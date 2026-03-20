# marmot-server — Architecture

This document explains how `marmot-server` is built internally: how the protocol layers interact, how state is managed, and why key design decisions were made.

## Table of Contents

- [Protocol Stack](#protocol-stack)
- [Component Overview](#component-overview)
- [Startup Sequence](#startup-sequence)
- [Identity and Key Management](#identity-and-key-management)
- [Storage Design](#storage-design)
- [Nostr Integration](#nostr-integration)
- [MLS Group Lifecycle](#mls-group-lifecycle)
- [Relay Subscription Lifecycle](#relay-subscription-lifecycle)
- [Message Flow](#message-flow)
- [Invite Flow](#invite-flow)
- [Real-time Event Fan-out](#real-time-event-fan-out)
- [Authentication Model](#authentication-model)
- [Security Considerations](#security-considerations)
- [Dependency Map](#dependency-map)

---

## Protocol Stack

```
┌─────────────────────────────────────────────┐
│              HTTP / WebSocket               │  Fastify 5
├─────────────────────────────────────────────┤
│              marmot-server                  │  REST routes + WS fan-out
├─────────────────────────────────────────────┤
│            @internet-privacy/marmot-ts      │  MarmotClient, InviteReader
├────────────────────┬────────────────────────┤
│     MLS (ts-mls)   │   Nostr (nostr-tools)  │
│  RFC 9420 groups   │   SimplePool, events   │
├────────────────────┴────────────────────────┤
│               SQLite (better-sqlite3)       │  All persistence
└─────────────────────────────────────────────┘
```

The key insight is that **MLS handles encryption** and **Nostr handles transport**. Nostr relays are used purely as dumb message buses — they store and forward encrypted blobs that only group members can decrypt.

---

## Component Overview

```
src/
├── index.ts              ← Fastify bootstrap, plugin registration, shutdown hooks
├── config.ts             ← Env var config
├── middleware/
│   └── auth.ts           ← onRequest hook: optional Bearer token check
├── marmot/
│   └── service.ts        ← MarmotService singleton (the core orchestrator)
├── nostr/
│   ├── pool.ts           ← NostrPool: implements NostrNetworkInterface
│   └── signer.ts         ← PrivateKeySigner: implements EventSigner
├── store/
│   ├── kv-store.ts       ← SqliteKvStore<T>, SqliteBlobStore
│   └── message-store.ts  ← MessageStore + BaseGroupHistory adapter
└── routes/
    ├── identity.ts
    ├── key-packages.ts
    ├── groups.ts
    ├── messages.ts
    ├── invites.ts
    └── events.ts         ← WebSocket real-time endpoint
```

### MarmotService

`MarmotService` is the central orchestrator. It:

1. Owns the `MarmotClient` (from marmot-ts)
2. Owns the `InviteReader` (gift-wrap inbox)
3. Manages per-group relay subscriptions (`groupSubs` Map)
4. Manages the inbox subscription (kind-1059 gift wraps)
5. Extends `EventEmitter` — all internal activity is emitted as `ServerEvent` objects that the WebSocket route fans out to connected clients

It is created once at startup via the static `MarmotService.create(db)` factory and injected into all route handlers.

---

## Startup Sequence

```
main()
  ├── mkdirSync(dirname(dbPath))         — ensure /data exists
  ├── new Database(dbPath)               — open SQLite, enable WAL
  ├── Fastify({ bodyLimit: 65536 })      — create HTTP server; 64 KiB body cap
  ├── register FastifyWebSocket
  ├── register FastifySwagger
  ├── register FastifySwaggerUi
  ├── addHook("onRequest", authHook)     — global auth gate
  ├── setErrorHandler                    — sanitise 5xx; log full error server-side
  ├── addContentTypeParser               — strict JSON-only body parsing
  ├── GET /health                        — liveness endpoint
  ├── MarmotService.create(db)
  │   ├── load/generate Nostr keypair from SQLite "identity" table
  │   ├── new NostrPool(defaultRelays)
  │   ├── new KeyValueGroupStateBackend(SqliteBlobStore)
  │   ├── new KeyPackageStore(SqliteKvStore)
  │   ├── new MessageStore(db)
  │   ├── new MarmotClient({signer, groupStateBackend, keyPackageStore, network, historyFactory})
  │   ├── new InviteReader({signer, store: {received, unread, seen}})
  │   ├── wire client lifecycle events → service.emit("event", ...)
  │   ├── wire inviteReader.newInvite → service.emit("event", ...)
  │   ├── client.loadAllGroups()         — restore group state, open subscriptions
  │   └── startInboxSubscription()       — subscribe kind-1059 on defaultRelays
  ├── register routes (identity, key-packages, groups, messages, invites, events)
  ├── register SIGTERM/SIGINT handlers
  └── fastify.listen()
```

---

## Identity and Key Management

### Nostr Identity

The server has exactly one Nostr identity — a secp256k1 keypair. On first boot, a random key is generated with `nostr-tools/pure.generateSecretKey()` and stored as a hex string in the `identity` SQLite table under key `"privkey"`.

The public key (hex) is derived via `nostr-tools/pure.getPublicKey()` and exposed at `GET /v1/identity`.

The `PrivateKeySigner` class wraps the private key bytes and implements the `EventSigner` duck type expected by marmot-ts:

```typescript
interface EventSigner {
  getPublicKey(): Promise<string>;
  signEvent(template: Partial<NostrEvent>): Promise<NostrEvent>;
}
```

It signs events using `nostr-tools/pure.finalizeEvent()`, which handles hashing, signing, and ID computation in one call.

### MLS Key Packages

MLS key packages (Nostr kind 443) are pre-published credentials that allow others to initiate a group with you without requiring you to be online. Each key package contains:

- Your MLS credential (bound to your Nostr pubkey)
- A Diffie-Hellman init key (for the initial key agreement)
- Capabilities and extensions

Key packages are managed by `client.keyPackages` (a `KeyPackageManager` from marmot-ts) backed by `SqliteKvStore`. The `keyPackageRef` (a hash of the key package) serves as the local identifier.

Key packages should be rotated regularly, or after being used, to maintain forward secrecy properties.

---

## Storage Design

All state lives in a single SQLite database. SQLite's WAL mode (`PRAGMA journal_mode = WAL`) is enabled for better concurrent read performance.

### SqliteKvStore\<T\>

A generic key-value store for structured objects. Values are stored as JSON TEXT with a custom replacer/reviver that handles types that don't survive standard JSON serialization:

| JS Type | Stored as |
|---------|-----------|
| `Uint8Array` | `{"__t":"u8","d":[...bytes...]}` |
| `BigInt` | `{"__t":"bi","d":"123456..."}` |

This is essential because marmot-ts objects like `StoredKeyPackage` contain `Uint8Array` (for raw TLS-encoded bytes) and `BigInt` (for MLS epoch numbers).

Because `tableName` is interpolated into SQL strings (SQLite does not support parameterised identifiers), the constructor validates it against `/^[a-z_][a-z0-9_]*$/i` and throws immediately on any non-conforming input. All current table names are hardcoded; the guard is defence-in-depth for future callers.

Used for: `identity`, `key_packages`, `invites_received`, `invites_unread`, `invites_seen`.

### SqliteBlobStore

A binary-only store using SQLite BLOB columns. Used exclusively for `SerializedClientState` — the TLS-encoded MLS group state produced by ts-mls. This is a raw `Uint8Array` that must be stored verbatim without any JSON transformation. The same table-name validation applied to `SqliteKvStore` is also enforced here.

Used for: `group_state`.

### MessageStore

A dedicated table for decrypted message history:

```sql
CREATE TABLE messages (
  id        TEXT PRIMARY KEY,   -- inner rumor Nostr event ID
  group_id  TEXT NOT NULL,      -- MLS group ID (hex)
  sender    TEXT NOT NULL,      -- sender pubkey
  kind      INTEGER NOT NULL,   -- inner rumor kind (typically 9)
  content   TEXT NOT NULL,      -- decrypted content
  tags      TEXT NOT NULL,      -- JSON array of tag arrays
  created_at INTEGER NOT NULL   -- unix timestamp
);
CREATE INDEX messages_group_id ON messages (group_id, created_at);
```

`MessageStore.historyFor(groupId)` returns a `BaseGroupHistory` adapter that marmot-ts calls to persist messages as they are decrypted during `group.ingest()`. The adapter calls `deserializeApplicationData()` to decode the raw MLS application bytes into a `Rumor` (unsigned Nostr event), then stores it.

---

## Nostr Integration

### NostrPool

`NostrPool` implements the `NostrNetworkInterface` required by marmot-ts, wrapping `nostr-tools SimplePool`:

```typescript
interface NostrNetworkInterface {
  publish(relays, event): Promise<Record<string, PublishResponse>>;
  request(relays, filters): Promise<NostrEvent[]>;
  subscription(relays, filters): Subscribable<NostrEvent>;
  getUserInboxRelays(pubkey): Promise<string[]>;
}
```

Key implementation details:

- **`publish`**: `SimplePool.publish()` returns `Promise<string>[]` (one per relay). These are mapped to `Record<string, PublishResponse>` with per-relay success/failure.
- **`request`**: Uses `pool.querySync()` which collects events until EOSE from all relays.
- **`subscription`**: Wraps `pool.subscribeMany()` in a minimal Rx-style `Subscribable<T>` — the marmot-ts event pipeline uses this interface.
- **`getUserInboxRelays`**: Fetches kind-10051 (Marmot relay list) or kind-10002 (NIP-65 relay list) to find a user's preferred inbox relays, falling back to default relays.

### Nostr Event Kinds

| Kind | Name | Used for |
|------|------|---------|
| 443 | Key Package | Publishing MLS key packages |
| 444 | Welcome | MLS Welcome messages (inside gift wraps) |
| 445 | Group Event | MLS commits, proposals, application messages |
| 1059 | Gift Wrap | Sealed-sender envelope for Welcome delivery |
| 10002 | Relay List Metadata | NIP-65 inbox relay discovery |
| 10051 | Key Package Relay List | Marmot relay list |

---

## MLS Group Lifecycle

### Creating a Group

`POST /v1/groups` calls `client.createGroup(name, options)`. Internally:

1. MLS generates a fresh group with a random group ID
2. A `GroupInfo` (Nostr group metadata) is published to the group's relays
3. The initial group state is serialized and saved to `group_state` in SQLite
4. `client.on("groupCreated")` fires, triggering `subscribeToGroup()`

### Inviting a Member

`POST /v1/groups/:id/invite` performs:

1. Fetch the invitee's kind-443 key package from the group's relays
2. Call `group.inviteByKeyPackageEvent(keyPackageEvent)` which:
   - Validates the key package
   - Constructs an MLS Add proposal and Welcome message
   - Wraps the Welcome in a kind-1059 gift wrap addressed to the invitee's pubkey
   - Publishes the group event (Add + Commit) to the group's relays
   - Publishes the gift-wrapped Welcome to the invitee's inbox relays
3. The MLS epoch increments

### Joining via Welcome

`POST /v1/invites/:id/accept` calls `client.joinGroupFromWelcome({ welcomeRumor })` which:

1. Decodes the Welcome from the gift-wrapped rumor
2. Validates the MLS Welcome against the key package that was consumed
3. Initializes local group state from the Welcome
4. Saves group state to SQLite
5. `client.on("groupJoined")` fires, triggering `subscribeToGroup()`

After joining, `group.selfUpdate()` is called automatically to rotate the local key material (MIP-02 forward secrecy).

### Sending a Message

`POST /v1/groups/:id/messages` calls `group.sendChatMessage(content, tags)` which:

1. Creates an unsigned Nostr event (Rumor) with kind 9 and the given content/tags
2. Serializes it via `serializeApplicationData()`
3. Wraps it in an MLS `ApplicationMessage`
4. Encrypts it using the current group epoch's symmetric key
5. Publishes as a kind-445 Nostr event tagged with the group's Nostr hash

### Leaving a Group

`POST /v1/groups/:id/leave` calls `client.leaveGroup(groupId)` which:

1. Proposes self-removal
2. Commits the proposal (epoch increment)
3. Publishes the commit to relays
4. Purges local state
5. `client.on("groupLeft")` fires, triggering `unsubscribeGroup()`

### Removing a Member

`DELETE /v1/groups/:id/members/:pubkey` uses the two-step flow:

```typescript
const { Proposals } = await import("@internet-privacy/marmot-ts/client");
await group.propose(Proposals.proposeRemoveUser, pubkey);
await group.commit();
```

`proposeRemoveUser` returns a `ProposalAction<ProposalRemove[]>` (an array of proposals), so it must be staged via `group.propose()` rather than passed inline to `group.commit()`. The commit publishes an MLS Commit event that removes the member and advances the epoch, after which the removed member can no longer decrypt group messages.

---

## Relay Subscription Lifecycle

For each active group, `MarmotService` maintains a live Nostr subscription.

### Per-Group Subscription

When a group is created, joined, or loaded from SQLite, `subscribeToGroup(group)` is called:

```
subscribeToGroup(group)
  ├── getNostrGroupIdHex(group.state)   — derive Nostr group hash from MLS state
  ├── fetchHistoricalEvents(group)      — pool.querySync for past kind-445 events
  │   └── processGroupEvent()           — group.ingest() → emit "message" events
  └── pool.subscribeMany(relays, {kinds:[445], "#h":[nostrGroupIdHex]})
      └── on "onevent" → processGroupEvent() → emit "message" events
```

The `seenIds` set prevents double-processing events that arrive in both the historical fetch and the live subscription.

### Inbox Subscription

A single subscription on `defaultRelays` watches for kind-1059 (gift-wrap) events addressed to the server's pubkey:

```
pool.subscribeMany(defaultRelays, {kinds:[1059], "#p":[pubkey]})
  └── on "onevent"
      ├── inviteReader.ingestEvent(event)  — store raw event
      └── inviteReader.decryptGiftWrap(id) — unwrap → emit "newInvite"
          └── service.emit("event", {type:"invite", ...})
```

### Cleanup

On graceful shutdown (SIGTERM/SIGINT), `service.shutdown()`:
1. Calls each group subscription's cleanup function (closes the sub)
2. Closes the inbox subscription
3. Calls `pool.close()` to disconnect from all relays
4. Closes the SQLite database

---

## Message Flow

### Outbound (send)

```
POST /v1/groups/:id/messages
  └── group.sendChatMessage(content, tags)
      ├── create Rumor (unsigned Nostr event, kind 9)
      ├── serializeApplicationData(rumor) → Uint8Array
      ├── MLS encrypt → ApplicationMessage
      ├── wrap in kind-445 Nostr event, tag "#h" = nostrGroupIdHex
      └── pool.publish(groupRelays, event)
```

### Inbound (receive)

```
pool.subscribeMany → kind-445 event arrives
  └── processGroupEvent(group, groupIdHex, [event])
      └── group.ingest([event])  (async generator)
          └── for each result:
              if result.kind === "processed" && result.result.kind === "applicationMessage":
                ├── deserializeApplicationData(result.result.message) → Rumor
                ├── messages.saveRumor(groupId, rumor)   [via historyFactory]
                └── service.emit("event", { type: "message", groupId, message: {...} })
                    └── WebSocket clients receive JSON
```

---

## Invite Flow

### Outbound (inviting someone)

```
POST /v1/groups/:id/invite
  ├── pool.request(groupRelays, {kinds:[443], authors:[pubkey]})  — fetch key package
  └── group.inviteByKeyPackageEvent(keyPackageEvent)
      ├── MLS: create Add proposal + Welcome message
      ├── pool.publish(groupRelays, addCommitEvent)  — kind-445
      └── pool.publish(inviteeInboxRelays, giftWrapEvent)  — kind-1059
```

### Inbound (receiving an invite)

```
pool.subscribeMany → kind-1059 gift wrap arrives on defaultRelays
  └── inviteReader.ingestEvent(event)    — deduplicated by seen set
      └── inviteReader.decryptGiftWrap(id)
          └── inviteReader.on("newInvite", rumor)
              └── service.emit("event", { type: "invite", inviteId: rumor.id, ... })

POST /v1/invites/:id/accept
  └── client.joinGroupFromWelcome({ welcomeRumor })
      ├── validate Welcome against stored key package
      ├── initialize MLS group state
      ├── save to SQLite group_state
      ├── client.on("groupJoined") → subscribeToGroup()
      └── group.selfUpdate()   — forward secrecy (MIP-02)
```

---

## Real-time Event Fan-out

`MarmotService extends EventEmitter<{ event: (e: ServerEvent) => void }>`. All internal activity emits a `ServerEvent`.

The WebSocket route (`/v1/events`) subscribes once to `service.on("event", ...)` at registration time and maintains a `Set<WebSocket>` of connected clients:

```typescript
service.on("event", (evt) => {
  const payload = JSON.stringify(evt);
  for (const ws of clients) {
    ws.send(payload);
  }
});
```

When a client connects:
1. Synchronous auth check (API key via `?key=` query param, constant-time comparison)
2. Socket added to `clients` set — only reached if auth passes
3. Initial `{"type":"connected","pubkey":"..."}` sent
4. On `close`/`error`: socket removed from set

---

## Authentication Model

Authentication is implemented as a Fastify `onRequest` hook (`authHook`) that runs before every route handler.

```
Request arrives
  ├── is API_KEY configured?  No  → pass through
  ├── is path in UNPROTECTED (/health, /docs, /docs/*)?  Yes  → pass through
  ├── has Authorization: Bearer <token>?  No  → 401 "Unauthorized"
  ├── timingSafeCompare(token, API_KEY)?  No  → 401 "Unauthorized"
  └── Yes  → pass through
```

The token comparison uses `crypto.timingSafeEqual` (via the exported `timingSafeCompare` helper) to prevent timing side-channel attacks. Both failure paths return the same `"Unauthorized"` message to avoid giving attackers a coarse oracle on which step failed.

WebSocket connections cannot send arbitrary HTTP headers in all environments (browsers enforce this). The `/v1/events` route accepts the API key as a `?key=<API_KEY>` query parameter. The check is **synchronous** — it is the first thing the handler does, before the socket is added to the `clients` set.

The `?key=` token is redacted to `[REDACTED]` in all Pino log output by a custom `req` serializer configured at server construction time, so the key never appears in log files regardless of transport.

---

## Security Considerations

See [docs/security.md](security.md) for the full threat model and risk assessment.

### What marmot-server protects (protocol layer)

- **Message confidentiality**: Messages are encrypted with MLS before leaving the server. The Nostr relays see only opaque ciphertext tagged with a hash of the group context.
- **Forward secrecy**: Each MLS commit advances the epoch and ratchets the group key. Old keys are discarded. Compromising the current key does not expose past messages.
- **Post-compromise security**: `selfUpdate()` (called after joining) rotates local key material, limiting the blast radius of a compromised endpoint key.
- **Sealed sender**: Welcome messages are delivered in kind-1059 gift wraps that hide the sender's identity from relay operators.

### What marmot-server does NOT protect

- **The local database**: The SQLite file at `/data/marmot.db` contains the Nostr private key and all MLS group state in plaintext. Protect the `/data` volume at the host level.
- **The HTTP API**: The `API_KEY` is a simple shared secret — not per-client, not rotatable without restart. marmot-server is designed as a local service accessed by a single trusted client.
- **Relay metadata**: Relay operators can observe which pubkeys subscribe to which groups (by Nostr group hash), message timing, and the outer `#p` tag of gift-wrapped envelopes.
- **MLS group admin**: The "admin" concept in Marmot is social (tracked in `GroupInfo`), not cryptographically enforced at the MLS layer.

### Threat model

marmot-server is intended to run as a **local daemon**, accessed by a single trusted application. It is not hardened for multi-tenant, internet-facing, or adversarial environments without additional network-layer controls (reverse proxy, firewall, VPN).

---

## Dependency Map

```
marmot-server
├── fastify@5                   HTTP server
│   ├── @fastify/websocket      WebSocket support
│   ├── @fastify/swagger        OpenAPI spec generation
│   └── @fastify/swagger-ui     Swagger UI
├── @internet-privacy/marmot-ts MLS + Nostr group messaging SDK
│   ├── ts-mls                  MLS RFC 9420 implementation
│   └── applesauce-*            Nostr event helpers
├── nostr-tools@2               Nostr key ops, SimplePool, event signing
├── @noble/hashes               Cryptographic hashing (secp256k1 support)
├── better-sqlite3              Synchronous SQLite bindings (native module)
└── eventemitter3               Typed EventEmitter for service → WS fan-out
```

### Why these choices

| Choice | Rationale |
|--------|-----------|
| Fastify over Express | Lower overhead, built-in JSON schema validation, native async, TypeScript-first |
| better-sqlite3 | Synchronous API simplifies storage layer; WAL mode handles concurrent reads adequately for a single-user daemon |
| nostr-tools SimplePool | Minimal, well-maintained; handles relay multiplexing and reconnection |
| ESM + Node16 module resolution | Required by marmot-ts and its dependencies; `module: "Node16"` + `moduleResolution: "node16"` must match |
| Single SQLite file | Zero-ops persistence; trivial backup (copy file); no separate database process |
