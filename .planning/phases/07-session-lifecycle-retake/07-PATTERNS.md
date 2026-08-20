# Phase 7: Session Lifecycle & Retake - Pattern Map

**Mapped:** 2026-08-12
**Files analyzed:** 6 (3 modified source files, 1 new migration surface inside an existing file, ~5 new/rewritten test files)
**Analogs found:** 6 / 6 — this phase modifies existing files in place; every "new" behavior has an in-file or in-repo sibling precedent, so there are no true "no analog" files.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|--------------------|------|-----------|-----------------|----------------|
| `mirror-request/src/queue/queueService.ts` (`onAgentEvent`, new `completeJob`/release-timer logic) | service (event-driven state machine) | event-driven | itself — `sessionAcked()`/`handleStall()`/`onAgentDisconnected()` (same file) | exact (self-analog, extend existing dispatch table) |
| `mirror-request/src/state/localStore.ts` (`completeInProgressJob` → jobId-scoped `completeJob`, new `pending_print` table, `booth_state.current_job_id`) | model / data-access (SQLite) | CRUD | itself — `requeueWithRetry`/`requeueNoRetry` sibling pair, `migrate()`, `bootstrap()` (same file) | exact (self-analog) |
| `mirror-request/src/status/guestStatus.ts` (`KNOWN_JOB_STATUSES` sixth member, `STATUS_MAP` entry) | model / status-translation | transform | itself — the existing `STATUS_MAP` five-entry `Record` (same file) | exact (self-analog) |
| `mirror-request/test/queue-dual-completion.test.ts` (NEW) | test | event-driven / CRUD | `mirror-request/test/queue-countdown.test.ts` ("booth state transitions" describe block) | exact — research names this explicitly as the pattern to extend |
| `mirror-request/test/queue-print-registry-expiry.test.ts` (NEW) | test | event-driven / timer | `mirror-request/test/queue-countdown.test.ts` (`vi.useFakeTimers()` + `vi.advanceTimersByTime()` usage) | exact |
| `mirror-request/test/queue-event-coverage.test.ts` (REWRITE, not new) | test | event-driven | itself (pre-phase version, read in full above) | exact — rewrite `debug` assertions to `info` |
| `mirror-request/test/queue-retake-anchor.test.ts` (NEW) | test | event-driven | `mirror-request/test/queue-event-coverage.test.ts`'s `buildStore()` mock shape | role-match |
| `mirror-request/test/local-store-persistence.test.ts` (EXTEND) | test | migration / CRUD | Phase 4's `notification_record` migration test (see `04-03-SUMMARY.md`, not read this pass — cited by research, verify path before use) | role-match |

## Pattern Assignments

### `mirror-request/src/queue/queueService.ts` — `onAgentEvent()` dispatch table (event-driven)

**Analog:** the file's own existing `onAgentEvent()` method, `queueService.ts:239-249`.

**Current dispatch pattern to extend** (`queueService.ts:239-249`):
```typescript
onAgentEvent(eventType: string, jobId?: string, payload?: Record<string, unknown>): void {
    if (eventType === 'session_end') {
      this.sessionEnded();
    } else if (eventType === 'session_start' && jobId) {
      this.sessionAcked(jobId);
    } else if (eventType === 'file_upload' && jobId && payload) {
      this.onFileUpload(jobId, payload);
    } else {
      queueLogger.debug(`Unhandled Agent event: ${eventType}${jobId ? ` (job ${jobId})` : ''}`);
    }
  }
```
Add `processing_start`/`printing` branches ahead of the `else`, following the exact `else if (eventType === X && jobId && payload)` shape already used for `file_upload`. D-12 requires the final `else` branch (and every branch) to log at `.info()`, not `.debug()` — this is the one line in this pattern that must change, not just extend.

**Sibling-timer discipline to copy for D-02's release timer** (`queueService.ts:307-315`, `startBusyTimer`, and the field declarations at `:13-14`):
```typescript
private busyTimer: NodeJS.Timeout | null = null;
...
private startBusyTimer(jobId: string, timeoutMs: number = this.sessionTimeoutMs): void {
    this.clearBusyTimer();
    this.busyTimer = setTimeout(() => {
      this.busyTimer = null;
      this.store.setBoothTimeout('session_ack timeout');
      this.handleStall(jobId, 'session_ack_timeout');
      this.tick();
    }, timeoutMs);
  }
```
D-02's new release-fallback timer (e.g. `releaseTimer`) must be a **separate field and separate method** with the identical shape (`clear...()` then `set...(fn, timeoutMs)`), but its callback must call only `store.setBoothIdle()` + clear `current_job_id` + `tick()` — **never** `this.handleStall(...)`. This mirrors the project's documented discipline at `localStore.ts:248-261` (`requeueWithRetry` vs `requeueNoRetry`, "a deliberate sibling ... not a variant of it") applied to timers instead of SQL writers — copy that same comment style onto the new timer method to record why it must never be collapsed with `busyTimer`.

