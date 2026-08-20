---
phase: 07-session-lifecycle-retake
plan: 01
subsystem: queue
tags: [sqlite, better-sqlite3, state-machine, websocket-events, dslrbooth]

# Dependency graph
requires:
  - phase: 02-queue-booth-state
    provides: LocalStore booth_state table, QueueService dispatch/busyTimer machinery, bounded retry policy (handleStall/requeueWithRetry/requeueNoRetry)
  - phase: 03-agent-websocket-link
    provides: onAgentEvent() dispatch table, AgentServer event forwarding
provides:
  - jobId-scoped LocalStore.completeJob(jobId, completedAt), replacing the positional completeInProgressJob()
  - booth_state.current_job_id as the server-held attribution source of truth (additive migration, getBoothCurrentJobId/setBoothCurrentJob)
  - QueueService.onPrintComposite() completing jobs from processing_start/printing events, scoped and cross-checked against current_job_id
  - sessionEnded() reduced to booth-release-only logic
  - sessionAcked() terminal-state guard preventing a stray session_start from resurrecting a completed/failed job
  - Throttled D-06 mismatch warn (jobIdMismatchWarnLogged)
  - Booth-release fallback timer (releaseTimer/BOOTH_RELEASE_TIMEOUT_MS) that never charges a retry
affects: [07-02-agent-event-visibility, 07-03-pending-print-registry, 07-04-no-photo-outcome, 07-05-phase-gate]

# Actuals (#2632)
actuals:
  tokens: 17562
  tasks: 3
  commits: 6

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "jobId-scoped SQL completion (WHERE id = ? AND status = 'in_progress') replacing positional ORDER BY ... LIMIT 1 selection"
    - "Server-held attribution column (booth_state.current_job_id) as the only trusted identity source; the event's own jobId is a cross-check, never authoritative"
    - "Deliberate-sibling timer discipline (releaseTimer alongside busyTimer, never routed through handleStall()) mirroring localStore.ts's requeueWithRetry/requeueNoRetry pattern"
    - "Log-once throttle flag (jobIdMismatchWarnLogged) copied from the existing agentOfflineDispatchSkipLogged shape"

key-files:
  created:
    - mirror-request/test/queue-dual-completion.test.ts
    - mirror-request/test/queue-retake-anchor.test.ts
    - mirror-request/test/queue-release-timer.test.ts
  modified:
    - mirror-request/src/state/localStore.ts
    - mirror-request/src/queue/queueService.ts
    - mirror-request/src/config.ts
    - mirror-request/src/types.ts
    - mirror-request/test/local-store-persistence.test.ts
    - mirror-request/test/agent-disconnect-requeue.test.ts
    - mirror-request/test/queue-config-injection.test.ts
    - mirror-request/test/queue-countdown.test.ts
    - mirror-request/test/queue-dispatch-connectivity.test.ts
    - mirror-request/test/queue-dispatch-mode.test.ts
    - mirror-request/test/queue-event-coverage.test.ts
    - mirror-request/test/queue-file-upload-print.test.ts
    - mirror-request/test/queue-timeout-retry.test.ts
    - mirror-request/test/status-api.test.ts

key-decisions:
  - "completeInProgressJob() removed outright, not kept alongside completeJob() (assumption-delta 'promote' decision) — the unscoped path stayed reachable is exactly the SC-2 failure re-armed"
  - "booth_state.current_job_id is the only trusted attribution source; the Agent-forwarded event jobId is a cross-check only, because the Agent's activeJobId is stale by design (D-05 leaves that defect in place deliberately)"
  - "Job completion moved off session_end entirely onto the print-composite events (processing_start/printing); sessionEnded() now only releases the booth"
  - "The booth-release fallback timer is a structurally separate field/method from busyTimer and never calls handleStall()/requeueWithRetry()/requeueNoRetry()/failJob()/setBoothTimeout() — a completed job must never be requeued or charged a retry by its own release timeout"

patterns-established:
  - "Pattern: any future completion/attribution mechanism in this codebase must be identity-scoped (WHERE id = ?), never positional/ordered — pinned by a standing LocalStore.prototype invariant test"
  - "Pattern: a fallback/safety timer that resolves an already-terminal state must be a structurally distinct sibling of the retry-charging timer, never unified with it"

requirements-completed: [SC-1, SC-2]

