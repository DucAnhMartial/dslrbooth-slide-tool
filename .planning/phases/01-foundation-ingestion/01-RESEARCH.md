# Phase 1: Foundation & Ingestion - Research

**Researched:** 2026-08-10
**Domain:** Webhook ingestion security (HMAC + IP allow-list), SQLite persistence, MySQL read-only polling fallback, structured logging with PII masking — inside an existing Node.js/TypeScript/Express service
**Confidence:** HIGH (grounded directly in the existing `mirror-request/` codebase) for architecture and pitfalls; MEDIUM for HMAC/webhook-security conventions (cross-checked web sources, no official RFC for this project's specific header scheme since it's a private integration contract)

## Summary

Phase 1 is **not greenfield** — `mirror-request/src/ingestion/mirrorReceiver.ts`, `dbPoller.ts`, `state/localStore.ts`, `config.ts` and `logging/logger.ts` already implement a working (but security-light) version of registration ingestion, SQLite persistence, and MySQL polling. The phase's job is to *harden* this existing code to satisfy the 16 locked decisions (D-01..D-16) in `01-CONTEXT.md`: add HMAC-SHA256 + IP allow-list auth to `/on-register`, extend SQLite with dedup-window and replay-ID state, make DB polling resilient, and tighten logging/masking. Almost all of the required tables and config plumbing already exist in some form — the plan should extend, not rebuild.

The single most important finding is a **verified, concrete bug-in-waiting**: `mirror-request/src/index.ts` currently registers `app.use(express.json())` globally, *before* the mirror receiver router is mounted. This means by the time any HMAC-verification middleware could run in `mirrorReceiver.ts`, Express has already parsed and discarded the raw request bytes — signature verification is impossible without restructuring body-parsing middleware order or capturing raw bytes via a `verify` callback. This is the textbook "raw body destroyed by body parser" webhook pitfall called out generically in the phase brief, and it is confirmed to already exist in this exact codebase.

**Primary recommendation:** Add raw-body capture via `express.json({ verify: (req, res, buf) => { req.rawBody = buf } })` on the global JSON middleware (cheap, applies uniformly, no route reordering needed), then do HMAC verification as an Express middleware inserted into the mirror receiver router ahead of the `/on-register` handler, reading `req.rawBody`. Persist webhook replay IDs and dedup-window state in new/extended SQLite tables via `LocalStore`, consistent with the "all central state lives in `LocalStore`" convention already established in this codebase. No new production npm packages are required — `node:crypto` (built in) covers HMAC and constant-time comparison.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| `POST /on-register` HTTP endpoint | API/Backend (Express, `mirrorReceiver.ts`) | — | Single backend service; no browser/SSR tier in this phase |
| Raw-body capture for HMAC | API/Backend (Express middleware, `index.ts` composition root) | — | Must happen before JSON body-parsing destroys raw bytes; owned by composition root per established convention |
| HMAC signature verification | API/Backend (`mirrorReceiver.ts` or new `ingestion/webhookAuth.ts`) | Database/Storage (replay-ID persistence) | Verification logic is request-scoped; replay-ID durability is a storage concern |
| IP allow-list enforcement | API/Backend (`mirrorReceiver.ts`) | — | Already implemented; extend only |
| Registration persistence | Database/Storage (`LocalStore` / SQLite) | — | Established convention: all durable central state goes through `LocalStore` prepared statements only |
| Deduplication (time-window + id/email/phone) | Database/Storage (SQLite query) | API/Backend (`mirrorReceiver.ts` orchestrates the check) | Matching logic needs a DB read against recent rows; the endpoint decides the HTTP response based on the result |
| DB polling (fallback ingestion) | External System / Database (read-only MySQL) | API/Backend (`dbPoller.ts` polling loop) | `dbPoller.ts` is a backend-owned scheduled task reading an external, foreign-owned database |
| Cursor advancement | Database/Storage (SQLite `db_poll_cursor`) | — | Already implemented; must never write back to the external MySQL DB (hard rule in `mirror-request/CLAUDE.md`) |
| Structured logging + masking | API/Backend (`logging/logger.ts`) | — | Cross-cutting, but implemented as a shared backend module already |

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| ING-01 | `POST /on-register` (mirrored from proxy), returns 200 immediately, processes async | Already structurally satisfied — `better-sqlite3` writes are synchronous and sub-millisecond, so the handler returns immediately after fast local persistence; no downstream (queue dispatch) work happens inline. Needs HMAC auth added ahead of it. `[VERIFIED: mirror-request/src/ingestion/mirrorReceiver.ts:20-56]` |
| ING-02 | Read-only (SELECT) periodic polling of backend DB to catch missed registrations | Already implemented in `dbPoller.ts` using parameterized `SELECT ... WHERE registered_at > ? ORDER BY registered_at ASC LIMIT ?` (verified: no INSERT/UPDATE/DELETE anywhere in the file). Needs resilience (D-05..D-08) and reconciliation logging (D-04) added. `[VERIFIED: mirror-request/src/ingestion/dbPoller.ts:82-85]` |
| ING-03 | Poll cursor stored in local state only, never written back to the real DB | Already implemented via `LocalStore.getCursor`/`setCursor` against the SQLite `db_poll_cursor` table. `[VERIFIED: mirror-request/src/state/localStore.ts:51-55,188-195]` |
| STO-01 | SQLite persists queue, booth state, cursor, job history, processed ids across restart | Schema already exists for all listed entities (`registration`, `queue_job`, `processed_id`, `db_poll_cursor`, `booth_state`, `notification_record`). Phase 1 must extend it with dedup-window and webhook-replay state. `[VERIFIED: mirror-request/src/state/localStore.ts:22-68]` |
| AUTH-02 | `/on-register` accepts only reverse-proxy IP (403 outside allow-list) | Already implemented (`isWhitelisted()` in `mirrorReceiver.ts`). D-09 requires this to be paired with HMAC and be environment-strict (mandatory in production). `[VERIFIED: mirror-request/src/ingestion/mirrorReceiver.ts:8-18]` |
| AUTH-03 (partial, formally owned by Phase 5 per ROADMAP.md M5) | Sensitive data (email, phone) partially masked in logs | D-15/D-16 in this phase's CONTEXT.md pull forward the masking requirement for any new ingestion log lines. Reuse the existing `mask()` helper; do not create a second masking implementation. `[VERIFIED: mirror-request/src/logging/logger.ts:7-14]` |

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Duplicate registration handling**
- D-01: Reject a repeated registration inside a configurable time window; default `REGISTRATION_DEDUP_WINDOW_MS` is 5 minutes (300,000 ms).
- D-02: Identity comparison prioritizes source `id`; if it is absent, use email or phone number. — Reversibility: costly — changing identity rules changes which persisted registrations are considered the same person.
- D-03: For a duplicate, return HTTP 200 with the original `jobId`; never create a new queue job.
- D-04: If database polling finds a registration already received through Mirror Request, skip it and emit an informational reconciliation log.

