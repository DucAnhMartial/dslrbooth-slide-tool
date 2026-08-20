---
phase: 02-queue-booth-state
plan: 02
subsystem: queue
tags: [state-machine, retry-policy, bounded-retry, winston, vitest-fake-timers]

# Dependency graph
requires:
  - phase: 02-queue-booth-state
    plan: 02-01
    provides: "handleStall() (the shared D-05/D-06/D-07 retry policy), queueLogger, LocalStore.requeueWithRetry()/failJob(), typed config injection on QueueService"
provides:
  - "The live busyTimer timeout callback and the onAgentAck NAK branch both routed through handleStall() — the second and third call sites of the shared retry policy"
  - "The stall_reason vocabulary's session_ack_timeout and agent_nak values, in production use for the first time"
  - "Removal of the two RESEARCH.md-Pitfall-4 timestamp bugs: no remaining updateJobStatus call writes acknowledged_at or session_started_at for an event that did not happen"
affects: [02-03-fifo-idempotency-runbook, 02-04-config-countdown]

# Actuals (#2632)
actuals:
  tokens: 3405
  tasks: 2
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Both live (non-restart) failure paths now converge on the single handleStall() definition from 02-01, matching the pattern 02-01 established: the retry/fail branching logic exists exactly once in the file, called from three sites (recover() sweep, busyTimer timeout, Agent NAK)"

key-files:
  modified:
    - mirror-request/src/queue/queueService.ts
    - mirror-request/test/queue-timeout-retry.test.ts
    - mirror-request/test/queue-recovery.test.ts

key-decisions:
  - "startBusyTimer's setTimeout callback order is fixed as: null out this.busyTimer, call store.setBoothTimeout() (booth -> IDLE, preserves the already-shipped warning), call handleStall(jobId, 'session_ack_timeout'), then tick() — reset and resolve before advance, so tick()'s booth !== 'IDLE' guard never blocks the next dispatch for an extra 250ms cycle (T-02-12)."
  - "The onAgentAck NAK branch keeps its existing setBoothIdle()/clearBusyTimer() calls and debug log line unchanged, replacing only the updateJobStatus call with handleStall(jobId, 'agent_nak'), placed before the trailing tick() call."
  - "Both plan-flagged Pitfall-4 timestamp bugs (acknowledged_at on a session that timed out, session_started_at on a session that never started) are removed as part of routing through handleStall(), which takes no timestamp parameter — leaving either write in place would have meant deliberately re-adding an unnecessary line."
  - "Per D-08, no notification, table, or outbound delivery was added for an exhausted job — only stall_reason and the log line, exactly as scoped."

patterns-established:
  - "queue-timeout-retry.test.ts's mock store (buildStore helper) is the reusable fake-timer harness for any future test needing a controllable booth + queue + requeueWithRetry/failJob spies, following queue-countdown.test.ts's shape but adding the retry-policy surface."

requirements-completed: [QUE-01, BTH-01, BTH-02]

