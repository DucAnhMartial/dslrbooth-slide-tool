---
phase: 10-agent-desktop
plan: 01
subsystem: infra
tags: [electron-prep, lifecycle-refactor, config-validation, health-check, typescript, vitest]

# Dependency graph
requires:
  - phase: 08-agent-cms-config
    provides: LiveConfig, SAFE_AGENT_CONFIG_FIELDS/READ_ONLY_AGENT_CONFIG_FIELDS, the D-16/D-17 in-memory config contract this plan builds status and validation on top of without touching
provides:
  - "createAgent(config, logger, options?) — a factory with a deferred-bind, explicit start()/stop()/isRunning() lifecycle, ready to be hosted by Electron's main process in plan 10-02"
  - "getStatus()/onStatus() — a credential-free status snapshot an IPC layer and a settings window can consume directly"
  - "parseConfigValues()/loadConfig() — a single config validator both the .env path and the plan 10-02 settings form can call"
  - "probeTcp() — a loopback reachability probe that stays inside the dumb-relay rule"
affects: [10-02-electron-shell, 10-03-settings-form, agent-desktop-ipc]

# Actuals (#2632)
actuals:
  tokens: 16789
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Deferred-bind factory lifecycle: construct without binding, start()/stop() open and release the trigger port and socket explicitly (D10-01, 10-RESEARCH Pattern 1)"
    - "One validator, two callers: parseConfigValues() collects every field error in one pass; loadConfig() is the environment-reader caller, a settings-form caller comes in 10-02 (SC-4, ASVS V5)"
    - "Status snapshot assembled field-by-field, never spread from config/live, so credentials cannot ride along by construction"
    - "Subscriber notification wrapped in try/catch per callback (mirrors WsConnection's own notifyStatus) so one bad subscriber cannot take the relay down"

key-files:
  created:
    - dslrbooth-agent/src/agent.ts
    - dslrbooth-agent/src/commands.ts
    - dslrbooth-agent/src/health/reachability.ts
    - dslrbooth-agent/test/agent-lifecycle.test.ts
    - dslrbooth-agent/test/config-values.test.ts
    - dslrbooth-agent/test/agent-status.test.ts
  modified:
    - dslrbooth-agent/src/config.ts
    - dslrbooth-agent/src/triggers/server.ts
    - dslrbooth-agent/src/index.ts
    - dslrbooth-agent/src/agentMessages.ts
    - dslrbooth-agent/package.json

key-decisions:
  - "Reachability probe reads the port through LiveConfig at every probe tick, not a captured boot value, because dslrBoothApiPort is one of the four CMS-tunable fields (08-RESEARCH Pitfall 4 applied to the new probe)."
  - "AgentStatus is a flat, serialisable snapshot with no credential fields at all — redaction by construction rather than by field-stripping, since there is nothing to strip."
  - "typecheck script added to package.json (tsc --noEmit) since this plan and later ones in the phase need it and the repo had none."

patterns-established:
  - "Pattern: any future service→Agent or IPC→Agent surface should validate through parseConfigValues()/LiveConfig.assign()'s existing rules rather than adding a third copy."

requirements-completed: [UI-02, SC-2, SC-4]

