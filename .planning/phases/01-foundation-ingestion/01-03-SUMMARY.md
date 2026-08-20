---
phase: 01-foundation-ingestion
plan: 03
subsystem: ingestion
tags: [typescript, mysql2, vitest, db-polling, resilience, read-only]

# Dependency graph
requires:
  - phase: 01-foundation-ingestion (plan 01-01)
    provides: "Complete EnvConfig surface (DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD/DB_POLL_INTERVAL_MS/DB_POLL_BATCH_SIZE), DB_PORT default corrected 5432 -> 3306"
  - phase: 01-foundation-ingestion (plan 01-02)
    provides: "LocalStore constructor(dbPath?: string) test seam used to build a throwaway SQLite fixture for the mocked-pool test harness"
provides:
  - "DBPollerDbConfig interface + DBPoller constructor taking typed database config instead of reading process.env.DB_* directly"
  - "DB polling fallback that warns-and-retries on any failure (first-cycle or mid-cycle) instead of permanently disabling itself"
  - "D-04 reconciliation log for source rows already ingested via the webhook; D-06 audit-skip log for rows missing id/name, with cursor advancement preserved past both"
  - "test/db-poller.test.ts: mocked mysql2/promise pool test harness (require-cache-patch technique) reusable by any future DBPoller test work"
affects: []

# Actuals (#2632)
actuals:
  tokens: 4304
  tasks: 2
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Mocking a lazily-required CommonJS dependency (`require('mysql2/promise')` inside dbPoller.ts) under Vitest: vi.mock()/vi.doMock() do not intercept a runtime require() call for an externalized node_modules package (confirmed experimentally — a hoisted vi.mock still let a real DNS lookup through). Instead, grab the real, already-installed module object via `createRequire(import.meta.url)` and `vi.spyOn()` its export directly — Node's CJS loader shares one module-cache instance keyed by resolved path regardless of how require was obtained, so the production code's own require('mysql2/promise') call returns the same, now-spied, object."
    - "Failure-severity normalization: every branch in a best-effort background poller that can legitimately retry (or that has an equally-severe sibling branch) logs at warn, not error — reserving error severity for conditions the codebase treats as requiring escalation."

key-files:
  created:
    - mirror-request/test/db-poller.test.ts
  modified:
    - mirror-request/src/ingestion/dbPoller.ts
    - mirror-request/src/index.ts

key-decisions:
  - "The require-cache-patch mocking technique (vi.spyOn on the real mysql2/promise module object obtained via createRequire) was used instead of vi.mock/vi.doMock + dynamic import, after confirming experimentally that vi.mock does not intercept dbPoller.ts's runtime require() call (a real DNS lookup occurred against the mocked host in early attempts). This keeps dbPoller.ts's lazy require() exactly as the plan specified (missing driver still degrades to a log, never a crash) while giving the test full control over the pool."
  - "Task 1 was scoped strictly to the constructor/typed-config change, deliberately leaving the three error-level log branches and the initial-cycle failure handling untouched, per the plan's explicit instruction that task 2 step 2 normalizes severity in one pass — this avoided git history that mixed the config-typing change with the severity/resilience change in one commit."
  - "The D-08 default-interval test (loadConfig().DB_POLL_INTERVAL_MS === 3000) was added to db-poller.test.ts rather than config-validation.test.ts, matching the plan's task 2 <files> scope (dbPoller.ts + db-poller.test.ts only) even though it exercises config.ts rather than DBPoller itself — D-08 required no code change, only a confirming test."

patterns-established:
  - "createRequire(import.meta.url) + vi.spyOn() as the standard technique for mocking a lazily-`require()`'d CJS driver anywhere else in this codebase that follows the same 'require inside try, degrade to log on failure' pattern."

requirements-completed: [ING-02, ING-03, STO-01]

