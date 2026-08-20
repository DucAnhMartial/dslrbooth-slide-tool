---
phase: 04-guest-notification
plan: 01
subsystem: notifications
tags: [sqlite, persisted-queue, retry, webhook, better-sqlite3, vitest]
provides:
  - Persisted retry queue for guest photo notifications (notification_record gains photoUrl/dueAt)
  - LocalStore.enqueueNotification()/getDueNotifications()/claimNotification()
  - NotificationService.start()/stop()/sweep()/attemptDelivery(), enqueue-only sendPhotoLink()
  - Additive migration with honest-failure backfill for pre-existing rows with no photoUrl (D-13)
  - notifier.start()/notifier.stop() wired into src/index.ts bootstrap/shutdown
affects: [04-guest-notification, 05-client-api-display-feed]
actuals:
  tokens: 8640
  tasks: 2
  commits: 3
tech-stack:
  added: []
  patterns:
    - "Persisted-queue restart recovery: due-time + status predicate in SQL instead of an in-memory timer (mirrors Phase 2's D-04 booth-state fix)"
    - "COALESCE(excluded.col, table.col) on a conflict-branch UPDATE to protect a column a later write doesn't re-supply"
    - "Terminal-state guard expressed as a SQL WHERE clause (status NOT IN ('delivered','failed')), not an application-level if"
key-files:
  created:
    - mirror-request/test/notification-sweeper-restart.test.ts
  modified:
    - mirror-request/src/config.ts
    - mirror-request/src/types.ts
    - mirror-request/src/state/localStore.ts
    - mirror-request/src/notifications/notificationService.ts
    - mirror-request/src/index.ts
    - mirror-request/test/notification-service.test.ts
    - mirror-request/test/notification-webhook.test.ts
key-decisions:
  - "NOTIFY_MAX_RETRIES default flipped 3 -> 2 (D-15); exhaustion boundary is strictly nextAttempt < 1 + maxRetries, yielding exactly 3 total attempts with the shipped default"
  - "Test 4 (pre-migration backfill) could not use the plan's literal 'saveNotification then reopen' recipe — bootstrap() gives any brand-new database the new columns directly, so migrate()'s 'column actually added' gate never fires on a fresh temp db. Followed the codebase's existing precedent (test/on-register-dedup.test.ts's received_at migration test) instead: construct the old-shape table with raw better-sqlite3, insert the row, then open LocalStore."
  - "notification-webhook.test.ts's sendPhotoLink().then(() => service.sweep()).then(resolve, reject) gates promise resolution on the client-side sweep() completing (including its saveNotification write), not on the server merely receiving bytes — an earlier draft resolved on the server's 'end' handler and produced an unhandled 'database not open' rejection when afterEach closed the store before the client-side write landed"
duration: ~15min
completed: 2026-08-10
status: complete
---

# Phase 4 Plan 1: Persisted Retry Queue for Guest Notification (Tracer) Summary

**Replaced notificationService.ts's in-memory retry `for` loop with a SQLite-persisted retry queue — proven end to end by a real ephemeral HTTP server receiving a delivery enqueued by one `LocalStore`/`NotificationService` pair and delivered by a second pair opened on the same database file after the first closed.**

## Performance
- **Duration:** ~15 min
- **Tasks:** 2/2 completed
- **Files modified:** 8 (5 production, 3 test)

## Accomplishments
- `notification_record` gains `photoUrl TEXT` and `dueAt INTEGER` in both `bootstrap()` (new databases) and `migrate()` (additive `ALTER TABLE` for live ones), with an honest-failure backfill (`status='failed'`, `lastError='photoUrl unavailable — record predates persisted-queue migration'`) for any pre-existing non-terminal row that has no photo URL to recover (D-13).
- `LocalStore.enqueueNotification()` structurally implements D-05 in SQL: its `ON CONFLICT ... WHERE status NOT IN ('delivered','failed')` clause makes a repeat `file_upload` for an already-terminal job a no-op at the database level, not an `if` a later edit could delete.
- `LocalStore.getDueNotifications()`/`claimNotification()` give the sweeper a due-time + status query and a lease-claim `UPDATE`; a row whose owning process died mid-flight (`status='sending'`) becomes due again on its own once its lease expires — no separate boot-time recovery pass exists or is needed (D-04).
- `saveNotification()`'s `ON CONFLICT` clause protects `photoUrl`/`dueAt` with `COALESCE(excluded.col, notification_record.col)` — every other status-write column stays a bare `excluded.col`, but these two would otherwise be nulled by every retry-status write.
- `sendPhotoLink()` is now enqueue-only and performs zero network I/O (D-06), proven directly by a stubbed `fetch` that is asserted never called. `queueService.ts`'s un-awaited call site at line 225 is untouched and unmodified (`git diff --name-only 9b20d9e..HEAD -- src/queue/queueService.ts` prints nothing).
- `sweep()`/`attemptDelivery()` implement the bounded-retry sweeper: claim → attempt → `delivered`/`retrying`/`failed`, with the retry-exhaustion boundary written and traced as strictly `nextAttempt < 1 + this.maxRetries` (not `<=`) — with the shipped default `maxRetries=2`, delivery goes terminal on attempt 3, exactly 3 total attempts, matching D-15.
- `NOTIFY_FETCH_TIMEOUT_MS` (10_000), `NOTIFY_SWEEP_INTERVAL_MS` (3_000), `NOTIFY_CLAIM_LEASE_MS` (60_000) added as typed config via the existing `toNum()` idiom; the constructor's new `opts` param clamps the effective claim lease to at least twice the effective fetch timeout so misconfiguration can never expire a lease under a live request. `AbortSignal`/fetch-timeout wiring itself is explicitly deferred to plan 04-02 (`grep -c "AbortSignal" src/notifications/notificationService.ts` → 0).
- `src/index.ts` calls `notifier.start()` in the `app.listen` callback (beside `queue.start()`) and `notifier.stop()` in `shutdown()` — the sweeper now actually runs in production bootstrap.
- The two pre-existing notification test files (from baseline commit `5519364`) were rewritten onto the new enqueue/sweep contract and, per D-14, `test/notification-webhook.test.ts` lost its last `getStore()` singleton coupling and its hardcoded `job-webhook-001` id.

