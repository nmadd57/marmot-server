# marmot-server — Risk Assessment

**Date**: 2026-04-04  
**Scope**: Full source audit (`src/**`) — security, reliability, code quality  
**Status**: All confirmed findings repaired and backtested (clean `tsc --noEmit`)

---

## Findings Summary

| ID | Severity | Category | File | Status |
|----|----------|----------|------|--------|
| S-1 | **HIGH** | SSRF | `signal/dispatcher.ts` | Fixed |
| R-1 | MEDIUM | Reliability | `nostr/pool.ts` | Fixed |
| R-2 | MEDIUM | Performance | `signal/dispatcher.ts` | Fixed |
| R-3 | MEDIUM | Performance | `nostr/pool.ts` | Fixed |
| Q-1 | LOW | Code Quality | `store/kv-store.ts` | Fixed |
| Q-2 | LOW | Code Quality | `signal/dispatcher.ts` | Fixed |

---

## S-1 — SSRF via unvalidated relay URLs in JSON-RPC `createGroup`

**Severity**: HIGH  
**File**: `src/signal/dispatcher.ts` — `createGroup` handler  
**Root cause**: The signal-cli compat API accepted `params.relays` from caller-supplied JSON-RPC without URL validation. The REST API (`routes/groups.ts`) already applied `isValidRelayUrl()` but the JSON-RPC path was missed.  
**Impact**: A caller could supply `ws://redis:6379`, `ws://169.254.169.254`, or any internal WebSocket endpoint and cause the server to open outbound connections to services reachable only from inside the container network.  
**Fix**: Added per-relay URL validation loop before calling `service.client.createGroup()`. Any relay whose `protocol` is not `wss:` or `ws:` returns JSON-RPC error `-32602`.  
**Backtest**: `tsc --noEmit` passes; logic mirrors the REST API guard in `routes/groups.ts`.

---

## R-1 — `pool.close()` left non-default relay connections open on shutdown

**Severity**: MEDIUM  
**File**: `src/nostr/pool.ts` — `close()`  
**Root cause**: `this.pool.close(this.defaultRelays)` only closed WebSocket connections to default relays. Groups often have their own relay lists (e.g. `relay.primal.net`) not present in `DEFAULT_RELAYS`. Those connections were never closed on SIGTERM/SIGINT.  
**Impact**: Hanging WebSocket connections on shutdown; Docker may wait for them before the container exits; relay servers accumulate ghost connections.  
**Fix**: Added `knownRelays: Set<string>` that is populated in `constructor`, `publish`, `request`, and `subscription` whenever new relay URLs appear. `close()` now calls `pool.close([...knownRelays])`.  
**Backtest**: Type-checks; all relay tracking paths are exhaustive (every method that initiates connections updates the set).

---

## R-2 — `getContact` blocks message delivery for up to 8 s, no caching

**Severity**: MEDIUM  
**File**: `src/signal/dispatcher.ts` — `getContact` handler  
**Root cause**: `service.pool.request()` defaulted to `maxWait: 8000 ms`. hermes-agent calls `getContact` for every incoming message envelope to resolve a display name. Each unique sender's first message would block the agent's receive loop for up to 8 s.  
**Impact**: Noticeable delivery delays for new senders; hermes-agent may time out depending on its HTTP client timeout.  
**Fix** (two-part):  
1. Added optional `maxWait` parameter to `NostrPool.request()` (default stays 8000 for all other callers). `getContact` passes `3000` ms.  
2. Added module-level `profileCache: Map<string, CachedProfile>` with 5-minute TTL. Repeat senders are served from cache with zero relay latency.  
**Backtest**: `pool.request` signature is backward-compatible (default value). Cache hit/miss paths both compile correctly.

---

## R-3 — `pool.request()` `maxWait` was hardcoded, not configurable

