# Phase 3: Agent WebSocket Link - Pattern Map

**Mapped:** 2026-08-10
**Files analyzed:** 15 (5 production files modified across 2 repos, 10 test/infra files)
**Analogs found:** 15 / 15 (this is a hardening pass — the primary analog for most files is the file itself, plus one earlier-phase file that solved the same shape of problem)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `mirror-request/src/agent/agentServer.ts` (upgrade auth, D-05..D-08) | middleware (auth gate) | request-response (HTTP upgrade) | `mirror-request/src/ingestion/webhookAuth.ts` | exact (timing-safe compare + length guard) |
| `mirror-request/src/agent/agentServer.ts` (401-before-handshake, D-06) | middleware | request-response | *(no in-repo analog)* — new pattern | none — flagged below |
| `mirror-request/src/agent/agentServer.ts` (D-10/D-11 replacement log) | controller (WS event handler) | event-driven | itself, lines 44-49 (existing guard) | exact — extend in place |
| `mirror-request/src/agent/agentServer.ts` (D-12/D-13 disconnect hook) | controller (WS event handler) | event-driven | `mirror-request/src/queue/queueService.ts` `bindSendCommand`/`registerAckHandler`/`registerEventHandler` (callback-binding idiom) | role-match (cross-module wiring, not auth) |
| `mirror-request/src/queue/queueService.ts` (`isAgentOnlineCb` gate, D-02..D-04) | service | CRUD / event-driven | itself, `tick()` + `dispatchJob()` (existing) | exact — extend in place |
| `mirror-request/src/queue/queueService.ts` (`mode` fix, 5th gap) | service | CRUD | itself, `dispatchJob()` (line 216) + `LocalStore.getJobRegistration()` (already exists) | exact |
| `mirror-request/src/queue/queueService.ts` (`onAgentDisconnected()`, D-12/D-13) | service | event-driven | `handleStall()` (lines 122-130) — sibling, not reuse | role-match (same shape, deliberately not the same function) |
| `mirror-request/src/queue/queueService.ts` (event-coverage fallback, D-14) | service | event-driven | itself, `onAgentEvent()` (lines 170-178) + `agentServer.ts`'s unknown-message-type `warn` (line 76) | exact |
| `mirror-request/src/state/localStore.ts` (`requeueNoRetry()`) | model (data-access method) | CRUD | `requeueWithRetry()` (lines 206-212, same file) | exact — sibling method |
| `dslrbooth-agent/src/websocket/connection.ts` (D-09 header) | service (WS client) | request-response (handshake) | itself, `connect()` lines 52-62 | exact — narrow in-place edit |
| `mirror-request/test/agent-auth.test.ts` | test | request-response | `mirror-request/test/agent-websocket.test.ts` | exact (same ephemeral-port + real-`ws`-client harness) |
| `mirror-request/test/agent-websocket.test.ts` (repair) | test | request-response | itself | exact — must be fixed in place, not extended |
| `mirror-request/test/agent-replacement.test.ts` | test | event-driven | `mirror-request/test/agent-websocket.test.ts` | role-match |
| `mirror-request/test/agent-disconnect-requeue.test.ts` | test | event-driven | `mirror-request/test/queue-countdown.test.ts` (mocked-store + fake-timer style) | exact |
| `mirror-request/test/queue-dispatch-connectivity.test.ts` | test | event-driven | `mirror-request/test/queue-countdown.test.ts` | exact |
| `mirror-request/test/queue-dispatch-mode.test.ts` | test | CRUD | `mirror-request/test/queue-countdown.test.ts` "booth state transitions" block | exact |
| `mirror-request/test/queue-event-coverage.test.ts` | test | event-driven | `mirror-request/test/db-poller.test.ts` (`vi.spyOn`-on-logger interception pattern) | role-match (logger-spy technique, not domain) |
| `mirror-request/test/agent-heartbeat-timeout.test.ts` | test | event-driven | `mirror-request/test/agent-websocket.test.ts` | exact (real ws client + real AgentServer, ephemeral port) |
| `dslrbooth-agent/package.json`, `dslrbooth-agent/vitest.config.ts` | config | — | `mirror-request/vitest.config.ts`, `mirror-request/package.json`'s `test` script | cross-repo role-match — **no local analog exists** |
| `dslrbooth-agent/test/connection-auth.test.ts` | test | request-response | `mirror-request/test/db-poller.test.ts` (`vi.spyOn`/mock-construction pattern) | cross-repo role-match |
| `mirror-request/docs/OPS-RUNBOOK.md` (new section) | config/doc | — | its own §1 (webhook signing contract) and §3 (production-readiness check) | exact — same doc, same author voice |

