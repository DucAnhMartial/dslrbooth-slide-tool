---
phase: 02-queue-booth-state
plan: 01
subsystem: queue
tags: [sqlite, better-sqlite3, winston, state-machine, restart-recovery]

# Dependency graph
requires:
  - phase: 01-foundation-ingestion
    provides: LocalStore, EnvConfig/toNum typed-config pattern, labelLogger/mask masked logging pipeline, warn-and-continue failure posture (D-05)
provides:
  - "LocalStore.getInFlightJobs()/requeueWithRetry()/failJob() — the storage primitives for the bounded retry policy (D-05..D-07)"
  - "QueueService.recover() — startup entry point closing the live restart deadlock (D-01..D-04)"
  - "QueueService.handleStall() — the single shared definition of the retry policy, reusable by plan 02-02's live timeout path"
  - "QueueService typed config injection (SESSION_TIMEOUT_MS, NEXT_GUEST_COUNTDOWN_MS, SESSION_MAX_RETRIES) — no process.env reads left in queueService.ts"
  - "queueLogger — masked Winston pipeline for the queue subsystem, with warn severity available for the first time"
affects: [02-02-agent-nak-timeout, 02-03-fifo-idempotency-runbook, 02-04-config-countdown]

# Actuals (#2632)
actuals:
  tokens: 6316
  tasks: 2
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Typed config injection via a Pick<EnvConfig, ...> constructor parameter defaulting to getConfig(), matching NotificationService's shape — applied to QueueService per D-13"
    - "Single shared private retry-policy method (handleStall) called from both a startup sweep and (in a later plan) a live timeout callback, so the D-05/D-06/D-07 decision is expressed exactly once"
    - "queued_at intentionally omitted from an UPDATE's SET list as the executable proof of a FIFO-position guarantee (D-06), with the explanation living in a comment above the method signature, not inside its body"

key-files:
  created:
    - mirror-request/test/queue-recovery.test.ts
  modified:
    - mirror-request/src/types.ts
    - mirror-request/src/config.ts
    - mirror-request/src/state/localStore.ts
    - mirror-request/src/queue/queueService.ts
    - mirror-request/src/index.ts

key-decisions:
  - "D-01/D-02: recover() reads booth_state.updated_at age against SESSION_TIMEOUT_MS to decide whether a BUSY booth found at startup is dead; a BUSY booth found dead (or found BUSY with zero in-flight rows) resets to IDLE via setBoothTimeout()."
  - "D-03: a BUSY booth younger than SESSION_TIMEOUT_MS with at least one in-flight row is left BUSY; the most recently dispatched in-flight row (dispatched_at DESC, first entry) is treated as the survivor and re-armed with only the remaining time (SESSION_TIMEOUT_MS - ageMs), never a fresh full timeout. An unparsable or future-dated updated_at is treated as unknown, therefore dead — the safer default, since a wrongly-reset booth self-heals on the next dispatch while a wrongly-BUSY booth reproduces the deadlock this phase removes."
  - "D-04: ANNOUNCING at startup resets to IDLE via setBoothIdle() (not setBoothTimeout(), since no session actually timed out) and the announced job is left untouched — it is still 'queued' and the next tick re-announces it."
  - "The sweep in recover() is unconditional across every booth state — IDLE, BUSY (live or dead), and ANNOUNCING alike — skipping only the one identified survivor. This is what resolves orphan dispatched rows left by an earlier incident that have no link back to the current booth_state row, safe only because the single-booth invariant guarantees at most one row can ever be genuinely in flight."
  - "D-06 is made an explicit, tested guarantee: requeueWithRetry()'s UPDATE deliberately omits queued_at from its SET list, so a requeued guest keeps their original FIFO position rather than being demoted to the back of the line."
  - "D-13: QueueService's constructor now takes an optional Pick<EnvConfig, 'SESSION_TIMEOUT_MS' | 'NEXT_GUEST_COUNTDOWN_MS' | 'SESSION_MAX_RETRIES'> parameter defaulting to getConfig(); the two former process.env reads (in beginAnnouncement() and startBusyTimer()) are gone. The 5-10s countdown-clamp logic moved into the constructor rather than getting its own config key — reusing the existing bounds was the discretionary answer the plan left open."
  - "The unmasked console-wrapping local logger object (no warn method, never reached the rotated file transport) is replaced with labelLogger('queue') from the shared Winston pipeline, exported as queueLogger so tests can assert against the exact instance."

