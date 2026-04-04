import { getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { getConversationKey, encrypt as nip44Encrypt, decrypt as nip44Decrypt } from "nostr-tools/nip44";
import type { NostrEvent } from "applesauce-core/helpers/event";

/** EventSigner interface from applesauce-core (duck-typed) */
export interface EventSigner {
  getPublicKey(): Promise<string>;
  signEvent(template: Partial<NostrEvent>): Promise<NostrEvent>;
  nip44?: {
    encrypt: (pubkey: string, plaintext: string) => Promise<string>;
    decrypt: (pubkey: string, ciphertext: string) => Promise<string>;
  };
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

  readonly nip44 = {
    encrypt: async (pubkey: string, plaintext: string): Promise<string> => {
      const key = getConversationKey(this.privkey, pubkey);
      return nip44Encrypt(plaintext, key);
    },
    decrypt: async (pubkey: string, ciphertext: string): Promise<string> => {
      const key = getConversationKey(this.privkey, pubkey);
      return nip44Decrypt(ciphertext, key);
    },
  };
}