coverage:
  - id: D1
    description: "createAgent(config, logger) constructs the relay without binding the trigger port or dialing the socket; start()/stop() are idempotent and an occupied trigger port is a recorded failure, not a crash"
    requirement: "SC-2"
    verification:
      - kind: unit
        ref: "dslrbooth-agent/test/agent-lifecycle.test.ts — all 10 cases (nothing bound before start, event forwarding, start_session ack, unknown-action ack, jobId threading, session_end reset, port release on stop, double start, double/pre stop, occupied-port start)"
        status: pass
    human_judgment: false
  - id: D2
    description: "start_session branch moved verbatim from index.ts into src/commands.ts, now directly testable, with AGT-02/AGT-03 ack shapes and log lines unchanged"
    verification:
      - kind: unit
        ref: "dslrbooth-agent/test/agent-lifecycle.test.ts — 'a start_session command reaches the dslrBooth stub and produces one ack with the same jobId', 'an unknown command action produces one ack with ok:false naming it'"
        status: pass
    human_judgment: false
  - id: D3
    description: "Trigger server gains an optional error callback; an in-use port becomes a reportable start failure instead of an uncaught exception"
    requirement: "SC-2"
    verification:
      - kind: unit
        ref: "dslrbooth-agent/test/agent-lifecycle.test.ts — 'start() against an occupied trigger port does not throw'"
        status: pass
    human_judgment: false
  - id: D4
    description: "parseConfigValues()/loadConfig() — one config validator collecting every field error, agreeing field-for-field with LiveConfig.assign()'s port bound and empty-password refusal, log levels read from the exported LOG_LEVELS constant"
    requirement: "SC-4"
    verification:
      - kind: unit
        ref: "dslrbooth-agent/test/config-values.test.ts — all 19 cases (missing/empty required fields, URL scheme check, port bounds cross-checked against LiveConfig.apply(), log-level set, defaults, loadConfig byte-identical output, process.env untouched)"
        status: pass
    human_judgment: false
  - id: D5
    description: "typecheck script added to package.json"
    verification:
      - kind: unit
        ref: "npm run typecheck (tsc --noEmit) exits 0"
        status: pass
    human_judgment: false
  - id: D6
    description: "getStatus()/onStatus() report running flag, socket state, bound trigger port, dslrBooth reachability verdict, last event timestamp, start timestamp and last error — never the WS token or dslrBooth password"
    requirement: "UI-02"
    verification:
      - kind: unit
        ref: "dslrbooth-agent/test/agent-status.test.ts — getStatus()/onStatus() describe blocks, plus the credential-free serialization case"
        status: pass
    human_judgment: false
  - id: D7
    description: "probeTcp() loopback reachability probe: reachable/unreachable within its own timeout, no HTTP request, no password, runs only while running, no leaked timer after stop()"
    requirement: "UI-02"
    verification:
      - kind: unit
        ref: "dslrbooth-agent/test/agent-status.test.ts — probeTcp() describe block, 'stays inside the dumb-relay rule' describe block, 'leaves no timer behind after stop() (vi.getTimerCount())'"
        status: pass
    human_judgment: false

# Metrics
duration: ~15min (full plan, including a mid-plan continuation)
completed: 2026-08-13
status: complete
---

# Phase 10 Plan 01: Agent Lifecycle Factory, Config Validator, Status Snapshot Summary

**`createAgent()` factory with deferred bind/explicit start-stop, one shared `parseConfigValues()` validator for the `.env` path and the coming settings form, and a credential-free `getStatus()`/`onStatus()` snapshot with a loopback dslrBooth reachability probe.**

## Performance

- **Duration:** ~15 min across the full plan (Task 1 committed first, this execution resumed at Task 2)
- **Completed:** 2026-08-13T17:03:22Z
- **Tasks:** 3
- **Files modified:** 11 (6 created, 5 modified)

## Accomplishments

- The Agent core no longer binds its trigger port or dials its socket at construction — `createAgent(config, logger)` builds every collaborator inert, and only `start()` opens the port and the connection, with an occupied port reported through `getLastError()`/`getStatus()` instead of crashing the process.
- The `start_session` command branch (AGT-02, AGT-03) now lives in `src/commands.ts`, directly exercised by a real WebSocket + real dslrBooth-stub end-to-end test rather than trusted implicitly.
- One function, `parseConfigValues()`, now decides whether a set of configuration values is usable — the `.env` reader (`loadConfig`) and the local settings form coming in plan 10-02 both call it, with the same port bound and empty-password rule `LiveConfig.assign()` already enforces.
- `getStatus()`/`onStatus()` give the handle a flat, serialisable snapshot (running flag, socket state, trigger port, dslrBooth reachability, last event time, start time, last error) that is credential-free by construction, plus a loopback TCP reachability probe that never issues an HTTP request or sends the dslrBooth password.

## Task Commits

Each task was committed atomically:

1. **Task 1: The factory, end to end — nothing bound until start(), a real socket, a real trigger, a real ack** - `64b5b2c` (feat)
2. **Task 2: One config validator, two callers — the `.env` path and the settings form that is coming** - `f2f7ee9` (feat)
3. **Task 3: A status the window can draw — socket, trigger port, dslrBooth reachability, last error** - `85fb72a` (feat)

_Note: this plan's tasks used `tdd="true"` at the task level (tests and implementation written together and verified before committing), not a separate RED/GREEN/REFACTOR commit sequence — each task's single commit contains both the passing implementation and its tests._

## Files Created/Modified

