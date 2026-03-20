import { getPublicKey, finalizeEvent } from "nostr-tools/pure";
import type { NostrEvent } from "applesauce-core/helpers/event";

/** EventSigner interface from applesauce-core (duck-typed) */
export interface EventSigner {
  getPublicKey(): Promise<string>;
  signEvent(template: Partial<NostrEvent>): Promise<NostrEvent>;
}

export class PrivateKeySigner implements EventSigner {
  constructor(private readonly privkey: Uint8Array) {}

  async getPublicKey(): Promise<string> {
    return getPublicKey(this.privkey);
  }

  async signEvent(template: Partial<NostrEvent>): Promise<NostrEvent> {
    const signed = finalizeEvent(
      {
        kind: template.kind ?? 1,
        content: template.content ?? "",
        tags: template.tags ?? [],
        created_at: template.created_at ?? Math.floor(Date.now() / 1000),
      },
      this.privkey
    );
    return signed as unknown as NostrEvent;
  }
}