coverage:
  - id: D1
    description: "A BUSY booth past SESSION_TIMEOUT_MS without an ack resets to IDLE, warns once naming the job id and attempt number, and the stalled job goes through handleStall() rather than an unbounded requeue (BTH-02, D-05, D-06, D-07)"
    requirement: "BTH-02"
    verification:
      - kind: unit
        ref: "test/queue-timeout-retry.test.ts#resets the booth to IDLE and requeues exactly once on timeout"
        status: pass
      - kind: unit
        ref: "test/queue-timeout-retry.test.ts#emits exactly one warning naming the job id and the attempt number"
        status: pass
      - kind: unit
        ref: "test/queue-timeout-retry.test.ts#fails the job once retries exceed SESSION_MAX_RETRIES, with a warning saying the job failed"
        status: pass
      - kind: unit
        ref: "test/queue-timeout-retry.test.ts#advances to the next queued guest after the stall resolves, without waiting for a further timeout"
        status: pass
      - kind: unit
        ref: "test/queue-timeout-retry.test.ts#a job acknowledged before the timeout re-arms the timer from the ack, and no stall is recorded"
        status: pass
    human_judgment: false
  - id: D2
    description: "The timeout path writes no timestamp column for an acknowledgement that never happened — the sole remaining acknowledged_at write site is sessionAcked(), where the job really was acknowledged"
    requirement: "BTH-02"
    verification:
      - kind: unit
        ref: "test/queue-timeout-retry.test.ts#makes no updateJobStatus call for the timed-out job"
        status: pass
      - kind: other
        ref: "grep -v '^\\s*[/*]' src/queue/queueService.ts | grep -c \"'acknowledged_at'\" — outputs 1"
        status: pass
    human_judgment: false
  - id: D3
    description: "An Agent NAK counts against the same bounded retry budget as a silent timeout, joins the same terminal failed state with agent_nak, and never stamps session_started_at (a session that never started)"
    requirement: "BTH-02"
    verification:
      - kind: unit
        ref: "test/queue-timeout-retry.test.ts#a NAK sets the booth IDLE, clears the busy timer, requeues once, and warns once"
        status: pass
      - kind: unit
        ref: "test/queue-timeout-retry.test.ts#a NAK on a job already at the retry ceiling fails it with agent_nak, and the next tick announces the following guest"
        status: pass
      - kind: unit
        ref: "test/queue-timeout-retry.test.ts#makes no updateJobStatus call in the NAK branch"
        status: pass
      - kind: unit
        ref: "test/queue-timeout-retry.test.ts#three consecutive NAKs of one job under a budget of 2 produce exactly one failJob call"
        status: pass
      - kind: other
        ref: "grep -v '^\\s*[/*]' src/queue/queueService.ts | grep -c \"'session_started_at'\" — outputs 0"
        status: pass
    human_judgment: false
  - id: D4
    description: "The positive-ack path (onAgentAck(jobId, true)) and the session_end happy path are unaffected by this plan's changes"
    requirement: "QUE-01"
    verification:
      - kind: unit
        ref: "test/queue-timeout-retry.test.ts#onAgentAck(jobId, true) is unaffected: still transitions via sessionAcked and re-arms the busy timer"
        status: pass
      - kind: unit
        ref: "test/queue-countdown.test.ts#announces and dispatches requests one at a time in FIFO order — still green unchanged"
        status: pass
    human_judgment: false
  - id: D5
    description: "Exactly two updateJobStatus call sites remain in queueService.ts (dispatchJob's dispatched_at, sessionAcked's acknowledged_at), each describing an event that actually happened; exactly three handleStall call sites exist (recover() sweep, busyTimer timeout, NAK branch)"
    verification:
      - kind: other
        ref: "grep -rn \"updateJobStatus\" src/queue/queueService.ts — 2 matches, at dispatchJob() and sessionAcked() only"
        status: pass
      - kind: other
        ref: "grep -v '^\\s*[/*]' src/queue/queueService.ts | grep -c 'this.handleStall(' — outputs 3"
        status: pass
    human_judgment: false

# Metrics
duration: 20min
completed: 2026-08-10
status: complete
---

# Phase 2 Plan 2: Agent NAK & Live Timeout Retry Summary