## Task Commits
1. **Task 1 (RED — failing tracer proof)** — `623818e` `test(04-01): add failing restart-resumed delivery proof for the persisted notification queue`
2. **Task 1 (GREEN — persisted queue implementation)** — `cb5467c` `feat(04-01): replace in-memory notification retries with a persisted, restart-resumed queue`
3. **Task 2** — `13117f0` `test(04-01): bring pre-existing notification tests onto the enqueue/sweep contract (D-14)`

## Files Created/Modified
- `mirror-request/test/notification-sweeper-restart.test.ts` (new) — the tracer's end-to-end proof: enqueue-without-network, restart-resumed delivery with exact-keys payload assertion, delivered-row-never-resent, pre-migration-row-marked-failed.
- `mirror-request/src/config.ts` — three new `NOTIFY_*` typed config keys; `NOTIFY_MAX_RETRIES` default 3 → 2.
- `mirror-request/src/types.ts` — `EnvConfig` gains the three new keys; `NotificationRecord` gains optional `photoUrl`/`dueAt`.
- `mirror-request/src/state/localStore.ts` — schema, migration, `saveNotification()` COALESCE fix, three new methods.
- `mirror-request/src/notifications/notificationService.ts` — rewritten: `notifyLogger`, injectable-timing constructor `opts`, enqueue-only `sendPhotoLink()`, `start()`/`stop()`/`sweep()`/`attemptDelivery()`.
- `mirror-request/src/index.ts` — `notifier.start()`/`notifier.stop()` added to bootstrap/shutdown.
- `mirror-request/test/notification-service.test.ts` — restructured into an enqueue case and a sweep-delivery case; `vi.unstubAllGlobals()` added to `afterEach`.
- `mirror-request/test/notification-webhook.test.ts` — temp-path `LocalStore` (three-argument `NotificationService` constructor) replaces the singleton; per-test generated job id replaces `job-webhook-001`.

## Decisions & Deviations

### Deviation 1 — Test 4's setup could not follow the plan's literal recipe (Rule 1, correctness)
The plan's `<behavior>` describes test 4 as: "write a row through `saveNotification({ jobId, status: 'pending', attempts: 1 })` (which sets no photo URL), reopen the store, and assert the record is `failed`." Implemented literally, this cannot exercise the migration backfill at all: `bootstrap()` gives any brand-new temporary database the `photoUrl`/`dueAt` columns directly (per Task 1's own instruction to extend `bootstrap()`'s `CREATE TABLE`), so on "reopen" `migrate()`'s `PRAGMA table_info` check finds both columns already present, the "at least one column was actually added" gate never fires, and the backfill never runs — the row would stay `pending` forever, the opposite of what the test asserts. Followed the codebase's own existing precedent instead: `test/on-register-dedup.test.ts`'s `received_at` migration test constructs the pre-phase-schema table directly with a raw `better-sqlite3` `Database` handle, inserts the row, closes it, then opens a `LocalStore` on the same path — this genuinely exercises the `ALTER TABLE`+backfill path. `test/notification-sweeper-restart.test.ts`'s fourth test follows that same shape. Confirmed passing (`status: 'failed'`, `lastError` matching `/photoUrl unavailable/`).

