# marmot-server — Security Risk Assessment

This document is the formal security risk assessment for marmot-server. It covers every finding identified during code review, the risk rating for each, the remediation applied, and residual risk guidance.

**Assessment date:** 2026-03-19
**Scope:** All TypeScript source files in `src/`
**Methodology:** Manual code review, threat modelling against the intended deployment model (local daemon, single trusted client)

---

## Rating Scale

| Severity | Definition |
|----------|-----------|
| **CRITICAL** | Exploitable remotely with low effort; directly compromises confidentiality, integrity, or availability of the API key, identity key, or group messages |
| **HIGH** | Exploitable with moderate effort or limited preconditions; causes incorrect behaviour, information disclosure, or resource abuse |
| **MEDIUM** | Requires specific conditions or insider access; limited impact in isolation but can be chained with other findings |
| **LOW** | Minor information exposure, hardening gap, or code quality issue with negligible security impact in the intended deployment |

---

## Summary

| ID | Severity | Title | Status |
|----|----------|-------|--------|
| C1 | CRITICAL | Timing side-channel on API key comparison | **Fixed** |
| C2 | CRITICAL | Async authentication gap in WebSocket handler | **Fixed** |
| H1 | HIGH | NaN integer injection via query parameters | **Fixed** |
| H2 | HIGH | Unhandled errors expose internal stack traces | **Fixed** |
| H3 | HIGH | Missing 404 — `getGroup()` throws cascade to 500 | **Fixed** |
| H4 | HIGH | SSRF via unvalidated user-supplied relay URLs | **Fixed** |
| M1 | MEDIUM | API key logged in plaintext via `?key=` query string | **Fixed** |
| M2 | MEDIUM | SQL table name string interpolation | **Fixed** |
| M3 | MEDIUM | No explicit request body size limit | **Fixed** |
| M4 | MEDIUM | No rate limiting | Accepted / Documented |
| L1 | LOW | Distinct 401 messages reveal auth state | **Fixed** |
| L2 | LOW | Dynamic `import()` inside route handler hot path | **Fixed** |
| L3 | LOW | No CORS policy | Accepted / Documented |

---

## Critical Findings

### C1 — Timing Side-Channel on API Key Comparison

**File:** `src/middleware/auth.ts`
**Original line:** `if (token !== config.apiKey)`

**Description**

The JavaScript `!==` / `===` operators perform a lexicographic string comparison and **short-circuit on the first mismatched byte**. An attacker can exploit this by:

1. Sending many requests with keys that differ by one character at a time.
2. Measuring the response latency distribution for each candidate character.
3. Using the shortest-latency (earliest mismatch) result to enumerate the correct key byte by byte.

This is a classical **timing side-channel attack**. It is practical over a local network and has been demonstrated against production API keys with far fewer requests than a brute-force search of the key space.

**Fix applied**

```typescript
// src/middleware/auth.ts
import { timingSafeEqual } from "crypto";

export function timingSafeCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    timingSafeEqual(aBuf, aBuf); // dummy run so length mismatch has same cost
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}
```

`crypto.timingSafeEqual` is Node.js's native constant-time comparison, implemented in C++ to prevent the compiler or JIT from reordering or short-circuiting the comparison.

The same `timingSafeCompare` export is used in the WebSocket handler (`src/routes/events.ts`) where the same vulnerability was independently present.

**Residual risk:** None. The comparison is now constant-time for equal-length inputs. The length check leaks whether the submitted key has the right length (this is a known, accepted property of this approach — the same technique is used in Django, Rails, and most security-conscious web frameworks).

---

### C2 — Async Authentication Gap in WebSocket Handler

**File:** `src/routes/events.ts` (original version)

**Description**

The original WebSocket handler performed the API key check inside a `dynamic import().then()` callback:

```typescript
// VULNERABLE — original code
(socket, req) => {
  const { config } = req.server as unknown as { ... }; // dead variable
  import("../config.js").then(({ config: cfg }) => {   // async!
    if (cfg.apiKey) {
      if (key !== cfg.apiKey) { socket.close(...); return; }
    }
    clients.add(socket);
  });
}
```

This introduced two distinct vulnerabilities:

