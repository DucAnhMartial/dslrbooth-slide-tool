---
phase: 03-agent-websocket-link
plan: 03
subsystem: queue-dispatch
tags: [queue, dispatch, connectivity-gate, retry-budget, agt-02]
dependency-graph:
  requires:
    - phase: "03-01"
      provides: "Authorization: Bearer auth; AgentServer.isAgentOnline() already exists and is read here through a callback, never by importing the class"
  provides:
    - "QueueService.bindIsAgentOnline(cb): the connectivity read seam, defaulting to online so every pre-Phase-3 test keeps its meaning"
    - "A two-checkpoint connectivity gate (tick() and dispatchJob()) that costs the guest zero retries on a booth outage"
    - "The dispatch command payload actually carries {type, action, jobId, mode} — AGT-02 satisfied for the first time"
  affects:
    - "03-04 (disconnect requeue policy) reuses this file's mock harness shape for its own new test file, per this plan's output instruction"
tech-stack:
  added: []
  patterns:
    - "Two-checkpoint connectivity gate: primary at tick() (before any state mutation, so an offline booth never leaves IDLE), secondary at dispatchJob() (closes the 5-10s ANNOUNCING countdown race) — the same shape 03-02 used for connection ids: gate at the earliest safe point, not only at the point of failure"
    - "Once-per-state-change logging via a single boolean flag, set on first skip and cleared only when the gate is passed again — same idiom as 03-02's disconnect seam's 'fire exactly once' guarantee"
key-files:
  created:
    - mirror-request/test/queue-dispatch-connectivity.test.ts
    - mirror-request/test/queue-dispatch-mode.test.ts
  modified:
    - mirror-request/src/queue/queueService.ts
    - mirror-request/test/queue-recovery.test.ts
    - mirror-request/test/queue-timeout-retry.test.ts
    - mirror-request/test/queue-config-injection.test.ts
    - mirror-request/test/queue-countdown.test.ts
decisions:
  - "The tick() gate returns before any state mutation (before beginAnnouncement()), not inside dispatchJob() alone — this is what makes D-03's once-per-outage wording achievable, since an offline booth never leaves IDLE and therefore never begins a fresh countdown that would need its own skip line."
  - "The dispatchJob() gate sets agentOfflineDispatchSkipLogged = true BEFORE calling this.tick() — required because the immediate re-entrant tick() call would otherwise find the same offline booth and same queued job and log a second, duplicate warning for one event."
  - "getJobRegistration() lookup happens after the connectivity guard but before the status write, so a disconnect during the countdown never triggers a wasted DB read — task 1's guard and task 3's lookup compose in a single early-return chain."
  - "The countdown regression guard's known mode was set to 'boomerang' — deliberately not 'print' (the Agent's hardcoded fallback per 03-RESEARCH.md), so a regression that silently drops the field again cannot pass by coincidence."
metrics:
  duration: "~10 min (autonomous, no checkpoints)"
  completed: 2026-08-10
status: complete
actuals:
  tokens: 5409
  tasks: 3
  commits: 3
---

# Phase 3 Plan 03: Dispatch Connectivity Gate & Mode Field Summary

Stopped the queue from feeding guests into a booth that is not there, and made the dispatch
command finally carry the mode the guest registered for — both defects confirmed live in
`queueService.ts` this session, both closed with additive, unconditionally-reversible changes.

## What Was Built

**Task 1 — commit `49bbb4d`:**
- Added `private isAgentOnlineCb: () => boolean = () => true;` and
  `private agentOfflineDispatchSkipLogged = false;` to `QueueService`, plus
  `bindIsAgentOnline(cb: () => boolean): void`.
- Gated `tick()` immediately after `getNextQueuedJob()` returns a job and before
  `beginAnnouncement(job)` runs: if the Agent is offline, the tick returns before any state
  mutation (no `setBoothState`, no status write, no retry increment), logging exactly once per
  outage via the flag. The flag resets the moment the gate is passed with the Agent online.
- Gated `dispatchJob()` as its first statement: if the Agent dropped during the 5-10s ANNOUNCING
  countdown, the function returns the booth to IDLE via `setBoothIdle()`, sets the skip-logged
  flag, and re-invokes `tick()` — with nothing to unwind, since the job was never marked
  `dispatched` and the busy timer was never armed.
