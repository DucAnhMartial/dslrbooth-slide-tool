---
phase: 04-guest-notification
plan: 03
subsystem: notifications
tags: [sqlite, better-sqlite3, vitest, persisted-queue, migration, proof-only]
provides:
  - Regression proof that notification_record's migration backfill is honest, idempotent, and additive-only (D-13)
  - Regression proof that the persisted-queue SQL contract (due-time gate, terminal-state lock, COALESCE photo-URL guard, claim lease) means what its comments claim (D-04, D-05)
affects: [04-guest-notification, 05-client-api-display-feed]
requirements: [NOT-02]
estimate:
  tokens: 52000
  tasks: 2
  confidence: low
actuals:
  tokens: 2814
  tasks: 2
  commits: 1
tech-stack:
  added: []
  patterns:
    - "Sanity-check a load-bearing test by temporarily deleting the SQL guard it claims to pin (COALESCE, ON CONFLICT...WHERE, migration backfill gate), confirming the test fails, then restoring the file unchanged before committing — done here for all three structural guarantees, not asserted on faith"
    - "Old-schema table constructed with a raw better-sqlite3 handle to exercise a migration's 'column actually added' gate, since bootstrap() gives any brand-new temp database the new columns directly (precedent: test/on-register-dedup.test.ts, reused verbatim in test/notification-sweeper-restart.test.ts by 04-01)"
key-files:
  created: []
  modified:
    - mirror-request/test/local-store-persistence.test.ts
key-decisions:
  - "Task 1 and Task 2 were committed as a single atomic commit rather than two: both tasks touch the same single file (test/local-store-persistence.test.ts) with no natural RED/GREEN boundary between them — production code (localStore.ts) needed zero changes, so there is no meaningful split point between 'proof of the migration' and 'proof of the queue SQL' beyond the two describe blocks already visible in the diff. This still satisfies the plan's binding acceptance criterion that every commit `git show --name-only --format=` lists only the test file and nothing else."
  - "Task 1's behavior section literally describes the same 'write via saveNotification(), then reopen' recipe that 04-01-SUMMARY.md's Deviation 1 already proved cannot exercise the backfill (bootstrap() gives a brand-new temp database the columns directly, so migrate()'s add-gate never fires). Followed the codebase's established raw-better-sqlite3-table precedent instead, exactly as the plan's own preexisting_state_you_should_know section instructed — not treated as a fresh deviation requiring escalation, since the plan text itself flagged this trap and named the fix."
  - "Test 4's 'delivered row left untouched' assertion uses toBeFalsy() rather than toBeUndefined() for lastError, because better-sqlite3 returns a SQL NULL as JS null, not undefined, and getNotification() passes that value through unmodified."
duration: ~12min
completed: 2026-08-10
status: complete
---

# Phase 4 Plan 3: Storage-Contract Regression Proof for the Persisted Notification Queue Summary

**Extended `test/local-store-persistence.test.ts` with two new describe blocks — 10 new test cases — that pin the notification storage layer's three silent failure modes at the SQL level, each one confirmed load-bearing by temporarily deleting its guard and watching the matching test go red before restoring the file.**

## Performance
- **Duration:** ~12 min
- **Tasks:** 2/2 completed
- **Files modified:** 1 (test only, no production code)

## Accomplishments

