---
phase: 02-queue-booth-state
plan: 04
subsystem: queue
tags: [vitest, fake-timers, state-machine, config-injection, sqlite, ops]

# Dependency graph
requires:
  - phase: 02-queue-booth-state
    plan: 02-01
    provides: "QueueService typed config injection (SESSION_TIMEOUT_MS, NEXT_GUEST_COUNTDOWN_MS, SESSION_MAX_RETRIES), handleStall(), recover()"
  - phase: 02-queue-booth-state
    plan: 02-02
    provides: "Both live stall paths (busyTimer timeout, Agent NAK) routed through handleStall()"
  - phase: 02-queue-booth-state
    plan: 02-03
    provides: "docs/OPS-RUNBOOK.md section 5 (transition table) checked against this plan's assertions, section 6 (backup-before-mutate procedure) used during the Task 3 checkpoint"
provides:
  - "test/queue-config-injection.test.ts — proves every queue timing/retry knob follows the injected typed config, never process.env (D-13)"
  - "test/queue-countdown.test.ts 'booth state transitions' describe block — the full IDLE->ANNOUNCING->BUSY->IDLE sequence, the exact Agent command payload shape, and the session_end auto-advance, asserted end to end (QUE-03, QUE-04, BTH-01)"
  - "Live production restart verification: the confirmed-stuck booth_state (BUSY since 2026-08-10T04:29:42.732Z) is now IDLE and fresh, all 4 stranded dispatched rows and job-webhook-001 were deleted by operator decision (not retried, not failed-in-place), and the recovery warn+info log lines were observed reaching the masked Winston pipeline in real production output"
  - "Phase 2 (Queue & Booth State) closed — all 6 requirements (QUE-01..04, BTH-01..02) marked complete"
affects: [03-agent-websocket-link]

# Actuals (#2632)
actuals:
  tokens: 13200
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "A dedicated hand-built mock per describe block (never getStore()) that records an ordered array of every booth-state write, not just the latest value — lets a case assert the exact transition sequence rather than a single snapshot"

key-files:
  created:
    - mirror-request/test/queue-config-injection.test.ts
  modified:
    - mirror-request/test/queue-countdown.test.ts
    - mirror-request/.gitignore

key-decisions:
  - "Task 1's retry-budget cases drive the mocked requeueWithRetry spy with a pre-set sequence of return values (retries: 1, 2, 3, 4) rather than a real counter, so each case can pin exactly which stall crosses the injected SESSION_MAX_RETRIES ceiling without depending on internal state."
  - "Task 2's new describe block builds its own mock rather than reshaping queue-countdown.test.ts's pre-existing one, per the plan's explicit instruction — the pre-existing FIFO-order case is untouched and still green as a regression signal."
  - "Checked task 2's assertions against docs/OPS-RUNBOOK.md section 5's transition table per the plan's instruction (action step 5): no discrepancy found between the code's actual transitions and the table 02-03 wrote."
  - "Task 3 (the blocking human-verify checkpoint over the live production database) was executed in two phases: this agent gathered read-only BEFORE-state evidence and computed the concrete delay (correctly identifying the dist/ staleness risk); the coordinator/human then performed the actual build, backup, mutation, and restart, since this agent was never authorized to do so."
  - "HUMAN DECISION (Task 3): none of the 5 non-terminal queue_job rows represented a live guest — the 4 stranded registrations were 3.8 days old and job-webhook-001 was 3.4 days old (queued 2026-08-07, checked 2026-08-10), essentially as stale as the rows it was 'waiting behind.' The human chose to delete all 5 rows outright rather than let the bounded retry policy run them out (~10 min/job) or mark them failed-in-place. This is a data decision outside D-01..D-13's scope, made explicitly by the human per the checkpoint's design."
  - "booth_state was deliberately left at its stuck BUSY value through the backup/delete step, so the subsequent restart still had to exercise recover()'s real age-check-and-reset path rather than starting from an already-clean IDLE state — preserving the phase's actual acceptance signal (a real restart fixing a real stuck booth, not a restart of an already-fixed database)."
  - "Added data/backups/ to .gitignore (Task 3's only source-tree change): the operator's pre-mutation SQLite backup, created per docs/OPS-RUNBOOK.md §6's 'take a backup first' instruction, isn't covered by the existing data/*.sqlite* rules and carries the same PII/sensitivity posture as the live database file (§2) — it must never enter git history."

