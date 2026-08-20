# Phase 2: Queue & Booth State - Pattern Map

**Mapped:** 2026-08-10
**Files analyzed:** 9 (5 modified source files, 5 new test files — see below)
**Analogs found:** 9 / 9 (this phase is a hardening pass; in most cases the analog is the file itself, at a prior commit shape, plus one Phase 1 precedent)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|--------------------|------|-----------|-----------------|----------------|
| `mirror-request/src/queue/queueService.ts` (modify) | service (state machine) | event-driven | itself (existing 195-line file) + `mirror-request/src/notifications/notificationService.ts` for config injection | exact (self) / role-match (config) |
| `mirror-request/src/state/localStore.ts` (modify — add 3 methods) | model / data-access | CRUD | `findDuplicateRegistration()` in the same file (most recent added query method) | exact |
| `mirror-request/src/config.ts` + `mirror-request/src/types.ts` (modify) | config | transform | existing `SESSION_TIMEOUT_MS`/`toNum()` entries in the same files | exact |
| `mirror-request/src/index.ts` (modify — call `recover()`) | composition root | request-response / startup | existing `poller.start()`/`queue.start()` wiring block in the same file | exact |
| `mirror-request/test/queue-recovery.test.ts` (new) | test | event-driven + integration | `mirror-request/test/queue-countdown.test.ts` (mocked-store unit half) + `mirror-request/test/db-poller.test.ts` (real-`LocalStore` temp-dir integration half) | role-match |
| `mirror-request/test/queue-timeout-retry.test.ts` (new) | test | event-driven | `mirror-request/test/queue-countdown.test.ts` | exact |
| `mirror-request/test/queue-fifo-retry.test.ts` (new) | test | CRUD | `mirror-request/test/queue-countdown.test.ts` (mock style) | role-match |
| `mirror-request/test/queue-idempotency.test.ts` (new) | test | CRUD / integration | `mirror-request/test/db-poller.test.ts` (real-`LocalStore` temp-dir style) | exact |
| `mirror-request/test/queue-config-injection.test.ts` (new) | test | request-response | `mirror-request/test/db-poller.test.ts` (typed-config injection assertions) | exact |

## Pattern Assignments

### `mirror-request/src/queue/queueService.ts` (service, event-driven — MODIFY, not rewrite)

**Analog:** the file itself (audit, don't rewrite) + `mirror-request/src/notifications/notificationService.ts` for the config-injection shape (D-13) + `mirror-request/src/state/localStore.ts:232-235` (`setBoothTimeout`) for the real-logger call shape.

**Current constructor (lines 25-27) — extend, don't replace:**
```typescript
constructor(store: LocalStore = getStore()) {
  this.store = store;
}
```

**Target shape, copied from `NotificationService`'s config-injection pattern (`notificationService.ts:13-21`):**
```typescript
constructor(
  maxRetries = config.NOTIFY_MAX_RETRIES,
  storeOrWebhook: LocalStore | string = getStore(),
  webhookUrl = config.NOTIFY_WEBHOOK_URL,
) {
  this.maxRetries = maxRetries;
  this.store = typeof storeOrWebhook === 'string' ? getStore() : storeOrWebhook;
  this.webhookUrl = typeof storeOrWebhook === 'string' ? storeOrWebhook : webhookUrl;
}
```
RESEARCH.md Pattern 4 already gives the exact target for `queueService.ts`:
```typescript
constructor(
  store: LocalStore = getStore(),
  config: Pick<EnvConfig, 'SESSION_TIMEOUT_MS' | 'NEXT_GUEST_COUNTDOWN_MS' | 'SESSION_MAX_RETRIES'> = getConfig(),
) {
  this.store = store;
  this.sessionTimeoutMs = config.SESSION_TIMEOUT_MS;
  this.countdownMs = config.NEXT_GUEST_COUNTDOWN_MS;
  this.sessionMaxRetries = config.SESSION_MAX_RETRIES;
}
```
Delete the two direct `process.env` reads this replaces:
- `beginAnnouncement()` line 103: `const configuredMs = parseInt(process.env.NEXT_GUEST_COUNTDOWN_MS || '7000', 10);`
- `startBusyTimer()` line 136: `const timeoutMs = parseInt(process.env.SESSION_TIMEOUT_MS || '300000', 10);`

**Do NOT copy `DBPoller`'s config pattern** (`dbPoller.ts:21-32`, explicit positional params threaded through `index.ts`'s constructor call at `index.ts:52-63`). RESEARCH.md Pattern 4 explains why: `QueueService` already has an injectable-default constructor shape (unlike `DBPoller`, which never did), so extending the existing default-parameter style is the smaller, more consistent diff.

