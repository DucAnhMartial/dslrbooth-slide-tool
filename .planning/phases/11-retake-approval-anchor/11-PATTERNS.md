# Phase 11: Retake & Approval Anchor - Pattern Map

**Mapped:** 2026-08-18
**Files analyzed:** 13 (7 modified, 4 new, 2 test-infra)
**Analogs found:** 13 / 13 (all in-repo; 0 "no analog")

Codebase root: `/opt/mirror_request_dslrobooth/mirror-request`. `dslrbooth-agent` is untouched this phase.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/queue/queueService.ts` — `startReleaseGraceTimer`/`clearReleaseGraceTimer` (new) | service (timer) | event-driven | `startReleaseTimer`/`clearReleaseTimer` (same file, :903-916) | exact |
| `src/queue/queueService.ts` — `finalizePendingPrint(jobId, door)` (new, replaces `resolvePendingPrint` call sites) | service | CRUD (idempotent state transition) | `sessionEnded()`/`onPrintComposite()` (same file) + `LocalStore.resolvePendingPrint` predicate | role-match |
| `src/queue/queueService.ts` — `sessionEnded()`, `sessionAckedFromEvent()`, `onPrintComposite()`, `onFileUpload()`, `logSessionSummary()` (modified) | service | event-driven | current bodies of themselves (same file) | exact (in-place rewrite) |
| `src/queue/queueService.ts` — `extractCompositePath(eventType, payload)` (new shared helper) | utility | transform | current duplicated `str('param5')`/`str('param1')` reads inside `agentEventDetail()` (:610-636) and `onPrintComposite()` (:422-500) | role-match |
| `src/state/localStore.ts` — migration for `booth_state.attempt_open` | migration | batch (additive DDL) | `current_job_id` migration idiom (:494-505) | exact |
| `src/state/localStore.ts` — migration for `pending_print.{photo_url,approved_by,attempt_no}` | migration | batch (additive DDL) | same `current_job_id`/`event.show_guest_name` idiom (:494-505, :521-526) | exact |
| `src/state/localStore.ts` — `openOrOverwritePendingPrint()` (new) | model | CRUD | `openPendingPrint()` (:1176-1183, `ON CONFLICT DO NOTHING`) | role-match (deliberately different conflict semantics) |
| `src/state/localStore.ts` — `finalizePendingPrint()` predicate / rename-and-extend of `resolvePendingPrint()` | model | CRUD | `resolvePendingPrint()` (:1218-1225), `completeJob()` (:657-662), `closeJobNoPhoto()` (:707-712) | exact |
| `src/state/localStore.ts` — `setBoothCurrentJob`/`setBoothIdle`/`setBoothBusy` (modified to carry `attempt_open`) | model | CRUD | themselves (:868-921, `INSERT OR REPLACE` idiom) | exact |
| `src/config.ts` — `RETAKE_GRACE_MS: toNum(...)` (new) | config | transform | `BOOTH_RELEASE_TIMEOUT_MS: toNum('BOOTH_RELEASE_TIMEOUT_MS', 120_000)` (:132-140) + `toNum()` itself (:10-19) | exact |
| `src/types.ts` — `RETAKE_GRACE_MS: number;` in `EnvConfig` (new) | config | transform | `BOOTH_RELEASE_TIMEOUT_MS: number;` member (~:233) | exact |
| `src/cms/cmsBoothRoutes.ts` (new) | route | request-response | `src/cms/cmsAgentRoutes.ts` (full file, 233 lines) | exact |
| `src/cms/cmsBoothPages.ts` (new, HTML fragment/section) | component | request-response | `src/cms/cmsAgentPages.ts` | exact |
| `src/app.ts` — thread `queue` into `createCmsRouter(...)` (modified) | config/wiring | request-response | current line `app.ts:230` | exact |
| `src/cms/cmsRouter.ts` — mount `createCmsBoothRoutes(queue)` (modified) | route (wiring) | request-response | mount of `createCmsAgentRoutes(store, agent)` at `cmsRouter.ts:243` | exact |
| `test/queue-retake-grace-timer.test.ts` (new) | test | event-driven | `test/queue-release-timer.test.ts` (fake-timer + mocked `LocalStore` harness) | exact |
| `test/queue-finalize-idempotency.test.ts` (new) | test | CRUD | `test/queue-dual-completion.test.ts` (mocked-store idempotency assertions) | role-match |
| `test/cms-booth-release.test.ts` (new) | test | request-response | `test/cms-agent-config.test.ts` (CMS route test: auth/IP inheritance, POST validation, JSON response shape) | exact |
| `test/helpers/pendingPrintRegistry.ts` (extend) | test-fixture | CRUD | itself (86 lines, in-memory stand-in for the 4 `pending_print` accessors) | exact (extend in place) |
| `test/local-store-persistence.test.ts` (extend) | test | CRUD (real SQLite) | itself (temp-file `LocalStore`, proves migrations/idempotency against real DB) | exact (extend in place) |

## Pattern Assignments

### `src/queue/queueService.ts` — new grace timer (role: service/timer, flow: event-driven)

**Analog:** same file, `startReleaseTimer`/`clearReleaseTimer` (:903-916), and `stop()` (:205-214).

**Core pattern to copy verbatim, renamed** (source: `queueService.ts:903-916`):
```typescript
private startReleaseTimer(jobId: string): void {
    this.clearReleaseTimer();
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null;
      this.store.setBoothIdle();
      queueLogger.warn(`Booth released for job ${jobId} by the fallback timer — no session_end arrived within ${this.boothReleaseTimeoutMs}ms`);
      this.tick();
    }, this.boothReleaseTimeoutMs);
}

