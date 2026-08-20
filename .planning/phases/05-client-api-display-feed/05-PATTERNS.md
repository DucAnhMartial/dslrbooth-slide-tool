# Phase 5: Client API & Display Feed - Pattern Map

**Mapped:** 2026-08-11
**Files analyzed:** 8 (2 new source, 3 new test, 3 modified)
**Analogs found:** 8 / 8

All line numbers below were read directly from the files this session
(`mirror-request/src/...`, `mirror-request/test/...`) — not assumed.

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/security/ipAllowlist.ts` (NEW) | utility/middleware-helper | request-response | `src/ingestion/mirrorReceiver.ts:20-54` (`clientIp`/`isWhitelisted` closures) | exact (logic to reimplement as exported pure functions) |
| `src/status/estimateWaitMs.ts` (NEW) | utility (pure) | transform | `src/queue/queueService.ts`'s `handleStall()` — single-definition-of-policy pure logic pattern | role-match (nearest pure-policy-function precedent; no existing stats function) |
| `src/display/displayServer.ts` (MODIFIED) | service/websocket-server | streaming + event-driven | itself (existing 77-line file) + `src/agent/agentServer.ts:59-90` for upgrade-gating and constructor-injection | exact (self) / exact (upgrade pattern) |
| `src/index.ts` (MODIFIED, `/status/:jobId` route + `/display-screen` middleware) | route/controller | request-response | itself (`src/index.ts:36-50`) + `src/ingestion/mirrorReceiver.ts:56-134` (generic-403/404, ip check, response shape) | exact (self) / exact (403/404 posture) |
| `src/state/localStore.ts` (MODIFIED — add duration-sample query + keep `getJobRegistration`) | model/data-access | CRUD (read) | itself, `getDueNotifications()` (`:432-438`) for the structural-WHERE pattern | exact |
| `test/status-api.test.ts` (NEW) | test (integration) | request-response | `test/notification-sweeper-restart.test.ts:96-135` (exact-shape assertions) + `test/on-register-auth.test.ts` (ephemeral app + supertest scaffolding) | role-match |
| `test/estimate-wait.test.ts` (NEW) | test (unit) | transform | none exact; nearest is any pure-function unit test in the suite (no direct analog file read this session — plain vitest, no DB) | partial (no strong analog; plain arrays, trivially structured) |
| `test/display-access-control.test.ts` (NEW) | test (integration) | request-response + WS upgrade | `test/on-register-auth.test.ts` (`buildAppWithFakeIp`, `req.ip` override, `expectForbidden` helper) + `src/agent/agentServer.ts:65-75` for the WS-upgrade-rejection shape to assert against | exact |
| `test/phase5-display.test.ts` (EXTEND) | test (integration) | streaming | itself (78 lines, 2 tests today) | exact (self, extend not replace) |
| `test/logging-mask.test.ts` (EXTEND) | test (unit+integration) | event-driven (log spy) | itself, specifically the `safeId()` helper at lines 80-89 and the `collectMessages()`/spy pattern at 142-166 | exact (self, extend not replace) |

---

## Pattern Assignments

### `src/security/ipAllowlist.ts` (NEW — utility)

**Analog:** `src/ingestion/mirrorReceiver.ts:20-54`

D-09 requires this reimplemented as its own module (do not import from or edit
`mirrorReceiver.ts` — it stays untouched so Phase 1's green suite is
zero-risk). Reproduce the identical logic as plain exported functions, and
carry the `trust proxy` doc-comment reasoning forward since `req.ip` is read
the same way here:

**Reference implementation** (verbatim pattern to copy, source
`mirrorReceiver.ts:20-54`, adapted to exported free functions per RESEARCH.md
"Access control for the display feed and screen"):
```typescript
// The single source of the peer address. No Express application-level
// `trust proxy` setting is enabled anywhere in this service (see
// src/index.ts). Without it, req.ip resolves to the direct TCP peer, which
// is what DISPLAY_IP_WHITELIST is meant to match. Enabling `trust proxy`
// unscoped would let any client forge X-Forwarded-For and impersonate an
// allow-listed address. See src/ingestion/mirrorReceiver.ts:20-34 for the
// full original reasoning this is copied from — do not diverge from it.
export function clientIp(req: { ip?: string; socket: { remoteAddress?: string } }): string {
  return (req.ip || req.socket.remoteAddress || '').split(',')[0].trim();
}

