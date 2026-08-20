# Phase 8: CMS & Event Display - Pattern Map

**Mapped:** 2026-08-12
**Files analyzed:** ~14 new/modified surfaces (mirror-request + dslrbooth-agent)
**Analogs found:** 14 / 14 (all have a strong in-repo precedent; RESEARCH.md already located
most of them — this file verifies each by direct read and pins exact excerpts/line numbers)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `mirror-request/src/state/localStore.ts` (+ `event`, `active_event`, `event_photo`, `agent_config` tables) | model/migration | CRUD | same file, `bootstrap()`/`migrate()` (existing tables) | exact — additive to the file itself |
| `mirror-request/src/cms/cmsPages.ts` | component (SSR template) | request-response | `src/display/displayPage.ts` | exact |
| `mirror-request/src/cms/cmsRouter.ts` | controller/route | CRUD + request-response | `src/status/statusRoute.ts` (`createStatusRouter`) | exact (router-as-factory idiom) |
| `mirror-request/src/cms/cmsAuth.ts` (session, hash/verify, `requireSession`) | middleware/service | request-response | `src/agent/agentServer.ts` `isValidBearerToken()` (crypto idiom); `src/index.ts` `/display-screen` gate (middleware shape) | role-match, composed from two analogs |
| `mirror-request/src/cms/cmsIpGate.ts` | middleware | request-response | `src/security/ipAllowlist.ts` + its call site in `src/index.ts:43-50` | exact (reuse the function, new middleware wrapper) |
| `mirror-request/src/cms/uploadHandler.ts` | service/file-I/O | file-I/O | none in-repo (new primitive) — pattern from RESEARCH.md's base64-JSON + magic-byte design | no analog — RESEARCH.md is the source |
| `mirror-request/src/display/displayServer.ts` (`buildSnapshot()` extended: `justCaptured`, event config) | service | streaming/event-driven | same file, `countdownSeconds`/`announcementEndsAt` computed-per-tick pattern | exact — additive to the file itself |
| `mirror-request/src/display/displayPage.ts` (extended to read event-config fields) | component | request-response | same file (existing inline-template idiom) | exact |
| `mirror-request/src/queue/queueService.ts` (`onFileUpload()` gains `recordEventPhoto()` write) | service | event-driven | same file, existing `resolvePendingPrint()`/`getJobRegistration()` calls at :970-971 | exact — additive to the file itself |
| `mirror-request/src/agent/agentServer.ts` (+ `config_request`/`config`/`reload_config` branches) | controller/service | event-driven | same file, existing `ack`/`event`/`heartbeat` `if/else if` chain at :117-133 and `sendEvent()` at :178-182 | exact — additive to the file itself |
| `mirror-request/src/config.ts` (+ `CMS_IP_WHITELIST`, `CMS_USERNAME`, `CMS_PASSWORD_HASH`) | config | request-response | same file, `DISPLAY_IP_WHITELIST` (:63, :71-73) + `required()` helper (:33-39) | exact — additive to the file itself |
| `mirror-request/src/logging/logger.ts` (no changes; new call sites in cms/photo code) | utility | transform | same file, `mask()` + `labelLogger()` | exact — reuse, not extend |
| `mirror-request/test/cms-*.test.ts` (new) | test | request-response | `test/display-access-control.test.ts` (supertest + temp-file store harness) | exact |
| `mirror-request/test/local-store-*.test.ts` (new tables) | test | CRUD | `test/local-store-persistence.test.ts` (real temp-file SQLite harness) | exact |
| `mirror-request/test/queue-event-photo.test.ts` (new) | test | event-driven | `test/queue-no-photo-outcome.test.ts` `buildStore()` (mocked-store service harness) | exact |
| `dslrbooth-agent/src/dslrbooth/client.ts` (`readonly port/password` → mutable) | service | request-response | same file (existing `call()`/`startSession()`) | exact — additive to the file itself |
| `dslrbooth-agent/src/index.ts` (`ws.onMessage`/`ws.onStatusChange` gain `config`/`reload_config`/`config_request` branches) | controller | event-driven | `dslrbooth-agent/src/websocket/connection.ts` `onMessage`/`send()`/`onStatusChange` API | exact — additive to the file itself |
| `dslrbooth-agent/test/config-mutation.test.ts` (new) | test | event-driven | `dslrbooth-agent/test/connection-auth.test.ts` (minimal vitest setup) | role-match |