**Core event-driven pattern (existing, keep as scaffold) — `tick()`/`beginAnnouncement()`/`dispatchJob()` (lines 93-132):**
```typescript
private tick(): void {
  const booth = this.store.getBoothState();
  if (booth !== 'IDLE') return;
  if (this.announcingJobId) return;
  const job = this.store.getNextQueuedJob();
  if (!job) return;
  this.beginAnnouncement(job);
}
```
New `recover()` method (RESEARCH.md Pattern 1, reproduced verbatim as the target implementation) must run once, before the first `tick()` — see `index.ts` integration point below.

**Retry orchestration — new `handleStall()` private method (RESEARCH.md Pattern 3):**
```typescript
private handleStall(job: { id: string }, reason: string): void {
  const { retries } = this.store.requeueWithRetry(job.id);
  if (retries > this.sessionMaxRetries) {
    this.store.failJob(job.id, reason);
    logger.warn(`Job ${job.id} failed after ${retries} attempts: ${reason}`);
  } else {
    logger.warn(`Job ${job.id} requeued (attempt ${retries + 1}/${this.sessionMaxRetries + 1}): ${reason}`);
  }
}
```
This replaces the body of `startBusyTimer()`'s timeout callback (currently lines 137-141, which calls `store.setBoothTimeout(...)` + `store.updateJobStatus(jobId, 'queued', 'acknowledged_at', Date.now())` — the semantically-wrong-timestamp bug, RESEARCH.md Pitfall 4) and is also the call both the live `busyTimer` path and the new `recover()` path share, so the retry policy is defined exactly once.

**Logger fix (required, not cosmetic — see Pitfall 5 below).**

---

### `mirror-request/src/state/localStore.ts` (model, CRUD — ADD 3 methods, no schema change)

**Analog:** `findDuplicateRegistration()` in the same file (lines 112-127) — the most recent example of adding a multi-branch query method to this class, and `completeInProgressJob()` (lines 170-179) as the closest existing "find + update the current job" shape (though its `WHERE status = 'in_progress'` filter is exactly what the new methods must NOT copy — see Pitfall 2 below).

