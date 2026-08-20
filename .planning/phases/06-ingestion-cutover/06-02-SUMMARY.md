---
phase: 06-ingestion-cutover
plan: 02
subsystem: database
tags: [mysql, mysql2, health-check, alerting, vitest, ops]

# Dependency graph
requires:
  - phase: 06-ingestion-cutover
    provides: "registrationsViewSql.ts's NAME_SOURCE_VALUES/NameSource type (plan 06-01) — the single declaration this plan's audit query and pure projection derive their vocabulary from"
provides:
  - "ViewHealthProbe (src/ops/viewHealthProbe.ts) — startup + periodic VIEW health probe distinguishing broken-VIEW error codes from connection-class codes, alerting through NOTIFY_WEBHOOK_URL, never blocking startup or the process (D-09)"
  - "nameSourceAudit.ts's pure nameSourceWarnings(rows) and NAME_AUDIT_CURSOR_KEY — D-05's exactly-once, restart-safe name-fallback warn, driven by the probe's cadence"
  - "VIEW_PROBE_INTERVAL_MS config key (default 60000ms), no production fail-fast, no enable/disable toggle"
  - "index.ts wiring: probe.start()/probe.stop() alongside poller.start()/poller.stop()"
affects: [06-03, 06-05, 06-06]

actuals:
  tokens: 9275
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "The probe owns its own connectionLimit:1 mysql2 pool rather than reusing DBPoller's — a named departure from RESEARCH's recommendation, forced by D-02 (dbPoller.ts closed to edits, DBPoller.pool is private)."
    - "D-05's warn lives on the probe's cadence, not at ingest — a sibling VIEW (registrations_name_audit, plan 06-01) plus a probe-driven audit query, since the fallback chain is computed in SQL and dbPoller.ts may not carry the log line."
    - "Test mocks that respect the bound SQL parameter (lexical WHERE registered_at > ? filter) rather than a dumb fixture that ignores it — needed to genuinely exercise the cursor-based exactly-once/restart-safety guarantee instead of assuming it."

key-files:
  created:
    - mirror-request/src/ops/viewHealthProbe.ts
    - mirror-request/src/ops/nameSourceAudit.ts
    - mirror-request/test/view-health-probe.test.ts
  modified:
    - mirror-request/src/config.ts
    - mirror-request/src/types.ts
    - mirror-request/src/index.ts

key-decisions:
  - "The probe creates its own mysql2 pool (connectionLimit: 1) rather than reusing DBPoller's — RESEARCH's 'reuse dbPoller's pool' recommendation is unreachable under D-02 (DBPoller.pool is private, created inside start(), and dbPoller.ts cannot be modified to add an accessor). Recorded as a departure per the plan's own <departures_from_research>, not an oversight."
  - "One query does double duty for the health check: SELECT COUNT(*) AS total, COUNT(DISTINCT registered_at) AS distinct_registered_at FROM registrations — proves the VIEW resolves AND detects the ordering backstop residual plan 06-01 recorded, in a single round trip."
  - "The audit runs on its own connection, acquired and released independently of the health-check connection, inside the connectionLimit:1 pool — sequential, never concurrent, so a single connection slot suffices."
  - "The audit's SELECT (id, name_source, registered_at) deliberately never fetches the resolved name column, even though it is available on the underlying VIEW — this is structural, not a redaction step a later edit could remove: the warn line cannot leak a name it never received."
  - "Cursor advance uses the last RETURNED row's registered_at (all rows, not only warned ones) so a first-rung (personalinfo_name) row is never re-examined — mirrors dbPoller.ts:130-133's own 'last fetched, not last acted-on' cursor discipline."

patterns-established:
  - "A probe-owned, injectable connectionLimit:1 pool as the sanctioned pattern for a second consumer of a VIEW dbPoller.ts already reads, when dbPoller.ts itself is closed to edits."

requirements-completed: [ING-02]