## Pattern Assignments

### 1. New SQLite tables: `event`, `active_event`, `event_photo`, `agent_config`

**Analog:** `mirror-request/src/state/localStore.ts` (766 lines; read in full range 1-110)

**Constructor + bootstrap/migrate shape** (lines 10-20):
```typescript
export class LocalStore {
  private db: Database.Database;
  constructor(dbPath?: string) {
    const resolved = path.resolve(dbPath ?? CONFIG.LOCAL_STORE_PATH);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    this.db = new Database(resolved);
    this.db.pragma('journal_mode = WAL');
    this.bootstrap();
    this.migrate();
  }
```

**`CREATE TABLE IF NOT EXISTS` idiom, single-row pointer precedent (`booth_state`)** (lines 66-70):
```typescript
CREATE TABLE IF NOT EXISTS booth_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    state TEXT NOT NULL DEFAULT 'IDLE',
    updated_at TEXT NOT NULL DEFAULT 'now'
  );
```
This is the direct template for `active_event` (single-row `CHECK (id = 1)` pointer) and
`agent_config` (single-row, current+previous JSON blobs, D-18).

**`jobId`-keyed registry precedent (`pending_print`)** (lines 93-101):
```typescript
CREATE TABLE IF NOT EXISTS pending_print (
  jobId          TEXT PRIMARY KEY,
  composite_path TEXT,
  status         TEXT NOT NULL DEFAULT 'awaiting',
  opened_at      INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  resolved_at    INTEGER,
  updated_at     TEXT NOT NULL DEFAULT 'now'
);
```
Direct template for `event_photo` (`jobId TEXT PRIMARY KEY`, plus `event_id`, `guest_name`,
`photo_url`, `captured_at` — see RESEARCH.md's already-drafted schema, lines 645-651 of that
doc, which follows this exact shape).

**Conditional `ALTER TABLE` migration idiom** (lines 105-110, continues past what was read —
verify by grep before writing the migration; the pattern is `PRAGMA table_info(<table>)` →
`.some((c) => c.name === '<col>')` → conditional `ALTER TABLE ... ADD COLUMN`):
```typescript
migrate(): void {
  // Additive-only migrations. This database file carries live operational
  // data ... migrations here must never drop or recreate a table — only add
  // columns and backfill.
  const columns = this.db.prepare('PRAGMA table_info(registration)').all() as Array<{ name: string }>;
  const hasReceivedAt = columns.some((c) => c.name === 'received_at');
```

**Test harness to copy:** `mirror-request/test/local-store-persistence.test.ts:1-30` — real
temp-file SQLite via `fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-store-'))`, `new LocalStore(dbPath)`,
close+`fs.rmSync` in `afterEach`. Use this (not a mock) to prove the new tables' idempotency,
per CONTEXT.md's explicit "prove idempotency against a real temp-file database, not a mock."

**Constraint carried forward:** never add a DELETE path for terminal/history rows without an
explicit decision — `pending_print`'s header comment (lines 75-92) is the cautionary precedent:
D-11's photo-history deletion must be an explicit, confirmed CMS action only, never automatic.

---

### 2. CMS HTML pages

**Analog:** `mirror-request/src/display/displayPage.ts` (60 lines, read in full)

**Inline-template-string idiom, no build step** (lines 1-11, 32-41):
```typescript
export function renderDisplayPage(): string {
  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  ...
  <style>
    :root{--ink:#171713;--paper:#f3ead8;--accent:#ff5b3d;--muted:#8d8678;--line:rgba(23,23,19,.16)}
    ...
```
CMS pages (login, dashboard, event form, photo history, agent config) are new template-string
functions in a new sibling file `src/cms/cmsPages.ts`, one function per page, same signature
shape (`(): string` or `(data: X): string`), returned via `res.type('html').send(...)`.