private clearReleaseTimer(): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
}
```
Model `startReleaseGraceTimer(jobId)`/`clearReleaseGraceTimer()` on this exact shape: nullable `NodeJS.Timeout | null` field, `startX` clears first then `setTimeout`, `clearX` clears+nulls. On fire: call `finalizePendingPrint(jobId, 'grace')` (door 2), **not** `setBoothIdle()` directly — `finalizePendingPrint` itself must call `setBoothIdle()`+`tick()` as its last step (see finalize pattern below). Name it distinctly (`releaseGraceTimer`, not `releaseTimer` — they are siblings covering different failure classes, per RESEARCH.md line 161).

**`stop()` must clear it too** (source: `queueService.ts:205-214`):
```typescript
stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    if (this.busyTimer) clearTimeout(this.busyTimer);
    this.clearReleaseTimer();
    if (this.announcementTimer) clearTimeout(this.announcementTimer);
    this.announcementTimer = null;
    this.announcingJobId = null;
    this.announcementEndsAt = null;
}
```
Add `this.clearReleaseGraceTimer();` to this list — same discipline, same place.

**Constraint from the release-timer's own header comment (:66-77):** the new timer must NEVER route through `handleStall()`/`requeueWithRetry()`/`failJob()` and must never write a `stall_reason` — copy that constraint's letter, not just its spirit.

---

### `src/queue/queueService.ts` — `finalizePendingPrint(jobId, door)` (new) (role: service, flow: CRUD/idempotent gate)

**Analog:** `LocalStore.resolvePendingPrint()` idempotency predicate (`src/state/localStore.ts:1218-1225`) plus `completeJob()`/`closeJobNoPhoto()` (`:657-662`, `:707-712`), and the existing two call sites inside `onFileUpload()` (`:988-991`, `:1000-1003`) that this method replaces.

**Idempotency predicate to reuse/extend** (source: `localStore.ts:1218-1225`):
```typescript
resolvePendingPrint(jobId: string, resolvedAt: number): boolean {
    const result = this.db.prepare(`
      UPDATE pending_print
      SET status = 'resolved', resolved_at = ?, updated_at = ?
      WHERE jobId = ? AND status IN ('awaiting','expired')
    `).run(resolvedAt, new Date().toISOString(), jobId);
    return result.changes === 1;
}
```
D11-05 explicitly says this method is **replaced**, not wrapped — rename/extend it (e.g. carry `approved_by`/`photo_url` in the same `SET` list) rather than adding a second layer on top.

**Notification/history call pair to reuse unchanged** (source: `queueService.ts:1105-1109`, and the pair currently duplicated at `:988-991`/`:1000-1003`):
```typescript
if (this.store.resolvePendingPrint(jobId, Date.now())) {
  this.recordPhotoHistory(jobId, photoUrl);
  void this.sendNotification(jobId, photoUrl);
}
```
`finalizePendingPrint()` becomes the ONE place this pair is called from. Do not duplicate `recordPhotoHistory`/`sendNotification` themselves — only move the call site.

**Completion pattern to call from inside finalize** (source: `completeJob()`/`closeJobNoPhoto()`, both guard `AND status = 'in_progress'`) — call whichever of the two applies (URL present vs absent), then `this.store.setBoothIdle(); this.tick();` exactly like today's `sessionEnded()` release sequence.

---

### `src/queue/queueService.ts` — `sessionEnded()` rewrite (role: service, flow: event-driven)

**Analog:** itself, current body (source: `queueService.ts:328-353`):
```typescript
sessionEnded(): void {
    const currentJobId = this.store.getBoothCurrentJobId();
    if (currentJobId === undefined) {
      queueLogger.info('session_end received with no job bound to the booth; ignored');
      return;
    }
    this.store.setBoothIdle(); // clears current_job_id in the same write
    this.clearBusyTimer();
    this.clearReleaseTimer(); // this session_end IS the release the fallback exists to guard against missing
    queueLogger.info(`Released booth held by job ${currentJobId}`);
    this.tick();
}
```
New shape: keep the `currentJobId === undefined` early-return line-for-line. Branch on whether the attempt is already approved (read off the `pending_print` row's `approved_by`/`status`, per D11-05's audit column, NOT `queue_job.stall_reason`): if approved, keep this exact unconditional release body; if not approved, do **not** call `setBoothIdle()` — instead clear `booth_state.attempt_open`, call `startReleaseGraceTimer(currentJobId)`, and log an `info` line naming the grace window opened (mirrors the existing `info` line style shown above).

---

### `src/queue/queueService.ts` — `onPrintComposite()` split by `eventType` (role: service, flow: event-driven)

**Analog:** itself (source: `queueService.ts:422-500`), key excerpt:
```typescript
const completed = this.store.completeJob(currentJobId, Date.now());
if (!completed) {
  queueLogger.info(`${eventType} composite for ${currentJobId} arrived after the job was already closed`);
  return;
}
...
this.startReleaseTimer(currentJobId);
const opened = this.store.openPendingPrint({ jobId: currentJobId, compositePath, openedAt: now, expiresAt: now + this.pendingPrintExpiryMs });
...
this.logSessionSummary(currentJobId, 'completed', true);
```
Copy the "cross-check jobId, extract composite, `queueLogger.info` on already-closed" skeleton; split into two branches by `eventType`:
- `processing_start` → call new `extractCompositePath('processing_start', payload)` (shared helper — see below), call `store.openOrOverwritePendingPrint(...)` (NOT `openPendingPrint`, NOT `completeJob`, NOT `startReleaseTimer`).
- `printing` → apply D11-03's two-part guard (attempt-open check FIRST, composite-match check SECOND — see Pitfall 3 in RESEARCH.md — with the two exact log strings `printing ignored: no attempt open` / `printing ignored: composite X is not this attempt's Y`), then call `finalizePendingPrint(jobId, 'printing')`.

