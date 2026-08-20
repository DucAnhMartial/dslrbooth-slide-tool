# Phase 6: Ingestion Cutover - Pattern Map

**Mapped:** 2026-08-11
**Files analyzed:** 8 (2 pure-DDL/docs artifacts + 6 TypeScript/test artifacts)
**Analogs found:** 6 / 8 direct code analogs; 2 DDL/docs artifacts use a *discipline* analog, not a source-file analog (see note below)

## Note on this phase's artifact shape

This phase is unusual: its primary product is SQL DDL that lives in MySQL
(`photobooth.registrations` VIEW + one `GRANT`), not TypeScript in either repo.
There is **no existing "closest analog source file"** for a VIEW — the correct
transfer is the project's established **migration/rollback discipline**, i.e.
capture-before-mutate, documented in `STATE.md`'s Phase 2/4 history
(`data/backups/extension-service.sqlite.<timestamp>.bak`,
`data/backups/*.2026-08-10T11-12-38.bak`) and echoed verbatim in RESEARCH.md's
"Rollback capture, before the DROP" section. The planner should treat that
prose section, not a `.ts` file, as the pattern source for the VIEW/GRANT/
rollback-script wave.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `mirror-request/docs/migrations/06-registrations-view.sql` (DDL doc, VIEW+GRANT text) | config/migration | batch (one-shot DDL) | *discipline analog only* — RESEARCH.md "Rollback capture, before the DROP" + `STATE.md` Phase 2/4 backup convention | discipline-match, no source-file analog |
| `mirror-request/data/backups/photobooth-registrations-rollback-<timestamp>.sql` | migration (rollback artefact) | batch | same as above | discipline-match |
| `mirror-request/src/ops/viewHealthProbe.ts` | service (health probe) | request-response (DB ping) + event-driven (periodic timer) | `mirror-request/src/ingestion/dbPoller.ts` (pool + `start()`/`stop()`/interval lifecycle, warn-and-retry `catch`) and `mirror-request/src/notifications/notificationService.ts` (alert dispatch via `fetch` + `AbortSignal.timeout`, never-crash sweep discipline) | exact (composite of two role-matches) |
| `mirror-request/src/security/rateLimiter.ts` | middleware | request-response | `mirror-request/src/security/ipAllowlist.ts` (plain exported functions, no class, no new dependency, Express-agnostic shape) | exact |
| `mirror-request/src/status/statusRoute.ts` (modified — mount limiter ahead of handler) | route | request-response | itself (existing file); its own `genericNotFound()` single-response-shape discipline is the constraint the limiter's response must not violate | n/a (modifying in place) |
| cursor-seeding step (one-time operational call, likely a small script or documented manual step, e.g. `mirror-request/scripts/seed-registrations-cursor.ts` or a runbook-documented CLI invocation) | utility (one-shot ops script) | batch | `mirror-request/src/state/localStore.ts` `setCursor()` (lines 298-300) — the only mechanism this step needs; no new schema | role-match (script wraps an existing method, not a new pattern) |
| `mirror-request/test/view-health-probe.test.ts` | test | event-driven / request-response (mocked) | `mirror-request/test/db-poller.test.ts` (`createRequire` + `vi.spyOn(mysql2Promise, 'createPool', ...)` mocking technique, lines 1-49) | exact |
| `mirror-request/test/status-rate-limit.test.ts` | test | request-response | `mirror-request/test/status-api.test.ts` (supertest against a real Express app built from `createStatusRouter`, `expectGenericNotFound()`-style single-response-shape helper) | exact |
| `mirror-request/test/local-store-persistence.test.ts` (extended, not new) | test | CRUD | itself (existing file) — add a case asserting `getCursor('registrations')` returns a seeded "now" value, not the `1970-01-01` default | n/a (extending in place) |
| `mirror-request/docs/OPS-RUNBOOK.md` (extended) | config/docs | n/a | itself — existing §3 (env keys) / §7 (deploy) structure | n/a (extending in place) |

## Pattern Assignments

### `mirror-request/src/ops/viewHealthProbe.ts` (service, DB-ping + periodic)

**Analogs:** `mirror-request/src/ingestion/dbPoller.ts` (lifecycle + pool) and `mirror-request/src/notifications/notificationService.ts` (alert dispatch).