**Client-side WS reconnect-with-backoff idiom** (lines 41, 57 — the whole inline `<script>`
block): the `connect()`/`ws.onclose=()=>setTimeout(connect,1500)` retry loop is the direct
precedent for D-07's "keep last content, show reconnecting banner, retry with backoff" — copy
this shape, add a visible banner toggle instead of leaving the DOM untouched on close.

**Secondary analog for route wiring:** `mirror-request/src/status/statusRoute.ts` — router-as-
factory shape (see Pattern 3 below); `mirror-request/src/index.ts:43-50` for the inline
IP-gate + page-serve two-middleware chain that mounts a rendered page behind an allow-list
(direct precedent for how `cmsRouter` mounts its login page).

---

### 3. CMS router (`createCmsRouter`)

**Analog:** `mirror-request/src/status/statusRoute.ts` (216 lines, read in full)

**Router-as-factory with narrow injected interfaces** (lines 34-59):
```typescript
export interface StatusQueue {
  getQueuePosition(jobId: string): number | undefined;
  getQueueLength(): number;
  getAnnouncement(): { jobId: string; endsAt: number; remainingSeconds: number } | null;
}
export interface StatusAgent {
  isAgentOnline(): boolean;
}
export type StatusConfig = Pick<EnvConfig, 'WAIT_ESTIMATE_SAMPLE_SIZE' | ... >;

export function createStatusRouter(
  store: LocalStore,
  queue: StatusQueue,
  agent: StatusAgent,
  cfg: StatusConfig,
): ReturnType<typeof Router> {
  const router = Router();
  ...
  return router;
}
```
`createCmsRouter(store, agentServer, config)` follows this exact shape: accept the narrowest
structural interfaces needed (not full concrete classes), build any per-instance state (e.g.
session store, rate limiter — see lines 62-70's `rateLimiter` built inside the factory, not at
module scope) inside the function body so tests get independent state per router instance, and
return `router` at the end.

**Generic-error / no-oracle discipline** (lines 20-22): the single `genericNotFound()` helper
used everywhere a lookup misses is the precedent for CMS error responses — one shape for "not
found"/"forbidden", not per-branch bespoke JSON.

**Mounting in `index.ts`:** `app.use(createStatusRouter(store, queue, agentServer, config));`
(index.ts:57) is the direct precedent for `app.use('/cms', cmsIpGate, createCmsRouter(...))`.

---

### 4. IP-gating middleware for `/cms`

**Analog:** `mirror-request/src/security/ipAllowlist.ts` (43 lines, read in full) +
`mirror-request/src/index.ts:38-50` (the `/display-screen` gate) +
`mirror-request/src/display/displayServer.ts:58-70` (the `WS /display` upgrade-time gate).

**Reusable functions (call verbatim, do not reimplement the algorithm):**
```typescript
export function clientIp(req: { ip?: string; socket: { remoteAddress?: string } }): string {
  return (req.ip || req.socket.remoteAddress || '').split(',')[0].trim();
}
export function isWhitelisted(ip: string, whitelist: string[]): boolean {
  if (whitelist.length === 0) return true;
  return whitelist.some((allowed) => {
    if (allowed.endsWith('.*')) {
      const prefix = allowed.slice(0, -2);
      return ip.startsWith(prefix);
    }
    return ip === allowed;
  });
}
```