- `dslrbooth-agent/src/agent.ts` - `createAgent()` factory: deferred-bind lifecycle, `start()`/`stop()`/`isRunning()`/`getLastError()`, and (Task 3) `getStatus()`/`onStatus()` plus the reachability-probe interval lifecycle
- `dslrbooth-agent/src/commands.ts` - `createCommandHandler()`, the `start_session` branch moved verbatim from `index.ts`
- `dslrbooth-agent/src/triggers/server.ts` - optional `onError` callback so an in-use trigger port routes to a caller instead of throwing
- `dslrbooth-agent/src/index.ts` - shrunk to the CLI shell around the factory; still what `build:exe` compiles
- `dslrbooth-agent/src/agentMessages.ts` - header paragraph corrected to name `src/commands.ts` as the command branch's new home
- `dslrbooth-agent/src/config.ts` - split into `parseConfigValues()` (the validator) and `loadConfig(env)` (the environment reader built on top of it)
- `dslrbooth-agent/src/health/reachability.ts` - `probeTcp()`, the loopback TCP reachability probe
- `dslrbooth-agent/package.json` - added `typecheck` script
- `dslrbooth-agent/test/agent-lifecycle.test.ts` - 10 cases, end-to-end against a real `WebSocketServer` and a real dslrBooth stub
- `dslrbooth-agent/test/config-values.test.ts` - 19 cases for `parseConfigValues()`/`loadConfig()`
- `dslrbooth-agent/test/agent-status.test.ts` - 11 cases for `getStatus()`/`onStatus()`/`probeTcp()`

## Decisions Made

- Reachability probe reads `live.dslrBoothApiPort` at every probe tick rather than a value captured at `start()` time, because that field is one of the four CMS-tunable ones and a captured value would silently go stale the moment an operator changed it from the CMS — the same class of bug 08-RESEARCH's Pitfall 4 named for `DslrBoothClient`'s port/password.
- `AgentStatus` is assembled field-by-field from state the factory already tracks (never `{ ...config }` or `{ ...live.snapshot() }`), so there is no object-spread path that could carry the WS token or the dslrBooth password into a snapshot that crosses an IPC boundary in plan 10-02.
- The reachability probe runs an immediate first reading on `start()` plus a recurring one on a default 10-second interval (both the interval and the probe function are injectable via `AgentOptions`, used by tests to avoid waiting on real timers), and is torn down in `stop()`.
- `probeTcp()`'s header comment explicitly states why it does not violate the dumb-relay rule: it sends no bytes, no password, and no dslrBooth API path — it cannot start a session, only answer whether something is listening.

## Deviations from Plan

None — plan executed exactly as written. All `<behavior>` bullets for Tasks 2 and 3 are covered by the corresponding acceptance-criteria test cases; no Rule 1-4 triggers were hit.

## Issues Encountered

None.

## User Setup Required

None — no external service configuration required. This plan is Linux-provable in full; the phase's blocking human gate (install/run on the real booth PC) is scoped to a later plan in this phase, not this one.

## Next Phase Readiness

- `createAgent()`'s lifecycle, `parseConfigValues()`'s validator, and `getStatus()`/`onStatus()`'s snapshot are all now available for plan 10-02's Electron main process and IPC layer to compose directly — no further extraction needed from `index.ts` or `config.ts`.
- `SAFE_AGENT_CONFIG_FIELDS`/`READ_ONLY_AGENT_CONFIG_FIELDS` in `src/liveConfig.ts` are byte-identical to their pre-phase contents (`git diff --stat src/liveConfig.ts` is empty), so `mirror-request`'s cross-repo equality test is untouched and unaffected.
- Full verification at the end of this plan: `npm test` — 6 files, 71 tests, all passing (up from the 4-file/41-test baseline this continuation started from, and the 3-file/31-test baseline before Task 1); `npm run typecheck` and `npm run build` both exit 0; `npm run build:exe` produces a non-empty `dslrbooth-agent.exe` (43MB, gitignored).
- No blockers for plan 10-02 (the Electron shell/IPC layer) or 10-03 (the settings form) to begin.

---
*Phase: 10-agent-desktop*
*Completed: 2026-08-13*

## Self-Check: PASSED

All 11 files referenced above (`src/agent.ts`, `src/commands.ts`, `src/health/reachability.ts`, `src/config.ts`, `src/triggers/server.ts`, `src/index.ts`, `src/agentMessages.ts`, `package.json`, `test/agent-lifecycle.test.ts`, `test/config-values.test.ts`, `test/agent-status.test.ts`) confirmed present on disk. All 3 commit hashes (`64b5b2c`, `f2f7ee9`, `85fb72a`) confirmed present in `git log`.