- `createQueueService()` wires the read: `qs.bindIsAgentOnline(() => agentServer.isAgentOnline());`
  inside the existing `if (agentServer)` block, alongside the three bindings already there.
- New `test/queue-dispatch-connectivity.test.ts` (6 cases): forty consecutive offline ticks
  produce exactly one warning with no announcement/status write/command/retry; flipping
  connectivity to true lets the very next ordinary tick announce and the countdown dispatch; a
  second outage after a resumed period produces a second warning; a disconnect mid-countdown
  leaves the job untouched, the booth IDLE, and produces exactly one further warning (the
  re-entrant `tick()` call does not double-log); an unbound `QueueService` dispatches exactly as
  before; and a fully-offline period never invokes the send-command callback at all.

**Task 2 — commit `da18418`:**
- Added `getJobRegistration: () => undefined,` to all 6 hand-built store literals in
  `test/queue-recovery.test.ts`, the 1 literal in `test/queue-timeout-retry.test.ts`, and the 1
  literal in `test/queue-config-injection.test.ts` — 8 lines across 3 files, zero production
  changes, verified by `git show --name-only HEAD -- src/` returning empty. This is preparation
  only: without it, task 3's `this.store.getJobRegistration(job.id)` call would have turned these
  four unrelated pre-existing test files red with a "not a function" error that would look like a
  Phase 2 regression rather than a missing mock method.

**Task 3 — commit `90f5654`:**
- Inside `dispatchJob()`, after task 1's connectivity guard and before the status write:
  `const registration = this.store.getJobRegistration(job.id)?.registration;` then
  `this.sendCommandCb?.({ type: 'command', action: 'start_session', jobId: job.id, mode:
  registration?.mode });`. Composition only — the callback's payload type already declared an
  optional `mode` and `createQueueService()` already forwarded `mode: cmd.mode` into
  `agentServer.sendCommand()`; the field had simply never been set.
- `getNextQueuedJob()`'s query was **not** touched — `getJobRegistration()` already performs the
  exact join needed, and no second lookup mechanism was introduced (`JOIN registration` count in
  `localStore.ts` unchanged at 1).
- New `test/queue-dispatch-mode.test.ts` (3 cases): the captured command equals the full
  `{type, action, jobId, mode}` object with a distinctive mode (`'gif360'`, not the Agent's
  hardcoded fallback); the registration lookup is called exactly once with the dispatched job's
  id; a job with no matching registration row still dispatches, with `mode` absent and no throw.
- `test/queue-countdown.test.ts` — both hand-built store literals gained `getJobRegistration`:
  the first `describe`'s store returns `() => undefined` (it never asserts on the payload's
  mode); `buildStore()`'s store now returns a real registration carrying `mode: 'boomerang'`. The
  pre-existing "booth state transitions" case asserting the exact command payload was extended to
  assert the mode too, upgrading it into a live AGT-02 regression guard — its title now reads
  "…shaped {type, action, jobId, mode} (QUE-03, AGT-02)".

## Answers to the Plan's Explicit Output Questions

**Exact wording of both skip warnings** (for 03-04's disconnect tests, which reuse this file's
mock shape, to match against if needed):
- Tick-gate warning: `` `Skipping dispatch: Agent not connected (job ${job.id} stays queued)` ``
- Dispatch-gate warning: `` `Skipping dispatch: Agent disconnected during announcement (job ${job.id} stays queued)` ``

**Did the forty-tick case need any adjustment to the tick arithmetic?** No. The test's injected
`NEXT_GUEST_COUNTDOWN_MS: 5_000` and the service's fixed 250ms tick interval mean
`vi.advanceTimersByTime(10_000)` fires exactly 40 ticks, matching the plan's own arithmetic on the
first attempt — no correction was needed.

**Mode value chosen for the countdown regression guard:** `'boomerang'` in
`queue-countdown.test.ts`'s `buildStore()`. `queue-dispatch-mode.test.ts` deliberately uses a
*different* distinctive value, `'gif360'`, so the two new test files can never coincidentally
agree with each other or with the Agent's hardcoded fallback (`'print'`) by accident.

## Deviations from Plan