**Express middleware call-site precedent** (`src/index.ts:38-50`):
```typescript
app.get('/display-screen', (req, res, next) => {
  const ip = clientIp(req);
  if (!isWhitelisted(ip, config.DISPLAY_IP_WHITELIST)) {
    log.warn(`Blocked /display-screen from non-whitelisted IP: ${ip}`);
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}, (_req, res) => res.type('html').send(renderDisplayPage()));
```
`createCmsIpGate(whitelist)` (RESEARCH.md's own draft, verified consistent with this pattern)
wraps this exact check as a standalone middleware factory using a **new, independent**
`CMS_IP_WHITELIST` list — see Pitfall 2 in RESEARCH.md: do NOT reuse `DISPLAY_IP_WHITELIST`'s
*value*, only the `isWhitelisted()` *function*.

**Config validation precedent for the new `CMS_IP_WHITELIST` key** — see Pattern 10 below
(`src/config.ts`).

---

### 5. New snapshot fields (`justCaptured`, event config)

**Analog:** `mirror-request/src/display/displayServer.ts` (162 lines, read in full)

**Computed-per-tick pattern, not pushed-and-timered** (`buildSnapshot()`, lines 119-142, and
the `maybeBroadcast()` comment at lines 144-153):
```typescript
private buildSnapshot(): DisplaySnapshot {
  const upNextRaw = this.store.getQueuedGuestSummaries();
  const announcement = this.queue.getAnnouncement();
  ...
  return {
    queuePosition: upNextRaw[0]?.position ?? 0,
    queueLength: this.queue.getQueueLength(),
    boothState: this.store.getBoothState(),
    agentOnline: this.agent.isAgentOnline(),
    guestName,
    countdownSeconds: announcement?.remainingSeconds ?? null,
    announcementEndsAt: announcement?.endsAt ?? null,
    upNext,
  };
}
```
`justCaptured` is added the same way: query `store.getMostRecentEventPhoto(activeEventId)`,
compare `Date.now() - capturedAt` against a constructor-injected `heroMomentDurationMs`
(mirrors `this.pollIntervalMs`'s injection at lines 29, 41, 47), return `{photoUrl, name}` or
`null`. **Do not** use `setTimeout(() => { this.justCaptured = null }, ...)` — see Pitfall 1 in
RESEARCH.md; the whole reason `countdownSeconds`/`announcementEndsAt` never thrash or go stale
is that they are recomputed fresh every tick from a stored end-time, never set-once-and-timered.

**Serialized-diff broadcast guard** (lines 154-161):
```typescript
private maybeBroadcast(): void {
  const msg = JSON.stringify({ type: 'snapshot', data: this.buildSnapshot() });
  if (msg === this.lastSent) return;
  this.lastSent = msg;
  for (const ws of this.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}
```
Extending `buildSnapshot()`'s return shape automatically participates in this guard — no new
wiring needed in `maybeBroadcast()` itself.

**Constructor injection precedent for the hero-moment TTL** (lines 37-48):
```typescript
constructor(
  queue: QueueService,
  agent: AgentServer,
  store: LocalStore = getStore(),
  opts: { displayWhitelist?: string[]; pollIntervalMs?: number } = {},
) {
  ...
  this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
}
```
Add `heroMomentDurationMs?: number` to the same `opts` object, defaulted from a new top-level
`const DEFAULT_HERO_MOMENT_MS = 12_000;` beside `DEFAULT_POLL_INTERVAL_MS` (line 12).

**Structural leak-prevention discipline to preserve** (lines 102-118's doc comment): the new
`justCaptured` field must be built from a purpose-built store method (e.g.
`getMostRecentEventPhoto()`) that returns only `{photoUrl, name, capturedAt}` — never a raw
`event_photo` row exposing internal columns, mirroring how `buildSnapshot()` today never calls
a raw `queue_job`-row getter for the same reason.

---

### 6. Photo-history write (`recordEventPhoto`)

**Analog:** `mirror-request/src/queue/queueService.ts` `onFileUpload()` (lines 913-973, read in
full) + `getJobRegistration()` (called at `statusRoute.ts:134` and `queueService.ts` itself).

**Attribution + resolve-before-deliver idiom** (lines 965-972):
```typescript
if (this.store.resolvePendingPrint(jobId, Date.now())) {
  void this.sendNotification(jobId, photoUrl);
}
```
The new `recordEventPhoto()` write is inserted alongside `sendNotification()` calls on both
legitimate-success branches — the ordinary `'awaiting'` path (lines 970-972) and the
late-but-legitimate `'expired'` path (lines 959-961) — and NOT on the two branches that must
stay no-ops: `pending === undefined` (D-04, line 938-946) and a duplicate/replayed resolve
returning `false` (line 970's `if`). RESEARCH.md's own drafted excerpt (its lines 671-683)
shows the exact insertion point:
```typescript
if (this.store.resolvePendingPrint(jobId, Date.now())) {
  const registration = this.store.getJobRegistration(jobId)?.registration;
  const activeEventId = this.store.getActiveEventId();
  if (activeEventId && registration) {
    this.store.recordEventPhoto({
      jobId, eventId: activeEventId,
      guestName: registration.name, photoUrl, capturedAt: Date.now(),
    });
  } else {
    queueLogger.warn(`Print upload for ${jobId} resolved but no active event — photo not recorded to history`);
  }
  void this.sendNotification(jobId, photoUrl);
}
```

**Guest-name join precedent:** `getJobRegistration(jobId)?.registration.name` — the exact same
call `statusRoute.ts:134` uses (and whose header comment there documents the live bug it fixed
by using this method instead of reading `.registration` off a bare `queue_job` row) — reuse
identically, do not re-derive the join.

---

### 7. New WS message types (`config_request`/`config`/`reload_config`)

**Analogs:**
`mirror-request/src/agent/agentServer.ts` (203 lines, read in full) +
`dslrbooth-agent/src/websocket/connection.ts` (183 lines, read in full).

**Service-side branch chain to extend** (`agentServer.ts:107-134`):
```typescript
ws.on('message', (raw) => {
  if (this.agentConn) this.agentConn.lastHeartbeat = Date.now();
  let msg: Record<string, unknown>;
  try { msg = JSON.parse(raw.toString()); } catch { logger.warn('Agent WS: invalid JSON'); return; }
  const type = msg.type as string;
  if (type === 'ack') { this.ackHandler(...); }
  else if (type === 'event') { this.eventHandler(...); }
  else if (type === 'heartbeat') { /* ack updated above */ }
  else { logger.warn(`Agent WS: unknown message type "${type}"`); }
});
```
Add `else if (type === 'config_request') { this.configRequestHandler(...); }` before the final
`else`, mirroring the existing branches exactly. Add a matching
`registerConfigRequestHandler(fn)` public method beside `registerAckHandler`/
`registerEventHandler`/`registerDisconnectHandler` (lines 30-32).

**Send primitive already generic — reuse without modification** (lines 178-182):
```typescript
sendEvent(payload: { type: string; data?: unknown }): boolean {
  if (!this.agentConn || this.agentConn.ws.readyState !== WebSocket.OPEN) return false;
  this.agentConn.ws.send(JSON.stringify(payload));
  return true;
}
```
Call as `agentServer.sendEvent({ type: 'config', data: safeFields })` and
`agentServer.sendEvent({ type: 'reload_config' })` — no change to `sendEvent()` itself needed.

**Auth idiom to preserve unmodified (AGT-01..05 pin this)** (lines 46-57):
```typescript
private isValidBearerToken(authHeader: string): boolean {
  const PREFIX = 'Bearer ';
  if (!authHeader.startsWith(PREFIX)) return false;
  try {
    const received = Buffer.from(authHeader.slice(PREFIX.length), 'utf8');
    const expected = Buffer.from(this.config.AGENT_WS_TOKEN, 'utf8');
    if (received.length !== expected.length) return false;
    return timingSafeEqual(received, expected);
  } catch { return false; }
}
```
This is also the direct precedent for CMS password verification (Pattern 8) — same
`timingSafeEqual` idiom, reused rather than reinvented (RESEARCH.md's "Don't Hand-Roll" table
calls this out explicitly).

**Agent-side message API to extend** (`connection.ts:34-42, 103-116`):
```typescript
onMessage(handler: MessageHandler): this { this.handlers.push(handler); return this }
onStatusChange(cb: StatusCallback): this { this.statusCallbacks.push(cb); return this }
send(msg: unknown): boolean {
  if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { this.logger.warn('Cannot send: WebSocket not open'); return false }
  try { this.ws.send(JSON.stringify(msg)); return true } catch (err) { ... return false }
}
```
`dslrbooth-agent/src/index.ts`'s `ws.onMessage(...)` handler (not read this session — verify
its exact `if (msg.type === 'announcement')` chain before editing, per RESEARCH.md's own quoted
excerpt at its lines 372-399) gains `if (msg.type === 'config') {...}` and
`if (msg.type === 'reload_config') { ws.send({ type: 'config_request' }) }` branches using this
same `send()`/`onMessage()` API, and the initial pull is sent from `ws.onStatusChange('connected')`.

---

### 8. Session/password auth (new primitive, closest analog = crypto idiom + display gate)

**Analog for timing-safe comparison and secret handling:** `agentServer.ts:46-57` (quoted
above in Pattern 7) — same `crypto.timingSafeEqual` + length-guard + try/catch shape applies to
`verifyPassword()`.

**Analog for the middleware-chain shape:** `src/index.ts:43-50` (`/display-screen`'s inline
two-middleware chain) — `requireSession()` follows the same `(req,res,next) => { ...check...
next() }` shape, returning a generic 401/403 JSON body on failure (mirrors `genericNotFound()`
in `statusRoute.ts:20-22`'s single-shape-for-every-miss discipline).

**No in-repo password-hashing precedent exists** — this is new. Use Node builtin
`crypto.scryptSync`/`randomBytes`/`timingSafeEqual` per RESEARCH.md's Code Examples section
(verified executable on this runtime), not a new npm dependency, consistent with the "Runtime"
section of `mirror-request/CLAUDE.md` (`express, ws, better-sqlite3, winston, dotenv` only).

---

### 9. Constructor-injected timing values (hero TTL)

**Analog:** `mirror-request/src/queue/queueService.ts` constructor pattern for
`PENDING_PRINT_EXPIRY_MS`/`NO_PHOTO_CLOSE_DELAY_MS` (named in CONTEXT/RESEARCH; same file as
Pattern 6) and `DisplayServer`'s own `opts.pollIntervalMs` (Pattern 5, lines 37-48). Both
follow: module-level `const DEFAULT_X = <value>;`, constructor accepts `opts: { x?: number }
= {}`, assigns `this.x = opts.x ?? DEFAULT_X;`. Apply identically for
`heroMomentDurationMs` on `DisplayServer`.

---

### 10. Logging with PII masking

**Analog:** `mirror-request/src/logging/logger.ts` (132 lines, read in full)

**Masking formatters — new CMS/photo log lines must pass through these unchanged** (lines 7-14,
16-26):
```typescript
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /\+?\d{7,}/g;
export function mask(value: string): string {
  return value
    .replace(PHONE_RE, m => '*'.repeat(m.length))
    .replace(EMAIL_RE, '[EMAIL REDACTED]');
}
```
Masking is applied automatically by the winston `printf` formatter as long as callers pass a
**plain string** (`typeof message === 'string'`), never a raw object — see the
`debugRawPayload()` warning at lines 113-124. New CMS/photo code must call
`labelLogger('cms')` / `labelLogger('photo')` (line 62-64 `labelLogger(name)`) and always
template-string-interpolate guest names into the log message, never pass an object.

**Sensitive-id-masking-collision precedent** (`agentServer.ts:83-98`, referenced from
`logger.ts`'s own header): when minting any new id containing adjacent digits (e.g. a CMS
session token or upload filename with a timestamp), be aware `PHONE_RE` will partially mask
it — `agentServer.ts` fixed this at the mint site (`.replace(/(\d)(?=\d)/g, '$1x')`), not by
loosening the regex. Apply the same fix if a new CMS-generated id embeds a raw timestamp.

---

### 11. Test harnesses

**Real temp-file SQLite harness** — `mirror-request/test/local-store-persistence.test.ts:1-30`:
```typescript
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-store-'));
  dbPath = path.join(dir, 'test.sqlite');
  store = undefined;
});
afterEach(() => {
  if (store) { store.close(); store = undefined; }
  fs.rmSync(dir, { recursive: true, force: true });
});
it('...', () => {
  store = new LocalStore(dbPath);
  ...
});
```
Use this exact shape to prove `event`/`active_event`/`event_photo`/`agent_config` migration
idempotency against a real file, per CONTEXT.md's explicit instruction.

**Mocked-store service harness with supertest** — `mirror-request/test/display-access-control.test.ts:1-50`:
```typescript
let storeCounter = 0;
function uniqueStorePath(): string {
  storeCounter += 1;
  return `./data/test-display-access-control-${process.pid}-${Date.now()}-${storeCounter}.sqlite`;
}
const openStores: LocalStore[] = [];
function makeStore(): LocalStore {
  const store = new LocalStore(uniqueStorePath());
  openStores.push(store);
  return store;
}
function makeMockQueue(getQueueLength = () => 0): Partial<QueueService> {
  return { getQueuePosition: () => undefined, getQueueLength, getAnnouncement: () => null };
}
function makeMockAgent(): Partial<AgentServer> { return { isAgentOnline: () => true }; }
afterEach(() => { while (openStores.length) { try { openStores.pop()?.close(); } catch {} } });
```
This is the direct precedent for CMS route tests: build a real `LocalStore` on a unique path,
mock only `QueueService`/`AgentServer` via `Partial<T>`, drive routes through `supertest(app)`
— no WebSocket server needed for CMS route tests, exactly as this file avoids one for the
Express-layer half of its display-access-control assertions.

**dslrbooth-agent minimal vitest setup** — `dslrbooth-agent/test/connection-auth.test.ts` (not
read this session — file exists per `ls`; reuse its import/setup shape for
`config-mutation.test.ts`, verify its exact structure before writing the new test file).

---

### 12. Config keys with production-required validation

**Analog:** `mirror-request/src/config.ts` `loadConfig()` (159 lines, read in full)

**`errors.push` fail-fast pattern** (lines 6-19, 41-42, 65-73):
```typescript
export function loadConfig(): EnvConfig {
  const errors: string[] = [];
  const get = (key: string): string | undefined => process.env[key];
  const required = (key: string, placeholder: string): string => {
    const val = get(key);
    if (!val || val === placeholder) {
      errors.push(`${key} must be configured (not placeholder)`);
    }
    return val ?? '';
  };
  required('AGENT_WS_TOKEN', 'replace-with-agent-token');
  ...
  const displayIpWhitelist = toCSV('DISPLAY_IP_WHITELIST', []);
  if (isProduction && displayIpWhitelist.length === 0) {
    errors.push('DISPLAY_IP_WHITELIST must be configured in production with the real display-machine addresses (D-09, Assumption A4)');
  }
  if (errors.length > 0) {
    throw new Error(`Configuration errors:\n  - ${errors.join('\n  - ')}`);
  }
```
Direct template for `CMS_IP_WHITELIST` (`toCSV('CMS_IP_WHITELIST', [])` + `isProduction &&
cmsIpWhitelist.length === 0` push, per RESEARCH.md's Pitfall 2 — a NEW, independent key, not a
reuse of `DISPLAY_IP_WHITELIST`'s value) and for `CMS_USERNAME`/`CMS_PASSWORD_HASH` (use
`required()` the same way `AGENT_WS_TOKEN`/`DB_PASSWORD` do at lines 41-42, with a distinct
placeholder string per key).

**`toCSV`/`toNum`/`toBool` helpers** (lines 10-31) — reuse verbatim for any new numeric/boolean
CMS config (e.g. a maxlength constant if made configurable, though CONTEXT.md defaults this to
a constructor-injected constant, not an env var).

## Shared Patterns

### IP allow-list gating
**Source:** `mirror-request/src/security/ipAllowlist.ts` (whole file, 43 lines)
**Apply to:** `cmsIpGate.ts` (new `CMS_IP_WHITELIST`), unchanged for `/display-screen`/`WS /display`.
```typescript
export function isWhitelisted(ip: string, whitelist: string[]): boolean {
  if (whitelist.length === 0) return true;
  return whitelist.some((allowed) => {
    if (allowed.endsWith('.*')) return ip.startsWith(allowed.slice(0, -2));
    return ip === allowed;
  });
}
```

### Timing-safe secret comparison
**Source:** `mirror-request/src/agent/agentServer.ts:46-57`
**Apply to:** CMS password verification, any new bearer/session-token check.
```typescript
if (received.length !== expected.length) return false;
return timingSafeEqual(received, expected);
```

### Additive-only SQLite migration
**Source:** `mirror-request/src/state/localStore.ts` `bootstrap()`/`migrate()` (lines 22-110+)
**Apply to:** all four new tables (`event`, `active_event`, `event_photo`, `agent_config`).
`CREATE TABLE IF NOT EXISTS` in `bootstrap()`; new columns only via `PRAGMA table_info()` +
conditional `ALTER TABLE` in `migrate()`. Never DROP, never recreate.

### Masked, labeled logging
**Source:** `mirror-request/src/logging/logger.ts` `mask()` + `labelLogger()`
**Apply to:** every new CMS/photo/agent-config log line — always a template string, never a
raw object, always via `labelLogger('cms')` (or similarly named child).

### Constructor-injected timing/limit values
**Source:** `mirror-request/src/display/displayServer.ts:37-48` (`opts.pollIntervalMs`),
`mirror-request/src/queue/queueService.ts` (`PENDING_PRINT_EXPIRY_MS`-style fields)
**Apply to:** `heroMomentDurationMs` on `DisplayServer`. Never a singleton read at call time.

### Router-as-factory with narrow injected interfaces
**Source:** `mirror-request/src/status/statusRoute.ts:34-59`
**Apply to:** `createCmsRouter(store, agentServer, config)` — accept structural interfaces
(`Pick<...>` / narrow `interface`), not full concrete classes, so route tests can mock cheaply.

### Real temp-file SQLite test harness
**Source:** `mirror-request/test/local-store-persistence.test.ts:1-30`
**Apply to:** all new-table migration/idempotency tests — no mocked DB for schema proofs.

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `mirror-request/src/cms/uploadHandler.ts` | service | file-I/O | No existing upload/file-write surface in `src/` at all (RESEARCH.md confirms: "no static-file middleware, no upload middleware... anywhere in `src/`"). Follow RESEARCH.md's Code Examples/Don't-Hand-Roll sections directly: base64-JSON body via `express.json()`, magic-byte sniff (4 fixed signatures), server-generated filename, storage outside the code dir, hand-rolled serving route with a fixed allow-listed `Content-Type` (explicitly NOT `express.static`). |
| `mirror-request/src/cms/cmsAuth.ts` (password hashing specifically) | service | request-response | No password-hashing precedent exists anywhere in this repo. Use RESEARCH.md's verified `scryptSync(password, salt, 64, {N:16384,r:8,p:1})` + `timingSafeEqual` recipe (its Code Examples section) — new code, but zero new dependency. |
| Static font assets (`assets/fonts/*.woff2`) | config/static asset | file-I/O | No self-hosted-font precedent in this repo; serve via plain `express.static('assets/fonts')` (safe here — unlike `/uploads`, these are trusted build-time files, not user-supplied). |

## Metadata

**Analog search scope:** `mirror-request/src/{state,display,status,queue,agent,security,logging,cms}`,
`mirror-request/src/index.ts`, `mirror-request/src/config.ts`, `mirror-request/test/*.test.ts`,
`dslrbooth-agent/src/{config.ts,index.ts,websocket,dslrbooth}`, `dslrbooth-agent/test/*.test.ts`.
**Files scanned/read in full or targeted range:** `localStore.ts` (1-110), `displayServer.ts`
(full, 162 lines), `displayPage.ts` (full, 60 lines), `statusRoute.ts` (full, 216 lines),
`index.ts` (full, 107 lines), `config.ts` (full, 159 lines), `queueService.ts` (890-979),
`agentServer.ts` (full, 203 lines), `ipAllowlist.ts` (full, 43 lines), `logger.ts` (full, 132
lines), `dslrbooth-agent/src/config.ts` (full, 34 lines), `dslrbooth-agent/src/websocket/connection.ts`
(full, 183 lines), `dslrbooth-agent/src/dslrbooth/client.ts` (full, 66 lines),
`test/local-store-persistence.test.ts` (1-30), `test/display-access-control.test.ts` (1-70).
**Pattern extraction date:** 2026-08-12