**Pool reuse / no second pool — dbPoller.ts:43-53:**
```typescript
try {
  const mysql = require('mysql2/promise');
  this.pool = mysql.createPool({
    host: this.dbConfig.host,
    port: this.dbConfig.port,
    database: this.dbConfig.database,
    user: this.dbConfig.user,
    password: this.dbConfig.password,
    waitForConnections: true,
    connectionLimit: 2,
  });
} catch (err) {
  logger.warn('DB poller: mysql2 not available, skipping. Install mysql2 to enable DB polling.');
  this.running = false;
  return;
}
```
RESEARCH.md is explicit the probe must reuse `dbPoller.ts`'s own already-constructed pool, not create a second `mysql2` pool — the probe module should receive the pool (or the `DBPoller` instance) via constructor injection, matching this project's "config injected through the constructor, not read from a singleton" house rule.

**Lifecycle shape — `start()`/`stop()`/interval — dbPoller.ts:34-90:**
```typescript
start(): void {
  if (this.running) return;
  this.running = true;
  ...
  this.doPoll()
    .then(() => { ...; this.timer = setInterval(() => this.doPoll(), this.intervalMs); })
    .catch((err: Error) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`DB poller initial cycle failed, will retry every ${this.intervalMs}ms: ${message}`);
      this.timer = setInterval(() => this.doPoll(), this.intervalMs);
    });
}

stop(): void {
  if (!this.running) return;
  this.running = false;
  if (this.timer) { clearInterval(this.timer); this.timer = null; }
  if (this.pool?.end) { this.pool.end().catch(() => {}); }
}
```
The probe should follow the same "run once at startup, then interval" shape, and must run **both** at startup and periodically per D-09 — startup run must never block `app.listen()` (see Wave 0 gap in RESEARCH.md's Phase Requirements → Test Map: "does not prevent `app.listen()`'s callback from completing").

**Warn-and-retry catch, never crash — dbPoller.ts:134-144 (D-05 precedent for D-09's departure from `config.ts` fail-fast):**
```typescript
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  logger.warn(`DB poller cycle failed: ${message}`);
} finally {
  conn?.release();
}
```

**Error-class branching — the probe's own new logic, per RESEARCH.md's Code Examples section (not lifted from an existing file, since no existing file branches on `err.code`):**
```typescript
async function probeViewHealth(pool: any, alert: (msg: string) => Promise<void>): Promise<void> {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query('SELECT id FROM registrations LIMIT 1');
  } catch (err: any) {
    const code = err?.code as string | undefined;
    const isViewBroken = code === 'ER_VIEW_INVALID'; // errno 1356
    if (isViewBroken) {
      opsLogger.error(`Registrations VIEW is broken: ${err.message}`);
      await alert(`photobooth.registrations VIEW is broken: ${err.message}`);
    } else {
      opsLogger.warn(`VIEW health probe: DB unreachable (${code ?? 'unknown'}), will retry`);
    }
  } finally {
    conn?.release();
  }
}
```

**Alert dispatch — reuse `notificationService.ts`'s exact fetch shape, notificationService.ts:149-155 (NOT a new AlertService class):**
```typescript
const response = await fetch(this.webhookUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(this.fetchTimeoutMs),
});
if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}`);
```
Reuse `config.NOTIFY_WEBHOOK_URL` / `config.NOTIFY_FETCH_TIMEOUT_MS` — do not invent a second webhook URL config key. Per RESEARCH.md's "Don't Hand-Roll" table, a full `AlertService` class is overkill for this fire-and-forget alert; call `fetch` directly with the same signature.

**Logging convention — success path is silent, matching notificationService.ts's "no log noise on the success path, only state changes/failures" convention** (see `probeViewHealth`'s comment above — no `info` log on a healthy probe cycle).

---

### `mirror-request/src/security/rateLimiter.ts` (middleware, request-response)

**Analog:** `mirror-request/src/security/ipAllowlist.ts` (full file, 44 lines — reproduced in full above since it is well under the 2,000-line threshold).

**Shape to copy — plain exported functions, no class, no new dependency:**
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
`ipAllowlist.ts` is Express-agnostic (structural `{ ip?: string; socket: { remoteAddress?: string } }` param, not `Request`), which is exactly the shape a hand-rolled limiter needs so it is unit-testable without booting Express. Follow the same pattern: export a pure `isRateLimited(key, now, state)`-style function plus a small in-memory `Map`-based state holder, not a class with hidden state, per RESEARCH.md's explicit recommendation against `express-rate-limit` (flagged `[SUS]`, "too-new," not adopted — no new dependency).

**Critical constraint from RESEARCH.md's Security Domain table — the limiter must gate BEFORE `store.getJob()` runs, not after, to avoid a timing side-channel distinguishing real vs. fake ids:**
> "the rate-limit check must gate ahead of the `store.getJob()` call, not after, or a timing side-channel appears: a limited request for a real id vs. a limited request for a fake id could differ in response latency if the real-id path does more work before hitting the limiter."

**No proxy trust — same caveat `ipAllowlist.ts`'s header comment states explicitly (lines 16-25):** no `app.set('trust proxy', ...)` is enabled anywhere in this service; `req.ip` resolves to the direct TCP peer. The limiter's client-key derivation should reuse `clientIp()` from `ipAllowlist.ts` directly rather than re-deriving IP another way.

---

### `mirror-request/src/status/statusRoute.ts` (modified — mount limiter)

**Analog:** itself. Existing single-response-shape discipline, statusRoute.ts:8-21:
```typescript
function genericNotFound(res: Response): Response {
  return res.status(404).json({ error: 'job not found' });
}
```
D-10's Claude's Discretion note ("a throttled response is not distinguishable in a way that confirms an id exists") means the 429 (or chosen status) response must be a similarly fixed, minimal shape — no `reason`/`retryAfterSeconds`-with-hint field that would differ based on whether the id was real. Mount the limiter middleware ahead of the `router.get('/status/:jobId', ...)` handler (statusRoute.ts:67) so the limiter's own response — not the handler's `genericNotFound()` — is what a throttled caller sees, and the two must not be distinguishable from each other in status/shape in a way that leaks id validity.

---

### Cursor seeding (D-06)

**Analog:** `mirror-request/src/state/localStore.ts:298-300`
```typescript
setCursor(pollKey: string, value: string): void {
  this.db.prepare('INSERT OR REPLACE INTO db_poll_cursor (poll_key, last_value, updated_at) VALUES (?, ?, ?)').run(pollKey, value, new Date().toISOString());
}
```
No new schema or method needed — the seeding step is a single call: `store.setCursor('registrations', <cutover-timestamp-string>)`, run once before `DBPoller.start()` is first invoked (per `mirror-request/src/index.ts:52-63`, the poller is wired unconditionally with no enable/disable flag, so this must happen before process start, not after). The seeded value must be a **string** in the same lexical format the VIEW will emit (see Pitfall 1 below) so the `registered_at > ?` comparison in `dbPoller.ts:101` stays a valid lexical/chronological comparison.

---

### `mirror-request/test/view-health-probe.test.ts` (new)

**Analog:** `mirror-request/test/db-poller.test.ts:1-49` (full mocking harness).

**Mocking technique to copy verbatim:**
```typescript
import { createRequire } from 'node:module';
const nodeRequire = createRequire(import.meta.url);
const mysql2Promise = nodeRequire('mysql2/promise');
...
queryMock = vi.fn().mockResolvedValue([[]]);
releaseMock = vi.fn();
endMock = vi.fn().mockResolvedValue(undefined);
getConnectionMock = vi.fn().mockResolvedValue({ query: queryMock, release: releaseMock });
createPoolMock = vi.spyOn(mysql2Promise, 'createPool').mockReturnValue({
  getConnection: getConnectionMock,
  end: endMock,
});
```
The comment block above this excerpt (db-poller.test.ts:11-22) documents *why* `vi.mock('mysql2/promise', ...)` does NOT work here — a lazy `require()` bypasses vitest's static-import interception — and why `createRequire` + `vi.spyOn` is the only technique that does. Reuse this exact rationale rather than rediscovering it; a naive `vi.mock` in the new probe test will silently fail to intercept and the test will hit the real DB.

Test cases needed (from RESEARCH.md's Phase Requirements → Test Map, M6 criterion 3): `queryMock.mockRejectedValue({code: 'ER_VIEW_INVALID'})` → assert `alert` called + `error` logged; `queryMock.mockRejectedValue({code: 'ECONNREFUSED'})` (and other connection-class codes) → assert `alert` NOT called, `warn` logged only; assert the probe function never throws/rejects out of its own boundary in either case.

---

### `mirror-request/test/status-rate-limit.test.ts` (new)

**Analog:** `mirror-request/test/status-api.test.ts:1-60` (full supertest harness pattern, reproduced above).

**Pattern to copy:**
```typescript
import express from 'express';
import request from 'supertest';
import { LocalStore } from '../src/state/localStore';
import { createStatusRouter } from '../src/status/statusRoute';

function expectGenericNotFound(res: request.Response): void {
  expect(res.status).toBe(404);
  expect(Object.keys(res.body)).toEqual(['error']);
  expect(res.body.error).toBe('job not found');
}
```
Follow the same "exact-keys" assertion discipline for the new rate-limit response shape (D-10's non-distinguishability requirement) — assert `Object.keys(res.body)` equals a fixed small set, not just the status code, exactly as `expectGenericNotFound` does for the 404 case. Also follow `status-api.test.ts`'s DB-file-per-test-run naming convention (`./data/test-<name>-${process.pid}-${Date.now()}.sqlite`) to avoid the shared-test-DB race noted in `WINDOWS.md` item 4.

---

### `mirror-request/test/local-store-persistence.test.ts` (extended)

**Analog:** itself (existing file, extend in place). New case: seed via `store.setCursor('registrations', <now-ISO-string>)`, then assert `store.getCursor('registrations')` returns that value, not the `dbPoller.ts:98` default of `'1970-01-01T00:00:00.000Z'`.

---

### VIEW DDL / rollback artefact (discipline analog, not source-file analog)

**Source of discipline:** `STATE.md`'s Phase 2/4 backup-before-mutation convention (`data/backups/extension-service.sqlite.<timestamp>.bak`), echoed in RESEARCH.md's "Rollback capture, before the DROP" section:
```sql
-- Run once, by hand, before DROP TABLE. Save the full output verbatim.
SHOW CREATE TABLE photobooth.registrations;
```
Store the output as `mirror-request/data/backups/photobooth-registrations-rollback-<timestamp>.sql`, formatted as a directly-runnable restore script:
```sql
DROP VIEW IF EXISTS photobooth.registrations;
CREATE TABLE photobooth.registrations ( /* paste SHOW CREATE TABLE output here */ );
```
This is capture-before-mutate, not "write a migration file that resembles an existing migration file" — there is no prior VIEW-creation migration in this project to copy syntax from. The planner should treat RESEARCH.md's Pattern 1 SQL skeleton (dedup'd `ROW_NUMBER()` JOIN, `DATE_FORMAT` cast) as the DDL starting point, explicitly flagged there as "a candidate skeleton for the planner to refine, not a verified-final SQL text."

## Shared Patterns

### Never crash on a network/DB boundary (D-05/D-09 lineage)
**Source:** `mirror-request/src/ingestion/dbPoller.ts:134-144` (doPoll's catch) and `mirror-request/src/notifications/notificationService.ts:103-114` (sweep's per-row catch).
**Apply to:** `viewHealthProbe.ts` entirely — this is the load-bearing precedent for D-09's explicit departure from `config.ts`'s fail-fast pattern. Every branch of the probe must warn-or-error-and-continue, never throw past its own function boundary, never call `process.exit`.

### Config injected through the constructor, not read from a singleton
**Source:** `mirror-request/src/ingestion/dbPoller.ts:21-32` (constructor takes `intervalMs`, `batchSize`, `store`, `dbConfig` as parameters) and `mirror-request/src/notifications/notificationService.ts:22-44` (constructor takes `maxRetries`, `store`, `webhookUrl`, and a timing-options object, all defaulted from `config` but overridable).
**Apply to:** `viewHealthProbe.ts` (probe interval, alert function, pool) and `rateLimiter.ts` (window, threshold) — both must accept these as constructor/factory parameters so tests can drive them without waiting on real timers, per RESEARCH.md's "Established Patterns" list in CONTEXT.md.

### Single fixed response shape, no enumeration oracle
**Source:** `mirror-request/src/status/statusRoute.ts:8-21` (`genericNotFound`) and `mirror-request/test/status-api.test.ts:19-33` (`expectGenericNotFound`, exact-keys assertion).
**Apply to:** the rate limiter's throttled response — must not add a `reason`/`retryAfter`/`hint` field that would let a caller distinguish "you were throttled because this id is real and gets checked more" from "you were throttled regardless." One response shape, asserted by exact key set in the new test.

### Warn-once-per-fallback-rung logging (D-05 of the name-fallback chain)
**Source pattern (structural, not code — no existing name-fallback chain exists to copy from):** `mirror-request/src/ingestion/dbPoller.ts:109-112`'s single `logger.warn` per skipped-row event is the closest existing precedent for "one warn line per anomalous event, naming the specific identifier and the specific reason." The VIEW's own D-04/D-05 name-fallback logging, however, **cannot live in TypeScript at all** — D-02 forbids touching `dbPoller.ts`, and the fallback chain is computed inside the VIEW's SQL (`COALESCE`/`CASE`). Per CONTEXT.md D-05, a MySQL `SIGNAL`/trigger-based warn is out of scope for a read-only VIEW; treat D-05's "emit one warn log" requirement as satisfied by the synthetic-label column itself being observable (`Khách • <last 4>`) plus an operational runbook note in `OPS-RUNBOOK.md`, not a live log line — flag this gap explicitly to the planner rather than silently dropping it.

## Cross-database type-coercion hazard (both bind sites, quoted in full)

**Confirmed via `Bash grep` then opened both matches — 2 occurrences total, both executable code (not comments):**

`mirror-request/src/state/localStore.ts:123-135` — `upsertRegistration()`:
```typescript
upsertRegistration(r: Registration & { raw_payload?: string; received_at?: number }): Registration {
  const stmt = this.db.prepare(
    `INSERT OR REPLACE INTO registration (id, name, email, phone, mode, registered_at, raw_payload, received_at)
     VALUES (@id, @name, @email, @phone, @mode, @registered_at, @raw_payload, @received_at)`
  );
  stmt.run({
    id: r.id, name: r.name, email: r.email, phone: r.phone,
    mode: r.mode, registered_at: r.registered_at,
    raw_payload: r.raw_payload ?? null,
    received_at: r.received_at ?? Date.now(),
  });
  return r;
}
```

`mirror-request/src/state/localStore.ts:298-300` — `setCursor()`:
```typescript
setCursor(pollKey: string, value: string): void {
  this.db.prepare('INSERT OR REPLACE INTO db_poll_cursor (poll_key, last_value, updated_at) VALUES (?, ?, ?)').run(pollKey, value, new Date().toISOString());
}
```

Both bind `registered_at`-derived values directly with no type coercion in between. Neither file is modified by this phase (D-02 forbids `dbPoller.ts`, and `localStore.ts` needs no change either — the fix is entirely upstream, in the VIEW's `SELECT` list casting `registered_at` to a string via `DATE_FORMAT(a.created_at, '%Y-%m-%d %H:%i:%s.%f')`, never a bare `DATETIME`/`TIMESTAMP` column). This is quoted here so the planner can verify, at the VIEW-creation task, that a real query through the pool yields `typeof row.registered_at === 'string'` before wiring anything to these two bind sites.

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| VIEW SQL text itself (`CREATE VIEW photobooth.registrations ...`) | migration (DDL) | batch | No prior VIEW-creation DDL exists anywhere in either repo to copy syntax from; RESEARCH.md's Pattern 1 skeleton is the only precedent, explicitly marked "candidate, not verified-final." |
| `GRANT SELECT ON photobooth.registrations TO ...` statement | migration (DCL) | batch | Same — no prior cross-database GRANT exists in this project's history to copy from; RESEARCH.md's Pitfall 4 (GRANT-scoped-to-object-name persistence across DROP+CREATE) is the only guidance available. |

## Metadata

**Analog search scope:** `mirror-request/src/{ingestion,notifications,security,status,state}/`, `mirror-request/test/`
**Files scanned:** `dbPoller.ts`, `notificationService.ts`, `ipAllowlist.ts`, `statusRoute.ts`, `localStore.ts`, `db-poller.test.ts`, `status-api.test.ts`, `local-store-persistence.test.ts` (path confirmed, not opened in full — extend in place per RESEARCH.md's Wave 0 gap list)
**Pattern extraction date:** 2026-08-11
**Counts verified by opening matches, not `grep -c` alone:** `registered_at` bind sites in `localStore.ts` — 4 raw `grep -n` matches total (line 30 schema `CREATE TABLE` column def, line 125-126 SQL text inside the prepared statement, line 130 the actual bind-object key); of these, **2 are executable bind sites** (the `stmt.run({...registered_at: r.registered_at...})` call at line 128-133, and `setCursor`'s positional `.run(pollKey, value, ...)` call at line 299) — the schema line (30) and the SQL-string line (125-126) are not themselves runtime bind operations, matching this project's house rule against trusting `grep -c` alone.