**Shared helper to extract (new), replacing duplicated logic in two places** (sources: `queueService.ts:610-636` `agentEventDetail()`'s `str('param5')` case, and `onPrintComposite()`'s own param extraction):
```typescript
case 'processing_start': {
    const composite = str('param5');
    return composite ? `composite=${composite}` : '';
}
```
Write ONE `extractCompositePath(eventType, payload)` function per D11-07 (last param pointing into `\Prints\`, else last non-empty param for `processing_start`; `printing` stays `param1`), call it from both `agentEventDetail()` and `onPrintComposite()`. Do not re-derive the scan twice — this duplication is exactly what caused today's `param5` bug (RESEARCH.md Anti-Patterns).

---

### `src/queue/queueService.ts` — `onFileUpload()` rewrite (role: service, flow: event-driven / file-I/O)

**Analog:** itself (source: `queueService.ts:942-1004`), the two send call sites to REMOVE:
```typescript
if (this.store.resolvePendingPrint(jobId, Date.now())) {
  this.recordPhotoHistory(jobId, photoUrl);
  void this.sendNotification(jobId, photoUrl);
}
```
New body: keep `param3 !== 'print'` filter and URL extraction unchanged; replace both send call sites with a write-only store call that sets `photo_url` without changing `status` — unless the row is already `expired`/`finalized`, in which case add an `info` log line (D11-04 explicitly closes today's silent no-`else` fall-through at `:994-1004`).

---

### `src/state/localStore.ts` — additive migrations (role: migration, flow: batch)

**Analog:** the `current_job_id` migration (source: `localStore.ts:494-505`, verbatim):
```typescript
const boothColumns = this.db.prepare('PRAGMA table_info(booth_state)').all() as Array<{ name: string }>;
const hasCurrentJobId = boothColumns.some((c) => c.name === 'current_job_id');
if (!hasCurrentJobId) {
  this.db.exec('ALTER TABLE booth_state ADD COLUMN current_job_id TEXT');
}
```
Copy this exact idiom, immediately after this block in `migrate()`, for `attempt_open`:
```typescript
const hasAttemptOpen = boothColumns.some((c) => c.name === 'attempt_open');
if (!hasAttemptOpen) {
  this.db.exec('ALTER TABLE booth_state ADD COLUMN attempt_open INTEGER NOT NULL DEFAULT 0');
}
```
`NOT NULL DEFAULT 0` is safe per the same reasoning already used for `event.show_guest_name`/`hero_enabled` (`:521-526`: "SQLite accepts a NOT NULL ADD COLUMN precisely because a DEFAULT is supplied"). Repeat the same `PRAGMA table_info`-then-conditional-`ALTER` pattern, one block per new column, for `pending_print.{photo_url TEXT, approved_by TEXT, attempt_no INTEGER}` against `PRAGMA table_info(pending_print)`.

**Critical follow-up (not a new pattern, a hazard already documented in this file):** every `INSERT OR REPLACE INTO booth_state (...)` writer (`setBoothCurrentJob`/`setBoothIdle`/`setBoothBusy`, `:868-921`) must add `attempt_open` to its column list, because `INSERT OR REPLACE` "deletes the row and inserts a new one, so any column left out of the column list silently reverts to its default" (comment at `:873-876`). This is the single highest-risk regression in this migration — flag it as its own reviewed task.

---

### `src/state/localStore.ts` — `openOrOverwritePendingPrint()` (new) (role: model, flow: CRUD)

**Analog:** `openPendingPrint()` (source: `localStore.ts:1176-1183`, verbatim):
```typescript
openPendingPrint(entry: { jobId: string; compositePath: string; openedAt: number; expiresAt: number }): boolean {
    const result = this.db.prepare(`
      INSERT INTO pending_print (jobId, composite_path, status, opened_at, expires_at, resolved_at, updated_at)
      VALUES (?, ?, 'awaiting', ?, ?, NULL, ?)
      ON CONFLICT(jobId) DO NOTHING
    `).run(entry.jobId, entry.compositePath, entry.openedAt, entry.expiresAt, new Date().toISOString());
    return result.changes === 1;
}
```
Do NOT change this method's semantics (its header comment at `:1170-1175` frames `DO NOTHING` as load-bearing for the double-fire case). Write a NEW method beside it that upserts when the incoming `compositePath` differs from the current row (retake: composite changed) and behaves like today's DO-NOTHING when it is the same path (double-fire), e.g. `ON CONFLICT(jobId) DO UPDATE SET composite_path = excluded.composite_path, ... WHERE excluded.composite_path <> pending_print.composite_path`. This double-fire-vs-retake distinction needs its own dedicated unit test (flagged in RESEARCH.md as the one place D11-02 and D-07/D-08's guarantee could regress into each other).

---

### `src/config.ts` / `src/types.ts` — `RETAKE_GRACE_MS` (role: config, flow: transform)

**Analog:** `BOOTH_RELEASE_TIMEOUT_MS` (source: `config.ts:132-140`, verbatim):
```typescript
SESSION_TIMEOUT_MS:       toNum('SESSION_TIMEOUT_MS',  300_000),
NEXT_GUEST_COUNTDOWN_MS:  toNum('NEXT_GUEST_COUNTDOWN_MS', 7000),
SESSION_MAX_RETRIES:      toNum('SESSION_MAX_RETRIES', 2),
BOOTH_RELEASE_TIMEOUT_MS: toNum('BOOTH_RELEASE_TIMEOUT_MS', 120_000),
```
Add `RETAKE_GRACE_MS: toNum('RETAKE_GRACE_MS', 20_000),` to this list. `toNum()` itself (`config.ts:10-19`) parses via `Number.parseInt(val, 10)`, pushes to `errors[]` on `NaN`, else default — no changes needed to `toNum`.

Add the matching `RETAKE_GRACE_MS: number;` member to `EnvConfig` in `types.ts` near `BOOTH_RELEASE_TIMEOUT_MS` (~`types.ts:233`), same inline-comment style.

**Do NOT use the `PENDING_PRINT_EXPIRY_MS`/`NO_PHOTO_CLOSE_DELAY_MS` shape** (module constant + constructor seam, explicitly NOT an `.env` key per `queueService.ts:24-29`'s D-12 comment) — D11-06 explicitly requires `.env`-tunability, which is the `EnvConfig`/`toNum()` shape, not that one. Add `'RETAKE_GRACE_MS'` to the `QueueService` constructor's `Pick<EnvConfig, ...>` union at `queueService.ts:166`, alongside the other four.

---

### `src/cms/cmsBoothRoutes.ts` (new) (role: route, flow: request-response)

**Analog:** `src/cms/cmsAgentRoutes.ts` (full file, 233 lines) — copy its exact shape wholesale.

**Interface pattern** (source: `cmsAgentRoutes.ts:22-31`):
```typescript
/**
 * The narrowest view of `LocalStore` this page needs — three methods, all of
 * them about `agent_config`. Note what is absent: nothing here can touch an
 * event, a queue row or booth state.
 */
export interface CmsAgentStore {
  getAgentConfig(): Record<string, unknown> | undefined;
  saveAgentConfig(next: Record<string, unknown>): void;
  restorePreviousAgentConfig(): Record<string, unknown> | undefined;
}
```
Define a `CmsBoothLink` interface the same narrow way, exposing exactly what D11-08 needs — a read (`getBoothStallInfo(): { jobId: string; guestName: string; waitingSinceMs: number } | null`) and one write (`releaseForOperator(jobId: string): boolean`, calling `finalizePendingPrint(jobId, 'operator')` internally). **Do not mutate `LocalStore` directly from this route** — go only through `QueueService`, exactly as `CmsAgentLink.sendEvent()` never touches `agent_config` SQL directly (RESEARCH.md Anti-Patterns, last bullet).

**Route-factory pattern** (source: `cmsAgentRoutes.ts:131-160`):
```typescript
export function createCmsAgentRoutes(store: CmsAgentStore, agent: CmsAgentLink): ReturnType<typeof Router> {
  const router = Router();

  router.get('/agent', (_req: Request, res: Response) => {
    const stored = pickSafeAgentConfig(store.getAgentConfig() ?? DEFAULT_AGENT_CONFIG);
    res.type('html').send(renderCmsAgentConfigPage({ ... }));
  });

  router.post('/api/agent', (req: Request, res: Response) => {
    const result = validateAgentConfigSubmission((req.body ?? {}) as Record<string, unknown>);
    if (!result.ok) {
      res.status(400).json({ error: AGENT_SAVE_ERROR });
      return;
    }
    ...
    res.status(200).json({ saved: true, ... });
  });

  return router;
}
```
`createCmsBoothRoutes(queue: CmsBoothLink)` should follow this exactly: a `GET` for the current-stall-info read, a `POST /api/booth/release` calling the one write method, returning `res.status(200).json({ released: true, ... })` on success. On idempotency race (already finalized between read and click), return e.g. `res.status(409).json({ error: '...' })` — mirror the `POST /api/agent/restore` 409-on-nothing-to-restore pattern (source: `cmsAgentRoutes.ts:198-215`):
```typescript
router.post('/api/agent/restore', (_req: Request, res: Response) => {
    const restored = store.restorePreviousAgentConfig();
    if (!restored) {
      res.status(409).json({ error: AGENT_NO_PREVIOUS });
      return;
    }
    ...
});
```

**Validation "refuse the whole thing on any unexpected field" pattern** (source: `cmsAgentRoutes.ts:61-122`, `validateAgentConfigSubmission`): if the POST body carries a `jobId` or similar, validate it the same all-or-nothing way — refuse the whole request (400) on any unexpected field rather than silently ignoring it, same as `isSafeAgentConfigField` gating.

**Mounting** (source: `cmsRouter.ts:243`, mounts `createCmsAgentRoutes(store, agent)` after `requireSession()` at `cmsRouter.ts:241`): mount `createCmsBoothRoutes(queue)` in `cmsRouter.ts` right after the existing `createCmsAgentRoutes(store, agent)` call — inherits session auth + IP gate automatically, no new wiring needed for either.

**`app.ts` wiring change** (source: `app.ts:230`, current):
```typescript
app.use('/cms', createCmsIpGate(config.CMS_IP_WHITELIST), createCmsRouter(store, config, agentServer));
```
`QueueService` (the `queue` variable, built in `index.ts:25`) is currently NOT passed in at all — add it as a new `createCmsRouter(store, config, agentServer, queue)` parameter, threaded down into `createCmsBoothRoutes(queue)`.

---

### `src/cms/cmsBoothPages.ts` (new) (role: component, flow: request-response)

**Analog:** `src/cms/cmsAgentPages.ts` — sibling render-function file exporting the HTML fragment plus string constants for success/error messages (`AGENT_SAVE_SUCCESS`, `AGENT_SAVE_ERROR`, etc., imported into `cmsAgentRoutes.ts` at lines 9-18). Follow the same shape: one `renderCmsBoothXxx(...)` function plus named message constants, imported the same way into `cmsBoothRoutes.ts`.

---

### Test files

**`test/queue-retake-grace-timer.test.ts`** — analog `test/queue-release-timer.test.ts`: fake-timer harness (`vi.useFakeTimers()`/`vi.advanceTimersByTime()`) driving the real `QueueService` against a hand-built mocked `LocalStore`. Copy its `buildStore()` scaffolding shape and its `vi.advanceTimersByTime(...)` assertions on timer fire vs. cancel. Note per RESEARCH.md: this file's own fixture setup around `processing_start` needs restructuring too, since D11-02 removes `startReleaseTimer()` from `onPrintComposite()` — read it fully before copying its fixture, don't just copy assertions blind.

**`test/queue-finalize-idempotency.test.ts`** — analog `test/queue-dual-completion.test.ts` (496 lines, mocked-store idempotency assertions around `completeJob`/`resolvePendingPrint`). Copy its pattern of asserting `changes === 1` vs `false` on a second call, extended to three doors (`printing`/`grace`/`operator`) all targeting the same `finalizePendingPrint(jobId, door)` gate — assert the second door's call is a no-op and does not double-send.

**`test/cms-booth-release.test.ts`** — analog `test/cms-agent-config.test.ts` (find via `test/cms-agent-config.test.ts` in the CMS test list) for the general CMS-route-test shape: constructs an Express app with the same auth/IP middleware stack, asserts session-required and IP-gate-required (inherited, no new mechanism), POSTs and asserts JSON response shape + logged field names only (no secrets). Also draw on `test/cms-access-control.test.ts` for the auth/IP-gate boilerplate if `cms-agent-config.test.ts` doesn't isolate it cleanly.

**`test/helpers/pendingPrintRegistry.ts`** (extend, source: full file above) — an in-memory stand-in for the 4 `pending_print` accessors, explicitly documented as "one shared file rather than five hand-copied maps... a mock drifting from the SQL it stands in for." Extend `PendingPrintRow`/`PendingPrintRegistry` with `photoUrl`, `approvedBy`, `attemptNo` fields, and add the overwrite-vs-DO-NOTHING branch (mirroring `openOrOverwritePendingPrint`'s real-SQL semantics) to the in-memory `registry.openPendingPrint`-equivalent. Every file importing this helper (`queue-dual-completion.test.ts`, `queue-file-upload-print.test.ts`, `queue-config-injection.test.ts`, `queue-retake-anchor.test.ts`, `queue-print-registry-expiry.test.ts`) picks up the new shape automatically — extend in place, do not fork.

**`test/local-store-persistence.test.ts`** (extend) — the ONLY file in the suite using a real `fs.mkdtempSync` temp-file SQLite + real `LocalStore`, proving actual migrations/SQL. Add cases here (not in a mocked-store file) for: `attempt_open`/`pending_print` new-columns migration is additive and idempotent on a real DB; `openOrOverwritePendingPrint`'s real `ON CONFLICT ... WHERE` SQL distinguishes double-fire from retake.

## Shared Patterns

### Timer lifecycle (start/clear/stop)
**Source:** `src/queue/queueService.ts:903-916` (start/clear pair), `:205-214` (`stop()` clearing all four existing timers)
**Apply to:** the new `releaseGraceTimer`. Nullable field, `startX()` calls `clearX()` first then `setTimeout`, `clearX()` calls `clearTimeout` then nulls the field, and `stop()` must clear it alongside the other four.

### Additive SQLite migration idiom
**Source:** `src/state/localStore.ts:494-505` (`current_job_id`), `:521-526` (`NOT NULL DEFAULT` reasoning for `event.show_guest_name`)
**Apply to:** `booth_state.attempt_open`, `pending_print.{photo_url,approved_by,attempt_no}`. `PRAGMA table_info(<table>)` → `.some((c) => c.name === '<col>')` → conditional `ALTER TABLE ... ADD COLUMN`, always with a `DEFAULT` when `NOT NULL`.

### Idempotent SQL predicate as "has this already happened" check
**Source:** `src/state/localStore.ts:1218-1225` (`resolvePendingPrint`'s `WHERE status IN (...)` + `changes === 1`), and the codebase-wide idiom named explicitly in `07-CONTEXT.md`: "structural guarantees are expressed by what the SQL leaves out, never by an `if` a later edit can delete."
**Apply to:** `finalizePendingPrint()`'s three-door idempotency, `openOrOverwritePendingPrint()`'s double-fire-vs-retake branch, and the CMS operator-release race (RESEARCH.md Security Domain: "Operator releases the WRONG job").

### CMS route factory: narrow interface + auth/IP inherited from mount order
**Source:** `src/cms/cmsAgentRoutes.ts` (full file), `src/cms/cmsRouter.ts:241,243`
**Apply to:** `cmsBoothRoutes.ts`/`cmsBoothPages.ts`. IP gate mounted once in `app.ts:230` ahead of the whole `/cms` router; session auth mounted once in `cmsRouter.ts:241` ahead of every route-factory call; CSRF is the existing `SameSite=Lax` cookie (`cmsAuth.ts:228-232`) — no new CSRF mechanism for the new POST route. Validation refuses the whole submission on any unexpected field (`cmsAgentRoutes.ts:61-122`), never silently drops one.

### `.env`-configurable numeric timing value
**Source:** `src/config.ts:10-19` (`toNum()`), `:132-140` (`BOOTH_RELEASE_TIMEOUT_MS` usage)
**Apply to:** `RETAKE_GRACE_MS` only — contrast with the deliberately-NOT-`.env` module-constant shape of `PENDING_PRINT_EXPIRY_MS`/`NO_PHOTO_CLOSE_DELAY_MS` (`queueService.ts:24-29`, D-12) which must NOT be copied for this key.

## No Analog Found

None. Every file in scope has a close in-repo analog (see table above); the codebase's Phase 7/8 patterns for timers, migrations, idempotent SQL, and CMS route factories directly cover this phase's new surface.

## Metadata

**Analog search scope:** `mirror-request/src/queue/`, `mirror-request/src/state/`, `mirror-request/src/cms/`, `mirror-request/src/config.ts`, `mirror-request/src/types.ts`, `mirror-request/test/`, `mirror-request/test/helpers/`
**Files scanned:** `queueService.ts` (1153 lines), `localStore.ts` (1677 lines, relevant sections), `config.ts` (full, 205 lines), `types.ts` (relevant region), `cmsAgentRoutes.ts` (full, 233 lines), `cmsRouter.ts`, `app.ts` (mount line), `test/helpers/pendingPrintRegistry.ts` (full, 86 lines), plus the CMS/queue test file directory listing. All excerpts sourced from `11-RESEARCH.md`'s verified quotes (read this session by the researcher) or re-read directly in this pass (`cmsAgentRoutes.ts`, `pendingPrintRegistry.ts`).
**Pattern extraction date:** 2026-08-18
