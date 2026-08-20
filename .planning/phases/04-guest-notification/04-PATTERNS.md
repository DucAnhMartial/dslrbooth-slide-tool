# Phase 4: Guest Notification - Pattern Map

**Mapped:** 2026-08-10
**Files analyzed:** 10 (4 modified source, 5 new test, 1 modified test)
**Analogs found:** 10 / 10

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `mirror-request/src/notifications/notificationService.ts` (rewrite: enqueue + sweeper) | service | event-driven / persisted-queue | `mirror-request/src/queue/queueService.ts` (`recover()`, `handleStall()`, `tick()`, `busyTimer`) | exact (same restart-safety shape, one layer up) |
| `mirror-request/src/state/localStore.ts` (extend: `notification_record` columns + methods) | model | CRUD / migration | itself — `migrate()` (lines 76-86), `requeueWithRetry`/`requeueNoRetry`/`failJob` (197-233), `saveNotification`/`getNotification` (322-340) | exact (same file, established idiom) |
| `mirror-request/src/config.ts` (add `NOTIFY_FETCH_TIMEOUT_MS`, `NOTIFY_SWEEP_INTERVAL_MS`) | config | transform | itself — `toNum('KEY', default)` idiom (lines 10-19, 94-99) | exact |
| `mirror-request/src/index.ts` (add `notifier.start()`) | config/bootstrap | event-driven | itself — `poller.start()`/`queue.recover()`/`queue.start()` sequence (65-76) and `shutdown()` (78-86) | exact |
| `test/notification-sweeper-restart.test.ts` (new) | test | integration | `test/local-store-persistence.test.ts` (real temp-path `LocalStore`, simulated restart via a second `new LocalStore(dbPath)`) | exact |
| `test/notification-sweeper-claim.test.ts` (new) | test | unit / fake-timer | `test/queue-timeout-retry.test.ts` (mocked-store harness + `vi.useFakeTimers()`/`vi.advanceTimersByTime()`) | exact |
| `test/notification-fetch-timeout.test.ts` (new) | test | unit | `test/notification-service.test.ts` (`vi.stubGlobal('fetch', ...)` harness) + `test/agent-heartbeat-timeout.test.ts` (timeout-under-fake-timers shape) | exact |
| `test/notification-retry-count.test.ts` (new) | test | unit | `test/notification-service.test.ts` (mocked store + `vi.stubGlobal('fetch', ...)`) | exact |
| `test/notification-service.test.ts` (rewrite: enqueue-only assertions) | test | unit | itself (current version, to be restructured around `enqueueNotification` instead of `fetch`) | exact |
| `test/notification-webhook.test.ts` (fix `getStore()` coupling, D-14) | test | integration (real HTTP) | `test/local-store-persistence.test.ts` (temp-path `LocalStore`, no singleton) for the store; itself for the ephemeral-`http.Server` shape | exact |
| `test/local-store-persistence.test.ts` (extend: migration-backfill case) | test | integration | itself — existing temp-path-`LocalStore` reopen pattern | exact |

## Pattern Assignments

### `mirror-request/src/notifications/notificationService.ts` (service, event-driven persisted-queue)

**Analog:** `mirror-request/src/queue/queueService.ts` (restart-safety shape) + itself (current 86-line version, to be preserved in parts)

**Current imports** (lines 1-6):
```typescript
import { getStore, type LocalStore } from '../state/localStore';
import { getConfig } from '../config';
import logger from '../logging/logger';
import type { NotificationRecord } from '../types';

const config = getConfig();
```
Keep this import block as-is; the rewrite changes method bodies, not the constructor's `(maxRetries, storeOrWebhook, webhookUrl)` shape (lines 13-21) — that seam is already the typed-injection pattern other phases use, and `sendPhotoLink()`'s signature must stay identical because `queueService.ts:225`'s call site depends on it.