## Pattern Assignments

### `mirror-request/src/agent/agentServer.ts` — Change 1: timing-safe token compare (D-07/D-08)

**Analog:** `mirror-request/src/ingestion/webhookAuth.ts` (Phase 1)

**The exact guard to copy** (`webhookAuth.ts:64-81`, `verifySignature`):
```typescript
export function verifySignature(
  rawBody: Buffer, timestamp: string, webhookId: string,
  signatureHeader: string, secret: string
): boolean {
  try {
    const canonical = buildCanonicalString(timestamp, webhookId, rawBody);
    const expected = createHmac('sha256', secret).update(canonical).digest('hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    const receivedBuf = Buffer.from(signatureHeader, 'hex');
    if (expectedBuf.length !== receivedBuf.length) return false; // guards timingSafeEqual's throw
    return timingSafeEqual(expectedBuf, receivedBuf);
  } catch {
    return false;
  }
}
```
The load-bearing line is `if (expectedBuf.length !== receivedBuf.length) return false;` — `timingSafeEqual` throws `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` on a length mismatch rather than returning `false`. The Phase 3 token compare must reproduce this exact guard shape (source: `crypto.timingSafeEqual` docs, cross-referenced by RESEARCH.md as "Pitfall 2"). Adapt directly — no HMAC needed here, just a length-guarded `timingSafeEqual` on two UTF-8 buffers:
```typescript
private isValidBearerToken(authHeader: string): boolean {
  const prefix = 'Bearer ';
  if (!authHeader.startsWith(prefix)) return false;
  const received = Buffer.from(authHeader.slice(prefix.length), 'utf8');
  const expected = Buffer.from(this.config.AGENT_WS_TOKEN, 'utf8');
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}
```
**No-secrets-in-logs pattern (D-08):** `webhookAuth.ts`'s `checkWebhookAuth()` returns a bare boolean and logs nothing itself — the caller owns the single generic denial log line (mirrors Phase 1 D-12). Apply identically: `isValidBearerToken()` must never log `authHeader` or any derived value; the caller logs only `'Agent WS rejected: invalid or missing Authorization header'`.

---

### `mirror-request/src/agent/agentServer.ts` — Change 2: 401-before-handshake (D-06)

**Analog:** none in-repo. This is confirmed new territory — RESEARCH.md's "Alternatives Considered" table rules out `verifyClient` because this codebase's `WebSocketServer` uses `noServer: true` shared across `/agent` and `/display` on one `httpServer` (`agentServer.ts:24-27`, `displayServer.ts:24`). The concrete, cited idiom to use:

```typescript
// mirror-request/src/agent/agentServer.ts — replaces the current upgrade handler (lines 29-35)
// and deletes the post-handshake token check (lines 37-43, becomes dead code)
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
```
Source of the raw-socket-write idiom: `[CITED: github.com/websockets/ws/blob/master/doc/ws.md — "Any HTTP response... must be written directly to the socket"]`, cross-checked against multiple real-world examples of `socket.write('HTTP/1.1 401 ...\r\n\r\n'); socket.destroy();`. The `'connection'` handler's old token block (current lines 37-43, including `ws.close(4001, 'unauthorized')`) must be **deleted**, not left alongside — the socket that reaches `'connection'` is now already authenticated.

---

### `mirror-request/src/agent/agentServer.ts` — Change 3: D-10/D-11 replacement log