**Prepared-statement style to copy (`getJob`, line 150-152 — the class's simplest read pattern):**
```typescript
getJob(id: string): QueueJob | undefined {
  return this.db.prepare('SELECT * FROM queue_job WHERE id = ?').get(id) as QueueJob | undefined;
}
```

**New method 1 — `getInFlightJobs()` (RESEARCH.md Pattern 2, exact code to add):**
```typescript
getInFlightJobs(): QueueJob[] {
  return this.db.prepare(
    "SELECT * FROM queue_job WHERE status IN ('dispatched','in_progress') ORDER BY dispatched_at DESC"
  ).all() as QueueJob[];
}
```
Place near `completeInProgressJob()` (after line 179) since both concern "the current in-flight job(s)".

**New method 2 — `requeueWithRetry()` (RESEARCH.md Pattern 3, exact code to add):**
```typescript
requeueWithRetry(jobId: string): { retries: number } {
  this.db.prepare(
    "UPDATE queue_job SET status = 'queued', retries = retries + 1 WHERE id = ?"
  ).run(jobId);
  const row = this.db.prepare('SELECT retries FROM queue_job WHERE id = ?').get(jobId) as { retries: number };
  return row;
}
```
Critical: `queued_at` is deliberately absent from the `SET` list — this IS D-06's guarantee, made explicit by omission rather than left implicit as it is in today's `updateJobStatus()`.

**New method 3 — `failJob()` (RESEARCH.md Pattern 3, exact code to add):**
```typescript
failJob(jobId: string, stallReason: string): void {
  this.db.prepare(
    "UPDATE queue_job SET status = 'failed', stall_reason = ? WHERE id = ?"
  ).run(stallReason, jobId);
}
```

**Why not extend `updateJobStatus()` (lines 136-144) instead:** its signature `(id, status, tsField, tsValue)` and internal `map` of allowed timestamp fields structurally cannot write `retries` (a counter increment, not a timestamp overwrite) or `stall_reason` (not in the map at all). Do not add `retries`/`stall_reason` as new `tsField` map entries — `tsValue: number` is the wrong type for `stall_reason: string`, and `retries` needs `retries + 1`, not an overwrite.

---

### `mirror-request/src/index.ts` (composition root — MODIFY, add one call)

**Analog:** the existing `poller.start(); queue.start();` sequencing block, lines 65-71:
```typescript
const server = app.listen(config.PORT, config.HOST, () => {
  log.info(`Extension Service ready on ${config.HOST}:${config.PORT}`);
  poller.start();
  queue.start();
  agentServer.start(server);
  displayServer.start(server);
});
```
**Target — insert `queue.recover()` (or chosen method name) immediately before `queue.start()`:**
```typescript
  poller.start();
  queue.recover();   // NEW — D-01..D-04 startup reconciliation, must run before the first tick
  queue.start();
```
No other change to `index.ts`'s wiring is needed — `createQueueService()` (line 33) already constructs `QueueService` with its default-injected `store`/`config`, so `recover()` needs no new parameters threaded through here.

---

### `mirror-request/src/config.ts` + `mirror-request/src/types.ts` (config — MODIFY, add 2 keys)

**Analog:** the existing `SESSION_TIMEOUT_MS` entry, present in both files already (`config.ts:94`, `types.ts:98`).

**`config.ts` — copy the `toNum(key, fallback)` pattern used for every other numeric key (line 94 for the sibling key, D-13's own text names this target):**
```typescript
NEXT_GUEST_COUNTDOWN_MS: toNum('NEXT_GUEST_COUNTDOWN_MS', 7000),
SESSION_MAX_RETRIES:     toNum('SESSION_MAX_RETRIES', 2),   // D-05 default: 2 retries = 3 attempts total
```
Insert immediately after `SESSION_TIMEOUT_MS: toNum('SESSION_TIMEOUT_MS', 300_000),` at `config.ts:94` to keep all session/queue timing keys grouped, matching the file's existing grouping-by-subsystem convention (SMTP keys together, Twilio keys together, etc.).

**`types.ts` `EnvConfig` interface — add two fields next to `SESSION_TIMEOUT_MS` (line 98):**
```typescript
NEXT_GUEST_COUNTDOWN_MS: number;
SESSION_MAX_RETRIES: number;
```

**`types.ts` `BoothState`/`QueueJob` — do NOT change.** `BoothState` already includes a dead `'TIMEOUT_RESET'` value never written anywhere (Pitfall 6 below) — leave it as dead code, do not wire it up as part of this phase. `QueueJob.status: string` stays a bare string (RESEARCH.md Assumption A4) — do not narrow to a union; that touches every existing `.status` comparison across the codebase, out of this phase's scope. Document the new `'failed'` status value with a comment instead.

---

## Shared Patterns

### Config injection (D-13)
**Source:** `mirror-request/src/notifications/notificationService.ts:8-21` (constructor shape) + `mirror-request/src/config.ts:94` + `mirror-request/src/types.ts:98` (the `toNum`/`EnvConfig` pattern all typed config reads follow)
**Apply to:** `queueService.ts`'s constructor only (the sole remaining file with direct `process.env` reads in the queue/booth domain).
```typescript
// notificationService.ts:13-21 — the shape to imitate
constructor(
  maxRetries = config.NOTIFY_MAX_RETRIES,
  storeOrWebhook: LocalStore | string = getStore(),
  webhookUrl = config.NOTIFY_WEBHOOK_URL,
) { ... }
```

### Logging (Pitfall 5 — required fix, not cosmetic)
**Source:** `mirror-request/src/logging/logger.ts:62-64` (`labelLogger`) + `mirror-request/src/index.ts:17` (`const log = labelLogger('server');`) + `mirror-request/src/state/localStore.ts:232-235` (`setBoothTimeout()`, which already calls the real `logger.warn`)
**Apply to:** `queueService.ts` — replace the local `console`-wrapping logger (lines 173-176) entirely.

Current bad pattern in `queueService.ts:173-176`:
```typescript
const logger = {
  debug: (...args: unknown[]) => console.debug('[queue]', ...args),
  info:  (...args: unknown[]) => console.info('[queue]', ...args),
};
```
This has no `warn` method at all — D-05/D-07's exhausted-retry and stall warnings, plus M2 success criterion 5, have nowhere to go without this fix. It also bypasses the masked Winston pipeline entirely (never reaches `logs/extension-service-%DATE%.log`, never runs through `mask()`).

Target — copy `index.ts:17`'s pattern:
```typescript
import { labelLogger } from '../logging/logger';
const logger = labelLogger('queue');
```
`localStore.ts:232-235` confirms the call shape once the real logger is wired in:
```typescript
setBoothTimeout(reason: string): void {
  this.db.prepare("INSERT OR REPLACE INTO booth_state (id, state, updated_at) VALUES (1, 'IDLE', ?)").run(new Date().toISOString());
  logger.warn(`Booth timeout reset: ${reason}`);
}
```
`stall_reason` values must be fixed, server-authored strings (e.g. `'restart_recovery_timeout'`, `'session_ack_timeout'`), never guest-supplied text — matches `localStore.ts`'s own `logger` import (`import logger from '../logging/logger';`, line 5) if a module-level default import is preferred over `labelLogger`.

### Prepared-statement, no-injection query methods
**Source:** `mirror-request/src/state/localStore.ts:150-152` (`getJob`), `:112-127` (`findDuplicateRegistration`)
**Apply to:** all 3 new `LocalStore` methods (`getInFlightJobs`, `requeueWithRetry`, `failJob`). Every method uses `this.db.prepare(...)` with `?` placeholders — never string interpolation of caller-supplied values (matches the Security Domain table's stated mitigation).

### Startup-recovery hook placement
**Source:** `mirror-request/src/index.ts:65-71` (existing `poller.start()`/`queue.start()` sequencing) — no prior "recovery" precedent exists in the codebase; this is genuinely new behavior. The nearest structural analog for "runs once at construction/startup before normal operation begins" is `LocalStore.migrate()` (`localStore.ts:76-86`, called once from the constructor at line 19, additive-only, no destructive rewrite of state).
**Apply to:** the single new call site in `index.ts`, placed between `poller.start()` and `queue.start()`.

## Test File Patterns

### `test/queue-recovery.test.ts` — mixed unit + integration
**Unit half analog:** `mirror-request/test/queue-countdown.test.ts:1-54` — full hand-built `LocalStore` mock (`as unknown as LocalStore`), `vi.useFakeTimers()`, `vi.setSystemTime()` for age calculations (RESEARCH.md's own Code Examples section gives the exact extension shape at lines 458-480 of 02-RESEARCH.md).
```typescript
// Pattern to copy from queue-countdown.test.ts:9-32
vi.useFakeTimers();
const store = {
  getBoothStateDetailed: () => ({ state: 'BUSY', updated_at: '2026-08-10T04:29:42.732Z' }),
  getInFlightJobs: () => [{ id: 'registration-20260806-04431', retries: 0 }],
  setBoothIdle: vi.fn(),
  requeueWithRetry: vi.fn().mockReturnValue({ retries: 1 }),
  failJob: vi.fn(),
} as unknown as LocalStore;
```
**Integration half analog:** `mirror-request/test/db-poller.test.ts:36-39` — real `LocalStore` via `constructor(dbPath?)` seam with a fresh `fs.mkdtempSync` temp dir, to seed rows reproducing the live 4-row scenario and assert `getInFlightJobs()`'s real SQL.
```typescript
// Pattern to copy from db-poller.test.ts:36-39,51-55
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-queue-recovery-'));
  dbPath = path.join(dir, 'test.sqlite');
  store = new LocalStore(dbPath);
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
```
**Constraint (from RESEARCH.md Pitfall 7 / 02-VALIDATION.md):** do NOT use `getStore()` singleton anywhere in this file — `booth_state` is a single global row (`CHECK (id = 1)`), shared across parallel vitest workers if the singleton is used.

### `test/queue-timeout-retry.test.ts`
**Analog:** `mirror-request/test/queue-countdown.test.ts` (full mocked-store style), extended with `vi.advanceTimersByTime()` past `SESSION_TIMEOUT_MS` to trigger `startBusyTimer()`'s timeout callback and assert `handleStall()`'s requeue/fail branching.

### `test/queue-fifo-retry.test.ts`
**Analog:** `mirror-request/test/queue-countdown.test.ts` mock style — assert `requeueWithRetry()` is called and that a mocked `getNextQueuedJob()` still returns the requeued job first (D-06's `queued_at`-preservation guarantee), covering QUE-01.

### `test/queue-idempotency.test.ts`
**Analog:** `mirror-request/test/db-poller.test.ts`'s real-`LocalStore`-via-temp-path style — seed one registration, drive it through the requeue path (D-05), and assert `SELECT COUNT(*) FROM queue_job WHERE registration_id = ?` stays 1 (D-12).

### `test/queue-config-injection.test.ts`
**Analog:** `mirror-request/test/db-poller.test.ts`'s typed-config-injection assertions (construct with an explicit config object, assert behavior matches injected values, not `process.env`) — same technique `db-poller.test.ts` uses to prove `DBPoller` reads `dbConfig`, not env, applied to `QueueService`'s new `Pick<EnvConfig, ...>` constructor param.

## No Analog Found

None — every file in this phase's scope has at least a role-match analog, either within the same file (self-audit) or a Phase 1 precedent. This reflects the phase's nature as a hardening pass over working code rather than greenfield work.

## Metadata

**Analog search scope:** `mirror-request/src/` (queue, state, config, types, index, notifications, ingestion, logging), `mirror-request/test/`
**Files scanned:** `queueService.ts`, `localStore.ts`, `config.ts`, `types.ts`, `index.ts`, `dbPoller.ts`, `notificationService.ts`, `logger.ts`, `queue-countdown.test.ts`, `db-poller.test.ts`
**Pattern extraction date:** 2026-08-10
