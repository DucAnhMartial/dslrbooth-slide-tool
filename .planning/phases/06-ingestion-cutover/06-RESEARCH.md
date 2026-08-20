# Phase 6: Ingestion Cutover - Research

**Researched:** 2026-08-11
**Domain:** Cross-database MySQL VIEW as an integration seam; Django/MySQL source-of-truth verification; Node.js driver type-coercion hazards; capability-URL rate limiting
**Confidence:** HIGH for the three primary D-03 questions (verified against `ets_web` source and live data) and the mysql2/better-sqlite3 type hazard (verified from driver docs + this project's own source); MEDIUM for MySQL grant/DEFINER mechanics (verified via official docs, not executed — DDL is write-forbidden during research); LOW/ASSUMED for rate-limiter algorithm choice (no precedent in this codebase).

## Summary

This research answers the three questions CONTEXT.md's D-03 explicitly deferred to research, and in doing so **partially overturns D-03's premise**: source code proves `event_manager_attendance` allows more than one row per ticket (unique constraint is `(ticket, session)`, not `ticket` alone — a ticket registered for N sessions gets N attendance rows), so the INNER JOIN in a naive form of the VIEW is not, by itself, a guaranteed 1:1 guard. The live data is safe *today* only because this event's 27 order details all carry exactly one `registered_session` value — a fact of this event's configuration, not a database constraint. The VIEW must therefore deduplicate explicitly (one row per ticket) rather than rely on the raw JOIN.

Separately, and more urgently: this research surfaces a **previously undocumented crash-class defect** in the already-shipped, never-modified `dbPoller.ts`. `mysql2` returns `DATETIME`/`TIMESTAMP` columns as native JS `Date` objects by default (no `dateStrings` option is set in the pool config, and D-02 forbids adding one). `better-sqlite3` — the *only* place `registered_at` is written to (both `upsertRegistration()` and `setCursor()`) — throws a `TypeError` on any bind parameter that is not a number, string, bigint, buffer, or null; a `Date` instance is none of those. Because `photobooth.registrations` has held zero rows since Phase 1, this code path has **never executed** in production. The VIEW is the only chance to prevent this: it must project `registered_at` as a string (`CAST(... AS CHAR)` or `DATE_FORMAT(...)`), not as a raw temporal type, or the very first real registration will make every poll cycle fail silently, forever, inside the existing `catch` block's `warn`-and-retry.

Cancellation is safe: no code path in `ets_web` can cancel an order/ticket once it has reached `VALID` + attendance (both the admin action and the public cancel API require `OrderStatus.PENDING`), so D-03's "cancelled tickets can never carry an attendance row" holds as a structural guarantee for the tickets this VIEW will ever see, once deduplicated. But there IS a genuine (if currently dormant) code path where a `VALID` ticket ends up with **zero** attendance rows — `register_ticket_to_event()` sets `ticket.status = VALID` and saves it *before* calling `create_attendance_and_notify()`, outside that method's own `@transaction.atomic` block; if the event has no `default_session` and none of `registered_session_codes` resolves, `RegistrationError` is raised after the ticket is already committed VALID. This is a miss (guest never reaches the queue), not a duplicate — lower severity than D-03's concern, but real and worth a one-line note in the runbook.

**Primary recommendation:** Build the VIEW as a single `INNER JOIN ... GROUP BY ticket.id` (or an equivalent `ROW_NUMBER()`/correlated-subquery dedup) picking the earliest attendance row per ticket, filtered by `t.status = 'valid' AND o.status = 'completed'`, with every projected column explicitly cast to a string type — especially `registered_at`, which must never reach the poller as a native MySQL temporal type. Use `SQL SECURITY DEFINER` with an explicit, persistent definer account (not the interactive DDL-runner's personal login) so the single budgeted `GRANT` stays exactly one statement. Probe VIEW health with the same `mysql2` pool `dbPoller.ts` already owns, distinguishing `err.code === 'ER_VIEW_INVALID'` (errno 1356 — alert) from connection-class codes (`PROTOCOL_CONNECTION_LOST`, `ECONNREFUSED`, `ETIMEDOUT`, `ER_ACCESS_DENIED_ERROR` — warn only, Phase 1's D-05 case). Rate-limit `/status/:jobId` with a small hand-rolled in-memory limiter mirroring `ipAllowlist.ts`'s style rather than adding a new dependency — this project has added none since Phase 1 and `express-rate-limit`'s own registry signals (see Package Legitimacy Audit) don't clear this project's bar cleanly enough to justify the exception.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** The VIEW derives `registered_at` from `event_manager_attendance.created_at`, reached by an INNER JOIN on `event_manager_attendance.ticket_id = ticketing_ticket.id`. Measured 2026-08-11: that column is distinct across all 9 rows, whereas `ticketing_order.created_at` ties exactly for two tickets on one order. Sourcing the timestamp per-ticket removes the failure mode at the source. Reversible.
- **D-02:** `dbPoller.ts` is **not** modified. Its `registered_at > ?` cursor and the SQLite cursor format stay exactly as shipped. Reversible (a compound cursor remains a future option).
- **D-03:** The same INNER JOIN is the validity filter — measured 9/9 valid tickets have an attendance row, 0/18 cancelled+temporary do. **Research was required to confirm, not assume, this — see Primary Research Findings below; the JOIN alone is insufficient and needs explicit deduplication.**
- **D-04:** Name fallback chain: `TRIM(CONCAT(first_name,' ',last_name))` → `account_personalinfo.display_name` → `ticketing_customer.display_name` → `ticketing_customer.username` → synthetic `Khách • <last 4 of ticket_code>`. Never empty. 4/9 current valid rows have no first/last name.
- **D-05:** Every fall-through past first/last name emits one `warn` log naming the ticket code and which rung supplied the name.
- **D-06:** At cutover the `registrations` cursor is seeded to the current timestamp so none of the 9 historical rows dispatch.
- **D-07:** End-to-end proof is a real registration created live during cutover, not a replay.
- **D-08:** The VIEW emits literal `'print'` for `mode`. Never validated anywhere downstream — flows verbatim to dslrBooth's `/start?mode=`.
- **D-09:** A broken VIEW never blocks the service. Probe runs at startup and periodically; on failure logs `error` and alerts via `NOTIFY_WEBHOOK_URL`; process continues serving. Deliberately departs from `config.ts`'s production fail-fast pattern.
- **D-10:** `/status/:jobId` gets rate limiting. `registrations.id` becomes `ticket_code`: CSPRNG-minted (`secrets.choice`), 40 bits of entropy — below ASVS V2's ≥128-bit guidance for a capability URL, so brute force (not pattern-guessing) is the residual risk the limiter mitigates.

### Claude's Discretion

- The exact SQL text of the VIEW, `SECURITY INVOKER` vs `SECURITY DEFINER`, and the precise `GRANT` statement — provided the grant confers read access only and output columns are exactly `id, name, email, phone, mode, registered_at` with types assignable to `photobooth.registrations`'s current definition.
- The probe's mechanism, cadence, and alert payload shape (D-09), provided it cannot block startup or terminate the process.
- The rate limiter's algorithm, window, and threshold (D-10), provided a throttled response is not distinguishable in a way that confirms an id exists.
- Where the `photobooth.registrations` rollback artefact lives.

### Deferred Ideas (OUT OF SCOPE)

- Agent configuration UI (manual env-var config is an operational pain point, but out of this phase — separate phase).
- Backfilling `qrcode_url` into the guest notification payload (Phase 4's payload shape is settled; changing it touches `web-slide`'s receiver).
- Keying the queue on check-in (`scanned_at`) rather than registration — `scanned_at` is 0/9 populated; revisit only if an event actually uses check-in.

</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| ING-02 | Đọc DB backend read-only (SELECT) định kỳ để bắt đăng ký bị miss | The VIEW is the thing `ING-02`'s already-built poller reads. Research establishes the VIEW's exact SQL shape (dedup'd JOIN, string-cast columns), the GRANT needed for the poller's read-only account to see it, and the health probe that keeps ING-02 honest when `ets_web` changes shape under it. |
| ING-03 | Cursor DB polling được lưu trong local state, không ghi ngược DB thật | Research confirms `dbPoller.ts`/`localStore.ts` are read-only toward MySQL already (no code change needed) and identifies the concrete cursor-seeding mechanism (`setCursor()` call before first boot) that satisfies D-06 without touching ING-03's existing local-only persistence. |

</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Registration validity filtering (valid + completed only) | Database / Storage | — | Expressed as VIEW JOIN/WHERE, not application code — the whole point of D-03's "omission as guarantee" pattern. Filtering here means the API/Backend tier (dbPoller) never even sees an invalid row to filter. |
| Guest identity resolution (name fallback chain, D-04) | Database / Storage | — | Computed in the VIEW's `SELECT` expression (`COALESCE`/`CASE`), not in `dbPoller.ts` — D-02 forbids touching that file, so the fallback chain has nowhere else to live. |
| Cross-database read access control | Database / Storage | — | `GRANT`/`DEFINER` — a MySQL-native concern, not an application concern. The "Agent is a dumb relay, business logic lives in the service" rule from `CLAUDE.md` doesn't reach this layer at all; this is infrastructure, not business logic. |
| Registration polling / cursor advance | API / Backend | — | Already built (`dbPoller.ts`), untouched by this phase (D-02). |
| Cursor seeding at cutover | API / Backend (operational script) | Database / Storage (SQLite write) | A one-time `LocalStore.setCursor()` call, not new poller code — it's an operational action against the *local* SQLite store, not MySQL. |
| VIEW health probe | API / Backend | Database / Storage | The probe query itself runs against MySQL, but the alert decision, alert dispatch, and never-block guarantee (D-09) are backend logic, matching Phase 1's D-05 pattern (`dbPoller.ts`'s own `doPoll()` catch block) rather than anything DB-side. |
| `/status/:jobId` rate limiting | API / Backend | — | Express middleware, same tier as `ipAllowlist.ts`'s existing route guards. |
| Mode validation | *Nobody* (deliberately) | — | D-08 is explicit: `mode` is never validated anywhere in this codebase. The VIEW's job is only to emit a value dslrBooth's Local API already accepts (`'print'`), not to build a validation layer that doesn't exist today. |

## Standard Stack

No new runtime dependency is required for the VIEW, GRANT, probe, or cursor seeding — all of it is either MySQL DDL/DCL or reuses `mysql2` (already a dependency, `^3.23.2` in `package.json`, `3.23.2` installed, `3.23.3` current on the npm registry [VERIFIED: `npm view mysql2 version` → `3.23.3`, `mirror-request/node_modules/mysql2/package.json` → `3.23.2` installed]). The rate limiter is the one place a new dependency is *conceivable*; see Package Legitimacy Audit and the recommendation below for why this research recommends against adding one.

### Core (reused, not new)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `mysql2` | `3.23.2` installed / `3.23.3` latest [VERIFIED: npm registry] | The probe query and the poller's live SELECT both run through the pool `dbPoller.ts:44-53` already creates | Already the project's only MySQL driver; adding a second one for the probe would violate "smallest change" |
| `better-sqlite3` | `^11.0.0` [CITED: `mirror-request/package.json`] | Cursor seeding writes through `LocalStore.setCursor()`, the same method the poller itself calls | Already the project's only local-state store |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| none recommended | — | Rate limiting `/status/:jobId` | See discussion below — hand-roll, matching `ipAllowlist.ts` |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Hand-rolled in-memory rate limiter (recommended) | `express-rate-limit` | Battle-tested, handles `trust proxy`/`X-Forwarded-For` edge cases this project doesn't otherwise need (no proxy trust is configured anywhere — `mirrorReceiver.ts`/`ipAllowlist.ts` both note this explicitly). **Flagged `[SUS]` by this project's package-legitimacy gate** — see audit below; the flag is a false-positive artifact (latest-version publish-date heuristic against a 57.8M-weekly-download package), but per this project's own gate protocol a `[SUS]` verdict still requires a `checkpoint:human-verify` before install, which is disproportionate for what a ~15-line `Map`-based limiter achieves. Not recommended as the default; note as an option if the planner wants a more feature-complete limiter (sliding window, `RateLimit-*` headers) than a hand-rolled one provides. |
| `CAST(a.created_at AS CHAR)` for `registered_at` | `DATE_FORMAT(a.created_at, '%Y-%m-%d %H:%i:%s.%f')` | `DATE_FORMAT` with `%f` guarantees a fixed 6-digit, zero-padded microsecond field by contract [CITED: MySQL 8.0 DATE_FORMAT reference], which is what makes lexical string comparison (`registered_at > ?`) equivalent to chronological comparison. `CAST(... AS CHAR)` is expected to also zero-pad to the column's declared `fsp` (6, from `datetime(6)`), but this research could not execute DDL to confirm that empirically (write-forbidden during research) — **`DATE_FORMAT` is the safer, provably-fixed-width choice and is this research's recommendation**, not `CAST`. |
| `SQL SECURITY DEFINER` (recommended) | `SQL SECURITY INVOKER` | INVOKER would require granting `extension_service_ro` direct `SELECT` on every `ets_web` table the JOIN touches (5-6 individual `GRANT` statements, or one broad `ON ets_web.*`), contradicting the phase's own framing of "a read-only `GRANT`" (singular) and widening `extension_service_ro`'s visibility into `ets_web` well beyond what `SHOW DATABASES` shows it today. DEFINER keeps the extra grant to exactly one statement (`GRANT SELECT ON photobooth.registrations TO ...`) and keeps `ets_web` invisible to the service account. |

**Installation:** none required.

## Package Legitimacy Audit

| Package | Registry | Age (latest publish) | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|----|-----------|-------------|---------|-------------|
| `express-rate-limit` | npm | latest version published 2026-08-04 (7 days before this research) [VERIFIED: `gsd-tools query package-legitimacy check`] | 57,845,963/week | `github.com/express-rate-limit/express-rate-limit` | `[SUS]` (`reasons: ["too-new"]`) | **NOT adopted.** Not installed in this phase's recommendation; hand-rolled limiter used instead (see Standard Stack). If the planner overrides this recommendation and installs it anyway, the flag requires a `checkpoint:human-verify` before `npm install` per this project's gate protocol — the "too-new" signal is almost certainly a false positive (a patch release of a package with 57.8M weekly downloads and a dedicated GitHub org, not a fresh/hallucinated package), but the gate is mechanical and doesn't distinguish "new package" from "new release of an old package." |

**Packages removed due to `[SLOP]` verdict:** none.
**Packages flagged as suspicious `[SUS]`:** `express-rate-limit` (not adopted; see above).

*No other new packages are proposed by this research. `mysql2` and `better-sqlite3` are pre-existing dependencies, not new installs.*

## Architecture Patterns

### System Architecture Diagram

```
 Guest's browser                ets_web (Django, unmodified)
 ─────────────────              ─────────────────────────────
 existing landing page  ──POST──►  /api/v1/public/register/{event_code}/{slug}
                                        │
                                        ▼
                              RegistrationService.register_ticket_to_event()
                                 ticket.status = VALID  (saved immediately)
                                        │
                                        ▼
                              create_attendance_and_notify()
                                 for each session in registered_session_codes:
                                   Attendance.objects.get_or_create(ticket, session)
                                        │
                                        ▼
                         MySQL: ets_web.ticketing_ticket (status='valid')
                                ets_web.event_manager_attendance (created_at)
                                        │
                    ┌───────────────────┘  (same MySQL instance, 127.0.0.1)
                    ▼
       photobooth.registrations  (VIEW, this phase)
       ── INNER JOIN ticketing_ticket → orderdetail → order → customer
       ── LEFT JOIN account_personalinfo (name/phone fallback)
       ── dedup: one row per ticket, earliest attendance.created_at
       ── WHERE t.status='valid' AND o.status='completed'
       ── projects id/name/email/phone/mode/registered_at, all cast to string
                    │
                    ▼  SELECT ... WHERE registered_at > ? LIMIT ?   (dbPoller.ts:100-103, UNCHANGED)
       mirror-request (Node.js, Extension Service)
       ── DBPoller.doPoll() — every DB_POLL_INTERVAL_MS (default 3000ms)
       ── skip if !id/!name (D-06 of Phase 1) — logs warn
       ── skip if isProcessed(id) (webhook reconciliation)
       ── LocalStore.upsertRegistration() + enqueueJob()   → SQLite (queue_job, registration)
       ── LocalStore.setCursor('registrations', lastRow.registered_at)
                    │
                    ▼
       QueueService → AgentServer (WS) → dslrBooth Local API → guest session
                    │
                    ▼ (parallel, independent of ingestion)
       VIEW health probe (this phase, new)
       ── runs at startup + every N minutes, using dbPoller.ts's own pool
       ── SELECT id FROM registrations LIMIT 1
       ── err.code === 'ER_VIEW_INVALID' (errno 1356)  → error log + NOTIFY_WEBHOOK_URL alert, service keeps running
       ── connection-class err.code (ECONNREFUSED, PROTOCOL_CONNECTION_LOST, ETIMEDOUT, ER_ACCESS_DENIED_ERROR) → warn only, no alert (Phase 1 D-05's case)
```

### Recommended Project Structure

No new source directories — this phase's code footprint is small and fits existing modules:

```
mirror-request/
├── src/
│   ├── ingestion/
│   │   └── dbPoller.ts          # UNCHANGED (D-02) — read only, no edits
│   ├── ops/                      # new, small: VIEW health probe (D-09)
│   │   └── viewHealthProbe.ts    # reuses dbPoller's pool-creation shape + notificationService's fetch pattern
│   ├── status/
│   │   └── statusRoute.ts        # + rate-limit middleware mounted ahead of the existing GET handler (D-10)
│   └── security/
│       └── rateLimiter.ts        # new, small: in-memory limiter, styled like ipAllowlist.ts
├── docs/
│   └── OPS-RUNBOOK.md            # + new section: VIEW DDL, GRANT statement, cursor-seed procedure, rollback script location
└── data/
    └── backups/
        └── photobooth-registrations-rollback-<timestamp>.sql   # CREATE TABLE capture + restore script (D-rollback)
```

The VIEW itself is **not** a file in either repository — it is DDL applied directly to MySQL. The plan should still store the exact SQL text somewhere in version control (e.g. `mirror-request/docs/migrations/06-registrations-view.sql`) purely as documentation/audit trail; MySQL does not read this file, an operator runs it by hand or via a migration script.

### Pattern 1: Deduplicated JOIN instead of a bare INNER JOIN

**What:** Rather than `SELECT ... FROM ticketing_ticket t INNER JOIN event_manager_attendance a ON a.ticket_id = t.id ...` (which can return >1 row per ticket if a ticket has attendance rows for multiple sessions), pick exactly one attendance row per ticket — the earliest by `created_at`, preserving D-01's ordering intent.

**When to use:** Always, in this VIEW — see Primary Research Finding 1 below for why the bare JOIN is unsafe even though it happens to be safe on today's data.

**Example (MySQL 8.0, window function — the server here is 8.0.46 [VERIFIED: `mysql -e "SELECT VERSION()"` → `8.0.46-0ubuntu0.22.04.3`], so window functions are available):**
```sql
CREATE OR REPLACE
  SQL SECURITY DEFINER
  VIEW photobooth.registrations AS
SELECT
    d.ticket_code                                              AS id,
    d.guest_name                                                AS name,
    d.email                                                     AS email,
    d.phone                                                     AS phone,
    'print'                                                     AS mode,
    DATE_FORMAT(d.attendance_created_at, '%Y-%m-%d %H:%i:%s.%f') AS registered_at
FROM (
    SELECT
        t.ticket_code,
        COALESCE(
          NULLIF(TRIM(CONCAT(COALESCE(p.first_name,''), ' ', COALESCE(p.last_name,''))), ''),
          NULLIF(p.display_name, ''),
          NULLIF(c.display_name, ''),
          NULLIF(c.username, ''),
          CONCAT('Khách • ', RIGHT(t.ticket_code, 4))
        )                                                       AS guest_name,
        c.email,
        p.phone,
        a.created_at                                            AS attendance_created_at,
        ROW_NUMBER() OVER (
          PARTITION BY t.id ORDER BY a.created_at ASC, a.id ASC
        )                                                       AS rn
    FROM ets_web.ticketing_ticket        t
    INNER JOIN ets_web.event_manager_attendance a ON a.ticket_id = t.id
    INNER JOIN ets_web.ticketing_orderdetail    od ON od.id = t.order_detail_id
    INNER JOIN ets_web.ticketing_order          o  ON o.id = od.order_id
    INNER JOIN ets_web.ticketing_customer       c  ON c.id = o.customer_id
    LEFT JOIN  ets_web.account_personalinfo     p  ON p.id = t.ticket_holder_id
    WHERE t.status = 'valid'
      AND o.status = 'completed'
) d
WHERE d.rn = 1;
```
This is a **candidate skeleton for the planner to refine, not a verified-final SQL text** — table/column names in the FROM/JOIN list are `[VERIFIED: information_schema.KEY_COLUMN_USAGE, per STATE.md's Phase 6 row and this session's confirmation of the ets_web account's grants]`, but the exact `guest_name`/name-fallback CASE expression, the `ROW_NUMBER()` tiebreak on `a.id` (not verified as the correct secondary sort — any deterministic tiebreak works), and the DEFINER clause's account name are all `[Claude's Discretion per CONTEXT.md]` and must be pinned by the plan, not assumed correct as written here. The one change from D-01's literal wording that research is asserting, not proposing: `registered_at` MUST be `DATE_FORMAT(..., '%Y-%m-%d %H:%i:%s.%f')` (a string), never `a.created_at` directly (a `datetime(6)`) — see Pitfall 1.

### Anti-Patterns to Avoid

- **Selecting `a.created_at` (or any DATETIME/TIMESTAMP column) directly into the VIEW's output.** `mysql2` will hand `dbPoller.ts` a JS `Date` object, and `better-sqlite3` throws on it. See Pitfall 1.
- **A bare INNER JOIN with no per-ticket dedup.** Correct today only because this event's `registered_session` is always a single-element array; breaks the moment any event registers a ticket for 2+ sessions. See Primary Research Finding 1.
- **`SQL SECURITY INVOKER` plus a broad `GRANT SELECT ON ets_web.* TO extension_service_ro`.** Technically satisfies "read-only," but widens the ingestion account's blast radius to every table in `ets_web` (payment records, staff accounts, etc.) when the VIEW only touches six. Prefer DEFINER + a narrowly-scoped VIEW.
- **Testing the probe by actually breaking the live VIEW.** Never drop/rename a real `ets_web` table to test the probe — the human's hard constraint forbids any write to `ets_web`, and the probe's failure-mode branching is fully testable by mocking `mysql2`'s pool (see Validation Architecture).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Detecting whether a value is a native Date vs. a string at runtime, to work around the mysql2/better-sqlite3 mismatch | A runtime type-check + `.toISOString()` shim inside `dbPoller.ts` | Cast in the VIEW's SQL (`DATE_FORMAT`) | D-02 forbids touching `dbPoller.ts` at all; the fix has to live in the one place D-02 leaves open — the VIEW's SELECT list. |
| A retry/backoff policy for the health probe | A bespoke exponential-backoff scheduler | Reuse `dbPoller.ts`'s own `setInterval` cadence pattern (fixed interval, `doPoll()`-style catch-and-warn) for the probe's periodic run | This project already has exactly one polling-loop pattern (Phase 1's D-05: warn-and-retry, never crash). A second bespoke retry policy for the probe would be an unjustified second pattern for the same problem class. |
| A generic outbound-webhook client for the D-09 alert | A new `AlertService` class with its own retry/timeout config | The exact `fetch(url, {method:'POST', signal: AbortSignal.timeout(ms)})` shape already proven in `notificationService.ts:149-155`, reusing `NOTIFY_WEBHOOK_URL`/`NOTIFY_FETCH_TIMEOUT_MS` | CONTEXT.md's own canonical-refs section names this file as the pattern to reuse "including its timeout and retry handling." A full class is overkill for a fire-and-forget alert; a single reused fetch call is proportionate. |

**Key insight:** every "don't hand-roll" here is really "don't build a second version of a pattern this codebase already has" — Phase 6 is a hardening/integration pass over four already-verified phases, and its own research philosophy (per `06-CONTEXT.md`'s Established Patterns section) is explicit that omission-as-guarantee, never-crash-on-network-boundary, and constructor-injected config are the house style. Nothing in this phase needs a genuinely new pattern.

## Runtime State Inventory

This is a cutover/migration phase — `photobooth.registrations` moves from `BASE TABLE` to `VIEW`, and a new cross-database `GRANT` is issued. Each category below is answered explicitly, not left blank.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| **Stored data** | `photobooth.registrations` is a `BASE TABLE` today, **measured 0 rows** [CITED: `06-CONTEXT.md`/`STATE.md` 2026-08-11 measurement — this session could not independently re-verify the row count or the exact `CREATE TABLE` text because the `photobooth` service DB credentials are not readable in this sandbox (`mirror-request/.env` access denied — see Environment Availability); the `ets_web` account used for all other queries in this session is itself denied access to `photobooth` (`ERROR 1044 Access denied for user 'ets_web'@'127.0.0.1' to database 'photobooth'`), confirming the databases are genuinely credential-isolated from each other, consistent with the phase's premise]. Since it holds 0 rows, no data migration is needed — only a schema swap (`DROP TABLE` then `CREATE VIEW`, same name). |
| **Live service config** | None found. `photobooth` holds exactly one table-turned-view; no other MySQL objects, no n8n/Datadog/Tailscale-style external config surfaces exist in this stack (single Node.js service + SQLite, per `CLAUDE.md`/`ROADMAP.md`). |
| **OS-registered state** | None found. No Windows Task Scheduler, no pm2 ecosystem file naming `registrations` as a table, no launchd/systemd unit referencing the DB schema. `mirror-request`'s only OS-level registration is the PM2 process itself (`config.json`'s `"processManager": "pm2"`), which is unaffected by a schema-only change underneath an unchanged `mysql2` connection string. |
| **Secrets/env vars** | `DB_USER`/`DB_PASSWORD`/`DB_HOST`/`DB_PORT`/`DB_NAME` in `mirror-request`'s env — **unchanged by this phase**, since the VIEW keeps the same name (`registrations`) inside the same database (`photobooth`) the poller already points at. The *new* secret this phase introduces is whatever password is attached to the VIEW's `DEFINER` account if a new dedicated definer account is created (see Architecture Patterns) — that credential must be set once at `CREATE VIEW` time and does not need to be known to `mirror-request` at all (DEFINER security means the invoking account, `extension_service_ro`, never authenticates as the definer). |
| **Build artifacts** | None found. No package needs reinstalling, no `dist/` staleness risk — this phase ships zero TypeScript changes to `dbPoller.ts` itself (D-02). The probe and rate-limiter are new files requiring a normal `npm run build`, same as every prior phase. |

## Common Pitfalls

### Pitfall 1: The VIEW silently breaks ingestion forever by returning a native datetime type

**What goes wrong:** `registered_at` is selected as `a.created_at` (or any bare `DATETIME`/`TIMESTAMP` column) without casting to a string. `mysql2` decodes it as a JS `Date` object (default behavior, no `dateStrings` configured in `dbPoller.ts`'s pool — and D-02 forbids adding one there). `LocalStore.upsertRegistration()` and `LocalStore.setCursor()` both bind this value directly into a `better-sqlite3` prepared statement, which only accepts numbers, strings, bigints, buffers, and null [VERIFIED: `mirror-request/src/state/localStore.ts:123-134,298-300` — `stmt.run({..., registered_at: r.registered_at, ...})` and `.run(pollKey, value, ...)` bind the value with no type coercion in between; `better-sqlite3`'s documented parameter-type restriction confirmed via GitHub issue #907/#741, "an instance of a class does not work as bind parameter"]. `better-sqlite3` throws a `TypeError`.
**Why it happens:** This exact code path has existed since Phase 1 but has never executed against a real row, because `photobooth.registrations` has held 0 rows the entire time. A crash class hiding behind an always-empty table is invisible to every test that mocks the row shape as a plain object with a string `registered_at` (which is what `dbPoller.ts`'s own test file does — `test/db-poller.test.ts` mocks `query()` to resolve string values, not `Date` objects, so it cannot catch this).
**How to avoid:** The VIEW must cast the timestamp to a string in the SELECT list — `DATE_FORMAT(a.created_at, '%Y-%m-%d %H:%i:%s.%f')` is recommended over a bare `CAST(... AS CHAR)` because `DATE_FORMAT`'s `%f` format specifier contractually zero-pads to 6 digits, which `CAST`'s string conversion behavior for `datetime(6)` this research could not independently verify (write-forbidden). Verify empirically at plan-execution time by running the actual query once through the real pool and asserting `typeof row.registered_at === 'string'` before wiring it into production.
**Warning signs:** `DBPoller: cycle failed: SQLite3 can only bind ...` in the log the first time a real registration occurs — by design this doesn't crash the process (D-05's catch-and-warn), so it fails *silently and repeatedly*, every `DB_POLL_INTERVAL_MS`, with no guest ever reaching the queue and no alert distinguishing it from a transient DB hiccup.

### Pitfall 2: One ticket can produce more than one queue entry

**What goes wrong:** An event whose registration flow lets a guest select more than one session (`ticketing_orderdetail.registered_session` holding 2+ codes) causes `create_attendance_and_notify()` to create one `Attendance` row per session for the same ticket [VERIFIED: `event_manager/services/registration.py:196-239` — `for session in sessions: Attendance.objects.get_or_create(ticket=ticket, session=session, ...)`]. A bare `INNER JOIN` on `attendance.ticket_id = ticket.id` then returns one row per attendance, i.e. duplicate guest entries for the same person in the booth queue.
**Why it happens:** The unique constraint on `Attendance` is `(ticket, session)`, not `ticket` alone [VERIFIED: `event_manager/models.py:719-726` — `constraints = [models.UniqueConstraint(fields=["ticket", "session"], name="unique_attendance")]`], and `Attendance.ticket` is a plain `ForeignKey`, not a `OneToOneField` [VERIFIED: `event_manager/models.py:679-684`]. This is by design — the event platform supports multi-session events. The current live event happens not to use that feature (all 27 `ticketing_orderdetail.registered_session` values are the single-element array `["default_pubstomp"]` [VERIFIED: live query, `ets_web` DB, 2026-08-11]), which is why today's data shows a clean 1:1 (measured: 0 tickets with >1 attendance row, `SELECT ticket_id, COUNT(*) FROM event_manager_attendance GROUP BY ticket_id HAVING COUNT(*) > 1` returned zero rows [VERIFIED: live query, 2026-08-11]).
**How to avoid:** Deduplicate in the VIEW — pick exactly one attendance row per ticket (earliest `created_at`, matching D-01's intent), via `ROW_NUMBER() OVER (PARTITION BY t.id ORDER BY a.created_at)` or an equivalent correlated-subquery `MIN(a.created_at)` join. Do not rely on "this event only uses one session" as a permanent property — it is event configuration, not a database guarantee, and this VIEW has no way to know if a future event (reusing this same integration) changes that.
**Warning signs:** A guest sees more than one queue position for themselves, or the booth calls the same name twice in one event.

### Pitfall 3: A confirmed ticket with zero attendance rows (miss, not duplicate)

**What goes wrong:** `RegistrationService.register_ticket_to_event()` sets `ticket.status = TicketStatus.VALID` and calls `ticket.save()` [VERIFIED: `event_manager/services/registration.py:274-276`] **before** calling `create_attendance_and_notify()` [line 296] — and that call is outside `register_ticket_to_event`'s own scope (no `@transaction.atomic` wraps the whole function; only `create_attendance_and_notify` itself is decorated, at line 180). If the event has no `default_session` and none of `order_detail.registered_session`'s codes resolve to a real `Session`, `create_attendance_and_notify` raises `RegistrationError("No session configured...")` at line 222 — after the ticket's VALID status was already committed at line 276, and *before* any write happens inside `create_attendance_and_notify`'s own atomic block, so there is nothing for that nested transaction to roll back. The exception propagates to `bulk_register_tickets`'s per-ticket `try/except RegistrationError` [line 344], which logs it into `results["failed"]` and continues — it does not re-raise, so `_process_free_order`'s outer `transaction.atomic()` [`payment.py:152`] sees no exception and commits normally, VALID status included.
**Why it happens:** A code path where ticket-status and attendance-creation are not one atomic unit, combined with the outer caller swallowing the exception per-ticket rather than aborting the whole order.
**How to avoid:** This is a miss (guest silently excluded from the VIEW, since there's no attendance row to JOIN on), not a duplicate — lower severity than Pitfall 2, and only reachable if an event is misconfigured (no default session, and registration didn't supply a valid session code). Given this event's `registered_session` is always populated with a resolvable code (`default_pubstomp`, confirmed to exist as one of the 3 live `event_manager_session` rows — `session_count = 3` [VERIFIED: live query]), this path is not currently active, but it is a genuine gap in `ets_web`, not something the VIEW can compensate for (the VIEW can only see what has an attendance row — it cannot detect "should have one but doesn't"). Document as an operational note in the runbook: if a guest reports registering but never reaching the queue, check whether their ticket is VALID with zero attendance rows before assuming an ingestion bug.
**Warning signs:** A ticket with `status='valid'` and no corresponding `event_manager_attendance` row.

### Pitfall 4: `GRANT` scoped to the wrong object type after DROP+CREATE VIEW

**What goes wrong:** MySQL privileges are recorded against a `db.object_name` pair, not against "table" or "view" as a type distinction — a pre-existing `GRANT SELECT ON photobooth.registrations TO 'extension_service_ro'@...` (if one already exists from the table era) continues to apply unchanged after the same-named object becomes a VIEW [CITED: MySQL 8.0 Reference Manual, GRANT syntax — privileges are per schema-qualified object name]. Assuming a *new* grant is always required (and, worse, granting broadly "just to be safe") can create an unintentionally wider privilege than existed before.
**Why it happens:** It's easy to assume DROP + CREATE implies a clean privilege slate; it doesn't, for same-named objects.
**How to avoid:** Before the DROP, run `SHOW GRANTS FOR 'extension_service_ro'@...` (or the account's real name — the STATE.md description says it defaults to `extension_service_ro` per `config.ts:90`, unverified in this session since `mirror-request/.env` is unreadable) and record exactly what it already has on `photobooth.*`. After CREATE VIEW, re-run `SHOW GRANTS` and diff — the "one read-only GRANT" the human budgeted may already be satisfied by an existing grant, or may need exactly one new `GRANT SELECT ON photobooth.registrations TO ...` if the existing grant only covered `photobooth.registrations` when it was literally a base table and MySQL's ACL implementation for that specific account happens to differ (verify, don't assume, either way).
**Warning signs:** `Access denied for user 'extension_service_ro'@'...' to table 'photobooth.registrations'` after the cutover DDL runs, even though the account worked before.

## Code Examples

### VIEW health probe — distinguishing broken-VIEW from unreachable-DB

```typescript
// Source pattern: mirror-request/src/ingestion/dbPoller.ts's own doPoll()
// catch block (D-05: warn-and-retry, never crash) + notificationService.ts's
// fetch pattern for the alert. Reuses the SAME pool dbPoller.ts already owns
// — no second mysql2 pool should be created for the probe.
async function probeViewHealth(pool: any, alert: (msg: string) => Promise<void>): Promise<void> {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query('SELECT id FROM registrations LIMIT 1');
    // healthy — no log noise on the success path, matching this
    // project's existing convention of logging only state changes/failures
  } catch (err: any) {
    const code = err?.code as string | undefined;
    const isViewBroken = code === 'ER_VIEW_INVALID'; // errno 1356
    if (isViewBroken) {
      opsLogger.error(`Registrations VIEW is broken: ${err.message}`);
      await alert(`photobooth.registrations VIEW is broken: ${err.message}`);
    } else {
      // Connection-class failure (ECONNREFUSED, PROTOCOL_CONNECTION_LOST,
      // ETIMEDOUT, ER_ACCESS_DENIED_ERROR, ...) — this is Phase 1's D-05
      // case, not a broken VIEW. Warn only, matching dbPoller.ts's own
      // doPoll() catch block; do not alert on a transient DB hiccup.
      opsLogger.warn(`VIEW health probe: DB unreachable (${code ?? 'unknown'}), will retry`);
    }
  } finally {
    conn?.release();
  }
}
```
`err.code`/`err.errno` on a thrown `mysql2` error mirroring the underlying MySQL server error code/name is documented driver behavior [CITED: mysql2/mysql npm driver error-object shape, `Error.code` as the `ER_*` symbolic name and `Error.errno` as the numeric code — this is the same mechanism `dbPoller.ts`'s existing `catch (err) { const message = err instanceof Error ? err.message : String(err); }` pattern already relies on for `.message`, just reading `.code` alongside it].

### Rollback capture, before the DROP

```sql
-- Run once, by hand, before DROP TABLE. Save the full output verbatim.
SHOW CREATE TABLE photobooth.registrations;
```
Store the output as `mirror-request/data/backups/photobooth-registrations-rollback-<timestamp>.sql`, formatted as a directly-runnable restore script:
```sql
DROP VIEW IF EXISTS photobooth.registrations;
CREATE TABLE photobooth.registrations ( /* paste SHOW CREATE TABLE output here */ );
```
This mirrors the project's existing backup-before-mutation convention (`data/backups/extension-service.sqlite.<timestamp>.bak`, `data/backups/*.2026-08-10T11-12-38.bak` — both referenced in `STATE.md`'s Phase 2/4 history) rather than inventing a new one.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| nginx `mirror` of `POST /api/v1/public/register/{event_code}/{slug}` | Cross-database read-only VIEW | Rejected during 06-CONTEXT.md discussion, 2026-08-11 | `mirror` duplicates the request, but `ticket_code`/`qrcode_url` exist only in the response; the mirrored request also fires before the response decides success/failure, so failed and `payment_required` registrations would have reached the booth. A VIEW satisfies "no code change" (it's DDL, not application code) while structurally excluding invalid registrations. |
| `ticketing_order.created_at` as the timestamp source (implicit, never actually shipped) | `event_manager_attendance.created_at` (D-01) | Decided in 06-CONTEXT.md before this research | Order-level timestamp ties across multi-ticket orders to the microsecond; attendance-level timestamp does not (on current data) — see Pitfall 2 for why "does not tie" still needs an explicit dedup guarantee, not just an assumption it holds. |

**Deprecated/outdated:** The `nginx mirror` design (`WINDOWS.md`/STATE.md's "Roadmap Evolution" note) is fully superseded — no nginx `mirror` directive exists anywhere on this host [CITED: STATE.md Phase 6 row, "no nginx mirror directive anywhere on this host"], and this research found nothing to contradict that.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `extension_service_ro` is the actual production account name for the poller's DB user (not just `config.ts`'s fallback default) | Pitfall 4, Standard Stack | If wrong, the `SHOW GRANTS FOR` / `GRANT` statements in the plan target the wrong principal; low risk since the executor will read the real env value at execution time (this research could not — `.env` access denied), and the plan should treat the account name as a value to confirm, not assume, before running any GRANT. |
| A2 | `CAST(datetime(6) AS CHAR)` does or does not zero-pad microseconds to 6 digits | Alternatives Considered, Pitfall 1 | If `CAST` actually does zero-pad correctly, this is a non-issue either way since the recommendation is `DATE_FORMAT` regardless (provably correct by contract) — risk is only that the plan might waste effort avoiding a non-problem. If `DATE_FORMAT` is used as recommended, this assumption is moot. |
| A3 | The VIEW's `ROW_NUMBER() OVER (PARTITION BY t.id ORDER BY a.created_at ASC, a.id ASC)` tiebreak on `a.id` is a reasonable secondary sort for the (currently unobserved) case of two attendance rows for the same ticket with identical `created_at` | Pattern 1 code example | Very low risk — any deterministic secondary sort works for the dedup purpose (only "pick exactly one, consistently" matters, not which one), and this scenario has never been observed in live data. |
| A4 | `photobooth.registrations`'s current column widths for `name`/`email`/`phone`/`mode` (beyond the given `id varchar(255)`) are wide enough for `ets_web`'s corresponding source column widths | Standard Stack, Runtime State Inventory | If a source value is truncated silently by an `INSERT`-style width mismatch this wouldn't even apply (it's a VIEW, not a copy — MySQL doesn't truncate VIEW output to a *target* table's width, since there's no target table once it's a VIEW) — so this is actually a non-issue for a VIEW specifically, downgraded from a real risk to a documentation note. Flagged only because this research could not independently run `SHOW CREATE TABLE registrations` against `photobooth` (access denied) to confirm the widths CONTEXT.md quotes. |

**If this table is empty:** N/A — see rows above.

## Open Questions

1. **What is the real production DB account name, and what grants does it already hold on `photobooth.*`?**
   - What we know: `config.ts:90` defaults to `extension_service_ro` if `DB_USER` is unset; `STATE.md` independently describes "the service's DB user" without naming it either.
   - What's unclear: the actual configured value, and its current `SHOW GRANTS` output — both require reading `mirror-request/.env`, which this research's sandbox denies.
   - Recommendation: the plan's first execution step against the live DB should be `SHOW GRANTS FOR '<account>'@'<host>';` (read-only, safe), which resolves this immediately and cheaply — no need to block planning on it, since the plan can express the GRANT/rollback steps parametrically ("the account named in `DB_USER`").

2. **Does `CAST(datetime(6) AS CHAR)` in MySQL 8.0.46 zero-pad to 6 fractional digits, or trim trailing zeros?**
   - What we know: `DATE_FORMAT(..., '%f')` is documented to always emit 6 digits.
   - What's unclear: `CAST`'s exact behavior — this research could not run DDL/DML to test it (write-forbidden).
   - Recommendation: moot if the plan follows this research's recommendation to use `DATE_FORMAT` rather than `CAST`; if the plan chooses `CAST` anyway, verify with a throwaway `SELECT CAST(created_at AS CHAR) FROM event_manager_attendance LIMIT 1` (read-only, safe) before committing to it in the VIEW.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| MySQL server | VIEW, GRANT, health probe | ✓ | `8.0.46-0ubuntu0.22.04.3` [VERIFIED: `mysql -e "SELECT VERSION()"`] | — |
| `mysql2` (npm) | Probe, poller (unchanged) | ✓ | `3.23.2` installed, `3.23.3` latest [VERIFIED: `npm view`, `node_modules/mysql2/package.json`] | — |
| `mysql` CLI | Manual DDL/GRANT execution, rollback capture | ✓ | `8.0.46-0ubuntu0.22.04.3` [VERIFIED: `mysql --version`] | — |
| Read access to `ets_web` DB (`ets_web` Django account) | This research session's verification queries | ✓ (via `.env` at `/opt/web-ticket/qrcode/.env`) | — | — |
| Read access to `mirror-request/.env` (poller's real `DB_USER`/`DB_PASSWORD`) | Confirming Open Question 1, and the account this phase's GRANT targets | ✗ — **[BLOCKED: no DB access]** `Bash` tool explicitly denied reading this file this session | — | Executor reads it directly at plan-execution time (it runs with different, presumably broader, sandbox permissions); plan should treat the account name as "read from env at execution time," not hard-code a guess. |
| Root/admin MySQL access (to inspect `photobooth.registrations`'s real `CREATE TABLE`, confirm current grants, or run the cutover DDL) | Rollback capture, GRANT execution, VIEW creation | ✗ — `mysql -u root` returns `Access denied`, no `sudo` password available in this sandbox | — | Whoever runs the actual migration (likely a human operator or a differently-privileged execution context) has this access; this research could only verify from the `ets_web` side, symmetric-checking that `photobooth` is equally invisible to `ets_web`'s account (confirmed: `ERROR 1044 Access denied for user 'ets_web'@'127.0.0.1' to database 'photobooth'`). |
| Node.js | Probe, rate limiter, all `mirror-request` code | ✓ | `v24.15.0` in this sandbox (project targets `20.x` per `package.json` `engines`) [VERIFIED: `node --version`] | Version mismatch between this sandbox (24.x) and the project's declared target (20.x) is a pre-existing condition, not something this phase introduces — worth flagging to the planner but out of this phase's scope to fix. |

**Missing dependencies with no fallback:** none — the two blocked items above (`mirror-request/.env`, root MySQL access) both have viable fallbacks at execution time, described in the table.

**Missing dependencies with fallback:** `mirror-request/.env` (executor reads it directly), root/admin MySQL access (executor/operator runs the DDL with appropriate credentials this research session does not hold).

## Validation Architecture

This phase's product is mostly DDL living in a database, not code in a repository — the Nyquist question ("how do you know it's true after you ship it, not just when you wrote it") has to be answered differently for each claim rather than uniformly. Overstating automatability here would be dishonest; several of this phase's most important claims are provably manual-only, and this section says so explicitly rather than inventing a fixture that doesn't reflect the real constraint (no write of any kind to `ets_web`, and no way to manufacture a "cancelled ticket with an attendance row" scenario in live data because that scenario cannot occur per Pitfall/Q3's finding — there is nothing to construct a regression test *against*).

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest `^2.1.4` (installed) [CITED: `mirror-request/package.json`] |
| Config file | none dedicated — `vitest run` uses defaults, matching every prior phase |
| Quick run command | `cd mirror-request && npx vitest run test/db-poller.test.ts` (extend this file, or add `test/view-health-probe.test.ts` alongside it, following its established `createRequire` + `vi.spyOn(mysql2Promise, ...)` mocking pattern [VERIFIED: `mirror-request/test/db-poller.test.ts:2-45`]) |
| Full suite command | `cd mirror-request && npm test` |

### Phase Requirements → Test Map

| Req ID / Claim | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| M6 criterion 3 (probe distinguishes broken VIEW from unreachable DB, D-09) | `probeViewHealth()` alerts on `err.code === 'ER_VIEW_INVALID'`, warns-only on connection-class codes | unit (mocked `mysql2` pool, same technique as `db-poller.test.ts`) | `npx vitest run test/view-health-probe.test.ts` | ❌ Wave 0 — new file |
| M6 criterion 3 (probe never blocks startup / never throws past its own boundary) | A probe failure of either kind returns normally, does not reject/throw out of `probeViewHealth()`, does not prevent `app.listen()`'s callback from completing | unit | same file as above | ❌ Wave 0 |
| M6 criterion 6 (`/status/:jobId` rate limited, D-10) | N+1th request within the window from one client gets throttled; the throttled response body/status is not distinguishable from a generic rate-limit response regardless of whether the id is real | integration (supertest against the real Express router, matching `test/status-api.test.ts`'s existing style) | `npx vitest run test/status-rate-limit.test.ts` | ❌ Wave 0 — new file |
| D-06 (cursor seeded to "now" before first boot) | `LocalStore.getCursor('registrations')` returns a value ≥ the cutover timestamp, not the `1970-01-01` default | unit, direct `LocalStore` call — no MySQL needed | `npx vitest run test/local-store-persistence.test.ts` (extend) | ✓ partial — file exists, add a case |
| D-04/D-05 name fallback chain | **Cannot be unit-tested against the real VIEW without a live `ets_web` connection.** The chain's *logic* (which rung fires for which input shape) is expressible and testable as a pure SQL `CASE`/`COALESCE` expression against a throwaway, disposable dataset — but that dataset must not be constructed inside anything named `ets_web` (the human's hard constraint forbids any write to `ets_web`'s data or schema, and a same-named throwaway schema would be indistinguishable from a violation in an audit). | **manual-only** | — | — |
| D-03 dedup (VIEW returns exactly one row per ticket) | The VIEW's row count for `valid`+`completed` tickets equals `COUNT(DISTINCT ticket.id)` for that same filter, not `COUNT(*)` of the unfiltered JOIN | **semi-automatable, but only against the live DB, read-only, once the VIEW exists** — this is a single comparative `SELECT`, safe to run repeatedly (`SELECT COUNT(*) FROM registrations` vs. the equivalent `COUNT(DISTINCT ...)` computed directly against `ets_web`), but it is not a CI regression test (no fixture stands in for `ets_web`) | manual/operational, run once at cutover and optionally on a schedule alongside the health probe | — | n/a |
| M6 criterion 1 (a real landing-page registration reaches the queue) | D-07: end-to-end proof via a real registration during cutover, explicitly not a replay | **manual-only, by design (D-07)** | — | — |
| M6 criterion 2 (cancelled/unpaid structurally excluded) | Already true of live data today (0/18 cancelled+temporary have attendance) and structurally true going forward per Q3's finding (no code path cancels a VALID+attended ticket) — this is a **source-code proof**, not a runtime test; re-verify only if `ets_web`'s cancellation code changes in a future upstream deploy (which is exactly what the health probe is *not* designed to catch — the probe detects schema breakage, not business-logic regressions in a codebase this project cannot modify or observe changes to) | manual (source read), already performed by this research | — | — |

### Sampling Rate

- **Per task commit:** `npx vitest run` on the specific new/changed test file (probe, rate limiter, cursor-seed).
- **Per wave merge:** `npm test` (full suite) — must stay green at whatever the baseline count is when this phase starts (last known: 31 files / 258 tests, per `STATE.md`'s Phase 5 close-out; confirm the live number at Wave 0 rather than trusting this stale figure).
- **Phase gate:** full suite green, **plus** the manual-only items above explicitly executed and their outcomes recorded (not silently skipped) — this phase cannot honestly reach `passed` without a human running the D-07 real-registration proof and the D-03 live dedup count check, mirroring how Phase 5 honestly returned `human_needed` rather than overclaiming `passed`.

### Wave 0 Gaps

- [ ] `test/view-health-probe.test.ts` — covers the D-09 probe's two-failure-mode branching, mocked `mysql2` pool per `db-poller.test.ts`'s established pattern
- [ ] `test/status-rate-limit.test.ts` — covers D-10's throttling and non-distinguishing-response behavior
- [ ] Extend `test/local-store-persistence.test.ts` — covers D-06's cursor-seed value landing correctly in SQLite
- [ ] No new framework install needed — vitest is already configured and green

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | Indirectly — `/status/:jobId`'s "id is the credential" design (D-06/D-10 of prior phases) is a capability-URL pattern, not classic authentication. This phase doesn't change the pattern, only mitigates its known entropy shortfall. | Rate limiting (this phase) as compensating control; the underlying fix (≥128-bit id) is out of this phase's scope (would require `ets_web` code changes, explicitly forbidden). |
| V3 Session Management | No | n/a |
| V4 Access Control | Yes — the VIEW's `WHERE` clause **is** the access-control boundary between "any registration attempt" and "the booth queue." | Omission-as-guarantee (VIEW JOIN/WHERE), consistent with this project's established pattern (Phases 2 and 4's SQL-structural guarantees, per `06-CONTEXT.md`'s Established Patterns section). |
| V5 Input Validation | Partially — `mode` is explicitly **never validated** anywhere in this codebase (D-08), by deliberate, documented design. This is a locked decision, not a gap this research should second-guess; noting it here only so the planner doesn't accidentally "fix" it by adding validation that contradicts D-08. | The VIEW itself is the sole guarantee that `mode` is a value dslrBooth accepts (`'print'`, literal, not sourced from `ets_web` at all). |
| V6 Cryptography | Indirectly — `ticket_code`'s CSPRNG generation (`secrets.choice`) is `ets_web`'s existing, unmodified code; this phase neither touches nor needs to touch it. | n/a — out of scope, already implemented upstream. |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|----------------------|
| Brute-forcing `ticket_code` via `/status/:jobId` (40 bits of entropy, D-10's own framing) | Information Disclosure / Spoofing | Rate limiting (this phase). A 40-bit space is not brute-forceable in a single guess but is brute-forceable given enough unthrottled attempts — the limiter raises the cost, it does not close the gap outright (closing it requires a wider id, out of scope per D-08's Agent-config-UI-deferred framing and the "no `ets_web` code change" constraint). |
| A distinguishable throttled response leaking "this id exists vs. doesn't" | Information Disclosure | The rate-limit response (429, or whatever status is chosen) must be identical in shape whether or not the underlying jobId is real — mirror `statusRoute.ts`'s existing `genericNotFound()` discipline: one response shape, no `reason`/`hint` field, applied *before* the existing 404 lookup runs (rate-limit check must gate ahead of the `store.getJob()` call, not after, or a timing side-channel appears: a limited request for a real id vs. a limited request for a fake id could differ in response latency if the real-id path does more work before hitting the limiter). |
| An upstream `ets_web` migration silently breaks the VIEW mid-event | Denial of Service (partial — ingestion only) | D-09's health probe + alert, never-block. This is the phase's own success criterion 5/6; not a new threat this research is introducing, just confirming the mitigation design is sound (probe distinguishes failure classes correctly per the code example above). |
| `extension_service_ro` granted broader `ets_web` access than the VIEW needs | Elevation of Privilege (lateral, if the service account is ever compromised) | `SQL SECURITY DEFINER` + narrow per-table grants on the definer account (not `extension_service_ro` itself, which under DEFINER security needs no `ets_web` grants at all) — see Architecture Patterns' Alternatives Considered row. |

## Sources

### Primary (HIGH confidence)

- `/opt/web-ticket/qrcode/ets_web/apps/event_manager/models.py:665-726` — `Attendance` model, unique constraint, `ForeignKey` (not `OneToOne`) on `ticket`
- `/opt/web-ticket/qrcode/ets_web/apps/event_manager/services/registration.py:179-317` — `create_attendance_and_notify()`, `register_ticket_to_event()`, the non-atomic status-then-attendance ordering
- `/opt/web-ticket/qrcode/ets_web/apps/event_manager/functions.py:220-241` — `sessions_register()`, a second attendance-per-session creation path
- `/opt/web-ticket/qrcode/ets_web/apps/ticketing/models.py:155-259` — `Order.cancel_order()`, PENDING-only guard
- `/opt/web-ticket/qrcode/ets_web/apps/ticketing/signals.py:190-238` — order-status-change signal handler, ticket status transitions
- `/opt/web-ticket/qrcode/ets_web/apps/ticketing/services/order_admin.py:780-833` — `cancel_event_order()`, `complete_event_order()`, both delegate to `cancel_order()`/`bulk_register_tickets()`
- `/opt/web-ticket/qrcode/ets_web/apps/ticketing/admin.py:794-836` — admin cancel action, also PENDING-only
- `/opt/web-ticket/qrcode/ets_web/apps/ticketing/choices.py:29-48` — `OrderStatus`/`TicketStatus` enum values (verbatim: `PENDING`/`COMPLETED`/`CANCELLED`/`RETURNED` for orders; `TEMPORARY`/`VALID`/`CANCELLED` for tickets)
- Live MySQL queries against `ets_web` (this session, 2026-08-11): `event_manager_session` count (3), `event_manager_attendance` per-ticket duplicate check (0 found), `ticketing_orderdetail.registered_session` distribution (27/27 single-session), millisecond-truncation distinctness of the 9 attendance timestamps, MySQL version (`8.0.46`), `SHOW GRANTS` for the `ets_web` account, symmetric-deny confirmation (`ets_web` account denied `photobooth`)
- `mirror-request/src/ingestion/dbPoller.ts`, `mirror-request/src/state/localStore.ts`, `mirror-request/src/notifications/notificationService.ts`, `mirror-request/src/security/ipAllowlist.ts`, `mirror-request/src/status/statusRoute.ts`, `mirror-request/src/index.ts`, `mirror-request/src/config.ts`, `mirror-request/test/db-poller.test.ts`, `mirror-request/package.json` — all read directly this session

### Secondary (MEDIUM confidence)

- [MySQL 8.0 Reference Manual — CREATE VIEW Statement](https://dev.mysql.com/doc/refman/8.0/en/create-view.html) — SQL SECURITY DEFINER/INVOKER semantics
- [MySQL 8.0 Reference Manual — Stored Object Access Control](https://dev.mysql.com/doc/refman/8.0/en/stored-objects-security.html) — definer vs. invoker privilege context
- [MySQL 8.0 Reference Manual — CHECK TABLE Statement](https://dev.mysql.com/doc/refman/8.0/en/check-table.html) — CHECK TABLE's support for views, corrupt-view reporting
- [MySQL Error 1356 / ER_VIEW_INVALID references](https://www.getgalaxy.io/learn/common-errors/mysql-error-1356-er-view-invalid---how-to-fix-and-prevent) — error trigger conditions and message shape
- `better-sqlite3` GitHub issue #907/#741 — parameter type restriction (numbers/strings/bigints/buffers/null only, class instances rejected)
- `mysql2` documented default DATETIME→JS Date decoding and the `dateStrings` option to override it

### Tertiary (LOW confidence)

- General knowledge of `mysql2`/MySQL error-object `.code`/`.errno` shape (`ER_VIEW_INVALID`, `PROTOCOL_CONNECTION_LOST`, `ECONNREFUSED`, `ETIMEDOUT`, `ER_ACCESS_DENIED_ERROR`) — consistent with training knowledge and with `dbPoller.ts`'s own existing `.message`-reading pattern, but not independently executed against a live broken VIEW in this session (DDL is write-forbidden during research).
- `CAST(datetime(6) AS CHAR)` zero-padding behavior — flagged as an open question (see Open Questions #2) rather than asserted; `DATE_FORMAT` is recommended instead specifically because it does not require trusting this unverified claim.

## Metadata

**Confidence breakdown:**
- Primary D-03 questions (dup risk, miss risk, cancel-retention): HIGH — every claim traced to a specific file/line in `ets_web` source, cross-checked against live data
- mysql2/better-sqlite3 type hazard (Pitfall 1): HIGH — verified from this project's own source plus documented driver behavior on both sides of the boundary
- Cross-database VIEW/GRANT mechanics: MEDIUM — sourced from official MySQL docs, but the exact DDL was never executed (write-forbidden), so exact behavior (e.g. `CAST` zero-padding) carries residual uncertainty flagged explicitly
- Rate limiter recommendation: LOW/discretionary — no precedent in this codebase for rate limiting specifically; recommendation is a style-consistency argument, not a verified fact

**Research date:** 2026-08-11
**Valid until:** 30 days for the MySQL/driver mechanics (stable); re-verify the `ets_web` source findings (Q1-Q3) if `ets_web` receives any deploy before this phase executes, since those are the parts of this research most exposed to upstream code changing under it.
