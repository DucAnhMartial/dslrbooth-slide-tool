# Phase 3: Agent WebSocket Link - Research

**Researched:** 2026-08-10
**Domain:** WebSocket transport hardening (HTTP-upgrade-level auth rejection, timing-safe token comparison, cross-repo client/server contract change, dispatch-connectivity gating, disconnect-triggered recovery) across two Node.js/TypeScript repositories (`mirror-request/` server, `dslrbooth-agent/` client)
**Confidence:** HIGH for current-code behavior and the auth/dispatch/disconnect mechanics (every claim below was read from source this session, both repos); MEDIUM for `ws`-library upgrade-rejection/client-header mechanics (official docs + source code read this session, cross-checked, but not executed against a live handshake in this research session); MEDIUM for the AGT-04 event-coverage recommendation (a design judgment, flagged as D-14 leaves it to research)

## Summary

Phase 3 is **not greenfield** — `mirror-request/src/agent/agentServer.ts` (145 lines) already implements a working token-gated WebSocket server, a heartbeat watchdog, `sendCommand`/`sendEvent`, and `isAgentOnline()`, fully wired into `src/index.ts`; `dslrbooth-agent/src/websocket/connection.ts` (185 lines) already implements a reconnecting client with exponential backoff. The phase's job is to **harden** this working link against four confirmed gaps, all verified against live source this session:

1. **Auth happens too late and too weakly.** The token travels in the query string, is compared with `!==` (timing attack), and is checked only inside the `'connection'` handler — `handleUpgrade()` (agentServer.ts:32) runs unconditionally for `/agent`, so an unauthenticated client completes the WS handshake before being closed with 4001. D-05..D-09 require moving to a header-only, upgrade-time-rejected, timing-safe contract that breaks compatibility with any Agent not updated in the same deploy.
2. **A dispatched job can be sent into a void.** `dispatchJob()` (queueService.ts:211-218) unconditionally marks the job `dispatched`, sets the booth `BUSY`, arms a 5-minute timer, and calls `sendCommandCb` — discarding its boolean return. `AgentServer.sendCommand()` already returns `false` and warns on no connection, but nothing upstream acts on that. D-02..D-04 require a pre-dispatch connectivity gate that costs the guest no retry budget.
3. **A dead Agent's disconnect is invisible to the queue.** `ws.on('close')` (agentServer.ts:80-85) only nulls the local connection object; if the booth is `BUSY`, nothing tells `QueueService` until the existing 5-minute `busyTimer` eventually fires. D-12/D-13 require an immediate, no-retry-charged requeue on disconnect that cannot double-fire with `busyTimer`.
4. **Seven of ten AGT-04 event types fall through with no handler at all.** `QueueService.onAgentEvent()` (queueService.ts:170-178) has an `if/else if` chain with no final `else` — `countdown_start`, `countdown`, `capture_start`, `file_download`, `processing_start`, `sharing_screen`, `printing` are silently dropped today.

A fifth gap was found during this research, **not** named in 03-CONTEXT.md's D-01..D-14 but directly blocking a literal requirement: **AGT-02's payload `{type, action, jobId, mode}` never actually carries `mode`.** `dispatchJob()`'s `sendCommandCb` call (queueService.ts:216) omits the `mode` field entirely; `JSON.stringify` then drops the `undefined` key, so the Agent falls back to its own hardcoded default (`dslrbooth-agent/src/index.ts:70`, `mode: string = 'print'` in `dslrbooth/client.ts:63`). Every session the booth actually runs defaults to `'print'` regardless of what the guest selected at registration. See "A Fifth Gap — AGT-02's `mode` Field Is Never Sent" below.