**Terminal-state guard pattern to copy for `sessionAcked()`'s new guard** (no direct precedent for a guard *inside* `sessionAcked()` itself, but `onFileUpload()`'s guard at `queueService.ts:342-346` is the closest same-file shape — validate-then-early-return before mutating state):
```typescript
private onFileUpload(jobId: string, payload: Record<string, unknown>): void {
    const kind = typeof payload.param3 === 'string' ? payload.param3 : undefined;
    if (kind !== undefined && kind !== 'print') {
      queueLogger.debug(`Ignoring '${kind}' upload for ${jobId}: only the print composite is delivered`);
      return;
    }
    ...
```
Apply the same "check first, log-and-return before mutating" shape to `sessionAcked(jobId)`: check the job's current status via `this.store.getJob(jobId)` before calling `updateJobStatus(..., 'in_progress', ...)`, and return early (with a `warn`, per the human's "make failure visible" preference recorded in CONTEXT.md `<specifics>`) if the job is already terminal (`completed`/`failed`).

**Mismatch-warn throttling analog (D-06's discretion point)** — `agentOfflineDispatchSkipLogged` (`queueService.ts:37-40` declaration, `:257-264` usage):
```typescript
private agentOfflineDispatchSkipLogged = false;
...
if (!this.isAgentOnlineCb()) {
      if (!this.agentOfflineDispatchSkipLogged) {
        queueLogger.warn(`Skipping dispatch: Agent not connected (job ${job.id} stays queued)`);
        this.agentOfflineDispatchSkipLogged = true;
      }
      return;
    }
    this.agentOfflineDispatchSkipLogged = false;
```
This is the project's only existing "log once, not once per event" boolean-flag shape. If D-06's mismatch warn is throttled, copy this exact flag-set/flag-reset pattern (set on first mismatch, reset the moment a matching jobId event is seen), not a time-windowed rate limiter — no such mechanism exists elsewhere in the codebase.

---

### `mirror-request/src/state/localStore.ts` — jobId-scoped completion replacing unscoped `ORDER BY ... LIMIT 1`

**Analog:** the method being replaced, plus its own id-scoped siblings in the same file.

**Method being replaced** (`localStore.ts:220-229`):
```typescript
completeInProgressJob(endedAt: number): string | undefined {
    const job = this.db.prepare(
      "SELECT id FROM queue_job WHERE status = 'in_progress' ORDER BY acknowledged_at DESC LIMIT 1"
    ).get() as { id: string } | undefined;
    if (!job) return undefined;
    this.db.prepare(
      "UPDATE queue_job SET status = 'completed', session_ended_at = ?, completed_at = ? WHERE id = ?"
    ).run(endedAt, endedAt, job.id);
    return job.id;
  }
```

**Id-scoped shape to copy** — `failJob()` (`localStore.ts:263-267`) and `requeueWithRetry()` (`localStore.ts:240-246`), both take `jobId` as a parameter and guard the `WHERE` on it directly, no ordering/inference:
```typescript
failJob(jobId: string, stallReason: string): void {
    this.db.prepare(
      "UPDATE queue_job SET status = 'failed', stall_reason = ? WHERE id = ?"
    ).run(stallReason, jobId);
  }
```
The new `completeJob(jobId, completedAt)` should follow this exact shape: `UPDATE queue_job SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'in_progress'`, and — per research's explicit recommendation — return a boolean/matched-row indicator (`result.changes === 1`) the way `claimNotification()` already does (`localStore.ts:474-481`, `return result.changes === 1;`), so the caller in `queueService.ts` can distinguish "completed the right job" from "already rejected upstream by the D-06 cross-check."

**Additive idempotent migration pattern (D-06's `current_job_id` column, D-08's new table)** — `migrate()` (`localStore.ts:78-120`), the `PRAGMA table_info()` + conditional `ALTER TABLE` shape:
```typescript
const notifColumns = this.db.prepare('PRAGMA table_info(notification_record)').all() as Array<{ name: string }>;
    const hasPhotoUrl = notifColumns.some((c) => c.name === 'photoUrl');
    ...
    if (!hasPhotoUrl) {
      this.db.exec('ALTER TABLE notification_record ADD COLUMN photoUrl TEXT');
      notifColumnAdded = true;
    }
```
D-06's `booth_state.current_job_id` column: `PRAGMA table_info(booth_state)` → `ALTER TABLE booth_state ADD COLUMN current_job_id TEXT` inside `migrate()`, no backfill needed (a NULL default means "no job owns the booth," which is correct for every pre-existing row). D-08's new registry table follows `bootstrap()`'s `CREATE TABLE IF NOT EXISTS` shape instead (`localStore.ts:22-75`, e.g. the `booth_state` or `webhook_replay` table declarations) — it is a brand-new table, not a new column, so it belongs in `bootstrap()`, not `migrate()`.

**Durable-registry-before-network-call precedent (D-07/D-08)** — `notification_record`'s claim-lease shape, `claimNotification()` (`localStore.ts:474-481`):
```typescript
claimNotification(jobId: string, now: number, leaseUntil: number): boolean {
    const result = this.db.prepare(`
      UPDATE notification_record
      SET status = 'sending', dueAt = ?, updatedAt = ?
      WHERE jobId = ? AND status IN ('pending','retrying','sending') AND dueAt <= ?
    `).run(leaseUntil, new Date().toISOString(), jobId, now);
    return result.changes === 1;
  }
```
D-08's registry table should follow the same `dueAt`/expiry-as-a-column shape (here: `expires_at`), and its "is this row still valid" check should be a `WHERE ... AND expires_at > ?` guard directly in SQL — the same "omission as guarantee" discipline documented at `localStore.ts:343-355` (the `getRecentSessionDurationsMs` comment block) and `localStore.ts:456-463` (`getDueNotifications`'s comment on why `'delivered'`/`'failed'` are absent from the predicate, not filtered in application code).