coverage:
  - id: D1
    description: "DBPoller reads no environment variable directly; constructing with an explicit DBPollerDbConfig and calling start() passes exactly those values to mysql.createPool"
    requirement: "ING-02"
    verification:
      - kind: unit
        ref: "test/db-poller.test.ts#constructing with explicit dbConfig and calling start() passes exactly those values to mysql.createPool"
        status: pass
      - kind: other
        ref: "grep -v '^\\s*[/*]' src/ingestion/dbPoller.ts | grep -c 'process.env' -> 0"
        status: pass
    human_judgment: false
  - id: D2
    description: "With user: '', start() logs a warning, creates no pool, and leaves the poller stopped"
    verification:
      - kind: unit
        ref: "test/db-poller.test.ts#with user: '', start() logs a warning, creates no pool, and leaves the poller stopped"
        status: pass
    human_judgment: false
  - id: D3
    description: "doPoll() issues a query whose SQL text begins with SELECT and contains no mutating keyword — the automated guard for the mirror-request/CLAUDE.md read-only hard rule"
    requirement: "ING-02"
    verification:
      - kind: unit
        ref: "test/db-poller.test.ts#doPoll issues a query whose SQL text begins with SELECT and contains no mutating keyword"
        status: pass
      - kind: other
        ref: "grep -v '^\\s*[/*]' src/ingestion/dbPoller.ts | grep -ciE '\\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\\b' -> 0"
        status: pass
    human_judgment: false
  - id: D4
    description: "A first-cycle database failure no longer disables polling; the interval is scheduled unconditionally and the next tick ingests normally (D-05)"
    requirement: "ING-03"
    verification:
      - kind: unit
        ref: "test/db-poller.test.ts#a first-cycle rejection still schedules the interval, and the next tick ingests successfully"
        status: pass
      - kind: other
        ref: "grep -v '^\\s*[/*]' src/ingestion/dbPoller.ts | grep -c 'this.running = false' -> 2 (stop() and the unrecoverable driver-load branch only)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Every failure branch in dbPoller.ts reports at warn severity; none log at error level any more (D-05, D-07)"
    verification:
      - kind: other
        ref: "grep -v '^\\s*[/*]' src/ingestion/dbPoller.ts | grep -c 'logger.error' -> 0; grep -c 'logger.warn' -> 5"
        status: pass
      - kind: unit
        ref: "test/db-poller.test.ts#a rejected query inside a cycle produces exactly one logger.warn call and no thrown rejection escaping doPoll()"
        status: pass
    human_judgment: false
  - id: D6
    description: "An already-processed source row produces one D-04 reconciliation logger.info line naming the id and triggers no persistence call"
    requirement: "STO-01"
    verification:
      - kind: unit
        ref: "test/db-poller.test.ts#an already-processed id produces one logger.info reconciliation line and no persistence call"
        status: pass
      - kind: other
        ref: "grep -c 'reconciled' src/ingestion/dbPoller.ts -> 1"
        status: pass
    human_judgment: false
  - id: D7
    description: "A source row missing id or name is D-06 audit-skipped with a warn log (presence indicator only, not the name) and the cursor still advances to the last fetched row"
    verification:
      - kind: unit
        ref: "test/db-poller.test.ts#a malformed row (missing id or name) is audit-skipped without persistence, and the cursor still advances"
        status: pass
      - kind: unit
        ref: "test/db-poller.test.ts#a batch of [malformed, good] leaves the cursor at the good row's registered_at (last fetched, not last ingested)"
        status: pass
      - kind: other
        ref: "grep -c 'skipped malformed source row' src/ingestion/dbPoller.ts -> 1"
        status: pass
    human_judgment: false
  - id: D8
    description: "No log line emitted by doPoll() contains the database password or an email address (T-01-18, T-01-19)"
    verification:
      - kind: unit
        ref: "test/db-poller.test.ts#no log line emitted by doPoll() contains the database password or an email address"
        status: pass
    human_judgment: false
  - id: D9
    description: "Poll interval comes from DB_POLL_INTERVAL_MS with a 3000ms default (D-08); no code change required"
    verification:
      - kind: unit
        ref: "test/db-poller.test.ts#D-08: DB_POLL_INTERVAL_MS defaults to 3000ms when unset"
        status: pass
    human_judgment: false
  - id: D10
    description: "Full existing Vitest suite (7 pre-existing files) does not regress alongside the extended db-poller.test.ts, and npm run typecheck passes"
    verification:
      - kind: integration
        ref: "npm test (9 files, 45 tests, all pass); npm run typecheck (exits 0)"
        status: pass
    human_judgment: false