patterns-established:
  - "Retry-policy centralization: any future stall-detection path (live timeout, NAK) must call the existing private handleStall(jobId, reason), never duplicate the requeue/fail branching."
  - "startBusyTimer(jobId, timeoutMs?) now takes an optional explicit timeout so a caller (recover()'s D-03 branch) can re-arm with a partial duration instead of the full configured timeout."

requirements-completed: [QUE-01, QUE-03, BTH-01, BTH-02]

coverage:
  - id: D1
    description: "Startup recovery resolves every stranded queue_job row (status IN ('dispatched','in_progress')) at boot, not only the one tied to the current booth_state row, reproducing and fixing the live 4-row deadlock (D-01, D-02, RESEARCH.md Pitfall 1)"
    requirement: "BTH-02"
    verification:
      - kind: integration
        ref: "test/queue-recovery.test.ts#resets a six-hour-stale BUSY booth and resolves every stranded row under the bounded retry policy"
        status: pass
      - kind: integration
        ref: "test/queue-recovery.test.ts#sweeps an orphan dispatched row from an earlier incident even when the booth is IDLE (Pitfall 1)"
        status: pass
    human_judgment: false
  - id: D2
    description: "A stalled job returns to the queue with retries incremented and its original queued_at untouched (D-05, D-06); a job past SESSION_MAX_RETRIES fails with a fixed stall_reason and the queue advances (D-07)"
    requirement: "QUE-01"
    verification:
      - kind: integration
        ref: "test/queue-recovery.test.ts#resets a six-hour-stale BUSY booth and resolves every stranded row under the bounded retry policy"
        status: pass
    human_judgment: false
  - id: D3
    description: "A BUSY booth younger than SESSION_TIMEOUT_MS with an in-flight row stays BUSY and its timer is re-armed with only the remaining time, never a fresh full timeout (D-03)"
    requirement: "BTH-01"
    verification:
      - kind: unit
        ref: "test/queue-recovery.test.ts#BUSY at 60s of a 300_000ms timeout with one in-flight row leaves the booth BUSY and re-arms the timer for exactly the 240_000ms remainder"
        status: pass
      - kind: unit
        ref: "test/queue-recovery.test.ts#sweeps only the older in-flight row, leaving the most recently dispatched one alone"
        status: pass
      - kind: unit
        ref: "test/queue-recovery.test.ts#resets the booth when age is 60s but there are zero in-flight rows — nothing to protect"
        status: pass
      - kind: unit
        ref: "test/queue-recovery.test.ts#treats an unparsable updated_at on a BUSY booth as unknown, therefore dead — resets and sweeps"
        status: pass
    human_judgment: false
  - id: D4
    description: "A booth found ANNOUNCING at startup returns to IDLE without a spurious timeout warning, and its still-queued job is left for the next tick to re-announce (D-04)"
    requirement: "BTH-01"
    verification:
      - kind: unit
        ref: "test/queue-recovery.test.ts#ANNOUNCING resets to IDLE without a timeout warning, and still sweeps any in-flight orphan row"
        status: pass
    human_judgment: false
  - id: D5
    description: "QueueService reads SESSION_TIMEOUT_MS, NEXT_GUEST_COUNTDOWN_MS and SESSION_MAX_RETRIES from an injected typed config and reads no environment variable itself (D-13)"
    requirement: "QUE-03"
    verification:
      - kind: unit
        ref: "test/queue-recovery.test.ts#announces for the injected countdown and times out at the injected SESSION_TIMEOUT_MS, with no environment variable involved"
        status: pass
      - kind: other
        ref: "grep -rn \"process.env\" mirror-request/src/queue/ — no matches"
        status: pass
    human_judgment: false
  - id: D6
    description: "Every log line QueueService emits reaches the masked Winston pipeline via queueLogger = labelLogger('queue'), and the module can emit at warn severity (M2 success criterion 5)"
    verification:
      - kind: other
        ref: "grep -v '^\\s*[/*]' src/queue/queueService.ts | grep -c \"labelLogger('queue')\" — outputs 1; grep -c 'console' — outputs 0"
        status: pass
    human_judgment: true
    rationale: "No test asserts a log line physically reaches logs/extension-service-%DATE%.log through mask() — this is confirmed by static code review (the console-wrapping logger is deleted, queueLogger is the sole logger in the file, handleStall's fail branch calls queueLogger.warn) rather than a runtime log-capture assertion. A human or a later log-inspection step should confirm the rotated file transport actually receives a queue warn line in a running process."
  - id: D7
    description: "A recovery failure at boot warns and lets the service start; it never crashes the process into a restart loop (Phase 1 D-05 failure posture)"
    verification:
      - kind: other
        ref: "src/index.ts — queue.recover() wrapped in try/catch calling log.warn(err instanceof Error ? err.message : String(err)) before queue.start()"
        status: pass
    human_judgment: true
    rationale: "No test drives queue.recover() to throw inside the real app.listen callback and asserts the process stays up — verified by code inspection of the try/catch wiring only."

