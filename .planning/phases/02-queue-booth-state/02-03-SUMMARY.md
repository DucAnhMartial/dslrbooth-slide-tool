---
phase: 02-queue-booth-state
plan: 03
subsystem: queue
tags: [sqlite, better-sqlite3, winston, fifo, idempotency, ops-docs]

# Dependency graph
requires:
  - phase: 02-queue-booth-state
    plan: 02-01
    provides: LocalStore.requeueWithRetry()/failJob()/getInFlightJobs(), QueueService.recover()/handleStall(), queueLogger masked pipeline
provides:
  - "LocalStore.enqueueJob() FIFO position log line — the single choke point both ingestion paths already share"
  - "test/queue-fifo-retry.test.ts — D-06's queued_at-preservation guarantee asserted against real SQL"
  - "test/queue-idempotency.test.ts — D-12's one-registration-one-job guarantee asserted across the retry and terminal-failure paths"
  - "docs/OPS-RUNBOOK.md §5/§6 — the booth state machine transition table and the stuck-job operator procedure"
affects: [02-04-config-countdown]

# Actuals (#2632)
actuals:
  tokens: 21500
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "enqueueJob() captures the prepared statement's RunResult.changes to distinguish a real insert from an INSERT OR IGNORE no-op, without adding any new dedup logic (D-11) — the changes===0 branch is an observation of the existing guarantee, not a second mechanism"
    - "Per-file temp-database test harness (fs.mkdtempSync + new LocalStore(dbPath) + store.close()/fs.rmSync) reused for both new test files, matching test/db-poller.test.ts and test/queue-recovery.test.ts — never getStore()"

key-files:
  created:
    - mirror-request/test/queue-fifo-retry.test.ts
    - mirror-request/test/queue-idempotency.test.ts
  modified:
    - mirror-request/src/state/localStore.ts
    - mirror-request/docs/OPS-RUNBOOK.md

key-decisions:
  - "The FIFO position log line lives inside LocalStore.enqueueJob(), not in mirrorReceiver.ts or dbPoller.ts — one change covers both ingestion paths and Phase 1's files stay untouched, as the plan required."
  - "The log message is the single literal string `Queued job ${j.id} at position ${pos} of ${len}` with no extra printf arguments, so mask()'s string-only masking path (test/logging-mask.test.ts) applies to it."
  - "Task 2 added zero production code, per D-11: QUE-02 is already satisfied structurally by enqueueJob's INSERT OR IGNORE and Phase 1's processed_id table; the new test file is the end-to-end proof D-12 owed that the retry path cannot create a second row."
  - "Both new test files use randomUUID() with digit runs broken up (the same safeId() pattern test/logging-mask.test.ts already established) to avoid mask()'s pre-existing, already-flagged PHONE_RE false positive on ids with a chance 7+-digit run — not a new masking concern, just avoiding an unrelated flaky assertion."
  - "OPS-RUNBOOK.md §5's transition table lists all 9 legal transitions the code implements after plans 02-01/02-02, including the 3 that fire only at startup recovery, and calls out that BoothState's fourth value (TIMEOUT_RESET) is dead code by design."

patterns-established:
  - "Any future log line added at a shared choke point (rather than at each caller) should capture RunResult/return values first to distinguish a real state change from a no-op, before logging — avoids duplicating dedup logic at the call site."

requirements-completed: [QUE-02]

coverage:
  - id: D1
    description: "Every registration that enters the queue is logged with its FIFO position and the queue length at that moment (M2 success criterion 1, QUE-01)"
    requirement: "QUE-01"
    verification:
      - kind: unit
        ref: "test/queue-fifo-retry.test.ts#enqueuing two ids in order reports positions 1 and 2 and the queue length at each moment"
        status: pass
    human_judgment: false
  - id: D2
    description: "An id already in the queue produces no second row and is logged as such rather than silently ignored (QUE-02, D-11)"
    requirement: "QUE-02"
    verification:
      - kind: unit
        ref: "test/queue-fifo-retry.test.ts#enqueuing the same id twice creates one row and the second call logs that it was not re-queued"
        status: pass
    human_judgment: false
  - id: D3
    description: "A requeued job keeps its original queued_at, so it can never be moved behind a guest who arrived later (QUE-01, D-06)"
    requirement: "QUE-01"
    verification:
      - kind: integration
        ref: "test/queue-fifo-retry.test.ts#after the first guest is dispatched and requeued via requeueWithRetry, getNextQueuedJob still returns them first, with queued_at untouched and retries at 1"
        status: pass
    human_judgment: false
  - id: D4
    description: "One registration can never produce two queue_job rows, including after it has been through the retry path (QUE-02, D-12)"
    requirement: "QUE-02"
    verification:
      - kind: integration
        ref: "test/queue-idempotency.test.ts#re-enqueuing after requeueWithRetry leaves one row with retries still 1 and queued_at untouched"
        status: pass
      - kind: integration
        ref: "test/queue-idempotency.test.ts#re-enqueuing after failJob has made the job terminal does not resurrect it: row count stays 1, status stays failed"
        status: pass
    human_judgment: false
  - id: D5
    description: "The booth state machine transitions, including startup recovery, and the stall_reason vocabulary are documented where an operator will find them (D-08, D-09, D-10)"
    verification:
      - kind: other
        ref: "grep -c '^## 5. Booth state machine' / '^## 6. When a job gets stuck' docs/OPS-RUNBOOK.md — both output 1; stall_reason/ANNOUNCING/env-var greps satisfied"
        status: pass
    human_judgment: true
    rationale: "No automated test reads the runbook prose; the acceptance-criteria greps confirm the required terms and section headers are present, but whether the prose is genuinely usable by an operator who has not read the planning tree is a judgment call, not something a grep can verify."

