import type { MarmotService } from "../marmot/service.js";
import { config } from "../config.js";
import { decode as nip19Decode } from "nostr-tools/nip19";
import type { JsonRpcRequest, JsonRpcResponse, SignalGroup } from "./types.js";

/** Convert marmot hex group ID → signal-cli base64 group ID */
export function hexToBase64(hex: string): string {
  return Buffer.from(hex, "hex").toString("base64");
}

/** Convert signal-cli base64 group ID → marmot hex group ID */
export function base64ToHex(b64: string): string {
  return Buffer.from(b64, "base64").toString("hex");
}

function ok(id: string | number | null | undefined, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcErr(
  id: string | number | null | undefined,
  code: number,
  message: string
): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function serializeGroup(group: {
  idStr: string;
  groupData: { name: string; description: string; adminPubkeys: string[]; relays: string[] } | null;
  state: { groupContext: { epoch: bigint } };
  relays?: string[];
}): SignalGroup {
  const data = group.groupData;
  const admins = data?.adminPubkeys ?? [];
  return {
    id: hexToBase64(group.idStr),
    name: data?.name ?? "",
    description: data?.description ?? "",
    isMember: true,
    isBlocked: false,
    members: admins,
    pendingMembers: [],
    requestingMembers: [],
    admins,
    messageExpirationTime: 0,
    isAnnouncementGroup: false,
    groupInviteLink: null,
  };
}

type Handler = (
  params: Record<string, unknown>,
  id: string | number | null
) => Promise<JsonRpcResponse>;

/** In-memory cache for kind-0 profile lookups to avoid a relay round-trip per message. */
interface CachedProfile { name: string; profileName: string; expiresAt: number }
const profileCache = new Map<string, CachedProfile>();
const PROFILE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function createDispatcher(service: MarmotService): (req: JsonRpcRequest) => Promise<JsonRpcResponse> {
  const methods: Record<string, Handler> = {
    /**
     * Send a message — primary method used by hermes-agent.
     * Supports groupId (base64) for groups; recipient is accepted but DMs are
     * not supported by the Marmot protocol so they return success silently.
     */
    async send(params, id) {
      const groupIdB64 = params.groupId as string | undefined;
      const message = (params.message as string | undefined) ?? "";

      if (!groupIdB64) {
        // DMs not supported; return a plausible timestamp so the caller doesn't error
        return ok(id, { timestamp: Date.now() });
      }

      const groupId = base64ToHex(groupIdB64);
      let group;
      try {
        group = await service.client.getGroup(groupId);
      } catch {
        return rpcErr(id, -32602, "Group not found");
      }

      if (message) {
        await group.sendChatMessage(message, []);
      }
      return ok(id, { timestamp: Date.now() });
    },

    /** Send a message to a group. DMs are not supported (marmot is groups-only). */
    async sendMessage(params, id) {
      const groupIdB64 = params.groupId as string | undefined;
      const message = params.message as string | undefined;

      if (!groupIdB64) {
        return rpcErr(id, -32602, "Direct messages are not supported; provide groupId");
      }
      if (typeof message !== "string" || message.length === 0) {
        return rpcErr(id, -32602, "message is required");
      }

      const groupId = base64ToHex(groupIdB64);
      let group;
      try {
        group = await service.client.getGroup(groupId);
      } catch {
        return rpcErr(id, -32602, "Group not found");
      }

      await group.sendChatMessage(message, []);
      return ok(id, { timestamp: Date.now() });
    },

    /** Typing indicator — no-op (Marmot has no typing events). */
    async sendTyping(_params, id) {
      return ok(id, null);
    },

    /**
     * Retrieve an attachment by ID.
     * Marmot has no attachment support; returns an error so hermes-agent
     * can handle it gracefully rather than hanging.
     */
    async getAttachment(_params, id) {
      return rpcErr(id, -32602, "Attachments are not supported");
    },

    /**
     * Get contact/profile info for a given address (Nostr pubkey).
     * Looks up the NIP-05/kind-0 display name if available, otherwise
     * returns the pubkey as the name so hermes-agent has something to display.
     */
    async getContact(params, id) {
      const address = (params.contactAddress ?? params.recipient ?? "") as string;

      // Resolve npub → hex pubkey if needed
      let pubkeyHex = address;
      if (address.startsWith("npub")) {
        try {
          const decoded = nip19Decode(address);
          if (decoded.type === "npub") pubkeyHex = decoded.data as string;
        } catch {
          // fall through with raw address
        }
      }

      // Fetch kind-0 metadata from relays, with a 5-minute in-memory cache.
      // hermes-agent calls getContact for every incoming message so uncached
      // relay fetches would block each delivery by up to 8 s; the cache drops
      // that to zero for repeat senders and the shorter 3 s timeout bounds the
      // worst case for cold lookups.
      let displayName: string | null = null;
      let profileName: string | null = null;
      if (/^[0-9a-fA-F]{64}$/.test(pubkeyHex)) {
        const now = Date.now();
        const cached = profileCache.get(pubkeyHex);
        if (cached && cached.expiresAt > now) {
          displayName = cached.name;
          profileName = cached.profileName;
        } else {
          try {
            const events = await service.pool.request(
              config.defaultRelays,
              { kinds: [0], authors: [pubkeyHex], limit: 1 },
              3000  // 3 s timeout — fast enough for hermes-agent without hanging
            );
            if (events.length > 0) {
              const meta = JSON.parse((events[0] as unknown as { content: string }).content) as Record<string, string>;
              displayName = meta.display_name || meta.name || null;
              profileName = meta.name || meta.display_name || null;
              profileCache.set(pubkeyHex, {
                name: displayName ?? address,
                profileName: profileName ?? address,
                expiresAt: now + PROFILE_CACHE_TTL_MS,
              });
            }
          } catch {
            // ignore — fall back to pubkey
          }
        }
      }

      return ok(id, {
        name: displayName ?? address,
        profileName: profileName ?? address,
        number: address,
        uuid: pubkeyHex,
        blocked: false,
      });
    },

    /** Send a reaction emoji to a group message. Encoded as a tagged message. */
    async sendReaction(params, id) {
      const groupIdB64 = params.groupId as string | undefined;
      const emoji = params.emoji as string | undefined;

      if (!groupIdB64) {
        return rpcErr(id, -32602, "groupId is required (DMs not supported)");
      }
      if (!emoji) {
        return rpcErr(id, -32602, "emoji is required");
      }

      const groupId = base64ToHex(groupIdB64);
      let group;
      try {
        group = await service.client.getGroup(groupId);
      } catch {
        return rpcErr(id, -32602, "Group not found");
      }

      const targetAuthor = (params.targetAuthor ?? params.recipient ?? "") as string;
      const targetTs = String(params.targetTimestamp ?? "0");
      await group.sendChatMessage(emoji, [
        ["reaction", "true"],
        ["target-author", targetAuthor],
        ["target-timestamp", targetTs],
      ]);
      return ok(id, { timestamp: Date.now() });
    },

    /** List all groups. */
    async listGroups(_params, id) {
      const groups = await service.client.loadAllGroups();
      return ok(id, groups.map(serializeGroup));
    },

    /** Get details for a single group. */
    async getGroup(params, id) {
      const groupIdB64 = params.groupId as string | undefined;
      if (!groupIdB64) return rpcErr(id, -32602, "groupId is required");

      const groupId = base64ToHex(groupIdB64);
      let group;
      try {
        group = await service.client.getGroup(groupId);
      } catch {
        return rpcErr(id, -32602, "Group not found");
      }
      return ok(id, serializeGroup(group));
    },

    /** Create a new group. */
    async createGroup(params, id) {
      const name = params.name as string | undefined;
      if (!name) return rpcErr(id, -32602, "name is required");

      const description = (params.description as string | undefined) ?? "";
      const relays = (params.relays as string[] | undefined) ?? config.defaultRelays;

      // Validate relay URLs — same SSRF guard as the REST API.
      // Without this check a caller could supply ws://redis:6379 or ws://169.254.x.x
      // and trigger outbound WebSocket connections to services inside the container network.
      for (const r of relays) {
        try {
          const { protocol } = new URL(r);
          if (protocol !== "wss:" && protocol !== "ws:") {
            return rpcErr(id, -32602, `Invalid relay URL (must be wss:// or ws://): ${r}`);
          }
        } catch {
          return rpcErr(id, -32602, `Invalid relay URL: ${r}`);
        }
      }

      const group = await service.client.createGroup(name, {
        description,
        relays,
        adminPubkeys: [],
      });
      return ok(id, { groupId: hexToBase64(group.idStr) });
    },

    /**
     * Update a group: add/remove members. Name/description updates are not
     * yet supported by the underlying marmot-ts API.
     */
    async updateGroup(params, id) {
      const groupIdB64 = params.groupId as string | undefined;
      if (!groupIdB64) return rpcErr(id, -32602, "groupId is required");

      const groupId = base64ToHex(groupIdB64);
      let group;
      try {
        group = await service.client.getGroup(groupId);
      } catch {
        return rpcErr(id, -32602, "Group not found");
      }

      const removeMembers = params.removeMembers as string[] | undefined;
      if (removeMembers && removeMembers.length > 0) {
        const { Proposals } = await import("@internet-privacy/marmot-ts/client");
        for (const pubkey of removeMembers) {
          await group.propose(Proposals.proposeRemoveUser, pubkey);
        }
        await group.commit();
      }

      const addMembers = params.addMembers as string[] | undefined;
      if (addMembers && addMembers.length > 0) {
        // Search group relays + default relays so key packages stored on
        // private relays (relay.og.coop, etc.) are always reachable even when
        // the group itself lives on standard relays.
        const groupRelays = group.relays ?? [];
        const relays = [...new Set([...groupRelays, ...config.defaultRelays])];
        for (const pubkey of addMembers) {
          const events = await service.pool.request(
            relays,
            { kinds: [443], authors: [pubkey], limit: 5 } as Parameters<typeof service.pool.request>[1]
          );
          if (events.length === 0) {
            return rpcErr(id, -32602, `No key package found on relays for member: ${pubkey}`);
          }
          await group.inviteByKeyPackageEvent(
            events[0] as unknown as Parameters<typeof group.inviteByKeyPackageEvent>[0]
          );
        }
      }

      return ok(id, { groupId: groupIdB64 });
    },

    /** Leave a group (publishes self-remove proposal). */
    async leaveGroup(params, id) {
      const groupIdB64 = params.groupId as string | undefined;
      if (!groupIdB64) return rpcErr(id, -32602, "groupId is required");

      const groupId = base64ToHex(groupIdB64);
      try {
        await service.client.leaveGroup(groupId);
      } catch {
        return rpcErr(id, -32602, "Group not found or leave failed");
      }
      return ok(id, null);
    },

    /** Delete a group (purges local state only). */
    async deleteGroup(params, id) {
      const groupIdB64 = params.groupId as string | undefined;
      if (!groupIdB64) return rpcErr(id, -32602, "groupId is required");

      const groupId = base64ToHex(groupIdB64);
      try {
        await service.client.destroyGroup(groupId);
      } catch {
        return rpcErr(id, -32602, "Group not found");
      }
      return ok(id, null);
    },

    /** Get the server's own profile. Returns pubkey as the identifier. */
    async getProfile(_params, id) {
      return ok(id, {
        number: service.pubkey,
        uuid: null,
        username: null,
        name: "marmot-server",
        about: "",
        aboutEmoji: "",
        mobileCoinAddress: null,
        lastSeenOnline: null,
        inboxPosition: null,
        blocked: false,
        profile: { lastUpdateTimestamp: 0, givenName: "marmot-server", familyName: "" },
      });
    },

    /** List contacts (always empty; marmot has no contact store). */
    async listContacts(_params, id) {
      return ok(id, []);
    },

    /** List linked devices. Returns a single entry representing this server. */
    async listDevices(_params, id) {
      return ok(id, [
        { id: 1, name: "marmot-server", created: 0, lastSeen: Date.now(), isThisDevice: true },
      ]);
    },

    /** List known identities (always empty; marmot stores no identity ledger). */
    async listIdentities(_params, id) {
      return ok(id, []);
    },

    /** Subscribe to real-time receive events (no-op; use GET /api/v1/events SSE). */
    async subscribeReceive(_params, id) {
      return ok(id, { subscription: 1 });
    },

    /** Unsubscribe from receive events (no-op). */
    async unsubscribeReceive(_params, id) {
      return ok(id, null);
    },

    /**
     * Poll for buffered received messages. Always returns empty; use the SSE
     * endpoint at GET /api/v1/events for real-time delivery.
     */
    async receive(_params, id) {
      return ok(id, []);
    },
  };

  // Aliases for method name variants used by different signal-cli clients
  methods.quitGroup = methods.leaveGroup;
  methods.getSelfProfile = methods.getProfile;

  return async function dispatch(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      return rpcErr(req.id ?? null, -32600, "Invalid Request");
    }

    const handler = methods[req.method];
    if (!handler) {
      return rpcErr(req.id ?? null, -32601, `Method not found: ${req.method}`);
    }

    try {
      return await handler(req.params ?? {}, req.id ?? null);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Internal error";
      return rpcErr(req.id ?? null, -32603, message);
    }
  };
}
