# Phase 1: Foundation & Ingestion - Pattern Map

**Mapped:** 2026-08-10
**Files analyzed:** 9 (5 modified, 3 new source, 4 new test)
**Analogs found:** 9 / 9 (this phase is a hardening pass over existing code — every "new" file has a direct in-repo analog because it extends or sits next to a file already implementing the pattern)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|--------------------|------|-----------|-----------------|----------------|
| `mirror-request/src/ingestion/mirrorReceiver.ts` (MODIFY) | controller/route | request-response | itself (existing file, in-place hardening) | exact |
| `mirror-request/src/ingestion/webhookAuth.ts` (NEW) | middleware | request-response | `mirror-request/src/ingestion/mirrorReceiver.ts` (`isWhitelisted` closure pattern) | role-match |
| `mirror-request/src/ingestion/dbPoller.ts` (MODIFY) | service (polling loop) | batch/event-driven | itself (existing file, in-place hardening) | exact |
| `mirror-request/src/state/localStore.ts` (MODIFY — add `webhook_replay` table, dedup query, `received_at` column) | model/store | CRUD | itself (existing prepared-statement methods, e.g. `isProcessed`/`markProcessed`, `getCursor`/`setCursor`) | exact |
| `mirror-request/src/config.ts` (MODIFY — add dedup/HMAC/skew keys) | config | transform | itself (existing `toNum`/`toCSV`/`required` helpers) | exact |
| `mirror-request/src/types.ts` (MODIFY — extend `EnvConfig`) | config/types | transform | itself (existing `EnvConfig` interface) | exact |
| `mirror-request/src/index.ts` (MODIFY — add raw-body `verify` callback) | composition root | request-response | itself (existing `app.use(express.json())` call site) | exact |
| `mirror-request/test/on-register-auth.test.ts` (NEW) | test | request-response | `mirror-request/test/notification-webhook.test.ts` | role-match (closest HTTP-level test; will additionally need `supertest` since this analog hand-rolls `http.createServer`) |
| `mirror-request/test/on-register-dedup.test.ts` (NEW) | test | CRUD | `mirror-request/test/notification-webhook.test.ts` (store setup style: `getStore()` + `upsertRegistration`/`enqueueJob`) | role-match |
| `mirror-request/test/db-poller.test.ts` (NEW) | test | batch/event-driven | `mirror-request/test/notification-service.test.ts` (not read this session, but same suite convention: Vitest + `getStore()`) | role-match |
| `mirror-request/test/local-store-persistence.test.ts` (NEW) | test | CRUD | `mirror-request/test/notification-webhook.test.ts` (store lifecycle usage) | role-match |

## Pattern Assignments

### `mirror-request/src/ingestion/mirrorReceiver.ts` (controller, request-response) — MODIFY IN PLACE

**Analog:** itself, full file read this session (59 lines) — `/opt/mirror_request_dslrobooth/mirror-request/src/ingestion/mirrorReceiver.ts`

**Imports pattern** (lines 1-3):
```typescript
import { Router, Request, Response } from 'express';
import { LocalStore } from '../state/localStore';
import logger from '../logging/logger';
```

**Factory + closure pattern** (lines 5-18):
```typescript
export function createMirrorReceiver(store: LocalStore, whitelist: string[], onEnqueue?: (jobId: string) => void): ReturnType<typeof Router> {
  const router = Router();

  function isWhitelisted(req: Request): boolean {
    if (whitelist.length === 0) return true;
    const ip = (req.ip || req.connection.remoteAddress || '').split(',')[0].trim();
    return whitelist.some((allowed) => {
      if (allowed.endsWith('.*')) {
        const prefix = allowed.slice(0, -2);
        return ip.startsWith(prefix);
      }
      return ip === allowed;
    });
  }
```
New HMAC verification should follow this same "helper function inside the factory closure, called first in the handler" shape — either inline here or imported from `webhookAuth.ts` and invoked the same way `isWhitelisted(req)` is invoked below.