# Metrics
duration: 12min
completed: 2026-08-10
status: complete
---

# Phase 2 Plan 3: FIFO Position Logging, Idempotency Proof & Operator Runbook Summary

**Made the FIFO guarantee observable with one log line at the single enqueue choke point both ingestion paths share, proved the requeue-preserves-position and one-registration-one-job guarantees against real SQL, and documented the booth state machine and stall_reason vocabulary in the operator runbook.**

## Performance

- **Duration:** ~12 min
- **Tasks:** 3
- **Commits:** 3
- **Files modified:** 2 (+ 2 new test files)

## Accomplishments

- `LocalStore.enqueueJob()` now logs the 1-based FIFO position and queue length for every new registration, and a distinguishable line for an id that was already queued and not re-queued — M2's first success criterion, closed without touching `mirrorReceiver.ts` or `dbPoller.ts` (both ingestion paths already funnel through this one method).
- D-06's promise that a requeued guest keeps their original place in line is now asserted against a real SQLite temp database, not inferred from `updateJobStatus()` happening not to touch `queued_at`.
- D-12's end-to-end proof landed: one registration cannot become two `queue_job` rows at any point in the lifecycle this phase introduced, including after a requeue or after the job has gone terminal via `failJob`. No production code was added for this — QUE-02 was already satisfied structurally by Phase 1's `processed_id` table and `enqueueJob`'s `INSERT OR IGNORE` (D-11).
- `docs/OPS-RUNBOOK.md` gained two new sections: the full 9-row booth transition table (including the 3 startup-recovery-only transitions) and a stuck-job procedure covering read-only inspection, the `stall_reason` vocabulary, the retry-to-failed budget, a manual "stop re-dispatching this job" statement, and the log-vs-database authority caveat. The three Phase 2 timing/retry env vars were also added to the existing optional-variables table.

## Task Commits

Each task was committed atomically, from inside `mirror-request/`:

1. **Task 1: Queue entries are logged with their FIFO position; a requeued guest keeps their place** - `33d67e5` (feat)
2. **Task 2: One registration can never become two queue jobs, retry path included** - `975b31b` (test)
3. **Task 3: Operator documentation — the booth state machine and the stuck-job procedure** - `25f6e15` (docs)

## Files Created/Modified

- `mirror-request/src/state/localStore.ts` - `enqueueJob()` now captures the prepared statement's `RunResult.changes`; emits `Queued job <id> at position <pos> of <len>` on a real insert or `Job <id> is already queued and was not re-queued` on a no-op. No new dedup logic.
- `mirror-request/test/queue-fifo-retry.test.ts` (new) - 5 tests: two-guest position/length logging, duplicate-id no-second-row + distinguishing log line, requeue-preserves-position/queued_at/retries against real SQL, requeue-twice-then-fail advances the queue, and a mask()-safety assertion on the new log line.
- `mirror-request/test/queue-idempotency.test.ts` (new) - 5 tests: duplicate enqueue keeps the first `queued_at`, re-enqueue after a requeue doesn't reset retries/queued_at, re-enqueue after `failJob` doesn't resurrect a terminal job, `registration_id` correctness, and `markProcessed`/`isProcessed` independence from queue-row status.
- `mirror-request/docs/OPS-RUNBOOK.md` - new §5 (booth state machine, 9-row transition table, `TIMEOUT_RESET` dead-value note) and §6 (stuck-job read-only inspection recipe, `stall_reason` table, retry/failure budget, manual stop-dispatch `UPDATE`, log-vs-database authority note); the three Phase 2 env vars added to §3's optional-variables table.

## Decisions Made

See `key-decisions` in frontmatter above. No new architectural decisions were required — 02-CONTEXT.md's D-06, D-08 through D-12 and the orchestrator's pre-dispatch correction (Task 1's `at position` literal-substring requirement) fully specified the implementation.

## Deviations from Plan

None — plan executed exactly as written, including the pre-dispatch correction noted in `<preexisting_state_you_should_know>` (the log message contains the literal substring `at position`, satisfying the gate).

## Issues Encountered

None. `localStore.ts` line numbers had shifted from plan 02-01 as the plan's `<read_first>` warned; located `enqueueJob()`, `getQueuePosition()`, and `getQueueLength()` by content rather than by the stale line numbers, with no surprises.

## Stubs

None.

## Threat Flags

None — all new surface (the log line, the two test files, the runbook sections) was anticipated and dispositioned in the plan's own `<threat_model>` (T-02-14 through T-02-18).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `LocalStore.enqueueJob()`, `requeueWithRetry()`, and `failJob()` are all now covered by real-SQL integration tests; plan 02-04 (config/countdown) can build on a store surface that is fully proven for the FIFO and idempotency guarantees.
- `docs/OPS-RUNBOOK.md` is complete for everything plans 02-01/02-02/02-03 shipped; plan 02-04 should extend §3's env-var table only if it introduces new configuration, and should not need to touch §5/§6.
- QUE-02 is now marked complete in `REQUIREMENTS.md`; QUE-04 remains open, pending plan 02-04.
- No blockers for plan 02-04.

---
*Phase: 02-queue-booth-state*
*Completed: 2026-08-10*

## Self-Check: PASSED

All 4 modified/created files verified present (`src/state/localStore.ts`, `test/queue-fifo-retry.test.ts`, `test/queue-idempotency.test.ts`, `docs/OPS-RUNBOOK.md`). All 3 task commits (`33d67e5`, `975b31b`, `25f6e15`) verified present in `git log --oneline --all`.