---

### `mirror-request/src/status/guestStatus.ts` — sixth internal status (D-09/D-10)

**Analog:** the file's own `KNOWN_JOB_STATUSES` array + `STATUS_MAP` record (`guestStatus.ts:71-103`).

```typescript
export const KNOWN_JOB_STATUSES = [
  'queued',
  'dispatched',
  'in_progress',
  'completed',
  'failed',
] as const;

export type InternalJobStatus = typeof KNOWN_JOB_STATUSES[number];
...
const STATUS_MAP: Record<InternalJobStatus, (input: GuestStatusInput) => GuestStatus> = {
  queued: ({ announced }) => (announced ? 'your_turn' : 'waiting'),
  dispatched: () => 'your_turn',
  in_progress: () => 'in_session',
  completed: ({ photoDelivery }) =>
    photoDelivery === 'sent' ? 'finished_photo_sent' : 'finished_photo_pending',
  failed: () => 'see_staff',
};
```
Add the sixth member (research recommends `'no_photo'`) to the `KNOWN_JOB_STATUSES` array — this alone makes an unmapped `STATUS_MAP` entry a compile error (`TS2741`, independently reproduced by research this session). Its resolver per D-10: `no_photo: () => 'see_staff'` — literally reuse the same return value `failed` already uses, since the guest-facing action is identical; only `photoDelivery: 'failed'` (a separate field, set at the call site, not inside this map) distinguishes it. Do NOT add a `default:`/switch — this file's whole existing discipline (and D-09's stated rationale in CONTEXT.md) is that a `Record` over the derived union is what makes omission a compile error rather than a silent absorption.

---

### `mirror-request/test/queue-dual-completion.test.ts` (NEW — the phase's most load-bearing test)

**Analog:** `mirror-request/test/queue-countdown.test.ts`, the `"booth state transitions"` describe block (lines 64-259, read this session per research).

That test builds a hand-rolled mocked `LocalStore` with two queued jobs (`job-1`, `job-2`) and drives `QueueService` through `IDLE → ANNOUNCING → BUSY → IDLE → ANNOUNCING` using `vi.useFakeTimers()` + `vi.advanceTimersByTime()`, asserting booth-state sequence and dispatch payload at each step, never touching the real SQLite store.

**Mock-store shape to copy** — `queue-event-coverage.test.ts`'s `buildStore()` (lines 32-60, this session) is the closest smaller-scope sibling already in the repo and shows the exact mock-object shape (`getBoothState`, `setBoothState`, `setBoothBusy`, `setBoothIdle`, `updateJobStatus`, `completeInProgressJob`, etc., all `vi.fn()`-wrapped where assertions are needed):
```typescript
const store = {
    getBoothState: () => booth,
    getNextQueuedJob: () => undefined,
    setBoothState: (s: string) => { booth = s; },
    setBoothBusy: () => { booth = 'BUSY'; },
    setBoothIdle: () => { booth = 'IDLE'; },
    setBoothTimeout: () => { booth = 'IDLE'; },
    updateJobStatus,
    getQueuedGuestSummaries: () => [],
    getQueueLength: () => 0,
    completeInProgressJob,
    getQueuePosition: () => undefined,
    getJobRegistration: () => undefined,
  } as unknown as LocalStore;
```
Extend this mock shape with a `current_job_id` field on the mocked `booth_state` surface and a `completeJob(jobId)`-returning-boolean mock method (mirroring D-06). Drive the two-guest sequence exactly as research's Validation Architecture section describes: `session_start('job-1')` → `processing_start('job-1', composite)` completes job-1 → `session_end()` releases booth, dispatches job-2 → `session_start('job-2')` → **stray second `session_end()`** → assert `job-2`'s status is unchanged (still `in_progress`). This is the exact non-vacuous proof shape (temporarily break the guard, watch the assertion fail, revert) this project's house rule requires per CONTEXT.md/RESEARCH.md precedent (Phases 4, 5, 6).

