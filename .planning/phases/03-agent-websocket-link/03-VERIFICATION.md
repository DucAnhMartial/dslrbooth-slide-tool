---
phase: 03-agent-websocket-link
verified: 2026-08-10T14:10:00Z
status: passed
score: 5/5 must-haves verified
behavior_unverified: 0
overrides_applied: 0
---

# Phase 3: Agent WebSocket Link Verification Report

**Phase Goal:** Every command the queue sends reaches a booth that is actually there, over a link
only an authenticated Agent can open. The Agent's credential travels in an `Authorization: Bearer`
header and is verified in constant time at the HTTP upgrade step, so an unauthorized peer never
holds an open socket even briefly; the dispatch command finally carries the mode the guest
registered for; every event the booth emits reaches a defined outcome; and when the Agent is
absent, dies mid-session or is evicted by the heartbeat watchdog, the queue holds the job in its
original place in line and returns the booth to service without ever charging the guest a retry
for the booth's fault.

**Verified:** 2026-08-10T14:10:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Verdict

**Goal achieved.** All five M3 success criteria and all six requirement IDs (AGT-01..05, AUTH-01)
are backed by real, wired, behaviorally-tested code in both repositories — not by SUMMARY.md
narrative alone. Full test suites (155 server tests, 4 Agent tests, 159 total) pass live in this
session. Typechecks clean in both repos. Commit history is tightly scoped to the plans' stated
diffs, with no scope creep into the Agent's "dumb relay" boundary. One pre-existing, correctly-
scoped, non-blocking defect (WINDOWS.md #5, connection-id log masking) remains open and is
accurately characterized as diagnostics-only.

## Goal Achievement

### Observable Truths (M3 Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Agent connects with token, rejected without | ✓ VERIFIED | `agentServer.ts:65-76` rejects at the raw `upgrade` handler with `HTTP/1.1 401` written to the socket + `socket.destroy()`, **before** `handleUpgrade()` runs — no handshake for an unauthenticated peer. `isValidBearerToken()` (`agentServer.ts:47-57`) uses `timingSafeEqual` with an explicit length guard (avoids the `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` throw). `test/agent-auth.test.ts` (8 tests, real `http.Server` on ephemeral port, real `ws` client via `unexpected-response`/`open` race) proves: no header → 401; non-Bearer scheme → 401; wrong-length token → 401 without throw; same-length wrong token → 401; correct token → opens + `isAgentOnline()` true; no credential ever appears in any log line across every rejection case. Live cross-repo smoke check (03-05) additionally proved the deleted `?token=` query-string form is rejected from a real, pre-D-05 Agent client's perspective — the one case no server-side unit test can establish. |
| 2 | Dispatch fires `{type, action, jobId, mode}` via WS | ✓ VERIFIED | `queueService.ts` `dispatchJob()` (line ~275) now reads `this.store.getJobRegistration(job.id)?.registration` and threads `mode` into `sendCommandCb({ type: 'command', action: 'start_session', jobId: job.id, mode: registration?.mode })`. Previously `mode` was never sent (context's "fifth gap"). `test/queue-dispatch-mode.test.ts` asserts the captured command with `toEqual({ type: 'command', action: 'start_session', jobId: 'job-a', mode: 'gif360' })` — a full-object match, not a partial/`toMatchObject` check — plus a no-registration-row case (`mode: undefined`, no throw) and an exactly-once lookup-call assertion. `queue-countdown.test.ts` extended as an AGT-02 regression guard with a real `mode` value (`'boomerang'`). |
| 3 | Agent ack `{jobId, ok}` logged, triggers IDLE transition | ✓ VERIFIED | `agentServer.ts` message handler routes `type === 'ack'` to `ackHandler(jobId, ok, errorMessage)`; `queueService.onAgentAck()` calls `sessionAcked()` (in_progress transition, busyTimer re-armed) on `ok=true`, or `handleStall()` + `setBoothIdle()` + `tick()` on `ok=false`. `test/agent-disconnect-requeue.test.ts`'s "AGT-03 regression" and "AGT-03 contrast" cases exercise both paths directly against the real `QueueService`, confirming a NAK charges a retry via `handleStall` while ack moves the job to `in_progress` with the booth staying `BUSY`. Pre-existing coverage retained (this phase did not need to touch the ack path's happy-path logic, only its interaction with the new disconnect seam — verified non-regressed). |
| 4 | Events from Agent received and processed | ✓ VERIFIED | `onAgentEvent()` handles all ten AGT-04 event types: `session_end`, `session_start`, `file_upload` keep real behavior; the other seven (`countdown_start`, `countdown`, `capture_start`, `file_download`, `processing_start`, `sharing_screen`, `printing`) plus any unrecognised future type now fall into a final `else` producing one `queueLogger.debug()` line naming the event type — no longer silent (D-14). `test/queue-event-coverage.test.ts` (6 tests) proves: all ten types processed without throwing; exactly 7 fallback log lines (not more, not fewer); each fallback line names its event type; an invented eleventh type ('future_event_xyz') also produces exactly one fallback line; the three handled types still hit their real handlers, not the fallback (assert `debugSpy` not called for those three). |
| 5 | No heartbeat 30s → Agent offline in status API | ✓ VERIFIED | `startHeartbeatWatchdog()` (default 15s interval / `HEARTBEAT_TIMEOUT_MS`=30s from config, both now constructor-injectable for tests) closes the connection with code 4002 and nulls `agentConn` once `elapsed > heartbeatTimeoutMs`, flipping `isAgentOnline()` to false and firing the disconnect handler. `GET /status/:jobId` (`index.ts`) and the `/display` WS snapshot (`displayServer.ts`) both surface `agentOnline: agentServer.isAgentOnline()` directly. `test/agent-heartbeat-timeout.test.ts` (5 tests, real server on ephemeral port, injected `heartbeatIntervalMs: 20, heartbeatTimeoutMs: 60`) proves offline detection within the injected window, close code 4002, exactly-once disconnect-handler invocation (not double-fired with the socket's own `close` event), continued-online under frequent heartbeats, and zero-arg production-default parity (`new AgentServer()` unchanged). |

**Score:** 5/5 truths verified (0 present-but-behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `mirror-request/src/agent/agentServer.ts` | Header-only Bearer auth, timing-safe compare, 401-before-handshake, displacement logging, injectable heartbeat, disconnect seam | ✓ VERIFIED | All present; query-string path fully removed (no `?token=` handling anywhere in the file); `connSeq` monotonic counter added for collision-proof ids |
| `mirror-request/src/queue/queueService.ts` | Connectivity gate at tick + dispatch, `mode` in dispatch payload, `onAgentDisconnected()`, full 10-event coverage | ✓ VERIFIED | `isAgentOnlineCb` gate at both `tick()` and `dispatchJob()`; `handleStall()` still has exactly 3 call sites (recovery sweep, NAK, busyTimer timeout); `onAgentDisconnected()` new and correctly excluded from `handleStall()` |
| `mirror-request/src/state/localStore.ts` | `requeueNoRetry()` sibling to `requeueWithRetry()` | ✓ VERIFIED | `requeueNoRetry()` (line 225) touches only `status`; `queued_at` and `retries` untouched by design, confirmed by real-SQL test |
| `dslrbooth-agent/src/websocket/connection.ts` | Sends `Authorization: Bearer` header, no query string | ✓ VERIFIED | `connect()` line ~53 passes `headers: { authorization: `Bearer ${token}` } }`; URL passed to `WebSocket` constructor unchanged (no query append) |
| `dslrbooth-agent/vitest.config.ts`, `test/connection-auth.test.ts` | Agent repo's first test infrastructure | ✓ VERIFIED | `vitest ^2.1.4` installed, `npm test` script wired, 4 tests pass live in this session |
| `mirror-request/docs/OPS-RUNBOOK.md` §7 | Auth contract, synchronized-deploy rule, both-or-neither rollback, honest no-staging statement, log-line guide | ✓ VERIFIED | Present, matches source verbatim for quoted log lines; explicitly states the per-side tests "do not prove the two sides meet on a real wire" and that no staging environment exists |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `index.ts` | `AgentServer` | `agentServer.start(server)`, wired into `createQueueService(agentServer, notifier)` | ✓ WIRED | Confirmed in running startup sequence |
| `QueueService` | `AgentServer.sendCommand` | `qs.bindSendCommand((cmd) => agentServer.sendCommand(...))` in `createQueueService()` | ✓ WIRED | `mode` field threaded through the full call chain |
| `AgentServer` | `QueueService.onAgentAck/onAgentEvent/onAgentDisconnected` | `registerAckHandler`, `registerEventHandler`, `registerDisconnectHandler` in `createQueueService()` | ✓ WIRED | All three seams bound; disconnect seam is the last of plan 03-02's three no-op-defaulted seams to be consumed (03-04) |
| `AgentServer.isAgentOnline()` | `/status/:jobId` response + `/display` WS snapshot | direct method calls in `index.ts` and `displayServer.ts` | ✓ WIRED | Both surfaces present; `/status/:jobId` is the "status API" M3 SC 5 refers to |
| `dslrbooth-agent WsConnection` | `mirror-request AgentServer` | live WebSocket over `Authorization: Bearer` header | ✓ WIRED | Confirmed by both the automated `connection-auth.test.ts` (client side) and the live cross-repo smoke check on port 3199 (both sides on the real wire) |

### Behavioral Spot-Checks / Full Suite Execution

Both full suites were run once, live, in this session (not re-run per must-have):

| Suite | Command | Result | Status |
|-------|---------|--------|--------|
| Server | `cd mirror-request && npm test` | 23 files, **155 tests**, all passed, 4.83s | ✓ PASS |
| Agent | `cd dslrbooth-agent && npm test` | 1 file, **4 tests**, all passed, 619ms | ✓ PASS |
| Server typecheck | `cd mirror-request && npx tsc --noEmit -p .` | clean, exit 0 | ✓ PASS |
| Agent typecheck | `cd dslrbooth-agent && npx tsc --noEmit -p .` | clean, exit 0 | ✓ PASS |

These counts match SUMMARY.md's claimed "155 server tests, 4 Agent tests" exactly — reproduced independently, not merely trusted.

### D-13 Double-Fire Prevention — Both Trigger Orders

Verified directly in `test/agent-disconnect-requeue.test.ts` (real code paths, `QueueService` instances, not pure mocks of the method under test):

- **Disconnect wins first:** `onAgentDisconnected()` fires while BUSY → booth IDLE, `requeueNoRetry` called once, then advancing fake timers past the full session timeout confirms `requeueWithRetry` (the busyTimer's path) is **never** called — `clearBusyTimer()` cancelled the pending timer.
- **busyTimer wins first:** timers advanced past the session timeout while still "online" → `requeueWithRetry` called once, booth IDLE. `onAgentDisconnected()` called afterward is a **complete no-op**: `getBoothState() !== 'BUSY'` guard short-circuits, `requeueNoRetry` never called.
- Additional cases: IDLE-state disconnect is a no-op with zero store writes; two in-flight rows (dispatched + in_progress) both requeue without retry, matching Phase 2's orphan-sweep semantics.

This satisfies scrutiny point 3 — both orders are asserted, not just one path in isolation.

### AGT-04 Full Event Coverage

`handleStall()` call-site count confirmed at exactly 3 (`recover()`'s sweep, `onAgentAck()`'s NAK path, `startBusyTimer()`'s timeout callback) via `grep -n "handleStall("` — `onAgentDisconnected()` deliberately does not call it, consistent with D-01/D-12's "system-side fault never spends the guest's retry budget" principle. `requeueNoRetry()`'s SQL (`UPDATE queue_job SET status = 'queued' WHERE id = ?`) touches only `status`, confirmed both by static read and by a real-SQLite test asserting `retries` and `queued_at` are byte-identical before and after.

All ten AGT-04 event types plus one invented type reach a defined outcome (three real handlers, eight debug-log fallbacks including the unrecognised type) — none silently dropped.

### CLAUDE.md Hard Rules

| Rule | Status | Evidence |
|------|--------|----------|
| Rule 1: backend DB read-only | ✓ HOLDS | No `INSERT`/`UPDATE`/`DELETE` in `dbPoller.ts`; production `extension-service.sqlite` mtime unchanged since Phase 2 (`2026-08-10T11:14`), confirming this phase's work and its smoke check never touched it (isolated `LOCAL_STORE_PATH` used for both test suites and the smoke check) |
| Rule 2: never call dslrBooth Local API directly from the server | ✓ HOLDS | No `http`/`fetch`/`axios` call to a Local API host anywhere in `mirror-request/src/agent/` or `mirror-request/src/queue/`; the only outbound-looking string in `agentServer.ts` is the internal `URL` parse used for its own upgrade-path routing |
| Rule 3: all business logic lives in the server; Agent is a dumb relay | ✓ HOLDS | `dslrbooth-agent`'s only Phase 3 commit (`e376696`) touches `connection.ts` (auth header), `package.json`/`vitest.config.ts` (test infra), and its own new test file — zero touches to `index.ts`, `triggers/server.ts`, or any queue/retry/booth-state logic. The Agent repo's pre-existing `queueLength`/`upNext` display fields are pass-through rendering of data the server already computed and sent, not independently-derived business decisions |

### Requirements Coverage

| Requirement | Description | Status | Evidence |
|-------------|-------------|--------|----------|
| AGT-01 | WS server accepts a single Agent, authenticates token | ✓ SATISFIED | `agent-auth.test.ts` + `agent-replacement.test.ts` (last-wins, displacement logged) |
| AGT-02 | Dispatch command `{type, action, jobId, mode}` | ✓ SATISFIED | `queue-dispatch-mode.test.ts`, full-object assertion |
| AGT-03 | Ack `{jobId, ok, errorMessage}` received | ✓ SATISFIED | `onAgentAck()` unchanged in happy/NAK paths; regression-guarded in `agent-disconnect-requeue.test.ts` |
| AGT-04 | All ten named event types received and processed | ✓ SATISFIED | `queue-event-coverage.test.ts`, D-14's "defined outcome" standard met for all ten plus unrecognised types |
| AGT-05 | Heartbeat — offline after >30s silence | ✓ SATISFIED | `agent-heartbeat-timeout.test.ts`, injectable timing, real server, 4002 close, `/status` + `/display` surfacing |
| AUTH-01 | Agent authenticates via token/API key on WS connect | ✓ SATISFIED | `agent-auth.test.ts`, header-only, timing-safe, 401-before-handshake, no query-string fallback |

No orphaned requirements — all six IDs mapped to this phase in REQUIREMENTS.md's traceability table appear in the plans and are backed by passing tests.

### Anti-Patterns Found

None. Scanned `agentServer.ts`, `queueService.ts`, `localStore.ts` (diffed sections), `displayServer.ts`, `index.ts`, `connection.ts`, and `OPS-RUNBOOK.md` for `TODO`/`FIXME`/`XXX`/`TBD`/`HACK`/`PLACEHOLDER`/"not yet implemented"/empty-return stubs. Two incidental matches for the word "placeholder" in `OPS-RUNBOOK.md` §3/§4 (pre-existing, unrelated to Phase 3 — describing what to do if an *environment variable* is left as a placeholder value, not a code stub).

### Test Integrity (Scrutiny Point 7)

- Every new Phase 3 test file that starts an `AgentServer` binds an ephemeral port (`listen(0, ...)`) and closes both the server and all tracked client sockets in `afterEach` — confirmed by direct read of `agent-auth.test.ts`, `agent-heartbeat-timeout.test.ts`, `agent-replacement.test.ts`.
- Zero `getStore()` calls in any of the six new Phase 3 test files. `agent-disconnect-requeue.test.ts` uses a per-file temp DB via `new LocalStore(dbPath)` (the `constructor(dbPath?)` seam) for its one real-SQL test, and a hand-built mock store for the rest.
- **One exception, pre-existing and not worsened by this phase:** `test/agent-websocket.test.ts` imports `DisplayServer`, which calls `getStore()` at module load (`displayServer.ts:9`). Confirmed via `git diff bc4ab61 2166049 -- test/agent-websocket.test.ts` that this import predates Phase 3 entirely — 03-01's diff only changed the connection URL/headers and added an explicit `ws.close()`, it did not introduce or expand the `DisplayServer`/`getStore()` coupling. WINDOWS.md ledger item 4 (shared test DB across parallel workers) remains open exactly as it was; this phase did not add a second offender, and its six new test files are demonstrably clean.
- 155/155 and 4/4 tests reproduced green in this verification session, independent of SUMMARY.md's claim.

### Regressions Check

- Phase 1 dedup ladder: `on-register-dedup.test.ts` (14 tests) still passes.
- Phase 1 read-only poller: `db-poller.test.ts` (11 tests) still passes; no `INSERT`/`UPDATE`/`DELETE` added.
- Phase 1 PII masking: `logging-mask.test.ts` (10 tests) still passes.
- Phase 2 bounded retry / `queued_at` place-in-line: `queue-fifo-retry.test.ts`, `queue-timeout-retry.test.ts`, `queue-recovery.test.ts`, `queue-idempotency.test.ts` all still pass; `handleStall()` behavior unchanged, only a new sibling (`requeueNoRetry`) added alongside it.

### Ledger Item 5 — Connection-ID Masking (Scrutiny Point 10)

Confirmed independently: `mask()`'s `PHONE_RE = /\+?\d{7,}/g` in `logger.ts` matches the 13-digit
`Date.now()` component of `agent-${Date.now()}-${++connSeq}`, asterisking it in every log line
while leaving the trailing `connSeq` suffix (e.g., `-1`, `-2`) intact. This means the
displaced-vs-arriving distinction in `Agent WS replaced: <old-id> displaced by <new-id>` **still
works within one process lifetime** (the trailing digit differs), but correlation across a process
restart is lost since `connSeq` resets to 1. This matches the ledger's and SUMMARY's own
characterization ("diagnostics only, no functional impact... degraded, not destroyed") — it is not
overstated. §7's log-line table states the line's meaning without claiming the ids are
un-redacted or globally unique, so it does not overpromise what the diagnostic delivers. Correctly
scoped as `open`, non-blocking to this phase's goal, and out of the documentation-only plan (03-05)
that discovered it.

## Deferred Items

None applicable — no gaps to defer to later phases. The only open item (WINDOWS.md #5) is a
pre-existing-pattern minor defect discovered and honestly recorded this phase, not deferred
phase-goal scope.

## Human Verification Required

None. All five M3 success criteria have automated, real-server or real-SQL evidence (not mocks-only
claims), reproduced live in this verification session. The one Manual-Only Verification row that
required a live artifact (cross-repo smoke check) was executed by the orchestrator prior to this
verification pass and its results are consistent with the code inspected here — no further human
action is needed to confirm phase-goal achievement.

## Gaps Summary

No blocking gaps. One pre-existing, correctly-scoped, non-blocking diagnostics defect remains open
in WINDOWS.md (#5) and one pre-existing test-isolation debt item remains open (#4, unchanged by
this phase) — both are known, tracked, and accurately characterized; neither prevents the phase
goal from being achieved.

---

*Verified: 2026-08-10T14:10:00Z*
*Verifier: Claude (gsd-verifier)*
