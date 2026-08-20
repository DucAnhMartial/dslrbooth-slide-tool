---
phase: 04-guest-notification
verified: 2026-08-10T16:18:58Z
status: passed
score: 19/19 must-haves verified
behavior_unverified: 0
overrides_applied: 2
overrides:
  - must_have: "Production NOTIFY_WEBHOOK_URL is reachable from the deploy host"
    reason: "The sandbox denies all Read/Bash access to any .env* path — an unworkaroundable environment constraint, not an implementation gap. Remains the operator's documented pre-deploy step (OPS-RUNBOOK §3, §8). The service's warn-and-skip on an unset URL is the safe fallback and is verified in code (notificationService.ts:56-59)."
    accepted_by: "human (Phase 4 gate, recorded in 04-04-SUMMARY.md §Task 3)"
    accepted_at: "2026-08-10T00:00:00Z"
  - must_have: "End-to-end real-photo run reaches the slideshow"
    reason: "Explicitly declined by the human at the phase gate with a stated reason: the service is stopped and the Phase 3 Agent-auth cutover has not been deployed, so no live Agent link exists to run it against. Deliberate deferral, not an oversight."
    accepted_by: "human (Phase 4 gate, recorded in 04-04-SUMMARY.md §Task 3)"
    accepted_at: "2026-08-10T00:00:00Z"
---

# Phase 4: Guest Notification — Verification Report

**Phase Goal:** When the booth finishes a session the guest's photo reaches the slideshow, and it stays reachable across a restart — because the work item is written to SQLite carrying the photo URL *before* any network call is made, and a periodic sweeper delivers whatever is due. Delivery is bounded in both time and attempts: a hung receiver aborts at a configured deadline, a failing one is retried a stated number of times and then recorded as terminally failed with a reason an operator can look up by guest name. A notification is never delivered twice, because the terminal states are absent from every query the sweeper runs rather than guarded by a condition a later edit could delete.

**Verified:** 2026-08-10T16:18:58Z
**Status:** passed
**Re-verification:** No — initial verification