None — plan executed exactly as written. Every grep-count acceptance criterion was simulated
against the actual edits before asserting (per this project's stated acceptance-criteria
discipline) and all matched on the first attempt:

- `bindIsAgentOnline` → 2 (method definition + wiring call)
- `isAgentOnlineCb` → 4 (field, binder assignment, tick() guard, dispatchJob() guard)
- `agentOfflineDispatchSkipLogged` → 5 (field, tick's `if`, tick's `= true`, tick's reset
  `= false`, dispatchJob's `= true`)
- `getStore` across both new test files → 0
- `getJobRegistration` in `src/queue/queueService.ts` → 1
- `getJobRegistration` in `queue-recovery.test.ts` → 6, `queue-timeout-retry.test.ts` → 1,
  `queue-config-injection.test.ts` → 1, `queue-countdown.test.ts` → 2
- `git show --name-only HEAD -- src/` for task 2's commit → empty (0 production files touched)
- `JOIN registration` in `localStore.ts` → 1 (unchanged — `getNextQueuedJob()` was not rewritten)
- `this.handleStall(` call sites → still exactly 3 (task 1's no-dispatch path never routes
  through the retry-charging policy, confirmed unchanged)

## Auth Gates

None. No CLI authentication was required for this plan.

## Known Stubs

None. Both changes are complete, production-shaped implementations on their single path — the
connectivity gate is a real behavioral guard (not a placeholder), and the `mode` field now
carries a real value sourced through the existing `getJobRegistration()` join.

## Threat Flags

None beyond what the plan's own `<threat_model>` already registered (T-03-14 through T-03-18) —
no new surface was introduced outside that register. T-03-17 (unconstrained guest-supplied
`mode` string) remains an explicitly accepted, pre-existing Phase 1 trust boundary per the plan's
own disposition; this plan made an already-trusted-through field arrive, and neither widened nor
narrowed that boundary.

## Verification

- `cd mirror-request && npx vitest run test/queue-dispatch-connectivity.test.ts` — 6/6 passing
- `cd mirror-request && npx vitest run test/queue-dispatch-mode.test.ts` — 3/3 passing
- `cd mirror-request && npx vitest run test/queue-countdown.test.ts` — 8/8 passing
- `cd mirror-request && npm test` — **21 files, 142 tests, all green** (133 pre-existing at the
  start of this plan + 9 new: 6 in `queue-dispatch-connectivity.test.ts`, 3 in
  `queue-dispatch-mode.test.ts`)
- `cd mirror-request && npm run typecheck` — clean after every task
- Working tree clean inside `mirror-request/` after all three commits (`git status --short`
  empty)

## Self-Check: PASSED

- FOUND: `/opt/mirror_request_dslrobooth/mirror-request/test/queue-dispatch-connectivity.test.ts`
- FOUND: `/opt/mirror_request_dslrobooth/mirror-request/test/queue-dispatch-mode.test.ts`
- FOUND: commit `49bbb4d` (Task 1)
- FOUND: commit `da18418` (Task 2)
- FOUND: commit `90f5654` (Task 3)
- Working tree clean inside `mirror-request/` after all three commits
- `cd mirror-request && npm test` — 21 files / 142 tests, all passing
- `cd mirror-request && npm run typecheck` — clean
- All acceptance-criteria grep gates listed above verified to match their required counts exactly
- `dslrbooth-agent/` left untouched throughout this plan
- Neither obsolete `.planning/` tree (`mirror-request/.planning/`, `dslrbooth-agent/.planning/`)
  was read for planning content during this plan. **One incidental write occurred and was
  reverted**: an early `roadmap.update-plan-progress` invocation resolved its runtime root from
  the current working directory (inside the `mirror-request/` git repo) rather than the
  workspace root, and wrote to the stale, tracked `mirror-request/.planning/ROADMAP.md` instead
  of the authoritative tree. Caught immediately via `git status`/`git diff` on that file, reverted
  with a scoped `git checkout -- .planning/ROADMAP.md` (not a blanket reset), and the subsequent
  invocation was re-run with `RUNTIME_DIR` exported explicitly to the workspace root so it
  targeted the authoritative `/opt/mirror_request_dslrobooth/.planning/` tree instead.