coverage:
  - id: D1
    description: "A VIEW broken by an upstream ets_web migration (ER_VIEW_INVALID or ER_NO_SUCH_USER) is detected within one probe interval and announced through NOTIFY_WEBHOOK_URL, while the service keeps serving — start() returns synchronously and no branch blocks startup or terminates the process."
    requirement: "ING-02"
    verification:
      - kind: unit
        ref: "test/view-health-probe.test.ts#ViewHealthProbe — two failure classes, one alert channel, never fatal > ER_VIEW_INVALID / ER_NO_SUCH_USER / start() returns synchronously / no branch throws out of start()"
        status: pass
    human_judgment: false
  - id: D2
    description: "A temporarily unreachable or refusing database (connection-class codes, and any unrecognised code) produces a warn and dispatches zero alerts — Phase 1's D-05 case never pages anyone."
    verification:
      - kind: unit
        ref: "test/view-health-probe.test.ts#ViewHealthProbe — two failure classes, one alert channel, never fatal > ECONNREFUSED / an unrecognised error code takes the warn-only branch"
        status: pass
    human_judgment: false
  - id: D3
    description: "The ordering backstop is made observable: the probe compares COUNT(*) against COUNT(DISTINCT registered_at) every cycle and alerts on inequality, naming both measured numbers."
    verification:
      - kind: unit
        ref: "test/view-health-probe.test.ts#ViewHealthProbe — two failure classes, one alert channel, never fatal > unequal counts: one error log and one alert naming both measured numbers"
        status: pass
    human_judgment: false
  - id: D4
    description: "Every registration whose name came from any rung past first_name/last_name produces exactly one warn naming the ticket code and the rung, once ever, surviving restart — the audit high-water mark is persisted through LocalStore.setCursor('name_audit', ...)."
    requirement: "ING-02"
    verification:
      - kind: unit
        ref: "test/view-health-probe.test.ts#nameSourceWarnings — pure D-05 projection (iterates NAME_SOURCE_VALUES) and #ViewHealthProbe — D-05 name-source audit, driven by the probe cadence (two consecutive cycles, restart-safety via a reopened SQLite file, cursor-fallback-from-registrations)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Neither the alert payload nor the D-05 warn line carries guest PII — the alert's key set is exactly {source, severity, message, timestamp} with no photoUrl key, and the warn line names only a ticket code and a rung."
    verification:
      - kind: unit
        ref: "test/view-health-probe.test.ts#the alert payload key set is exactly source, severity, message, timestamp / each emitted warn message names the ticket code and the rung, and contains neither an @ character nor the fixture's guest name"
        status: pass
    human_judgment: false

duration: 22min
completed: 2026-08-11
status: complete
---

# Phase 6 Plan 02: VIEW Health Probe and D-05 Name-Source Warn Summary

**A `connectionLimit:1` health probe that branches MySQL error codes into a broken-VIEW alert path and a connection-outage warn-only path, plus a probe-cadence-driven, cursor-persisted, exactly-once D-05 name-fallback warn — neither touching `dbPoller.ts`.**

## Performance

- **Duration:** ~22 min
- **Tasks:** 2/2 completed
- **Files modified:** 6 (3 created, 3 modified)
- **Commits:** 2 task commits

## Accomplishments

