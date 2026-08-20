---
phase: 03-agent-websocket-link
plan: 02
subsystem: agent-transport
tags: [websocket, observability, heartbeat, connection-lifecycle, testing]
dependency-graph:
  requires:
    - phase: "03-01"
      provides: "Authorization: Bearer <token> auth on the /agent upgrade path; the same AgentServer this plan edits"
  provides:
    - "Diagnosable last-wins Agent replacement: one warn naming both the displaced and arriving connection ids (D-10/D-11)"
    - "Collision-proof connection ids (agent-${Date.now()}-${++connSeq})"
    - "AgentServer(opts?: { heartbeatIntervalMs?, heartbeatTimeoutMs? }) — first constructor this class has ever had, defaulting to production's exact prior values"
    - "AGT-05's first automated test coverage ever (offline detection with 4002 close, continued-online, zero-arg regression guard)"
    - "registerDisconnectHandler(fn): void — a no-op-defaulted seam fired exactly once per real disconnect (clean close or heartbeat eviction), never for a stale/displaced socket"
  affects:
    - "03-04 (requeue policy) binds its handler through registerDisconnectHandler() — the only consumer of this seam"
    - "03-03 (running in the same wave, different files: queueService.ts, dbPoller-adjacent) has no file overlap with this plan"
tech-stack:
  added: []
  patterns:
    - "Constructor-injected timing config with production defaults (mirrors queueService.ts's existing shape) — the module constant becomes the constructor's default rather than a hardcoded setInterval argument"
    - "Callback-binding seam (registerXHandler(fn), no-op default) — same idiom as the existing ackHandler/eventHandler pair, now with a third member"
key-files:
  created:
    - mirror-request/test/agent-replacement.test.ts
    - mirror-request/test/agent-heartbeat-timeout.test.ts
  modified:
    - mirror-request/src/agent/agentServer.ts
decisions:
  - "Connection id format finalized as `agent-${Date.now()}-${++this.connSeq}` — the mint moved to run before the replacement-check block so the arriving id is in scope for the displacement warning, per the plan's step ordering."
  - "The displacement warning text is the literal `Agent WS replaced: ${displacedId} displaced by ${id}` — asserted verbatim by test/agent-replacement.test.ts via regex `^Agent WS replaced: (.+) displaced by (.+)$`."
  - "Both new test files use real timers with short injected values, never vi.useFakeTimers() — fake timers would race against real socket I/O per the plan's explicit rationale, confirmed stable across 5 repeated local runs of each new file (see Observed Timing Margins below)."
  - "The disconnect seam's two invocation sites are exactly where the plan specified: inside the existing `this.agentConn?.id === id` close guard, and immediately after `this.agentConn = null` in the watchdog's eviction branch — no third site, no state check added to either branch."
metrics:
  duration: "~35 min (autonomous, no checkpoints)"
  completed: 2026-08-10
status: complete
actuals:
  tokens: 4150
  tasks: 3
  commits: 3
---

# Phase 3 Plan 02: Agent Replacement, Heartbeat Injection & Disconnect Seam Summary

Hardened `AgentServer`'s observability and liveness on top of plan 03-01's authenticated
socket: a displaced Agent is now named in a single warn line, connection ids can no longer
collide, the heartbeat watchdog gained its first-ever automated test via an injectable
constructor, and a `registerDisconnectHandler()` seam now fires exactly once per real
disconnect — clean close or heartbeat eviction — while staying silent for a stale, displaced
socket's late close.

## What Was Built

**Task 1 — commit `ed46dcc`:**
- Added `private connSeq = 0;` and moved the connection-id mint to run **before** the
  `if (this.agentConn)` replacement check. Final id format:
  `` `agent-${Date.now()}-${++this.connSeq}` `` — the counter guarantees two sockets accepted
  inside the same millisecond never collide, which the close guard (`this.agentConn?.id === id`)
  depends on for correctness.