**Database polling resilience**
- D-05: A DB connection/query failure logs a warning and retries on the next cycle; it must not stop the service.
- D-06: A source record without `id` or `name` is skipped, logged for audit, and does not block cursor advancement.
- D-07: Phase 1 records polling warnings in structured log files only; there is no separate error table or operations webhook.
- D-08: Poll interval is configurable with a 3-second default.

**Registration endpoint security**
- D-09: Protect `POST /on-register` with HMAC-SHA256 plus IP allow-list. Production requires both controls; other environments may configure them. — Reversibility: costly — this is a published integration contract with the form/Mirror Request system.
- D-10: Use `X-Webhook-Signature`, `X-Webhook-Timestamp`, and `X-Webhook-Id`; verify the signature against the raw request body.
- D-11: Timestamp acceptance is configurable, with a 5-minute default; reject replayed request IDs.
- D-12: Authentication failures return HTTP 403 and log only a general reason, never secrets or validation detail.

**Stored data and logging**
- D-13: SQLite retains operational fields, email, phone number, and the raw Mirror Request payload for reconciliation and debugging.
- D-14: Retention is manual; the operator deletes data when appropriate. — Reversibility: costly — automatic retention would alter stored operational data and require a cleanup/migration policy.
- D-15: Runtime logs partially mask email and phone numbers and emphasize `id`, status, and error reason.
- D-16: Raw payloads are never logged in production; they may be emitted only with `DEBUG` enabled in development.

### Claude's Discretion

- Choose the exact HMAC canonical string and the persistent mechanism for replayed request IDs, provided the three agreed headers and raw-body HMAC validation remain compatible with the source system.

### Deferred Ideas (OUT OF SCOPE)

- Queue behavior belongs in the later Queue & Booth State phase.
- Agent command/display behavior belongs in a later Agent WebSocket phase.
- Name-and-photo slideshow delivery belongs in a later notification/display phase.
</user_constraints>

## Project Constraints (from CLAUDE.md)

`mirror-request/CLAUDE.md` (the sub-project this phase modifies) states hard rules that apply directly to this phase:

- **NEVER write (INSERT/UPDATE/DELETE) to the real backend DB. Read-only SELECT only.** — `dbPoller.ts` already complies; any resilience/reconciliation changes must preserve this (no schema-mutating statements, no writes to the MySQL `registrations` table).
- **All business logic lives HERE [the central service]. Agent is a dumb relay only.** — Out of scope for this phase (no Agent code touched), but confirms dedup/HMAC/polling logic belongs entirely inside `mirror-request/`.
- Runtime: Node.js 20 LTS, TypeScript. Packages: express, ws, better-sqlite3, winston, dotenv. Deployment: PM2 or Docker.

## Standard Stack

### Core (all already installed — no new production dependencies needed)

