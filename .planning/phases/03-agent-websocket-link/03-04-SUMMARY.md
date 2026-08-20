---
phase: 03-agent-websocket-link
plan: 04
subsystem: queue-dispatch
tags: [queue, disconnect, retry-policy, event-handling, agt-03, agt-04]
dependency-graph:
  requires:
    - phase: "03-02"
      provides: "AgentServer.registerDisconnectHandler() — a no-op-defaulted seam fired exactly once per real disconnect (clean close or heartbeat eviction), never for a stale/displaced socket"
    - phase: "03-03"
      provides: "QueueService.bindIsAgentOnline() connectivity gate and the dispatch payload's mode field, both landed in the same file this plan edits"
  provides:
    - "LocalStore.requeueNoRetry(jobId): a deliberate sibling of requeueWithRetry() that omits both queued_at (D-06 place-in-line) and the retries increment (D-01/D-12 — a system-side fault never spends the guest's budget)"
    - "QueueService.onAgentDisconnected(): D-13's mutual exclusion with the busyTimer, proven in both trigger orders"
    - "onAgentEvent()'s final else: a debug-level fallback log line for the seven previously-silent AGT-04 event types, plus any future/unrecognised type"
  affects:
    - "03-05 (OPS-RUNBOOK.md) quotes the exact disconnect-requeue warning text and the fallback log line format recorded below"
tech-stack:
  added: []
  patterns:
    - "Deliberate sibling method (requeueNoRetry beside requeueWithRetry) instead of a parameterized/branching shared method — keeps the D-01 contrast (session-side charges, system-side doesn't) legible at the call site rather than hidden inside a conditional"
    - "Mutual exclusion via existing state read + explicit timer cancellation, no lock/flag — relies on Node's single-threaded event loop guarantee that a timer callback and a socket-close callback are separate macrotasks that can never interleave"
    - "Exhaustive fallthrough (final else + debug log) for an externally-driven event enum, so an unhandled or future case is recorded rather than silently dropped — same idiom agentServer.ts already used for unknown WS message types"
key-files:
  created:
    - mirror-request/test/agent-disconnect-requeue.test.ts
    - mirror-request/test/queue-event-coverage.test.ts
  modified:
    - mirror-request/src/state/localStore.ts
    - mirror-request/src/queue/queueService.ts
decisions:
  - "onAgentDisconnected() never calls handleStall() — confirmed structurally by grep: this.handleStall( still has exactly 3 call sites (recover()'s sweep, the busyTimer callback, the NAK branch), same as before this plan."
  - "D-13's mutual exclusion needed no lock, mutex, or in-flight flag: the `!== 'BUSY'` guard covers 'the busyTimer already won' and clearBusyTimer() covers 'the disconnect wins', and Node's single-threaded event loop makes a timer callback and a socket-close callback mutually exclusive by construction — both orders are proven by named test cases with count assertions, not by reasoning alone."
  - "The mocked-store tests bind connectivity through a mutable local flipped to false at the moment of disconnect, per the plan's explicit guidance — this both matches what really happens (a dead Agent is also offline) and keeps onAgentDisconnected()'s trailing tick() call from immediately re-announcing the same job and muddying the assertions."
  - "AGT-03's regression proof was split into two separate test cases (positive-ack-unchanged, NAK-vs-disconnect budget contrast) rather than one combined case, to reach the plan's 'at least 7 passing cases' floor for agent-disconnect-requeue.test.ts cleanly rather than padding an unrelated case."
  - "onAgentEvent()'s fallback is deliberately NOT wired against types.ts's AgentMessage interface (confirmed dead: grep -c 'AgentMessage' src/queue/queueService.ts -> 0) — its eventType union only lists three of the ten real types and its field name doesn't match the wire field agentServer.ts actually reads."
metrics:
  duration: "~25 min (autonomous, no checkpoints)"
  completed: 2026-08-10
status: complete
actuals:
  tokens: 5217
  tasks: 2
  commits: 2
---

# Phase 3 Plan 04: Disconnect Requeue Policy & Full Event Coverage Summary

A dead Agent now costs the guest seconds, not the full five-minute session timeout, and costs
them nothing else — no lost retry, no lost place in line — while Phase 2's bounded retry policy
keeps exactly its three original call sites; and all ten AGT-04 event types now reach a defined
outcome instead of three handled and seven silently dropped.