**Verdict: the phase goal is genuinely achieved.** Every clause of the goal was traced to shipped code and to a test that exercises it, and the two highest-risk items flagged for this phase — the "a 2xx proves nothing" delivery assertion and the retry-budget off-by-one that was never re-reviewed by plan-checker — both hold in the shipped code. No genuine unresolved gaps were found.

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | (M4 SC1 / NOT-01) `file_upload` → look up guest by `jobId` → send via webhook | VERIFIED | `queueService.ts:225` → `sendNotification()` at `:297-299` → `sendPhotoLink()`; guest lookup `notificationService.ts:47` (enqueue guard) and `:123` (delivery); POST at `:149-154` |
| 2 | (M4 SC2 / NOT-02) Failed sends retried N times, then logged | VERIFIED | Retry branch `notificationService.ts:170-181`; terminal branch + single `notifyLogger.error` at `:188-194`; pinned by `test/notification-retry-count.test.ts` (4 tests) |
| 3 | Work item is written to SQLite carrying `photoUrl` **before** any network call; `sendPhotoLink()` is enqueue-only with zero network I/O (D-06) | VERIFIED | `notificationService.ts:65` is the sole statement after the three guards — `store.enqueueNotification({jobId, photoUrl, dueAt})`. No `fetch` in the method. `test/notification-sweeper-restart.test.ts:90` asserts `requestCount === 0` against a **real** server; `:93` asserts the photo URL persisted |
| 4 | A restart resumes delivery — a fresh process delivers without the original caller's stack frame | VERIFIED | `test/notification-sweeper-restart.test.ts:100-135`: `storeA` enqueues then `storeA.close()`; a fresh `new LocalStore(dbPath)` + fresh `NotificationService` deliver via one `sweep()`. Not a second method call on the same objects |
| 5 | Outbound body carries exactly five keys — `jobId`, `guestName`, `photoUrl`, `timestamp`, `mode` — and no email/phone (D-02, D-03) | VERIFIED | Payload `notificationService.ts:142-148`. `grep -nE "email\|phone" src/notifications/notificationService.ts` returns **0 lines** (measured). Exact-key assertion in all three delivery tests (see Behavioral Spot-Checks) |
| 6 | A notification is never delivered twice because terminal states are **absent from the sweeper's queries**, not guarded by a deletable `if` (D-05) | VERIFIED | `localStore.ts:435` `status IN ('pending','retrying','sending')` and `:446` same predicate on the claim — `'delivered'`/`'failed'` absent from both. `enqueueNotification` re-arm guard `:420` `WHERE ... status NOT IN ('delivered','failed')`. Confirmed structurally: grep for `delivered\|failed` in `notificationService.ts` returns only **write** sites (`:129, :156, :190, :194`) — no read-side conditional exists to delete |
| 7 | A status-only write cannot erase the persisted photo URL | VERIFIED | `localStore.ts:372-373` `photoUrl = COALESCE(excluded.photoUrl, notification_record.photoUrl)` (and same for `dueAt`), contrasted against bare `excluded.<col>` for status/attempts/lastError at `:369-371`. Pinned by `test/local-store-persistence.test.ts:227` |
| 8 | A job is attempted exactly `1 + NOTIFY_MAX_RETRIES` times — **3** under the shipped default (D-08, D-15) | VERIFIED | `notificationService.ts:170` reads `if (nextAttempt < 1 + this.maxRetries)` — strictly `<`. Measured: `grep -c "nextAttempt <= "` returns **0**. Default chain: `config.ts:103` `NOTIFY_MAX_RETRIES → 2` (measured: old `,3)` form returns **0**, new `,2)` form returns **1**) → constructor default `notificationService.ts:23`. Count pinned at 3, not merely "retries happen": `notification-retry-count.test.ts:78` `toHaveBeenCalledTimes(3)` **and** `:85` re-asserts 3 after further sweeps |
| 9 | Exhaustion → `status='failed'` with a reason and **exactly one** error line (D-09) | VERIFIED | `notificationService.ts:188-194` writes terminal state first, then one `notifyLogger.error`. `notification-retry-count.test.ts:113` `expect(errorSpy).toHaveBeenCalledTimes(1)`, plus job-id and attempt-count content assertions at `:114-115` |
| 10 | A hung receiver aborts at the configured deadline; timeout is distinguished from connection refusal (D-07) | VERIFIED | `notificationService.ts:153` `signal: AbortSignal.timeout(this.fetchTimeoutMs)` on the delivery fetch; `classifyError()` at `:207-211`. Proven against a **real never-responding `http.Server`** — `test/notification-fetch-timeout.test.ts:37-66` (test 1 accepts the connection, never responds, asserts `lastError === 'timeout'`), with refusal/non-2xx distinguished at `:83-108` |
| 11 | One row's failure never throws out of `sweep()` and never stops the next row (D-10) | VERIFIED | Per-row `try`/`catch` `notificationService.ts:103-114`; `test/notification-sweeper-claim.test.ts:121` |
| 12 | Two overlapping sweep passes deliver a row exactly once (D-05) | VERIFIED | Claim-predicate guard `localStore.ts:442-448` returning `result.changes === 1`; `test/notification-sweeper-claim.test.ts:62` |
| 13 | A pre-existing row with no `photoUrl` is marked `failed` with an explanatory reason, not left pending forever (D-13) | VERIFIED | `localStore.ts:113-118` backfill, gated on a column actually having been added. `test/notification-sweeper-restart.test.ts:165-195` builds a genuine old-shape table with raw SQL (the only way to make the gate fire) and asserts `failed` + `/photoUrl unavailable/`; also `local-store-persistence.test.ts:98` |
| 14 | Opening the same database twice runs `migrate()` twice and changes nothing the second time — additive and idempotent | VERIFIED | `localStore.ts:101-119` PRAGMA-guarded `ALTER TABLE`, no drop/recreate. `local-store-persistence.test.ts:108` (idempotent), `:135` (additive-only), `:166` (a pre-existing `delivered` row is left untouched) |
| 15 | An operator can find, by one documented SQL query, every guest whose photo never reached the slideshow | VERIFIED | `docs/OPS-RUNBOOK.md:539-553`. **Executed by this verifier** against a scratch DB built by the real `LocalStore` — returned `{"jobId":"j1","guestName":"Nguyen Van A","lastError":"timeout","attempts":3,...}`. The join columns are real (`queue_job.registration_id`, `registration.id/name`, schema `localStore.ts:24-45`) |
| 16 | The payload contract, the three new env vars, and the changed meaning of `NOTIFY_MAX_RETRIES` are published before anyone deploys | VERIFIED | `docs/OPS-RUNBOOK.md` §8 at `:425` (payload `:432`, delivery model `:477`, status vocabulary `:491`, failure vocabulary `:508`, lookup `:539`, re-arm `:560`, retry budget `:581`, migration note `:598`); §3 extended. §581-596 states the strict-`<` boundary and warns that anyone who set the variable explicitly now gets one more attempt |
| 17 | Nothing outside the declared file set changed — queue seam, display feed and `web-slide` untouched (D-06, D-11, D-12) | VERIFIED | `git diff --name-only 9b20d9e..HEAD` lists exactly **13** files (measured), all declared. `git diff --name-only 9b20d9e..HEAD -- src/queue/ src/display/` returns **0** files (measured). `web-slide/server.js` mtime `2026-08-07 04:26:20` predates the first Phase 4 commit (`623818e`, `2026-08-10 15:17:54`) — unmodified |
| 18 | A human explicitly accepted that deploying mutates rows in the live production DB, with a backup taken first (D-04) | VERIFIED | Backup present: `data/backups/extension-service.sqlite.2026-08-10T11-12-38.bak`, **57344 bytes** (measured, matches the recorded number). Acceptance recorded in `04-04-SUMMARY.md:120-130`. Live pre-state independently re-measured — see Data-Flow Trace below |
| 19 | No Phase 4 test reaches the shared database singleton (D-14) | VERIFIED | Measured `grep -c getStore` across all six notification test files returns **0** for each. `job-webhook-001` count **0**; `new LocalStore(` count **1** in the webhook test, which also uses the three-argument constructor (`notification-webhook.test.ts:20-45`) so the string overload's hidden singleton fallback is not reached |