patterns-established:
  - "Retry-budget test cases drive a spy's return-value sequence explicitly (mockReturnValueOnce-style array) rather than reimplementing the retries counter, keeping the test's assertion about the injected ceiling independent of how the real counter increments."
  - "A manual pre-mutation database backup (docs/OPS-RUNBOOK.md §6) goes to data/backups/*.<ISO-timestamp>.bak, gitignored alongside the live SQLite files it backs up."

requirements-completed: [QUE-03, QUE-04, BTH-01]
# QUE-01, QUE-02, and BTH-02 were already marked complete by earlier plans
# in this phase (02-01, 02-03); this plan closes out the remaining three,
# completing all 6 of Phase 2's requirements.

coverage:
  - id: D1
    description: "The queue's countdown, session timeout and retry budget provably come from the typed config object injected at construction, never from process.env, with the 5-10s announcement clamp holding at both ends (D-13)"
    requirement: "QUE-03"
    verification:
      - kind: unit
        ref: "test/queue-config-injection.test.ts#an injected 9000ms countdown dispatches at exactly 9000ms — not at 8999ms, not at the 7000ms default"
        status: pass
      - kind: unit
        ref: "test/queue-config-injection.test.ts#a configured countdown of 3000ms clamps up to the 5000ms floor"
        status: pass
      - kind: unit
        ref: "test/queue-config-injection.test.ts#a configured countdown of 30000ms clamps down to the 10000ms ceiling"
        status: pass
      - kind: unit
        ref: "test/queue-config-injection.test.ts#an injected 12000ms session timeout stalls the job at exactly 12000ms after dispatch — not at the 300000ms default"
        status: pass
      - kind: unit
        ref: "test/queue-config-injection.test.ts#a retry budget of 0 fails the job on its first stall instead of requeueing it"
        status: pass
      - kind: unit
        ref: "test/queue-config-injection.test.ts#a retry budget of 3 survives three stalls and fails the job on the fourth"
        status: pass
      - kind: unit
        ref: "test/queue-config-injection.test.ts#environment variables set to conspicuously different values before construction change none of the injected timing"
        status: pass
      - kind: unit
        ref: "test/queue-config-injection.test.ts#constructed with no config argument at all, the service still works and uses the config.ts defaults — 7000ms countdown"
        status: pass
    human_judgment: false
  - id: D2
    description: "IDLE with a queued job transitions to ANNOUNCING, then to BUSY on dispatch, and the Agent command carries {type, action, jobId}; while ANNOUNCING or BUSY no second job is announced or dispatched (QUE-03, BTH-01, D-09, D-10)"
    requirement: "QUE-03"
    verification:
      - kind: unit
        ref: "test/queue-countdown.test.ts#IDLE with two queued guests: the first tick writes ANNOUNCING and sends no Agent command; getAnnouncement() reports the first guest"
        status: pass
      - kind: unit
        ref: "test/queue-countdown.test.ts#while ANNOUNCING, further ticks announce nothing else and dispatch nothing — the second guest waits"
        status: pass
      - kind: unit
        ref: "test/queue-countdown.test.ts#the countdown elapsing: booth is BUSY, the job is dispatched, and exactly one command is sent shaped {type, action, jobId} (QUE-03)"
        status: pass
      - kind: unit
        ref: "test/queue-countdown.test.ts#session_start moves the job to in_progress and leaves the booth BUSY; no second guest is announced"
        status: pass
    human_judgment: false
  - id: D3
    description: "session_end returns the booth to IDLE, completes the in-flight job, and the next queued guest is announced without operator action (QUE-04)"
    requirement: "QUE-04"
    verification:
      - kind: unit
        ref: "test/queue-countdown.test.ts#session_end completes the in-flight job, returns the booth to IDLE, and announces the second guest without further external input (QUE-04)"
        status: pass
      - kind: unit
        ref: "test/queue-countdown.test.ts#neither requeueWithRetry nor failJob is called anywhere on the happy path"
        status: pass
      - kind: unit
        ref: "test/queue-countdown.test.ts#after stop(), advancing timers produces no further dispatch"
        status: pass
    human_judgment: false
  - id: D4
    description: "The live production database recovers on the first restart after this phase ships: the booth leaves its stuck BUSY state and the stranded jobs are resolved (D-01, D-02, BTH-01)"
    requirement: "BTH-01"
    verification:
      - kind: manual_procedural
        ref: "docs/OPS-RUNBOOK.md §6 read-only inspection query, run before and after a real `npm run build && node dist/index.js` restart against mirror-request/data/extension-service.sqlite"
        status: pass
    human_judgment: true
    rationale: "This is Task 3, a blocking checkpoint over real persisted production state that no unit test can simulate. Resolved: the coordinator backed up the database, deleted the 5 non-terminal queue_job rows (human decision — none represented a live guest), deliberately left booth_state at its stuck BUSY value, then rebuilt and restarted the real service. The startup log showed the recovery path firing exactly as designed ('Booth timeout reset: restart recovery: booth was BUSY at startup', 'Recovery complete: booth was BUSY, swept 0 in-flight job(s)') and the AFTER read-only query confirmed booth_state=IDLE with a fresh updated_at. Recorded here as human_judgment:true (not auto-pass) because the deliverable is inherently a human sign-off event, not something a future automated run reproduces — the pass status reflects that sign-off already happened, not that it could be re-derived mechanically."

