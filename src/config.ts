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

/**
 * Parse SIGNAL_GROUP_ALLOWED_USERS.
 * Returns null for "all groups" (*), empty array for "no groups", or a Set of
 * base64 group IDs to allow.
 *
 *   unset / "*"            → null  (allow all — marmot default since DMs don't exist)
 *   ""                     → Set() (block all groups)
 *   "groupIdA,groupIdB"    → Set of those base64 IDs
 */
function parseGroupAllowedUsers(raw: string | undefined): Set<string> | null {
  if (!raw || raw.trim() === "*") return null; // null = all groups allowed
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
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
   */
  autoAcceptFrom: parsePubkeyList(process.env.AUTO_ACCEPT_FROM, "AUTO_ACCEPT_FROM"),
  /**
   * hermes-agent: SIGNAL_ALLOWED_USERS
   * Comma-separated npubs/hex pubkeys allowed to send messages to the agent.
   * When set, messages from all other senders are silently dropped on the SSE
   * stream. When unset and SIGNAL_ALLOW_ALL_USERS is not true, unknown senders
   * are also dropped (explicit opt-in required).
   * Set SIGNAL_ALLOW_ALL_USERS=true to forward messages from everyone.
   */
  allowedUsers: parsePubkeyList(process.env.SIGNAL_ALLOWED_USERS, "SIGNAL_ALLOWED_USERS"),
  /**
   * hermes-agent: SIGNAL_ALLOW_ALL_USERS
   * When true, all senders are forwarded regardless of SIGNAL_ALLOWED_USERS.
   * Equivalent to signal-cli open-access mode. Use with caution.
   */
  allowAllUsers: process.env.SIGNAL_ALLOW_ALL_USERS === "true",
  /**
   * hermes-agent: SIGNAL_GROUP_ALLOWED_USERS
   * Controls which groups' messages are forwarded on the SSE stream.
   *   unset or "*" → all groups (marmot default — no DMs exist)
   *   comma-separated base64 group IDs → only those groups
   * Note: in signal-cli the default is DM-only; marmot defaults to all groups
   * since the protocol is groups-only.
   */
  groupAllowedUsers: parseGroupAllowedUsers(process.env.SIGNAL_GROUP_ALLOWED_USERS),
};
