---
phase: 07-session-lifecycle-retake
plan: 02
subsystem: observability
tags: [winston, logging, ops, signals, sighup, pm2, docker]

# Dependency graph
requires:
  - phase: 01-mirror-request-foundation
    provides: src/logging/logger.ts's winston Logger, labelLogger() child-logger factory, and config.ts's LOG_LEVEL default
provides:
  - "setLogLevel(next) on src/logging/logger.ts — validated, never-throwing, single-source-of-truth LOG_LEVELS vocabulary"
  - "src/ops/logLevelControl.ts — reloadLogLevelFromEnvFile() and registerLogLevelSignalHandler(), the SIGHUP-driven runtime reload mechanism"
  - "docs/OPS-RUNBOOK.md section 11 — the operator procedure for PM2/raw-process/Docker"
affects: [07-05-phase-gate]

# Actuals (#2632)
actuals:
  tokens: 5083
  tasks: 2
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "dotenv.parse() (never dotenv.config()) for a runtime re-read of a single .env key, so process.env is never mutated after startup"
    - "Array-derived union (LOG_LEVELS -> LogLevel) mirroring guestStatus.ts's GUEST_STATUSES/PHOTO_DELIVERY_STATES idiom"
    - "Signal-handler boundary: try/catch + one warn on failure, register/unregister function pair, matching Phase 1 D-05's never-crash-on-a-boundary discipline"

key-files:
  created:
    - mirror-request/src/ops/logLevelControl.ts
    - mirror-request/test/log-level-runtime.test.ts
  modified:
    - mirror-request/src/logging/logger.ts
    - mirror-request/src/index.ts
    - mirror-request/docs/OPS-RUNBOOK.md

key-decisions:
  - "No transport.level fan-out was added: measured (test/log-level-runtime.test.ts's labelLogger('queue').isLevelEnabled() assertion) that winston already applies logger.level as every transport's default level, so the prototype-chain propagation the plan asked to verify held without extra code."
  - "SIGHUP chosen over SIGUSR2 per the plan's explicit instruction — SIGUSR2 is claimed by PM2 (log reopening) and nodemon (restart); registering a SIGHUP handler also converts its default terminate-on-signal behavior into the safe reload."
  - "The confirmation line is written at warn, not info, so it survives an operator having already pinned the process above info — documented tradeoff: pinning above warn silences the confirmation itself, which is standard logging semantics, not a bug."

requirements-completed: [SC-5]

coverage:
  - id: D1
    description: "setLogLevel() validates against the single-source-of-truth LOG_LEVELS array, changes logger.level in place, and never throws"
    requirement: SC-5
    verification:
      - kind: unit
        ref: "test/log-level-runtime.test.ts#setLogLevel() (Task 1 — SC-5, runtime half)"
        status: pass
    human_judgment: false
  - id: D2
    description: "A real labelLogger() child (the same factory queueService.ts uses) is measured, not assumed, to follow the parent's raised level via isLevelEnabled()"
    requirement: SC-5
    verification:
      - kind: unit
        ref: "test/log-level-runtime.test.ts#a real labelLogger() child follows the parent level — measured, not assumed"
        status: pass
    human_judgment: false
  - id: D3
    description: "SIGHUP reloads LOG_LEVEL from .env into the running process, in place, with no restart"
    requirement: SC-5
    verification:
      - kind: unit
        ref: "test/log-level-runtime.test.ts#registerLogLevelSignalHandler(SIGUSR1) + emit changes the level; the returned unregister function stops further reloads"
        status: pass
    human_judgment: false
  - id: D4
    description: "An invalid or absent LOG_LEVEL leaves the current level unchanged, emits one warn, and never throws or terminates the process"
    requirement: SC-5
    verification:
      - kind: unit
        ref: "test/log-level-runtime.test.ts#a .env with LOG_LEVEL=shouty leaves the level unchanged, returns changed: false, and produces one warn"
        status: pass
      - kind: unit
        ref: "test/log-level-runtime.test.ts#a nonexistent path with no process.env.LOG_LEVEL either leaves the level unchanged and returns changed: false, source: none — no throw"
        status: pass
    human_judgment: false
  - id: D5
    description: "Parsing the env file never mutates process.env — no new configuration key is introduced (D-12)"
    requirement: SC-5
    verification:
      - kind: unit
        ref: "test/log-level-runtime.test.ts#parsing the env file never mutates process.env — a key present only in the file is still undefined on process.env after the reload"
        status: pass
    human_judgment: false
  - id: D6
    description: "The mechanism is wired into the deployed process (src/index.ts), not only exercised in a test, and documented for an operator on PM2, raw-process, and Docker"
    requirement: SC-5
    verification:
      - kind: unit
        ref: "grep -n \"registerLogLevelSignalHandler\" src/index.ts — exactly one registration call, at startup"
        status: pass
      - kind: other
        ref: "docs/OPS-RUNBOOK.md section 11"
        status: pass
    human_judgment: false
  - id: D7
    description: "At the physical booth, an operator sends a real SIGHUP to the deployed PM2 process and confirms the log level changes without a restart"
    verification: []
    human_judgment: true
    rationale: "No live PM2 deployment exists in this executor's environment; deferred to the phase gate (07-05) alongside 07-01's own D8 backstop item, per the same pattern."

duration: ~20min
completed: 2026-08-12
status: complete
---

# Phase 7 Plan 2: SIGHUP Log-Level Reload Summary

**A validated, never-throwing `setLogLevel()` on the winston logger plus a SIGHUP-driven `.env` reload wired into the running process — the "without a redeploy" half of SC-5, adding no new configuration key (D-12).**

## Performance