coverage:
  - id: D1
    description: "A print-composite event (processing_start or printing) completes exactly the job named by booth_state.current_job_id, and no other job"
    requirement: SC-2
    verification:
      - kind: unit
        ref: "test/queue-dual-completion.test.ts#processing_start completes job-1 while the booth stays BUSY..."
        status: pass
      - kind: unit
        ref: "test/local-store-persistence.test.ts#completeJob(jobId) reaches only the named row, proven against a real database with two in_progress rows (SC-2)"
        status: pass
    human_judgment: false
  - id: D2
    description: "A second session_end arriving after the booth was released completes nothing; with a second guest queued, dispatched and in session, that guest's status is still in_progress"
    requirement: SC-2
    verification:
      - kind: unit
        ref: "test/queue-dual-completion.test.ts#processing_start completes job-1 while the booth stays BUSY... a stray duplicate session_end afterward completes nothing and leaves job-2 in_progress"
        status: pass
    human_judgment: false
  - id: D3
    description: "capture_start and session_start alone, with no processing_start and no printing, never move a job to completed"
    requirement: SC-1
    verification:
      - kind: unit
        ref: "test/queue-retake-anchor.test.ts#the full capture-phase sequence for the job that owns the booth never completes it and never changes current_job_id"
        status: pass
      - kind: unit
        ref: "test/queue-retake-anchor.test.ts#the same sequence delivered twice... still never completes the job"
        status: pass
    human_judgment: false
  - id: D4
    description: "A session_start naming a job already in a terminal state does not return it to in_progress (the BZWCWFN6 resurrection mechanism)"
    requirement: SC-2
    verification:
      - kind: unit
        ref: "test/queue-dual-completion.test.ts#a session_start for a job whose stored status is completed leaves that status unchanged..."
        status: pass
      - kind: unit
        ref: "test/queue-dual-completion.test.ts#a session_start for a job whose stored status is failed behaves identically"
        status: pass
    human_judgment: false
  - id: D5
    description: "No completion path in LocalStore resolves a job by ordering or position; LocalStore.prototype carries no positional completion method"
    requirement: SC-2
    verification:
      - kind: unit
        ref: "test/queue-dual-completion.test.ts#completeInProgressJob is undefined on the prototype..."
        status: pass
    human_judgment: false
  - id: D6
    description: "The booth_state.current_job_id migration is idempotent against a real SQLite file"
    verification:
      - kind: unit
        ref: "test/local-store-persistence.test.ts#the booth_state.current_job_id migration is idempotent..."
        status: pass
    human_judgment: false
  - id: D7
    description: "The booth-release fallback timer returns the booth to service without requeueing the job, without charging a retry and without writing a stall_reason"
    verification:
      - kind: unit
        ref: "test/queue-release-timer.test.ts#after the fallback fires, requeueWithRetry, requeueNoRetry and failJob are never called and the job stays completed"
        status: pass
    human_judgment: false
  - id: D8
    description: "At the physical booth, a retake by guest A neither completes A's job nor frees the booth while guest B is queued"
    verification: []
    human_judgment: true
    rationale: "Backstop verification per the plan's own must_haves (verification: backstop) — explicitly deferred to the phase gate (07-05 T4, D-15) with a real booth and a real second guest. No live booth or dispatched Agent connection exists in this executor's environment."

duration: ~30min
completed: 2026-08-12
status: complete
---

# Phase 7 Plan 1: Session Lifecycle Completion Anchor Move Summary

**Job completion moved off `session_end` onto dslrBooth's print-composite events, scoped by a new `booth_state.current_job_id` column, with booth release split into its own anchor and its own never-charges-a-retry fallback timer — SC-2 (the BZWCWFN6 dual-completion bug) proven at both the service-dispatch layer and the raw SQL layer.**

## Performance

- **Duration:** ~30 min
- **Started:** ~2026-08-12T10:10:00Z (estimated; file discovery and reading preceded the first commit)
- **Completed:** 2026-08-12T10:40:00Z
- **Tasks:** 3
- **Files modified:** 17 (3 created, 14 modified)

## Accomplishments