**Primary recommendation:** Treat this as five independent, small changes to two files' worth of production code (`agentServer.ts`, `queueService.ts`, plus one new `localStore.ts` method and one new `connection.ts` header change), each with a narrow, testable seam — not a rewrite. No schema migration and no new npm packages on the server side; the Agent repo needs a test framework added (it currently has none) to cover the D-09 client change.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Agent authentication (AUTH-01, D-05..D-09) | API/Backend (`AgentServer`'s `upgrade` handler) | External System (Agent's `WsConnection`, sends the header) | The verification decision is entirely server-side; the Agent is a dumb relay per CLAUDE.md rule 3 and only needs to send the right header |
| Dispatch command (AGT-02) | API/Backend (`QueueService.dispatchJob()` composes the payload) | API/Backend (`AgentServer.sendCommand()` carries it) | Business logic (what to send, whether it's safe to send) stays in `QueueService`; `AgentServer` is a pure transport that returns success/failure |
| Dispatch connectivity gate (D-02..D-04) | API/Backend (`QueueService.tick()`/`dispatchJob()`) | API/Backend (`AgentServer.isAgentOnline()` as the read) | `QueueService` owns the decision to skip dispatch; it reads connectivity through the same callback-binding seam `bindSendCommand` already established, never touching `AgentServer` internals directly |
| Ack/NAK handling (AGT-03) | API/Backend (`QueueService.onAgentAck()`) | Database/Storage (`queue_job.status`, `retries`) | Unchanged by this phase — Phase 2 already implemented and verified this path |
| Disconnect-triggered recovery (D-12/D-13) | API/Backend (new `AgentServer` disconnect hook → `QueueService.onAgentDisconnected()`) | Database/Storage (`queue_job`, `booth_state`) | The transport (`AgentServer`) only knows "the socket closed"; only `QueueService` knows whether that means a job needs unwinding — same separation as the existing ack/event callback pattern |
| Event coverage (AGT-04, D-14) | API/Backend (`QueueService.onAgentEvent()`) | Database/Storage (log only, no new columns) | All ten event types are already delivered to this one function via the existing `eventHandler` callback; the gap is purely in how many of them have a branch |
| Heartbeat / offline detection (AGT-05) | API/Backend (`AgentServer`'s `heartbeatTimer`) | Client (`dslrbooth-agent`'s own 15s heartbeat send) | Already fully implemented both sides; this phase should add a test, not new logic |
| Client-side reconnect backoff | Client (`dslrbooth-agent`'s `WsConnection`) | — | Already implemented (exponential 2s→30s) and, per this session's research into `ws` internals, already correctly engaged by a 401 upgrade rejection — no new code needed here (see Pitfall "Client already handles a 401 correctly") |

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| AUTH-01 | Agent xác thực qua token/API key khi kết nối WebSocket | Currently query-string + `!==`, checked post-handshake `[VERIFIED: mirror-request/src/agent/agentServer.ts:37-43]`. D-05..D-09 fully specify the replacement; see "Pattern 1: Upgrade-time header auth" below. |
| AGT-01 | WS server chấp nhận Agent duy nhất, xác thực token | Single-agent replacement (last-wins) already implemented `[VERIFIED: mirror-request/src/agent/agentServer.ts:44-49]`; D-10 keeps it, D-11 adds the missing displaced/arriving log line. |
| AGT-02 | Gửi lệnh {type, action, jobId, mode} khi dispatch | Partially implemented — `type`/`action`/`jobId` present, **`mode` is never sent** `[VERIFIED: mirror-request/src/queue/queueService.ts:216]`. This is a real gap this research surfaced (not named in 03-CONTEXT.md's decisions) — see "A Fifth Gap" below. Must be fixed for the requirement to be literally satisfied. |
| AGT-03 | Nhận ack {jobId, ok, errorMessage} từ Agent | Already implemented and unaffected by this phase's decisions `[VERIFIED: mirror-request/src/agent/agentServer.ts:61-66, mirror-request/src/queue/queueService.ts:158-168]`. Roadmap's M3 criterion 3 wording ("ack ... triggers IDLE transition") does not literally match current behavior (`ok=true` keeps the booth BUSY, transitioning the job to `in_progress`, not IDLE) — flagged in Open Questions, not assumed to be a defect. |
| AGT-04 | Nhận event từ Agent (10 named types) | 3 of 10 handled today `[VERIFIED: mirror-request/src/queue/queueService.ts:170-177]`. D-14 requires research to classify all ten; see "Pattern 5: Event-coverage fallback" below. |
| AGT-05 | Heartbeat — nếu > 30s không nhận, Agent offline | Already fully implemented (`HEARTBEAT_TIMEOUT_MS` default 30 000 `[VERIFIED: mirror-request/src/config.ts:97]`, watchdog `[VERIFIED: mirror-request/src/agent/agentServer.ts:127-139]`). No behavior change required; **no test exists today** — Wave 0 gap. |

</phase_requirements>

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**The governing principle for this phase**
- D-01: A system-side fault never consumes the guest's retry budget. The bounded retry policy Phase 2 built (via `handleStall()`) exists to stop a bad job from blocking the queue. An Agent that is offline, or that drops mid-session, is a fault of the booth — not of the job. Only session-side faults (ack timeout, Agent NAK) consume retries. This governs D-02 and D-10, and is the tie-breaker for any similar case research surfaces.

**Dispatching when the Agent is not connected**
- D-02: Check Agent connectivity before dispatching. If not connected: do not dispatch, leave the booth IDLE, leave the job queued, do not increment `retries`. The job keeps its place in line.
- D-03: Log the skipped dispatch once per state change, not on every 250ms tick.
- D-04: When the Agent reconnects, the normal tick dispatches the head of the queue. No separate wake-up path.

**Agent authentication**
- D-05: Move the token to an `Authorization: Bearer <token>` header. The server accepts only the header — the query-string path is removed, not deprecated. Reversibility: one-way — a published integration contract between two deployed components.
- D-06: Reject unauthorized upgrades at the HTTP upgrade step with 401, before the handshake completes. An unauthenticated client must never reach an open socket.
- D-07: Compare the token with a timing-safe comparison, matching Phase 1's HMAC verification. Guard against the length-mismatch throw (`timingSafeEqual` Pitfall 2).
- D-08: The token is never written to a log line, in any form, at any level — including on the rejection path. Phase 1 D-12's rule (generic reason only, never secrets or validation detail) applies here unchanged.
- D-09: `dslrbooth-agent/src/websocket/connection.ts:53-54` is updated in this same phase to send the header instead of the query string.

Deployment consequence, accepted deliberately: server and Agent must deploy together. A server on the new build with an Agent on the old one rejects every connection and the booth stops serving. Must be stated plainly in `mirror-request/docs/OPS-RUNBOOK.md` alongside the webhook signing contract.

**A second Agent connecting**
- D-10: Keep last-wins. It lets a real Agent recover after a flaky network drop without waiting for the heartbeat watchdog.
- D-11: But log it: a `warn` naming both the displaced and the arriving agent id.

**The Agent dying mid-session**
- D-12: A disconnect while the booth is BUSY resets the booth to IDLE and returns the in-flight job to `queued`, preserving `queued_at`, without incrementing `retries`.
- D-13: This must not double-fire with Phase 2's `busyTimer`. Whichever path acts first must leave the other a no-op — a job must never be requeued twice for one failure.

**Event coverage (AGT-04) — flagged for research, not yet decided**
- D-14: Research must establish, for each of the ten event types, whether Phase 3 owes it a behavior, a persisted record, or only a log line — and whether any are consumed by Phase 5's display feed. Unhandled types must at minimum not be silently dropped.

### Claude's Discretion

- The exact wire shape of the `Authorization` header handling on the Node `upgrade` event, and how the 401 response is written to the raw socket.
- Whether disconnect-triggered requeue reuses a Phase 2 method or introduces a new one, provided D-13's no-double-requeue guarantee holds and is tested.
- Log wording and levels, within D-03's once-per-state-change and D-08's no-token rules.

### Deferred Ideas (OUT OF SCOPE)

- Removing the query-string auth path was **not** deferred — deleted in this phase (D-05).
- Guest-facing status API and the display feed consuming Agent online/offline state — Phase 5.
- Photo delivery triggered by `file_upload` — Phase 4. Phase 3 only ensures the event arrives and is routed.
- Multi-booth support and per-booth Agent routing — out of scope per PROJECT.md.
- Giving each test file its own database — still open ledger item 4 (WINDOWS.md); Phase 3 must at minimum not make it worse.

</user_constraints>

## Project Constraints (from CLAUDE.md)

`mirror-request/CLAUDE.md` states hard rules directly binding this phase:

- **NEVER call dslrBooth Local API directly — all commands go through Agent via WS.** Confirms this phase only ever composes/receives WS payloads; it must never reach past the Agent (it doesn't — no `dslrbooth/client.ts`-equivalent exists in `mirror-request/`, confirmed by directory listing).
- **All business logic lives HERE [the central service]. Agent is a dumb relay only.** Confirms the connectivity gate (D-02..D-04), the disconnect-recovery policy (D-12/D-13), and the event-classification decision (D-14) all belong in `QueueService`, not `dslrbooth-agent`. The Agent's only Phase 3 change is D-09's header (a transport detail, not a business decision) — consistent with `dslrbooth-agent/src/triggers/server.ts` already forwarding **every** dslrBooth event verbatim without interpreting any of them `[VERIFIED: dslrbooth-agent/src/triggers/server.ts:40-45]`.
- Runtime: Node.js 20 LTS, TypeScript. Packages: express, ws, better-sqlite3, winston, dotenv. `ws` is already a dependency in both repos (`mirror-request/package.json`: `"ws": "^8.18.0"`; `dslrbooth-agent/package.json`: `"ws": "^8.18.0"`) — no new dependency needed for the transport itself.

## Existing Code Audit — Verified This Session

All line numbers below were read directly from source this session (both repos); where 03-CONTEXT.md cited a line range, it is confirmed accurate.

### `mirror-request/src/agent/agentServer.ts` (145 lines)
- `start()` (23-94): registers `httpServer.on('upgrade', ...)` (29-35) which calls `handleUpgrade()` **unconditionally** for `/agent` — no auth check before the handshake.
- Token check (37-43): reads `req.url` query string `?token=`, compares with `!==`, closes with `ws.close(4001, 'unauthorized')` **after** the WS connection is already open.
- Single-agent replacement (44-49): closes the prior connection with no log line (D-10/D-11 gap).
- Message dispatch (51-78): `ack`/`event`/`heartbeat` discriminated by `type`; unknown types get a `warn` (76) — this pattern is the direct precedent for D-14's "not silently dropped" fallback.
- Close handler (80-85): `if (this.agentConn?.id === id) { this.agentConn = null; logger.info(...) }` — this existing guard is exactly what prevents a stale (displaced) connection's async `close` event from acting after a newer Agent has already taken over (see Pitfall "The existing close-guard is reusable for D-12/D-13").
- `sendCommand()` (112-119) and `sendEvent()` (121-125) already return `boolean`, already log a `warn` on no connection — nothing new needed here.
- Heartbeat watchdog (127-139): `HEARTBEAT_INTERVAL` (module constant, line 6, `15_000`) is **not** injectable; `HEARTBEAT_TIMEOUT_MS` **is**, via `this.config = getConfig()` (15). This asymmetry matters for testing AGT-05 (see Validation Architecture).

### `mirror-request/src/queue/queueService.ts` (277 lines — Phase 2's output, already includes `recover()`, `handleStall()`, `getInFlightJobs()` usage)
- `dispatchJob()` (211-218): marks `dispatched`, `setBoothBusy()`, `startBusyTimer()`, then `this.sendCommandCb?.({ type: 'command', action: 'start_session', jobId: job.id })` (216) — **no `mode` field**, return value discarded (there is none to discard; the callback type is `void`, so even reacting to failure requires changing the callback's binding, not just reading a return value — see Pattern 2).
- `onAgentEvent()` (170-178): `if/else if` chain, three branches (`session_end`, `session_start`, `file_upload`), **no final `else`** — the seven others fall through silently.
- `onAgentAck(jobId, ok, ...)` (158-168): `ok=true` → `sessionAcked()` (job → `in_progress`, booth stays BUSY); `ok=false` → `setBoothIdle()` + `handleStall(jobId, 'agent_nak')` (booth → IDLE, retry-charged). This existing behavior is unaffected by any D-01..D-14 decision — confirmed not to require changes.
- `handleStall()` (122-130): **always** increments `retries` via `store.requeueWithRetry()`. This is the exact reason D-12/D-13's disconnect path cannot reuse `handleStall()` directly — doing so would violate D-01's governing principle. A parallel no-retry path is required (Pattern 4).
- `tick()` (180-187): runs every 250ms via `setInterval` (`start()`, line 49); this is the natural home for D-02's connectivity gate given D-03's "once per state change, not every tick" wording (see Pattern 2's reasoning).
- `createQueueService()` (259-276): the binding factory — `bindSendCommand`, `registerAckHandler`, `registerEventHandler`, `bindAnnouncement` are all wired here. Any new callback (connectivity read, disconnect handler) belongs in this same function, following the identical pattern.

### `mirror-request/src/state/localStore.ts`
- `getInFlightJobs()` (197-201) **already exists** (Phase 2 output): `SELECT * FROM queue_job WHERE status IN ('dispatched','in_progress') ORDER BY dispatched_at DESC` — directly reusable by the disconnect path (Pattern 4), no new query needed for "what job is currently in flight."
- `requeueWithRetry()` (206-212) **always** increments `retries` — confirmed not reusable for D-12 without violating D-01.
- No existing method requeues **without** incrementing `retries`. New method needed (Pattern 4).

### `dslrbooth-agent/src/websocket/connection.ts` (185 lines)
- `connect()` (44-103): line 53-54 builds `?token=${encodeURIComponent(token)}` and appends it to the URL — this is the exact code D-09 replaces.
- `'close'` handler (92-102): unconditionally calls `scheduleReconnect()` if `shouldReconnect` (true unless `disconnect()` was called deliberately) — exponential backoff already implemented (`scheduleReconnect()`, 139-147: starts at `reconnectBaseDelayMs` = 2000ms in `dslrbooth-agent/src/index.ts:35`, doubles each attempt, capped at `reconnectMaxDelayMs` = 30000ms, line 36).
- **No `'unexpected-response'` handler exists.** This session traced `ws`'s source (`websocket.js`, v8.18.0) to confirm what happens without one — see Pitfall "Client already handles a 401 correctly."

### `dslrbooth-agent/` test infrastructure
- **No test framework is installed.** `package.json` has no `vitest`/`jest`/`mocha` in `devDependencies`, and no `test` script exists `[VERIFIED: dslrbooth-agent/package.json]`. There is no `test/` directory of any kind (only `node_modules/*/test` from third-party packages). This is a genuine Wave 0 gap for D-09's client-side change — see Validation Architecture.

## A Fifth Gap — AGT-02's `mode` Field Is Never Sent

Not named in 03-CONTEXT.md's D-01..D-14 (none of the fourteen decisions discuss the dispatch payload's contents), but directly blocks AGT-02's literal text: `{type: "command", action: "start_session", jobId, mode}`.

- `dispatchJob(job: { id: string })`'s parameter type only requires an `id` — the actual object passed in comes from `this.store.getNextQueuedJob()`, whose query (`localStore.ts:170-172`) selects only from `queue_job`, never joining `registration` — so `job.mode` does not exist on it at all, even though `QueueJob`'s TS interface optimistically declares `registration: Registration` (a field this particular query never populates) `[VERIFIED: mirror-request/src/state/localStore.ts:170-172, mirror-request/src/types.ts:13-15]`.
- The `sendCommandCb` call (`queueService.ts:216`) constructs `{ type: 'command', action: 'start_session', jobId: job.id }` — no `mode` key at all.
- `createQueueService()`'s binding (`queueService.ts:266`) does forward `mode: cmd.mode` to `agentServer.sendCommand()`, but since the object built above never set `mode`, it is `undefined` there — `JSON.stringify()` drops `undefined`-valued keys, so the wire payload the Agent receives has no `mode` field, ever, today.
- On the Agent side, `msg.mode as string | undefined) || 'print'` (`dslrbooth-agent/src/index.ts:70`) silently defaults to `'print'`, and `DslrBoothClient.startSession(mode: string = 'print')` (`dslrbooth-agent/src/dslrbooth/client.ts:63`) defaults again — so nothing crashes, but **every session the physical booth actually runs is `'print'` mode regardless of what the guest selected at registration.**

**Fix:** `dispatchJob()` needs the job's registration mode before composing the command. `LocalStore.getJobRegistration(jobId)` already exists and already performs the exact join needed (`localStore.ts:294-305`) — call it inside `dispatchJob()` (or thread the mode through from wherever the job was already fetched) and pass `mode: registration.mode` into the `sendCommandCb` payload. This is a one-line addition to an existing, already-correct helper method — no new query needed.

## Standard Stack

### Core (all already installed, both repos)

| Library | Version (installed) | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `ws` | `^8.18.0` pinned; `8.21.1` installed in `mirror-request` `[VERIFIED: node -e "require('ws/package.json').version" this session]`, `^8.18.0` pinned in `dslrbooth-agent` (not independently re-verified — same lockfile-driven install) | WS server + client transport | Already the project's WS library on both sides; version supports `headers` on client construction and both `verifyClient`/manual-socket rejection on the server (see Architecture Patterns) |
| `crypto` (Node built-in) | Node 20 LTS | `timingSafeEqual` for D-07 | Already the exact mechanism Phase 1 established for HMAC verification (`webhookAuth.ts:1,77`) — reuse, don't reinvent |
| `winston` | `^3.14.2` | D-11/D-14 log lines | Already `queueService.ts`'s logger (`labelLogger('queue')`); `agentServer.ts` currently imports the default `logger` directly rather than a labeled child — a minor, optional consistency fix, not required by any D-01..D-14 decision |

### Supporting — new to `dslrbooth-agent` only

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `vitest` | `^2.1.4` (match `mirror-request`'s pin for consistency; registry currently offers `4.1.10` `[VERIFIED: npm view vitest version this session]`, but matching the sibling repo's major version avoids introducing a second toolchain convention for the same two-person-maintained project) | Unit test for D-09's header-construction change in `connection.ts` | `dslrbooth-agent` has zero test infrastructure today — this is a new addition, not an upgrade |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Reusing `handleStall()` for D-12's disconnect path | A new `requeueNoRetry()` method + inline orchestration in a new `onAgentDisconnected()` | `handleStall()` is structurally retry-charging by design (D-05/D-07's contract) — bending it to sometimes skip the increment would make its one job ambiguous. A parallel, equally small method keeps both call sites' intent legible and matches D-01's governing principle literally. |
| `ws`'s `verifyClient` option for upgrade-time rejection | Manual check-then-`handleUpgrade()` in the existing `httpServer.on('upgrade', ...)` handler | `verifyClient` only applies when `WebSocketServer` owns the HTTP server directly; this codebase already uses `noServer: true` with manual routing shared between `/agent` and `/display` on one `httpServer` (`agentServer.ts:24-27`, `displayServer.ts:24`) — switching to `verifyClient` would require restructuring both listeners. The manual pattern is the documented alternative for exactly this `noServer` shape (see Pattern 1). |
| Faking `HEARTBEAT_INTERVAL` via `vi.useFakeTimers()` for the AGT-05 test | Making `HEARTBEAT_INTERVAL` an injectable constructor parameter (default `15_000`) | Fake timers plus a real WS socket is a plausible combination (vitest's fake timers only intercept `setTimeout`/`setInterval`/`Date`, not the underlying socket I/O) but unverified in this session against this exact codebase. An injectable parameter is a smaller, precedented change (`startBusyTimer(jobId, timeoutMs = this.sessionTimeoutMs)` already accepts an override, `queueService.ts:220`) and removes the uncertainty entirely. |

**Installation:**
```bash
cd dslrbooth-agent && npm install --save-dev vitest@^2.1.4 @types/node@^22.5.0
```
(`@types/node` already present; listed for completeness — only `vitest` is actually new.)

**Version verification performed this session:**
```
node -e "console.log(require('ws/package.json').version)"   → 8.21.1 (mirror-request, matches ^8.18.0 pin)
npm view vitest version                                       → 4.1.10 (registry latest; recommend pinning ^2.1.4 to match mirror-request)
npm view ws version                                            → 8.21.3 (registry latest; already-installed 8.21.1 is current enough, no action needed)
npm view ws scripts.postinstall / vitest scripts.postinstall  → both empty (no postinstall scripts, no supply-chain red flag)
```

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `vitest` | npm | mature (first published years ago; latest `4.1.10` published 2026-07-06) | 89,744,366/week `[VERIFIED: gsd-tools package-legitimacy check this session]` | `github.com/vitest-dev/vitest` | OK | Approved |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

`ws` is not re-audited here — it is already an installed, in-production dependency in both repositories with no version change proposed.

## Architecture Patterns

### System Architecture Diagram

```text
mirror-request (server)                              dslrbooth-agent (client)
========================                              ========================

  httpServer.on('upgrade', ...)   <--- HTTP Upgrade: GET /agent
    |  Authorization: Bearer <token>  ----------------------  WsConnection.connect()
    |                                                          new WebSocket(url, {
    v                                                            headers: {
  [NEW] check header BEFORE                                        authorization: `Bearer ${token}`
  handleUpgrade():                                                }
    - missing/malformed header?  ---- 401, socket.destroy() --->  })
    - timing-safe compare fails? ---- 401, socket.destroy() --->  'unexpected-response' (no listener
                                                                     registered) -> ws internally emits
                                                                     'error' + 'close' -> scheduleReconnect()
                                                                     (existing exponential backoff, 2s->30s)
    - compare passes
    v
  wss.handleUpgrade() -> 'connection'
    |
    v
  [D-10/D-11] existing agent present?
    - yes: log `warn` (old id, new id), close old ws
           (old ws's 'close' handler no-ops: this.agentConn.id
            already reassigned to the NEW id by the time the
            old socket's async close fires)
    - assign this.agentConn = { ws, id, lastHeartbeat, online }
    v
  ws.on('message') -> type: ack | event | heartbeat
    |                                                          ws.send({type:'ack', jobId, ok, errorMessage})
    |  ack -----------------> QueueService.onAgentAck()        ws.send({type:'event', event, jobId, payload})
    |  event ---------------> QueueService.onAgentEvent()      ws.send({type:'heartbeat', timestamp})
    |    [D-14] 3 handled (session_end, session_start,
    |          file_upload); [NEW] final `else` logs+
    |          does-not-drop the other 7
    v
  ws.on('close') -> [NEW] if (this.agentConn?.id === id)
    disconnectHandler()  ------> QueueService.onAgentDisconnected()
                                   [D-12/D-13] if booth === 'BUSY':
                                     clearBusyTimer()  <-- mutual exclusion with
                                     store.setBoothIdle()   the live busyTimer path
                                     for each getInFlightJobs():
                                       store.requeueNoRetry(id)  <-- NEW method,
                                     tick()                          does NOT touch retries

  heartbeatTimer (setInterval 15s) -> elapsed > HEARTBEAT_TIMEOUT_MS (30s)?
    -> agentConn.online = false; ws.close(4002); agentConn = null   (AGT-05, unchanged)

  ---------------------------------------------------------------------------
  QueueService.tick() (every 250ms)
    booth === 'IDLE' && queued job exists?
      [NEW D-02/D-03] isAgentOnlineCb()?
        false -> log warn ONCE (flag-guarded), return (booth stays IDLE,
                  job stays queued, retries untouched) — D-04: next tick
                  after Agent reconnects just works, no wake-up path
        true  -> beginAnnouncement(job)  [existing, 5-10s countdown]
                    |
                    v
                dispatchJob(job) after countdown
                  [NEW defense-in-depth] isAgentOnlineCb()? (Agent may have
                    dropped DURING the countdown)
                    false -> setBoothIdle(), tick(), return (job never left
                              'queued', nothing to unwind, no retry charge)
                    true  -> [FIX] fetch registration.mode via
                              getJobRegistration(job.id) — AGT-02's payload
                              is incomplete without it
                             updateJobStatus(dispatched) -> setBoothBusy()
                             -> startBusyTimer() -> sendCommandCb({type,
                                action:'start_session', jobId, mode})
```

### Recommended Project Structure (extends existing layout — no new top-level folders)
```
mirror-request/src/
├── agent/
│   └── agentServer.ts        # existing — rewrite upgrade auth (D-05..D-09),
│                               #   add D-11 replacement log, add disconnect
│                               #   handler registration (D-12/D-13)
├── queue/
│   └── queueService.ts        # existing — add isAgentOnlineCb gate (D-02..D-04),
│                               #   add onAgentDisconnected() (D-12/D-13), add
│                               #   final else in onAgentEvent() (D-14), fix
│                               #   dispatchJob()'s missing mode field
├── state/
│   └── localStore.ts          # existing — add requeueNoRetry() (no schema change)
└── index.ts                   # existing — createQueueService() wires the new
                                #   disconnect callback and isAgentOnline read

dslrbooth-agent/src/
├── websocket/
│   └── connection.ts          # existing — line 53-54: headers instead of query string
├── config.ts                  # existing — unchanged (token already typed)
└── (new) test infrastructure  # package.json devDependencies + vitest.config.ts +
                                #   test/connection-auth.test.ts (Wave 0 gap)
```

### Pattern 1: Upgrade-time header auth, rejected before handshake (D-05..D-08)
**What:** Move the token check from the post-handshake `'connection'` handler to the `'upgrade'` handler, before `wss.handleUpgrade()` is ever called. On failure, write a bare 401 directly to the raw socket and destroy it — never call `handleUpgrade()`.
**Why this mechanic:** Confirmed via `ws`'s own documentation (read this session) and cross-checked WebSearch results: with `noServer: true` (this codebase's mode), there is no `verifyClient` hook — rejection must happen manually, before `handleUpgrade()`, by writing an HTTP response straight to the socket. This is a documented, common pattern `[CITED: github.com/websockets/ws/blob/master/doc/ws.md — 'wsClientError' event doc: "Any HTTP response, including response headers and body, must be written directly to the socket"; cross-checked via WebSearch against multiple independent real-world examples of the identical `socket.write('HTTP/1.1 401 ...\r\n\r\n'); socket.destroy();` idiom]`.
**Example:**
```typescript
// mirror-request/src/agent/agentServer.ts — httpServer.on('upgrade', ...) handler
httpServer.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;
  if (pathname !== '/agent' || !this.wss) return;

  const authHeader = req.headers.authorization ?? '';
  if (!this.isValidBearerToken(authHeader)) {
    logger.warn('Agent WS rejected: invalid or missing Authorization header'); // D-08: no token value, ever
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  this.wss.handleUpgrade(req, socket, head, (ws) => {
    this.wss?.emit('connection', ws, req);
  });
});

// D-07: timing-safe, length-guarded (mirrors webhookAuth.ts:74-77 exactly)
private isValidBearerToken(authHeader: string): boolean {
  const prefix = 'Bearer ';
  if (!authHeader.startsWith(prefix)) return false;
  const received = Buffer.from(authHeader.slice(prefix.length), 'utf8');
  const expected = Buffer.from(this.config.AGENT_WS_TOKEN, 'utf8');
  if (received.length !== expected.length) return false; // guards timingSafeEqual's throw
  return timingSafeEqual(received, expected);
}
```
The `'connection'` handler's old token-check block (agentServer.ts:37-43, including the `ws.close(4001, ...)` line) is now dead code and should be deleted, not left alongside the new check — an authenticated-only-by-upgrade socket reaching `'connection'` needs no second gate.

### Pattern 2: Client sends the header, not the query string (D-09)
**What:** `dslrbooth-agent/src/websocket/connection.ts`'s `connect()` method builds the WS URL with the token as a query parameter; replace with the `headers` constructor option.
**Confirmed mechanic:** `ws`'s client constructor accepts "any other option allowed in `http.request()` or `https.request()`" `[CITED: github.com/websockets/ws/blob/master/doc/ws.md]`, which includes `headers`; WebSearch cross-check found the identical idiom (`headers: { authorization: 'Bearer ${token}' }`) used in multiple independent real-world WS-auth examples `[CITED, MEDIUM confidence, cross-checked across >2 independent sources]`.
**Example:**
```typescript
// dslrbooth-agent/src/websocket/connection.ts — connect(), replacing lines 52-62
try {
  this.ws = new WebSocket(this.config.url, {
    headers: this.config.token ? { authorization: `Bearer ${this.config.token}` } : undefined,
    handshakeTimeout: 10000,
    perMessageDeflate: false,
  })
} catch (err) { /* unchanged */ }
```
No change is needed to `'close'`/`'error'` handling — see the next pitfall for why a 401 already reaches `scheduleReconnect()` without a new `'unexpected-response'` listener.

### Pattern 3: Dispatch connectivity gate — two checkpoints, not one (D-02..D-04)
**What:** `QueueService` needs to know whether the Agent is connected without depending on `AgentServer` directly (the existing binding-callback pattern, not a new coupling). Two checkpoints are needed, not one — a primary gate at `tick()` (satisfies D-03's "once per state change, not every 250ms tick" by never starting an announcement while offline) and a secondary defense-in-depth check inside `dispatchJob()` itself (closes the narrow 5-10s race where the Agent disconnects *during* the `ANNOUNCING` countdown, after `tick()` already started it while the Agent was still online).
**Why two checkpoints, reasoned from D-03's exact wording:** if the check lived only inside `dispatchJob()`, a fully-offline booth would still run a full 5-10s `ANNOUNCING` cycle every 250ms tick (`tick()` finds IDLE + queued + starts announcing every time, since nothing stops it), producing one skipped-dispatch log line every 5-10s over a long outage — not "once per state change." Gating at `tick()` means an offline booth simply never leaves IDLE, and the one-time flag naturally covers the entire outage.
**Example:**
```typescript
// queueService.ts — new field + tick() gate
private isAgentOnlineCb: () => boolean = () => true; // default preserves existing tests
private agentOfflineDispatchSkipLogged = false;

bindIsAgentOnline(cb: () => boolean): void { this.isAgentOnlineCb = cb; }

private tick(): void {
  const booth = this.store.getBoothState();
  if (booth !== 'IDLE') return;
  if (this.announcingJobId) return;
  const job = this.store.getNextQueuedJob();
  if (!job) return;
  if (!this.isAgentOnlineCb()) {
    if (!this.agentOfflineDispatchSkipLogged) {
      queueLogger.warn(`Skipping dispatch: Agent not connected (job ${job.id} stays queued)`); // D-03
      this.agentOfflineDispatchSkipLogged = true;
    }
    return; // D-02: booth stays IDLE, job stays queued, retries untouched
  }
  this.agentOfflineDispatchSkipLogged = false; // D-04: next online tick just proceeds
  this.beginAnnouncement(job);
}

// dispatchJob() — new guard as the FIRST line, before any state mutation
private dispatchJob(job: { id: string }): void {
  if (!this.isAgentOnlineCb()) {
    queueLogger.warn(`Skipping dispatch: Agent disconnected during announcement (job ${job.id} stays queued)`);
    this.store.setBoothIdle(); // ANNOUNCING -> IDLE; job was never marked 'dispatched', nothing to unwind
    this.tick();
    return;
  }
  const registration = this.store.getJobRegistration(job.id)?.registration; // fixes AGT-02's missing mode
  const now = Date.now();
  this.store.updateJobStatus(job.id, 'dispatched', 'dispatched_at', now);
  this.store.setBoothBusy();
  this.startBusyTimer(job.id);
  this.sendCommandCb?.({ type: 'command', action: 'start_session', jobId: job.id, mode: registration?.mode });
  queueLogger.info(`Dispatched job ${job.id} → Agent`);
}
```
`createQueueService()` wires the read exactly like every other binding:
```typescript
qs.bindIsAgentOnline(() => agentServer.isAgentOnline()); // AgentServer.isAgentOnline() already exists, unchanged
```

### Pattern 4: Disconnect-triggered, no-retry-charged requeue (D-12/D-13)
**What:** A new `AgentServer` hook fires only when the *currently active* connection (not a stale, displaced one) closes; `QueueService` reacts by unwinding a BUSY booth without touching `retries`.
**Why the existing `if (this.agentConn?.id === id)` guard (agentServer.ts:81) already solves the D-10/last-wins interaction:** when a second Agent connects, the code closes the OLD `ws` (line 45) *before* reassigning `this.agentConn` to the new connection (line 48). The old socket's `'close'` event fires asynchronously, later — by then `this.agentConn.id` already holds the *new* agent's id, so the guard correctly treats the old close as a no-op. The new disconnect hook must sit **inside** this same guarded block, not fire unconditionally.
**Why the mutual-exclusion with `busyTimer` (D-13) is safe by construction, not by a manual lock:** Node's single-threaded event loop guarantees the `busyTimer`'s `setTimeout` callback and the socket's `'close'` callback can never interleave — whichever macrotask is dequeued first runs to completion before the other can start. So it is sufficient for each path to (a) check current state before acting, and (b) cancel the other path's pending trigger as part of its own action. No new locking primitive is needed.
**Example:**
```typescript
// agentServer.ts — new hook, registered the same way as ackHandler/eventHandler
private disconnectHandler: () => void = () => {};
registerDisconnectHandler(fn: () => void): void { this.disconnectHandler = fn; }

// inside ws.on('close', ...) — existing guard, one new line added
ws.on('close', () => {
  if (this.agentConn?.id === id) {
    this.agentConn = null;
    logger.info('Agent disconnected');
    this.disconnectHandler(); // NEW
  }
});
```
```typescript
// localStore.ts — new method, parallel to requeueWithRetry() but D-01-compliant
// queued_at omitted from SET list (D-06's FIFO-preservation guarantee, same as
// requeueWithRetry) — retries is deliberately NOT touched: a system-side fault
// (Agent disconnect) must never spend the guest's retry budget (D-01).
requeueNoRetry(jobId: string): void {
  this.db.prepare("UPDATE queue_job SET status = 'queued' WHERE id = ?").run(jobId);
}
```
```typescript
// queueService.ts — new orchestration method
onAgentDisconnected(): void {
  if (this.store.getBoothState() !== 'BUSY') return; // D-13: already resolved by busyTimer, or never dispatched — no-op
  this.clearBusyTimer(); // D-13: cancel the live timeout so it cannot ALSO fire for this job
  this.store.setBoothIdle();
  for (const job of this.store.getInFlightJobs()) { // reuses Phase 2's existing query, no new SQL needed
    this.store.requeueNoRetry(job.id); // D-01/D-12: no retry charged
    queueLogger.warn(`Job ${job.id} requeued after Agent disconnect (no retry charged)`);
  }
  this.tick();
}
```
```typescript
// createQueueService() — one new binding line, same pattern as the other three
agentServer.registerDisconnectHandler(() => qs.onAgentDisconnected());
```
**Note on ANNOUNCING-state disconnects:** `onAgentDisconnected()` deliberately only acts when `booth === 'BUSY'`. If the Agent disconnects during the 5-10s `ANNOUNCING` countdown, `onAgentDisconnected()` no-ops (booth isn't BUSY yet), and Pattern 3's `dispatchJob()` guard catches it cleanly when the countdown elapses — no double-handling needed, matching this codebase's existing "ANNOUNCING resolves itself within 5-10s, not worth extra complexity" philosophy already established for Phase 2's restart-recovery `ANNOUNCING → IDLE` case.

### Pattern 5: Event-coverage fallback (D-14)
**What:** A single final `else` branch in `onAgentEvent()` that logs any event type without a specific handler, satisfying "not silently dropped" for all seven currently-unhandled types (`countdown_start`, `countdown`, `capture_start`, `file_download`, `processing_start`, `sharing_screen`, `printing`) — and, as a side benefit, any future/unnamed event `dslrbooth-agent/src/triggers/server.ts` forwards, since that file forwards **every** dslrBooth-emitted event type verbatim without filtering (`triggers/server.ts:40-45`), not just the ten named in AGT-04.
**Classification (D-14's required per-event answer):**

| Event | AGT-04 named | Phase 3 owes | Reasoning |
|-------|:---:|---|---|
| `session_start` | yes | Behavior (existing — `sessionAcked()`) | Already handled; see Open Questions for a possible double-stamp overlap with the `ack` message type, not a new decision this research makes unilaterally |
| `session_end` | yes | Behavior (existing — `sessionEnded()`) | Already handled, unchanged |
| `file_upload` | yes | Behavior (existing — triggers notification) | Already handled, unchanged; NOT-01 is Phase 4's concern |
| `countdown_start` | yes | Log only | No queue-state implication (booth already BUSY); today's `DisplaySnapshot` (`types.ts:67-77`) has no field for an in-session countdown — Phase 5 would need new scope to consume this, not assumed here |
| `countdown` | yes | Log only (debug level) | Same as above; likely fires once per second during the capture countdown — must not be `info`-level or it floods logs (same spam concern D-03 raises for dispatch-skip) |
| `capture_start` | yes | Log only | No queue-state implication |
| `file_download` | yes | Log only | No consumer identified in `mirror-request/src/display/` or Phase 4's notification seam; distinct from `file_upload` (which already has a defined consumer) |
| `processing_start` | yes | Log only | No queue-state implication |
| `sharing_screen` | yes | Log only | No queue-state implication |
| `printing` | yes | Log only | No queue-state implication; `OPS-RUNBOOK.md`'s `stall_reason` vocabulary doesn't reference printing failures, so no persisted record is owed by this phase |

**Example:**
```typescript
// queueService.ts — onAgentEvent(), add a final else
onAgentEvent(eventType: string, jobId?: string, payload?: Record<string, unknown>): void {
  if (eventType === 'session_end') {
    this.sessionEnded();
  } else if (eventType === 'session_start' && jobId) {
    this.sessionAcked(jobId);
  } else if (eventType === 'file_upload' && jobId && payload) {
    this.sendNotification(jobId, String(payload.photoUrl ?? ''));
  } else {
    // D-14: not silently dropped — debug level, since some of these (countdown)
    // can fire multiple times per second and must not flood logs at info/warn.
    queueLogger.debug(`Unhandled Agent event: ${eventType}${jobId ? ` (job ${jobId})` : ''}`);
  }
}
```

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|--------------|-----|
| Rejecting an unauthenticated upgrade before handshake | A custom "pre-auth" WebSocket subprotocol negotiation, or a second `WebSocketServer` instance for auth-checking | Manual `socket.write('HTTP/1.1 401 ...'); socket.destroy();` inside the existing `httpServer.on('upgrade', ...)` handler, before `handleUpgrade()` | This is `ws`'s own documented pattern for `noServer: true` mode `[CITED: ws doc]`; a second server instance or custom subprotocol would duplicate routing logic this codebase already has |
| Timing-safe token comparison | A custom constant-time string-compare loop | `crypto.timingSafeEqual`, length-guarded exactly as `webhookAuth.ts:74-77` already does | Phase 1 already solved this exact problem in this exact codebase; reusing the identical guard avoids re-introducing the length-mismatch throw bug Phase 1's research flagged as Pitfall 2 |
| Detecting "the currently in-flight job" for the disconnect path | A new tracking variable or a second SQL query | `LocalStore.getInFlightJobs()` — already exists from Phase 2, already the single source of truth for "what's in flight" | Building a second mechanism for the same fact (Phase 2's restart-recovery already needed this exact question) risks the two mechanisms drifting, the same class of bug Phase 2 was built to remove |
| Preventing an infinite fast reconnect loop on a permanently-rejecting server | A new backoff/retry-limit mechanism in `connection.ts` | The existing `scheduleReconnect()` (exponential, 2s→30s cap, `connection.ts:139-147`) — already engaged by a 401 rejection without any new code, confirmed by tracing `ws`'s source this session | `ws` already emits both `'error'` and `'close'` for an unhandled non-101 response (`abortHandshake()` → `emitErrorAndClose()`), so the existing `'close'` handler's `scheduleReconnect()` call already fires; adding a parallel mechanism would be redundant and risks double-scheduling reconnect attempts |

**Key insight:** every mechanism this phase needs already has a sibling in this exact codebase — timing-safe comparison (Phase 1), an in-flight-job query (Phase 2), a callback-binding pattern for cross-module wiring (`bindSendCommand`/`registerAckHandler`, Phase 2), and even the disconnect-vs-stale-connection guard (`agentServer.ts:81`, written for D-10's last-wins case, incidentally already solves D-13's race safety too). The entire phase is small, targeted additions that reuse these seams — resist inventing a new pattern where an existing one already fits.

## Common Pitfalls

### Pitfall 1: The existing `agent-websocket.test.ts` will break under the new auth, not just need extension
**What goes wrong:** The one existing test (`does not negotiate permessage-deflate`) deliberately connects with `?token=invalid-test-token` (`agent-websocket.test.ts:34`) and listens for the `'upgrade'` client event to inspect response headers. That event only fires on a successful `101 Switching Protocols` response. Today it works *because* the old code completes the handshake before checking auth. Once D-06 lands, this exact client call gets a 401 before any `'upgrade'` event fires — the test will hang on its `ws.once('upgrade', ...)` promise until timeout, or fail outright.
**Why it happens:** The test's invalid token was orthogonal to its actual intent (checking deflate negotiation) — it happened to work only as a side effect of auth being checked late.
**How to avoid:** Update this test to use a *valid* token via the new header form (`headers: { authorization: 'Bearer test-agent-token' }` — `test-agent-token` is `vitest.config.ts`'s configured `AGENT_WS_TOKEN` `[VERIFIED: mirror-request/vitest.config.ts]`, quoted here verbatim). The `'upgrade'` event still fires normally on a valid, accepted connection, so the deflate assertion is unaffected once auth passes.
**Warning signs:** This specific test timing out or failing immediately after the auth rewrite lands, with no other test file affected.

### Pitfall 2: `AgentMessage`'s `eventType` union is dead code — do not treat it as a validation gate
**What goes wrong:** `types.ts:29-39` declares `interface AgentMessage { ...; eventType?: 'session_start' | 'session_end' | 'file_upload'; ... }` — a union of only three of the ten AGT-04 types. A future implementer might read this and assume the other seven are intentionally excluded by design.
**Why it happens:** A grep across `src/` and `test/` for `AgentMessage` finds exactly one hit — its own declaration `[VERIFIED: grep -rn "AgentMessage" mirror-request/src mirror-request/test this session — one match]`. It is never imported or used; `agentServer.ts` parses incoming JSON as an untyped `Record<string, unknown>` and reads `msg.event` (not `msg.eventType`) — a field-name mismatch confirming this interface was never actually wired to the runtime parsing path.
**How to avoid:** Do not extend or rely on `AgentMessage.eventType` as part of implementing D-14. If the planner wants a real, load-bearing discriminated-union type for agent messages, that is new scope, not implied by this dead interface.
**Warning signs:** New code importing `AgentMessage` for the first time, or a `switch` on `eventType` (rather than the actual wire field `event`) anywhere in `queueService.ts`.

### Pitfall 3: Importing `DisplayServer` in a test transitively creates the shared `getStore()` singleton — even without calling it
**What goes wrong:** `mirror-request/src/display/displayServer.ts:9` runs `const store = getStore();` at **module load time** (not inside a method). Any test file that imports `DisplayServer` — even just for an unrelated assertion, as the existing `agent-websocket.test.ts:5` already does — triggers the shared test-DB singleton as a side effect of the `import` statement alone, regardless of whether the test ever calls a `DisplayServer` method.
**Why it happens:** Module-level side effects in ES modules run once, on first import, for the lifetime of the test process — this is invisible from a test file that never explicitly calls `getStore()` itself.
**How to avoid:** New Phase 3 tests focused purely on `AgentServer`/`QueueService` behavior (auth rejection, D-11's log line, D-12/D-13's disconnect requeue, D-02..D-04's connectivity gate) should **not** import `DisplayServer` unless the test genuinely needs it. This is a stricter bar than "zero explicit `getStore()` calls" (Phase 2's stated constraint) — it also means zero *transitive* imports of anything that calls `getStore()` at module scope.
**Warning signs:** A new Phase 3 test file passes alone but produces different results when run as part of the full suite — the signature of accidental singleton sharing (same class of failure WINDOWS.md ledger item 4 already documents, but via a new, less obvious import path).

### Pitfall 4: The client already handles a 401 correctly — do not add reconnect-loop-prevention code that isn't needed
**What goes wrong:** It is tempting to add an explicit `ws.on('unexpected-response', ...)` handler to `connection.ts` to "make sure" a 401 doesn't cause a hot reconnect loop, since none exists today.
**Why it's unnecessary:** Traced directly in `ws`'s v8.18.0 source this session: when there is no `'unexpected-response'` listener, `ws` internally calls `abortHandshake()`, which destroys the socket and calls `emitErrorAndClose()` — emitting **both** `'error'` and `'close'` `[CITED: raw.githubusercontent.com/websockets/ws/8.18.0/lib/websocket.js, read this session]`. `connection.ts`'s existing `'close'` handler (92-102) already unconditionally calls `scheduleReconnect()`, which already backs off exponentially (2s → 30s cap, `connection.ts:139-147`). A permanently-invalid token therefore already produces, at worst, one reconnect attempt every 30 seconds — not a hot loop.
**How to avoid:** No new code is required for this concern. If a clearer diagnostic log distinguishing "401 auth failure" from "network error" is wanted, an explicit `'unexpected-response'` handler is a reasonable *optional* addition (log the status code only — never the token, never the sent header value), but it is not required for correctness.
**Warning signs:** None — this is a pitfall in the *planning* direction (over-engineering), not a runtime one. Flagging here only so the planner does not spend a task budget on an already-solved problem.

### Pitfall 5: `busyTimer`'s timeout callback has no state-check guard today — but it doesn't need one for D-13 to hold
**What goes wrong:** It may look like `startBusyTimer()`'s `setTimeout` callback (`queueService.ts:222-227`) needs a "is this job still the current one?" guard added, symmetric to the new `onAgentDisconnected()`'s `getBoothState() !== 'BUSY'` check, to make D-13 airtight.
**Why it's not needed:** Node's single-threaded event loop makes the two callbacks (the timer's and the socket's `'close'` handler) mutually exclusive by construction — they can never execute concurrently, only in some order. Whichever runs first (a) checks/changes state and (b) calls `clearBusyTimer()`, which reliably cancels the *other* path's still-pending timer (a timer that has not yet begun executing is always cancellable via `clearTimeout`, unconditionally, in Node). The second-to-run path's own callback — if it's the timer — simply never fires at all (cancelled); if it's `onAgentDisconnected()`, its own `getBoothState() !== 'BUSY'` guard at its top makes it a no-op.
**How to avoid:** Do not add unnecessary defensive checks to `startBusyTimer()`'s existing callback — the guard belongs only in the new `onAgentDisconnected()` (which is genuinely a new, second trigger path), not retrofitted into code Phase 2 already verified.
**Warning signs:** A code review flagging "the timeout path doesn't check state" as a bug — it's correct as-is, given the disconnect path calls `clearBusyTimer()` as part of its own action.

## Code Examples

### Test proving the 401-before-handshake guarantee (D-06, M3 criterion 1)
```typescript
// Source: pattern derived from ws's documented 'unexpected-response' event
// [CITED: github.com/websockets/ws/blob/master/doc/ws.md] plus this codebase's
// existing agent-websocket.test.ts structure (ephemeral port, no getStore()).
import { WebSocket } from 'ws';

it('rejects a connection with no Authorization header at the HTTP upgrade step', async () => {
  const { statusCode, sawOpen } = await new Promise<{ statusCode: number; sawOpen: boolean }>((resolve) => {
    let sawOpen = false;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/agent`); // no headers option at all
    ws.once('open', () => { sawOpen = true; });
    ws.once('unexpected-response', (_req, res) => resolve({ statusCode: res.statusCode, sawOpen }));
  });
  expect(statusCode).toBe(401);
  expect(sawOpen).toBe(false); // M3 criterion 1: "rejected without" — never an open socket
});

it('accepts a connection with a valid Bearer token', async () => {
  const opened = await new Promise<boolean>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/agent`, {
      headers: { authorization: 'Bearer test-agent-token' }, // matches vitest.config.ts's AGENT_WS_TOKEN
    });
    ws.once('open', () => resolve(true));
    ws.once('unexpected-response', () => resolve(false));
  });
  expect(opened).toBe(true);
});
```

### Test proving D-13's no-double-requeue guarantee under fake timers
```typescript
// Source: pattern extends test/queue-countdown.test.ts's fully-mocked-store style
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueService } from '../src/queue/queueService';

describe('disconnect vs busyTimer race (D-13)', () => {
  afterEach(() => vi.useRealTimers());

  it('a disconnect that wins the race leaves the busyTimer a no-op', () => {
    vi.useFakeTimers();
    let booth = 'BUSY';
    const requeueNoRetryCalls: string[] = [];
    const requeueWithRetryCalls: string[] = [];
    const store = {
      getBoothState: () => booth,
      setBoothIdle: () => { booth = 'IDLE'; },
      getInFlightJobs: () => (booth === 'BUSY' ? [{ id: 'job-1' }] : []),
      requeueNoRetry: (id: string) => { requeueNoRetryCalls.push(id); },
      requeueWithRetry: (id: string) => { requeueWithRetryCalls.push(id); return { retries: 1 }; },
      failJob: vi.fn(),
      getNextQueuedJob: () => undefined,
      // ...remaining LocalStore surface stubbed as needed
    } as any;
    const service = new QueueService(store, { SESSION_TIMEOUT_MS: 300_000, SESSION_MAX_RETRIES: 2, NEXT_GUEST_COUNTDOWN_MS: 7000 });
    // simulate startBusyTimer() having been armed by a prior dispatchJob() call,
    // then fire the disconnect BEFORE the timer's 300_000ms elapses
    service.onAgentDisconnected();
    vi.advanceTimersByTime(300_000); // if a stray busyTimer were still armed, it would fire here
    expect(requeueNoRetryCalls).toEqual(['job-1']);
    expect(requeueWithRetryCalls).toEqual([]); // handleStall's path never ran — no retry charged
  });
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Auth checked after WS handshake completes (`4001` close) | Auth checked at the HTTP `upgrade` step, before handshake (`401`, raw socket) | This phase (D-06) | Matches the general WS-security guidance that an unauthenticated peer should never hold an open socket, even briefly `[CITED, MEDIUM confidence — cross-checked across multiple independent examples of the identical pattern, no single canonical spec since this is implementation-level, not protocol-level]` |
| Token in query string | Token in `Authorization: Bearer` header | This phase (D-05) | Query strings are more likely to be logged by intermediate proxies/access logs than headers explicitly excluded from logging; this is the same rationale that motivates most token-based WS auth guides found this session |
| Plain `!==` token comparison | `crypto.timingSafeEqual`, length-guarded | This phase (D-07) | Direct reuse of Phase 1's already-established precedent in this codebase (`webhookAuth.ts`) — no new research needed, just applying the same fix to a second location |

**Deprecated/outdated:**
- The `ws.close(4001, 'unauthorized')` path (`agentServer.ts:41`) becomes dead code once D-06 lands — auth is decided entirely before any `WebSocket` object for a rejected client is ever constructed.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The dispatch-connectivity check belongs at `tick()` (primary) plus `dispatchJob()` (secondary), not solely inside `dispatchJob()` | Pattern 3 | Inferred from D-03's "once per state change, not every 250ms tick" wording, not stated as an explicit architectural instruction in 03-CONTEXT.md. If the planner intends a single checkpoint only, the log-dedup flag would need to move and the ANNOUNCING-race window (5-10s) would need a different closing mechanism. Low implementation cost either way — flag for planner confirmation. |
| A2 | `onAgentDisconnected()` should only act when `booth === 'BUSY'`, deliberately leaving an ANNOUNCING-state disconnect to be caught by `dispatchJob()`'s own guard rather than cancelling `announcementTimer` directly | Pattern 4 | If the planner prefers a single, more aggressive disconnect handler that also cancels a live announcement immediately (rather than waiting up to 5-10s for the countdown to elapse), that's a small additional line (`clearTimeout(this.announcementTimer)` + reset `announcingJobId`/`announcementEndsAt` + `setBoothIdle()`) — flagged as a discretionary tightening, not required for D-12/D-13's literal text. |
| A3 | AGT-02's missing `mode` field is an unintentional gap to fix, not an intentional MVP simplification (single-mode booth) | A Fifth Gap | `Registration.mode` is ingested from the real webhook payload and `DslrBoothClient.startSession(mode)` genuinely forwards it to the physical booth's Local API — nothing in PROJECT.md or REQUIREMENTS.md suggests mode is meant to be ignored. If wrong (single mode is intentional), the fix is simply not applied — no downside to raising it either way, since AGT-02's requirement text explicitly names `mode` as part of the payload contract. |
| A4 | `vitest` (not `jest`/`node:test`) is the right choice for `dslrbooth-agent`'s new test infrastructure | Standard Stack | Chosen for toolchain consistency with the sibling repo maintained by the same team, not because of any Agent-repo-specific constraint. `node:test` (Node 20's built-in runner) would also work with zero new dependencies — a legitimate alternative if the planner prefers not adding any devDependency to the Agent repo at all. |

**If this table is empty:** N/A — see rows above.

## Open Questions

1. **Does M3 success criterion 3's wording ("Agent ack {jobId, ok} logged, triggers IDLE transition") describe current behavior accurately?**
   - What we know: `onAgentAck(jobId, ok=true, ...)` calls `sessionAcked()`, which sets the job to `in_progress` and **keeps the booth BUSY** (re-arming `busyTimer`) — not IDLE. Only `ok=false` (NAK) sets the booth to IDLE (`[VERIFIED: mirror-request/src/queue/queueService.ts:158-168]`).
   - What's unclear: Whether this ROADMAP.md wording is a loose summary (the *session's* eventual IDLE transition happens later, via `session_end`) or describes an intended-but-unimplemented behavior change.
   - Recommendation: 03-CONTEXT.md's D-01..D-14 do not touch ack semantics at all, and 02-VERIFICATION.md already confirmed Phase 2's ack handling as goal-achieved. Treat this as a documentation imprecision, not a code change, unless the planner surfaces evidence otherwise — do not silently alter `onAgentAck()`'s behavior based on this phrasing alone.

2. **Should the `session_start` event (via `onAgentEvent`) and a positive `ack` (via `onAgentAck`) both calling `sessionAcked()` be de-duplicated?**
   - What we know: `dslrbooth-agent/src/index.ts` sends an immediate `{type:'ack', jobId, ok:true}` right after its local `dslrBoothClient.startSession()` call succeeds (line 87), and *separately*, `triggers/server.ts` forwards dslrBooth's own `session_start` webhook event (fired later, when the physical capture UI genuinely starts) as `{type:'event', event:'session_start', jobId}`. Both paths call `QueueService.sessionAcked(jobId)`, which re-stamps `acknowledged_at` and re-arms `busyTimer` each time.
   - What's unclear: Whether this double-stamp is harmless (each call simply extends the busy-timeout window a little further, which only helps the guest) or should be collapsed to a single source of truth.
   - Recommendation: Not required by any D-01..D-14 decision or any named requirement; flagging only because this research surfaced it while reading `onAgentEvent()`'s existing branches for D-14. No code change recommended unless the planner wants to close it explicitly.

3. **Is `dslrbooth-agent`'s new test framework choice (`vitest` vs Node's built-in `node:test`) a decision for this phase or deferred to whoever next touches that repo?**
   - What we know: Zero test infrastructure exists today; D-09 requires a code change to `connection.ts` that this research could not find any existing automated coverage for.
   - What's unclear: Whether adding a full test framework is in scope for a single-file, single-decision change, or whether a lighter-weight approach (a manual verification script, or Node's zero-dependency `node:test` + `node --test`) is more proportionate.
   - Recommendation: Given D-05's "Reversibility: one-way" framing for the whole auth contract, and that this is the very first commit to a newly-version-controlled repo, establishing *some* automated test capability now (rather than deferring) is the safer choice — but the specific framework is genuinely a low-stakes, reversible pick. Vitest is recommended for toolchain consistency; `node:test` is a legitimate zero-dependency alternative.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Runtime, both repos | ✓ | v24.15.0 in this research sandbox (both repos pin `20.x`) `[VERIFIED: node --version this session]` | Deployment target should use Node 20 LTS per both `CLAUDE.md`/`package.json engines`; same sandbox-vs-deploy caveat every prior phase's research flagged, not Phase-3-specific |
| `ws` (server + client) | WS transport, both repos | ✓ | `8.21.1` installed in `mirror-request` `[VERIFIED this session]`; `^8.18.0` pinned in `dslrbooth-agent` (lockfile-driven, not independently re-verified this session) | — |
| `better-sqlite3` | `requeueNoRetry()`'s persistence | ✓ (already verified working by Phase 2's research) | `11.10.0` | — |
| `vitest` | Server-side test execution | ✓ | `2.1.9` `[VERIFIED: npx vitest --version this session]` | — |
| `vitest` (new) | Agent-side test execution | ✗ (not installed) | — | Install as a new devDependency (Standard Stack); alternative fallback is Node's built-in `node:test` runner, requiring zero new dependency |
| Two repositories' git state | Coordinated review/commit across `mirror-request/` and `dslrbooth-agent/` | ✓ both are git repos (`dslrbooth-agent` initialized today at baseline `e3007d5`) `[VERIFIED: git log/git status this session]` | — | — |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** `vitest` on the Agent side — `node:test` is a viable zero-install fallback if the planner prefers not to add a devDependency to a repo this small.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework (server) | Vitest ^2.1.4, running 2.1.9 `[VERIFIED: mirror-request/package.json:42 devDependencies vitest "^2.1.4"; npx vitest --version this session]` |
| Framework (Agent) | **None installed today.** Recommend Vitest ^2.1.4 (Standard Stack) — Wave 0 gap, not yet a config file. |
| Config file (server) | `mirror-request/vitest.config.ts` — sets `AGENT_WS_TOKEN: 'test-agent-token'` and `LOG_LEVEL: 'error'` among other env, distinct test DB path `[VERIFIED: mirror-request/vitest.config.ts]` |
| Config file (Agent) | Does not exist yet — Wave 0 gap: `dslrbooth-agent/vitest.config.ts` |
| Quick run command (server) | `cd mirror-request && npx vitest run test/agent-websocket.test.ts` (or a new Phase 3 test file) |
| Quick run command (Agent) | `cd dslrbooth-agent && npx vitest run test/connection-auth.test.ts` (once Wave 0 lands) |
| Full suite command (server) | `cd mirror-request && npm test` — **measured this session: 16 files, 113 tests, 4.73s wall time**, all passing `[VERIFIED: npm test run this session]` |
| Full suite command (Agent) | Does not exist yet |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| AUTH-01/D-05..D-08 | Reject upgrade with 401 before handshake when Authorization header missing/invalid/absent; timing-safe compare; token never in a log line | unit (real `http.Server` + ephemeral port, real `ws` client, `'unexpected-response'` event — matches `agent-websocket.test.ts`'s existing pattern) | `npx vitest run test/agent-auth.test.ts` | ❌ Wave 0 |
| AUTH-01/D-06 | Accept upgrade with a valid `Authorization: Bearer <token>` header | unit (same harness) | `npx vitest run test/agent-auth.test.ts` | ❌ Wave 0 |
| — (existing) | `does not negotiate permessage-deflate` — must be updated to use a valid header, not the old invalid query-string token | unit | `npx vitest run test/agent-websocket.test.ts` | ✅ existing, **must be fixed**, not just extended (Pitfall 1) |
| AGT-01/D-10/D-11 | Second Agent connecting closes the first (last-wins); a `warn` names both ids | unit (two sequential real `ws` clients against one `AgentServer`) | `npx vitest run test/agent-replacement.test.ts` | ❌ Wave 0 |
| AGT-02 | Dispatch payload includes `mode` sourced from the job's registration | unit (mocked store returning a `getJobRegistration()` result with a known `mode`; assert the exact object passed to `sendCommandCb`) | `npx vitest run test/queue-dispatch-mode.test.ts` | ❌ Wave 0 |
| AGT-02/QUE-03 (regression) | Existing dispatch payload shape `{type, action, jobId}` still correct after the `mode` fix | unit | `npx vitest run test/queue-countdown.test.ts` (extend existing "booth state transitions" block) | ✅ existing, extend |
| D-02/D-03/D-04 | Agent offline: booth stays IDLE, job stays queued, no retry increment, log fires once not every tick; Agent online again: normal tick dispatches with no separate wake path | unit (mocked store + fake timers, `isAgentOnlineCb` toggled mid-test) | `npx vitest run test/queue-dispatch-connectivity.test.ts` | ❌ Wave 0 |
| D-02 (race) | Agent disconnects mid-`ANNOUNCING`: `dispatchJob()`'s own guard reverts to IDLE with no retry charge | unit (mocked store + fake timers, flip `isAgentOnlineCb` between `beginAnnouncement()` and the countdown's elapse) | `npx vitest run test/queue-dispatch-connectivity.test.ts` | ❌ Wave 0 (same file) |
| D-12/D-13 | Disconnect while BUSY resets booth to IDLE, requeues without incrementing `retries`, preserves `queued_at`; cannot double-fire with `busyTimer` | unit (mocked store + fake timers, simulating both trigger orders) | `npx vitest run test/agent-disconnect-requeue.test.ts` | ❌ Wave 0 |
| AGT-04/D-14 | All ten event types reach `onAgentEvent()` without throwing; the seven previously-unhandled types produce a debug log line, not silence | unit (spy on `queueLogger.debug`, matching `db-poller.test.ts`'s `vi.spyOn` pattern for intercepting before Winston's level filter — recall `LOG_LEVEL=error` in test env means only a direct `vi.spyOn` on the logger method, not real transport output, will observe `debug` calls) | `npx vitest run test/queue-event-coverage.test.ts` | ❌ Wave 0 |
| AGT-05 | No heartbeat for 30s → `isAgentOnline()` returns false | unit (real `ws` client + real `AgentServer`, either fake timers for the `setInterval` watchdog + injectable `HEARTBEAT_INTERVAL`, or a short-real-wait fallback) | `npx vitest run test/agent-heartbeat-timeout.test.ts` | ❌ Wave 0 — **no coverage exists today at all** |
| D-09 (Agent side) | `WsConnection.connect()` sends `Authorization: Bearer <token>` header, never a `?token=` query string | unit (spy on the `ws` module's `WebSocket` constructor call, matching `db-poller.test.ts`'s `createRequire` + `vi.spyOn` runtime-require workaround — needed because `connection.ts` imports `ws` via a static `import`, so a plain `vi.mock('ws', ...)` should work here since it *is* a static import unlike `dbPoller.ts`'s lazy `require`, but confirm before assuming) | `dslrbooth-agent/test/connection-auth.test.ts` | ❌ Wave 0, **and the test framework itself doesn't exist yet** |

### Sampling Rate
- **Per task commit:** targeted `npx vitest run <file>` for the file(s) touched, in whichever repo was touched
- **Per wave merge:** `cd mirror-request && npm test` (full suite — currently 113 tests, ~4.7s, cheap enough every merge); `cd dslrbooth-agent && npm test` once Wave 0 establishes it
- **Phase gate:** Full suite green in both repos before `/gsd-verify-work`; additionally, given D-05's "Reversibility: one-way" and the "server and Agent must deploy together" consequence, the phase gate should include a **manual cross-repo smoke check** before the real production cutover — see "Deployment Consequence" below

### Wave 0 Gaps
- [ ] `mirror-request/test/agent-auth.test.ts` — covers AUTH-01/D-05..D-08 (401 before handshake, valid header accepted, timing-safe compare, no token in logs)
- [ ] `mirror-request/test/agent-websocket.test.ts` — **existing test must be fixed** (Pitfall 1), not just left alone, or the suite breaks the moment D-06 lands
- [ ] `mirror-request/test/agent-replacement.test.ts` — covers AGT-01/D-10/D-11
- [ ] `mirror-request/test/queue-dispatch-mode.test.ts` — covers the Fifth Gap (AGT-02's missing `mode`)
- [ ] `mirror-request/test/queue-dispatch-connectivity.test.ts` — covers D-02/D-03/D-04, including the mid-ANNOUNCING race
- [ ] `mirror-request/test/agent-disconnect-requeue.test.ts` — covers D-12/D-13, including the no-double-fire race
- [ ] `mirror-request/test/queue-event-coverage.test.ts` — covers AGT-04/D-14
- [ ] `mirror-request/test/agent-heartbeat-timeout.test.ts` — covers AGT-05 (zero coverage exists today); consider making `HEARTBEAT_INTERVAL` an injectable constructor parameter (mirroring `startBusyTimer`'s existing override-parameter idiom) to make this test fast and reliable rather than fighting fake-timers-vs-real-sockets interaction
- [ ] `dslrbooth-agent/package.json` — add `vitest` devDependency + `test` script (framework install, not just a test file)
- [ ] `dslrbooth-agent/vitest.config.ts` — new file, minimal (no existing pattern to copy from within this repo; can mirror `mirror-request/vitest.config.ts`'s shape)
- [ ] `dslrbooth-agent/test/connection-auth.test.ts` — covers D-09 (header sent, no query string)
- [ ] `mirror-request/docs/OPS-RUNBOOK.md` — new section documenting the auth contract change and the synchronized-deploy requirement (not a test, but a required Wave 0/1 artifact per D-05's explicit instruction)

## Deployment Consequence — What the Runbook Needs to Say

D-05 requires this to be stated plainly in `mirror-request/docs/OPS-RUNBOOK.md` alongside the existing §1 webhook signing contract. Based on this session's read of the existing runbook's style (concrete headers/commands, not abstract prose) and the existing §3 "production-readiness check" pattern, the new section should include:

1. **What breaks and why:** a server on the new build rejects *every* Agent connection from an Agent still sending `?token=` — not a partial degradation, a full outage of the dispatch path (the booth stops receiving `start_session` commands; the queue keeps accepting registrations, but nothing gets served). This mirrors the existing runbook's framing of the webhook HMAC contract as "the published contract... implement exactly."
2. **Deploy ordering:** update and restart both `mirror-request` and `dslrbooth-agent` in the same maintenance window; do not deploy one and defer the other. Unlike the webhook contract (`mirror-request` is the only implementation, so no coordination is needed there), this is genuinely a two-party contract now that `dslrbooth-agent` has its own git history and its own deploy artifact (`dslrbooth-agent.exe`, built via `npm run build:exe` per `dslrbooth-agent/package.json`'s `pkg`-based build script).
3. **A safe verification step before cutover:** the existing runbook's §4 pattern (`NODE_ENV=production node -e "require('./dist/config').loadConfig()"`) is a config-only check with no live traffic involved — the equivalent for this phase is running the new `test/agent-auth.test.ts` suite (a fast, non-production-touching check) plus, if practical, a manual test connection from a build of the updated Agent binary against a *non-production* instance of the updated server before rolling either to production. This session found no existing staging environment reference in `OPS-RUNBOOK.md` or `config.ts` — if none exists, the runbook should say so explicitly rather than imply one, matching this project's established honesty-over-assumption documentation style (e.g., §2's explicit "no built-in retention job... as of Phase 1").
4. **Rollback:** because D-05 is one-way (no dual-accept), rolling the server back to the pre-Phase-3 build while the Agent is already on the new build reproduces the identical outage in the opposite direction. The runbook should say plainly: roll back *both* together, or not at all.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|----------------|---------|--------------------|
| V2 Authentication | Yes | Shared-secret Bearer token, timing-safe compared, rejected before handshake (D-05..D-08) — a machine-to-machine credential, not a user credential, but ASVS V2's constant-time-comparison and no-credential-in-URL guidance both apply directly |
| V3 Session Management | No (in the ASVS web-session sense) | The WS connection itself is the "session"; there is no cookie/JWT session token beyond the single static `AGENT_WS_TOKEN` |
| V4 Access Control | Marginal | Single-tenant, single-Agent system by design (PROJECT.md's explicit single-booth scope) — "access control" here is binary (valid token or not), not role-based |
| V5 Input Validation | Yes | Every inbound WS message (`ack`/`event`/`heartbeat`) is already parsed defensively (`try { JSON.parse(...) } catch { ... }`, `agentServer.ts:53-59`) and every field is coerced with `String(... ?? '')`/`Boolean(...)` before use — this phase adds no new unvalidated input paths, since `mode` (the Fifth Gap fix) flows from `LocalStore.getJobRegistration()`, a server-authored value, never directly from the Agent |
| V6 Cryptography | Yes | `crypto.timingSafeEqual` for D-07 — never hand-roll a constant-time compare (Don't Hand-Roll table) |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|-----------------------|
| Timing attack against the Bearer token comparison | Information Disclosure / Spoofing | `crypto.timingSafeEqual`, length-guarded (D-07) — closes the exact class of attack a plain `!==`/`===` string comparison is vulnerable to |
| Token leaking via logs, error messages, or the query string | Information Disclosure | D-05 removes the token from the URL entirely (URLs are far more likely to be logged by intermediate infrastructure than headers); D-08 forbids the token in any log line at any level, including the rejection path — the recommended `isValidBearerToken()` implementation (Pattern 1) never interpolates `authHeader` or the extracted token into any log call |
| An unauthenticated peer holding an open socket, even briefly, to probe the protocol | Denial of Service / Information Disclosure | D-06's upgrade-time rejection — the socket is destroyed before any `'message'` handler could ever process anything from an unauthenticated peer |
| Two Agents connecting simultaneously (misconfiguration, not malice) going undiagnosed | (not a STRIDE-classic threat, but an availability/observability gap) | D-11's log line — turns a silent flap into a diagnosable warning, closing the observability gap without changing the last-wins behavior itself |
| A guest-registration-controlled value (e.g. a crafted `mode` string) reaching the Agent unsanitized | Tampering | `Registration.mode` is ingested from the webhook payload without an enum constraint today (`mode: string`, `types.ts:8`) — this is a pre-existing Phase 1 scope item, not new to Phase 3, but worth flagging: the dispatch payload's `mode` field (the Fifth Gap fix) will carry whatever string was in the original registration through to the Agent's `dslrBooth.startSession(mode)` call, which itself passes it as a raw query parameter to the local dslrBooth API (`client.ts:16-19`). This phase does not change that trust boundary — it only makes the existing (already-trusted-through) field actually reach the Agent, which it currently does not. Flagged for awareness, not a new decision this research makes. |

## Sources

### Primary (HIGH confidence — read directly this session)
- `mirror-request/src/agent/agentServer.ts`, `mirror-request/src/queue/queueService.ts`, `mirror-request/src/state/localStore.ts`, `mirror-request/src/types.ts`, `mirror-request/src/config.ts`, `mirror-request/src/index.ts`, `mirror-request/src/display/displayServer.ts`, `mirror-request/src/logging/logger.ts`, `mirror-request/src/ingestion/webhookAuth.ts` — every claim about current server behavior, the timing-safe-compare precedent, and the module-load-time `getStore()` side effect
- `dslrbooth-agent/src/websocket/connection.ts`, `dslrbooth-agent/src/index.ts`, `dslrbooth-agent/src/config.ts`, `dslrbooth-agent/src/health/heartbeat.ts`, `dslrbooth-agent/src/triggers/server.ts`, `dslrbooth-agent/src/dslrbooth/client.ts`, `dslrbooth-agent/package.json` — client-side reconnect/backoff mechanics, the event-forwarding-is-generic finding, the missing `mode` default, confirmed absence of any test framework
- `mirror-request/test/agent-websocket.test.ts`, `mirror-request/test/queue-countdown.test.ts`, `mirror-request/test/db-poller.test.ts`, `mirror-request/test/phase5-display.test.ts` — existing test patterns (ephemeral port, mocked-store, temp-dir-`LocalStore`, `createRequire`+`vi.spyOn`) and the Pitfall-1 regression finding
- `mirror-request/vitest.config.ts`, `mirror-request/package.json`, `dslrbooth-agent/package.json` — test env values (`AGENT_WS_TOKEN='test-agent-token'`), installed versions
- `mirror-request/docs/OPS-RUNBOOK.md` — existing documentation style/structure for the new auth-contract section
- `.planning/phases/03-agent-websocket-link/03-CONTEXT.md`, `.planning/REQUIREMENTS.md`, `.planning/STATE.md`, `.planning/ROADMAP.md` (Phase 3 section), `.planning/WINDOWS.md`, `.planning/config.json`, `.planning/phases/02-queue-booth-state/02-CONTEXT.md`, `.planning/phases/02-queue-booth-state/02-RESEARCH.md` — inherited decisions, verified Phase 2 output, and the structure/depth this document matches
- `mirror-request/CLAUDE.md` — project hard rules
- Live command output this session: `node --version`, `node -e "require('ws/package.json').version"`, `npx vitest --version`, full `npm test` run (113/113 passing, 4.73s), `npm view vitest version`, `npm view ws version`, `npm view ws/vitest scripts.postinstall`, `git log`/`git status` in `dslrbooth-agent`, `gsd-tools query package-legitimacy check` for `vitest`, `grep -rn "AgentMessage"` across `src/`+`test/`

### Secondary (MEDIUM confidence — official docs/source read this session, cross-checked)
- `github.com/websockets/ws/blob/master/doc/ws.md` (fetched this session) — `headers` option via `http.request()`/`https.request()` passthrough, `'unexpected-response'` event definition, `verifyClient`/`'wsClientError'` server-rejection patterns
- `raw.githubusercontent.com/websockets/ws/8.18.0/lib/websocket.js` (fetched this session) — exact `abortHandshake()`/`emitErrorAndClose()` behavior confirming a 401 already reaches the client's existing `'error'`+`'close'` handlers without a new `'unexpected-response'` listener
- WebSearch cross-checks (multiple independent results per query) confirming: the `socket.write('HTTP/1.1 401 ...'); socket.destroy();` idiom for `noServer`-mode rejection; the `headers: { authorization: 'Bearer ...' }` idiom for `ws` client construction; the general shape of `'unexpected-response'` usage in the wild

### Tertiary (LOW confidence)
- None retained as authoritative — all WebSearch findings above were cross-checked against the official `ws` docs/source before being tagged `[CITED]`/MEDIUM.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new server dependencies; the one new dependency (`vitest` for `dslrbooth-agent`) is a well-established, high-download package matching this project's existing toolchain choice, verified via the package-legitimacy seam
- Architecture: HIGH for current-code behavior (every claim grounded in source read this session, both repos, with cited line numbers); MEDIUM for the `ws`-library upgrade-rejection mechanics (official docs + source read this session, cross-checked, but not executed against a live handshake in this research session — recommend the planner's first task include a quick spike confirming the exact `socket.write`/`destroy` sequence behaves as documented against this codebase's actual `noServer: true` setup before relying on it further)
- Pitfalls: HIGH for Pitfalls 1, 2, 3, 5 (directly verified against source and existing test files this session); MEDIUM for Pitfall 4 (grounded in `ws` source code read this session, but the specific interaction with THIS codebase's exact `WsConnection` class was reasoned about, not executed end-to-end against a live rejected connection)

**Research date:** 2026-08-10
**Valid until:** 2026-08-24 (14 days — shorter than Phase 2's 30-day window because this phase establishes a live, one-way, two-repository breaking-change deploy contract; re-verify sooner if either repo's `ws` dependency is bumped, or if the live production booth/Agent pairing is touched before this phase ships, since that would invalidate the "server and Agent must deploy together" operational assumption this research is built around)
