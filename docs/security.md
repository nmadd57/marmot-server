# marmot-server — Security

This document covers the threat model, accepted risks, and operational security guidance for marmot-server.

**Assessment date:** 2026-03-19
**Scope:** All TypeScript source files in `src/`
**Methodology:** Manual code review against the intended deployment model (local daemon, single trusted client)

---

## Threat Model

### Intended deployment

marmot-server is a **local daemon** running inside a Docker container, accessed by a single trusted local application (e.g. a desktop app, a CLI tool, or another container on the same Docker network). It is not designed to be exposed to the public internet.

### In-scope threats (mitigated)

| Threat | Mitigation |
|--------|-----------|
| API key enumeration via timing side-channel | Constant-time comparison (`crypto.timingSafeEqual`) |
| Unauthenticated WebSocket connection | Synchronous auth check before socket is registered |
| API key exposure in server access logs | `?key=` redacted to `[REDACTED]` by Pino `req` serializer |
| Internal error details leaking to callers | Global `setErrorHandler` sanitises 5xx; full error logged server-side |
| Incorrect HTTP status codes masking 404s | `resolveGroup()` wrapper returns clean 404 for unknown groups |
| SSRF via user-supplied relay URLs | Protocol allowlist: only `wss://` and `ws://` accepted |
| SQL identifier injection in store layer | Allowlist regex validates table names at construction time |
| Oversized request bodies consuming resources | Explicit `bodyLimit: 65536` (64 KiB) in Fastify constructor |

### Out-of-scope threats (accepted with documentation)

| Threat | Rationale |
|--------|-----------|
| Physical access to the host machine | Out of scope for the application layer |
| Compromise of the SQLite database file | Protect the `/data` volume at the host/container level |
| Network-adjacent SSRF to internal `ws://` hosts | Protocol allowlist prevents non-WS schemes; egress firewall needed for full SSRF prevention |
| API key brute-force at unlimited rate | No rate limiting (see M4 below); mitigated by requiring a strong key |
| Relay operator metadata observation | Inherent in the Nostr transport layer; by design |

---

## Accepted Risks

### M4 — No Rate Limiting

There is no rate limiting on any endpoint. An authenticated caller can send unlimited requests, enabling:

- High-volume message publishing that floods group relays
- Group creation spam that accumulates MLS state in SQLite
- Sustained request load consuming CPU and memory

**Accepted:** marmot-server is a local daemon accessed by a single trusted client. Rate limiting is appropriate if the API is ever exposed beyond a local network boundary. The `@fastify/rate-limit` plugin can be added if needed.

**Key selection guidance:** Use an API key of at least 32 random bytes (256 bits of entropy). With such a key, brute-force is computationally infeasible regardless of rate:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

### L3 — No CORS Policy

No `Access-Control-Allow-Origin` header is set. Browsers block cross-origin JavaScript from calling the API by default (same-origin policy).

**Accepted:** The absence of a CORS policy is the correct security posture for a local daemon — it prevents malicious web pages from using a visitor's browser as an unwitting API client. If the API must be called from a browser frontend on a different origin, CORS should be explicitly configured with a strict origin allowlist, never `*`.

---

## What Is Not Protected

- **The private key**: The Nostr private key is stored in plaintext in `/data/marmot.db`. Anyone with read access to this file can impersonate the server's identity. Protect the file with filesystem permissions and/or volume encryption.
- **Message history**: Decrypted messages are stored in plaintext in the `messages` SQLite table. MLS encryption only protects messages in transit over Nostr relays.
- **Multi-tenant isolation**: There is one identity and one API key. marmot-server is not designed for multi-user scenarios.
- **Relay metadata**: Relay operators can observe which pubkeys subscribe to which groups (by Nostr group hash), message timing, and the outer `#p` tag of gift-wrapped envelopes.
- **MLS group admin enforcement**: The admin concept in Marmot is social (tracked in `GroupInfo`), not cryptographically enforced at the MLS layer.

---

## Recommended Operational Controls

1. **Set a strong `API_KEY`** (≥32 random bytes). With no key set, the API is fully open to anyone with network access.
2. **Do not expose port 8080 to the public internet.** Bind to `127.0.0.1` or a private Docker network.
3. **Protect the `/data` volume.** Use Docker volume encryption or host filesystem permissions (`chmod 700`) to prevent unauthorised read access to the database file.
4. **Use TLS in front of the server.** A TLS-terminating reverse proxy (Caddy, nginx) prevents the WS `?key=` token from being observed on the wire. The token is already redacted from server-side logs, but wire-level protection requires TLS.
5. **Rotate the API key periodically.** Update `API_KEY` in the container environment and restart. No data migration is required.
6. **Monitor for unexpected 500 responses.** Log entries with message `"Unhandled server error"` include the full error and a `reqId` field for correlation with client-observed failures.