### Deviation 2 — notification-webhook.test.ts's promise-resolution point moved from the server handler to the client-side sweep() completion (Rule 1, bug)
An initial draft (matching the pre-existing test file's structure) resolved the outer test promise from inside the HTTP server's `req.on('end', ...)` handler — the same point the pre-existing test used. Under the old contract that was safe because `sendPhotoLink()` performed the fetch and the `saveNotification()` write in the same call, both of which had already started before the server received the request. Under the new contract, `sendPhotoLink()` only enqueues, and `sweep()` is a separate call whose `saveNotification()` write happens *after* the client has processed the HTTP response — a later step than the server receiving the request. Resolving on the server side let `afterEach()` close the temp-path store while `sweep()`'s continuation was still in flight, producing an intermittent unhandled `TypeError: The database connection is not open` rejection from `better-sqlite3`. Fixed by explicitly chaining `sendPhotoLink().then(() => service.sweep()).then(resolve, reject)` so the test's promise resolves only once the full client-side write has landed. Verified clean (no unhandled-rejection warnings) across 3 consecutive full-suite runs.

No other deviations. Both tasks otherwise executed exactly as planned, including the corrected `nextAttempt < 1 + this.maxRetries` retry boundary the plan-checker fixed before dispatch.

## Values plans 04-02 and 04-03 will need to quote

- **Final backoff/lease values:** `NOTIFY_FETCH_TIMEOUT_MS = 10_000`, `NOTIFY_SWEEP_INTERVAL_MS = 3_000`, `NOTIFY_CLAIM_LEASE_MS = 60_000` (all defaults, all overridable via env and via the constructor's `opts` parameter). Effective claim lease is `Math.max(requestedLeaseMs, fetchTimeoutMs * 2)`. Backoff on retry is `this.baseDelayMs * 2 ** (nextAttempt - 1)` where `baseDelayMs` defaults to `config.NOTIFY_RETRY_BASE_DELAY_MS` (1000ms, unchanged from before this plan).
- **Honest-failure `lastError` string, verbatim:** `photoUrl unavailable — record predates persisted-queue migration`
- **Exact five payload keys, verbatim, in the order the code emits them:** `jobId`, `guestName`, `photoUrl`, `timestamp`, `mode`. Sorted-alphabetical form used in every exact-keys assertion: `['guestName', 'jobId', 'mode', 'photoUrl', 'timestamp']`.
- **Generated-id format chosen in `notification-webhook.test.ts`:** `` `job-webhook-${Date.now()}` ``. `notification-sweeper-restart.test.ts` uses `` `job-sweep-${Date.now()}-${n}` `` (n = 1..3 across its three HTTP-backed tests) and `` `job-premigration-${Date.now()}` `` for the migration-only test.
- **Retry-exhaustion boundary, verbatim as committed:** `if (nextAttempt < 1 + this.maxRetries) { ... retrying ... } else { ... failed ... }` — strictly `<`, confirmed to yield exactly 3 total attempts with the shipped `maxRetries = 2` default.
- **`NotificationService`'s constructor signature (unchanged positional shape, one new param):** `(maxRetries = config.NOTIFY_MAX_RETRIES, storeOrWebhook: LocalStore | string = getStore(), webhookUrl = config.NOTIFY_WEBHOOK_URL, opts: { fetchTimeoutMs?; sweepIntervalMs?; claimLeaseMs?; baseDelayMs? } = {})`.

## Verification
- `cd mirror-request && npx vitest run test/notification-sweeper-restart.test.ts` — 4/4 passing.
- `cd mirror-request && npx vitest run test/notification-service.test.ts test/notification-webhook.test.ts` — 3/3 passing.
- `cd mirror-request && npm test` — 24 files / 160 tests green (155 pre-existing + 5 new/restructured), run 3 times back-to-back with identical results.
- `cd mirror-request && npm run typecheck` — clean.
- `cd mirror-request && npm run build` — clean.
- `cd mirror-request && git status --porcelain` — clean tree after all three commits.
- `cd mirror-request && git diff --name-only 9b20d9e..HEAD` — exactly the 8 files this plan's `files_modified` frontmatter lists; `src/display/` and `src/queue/` appear nowhere.
- All acceptance-criteria greps from the plan (`getStore` count 0 in both new/rewritten test files, `AbortSignal` count 0 in `notificationService.ts`, `NOTIFY_MAX_RETRIES...2)` present and `...3)` absent in `config.ts`, `job-webhook-001` count 0, `new LocalStore(` present, `unstubAllGlobals` present) confirmed directly.
- Stale `mirror-request/.planning/` tree confirmed untouched (`git status --short .planning/` and `git diff --name-only 9b20d9e..HEAD -- .planning/` both empty); `web-slide/` and `dslrbooth-agent/` untouched (grep of the diff file list for either path returns nothing).

## Next Phase Readiness
Plan 04-02 (failure-posture refinements: fetch timeout via `AbortSignal`, error classification, operator-facing exhaustion log line, per-row isolation) and plan 04-03 can build directly on this plan's `sweep()`/`attemptDelivery()`/`enqueueNotification()`/`getDueNotifications()`/`claimNotification()` surface and the exact literal values recorded above. No blockers. Reversibility note carried forward from the plan: this migration marks pre-existing non-terminal `notification_record` rows permanently `failed` — plan 04-04's phase gate still requires a database backup and explicit human acknowledgement before deploy, unchanged by this plan.