- The replacement block now captures the incumbent's id before closing it and emits exactly
  one `logger.warn` naming both: `` `Agent WS replaced: ${displacedId} displaced by ${id}` ``.
  Last-wins behavior (D-10) is unchanged; only the visibility changed (D-11).
- New `test/agent-replacement.test.ts` (5 cases): last-wins with `isAgentOnline()` staying
  true, exactly-one warning naming two different ids, id-uniqueness under immediate
  succession, no warning for a lone connection, and no credential leakage.

**Task 2 — commit `ae42c50`:**
- `AgentServer` gained its first constructor: `constructor(opts: { heartbeatIntervalMs?:
  number; heartbeatTimeoutMs?: number } = {})`, defaulting to the module constant
  `HEARTBEAT_INTERVAL` (15s) and `this.config.HEARTBEAT_TIMEOUT_MS` (30s) respectively —
  `new AgentServer()` in `src/index.ts` compiles and behaves identically to before.
- `startHeartbeatWatchdog()`'s `setInterval` period and both timeout reads (the elapsed
  comparison and the interpolated warning) now go through `this.heartbeatIntervalMs` /
  `this.heartbeatTimeoutMs` instead of the module constant and `getConfig()` directly.
- New `test/agent-heartbeat-timeout.test.ts` (4 cases at this point, 5 after Task 3): offline
  detection with a 60ms injected timeout closing the socket with code 4002, continued-online
  under a 25ms heartbeat cadence against a 500ms timeout, a zero-argument regression guard
  proving production defaults are unchanged, and a no-credential-in-warning assertion.

**Task 3 — commit `812ab4c`:**
- Added `private disconnectHandler: () => void = () => {};` and
  `registerDisconnectHandler(fn: () => void): void`, matching the existing
  `ackHandler`/`eventHandler` shape exactly.
- Invoked inside the existing `ws.on('close')` id guard, immediately after the existing
  `logger.info('Agent disconnected')` line — so a displaced (stale) socket's asynchronous
  late close, which by then finds the guard false, never fires the handler.
- Invoked a second time in the heartbeat watchdog's eviction branch, immediately after
  `this.agentConn = null`, so an Agent that dies without a clean TCP close (the realistic
  dead-booth case) still reaches the seam — and exactly once, since the watchdog nulling the
  connection first makes the guard false when the socket's own later `'close'` event fires.
