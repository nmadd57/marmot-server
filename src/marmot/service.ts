import Database from "better-sqlite3";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { generateSecretKey } from "nostr-tools/pure";
import { decode as nip19Decode } from "nostr-tools/nip19";
import {
  MarmotClient,
  KeyValueGroupStateBackend,
  KeyPackageStore,
  InviteReader,
  GROUP_EVENT_KIND,
  WELCOME_EVENT_KIND,
  deserializeApplicationData,
  getNostrGroupIdHex,
} from "@internet-privacy/marmot-ts";
import type { MarmotGroup } from "@internet-privacy/marmot-ts/client";
import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import type { NostrEvent } from "applesauce-core/helpers/event";
import { EventEmitter } from "eventemitter3";
import { config } from "../config.js";
import { SqliteKvStore, SqliteBlobStore } from "../store/kv-store.js";
import { MessageStore } from "../store/message-store.js";
import { PrivateKeySigner } from "../nostr/signer.js";
import { NostrPool } from "../nostr/pool.js";

/** Server-emitted real-time event types */
export type ServerEvent =
  | { type: "message"; groupId: string; message: { id: string; sender: string; kind: number; content: string; tags: string[][]; createdAt: number } }
  | { type: "invite"; inviteId: string; groupName: string | null; inviterPubkey: string | null }
  | { type: "group_created"; groupId: string; name: string }
  | { type: "group_joined"; groupId: string; name: string }
  | { type: "group_left"; groupId: string }
  | { type: "group_destroyed"; groupId: string };

type ServiceEvents = {
  event: (e: ServerEvent) => void;
};

export class MarmotService extends EventEmitter<ServiceEvents> {
  readonly client: MarmotClient;
  readonly inviteReader: InviteReader;
  readonly messages: MessageStore;
  readonly pool: NostrPool;
  readonly pubkey: string;

  /** Active relay subscriptions per group (MLS group id hex → cleanup fn) */
  private groupSubs = new Map<string, () => void>();
  /** Gift-wrap inbox subscription cleanup */
  private inboxSubCleanup: (() => void) | null = null;

  private constructor(
    client: MarmotClient,
    inviteReader: InviteReader,
    messages: MessageStore,
    pool: NostrPool,
    pubkey: string
  ) {
    super();
    this.client = client;
    this.inviteReader = inviteReader;
    this.messages = messages;
    this.pool = pool;
    this.pubkey = pubkey;

    // Forward client group lifecycle events
    client.on("groupCreated", (group) => {
      const name = group.groupData?.name ?? "";
      this.emit("event", { type: "group_created", groupId: group.idStr, name });
      this.subscribeToGroup(group);
    });
    client.on("groupJoined", (group) => {
      const name = group.groupData?.name ?? "";
      this.emit("event", { type: "group_joined", groupId: group.idStr, name });
      this.subscribeToGroup(group);
    });
    client.on("groupLoaded", (group) => {
      this.subscribeToGroup(group);
    });
    client.on("groupLeft", (groupId) => {
      const hex = bytesToHex(groupId);
      this.emit("event", { type: "group_left", groupId: hex });
      this.unsubscribeGroup(hex);
    });
    client.on("groupDestroyed", (groupId) => {
      const hex = bytesToHex(groupId);
      this.emit("event", { type: "group_destroyed", groupId: hex });
      this.unsubscribeGroup(hex);
    });

    // Forward invite events
    inviteReader.on("newInvite", (rumor) => {
      this.emit("event", {
        type: "invite",
        inviteId: rumor.id,
        groupName: null, // decoded lazily via client.readInviteGroupInfo
        inviterPubkey: rumor.pubkey ?? null,
      });
      // Auto-accept if the inviter is in the configured allow-list
      if (rumor.pubkey && config.autoAcceptFrom.includes(rumor.pubkey)) {
        this.client.joinGroupFromWelcome({ welcomeRumor: rumor as unknown as Parameters<typeof this.client.joinGroupFromWelcome>[0]["welcomeRumor"] })
          .then(({ group }) => {
            this.inviteReader.markAsRead(rumor.id).catch(() => {});
            return group.selfUpdate().catch(() => {});
          })
          .catch((err) => {
            console.error("[service] auto-accept invite %s from %s failed: %s", rumor.id.slice(0, 16), (rumor.pubkey ?? "").slice(0, 16), err?.message);
          });
      }
    });
  }