---

## Shared Patterns

### Config injection (every new timing value: D-02's release deadline, D-07/D-11's registry expiry)
**Source:** `queueService.ts:52-61` (constructor) — `Pick<EnvConfig, ...>` injected with a default of `getConfig()`, never read from a module-level singleton inside a method body.
```typescript
constructor(
    store: LocalStore = getStore(),
    config: Pick<EnvConfig, 'SESSION_TIMEOUT_MS' | 'NEXT_GUEST_COUNTDOWN_MS' | 'SESSION_MAX_RETRIES'> = getConfig(),
  ) {
    this.store = store;
    this.sessionTimeoutMs = config.SESSION_TIMEOUT_MS;
    const configuredMs = config.NEXT_GUEST_COUNTDOWN_MS;
    this.countdownMs = Math.min(10_000, Math.max(5_000, Number.isFinite(configuredMs) ? configuredMs : 7_000));
    this.sessionMaxRetries = config.SESSION_MAX_RETRIES;
  }
```
**Apply to:** the release-fallback timer's default deadline and the pending-print registry's expiry — both must be added to `EnvConfig` (`src/types.ts`, not read this session but implied by this pattern), read via `Pick<EnvConfig, ...>` in the same constructor, with the same clamp-and-fallback style already used for `countdownMs`.

### Logging: label logger + `.info()` for every event (D-12/D-13)
**Source:** `queueService.ts:8` — `export const queueLogger = labelLogger('queue');`, and `logging/logger.ts:62-64` — `labelLogger(name)` returns `logger.child({ label: name })`. `config.ts:140` already defaults `LOG_LEVEL` to `'info'`, verified by research, so no config change is needed for D-12 to become visible without a redeploy — only the code change from `.debug()` to `.info()` (and adding the missing branches) is required.
**Apply to:** every AGT-04 branch in `onAgentEvent()`. Never pass a raw object to `.info()`/`.warn()` — the masking formatters in `logger.ts:16-25`/`:37-45` only run `mask()` on `typeof message === 'string'`; always build a template string, matching the existing style at `queueLogger.info(\`Announcing next guest for job ${job.id} (${countdownMs}ms)\`)` (`queueService.ts:281`). D-13 forbids including `photoUrl`/`param2` in any `info`-level line — verify no new call site does.

### Never-charge-a-retry-for-a-system-fault (D-02, D-03 inherit this)
**Source:** `localStore.ts:248-261`, `requeueNoRetry()` and its comment block: "A deliberate sibling of `requeueWithRetry()` above, not a variant of it... a system-side fault ... must never spend the guest's retry budget." Also `queueService.ts:228-237`, `onAgentDisconnected()`, which calls `requeueNoRetry()` in a loop rather than `handleStall()`.
**Apply to:** D-02's release-fallback timer callback and D-03's no-photo close path — both must route through a call shape that never touches `handleStall()`/`requeueWithRetry()`.

## No Analog Found

None — every file this phase touches is an existing file being extended, and every new mechanism (jobId-scoped completion, sibling timer, additive migration, exhaustive Record, durable registry, log-once flag) has a same-repo precedent identified above. New test files are mapped to existing test files with sufficiently matching structure (see File Classification table).

## Metadata

**Analog search scope:** `mirror-request/src/queue/`, `mirror-request/src/state/`, `mirror-request/src/status/`, `mirror-request/src/logging/`, `mirror-request/test/` (targeted reads only: `queue-countdown.test.ts` header/structure referenced via research's own verified excerpt, `queue-event-coverage.test.ts` read in full this pass).
**Files scanned (full read this pass):** `queueService.ts` (404 lines), `localStore.ts` (492 lines), `guestStatus.ts` (129 lines), `logging/logger.ts` (85 lines), `test/queue-event-coverage.test.ts` (149 lines), `07-CONTEXT.md`, `07-RESEARCH.md`, `mirror-request/CLAUDE.md`.
**Pattern extraction date:** 2026-08-12