# Metrics
duration: 34min
completed: 2026-08-10
status: complete
---

# Phase 2 Plan 4: Config Injection, Transition-Sequence Proof & Live Restart Verification Summary

**Proved every queue timing/retry knob follows the injected typed config (never process.env), pinned the full IDLE→ANNOUNCING→BUSY→IDLE transition sequence with the exact Agent command payload end to end, and verified — against a real restart of the real production service — that the confirmed-stuck booth (BUSY since 2026-08-10T04:29:42.732Z) recovers. Phase 2 is closed: all 6 requirements complete.**

## Performance

- **Duration:** ~34 min total (Tasks 1-2: ~11 min; checkpoint pause + Task 3 resolution: ~23 min)
- **Started:** 2026-08-10T10:55:08Z (session resume, per STATE.md)
- **Completed:** 2026-08-10T11:29:00Z (approx — after checkpoint resolution and Task 3 close-out)
- **Tasks:** 3 of 3
- **Files modified:** 3 (1 new test file, 1 pre-existing test file extended, 1 `.gitignore` hygiene fix)

## Accomplishments

- `test/queue-config-injection.test.ts` (new, 8 cases): proves `NEXT_GUEST_COUNTDOWN_MS`, `SESSION_TIMEOUT_MS` and `SESSION_MAX_RETRIES` all come from the constructor's injected config object — an injected 9000ms countdown dispatches at exactly 9000ms, the 5-10s clamp holds at both ends (3000ms→5000ms floor, 30000ms→10000ms ceiling), an injected 12000ms session timeout stalls at exactly 12000ms, a retry budget of 0 fails on the first stall, a budget of 3 survives three stalls and fails on the fourth, environment variables set to conspicuously different values change nothing, and constructing with no config argument still works via `config.ts`'s defaults (7000ms countdown).
- `test/queue-countdown.test.ts` gained a new "booth state transitions" describe block (7 cases) with its own hand-built mock that records the *ordered sequence* of booth-state writes, not just the latest value: IDLE→ANNOUNCING→BUSY→IDLE is asserted as an exact path, the dispatched Agent command's shape is asserted exactly as `{ type: 'command', action: 'start_session', jobId }` (QUE-03), `session_start` moves the job to `in_progress` without a second announcement, `session_end` completes the job and auto-announces the next guest with no further external input (QUE-04), the happy path never touches `requeueWithRetry`/`failJob`, and `stop()` halts further dispatch. The pre-existing FIFO-order case (Phase 1-era) was left untouched and is still green.
- Assertions were checked against `docs/OPS-RUNBOOK.md` section 5's transition table per the plan's instruction — no discrepancy found between what the code does and what the table (written by plan 02-03) describes.
- **The live restart defect is confirmed fixed against real production data**, not just unit tests: a real `npm run build && node dist/index.js` produced the designed recovery sequence and the booth left its 6.7-hour-stuck `BUSY` state. Full detail in "Checkpoint Resolution" below.
- Full suite: 16 files, 113 tests, all green throughout. `npx tsc --noEmit` clean.

## Task Commits

1. **Task 1: The queue's timing and retry budget follow the injected config, not the environment** - `0e3713c` (test)
2. **Task 2: The full booth transition sequence, asserted end to end** - `8cc0ebe` (test)
3. **Task 3: Verify the live production database recovers on the first restart** - `263cfe8` (chore — `.gitignore` only; the checkpoint itself is a verification event, not a code change, see below)