- `completeInProgressJob()` — the positional `ORDER BY acknowledged_at DESC LIMIT 1` selector that let guest A's stray second `session_end` complete guest B — is removed outright and replaced by `LocalStore.completeJob(jobId, completedAt): boolean`, scoped by id and returning whether it matched, following `failJob()`'s id-scoped shape and `claimNotification()`'s changes-count return.
- `booth_state.current_job_id` is a new, additive, migration-proven column that is the sole server-held source of truth for which job owns the booth. The four booth writers (`setBoothBusy`, `setBoothIdle`, `setBoothTimeout`, `setBoothState`) all name it explicitly, and two new accessors (`getBoothCurrentJobId`/`setBoothCurrentJob`) read/write it.
- `QueueService.onPrintComposite()` is the new completion anchor, invoked from `processing_start` and `printing` events. It validates the composite path, reads `current_job_id`, cross-checks the event's own (Agent-stamped, known-stale) jobId against it with a throttled warn on mismatch, and calls `completeJob()` — the second of a `processing_start`/`printing` double-fire matches zero rows and is absorbed structurally.
- `sessionEnded()` is reduced to booth-release logic only: it never completes a job. A `session_end` with no job bound to the booth is a complete no-op (the stray-duplicate path measured 3x in 52s for one session).
- `sessionAcked()` gained a terminal-state guard (Task 2): a `session_start` naming a job already `completed` or `failed` is rejected with one warn and no `updateJobStatus` write — closing WINDOWS-8's second, independently-closable resurrection path.
- A booth-release fallback timer (`releaseTimer`, `BOOTH_RELEASE_TIMEOUT_MS`, default 120000ms) returns a BUSY booth to service if `session_end` never arrives after completion — armed after a successful print-composite completion, cleared on `session_end`, `onAgentDisconnected()`, and `stop()`. It is a structurally distinct sibling of `busyTimer` and never calls `handleStall()` or charges a retry.
- SC-2 proven from both ends per the plan's `<sc2_reconciliation>`: `test/queue-dual-completion.test.ts` drives two real guests through the real `QueueService` dispatch path (mocked SQLite only); `test/local-store-persistence.test.ts` proves the same guarantee against a real temp-file database with two real rows, guest A's `acknowledged_at` deliberately older than B's.

## Task Commits

Each task was committed atomically (Task 2 and Task 3 carry TDD RED/GREEN commits):

1. **Task 1: End-to-end "one print composite completes exactly one named job"** - `049e53d` (feat)
2. **Task 2: Terminal-state guard, throttled mismatch warn, positional-completion invariant** - `2974e48` (test, RED) → `d0d6239` (feat, GREEN)
3. **Task 3: Booth-release fallback timer (D-02)** - `af8aef4` (test, RED) → `3015aa9` (feat, GREEN)

## Files Created/Modified

- `mirror-request/src/state/localStore.ts` - `booth_state.current_job_id` additive migration; `completeJob(jobId, completedAt)` replaces `completeInProgressJob()`; four booth writers name `current_job_id` explicitly; `getBoothCurrentJobId`/`setBoothCurrentJob` accessors
- `mirror-request/src/queue/queueService.ts` - `onPrintComposite()` completion anchor; `sessionEnded()` reduced to release-only; `sessionAcked()` terminal-state guard; `jobIdMismatchWarnLogged` throttle; `releaseTimer`/`startReleaseTimer()`/`clearReleaseTimer()`
- `mirror-request/src/config.ts` / `mirror-request/src/types.ts` - `BOOTH_RELEASE_TIMEOUT_MS` config key (default 120000ms)
- `mirror-request/test/queue-dual-completion.test.ts` (new) - the phase tracer proof: two real guests through the real dispatch path, terminal-state guard, prototype invariant, mismatch-warn throttle
- `mirror-request/test/queue-retake-anchor.test.ts` (new) - SC-1 structural coverage: no capture-phase event sequence reaches the completion anchor
- `mirror-request/test/queue-release-timer.test.ts` (new) - the D-02 fallback timer's four behaviors
- `mirror-request/test/local-store-persistence.test.ts` - new `describe` block: migration idempotency, booth-binding round-trip, the SC-2 SQL-layer case, duplicate-completion, terminal-row unreachability
- 9 further test files updated for the removed method and new store surface (`agent-disconnect-requeue`, `queue-config-injection`, `queue-countdown`, `queue-dispatch-connectivity`, `queue-dispatch-mode`, `queue-event-coverage`, `queue-file-upload-print`, `queue-timeout-retry`, `status-api`)

## Decisions Made

- Completion identity moved from positional to jobId-scoped per the plan's `assumption_delta_decision`: `promote`, not `keep-alongside` — a reachable unscoped path is the exact defect being removed.
- `booth_state.current_job_id` chosen over an in-memory field so the binding survives a restart (proven in `local-store-persistence.test.ts`) and is the single source multiple call sites (`onPrintComposite`, `sessionEnded`) read from consistently.
- The D-06 mismatch warn is throttled with the project's only existing log-once boolean-flag shape (mirroring `agentOfflineDispatchSkipLogged`), not a time-windowed rate limiter — no such mechanism exists elsewhere in this codebase.
- The release-fallback timer's default (120000ms) is justified against the measured evidence: a 31-second real gap between composite arrival and `session_end` in the incident that motivated this phase, giving roughly 4x headroom.

## Deviations from Plan

### Judgment calls on ambiguous/inconsistent plan prose (not Rule 1-4 auto-fixes — plan-authoring imprecisions resolved in favor of the higher-authority bar)