**Route handler / validation / idempotency / error-response pattern** (lines 20-56):
```typescript
router.post('/on-register', (req: Request, res: Response) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';

    if (!isWhitelisted(req)) {
      logger.warn(`Blocked /on-register from non-whitelisted IP: ${ip}`);
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { id, name, email, phone, mode, qr_token, registered_at } = req.body ?? {};

    if (!id || !name) {
      return res.status(400).json({ error: 'id and name are required' });
    }

    if (store.isProcessed(id)) {
      return res.status(200).json({ duplicate: true, jobId: id });
    }

    const registration = {
      id, name, email: email ?? '', phone: phone ?? '',
      mode: mode ?? 'standard', qr_token: qr_token ?? null,
      registered_at: registered_at ?? new Date().toISOString(),
    };

    store.upsertRegistration(registration);
    store.saveRawPayload(id, JSON.stringify(req.body));
    store.markProcessed(id);
    store.enqueueJob({ id, queued_at: Date.now() });
    onEnqueue?.(id);

    logger.info(`Ingested registration ${id} from ${ip}`);
    return res.status(200).json({ accepted: true, jobId: id });
  });
```
Key pattern to preserve: **synchronous 403/400/200 early-returns, no thrown exceptions, one `logger.warn`/`logger.info` string per branch** (never an object — this matters because `logging/logger.ts`'s masking only runs on string `message` values, see Shared Patterns below). D-03's "duplicate returns original jobId, no new queue job" should slot into the existing `if (store.isProcessed(id))` early-return shape — extend it to also check the new time-window dedup query, still returning before any `store.upsertRegistration`/`saveRawPayload`/`enqueueJob` calls (per RESEARCH.md Pitfall/Anti-Pattern: never re-run persistence on a duplicate).

---

### `mirror-request/src/ingestion/webhookAuth.ts` (NEW middleware, request-response)

**Analog:** `mirror-request/src/ingestion/mirrorReceiver.ts`'s `isWhitelisted()` (same file/lines as above) — closest existing example of a request-scoped boolean guard function that logs a generic reason and lets the caller decide the HTTP response.

Recommended shape (from RESEARCH.md Pattern 2/3, consistent with the `isWhitelisted` closure style — a plain function taking `req`-derived values and returning a verdict, not a class):
```typescript
import { createHmac, timingSafeEqual } from 'crypto';
import type { LocalStore } from '../state/localStore';

export function verifySignature(rawBody: Buffer, timestamp: string, webhookId: string, signatureHeader: string, secret: string): boolean {
  const canonical = `${timestamp}.${webhookId}.${rawBody.toString('utf8')}`;
  const expected = createHmac('sha256', secret).update(canonical).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const receivedBuf = Buffer.from(signatureHeader, 'hex');
  if (expectedBuf.length !== receivedBuf.length) return false; // guard before timingSafeEqual (throws on length mismatch)
  return timingSafeEqual(expectedBuf, receivedBuf);
}
```
Replay-ID check should call new `LocalStore` methods (see below), following the exact style of the existing `isProcessed`/`markProcessed` pair.

**Error-response contract to match D-12 (generic reason, never detail):** follow the exact `logger.warn(...)` + `res.status(403).json({ error: 'Forbidden' })` shape already used in `mirrorReceiver.ts:24-26` — do not add validation detail to either the log line or the JSON body.

---

### `mirror-request/src/ingestion/dbPoller.ts` (service, batch/event-driven) — MODIFY IN PLACE

**Analog:** itself, full file read this session (116 lines) — `/opt/mirror_request_dslrobooth/mirror-request/src/ingestion/dbPoller.ts`

**Class shape / constructor pattern** (lines 4-17):
```typescript
export class DBPoller {
  private intervalMs: number;
  private batchSize: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private pool: any;
  private store: ReturnType<typeof getStore>;

  constructor(intervalMs: number, batchSize: number, store: ReturnType<typeof getStore>) {
    this.intervalMs = intervalMs;
    this.batchSize = batchSize;
    this.store = store;
    this.pool = null;
  }
```
Per RESEARCH.md Pitfall 4, this constructor should be extended to accept the resolved `DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD` from `EnvConfig` instead of reading `process.env` directly inside `start()` (lines 23-27 below) — this is the exact spot to fix the `5432`/`3306` default drift.

**Config-drift smell to fix (lines 23-27), do NOT copy this sub-pattern, replace it:**
```typescript
const dbHost = process.env.DB_HOST ?? 'localhost';
const dbPort = Number(process.env.DB_PORT ?? '3306');
const dbName = process.env.DB_NAME ?? 'photobooth';
const dbUser = process.env.DB_USER ?? '';
const dbPass = process.env.DB_PASSWORD ?? '';
```

**Resilient polling cycle / error handling pattern** (lines 74-115) — this IS the pattern to copy for D-05/D-06/D-08 (never let a poll-cycle failure kill the service; `catch` inside `doPoll`, not around `setInterval`):
```typescript
private async doPoll(): Promise<void> {
    if (!this.running || !this.pool) return;
    let conn;
    try {
      conn = await this.pool.getConnection();
      const cursor = this.store.getCursor('registrations');
      const lastAt = cursor ?? '1970-01-01T00:00:00.000Z';

      const [rows] = await conn.query(
        'SELECT id, name, email, phone, mode, registered_at FROM registrations WHERE registered_at > ? ORDER BY registered_at ASC LIMIT ?',
        [lastAt, this.batchSize]
      );

      const records = rows as Array<{ id: string; name: string; email: string; phone: string; mode: string; registered_at: string }>;
      if (records.length === 0) return;

      for (const row of records) {
        if (this.store.isProcessed(row.id)) continue;   // <-- D-04: add logger.info reconciliation log here before `continue`
        this.store.upsertRegistration({ ...row, phone: row.phone ?? '', registered_at: row.registered_at ?? new Date().toISOString() });
        this.store.markProcessed(row.id);
        this.store.enqueueJob({ id: row.id, queued_at: Date.now() });
        logger.info(`DB poller ingested ${row.id}`);
      }

      const lastRow = records.at(-1);
      if (lastRow) {
        this.store.setCursor('registrations', lastRow.registered_at);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`DB poller cycle failed: ${message}`);   // <-- D-05: this is already correct, retries next setInterval tick automatically
    } finally {
      conn?.release();
    }
  }
```
D-06 (skip record missing `id`/`name`, log for audit, don't block cursor) should be added as a per-row `if (!row.id || !row.name) { logger.warn(...); continue; }` guard inside the same `for` loop, matching the `isProcessed` `continue` style exactly — critically, the `lastRow`/`setCursor` call at the bottom must still run over the full `records` array regardless of skips, since cursor advancement is keyed to the last fetched row, not the last *ingested* row (this already works correctly as written — confirm no change needed there beyond adding the skip branch).

---

### `mirror-request/src/state/localStore.ts` (model/store, CRUD) — MODIFY IN PLACE

**Analog:** itself, full file read this session (281 lines) — `/opt/mirror_request_dslrobooth/mirror-request/src/state/localStore.ts`

**Bootstrap/schema pattern** (lines 22-68) — new `webhook_replay` table and `registration.received_at` column should be added inside `bootstrap()`'s single `db.exec(...)` template literal, in the same `CREATE TABLE IF NOT EXISTS` style as existing tables:
```typescript
bootstrap(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS registration (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT NOT NULL,
        mode TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        raw_payload TEXT
      );
      ...
      CREATE TABLE IF NOT EXISTS db_poll_cursor (
        poll_key TEXT PRIMARY KEY,
        last_value TEXT NOT NULL,
        updated_at TEXT DEFAULT 'now'
      );
      ...
    `);
  }

  migrate(): void {
    // Phase 2+ migrations go here    <-- adding received_at to an existing `registration` table needs an ALTER here (CREATE TABLE IF NOT EXISTS won't add columns to an existing DB file), following this exact stub's intent
  }