## Files Created/Modified

- `mirror-request/test/queue-config-injection.test.ts` (new) - 8 fake-timer cases proving D-13 (config-injection, never `process.env`, never `getStore()`)
- `mirror-request/test/queue-countdown.test.ts` - new "booth state transitions" describe block (7 cases); pre-existing case untouched
- `mirror-request/.gitignore` - added `data/backups/` (the operator's pre-mutation SQLite backup isn't covered by the existing `data/*.sqlite*` rules and carries the same PII posture as the live database)

## Decisions Made

See `key-decisions` in frontmatter above. No new architectural decisions were required for Tasks 1-2 — 02-CONTEXT.md's D-13 and RESEARCH.md's Full Transition Table fully specified the expected behavior. Task 3's one real decision (what to do with the 5 non-terminal rows) was made explicitly by the human, exactly as the checkpoint was designed to require — not inferred or defaulted by any agent.

## Deviations from Plan

None — Tasks 1 and 2 executed exactly as written. No production code was touched by either task (both are test-only, confirmed by `git diff --name-only` showing no file under `src/` in either commit). Task 3's `.gitignore` addition is a minor, directly-caused hygiene fix (Rule 2 — protecting a newly-created PII-bearing backup file from ever entering git history), not a deviation from the checkpoint's substance.

## Issues Encountered

None for Tasks 1-2. All grep-based acceptance criteria matched on the first attempt:
- `grep -v '^\s*[/*]' test/queue-config-injection.test.ts | grep -c 'getStore'` → 0
- `grep -v '^\s*[/*]' test/queue-countdown.test.ts | grep -c 'getStore'` → 0
- `grep -c "announces and dispatches requests one at a time in FIFO order" test/queue-countdown.test.ts` → 1 (pre-existing case preserved)
- `git diff --name-only HEAD` for both task commits lists no file under `src/`

## Checkpoint Resolution (Task 3)

**This agent's role was evidence-gathering only** — restarting the service and mutating the production database were explicitly outside this agent's authorization. The checkpoint was resolved in two stages:

### Stage 1 — evidence gathered by this agent (read-only, no mutation, no restart)

BEFORE state, unchanged since 02-CONTEXT.md's original observation:

```
booth_state: state=BUSY, updated_at=2026-08-10T04:29:42.732Z

registration-20260806-0001    dispatched  retries=0  queued_at=1786030168651
registration-20260806-0002    dispatched  retries=0  queued_at=1786030776942
registration-20260806-02331   dispatched  retries=0  queued_at=1786031247040
registration-20260806-04431   dispatched  retries=0  queued_at=1786031390675
job-webhook-001               queued      retries=0  queued_at=1786069361363
```

Confirmed the effective config for the next restart (via `dotenv`, printing only the three numeric keys — no `.env` content or secrets read/shown): none of `SESSION_TIMEOUT_MS`, `SESSION_MAX_RETRIES`, `NEXT_GUEST_COUNTDOWN_MS` is set in `.env`, so `config.ts`'s defaults apply (300,000ms / 2 / 7,000ms).

**Correctly flagged that `mirror-request/dist/config.js` and `dist/queue/queueService.js` were stale** — the compiled output predated this entire phase and had zero occurrences of `SESSION_MAX_RETRIES` or `recover`. A bare restart of the then-running process would have executed the pre-phase build and NOT applied the fix. The coordinator independently re-verified this exact finding before acting on it.

**Initial delay estimate needed correction** (see Stage 2): this agent's checkpoint report estimated ~15 min/job (3 full `SESSION_TIMEOUT_MS` cycles) and ~1 hour total, not accounting for `recover()`'s sweep incrementing `retries` to 1 instantly at boot with no wall-clock wait — the corrected figure is ~10 min/job, ~40 min total. This agent also did not initially weigh that `job-webhook-001` (queued 2026-08-07, 3.4 days old at the time) was nearly as stale as the four rows it was "queued behind," which the coordinator's independent check surfaced and which materially changed the human's decision (delete, not retry-or-fail-in-place).

### Stage 2 — human decision + coordinator-executed restart

The human, informed by both this agent's evidence and the coordinator's corrections, decided:

1. **Delete all 5 non-terminal `queue_job` rows outright** (4× `dispatched`, 1× `queued`) rather than let the bounded retry policy run them out or mark them `failed` in place — none represented a guest still waiting; all were multiple days stale, and `job-webhook-001`'s name pattern suggested a test fixture rather than a real registration.
2. **Have the coordinator perform the build and restart** (backup → delete rows → `npm run build` → `node dist/index.js`), since this agent was not authorized to.

Actions taken, verified independently by this agent afterward (all read-only checks, run after the fact — no restart or mutation performed by this agent at any point):

1. Full SQLite backup taken first, at `mirror-request/data/backups/extension-service.sqlite*.2026-08-10T11-12-38.bak` — **confirmed present** on disk.
2. The 5 non-terminal `queue_job` rows deleted; `booth_state` deliberately left at its stuck `BUSY` value so the restart still had to exercise the real recovery path.
3. `npm run build` — **confirmed**: `dist/config.js` now contains `SESSION_MAX_RETRIES` (1 occurrence), `dist/queue/queueService.js` now contains `recover` and `handleStall` (4 occurrences each).
4. Service started (`node dist/index.js`), producing this startup log (the phase's acceptance signal):
   ```
   warn  Booth timeout reset: restart recovery: booth was BUSY at startup
   info  [queue]Recovery complete: booth was BUSY, swept 0 in-flight job(s)
   info  AgentServer started at /agent
   ```
   The `warn` line reaching the masked `[queue]`-labeled Winston pipeline is itself part of what M2 success criterion 5 required — the pre-02-01 local logger had no `warn` method at all, so this warning could not have been emitted before this phase.
5. AFTER state, **confirmed independently by this agent** via a fresh read-only query:
   ```
   booth_state: {"id":1,"state":"IDLE","updated_at":"2026-08-10T11:13:43.299Z"}   (22s old at the time — fresh, no longer 04:29:42)
   queue_job:   [{"status":"completed","n":1}]   (the 5 non-terminal rows are gone; only the pre-existing completed row remains)
   ```
6. **The service was then stopped** by the coordinator, since it was not running before the checkpoint began (`pm2 list` empty, no matching process). **The service is currently NOT running** — this agent independently confirmed no `dist/index.js` process and an empty `pm2 list` at the time of writing this summary. Whoever starts it next does so with the deployment's normal mechanism, not as a residual of this checkpoint.

This proves, on real persisted data rather than mocks: the persisted-BUSY deadlock (D-01) is broken by a real restart; the wall-clock age check correctly classified a ~6.7-hour-old `BUSY` booth as dead (D-02); and the queue's `warn`-level output now reaches the production log pipeline.

## User Setup Required

None. The database backup, build, restart, and stop were all performed and verified as part of this checkpoint's resolution — nothing further is required to close Phase 2. Starting the service for ongoing operation is a normal deployment action, not a leftover setup step from this phase.

## Next Phase Readiness

- **Phase 2 (Queue & Booth State) is CLOSED.** All 4 plans executed; all 6 requirements (QUE-01, QUE-02, QUE-03, QUE-04, BTH-01, BTH-02) marked complete in `REQUIREMENTS.md`, including the traceability table row. `ROADMAP.md` shows Phase 2 at 4/4 plans.
- Full suite green throughout: 16 files, 113 tests. `npx tsc --noEmit` clean.
- The confirmed live production defect this phase existed to fix is verified fixed against real data, not inferred from unit tests alone.
- **The service is currently stopped.** Phase 3 (Agent WebSocket Link) can begin planning immediately — it does not require the service to be running — but whoever deploys next should start it via the normal mechanism, aware that `booth_state` is now a clean `IDLE` with an empty queue (the 5 stale rows were deleted, not left for the retry policy).
- No blockers for Phase 3.

---
*Phase: 02-queue-booth-state*
*Completed: 2026-08-10*

## Self-Check: PASSED

All 3 modified/created files verified present: `mirror-request/test/queue-config-injection.test.ts`, `mirror-request/test/queue-countdown.test.ts`, `mirror-request/.gitignore`. All 3 task commits (`0e3713c`, `8cc0ebe`, `263cfe8`) verified present in `git log --oneline --all` inside `mirror-request/`. The live-database AFTER state (`booth_state.state=IDLE`, `queue_job` holding only 1 `completed` row) and the absence of a running service process were independently re-confirmed by this agent via read-only queries before writing this summary, not taken solely on the coordinator's report.