- `src/ops/viewHealthProbe.ts`'s `ViewHealthProbe` class mirrors `dbPoller.ts`'s `start()`/`stop()` lifecycle shape exactly (guard on `running`, pool creation degrading to a warn if `mysql2` is unavailable, interval scheduled on both the resolve and reject path of the first cycle) but deliberately owns its own `connectionLimit: 1` pool rather than reusing `DBPoller`'s — `DBPoller.pool` is private and D-02 forbids modifying `dbPoller.ts` to add an accessor.
- `runOnce()` branches `err.code`: `ER_VIEW_INVALID`/`ER_NO_SUCH_USER` (the VIEW itself is broken) log one `error` and dispatch exactly one alert through `NOTIFY_WEBHOOK_URL`; connection-class codes (`ECONNREFUSED`, `PROTOCOL_CONNECTION_LOST`, `ETIMEDOUT`, `ER_ACCESS_DENIED_ERROR`) and any unrecognised code warn only, dispatching zero alerts — Phase 1's D-05 lineage: a transient outage must never page anyone.
- A single query, `SELECT COUNT(*) AS total, COUNT(DISTINCT registered_at) AS distinct_registered_at FROM registrations`, both proves the VIEW resolves and makes plan 06-01's `ordering` backstop observable — an inequality logs one `error` and dispatches one alert naming both numbers.
- `start()` returns `void` synchronously — the first cycle is never awaited — so a broken VIEW can never block `app.listen()`'s callback or terminate the process (D-09), proven by a synchronous-marker test and a "no branch throws out of `start()`" test.
- `src/ops/nameSourceAudit.ts`'s pure `nameSourceWarnings(rows)` implements D-05's fall-through-to-warn projection: one warning per row whose `name_source` differs from `personalinfo_name`, free of logging/`LocalStore`/`mysql2` so it is testable with a literal array.
- `ViewHealthProbe.runNameAudit()` runs only after a healthy count-check cycle, in its own `try`/`catch` so an audit failure can never affect the health verdict. It reads the high-water mark from `store.getCursor('name_audit')`, falling back to the `'registrations'` ingestion cursor (D-06 lineage — keeps the nine pre-cutover rows out of the log) and then `'1970-01-01T00:00:00.000Z'`, queries `registrations_name_audit WHERE registered_at > ? ORDER BY registered_at ASC LIMIT 200`, emits one `opsLogger.warn` per fall-through in the shape `Guest name for ticket <code> came from <rung>, not first_name/last_name`, then advances the cursor to the last **returned** row's `registered_at` (all rows, not only warned ones).
- The alert payload is exactly `{ source: 'extension-service', severity: 'error', message, timestamp }` — no guest field, and deliberately no `photoUrl` key, so the shared `NOTIFY_WEBHOOK_URL` receiver cannot mistake an alert for a photo payload.
- `VIEW_PROBE_INTERVAL_MS` (default `60000`ms) was added to `EnvConfig`/`loadConfig()` with no production fail-fast check and no enable/disable toggle, matching `config.ts`'s own reasoning against "a supported way to switch off the only signal that ingestion is dead."
- Wired into `src/index.ts`: `probe.start()` runs immediately after `poller.start()` inside the `app.listen` callback; `probe.stop()` runs immediately after `poller.stop()` in `shutdown()`.
- `dbPoller.ts` and `localStore.ts` remain byte-identical to baseline `9699374` (D-02); `git diff --name-only 2163376..HEAD` lists exactly the 6 files this plan's `files_modified` frontmatter declared, no more, no fewer; `src/queue`, `src/agent`, `src/display`, `src/notifications` are untouched.

## Task Commits

Each task was committed atomically in `mirror-request`:

1. **Task 1: The probe — two failure classes, one alert channel, never fatal** — `69524d2` (feat)
2. **Task 2: D-05's warn — exactly once per guest, restart-safe, off the ingestion path** — `3b509cb` (feat)

_Note: both tasks carry `tdd="true"`. Both genuinely went RED first (the target module did not exist / the audit wiring did not exist) and GREEN on implementation, so no mutation-based non-vacuousness proof was required by the plan's own fallback clause — but one was performed anyway as a sanity check (see Deviations)._

## Files Created/Modified

- `mirror-request/src/ops/viewHealthProbe.ts` — `ViewHealthProbe`, `createViewHealthProbe`, `VIEW_BROKEN_ERROR_CODES`, `opsLogger` (Task 1), extended with `runNameAudit()` (Task 2).
- `mirror-request/src/ops/nameSourceAudit.ts` — `nameSourceWarnings()`, `NAME_AUDIT_CURSOR_KEY` (Task 2, new file).
- `mirror-request/src/config.ts` / `mirror-request/src/types.ts` — `VIEW_PROBE_INTERVAL_MS` key (Task 1).
- `mirror-request/src/index.ts` — `probe.start()`/`probe.stop()` wiring beside the poller (Task 1).
- `mirror-request/test/view-health-probe.test.ts` — 25 tests across two new describe blocks plus a pure-function block (Task 1: 12 tests; Task 2: +13 tests).