1. **Async auth window.** Between the WebSocket handshake completing and the `import()` promise resolving, the socket was fully open. A client that sent data immediately on connect could do so before the auth check ran. While no message processing would occur (the socket wasn't in `clients` yet), the socket was accepted by the server and in an indeterminate state.

2. **Silent failure on import rejection.** If the dynamic `import()` had failed (e.g. due to a module resolution error during development), the `.then()` callback would never run. The socket would remain open indefinitely with no auth check having run and no `close` being called.

3. **Dead variable.** The `const { config } = req.server as unknown as { ... }` cast on line 43 produced a `config` variable that was never used, silently shadowed by the `cfg` binding inside the callback.

**Fix applied**

Replaced the dynamic import with a static top-level import and moved the auth check to be **synchronous and the first thing the handler does** before any other operation:

```typescript
// FIXED
import { config } from "../config.js";           // static — resolved at module load
import { timingSafeCompare } from "../middleware/auth.js";

(socket, req) => {
  if (config.apiKey) {                            // synchronous
    const key = (req.query as Record<string, string>).key;
    if (!key || !timingSafeCompare(key, config.apiKey)) {
      socket.send(JSON.stringify({ error: "Unauthorized" }));
      socket.close(1008, "Unauthorized");
      return;                                     // socket never enters clients set
    }
  }
  clients.add(socket);
  // ...
}
```

**Residual risk:** None. Auth is synchronous, uses constant-time comparison, and the socket is rejected before being added to any client set.

---

## High Findings

### H1 — NaN Integer Injection via Query Parameters

**File:** `src/routes/messages.ts`
**Original lines:**
```typescript
const limit = Math.min(parseInt(req.query.limit ?? "50"), 200);
const since = parseInt(req.query.since ?? "0");
```

**Description**

`parseInt("abc")` returns `NaN`. `Math.min(NaN, 200)` returns `NaN`. When `NaN` is passed to a `better-sqlite3` prepared statement as a bound parameter, the driver binds it as `NULL` (IEEE 754 NaN has no direct SQLite equivalent).

SQLite behaviour with NULL parameters:

| Parameter | Bound as | SQL effect |
|-----------|----------|-----------|
| `limit = NaN` | NULL | `LIMIT NULL` → SQLite treats as `LIMIT -1` (no limit) — returns **all rows** for the group |
| `since = NaN` | NULL | `created_at > NULL` → always NULL (falsy) → returns **zero rows** |

The `limit` case is the dangerous one: a caller sending `?limit=garbage` bypasses the 200-row cap and receives the entire message history for a group in a single response. In a busy group this could be a large data transfer, and in a future version where pagination is enforced for billing/quota reasons, it would be a bypass.

Additionally, `parseInt` without an explicit radix defaults to base-10 in modern JS (ES5+), but the [ECMA spec](https://tc39.es/ecma262/#sec-parseint-string-radix) still permits implementation-defined treatment of strings beginning with `0`. Passing radix `10` explicitly is the defensive standard.

**Fix applied**

```typescript
const rawLimit = parseInt(req.query.limit ?? "50", 10);
const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50, 200);
const rawSince = parseInt(req.query.since ?? "0", 10);
const since = Number.isFinite(rawSince) && rawSince >= 0 ? rawSince : 0;
```

`Number.isFinite` returns `false` for `NaN`, `Infinity`, and `-Infinity`. Any non-finite value silently defaults to the safe fallback (50 for limit, 0 for since).

**Residual risk:** None.

---

### H2 — Unhandled Errors Expose Internal Stack Traces

**File:** `src/index.ts`

**Description**

Fastify's default error serialiser forwards the raw `error.message` string in the HTTP response body for **all** status codes including 500. When route handlers throw unexpected errors, the response body may contain:

- File system paths (e.g. `ENOENT: no such file '/data/marmot.db'`)
- Module names and versions (e.g. `Cannot read properties of undefined (reading 'epoch')`)
- SQL query fragments leaked from `better-sqlite3` errors
- MLS library internal state descriptions
- Stack traces when `Error.stack` is serialised by certain Fastify versions

This information assists an attacker in understanding the server's internal structure, dependency versions, and data layout — all of which reduce the effort required to find further vulnerabilities.

**Fix applied**

Added a global `setErrorHandler` that:
- For **5xx responses**: logs the full error (including stack) at `ERROR` level server-side, then returns a generic `{"error":"Internal Server Error","message":"An unexpected error occurred"}` to the caller.
- For **4xx responses**: passes the error name and message through (these are intentional client errors from route handlers).

```typescript
fastify.setErrorHandler((error, req, reply) => {
  const err = error as { statusCode?: number; name?: string; message?: string };
  const statusCode = err.statusCode ?? 500;
  if (statusCode >= 500) {
    fastify.log.error({ err: error, reqId: req.id }, "Unhandled server error");
    reply.status(500).send({ error: "Internal Server Error", message: "An unexpected error occurred" });
  } else {
    reply.status(statusCode).send({ error: err.name ?? "Error", message: err.message ?? "Request failed" });
  }
});
```

**Residual risk:** Internal errors are now logged with `reqId` for correlation. A trusted operator can match a client-observed 500 to the corresponding server log entry.

---

### H3 — Missing 404 — `getGroup()` Throws Cascade to 500

**Files:** `src/routes/groups.ts`, `src/routes/messages.ts`

**Description**

`service.client.getGroup(id)` throws an exception when the requested group does not exist. Without a try/catch, this exception propagates to Fastify's default error handler, which returns a `500 Internal Server Error` response. The correct HTTP semantics are `404 Not Found`.

This caused two problems:

1. **Incorrect HTTP status codes** confuse API consumers and monitoring systems.
2. **Before H2 was fixed**, the raw exception message was forwarded in the response body (potential information disclosure).

Affected endpoints before the fix:
- `GET /v1/groups/:groupId`
- `DELETE /v1/groups/:groupId`
- `POST /v1/groups/:groupId/leave`
- `POST /v1/groups/:groupId/invite`
- `DELETE /v1/groups/:groupId/members/:pubkey`
- `POST /v1/groups/:groupId/messages` (send)

**Fix applied**

Added a `resolveGroup()` helper in both route files that wraps `getGroup()` in a try/catch and sends a clean 404 on failure:

```typescript
async function resolveGroup(service, groupId, reply) {
  try {
    return await service.client.getGroup(groupId);
  } catch {
    reply.status(404).send({ error: "Not Found", message: "Group not found" });
    return null;
  }
}
```

All callers check `if (!group) return;` immediately after, preventing further execution with a null group reference.

**Residual risk:** The catch block catches all `getGroup()` failures, including potential deeper errors (e.g. database read failures). These will now surface as 404 rather than 500. In practice, database failures at this layer will likely also affect the global error handler via other routes; the trade-off is acceptable given the intended deployment model.

---

### H4 — SSRF via Unvalidated User-Supplied Relay URLs

**Files:** `src/routes/groups.ts` (`POST /v1/groups`), `src/routes/key-packages.ts` (`POST /v1/key-packages`)

**Description**

Both endpoints accept a user-supplied `relays` array of strings, which are passed directly to `service.pool.publish()` and `service.client.keyPackages.create()`. These functions open WebSocket connections to the supplied URLs via `nostr-tools SimplePool`.

An attacker with API access can supply arbitrary URLs including:

- **Internal service targets** — e.g. `ws://redis:6379`, `ws://postgres:5432`, `ws://metadata.internal/`, causing the server to initiate TCP connections to services only reachable from inside the container network. The server acts as an unwitting proxy, and some protocols (Redis, Memcached, internal HTTP) can be manipulated using WebSocket framing to send arbitrary bytes.
- **Credential-bearing URLs** — e.g. `wss://user:pass@host/`, which may surface credentials in logs or error messages.
- **Non-WebSocket URLs** — e.g. `http://internal-api/reset`, which cause connection errors whose messages may leak internal hostnames.
- **URL schemes for local resources** — e.g. `file:///etc/passwd` (unlikely to open WebSocket connections, but may cause unexpected behavior in the URL parser).

This is a **Server-Side Request Forgery (SSRF)** vulnerability. It is exploitable by any authenticated API caller (or any caller when `API_KEY` is not set).

**Fix applied**

Added `isValidRelayUrl()` in both route files that validates the `protocol` field parsed by the WHATWG `URL` constructor:

```typescript
function isValidRelayUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "wss:" || protocol === "ws:";
  } catch {
    return false;
  }
}
```

If any supplied relay fails validation, the route returns `400 Bad Request` before making any network calls. The `DEFAULT_RELAYS` configuration value (from the trusted environment) bypasses this check (it is not user-supplied).

**Residual risk:** `ws://` (non-TLS) is still allowed because the Marmot protocol itself does not mandate TLS on relays and `ws://` is valid for local/test relay deployments. Operators who require all relays to use TLS should configure `DEFAULT_RELAYS` with `wss://` URLs only.

A protocol allowlist does not prevent connecting to valid-WebSocket-protocol internal addresses (e.g. `ws://internal-relay.cluster.local:443`). Complete SSRF prevention requires a network-level egress firewall. This is noted in the residual risk section of the threat model.

---

## Medium Findings

### M1 — API Key Logged in Plaintext via `?key=` Query String

**File:** `src/index.ts`

**Description**

WebSocket clients authenticate by passing the API key as a URL query parameter: `ws://localhost:8080/v1/events?key=<API_KEY>`. This is a design constraint — the WebSocket browser API (`new WebSocket(url)`) does not support custom request headers. Fastify logs all incoming request URLs by default, so without a redaction step the API key appears in plaintext in every access log line for WS upgrade requests.

**Fix applied**

Added a custom Pino `req` serializer in the Fastify constructor options that rewrites any `?key=…` (or `&key=…`) substring to `[REDACTED]` before the URL reaches the log sink:

```typescript
serializers: {
  req(req: any) {
    const rawUrl: string = req.url ?? "";
    return {
      method: req.method,
      url: rawUrl.replace(/([?&]key=)[^&#]*/g, "$1[REDACTED]"),
      remoteAddress: req.remoteAddress ?? req.socket?.remoteAddress,
    };
  },
},
```

The redaction is applied once, in the serializer, before Pino writes the log record to any transport. It covers all log destinations (stdout, file transports, remote log aggregators) without requiring configuration at the transport layer.

**Residual risk:** Low. The token is still transmitted in the URL query string and visible in browser devtools network inspector on the client side. TLS (a reverse proxy) prevents wire-level interception. Log files now contain `[REDACTED]` in place of the key value.

---

### M2 — SQL Table Name String Interpolation

**File:** `src/store/kv-store.ts`

**Description**

The `tableName` parameter is interpolated directly into SQL `CREATE TABLE` and `SELECT` statements using template literals. SQL identifiers cannot be parameterised with `?` placeholders — only values can. The double-quote wrapping provides partial protection but does not prevent all injection if a table name containing a double-quote were passed.

All current callers in `service.ts` use hardcoded string literals, so exploitation requires a code change. The fix is a defence-in-depth guard that prevents the class from ever accepting an invalid name, making the surface safe for future callers.

**Fix applied**

Added an allowlist regex check at the top of both `SqliteKvStore` and `SqliteBlobStore` constructors:

```typescript
if (!/^[a-z_][a-z0-9_]*$/i.test(tableName)) {
  throw new Error(`Invalid table name "${tableName}": only letters, digits, and underscores are allowed`);
}
```

The regex permits the same character set SQLite uses for unquoted identifiers. All existing table names (`identity`, `group_state`, `key_packages`, `invites_received`, `invites_unread`, `invites_seen`, `messages`) match without change.

**Residual risk:** None. Any non-conforming table name now throws at construction time, before any SQL executes.

---

### M3 — No Explicit Request Body Size Limit

**File:** `src/index.ts`

**Description**

Without an explicit `bodyLimit` in the Fastify constructor, the implicit default of 1 MiB applies. This default is version-dependent (it could change between Fastify releases) and is not visible in the source code, making it easy to overlook during security review. An attacker with API access could submit 1 MiB request bodies on every call, consuming memory and CPU for JSON parsing.

**Fix applied**

Set `bodyLimit: 65536` (64 KiB) explicitly in the Fastify constructor:

```typescript
const fastify = Fastify({
  bodyLimit: 65536,
  // ...
});
```

64 KiB is more than sufficient for any realistic API payload (a chat message, a group name, a list of relay URLs). Requests with bodies larger than this limit receive a `413 Payload Too Large` response before the body is parsed.

**Residual risk:** None. The limit is now explicit, documented in the source, and enforced by Fastify before the body reaches any route handler.

---

### M4 — No Rate Limiting

**Description**

There is no rate limiting on any endpoint. An authenticated (or unauthenticated when no `API_KEY` is set) caller can send unlimited requests.

Exploitable scenarios:

- **API key brute-force** — timing protection (C1) is now in place, but unlimited attempts over a slow network still dramatically reduce the required brute-force time for short keys.
- **Relay flooding** — `POST /v1/groups/:id/messages` publishes a Nostr event per call; a caller could flood the group's relays with garbage messages.
- **Group creation spam** — each `POST /v1/groups` creates and persists a full MLS group, consuming memory and SQLite storage.

**Accepted mitigation:** marmot-server is designed as a local service accessed by a single trusted client. Rate limiting is appropriate if the API is ever exposed to a network boundary beyond a local machine. The `@fastify/rate-limit` plugin can be added in a future pass.

**Key selection guidance:** Use an API key of at least 32 random bytes (256 bits of entropy) encoded as hex or base64. With such a key, even unlimited-rate brute force is computationally infeasible:

```bash
# Generate a strong API key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Low Findings

### L1 — Distinct 401 Messages Reveal Auth State

**File:** `src/middleware/auth.ts`

**Description**

The original auth hook returned different messages for two failure modes:
- `"Missing or malformed Authorization header"` — no `Bearer …` header present
- `"Invalid API key"` — header present but token wrong

An attacker can use these distinct messages to determine whether their request reached the token comparison step, providing a coarse oracle on authentication state.

**Fix applied**

Both failure paths now return the same generic `"Unauthorized"` message:

```typescript
reply.status(401).send({ error: "Unauthorized", message: "Unauthorized" });
```

The HTTP `401` status code itself conveys the necessary information to a legitimate client. The message distinction is available in server logs at the appropriate log level for operator debugging without exposing it to callers.

**Residual risk:** None.

---

### L2 — Dynamic `import()` in `GET /v1/invites` Route Handler

**File:** `src/routes/invites.ts`

**Description**

`getMarmotGroupData` was imported dynamically inside the route handler on every `GET /v1/invites` call. Dynamic `import()` returns a promise — if module resolution were to fail at runtime (e.g. during development with a broken build), the error would be caught by the surrounding `try/catch` and silently swallowed, returning `groupName: null` instead of surfacing the real failure. Static imports fail fast at process startup.

**Fix applied**

Moved to a static top-level import:

```typescript
// src/routes/invites.ts
import { getMarmotGroupData } from "@internet-privacy/marmot-ts";
```

The dynamic `import()` and its destructuring inside the handler were removed.

**Residual risk:** None.

---

### L3 — No CORS Policy

**Description**

No `Access-Control-Allow-Origin` header is set. By default, browsers will block cross-origin JavaScript from calling the API (same-origin policy). This is the **correct default** for a local service — it prevents malicious web pages from using a visitor's browser as an unwitting API client.

**Accepted:** The absence of a CORS policy is the correct security posture for a local daemon. If the API must be called from a browser frontend on a different origin, CORS should be explicitly configured with a strict allowlist (not `*`).

---

## Threat Model Summary

### Intended deployment

marmot-server is a **local daemon** running inside a Docker container, accessed by a single trusted local application (e.g. a desktop app, a CLI tool, or another container on the same Docker network). It is not designed to be exposed to the public internet.

### In-scope threats (mitigated)

| Threat | Mitigation |
|--------|-----------|
| API key enumeration by network-adjacent attacker | C1: Constant-time comparison |
| Unauthenticated WebSocket connection | C2: Synchronous auth before socket registration |
| Unbounded data retrieval via malformed pagination | H1: Input validation with safe defaults |
| Internal error details leaking to caller | H2: Global error handler sanitises 5xx responses |
| 500 errors on valid 404 scenarios | H3: `resolveGroup()` wrapper |
| SSRF via relay URL parameter | H4: Protocol allowlist (wss/ws only) |

### Out-of-scope threats (accepted with documentation)

| Threat | Rationale |
|--------|-----------|
| Physical access to the host machine | Out of scope for the application layer |
| Compromise of the SQLite database file | Protect the `/data` volume at the host/container level |
| Network-adjacent SSRF to internal ws:// hosts | Requires egress firewall; documented in H4 residual risk |
| API key brute-force at unlimited rate | Requires strong key (≥32 bytes entropy); documented in M4 |
| Relay operator metadata observation | Inherent in the Nostr transport layer; by design |

### What is NOT protected

- **The private key**: The Nostr private key is stored in plaintext in the SQLite database at `/data/marmot.db`. Anyone with read access to this file can impersonate the server's identity. Protect the file with filesystem permissions and volume encryption.
- **Message history**: Decrypted messages are stored in plaintext in the `messages` SQLite table. The encryption only protects messages in transit over Nostr relays.
- **Multi-tenant isolation**: There is one identity and one API key. marmot-server is not designed for multi-user scenarios.

---

## Recommended Operational Controls

1. **Set a strong `API_KEY`** (≥32 random bytes). With no key, the API is fully open.
2. **Do not expose port 8080 to the public internet.** Bind to `127.0.0.1` or a private Docker network.
3. **Protect the `/data` volume.** Use Docker volume encryption or host filesystem permissions (`chmod 700`) to prevent unauthorised access to the database file.
4. **Use TLS in front of the server.** A TLS-terminating reverse proxy (Caddy, nginx) prevents credential exposure in network traffic and mitigates M1 (query-string key logging) at the proxy level.
5. **Rotate the API key periodically.** Update `API_KEY` in the container environment and restart. No data migration is required.
6. **Monitor for unexpected 500 responses.** They indicate bugs that may also be security issues. Review the `err` field in the structured JSON logs.