| Library | Version (installed) | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `express` | ^4.21.1 `[VERIFIED: mirror-request/package.json:20]` | HTTP server, `/on-register` route | Already the project's HTTP framework |
| `better-sqlite3` | ^11.0.0 `[VERIFIED: mirror-request/package.json:18]` | Synchronous SQLite access for all durable central state | Already the project's persistence layer; synchronous API fits the existing `LocalStore` design |
| `node:crypto` (Node.js built-in) | Node 20.x runtime | HMAC-SHA256 signing/verification, `timingSafeEqual` constant-time comparison | No external dependency needed or advisable for cryptographic primitives — hand-rolling or importing a third-party HMAC library would violate "Don't Hand-Roll" guidance in the opposite direction (adds risk without benefit; Node's `crypto` module is the canonical, audited implementation) `[CITED: nodejs.org/api/crypto.html]` |
| `mysql2` | ^3.23.2 `[VERIFIED: mirror-request/package.json:21]` | Read-only polling of the external `registrations` table | Already in use in `dbPoller.ts` |
| `winston` + `winston-daily-rotate-file` | ^3.14.2 / ^5.0.0 `[VERIFIED: mirror-request/package.json:25-26]` | Structured, rotated logging with existing `mask()` helper | Already the project's logging stack |
| `dotenv` | ^16.4.5 `[VERIFIED: mirror-request/package.json:19]` | `.env` loading for new config keys (HMAC secret, dedup window, timestamp skew) | Already in use in `config.ts` |

### Supporting (test-only, new devDependency)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `supertest` | 7.2.2 (latest, verified via `npm view`) | HTTP-level integration tests for `/on-register` (valid/invalid signature, replay, dedup, IP allow-list) | No devDependency currently exists for driving real HTTP requests against the Express app in tests; existing tests either exercise WS/queue internals directly or spin up a raw `http.Server` by hand (`test/notification-webhook.test.ts`). `supertest` is the standard, minimal way to test Express routes without binding a real port. |
| `@types/supertest` | 7.2.1 (latest, verified via `npm view`) | TypeScript types for `supertest` | Project is strict TypeScript; every other test/runtime dependency has a matching `@types/*` package |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `node:crypto` HMAC | A signing library like `svix` or a webhook-framework's built-in verifier | Unnecessary — the header scheme (`X-Webhook-Signature`/`X-Webhook-Timestamp`/`X-Webhook-Id`) is this project's own private contract with Mirror Request, not a third-party provider's protocol, so there's no vendor SDK to reuse. Adding one would be over-engineering for three header checks. |
| SQLite table for replay IDs | In-memory `Set`/`Map` with TTL cleanup | Rejected — would silently lose replay protection on every restart/redeploy (PM2 restarts, crashes), directly violating the spirit of D-11 and the established "all central state persists in `LocalStore`" convention `[VERIFIED: .planning/codebase/CONVENTIONS.md:17]` |
| `supertest` | Manual `http.createServer` + `fetch`/`http.request`, as in `test/notification-webhook.test.ts` | Valid but more boilerplate per test; `supertest` is lower-friction when many auth/dedup permutations need testing against the same Express app instance |

**Installation (test dependency only):**
```bash
cd mirror-request
npm install --save-dev supertest @types/supertest
```

**Version verification performed this session:**
```
npm view express version        → 5.2.1 latest (project pins ^4.21.1 — no upgrade in scope for this phase)
npm view better-sqlite3 version  → 13.0.3 latest (project pins ^11.0.0 — no upgrade in scope for this phase)
npm view winston version         → 3.19.0 latest (project pins ^3.14.2 — no upgrade in scope for this phase)
npm view supertest version       → 7.2.2
npm view @types/supertest version → 7.2.1
```
None of these existing pins need to change for Phase 1 — they are documented here only to confirm the installed majors are still receiving updates upstream (i.e., not abandoned), not as an upgrade recommendation.

## Package Legitimacy Audit

Only one new package is proposed (a devDependency, test-only).

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `supertest` | npm | mature (long-established, ladjs org) | 16.9M/week | github.com/ladjs/supertest | OK | Approved |
| `@types/supertest` | npm | mature (DefinitelyTyped) | tracks supertest | github.com/DefinitelyTyped/DefinitelyTyped | OK (DefinitelyTyped types package, not independently checked but standard companion) | Approved |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

No production dependencies are added by this phase — all HMAC, dedup, and persistence work uses libraries already in `package.json` plus Node's built-in `crypto`.

## Architecture Patterns

### System Architecture Diagram

```text
Mirror Request / Form Proxy                External MySQL (registrations, read-only)
            |                                          |
            | POST /on-register                        | SELECT ... WHERE registered_at > cursor
            | headers: X-Webhook-Signature,             | (every DB_POLL_INTERVAL_MS, default 3s)
            |          X-Webhook-Timestamp,              |
            |          X-Webhook-Id                       v
            v                                     +--------------+
   +-------------------+   raw body captured       | DBPoller     |
   | express.json({    |   via verify callback     | (dbPoller.ts)|
   |   verify: capture  |------------+              +------+-------+
   |   raw bytes })     |            |                     |
   +-------------------+            v                     |
            |                +----------------+             | isProcessed(id)? skip + log reconciliation (D-04)
            |                | IP allow-list   |             | validate id+name present, else skip + audit log (D-06)
            v                | check (existing)|             |
   +-------------------+     +--------+--------+             |
   | mirrorReceiver.ts |              |                      |
   | /on-register       |<-------------+                      |
   +--------+-----------+                                     |
            | HMAC verify (X-Webhook-Signature over raw body, |
            |   X-Webhook-Timestamp skew check,                |
            |   X-Webhook-Id replay check against SQLite)       |
            v                                                  |
   +-------------------+     dedup check (D-01/D-02):           |
   | Dedup window check |     id match, else email/phone match  |
   | (SQLite query)     |     within REGISTRATION_DEDUP_WINDOW_MS|
   +--------+-----------+                                       |
            | duplicate? -> 200 { jobId: original } (D-03)       |
            | new?       -> continue                             |
            v                                                    v
   +-----------------------------------------------------------------+
   |                      LocalStore (SQLite, WAL)                    |
   |  registration | processed_id | webhook_replay (new) | queue_job  |
   |  db_poll_cursor | booth_state | notification_record               |
   +-----------------------------------------------------------------+
            |
            v
   HTTP 200 { accepted: true, jobId } / 403 (auth failure, generic reason only, D-12)
```

### Recommended Project Structure (extends existing layout — no new top-level folders)
```
mirror-request/src/
├── ingestion/
│   ├── mirrorReceiver.ts   # existing — add HMAC + dedup-window orchestration
│   ├── webhookAuth.ts      # NEW — HMAC verify + replay-ID check middleware (keeps mirrorReceiver.ts focused)
│   └── dbPoller.ts         # existing — add resilience (D-05..D-08), reconciliation log (D-04), typed config
├── state/
│   └── localStore.ts       # existing — extend schema: webhook_replay table, dedup-window query, received_at column
├── config.ts                # existing — extend EnvConfig with new webhook/dedup keys
└── types.ts                  # existing — extend EnvConfig interface
```

### Pattern 1: Raw-body capture without disturbing existing JSON parsing
**What:** Capture the exact bytes Express received, before `body-parser`/`express.json()` reserializes them, by using the `verify` callback that `express.json()` (via `body-parser`) already supports.
**When to use:** Any route needing signature verification against the literal wire bytes.
**Example:**
```typescript
// Source: pattern confirmed via multiple official/vendor webhook docs (Stripe, general Express guidance)
// index.ts — composition root, applies to ALL routes (cheap; only /on-register reads req.rawBody)
app.use(express.json({
  verify: (req, _res, buf) => {
    (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
  },
}));
```
**Why global instead of route-scoped `express.raw()`:** `mirror-request/src/index.ts` currently applies `express.json()` globally before any routers are mounted `[VERIFIED: mirror-request/src/index.ts:18-23 — "const app = express(); app.use(express.json());" ... "app.use(mirror);"]`. Reordering middleware to scope `express.raw()` only to `/on-register` would require moving the mirror router registration before the global JSON parser — a bigger structural change than adding a `verify` callback to the existing single `express.json()` call. The `verify` callback approach is a one-line change that preserves the current composition order and gives every route access to `req.rawBody` (unused elsewhere, harmless).

### Pattern 2: HMAC verification middleware (constant-time, buffer-length-guarded)
**What:** Verify `X-Webhook-Signature` against an HMAC-SHA256 digest of a canonical string built from the raw body plus the two other headers, using `crypto.timingSafeEqual`.
**When to use:** `/on-register` only, mounted ahead of the handler (or as the first statement inside it).
**Example:**
```typescript
// Source: pattern cross-checked against Node.js crypto docs + multiple webhook-security guides [CITED, MEDIUM confidence]
import { createHmac, timingSafeEqual } from 'crypto';

function verifySignature(rawBody: Buffer, timestamp: string, webhookId: string, signatureHeader: string, secret: string): boolean {
  const canonical = `${timestamp}.${webhookId}.${rawBody.toString('utf8')}`; // includes id+timestamp to prevent header-swap
  const expected = createHmac('sha256', secret).update(canonical).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const receivedBuf = Buffer.from(signatureHeader, 'hex');
  if (expectedBuf.length !== receivedBuf.length) return false; // guard: timingSafeEqual throws on length mismatch
  return timingSafeEqual(expectedBuf, receivedBuf);
}
```
Note: the exact canonical-string composition (`timestamp.id.body` vs. `timestamp.body`) is explicitly left to agent discretion by CONTEXT.md — see Assumptions Log below. Including the webhook ID in the signed content is a defense against an attacker replaying an old valid signature with a *different* `X-Webhook-Id` to dodge replay detection; this reasoning is original to this research, not sourced from a specific doc, and should be confirmed with the source system's actual signing behavior (see Open Questions).

### Pattern 3: Timestamp skew + persisted replay-ID check
**What:** Reject requests whose `X-Webhook-Timestamp` is outside `WEBHOOK_TIMESTAMP_SKEW_MS` of server time, and reject any `X-Webhook-Id` already seen (persisted, not in-memory).
**When to use:** Immediately after signature verification passes (checking timestamp/replay before verifying the signature would let an attacker probe validity without a valid secret; checking after wastes no security but conventionally signature-then-freshness is fine either order since both must pass).
**Example:**
```typescript
// New LocalStore methods, following the existing prepared-statement convention
// [VERIFIED pattern from mirror-request/src/state/localStore.ts:179-185 markProcessed/isProcessed]
hasSeenWebhookId(webhookId: string): boolean {
  return this.db.prepare('SELECT 1 FROM webhook_replay WHERE webhook_id = ?').get(webhookId) !== undefined;
}
recordWebhookId(webhookId: string, receivedAt: number): void {
  this.db.prepare('INSERT OR IGNORE INTO webhook_replay (webhook_id, received_at) VALUES (?, ?)').run(webhookId, receivedAt);
}
```

### Pattern 4: Dedup-window matching (id, then email/phone fallback)
**What:** Before persisting a new registration, check for an existing registration within `REGISTRATION_DEDUP_WINDOW_MS` matching by `id` first, then by `email` or `phone` if no `id` match.
**Example:**
```sql
-- id match (covers the common case; existing processed_id table already does permanent id idempotency)
SELECT id FROM registration WHERE id = ? AND received_at >= ?  -- window lower bound

-- fallback match when id differs across resubmissions (see Open Questions for when this applies)
SELECT id FROM registration
WHERE (email = ? OR phone = ?) AND received_at >= ?
ORDER BY received_at ASC LIMIT 1
```
This requires adding a `received_at INTEGER` column (server ingestion wall-clock, epoch ms) to the `registration` table — see Open Questions for why this should be separate from the source-provided `registered_at` string.

### Anti-Patterns to Avoid
- **Reading `req.body` for HMAC verification:** By the time Express has parsed JSON, whitespace/key-order/unicode-escaping differences from the original bytes will break any signature computed from a re-serialized `JSON.stringify(req.body)`. Always sign/verify against `req.rawBody` (the captured `Buffer`), never a reparsed object. `[CITED — cross-checked across Stripe docs and multiple webhook-security guides]`
- **Using `===` or `Buffer.equals()` for signature comparison:** vulnerable to timing attacks; always use `crypto.timingSafeEqual` with a prior length check. `[CITED: nodejs.org/api/crypto.html + cross-checked guides]`
- **In-memory-only dedup/replay state:** breaks the moment PM2 restarts the process (a normal deploy event, not a rare crash) — must be SQLite-backed like everything else in `LocalStore`.
- **Blindly enabling `app.set('trust proxy', true)`:** Not currently set anywhere in the codebase `[VERIFIED: grep across mirror-request/src for "trust proxy" returned no matches]`. The existing `isWhitelisted()` check in `mirrorReceiver.ts` compares `req.ip || req.connection.remoteAddress` — without `trust proxy` configured, this is the **direct TCP peer address**, i.e., the reverse proxy's own IP, which is exactly what `PROXY_IP_WHITELIST` is designed to match `[VERIFIED: mirror-request/src/ingestion/mirrorReceiver.ts:8-18]`. Enabling `trust proxy` (especially `true`) without also restricting it to the specific trusted proxy hop would let a malicious client spoof `X-Forwarded-For` and impersonate an allow-listed IP, defeating AUTH-02. Do not add `trust proxy` as part of this phase's HMAC work unless the deployment topology genuinely changes (e.g., an additional load balancer is introduced) — and if so, scope it to the specific trusted hop IP(s), never `true`. `[CITED: expressjs.com/en/guide/behind-proxies.html]`
- **Re-upserting the original registration on a detected duplicate:** D-03 requires returning the *original* `jobId` and never creating a new queue job. The handler should short-circuit before calling `upsertRegistration`/`saveRawPayload`/`enqueueJob` on a duplicate — those calls should only run for genuinely new registrations.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|--------------|-----|
| HMAC signing/verification | A custom string-comparison or homegrown hashing routine | `node:crypto` `createHmac` + `timingSafeEqual` | Built-in, audited, constant-time; hand-rolling comparison is the single most common source of timing-attack vulnerabilities in webhook implementations |
| SQLite access | Raw `db.exec()` string concatenation for dedup/replay queries | `better-sqlite3` prepared statements (`.prepare().get()/.run()`), matching every existing `LocalStore` method | Prevents SQL injection, matches established convention, enables statement reuse |
| IP range matching | A new bespoke CIDR parser | The existing `isWhitelisted()` prefix-match approach (`allowed.endsWith('.*')`) — extend only if a real requirement for real CIDR ranges emerges | Current allow-list only needs single-IP or simple prefix matching for a small, known set of proxy IPs; introducing a full CIDR library (e.g. `ip-range-check`) is unwarranted scope for this phase given D-09 doesn't request it |
| HTTP-level route testing | Hand-rolled `http.createServer` + manual socket listening for every new test (as done once in `test/notification-webhook.test.ts`) | `supertest` against the exported Express `app` | Less boilerplate per test case; this phase needs many auth/dedup permutations (valid sig, bad sig, replay, stale timestamp, IP outside allow-list, dedup hit, dedup miss) |

**Key insight:** This phase is almost entirely "harden and extend existing code," not "build new infrastructure." The biggest risk is *not* picking the wrong library — it's missing that the codebase already has 80% of the required plumbing (raw SELECT-only polling, cursor persistence, `processed_id` idempotency, `mask()` logging) and either duplicating it or breaking an established convention while extending it.

## Common Pitfalls

### Pitfall 1: Raw body already consumed before HMAC middleware can see it
**What goes wrong:** Signature verification always fails because `req.body` has already been parsed and the original bytes are gone.
**Why it happens:** `index.ts` applies `app.use(express.json())` globally, before any router (including the mirror receiver) is mounted `[VERIFIED: mirror-request/src/index.ts:18-23]`.
**How to avoid:** Add a `verify` callback to the existing `express.json()` call to capture `req.rawBody` as a `Buffer` (Pattern 1 above). Do not add a second, route-scoped `express.raw()` parser unless the global-capture approach proves insufficient (e.g., very large payload concerns — not indicated here).
**Warning signs:** Every request fails signature verification even with a manually-verified-correct secret and payload; the `Buffer` used to compute HMAC has different byte length than what was actually sent (a sign it was reconstructed from parsed JSON).

### Pitfall 2: `timingSafeEqual` throws instead of returning `false` on length mismatch
**What goes wrong:** An attacker (or a misconfigured client) sending a malformed/short signature header crashes the request handler with an uncaught `RangeError`, potentially taking down the process if not caught (Express catches sync throws in route handlers by default in v4/v5, converting to 500, but this masks the real 403 auth-failure semantics required by D-12).
**Why it happens:** `crypto.timingSafeEqual` requires both buffers to be the same length and throws `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` otherwise. `[CITED: nodejs.org/api/crypto.html, cross-checked]`
**How to avoid:** Always compare buffer `.length` before calling `timingSafeEqual`; treat a length mismatch as "verification failed" (403), not a validation exception.
**Warning signs:** 500 errors in logs for `/on-register` instead of clean 403s when testing with intentionally-malformed signature headers.

### Pitfall 3: Dedup/replay state that doesn't survive a restart
**What goes wrong:** PM2 restarts (deploys, crash-restarts) silently reset in-memory replay-ID or dedup-window tracking, reopening a window for replayed webhooks or duplicate registrations right after every deploy.
**Why it happens:** It's tempting to reach for a `Map`/`Set` with manual TTL cleanup for "just a short-lived cache" — but this project's established convention is that *all* durable central state goes through `LocalStore`/SQLite, precisely because the process restarts routinely under PM2.
**How to avoid:** New `webhook_replay` table (SQLite), queried the same way `processed_id` already is (Pattern 3 above).
**Warning signs:** Duplicate registrations or replayed webhooks accepted immediately after a deploy/restart in testing.

### Pitfall 4: DB poller bypasses typed `EnvConfig`, and has a DB_PORT default mismatch with `config.ts`
**What goes wrong:** `dbPoller.ts` reads `process.env.DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD` directly (`Number(process.env.DB_PORT ?? '3306')`) instead of using the typed `EnvConfig` object already loaded in `index.ts` and already declaring these exact fields `[VERIFIED: mirror-request/src/ingestion/dbPoller.ts:23-27]` `[VERIFIED: mirror-request/src/types.ts:82-86 — "DB_HOST: string; DB_PORT: number; DB_NAME: string; DB_USER: string; DB_PASSWORD: string;"]`. Worse, `config.ts` defaults `DB_PORT` to `5432` (a Postgres default, leftover from an earlier Postgres-era config) while `dbPoller.ts` independently defaults to `3306` (MySQL's real default) `[VERIFIED: mirror-request/src/config.ts:56 — "DB_PORT: toNum('DB_PORT', 5432),"]`. This is also flagged generically in `.planning/codebase/CONCERNS.md`, but this session verified the exact line numbers and literal defaults.
**Why it happens:** Historical drift — the project's dependencies (`pg`, SMTP, Twilio fields still in `EnvConfig`) show it was retargeted from an earlier Postgres/email/SMS design to the current MySQL/SQLite/webhook design, and `dbPoller.ts` was never updated to consume the typed config.
**How to avoid:** Since this phase already touches `dbPoller.ts` for D-05..D-08 resilience work, take the opportunity to pass the resolved `EnvConfig` (or its DB_* fields) into `DBPoller`'s constructor instead of reading `process.env` inside `start()`. This isn't strictly required by any single D-0x decision, but directly serves the CONTEXT.md code-context guidance: "Extend `EnvConfig` and `loadConfig()` for deduplication, polling and webhook security configuration." Fix the `5432`→`3306` default mismatch as part of this change (cosmetic no-op today since `DB_PORT` is presumably always set in real `.env`, but a real footgun for anyone bootstrapping a fresh environment).
**Warning signs:** A fresh `.env` without `DB_PORT` set would silently try to connect to MySQL on port 5432 depending on which code path reads the variable — currently `dbPoller.ts`'s own inline default (3306) wins because it doesn't consult `config.ts` at all, but this is fragile and accidental, not designed.

### Pitfall 5: Silent reconciliation instead of an informational log (D-04)
**What goes wrong:** D-04 requires an informational log when the poller finds a registration already ingested via the webhook, but the current code just `continue`s silently: `if (this.store.isProcessed(row.id)) continue;` `[VERIFIED: mirror-request/src/ingestion/dbPoller.ts:91]`.
**How to avoid:** Add an explicit `logger.info(...)` (or the equivalent through the label logger) on that branch before `continue`, clearly distinguishing "reconciled, already had this one" from "processed a new record via polling" (which already logs at line 102).

### Pitfall 6: Logging PII in new HMAC/dedup code paths
**What goes wrong:** New log statements added around HMAC failures, dedup hits, or reconciliation could accidentally include email/phone/raw payload, violating D-15/D-16.
**How to avoid:** Route every new log line through the existing `mask()`/`logger` from `logging/logger.ts` (already applied to *all* log output via the Winston format pipeline, not just calls that explicitly invoke `mask()` — see `[VERIFIED: mirror-request/src/logging/logger.ts:16-26]`, the file transport's `printf` calls `mask(message)` unconditionally for every log line). This is actually good news: the existing masking is applied at the transport level to all string messages already, so as long as new log calls pass a string message (not raw object interpolation that bypasses `message`), masking is automatic. Still, never pass the raw payload string to any log call in a production path (D-16) — gate any raw-payload debug logging behind `process.env.DEBUG` explicitly, following the `NODE_ENV !== 'production'` conditional pattern already used for the console transport `[VERIFIED: mirror-request/src/logging/logger.ts:58-60]`.

### Pitfall 7: `INSERT OR REPLACE` semantics on `upsertRegistration`
**What goes wrong:** `INSERT OR REPLACE INTO registration (...)` `[VERIFIED: mirror-request/src/state/localStore.ts:77-79]` deletes and recreates the row on conflict. If a second call to `upsertRegistration` for the same `id` omits `raw_payload` (as `dbPoller.ts` does — it never calls `saveRawPayload`), any previously-stored raw payload for that id would be wiped to `NULL`.
**Why it currently isn't a live bug:** Today, `isProcessed(id)` gates both ingestion paths from ever calling `upsertRegistration` twice for the same id, so this can't currently trigger. It becomes a live risk if the Phase 1 dedup rework changes when/whether `upsertRegistration` is called on a "duplicate" (per D-03, a detected duplicate should skip persistence entirely, which also avoids this).
**How to avoid:** Confirm the new dedup logic never re-calls `upsertRegistration` for an already-persisted `id` — only for genuinely new registrations — preserving this invariant.

## Code Examples

### Extending `EnvConfig` for Phase 1 (follows existing `config.ts` pattern)
```typescript
// Source: pattern extended from mirror-request/src/config.ts:41-42 (existing required() calls)
// New required-conditionally-on-production validation, matching D-09's
// "production requires both controls; other environments may configure them"
const nodeEnv = get('NODE_ENV') ?? 'development';
const isProduction = nodeEnv === 'production';

const webhookSecret = get('WEBHOOK_HMAC_SECRET') ?? '';
if (isProduction && !webhookSecret) {
  errors.push('WEBHOOK_HMAC_SECRET must be configured in production');
}
const ipWhitelist = toCSV('PROXY_IP_WHITELIST', []); // change fallback from ['127.0.0.1'] if production must not silently allow all
if (isProduction && ipWhitelist.length === 0) {
  errors.push('PROXY_IP_WHITELIST must be configured in production');
}

// ... added to the returned EnvConfig object:
REGISTRATION_DEDUP_WINDOW_MS: toNum('REGISTRATION_DEDUP_WINDOW_MS', 300_000), // D-01
WEBHOOK_HMAC_SECRET: webhookSecret,                                            // D-09/D-10
WEBHOOK_TIMESTAMP_SKEW_MS: toNum('WEBHOOK_TIMESTAMP_SKEW_MS', 300_000),        // D-11
```
Note: `PROXY_IP_WHITELIST` currently defaults to `['127.0.0.1']` `[VERIFIED: mirror-request/src/config.ts:54]`, which is a reasonable dev default but would silently pass production validation with a single loopback entry — worth flagging to the planner as a decision point for whether production validation should also check the whitelist isn't just `['127.0.0.1']`. Left as an open question below.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| IP allow-list only for webhook trust | IP allow-list + HMAC signature | This phase (D-09) | Matches modern webhook-security guidance (IP allow-listing alone is fragile — cloud egress IPs rotate, and IP spoofing/SSRF-adjacent risks exist); HMAC adds message-integrity + authenticity independent of network topology `[CITED: general webhook-security guidance, cross-checked across multiple sources]` |
| Permanent-only idempotency (`processed_id`, keyed on `id` forever) | Time-windowed dedup with `id`→email/phone fallback | This phase (D-01/D-02) | Handles the case where a resubmission carries a *different* source `id` (e.g. a double form-submit that regenerates an id), which permanent id-based idempotency alone cannot catch |

**Deprecated/outdated:**
- Postgres-era config fields (`pg`, `@types/pg`, `DB_PORT` default of 5432) and SMTP/Twilio fields in `EnvConfig` are vestigial from an earlier design — `.planning/codebase/CONCERNS.md` and `STACK.md` both note the active code uses MySQL/SQLite/webhook only. Not in scope to remove in Phase 1, but do not extend or rely on these fields when adding new config.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|----------------|
| A1 | HMAC canonical string should be `${timestamp}.${webhookId}.${rawBody}` (including the webhook ID in the signed content) rather than just `${timestamp}.${rawBody}` | Architecture Patterns / Pattern 2 | If the source system (Mirror Request) signs only `timestamp.body` on its side, this project's verification must match exactly or all requests will be rejected as invalid signatures. This is explicitly left to "the agent's discretion" per CONTEXT.md, but discretion only works if it's compatible with what the source system actually sends — needs confirmation against the actual Mirror Request signing implementation before finalizing, or the plan should make the canonical string easy to change in one place. |
| A2 | Dedup email/phone fallback (D-02) applies when a resubmission carries a different source `id` than a prior submission from the same guest, not when `id` is entirely absent from the payload (since `id` is currently a hard-required field, returning 400 if missing) | Common Pitfalls / Pattern 4 / Open Questions | If the real intent is that `id` absence should be tolerated (not 400) and identity should fall back to email/phone in that case, the endpoint's current `if (!id || !name) return 400` behavior needs to change too, which is a bigger scope change than currently assumed. |
| A3 | `REQUIRE_HMAC`/`REQUIRE_IP_WHITELIST` "environment-dependent strictness" (D-09) should be implemented via `NODE_ENV === 'production'` conditional validation in `config.ts` (mandatory in prod, optional elsewhere), reusing the existing `NODE_ENV` convention already used in `logging/logger.ts` | Code Examples | If the project actually wants an explicit separate toggle (e.g., `ENFORCE_WEBHOOK_AUTH=true/false`) independent of `NODE_ENV`, the config surface will need an extra key; low risk either way since both are simple to add, but worth confirming during planning rather than assuming `NODE_ENV` is the intended signal. |
| A4 | New `webhook_replay` table stores `(webhook_id TEXT PRIMARY KEY, received_at INTEGER)` and is never pruned in Phase 1 (consistent with D-14's "retention is manual") | Architecture Patterns / Pattern 3 | Table grows unbounded over the service's lifetime; acceptable per D-14, but if webhook volume is very high this could eventually affect query performance — not a Phase 1 concern given a single-booth deployment, but worth noting for a future retention-tooling phase. |
| A5 | A new `received_at INTEGER` (epoch ms, server-assigned) column is needed on `registration`, distinct from the existing `registered_at TEXT` (source-provided timestamp string), specifically so the dedup time-window comparison isn't dependent on the source system's clock/formatting | Architecture Patterns / Pattern 4 | If `registered_at` is reliably ISO-8601 and reliably close to server-receive time, this second column may be redundant — but relying on an external system's clock for a security/correctness-relevant time window is risky; recommend keeping both fields distinct rather than assuming this away. |

**If this table is empty:** N/A — see entries above; all are flagged for planner/user confirmation before being treated as locked implementation details.

## Open Questions

1. **What is the exact canonical string Mirror Request signs on its side?**
   - What we know: The three headers are fixed (`X-Webhook-Signature`, `X-Webhook-Timestamp`, `X-Webhook-Id`) and verification must be against the raw body (D-10). CONTEXT.md explicitly defers the exact canonical string to agent discretion.
   - What's unclear: Whether "the source system" (Mirror Request) already has a fixed signing implementation this service must match bit-for-bit, or whether both sides of this integration are being built/updated together and the central service's choice effectively *defines* the contract.
   - Recommendation: Confirm with whoever controls the Mirror Request / proxy side before finalizing Pattern 2's exact canonical string; structure the implementation (a single `buildCanonicalString()` function) so it's a one-line change if the assumption is wrong.

2. **Does the dedup email/phone fallback (D-02) ever actually trigger given `id` is currently mandatory?**
   - What we know: `mirrorReceiver.ts` currently 400s any request missing `id` or `name`. D-02 describes an "if `id` is absent" fallback.
   - What's unclear: Whether D-02's "absent" refers to genuinely missing `id` in the payload (which would require relaxing the current 400 validation) or to `id` differing across two submissions from the same guest (a resubmission with a freshly-generated id) — see Assumption A2.
   - Recommendation: Confirm intended semantics during planning; the plan should pick one interpretation explicitly rather than leaving it ambiguous in task descriptions.

3. **Should production `PROXY_IP_WHITELIST` validation reject the default `['127.0.0.1']` as "not really configured"?**
   - What we know: `config.ts`'s `required()` pattern already treats a placeholder value as an error for `AGENT_WS_TOKEN`/`DB_PASSWORD` `[VERIFIED: mirror-request/src/config.ts:33-39,41-42]`.
   - What's unclear: Whether the same "reject placeholder in production" treatment should extend to `PROXY_IP_WHITELIST`'s default.
   - Recommendation: Low-risk either way; the planner can decide, but flagging here so it isn't missed given D-09 explicitly calls production strictness "costly to reverse."

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Runtime | ✓ | v24.15.0 in this research sandbox (project pins `20.x` in `package.json`/`CLAUDE.md`) | Deployment target should use Node 20 LTS per project constraints; sandbox version mismatch is not a Phase 1 blocker but worth flagging so the executor doesn't assume sandbox Node = deploy Node |
| `better-sqlite3` native module | SQLite persistence | ✓ (loads and reports version 11.10.0, matching `^11.0.0`) | 11.10.0 | — |
| `mysql2` module | DB polling | ✓ (module loads) | matches `^3.23.2` pin | — |
| Reachable external MySQL instance | DB polling live testing | Not verified reachable in this sandbox (only checked that the `mysql` CLI binary and `mysql2` module exist locally; no live connection attempted, and doing so would require credentials not available to research) | — | Unit-test `dbPoller.ts` against a mocked `mysql2/promise` pool (as recommended in `.planning/codebase/TESTING.md`) rather than requiring a live DB for automated tests |
| npm registry access | Installing `supertest`/`@types/supertest` | ✓ (confirmed via live `npm view` calls during this research) | — | — |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** live MySQL connectivity for `dbPoller.ts` — use mocked `mysql2/promise` in automated tests; manual/human verification against the real read-only DB replica is still recommended before shipping (see Validation Architecture).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest ^2.1.4 `[VERIFIED: mirror-request/package.json:40]` |
| Config file | `mirror-request/vitest.config.ts` — includes `src/**/*.{test,spec}.*` and `test/**/*.{test,spec}.*` `[VERIFIED: mirror-request/vitest.config.ts:1-7]` |
| Quick run command | `cd mirror-request && npx vitest run test/on-register.test.ts` (or whichever new test file) |
| Full suite command | `cd mirror-request && npm test` (runs `vitest run`) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|---------------------|--------------|
| AUTH-02 | `/on-register` 403s outside IP allow-list | integration (supertest) | `npx vitest run test/on-register-auth.test.ts` | ❌ Wave 0 |
| D-09/D-10 | Valid HMAC signature (correct headers, raw body) accepted; invalid signature 403 | integration (supertest) | `npx vitest run test/on-register-auth.test.ts` | ❌ Wave 0 |
| D-11 | Stale timestamp rejected; replayed `X-Webhook-Id` rejected on second request | integration (supertest) | `npx vitest run test/on-register-auth.test.ts` | ❌ Wave 0 |
| D-12 | Auth failure response is 403 with generic body, no secret/detail leaked | integration (supertest, assert on response body) | `npx vitest run test/on-register-auth.test.ts` | ❌ Wave 0 |
| D-01/D-02/D-03 | Duplicate within window → 200 + original `jobId`, no new `queue_job` row; outside window → new job | integration (supertest + direct `LocalStore` assertions) | `npx vitest run test/on-register-dedup.test.ts` | ❌ Wave 0 |
| ING-02/D-05 | DB poller failure logs warning and retries next cycle without crashing | unit (mocked `mysql2/promise` pool) | `npx vitest run test/db-poller.test.ts` | ❌ Wave 0 |
| D-06 | Source row missing `id`/`name` is skipped, doesn't block cursor advancement | unit (mocked pool) | `npx vitest run test/db-poller.test.ts` | ❌ Wave 0 |
| D-04 | Poller finds an already-webhook-ingested id → skip + informational log | unit (mocked pool + `LocalStore`) | `npx vitest run test/db-poller.test.ts` | ❌ Wave 0 |
| ING-03/STO-01 | Cursor and registration state persist across a `LocalStore` close/reopen | integration (real SQLite temp file) | `npx vitest run test/local-store-persistence.test.ts` | ❌ Wave 0 |
| D-15/D-16 | New log lines mask email/phone; raw payload never logged outside `DEBUG` | unit (assert on `mask()` output / logger call args) | `npx vitest run test/logging-mask.test.ts` (or extend existing coverage if any is added inline) | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** targeted `npx vitest run <file>` for the file(s) touched
- **Per wave merge:** `cd mirror-request && npm test` (full suite)
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `mirror-request/test/on-register-auth.test.ts` — covers AUTH-02, D-09..D-12
- [ ] `mirror-request/test/on-register-dedup.test.ts` — covers D-01..D-03
- [ ] `mirror-request/test/db-poller.test.ts` — covers ING-02, D-04..D-08 (needs a `mysql2/promise` mock — no existing pattern for this in the codebase; `vi.mock('mysql2/promise', ...)` from Vitest)
- [ ] `mirror-request/test/local-store-persistence.test.ts` — covers ING-03, STO-01, and the new `webhook_replay`/dedup schema
- [ ] Framework install: `npm install --save-dev supertest @types/supertest` — needed for the auth/dedup integration tests listed above

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|----------------|---------|--------------------|
| V2 Authentication | Yes | HMAC-SHA256 signature (D-09/D-10) as the "authentication" of the webhook sender; `node:crypto` `timingSafeEqual`, never a hand-rolled comparison |
| V3 Session Management | No | Stateless webhook endpoint; no session concept in this phase |
| V4 Access Control | Yes | IP allow-list (`isWhitelisted()`, existing) as network-layer access control, layered with HMAC |
| V5 Input Validation | Yes | Existing `if (!id || !name)` required-field check; extend carefully if A2's interpretation changes this |
| V6 Cryptography | Yes | `node:crypto` `createHmac('sha256', ...)` + `timingSafeEqual` — never hand-roll HMAC or a custom constant-time compare |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|-----------------------|
| Webhook replay (resending a captured valid request) | Spoofing / Tampering | Timestamp skew window (D-11) + persisted `X-Webhook-Id` replay table (Pattern 3) |
| Signature timing attack | Information Disclosure | `crypto.timingSafeEqual`, buffer-length guard before compare (Pitfall 2) |
| IP spoofing via `X-Forwarded-For` | Spoofing | Do not enable `app.set('trust proxy', ...)` casually; current direct-socket-IP check against `PROXY_IP_WHITELIST` is intentional (Anti-Patterns) |
| Log injection / PII leakage via new ingestion log lines | Information Disclosure | Route all new log messages through the existing `logger`/`mask()` pipeline (Pitfall 6); never log raw payload outside `DEBUG` + non-production (D-16) |
| SQL injection in new dedup/replay queries | Tampering | `better-sqlite3` prepared statements only (Don't Hand-Roll table), matching every existing `LocalStore` method |
| Unbounded replay-ID table growth | Denial of Service (resource exhaustion, long-term) | Accepted risk for Phase 1 per D-14 (manual retention); not a near-term concern for single-booth traffic volume, flagged in Assumptions Log (A4) |

## Sources

### Primary (HIGH confidence — read directly this session)
- `mirror-request/src/ingestion/mirrorReceiver.ts` — existing `/on-register` handler, IP allow-list, idempotency
- `mirror-request/src/ingestion/dbPoller.ts` — existing MySQL polling, cursor use, config drift
- `mirror-request/src/state/localStore.ts` — existing SQLite schema and prepared-statement conventions
- `mirror-request/src/config.ts`, `mirror-request/src/types.ts` — existing typed config and `EnvConfig` contract
- `mirror-request/src/logging/logger.ts` — existing masking/logging pipeline
- `mirror-request/src/index.ts` — composition root, middleware ordering (the raw-body pitfall)
- `mirror-request/CLAUDE.md` — sub-project hard rules
- `mirror-request/package.json`, `.planning/config.json` — installed dependency versions
- `.planning/phases/01-foundation-ingestion/01-CONTEXT.md`, `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, `.planning/PROJECT.md`, `.planning/STATE.md`
- `.planning/codebase/STACK.md`, `ARCHITECTURE.md`, `CONVENTIONS.md`, `STRUCTURE.md`, `INTEGRATIONS.md`, `TESTING.md`, `CONCERNS.md`
- Live version checks this session: `npm view express/better-sqlite3/winston/supertest/@types/supertest version`, `node --version`, module-load checks for `better-sqlite3` and `mysql2/promise`

### Secondary (MEDIUM confidence — WebSearch cross-checked against multiple independent sources)
- Express raw-body capture via `verify` callback / `express.raw()` (expressjs.com guidance, Stripe docs pattern, multiple webhook-integration guides)
- `crypto.timingSafeEqual` usage and length-mismatch throw behavior (nodejs.org/api/crypto.html, cross-checked against several guides)
- HMAC webhook signing conventions: sign `timestamp.payload`, reject stale timestamps, persist replay IDs (multiple webhook-security guides: hooklistener.com, webhooks.fyi, inventivehq.com)
- `better-sqlite3` WAL mode, prepared-statement reuse, transactions for bulk writes (github.com/WiseLibs/better-sqlite3/docs/performance.md, cross-checked)
- Express `trust proxy` / `X-Forwarded-For` security guidance (expressjs.com/en/guide/behind-proxies.html, cross-checked against MDN and OneUptime blog)

### Tertiary (LOW confidence)
- None retained as authoritative in this document — all WebSearch findings above were cross-checked across ≥2 independent sources before being tagged `[CITED]`/MEDIUM.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new production dependencies; all versions verified live via `npm view` and module-load checks this session
- Architecture: HIGH for what already exists (directly read every relevant source file); MEDIUM for new patterns (HMAC canonical string, dedup-window schema) since these are new design decisions cross-checked against general best practice but not against an official spec for this private integration
- Pitfalls: HIGH — the raw-body ordering bug, DB_PORT mismatch, silent-reconciliation gap, and `INSERT OR REPLACE` risk are all directly verified against current source code, not inferred

**Research date:** 2026-08-10
**Valid until:** 2026-09-09 (30 days — stable domain; re-verify if Mirror Request's actual signing implementation becomes available, as it may override Assumption A1)