# Metrics
duration: 10min
completed: 2026-08-10
status: complete
---

# Phase 2 Plan 1: Restart Recovery & Bounded Retry Summary

**Startup reconciliation (`QueueService.recover()`) that closes the live BUSY deadlock — age-checks `booth_state.updated_at` against `SESSION_TIMEOUT_MS`, sweeps every stranded `queue_job` row through a shared bounded-retry policy that preserves FIFO position, and moves the queue's config and logging onto the typed/masked pipeline the rest of the codebase already uses.**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-08-10T10:26:21Z (session state load)
- **Completed:** 2026-08-10T10:36:15Z
- **Tasks:** 2
- **Files modified:** 5 (+ 1 new test file)

## Accomplishments
- Closed the confirmed live deadlock: `recover()` now runs before the first `tick()`, resets a `booth_state` row found `BUSY` past `SESSION_TIMEOUT_MS`, and unconditionally sweeps every `queue_job` row in `status IN ('dispatched','in_progress')` — not only the one tied to the current `booth_state` row — reproducing and resolving the exact live 4-row scenario in an integration test against a real temp SQLite file.
- Added the bounded retry policy (D-05..D-07) as a single shared `handleStall()` method: a stalled job requeues with `retries + 1` and its original `queued_at` preserved (never demoted in line); a job past `SESSION_MAX_RETRIES` fails with a fixed `stall_reason` and the queue moves on.
- Added D-03's age-based survival: a `BUSY` booth younger than `SESSION_TIMEOUT_MS` with an in-flight row stays `BUSY`, and its timer re-arms with only the remaining time — proved exactly at 240,000ms of a 300,000ms budget, not a fresh full timeout.
- Added D-04's `ANNOUNCING` reset: returns to `IDLE` quietly (no spurious timeout warning), leaving the still-`queued` job for the next tick to re-announce.
- Replaced the unmasked, `warn`-less console-wrapping logger in `queueService.ts` with the real Winston pipeline (`queueLogger = labelLogger('queue')`), and moved `queueService.ts`'s two `process.env` reads onto an injected typed config (D-13).

## Task Commits

Each task was committed atomically:

