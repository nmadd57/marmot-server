// Use nostr-tools/pool directly so we share the same module instance as
// useWebSocketImplementation, avoiding the split-module _WebSocket problem.
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import type { Filter } from "nostr-tools";
import { WebSocket } from "ws";

// Node.js < 21 has no global WebSocket. Register 'ws' so every SimplePool
// instance created anywhere (including inside marmot-ts) uses it.
useWebSocketImplementation(WebSocket as unknown as typeof globalThis.WebSocket);
import type { NostrEvent } from "applesauce-core/helpers/event";
import type {
  NostrNetworkInterface,
  PublishResponse,
} from "@internet-privacy/marmot-ts";
import { KEY_PACKAGE_RELAY_LIST_KIND } from "@internet-privacy/marmot-ts";

type Unsubscribable = { unsubscribe(): void };
type Observer<T> = Partial<{ next(v: T): void; error(e: unknown): void; complete(): void }>;
type Subscribable<T> = { subscribe(observer: Observer<T>): Unsubscribable };

type AuthSigner = (template: Partial<NostrEvent>) => Promise<NostrEvent>;

/** Wraps nostr-tools SimplePool to implement marmot-ts NostrNetworkInterface */
export class NostrPool implements NostrNetworkInterface {
  private readonly pool: SimplePool;
  private readonly authSigner?: AuthSigner;
  /** Tracks every relay URL we have ever connected to for clean shutdown. */
  private readonly knownRelays = new Set<string>();

  constructor(
    private readonly defaultRelays: string[],
    authSigner?: AuthSigner
  ) {
    this.authSigner = authSigner;
    this.pool = new SimplePool();
    for (const r of defaultRelays) this.knownRelays.add(r);
    // Wire NIP-42 auth for relays that send AUTH proactively on connect.
    if (authSigner) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.pool as any).automaticallyAuth = (_url: string) => authSigner;
    }
  }

  async publish(
    relays: string[],
    event: NostrEvent
  ): Promise<Record<string, PublishResponse>> {
    for (const r of relays) this.knownRelays.add(r);
    const results: Record<string, PublishResponse> = {};
    // Pass onauth so that relays which send AUTH only after a failed publish
    // (rather than proactively on connect) are handled correctly via retry.
    const promises = (
      this.pool.publish as (
        relays: string[],
        event: unknown,
        params?: { onauth?: AuthSigner }
      ) => Promise<string>[]
    )(
      relays,
      event,
      this.authSigner ? { onauth: this.authSigner } : undefined
    );
    await Promise.allSettled(
      relays.map(async (relay, i) => {
        try {
          await promises[i];
          results[relay] = { from: relay, ok: true };
        } catch (err) {
          results[relay] = {
            from: relay,
            ok: false,
            message: err instanceof Error ? err.message : String(err),
          };
        }
      })
    );
    // Log publish results for observability
    const ok = Object.values(results).filter((r) => r.ok);
    const failed = Object.values(results).filter((r) => !r.ok);
    console.log("[pool] publish kind=%d to %d relays → %d ok, %d failed | relays=%s",
      (event as unknown as { kind: number }).kind,
      relays.length, ok.length, failed.length,
      relays.join(",")
    );
    if (failed.length > 0) {
      console.error("[pool] publish failures: %s",
        failed.map((r) => `${r.from}: ${r.message}`).join("; ")
      );
    }
    return results;
  }

  async request(
    relays: string[],
    filters: Filter | Filter[],
    /** Max milliseconds to wait for EOSE from slow relays (default 8 s). */
    maxWait = 8000
  ): Promise<NostrEvent[]> {
    for (const r of relays) this.knownRelays.add(r);
    const filterArray = Array.isArray(filters) ? filters : [filters];
    // Pass maxWait so slow relays have time to return EOSE before querySync
    // resolves. Default in nostr-tools is ~2.4 s which is too short.
    const events = await (
      this.pool.querySync as (
        relays: string[],
        filter: Filter,
        opts?: { maxWait?: number }
      ) => Promise<{ id: string }[]>
    )(relays, filterArray[0], { maxWait });
    return events as unknown as NostrEvent[];
  }

  subscription(
    relays: string[],
    filters: Filter | Filter[]
  ): Subscribable<NostrEvent> {
    for (const r of relays) this.knownRelays.add(r);
    // nostr-tools 2.x subscribeMany/subscribe takes a SINGLE filter object, not an array.
    // Passing an array produces ["REQ","id",[{filter}]] instead of ["REQ","id",{filter}],
    // which relays correctly reject as "not an object".
    const filter = Array.isArray(filters) ? filters[0] : filters;
    return {
      subscribe: (observer) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sub = this.pool.subscribeMany(relays, filter as any, {
          onevent: (event) => {
            observer.next?.(event as unknown as NostrEvent);
          },
        });
        return { unsubscribe: () => sub.close() };
      },
    };
  }

  async getUserInboxRelays(pubkey: string): Promise<string[]> {
    try {
      const filter: Filter = { kinds: [KEY_PACKAGE_RELAY_LIST_KIND, 10002], authors: [pubkey], limit: 2 };
      const events = await (this.pool.querySync as (relays: string[], filter: Filter) => Promise<{ kind: number; tags: string[][] }[]>)(
        this.defaultRelays,
        filter
      );
      if (events.length === 0) return this.defaultRelays;

      // Prefer 10051 over 10002
      const sorted = [...events].sort((a, b) =>
        a.kind === KEY_PACKAGE_RELAY_LIST_KIND ? -1 : b.kind === KEY_PACKAGE_RELAY_LIST_KIND ? 1 : 0
      );

      const relays = sorted[0].tags
        .filter((t) => (t[0] === "relay" || t[0] === "r") && t[1])
        .map((t) => t[1]);

      return relays.length > 0 ? relays : this.defaultRelays;
    } catch {
      return this.defaultRelays;
    }
  }

  close(): void {
    // Close every relay connection opened during the lifetime of this pool,
    // not just the default relays. Group relays differ from defaultRelays and
    // would otherwise be left as hanging WebSocket connections on shutdown.
    this.pool.close([...this.knownRelays]);
  }
}