export function isWhitelisted(ip: string, whitelist: string[]): boolean {
  if (whitelist.length === 0) return true; // dev escape hatch, same as Phase 1
  return whitelist.some((allowed) => {
    if (allowed.endsWith('.*')) return ip.startsWith(allowed.slice(0, -2));
    return ip === allowed;
  });
}
```

**Config key:** Add `DISPLAY_IP_WHITELIST` to `EnvConfig` (`src/types.ts:81-117`)
and `config.ts`'s `loadConfig()`, following the exact `toCSV('PROXY_IP_WHITELIST', ['127.0.0.1'])`
pattern at `config.ts:58,75`. Per Assumption A4, consider mirroring the
production fail-fast check at `config.ts:63-65` for the new key.

---

### `src/status/estimateWaitMs.ts` (NEW — pure utility)

**No strong existing analog** — this is genuinely new pure-function logic.
Follow the project's established preference (per RESEARCH.md "Where this
lives") for isolating pure logic the way `queueService.ts`'s `handleStall()`
(lines 133-141) is the single definition of retry policy reused by two call
sites — same idea, single definition of the estimate formula, unit-testable
with plain arrays, zero DB.

**Config pattern to copy** (source `config.ts:94-97`, the
`NEXT_GUEST_COUNTDOWN_MS`/`SESSION_TIMEOUT_MS` sibling fields):
```typescript
SESSION_TIMEOUT_MS:       toNum('SESSION_TIMEOUT_MS',  300_000),
NEXT_GUEST_COUNTDOWN_MS:  toNum('NEXT_GUEST_COUNTDOWN_MS', 7000),
```
D-04 requires `WAIT_ESTIMATE_SAMPLE_SIZE`, `WAIT_ESTIMATE_MIN_SAMPLES`,
`WAIT_ESTIMATE_DEFAULT_MS` added the same way (new `toNum(...)` lines in
`loadConfig()`, new fields in `EnvConfig`).

**Signature per RESEARCH.md:**
```typescript
function estimateWaitMs(
  durations: number[],
  guestsAhead: number,
  config: { minSamples: number; defaultMs: number },
): { lowMs: number; highMs: number } | null
```

**Structural SQL feeding it** (add to `LocalStore`, pattern below).

---

### `src/state/localStore.ts` (MODIFIED — add a duration-sample read method)

**Analog:** `getDueNotifications()` (`localStore.ts:432-438`) — the exact
"guarantee lives in what the WHERE clause omits" idiom D-02's exclusion must
follow, per D-15's own citation of this same method:
```typescript
// Source: mirror-request/src/state/localStore.ts:432-438, verbatim
getDueNotifications(now: number): Array<{ jobId: string; photoUrl: string; attempts: number }> {
  return this.db.prepare(`
    SELECT jobId, photoUrl, attempts FROM notification_record
    WHERE status IN ('pending','retrying','sending') AND dueAt <= ? AND photoUrl IS NOT NULL
    ORDER BY dueAt ASC
  `).all(now) as Array<{ jobId: string; photoUrl: string; attempts: number }>;
}
```

**New method to add, same shape/style** (query verified correct against
Correction 2 in RESEARCH.md — `status = 'completed'` is itself the exclusion,
no extra filter needed):
```typescript
getRecentSessionDurationsMs(limit: number): number[] {
  const rows = this.db.prepare(`
    SELECT completed_at - acknowledged_at AS duration_ms
    FROM queue_job
    WHERE status = 'completed' AND acknowledged_at IS NOT NULL AND completed_at IS NOT NULL
    ORDER BY completed_at DESC
    LIMIT ?
  `).all(limit) as Array<{ duration_ms: number }>;
  return rows.map((r) => r.duration_ms);
}
```

**Existing method to reuse, not reinvent** — `getJobRegistration()`
(`localStore.ts:343-354`), verbatim, already does the join `store.getJob()`
lacks:
```typescript
getJobRegistration(jobId: string): { job: QueueJob; registration: Registration } | undefined {
  const jobRow = this.db.prepare('SELECT * FROM queue_job WHERE id = ?').get(jobId) as
    | (QueueJob & { registration_id?: string })
    | undefined;
  if (!jobRow?.registration_id) return undefined;
  const registration = this.db.prepare('SELECT * FROM registration WHERE id = ?').get(jobRow.registration_id) as Registration | undefined;
  if (!registration) return undefined;
  const job = { ...jobRow, registration } as QueueJob;
  return { job, registration };
}
```
Use this — not `job.registration?.name` off `store.getJob()` — to fix the
live `guestName` bug (RESEARCH.md "Pitfall 1").

---

### `src/index.ts` (MODIFIED — `/status/:jobId` redesign, `/display-screen` gate)

**Analog for the 404 posture (already correct, keep):** `src/index.ts:36-39`
```typescript
const job = store.getJob(req.params.jobId);
if (!job) return res.status(404).json({ error: 'job not found' });
```

**Analog for the IP-gate + generic-403 shape to copy for `/display-screen`:**
`src/ingestion/mirrorReceiver.ts:56-62`
```typescript
router.post('/on-register', (req: Request, res: Response) => {
  const ip = clientIp(req) || 'unknown';
  if (!isWhitelisted(req)) {
    logger.warn(`Blocked /on-register from non-whitelisted IP: ${ip}`);
    return res.status(403).json({ error: 'Forbidden' });
  }
  ...
```
Adapt to Express middleware form ahead of `app.get('/display-screen', ...)`:
```typescript
app.get('/display-screen', (req, res, next) => {
  const ip = clientIp(req);
  if (!isWhitelisted(ip, config.DISPLAY_IP_WHITELIST)) {
    logger.warn(`Blocked /display-screen from non-whitelisted IP: ${ip}`);
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}, (_req, res) => res.type('html').send(renderDisplayPage()));
```

**Current buggy line to replace** (`src/index.ts:47`):
```typescript
guestName: job.registration?.name ?? null,   // ALWAYS null at runtime — job has no .registration
```
Replace with `store.getJobRegistration(req.params.jobId)?.registration.name ?? null`.

**Vocabulary mapping (D-11/D-12):** no existing analog — new closed-vocabulary
mapper function, co-locate near the route or in `src/status/`. Table-driven,
exhaustive over `status` × `stall_reason` × Agent-online × booth-state, per
RESEARCH.md's Assumptions/Open Questions section (response shape is the
planner's explicit design choice).

---

### `src/display/displayServer.ts` (MODIFIED — D-09/D-10/D-13/D-15/D-16 together, one file)

RESEARCH.md Pitfall 3 explicitly warns against splitting this file's edits
across waves — plan it as one coherent rewrite task.

**D-16 constructor-injection analog** — `src/queue/queueService.ts:46-55`:
```typescript
constructor(
  store: LocalStore = getStore(),
  config: Pick<EnvConfig, 'SESSION_TIMEOUT_MS' | 'NEXT_GUEST_COUNTDOWN_MS' | 'SESSION_MAX_RETRIES'> = getConfig(),
) {
  this.store = store;
  ...
}
```
Apply identically: `constructor(queue: QueueService, agent: AgentServer, store: LocalStore = getStore())`,
delete module-scope `const store = getStore()` (current `displayServer.ts:9`),
replace all bare `store.` in `broadcastSnapshot()` (current lines 56-57) with
`this.store.`.

**D-09/D-10 upgrade-time-rejection analog** — `src/agent/agentServer.ts:65-80`
(verbatim pattern, this is the precedent cited directly in CONTEXT.md D-09):
```typescript
httpServer.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;
  if (pathname !== '/agent' || !this.wss) return;

  const authHeader = req.headers.authorization ?? '';
  if (!this.isValidBearerToken(authHeader)) {
    logger.warn('Agent WS rejected: invalid or missing Authorization header');
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  this.wss.handleUpgrade(req, socket, head, (ws) => {
    this.wss?.emit('connection', ws, req);
  });
});
```
Adapt for `/display` using IP allow-list and a `403` (matching `mirrorReceiver.ts`'s
generic-403 posture, not `401` — "nothing to provide," per RESEARCH.md):
```typescript
httpServer.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;
  if (pathname !== '/display' || !this.wss) return;
  const ip = clientIp(req);
  if (!isWhitelisted(ip, this.displayWhitelist)) {
    logger.warn(`Blocked /display from non-whitelisted IP: ${ip}`);
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  this.wss.handleUpgrade(req, socket, head, (ws) => this.wss?.emit('connection', ws, req));
});
```
D-10: do not add any `?token=` query-string check anywhere in this handler.

**D-15 structural fix** — delete `currentJob: QueueJob | null` from
`DisplaySnapshot` (`src/types.ts:70`) entirely (RESEARCH.md's recommendation,
Assumption A3), and delete the corresponding `currentJob: job ?? null` line
from `broadcastSnapshot()` (current `displayServer.ts:56,61`).

**D-13 change-driven broadcast** — replace the unconditional
`setInterval(() => this.broadcastSnapshot(), 250)` (current `displayServer.ts:43`)
with change-detection (diff the last-sent snapshot, broadcast on delta) plus a
1 Hz timer gated on `this.queue.getAnnouncement() !== null`. No existing
analog for the diffing logic itself in this codebase — implement directly in
`broadcastSnapshot()`/a new `maybeBroadcast()` wrapper.

**D-14 given-name projection** — apply only to `upNext` entries at broadcast
assembly time (not in `LocalStore`):
```typescript
// Vietnamese naming: given name is the trailing token.
function toGivenName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1] ?? fullName;
}
```
`guestName` (the hero) keeps the full name unchanged — `getQueuedGuestSummaries()`
(`localStore.ts:208-218`) itself is untouched.

---

## Shared Patterns

### IP allow-list + generic rejection (D-09)
**Source:** `src/ingestion/mirrorReceiver.ts:20-62`
**Apply to:** `src/security/ipAllowlist.ts` (new module), `src/index.ts`'s
`/display-screen` middleware, `src/display/displayServer.ts`'s upgrade handler.
Reuse the logic, never the module — do not import from `mirrorReceiver.ts`.

### Upgrade-time WS rejection before `handleUpgrade()`
**Source:** `src/agent/agentServer.ts:65-80`
**Apply to:** `src/display/displayServer.ts`'s `start()` — write the raw HTTP
status line + `socket.destroy()` before calling `wss.handleUpgrade()`, never
after.

### Structural exclusion via SQL WHERE (never a deletable `if`)
**Source:** `src/state/localStore.ts:424-438` (`getDueNotifications`),
`localStore.ts:237-246` (`requeueWithRetry`'s FIFO-position guarantee, via
`queued_at`'s omission from `SET`)
**Apply to:** the new `getRecentSessionDurationsMs()` query (D-02) and the
`DisplaySnapshot.currentJob` deletion (D-15) — both guarantees live in what's
absent (a WHERE predicate, a type field), not a runtime guard.

### Constructor injection with a `getStore()`/`getConfig()` default parameter
**Source:** `src/queue/queueService.ts:46-55`
**Apply to:** `src/display/displayServer.ts`'s constructor (D-16) — identical
shape, `store: LocalStore = getStore()` as the trailing default parameter so
the existing production call site (`new DisplayServer(queue, agentServer)`,
`index.ts:34`) needs zero change.

### Exact-shape response assertion (no "2xx proves nothing")
**Source:** `test/notification-sweeper-restart.test.ts:96-135` (cited by
RESEARCH.md; not re-read this session — file exists and is the established
project convention already referenced by CONTEXT.md's own anti-pattern list)
**Apply to:** `test/status-api.test.ts` — assert
`Object.keys(res.body).sort()` against the full expected key set, per the
project's own documented "a 2xx proves nothing" anti-pattern history.

### `req.ip` override for IP-allow-list testing over loopback
**Source:** `test/on-register-auth.test.ts:51-66` (`buildAppWithFakeIp`) and
`:73-77` (`expectForbidden` helper)
```typescript
function buildAppWithFakeIp(hmacSecret: string, whitelist: string[], fakeIp: string): express.Express {
  const app = express();
  app.use(jsonWithRawBody());
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', { value: fakeIp, configurable: true });
    next();
  });
  app.use(createMirrorReceiver(getStore(), whitelist, { ... }));
  return app;
}