duration: 10min
completed: 2026-08-10
status: complete
---

# Phase 1 Plan 3: Resilient, Observable DB Polling Fallback Summary

**DBPoller now takes typed database configuration instead of reading `process.env` directly, warns-and-retries on any connection or query failure instead of permanently disabling itself, and logs explicit D-04 reconciliation / D-06 audit-skip lines instead of silently `continue`-ing — proven by an 11-case mocked-`mysql2/promise` test suite that also asserts the poller never issues a mutating SQL statement.**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-08-10T08:12Z
- **Completed:** 2026-08-10T08:21Z
- **Tasks:** 2/2
- **Files modified:** 3 (2 modified, 1 created)

## Accomplishments

- Removed the second, drifting source of database configuration flagged in RESEARCH.md Pitfall 4: `DBPoller` now takes a typed `DBPollerDbConfig` constructor argument (`host`, `port`, `database`, `user`, `password`) instead of reading `process.env.DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD` inline. `index.ts` sources every value from the already-loaded `EnvConfig`, so `config.ts` is now the only place a `DB_*` default is expressed.
- A first-cycle database failure no longer sets `this.running = false` and stalls polling until a restart (D-05): the `setInterval` is now scheduled unconditionally after the initial `doPoll()` settles, whether that settle was success or failure, and only `stop()` plus the genuinely-unrecoverable driver-load branch (missing `mysql2` package) are allowed to clear `running`.
- Normalized every failure branch in `dbPoller.ts` to `warn` severity — the driver-load catch, the initial-cycle catch, and the `doPoll()` cycle catch all previously logged at `error`; none do now, matching D-05's stated posture that these are retryable, non-fatal conditions. Only `err.message` is ever logged, never the caught error object or `this.dbConfig`, so credentials cannot reach the log file (T-01-18).
- Replaced the silent `if (this.store.isProcessed(row.id)) continue;` with an explicit D-04 reconciliation `logger.info` line naming the id, and added a new D-06 audit-skip `logger.warn` branch (checked first, before the reconciliation check) for rows missing `id` or `name` — logging a presence indicator for `name`, never the name itself. Both guards `continue` before any persistence call, and cursor advancement (`records.at(-1).registered_at`) is untouched, so it still advances past skipped rows to the last *fetched* row, not the last *ingested* one.
- Built `test/db-poller.test.ts` (11 cases) around a mocked `mysql2/promise` pool. Discovered and worked around a real Vitest limitation: `vi.mock('mysql2/promise', ...)` does not intercept `dbPoller.ts`'s runtime `require('mysql2/promise')` call — confirmed by observing a genuine DNS lookup against the mocked hostname during early attempts. The working technique instead obtains the real, already-installed module object via `createRequire(import.meta.url)` and `vi.spyOn()`s its `createPool` export directly, relying on Node's CJS module cache being shared regardless of how `require` was obtained.

## Task Commits

1. **Task 1: DBPoller takes typed database configuration; mocked-pool test harness** - `3b9f593` (feat, tdd)
2. **Task 2: Four explicit poll-cycle branches — retry, reconcile, audit-skip, advance** - `80f99be` (feat, tdd)

_Note: each task's `tdd="true"` behavior was implemented and verified together with its tests in a single commit per task, following the same integration-test-alongside-implementation style established in 01-01/01-02, rather than separate RED/GREEN commits. Task 1 was deliberately scoped to exclude the severity-normalization and initial-cycle-retry changes (left for task 2 per the plan's explicit sequencing instruction), so the two commits cleanly separate "typed config" from "resilience/observability behavior."_

## Files Created/Modified