## Measured Numbers

- `cd mirror-request && npm test`: **33 files / 293 tests** green (baseline at plan start, confirmed live: 32 files / 268 tests, matching `06-01-SUMMARY.md`). +1 file (`test/view-health-probe.test.ts`), +25 tests. Run three times back-to-back with identical results.
- `npm run typecheck` / `npm run build`: both exit 0, both times (after Task 1 and after Task 2).
- `git diff --quiet 9699374 -- src/ingestion/dbPoller.ts`: exits 0 (D-02, byte-identical).
- `git diff --quiet 9699374 -- src/state/localStore.ts`: exits 0 (byte-identical).
- `git diff --name-only 9699374..HEAD -- src/queue src/agent src/display src/notifications`: empty (phase boundary held).
- `git diff --name-only 2163376..HEAD`: exactly the 6 files this plan's frontmatter declares.
- No new entry in `package.json` `dependencies` or `devDependencies`.
- No `INSERT`/`UPDATE`/`DELETE`/DDL statement issued against any database at any point — this plan is entirely local TypeScript/test work; the only database credentials read (`/opt/web-ticket/qrcode/.env`) were used in the environment-setup step at session start and never for a live query, since this plan's `<verify>` steps are unit tests against a mocked `mysql2` pool, not a live-MySQL harness.

## Decisions Made

- The probe's `connectionLimit: 1` own-pool design (departure from RESEARCH, forced by D-02) — recorded in the plan itself, confirmed as implemented exactly as specified.
- One query serving both the VIEW-resolves check and the ordering-backstop check, rather than two round trips — reduces load on the single-connection pool and keeps the health verdict and the ordering alert on the same cadence.
- The audit's SELECT never fetches the resolved `name` column even though it exists on the underlying VIEW — a structural guarantee against a future edit widening the warn line to include it, not a runtime redaction step.
- Cursor advances on all returned rows (not only warned ones) so a `personalinfo_name` row is never re-examined — mirrors `dbPoller.ts`'s own "last fetched, not last acted-on" cursor discipline exactly.
- Alert payload naming: `source: 'extension-service'` (not `'view-health-probe'` or similar) — matches the constant string this project's other alerting surfaces would use for the whole service, keeping the receiver's `source` field meaningful as "which process sent this," not "which internal module."

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Two Task-1 tests were vacuously passing (`runOnce()` called without `start()`)**
- **Found during:** Task 2, while wiring `runNameAudit()` into `runOnce()` and re-running the full test file.
- **Issue:** `runOnce()` is a no-op until `this.pool` exists, which only `start()` creates. Two Task-1 tests (`runOnce() resolves (never rejects) for every failure class`, `runOnce() resolves even when the injected alert itself rejects`) called `probe.runOnce()` directly without ever calling `probe.start()`, so `this.pool` was `null` and `runOnce()` returned immediately without exercising any of the branches under test — both tests passed trivially regardless of the code under test.
- **Fix:** Both tests now call `probe.start()` first (synchronously creating the pool) before driving explicit `runOnce()` calls, with a `setImmediate` flush where a detached first cycle needed to fully settle before the test's own controlled calls began (to avoid a race between the two).
- **Files modified:** `mirror-request/test/view-health-probe.test.ts`
- **Verification:** Both tests now genuinely exercise the branches; confirmed by the mutation check below.
- **Committed in:** `3b509cb` (Task 2 commit)