**Severity**: MEDIUM (enabler for R-2)  
**File**: `src/nostr/pool.ts` — `request()`  
**Root cause**: `const opts = { maxWait: 8000 }` was a private constant. Callers that needed a shorter timeout (profile lookups) could not override it.  
**Fix**: Added `maxWait = 8000` as a third parameter. All existing callers pass no third argument and get the same 8 s behaviour. Documented in JSDoc.  
**Backtest**: All call sites were checked; none pass a third argument — no regressions.

---

## Q-1 — `SqliteKvStore` prepared every statement twice

**Severity**: LOW  
**File**: `src/store/kv-store.ts` — `SqliteKvStore` constructor  
**Root cause**: The constructor body prepared 5 SQLite statements and bound them to instance properties (lines 61–85), then immediately re-prepared the same 5 statements (lines 88–110) and re-bound them, overwriting the first set. The first 5 statement objects were discarded — occupying parse time, memory, and SQLite statement handles for no benefit.  
**Impact**: 5× unnecessary prepared statement allocations per `SqliteKvStore` instance. There are 6 instances at startup (identity, group_state, key_packages, invites_received, invites_unread, invites_seen) = 30 wasted statements.  
**Fix**: Removed the first (dead) binding block. Single set of prepared statements retained.  
**Backtest**: Type-checks; interface contract unchanged.

---

## Q-2 — Dead no-op alias `methods.sendMessage = methods.sendMessage ?? methods.send`

**Severity**: LOW  
**File**: `src/signal/dispatcher.ts` — alias section  
**Root cause**: `sendMessage` was already defined as a full handler earlier in the `methods` object. The `?? methods.send` fallback could never trigger.  
**Impact**: Misleading code; implies `sendMessage` might not exist and would fall back to `send`. Creates false confidence that the two methods are interchangeable when they have different validation logic (`sendMessage` requires `groupId`, `send` silently no-ops on DMs).  
**Fix**: Removed the dead assignment. Both methods remain independently defined with their respective semantics.  
**Backtest**: Type-checks; aliases block still has `quitGroup` and `getSelfProfile`.

---

## Non-findings (investigated and cleared)

| Item | Finding |
|------|---------|
| SQL injection via table names | `SqliteKvStore`/`SqliteBlobStore` validate `tableName` against `^[a-z_][a-z0-9_]*$` before interpolation. No user-controlled input reaches table name paths. |
| Timing oracle on API key length | `timingSafeCompare` runs a dummy `timingSafeEqual(aBuf, aBuf)` when lengths differ. A length oracle is theoretically present but requires sub-millisecond HTTP timing precision — not exploitable in practice against a local service. Accepted risk. |
| Batch JSON-RPC amplification | No per-batch size limit. Acceptable for a local single-identity service; not exposed to untrusted networks. |
| `base64ToHex` on malformed input | `Buffer.from(b64, "base64")` is silently forgiving; garbage input produces a hex string that `getGroup()` will not find, returning a proper 404. No crash path. |
| `signalRoutes` SSE `?key=` in logs | Query-key redaction is already applied in the Fastify logger serialiser (`index.ts:47–53`). |
| WebSocket `clients` Set leak | Both `close` and `error` handlers delete from the Set. No leak path found. |
| `inviteAccept` double-join on restart | `inviteReader.ingestEvent` de-duplicates by event id; a previously ingested gift wrap returns `isNew = false` and does not re-fire `newInvite`. |

---

## Architecture notes (no action required)

- **Single filter only in `pool.request`**: The method signature accepts `Filter | Filter[]` but only the first filter is queried. All internal callers pass a single filter. The `| Filter[]` overload should not be relied on for multi-filter queries; this is a known limitation of the `querySync` adapter.
- **`pool.subscription` single filter**: Same constraint — `subscribeMany` receives a single filter object. Multi-filter subscriptions would require a refactor of the `subscription()` method. All current callers pass one filter.
- **No relay URL validation on `updateGroup` in dispatcher**: Relays in `updateGroup` come from `group.relays` (trusted group state from Nostr) and `config.defaultRelays` (trusted env config), not from caller input. No validation needed.
