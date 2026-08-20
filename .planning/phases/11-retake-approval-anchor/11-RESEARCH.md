# Phase 11: Retake & Approval Anchor — Research (researcher agent)

**Researched:** 2026-08-18
**Domain:** dslrBooth trigger reattribution — session/attempt/job lifecycle, SQLite migration, CMS operator control
**Confidence:** HIGH for code locations and current bodies (all read this session, verbatim quoted below); MEDIUM for the new-code shape (derived from D11-01…D11-10, which are locked); LOW/ASSUMED only where flagged.

**Read first, this file builds on and does not repeat them:**
- `11-RESEARCH-OPERATOR.md` — vendor docs, the broken-assumption table, the code map, the measured timings, Q1–Q4. Not re-derived here.
- `11-CONTEXT.md` — D11-01…D11-10, locked 2026-08-18. This file is downstream of it.
- `07-EVIDENCE-dslrbooth-triggers.md` §C/D/E — the measured trigger sequences (conclusions 7–14), ground truth.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions (verbatim, D11-01…D11-10 — full text in `11-CONTEXT.md`, one-line digest here for orientation)

- **D11-01** — `session_start` opens an *attempt*, `session_end` closes it. Attempt is a new unit under job. The "attempt open" flag is **persisted in `booth_state`**, same row as `current_job_id`, same restart-survival mechanism — **not** an in-memory variable.
- **D11-02** — `processing_start` = composite exists (opens/**overwrites** the pending-print slot). `printing` = guest approved (only with auto-print OFF). Replaces Phase 7 D-01 (which treated both as the same completion anchor).
- **D11-03** — `printing` only counts as approval when BOTH: (a) an attempt is open, (b) `printing.param1` equals the `composite_path` that this attempt's own `processing_start` wrote into the slot. Either failure → ignored, one `info` line naming which condition failed (`printing ignored: no attempt open` / `printing ignored: composite X is not this attempt's Y`).
- **D11-04** — `file_upload param3=print` only **writes** the URL into the slot of the job currently bound to the booth (overwriting any prior URL), never sends. Sending happens only at finalize (D11-05). Lookup is still via the registry (D-07), not booth state. A `print` upload arriving after the slot is `finalized` is a no-op **with a log line** (fixes today's silent branch).
- **D11-05** — Finalize (`finalizePendingPrint(jobId)`, idempotent, returns boolean) has exactly three doors, and writes which one into `pending_print.approved_by`:
  1. valid `printing` per D11-03 → `approved_by='printing'`, 0s wait.
  2. grace timer (D11-06) expires with no new `session_start` → `approved_by='grace'`, sends whichever URL the slot currently holds (if any).
  3. operator presses "end this guest" on CMS (D11-08) → `approved_by='operator'`.
  Finalize = `completeJob` (if a URL exists) or `no_photo` (if the slot never got a URL) + send notification + write photo history + release booth + `tick()`.
- **D11-06** — `RETAKE_GRACE_MS`, default 20000, `.env`-configurable. An unapproved attempt's `session_end` does **not** release the booth; it starts a grace timer. A new `session_start` while it runs = retake: cancel timer, open a new attempt, job keeps the booth. Timer expiry = D11-05 door 2. An **approved** attempt's `session_end` releases immediately, no grace (booth already released at door 1's `printing`, in practice). Accepted tradeoff: a stranger pressing start within the 20s window is read as the same guest retaking; D11-08 is the human mitigation.
- **D11-07** — `processing_start` composite = the **last** param whose value points into `\Prints\`; if none matches, the highest-indexed non-empty param. Removes the `param5` hardcode. Applies to both `agentEventDetail()` (the log line) and `onPrintComposite()`. `printing` stays `param1`.
- **D11-08** — CMS `POST /cms/api/booth/release` — "end this guest" button, shown only while the booth is BUSY or in grace, displaying guest name + elapsed wait. Goes through the CMS's existing auth/IP-gate/CSRF(=SameSite). Writes `approved_by='operator'`.
- **D11-09** — `SESSION_SUMMARY` gains two trailing fields, appended (order preserved): `attempts=N approved_by=printing|grace|operator|none`. `captures` keeps counting `capture_start` across every attempt. Every new "ignored" branch logs one `info` line — no new silent branch anywhere.
- **D11-10** — `test/queue-retake-anchor.test.ts` is rewritten from the measured C/D/E sequences (see Wave 0 below — this researcher found the breakage radius is **much wider** than this one file; see §5).

### Claude's Discretion
None declared separately in `11-CONTEXT.md` beyond the open questions below — D11-01…D11-10 are locked, not discretionary.

### Deferred Ideas (OUT OF SCOPE)
- `/api/cancel` via Agent as a new `command` action (needs Agent change — violates this phase's own D-05 hold — and dslrBooth ≥ v8.3.0, unconfirmed — Q1).
- Agent still never clears `activeJobId` (carried from Phase 7 Deferred).
- Max attempts per job / anti-booth-hogging limit.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| BTH-01/BTH-02 (re-opened) | Booth IDLE/BUSY state machine + safe timeout | §2/§3 below: `booth_state` gains `attempt_open` (persisted flag, not new `BoothState` enum value — see Risk R3); `BOOTH_RELEASE_TIMEOUT_MS`/`RETAKE_GRACE_MS` interaction mapped in Risk R4. |
| NOT-01 (re-opened) | `file_upload` → notify guest | §2 `onFileUpload()` D11-04 rewrite: write-only, no send; §4 `finalizePendingPrint()` is the new single send site, replacing the two `sendNotification()` call sites in today's `onFileUpload()`. |
| AGT-04 (extended) | Agent event handling | §2 `agentEventDetail()`/`onPrintComposite()` D11-07 fix; new attempt-tracking on `session_start`/`session_end`. |

</phase_requirements>

## Summary

Phase 7 built the right machinery (pending-print registry, `current_job_id` attribution, release-vs-completion split) on one wrong assumption: that a retake happens *inside* the capture phase, before any composite exists. The operator's 2026-08-18 measurements (`07-EVIDENCE-dslrbooth-triggers.md` §C/D/E) prove the opposite — the sharing-screen Retake is a brand-new dslrBooth session (`session_end` → `session_start`), and *every* attempt, kept or discarded, produces its own composite and its own `file_upload param3=print`. This phase inserts one new concept — the **attempt**, nested under job — and moves the finalize decision from "first composite seen" to "guest pressed print" (with a grace-timer and an operator-button safety net for the two cases where nobody presses print).

The blast radius inside `queueService.ts` is concentrated in six methods (`sessionEnded`, `sessionAckedFromEvent`, `onPrintComposite`, `onFileUpload`, `sweepPendingPrints`, `logSessionSummary`) plus one new method (`finalizePendingPrint`) and one new timer (`releaseGraceTimer`, a sibling of the existing `releaseTimer`/`busyTimer` pair — same `stop()`-clears-it discipline). In `localStore.ts` it is one migration (`booth_state.attempt_open`, `pending_print.{photo_url,approved_by,attempt_no}`) and a handful of new/changed accessors, all following the codebase's existing `PRAGMA table_info` + conditional `ALTER TABLE` idiom (verified at `localStore.ts:494-505`). In `config.ts`/`types.ts` it is one new **real** `.env` key, `RETAKE_GRACE_MS`, following the `toNum()` pattern used by `BOOTH_RELEASE_TIMEOUT_MS` — this is a different injection shape than `PENDING_PRINT_EXPIRY_MS`/`NO_PHOTO_CLOSE_DELAY_MS`, which are deliberately *not* `.env` keys (Phase 7 D-12); D11-06 explicitly wants operator-tunable-without-rebuild, which means `EnvConfig` + `loadConfig()`, not a module constant.

The single biggest planning risk this research surfaces beyond what `11-CONTEXT.md`/`11-RESEARCH-OPERATOR.md` already flag: **the test breakage is not limited to `test/queue-retake-anchor.test.ts`** (D11-10's explicit target). Reading the current suite shows at least five more files assert the *old* single-anchor model directly — `processing_start` alone flips a job to `completed`, and `file_upload` alone calls `sendPhotoLink` — both of which D11-02/D11-04/D11-05 deliberately break. §5 below lists every file and line found.

**Primary recommendation:** keep the "attempt open" state as a boolean column on the existing single-row `booth_state` table (not a new `BoothState` enum value), and treat the `pending_print` row's `approved_by` column — not `queue_job.stall_reason` — as D11-05's audit trail, because `stall_reason` is a closed, server-authored vocabulary (OPS-RUNBOOK §6) that must not gain retake-specific values.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Attempt lifecycle (`session_start`/`session_end` → attempt open/closed) | Extension Service (Queue tier) | Local State Store (SQLite) | Business logic per `CLAUDE.md`; persisted because it must survive a restart mid-grace-window, same discipline as `current_job_id` (D-06). |
| Approval decision (D11-03/D11-05) | Extension Service (Queue tier) | Local State Store | Pure server-side state machine; no external call needed to decide. |
| Grace timer (D11-06) | Extension Service (Queue tier, in-process timer) | Local State Store (durable flag so `recover()` can reason about a crash mid-grace) | Mirrors `releaseTimer`'s existing shape — in-memory `setTimeout`, with the *fact* that a grace window is open persisted, not the timer itself. |
| Operator override (D11-08) | CMS route (Extension Service, API/Backend tier) | Extension Service Queue tier (the actual state mutation) | CMS is a thin authenticated HTTP surface over one new `QueueService` public method — same shape as `createCmsAgentRoutes`' `askAgentToReload()`. |
| Guest notification send | Extension Service (Queue tier → Notification module) | — | Unchanged tier; only the *trigger site* moves (from `onFileUpload` to `finalizePendingPrint`). |
| Display feed (`boothState`) | Extension Service (`DisplayServer`, API/Backend tier, WS push) | Browser (room screen) | Reads `store.getBoothState()` — see Risk R3 for why grace must not require a display-tier change. |

## Package Legitimacy Audit

Not applicable — this phase adds no new npm dependency. `better-sqlite3`, `express`, `ws` are already installed and unchanged in scope.

## Codebase Specifics (file:line, current bodies)

All quotes below were read from source this session (`Read` tool) at the paths and line numbers given.

### `src/queue/queueService.ts` (1153 lines total, verified)

**`sessionEnded()` — `queueService.ts:328-353`.** Current body (release-only, D-02 already split from completion):
```
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
**D11-06 changes this unconditionally to release.** The new body must branch on whether the current attempt is already approved (per the pending-print row's `approved_by`/`status`) — if approved, keep today's immediate release; if not approved, do **not** call `setBoothIdle()` — instead close the attempt (clear `booth_state.attempt_open`) and start the new grace timer (`startReleaseGraceTimer(currentJobId)`), leaving `current_job_id` untouched so a retake's `session_start` still finds the booth "bound" to the same job.

**`sessionAckedFromEvent()` — `queueService.ts:387-396`** and **`sessionAcked()` — `queueService.ts:398-412`.** Current `sessionAckedFromEvent` cross-checks jobId against `current_job_id` and rejects a mismatch; `sessionAcked` writes `in_progress` + `setBoothCurrentJob` + resets `busyTimer`. **D11-01/D11-06 changes:** when `session_start` arrives while a grace timer is running for the SAME `current_job_id`, this is the retake path — must cancel the grace timer (`clearReleaseGraceTimer()`), set `booth_state.attempt_open = 1`, increment the in-memory or persisted attempt counter, and must NOT reset `busyTimer` incorrectly relative to the overall session — reuse the existing `sessionAcked()` call but the caller (`sessionAckedFromEvent`) needs a new branch before its current mismatch-check: "is the booth already bound to this exact jobId and in grace? then this is a retake, not a fresh dispatch ack."

**`onPrintComposite()` — `queueService.ts:422-500`.** Current body does ALL of: cross-check jobId, extract `param5`/`param1`, call `completeJob()` (the single anchor), start `releaseTimer`, open pending-print slot, log summary. Full text quoted above in the read; key excerpt:
```
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
**D11-02 splits this into two handlers by `eventType`:**
- `processing_start` branch: extract composite per D11-07's new rule (see below), call a new `openOrOverwritePendingPrint()` (must **not** be `ON CONFLICT DO NOTHING` any more — a retake's second `processing_start` must overwrite the first attempt's composite path, contradicting the current `openPendingPrint()` header comment at `localStore.ts:1170-1175` which states the DO-NOTHING clause "IS the idempotency guarantee" for the *double-fire* case, not the retake case — these are now two different situations that must be told apart: same composite path re-arriving (double-fire, ignore) vs. a **different** composite path for the same job (retake, overwrite)). No `completeJob()` call here at all — D11-02 explicitly removes `processing_start` from the completion anchor. No `startReleaseTimer()` call here either — D11-05 replaces it with D11-06's grace flow, triggered from `sessionEnded()`, not from the composite event.
- `printing` branch: apply D11-03's two-part guard (attempt open AND composite matches), then call `finalizePendingPrint(jobId, 'printing')` (D11-05 door 1) instead of `completeJob()` directly.

**`agentEventDetail()` — `queueService.ts:610-636`.** Current `processing_start` case:
```
case 'processing_start': {
    const composite = str('param5');
    return composite ? `composite=${composite}` : '';
}
```
D11-07 replaces the `str('param5')` call with a scan over `payload`'s own keys (see Risk R1 for the exact algorithm and its edge cases). This method and `onPrintComposite()` must share ONE implementation of "which param is the composite" — do not duplicate the scan logic in both places (today's code already duplicates `param5`/`param1` selection between these two methods; D11-07 is the moment to extract a shared helper, e.g. `extractCompositePath(eventType, payload)`).

**`onFileUpload()` — `queueService.ts:942-1004`.** Current body resolves the registry and sends immediately:
```
if (this.store.resolvePendingPrint(jobId, Date.now())) {
  this.recordPhotoHistory(jobId, photoUrl);
  void this.sendNotification(jobId, photoUrl);
}
```
(two call sites, the `awaiting` branch at `:1000-1003` and the `expired` D-11 late-arrival branch at `:988-991`). **D11-04 removes both `sendNotification`/`recordPhotoHistory` calls from this method entirely.** The method's job shrinks to: filter `param3 !== 'print'` (unchanged), extract URL (unchanged), then call a new store method that **writes `photo_url` into the pending_print row without changing its `status`** (unless the row is already `expired`/`finalized`, in which case log per D11-04's "no-op has a log line" requirement — this closes the WINDOWS-style silent branch the current `pending.status === 'resolved'` check would otherwise leave in the `resolvePendingPrint(...) === false` fall-through, which today has **no `else` and no log at all** — confirmed by reading `:994-1004`, there is no `else` branch on the final `if`).

**`sweepPendingPrints()` — `queueService.ts:745-751`.** Unchanged mechanism (mark-and-return in one transaction), but its meaning under D11-05 shifts: an `awaiting` row that expires without ever being resolved now means "no `printing` ever arrived AND the grace timer's own separate expiry already tried to finalize with whatever URL was held" — these are two independent timers on two different things (pending-print *URL* arrival vs. *attempt* grace) and must not be collapsed. Confirm in planning whether `PENDING_PRINT_EXPIRY_MS` (600s floor) can still fire *after* `RETAKE_GRACE_MS` (20s) has already finalized the job via door 2 — yes, because D11-05 door 2 sends "whichever URL the slot currently holds," which may be empty (no `file_upload` arrived yet); the pending-print row must stay open until the finalize's own send resolves it, not be force-closed by the grace timer.

**`logSessionSummary()` — `queueService.ts:684-697`.** Current line:
```
queueLogger.info(
  `SESSION_SUMMARY job=${jobId} outcome=${outcome} captures=${captures ?? 'unknown'}`
  + ` print_composite=${compositeSeen ? 'yes' : 'no'} duration_ms=${durationMs}`,
);
```
D11-09 appends, field order preserved: `... duration_ms=${durationMs} attempts=${attempts ?? 'unknown'} approved_by=${approvedBy}`. Needs two new inputs threaded into the method's signature: an attempt counter (mirrors the existing `captureCounts` in-memory-Map-keyed-by-jobId pattern at `:141`, or read from the persisted `pending_print`/`booth_state` row — recommend **persisted**, since D11-01 explicitly says the attempt-open flag must be persisted, and an attempt *count* that resets on restart the way `captureCounts` deliberately does (documented at `:108-140` as an accepted, stated tradeoff) would be a **regression** for `approved_by=grace` cases specifically, where a restart mid-grace is exactly the scenario D11-06's persistence requirement exists to survive) and the `approved_by` value read off the `pending_print` row at finalize time.

**Timers — storage and clearing (pattern to follow for the new grace timer).** All four existing timers follow one shape: a nullable `NodeJS.Timeout | null` instance field, a `startX()` that calls `clearX()` first then `setTimeout`, a `clearX()` that calls `clearTimeout` then nulls the field, and `stop()` (`:205-214`) clearing every one of them:
```
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
A new `releaseGraceTimer` field (name it distinctly from `releaseTimer` — they are siblings, not the same concept: `releaseTimer` is D-02's "release even if `session_end` never comes for an *already-completed* job"; the new one is "finalize via grace if `session_start` never comes back for an *unapproved, ended* attempt") must be added to this same list, with its own `startReleaseGraceTimer()`/`clearReleaseGraceTimer()` pair, and — per the header comment already on `releaseTimer` at `:66-77` — must NEVER route through `handleStall()`/`requeueWithRetry()`/`failJob()`, exactly like `releaseTimer`. Follow that comment's discipline literally for the new timer too (it explicitly forbids writing a `stall_reason`).

**`beginAnnouncement()` — `queueService.ts:843-863`.** Unchanged by this phase, but note for the plan: it already reads `this.store.getQueuedGuestSummaries()` and calls `this.sendAnnouncementCb`. D11-05's success criterion 1 ("B is not announced or dispatched before A's `printing`") is enforced entirely by `tick()`'s existing `if (booth !== 'IDLE') return;` guard at `:828` — as long as the booth stays non-IDLE for the whole grace window (i.e., `setBoothIdle()` is NOT called from the new `sessionEnded()` grace branch), this guarantee falls out of code that already exists and needs no new guard. This is worth stating explicitly in the plan because it is easy to over-build a second "is B allowed to be announced" check that duplicates `tick()`'s existing one.

### `src/state/localStore.ts` (1677 lines total, verified)

**`pending_print` table — `localStore.ts:267-275`, quoted verbatim:**
```sql
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
Status vocabulary today is exactly `'awaiting' | 'resolved' | 'expired'` (comment at `:259`, quoted: `"The status vocabulary is exactly three words: 'awaiting', 'resolved', 'expired'."`). D11-05 needs to distinguish "URL written but not yet approved" from "approved and sent" — this researcher recommends **adding**, not overloading `status`:
- `photo_url TEXT` (nullable) — written by D11-04's rewritten `onFileUpload`, independent of `status`.
- `approved_by TEXT` (nullable) — `'printing' | 'grace' | 'operator'`, written only at finalize.
- `attempt_no INTEGER` — which attempt's composite this row currently reflects, so D11-03's "composite belongs to the currently-open attempt" check can be a column comparison rather than a re-derivation.
The existing `status` column keeps its 3-word vocabulary (`'awaiting'` while open, `'resolved'` once finalized-and-sent, `'expired'` on the existing sweep) — this is additive and does not change `expirePendingPrints()`'s or `resolvePendingPrint()`'s existing SQL predicates (`WHERE status IN ('awaiting','expired')` at `:1222`), only adds columns those statements' `SET` lists can also touch.

**`openPendingPrint()` — `localStore.ts:1176-1183`, quoted verbatim:**
```
openPendingPrint(entry: { jobId: string; compositePath: string; openedAt: number; expiresAt: number }): boolean {
    const result = this.db.prepare(`
      INSERT INTO pending_print (jobId, composite_path, status, opened_at, expires_at, resolved_at, updated_at)
      VALUES (?, ?, 'awaiting', ?, ?, NULL, ?)
      ON CONFLICT(jobId) DO NOTHING
    `).run(entry.jobId, entry.compositePath, entry.openedAt, entry.expiresAt, new Date().toISOString());
    return result.changes === 1;
}
```
The header comment (`:1170-1175`) explicitly frames `DO NOTHING` as "the idempotency guarantee that exactly one slot is opened; turning it into an upsert would let the second fire silently extend the first slot's deadline and reset its composite path" — written for the double-fire case (`processing_start` then `printing` naming the *same* file). D11-02 needs a **new** method (not a change to this one's semantics) — e.g. `openOrOverwritePendingPrint()` — that upserts `composite_path`/`attempt_no`/`opened_at`/`expires_at` when the incoming `compositePath` differs from the row's current one (retake: composite genuinely changed), and behaves like today's DO-NOTHING when it is the same path (double-fire: composite unchanged). This is a real SQL-level distinction (`ON CONFLICT(jobId) DO UPDATE ... WHERE excluded.composite_path <> pending_print.composite_path`, or equivalent read-then-branch in application code) — flag this as needing a dedicated unit test pinning exactly this double-fire-vs-retake distinction, since it is the one place D11-02 and the old D-07/D-08 guarantee could silently regress into each other.

**`getPendingPrint()` — `:1192-1205`**, **`resolvePendingPrint()` — `:1218-1225`**, **`expirePendingPrints()` — `:1234-1247`**: all quoted above in the read. `resolvePendingPrint()`'s `WHERE jobId = ? AND status IN ('awaiting','expired')` predicate is the idempotency mechanism D11-05's `finalizePendingPrint()` must reuse or directly extend (rename per D11-05's own text: "Idempotent qua cổng `finalizePendingPrint(jobId)` trả boolean, thay `resolvePendingPrint`" — the D11-05 decision explicitly says this method **replaces** `resolvePendingPrint`, not wraps it as a second layer).

**`booth_state` table — `localStore.ts:240-244`, quoted verbatim:**
```sql
CREATE TABLE IF NOT EXISTS booth_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    state TEXT NOT NULL DEFAULT 'IDLE',
    updated_at TEXT NOT NULL DEFAULT 'now'
);
```
`current_job_id` was added via migration at `localStore.ts:494-505`, quoted verbatim:
```
const boothColumns = this.db.prepare('PRAGMA table_info(booth_state)').all() as Array<{ name: string }>;
const hasCurrentJobId = boothColumns.some((c) => c.name === 'current_job_id');
if (!hasCurrentJobId) {
  this.db.exec('ALTER TABLE booth_state ADD COLUMN current_job_id TEXT');
}
```
**This is the exact idiom to copy for `attempt_open`.** Add, in `migrate()` immediately after this block:
```
const hasAttemptOpen = boothColumns.some((c) => c.name === 'attempt_open');
if (!hasAttemptOpen) {
  this.db.exec('ALTER TABLE booth_state ADD COLUMN attempt_open INTEGER NOT NULL DEFAULT 0');
}
```
(NOT NULL DEFAULT 0 is safe here — SQLite accepts a `NOT NULL ADD COLUMN` when a `DEFAULT` is supplied, the same reasoning already used for `event.show_guest_name`/`hero_enabled` at `:521-526`, quoted: `"SQLite accepts a NOT NULL ADD COLUMN precisely because a DEFAULT is supplied, so every pre-existing row reads back as ON (today's behaviour) with no backfill statement required."` — the equivalent read-back-as-0/false-on-every-existing-row is exactly the correct migration-safety property for `attempt_open` on a database with no attempt in progress at deploy time.)

`getBoothCurrentJobId()`/`setBoothCurrentJob()`/`setBoothIdle()`/`setBoothBusy()` (`:868-921`, all quoted above) all use bare `INSERT OR REPLACE INTO booth_state (id, state, updated_at, current_job_id) VALUES (1, ..., NULL)` or `UPDATE ... SET current_job_id = ...` — **every one of these writers must be updated to also carry `attempt_open`**, because `INSERT OR REPLACE` "deletes the row and inserts a new one, so any column left out of the column list silently reverts to its default" (comment at `:873-876`, quoted verbatim — this is the exact hazard: adding `attempt_open` to the schema without adding it to every existing `INSERT OR REPLACE` writer would silently zero it on the next `setBoothState()`/`setBoothBusy()`/`setBoothIdle()` call, which is called on **every** tick-adjacent state transition).

**`closeJobNoPhoto()` — `:707-712`** and **`completeJob()` — `:657-662`**, both quoted verbatim above. Both guard on `AND status = 'in_progress'`. D11-05's `finalizePendingPrint()` needs to call one of these two (not both) depending on whether the slot ever got a `photo_url` — this is an unchanged branch, just now called from the new finalize gate instead of from `onPrintComposite()`/wherever completion used to live.

**`KNOWN_JOB_STATUSES` — `src/status/guestStatus.ts:82-89`, quoted verbatim:**
```
export const KNOWN_JOB_STATUSES = [
  'queued',
  'dispatched',
  'in_progress',
  'completed',
  'failed',
  'no_photo',
] as const;
```
**No change needed** — D11-05's three finalize doors all resolve to the SAME two existing outcomes (`completed` or `no_photo`); `approved_by` is a `pending_print` column, not a `queue_job.status` member, so this array and its `STATUS_MAP`/`toGuestStatus()`/`toPhotoDelivery()` exhaustiveness machinery (`guestStatus.ts:106-172`, read and quoted above) are untouched by this phase. Confirm this explicitly in the plan so nobody attempts to add a seventh status for "retaken" — D11-05's own text is clear the outcome vocabulary does not grow.

**`BoothState` type — `src/types.ts:1`, quoted verbatim:**
```
export type BoothState = 'IDLE' | 'ANNOUNCING' | 'BUSY' | 'TIMEOUT_RESET';
```
See Risk R3 — recommendation is to NOT add a fifth value here.

### `src/config.ts` / `src/types.ts` — adding `RETAKE_GRACE_MS`

Confirmed pattern for a numeric `.env`-configurable key (`config.ts:132-140`, quoted verbatim):
```
SESSION_TIMEOUT_MS:       toNum('SESSION_TIMEOUT_MS',  300_000),
NEXT_GUEST_COUNTDOWN_MS:  toNum('NEXT_GUEST_COUNTDOWN_MS', 7000),
SESSION_MAX_RETRIES:      toNum('SESSION_MAX_RETRIES', 2),
BOOTH_RELEASE_TIMEOUT_MS: toNum('BOOTH_RELEASE_TIMEOUT_MS', 120_000),
```
`toNum()` itself (`config.ts:10-19`, quoted): parses with `Number.parseInt(val, 10)`, pushes a startup error string to `errors[]` on `NaN`, else falls back to the default. Add `RETAKE_GRACE_MS: toNum('RETAKE_GRACE_MS', 20_000),` here, and the matching `RETAKE_GRACE_MS: number;` member to `EnvConfig` in `types.ts` (insert near `BOOTH_RELEASE_TIMEOUT_MS` at `types.ts:233`, following the same inline-comment style already used there).

**This is a different injection shape than `PENDING_PRINT_EXPIRY_MS`/`NO_PHOTO_CLOSE_DELAY_MS`.** Those two are deliberately *module constants*, not `EnvConfig` members — `queueService.ts:24-29` states this explicitly: `"D-12: deliberately a module constant and a constructor seam, NOT a key in src/config.ts. There is no environment variable and no runtime toggle for it."` D11-06's own text says the opposite for `RETAKE_GRACE_MS` — `"cấu hình qua .env"`, `"Có thể hạ tại sự kiện qua .env không cần build lại"` — i.e. it MUST be a real `.env` key. Add `'RETAKE_GRACE_MS'` to the `QueueService` constructor's `Pick<EnvConfig, ...>` type union (`queueService.ts:166`) alongside `SESSION_TIMEOUT_MS`/`NEXT_GUEST_COUNTDOWN_MS`/`SESSION_MAX_RETRIES`/`BOOTH_RELEASE_TIMEOUT_MS` — **not** the `& { ... }` intersected-optional shape used for the two module constants.

**No production fail-fast is needed for `RETAKE_GRACE_MS`** — it has a site-independent default (20000ms) that is correct out of the box, matching the reasoning already used for `BOOTH_RELEASE_TIMEOUT_MS` and `VIEW_PROBE_INTERVAL_MS` (neither has a `required()`/fail-fast check).

**SIGHUP hot-reload does NOT apply.** Confirmed by reading `src/ops/logLevelControl.ts` in full — `LOG_LEVEL` is the only key `reloadLogLevelFromEnvFile()` ever reads (comment at `:28-29`: `"Only the LOG_LEVEL key is ever read from the parsed file — no other key, and no file content, reaches a log line."`). `RETAKE_GRACE_MS` is read once at `getConfig()`/process-startup time like every other timing value in this codebase (`SESSION_TIMEOUT_MS`, `BOOTH_RELEASE_TIMEOUT_MS`, etc. — none of them are SIGHUP-reloadable). D11-06's "không cần build lại" means "no rebuild, just a restart" — **not** "no restart." State this explicitly to the planner so nobody plans a SIGHUP-reload feature for this key that doesn't exist for its siblings.

### `src/cms/` — the "end this guest" button

**Current wiring, verified in `src/app.ts:230`:**
```
app.use('/cms', createCmsIpGate(config.CMS_IP_WHITELIST), createCmsRouter(store, config, agentServer));
```
`store` here is the plain `LocalStore` instance (satisfies `CmsEventStore & CmsAgentStore & CmsPhotoStore` structurally — three separate narrow interfaces, each declared beside its own route file). **`QueueService` (the `queue` variable built in `index.ts:25`) is NOT currently passed into `createCmsRouter` at all.** This is the load-bearing finding for D11-08: today's CMS interfaces (`CmsEventStore`, `CmsAgentStore`, `CmsPhotoStore`) are all narrow views over `LocalStore`, deliberately excluding queue mutation — `cmsEventRoutes.ts:30-42` states this explicitly: `"Note what is absent: no queue MUTATION, no booth-state method, no registration method... a CMS route cannot enqueue, requeue, complete or fail a job because it was never handed a way to."` D11-08 needs the **first** CMS-reachable queue mutation this codebase has ever had, and it must go through `QueueService`, not `LocalStore` directly (mutating `booth_state`/`pending_print` straight from a CMS route would bypass `QueueService`'s in-memory timer state — `releaseGraceTimer` must be cleared by the same object that started it, or the timer fires later on an already-finalized job).

**Plan implication:** `app.ts` must additionally pass `queue` into `createCmsRouter`, and a new `createCmsBoothRoutes(queue: CmsBoothLink)` file (sibling of `createCmsAgentRoutes`/`createCmsEventRoutes`/`createCmsPhotoRoutes`) must be created and mounted in `cmsRouter.ts` after `requireSession()`, following the exact same shape as `createCmsAgentRoutes` (`cmsAgentRoutes.ts:1-45`, quoted above): a **narrow interface** (`CmsBoothLink`) exposing only what D11-08 needs — e.g. `getBoothStallInfo(): { jobId: string; guestName: string; waitingSinceMs: number } | null` (a read) and `releaseForOperator(jobId: string): boolean` (the one write, calling D11-05 door 3 → `finalizePendingPrint(jobId, 'operator')`).

**Auth/IP-gate/CSRF, already in place and reusable as-is (no new mechanism needed):**
- IP gate: `cmsIpGate.ts:28-40`, mounted in front of the whole `/cms` router in `app.ts:230` — reused automatically, no per-route wiring.
- Session auth: `cmsRouter.ts:241`, `router.use(createRequireSession(sessions, cookieName));` — mounted once, before every route-factory call; a new `createCmsBoothRoutes` mounted after this line inherits it for free, exactly like `createCmsAgentRoutes`/`createCmsPhotoRoutes` do today.
- CSRF: **there is no CSRF-token library in this codebase.** `cmsAuth.ts:228-232`, quoted verbatim: `"SameSite=Lax is the CSRF control for the mutating /cms routes (T-08-05), chosen over a CSRF-token library because this is a single-operator console with no public write surface."` D11-08's POST route needs no new CSRF mechanism — it inherits the cookie's `SameSite=Lax` the same way `POST /cms/api/agent` does.

**How the CMS reads queue state today:** confirmed the ONLY queue-shaped read any existing CMS route has is `getQueueLength()` (`cmsEventRoutes.ts:37-53`, interface `CmsEventStore`, quoted: `"getQueueLength() is the one queue-shaped member, and it is a READ."`). No existing CMS surface reads `booth_state` or an individual job at all. `healthRoute.ts:63,175` also reads `getBoothState()` but that is an internal `/health` probe, not a CMS page. D11-08's "shows guest name + elapsed wait" requirement needs a genuinely new read path — `QueueService` does not currently expose per-job elapsed-wait or guest-name-while-BUSY; `getJobRegistration()` on `LocalStore` (used internally by `queueService.ts` at several sites, e.g. `:874`, `:1046`) is the existing join to reuse for the name, and `acknowledged_at` (already read at `:686`, `logSessionSummary`'s own pattern: `Date.now() - acknowledgedAt`) is the existing timestamp to reuse for elapsed wait — do not invent a second wait-clock.

**Which page hosts the button:** no existing CMS page renders booth/queue status today (`cmsPages.ts` is the login page only, per its 274-line size and the fact that `CmsEventStore`'s only queue-shaped read is a bare count used in two numeric displays at `cmsEventRoutes.ts:324,368`). This is a **new page or a new section of an existing dashboard page** — flag this to the planner as UI surface, not just an API route; D11-08's ROADMAP success criterion 4 ("The CMS shows and acts on 'end this guest'") requires a rendered element, not only the POST endpoint.

### `src/display/displayServer.ts` — grace vs BUSY, recommendation

`displayServer.ts:191`, quoted: `boothState: this.store.getBoothState(),` — this is a **direct, untransformed** read of the same `BoothState` union every other consumer reads. Every consumer of `BoothState` in the codebase (verified by grepping every equality/inequality check against it — `statusRoute.ts:151,203`, `queueService.ts:243,256,548,828`, `healthRoute.ts`, `displayServer.ts:191`) uses **plain equality checks**, never an exhaustive `switch`, so adding a value to the union would not be a compile error anywhere — but it WOULD silently change behavior at three specific call sites that were not written with a fifth state in mind:
1. `queueService.ts:548`, `onAgentDisconnected()`: `if (this.store.getBoothState() !== 'BUSY') return;` — if grace were modeled as a distinct 5th state (e.g. `'GRACE'`), an Agent disconnect *during* the grace window would fail this guard and the grace timer would be silently orphaned (never cleared, fires later against a booth state that has since moved on).
2. `queueService.ts:828`, `tick()`: `if (booth !== 'IDLE') return;` — this one is SAFE either way (a 5th state also satisfies `!== 'IDLE'`), but is a second place that would need auditing if grace were a new top-level state.
3. `statusRoute.ts:203`: `const inFlight = boothState === 'BUSY' || boothState === 'ANNOUNCING' ? 1 : 0;` — feeds the guest-facing wait estimate; a `'GRACE'` state would need to be added here too or the estimate silently undercounts by one in-flight session during every grace window.

**Recommendation (this researcher, not yet a locked decision): keep `booth_state.state` at `'BUSY'` throughout the grace window; do not add a 5th `BoothState` value.** Represent "attempt open vs. in grace" purely via the new `attempt_open` column (D11-01 already specifies this exact shape: "cờ persist trong `booth_state`... không phải biến in-memory"). This means:
- `onAgentDisconnected()`'s existing `!== 'BUSY'` guard keeps working unmodified during grace — an Agent disconnect while unapproved-and-in-grace is still treated as a genuine disconnect (requeue-no-retry, same as today).
- `statusRoute.ts`'s wait estimate keeps counting a grace-window job as in-flight, which is correct (a guest is still, in fact, at the booth or just having left it).
- `displayServer.ts:191` needs **zero code change** to keep broadcasting a sane `boothState` — it already sends `'BUSY'`, which is correct for the room screen's purposes (nothing needs to visually distinguish "shooting" from "in grace" today; that distinction is CMS-only, D11-08's whole reason to exist).
- The CMS's D11-08 button reads `attempt_open` (a field `BoothState`'s consumers never had before) rather than a `BoothState` value, so it needs its own new read path anyway (confirmed above — no existing CMS surface reads per-job state), and that new path can read `attempt_open` + `session_ended_at`-is-null-ness directly.

If the plan instead wants a `'GRACE'` state for observability, the three call sites above must each be updated in the same plan-task, and `statusRoute.ts`'s guest-facing wait estimate needs a decision about whether a grace-window job still counts as 1 in-flight (this researcher recommends yes, to avoid a guest's queue-position estimate jittering during someone else's retake).

### `src/notifications/` — where finalize should send from

`notificationService.sendPhotoLink(jobId, photoUrl)` (`notificationService.ts:47` on) is the unchanged public contract `QueueService.sendNotification()` (`queueService.ts:1105-1109`, quoted verbatim: `sendNotification(jobId, photoUrl) { if (this.notificationService) { await this.notificationService.sendPhotoLink(jobId, photoUrl); } }`) already wraps. The photo-history write is `recordPhotoHistory()` → `writePhotoHistory()` (`queueService.ts:1029-1083`, quoted above), which itself calls `store.recordEventPhoto()` then fires-and-forgets `resolvePhotoImageUrl()`. **D11-05's `finalizePendingPrint()` should call this exact same pair — `this.recordPhotoHistory(jobId, photoUrl)` then `void this.sendNotification(jobId, photoUrl)` — once, from the one finalize gate, replacing the two duplicate call sites currently inside `onFileUpload()` (`:988-991` and `:1000-1003`).** No change to `recordPhotoHistory`/`writePhotoHistory`/`sendNotification` themselves is needed — only the call site moves.

## Architecture Patterns

### System Architecture Diagram

```
dslrBooth (booth PC)
   │  Agent WS events (session_start, processing_start, file_upload,
   │  printing, session_end — verbatim relay, no filtering)
   ▼
AgentServer (registerEventHandler) ──▶ QueueService.onAgentEvent(eventType, jobId, payload)
                                              │
                    ┌─────────────────────────┼──────────────────────────────┐
                    ▼                         ▼                              ▼
          session_start/session_end   processing_start/printing       file_upload(print)
          → attempt open/close        → composite anchor split        → WRITE URL ONLY
          (booth_state.attempt_open,  (D11-02/07: extract composite,   (D11-04: no send;
           D11-01/06 grace timer)      open/overwrite pending_print;   pending_print.photo_url)
                    │                  printing: D11-03 guard →                │
                    │                  finalizePendingPrint door 1)            │
                    │                         │                                │
                    └────────────┬────────────┴────────────────────────────────┘
                                 ▼
                    finalizePendingPrint(jobId, door)   ◀── door 2: grace timer expiry (D11-06)
                       (D11-05, idempotent gate)        ◀── door 3: CMS "end this guest" (D11-08)
                                 │
              ┌──────────────────┼───────────────────────┐
              ▼                  ▼                        ▼
      completeJob/           recordPhotoHistory        release booth
      closeJobNoPhoto        + sendNotification         (setBoothIdle)
      (LocalStore, D-09)     (existing, unchanged)       + tick()
                                                              │
                                                              ▼
                                                   next guest announced/dispatched
                                                   (existing tick()/beginAnnouncement,
                                                    unchanged — guarded by booth !== IDLE
                                                    for the entire grace window)

Operator ──POST /cms/api/booth/release──▶ createCmsBoothRoutes (NEW)
   (CMS dashboard button, D11-08)              │  (session auth + IP gate, both existing/reused)
                                                ▼
                                     QueueService.releaseForOperator(jobId)
                                                │
                                                ▼
                                     finalizePendingPrint(jobId, 'operator')  [door 3, above]
```

### Recommended Project Structure

No new top-level directories. New files:
```
src/queue/queueService.ts        — extended (no new file; see method list above)
src/state/localStore.ts          — extended (migration + new/changed accessors)
src/config.ts, src/types.ts      — extended (RETAKE_GRACE_MS)
src/cms/cmsBoothRoutes.ts        — NEW, sibling of cmsAgentRoutes.ts/cmsEventRoutes.ts
src/cms/cmsBoothPages.ts         — NEW (or extend cmsPages.ts / a dashboard page), if D11-08's UI needs its own render function — sibling of cmsAgentPages.ts
test/queue-retake-anchor.test.ts — REWRITTEN (D11-10)
test/queue-dual-completion.test.ts, test/queue-file-upload-print.test.ts,
test/queue-release-timer.test.ts, test/queue-no-photo-outcome.test.ts,
test/queue-countdown.test.ts, test/queue-session-start-hijack.test.ts,
test/queue-event-photo.test.ts, test/queue-print-registry-expiry.test.ts,
test/queue-event-coverage.test.ts, test/local-store-persistence.test.ts
                                  — ALL REQUIRE ASSERTION CHANGES (see §5, Test Infrastructure)
test/cms-booth-release.test.ts   — NEW, for D11-08
test/queue-retake-grace-timer.test.ts (or folded into queue-release-timer.test.ts)
                                  — NEW, for D11-06's timer
```

### Pattern 1: Persisted flag on the existing single-row state table, not a new enum value

**What:** `booth_state.attempt_open INTEGER NOT NULL DEFAULT 0`, written by every `booth_state` writer alongside `current_job_id`, read back by `recover()` at startup.
**When to use:** Any boolean sub-state of an existing state machine that (a) must survive a restart and (b) must not multiply the number of values every existing equality-check consumer has to handle.
**Example (the model to follow, `current_job_id`'s own migration):**
```typescript
// Source: src/state/localStore.ts:501-505 (verified this session)
const boothColumns = this.db.prepare('PRAGMA table_info(booth_state)').all() as Array<{ name: string }>;
const hasCurrentJobId = boothColumns.some((c) => c.name === 'current_job_id');
if (!hasCurrentJobId) {
  this.db.exec('ALTER TABLE booth_state ADD COLUMN current_job_id TEXT');
}
```

### Pattern 2: One idempotent finalize gate, three callers, one audit column

**What:** `finalizePendingPrint(jobId, door)` — single choke point for "send this guest's photo and close their job," callable from three independent triggers, returning `boolean` (matched-and-finalized vs. no-op), writing which door fired into a durable column.
**When to use:** Whenever a real-world outcome ("guest approved") can legitimately be signaled through more than one channel (a hardware trigger, a timeout, a human override) and double-firing must be structurally impossible, not merely unlikely.
**Example (the model to follow, `resolvePendingPrint`'s existing idempotency SQL — extend, do not duplicate):**
```typescript
// Source: src/state/localStore.ts:1218-1225 (verified this session) — the predicate
// finalizePendingPrint's SQL should reuse/extend
resolvePendingPrint(jobId: string, resolvedAt: number): boolean {
    const result = this.db.prepare(`
      UPDATE pending_print
      SET status = 'resolved', resolved_at = ?, updated_at = ?
      WHERE jobId = ? AND status IN ('awaiting','expired')
    `).run(resolvedAt, new Date().toISOString(), jobId);
    return result.changes === 1;
}
```

### Anti-Patterns to Avoid

- **Re-deriving the "which param is the composite" logic separately in `onPrintComposite()` and `agentEventDetail()`.** Today's code already does this (two independent `str('param5')`/`str('param1')` reads). D11-07 is the moment to extract one shared function; duplicating the new scan-and-fallback rule twice is how the two copies drift (exactly what happened with `param5` never being updated when layouts changed).
- **Writing `approved_by` onto `queue_job.stall_reason`.** `stall_reason` is a closed, server-authored vocabulary documented in OPS-RUNBOOK §6 (verified: `stall_reason` values enumerated at `docs/OPS-RUNBOOK.md:427-438`, and the file states an empty `stall_reason` on a terminal job is already meaningful — "not a bug" — for the two Phase 7 non-stall close paths). D11-05's `approved_by` is a `pending_print` column, a different vocabulary, for a different question ("who approved," not "why did this stall").
- **Modeling grace as a new `BoothState` value without auditing all three call sites in Risk R3.** See the dedicated recommendation above.
- **Mutating `booth_state`/`pending_print` directly from a CMS route instead of through `QueueService`.** The grace timer is in-process state on the `QueueService` instance; a direct SQL write from `cmsBoothRoutes.ts` would leave the timer running and fire later against an already-finalized job. D11-08 must call a `QueueService` method, following the existing CMS→Agent pattern (`cmsAgentRoutes.ts`'s `askAgentToReload()` calling into `agent.sendEvent()`, never touching `agent_config` SQL and business rules directly from the route).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|--------------|-----|
| Idempotent "has this already been sent" check | A boolean flag checked-then-set in application code | SQL `WHERE status IN (...)` predicate that returns `changes === 1` (the existing `resolvePendingPrint`/`completeJob`/`closeJobNoPhoto` pattern) | This codebase's own established idiom — "omission as guarantee" (Phase 7 canonical_refs, `07-CONTEXT.md`: "structural guarantees are expressed by what the SQL leaves out, never by an `if` a later edit can delete") — a second, application-level flag is a second thing that can drift from the SQL truth. |
| CSRF protection for the new `POST /cms/api/booth/release` route | A CSRF-token library | The existing `SameSite=Lax` session cookie (`cmsAuth.ts:228-232`) | Already the accepted, documented control for every other mutating `/cms` route; adding a token mechanism for one route only would be inconsistent and unnecessary for a single-operator console with no public write surface. |
| Deciding which JSON param on `processing_start` holds the composite | A second hardcoded param index (`param2`, since that is what layout 1 uses) | The scan rule D11-07 specifies: last param whose value contains `\Prints\`, else last non-empty param | A second hardcode just moves today's bug to a different layout; the vendor doc's own wording ("param1 originals (optional), param2 final_file") already tells you the position is layout-dependent, so ANY fixed index will eventually break on a 5th layout style. |

**Key insight:** every "don't hand-roll" item here already has a codebase-native answer — this phase is not introducing new categories of problem, only new call sites for two existing mechanisms (durable idempotent SQL predicates, and the existing CMS auth stack).

## Common Pitfalls

### Pitfall 1: Composite-path comparison must be exact-string on a normalized form, not raw-string

**What goes wrong:** D11-03's guard requires `printing.param1` to equal the `composite_path` `processing_start` wrote. If the comparison is naive `===` on the raw strings, a benign difference (trailing whitespace already handled by the existing `.trim()` at `queueService.ts:433`; but NOT Windows path-separator case, and NOT a `_1x`/`_2x` filename suffix) will make a legitimate approval silently fail D11-03 and finalize nothing — the exact opposite of D11-05's SC-1 ("A receives exactly one notification").

**Why it happens:** the operator's own evidence and the current `onFileUpload()` doc comment record a real suffix variance: `queue-file-upload-print.test.ts:16` (comment, quoted) shows `param1 = C:\dslrBooth\Test_event\Prints\20260812_131547_837_1x.jpg` on a `file_upload`, while `processing_start`/`printing` composite paths in the SAME evidence session (`07-EVIDENCE-dslrbooth-triggers.md` §A, `param5`/`printing.param1`) both read `...Prints\20260812_143526_970.jpg` — **no `_1x`/`_2x` suffix** on the composite itself in the measured captures this researcher read. The suffix is confirmed to exist on `file_upload`'s path (a different event, a different field, not compared under D11-03 at all — D11-03 only compares `processing_start`'s composite path against `printing.param1`, never against `file_upload`'s `param1`). **This researcher did not find a measured case where `processing_start`'s composite and `printing.param1` differ by a suffix from each other** — every quoted evidence line (§A, §C, §D) shows them byte-identical. This is `[ASSUMED]` risk, not `[VERIFIED]` risk: the additional_context's specific concern (`_094130_744_1x.jpg` vs `_2x.jpg`) was not found in `07-EVIDENCE-dslrbooth-triggers.md` as read this session — it may be from a log this researcher did not have access to, or may be conflating the `file_upload` suffix with the composite comparison. **Recommend defensively: normalize both sides (trim, and compare only the filename component or a case-insensitive backslash-normalized full path) rather than relying on byte-exact `===`,** because the failure mode (finalize silently not firing) is worse than the cost of a normalize step, and because Windows path separators crossing a WS relay are a documented general risk class even where no specific instance was measured here.

**How to avoid:** write `finalizePendingPrint`'s D11-03 comparison as a normalized-path equality (e.g., `path.win32.basename()`-equivalent, or a lowercase-and-backslash-collapsed string compare), and add a unit test asserting the comparison holds even with a trailing-slash/case difference. **Do not** assume byte-exact equality is safe without this normalization, but also do not assume the `_1x`/`_2x` suffix issue affects this specific comparison — verify against a fresh live capture before hardening further (this is Q3-adjacent: worth folding into the operator's next measurement pass).

**Warning signs:** `printing ignored: composite X is not this attempt's Y` firing on what the operator confirms was a normal, un-interrupted session (not a gallery reprint) — that log line, which D11-03 mandates, is exactly the trip-wire that will surface this pitfall in production if it exists.

### Pitfall 2: `stop()`/`recover()` with a persisted open attempt after a restart mid-grace

**What goes wrong:** the process restarts while `booth_state.attempt_open = 0` (attempt already ended) but the grace timer that was supposed to fire `finalizePendingPrint(jobId, 'grace')` was in-memory and is now gone. On restart, `recover()` (`queueService.ts:237-268`) reads `booth_state` and `getInFlightJobs()`, but its current logic only distinguishes `BUSY` (possibly-live, re-arm `busyTimer`) from everything else (sweep via `handleStall`). **A job that is `in_progress`, `current_job_id` still set, `attempt_open = 0` (grace was running, not yet expired) has no branch in today's `recover()` at all** — it would fall into the `isPossiblyLive` branch (since `booth_state.state` is still `'BUSY'` per Pattern-1's recommendation) and get re-armed with `startBusyTimer()`, which is the WRONG timer — the guest already ended their attempt; what should resume is the grace countdown (or, simpler and safer: immediately re-evaluate as if the grace timer had just expired, since the exact remaining time cannot be reconstructed without also persisting `attempt_ended_at`).

**Why it happens:** `recover()` was written in Phase 7 for a strictly simpler state space (dispatched → in_progress → completed, one fallback timer). D11-01/06 add a state (unapproved-attempt-ended, grace pending) that `recover()`'s current `BUSY`/`else` binary does not model.

**How to avoid:** persist `attempt_open` AND (recommend) a nullable `attempt_ended_at` timestamp on `booth_state` (or read it off `queue_job.session_ended_at`, which is already written by `updateJobStatus`'s `session_ended_at` field per the `map` in `updateJobStatus()` at `:610-618` — confirms this timestamp already exists in the schema and is already wired, just not currently populated on the D11-06 grace path since today's code calls `setBoothIdle()` instead). `recover()` needs a third branch: `state === 'BUSY' && attempt_open === 0 && current_job_id !== undefined` → the process crashed mid-grace; either immediately finalize via door 2 (simplest, safe-by-design: a restart mid-grace is rare and "finalize now with whatever URL is held" is never wrong, only possibly early) or re-arm a fresh, full-length grace timer (more guest-friendly, slightly more code). Flag this decision as an open item for the plan — this researcher recommends immediate-finalize-on-recovery for simplicity, since `RETAKE_GRACE_MS` is short (20s default) and a restart is already a rare, disruptive event during which losing the remainder of a 20s grace window is a minor cost next to the complexity of persisting and restoring the exact remaining countdown.

**Warning signs:** a job stuck `in_progress` forever after any service restart that happened to land inside a grace window — would show up as a `queue_job` row with no terminal status and a `session_ended_at` set but a fresh `dispatched_at` never following it, greppable via the same `pm2 restart`-adjacent SQL query pattern OPS-RUNBOOK §10 already uses for stuck jobs.

### Pitfall 3: `printing`'s composite-path check must fire even when NO attempt has ever been open for that job (Evidence §E)

**What goes wrong:** §E (gallery reprint, no `session_start`, `printing.param1` names a composite from 18 minutes earlier) must produce `printing ignored: no attempt open`, not `printing ignored: composite X is not this attempt's Y` — using the wrong reason string in the log makes D11-05's ROADMAP success criterion 2 ("finalizes nothing and logs why") technically true but operationally confusing (an operator reading `composite X is not this attempt's Y` will look for the "real" attempt that doesn't exist).

**Why it happens:** D11-03's two conditions are AND'd, but the two failure messages must be produced by checking them in the right order and with the right guard — check "is an attempt open at all" FIRST (using `booth_state.attempt_open`, independent of whether `current_job_id` even matches), and only check "does the composite match" if an attempt IS open. Getting this backwards (checking composite match first, defaulting to a generic message when no attempt is open) produces a `NaN`-vs-`Y` style comparison against an undefined `Y`, or a misleading message.

**How to avoid:** structure the guard as two sequential early-returns exactly mirroring D11-03's own two clauses, in the order stated in `11-CONTEXT.md`: "(a) attempt đang mở, (b) `printing.param1` trùng `composite_path`... Sai một trong hai → bỏ qua" (order (a) then (b) — check attempt-open first). Write the two distinct log messages verbatim as D11-03 specifies them.

**Warning signs:** the live-booth gate step 3 (`11-CONTEXT.md` `<verification>` item 3 — operator reprints A's photo while B is mid-session) producing the wrong one of the two messages.

## Code Examples

### Extending a persisted single-row state table (the exact migration idiom to copy)

```typescript
// Source: src/state/localStore.ts:494-505 (verified this session, current code)
const boothColumns = this.db.prepare('PRAGMA table_info(booth_state)').all() as Array<{ name: string }>;
const hasCurrentJobId = boothColumns.some((c) => c.name === 'current_job_id');
if (!hasCurrentJobId) {
  this.db.exec('ALTER TABLE booth_state ADD COLUMN current_job_id TEXT');
}
```

### The QueueService timer pattern (copy exactly for the grace timer)

```typescript
// Source: src/queue/queueService.ts:903-916 (verified this session, current code —
// releaseTimer is the sibling to model releaseGraceTimer after)
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

### The CMS route-factory pattern (copy for `createCmsBoothRoutes`)

```typescript
// Source: src/cms/cmsAgentRoutes.ts:131-160,198-215 (verified this session, current code)
export function createCmsAgentRoutes(store: CmsAgentStore, agent: CmsAgentLink): ReturnType<typeof Router> {
  const router = Router();
  router.get('/agent', (_req: Request, res: Response) => { /* ... */ });
  router.post('/api/agent', (req: Request, res: Response) => { /* validate, mutate, log, respond */ });
  router.post('/api/agent/restore', (_req: Request, res: Response) => { /* idempotent-by-construction (409 on nothing-to-restore) */ });
  return router;
}
```
`createCmsBoothRoutes(queue: CmsBoothLink)` should follow this exact shape: a `GET` for the dashboard's current-stall-info read, a `POST /api/booth/release` that calls the queue's one write method and returns a JSON status (mirroring `res.status(200).json({ saved: true, ... })`'s pattern), mounted in `cmsRouter.ts` right after `createCmsAgentRoutes(store, agent)` at `cmsRouter.ts:243`.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| One completion anchor (`processing_start` OR `printing`, either one calls `completeJob`) | Two anchors, split by role: `processing_start` = composite exists; `printing` = guest approved (conditionally) | This phase (D11-02), replacing Phase 7 D-01 | Every test and code path that assumed "composite seen = done" must be re-derived through the new finalize gate. |
| `session_end` = immediate release (D-02, unconditional) | `session_end` = immediate release ONLY if already approved; otherwise starts grace | This phase (D11-06), extending Phase 7 D-02 | `sessionEnded()`'s single unconditional `setBoothIdle()` call becomes a two-branch method. |
| `param5` hardcoded for `processing_start` composite | Scan for the param pointing into `\Prints\`, fallback to last non-empty | This phase (D11-07) | Fixes SC-5's "no usable composite path" warning on both 4-shot and 1-shot layouts, measured to fail 4/4 times on 2026-08-18 with the old hardcode. |
| `file_upload param3=print` sends immediately on first arrival | Writes URL to slot only; sending happens at finalize | This phase (D11-04) | Removes the race where the rejected attempt's photo could reach the guest before the kept attempt's `printing` fires. |

**Deprecated/outdated:** the entire single-anchor mental model documented in `07-CONTEXT.md` D-01 ("The print composite is the completion anchor... either one completes the job") is superseded by D11-01…D11-05. Do not use `07-CONTEXT.md`'s D-01 text as a reference for new code — it is retained in that file as history, and `11-CONTEXT.md` explicitly records it as "Bị thay."

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|----------------|
| A1 | `printing.param1` never carries a `_1x`/`_2x` suffix that `processing_start`'s composite path lacks (Pitfall 1) — this researcher found no measured instance of such a divergence in `07-EVIDENCE-dslrbooth-triggers.md`, only a suffix on a *different* field (`file_upload`'s `param1`) in a *different* test file's comment. | Common Pitfalls, Pitfall 1 | If wrong, D11-03's exact-match guard silently blocks every legitimate `printing` approval, and the phase's primary success criterion (SC-1: exactly one notification) fails at the live-booth gate rather than in a unit test. Mitigation already recommended: normalize the comparison regardless. |
| A2 | A restart mid-grace-window should immediately finalize via door 2 rather than resuming a partial countdown (Pitfall 2) — no locked decision exists on this in `11-CONTEXT.md`; this is this researcher's own recommendation, made for simplicity. | Common Pitfalls, Pitfall 2 | If the operator would prefer resuming the countdown (guest-friendliness), the simpler immediate-finalize choice could cut a legitimately-retaking guest's window short during the rare restart-during-grace case. Low real-world frequency (grace is 20s; a restart landing inside it is rare), but should be confirmed with the operator during planning, not assumed silently. |
| A3 | `BoothState` should NOT gain a 5th `'GRACE'` value; `attempt_open` alone is sufficient (Risk R3 recommendation). | Architecture Patterns, `src/display/displayServer.ts` section | If the operator wants the room screen or CMS to visually distinguish "attempt in progress" from "grace window open," this recommendation under-serves that UX need and a `BoothState` extension (with the three call-site audits already listed) would be required instead. |
| A4 | D11-08's UI needs a new page/dashboard section (not just an API route) to satisfy ROADMAP SC-4 ("The CMS shows... 'end this guest'"). | Codebase Specifics, `src/cms/` section | Low risk — this is a direct reading of the ROADMAP text ("shows AND acts on"), not a speculative claim, but flagged since no UI-SPEC exists yet for this phase and the planner may want to route this through `gsd-ui-phase` rather than plan it inline. |

**If this table is empty:** N/A — see above, four items logged.

## Open Questions (RESOLVED — deferred to 11-CONTEXT.md flagged assumptions A2/A3/Q3; A1 resolved by evidence 15)

Per the researcher instructions, Q1–Q4 from `11-RESEARCH-OPERATOR.md` are kept as-is and not repeated in full here (see that file, §5). This researcher found no additional question the codebase forces — the four items above (Assumptions Log) are flagged as assumptions requiring confirmation, not as new open questions, because each has a concrete, actionable default recommendation the planner can proceed with.

## Environment Availability

Not applicable in the external-dependency sense — this phase touches only the already-running Extension Service (Node 20, better-sqlite3, express, ws — all already installed and verified present via `package.json`/existing test suite green runs) and the CMS's existing auth stack. The one genuinely external dependency — the physical dslrBooth booth with auto-print OFF — is an **operational precondition**, not a software dependency, and is already tracked in `DEPLOYMENT.md` (§7/§9, lines 418-434, confirmed present and already referencing this phase) and `11-CONTEXT.md`'s own `<verification>` section.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest ^2.1.4 (confirmed via `vitest.config.ts`, same as Phase 7) |
| Config file | `mirror-request/vitest.config.ts` — fixed `LOCAL_STORE_PATH: './data/test-extension-service.sqlite'`, `LOG_LEVEL: 'error'`, `globalSetup: ['./test/global-teardown.ts']` (removes per-test SQLite files the constructor-seam pattern creates) |
| Quick run command | `cd /opt/mirror_request_dslrobooth/mirror-request && npx vitest run test/<file>.test.ts` |
| Full suite command | `cd /opt/mirror_request_dslrobooth/mirror-request && npm test` |
| Two test harness shapes, confirmed by reading | (1) **Mocked `LocalStore`** — a hand-built object satisfying the surface `QueueService` needs, driven through the REAL `QueueService` with `vi.useFakeTimers()`/`vi.advanceTimersByTime()` (pattern in `queue-release-timer.test.ts`, `queue-dual-completion.test.ts`, `queue-retake-anchor.test.ts`, `queue-file-upload-print.test.ts`, etc. — the large majority of `queue-*.test.ts` files). Shared helper `test/helpers/pendingPrintRegistry.ts` stands in for the `pending_print` table's four accessors — **must be extended** with `photo_url`/`approved_by`/`attempt_no` fields and an overwrite-vs-DO-NOTHING distinction for this phase. (2) **Real temp-file SQLite** — `fs.mkdtempSync(os.tmpdir())` + `new LocalStore(dbPath)`, used exclusively in `test/local-store-persistence.test.ts` to prove the actual SQL (migrations, idempotency predicates) against a real database file. |
| How Agent events are fed | `service.onAgentEvent(eventType, jobId, payload)` called directly — no WS layer in these tests; `AgentServer` is never constructed. This is the seam to reuse for the D11-10 rewrite's C/D/E fixture replay. |
| Expected end-of-phase size | Baseline not re-measured this session (Phase 7's own baseline was 36 files/335 tests pre-Phase-7, growing to 42/mid-600s by Phase 8's own count per `STATE.md`'s Phase 8 log) — planner should run `npm test` once at the start of planning to capture the exact current baseline before estimating Wave 0 file count. |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|---------------------|--------------|
| BTH-01/02 (re-opened) | Booth stays BUSY through grace; `attempt_open` migration is additive and idempotent on a real DB | integration (real temp-file SQLite) | `npx vitest run test/local-store-persistence.test.ts` | ✅ (extend existing file) |
| NOT-01 (re-opened) | Exactly one notification per job, carrying the LAST attempt's URL, sent only at finalize | unit | `npx vitest run test/queue-retake-anchor.test.ts test/queue-file-upload-print.test.ts` | ✅ REWRITE both (see §5) |
| AGT-04 (extended) | `processing_start` composite extraction works on both 1-shot and 4-shot layouts, no `param5` hardcode | unit | `npx vitest run test/queue-event-coverage.test.ts` | ✅ extend existing (add a 1-shot-layout case; current tests only cover the 4-shot shape's `param5`/`param1` split) |
| D11-03 | `printing` ignored with correct reason when no attempt open / composite mismatch (§E gallery reprint) | unit, new fixture from measured §E | `npx vitest run test/queue-retake-anchor.test.ts` | ✅ REWRITE (D11-10) |
| D11-05 | `finalizePendingPrint` idempotent across all three doors — a second door firing after the first is a no-op | unit | new test file, e.g. `test/queue-finalize-idempotency.test.ts` | ❌ Wave 0 |
| D11-06 | Grace timer: retake within window cancels it; expiry finalizes with door 2 | unit (fake timers) | new test file, e.g. `test/queue-retake-grace-timer.test.ts` | ❌ Wave 0 |
| D11-08 | CMS "end this guest" shown only while BUSY/grace; POST releases and finalizes with `approved_by='operator'` | unit + integration (CMS route + real store) | new test file, e.g. `test/cms-booth-release.test.ts` | ❌ Wave 0 |
| D11-09 | `SESSION_SUMMARY` carries `attempts=`/`approved_by=`, field order preserved | unit | extend `test/queue-dual-completion.test.ts`'s existing `SESSION_SUMMARY` describe block | ✅ extend existing |
| SC-6 (live booth gate) | Full retake/grace/reprint/operator sequences on real hardware, auto-print OFF | manual-only | N/A — `11-CONTEXT.md` `<verification>` steps 1-5 | N/A |

### Sampling Rate

- **Per task commit:** the file(s) named in that task's automated command, matching Phase 7's own established rate (`07-VALIDATION.md`: "under 5 seconds" per file).
- **Per plan/wave merge:** `npm test` (full suite) — Phase 7's measured baseline was 8.09s for 335 tests; expect this to have grown by Phase 8/9/10's additions, re-measure at planning time.
- **Phase gate:** full suite green, `npm run typecheck` and `npm run build` clean, before `/gsd-verify-work` — same as every prior phase in this project.

### Wave 0 Gaps

- [ ] `test/queue-finalize-idempotency.test.ts` — proves D11-05's three-door idempotency (a second door firing after the first is a no-op, and which door "won" is recorded correctly).
- [ ] `test/queue-retake-grace-timer.test.ts` — proves D11-06 (retake cancels the timer; expiry finalizes via door 2; `stop()` clears it, matching every other timer's discipline).
- [ ] `test/cms-booth-release.test.ts` — proves D11-08 (button visibility gating, POST route auth/IP/session inheritance, `approved_by='operator'` write).
- [ ] `test/helpers/pendingPrintRegistry.ts` — extend, not replace: add `photoUrl`, `approvedBy`, `attemptNo` fields and the overwrite-vs-DO-NOTHING branch, so every file importing this shared helper (`queue-dual-completion.test.ts`, `queue-file-upload-print.test.ts`, `queue-config-injection.test.ts`, `queue-retake-anchor.test.ts` if it keeps using it, `queue-print-registry-expiry.test.ts`) gets the new shape consistently rather than five independent hand-edits drifting apart.
- [ ] Framework install: none — vitest is already present and configured.

## Common Pitfalls in Testing — the breakage radius beyond D11-10's named file

`11-CONTEXT.md`'s D11-10 names only `test/queue-retake-anchor.test.ts` for rewrite. Reading the current suite this session found the following additional files asserting the **old single-anchor / immediate-send model** that D11-02/D11-04/D11-05 deliberately replace — these WILL go red under a correct implementation of the locked decisions and MUST be included in the plan's task breakdown, not discovered mid-execution:

| File | Line(s) | Old assumption asserted | Why it breaks |
|------|---------|--------------------------|----------------|
| `test/queue-dual-completion.test.ts` | `:113-117` (`expect(jobStatus['job-1']).toBe('completed')` immediately after `processing_start` alone) | `processing_start` alone completes the job | D11-02: `processing_start` no longer completes anything; only `finalizePendingPrint` (via `printing`/grace/operator) does |
| `test/queue-event-coverage.test.ts` | `:319-327` ("processing_start still completes the in-flight job") | same | same |
| `test/queue-event-coverage.test.ts` | `:339-356` ("file_upload still reaches the notification service") | `file_upload` alone (no `printing`) triggers `sendPhotoLink` | D11-04: `file_upload` only writes the URL; needs a `printing`/grace/operator finalize afterward to trigger send |
| `test/queue-release-timer.test.ts` | `:74`, `:99` (`expect(jobStatus['job-1']).toBe('completed')` right after `processing_start`) | same completion-anchor assumption, plus this whole file's premise (`releaseTimer` starts at `processing_start`) needs re-checking against D11-05 (release timer is no longer started from the composite event) | D11-02 removes `startReleaseTimer()` from `onPrintComposite()` entirely — this file's fixture setup itself needs restructuring, not just its assertions |
| `test/queue-no-photo-outcome.test.ts` | `:279`, `:285` | same completion-anchor assumption | same |
| `test/queue-countdown.test.ts` | `:234` | same | same |
| `test/queue-session-start-hijack.test.ts` | `:145-156` | same, plus asserts `completeJob` called directly from a `processing_start`-driven path | same |
| `test/queue-file-upload-print.test.ts` | entire first `describe` block, `:109-230` (10 test cases) | `file_upload` alone sends the notification (`sendPhotoLink` asserted called directly off `onAgentEvent('file_upload', ...)` with no `printing` in the sequence anywhere) | D11-04 — this is the single largest concentration of now-obsolete assertions found; the file's own header comment frames its purpose as proving the send-on-upload path, which no longer exists |
| `test/queue-file-upload-print.test.ts` | `:275-296` ("an awaiting row delivers the photo and moves to resolved" / "an already-resolved row delivers nothing") | `resolvePendingPrint`'s status flip happens on `file_upload` | D11-04/05: the status flip to `resolved` now happens inside `finalizePendingPrint`, not `onFileUpload` |
| `test/queue-event-photo.test.ts` | multiple, `:130-240` (every `sendPhotoLink`/`vi.waitFor` assertion keyed off a `file_upload`-only sequence) | same send-on-upload assumption | same |
| `test/queue-print-registry-expiry.test.ts` | `:190-199` | `sendPhotoLink` called and `status` flips to `resolved` directly from the upload path in this file's own fixture | same |

**Recommendation for the plan:** treat this as a first-class task ("rewrite the completion/notification test suite for the new finalize gate"), sized comparably to D11-10's own `queue-retake-anchor.test.ts` rewrite, not as an incidental side effect discovered during D11-02/D11-04 implementation. The count (9 files beyond the one D11-10 names, several with 5-10 affected cases each) is large enough to warrant its own wave or its own dedicated plan, sequenced immediately after `finalizePendingPrint`/`onPrintComposite`/`onFileUpload` land, so the suite is never red for more than one commit's worth of work.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|----------------|---------|-------------------|
| V2 Authentication | yes (D11-08 CMS route) | Existing CMS session-cookie auth (`cmsAuth.ts`), reused unmodified — no new auth mechanism introduced |
| V3 Session Management | yes | Existing CMS session store (`createSessionStore`/`createRequireSession`), reused unmodified |
| V4 Access Control | yes | Existing CMS IP allow-list (`cmsIpGate.ts`) + session requirement, both mounted ahead of the new route exactly as for every existing `/cms` route |
| V5 Input Validation | yes | The new `POST /cms/api/booth/release` body (if any — likely just a `jobId` or none, since it targets "whichever job currently owns the booth") must be validated the same way `validateAgentConfigSubmission()` validates its allow-list (`cmsAgentRoutes.ts:61-122`) — refuse the whole request on any unexpected field, do not silently ignore |
| V6 Cryptography | no | No new cryptographic operation introduced by this phase |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|-----------------------|
| Operator releases the WRONG job (race between the CMS read and the POST, if a retake happens in between) | Tampering (of intent, not data) | `finalizePendingPrint`'s idempotent SQL predicate naturally handles this — if the job already finalized via `printing` between the CMS's read and the operator's click, `finalizePendingPrint`'s `changes === 0` path returns false and the route should report "already finished" rather than silently double-finalizing. This is the same class of protection the existing `resolvePendingPrint` predicate already provides against a `printing`/`file_upload` race. |
| A stranger's `session_start` inside the grace window read as the same guest's retake (D11-06's accepted, operator-confirmed tradeoff) | Spoofing (of guest identity, at the physical/social layer, not the network layer) | Accepted risk, explicitly signed off by the operator 2026-08-18 per `11-CONTEXT.md` D11-06's own text — mitigated by D11-08's operator-visible override, not by a code-level fix. No further mitigation is in scope for this phase. |
| CMS route mutates queue state without going through `QueueService`'s in-process timer bookkeeping | Tampering (internal state desync) | Enforced by the interface design recommended above (`CmsBoothLink`, narrow, calls into `QueueService`, never touches `LocalStore.booth_state`/`pending_print` directly from the route) — same discipline `CmsAgentStore`/`CmsEventStore` already apply. |

## Sources

### Primary (HIGH confidence — read directly this session)
- `mirror-request/src/queue/queueService.ts` (full file, 1153 lines)
- `mirror-request/src/state/localStore.ts` (bootstrap/migrate/pending_print/booth_state/completeJob/closeJobNoPhoto/recordEventPhoto sections, ~750 lines read)
- `mirror-request/src/config.ts` (full file, 205 lines)
- `mirror-request/src/types.ts` (BoothState + EnvConfig region)
- `mirror-request/src/status/guestStatus.ts` (full file, 173 lines)
- `mirror-request/src/ops/logLevelControl.ts` (full file, 105 lines)
- `mirror-request/src/cms/cmsRouter.ts` (full file, 248 lines), `cmsAgentRoutes.ts` (full file, 233 lines), `cmsAuth.ts` (session-cookie section), `cmsIpGate.ts` (full file, 41 lines), `cmsEventRoutes.ts` (interface + wiring sections)
- `mirror-request/src/app.ts` (CMS mount line), `mirror-request/src/index.ts` (full file, 86 lines)
- `mirror-request/src/display/displayServer.ts` (boothState broadcast section)
- `mirror-request/src/notifications/notificationService.ts` (constructor + sendPhotoLink header)
- `mirror-request/test/queue-retake-anchor.test.ts` (full file, 93 lines)
- `mirror-request/test/queue-dual-completion.test.ts` (full file, 496 lines)
- `mirror-request/test/queue-file-upload-print.test.ts` (full file, 351 lines)
- `mirror-request/test/queue-event-coverage.test.ts` (relevant sections, ~140 lines)
- `mirror-request/test/helpers/pendingPrintRegistry.ts` (full file, 86 lines)
- `mirror-request/vitest.config.ts` (full file)
- `mirror-request/test/queue-config-injection.test.ts` (buildStore section)
- `mirror-request/docs/OPS-RUNBOOK.md` (stall_reason vocabulary section, grepped + read around matches)
- `/opt/mirror_request_dslrobooth/DEPLOYMENT.md` (retake/auto-print sections, lines 405-434, 539)
- `.planning/phases/07-session-lifecycle-retake/07-EVIDENCE-dslrbooth-triggers.md` (full file)
- `.planning/phases/07-session-lifecycle-retake/07-CONTEXT.md` (full file)
- `.planning/phases/07-session-lifecycle-retake/07-VALIDATION.md` (full file)
- `.planning/phases/11-retake-approval-anchor/11-CONTEXT.md` (full file)
- `.planning/phases/11-retake-approval-anchor/11-RESEARCH-OPERATOR.md` (full file)
- `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md` (Phase 11 section), `.planning/STATE.md` (head + Phase 11 tail), `mirror-request/CLAUDE.md`

### Secondary (MEDIUM confidence)
- None beyond the operator's own already-cited vendor docs (see `11-RESEARCH-OPERATOR.md` §1) — this research session did not perform new external documentation lookups; the domain is entirely in-repo code plus the operator's own prior measurement, both of which qualify as primary/HIGH per this phase's own evidentiary rules ("nếu research mâu thuẫn với [evidence file] thì research sai").

### Tertiary (LOW confidence)
- Pitfall 1's `_1x`/`_2x` suffix concern — flagged `[ASSUMED]` in the Assumptions Log (A1), not found verified in the evidence file as read this session.

## Metadata

**Confidence breakdown:**
- Codebase specifics (file:line, current bodies): HIGH — every quote in this document was read via the `Read` tool this session, with line ranges cited.
- New-code shape (how D11-01…D11-10 map onto the existing methods/tables): MEDIUM — derived from locked decisions plus verified current code, but the exact new method signatures/SQL are this researcher's recommendation, not yet implemented or tested.
- Test breakage radius (§5 / the extended pitfalls table): HIGH — every file/line cited was read and the specific assertion quoted or paraphrased from a read excerpt.
- Pitfall 1 (composite suffix risk): LOW/ASSUMED — explicitly flagged, no verified instance found in the evidence this researcher had access to.

**Research date:** 2026-08-18
**Valid until:** re-verify code line numbers if any other phase lands on `queueService.ts`/`localStore.ts` before Phase 11 planning begins (30-day estimate otherwise; this is an actively-changing file, so treat any gap of more than a few days before planning as a re-read trigger).
