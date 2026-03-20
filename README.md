# marmot-server

A self-hosted Docker container that exposes the [Marmot protocol](https://github.com/marmot-protocol/marmot) — MLS-encrypted group messaging over Nostr — as a REST API and WebSocket interface. Inspired by the [signal-cli](https://github.com/AsamK/signal-cli) daemon pattern.

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Authentication](#authentication)
- [API Reference](#api-reference)
  - [Health](#health)
  - [Identity](#identity)
  - [Key Packages](#key-packages)
  - [Groups](#groups)
  - [Messages](#messages)
  - [Invites](#invites)
  - [Real-time Events (WebSocket)](#real-time-events-websocket)
- [WebSocket Event Schema](#websocket-event-schema)
- [Typical Workflows](#typical-workflows)
- [Data Persistence](#data-persistence)
- [Development](#development)
- [Architecture](#architecture)

---

## Overview

Marmot combines two protocols:

| Layer | Protocol | Purpose |
|-------|----------|---------|
| Encryption | [MLS (RFC 9420)](https://www.rfc-editor.org/rfc/rfc9420) | Post-quantum-safe group key agreement, forward secrecy |
| Transport | [Nostr](https://nostr.com) | Decentralized relay network for message delivery |

`marmot-server` wraps the [`@internet-privacy/marmot-ts`](https://www.npmjs.com/package/@internet-privacy/marmot-ts) SDK and manages the full lifecycle:

- Generating and persisting a Nostr identity (keypair)
- Publishing and rotating MLS key packages so others can invite you to groups
- Creating groups, inviting members, removing members
- Sending and receiving end-to-end encrypted messages
- Accepting / declining incoming group invitations (gift-wrapped Welcome messages)
- Streaming all activity over a WebSocket for real-time clients

All state is persisted in a single SQLite database at `/data/marmot.db`.

---

## Quick Start

### Docker Compose (recommended)

```yaml
# docker-compose.yml
services:
  marmot-server:
    image: marmot-server:latest
    build: .
    ports:
      - "8080:8080"
    volumes:
      - ./data:/data
    environment:
      API_KEY: "change-me"
      DEFAULT_RELAYS: "wss://relay.damus.io,wss://nos.lol"
      DB_PATH: "/data/marmot.db"
      LOG_LEVEL: "info"
    restart: unless-stopped
```

```bash
docker compose up -d
```

The server is ready when `GET /health` returns `{"ok":true}`.

### Docker CLI

```bash
docker build -t marmot-server .
docker run -d \
  -p 8080:8080 \
  -v "$(pwd)/data:/data" \
  -e API_KEY="change-me" \
  marmot-server
```

### Local Development

```bash
npm install
npm run dev          # tsx watch mode
# or
npm run build && npm start
```

Swagger UI is available at `http://localhost:8080/docs`.

---

## Configuration

All configuration is via environment variables.

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST` | `0.0.0.0` | Bind address |
| `PORT` | `8080` | HTTP/WebSocket port |
| `DB_PATH` | `/data/marmot.db` | SQLite database file path |
| `API_KEY` | _(unset)_ | If set, enables Bearer token authentication on all endpoints |
| `DEFAULT_RELAYS` | `wss://relay.damus.io,wss://nos.lol` | Comma-separated list of Nostr relays used for key package publishing and group subscriptions |
| `LOG_LEVEL` | `info` | Pino log level: `trace`, `debug`, `info`, `warn`, `error` |

---

## Authentication

Authentication is **optional**. If `API_KEY` is not set, the server is fully open.

When `API_KEY` is set:

- **HTTP requests**: include the header `Authorization: Bearer <API_KEY>`
- **WebSocket**: append `?key=<API_KEY>` to the connection URL

The WebSocket query-string token is necessary because the browser WebSocket API does not allow custom headers. The server redacts `?key=…` from all access log entries (replaced with `[REDACTED]`), so the key does not appear in log files. Use TLS (a reverse proxy) to prevent the token from being observed on the wire.

The following paths are **always public** regardless of `API_KEY`:

- `GET /health`
- `GET /docs` (Swagger UI and its JSON/YAML spec)

### Examples

```bash
# HTTP
curl -H "Authorization: Bearer change-me" http://localhost:8080/v1/identity

# WebSocket (wscat)
wscat -c "ws://localhost:8080/v1/events?key=change-me"
```

---

## API Reference

### Health

#### `GET /health`

Liveness check. Always returns 200, no auth required.

**Response**
```json
{ "ok": true }
```

---

### Identity

The server manages a single Nostr identity (keypair). The private key is generated on first boot and persisted in SQLite. It never changes unless the database is deleted.

#### `GET /v1/identity`

Returns the server's Nostr public key and the configured default relays.

**Response `200`**
```json
{
  "pubkey": "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d",
  "defaultRelays": [
    "wss://relay.damus.io",
    "wss://nos.lol"
  ]
}
```

---

### Key Packages

MLS key packages (Nostr kind 443) are one-time-use credential bundles that allow others to add you to a group. You must publish at least one key package before anyone can invite you to a group.

#### `GET /v1/key-packages`

List all locally stored key packages.

**Response `200`**
```json
[
  {
    "ref": "a674efc3d8...",
    "publishedEventIds": ["b3e1f2a..."],
    "used": false
  }
]
```

| Field | Description |
|-------|-------------|
| `ref` | Hex-encoded key package reference (unique identifier) |
| `publishedEventIds` | Nostr event IDs of the published kind-443 events |
| `used` | `true` if the key package has been consumed by a Welcome |

#### `POST /v1/key-packages`

Create and publish a new key package to the specified relays.

**Request body** (all fields optional)
```json
{
  "relays": ["wss://relay.damus.io"],
  "isLastResort": true
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `relays` | `DEFAULT_RELAYS` | Relays to publish to (must be valid `wss://` or `ws://` URLs) |
| `isLastResort` | `true` | Mark as last-resort (reusable) key package |

**Response `201`**
```json
{
  "ref": "a674efc3d8...",
  "publishedEventIds": ["b3e1f2a..."]
}
```

**Response `400`** if any relay URL is not a valid `wss://` or `ws://` address.

#### `POST /v1/key-packages/:ref/rotate`

Deletes the key package at `:ref` from the relay and creates a fresh replacement. Use this to cycle key material periodically.

**Response `200`**
```json
{ "ref": "c9f3ba1d2e..." }
```

#### `DELETE /v1/key-packages/:ref`

Purge a key package from local storage and revoke it from relays.

**Response `204`** No content.

---

### Groups

Groups are MLS groups whose state is TLS-serialized and stored in SQLite. Each group has a Nostr "group ID" (a hash of the MLS group context) used to tag events on relays.

#### `GET /v1/groups`

List all groups the server is a member of.

**Response `200`**
```json
[
  {
    "id": "35bffd6e4a...",
    "name": "My Group",
    "description": "A test group",
    "adminPubkeys": ["3bf0c63f..."],
    "relays": ["wss://relay.damus.io"],
    "epoch": 0
  }
]
```

| Field | Description |
|-------|-------------|
| `id` | MLS group ID (hex) |
| `name` | Human-readable group name |
| `description` | Group description |
| `adminPubkeys` | Nostr pubkeys of group admins |
| `relays` | Relays used for this group's events |
| `epoch` | Current MLS epoch (increments on each commit) |

#### `GET /v1/groups/:groupId`

Get details for a single group.

**Response `200`** — same shape as list item above.

**Response `404`** if the group does not exist.

#### `POST /v1/groups`

Create a new group. The server's identity becomes the initial member.

**Request body**
```json
{
  "name": "My Group",
  "description": "Optional description",
  "relays": ["wss://relay.damus.io"],
  "adminPubkeys": ["3bf0c63f..."]
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | Yes | — | Group name |
| `description` | No | `""` | Group description |
| `relays` | No | `DEFAULT_RELAYS` | Relays for group events (must be valid `wss://` or `ws://` URLs) |
| `adminPubkeys` | No | `[]` | Additional admin pubkeys |

**Response `201`** — group object (same shape as GET).

**Response `400`** if any relay URL is not a valid `wss://` or `ws://` address.

#### `DELETE /v1/groups/:groupId`

Destroy a group locally. Purges all local MLS state and message history. Does **not** send any network message — use `/leave` to signal departure to other members first.

**Response `204`** No content.

**Response `404`** if the group does not exist.

#### `POST /v1/groups/:groupId/leave`

Publish a self-remove proposal, commit it, then purge local state. Other members will process the removal on their next event ingest.

**Response `204`** No content.

**Response `404`** if the group does not exist.

#### `POST /v1/groups/:groupId/invite`

Invite a user to the group by fetching their key package from relays.

**Request body**
```json
{
  "pubkey": "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d",
  "keyPackageEventId": "b3e1f2a..."
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `pubkey` | Yes | Nostr pubkey of the person to invite |
| `keyPackageEventId` | No | Specific key package event ID to use. If omitted, the most recent key package is used. |

The server fetches the invitee's kind-443 key package from the group's relays, creates an MLS Welcome message, and publishes it as a kind-1059 gift wrap addressed to the invitee.

**Response `204`** No content.

**Response `404`** if the group does not exist, or if no key package is found for the pubkey on the group's relays.

#### `DELETE /v1/groups/:groupId/members/:pubkey`

Remove a member from the group (admin only). Publishes a remove proposal and commits it.

**Response `204`** No content.

**Response `404`** if the group does not exist.

---

### Messages

#### `POST /v1/groups/:groupId/messages`

Send an encrypted chat message to a group.

**Request body**
```json
{
  "content": "Hello, group!",
  "tags": [["reply", "some-event-id"]]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `content` | Yes | Message text |
| `tags` | No | Nostr-style tags (e.g., reply threads) |

The message is MLS-encrypted, wrapped in a Nostr kind-445 event, and published to the group's relays. The request body is capped at 64 KiB; larger payloads receive `413 Payload Too Large`.

**Response `201`**
```json
{ "ok": true }
```

**Response `404`** if the group does not exist.

#### `GET /v1/groups/:groupId/messages`

Query message history from the local SQLite store. Messages are only stored here after being received and decrypted via relay subscription.

**Query parameters**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `limit` | `50` | Maximum messages to return (capped at 200) |
| `since` | `0` | Unix timestamp — only return messages after this time |

**Response `200`**
```json
[
  {
    "id": "d4e5f6a7...",
    "groupId": "35bffd6e...",
    "sender": "3bf0c63f...",
    "kind": 9,
    "content": "Hello, group!",
    "tags": [],
    "createdAt": 1700000000
  }
]
```

| Field | Description |
|-------|-------------|
| `id` | Nostr event ID of the inner rumor |
| `groupId` | MLS group ID (hex) |
| `sender` | Sender's Nostr pubkey |
| `kind` | Nostr event kind of the inner rumor (typically 9 for chat) |
| `content` | Decrypted message content |
| `tags` | Inner rumor tags |
| `createdAt` | Unix timestamp |

---

### Invites

Invitations arrive as kind-1059 gift-wrapped Welcome messages (kind 444 inside) addressed to the server's pubkey. The server automatically watches for these on the default relays.

#### `GET /v1/invites`

List all pending (unread) invitations.

**Response `200`**
```json
[
  {
    "id": "e1a2b3c4...",
    "inviterPubkey": "3bf0c63f...",
    "groupName": "My Group",
    "createdAt": 1700000000
  }
]
```

| Field | Description |
|-------|-------------|
| `id` | Invite rumor ID — use this in accept/decline calls |
| `inviterPubkey` | Pubkey of the person who invited you |
| `groupName` | Group name decoded from the Welcome payload (may be `null` if unresolvable) |
| `createdAt` | Unix timestamp of the invite |

#### `POST /v1/invites/:inviteId/accept`

Accept an invitation and join the group. After joining, a self-update commit is automatically sent to provide forward secrecy (per MIP-02).

**Response `200`**
```json
{
  "groupId": "35bffd6e...",
  "name": "My Group"
}
```

#### `POST /v1/invites/:inviteId/decline`

Decline an invitation (marks it as read without joining).

**Response `204`** No content.

---

### Real-time Events (WebSocket)

#### `WS /v1/events`

Connect to receive a live stream of all server activity as JSON messages.

**Connection**
```
ws://localhost:8080/v1/events
ws://localhost:8080/v1/events?key=<API_KEY>   # when auth is enabled
```

On successful connection, the server immediately sends:
```json
{ "type": "connected", "pubkey": "3bf0c63f..." }
```

---

## WebSocket Event Schema

All events share a `type` discriminator field.

### `message` — Incoming chat message

Emitted when a new decrypted group message is received from a relay.

```json
{
  "type": "message",
  "groupId": "35bffd6e...",
  "message": {
    "id": "d4e5f6a7...",
    "sender": "3bf0c63f...",
    "kind": 9,
    "content": "Hello!",
    "tags": [],
    "createdAt": 1700000000
  }
}
```

### `invite` — New group invitation

Emitted when a kind-1059 gift wrap addressed to this server is received and decrypted.

```json
{
  "type": "invite",
  "inviteId": "e1a2b3c4...",
  "groupName": null,
  "inviterPubkey": "3bf0c63f..."
}
```

> `groupName` is always `null` in the real-time event; resolve it by calling `GET /v1/invites`.

### `group_created` — Group created locally

```json
{
  "type": "group_created",
  "groupId": "35bffd6e...",
  "name": "My Group"
}
```

### `group_joined` — Joined a group via Welcome

```json
{
  "type": "group_joined",
  "groupId": "35bffd6e...",
  "name": "My Group"
}
```

### `group_left` — Left a group

```json
{
  "type": "group_left",
  "groupId": "35bffd6e..."
}
```

### `group_destroyed` — Group purged locally

```json
{
  "type": "group_destroyed",
  "groupId": "35bffd6e..."
}
```

---

## Typical Workflows

### Onboarding: prepare to receive invites

```bash
# 1. See your identity
curl http://localhost:8080/v1/identity

# 2. Publish a key package so others can invite you
curl -X POST http://localhost:8080/v1/key-packages
```

### Create a group and send a message

```bash
# 1. Create group
GROUP=$(curl -s -X POST http://localhost:8080/v1/groups \
  -H "Content-Type: application/json" \
  -d '{"name":"Team Alpha","relays":["wss://relay.damus.io"]}')
GROUP_ID=$(echo $GROUP | jq -r '.id')

# 2. Send a message
curl -X POST http://localhost:8080/v1/groups/$GROUP_ID/messages \
  -H "Content-Type: application/json" \
  -d '{"content":"Hello, team!"}'
```

### Invite another user

```bash
# Invitee must have published a key package on a relay the group uses
curl -X POST http://localhost:8080/v1/groups/$GROUP_ID/invite \
  -H "Content-Type: application/json" \
  -d '{"pubkey":"<invitee-pubkey>"}'
```

### Accept an incoming invite

```bash
# List pending invites
curl http://localhost:8080/v1/invites

# Accept
curl -X POST http://localhost:8080/v1/invites/<inviteId>/accept
```

### Remove a member

```bash
curl -X DELETE http://localhost:8080/v1/groups/$GROUP_ID/members/<pubkey>
```

### Listen for real-time events

```bash
# Using wscat
wscat -c ws://localhost:8080/v1/events

# Using websocat
websocat ws://localhost:8080/v1/events
```

---

## Data Persistence

All data lives in a single SQLite file (`DB_PATH`, default `/data/marmot.db`).

| Table | Contents | Format |
|-------|----------|--------|
| `identity` | Nostr private key | TEXT (hex) |
| `group_state` | MLS group state per group | BLOB (TLS-encoded `SerializedClientState`) |
| `key_packages` | MLS key packages | TEXT (JSON with Uint8Array/BigInt encoding) |
| `invites_received` | Raw received gift-wrap events | TEXT (JSON) |
| `invites_unread` | Unread invite rumor IDs | TEXT (JSON) |
| `invites_seen` | Seen invite IDs (dedup) | TEXT (JSON) |
| `messages` | Decrypted message history | TEXT columns + INTEGER timestamps |

**Backup**: stop the server, copy the database file, restart.

**Reset**: delete the database file. A new identity (keypair) and fresh state will be generated on next boot.

> Warning: deleting the database destroys all group memberships and keys. There is no recovery — other group members will need to re-invite you.

---

## Development

### Prerequisites

- Node.js 18+ (22 recommended)
- npm

### Commands

```bash
npm install          # install dependencies
npm run dev          # run with tsx (no build step)
npm run build        # compile TypeScript to dist/
npm start            # run compiled output
```

### Project Structure

```
src/
  index.ts                 # Entry point: Fastify app, plugin registration, graceful shutdown
  config.ts                # Environment variable configuration
  middleware/
    auth.ts                # Optional Bearer token auth hook
  marmot/
    service.ts             # MarmotService: core singleton, relay subscriptions, event fan-out
  nostr/
    pool.ts                # NostrPool: NostrNetworkInterface wrapping nostr-tools SimplePool
    signer.ts              # PrivateKeySigner: EventSigner using nostr-tools
  store/
    kv-store.ts            # SqliteKvStore<T> and SqliteBlobStore
    message-store.ts       # MessageStore + BaseGroupHistory adapter
  routes/
    identity.ts            # GET /v1/identity
    key-packages.ts        # Key package CRUD
    groups.ts              # Group management and membership
    messages.ts            # Send and retrieve messages
    invites.ts             # Invite lifecycle
    events.ts              # WebSocket real-time events
```

### Swagger UI

When running locally, full interactive API documentation is available at:

```
http://localhost:8080/docs
```

---

## Security

See [docs/security.md](docs/security.md) for the full risk assessment. All identified findings have been remediated or formally accepted:

| ID | Severity | Finding | Status |
|----|----------|---------|--------|
| C1 | CRITICAL | Timing side-channel on API key comparison | Fixed — `crypto.timingSafeEqual` |
| C2 | CRITICAL | Async authentication gap in WebSocket handler | Fixed — synchronous check before socket registration |
| H1 | HIGH | NaN integer injection via query parameters | Fixed — explicit radix + `Number.isFinite` |
| H2 | HIGH | Stack trace leakage from unhandled errors | Fixed — global `setErrorHandler` sanitises 5xx |
| H3 | HIGH | Missing 404 — `getGroup()` throws cascade to 500 | Fixed — `resolveGroup()` wrapper |
| H4 | HIGH | SSRF via unvalidated relay URLs | Fixed — `wss://`/`ws://` protocol allowlist |
| M1 | MEDIUM | API key logged in plaintext via `?key=` query string | Fixed — Pino `req` serializer redacts to `[REDACTED]` |
| M2 | MEDIUM | SQL table name string interpolation | Fixed — allowlist regex guard in store constructors |
| M3 | MEDIUM | No explicit request body size limit | Fixed — `bodyLimit: 65536` (64 KiB) |
| M4 | MEDIUM | No rate limiting | Accepted — local daemon; document strong key selection |
| L1 | LOW | Distinct 401 messages reveal auth state | Fixed — unified `"Unauthorized"` for all 401 paths |
| L2 | LOW | Dynamic `import()` in hot path | Fixed — static import at module load |
| L3 | LOW | No CORS policy | Accepted — correct default for a local daemon |

### Operational security checklist

- Set `API_KEY` to at least 32 random bytes: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- Do **not** expose port 8080 to the public internet — bind to a private network
- Protect the `/data` volume — the SQLite file contains the private key and message history in plaintext
- Put a TLS-terminating reverse proxy (Caddy, nginx) in front for production deployments; this also ensures the WS `?key=` token (already redacted from server logs) is not visible on the wire
- Review structured JSON logs for `500` responses (`"Unhandled server error"` log entries with `reqId`)

---

## Architecture

See [docs/architecture.md](docs/architecture.md) for a deep dive into:

- Protocol layer stack (MLS + Nostr)
- Storage design decisions
- Relay subscription lifecycle
- MLS group lifecycle (create, invite, join, leave, remove, epoch commits)
- Security model and threat considerations