**The live `busyTimer` timeout callback and the Agent NAK branch in `onAgentAck` now both route through `handleStall()`, the single bounded-retry policy plan 02-01 built — closing the two unbounded-requeue DoS paths and the two semantically-wrong timestamp writes RESEARCH.md's Pitfall 4 flagged.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-08-10T10:37:00Z (approx, immediately following 02-01)
- **Completed:** 2026-08-10T10:47:36Z
- **Tasks:** 2
- **Files modified:** 3 (1 new test file, 1 source file, 1 pre-existing test file's mock fixed)

## Accomplishments

- `startBusyTimer()`'s `setTimeout` callback rewritten to, in order: null out `this.busyTimer`, call `store.setBoothTimeout('session_ack timeout')` (unchanged reason string, preserves the already-shipped booth-reset warning), call `this.handleStall(jobId, 'session_ack_timeout')`, then `this.tick()` — reset and resolve before advance, so the next guest is dispatched against an already-IDLE booth instead of waiting an extra 250ms tick cycle.
- Deleted the `updateJobStatus(jobId, 'queued', 'acknowledged_at', Date.now())` call inside that callback — the job was never acknowledged (that's why the timer fired); its status transition is now entirely `handleStall()`'s (via `requeueWithRetry`/`failJob`).
- `onAgentAck()`'s NAK branch now calls `this.handleStall(jobId, 'agent_nak')` in place of `updateJobStatus(jobId, 'queued', 'session_started_at', Date.now())` — an Agent that NAKs every dispatch now hits the same bounded budget and terminal `failed` state as the timeout path, instead of looping one poisoned job forever on a faster cycle.
- Both wrong timestamp writes RESEARCH.md Pitfall 4 flagged are gone: the only remaining `acknowledged_at` write is in `sessionAcked()` (a real ack), and `session_started_at` is written nowhere in the file.
- 11 new tests in `test/queue-timeout-retry.test.ts` drive both paths through fake timers: reset-to-IDLE, single warning with job id + attempt number, terminal `failed` with the correct `stall_reason` at each of the two poison points, zero stray `updateJobStatus` calls, the queue advancing to the next guest without an extra timeout wait, ack-before-timeout re-arming, and a 3-consecutive-NAK sequence proving exactly one `failJob` call under a budget of 2.

## Task Commits

Each task was committed atomically:

1. **Task 1: The live BUSY timeout joins the bounded retry policy** - `70d1ea2` (feat)
2. **Task 2: An Agent NAK counts against the same retry budget** - `87e6aed` (feat)

## Files Created/Modified

- `mirror-request/src/queue/queueService.ts` - `startBusyTimer()`'s timeout callback rewritten to route through `handleStall()`; `onAgentAck()`'s NAK branch likewise
- `mirror-request/test/queue-timeout-retry.test.ts` (new) - 11 fake-timer tests: 6 for the live busyTimer timeout path, 5 for the Agent NAK path
- `mirror-request/test/queue-recovery.test.ts` - one pre-existing mock store (the D-13 config-injection test) extended with `requeueWithRetry`/`failJob` stubs — see Deviations

## Decisions Made

See `key-decisions` in frontmatter above — all decisions were pre-resolved by 02-CONTEXT.md (D-05..D-08) and the plan's exact target callback ordering and grep-verified call-site counts; no new architectural decisions were required during execution.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking issue] Fixed a pre-existing test mock broken by task 1's call-site change**
- **Found during:** Task 1, running `npm test` after the `startBusyTimer` rewrite
- **Issue:** `test/queue-recovery.test.ts`'s `QueueService config injection (D-13)` test builds a hand-rolled mock `LocalStore` for its own purposes (asserting the injected countdown/timeout values, not the retry policy). That mock never included `requeueWithRetry`/`failJob` because, before this plan, the timeout callback called `store.updateJobStatus()` directly. Task 1 routes that same callback through `handleStall()`, which calls `this.store.requeueWithRetry(jobId)` — a method the D-13 mock didn't define, throwing `TypeError: this.store.requeueWithRetry is not a function` once the test's fake timers reached the injected `SESSION_TIMEOUT_MS`.
- **Fix:** Added `requeueWithRetry: () => ({ retries: 1 })` and `failJob: () => {}` stubs to that one mock store, with a comment explaining why they're needed now. No assertion in that test changed; it still verifies the injected-config timing only.
- **Files modified:** `mirror-request/test/queue-recovery.test.ts`
- **Commit:** `70d1ea2`

Or: this is the only deviation — everything else executed exactly as written.

## Issues Encountered

None beyond the one auto-fixed deviation above. All plan-specified grep-based acceptance criteria matched exactly on the first attempt for both tasks:
- `this.handleStall(` count: 2 after task 1, 3 after task 2
- `'session_ack_timeout'` count: 1
- `'acknowledged_at'` count: 1 (sole site: `sessionAcked()`)
- `'agent_nak'` count: 1
- `this.store.updateJobStatus(` count: 2 (sole sites: `dispatchJob()`, `sessionAcked()`)
- `'session_started_at'` count: 0
- `getStore` count in the new test file: 0

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- Both live (non-restart) failure paths now share `handleStall()` with 02-01's restart-recovery sweep — all three call sites use one definition of the D-05/D-06/D-07 retry policy, exactly as 02-01's Summary anticipated.
- `queueService.ts` now has 2 `updateJobStatus` call sites (both correct) and 3 `handleStall` call sites (all correct) — the file's timestamp-writing surface is fully audited and every write describes a real event.
- No blockers for plan 02-03 (FIFO/idempotency/runbook — QUE-01's `queued_at`-preservation guarantee already lives in `requeueWithRetry()` from 02-01; QUE-02's idempotency test and the FIFO end-to-end test remain 02-03's work) or plan 02-04 (config/countdown).
- 02-VALIDATION.md's "Manual-Only Verification" (restart the real service, re-inspect `booth_state`/`queue_job` read-only) remains open, same as after 02-01 — no service restart or production-data mutation was performed by this execution.

---
*Phase: 02-queue-booth-state*
*Completed: 2026-08-10*

## Self-Check: PASSED

Both modified/created files verified present: `src/queue/queueService.ts`, `test/queue-timeout-retry.test.ts`, `test/queue-recovery.test.ts`. Both task commits (`70d1ea2`, `87e6aed`) verified present in `git log --oneline --all`.