- **Migration honesty and idempotency (D-13, NOT-02):** four new cases construct a pre-Phase-4 `notification_record` table with a raw `better-sqlite3` handle (the codebase's established `on-register-dedup.test.ts` precedent, already reused by 04-01's `notification-sweeper-restart.test.ts`) and prove: (1) a pre-existing non-terminal row with no `photoUrl` is marked `failed` with a `lastError` matching `/photoUrl unavailable/` on the first reopen; (2) reopening the migrated database a third time is a strict no-op — status, `lastError`, and `attempts` are byte-for-byte identical to the state after the second open; (3) after two reopen cycles, `PRAGMA table_info(notification_record)` still lists all five original columns (`jobId`, `status`, `attempts`, `lastError`, `updatedAt`) alongside the two new ones (`photoUrl`, `dueAt`) — read through a throwaway `better-sqlite3` handle, not a new `LocalStore` method; (4) a pre-existing `delivered` row is left completely untouched by the backfill.
- **Persisted-queue SQL contract (D-04, D-05):** six new cases against a real temp-path `LocalStore` prove: (1) `getDueNotifications()`'s due-time predicate is a real gate, not decoration; (2) a repeat `enqueueNotification()` cannot re-arm a `delivered` row; (3) a repeat `enqueueNotification()` cannot re-arm a `failed` row (separate case from (2), per the plan's acceptance criterion); (4) a status-only `saveNotification()` write (no `photoUrl` supplied) leaves the persisted photo URL intact, both via `getNotification()` and via the row still surfacing correctly-populated from `getDueNotifications()`; (5) `claimNotification()` transitions a row exactly once per lease — the immediate second claim with the same `now` returns `false` — and the row becomes due again only once the lease has actually expired; (6) a row written with no `photoUrl` at all is never returned by `getDueNotifications()`.
- **All three structural guarantees independently confirmed load-bearing, not just asserted:** the `COALESCE(excluded.photoUrl, notification_record.photoUrl)` guard, the `ON CONFLICT ... WHERE status NOT IN ('delivered','failed')` predicate, and the migration's `notifColumnAdded` backfill gate were each temporarily deleted in `localStore.ts`, `npx vitest run test/local-store-persistence.test.ts` re-run, and the exact test named in the plan's `<threat_model>`/acceptance criteria observed to fail (photo-URL-preservation test, both D-05 terminal-state tests, and both migration idempotency/honesty tests respectively) — then `localStore.ts` was restored to its pre-experiment state with no residual diff (`git status --porcelain` clean before commit; only `test/local-store-persistence.test.ts` in the final commit).
- The 5 pre-existing cases in the file (webhook replay + poll cursor, including the singleton `getStore()` case) were not modified.

## Task Commits

Both tasks landed in a single atomic commit, since neither required a production-code change and both touch only the same test file with no meaningful RED/GREEN split between them (see Decisions & Deviations below).

1. **Tasks 1+2** — `dc19b94` `test(04-03): pin the notification storage contract's silent failure modes`

## Files Created/Modified

- `mirror-request/test/local-store-persistence.test.ts` — two new nested `describe` blocks added inside the existing top-level describe, reusing its `beforeEach`/`afterEach` temp-directory harness verbatim: `notification_record migration` (4 cases) and `persisted-queue SQL contract` (6 cases). `import Database from 'better-sqlite3'` added to the top-level imports for the raw-table construction and the throwaway `PRAGMA` introspection handle. No new `LocalStore` production methods were added; every case is written against `enqueueNotification()`, `saveNotification()`, `getNotification()`, `getDueNotifications()`, and `claimNotification()` as they stood after plan 04-02.

## Decisions & Deviations

### No production code changed — `src/state/localStore.ts` needed zero fixes

All 15 tests in the file (5 pre-existing + 10 new) passed on the first implementation attempt. `localStore.ts` was touched only transiently, three separate times, purely to prove each guarantee is genuinely load-bearing (see below) — each time the file was restored byte-for-byte from a pre-experiment backup before moving on, and the final `git status --porcelain` before committing shows only the test file changed. This satisfies the plan's binding per-commit acceptance criterion (`git show --name-only --format= <sha>` lists `test/local-store-persistence.test.ts` and nothing else) without needing the "one exception" carve-out the plan reserved for a genuine production fix.

### Deviation — Task 1's literal test-1 recipe does not exercise the migration (not a fresh discovery, plan already named the fix)

The plan's `<behavior>` for Task 1 Test 1 describes: "write a row through `saveNotification({ jobId, status: 'pending', attempts: 1 })` ... then `close()` and reopen the same path." Implemented literally this cannot exercise `migrate()`'s backfill at all — `bootstrap()` gives any brand-new temporary database the `photoUrl`/`dueAt` columns directly, so on "reopen" the `notifColumnAdded` gate never fires and the backfill never runs. This is exactly the trap 04-01-SUMMARY.md's Deviation 1 already documented, and the plan's own `<preexisting_state_you_should_know>` context explicitly named the fix in advance: build the old-schema table with a raw `better-sqlite3` handle first, following `test/on-register-dedup.test.ts`'s precedent (already reused by 04-01's `notification-sweeper-restart.test.ts`). Implemented that way from the start — a `createOldShapeTable()` helper local to the new `describe` block, used by all four migration cases. Not logged as a Rule 1/2/3 auto-fix against plan text, since the plan itself flagged the trap; recorded here for traceability.