**1. Task 1 step 11's "the booth is still BUSY" clause dropped from the load-bearing dual-completion assertion**
- **Found during:** Task 1, writing `test/queue-dual-completion.test.ts`
- **Issue:** The action text for the load-bearing test case asks to assert, after a stray second `session_end` arrives while guest B (job-2) is dispatched and acknowledged, that "the booth is still BUSY." But Task 1 step 9's own `sessionEnded()` spec is unconditional: whenever `current_job_id` is bound (which it is — job-2 is acked), `sessionEnded()` always releases the booth (`setBoothIdle()` + `tick()`), regardless of which physical session's duplicate this is (the payload carries no identity at all). Tracing the design by hand confirms the booth ends **IDLE**, not BUSY, after this second call — there is no distinguishing mechanism in the spec that would keep it BUSY.
- **Resolution:** The plan's `must_haves.truths` and Task 1's own `acceptance_criteria` (the higher-authority, actually-graded bars) both state only that job-2's *status* stays `in_progress` and `completeJob` is never called with `'job-2'` — neither requires the booth to stay BUSY. The test asserts exactly what the acceptance criteria require and what the traced design actually produces; it does not assert the unreachable "still BUSY" claim. This is the correct, most valuable guarantee: the misattribution bug (SC-2's core concern) is what's fixed; the booth's premature-release side effect on a stray duplicate is an honestly-scoped residual behavior, unchanged from what D-02's split was designed to address.
- **Files modified:** `test/queue-dual-completion.test.ts`
- **Committed in:** `049e53d`

**2. The <verification> block's "double-fire assertion in test/queue-dual-completion.test.ts... goes red" claim does not hold structurally for the mocked-store test**
- **Found during:** Task 1, running the plan's non-vacuity mutation (removing `AND status = 'in_progress'` from `completeJob`'s SQL)
- **Issue:** The plan's `<verification>` section asks to confirm BOTH `test/queue-dual-completion.test.ts`'s double-fire assertion AND `test/local-store-persistence.test.ts`'s duplicate-completion case go red under this mutation. `queue-dual-completion.test.ts` uses a fully mocked `LocalStore` whose `completeJob` is independent JS logic (`if (jobStatus[jobId] !== 'in_progress') return false; ...`) — it never calls the real SQL in `localStore.ts` at all, so mutating that SQL cannot possibly affect it.
- **Resolution:** Ran the mutation and confirmed `test/local-store-persistence.test.ts`'s real-database cases go red exactly as required (2 failures: duplicate-completion and terminal-row cases). `test/queue-dual-completion.test.ts` stayed green, which is the structurally correct and only possible outcome for a mocked-store test under a production-SQL mutation. The real guarantee — that the `AND status = 'in_progress'` predicate is what makes the double-fire and duplicate-session_end idempotent — is genuinely proven at the SQL layer, which is what the `<sc2_reconciliation>` section itself explains is the mocked test's known limitation and the real-store companion's whole reason to exist. Reverted the mutation before continuing (confirmed byte-identical to pre-mutation `localStore.ts`).
- **Files modified:** none (mutation reverted, no code change)
- **Verified:** `test/local-store-persistence.test.ts` — 2 of 26 cases red under the mutation, all 26 green after revert

---

**Total deviations:** 2 judgment calls, both plan-prose corrections favoring the plan's own higher-authority acceptance criteria / structural reality; zero Rule 1-4 auto-fixes were needed.
**Impact on plan:** None on scope or correctness — both are documentation-of-intent corrections, not code changes beyond what the plan's acceptance criteria already required.

## Issues Encountered

None beyond the two deviations above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plans 07-02 through 07-05 can proceed: the completion/release split, `booth_state.current_job_id`, and `onPrintComposite()` are the foundation 07-03's pending-print registry and 07-04's no-photo outcome build on.
- The Agent-untouched constraint (D-05) held throughout: `git -C dslrbooth-agent status --porcelain` is empty.
- No blockers. `npm test`: 39 files / 357 tests green (baseline 36/335); `npm run typecheck` and `npm run build` both exit 0.

---
*Phase: 07-session-lifecycle-retake*
*Completed: 2026-08-12*

## Self-Check: PASSED

All created files and referenced commit hashes verified present on disk / in `git log`:
- `mirror-request/test/queue-dual-completion.test.ts`, `test/queue-retake-anchor.test.ts`, `test/queue-release-timer.test.ts` — FOUND
- `mirror-request/src/state/localStore.ts`, `src/queue/queueService.ts`, `src/config.ts`, `src/types.ts`, `test/local-store-persistence.test.ts` — FOUND
- Commits `049e53d`, `2974e48`, `d0d6239`, `af8aef4`, `3015aa9` — FOUND in `git log`