- `mirror-request/src/ingestion/dbPoller.ts` - `DBPollerDbConfig` interface, typed constructor, unconditional interval scheduling after the first cycle, all three failure branches normalized to `warn`, D-06 audit-skip + D-04 reconciliation log branches added to the per-row loop
- `mirror-request/src/index.ts` - `new DBPoller(...)` call site passes the fifth `dbConfig` argument sourced from `config.DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD`
- `mirror-request/test/db-poller.test.ts` - NEW: 11 cases across two `describe` blocks — 4 for typed-config/pool-lifecycle/SELECT-only (task 1), 7 for retry/reconcile/audit-skip/advance/credential-safety/D-08-default (task 2)

## Decisions Made

- Chose the `createRequire` + `vi.spyOn()` require-cache-patch technique over `vi.mock`/`vi.doMock` + dynamic import after confirming experimentally that the latter does not intercept `dbPoller.ts`'s lazy `require('mysql2/promise')` call (a real DNS lookup occurred in a minimal reproduction before this fix). This keeps `dbPoller.ts`'s production code exactly as the plan specified — no static import was substituted for the lazy `require()`, which stays needed so a missing `mysql2` package still degrades to a log instead of crashing.
- Task 1's commit deliberately left the three error-level log branches and the initial-cycle failure handling untouched, per the plan's explicit "task 2 step 2 normalizes every failure branch in the file in one pass" instruction — this produced two commits with clean, non-overlapping diffs instead of one commit mixing the config-typing change with the resilience change.
- The D-08 default-interval assertion was added to `test/db-poller.test.ts` (exercising `loadConfig()`) rather than `test/config-validation.test.ts`, to stay within task 2's declared `<files>` scope even though the code under test is `config.ts`, not `dbPoller.ts` — D-08 required no code change per the plan, only a confirming test.

## Deviations from Plan

None — plan executed exactly as written. All task-level `<acceptance_criteria>` (grep checks and behavior tests) and the plan's overall `<verification>` block (`npm test`, `npm run typecheck`, `grep -rn "process.env.DB_" src`) pass. The mocking-technique substitution described above stayed inside the plan's own guidance: task 1's `<action>` explicitly anticipated `vi.mock` alone might not intercept the CommonJS require path and named `vi.doMock` + dynamic import as the fallback; that fallback was itself found insufficient during implementation, and the require-cache-patch technique was used instead to achieve the same intercepted-mock outcome the plan asked for (a mocked pool, no live MySQL required) — no scope, contract, or file list changed as a result.

## Issues Encountered

None. `npm run typecheck` and `npm test` ran clean throughout this plan; no pre-existing blockers were carried into this plan's scope.

## Known Stubs

None.

## Threat Flags

None — all new surface (typed `DBPollerDbConfig`, the D-04/D-06 log branches, the retry-on-failure interval scheduling) matches the plan's `<threat_model>` register (T-01-15 through T-01-21); no new unplanned surface was introduced.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `mirror-request/src/ingestion/dbPoller.ts` and `mirror-request/src/index.ts` now present a fully typed-config, warn-and-retry, D-04/D-06-observable polling fallback for Phase 1's remaining plans to build on without further changes to this surface.
- The `createRequire` + `vi.spyOn()` mocking technique documented in `test/db-poller.test.ts`'s header comment is available for any future plan that needs to mock a lazily-`require()`'d CJS driver.
- This completes plan 3 of 5 for Phase 1; plans 01-04 and 01-05 remain (queue/booth-state work and the outstanding HMAC canonical-string confirmation against the real Mirror Request signer, per 01-01's `key-decisions`).
- No blockers for the phase gate from this plan's own work.

---
*Phase: 01-foundation-ingestion*
*Completed: 2026-08-10*

## Self-Check: PASSED

All 3 created/modified source and test files found on disk (`src/ingestion/dbPoller.ts`, `src/index.ts`, `test/db-poller.test.ts`). Both task commits (`3b9f593`, `80f99be`) found in `git log`. SUMMARY.md itself confirmed present at its expected path.