### No guarantee proved unobservable through the existing `LocalStore` surface

Every case in both new describe blocks was written entirely against `enqueueNotification()`, `saveNotification()`, `getNotification()`, `getDueNotifications()`, and `claimNotification()`. The one raw-`better-sqlite3` read (Task 1 Test 3's `PRAGMA table_info`) is explicitly a test-only introspection concern per the plan's own instruction, not evidence that the production surface is missing something. No production method was added or considered necessary.

## Values plan 04-04 (or any later reader) may want to quote

- **Observed claim-lease timing used in Task 2 Test 4:** a 5000ms (`lease = 5000`) synthetic lease against `Date.now()`-based `now`/`now + lease` arguments — real wall-clock time was not consumed; `claimNotification()`'s SQL comparison is exercised purely through the `now`/`leaseUntil` arguments passed in, so the test runs in milliseconds regardless of the lease value chosen.
- **Honest-failure `lastError` regex used, per the plan's instruction to assert a fragment rather than the full string:** `/photoUrl unavailable/` (the full committed string, quoted from 04-01-SUMMARY.md, is `photoUrl unavailable — record predates persisted-queue migration`).
- **`getStore()` grep count confirmed unchanged at 4** (import, singleton-case title, its comment, its one call) — no case added by this plan touches the singleton.

## Verification

- `cd mirror-request && npx vitest run test/local-store-persistence.test.ts` — 15/15 passing (5 pre-existing unmodified + 10 new).
- **Load-bearing sanity check (not part of the committed suite, run manually against a scratch copy of `localStore.ts` and reverted before commit):** removing the `COALESCE` guard on `photoUrl`/`dueAt` failed exactly the photo-URL-preservation test (1 failure); removing the `ON CONFLICT ... WHERE status NOT IN ('delivered','failed')` predicate failed exactly the two D-05 terminal-row tests (2 failures); disabling the migration's `notifColumnAdded` backfill branch failed exactly the honest-terminal-state and idempotency tests (2 failures). All three confirmed the guard each test claims to pin is the guard actually protecting the behavior.
- `cd mirror-request && npm test` — 27 files / 182 tests green (172 pre-existing + 10 new), run 3 times back-to-back with identical results.
- `cd mirror-request && npm run typecheck` — clean.
- `cd mirror-request && npm run build` — clean.
- `cd mirror-request && git status --porcelain` — clean tree after the commit.
- `cd mirror-request && git show --name-only --format= dc19b94` — exactly `test/local-store-persistence.test.ts`, nothing else.
- `cd mirror-request && grep -c "getStore" test/local-store-persistence.test.ts` — `4`, unchanged from before this plan.
- Stale `mirror-request/.planning/` tree confirmed untouched — this plan's only file write was inside `mirror-request/test/`; no `gsd_run` state-mutating command was run from inside `mirror-request/`.

## Self-Check: PASSED

- FOUND: `mirror-request/test/local-store-persistence.test.ts` (modified, exists).
- FOUND: commit `dc19b94` in `git log --oneline --all`.

## Next Phase Readiness

Phase 4 (Guest Notification) is now fully covered by regression proof at both the delivery layer (04-01, 04-02) and the storage layer (04-03, this plan) — every SQL-level guarantee the phase's D-04/D-05/D-13 decisions depend on now has a test that fails if its clause is deleted, independently confirmed rather than assumed. Requirements NOT-01 and NOT-02 were both already `[x]` in REQUIREMENTS.md before this plan (marked complete by 04-01/04-02); this plan adds no new requirement completions, only regression coverage. No blockers. Plan 04-04 (per STATE.md's "4 plans, 3 waves" framing, wave 3/the phase gate) can proceed — this plan's `git diff --name-only 9b20d9e..HEAD -- src/` remains unchanged from 04-02's baseline, since no production file was touched.