**Analog:** itself, existing guard at lines 44-49 (current file, read this session):
```typescript
if (this.agentConn) {
  try { this.agentConn.ws.close(); } catch { /* ignore */ }
}
```
Extend with the log line naming both ids (D-11) **before** replacement:
```typescript
if (this.agentConn) {
  logger.warn(`Agent WS replaced: displacing ${this.agentConn.id}, new connection incoming`);
  try { this.agentConn.ws.close(); } catch { /* ignore */ }
}
const id = `agent-${Date.now()}`;
// ... existing assignment, then optionally log the new id too
```

---

### `mirror-request/src/agent/agentServer.ts` — Change 4: disconnect hook (D-12/D-13)

**Analog:** `mirror-request/src/queue/queueService.ts`'s callback-binding idiom — `bindSendCommand()` (line 132), `registerAckHandler`/`registerEventHandler` already live on `agentServer.ts` itself (lines 20-21). Follow the identical shape, a third registration method plus a private field defaulting to a no-op:

```typescript
// agentServer.ts — new field + registration method, same pattern as ackHandler/eventHandler (lines 17-21)
private disconnectHandler: () => void = () => {};
registerDisconnectHandler(fn: () => void): void { this.disconnectHandler = fn; }
```
**Critical: reuse the existing close-guard exactly, add one line inside it** (current lines 80-85):
```typescript
ws.on('close', () => {
  if (this.agentConn?.id === id) {
    this.agentConn = null;
    logger.info('Agent disconnected');
    this.disconnectHandler(); // NEW — only fires for the CURRENT connection, not a stale/displaced one
  }
});
```
This guard is why D-10's last-wins interaction is already safe: the old socket's `'close'` fires asynchronously after `this.agentConn` has been reassigned to the new agent's id, so the guard makes the stale close a no-op — the disconnect handler must live **inside** this guard, never unconditionally on `ws.on('close', ...)`.

---

### `mirror-request/src/queue/queueService.ts` — Change 1: connectivity gate (D-02..D-04)

**Analog:** itself — `tick()` (current lines 180-187) and `dispatchJob()` (current lines 211-218), extended in place. Two checkpoints, not one (RESEARCH.md Pattern 3, Assumption A1):

```typescript
// new field + binder, same style as bindSendCommand (line 132)
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
  this.agentOfflineDispatchSkipLogged = false; // D-04
  this.beginAnnouncement(job);
}
```
Second checkpoint inside `dispatchJob()` (current lines 211-218) closes the mid-ANNOUNCING race:
```typescript
private dispatchJob(job: { id: string }): void {
  if (!this.isAgentOnlineCb()) {
    queueLogger.warn(`Skipping dispatch: Agent disconnected during announcement (job ${job.id} stays queued)`);
    this.store.setBoothIdle();
    this.tick();
    return;
  }
  // ... existing body, plus the mode fix below
}
```
Wiring in `createQueueService()` (current lines 259-276), same pattern as the other three bindings:
```typescript
qs.bindIsAgentOnline(() => agentServer.isAgentOnline()); // AgentServer.isAgentOnline() already exists, unchanged
```

---

### `mirror-request/src/queue/queueService.ts` — Change 2: `mode` fix (5th gap, AGT-02)

