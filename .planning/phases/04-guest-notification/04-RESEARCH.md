# Phase 4: Guest Notification - Research

**Researched:** 2026-08-10
**Domain:** Restart-safe delivery guarantees for an outbound webhook (persisted retry queue / sweeper pattern) in a Node.js 20 / TypeScript / better-sqlite3 service — hardening `mirror-request/src/notifications/notificationService.ts`
**Confidence:** HIGH for current-code behavior and the schema/state-machine design (every claim below was read from source this session, both `mirror-request/` and `web-slide/`); MEDIUM for `AbortSignal.timeout()`/error-shape mechanics (official-pattern cross-checked via WebSearch this session, not executed against a live timeout in this research session); LOW-flagged-as-ASSUMED only where explicitly marked.

## Summary

Phase 4 is **not greenfield** — `notificationService.ts` (86 lines, commit `5519364`) already POSTs a shaped payload to `web-slide/server.js` and already retries with exponential backoff. Two existing test files (`test/notification-service.test.ts`, `test/notification-webhook.test.ts`) already cover the happy path. The phase's job is to **harden** this working code against one confirmed structural defect and three smaller correctness gaps, all verified against live source this session:

1. **The retry loop is not restart-safe, and worse than that: even a resumed sweeper cannot recover the photo URL today.** The `for` loop with `await setTimeout` sleeps (`notificationService.ts:48-78`) lives entirely in memory; a restart mid-retry destroys it while `notification_record` (jobId PK, `status`, `attempts`, `lastError`, `updatedAt`) survives to SQLite — but that row **never stores `photoUrl`** `[VERIFIED: grep -rn "photoUrl" mirror-request/src this session — only appears as a function parameter, never a persisted column or table]`. `photoUrl` arrives only as a runtime argument to `sendPhotoLink(jobId, photoUrl)`, itself only reachable from `onAgentEvent()`'s `file_upload` branch (`queueService.ts:224-225`), which reads it off the live WebSocket event payload — not from any durable table. **A persisted retry queue that only adds a due-time column is not sufficient**: `notification_record` must also persist `photoUrl`, or a sweeper resuming after restart has a `jobId` to retry but nothing to send. This is the single most important finding of this research and is not named in 04-CONTEXT.md's D-04.
2. **`fetch` has no timeout** (`notificationService.ts:58-62`) — confirmed, matches D-07's framing exactly.
3. **Retry-count semantics count the total, not retries-after-first-attempt** (`attempt <= this.maxRetries`, `notificationService.ts:48`) — confirmed, matches D-08's framing exactly. `NOTIFY_MAX_RETRIES` defaults to `3` (`config.ts:98`) meaning 3 total attempts today; `SESSION_MAX_RETRIES` defaults to `2` (`config.ts:96`) meaning 3 total dispatch attempts (1 + 2 retries) per Phase 2's D-05. The two numbers already happen to produce the same total (3) under today's code, which is exactly why the semantic mismatch has stayed invisible — changing `NOTIFY_MAX_RETRIES`'s meaning without also raising its default would silently cut real retries from 3 total to 2 total (1 initial + `NOTIFY_MAX_RETRIES=3`... no — under the corrected D-08 semantics, `NOTIFY_MAX_RETRIES=3` means 1 + 3 = 4 total attempts, one more than today. See Pitfall 1.
4. **`queueService.ts:225`'s un-awaited call is confirmed** `[VERIFIED: mirror-request/src/queue/queueService.ts:219-229]` — `onAgentEvent()` is a synchronous `void` method calling the `private async sendNotification()` wrapper (`queueService.ts:297-301`) without `await`. Per D-06 this becomes fully acceptable once the sweeper, not the in-memory loop, owns delivery — no change needed at this call site.

The receiver side (`web-slide/server.js:59-90`) was re-confirmed this session: no lookup, no DB, silent `''`/`'Khách hàng'` fallbacks on every field, `200` returned unconditionally inside the `try` block regardless of what shape the payload actually had. This makes "we got a 200" worthless as a delivery proof — the Validation Architecture below is built around asserting the exact outbound payload shape instead.

**Primary recommendation:** Replace the in-memory loop with a persisted retry queue backed by two new columns on `notification_record` (`photoUrl`, `dueAt`) plus a `sending` in-flight status value, driven by a dedicated sweeper timer (own interval, not folded into the 250ms queue tick) that claims due rows with a synchronous pre-`await` status transition so a row can structurally never be sent twice (D-05) even under an overlapping sweep. No new npm dependency — `AbortSignal.timeout()` is a Node 20 built-in.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Guest lookup by jobId (NOT-01) | API/Backend (`LocalStore.getJobRegistration()`) | Database/Storage (`registration` join) | Already exists, reused as-is — no new query needed |
| Webhook payload shaping (name + photo only, D-02) | API/Backend (`NotificationService`) | External System (`web-slide/server.js`, performs zero shaping/lookup) | `web-slide` is a pure display surface with silent fallbacks; all correctness must originate server-side, since the receiver cannot detect or reject a malformed payload |
| Persisted retry queue / sweeper (D-04) | API/Backend (new sweep loop, its own timer) | Database/Storage (`notification_record`'s `dueAt`/`photoUrl`/`status` columns) | Mirrors Phase 2's `queue_job`/`busyTimer` split exactly — the timer is transient and disposable, the state that must survive a restart lives in SQLite |
| Restart recovery of pending notifications | API/Backend (the sweeper's own periodic due-time query) | Database/Storage | No separate boot-time recovery pass is needed the way Phase 2 built `recover()` — because the sweeper's normal `WHERE dueAt <= now` query already picks up anything overdue the moment it next runs after a restart, "restart-proof by construction" (D-04's exact wording) |
| Bounded retry / terminal-state recording (NOT-02, D-08, D-09) | Database/Storage (`notification_record.status`/`attempts`/`lastError`) | API/Backend (one `logger.error` line at exhaustion, mirroring `stall_reason`) | Operator-facing audit trail, same shape as Phase 2's `stall_reason` |
| Fire-and-forget call site (D-06) | API/Backend (`queueService.ts`'s `onAgentEvent()`) | — | Becomes correct once delivery no longer depends on the caller's stack frame staying alive — the sweeper, not the caller, owns the outcome |

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| NOT-01 | file_upload event → tra jobId → tìm thông tin liên hệ → gửi ảnh qua webhook trigger | Lookup (`getJobRegistration`) and webhook POST already implemented and correct in shape `[VERIFIED: mirror-request/src/notifications/notificationService.ts:23-62]`; payload already matches D-02 (name + photo + jobId + mode, no PII) `[VERIFIED: test/notification-service.test.ts:26-31 asserts exactly this shape]`. Nothing to build for the "happy path" — hardening only. |
| NOT-02 | Retry giới hạn khi gửi thất bại — log để xử lý thủ công | Bounded retry exists but is not restart-safe (D-04) and its count semantics disagree with Phase 2's (D-08); durable failure recording exists (`saveNotification` writes `status='failed'`) but the record is currently insufficient to resume or to distinguish "gave up, still know what to resend" from "gave up, photo URL lost" — see "A Second Gap" below. |

</phase_requirements>

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Where the photo actually goes**
- D-01: The receiver (`web-slide/server.js`) cannot look a guest up. Whatever the slideshow shows must be in the payload.
- D-02: The payload carries name and photo only — plus `jobId` and `mode` as correlation/metadata. No email, no phone, no other PII.
- D-03: `web-slide`'s `phone`/`email` fields are vestigial for this phase; they receive `''`. Intended end state, not drift.

**Retry must survive a restart**
- D-04: Replace the in-memory retry loop with a persisted retry queue. `notification_record` gains a due-time, and a periodic sweeper picks up rows that are due. Restart-proof by construction. Reversibility: costly — changes the delivery mechanism and the meaning of rows already in `notification_record`.
- D-05: A notification must never be delivered twice for one `file_upload`. Terminal states are terminal; the sweeper must not re-send a row already `delivered`.
- D-06: Fire-and-forget at the call site becomes acceptable once D-04 lands — the sweeper owns retries.

**Failure posture**
- D-07: `fetch` must have a timeout.
- D-08: Retry-count semantics align with Phase 2: the configured number is the count of retries after the first attempt, not the total.
- D-09: When retries are exhausted, record the failure durably with a reason and log it — matching how Phase 2 records `stall_reason`.
- D-10: Delivery failure must never crash the process or block the queue, consistent with Phase 1 D-05's warn-and-continue posture.

### Claude's Discretion

- The `fetch` timeout value (a sane default around 10s) and the sweeper's polling interval, provided both are typed config rather than literals.
- The exact schema change to `notification_record` for the due-time, and whether the sweeper is its own module or folded into an existing one.
- Backoff curve for the persisted queue, provided it is bounded per D-08.

### Deferred Ideas (OUT OF SCOPE)

- Sending the photo to the guest directly by email or SMS. The slideshow is a display surface only, not a delivery channel to the guest's phone. Separate decision if ever wanted.
- Signing the outbound webhook the way `/on-register` is signed inbound. Not needed while the payload carries no PII; revisit only if D-02 is reversed.
- Changing `web-slide` itself — out of scope.
- Giving each test file its own database — still open ledger item 4 (WINDOWS.md).

</user_constraints>

## Project Constraints (from CLAUDE.md)

`mirror-request/CLAUDE.md` states hard rules directly binding this phase:

- **NEVER write (INSERT/UPDATE/DELETE) to the real backend DB. Read-only SELECT only.** Not implicated — `notification_record` lives entirely in the local SQLite (`extension-service.sqlite`), never the backend registration DB.
- **All business logic lives HERE. Agent is a dumb relay only.** Confirms the sweeper, the retry policy, and the payload-shaping decision all belong in `mirror-request/`, never in `web-slide/` or the Agent — consistent with `web-slide/server.js` already being confirmed lookup-free this session.
- Runtime: Node.js 20 LTS, TypeScript. Packages: express, ws, better-sqlite3, winston, dotenv. `notificationService.ts` currently uses the Node 20 built-in global `fetch`, not the `node-fetch` package already listed in `package.json`'s dependencies (unused legacy dependency, not touched by this phase) `[VERIFIED: mirror-request/src/notifications/notificationService.ts:58 uses bare `fetch(...)`, no import; mirror-request/package.json lists node-fetch ^3.3.2 as a dependency with no import site found via grep]`.

## Existing Code Audit — Verified This Session

### `mirror-request/src/notifications/notificationService.ts` (86 lines, from commit `5519364`)
- Constructor (13-21) already accepts injected `maxRetries`, `store`/`webhookUrl` — typed-config pattern already followed, matching Phases 1-3's established convention. No change needed to this shape.
- `sendPhotoLink()` (23-81): looks up `getJobRegistration(jobId)` (24), bails with a warn if missing (25-28), bails if no `photoUrl` (29-32) or no `NOTIFY_WEBHOOK_URL` configured (33-36) — all three guards are correct and reusable as-is.
- Payload construction (51-57): `{ jobId, guestName: registration.name, photoUrl, timestamp: new Date().toISOString(), mode: registration.mode }` — matches D-02 exactly (name + photo + jobId + mode; `timestamp` is metadata, not PII). No email/phone field present. **Confirmed correct, no change needed to payload shape.**
- The retry loop (48-78): `for (let attempt = 1; attempt <= this.maxRetries; attempt++)` — in-memory, `await new Promise(resolve => setTimeout(resolve, ...))` (75) for backoff between attempts. This entire loop's persistence-of-intent (which attempt is next, when) is destroyed by any process restart while `notification_record`'s `status`/`attempts`/`lastError` rows persist a stale snapshot with nothing to resume them.
- `saveNotification()` is called after every attempt, success or failure (66, 73) — the record-writing discipline is already correct; only the schema and the driving loop need to change.

### `mirror-request/src/state/localStore.ts`
- `notification_record` schema (57-63, `bootstrap()`): `jobId TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, lastError TEXT, updatedAt TEXT NOT NULL DEFAULT 'now'`. **No `photoUrl` column, no due-time column** `[VERIFIED: mirror-request/src/state/localStore.ts:57-63]`.
- `migrate()` (76-86): the established additive-migration pattern — `PRAGMA table_info(<table>)`, check for a missing column by name, `ALTER TABLE ... ADD COLUMN`, then a one-time backfill `UPDATE`. Comment above it (77-79) states the hard rule this phase must also honor: "migrations here must never drop or recreate a table — only add columns and backfill." **This phase's schema change fits this exact pattern.**
- `saveNotification()` (323-333): a single `INSERT ... ON CONFLICT(jobId) DO UPDATE` — upsert semantics already in place, convenient for the sweeper's claim-and-update flow. Currently only writes `status`, `attempts`, `lastError`, `updatedAt` — must be extended to also write `photoUrl` and `dueAt`.
- `getNotification()` (335-340): reads the row back, currently hardcodes `channel: 'webhook', recipient: ''` in the returned object rather than reading real columns — a pre-existing simplification, not a defect this phase needs to fix (the `NotificationRecord.channel`/`recipient` fields are not read anywhere outside this file and no test asserts on them) `[VERIFIED: grep -rn "\.channel\b\|\.recipient\b" mirror-request/src mirror-request/test — no read site for either field outside localStore.ts itself]`.
- `getJobRegistration(jobId)` (309-320): already the exact join NOT-01 needs (`queue_job` → `registration`). No new query required.

### `mirror-request/src/queue/queueService.ts`
- `onAgentEvent()`'s `file_upload` branch (224-225): `this.sendNotification(jobId, String(payload.photoUrl ?? ''));` — not awaited, confirmed. `payload.photoUrl` is read off the live Agent event; this is the **only** place `photoUrl` exists in the running process before this phase's change. This confirms Gap 1 above: today, if the process restarts between this line executing and `sendPhotoLink()` completing its final successful `saveNotification()`, the URL is gone forever — not just the retry timer.
- `sendNotification()` wrapper (297-301): `private async sendNotification(jobId, photoUrl) { if (this.notificationService) { await this.notificationService.sendPhotoLink(jobId, photoUrl); } }` — thin pass-through, no logic to preserve or change.
- `bindNotificationService()` (152-154) and the `createQueueService()` factory (328, 340-342) wire an object shaped `{ sendPhotoLink(jid, url): Promise<void> }` — this interface is the seam Phase 4 must keep satisfying; the sweeper's internal delivery mechanism is free to differ as long as `sendPhotoLink()` still exists with this exact signature (Pattern 1 below explains why it should mean "enqueue" now, not "deliver synchronously").

### `mirror-request/src/config.ts`
- Already typed and defaulted: `NOTIFY_MAX_RETRIES` (98, default `3`), `NOTIFY_RETRY_BASE_DELAY_MS` (99, default `1000`), `NOTIFY_WEBHOOK_URL` (100, default `''`) `[VERIFIED: mirror-request/src/config.ts:98-100]`. No `NOTIFY_SWEEP_INTERVAL_MS` or `NOTIFY_FETCH_TIMEOUT_MS` exist yet — new config keys, following the exact `toNum('KEY', default)` idiom already used for every other timing knob in this file.

### `mirror-request/src/index.ts`
- Startup sequence (65-76): `poller.start()` → `queue.recover()` (wrapped in try/warn, matching D-10's warn-and-continue) → `queue.start()` → `agentServer.start(server)` → `displayServer.start(server)`. `notifier = createNotificationService()` (32) is constructed before `queue` but never `.start()`-ed or `.recover()`-ed today — there is no sweeper to start yet. **This is the natural insertion point**: a `notifier.start()` call alongside `queue.start()`, following the identical pattern already used for `poller`/`queue`/`agentServer`/`displayServer` — each owns its own lifecycle method, none share a single "start everything" mechanism.

### `web-slide/server.js` (re-confirmed this session)
- `/webhook` POST handler (59-90): reads `body.jobId`, `body.guestName || body.name || body.customer_name || 'Khách hàng'`, `body.phone || body.customer_phone || ''`, `body.email || body.customer_email || ''`, `file ? uploads path : (body.photoUrl || body.imageUrl || body.image_url || null)`, `body.mode || null`. Responds `res.status(200).json({ success: true, id: customer.id })` unconditionally inside the `try` block (85) — **the only way to get a non-200 is an uncaught exception inside the handler**, which given the permissive fallbacks above is exceptionally hard to trigger from a normal payload. **Confirms the CONTEXT.md hazard exactly: a payload-shape mistake produces silent success, not an error.**
- Field name to send: `guestName` (matches current code, `notificationService.ts:53`) — **not** `name` — both are accepted but `guestName` is what today's code already sends and what the existing test asserts (`notification-service.test.ts:28`). No change needed to this field name.

## A Second Gap — `notification_record` Cannot Resume Delivery Without `photoUrl`

Not named in 04-CONTEXT.md's D-01..D-10 (the decisions discuss *when* the sweeper acts, not *what data* it needs to act with), but structurally required for D-04's "restart-proof by construction" to actually hold:

- `notification_record` today persists only `jobId`, `status`, `attempts`, `lastError`, `updatedAt`. It has never persisted the one piece of information — `photoUrl` — without which a resumed attempt has nothing to POST.
- `getJobRegistration(jobId)` can re-derive `guestName` and `mode` after a restart (they live durably in `registration`), but **cannot** re-derive `photoUrl` — that value only ever existed on the wire, inside one `file_upload` WebSocket event, and is never written to `queue_job` or `registration`.
- **Fix:** add a `photoUrl TEXT` column to `notification_record`, written at row-creation time (the first `saveNotification()` call for a given `jobId`, before the first delivery attempt), read back by the sweeper on every sweep pass. This turns the row into a fully self-contained work item — everything the sweeper needs to retry a delivery lives in that one row, with no dependency on any other table or any in-memory state.
- **Consequence for the additive migration:** any *pre-existing* `notification_record` row from before this migration (status `'pending'` or `'failed'`, `attempts > 0`) will have `photoUrl IS NULL` after the `ALTER TABLE` — it can never be resumed, because the value was never captured. The backfill step should mark such rows `'failed'` with `lastError = 'photoUrl unavailable — record predates persisted-queue migration'` rather than leave them silently un-resumable forever in a `'pending'`-looking state. See Pitfall 3.

## Standard Stack

### Core (all already installed, no new dependency)

| Library | Version (installed) | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Node 20 built-in `fetch` | Node 20 LTS (undici-backed) | Outbound webhook POST | Already this file's mechanism; no change |
| Node 20 built-in `AbortSignal.timeout(ms)` | Node 20 LTS | D-07's fetch timeout | Purpose-built for exactly this — throws a distinguishable `TimeoutError` DOMException on expiry, separate from a network-level rejection `[CITED, MEDIUM confidence, WebSearch cross-checked this session against MDN's `AbortSignal` reference and multiple independent Node/undici usage examples: `err.name === 'TimeoutError'` on expiry vs. a `TypeError`/`cause`-carrying rejection on connection refusal]` |
| `better-sqlite3` | `^11.0.0` (already installed, already verified working by Phase 2's research) | `notification_record`'s additive migration and the sweeper's claim/update SQL | Already this project's only SQLite driver; synchronous API is what makes the claim-before-`await` pattern in Pattern 2 below race-free without an extra lock |
| `winston` | `^3.14.2` | D-09's failure log line | Already `queueService.ts`'s and `notificationService.ts`'s logger |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| A dedicated sweeper `setInterval`, separate from the 250ms queue tick | Fold the due-row check into `QueueService.tick()` | Rejected: notification delivery is a different capability with a different cadence (retries are seconds-to-minutes apart, not 250ms), and this codebase already has an established idiom of one dedicated timer per concern (`tick` 250ms, `busyTimer`, `announcementTimer`, `heartbeatTimer` 15s) — folding a fifth concern into `tick()` would couple two unrelated failure domains and make `QueueService`'s single-responsibility boundary (dispatch, not delivery) blurrier than it already risks being |
| A synchronous pre-`await` SQL status transition ("claim") to enforce D-05 | An in-process boolean lock/mutex only | The claim-in-SQL approach is what makes D-05 hold even if a *future* change ever made the sweeper concurrent (e.g. two processes, a worker thread) — a same-process boolean flag alone only protects against Node's own interval re-entrancy, not against any other mechanism reading the same table. Since the cost of doing both is one extra `UPDATE` statement, no reason to pick only the weaker guard. |
| `AbortSignal.timeout()` | Manual `AbortController` + `setTimeout(() => controller.abort(), ms)` | `AbortSignal.timeout()` is strictly less code for the same effect and produces a distinguishable `TimeoutError` for free; manual `AbortController` is only preferable if the timeout needs to be cancelled/reset mid-flight (not needed here — one fetch, one deadline, no cancellation trigger exists) |

**Installation:** none — no new dependency for either the server-side sweeper or the timeout mechanism.

## Package Legitimacy Audit

**No new external packages are introduced by this phase.** The persisted retry queue is built from `better-sqlite3` (already installed, already audited in Phase 2's research) and Node 20's built-in `fetch`/`AbortSignal.timeout()`. This section is intentionally empty of a findings table because the gate's trigger condition ("whenever this phase installs external packages") does not apply.

## Architecture Patterns

### System Architecture Diagram

```text
Agent (dslrbooth-agent)                mirror-request (server)                          web-slide (receiver)
========================                ========================                        =====================

file_upload event (WS)  ------------->  QueueService.onAgentEvent()
                                           |  eventType === 'file_upload'
                                           v
                                         NotificationService.enqueue(jobId, photoUrl)  <-- RENAMED INTENT:
                                           |  (fire-and-forget call site is now correct, D-06)      no longer "send now",
                                           |  looks up registration for guestName/mode (durable)     now "durably record
                                           |  writes ONE row:                                        the work item"
                                           |    INSERT INTO notification_record
                                           |    (jobId, photoUrl, status='pending', attempts=0,
                                           |     dueAt=now, updatedAt=now)
                                           v
                                         [returns immediately — nothing awaited by the caller]

                                         ================= SWEEPER (own timer, e.g. every 2-5s) =================
                                         NotificationService.sweep()  [D-04: restart-proof by construction —
                                           |                           this loop is the ONLY resumption mechanism;
                                           |                           no separate boot-time recovery pass exists
                                           |                           or is needed]
                                           v
                                         SELECT jobId, photoUrl, attempts FROM notification_record
                                           WHERE status IN ('pending','retrying') AND dueAt <= now
                                           ORDER BY dueAt ASC
                                           |
                                           v
                                         for each due row (sequential, awaited):
                                           |  [D-05: structural claim, synchronous, before any await]
                                           |  UPDATE notification_record SET status='sending' WHERE jobId=? AND status IN ('pending','retrying')
                                           |    -> if 0 rows changed: another pass already claimed it, skip
                                           v
                                         fetch(webhookUrl, { signal: AbortSignal.timeout(NOTIFY_FETCH_TIMEOUT_MS), ...})  ------>  POST /webhook
                                           |                                                                                       (no lookup — reads
                                           |  ok (2xx)?                                                                            body fields with
                                           |    yes -> UPDATE status='delivered' [TERMINAL]                                        silent '' fallbacks,
                                           |    no  -> attempts+1;                                                                 200 unconditionally)
                                           |           attempts <= 1 + NOTIFY_MAX_RETRIES ?
                                           |             yes -> UPDATE status='retrying', dueAt=now+backoff(attempts), lastError=reason
                                           |             no  -> UPDATE status='failed' [TERMINAL], lastError=reason;  (D-09)
                                           |                    logger.error('Notification failed for <jobId> after N attempts: <reason>')
                                           v
                                         [never crashes the sweep loop or the process — one row's failure
                                          does not stop the next row's sweep, matching D-10]
```

### Recommended Project Structure (extends existing layout — no new top-level folders)
```
mirror-request/src/
├── notifications/
│   └── notificationService.ts   # existing — becomes the enqueue + sweep owner;
│                                 #   sendPhotoLink() keeps its name/signature
│                                 #   (queueService.ts's seam) but its body
│                                 #   changes from "deliver now" to "enqueue"
├── state/
│   └── localStore.ts             # existing — migrate() gains photoUrl + dueAt
│                                 #   columns on notification_record, no new table
├── config.ts                     # existing — add NOTIFY_FETCH_TIMEOUT_MS,
│                                 #   NOTIFY_SWEEP_INTERVAL_MS (typed, discretion)
└── index.ts                      # existing — add `notifier.start()` alongside
                                  #   the existing poller/queue/agentServer/
                                  #   displayServer .start() calls
```

### Pattern 1: `sendPhotoLink()` becomes "enqueue", not "deliver" (D-04, D-06)
**What:** `queueService.ts`'s call site keeps calling `notificationService.sendPhotoLink(jobId, photoUrl)` with the identical signature — the seam does not change. What changes is what happens inside: instead of looping and POSTing synchronously, the method now performs one synchronous SQLite write (a durable "work item" row) and returns. Delivery itself happens later, driven entirely by the sweeper.
**Why the seam name can stay:** `bindNotificationService()`'s type (`{ sendPhotoLink: (jid: string, url: string) => Promise<void> }`) already returns a `Promise<void>` — nothing about the interface implies synchronous delivery. Renaming the method risks an unnecessary diff across the call site and both existing test files for no behavioral gain; keeping the name and changing only the body is the smaller, more reviewable change.
**Example:**
```typescript
// notificationService.ts — new enqueue-only sendPhotoLink()
async sendPhotoLink(jobId: string, photoUrl: string): Promise<void> {
  const recordWithRegistration = this.store.getJobRegistration(jobId);
  if (!recordWithRegistration) {
    logger.warn(`Notification: job ${jobId} not found`);
    return;
  }
  if (!photoUrl) {
    logger.warn(`Notification: no photo URL for ${jobId}`);
    return;
  }
  if (!this.webhookUrl) {
    logger.warn(`Notification: NOTIFY_WEBHOOK_URL is not configured; skipping ${jobId}`);
    return;
  }
  // D-04: durable work item — photoUrl persisted so a restart can resume it.
  this.store.enqueueNotification({ jobId, photoUrl, dueAt: Date.now() });
  // Delivery itself now happens in sweep(), not here — D-06's fire-and-forget
  // call site is correct because nothing about the outcome depends on this
  // stack frame staying alive.
}
```

### Pattern 2: The sweeper — structural D-05 via a synchronous claim before any `await`
**What:** A dedicated method, driven by its own `setInterval`, that selects due rows and — critically — transitions each row's status with a plain synchronous `better-sqlite3` `UPDATE ... WHERE status IN (...)` **before** the `await fetch(...)` call for that row. Because `better-sqlite3` is synchronous, this UPDATE and the preceding SELECT execute in the same tick with no `await` between them — no other code can interleave and re-claim the same row, regardless of how many times the interval has fired or how long a previous sweep is still running.
**Why this makes D-05 structural, not a forgettable check:** the claim-UPDATE's `WHERE status IN ('pending','retrying')` clause means a row already `'delivered'`, `'failed'`, or already claimed as `'sending'` by an earlier pass is **excluded by the query itself** — there is no `if (alreadySent) return;` anywhere that a future edit could accidentally delete. The guarantee lives in the SQL predicate, not in application logic.
**Example:**
```typescript
// notificationService.ts — the sweep loop
private sweeping = false;

start(): void {
  if (this.timer) return;
  this.timer = setInterval(() => { void this.sweep(); }, this.sweepIntervalMs);
}

async sweep(): Promise<void> {
  if (this.sweeping) return; // defense-in-depth against interval re-entrancy; not
                              // the mechanism that makes D-05 hold — see claim below
  this.sweeping = true;
  try {
    const due = this.store.getDueNotifications(Date.now()); // WHERE status IN ('pending','retrying') AND dueAt <= ?
    for (const row of due) {
      const claimed = this.store.claimNotification(row.jobId); // synchronous UPDATE ... WHERE status IN (...) ; returns boolean
      if (!claimed) continue; // already claimed/terminal by the time we got here — structural no-op, not a bug
      await this.attemptDelivery(row); // the only await in this loop body per row
    }
  } finally {
    this.sweeping = false;
  }
}

private async attemptDelivery(row: { jobId: string; photoUrl: string; attempts: number }): Promise<void> {
  const nextAttempt = row.attempts + 1;
  try {
    const response = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(this.buildPayload(row.jobId, row.photoUrl)),
      signal: AbortSignal.timeout(this.fetchTimeoutMs), // D-07
    });
    if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}`);
    this.store.saveNotification({ jobId: row.jobId, status: 'delivered', attempts: nextAttempt });
    logger.info(`Notification sent for ${row.jobId} (attempt ${nextAttempt})`);
  } catch (err) {
    const reason = this.classifyError(err); // D-07: distinguishes 'timeout' from other network errors
    // D-08: retries AFTER the first attempt — total attempts allowed = 1 + NOTIFY_MAX_RETRIES
    if (nextAttempt <= 1 + this.maxRetries) {
      const backoffMs = Math.min(this.maxBackoffMs, this.baseDelayMs * 2 ** (nextAttempt - 1));
      this.store.saveNotification({ jobId: row.jobId, status: 'retrying', attempts: nextAttempt, lastError: reason, dueAt: Date.now() + backoffMs });
    } else {
      this.store.saveNotification({ jobId: row.jobId, status: 'failed', attempts: nextAttempt, lastError: reason }); // D-09
      logger.error(`Notification failed for ${row.jobId} after ${nextAttempt} attempts: ${reason}`);
    }
  }
}

private classifyError(err: unknown): string {
  if (err instanceof Error && err.name === 'TimeoutError') return 'timeout'; // AbortSignal.timeout()'s distinguishable error
  if (err instanceof Error) return err.message; // e.g. "fetch failed" with a connection-refused cause, or the thrown HTTP-status Error
  return String(err);
}
```
```typescript
// localStore.ts — new methods, following saveNotification()'s existing upsert idiom
enqueueNotification(n: { jobId: string; photoUrl: string; dueAt: number }): void {
  this.db.prepare(`
    INSERT INTO notification_record (jobId, photoUrl, status, attempts, dueAt, updatedAt)
    VALUES (?, ?, 'pending', 0, ?, ?)
    ON CONFLICT(jobId) DO UPDATE SET
      photoUrl = excluded.photoUrl, status = 'pending', dueAt = excluded.dueAt, updatedAt = excluded.updatedAt
  `).run(n.jobId, n.photoUrl, n.dueAt, new Date().toISOString());
}

getDueNotifications(now: number): Array<{ jobId: string; photoUrl: string; attempts: number }> {
  return this.db.prepare(`
    SELECT jobId, photoUrl, attempts FROM notification_record
    WHERE status IN ('pending', 'retrying') AND dueAt <= ?
    ORDER BY dueAt ASC
  `).all(now) as Array<{ jobId: string; photoUrl: string; attempts: number }>;
}

// D-05's structural guarantee: this WHERE clause is what prevents a double-send,
// not an application-level flag. Returns true only if this call is the one that
// actually transitioned the row.
claimNotification(jobId: string): boolean {
  const result = this.db.prepare(`
    UPDATE notification_record SET status = 'sending', updatedAt = ? WHERE jobId = ? AND status IN ('pending', 'retrying')
  `).run(new Date().toISOString(), jobId);
  return result.changes === 1;
}
```

### Pattern 3: Migration — additive columns, and an honest terminal state for un-resumable pre-existing rows
**What:** Follows `migrate()`'s existing pattern (`localStore.ts:76-86`) exactly — check for the column via `PRAGMA table_info`, `ALTER TABLE ... ADD COLUMN` if missing, then a one-time backfill. The backfill here does two things: gives every row a `dueAt` (so existing `'pending'`/`'failed'` rows do not remain permanently `NULL`-due and simply never picked up or never re-attempted), and marks any row with no `photoUrl` as terminally `'failed'` rather than silently un-resumable forever (see "A Second Gap").
**Example:**
```typescript
// localStore.ts — migrate(), extended
const notifCols = this.db.prepare('PRAGMA table_info(notification_record)').all() as Array<{ name: string }>;
const hasPhotoUrl = notifCols.some((c) => c.name === 'photoUrl');
const hasDueAt = notifCols.some((c) => c.name === 'dueAt');
if (!hasPhotoUrl) this.db.exec('ALTER TABLE notification_record ADD COLUMN photoUrl TEXT');
if (!hasDueAt) this.db.exec('ALTER TABLE notification_record ADD COLUMN dueAt INTEGER');
if (!hasPhotoUrl || !hasDueAt) {
  // Rows from before this migration have no photoUrl — they can never be
  // resumed by the sweeper. Recording this honestly as 'failed' (not left
  // 'pending' forever) matches D-09's spirit: an operator must be able to
  // find which guests never got their photo, not have the row silently rot.
  this.db.prepare(`
    UPDATE notification_record SET status = 'failed', lastError = 'photoUrl unavailable — record predates persisted-queue migration', dueAt = ?
    WHERE photoUrl IS NULL AND status NOT IN ('delivered', 'failed')
  `).run(Date.now());
}
```

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|--------------|-----|
| Fetch timeout | A manual `Promise.race([fetch(...), timeoutPromise])` or a hand-rolled `AbortController` + `setTimeout` pair | `AbortSignal.timeout(ms)` passed as `fetch`'s `signal` option | Node 20 built-in, produces a distinguishable `TimeoutError`, zero new code beyond the option itself |
| Detecting "is this the currently in-flight retry for this job" | A new in-memory `Set<jobId>` of jobs currently being retried | The `status IN ('pending','retrying')` predicate in the claim `UPDATE` (Pattern 2) | An in-memory set is destroyed by the same restart D-04 exists to survive; the SQL predicate is the durable, restart-safe equivalent |
| Timing-safe or complex state tracking for "never deliver twice" | A dedicated locking table, a Redis lock, or an in-process mutex library | The single claim `UPDATE ... WHERE status IN (...)` (Pattern 2) | `better-sqlite3` is synchronous — the claim and the SELECT that found the row run with no `await` between them, so no external lock is needed for a single-process service; a heavier locking mechanism would be solving a concurrency problem this codebase does not have (single Node process, single SQLite file) |
| Exponential backoff | A backoff library (e.g. a generic retry package) | The existing formula already in `notificationService.ts:75` (`NOTIFY_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)`), reused unchanged, now driving `dueAt` instead of a `setTimeout` sleep | It already exists, already works, and is trivially small — importing a library for one line of math would be the over-engineering this phase should avoid |

**Key insight:** every mechanism this phase needs already has a sibling in this exact codebase — the additive-migration pattern (`migrate()`), the upsert-on-conflict idiom (`saveNotification()`), the per-concern-owns-its-own-timer idiom (`tick`, `busyTimer`, `heartbeatTimer`), and even the "system fault records durably, never crashes the process" posture (Phase 1 D-05, Phase 2's `stall_reason`). The entire phase is a small, targeted schema change plus moving existing logic from an in-memory loop to a SQL-driven sweep — resist introducing a queue library, a lock manager, or a new table.

## Common Pitfalls

### Pitfall 1: D-08's semantic flip silently changes the real retry count unless the default is reconsidered
**What goes wrong:** Under today's code, `NOTIFY_MAX_RETRIES=3` means 3 total attempts (`attempt <= 3`). Under D-08's corrected semantics ("the configured number is retries after the first attempt"), the same literal value `3` now means 1 + 3 = **4** total attempts — a real behavior change, not just a naming cleanup. If the planner leaves the default untouched while flipping the semantics, delivery will silently become *more* persistent (one extra attempt) than it is today — which is safe (more retries, not fewer) but should be a deliberate, stated choice, not an accidental byproduct of the rename.
**Why it happens:** The decision (D-08) is phrased as aligning the *meaning* of the number with Phase 2's `SESSION_MAX_RETRIES`, not as instructing a specific new default value.
**How to avoid:** State explicitly in the plan whether `NOTIFY_MAX_RETRIES`'s default stays `3` (yielding 4 total attempts, one more than today) or drops to `2` (yielding 3 total attempts, matching today's actual count). Either is defensible; leaving it unstated risks a plan-checker citing a total-attempt count that doesn't match the code.
**Warning signs:** A test asserting "3 attempts total" that was copy-pasted from the old semantics without checking which meaning is intended.

### Pitfall 2: The claim `UPDATE`'s `changes === 0` case is a normal, expected outcome — not an error
**What goes wrong:** It's tempting to log a warning or throw when `claimNotification()` returns `false` (0 rows changed), on the theory that "we just selected this row, why didn't the claim succeed?"
**Why it's not an error:** Under a single-process, single-timer sweeper this should never actually happen in practice (no concurrent claimer exists), but the guard exists for defensive correctness rather than as an anomaly detector — the `sweeping` boolean in Pattern 2 already prevents Node's own interval from re-entering. If it *does* return `false` in this codebase's current single-process shape, that indicates the `sweeping` guard itself has a bug, not that the notification data is corrupt.
**How to avoid:** Treat `claimNotification()` returning `false` as a silent `continue`, not a logged warning — matching Pattern 2's example. Reserve `logger.warn`/`error` for genuine delivery failures (D-09), not for claim races that are expected to be rare-to-never under this architecture.
**Warning signs:** Log noise from claim races in a system with only one sweeper process — a signal the `sweeping` flag isn't doing its job, not a signal about guest data.

### Pitfall 3: A pre-existing `notification_record` row's `photoUrl` cannot be backfilled from anywhere — the migration must be honest about permanent data loss for those rows
**What goes wrong:** A migration script might try to backfill `photoUrl` for existing rows by re-deriving it from `queue_job` or `registration` — but neither table has ever stored it (confirmed by grep this session, "A Second Gap" above). Any attempt to backfill will find nothing and either leave the column `NULL` (row silently un-resumable, `status` still looking like `'pending'`) or fabricate a placeholder value (actively wrong — POSTing a bogus URL to the slideshow).
**Why it happens:** It's a reasonable first instinct to assume any missing column can be backfilled from some other table; here, the true source (`payload.photoUrl` off a WebSocket event) was never durable in the first place.
**How to avoid:** The migration must mark rows with `photoUrl IS NULL` (after the column is added) as terminally `'failed'` with an explicit `lastError` explaining why (Pattern 3's example) — this is the only honest option: not silently dropped, and not fabricated.
**Warning signs:** A `'pending'` or `'retrying'` row in `notification_record` that has `photoUrl = NULL` after this migration lands — this state should be structurally impossible post-migration (every new row is created with a `photoUrl` by `enqueueNotification()`); if seen, it indicates the migration's backfill step did not run or was skipped.

### Pitfall 4: `notification-webhook.test.ts` calls `getStore()` directly — audited and confirmed a real coupling, not a false alarm
**What goes wrong:** `test/notification-webhook.test.ts:24` — `const store = getStore();` — this is a direct call to the shared test-DB singleton the WINDOWS.md ledger item 4 warns about, confirmed by reading the file this session `[VERIFIED: mirror-request/test/notification-webhook.test.ts:24]`. It then `upsertRegistration()`s and `enqueueJob()`s a **hardcoded** id, `'job-webhook-001'` (line 26, 33) — not a per-test-generated id. Under parallel vitest workers sharing one test DB, a second test file (present or future) that also happens to use `'job-webhook-001'` would collide.
**Why it happens:** This file predates Phase 4's planning (commit `5519364`) and was written before the `getStore()` singleton hazard was documented project-wide.
**How to avoid:** New Phase 4 tests must not call `getStore()` — use a mocked `LocalStore`-shaped object (as `test/notification-service.test.ts` already correctly does, confirmed clean of this coupling this session) or a per-test-generated jobId with an isolated temp-file `LocalStore` instance (`new LocalStore(tempPath)`, the `constructor(dbPath?)` seam Phase 2's research already flagged as the safer alternative to the singleton). Whether to *fix* `notification-webhook.test.ts` itself (give it a generated id, or migrate it off `getStore()`) is a planning decision — this research surfaces the coupling as confirmed, not as something to silently leave for a future phase to rediscover.
**Warning signs:** `notification-webhook.test.ts` passing alone but failing (or another file failing) when run as part of the full suite — the WINDOWS.md ledger item 4 signature.

### Pitfall 5: A 2xx response from `web-slide` proves nothing about payload correctness — verification must assert the exact body
**What goes wrong:** A test that only checks `response.ok === true` (or that `record.status === 'delivered'`) after a real or mocked webhook call passes even if the payload silently regressed to sending `phone`/`email`, or dropped `guestName`, or sent the wrong `photoUrl` — because `web-slide/server.js:59-90` returns `200` unconditionally for any well-formed JSON body, regardless of which fields are present or absent (re-confirmed this session).
**Why it happens:** "We got a 200" is the natural, cheap thing to assert, and it happens to be true for both a correct and a badly-malformed payload.
**How to avoid:** Every delivery-path test must assert the *exact* outbound JSON body (as `test/notification-service.test.ts:26-32` and `test/notification-webhook.test.ts:57-62` already correctly do) — `toMatchObject` or equivalent field-by-field checks, not just an HTTP-status check. This is doubly important once the sweeper is introduced, since a new test must prove the *replayed* payload (after a restart, from `photoUrl` re-read out of `notification_record`) is byte-identical in shape to the original, not just "delivery eventually succeeded."
**Warning signs:** A new Phase 4 test asserting only `expect(fetchMock).toHaveBeenCalled()` or `expect(response.status).toBe(200)` without inspecting the body.

## Code Examples

### Test proving D-05's never-deliver-twice guarantee under fake timers
```typescript
// Source: pattern extends test/queue-timeout-retry.test.ts's fully-mocked-store,
// fake-timer harness shape — no getStore() call, no shared singleton.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationService } from '../src/notifications/notificationService';

describe('sweeper never re-delivers a claimed row (D-05)', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('a row claimed by one sweep pass is invisible to a second overlapping pass', async () => {
    vi.useFakeTimers();
    let status = 'pending';
    const fetchMock = vi.fn().mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve({ ok: true, status: 200 }), 50); // slow enough to overlap a second sweep tick
    }));
    vi.stubGlobal('fetch', fetchMock);
    const store = {
      getDueNotifications: () => (status === 'pending' ? [{ jobId: 'job-1', photoUrl: 'https://x/photo.jpg', attempts: 0 }] : []),
      claimNotification: (id: string) => { if (status !== 'pending') return false; status = 'sending'; return true; },
      saveNotification: vi.fn((n) => { status = n.status; }),
      getJobRegistration: () => ({ job: { id: 'job-1' }, registration: { name: 'Guest', mode: 'print' } }),
    } as never;
    const service = new NotificationService(3, store, 'https://slides.example/webhook');

    const first = service.sweep();
    vi.advanceTimersByTime(10);
    const second = service.sweep(); // fires while the first sweep's fetch is still pending
    vi.advanceTimersByTime(50);
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1); // never sent twice, even under an overlapping sweep
  });
});
```

### Test proving the migration's honest-failure backfill (Pitfall 3)
```typescript
// Source: pattern derived from local-store-persistence.test.ts's real-file
// LocalStore harness (isolated temp path, not getStore()).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalStore } from '../src/state/localStore';

it('marks a pre-migration row with no photoUrl as failed, not silently unresumable', () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'notif-migrate-')), 'test.sqlite');
  const store1 = new LocalStore(dbPath);
  // simulate a row written by the OLD schema/code, before photoUrl existed
  store1.saveNotification({ jobId: 'job-old', status: 'pending', attempts: 1 });
  store1.close();

  const store2 = new LocalStore(dbPath); // re-open triggers migrate() again — idempotent, additive
  const record = store2.getNotification('job-old');
  expect(record?.status).toBe('failed');
  expect(record?.lastError).toMatch(/photoUrl unavailable/);
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| In-memory `for` loop + `await setTimeout` sleep drives retry timing | Persisted `dueAt` column + periodic sweeper `SELECT ... WHERE dueAt <= now` | This phase (D-04) | Directly mirrors Phase 2's `booth_state`/`busyTimer` fix — same defect class, same fix shape, one layer up the stack |
| `attempt <= maxRetries` (total count) | `nextAttempt <= 1 + maxRetries` (retries-after-first) | This phase (D-08) | Aligns with Phase 2's `SESSION_MAX_RETRIES` semantics; see Pitfall 1 for the default-value consequence |
| No fetch timeout | `AbortSignal.timeout(NOTIFY_FETCH_TIMEOUT_MS)` | This phase (D-07) | A hung `web-slide` connection no longer holds a retry attempt open indefinitely |

**Deprecated/outdated:**
- The in-memory retry `for` loop (`notificationService.ts:48-78`) becomes dead code once the sweeper lands — its logic (exponential backoff formula, per-attempt `saveNotification` call) is reused, but the driving loop itself is replaced entirely.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The sweeper should be its own timer inside `NotificationService`, not folded into `QueueService.tick()` | Architecture Patterns, Alternatives Considered | Explicitly named as the planner's discretion in 04-CONTEXT.md ("whether the sweeper is its own module or folded into an existing one") — if the planner prefers folding it into `tick()`, the claim-UPDATE pattern (Pattern 2) still applies unchanged, only the timer wiring moves. Low cost either way. |
| A2 | `NOTIFY_MAX_RETRIES`'s default value choice under D-08's new semantics (stay `3` → 4 total attempts, or drop to `2` → 3 total attempts) is not itself specified by 04-CONTEXT.md | Pitfall 1 | If the plan doesn't state this explicitly, a plan-checker or a test may assert a total-attempt count that silently drifts from what the code actually does after the semantic flip. |
| A3 | A `'sending'` intermediate status (distinct from `'pending'`/`'retrying'`/`'delivered'`/`'failed'`) is the right mechanism for D-05's structural claim, rather than e.g. a separate `claimed_at` timestamp column | Pattern 2 | A `claimed_at` column would work equivalently but adds a second column instead of one new enum value on the existing `status` column; the status-value approach was chosen for minimal schema surface, consistent with the additive-only migration philosophy already established. If the planner prefers a timestamp-based claim (e.g. to auto-expire a claim that crashed mid-flight without ever resolving), that is a reasonable alternative not explored in depth here — flagged as a legitimate design choice, not a defect in this recommendation. |
| A4 | `AbortSignal.timeout()`'s `TimeoutError` is reliably distinguishable from a connection-refused/DNS-failure error via `err.name` under Node 20's undici-backed `fetch` | Standard Stack, Pattern 2 | Cross-checked via WebSearch this session (MDN + multiple independent Node/undici examples) but not executed against a live timeout in this research session. If the error shape differs in practice (e.g. wrapped differently by undici's `fetch` vs. raw `AbortController` usage), `classifyError()`'s `err.name === 'TimeoutError'` check may need adjustment — low-cost to verify with one real timeout test during implementation (recommended as an early task). |

## Open Questions

1. **Should `notification-webhook.test.ts`'s `getStore()` coupling and hardcoded `job-webhook-001` id be fixed as part of this phase, or only newly-added tests held to the stricter no-`getStore()` bar?**
   - What we know: The coupling is real and confirmed (Pitfall 4). It has apparently not caused an observed failure yet (full suite currently green, 23 files / 155 tests, measured this session).
   - What's unclear: Whether fixing pre-existing test debt is in scope for a hardening phase whose named deliverable is the retry-queue behavior, or whether it should be logged to WINDOWS.md and deferred like ledger item 4 itself.
   - Recommendation: At minimum, log it to WINDOWS.md if not fixed (consistent with this project's established practice of recording, not silently ignoring, known test-isolation debt). Fixing it is low-cost (swap the hardcoded id for a generated one, or migrate the file to a temp-path `LocalStore`) and would be a natural fit for whichever task touches `notification_record`'s schema anyway, since that test will very likely need updating regardless (its assertions currently check the old `record.status`/shape which is unaffected, but the file already touches the exact table this phase changes).

2. **What should `NOTIFY_WEBHOOK_URL` actually be in production, and has the payload's field name (`guestName`) ever been cross-checked against a real deployed `web-slide` instance beyond the one historical log line?**
   - What we know: `config.ts` defaults `NOTIFY_WEBHOOK_URL` to `''` (unconfigured); the existing code already warns and skips if unset (`notificationService.ts:33-36`). `web-slide/webhook-json.log` records one real 2026-08-07 delivery.
   - What's unclear: Whether the production `.env` has this set today, and whether `web-slide` is reachable from `mirror-request`'s deployment target (same host? different port only? see Environment Availability).
   - Recommendation: Not blocking for this phase's code changes (the guard already handles an unset URL safely), but the phase-gate checkpoint should confirm the production value is set, following this project's established pattern (Phase 1's `WEBHOOK_HMAC_SECRET`/`PROXY_IP_WHITELIST` production-readiness confirmation, Phase 3's cross-repo smoke check).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Runtime | ✓ | v24 in this research sandbox; both `package.json`/`CLAUDE.md` pin `20.x` for deployment | Deployment target should use Node 20 LTS; same sandbox-vs-deploy caveat every prior phase's research flagged |
| `better-sqlite3` | Schema migration, sweeper's claim SQL | ✓ (already verified working, Phase 2's research) | `^11.0.0` per `config.json` | — |
| `web-slide/server.js` reachability from `mirror-request` | End-to-end delivery | **Not verified this session** — `NOTIFY_WEBHOOK_URL`'s actual production value is in `.env`, which this sandbox cannot read (`.env*` paths are denied to Read/Bash per this environment's hard restriction, confirmed, not a finding) `[ASSUMED — production reachability, not verified this session]` | — | Existing code already warn-and-skips on an unconfigured URL (D-10-consistent); the phase-gate checkpoint should confirm production connectivity, per Open Question 2 |
| `vitest` | Test execution | ✓ | `2.1.9` running per `package.json`'s `^2.1.4` pin (measured this session) | — |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** production `NOTIFY_WEBHOOK_URL` reachability — not independently verifiable in this research session; existing warn-and-skip behavior is the safe fallback, but should be confirmed at the phase gate.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest `^2.1.4`, running `2.1.9` `[VERIFIED: mirror-request/package.json devDependencies vitest "^2.1.4"; npx vitest --version this session]` |
| Config file | `mirror-request/vitest.config.ts` — sets `LOG_LEVEL: 'error'`, distinct test DB path (unchanged by this phase) |
| Quick run command | `cd mirror-request && npx vitest run test/notification-service.test.ts test/notification-webhook.test.ts` (or a new sweeper-specific file) |
| Full suite command | `cd mirror-request && npm test` — **measured this session: 23 files, 155 tests, 4.81s wall time**, all passing `[VERIFIED: npm test run this session]` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| NOT-01 | `file_upload` → lookup → enqueue with correct name/photo/mode, no PII | unit (mocked store, asserts exact payload shape) | `npx vitest run test/notification-service.test.ts` | ✅ existing — **must be updated** to assert the new enqueue-shaped call (`store.enqueueNotification` args) rather than only the delivered `fetch` body, since delivery now happens in the sweeper, not synchronously inside `sendPhotoLink()` |
| NOT-01 | Real HTTP round-trip payload shape (name + photo only, exact field names) | integration (real ephemeral `http.Server`, matches existing pattern) | `npx vitest run test/notification-webhook.test.ts` | ✅ existing — **must be fixed for the `getStore()` coupling** (Pitfall 4) as part of touching this file for the enqueue/sweep split |
| D-04/D-05 | A restart mid-retry resumes delivery from the persisted `photoUrl`, and never re-delivers an already-`delivered` row | unit (temp-path `LocalStore`, two `NotificationService` instances simulating a restart) | `npx vitest run test/notification-sweeper-restart.test.ts` | ❌ Wave 0 |
| D-05 | An overlapping sweep pass cannot double-claim a row (Code Examples' fake-timer test) | unit (mocked store + fake timers) | `npx vitest run test/notification-sweeper-claim.test.ts` | ❌ Wave 0 |
| D-07 | A hung/never-responding webhook target times out at the configured `NOTIFY_FETCH_TIMEOUT_MS`, recorded as `lastError` distinguishing a timeout from a connection failure | unit (mocked `fetch` that never resolves vs. one that rejects with a connection-refused-shaped error) | `npx vitest run test/notification-fetch-timeout.test.ts` | ❌ Wave 0 |
| D-08 | Retry count is 1 + `NOTIFY_MAX_RETRIES` total attempts, not `NOTIFY_MAX_RETRIES` total | unit (mocked store + fetch that always rejects, count `fetch` calls) | `npx vitest run test/notification-retry-count.test.ts` | ❌ Wave 0 |
| D-09/NOT-02 | Retries exhausted → row `status='failed'`, `lastError` set, one `logger.error` line, matching `stall_reason`'s durable-record shape | unit (spy on `queueLogger`/`logger.error`, matching `db-poller.test.ts`'s `vi.spyOn` pattern for intercepting before Winston's level filter) | `npx vitest run test/notification-retry-count.test.ts` (same file, extend) | ❌ Wave 0 (same file) |
| D-10 | A `fetch` rejection or an unexpected exception inside `attemptDelivery()` never throws out of `sweep()` or stops the next row's processing | unit (two due rows, first mocked to throw synchronously, assert the second still attempts) | `npx vitest run test/notification-sweeper-claim.test.ts` (same file, extend) | ❌ Wave 0 (same file) |
| Pitfall 3 | Migration backfill marks pre-existing `photoUrl IS NULL` rows `'failed'` with an explanatory `lastError`, idempotently across repeated `migrate()` calls | integration (temp-path `LocalStore`, write pre-migration-shaped row, reopen, assert) | `npx vitest run test/local-store-persistence.test.ts` (extend existing file — matches its established real-file harness) | ✅ existing file, **new test case** |

### Sampling Rate
- **Per task commit:** targeted `npx vitest run <file>` for the file(s) touched
- **Per wave merge:** `cd mirror-request && npm test` (full suite — currently 155 tests, ~4.8s, cheap enough every merge)
- **Phase gate:** Full suite green before `/gsd-verify-work`; additionally, given the "2xx proves nothing" hazard (Pitfall 5), the phase gate should include at least one assertion of the exact outbound payload against a real (not mocked) HTTP server, matching `notification-webhook.test.ts`'s existing pattern, extended to cover a post-restart-resumed delivery specifically — a mocked `fetch` alone cannot prove the sweeper's SQL-driven resumption path actually reconstructs the same payload shape end-to-end.

### Wave 0 Gaps
- [ ] `mirror-request/test/notification-sweeper-restart.test.ts` — covers D-04/D-05 (restart resumes from persisted `photoUrl`)
- [ ] `mirror-request/test/notification-sweeper-claim.test.ts` — covers D-05 (no double-claim) and D-10 (one row's failure doesn't stop the sweep)
- [ ] `mirror-request/test/notification-fetch-timeout.test.ts` — covers D-07, including distinguishing timeout vs. connection-refused in `lastError`
- [ ] `mirror-request/test/notification-retry-count.test.ts` — covers D-08 (1 + `NOTIFY_MAX_RETRIES` total attempts) and D-09 (terminal `failed` state + log line)
- [ ] `mirror-request/test/notification-service.test.ts` — **existing test must be updated**, not just extended, since `sendPhotoLink()`'s behavior changes from synchronous delivery to enqueue-only (Pattern 1)
- [ ] `mirror-request/test/notification-webhook.test.ts` — **existing test must be fixed** for the `getStore()`/hardcoded-id coupling (Pitfall 4) while it's being touched anyway for the enqueue/sweep split
- [ ] `mirror-request/test/local-store-persistence.test.ts` — extend with the migration-backfill case (Pitfall 3's honest-failure behavior)
- [ ] `mirror-request/src/config.ts` — add `NOTIFY_FETCH_TIMEOUT_MS` (discretion, ~10s default) and `NOTIFY_SWEEP_INTERVAL_MS` (discretion) as typed config, following the existing `toNum('KEY', default)` idiom — not a test file, but a required Wave 0 groundwork item every new test above depends on

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|----------------|---------|--------------------|
| V2 Authentication | No | The outbound webhook to `web-slide` carries no credential today (no signing per D-02's deferred-ideas note) — this is an accepted, deliberate gap for this phase, not a new one introduced by it |
| V5 Input Validation | Marginal | The payload sent is server-authored (`registration.name`, `registration.mode`, a `photoUrl` string from the Agent's `file_upload` event) — the only semi-external input is `photoUrl` itself, which originates from the Agent (a trusted, already-authenticated WS peer per Phase 3) rather than an untrusted guest-facing surface |
| V6 Cryptography | No | No new cryptographic operation in this phase |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|-----------------------|
| A stalled/never-responding `web-slide` instance holding a retry attempt open indefinitely, degrading into a slow resource leak across many stuck notifications | Denial of Service | D-07's `AbortSignal.timeout()` — bounds every attempt's maximum duration regardless of the target's behavior |
| A crafted or malformed `photoUrl` (e.g. `file://` or an internal-network URL) being POSTed as JSON body text to `web-slide` | Tampering (SSRF-adjacent, but inverted — the *receiver*, not this service, would fetch it if it ever chose to) | Out of scope for this phase: `mirror-request` never fetches `photoUrl` itself, only forwards the string; `web-slide` treats it as an opaque string for an `<img src>`-style URL, never fetches it server-side either (confirmed by this session's read of `server.js`, which only sets `imageUrl` in a JSON response, never calls `fetch`/`http.get` on it). No new mitigation needed, flagged for awareness only. |
| PII leaking into the webhook payload via a future accidental field addition (e.g. someone later "helpfully" adds `phone` back) | Information Disclosure | D-02's payload shape (name + photo + jobId + mode only) enforced by the exact-shape test assertions this research recommends (Pitfall 5) — a test asserting the payload's exact keys, not just `toMatchObject` on the fields expected to be present, would catch an accidental PII addition; recommend the planner consider a `toEqual`-style exact-shape assertion (not just `toMatchObject`) for at least one payload test, since `toMatchObject` alone does not fail if an *extra* field like `phone` were added |

## Sources

### Primary (HIGH confidence — read directly this session)
- `mirror-request/src/notifications/notificationService.ts`, `mirror-request/src/state/localStore.ts`, `mirror-request/src/queue/queueService.ts`, `mirror-request/src/types.ts`, `mirror-request/src/config.ts`, `mirror-request/src/index.ts` — every claim about current server behavior, the schema, the migration pattern, and the missing-`photoUrl` gap
- `web-slide/server.js` — the receiver's lookup-free, silently-falling-back `/webhook` handler
- `mirror-request/test/notification-service.test.ts`, `mirror-request/test/notification-webhook.test.ts`, `mirror-request/test/queue-timeout-retry.test.ts`, `mirror-request/test/db-poller.test.ts` — existing test patterns (mocked-store, real-HTTP-server, fake-timer, `createRequire`+`vi.spyOn`) and the confirmed `getStore()` coupling in `notification-webhook.test.ts`
- `mirror-request/CLAUDE.md`, `.planning/phases/04-guest-notification/04-CONTEXT.md`, `.planning/REQUIREMENTS.md`, `.planning/STATE.md`, `.planning/ROADMAP.md` (Phase 4 section), `.planning/phases/02-queue-booth-state/02-CONTEXT.md`, `.planning/phases/03-agent-websocket-link/03-RESEARCH.md` — inherited decisions, verified Phase 2/3 output, and the structure/depth this document matches
- Live command output this session: `npm test` (23 files / 155 tests / 4.81s, all passing), `grep -rn "photoUrl"`, `grep -rn "\.channel\b\|\.recipient\b"` across `src/`+`test/`

### Secondary (MEDIUM confidence — official docs/patterns cross-checked this session)
- WebSearch cross-check (MDN's `AbortSignal` reference plus multiple independent Node/undici usage examples) confirming `AbortSignal.timeout()` produces a distinguishable `err.name === 'TimeoutError'` on expiry, separate from a network-level rejection

### Tertiary (LOW confidence)
- None retained as authoritative — the one WebSearch finding above was cross-checked against MDN before being tagged `[CITED]`/MEDIUM.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies; both `AbortSignal.timeout()` and `better-sqlite3`'s synchronous API are well-established Node 20/already-installed mechanisms
- Architecture: HIGH for current-code behavior and the schema/migration design (every claim grounded in source read this session, cited line numbers); MEDIUM for the exact `AbortSignal.timeout()` error-shape behavior (cross-checked via docs/WebSearch, not executed against a live timeout in this research session — recommend the planner's first sweeper task include a quick real-timeout test confirming `err.name === 'TimeoutError'` behaves as documented against this codebase's actual `fetch` call before relying on it further in `classifyError()`)
- Pitfalls: HIGH for Pitfalls 1, 2, 3, 4, 5 (directly verified against source, existing test files, and the migration pattern this session)

**Research date:** 2026-08-10
**Valid until:** 2026-08-24 (14 days — matches Phase 3's shortened window; this phase changes the meaning of rows already living in a production SQLite table (D-04's "costly" reversibility), so re-verify sooner if `notification_record` is touched by any other change before this phase ships)