```

**Prepared-statement CRUD method pattern to copy exactly** (lines 179-195, `isProcessed`/`markProcessed`/`getCursor`/`setCursor`):
```typescript
  isProcessed(regId: string): boolean {
    return this.db.prepare('SELECT 1 FROM processed_id WHERE reg_id = ?').get(regId) !== undefined;
  }

  markProcessed(regId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO processed_id (reg_id) VALUES (?)').run(regId);
  }

  getCursor(pollKey: string): string | undefined {
    const row = this.db.prepare('SELECT last_value FROM db_poll_cursor WHERE poll_key = ?').get(pollKey) as { last_value: string } | undefined;
    return row?.last_value;
  }

  setCursor(pollKey: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO db_poll_cursor (poll_key, last_value, updated_at) VALUES (?, ?, ?)').run(pollKey, value, new Date().toISOString());
  }
```
New `hasSeenWebhookId(webhookId)`/`recordWebhookId(webhookId, receivedAt)` (replay) and a dedup-window query method (id-then-email/phone fallback per D-02) should be added as new methods immediately following this section, in the same terse `this.db.prepare(...).get()/.run()` one-liner style — no ORM, no query builder, always parameterized `?` placeholders.

**Existing `upsertRegistration` — note the `INSERT OR REPLACE` risk flagged in RESEARCH.md Pitfall 7** (lines 76-87):
```typescript
  upsertRegistration(r: Registration & { raw_payload?: string }): Registration {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO registration (id, name, email, phone, mode, registered_at, raw_payload)
       VALUES (@id, @name, @email, @phone, @mode, @registered_at, @raw_payload)`
    );
    stmt.run({ id: r.id, name: r.name, email: r.email, phone: r.phone, mode: r.mode, registered_at: r.registered_at, raw_payload: r.raw_payload ?? null });
    return r;
  }
```
When adding `received_at`, extend this same `INSERT OR REPLACE` statement's column list and `@`-named param binding — keep the flat object-param style, don't switch to positional `?` here since this method already uses named params.

**Singleton export pattern** (lines 276-280) — unchanged, no action needed, just confirms `getStore()` is the one shared instance new code should inject/reuse, never `new LocalStore()` directly outside this file:
```typescript
let store: LocalStore | null = null;
export function getStore(): LocalStore {
  if (!store) store = new LocalStore();
  return store;
}
```

---

### `mirror-request/src/config.ts` + `mirror-request/src/types.ts` (config, transform) — MODIFY IN PLACE

**Analog:** itself, both files read in full this session — `/opt/mirror_request_dslrobooth/mirror-request/src/config.ts` (88 lines), `/opt/mirror_request_dslrobooth/mirror-request/src/types.ts` (106 lines)

**Helper functions to reuse verbatim** (`config.ts` lines 10-39):
```typescript
  const toNum = (key: string, fallback: number): number => {
    const val = get(key);
    if (val === undefined) return fallback;
    const n = Number.parseInt(val, 10);
    if (Number.isNaN(n)) { errors.push(`${key} must be a number, got "${val}"`); return fallback; }
    return n;
  };

  const toCSV = (key: string, fallback: string[]): string[] => {
    const val = get(key);
    if (!val) return fallback;
    return val.split(',').map(s => s.trim()).filter(Boolean);
  };

  const required = (key: string, placeholder: string): string => {
    const val = get(key);
    if (!val || val === placeholder) { errors.push(`${key} must be configured (not placeholder)`); }
    return val ?? '';
  };
```
New `REGISTRATION_DEDUP_WINDOW_MS`, `WEBHOOK_HMAC_SECRET`, `WEBHOOK_TIMESTAMP_SKEW_MS` keys go into the returned object (lines 50-78) using `toNum`/`get` exactly as the existing `DB_POLL_INTERVAL_MS: toNum('DB_POLL_INTERVAL_MS', 3000)` entry does. Production-conditional validation (D-09 "mandatory in production") should follow the existing `required(...)` pattern but gated on `NODE_ENV === 'production'`, per RESEARCH.md's Code Examples section (not literally present in current `config.ts`, but directly modeled on the existing `required('AGENT_WS_TOKEN', ...)`/`required('DB_PASSWORD', ...)` calls at lines 41-42).

**`types.ts` `EnvConfig` interface** (lines 77-105) — append new keys in the same flat, non-nested, all-caps style as every existing field:
```typescript
export interface EnvConfig {
  PORT: number;
  ...
  DB_POLL_INTERVAL_MS: number;
  DB_POLL_BATCH_SIZE: number;
  ...
  LOCAL_STORE_PATH: string;
  LOG_LEVEL: string;
}
```

---

### `mirror-request/src/index.ts` (composition root) — MODIFY IN PLACE (one-line change)

**Analog:** itself, full file read this session (73 lines) — `/opt/mirror_request_dslrobooth/mirror-request/src/index.ts`

**Exact insertion point** (line 19, confirming RESEARCH.md's cited pitfall):
```typescript
const app = express();
app.use(express.json());          // <-- add `{ verify: (req, _res, buf) => { (req as any).rawBody = buf; } }` here
```
This must stay a global `app.use(...)` call before `app.use(mirror)` (line 23) — do not reorder, per RESEARCH.md Pattern 1's reasoning (route-scoped `express.raw()` would require moving router registration earlier, a bigger structural change than adding a `verify` callback).

`DBPoller` construction (lines 47-51) is the exact call site to update once the constructor signature changes per the config-drift fix:
```typescript
const poller = new DBPoller(
  config.DB_POLL_INTERVAL_MS,
  config.DB_POLL_BATCH_SIZE,
  store,
);
```

---

### Test files (NEW)

**Analog:** `mirror-request/test/notification-webhook.test.ts` (lines 1-60 read this session) — `/opt/mirror_request_dslrobooth/mirror-request/test/notification-webhook.test.ts`

**Vitest structure + store setup pattern to copy:**
```typescript
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'http';
import { NotificationService } from '../src/notifications/notificationService';
import { getStore } from '../src/state/localStore';

describe('NotificationService webhook delivery', () => {
  let server: http.Server | undefined;
  ...
  it('posts guest photo payload to the configured webhook', async () => {
    const store = getStore();
    store.upsertRegistration({
      id: 'job-webhook-001', name: 'Alice', email: 'alice@example.com',
      phone: '0900000000', mode: 'print', registered_at: new Date().toISOString(),
    });
    store.enqueueJob({ id: 'job-webhook-001', queued_at: Date.now() });
    ...
```
This existing test hand-rolls `http.createServer` for HTTP assertions — RESEARCH.md recommends `supertest` (new devDependency) for `on-register-auth.test.ts`/`on-register-dedup.test.ts` instead, since they need to drive the actual Express `app`/router, not an external HTTP callback target. The `getStore()` + `store.upsertRegistration(...)`/`store.enqueueJob(...)` setup idiom above should still be reused verbatim in the new dedup/persistence tests for seeding fixture data.

## Shared Patterns

### Logging (mask + label)
**Source:** `mirror-request/src/logging/logger.ts` (full file read, 67 lines)
**Apply to:** `webhookAuth.ts`, `mirrorReceiver.ts`, `dbPoller.ts` — every new log line
```typescript
export function mask(value: string): string {
  return value
    .replace(PHONE_RE, m => '*'.repeat(m.length))
    .replace(EMAIL_RE, '[EMAIL REDACTED]');
}
...
export const logger = winston.createLogger({ ... });
export function labelLogger(name: string) {
  return logger.child({ label: name });
}
export default logger;
```
Masking runs automatically on any string `message` argument via the Winston `printf` formatter (`formatFile`/`formatConsole`, lines 16-46) — **new log calls must pass a plain string** (e.g. `logger.warn('Blocked /on-register: bad signature')`), never string-interpolate the raw payload object, and never call `logger.info(rawPayloadString)` outside a `process.env.NODE_ENV !== 'production'` + explicit `DEBUG` gate (D-16), mirroring the existing console-transport gate at lines 58-60:
```typescript
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({ format: formatConsole }));
}
```

### Config loading (typed env + fail-fast)
**Source:** `mirror-request/src/config.ts` + `mirror-request/src/types.ts`
**Apply to:** all new config keys (`REGISTRATION_DEDUP_WINDOW_MS`, `WEBHOOK_HMAC_SECRET`, `WEBHOOK_TIMESTAMP_SKEW_MS`) and `DBPoller`'s DB_* field consumption
- Every config value flows through `loadConfig()` → cached singleton `getConfig()` (lines 81-87 of `config.ts`); never read `process.env` directly outside `config.ts` (this is precisely the anti-pattern RESEARCH.md's Pitfall 4 flags in `dbPoller.ts` today, and the phase must not introduce a second instance of it in new code).

### SQLite persistence (prepared statements only, WAL mode)
**Source:** `mirror-request/src/state/localStore.ts`
**Apply to:** all new durable state — `webhook_replay` table, dedup-window queries, `received_at` column
- Single `Database` instance in WAL mode (`this.db.pragma('journal_mode = WAL')`, line 17), all reads/writes through `this.db.prepare(...).get()/.run()`, never `this.db.exec()` with interpolated values. No new tables or in-memory `Map`/`Set` state — everything durable goes through this one class, consistent with the "all central state lives in LocalStore" convention cited in both CONTEXT.md and RESEARCH.md.

## No Analog Found

None — every file in this phase's scope is either an existing file being hardened in place, or a new file sitting directly beside/inside an existing file that already demonstrates the same role+data-flow pattern (webhook middleware next to the existing IP-allow-list closure; new store methods next to existing prepared-statement methods; new tests next to the existing Vitest HTTP-level test).

## Metadata

**Analog search scope:** `mirror-request/src/**`, `mirror-request/test/**` (no `Glob`/`Grep` needed beyond directory listing — RESEARCH.md and CONTEXT.md already named the exact files to read; confirmed via `ls mirror-request/test/`)
**Files scanned:** 8 source files read in full (`mirrorReceiver.ts`, `dbPoller.ts`, `localStore.ts`, `config.ts`, `index.ts`, `logging/logger.ts`, `types.ts`) + 1 test file read partially (`notification-webhook.test.ts`, first 60 lines) + directory listing of `mirror-request/test/`
**Pattern extraction date:** 2026-08-10
