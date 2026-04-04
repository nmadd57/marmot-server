# marmot-server

A drop-in replacement for [signal-cli](https://github.com/AsamK/signal-cli) that delivers end-to-end encrypted group messaging over [Marmot](https://github.com/marmot-protocol/marmot) (MLS + Nostr) instead of Signal. Any tool built on signal-cli's HTTP daemon API works without modification.

**Why Marmot instead of Signal?**
- No phone number required — identity is a Nostr keypair
- Decentralized relay network — no central server to register with
- Post-quantum-safe group key agreement (MLS RFC 9420)
- Self-hostable with a single Docker container and a SQLite file

---

## Quick Start

```bash
docker compose up -d
```

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
      # Optional: pin a specific keypair (nsec bech32 or 64-char hex)
      # IDENTITY_KEY: "nsec1..."
      # Optional: auto-accept invites from these npubs
      # AUTO_ACCEPT_FROM: "npub1...,npub1..."
    restart: unless-stopped
```

Once running, get the server's public key — you'll need it as the "account" identifier in client config:

```bash
curl http://localhost:8080/v1/identity
# {"pubkey":"83e7324c...","defaultRelays":["wss://relay.damus.io","wss://nos.lol"]}
```

Swagger UI is at `http://localhost:8080/docs`.

---

## hermes-agent

[hermes-agent](https://github.com/NousResearch/hermes-agent) connects to marmot-server via the signal-cli HTTP API with no changes required.

```bash
SIGNAL_HTTP_URL=http://localhost:8080
SIGNAL_ACCOUNT=<pubkey from /v1/identity>

# If API_KEY is set:
SIGNAL_API_KEY=change-me

# Access control (mirrors TELEGRAM_ALLOWED_USERS / SLACK_ALLOWED_USERS):
SIGNAL_ALLOWED_USERS=npub1...,npub1...   # only forward messages from these pubkeys
# SIGNAL_ALLOW_ALL_USERS=true            # skip sender filtering entirely (open access)
# SIGNAL_GROUP_ALLOWED_USERS=*           # which groups to forward (* = all, default)
```

That's it. hermes-agent's `send`, `sendTyping`, `getContact`, `listGroups`, `getGroup`, and SSE receive stream all work out of the box.

---

## OpenClaw

[OpenClaw](https://docs.openclaw.ai/channels/signal) uses marmot-server as an external Signal daemon via the `httpUrl` setting.

```json5
{
  channels: {
    signal: {
      enabled: true,
      account: "<pubkey from /v1/identity>",
      httpUrl: "http://localhost:8080",
      dmPolicy: "disabled",        // Marmot is groups-only; no DM support
      groupPolicy: "open",
      historyLimit: 50,
    },
  },
}
```

**If `API_KEY` is set**, add the Bearer token. OpenClaw passes it via the `Authorization` header on RPC calls and `?key=` on the SSE stream automatically when you set the token in your channel config — consult the OpenClaw docs for the token field name in your version.

**Joining groups**: use Whitenoise, another Marmot client, or the REST API to create or join groups, then reference them in OpenClaw as `signal:group:<base64-group-id>`. Retrieve group IDs from:

```bash
curl http://localhost:8080/v1/groups
```

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST` | `0.0.0.0` | Bind address |
| `PORT` | `8080` | HTTP port |
| `DB_PATH` | `/data/marmot.db` | SQLite database path |
| `API_KEY` | _(unset)_ | Bearer token required on all endpoints when set |
| `DEFAULT_RELAYS` | `wss://relay.damus.io,wss://nos.lol` | Comma-separated Nostr relays |
| `LOG_LEVEL` | `info` | `trace` \| `debug` \| `info` \| `warn` \| `error` |
| `IDENTITY_KEY` | _(unset)_ | Pin a keypair: `nsec1…` bech32 or 64-char hex. Overwrites stored key on startup. |
| `AUTO_ACCEPT_FROM` | _(unset)_ | Comma-separated npubs/hex pubkeys whose group invitations are auto-accepted. |
| `SIGNAL_ALLOWED_USERS` | _(unset)_ | Comma-separated npubs/hex pubkeys allowed to send messages to the agent via SSE. When set, all other senders are dropped. When unset, unknown senders are also dropped unless `SIGNAL_ALLOW_ALL_USERS=true`. |
| `SIGNAL_ALLOW_ALL_USERS` | `false` | Set to `true` to forward messages from all senders without an allowlist. Equivalent to open-access mode. |
| `SIGNAL_GROUP_ALLOWED_USERS` | `*` | Which groups to forward. `*` or unset = all groups. Comma-separated base64 group IDs to restrict to specific groups. Note: marmot defaults to all groups since DMs don't exist; signal-cli defaults to DM-only. |

---

## signal-cli API

marmot-server exposes the same HTTP interface as `signal-cli --http`:

| Endpoint | Description |
|----------|-------------|
| `POST /api/v1/rpc` | JSON-RPC 2.0 (single or batch) |
| `GET /api/v1/events` | SSE stream — `data: {"envelope":{...}}` per message |
| `GET /api/v1/check` | Liveness probe (no auth) |

### Supported methods

`send` · `sendMessage` · `sendTyping` · `sendReaction` · `getContact` · `getProfile` / `getSelfProfile` · `listGroups` · `getGroup` · `createGroup` · `updateGroup` · `leaveGroup` / `quitGroup` · `deleteGroup` · `listContacts` · `listDevices` · `listIdentities` · `subscribeReceive` · `unsubscribeReceive` · `receive`

**Protocol notes:**
- The `account` param is accepted and ignored (single-identity server)
- Group IDs are base64-encoded on the wire (signal-cli convention)
- Direct messages are not supported — `send` without a `groupId` no-ops silently
- `getContact` resolves Nostr pubkeys to display names via kind-0 profile lookup (5-minute cache)

### Authentication

- HTTP: `Authorization: Bearer <API_KEY>`
- SSE: `?key=<API_KEY>` query param or `Authorization: Bearer <API_KEY>` header
- Unprotected: `GET /health`, `GET /docs`, `GET /api/v1/check`

---

## REST API

The full REST API is documented interactively at `/docs`. Quick reference:

| Endpoint | Description |
|----------|-------------|
| `GET /v1/identity` | Server pubkey and relay list |
| `GET/POST /v1/key-packages` | MLS key package lifecycle |
| `POST /v1/key-packages/:ref/rotate` | Rotate a key package |
| `DELETE /v1/key-packages/:ref` | Purge a key package |
| `GET/POST /v1/groups` | List or create groups |
| `GET/DELETE /v1/groups/:id` | Get or destroy a group |
| `POST /v1/groups/:id/leave` | Leave a group |
| `POST /v1/groups/:id/invite` | Invite a user by pubkey |
| `DELETE /v1/groups/:id/members/:pubkey` | Remove a member |
| `GET/POST /v1/groups/:id/messages` | Message history / send |
| `GET /v1/invites` | List pending invitations |
| `POST /v1/invites/:id/accept` | Accept an invitation |
| `POST /v1/invites/:id/decline` | Decline an invitation |
| `WS /v1/events` | Real-time event stream |

---

## Preparing to receive invites

Before another Marmot client (e.g. Whitenoise) can add the server to a group, publish a key package:

```bash
curl -X POST http://localhost:8080/v1/key-packages
```

Then share the server's pubkey (`GET /v1/identity`) with the person inviting you. Once they send the invite, either accept it manually:

```bash
curl http://localhost:8080/v1/invites
curl -X POST http://localhost:8080/v1/invites/<id>/accept
```

Or set `AUTO_ACCEPT_FROM` to auto-accept from trusted pubkeys.

---

## Data & Security

All state lives in a single SQLite file (`DB_PATH`). To back up: stop the server, copy the file, restart.

> The database contains the private key and full message history in plaintext. Protect the `/data` volume accordingly.

- Set `API_KEY` to at least 32 random bytes: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- Do not expose port 8080 to the public internet
- Use a TLS-terminating reverse proxy (Caddy, nginx) in production to protect the WS/SSE `?key=` token on the wire

See [RISK_ASSESSMENT.md](RISK_ASSESSMENT.md) for the full security audit.

---

## Development

```bash
npm install
npm run dev       # tsx, no build step
npm run build     # compile to dist/
npm start         # run compiled output
```

### Project structure

```
src/
  index.ts              # Fastify app, startup, graceful shutdown
  config.ts             # Environment variable config
  middleware/auth.ts    # Bearer token auth hook
  marmot/service.ts     # Core: relay subscriptions, event fan-out
  nostr/pool.ts         # NostrPool wrapping nostr-tools SimplePool
  nostr/signer.ts       # PrivateKeySigner (nostr-tools)
  store/kv-store.ts     # SqliteKvStore + SqliteBlobStore
  store/message-store.ts
  routes/               # REST API routes (identity, groups, messages, …)
  routes/signal.ts      # signal-cli compat transport
  signal/dispatcher.ts  # JSON-RPC method handlers
  signal/types.ts       # JsonRpcRequest/Response, SignalEnvelope types
```