1. **Task 1: End-to-end restart recovery — a dead BUSY booth resets and every stranded job is resolved** - `5dafc78` (feat)
2. **Task 2: A possibly-live session survives a restart; ANNOUNCING resets cleanly** - `b80e9fa` (feat)

## Files Created/Modified
- `mirror-request/src/types.ts` - `EnvConfig.NEXT_GUEST_COUNTDOWN_MS`/`SESSION_MAX_RETRIES`, `QueueJob.stall_reason`, status-value comment
- `mirror-request/src/config.ts` - `NEXT_GUEST_COUNTDOWN_MS`/`SESSION_MAX_RETRIES` via the existing `toNum()` helper
- `mirror-request/src/state/localStore.ts` - `getInFlightJobs()`, `requeueWithRetry()`, `failJob()`
- `mirror-request/src/queue/queueService.ts` - `queueLogger`, typed config injection, `recover()`, `handleStall()`, `startBusyTimer(jobId, timeoutMs?)`
- `mirror-request/src/index.ts` - `queue.recover()` in a warn-and-continue `try/catch`, before `queue.start()`
- `mirror-request/test/queue-recovery.test.ts` (new) - 8 tests: 2 real-`LocalStore` integration cases (D-01/D-02/Pitfall 1), 5 mocked-store fake-timer unit cases (D-03/D-04), 1 config-injection case (D-13)

## Decisions Made
See `key-decisions` in frontmatter above — all decisions were pre-resolved by 02-CONTEXT.md (D-01..D-07, D-13) and RESEARCH.md/PATTERNS.md's exact target code; no new architectural decisions were required during execution.

## Deviations from Plan

None — plan executed exactly as written. The plan's own preexisting-state note flagged that its prose enumerates 3 `updateJobStatus(` call sites in the pre-existing file when the real file has 4 (the fourth inside the live `busyTimer` timeout callback); this did not affect any task action or acceptance criterion, since none of them counted call sites by that number, and task 1 explicitly left that callback's body untouched (plan 02-02 rewrites it).

## Issues Encountered

The plan's overall `<verification>` block runs a literal (non-comment-stripped) `grep -rn "getStore()" test/queue-recovery.test.ts`. An early draft of the test file's header comment explained the test-isolation constraint by naming `getStore()` literally, which would have shown a false-positive match despite never calling it in executable code. Reworded the comment to describe "the shared store singleton" without the literal substring so both the literal plan-level grep and the comment-stripped task-level grep (`grep -v '^\s*[/*]' ... | grep -c 'getStore'`) pass. No code change — cosmetic wording only, verified with both grep forms before the task 2 commit.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `handleStall()` and `startBusyTimer(jobId, timeoutMs?)` are ready for plan 02-02 to wire the live `busyTimer` timeout callback and the Agent NAK path through the same retry policy, replacing the semantically-wrong-timestamp bug noted in RESEARCH.md Pitfall 4.
- `queueLogger` is exported and ready for plan 02-02's NAK/timeout log lines.
- The live production defect (`booth_state` stuck `BUSY` since `2026-08-10T04:29:42Z`) is fixed at the code level; 02-VALIDATION.md's "Manual-Only Verification" (restart the real service and re-inspect `booth_state`/`queue_job` read-only) remains an explicit deferred manual step, outside this plan's automated task list and outside this executor's scope (no service restart or production-data mutation was performed).
- No blockers for plan 02-02 (Agent NAK & live timeout retry) or 02-03 (FIFO/idempotency/runbook).

---
*Phase: 02-queue-booth-state*
*Completed: 2026-08-10*

## Self-Check: PASSED

All 6 modified/created files verified present (`src/types.ts`, `src/config.ts`, `src/state/localStore.ts`, `src/queue/queueService.ts`, `src/index.ts`, `test/queue-recovery.test.ts`). Both task commits (`5dafc78`, `b80e9fa`) verified present in `git log --oneline --all`.