## What Was Built

**Task 1 — commit `3e81b11`:**
- `LocalStore.requeueNoRetry(jobId): void` added immediately after `requeueWithRetry()` in
  `src/state/localStore.ts`: `UPDATE queue_job SET status = 'queued' WHERE id = ?` — no `retries`
  increment, no `queued_at` write, no return value, no parameter. A deliberate sibling, not a
  variant: the SET list's omissions are themselves the guarantees (D-06's place-in-line, D-01/D-12's
  no-charge-for-a-system-fault).
- `QueueService.onAgentDisconnected(): void` added in `src/queue/queueService.ts`, beside
  `onAgentAck`/`onAgentEvent`: guards on `getBoothState() !== 'BUSY'` (early-returns when the
  busyTimer already resolved the job), then `clearBusyTimer()` (cancels a still-pending timer so it
  cannot also resolve the same job), `setBoothIdle()`, and a loop over `getInFlightJobs()` calling
  `requeueNoRetry()` on each — reusing Phase 2's existing "what is in flight" source of truth rather
  than tracking a job id in a new field. Ends with `this.tick()` so the queue can immediately
  re-announce the next guest (or the same one) once the Agent reconnects.
- `createQueueService()` gained one wiring line:
  `agentServer.registerDisconnectHandler(() => qs.onAgentDisconnected());` — the last of plan
  03-02's three no-op-defaulted seams to be consumed.
- New `test/agent-disconnect-requeue.test.ts` (7 cases): a real-SQL block proving
  `requeueNoRetry()` against actual SQLite (see "Observed Real-SQL Values" below), and a
  mocked-store block covering both D-13 trigger orders with count assertions, the IDLE no-op case,
  the two-in-flight sweep, and AGT-03's regression proof split into two cases (positive ack
  unchanged; NAK-vs-disconnect budget contrast).

**Task 2 — commit `57d5ba4`:**
- `onAgentEvent()`'s `if/else if` chain gained a final `else`:
  `` queueLogger.debug(`Unhandled Agent event: ${eventType}${jobId ? ` (job ${jobId})` : ''}`) ``.
  The three existing branches (`session_end`, `session_start`, `file_upload`) are untouched,
  byte-for-byte. The seven previously-silent types (`countdown_start`, `countdown`,
  `capture_start`, `file_download`, `processing_start`, `sharing_screen`, `printing`) now each
  produce exactly one debug-level log line naming the event type — and so does any type nobody has
  named yet, since the Agent forwards every dslrBooth event verbatim.
- Deliberately not wired against `types.ts`'s `AgentMessage.eventType` union — confirmed dead code
  (a workspace grep finds only its own declaration) and its field name doesn't match the wire field
  `agentServer.ts` actually reads.
- New `test/queue-event-coverage.test.ts` (6 cases): all ten named types plus one invented type
  driven through `onAgentEvent()` via `vi.spyOn(queueLogger, 'debug')` (required because
  `LOG_LEVEL=error` means a real transport never emits debug); asserts the exact fallback count
  (seven), that each fallback message contains its event type's name, that an unrecognised type
  also produces a fallback line, and — separately — that the three handled types still produce
  their real effects (completion, `in_progress` status write, notification call) rather than being
  accidentally routed into the fallback.

## Answers to the Plan's Explicit Output Questions

**Observed real-SQL values, before and after `requeueNoRetry()`** (from
`test/agent-disconnect-requeue.test.ts`'s real-SQL block, driven against actual SQLite via
`new LocalStore(dbPath)`, not a mock):

| | Before | After `requeueNoRetry()` |
|---|---|---|
| `status` | `dispatched` | `queued` |
| `retries` | `2` | `2` (unchanged) |
| `queued_at` | `5000` | `5000` (byte-identical) |

**Exact wording of the requeue warning:**
`` `Job ${job.id} requeued after Agent disconnect (no retry charged)` `` — logged once per in-flight
job swept, at `warn` level (`src/queue/queueService.ts:214`).

**Fallback log line's final format:**
`` `Unhandled Agent event: ${eventType}${jobId ? ` (job ${jobId})` : ''}` `` — logged at `debug`
level (`src/queue/queueService.ts:227`). For a job-scoped event this reads e.g.
`Unhandled Agent event: countdown (job job-abc)`; for a payload-only event with no `jobId`, e.g.
`Unhandled Agent event: countdown_start`.