**Restart-safe timer/state split — copy from `QueueService`** (`queueService.ts:14, 60, 66, 94-125`):
```typescript
private busyTimer: NodeJS.Timeout | null = null;
...
this.timer = setInterval(() => this.tick(), 250);
...
if (this.busyTimer) clearTimeout(this.busyTimer);
```
and the `recover()` doc-comment shape — a method that queries durable state and reconciles it, called once at boot before `.start()`:
```typescript
recover(): void {
  const { state, updated_at } = this.store.getBoothStateDetailed();
  const inFlight = this.store.getInFlightJobs();
  ...
}
```
For notifications, no separate `recover()` is needed per RESEARCH.md — the sweeper's own `WHERE dueAt <= now` query on every tick already re-discovers overdue rows after a restart. This is the one place the notification sweeper's design **diverges** from `QueueService`: `QueueService.recover()` is a one-shot boot pass; `NotificationService.sweep()` is the recurring pass that also serves as recovery, so there is one fewer method to add, not one more.

**Bounded-retry / terminal-state pattern — copy from `handleStall()`** (`queueService.ts:127-141`):
```typescript
private handleStall(jobId: string, reason: string): void {
  const { retries } = this.store.requeueWithRetry(jobId);
  if (retries > this.sessionMaxRetries) {
    this.store.failJob(jobId, reason);
    queueLogger.warn(`Job ${jobId} failed after ${retries} attempts: ${reason}`);
  } else {
    queueLogger.warn(`Job ${jobId} requeued (attempt ${retries + 1}/${this.sessionMaxRetries + 1}): ${reason}`);
  }
}
```
Map directly onto `attemptDelivery()`'s exhausted-vs-retry branch (D-08/D-09): on exhaustion, `saveNotification({status:'failed', lastError})` + one `logger.error` line, matching this `warn`-on-exceed / `warn`-on-requeue split in shape (terminal write, then one log line — never a throw).