- **Duration:** ~20 min
- **Started:** ~2026-08-12T10:40:00Z
- **Completed:** 2026-08-12T11:00:00Z
- **Tasks:** 2
- **Files modified:** 5 (2 created, 3 modified)

## Accomplishments

- `src/logging/logger.ts` exports `LOG_LEVELS` (winston's seven npm levels, array-derived-union idiom matching `guestStatus.ts`) and `setLogLevel(next)`, which validates against that single source of truth, never throws, warns once on an invalid value, and is a no-op (`changed: false`) when the requested level already matches.
- Measured, not assumed: `labelLogger('queue').isLevelEnabled('debug')` after `setLogLevel('debug')` proves winston's `logger.child()` prototype chain and default transport level propagate the parent's raised level to every child logger with zero extra code — the one property the whole mechanism rests on, per the plan's own caution.
- `src/ops/logLevelControl.ts` (new) exports `reloadLogLevelFromEnvFile(envPath?)` — reads a `.env`-shaped file with `dotenv.parse` (never `dotenv.config`, so `process.env` is never mutated), takes only the `LOG_LEVEL` key, falls back to `process.env.LOG_LEVEL` when the file is unreadable, and never throws — and `registerLogLevelSignalHandler(signal?, envPath?)`, defaulting to `SIGHUP` (not `SIGUSR2`, which PM2 and nodemon already claim), returning an unregister function.
- `src/index.ts` registers the handler exactly once, at startup, before the express app is built, and the `app.listen` callback now logs the starting level and the SIGHUP hint — the mechanism is discoverable from the log an operator is already reading.
- `docs/OPS-RUNBOOK.md` gained section 11: the exact commands for PM2 (`pm2 sendSignal SIGHUP <app-name>`), raw process (`kill -HUP <pid>`), and Docker (`docker kill --signal=HUP <container>`), the accepted-value list, the confirmation line's warn-level caveat, the in-memory-only scope, and why SIGHUP was chosen over SIGUSR2.
- `test/log-level-runtime.test.ts` covers all 10 behaviors across both plan tasks (11 test cases total) — 5 for `setLogLevel()`, 6 for the reload/signal path, including the process.env non-mutation assertion.
- Ran the plan's own non-vacuity check: temporarily disabled `setLogLevel`'s validation branch (`if (false)`), confirmed both invalid-value test cases failed (2 of 11), then reverted — `git diff` on `src/logging/logger.ts` was empty afterward.

## Task Commits

Each task was committed atomically:

1. **Task 1: setLogLevel() on the winston logger, proved against a real label-logger child** - `398ae90` (feat)
2. **Task 2: SIGHUP reload of LOG_LEVEL from .env, wired into the running process and documented** - `593977a` (feat)

## Files Created/Modified

- `mirror-request/src/logging/logger.ts` - `LOG_LEVELS`/`LogLevel` exports; `setLogLevel(next)`
- `mirror-request/src/ops/logLevelControl.ts` (new) - `reloadLogLevelFromEnvFile()`; `registerLogLevelSignalHandler()`
- `mirror-request/src/index.ts` - one `registerLogLevelSignalHandler()` call at startup; startup-level/SIGHUP-hint log line in the `app.listen` callback
- `mirror-request/test/log-level-runtime.test.ts` (new) - 11 tests across 2 describe blocks covering all 10 plan behaviors
- `mirror-request/docs/OPS-RUNBOOK.md` - new section 11

## Decisions Made

- No `transport.level` fan-out was needed (plan Task 1 step 3's conditional escape hatch): the child-logger propagation assertion passed on the first run, so the comment in `setLogLevel()`'s docblock records what was measured rather than adding unused code.
- `SIGUSR1` was used for the test file's signal-registration cases (not `SIGHUP`), exactly as the plan specifies, so the test runner's own process signalling is never touched.
- The confirmation line's warn-level caveat (silenced by pinning above `warn`) is documented explicitly in the runbook rather than treated as a residual defect — it is standard logging semantics, matching the plan's own framing.

## Deviations from Plan

None — plan executed exactly as written. Both tasks matched their `<action>` steps and `<acceptance_criteria>` without needing a Rule 1-4 auto-fix.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required. (Section 11 documents an *operator* procedure for an already-deployed process, not a setup step for this execution.)

## Next Phase Readiness

- The "without a redeploy" half of SC-5 is complete and lives in the deployed process (`src/index.ts` registers the handler unconditionally at startup), not only in a test.
- SC-5's other half — raising the AGT-04 event lines from `debug` to `info` unconditionally — is plan 07-05's job, per the plan's own `<d12_reconciliation>`; this plan does not claim to satisfy SC-5 alone.
- D-12 holds: `grep -rn "LOG_LEVEL"` shows the key reused exactly as `config.ts` already defined it; no new configuration key was introduced anywhere in this plan's diff.
- The Agent-untouched constraint (D-05) held throughout: `git -C dslrbooth-agent status --porcelain` is empty.
- No blockers. `npm test`: 40 files / 368 tests green (baseline at plan start: 39/357, from 07-01); `npm run typecheck` and `npm run build` both exit 0.

---
*Phase: 07-session-lifecycle-retake*
*Completed: 2026-08-12*

## Self-Check: PASSED

All created files and referenced commit hashes verified present on disk / in `git log`:
- `mirror-request/src/ops/logLevelControl.ts`, `mirror-request/test/log-level-runtime.test.ts` — FOUND
- `mirror-request/src/logging/logger.ts`, `mirror-request/src/index.ts`, `mirror-request/docs/OPS-RUNBOOK.md` — FOUND (modified)
- Commits `398ae90`, `593977a` — FOUND in `git log`
