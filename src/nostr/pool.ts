import { SimplePool } from "nostr-tools";
import type { Filter } from "nostr-tools";
import type { NostrEvent } from "applesauce-core/helpers/event";
import type {
  NostrNetworkInterface,
  PublishResponse,
} from "@internet-privacy/marmot-ts";
import { KEY_PACKAGE_RELAY_LIST_KIND } from "@internet-privacy/marmot-ts";

type Unsubscribable = { unsubscribe(): void };
type Observer<T> = Partial<{ next(v: T): void; error(e: unknown): void; complete(): void }>;
type Subscribable<T> = { subscribe(observer: Observer<T>): Unsubscribable };

/** Wraps nostr-tools SimplePool to implement marmot-ts NostrNetworkInterface */
export class NostrPool implements NostrNetworkInterface {
  private readonly pool: SimplePool;

  constructor(private readonly defaultRelays: string[]) {
    this.pool = new SimplePool();
  }

  async publish(
    relays: string[],
    event: NostrEvent
  ): Promise<Record<string, PublishResponse>> {
    const results: Record<string, PublishResponse> = {};
    // nostr-tools publish returns Promise<string>[] — one promise per relay
    const promises = this.pool.publish(
      relays,
      event as unknown as Parameters<SimplePool["publish"]>[1]
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
    return results;
  }

  async request(
    relays: string[],
    filters: Filter | Filter[]
  ): Promise<NostrEvent[]> {
    const filterArray = Array.isArray(filters) ? filters : [filters];
    // querySync accepts rest filters
    const events = await (this.pool.querySync as (relays: string[], ...filters: Filter[]) => Promise<{ id: string }[]>)(
      relays,
      ...filterArray
    );
    return events as unknown as NostrEvent[];
  }

  subscription(
    relays: string[],
    filters: Filter | Filter[]
  ): Subscribable<NostrEvent> {
    const filterArray = Array.isArray(filters) ? filters : [filters];
    return {
      subscribe: (observer) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sub = this.pool.subscribeMany(relays, filterArray as any, {
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
    this.pool.close(this.defaultRelays);
  }
}