**Fetch timeout (D-07) and exponential backoff — reuse from current file** (`notificationService.ts:58-62, 75`):
```typescript
const response = await fetch(this.webhookUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});
if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}`);
...
await new Promise(resolve => setTimeout(resolve, config.NOTIFY_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)));
```
The backoff formula (`baseDelayMs * 2 ** (attempt - 1)`) is reused unchanged, now computing `dueAt` instead of driving a `setTimeout` sleep. Add `signal: AbortSignal.timeout(this.fetchTimeoutMs)` to the fetch options object — no other options change.

**Error handling / warn-and-continue (D-10) — copy from `notificationService.ts:69-77`:**
```typescript
} catch (err) {
  record.status = 'failed';
  record.errorMessage = err instanceof Error ? err.message : String(err);
  ...
  this.store.saveNotification(record);
  ...
}
```
Preserve this try/catch-per-attempt shape inside `attemptDelivery()`; per-row failures must never throw out of `sweep()`'s `for` loop (mirrors `QueueService.tick()`'s per-job isolation).

---

### `mirror-request/src/state/localStore.ts` (model, CRUD/migration)

**Analog:** itself — `migrate()`, `requeueWithRetry`/`requeueNoRetry`/`failJob`, `saveNotification`/`getNotification`

**Additive migration pattern** (lines 76-86):
```typescript
migrate(): void {
  // Additive-only migrations. This database file carries live operational
  // data that D-14 says only the operator may delete, so migrations here
  // must never drop or recreate a table — only add columns and backfill.
  const columns = this.db.prepare('PRAGMA table_info(registration)').all() as Array<{ name: string }>;
  const hasReceivedAt = columns.some((c) => c.name === 'received_at');
  if (!hasReceivedAt) {
    this.db.exec('ALTER TABLE registration ADD COLUMN received_at INTEGER');
    this.db.prepare('UPDATE registration SET received_at = ? WHERE received_at IS NULL').run(Date.now());
  }
}
```
Copy this exact shape twice for `notification_record`: once for `photoUrl TEXT`, once for `dueAt INTEGER`, each behind its own `PRAGMA table_info(notification_record)` check — then the honest-failure backfill (D-13, Pitfall 3 in RESEARCH.md) for rows where `photoUrl IS NULL` after the columns exist. Must run idempotently on every `LocalStore` construction (constructor calls `this.bootstrap(); this.migrate();` at lines 18-19) — verified by reopening a temp-path DB twice, exactly as `test/local-store-persistence.test.ts` already does for `received_at`.

**Structural never-twice claim UPDATE — copy from `requeueWithRetry`/`requeueNoRetry`** (lines 203-227):
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

// A deliberate sibling of requeueWithRetry() above, not a variant of it. ...
requeueNoRetry(jobId: string): void {
  this.db.prepare("UPDATE queue_job SET status = 'queued' WHERE id = ?").run(jobId);
}
```
This is the exact precedent for `claimNotification(jobId)`: the guarantee (D-05) must live in the `WHERE status IN ('pending','retrying')` predicate of a plain synchronous `UPDATE`, the same way `requeueWithRetry`'s guarantee (D-06, place-in-line) lives in what's *absent* from its SET clause, not in an `if` at the call site. Add the doc-comment convention this file already uses (see `requeueNoRetry`'s comment) to explain *why* the predicate — not an app-level flag — is the actual guard, so a future edit can't accidentally weaken it.

**Upsert idiom — copy from `saveNotification`** (lines 322-333):
```typescript
saveNotification(n: Partial<NotificationRecord> & { jobId: string }): void {
  this.db.prepare(`
    INSERT INTO notification_record (jobId, status, attempts, lastError, updatedAt)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(jobId) DO UPDATE SET
      status = excluded.status,
      attempts = excluded.attempts,
      lastError = excluded.lastError,
      updatedAt = excluded.updatedAt
  `).run(n.jobId, n.status ?? 'pending', n.attempts ?? 0, n.errorMessage ?? n.lastError ?? null, new Date().toISOString());
}
```
Extend the INSERT/SET column lists to include `photoUrl` and `dueAt`; keep the `INSERT ... ON CONFLICT(jobId) DO UPDATE` upsert shape for `enqueueNotification()` too (RESEARCH.md Pattern 2's example already follows this exactly).

**Read pattern** — `getNotification()` (335-340) hardcodes `channel`/`recipient`; no change required there (RESEARCH.md confirms these fields are unread elsewhere) — just add `photoUrl`/`dueAt` to the returned shape if `getDueNotifications()`/tests need them off this method too, otherwise leave as a separate query (`getDueNotifications`).

**Guest lookup — reused unchanged**, `getJobRegistration()` (309-320): no modification needed, already the exact join `sendPhotoLink()`'s enqueue path needs.

---

### `mirror-request/src/config.ts` (config, transform)

**Analog:** itself, `toNum('KEY', default)` idiom

**Pattern** (lines 10-19, applied at 94-99):
```typescript
const toNum = (key: string, fallback: number): number => {
  const val = get(key);
  if (val === undefined) return fallback;
  const n = Number.parseInt(val, 10);
  if (Number.isNaN(n)) {
    errors.push(`${key} must be a number, got "${val}"`);
    return fallback;
  }
  return n;
};
...
NOTIFY_MAX_RETRIES:       toNum('NOTIFY_MAX_RETRIES',       3),
NOTIFY_RETRY_BASE_DELAY_MS: toNum('NOTIFY_RETRY_BASE_DELAY_MS', 1000),
```
Add two new entries directly beside these, same block, same idiom:
```typescript
NOTIFY_FETCH_TIMEOUT_MS: toNum('NOTIFY_FETCH_TIMEOUT_MS', 10_000),
NOTIFY_SWEEP_INTERVAL_MS: toNum('NOTIFY_SWEEP_INTERVAL_MS', 3_000),
```
Per D-15, also change `NOTIFY_MAX_RETRIES`'s default from `3` to `2` in this same edit (D-08's semantic flip — see Pitfall 1 in RESEARCH.md — keeps total attempts at 3, matching `SESSION_MAX_RETRIES=2`'s value and meaning). Both new keys must also be added to `EnvConfig` in `src/types.ts` (grep for `NOTIFY_MAX_RETRIES` there to find the existing type block to extend).

**Injectable timing (for tests) — copy from `AgentServer`'s constructor** (`src/agent/agentServer.ts:25-27`):
```typescript
constructor(opts: { heartbeatIntervalMs?: number; heartbeatTimeoutMs?: number } = {}) {
  this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL;
  this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? this.config.HEARTBEAT_TIMEOUT_MS;
}
```
`NotificationService`'s constructor should accept an optional `{ fetchTimeoutMs?, sweepIntervalMs? }` (or equivalent positional params, consistent with its current `(maxRetries, storeOrWebhook, webhookUrl)` shape) sourced from config by default but overridable — this is what lets `test/notification-fetch-timeout.test.ts` and `test/notification-sweeper-claim.test.ts` drive short/fake timeouts without real waits, exactly as `test/agent-heartbeat-timeout.test.ts` does for `AgentServer`.

---

### `mirror-request/src/index.ts` (bootstrap)

**Analog:** itself — `poller`/`queue`/`agentServer`/`displayServer` lifecycle wiring

**Pattern** (lines 65-76, 78-86):
```typescript
const server = app.listen(config.PORT, config.HOST, () => {
  log.info(`Extension Service ready on ${config.HOST}:${config.PORT}`);
  poller.start();
  try {
    queue.recover();
  } catch (err) {
    log.warn(err instanceof Error ? err.message : String(err));
  }
  queue.start();
  agentServer.start(server);
  displayServer.start(server);
});

function shutdown(code: number): void {
  log.info('Shutting down');
  poller.stop();
  queue.stop();
  agentServer.stop();
  displayServer.stop();
  store.close();
  server.close(() => process.exit(code));
}
```
Add `notifier.start()` immediately after `queue.start()` (no `recover()` call needed for the notifier — see the `recover()` divergence note above) and `notifier.stop()` in `shutdown()` alongside `queue.stop()`. `notifier = createNotificationService()` is already constructed at line 32, before this block — only the `.start()`/`.stop()` calls are new, matching every other subsystem's one-line lifecycle wiring.

## Shared Patterns

### Warn-and-continue at network boundaries (D-10)
**Source:** `mirror-request/src/notifications/notificationService.ts:69-77` (current catch block) and `mirror-request/src/queue/queueService.ts:133-141` (`handleStall`)
**Apply to:** `attemptDelivery()`'s catch block, and `sweep()`'s per-row loop — no `await` failure may propagate out of the loop or crash the sweeper interval.

### Additive-only migration (D-13)
**Source:** `mirror-request/src/state/localStore.ts:76-86` (`migrate()`)
**Apply to:** the `photoUrl`/`dueAt` column additions and the honest-failure backfill. Must remain idempotent across repeated `LocalStore` construction (verified by `test/local-store-persistence.test.ts`'s reopen pattern).

### Structural (SQL-predicate) guarantees over app-level flags (D-05)
**Source:** `mirror-request/src/state/localStore.ts:203-227` (`requeueWithRetry`/`requeueNoRetry`'s omission-as-guarantee convention)
**Apply to:** `claimNotification()`'s `WHERE status IN ('pending','retrying')` predicate — document with the same style of comment `requeueNoRetry` uses, stating explicitly what would break the guarantee if edited.

### Typed config, no direct `process.env` reads (Phases 1-3 convention)
**Source:** `mirror-request/src/config.ts:10-19, 94-104`
**Apply to:** `NOTIFY_FETCH_TIMEOUT_MS`, `NOTIFY_SWEEP_INTERVAL_MS`.

### Injectable timing for fake-timer tests
**Source:** `mirror-request/src/agent/agentServer.ts:25-27` (constructor opts pattern)
**Apply to:** `NotificationService`'s constructor — sweep interval and fetch timeout must be overridable per-instance, not only via global config, or `test/notification-sweeper-claim.test.ts` and `test/notification-fetch-timeout.test.ts` cannot use `vi.useFakeTimers()`/`vi.advanceTimersByTime()` deterministically.

### Fetch mocking convention
**Source:** `mirror-request/test/notification-service.test.ts:15-16` — `vi.stubGlobal('fetch', fetchMock)`
**Apply to:** every new mocked-fetch unit test (`notification-fetch-timeout.test.ts`, `notification-retry-count.test.ts`, `notification-sweeper-claim.test.ts`). Note (per `test/db-poller.test.ts`'s header comment and the Validation caveat): `vi.mock()` only intercepts statically-analyzed `import`s / `createRequire`d CommonJS modules — `fetch` is a Node 20 global, so `vi.stubGlobal('fetch', ...)` (not `vi.mock`) is the correct and only interception point, and must be paired with `vi.unstubAllGlobals()` or equivalent in `afterEach` (the existing file only calls `vi.restoreAllMocks()`, which does **not** clear `vi.stubGlobal` — add `vi.unstubAllGlobals()` explicitly in new test files to avoid cross-test global leakage).

### Real ephemeral HTTP server for payload-shape proof (Validation gate requirement)
**Source:** `mirror-request/test/notification-webhook.test.ts:35-55` — raw `http.createServer`, `req.on('data'/'end')` body capture, `toMatchObject` on `receivedPayload`
**Apply to:** the phase-gate-required real-HTTP test covering a post-restart-resumed delivery (RESEARCH.md's binding validation requirement) — reuse this exact ephemeral-server harness, but replace the `getStore()` call (line 24) with a temp-path `LocalStore` per D-14, and replace the hardcoded `'job-webhook-001'` id with a per-test-generated id (e.g. `job-webhook-${Date.now()}`).

### Real-file `LocalStore` integration harness (no singleton)
**Source:** `mirror-request/test/local-store-persistence.test.ts` (referenced in RESEARCH.md's Code Examples section — temp-path constructor, reopen to prove migration idempotency: `fs.mkdtempSync(path.join(os.tmpdir(), '<prefix>-')); new LocalStore(dbPath); ...; new LocalStore(dbPath)` again to simulate restart)
**Apply to:** `notification-sweeper-restart.test.ts` and the migration-backfill case added to `local-store-persistence.test.ts` itself. This is the required alternative to `getStore()` for every new Phase 4 test (binding per 04-VALIDATION.md: "No new test may call `getStore()`").

## No Analog Found

None. Every file in scope has a strong same-codebase analog — this phase is explicitly a hardening pass, not greenfield (per 04-CONTEXT.md), and RESEARCH.md independently confirms every needed mechanism already has a sibling in this codebase.

## Metadata

**Analog search scope:** `mirror-request/src/{notifications,state,queue,agent,config.ts,index.ts}`, `mirror-request/test/*.test.ts`
**Files read this session:** `notificationService.ts` (full), `localStore.ts` (bootstrap/migrate/getJobRegistration/saveNotification/getNotification/requeueWithRetry/requeueNoRetry/failJob/getInFlightJobs), `queueService.ts` (recover/handleStall/tick wiring), `config.ts` (full), `index.ts` (full), `agentServer.ts` (constructor grep), `notification-service.test.ts` (full), `notification-webhook.test.ts` (full), `queue-timeout-retry.test.ts` (header), `db-poller.test.ts` (header, fetch/require-mocking caveat)
**Pattern extraction date:** 2026-08-10
```