**Score:** 19/19 truths verified (0 present, behavior-unverified) — includes 2 PASSED (override).

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/state/localStore.ts` | `photoUrl`/`dueAt` in bootstrap + migrate; `enqueueNotification`, `getDueNotifications`, `claimNotification`; COALESCE guard | VERIFIED | Bootstrap `:56-64`, migrate `:101-119`, methods `:409/:432/:442`, COALESCE `:372-373` |
| `src/notifications/notificationService.ts` | enqueue-only `sendPhotoLink()`, `sweep()`, `attemptDelivery()`, `start()`/`stop()`, `notifyLogger` | VERIFIED | All present, 217 lines; `notifyLogger` exported `:9` and used for every log call |
| `src/config.ts` | three new typed keys; `NOTIFY_MAX_RETRIES` default flipped to 2 | VERIFIED | `:103-107`; no `process.env` read outside `config.ts` |
| `src/index.ts` | `notifier.start()` in listen callback, `notifier.stop()` in shutdown | VERIFIED | `:74` inside the `app.listen` callback (beside `queue.start()`), `:83` in `shutdown()` |
| `test/notification-sweeper-restart.test.ts` | end-to-end restart-resumed proof against a real HTTP server | VERIFIED | 196 lines, 4 tests, real `http.createServer` at `:53`, `listen(0,'127.0.0.1')` |
| `test/notification-fetch-timeout.test.ts` | timeout + classification | VERIFIED | 4 tests; test 1 uses a real never-responding server |
| `test/notification-retry-count.test.ts` | attempt count pinned | VERIFIED | 4 tests; `FakeStore` models the real SQL predicate shape so backoff `dueAt` genuinely gates the next sweep |
| `test/notification-sweeper-claim.test.ts` | claim isolation + per-row containment | VERIFIED | 4 tests |
| `test/local-store-persistence.test.ts` | migration + persisted-queue SQL contract | VERIFIED | Two new describe blocks at `:79` and `:181`, 10 new cases |
| `docs/OPS-RUNBOOK.md` §8 + §3 | payload contract, vocabularies, lookup, re-arm, env vars | VERIFIED | §8 at `:425-600+`; §3 extended |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `queueService.ts:225` | `NotificationService.sendPhotoLink()` | `sendNotification()` wrapper `:297-299` | WIRED | Seam signature unchanged; `queueService.ts` has **0** diff lines vs `9b20d9e` (measured) |
| `index.ts:74` | `notifier.start()` | `app.listen` callback | WIRED | Without this the sweeper never runs and every notification stops at `pending` — present and beside `queue.start()` |
| `enqueueNotification()` ON CONFLICT `WHERE` | D-05 re-arm guard | `localStore.ts:420` | WIRED | Terminal row cannot be re-armed by a repeat `file_upload` |
| `AbortSignal.timeout()` | `classifyError()`'s `TimeoutError` branch | `notificationService.ts:153` → `:208` | WIRED | The error-shape assumption (RESEARCH A4, rated MEDIUM confidence) is proven against this runtime's real undici fetch, not assumed |
| `attemptDelivery()` exhaustion branch | `notifyLogger.error` | `notificationService.ts:194` | WIRED | The only operator-visible signal; count pinned at exactly 1 |
| OPS-RUNBOOK §8 payload | `web-slide/server.js` field reads | doc ↔ code | WIRED | Documented keys `guestName`/`photoUrl`/`jobId`/`mode` match both the shipped payload (`:142-148`) and the receiver's reads (`server.js:64-71`) |

---

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| outbound payload | `guestName` | `store.getJobRegistration(row.jobId).registration.name` (`:123`, `:144`) | Yes — real SQLite row | FLOWING |
| outbound payload | `photoUrl` | persisted `notification_record.photoUrl`, selected by `getDueNotifications` (`:434`) | Yes — survives restart; proven by the two-store test | FLOWING |
| operator lookup | `guestName` | 3-table JOIN, executed by this verifier | Yes — returned a real row | FLOWING |
| live production DB | `notification_record` | `data/extension-service.sqlite` (read-only) | See note below | FLOWING |

**Live database, independently re-measured read-only by this verifier** (SELECT/PRAGMA only; the real backend MySQL was never touched, per `CLAUDE.md`):

- Columns today: `jobId,status,attempts,lastError,updatedAt` — the **pre-migration** shape. `photoUrl`/`dueAt` are not yet present.
- Rows by status: `[{"status":"delivered","n":1}]`. Total rows: **1**.

This exactly matches the numbers recorded at the phase gate (1 row, `delivered`) and is **not a defect**: the migration runs inside `migrate()` on first boot, and the service is deliberately stopped pending the Phase 3 cutover. `OPS-RUNBOOK.md:598-600` states this plainly ("The first boot after this deploy rewrites rows"), and `04-04-SUMMARY.md` claims the migration was *accepted*, never that it was *applied* — the summary and the observed state agree. Because the single live row is terminal (`delivered`), the backfill predicate `WHERE photoUrl IS NULL AND status NOT IN ('delivered','failed')` matches **0 rows**: the blast radius on the current production data is zero, as recorded.

---

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full suite green | `npm test` | **27 files, 182 tests, all passed**, 5.61s | PASS |
| Types clean | `npm run typecheck` (`tsc --noEmit`) | no output, exit 0 | PASS |
| Build clean | `npm run build` (`tsc`) | no output, exit 0 | PASS |
| Exact-body assertion in every delivery test | `grep -n "Object.keys" test/*.test.ts` | 3 notification tests assert `.sort()` `toEqual(['guestName','jobId','mode','photoUrl','timestamp'])` — `notification-sweeper-restart:126`, `notification-service:63`, `notification-webhook:87` | PASS |
| No weakened assertions remain | `grep -n toMatchObject test/notification-*.test.ts` | 4 hits, **all inside comments** explaining why the exact-key form was chosen — opened and read each; zero live `toMatchObject` calls | PASS |
| Retry boundary operator | `grep -n "nextAttempt < 1 + this.maxRetries"` / `grep -c "nextAttempt <= "` | 1 hit strict `<` at `:170`; **0** hits for `<=` | PASS |
| Config default flip | `grep -cE "NOTIFY_MAX_RETRIES' *, *3\)"` / `,*2\)` | **0** / **1** | PASS |
| No PII in payload path | `grep -nE "email\|phone" src/notifications/notificationService.ts` | **0** lines | PASS |
| Operator lookup query actually runs | executed §8's SELECT against a scratch `LocalStore` DB | returned `guestName: "Nguyen Van A"`, `lastError: "timeout"`, `attempts: 3` | PASS |
| Working tree clean | `git status --short` | only ` M .planning/STATE.md` — the pre-existing, not-mine drift in the stale tree; nothing added to it | PASS |

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| NOT-01 | 04-01, 04-04 | `file_upload` → lookup `jobId` → find contact info → send photo via webhook trigger | SATISFIED | Truths 1, 3, 4, 5; real-HTTP restart-resumed delivery test |
| NOT-02 | 04-02, 04-03, 04-04 | Bounded retry on failure — log for manual handling | SATISFIED | Truths 2, 8, 9, 15; exactly 3 attempts, one error line, executable operator lookup |

No orphaned requirements: `REQUIREMENTS.md:62` maps `NOT-01..02` to Phase 4, and both are claimed by plans.

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| — | — | — | — | None |

Measured: scanning all 13 changed files for `TBD|FIXME|XXX|TODO|HACK|PLACEHOLDER` returned **no matches**. No debt-marker gate violation. No stubs, no empty handlers, no static-return endpoints in the changed set.

**Grep false positives explicitly ruled out** (this project has been bitten three times): the four `toMatchObject` hits and every `getStore`-adjacent hit were opened and read in place — all are prose in comments documenting an *absence*, not live code.

---

## Accepted Gaps (recorded, not failures)

These were adjudicated by the human at the phase gate with stated reasons. They are carried as `overrides` in the frontmatter, not as defects.

1. **Production `NOTIFY_WEBHOOK_URL` reachability — NOT verified.** All `.env*` paths are sandbox-denied; no attempt was made to read them. Remains the operator's pre-deploy step (`OPS-RUNBOOK` §3, §8). The unset-URL path is a safe warn-and-skip (`notificationService.ts:56-59`).
2. **End-to-end real-photo run — explicitly declined**, because the service is stopped and the Phase 3 Agent-auth cutover is undeployed, so no live Agent link exists to run it against.

## Carry-Forward Items (not Phase 4 blockers)

- `WINDOWS.md` ledger item 4 — shared test DB via the `getStore()` singleton across parallel vitest workers. **Not worsened by this phase**: all six notification test files use per-test temp-path stores and generated ids (measured `getStore` count 0 in each). The one surviving `getStore()` case at `test/local-store-persistence.test.ts:60` is pre-existing and deliberately tests the accessor itself.
- `WINDOWS.md` ledger item 5 — Phase 3 connection-id log masking. Unrelated to this phase.
- The Phase 3 Agent-auth cutover is undeployed; server and Agent must ship in the same window per `OPS-RUNBOOK` §7.
- The live migration applies on first boot after deploy; backup already taken, blast radius measured at zero non-terminal rows.

## Informational Observation (not a gap)

Delivery is **at-least-once**, not exactly-once, in one narrow window: if the process dies after the POST is received by `web-slide` but before `saveNotification({status:'delivered'})` commits, the `sending` row's lease expires and the sweeper re-delivers. This is inherent to the persisted-queue shape and is *outside* the goal's stated guarantee, which is specifically that terminal states are absent from the sweeper's queries — and that guarantee holds exactly as written. The lease is clamped to at least twice the fetch timeout (`notificationService.ts:39-43`), which correctly prevents the much likelier failure of expiring a lease under a live in-flight request. Recorded only so a future reader is not surprised.

---

## Gaps Summary

**No genuine unresolved gaps.**

The two items this phase was most at risk on were checked directly rather than taken from the summaries:

1. **"A 2xx proves nothing."** The requirement was a real ephemeral HTTP server, an exact-body assertion, and coverage of a *post-restart-resumed* delivery. All three hold in one place: `test/notification-sweeper-restart.test.ts:96-135` enqueues through `storeA`, closes it, opens a fresh `LocalStore`/`NotificationService` pair on the same file, sweeps, and asserts `Object.keys(body).sort()` equals the exact five-key set plus each value. The receiver's silent fallbacks therefore cannot mask a payload-shape regression.

2. **The retry-budget off-by-one that was fixed in the plans but never re-reviewed by plan-checker.** The shipped code reads `if (nextAttempt < 1 + this.maxRetries)` at `notificationService.ts:170` — strictly `<`, with **0** occurrences of `<=` in the file. Combined with the measured `NOTIFY_MAX_RETRIES` default of `2` (`config.ts:103`), that is exactly 3 total attempts, and the count is pinned by an assertion on the number (`toHaveBeenCalledTimes(3)`, re-asserted after further sweeps) rather than by a vaguer "retries happen" test. The execution-only closure of that plan-checker finding did not let a defect through.

The D-05 guarantee is genuinely structural: `'delivered'` and `'failed'` appear in `notificationService.ts` only as values being *written*, never as a condition being *read*, so there is no `if` a later edit could delete — the guarantee lives entirely in what `getDueNotifications` and `claimNotification` omit from their `status IN (...)` lists.

---

## Note for Phase 5 (forward-look)

**Phase 5 is not greenfield.** Measured, not assumed:

- `src/display/displayServer.ts` — **76** lines
- `src/display/displayPage.ts` — **60** lines
- `test/phase5-display.test.ts` — **78** lines, **2** tests currently passing
- Both M5 routes already exist: `GET /display-screen` at `src/index.ts:29`, `GET /status/:jobId` at `src/index.ts:36`

Per D-12 these are the *live booth status feed* (port 3002), a different surface from the `web-slide` photo slideshow (port 3001) this phase fed. Phase 4 left all of it untouched (0 changed files under `src/display/`), so Phase 5 planning should audit this existing code rather than assume an empty start — the same posture Phase 4 correctly took toward commit `5519364`.

---

_Verified: 2026-08-10T16:18:58Z_
_Verifier: Claude (gsd-verifier)_