## Deviations from Plan

None — plan executed exactly as written. Every grep-count acceptance criterion was simulated
against the actual edits before asserting (per this project's stated acceptance-criteria
discipline) and all matched on the first attempt:

- `requeueNoRetry` in `localStore.ts` (non-comment) → 1
- `retries = retries + 1` in `localStore.ts` (non-comment) → 1 (unchanged — the new sibling did
  not copy Phase 2's increment)
- `requeueNoRetry` in `queueService.ts` (non-comment) → 1
- `onAgentDisconnected` in `queueService.ts` (non-comment) → 2 (definition + wiring call)
- `this.handleStall(` in `queueService.ts` (non-comment) → 3 (unchanged from Phase 2:
  `recover()`'s sweep, the `busyTimer` callback, the NAK branch)
- `queueLogger.debug` in `queueService.ts` (non-comment) → 2 (the pre-existing NAK line in
  `onAgentAck()` and the new event fallback)
- `AgentMessage` in `queueService.ts` → 0 (the dead interface was not revived)
- `getStore` across both new test files → 0

One structural note, not a deviation: Task 1 and Task 2 both edit `src/queue/queueService.ts`
(the disconnect method + wiring line vs. the final `else` branch), in non-overlapping hunks. To
keep each task's commit atomic and reviewable independently, Task 2's `else` branch was written
and then temporarily removed via a scoped edit before Task 1's commit, then restored immediately
afterward before Task 2's commit — the working tree was verified clean and the full suite green
both before and after this reorder, so no functional state existed outside either commit's
intended scope at any point.

## Auth Gates

None. No CLI authentication was required for this plan.

## Known Stubs

None. Both `requeueNoRetry()` and the event fallback are complete, production-shaped
implementations on their single path — the fallback deliberately does nothing more than log,
which is the plan's own stated definition of "processed" for the seven event types that have no
queue-state implication (D-14), not a placeholder standing in for missing behavior.

## Threat Flags

None beyond what the plan's own `<threat_model>` already registered (T-03-19 through T-03-23) —
no new surface was introduced outside that register.

## Verification

- `cd mirror-request && npx vitest run test/agent-disconnect-requeue.test.ts` — 7/7 passing
- `cd mirror-request && npx vitest run test/queue-event-coverage.test.ts` — 6/6 passing
- `cd mirror-request && npm test` — **23 files, 155 tests, all green** (142 pre-existing at the
  start of this plan + 13 new: 7 in `agent-disconnect-requeue.test.ts`, 6 in
  `queue-event-coverage.test.ts`), run twice back-to-back with identical results
- `cd mirror-request && npm run typecheck` — clean after both tasks
- Working tree clean inside `mirror-request/` after both commits (`git status --short` empty)
- `dslrbooth-agent/` untouched throughout this plan (`git status --short` empty)
- Neither obsolete `.planning/` tree (`mirror-request/.planning/`, `dslrbooth-agent/.planning/`)
  was read or written during this plan — confirmed via `git status --short -- .planning` in both
  repos after the `roadmap.update-plan-progress` and `requirements.mark-complete` invocations,
  both run from `/opt/mirror_request_dslrobooth` (the workspace root), not from inside either repo

## Self-Check: PASSED

- FOUND: `/opt/mirror_request_dslrobooth/mirror-request/test/agent-disconnect-requeue.test.ts`
- FOUND: `/opt/mirror_request_dslrobooth/mirror-request/test/queue-event-coverage.test.ts`
- FOUND: commit `3e81b11` (Task 1)
- FOUND: commit `57d5ba4` (Task 2)
- All acceptance-criteria grep gates listed above verified to match their required counts exactly
- AGT-03 and AGT-04 marked `[x]` in `/opt/mirror_request_dslrobooth/.planning/REQUIREMENTS.md`

## Next Phase Readiness

Phase 3's last content plan (`03-05-PLAN.md`, `OPS-RUNBOOK.md` §7) is unblocked — it can now quote
the exact disconnect-requeue warning text and event-fallback log format recorded above, alongside
plan 03-01's auth contract and plan 03-03's skip-warning wording. No blockers.

---
*Phase: 03-agent-websocket-link*
*Completed: 2026-08-10*