- Extended `test/agent-replacement.test.ts` with a new `describe('Agent disconnect seam...')`
  block (2 cases: displaced-close fires zero times / survivor-close fires exactly once; no
  handler registered doesn't throw) and `test/agent-heartbeat-timeout.test.ts` with one case
  proving eviction-then-close fires the handler exactly `1`, not more.
- `AgentServer` still imports nothing from `queueService.ts` — confirmed by
  `grep -c "queue/queueService" src/agent/agentServer.ts` → `0`.

## The Final Shape (for 03-04 to bind against)

- **Connection id format:** `agent-${Date.now()}-${++this.connSeq}` (e.g.
  `agent-1755000000000-3`)
- **Displacement warning (exact text):** `Agent WS replaced: <displacedId> displaced by <id>`
- **Constructor:** `new AgentServer(opts?: { heartbeatIntervalMs?: number; heartbeatTimeoutMs?:
  number })` — omit `opts` entirely for identical production behavior to before this plan
- **Disconnect seam:** `agentServer.registerDisconnectHandler(() => { /* 03-04's requeue policy */ })`
  — no-op by default, fired exactly once per real disconnect, from either of two call sites
  inside `agentServer.ts`, never from a stale socket's close

## Observed Timing Margins (for 03-04 and future flakiness investigation)

Measured locally, 5 consecutive repeated runs of each new test file, all stable (no
observed flakiness):

- **Offline-detection case** (`heartbeatIntervalMs: 20, heartbeatTimeoutMs: 60`, polling
  `isAgentOnline()` every 10ms up to a 1000ms ceiling): detection consistently completed well
  inside the ceiling; the combined eviction-then-close-settle case (which adds an explicit
  300ms wait after detection for the socket's own `'close'` event to land) measured
  **388–392ms wall-clock** across 5 runs — a 4ms spread, i.e. detection itself took roughly
  88–92ms against the 60ms configured timeout (about 1–2 watchdog ticks of overshoot at a
  20ms interval, which is expected: the watchdog only checks at tick boundaries).
- **Stays-online case** (`heartbeatIntervalMs: 25, heartbeatTimeoutMs: 500`, heartbeats sent
  every 25ms, assertion at 300ms): measured **306–307ms wall-clock** across 5 runs — a 1ms
  spread. The 500ms timeout is never approached (300ms assertion point leaves 200ms/40%
  headroom), and the 25ms send period is 20x shorter than the 500ms timeout, matching the
  plan's explicit margin rationale for avoiding a flaky test.
- Full suite (`npm test`) ran 3 times back-to-back during verification with identical
  pass counts each time (19 files / 133 tests), and the two new files were also run
  standalone 5 times each — zero flaky failures observed in any run.

## Verification

- `cd mirror-request && npx vitest run test/agent-replacement.test.ts` — 7/7 passing
- `cd mirror-request && npx vitest run test/agent-heartbeat-timeout.test.ts` — 5/5 passing
- `cd mirror-request && npm run typecheck` — clean (proves `new AgentServer()` in
  `src/index.ts` still compiles with zero arguments)
- `cd mirror-request && npm test` — **19 files, 133 tests, all green** (130 pre-existing +
  what plan 03-02 added net: +7 in agent-replacement, +5 in agent-heartbeat-timeout, minus the
  2 that existed before Task 3 extended them — net +12 test cases vs. 03-01's baseline of 121)
- All acceptance-criteria grep gates verified to match exactly:
  - `Agent WS replaced` → 1
  - `connSeq` → 2
  - `HEARTBEAT_INTERVAL` → 2
  - `this.config.HEARTBEAT_TIMEOUT_MS` → 1
  - `this.heartbeatTimeoutMs` → 3
  - `this.disconnectHandler(` → 2
  - `registerDisconnectHandler` → 1
  - `queue/queueService` in `agentServer.ts` → 0
  - `getStore` across both new test files → 0
  - `DisplayServer` in `agent-replacement.test.ts` → 0

## Deviations from Plan

None — plan executed exactly as written. All grep-count acceptance criteria were simulated
against the actual edits before asserting (per this project's stated acceptance-criteria
discipline) and all matched on the first attempt; no corrections were needed.

## Auth Gates

None. No CLI authentication was required for this plan.

## Known Stubs

None. `registerDisconnectHandler()` is a complete, production-shaped seam with a genuine
no-op default (not a placeholder) — it is intentionally unconsumed until plan 03-04 binds a
real handler, which is the scope boundary this plan's objective states explicitly.

## Threat Flags

None beyond what the plan's own `<threat_model>` already registered (T-03-08 through T-03-13)
— no new surface was introduced outside that register.

## Self-Check: PASSED

- FOUND: `/opt/mirror_request_dslrobooth/mirror-request/test/agent-replacement.test.ts`
- FOUND: `/opt/mirror_request_dslrobooth/mirror-request/test/agent-heartbeat-timeout.test.ts`
- FOUND: commit `ed46dcc` (Task 1)
- FOUND: commit `ae42c50` (Task 2)
- FOUND: commit `812ab4c` (Task 3)
- Working tree clean inside `mirror-request/` after all three commits (`git status --short`
  empty)
- `cd mirror-request && npm test` — 19 files, 133 tests, all passing (run 3x, stable)
- `cd mirror-request && npm run typecheck` — clean
- All acceptance-criteria grep gates listed above verified to match their required counts
  exactly
- Neither obsolete `.planning/` tree (`mirror-request/.planning/`, `dslrbooth-agent/.planning/`)
  was read or written during this plan

