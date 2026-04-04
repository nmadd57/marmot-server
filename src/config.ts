import { decode as nip19Decode } from "nostr-tools/nip19";
import { bytesToHex } from "@noble/hashes/utils.js";

function parsePubkeyList(raw: string | undefined, varName: string): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      if (s.startsWith("npub")) {
        const decoded = nip19Decode(s);
        if (decoded.type !== "npub") throw new Error(`${varName}: expected npub, got ${decoded.type}`);
        return decoded.data as string;
      }
      if (/^[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
      throw new Error(`${varName}: invalid value "${s}" — expected npub or 64-char hex`);
    });
}

export const config = {
  host: process.env.HOST ?? "0.0.0.0",
  port: parseInt(process.env.PORT ?? "8080"),
  dbPath: process.env.DB_PATH ?? "/data/marmot.db",
  /** If set, all requests must include `Authorization: Bearer <key>` */
  apiKey: process.env.API_KEY ?? null,
  defaultRelays: (process.env.DEFAULT_RELAYS ?? "wss://relay.damus.io,wss://nos.lol")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean),
  logLevel: process.env.LOG_LEVEL ?? "info",
  /**
   * Optional identity private key override. Accepts a 64-char hex string or
   * an nsec bech32 string. When set, this key is stored in (or overwrites) the
   * identity table on startup so the server always uses the supplied identity.
   */
  identityKey: process.env.IDENTITY_KEY ?? null,
  /**
   * Comma-separated list of npubs (or hex pubkeys) from which incoming group
   * invites are automatically accepted without requiring a manual API call.
   * Example: AUTO_ACCEPT_FROM=npub1abc...,npub1xyz...
   */
  autoAcceptFrom: parsePubkeyList(process.env.AUTO_ACCEPT_FROM, "AUTO_ACCEPT_FROM"),
  /**
   * Comma-separated list of npubs (or hex pubkeys) whose messages are forwarded
   * to the signal-cli SSE stream. Messages from any other sender are silently
   * dropped. When unset, all messages are forwarded (no filtering).
   * Mirrors the TELEGRAM_ALLOWED_USERS / SLACK_ALLOWED_USERS pattern in hermes-agent.
   */
  allowedUsers: parsePubkeyList(process.env.SIGNAL_ALLOWED_USERS, "SIGNAL_ALLOWED_USERS"),
};