  static async create(db: Database.Database): Promise<MarmotService> {
    // --- identity ---
    const identityStore = new SqliteKvStore<string>(db, "identity");
    // If IDENTITY_KEY is set, resolve it to hex and (over)write the store so
    // the server always starts with the configured keypair.
    if (config.identityKey) {
      let resolved: string;
      const raw = config.identityKey.trim();
      if (raw.startsWith("nsec")) {
        const decoded = nip19Decode(raw);
        if (decoded.type !== "nsec") throw new Error("IDENTITY_KEY: expected nsec bech32");
        resolved = bytesToHex(decoded.data as Uint8Array);
      } else {
        if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw new Error("IDENTITY_KEY: expected 64-char hex or nsec bech32");
        resolved = raw.toLowerCase();
      }
      await identityStore.setItem("privkey", resolved);
    }
    let privkeyHex = await identityStore.getItem("privkey");
    if (!privkeyHex) {
      const key = generateSecretKey();
      privkeyHex = bytesToHex(key);
      await identityStore.setItem("privkey", privkeyHex);
    }
    const privkey = hexToBytes(privkeyHex!);
    const signer = new PrivateKeySigner(privkey);
    const pubkey = await signer.getPublicKey();

    // --- nostr pool ---
    // Pass signer so the pool can respond to NIP-42 AUTH challenges from
    // relays that require authentication before accepting published events.
    const pool = new NostrPool(config.defaultRelays, (template) => signer.signEvent(template));

    // --- group state store ---
    const groupStateBlobStore = new SqliteBlobStore(db, "group_state");
    const groupStateBackend = new KeyValueGroupStateBackend(groupStateBlobStore);

    // --- key package store ---
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const keyPackageKvStore = new SqliteKvStore(db, "key_packages") as any;
    const keyPackageStore = new KeyPackageStore(keyPackageKvStore);

    // --- message store ---
    const messages = new MessageStore(db);

    // --- marmot client ---
    const client = new MarmotClient({
      signer,
      groupStateBackend,
      keyPackageStore,
      network: pool,
      historyFactory: (groupId) => messages.historyFor(bytesToHex(groupId)),
    });

    // --- invite reader ---
    const inviteStore = {
      received: new SqliteKvStore(db, "invites_received"),
      unread: new SqliteKvStore(db, "invites_unread"),
      seen: new SqliteKvStore(db, "invites_seen"),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const inviteReader = new InviteReader({ signer, store: inviteStore });

    const service = new MarmotService(client, inviteReader, messages, pool, pubkey);

    // Load all existing groups and start subscriptions
    await client.loadAllGroups();

    // Start inbox subscription for welcome messages
    service.startInboxSubscription();

    return service;
  }

  /** Subscribe to group relay events for an already-loaded group */
  private subscribeToGroup(group: MarmotGroup): void {
    const groupIdHex = group.idStr;
    if (this.groupSubs.has(groupIdHex)) return;

    const relays = group.relays;
    if (!relays || relays.length === 0) return;

    let nostrGroupIdHex: string;
    try {
      nostrGroupIdHex = getNostrGroupIdHex(group.state);
    } catch {
      return;
    }

    const seenIds = new Set<string>();

    // First do a historical fetch
    this.fetchHistoricalEvents(group, seenIds);

    // Then open a live subscription
    const sub = this.pool.subscription(relays, {
      kinds: [GROUP_EVENT_KIND],
      "#h": [nostrGroupIdHex],
    });

    const handle = sub.subscribe({
      next: (event) => {
        if (seenIds.has(event.id as unknown as string)) return;
        seenIds.add(event.id as unknown as string);
        this.processGroupEvent(group, groupIdHex, [event]).catch(() => {});
      },
    });

    this.groupSubs.set(groupIdHex, () => handle.unsubscribe());
  }

  private unsubscribeGroup(groupIdHex: string): void {
    const cleanup = this.groupSubs.get(groupIdHex);
    if (cleanup) {
      cleanup();
      this.groupSubs.delete(groupIdHex);
    }
  }

  private async fetchHistoricalEvents(group: MarmotGroup, seenIds: Set<string>): Promise<void> {
    const relays = group.relays;
    if (!relays || relays.length === 0) return;
    try {
      const nostrGroupIdHex = getNostrGroupIdHex(group.state);
      const events = await this.pool.request(relays, {
        kinds: [GROUP_EVENT_KIND],
        "#h": [nostrGroupIdHex],
      });
      const newEvents = events.filter((e) => {
        const id = (e as unknown as { id: string }).id;
        if (seenIds.has(id)) return false;
        seenIds.add(id);
        return true;
      });
      if (newEvents.length > 0) {
        await this.processGroupEvent(group, group.idStr, newEvents);
      }
    } catch {
      // ignore
    }
  }

  private async processGroupEvent(
    group: MarmotGroup,
    groupIdHex: string,
    events: NostrEvent[]
  ): Promise<void> {
    for await (const result of group.ingest(events as unknown as Parameters<MarmotGroup["ingest"]>[0])) {
      if (result.kind === "processed" && result.result.kind === "applicationMessage") {
        try {
          const rumor = deserializeApplicationData(result.result.message);
          this.emit("event", {
            type: "message",
            groupId: groupIdHex,
            message: {
              id: rumor.id,
              sender: rumor.pubkey,
              kind: rumor.kind,
              content: rumor.content,
              tags: rumor.tags as string[][],
              createdAt: rumor.created_at,
            },
          });
        } catch {
          // ignore parse errors
        }
      }
    }
  }

  /** Subscribe to kind 1059 gift wraps addressed to our pubkey */
  private startInboxSubscription(): void {
    if (this.inboxSubCleanup) return;

    // Fetch historical gift wraps first (the live subscription only catches new ones)
    this.fetchHistoricalInbox().catch(() => {});

    // kind 1059 = NIP-59 gift wrap (outer envelope); inner rumor is kind 444 (WELCOME_EVENT_KIND)
    const sub = this.pool.subscription(config.defaultRelays, {
      kinds: [1059],
      "#p": [this.pubkey],
    } as Parameters<typeof this.pool.subscription>[1]);

    const handle = sub.subscribe({
      next: async (event) => {
        const e = event as unknown as { kind: number };
        if (e.kind !== 1059) return;
        try {
          const isNew = await this.inviteReader.ingestEvent(event as unknown as Parameters<typeof this.inviteReader.ingestEvent>[0]);
          if (isNew) {
            await this.inviteReader.decryptGiftWrap(
              (event as unknown as { id: string }).id
            );
          }
        } catch {
          // ignore
        }
      },
    });

    this.inboxSubCleanup = () => handle.unsubscribe();
  }

  private async fetchHistoricalInbox(): Promise<void> {
    try {
      const events = await this.pool.request(config.defaultRelays, {
        kinds: [1059],
        "#p": [this.pubkey],
      } as Parameters<typeof this.pool.request>[1]);
      for (const event of events) {
        const e = event as unknown as { kind: number; id: string };
        if (e.kind !== 1059) continue;
        try {
          const isNew = await this.inviteReader.ingestEvent(event as unknown as Parameters<typeof this.inviteReader.ingestEvent>[0]);
          if (isNew) {
            await this.inviteReader.decryptGiftWrap(e.id);
          }
        } catch {
          // ignore individual failures
        }
      }
    } catch {
      // ignore
    }
  }

  shutdown(): void {
    for (const cleanup of this.groupSubs.values()) cleanup();
    this.groupSubs.clear();
    if (this.inboxSubCleanup) {
      this.inboxSubCleanup();
      this.inboxSubCleanup = null;
    }
    this.pool.close();
  }
}