**2. [Rule 1 - Bug] Two Task-1 success-path tests were polluted once the audit was wired in**
- **Found during:** Task 2, first test run after wiring `runNameAudit()` into `runOnce()`.
- **Issue:** The "unequal counts" and "healthy cycle (equal counts)" tests used a blanket `queryMock.mockResolvedValue(...)` that, once the audit query started sharing the same mock, also answered the audit's `SELECT id, name_source, registered_at ...` with a `{total, distinct_registered_at}`-shaped row. That row has no `name_source`, so `nameSourceWarnings()` treated `undefined !== 'personalinfo_name'` as true and emitted a warning for a ticket code of `undefined`; the subsequent `store.setCursor(NAME_AUDIT_CURSOR_KEY, undefined)` call also failed, producing a second, unrelated warn. The "healthy cycle" test's `expect(warnSpy).toHaveBeenCalledTimes(0)` assertion caught this.
- **Fix:** Added a `healthyQueryImpl()` helper that branches the mocked `conn.query()` response on the SQL text (`registrations_name_audit` vs. the count query), so the audit call receives an empty row set independently of the health-check call's configured response — mirroring production, where these are two different SELECT statements against two different VIEWs.
- **Files modified:** `mirror-request/test/view-health-probe.test.ts`
- **Verification:** All 25 tests pass; the healthy-cycle test's zero-calls assertion now holds for the right reason.
- **Committed in:** `3b509cb` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 1 — bugs in the test file discovered while wiring Task 2, not in the shipped production code from Task 1, which needed no changes).
**Impact on plan:** Both fixes are entirely within `test/view-health-probe.test.ts`, one of this plan's own declared `files_modified`. No scope creep; `src/ops/viewHealthProbe.ts`'s Task-1 production code was correct as originally written and needed no changes once these test-only defects were found.

## Non-Vacuousness Proof (mutation)

Although both tasks genuinely went RED before GREEN (the target modules/wiring did not exist prior to implementation, satisfying the plan's TDD gate without needing the mutation fallback), a mutation check was performed on `nameSourceWarnings()` as an extra sanity pass per this project's "prove tests are non-vacuous" house rule: inverting the filter condition (`!== 'personalinfo_name'` → `=== 'personalinfo_name'`) failed **8 of the 25** tests in `test/view-health-probe.test.ts` (both the pure-function block and the integration block that depends on it). Reverted before commit; `git diff` after revert showed no residual change.

## Issues Encountered

None beyond the two test-file deviations documented above, both found and fixed within Task 2's own commit before it landed.

## User Setup Required

None — no external service configuration required. `NOTIFY_WEBHOOK_URL` is already a Phase 4 config key; this plan adds no new environment variable requiring a value beyond `VIEW_PROBE_INTERVAL_MS`, which has a safe default (`60000`ms) and no production fail-fast.

## Next Phase Readiness

- **For plan 06-06's OPS-RUNBOOK.md §10:** the alert payload shape is `{ source: 'extension-service', severity: 'error', message: string, timestamp: ISO-8601 string }` (no guest field, no `photoUrl`); the D-05 warn line format is `Guest name for ticket <code> came from <rung>, not first_name/last_name`. Both are asserted verbatim by the test suite, not just documented in prose.
- **Latency to name:** D-05's warn appears within one `VIEW_PROBE_INTERVAL_MS` (default 60s) of the guest registering, not at the instant of ingest — per the plan's own `<departures_from_research>` note 3, this is the one honest difference from the locked decision's literal wording and should be named in the runbook.
- **For plan 06-05 (the live DDL cutover):** the probe and audit are both fully built and tested against a mocked `mysql2` pool; once the live VIEW and `registrations_name_audit` VIEW exist in production (plan 06-05), no further code change is needed here — `probe.start()` is already wired into `index.ts`'s `app.listen` callback.
- No blockers.

## Self-Check: PASSED

All 6 created/modified files confirmed present on disk; both task commit hashes (`69524d2`, `3b509cb`) confirmed present in `git log --oneline --all`.

---
*Phase: 06-ingestion-cutover*
*Completed: 2026-08-11*