function expectForbidden(res: request.Response): void {
  expect(res.status).toBe(403);
  expect(Object.keys(res.body)).toEqual(['error']);
  expect(res.body.error).toBe('Forbidden');
}
```
**Apply to:** `test/display-access-control.test.ts` — same technique, applied
to the `/display-screen` Express route. For the WS-upgrade layer, a real
loopback client against a `403`-then-`socket.destroy()` server (no
`req.ip`-override trick available at the raw upgrade layer — assert on the
raw HTTP response line / connection-refused behavior instead, following
`agentServer.ts:65-75`'s shape).

### Digit-run-safe id generation (WINDOWS.md item 5 fix)
**Source:** `test/logging-mask.test.ts:80-89` (`safeId()` helper, currently
test-only) — apply the identical technique to the *real* generator, not the
test:
```typescript
// Source: mirror-request/test/logging-mask.test.ts:87-89, proven technique
// Real fix target: src/agent/agentServer.ts:83
// const id = `agent-${Date.now()}-${++this.connSeq}`;
// Reformat so PHONE_RE (\+?\d{7,}) can never match by construction —
// e.g. id.replace(/(\d)(?=\d)/g, '$1x') or a base-36 timestamp encoding.
```
Do not touch `PHONE_RE` itself (`src/logging/logger.ts:8`) — explicitly
forbidden by the comment at `test/logging-mask.test.ts:81-82` (Phase 1 plan
01-05's locked decision).

### Log-message spy pattern for AUTH-03 regression proof
**Source:** `test/logging-mask.test.ts:142-166` (`infoSpy`/`warnSpy`/`debugSpy`
+ `collectMessages()`)
```typescript
let infoSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let debugSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  infoSpy = vi.spyOn(logger, 'info');
  warnSpy = vi.spyOn(logger, 'warn');
  debugSpy = vi.spyOn(logger, 'debug');
});
function collectMessages(): unknown[] {
  return [...infoSpy.mock.calls, ...warnSpy.mock.calls, ...debugSpy.mock.calls].map(call => call[0]);
}
```
**Apply to:** the new non-ingestion `describe` block in
`test/logging-mask.test.ts` — drive a realistic Phase 2-4 flow (queue
dispatch, agent ack, notification retry) and assert `mask(msg) === msg` for
every captured message, per the existing ingestion-surface test's own
`it('produces log messages that are all plain strings and all unchanged by
mask()')` (lines 168-181).

---

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `test/estimate-wait.test.ts` | test (unit) | transform | No pure-function unit test file was read this session to use as a structural analog; the function itself has no existing analog either (first stats/median logic in the codebase). Low risk — plain vitest `describe`/`it` over arrays, no scaffolding needed. |
| D-11/D-12 vocabulary-mapping function (wherever the planner locates it) | utility (pure) | transform | No existing closed-vocabulary mapper exists anywhere in `src/`. Build fresh as a table-driven pure function; test exhaustively per `test/status-vocabulary.test.ts`'s stated purpose in `05-VALIDATION.md`. |

---

## Metadata

**Analog search scope:** `mirror-request/src/` (ingestion, agent, display,
state, queue, index.ts, config.ts, types.ts), `mirror-request/test/`
(on-register-auth, logging-mask, phase5-display).
**Files scanned (read in full or by targeted section):** 12 source files, 3
test files, plus `05-CONTEXT.md`, `05-RESEARCH.md`, `05-VALIDATION.md`.
**Pattern extraction date:** 2026-08-11