**Analog:** `LocalStore.getJobRegistration()` — already exists, already does the exact join needed (`mirror-request/src/state/localStore.ts:294-305`, read this session):
```typescript
getJobRegistration(jobId: string): { job: QueueJob; registration: Registration } | undefined {
  const jobRow = this.db.prepare('SELECT * FROM queue_job WHERE id = ?').get(jobId) as ...;
  if (!jobRow?.registration_id) return undefined;
  const registration = this.db.prepare('SELECT * FROM registration WHERE id = ?').get(jobRow.registration_id) as Registration | undefined;
  if (!registration) return undefined;
  return { job: { ...jobRow, registration } as QueueJob, registration };
}
```
Current `dispatchJob()` (`queueService.ts:216`) constructs the command **without** `mode`:
```typescript
this.sendCommandCb?.({ type: 'command', action: 'start_session', jobId: job.id });
```
Fix — call `getJobRegistration()` and thread `mode` through (the `sendCommandCb` type signature at line 24-26 and `createQueueService()`'s forwarding at line 266 already accept/forward `mode`, so this is a one-line composition fix, not a type change):
```typescript
const registration = this.store.getJobRegistration(job.id)?.registration;
this.sendCommandCb?.({ type: 'command', action: 'start_session', jobId: job.id, mode: registration?.mode });
```

---

### `mirror-request/src/queue/queueService.ts` — Change 3: disconnect requeue orchestration (D-12/D-13)

**Analog (deliberately NOT the same function):** `handleStall()` (current lines 122-130) is the shape to mirror — same "look up in-flight state, act, log" structure — but it must **not** be called or extended, because it always increments `retries` (D-01 forbids charging a system-side fault to the guest's budget). Build a sibling with the identical call shape:

```typescript
// handleStall() — the shape being mirrored, NOT reused:
private handleStall(jobId: string, reason: string): void {
  const { retries } = this.store.requeueWithRetry(jobId);
  if (retries > this.sessionMaxRetries) {
    this.store.failJob(jobId, reason);
    queueLogger.warn(`Job ${jobId} failed after ${retries} attempts: ${reason}`);
  } else {
    queueLogger.warn(`Job ${jobId} requeued (attempt ${retries + 1}/${this.sessionMaxRetries + 1}): ${reason}`);
  }
}

// NEW sibling — no retry increment, no failure ceiling (D-01)
onAgentDisconnected(): void {
  if (this.store.getBoothState() !== 'BUSY') return; // D-13: already resolved by busyTimer, or never dispatched — no-op
  this.clearBusyTimer(); // D-13: cancel the live timeout so it cannot ALSO fire for this job
  this.store.setBoothIdle();
  for (const job of this.store.getInFlightJobs()) { // reuses Phase 2's existing query (localStore.ts:197-201) — no new SQL needed
    this.store.requeueNoRetry(job.id);
    queueLogger.warn(`Job ${job.id} requeued after Agent disconnect (no retry charged)`);
  }
  this.tick();
}
```
Wiring in `createQueueService()`, same pattern as the other bindings:
```typescript
agentServer.registerDisconnectHandler(() => qs.onAgentDisconnected());
```
**D-13 mutual-exclusion is safety-by-construction, not a new lock** (RESEARCH.md Pitfall 5): Node's single-threaded event loop makes `busyTimer`'s `setTimeout` callback and the socket's `'close'` callback mutually exclusive. Whichever runs first calls `clearBusyTimer()`/checks state; do not add a defensive state-check to `startBusyTimer()`'s existing callback (`queueService.ts:220-228`) — it doesn't need one.

---

### `mirror-request/src/state/localStore.ts` — `requeueNoRetry()`

**Analog:** `requeueWithRetry()`, same file (current lines 206-212, read this session):
```typescript
// queued_at is deliberately absent from the SET list below — this omission
// IS D-06's guarantee that a requeued guest keeps their original place in
// line (getNextQueuedJob() orders by queued_at ASC).
requeueWithRetry(jobId: string): { retries: number } {
  this.db.prepare(
    "UPDATE queue_job SET status = 'queued', retries = retries + 1 WHERE id = ?"
  ).run(jobId);
  const row = this.db.prepare('SELECT retries FROM queue_job WHERE id = ?').get(jobId) as { retries: number } | undefined;
  return { retries: row?.retries ?? 0 };
}
```
New sibling — same `queued_at`-preservation comment convention, but never touches `retries`:
```typescript
// Sibling of requeueWithRetry() — deliberately does NOT increment retries.
// A system-side fault (Agent disconnect) must never spend the guest's retry
// budget (D-01/D-12). queued_at is still omitted from the SET list, same
// FIFO-preservation guarantee as requeueWithRetry().
requeueNoRetry(jobId: string): void {
  this.db.prepare("UPDATE queue_job SET status = 'queued' WHERE id = ?").run(jobId);
}
```

---

### `mirror-request/src/queue/queueService.ts` — Change 4: event-coverage fallback (D-14)

**Analog:** itself, `onAgentEvent()` (current lines 170-178) — an `if/else if` chain with no final `else`. The precedent for "log, don't drop" is `agentServer.ts`'s own unknown-message-type branch (line 76): `logger.warn(\`Agent WS: unknown message type "${type}"\`)`. Apply the same shape as a `debug`-level final `else` (debug, not warn, because `countdown` can fire multiple times per second — D-03's spam concern applies here too):
```typescript
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
**Do not** wire this against `types.ts`'s `AgentMessage.eventType` union (lines 29-39) — confirmed dead code, never imported anywhere in `src/` or `test/`, and its field name (`eventType`) doesn't even match the runtime wire field (`event`) that `agentServer.ts` actually reads.

---

### `dslrbooth-agent/src/websocket/connection.ts` — D-09 header change

**Analog:** itself, `connect()` (current lines 44-103, specifically lines 52-62, read this session):
```typescript
try {
  const wsUrl = this.config.token
    ? `${this.config.url.replace(/\/$/, '')}?token=${encodeURIComponent(this.config.token)}`
    : this.config.url
  this.ws = new WebSocket(wsUrl, {
    handshakeTimeout: 10000,
    perMessageDeflate: false,
  })
} catch (err) { ... }
```
Replace with the `headers` constructor option (confirmed by `ws` docs: client constructor passes through any `http.request()`/`https.request()` option, including `headers`):
```typescript
try {
  this.ws = new WebSocket(this.config.url, {
    headers: this.config.token ? { authorization: `Bearer ${this.config.token}` } : undefined,
    handshakeTimeout: 10000,
    perMessageDeflate: false,
  })
} catch (err) { ... }
```
**No other change needed in this file.** The `'close'` handler (current lines 92-102) already unconditionally calls `scheduleReconnect()` (exponential 2s→30s backoff, lines 139-147), and `ws` internally emits both `'error'` and `'close'` on an unhandled non-101 response (traced in `ws` v8.18.0 source this session — `abortHandshake()` → `emitErrorAndClose()`). Do **not** add a new `'unexpected-response'` handler or any reconnect-loop-prevention code — it is already correctly engaged.

---

## Shared Patterns

### Timing-safe comparison (D-07)
**Source:** `mirror-request/src/ingestion/webhookAuth.ts:64-81`
**Apply to:** `AgentServer.isValidBearerToken()`
Length-guard before `timingSafeEqual`, always. Never a bare `===`/`!==` on a secret value.

### No-secrets-in-logs (D-08, inherited from Phase 1 D-12)
**Source:** `mirror-request/src/ingestion/webhookAuth.ts` (`checkWebhookAuth()` returns bare boolean, logs nothing itself)
**Apply to:** every rejection path in `agentServer.ts`'s upgrade handler — log only a generic reason string, never the header value, never the extracted token, never the comparison result detail.

### Callback-binding idiom for cross-module wiring
**Source:** `mirror-request/src/queue/queueService.ts:132-140` (`bindSendCommand`, `bindAnnouncement`, `bindNotificationService`) and `agentServer.ts:17-21` (`registerAckHandler`, `registerEventHandler`)
**Apply to:** `bindIsAgentOnline()` (new), `registerDisconnectHandler()` (new) — private field defaulting to a safe no-op, a single public `bind*`/`register*` setter, wired once inside `createQueueService()` (`queueService.ts:259-276`). Never have `QueueService` import `AgentServer` directly or vice versa.

### Once-per-state-change logging (D-03, extends to D-11/D-14's debug-level concern)
**Source:** `queueService.ts`'s existing `queueLogger.warn`/`.debug` call sites
**Apply to:** the offline-dispatch-skip flag (`agentOfflineDispatchSkipLogged`) and the D-14 fallback (`debug`, not `warn`, because some event types fire multiple times per second).

### Ephemeral-port + real-`ws`-client test harness
**Source:** `mirror-request/test/agent-websocket.test.ts:19-44` (`httpServer.listen(0, '127.0.0.1', resolve)`, read `address.port` back, close in `afterEach`)
**Apply to:** every new `AgentServer` test file (`agent-auth.test.ts`, `agent-replacement.test.ts`, `agent-heartbeat-timeout.test.ts`) — binding constraint from 03-VALIDATION.md.

### Mocked-store + fake-timer test harness
**Source:** `mirror-request/test/queue-countdown.test.ts:1-53` (hand-built `store` object implementing only the `LocalStore` surface the test needs, cast `as unknown as LocalStore`; `vi.useFakeTimers()`/`vi.advanceTimersByTime()`; zero `getStore()` calls)
**Apply to:** `queue-dispatch-connectivity.test.ts`, `agent-disconnect-requeue.test.ts`, `queue-dispatch-mode.test.ts`. Note the file's own comment (lines 56-62): a case that needs a materially different mock shape should build its own store object rather than share one, to avoid cross-case interference.

### `vi.spyOn`-on-logger interception pattern (for asserting on `debug`-level logs under `LOG_LEVEL=error`)
**Source:** `mirror-request/test/db-poller.test.ts:1-55` (`createRequire` + `vi.spyOn` for runtime `require()` interception — the general technique of spying directly on an exported object's method to intercept before any level filter applies)
**Apply to:** `queue-event-coverage.test.ts` — spy on `queueLogger.debug` (imported from `queueService.ts`'s exported `queueLogger`, itself already exported for exactly this purpose — see `queueService.ts:8`) since `vitest.config.ts` sets `LOG_LEVEL: 'error'`, so only a direct `vi.spyOn` on the logger method (not real transport output) will observe `debug` calls.

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `mirror-request/src/agent/agentServer.ts` — 401-before-handshake block | middleware | request-response | No existing code in this repo rejects an HTTP upgrade manually before `handleUpgrade()`; `webhookAuth.ts` rejects at the Express-middleware layer (a different transport entirely — HTTP request, not upgrade). Use RESEARCH.md Pattern 1's cited excerpt verbatim; do not reinvent. |
| `dslrbooth-agent/package.json`, `dslrbooth-agent/vitest.config.ts` | config | — | `dslrbooth-agent` has **zero test infrastructure** today — no framework, no `test/` dir, no config file of any kind. The only analog is in the *other* repo: `mirror-request/vitest.config.ts` (shown above, 15 lines) and `mirror-request/package.json`'s `"test": "vitest run"` / `"test:watch": "vitest"` scripts (lines 13-14). Mirror that shape — minimal `defineConfig({ test: { include: [...] } })`, no `env` block needed unless a test requires one (the Agent has no `AGENT_WS_TOKEN`-equivalent secret to inject via config the way the server does). |
| `dslrbooth-agent/test/connection-auth.test.ts` | test | request-response | No test file of any kind exists in this repo. Nearest technique-level analog (not domain-level) is `mirror-request/test/db-poller.test.ts`'s `vi.spyOn`/mock-construction pattern for intercepting a module's constructor call — but confirm first whether `vi.mock('ws')` works directly here, since `connection.ts` uses a static `import WebSocket from 'ws'` (unlike `dbPoller.ts`'s lazy `require`), per RESEARCH.md's explicit flag: "confirm before assuming." |

## Metadata

**Analog search scope:** `mirror-request/src/agent/`, `mirror-request/src/queue/`, `mirror-request/src/state/`, `mirror-request/src/ingestion/`, `mirror-request/test/`, `dslrbooth-agent/src/websocket/`, `dslrbooth-agent/package.json`
**Files read in full this session:** `mirror-request/src/ingestion/webhookAuth.ts`, `mirror-request/src/agent/agentServer.ts`, `mirror-request/src/queue/queueService.ts`, `mirror-request/test/agent-websocket.test.ts`, `dslrbooth-agent/src/websocket/connection.ts`, `mirror-request/vitest.config.ts`, `mirror-request/docs/OPS-RUNBOOK.md` (§1)
**Files read in part (targeted line ranges):** `mirror-request/src/state/localStore.ts` (getInFlightJobs, requeueWithRetry, getJobRegistration), `mirror-request/test/db-poller.test.ts` (mock-construction header), `mirror-request/test/queue-countdown.test.ts` (mocked-store style), `mirror-request/package.json` / `dslrbooth-agent/package.json` (scripts blocks)
**Pattern extraction date:** 2026-08-10

---

*Phase: 03-agent-websocket-link*
