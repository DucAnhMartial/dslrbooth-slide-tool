---
phase: 04-guest-notification
plan: 02
subsystem: notifications
tags: [sqlite, persisted-queue, retry, webhook, better-sqlite3, vitest, abortsignal]
requires:
  - phase: 04-guest-notification
    provides: "Persisted retry queue (photoUrl/dueAt columns, enqueue/sweep/claim SQL) from plan 04-01"
provides:
  - "attemptDelivery()'s fetch bounded by AbortSignal.timeout(NOTIFY_FETCH_TIMEOUT_MS) — a hung web-slide can no longer hold an attempt open indefinitely"
  - "classifyError() distinguishing 'timeout' from other failure reasons, confirmed against a real never-responding http.Server (not assumed from docs)"
  - "The retry budget's operator-facing exhaustion record: notifyLogger.error naming the job id, attempt count, and reason, exactly once per permanently-failed delivery"
  - "sweep()'s per-row try/catch — one bad row's unexpected exception can never crash the process or stop the next row"
affects: [04-guest-notification, 05-client-api-display-feed]
actuals:
  tokens: 6270
  tasks: 3
  commits: 3
tech-stack:
  added: []
  patterns:
    - "Real never-responding http.Server (not a mocked fetch) as the load-bearing proof for a timeout error shape RESEARCH.md rated MEDIUM confidence — confirmed the shape empirically rather than trusting the docs cross-check"
    - "Two NotificationService instances sharing one mocked store to prove D-05's claim guarantee is structural (SQL predicate + honest lease write), not an artifact of a single instance's in-process re-entrancy flag"
    - "Terminal-write-then-one-log-line ordering (queueService.ts's handleStall() shape) reused for the exhaustion branch — durable record first, then exactly one notifyLogger.error line, never a throw"
key-files:
  created:
    - mirror-request/test/notification-fetch-timeout.test.ts
    - mirror-request/test/notification-retry-count.test.ts
    - mirror-request/test/notification-sweeper-claim.test.ts
  modified:
    - mirror-request/src/notifications/notificationService.ts
key-decisions:
  - "Real-runtime error shape CONFIRMED, not assumed: Node 20's AbortSignal.timeout() rejects the delivery fetch with an Error whose name is 'TimeoutError', exactly matching RESEARCH.md Assumption A4's MEDIUM-confidence, docs-only prediction. Proven against a real ephemeral http.Server whose handler never calls the response's end — no mocked promise, no assumption. classifyError()'s 'TimeoutError' branch is reachable and correct as written; no adjustment was needed."
  - "notifyLogger.error's exhaustion message, exact as committed: `Notification permanently failed for job ${row.jobId} after ${nextAttempt} attempts: ${reason}`. Written after the durable 'failed' saveNotification() write, mirroring queueService.ts's handleStall() terminal-write-then-log-line order. No error-level log on the retry branch — an intermediate retry is not yet an operator problem."
  - "D-05's overlapping-sweep test uses two distinct NotificationService instances sharing one mocked store, not two sweep() calls on the same instance — a single instance's own `sweeping` boolean would trivially block re-entry and mask whether the SQL claim predicate (not the flag) is actually what prevents double delivery. Confirmed the claim's honest lease write (dueAt = now + claimLeaseMs) is what makes the second instance's getDueNotifications() find nothing."
patterns-established:
  - "Timeout-vs-refusal error classification: classifyError(err) checks err.name === 'TimeoutError' first, falls through to err.message, then String(err) — reusable shape for any future outbound fetch needing the same distinction."
requirements-completed: [NOT-02]
coverage:
  - id: D1
    description: "Every delivery attempt is bounded in wall-clock time; a hung web-slide cannot hold an attempt open indefinitely (D-07)"
    requirement: "NOT-02"
    verification:
      - kind: unit
        ref: "test/notification-fetch-timeout.test.ts#test 1 (load-bearing): a real server that accepts a connection and never responds aborts at the configured deadline"
        status: pass
    human_judgment: false
  - id: D2
    description: "A recorded lastError distinguishes a timeout from a connection refusal or a non-2xx HTTP status (D-07)"
    requirement: "NOT-02"
    verification:
      - kind: unit
        ref: "test/notification-fetch-timeout.test.ts#test 2: TimeoutError-named error records the timeout reason"
        status: pass
      - kind: unit
        ref: "test/notification-fetch-timeout.test.ts#test 3: TypeError records a distinguishable, non-timeout reason"
        status: pass
      - kind: unit
        ref: "test/notification-fetch-timeout.test.ts#test 4: a non-2xx response records a reason naming the HTTP status"
        status: pass
    human_judgment: false
  - id: D3
    description: "A job is attempted exactly 1 + NOTIFY_MAX_RETRIES times (3 total under the shipped default) then stops permanently (D-08, NOT-02)"
    requirement: "NOT-02"
    verification:
      - kind: unit
        ref: "test/notification-retry-count.test.ts#test 1: fetch is called exactly 3 times, never a 4th"
        status: pass
      - kind: unit
        ref: "test/notification-retry-count.test.ts#test 2: the terminal record is failed, attempts is 3, lastError is non-empty"
        status: pass
    human_judgment: false
  - id: D4
    description: "Exhaustion produces a durable failed record and exactly one operator-facing error log line naming the job and attempt count (D-09, NOT-02)"
    requirement: "NOT-02"
    verification:
      - kind: unit
        ref: "test/notification-retry-count.test.ts#test 3: notifyLogger.error is called exactly once, naming the job id and the attempt count"
        status: pass
      - kind: unit
        ref: "test/notification-retry-count.test.ts#test 4: after exhaustion, a further sweep performs no fetch at all"
        status: pass
    human_judgment: false
  - id: D5
    description: "Two overlapping sweep passes deliver a row exactly once (D-05); an unexpected per-row exception never throws out of sweep() or stops the next row (D-10)"
    requirement: "NOT-02"
    verification:
      - kind: unit
        ref: "test/notification-sweeper-claim.test.ts#test 1 (D-05): two overlapping sweep passes deliver a row exactly once"
        status: pass
      - kind: unit
        ref: "test/notification-sweeper-claim.test.ts#test 2 (D-05, restart shape): a sending row past its lease is due again; one still under lease is not"
        status: pass
      - kind: unit
        ref: "test/notification-sweeper-claim.test.ts#test 3 (D-10): an unexpected exception on one row never throws out of sweep() and never stops the next row"
        status: pass
      - kind: unit
        ref: "test/notification-sweeper-claim.test.ts#test 4 (Pitfall 2): a lost claim produces no log output at all"
        status: pass
    human_judgment: false
duration: ~25min
completed: 2026-08-10
status: complete
---

# Phase 4 Plan 2: Failure Posture for the Guest Notification Retry Queue Summary

**Bounded every delivery attempt with `AbortSignal.timeout()`, confirmed the runtime's real TimeoutError shape against a live never-responding server, added the single operator-facing exhaustion log line, and closed the last per-row isolation gap in `sweep()` — earning NOT-02 on top of plan 04-01's persisted queue.**

## Performance

- **Duration:** ~25 min
- **Tasks:** 3/3 completed
- **Files modified:** 4 (1 production, 3 new test files)

## Accomplishments

- `attemptDelivery()`'s delivery `fetch` now carries `signal: AbortSignal.timeout(this.fetchTimeoutMs)` — a Node 20 built-in, no new dependency, no hand-rolled `AbortController`/`Promise.race` (confirmed absent by grep). A receiver that accepts a connection and never answers no longer holds the attempt open indefinitely (D-07).
- `classifyError(err)` returns the single word `'timeout'` when `err instanceof Error && err.name === 'TimeoutError'`, otherwise the underlying `Error.message`, otherwise `String(err)`. **The runtime's actual abort shape was proven, not assumed:** Task 1's load-bearing test drove a real ephemeral `http.Server` whose handler never completes the response, pointed the service at it with `fetchTimeoutMs: 150`, and confirmed the recorded `lastError` is exactly `'timeout'` — RESEARCH.md's Assumption A4 (MEDIUM confidence, docs-only) holds exactly as predicted under this runtime's undici-backed `fetch`.
- The retry-exhaustion branch of `attemptDelivery()` now writes the durable `failed` record first, then emits exactly one `notifyLogger.error` line — `` `Notification permanently failed for job ${row.jobId} after ${nextAttempt} attempts: ${reason}` `` — mirroring `queueService.ts`'s `handleStall()` terminal-write-then-log-line order (D-09, NOT-02). No error-level log fires on the retry branch; the error-line count is a function of guests who never got their photo, not of the retry budget.
- The already-correct `nextAttempt < 1 + this.maxRetries` boundary from plan 04-01 was traced again, not just read, and confirmed still strictly `<`: with the shipped `maxRetries = 2`, exactly 3 total delivery attempts.
- `sweep()`'s per-row `await this.attemptDelivery(row)` is now wrapped in its own `try`/`catch` — `attemptDelivery()` already catches everything `fetch` itself can throw, but this closes the remaining gap for a store method throwing synchronously or a future edit adding a call above the try. Catches, warns once naming the job id, continues to the next row (D-10). A doc comment above `sweep()`'s loop now states in prose where D-05's never-deliver-twice guarantee actually lives (the `status IN (...)` predicate in `claimNotification()`'s SQL, not the `sweeping` flag) and names exactly which edits would silently reintroduce double delivery.
- `test/notification-sweeper-claim.test.ts`'s overlapping-sweep case deliberately uses **two distinct `NotificationService` instances sharing one mocked store**, not two `sweep()` calls on one instance — a single instance's own `sweeping` boolean would trivially block re-entry and would prove nothing about the SQL claim predicate the test exists to verify.

## Task Commits

1. **Task 1: Bound every attempt in time, and record whether it timed out or was refused** - `2cde9bf` (feat)
2. **Task 2: Prove the retry budget terminates at three attempts and leaves one operator-facing record** - `45a86fc` (feat)
3. **Task 3: One bad row cannot double-send and cannot stop the sweep** - `91a79ef` (feat)

_All three tasks were `tdd="true"`: for each, the new test file was written first and run to confirm it failed against the pre-task code (RED, verified via `npx vitest run` before touching production code, not committed separately), then the minimal production-code change was made and the same test file re-run to confirm it passed (GREEN) before the single atomic commit above, which contains both the new test file and the implementation change together._

## Files Created/Modified

- `mirror-request/src/notifications/notificationService.ts` — `AbortSignal.timeout()` added to the delivery fetch; new private `classifyError()`; `notifyLogger.error` added to the exhaustion branch with an in-words arithmetic comment; `sweep()`'s per-row loop gained a `try`/`catch` isolation guard and a D-05 provenance comment above the loop.
- `mirror-request/test/notification-fetch-timeout.test.ts` (new) — 4 cases: a real never-responding `http.Server` (load-bearing), a mocked `TimeoutError`, a mocked `TypeError` (connection-refused shape), a mocked non-2xx status.
- `mirror-request/test/notification-retry-count.test.ts` (new) — a `FakeStore` modeling one row's real due/claim/save lifecycle under `vi.useFakeTimers()`; 4 cases proving exactly 3 fetch calls, the terminal `failed`/`attempts=3` record, exactly one `notifyLogger.error` call, and no further fetch after exhaustion.
- `mirror-request/test/notification-sweeper-claim.test.ts` (new) — a `MultiRowFakeStore` modeling multiple rows under the same status/dueAt predicate LocalStore's real SQL uses; 4 cases proving overlapping-sweep exactly-once delivery, restart self-healing via lease expiry, per-row exception isolation, and silent no-op on a lost claim.

## Decisions Made

See `key-decisions` in frontmatter for the full detail — summarized:
- The real-runtime `TimeoutError` shape is now empirically confirmed (not assumed), closing RESEARCH.md's Assumption A4.
- The exhaustion log message's exact wording is fixed and quoted above for plan 04-03's runbook section.
- The overlapping-sweep test intentionally uses two service instances to isolate the SQL claim predicate (the thing D-05 actually guarantees) from the in-process `sweeping` flag (which is only defence in depth against one instance's own interval re-entrancy).

## Deviations from Plan

None — plan executed exactly as written. Each task followed RED (test written and confirmed failing against the pre-task code) → GREEN (the smallest production-code change to pass) → verified against the plan's `<acceptance_criteria>` greps before committing. No auto-fixes, no architectural questions, no auth gates.

## Issues Encountered

None.

## User Setup Required

None — no external service configuration required. `AbortSignal.timeout()` is a Node 20 built-in; no new dependency was installed.

## Values plan 04-03 will need to quote

- **Exact exhaustion log message, verbatim:** `` `Notification permanently failed for job ${row.jobId} after ${nextAttempt} attempts: ${reason}` `` — e.g. `Notification permanently failed for job job-a after 3 attempts: timeout`.
- **Exact `lastError` reason strings:** `'timeout'` (from `classifyError()` when the delivery fetch aborts on deadline); the pass-through `Error.message` for any other rejected fetch (e.g. a connection-refused `TypeError`'s message); `` `Webhook returned HTTP <status>` `` for a resolved-but-non-2xx response.
- **Confirmed real-runtime error shape (RESEARCH.md Assumption A4, now CONFIRMED not assumed):** Node 20's `AbortSignal.timeout()` rejects the delivery `fetch` with an `Error` whose `name` is `'TimeoutError'`, proven against a real never-responding `http.Server`.
- **`sweep()`'s per-row isolation warning, verbatim shape:** `` `Notification sweep: unexpected error on job ${row.jobId}, continuing: ${reason}` `` — fires only for an exception raised outside `attemptDelivery()`'s own try/catch (a claim-adjacent store failure), never for a normal delivery failure.

## Verification

- `cd mirror-request && npx vitest run test/notification-fetch-timeout.test.ts` — 4/4 passing.
- `cd mirror-request && npx vitest run test/notification-retry-count.test.ts` — 4/4 passing.
- `cd mirror-request && npx vitest run test/notification-sweeper-claim.test.ts` — 4/4 passing.
- `cd mirror-request && npm test` — 27 files / 172 tests green (160 pre-existing + 12 new), run 3 times back-to-back with identical results.
- `cd mirror-request && npm run typecheck` — clean.
- `cd mirror-request && npm run build` — clean.
- `cd mirror-request && git status --porcelain` — clean tree after all three commits.
- `cd mirror-request && git diff --name-only 9b20d9e..HEAD -- src/` — exactly `config.ts`, `index.ts`, `notifications/notificationService.ts`, `state/localStore.ts`, `types.ts` across plans 04-01 and 04-02 combined; `src/display/` and `src/queue/` are absent, matching the plan's binding verification block.
- All acceptance-criteria greps from all three tasks confirmed directly: `AbortSignal.timeout` count 1, `Promise.race|new AbortController` count 0, `classifyError` count 2, `notifyLogger.error` count 1, `1 + this.maxRetries` count 1, `getStore` count 0 in all three new test files.
- Stale `mirror-request/.planning/` tree confirmed untouched (`git status --short .planning/` and `git diff --name-only 9b20d9e..HEAD -- .planning/` both empty from inside `mirror-request/`); `web-slide/` and `dslrbooth-agent/` untouched.

## Next Phase Readiness

Plan 04-03 can build directly on this plan's `classifyError()` reason vocabulary, the exact exhaustion log message, and the confirmed real-runtime `TimeoutError` shape — all quoted verbatim above. NOT-02 is now fully earned: the persisted retry queue (04-01) plus its failure posture (04-02) together satisfy "retry giới hạn khi gửi thất bại — log để xử lý thủ công." No blockers. Reversibility note carried forward: this plan changed no schema and no migration; reverting it is a plain code revert with no data-loss surface.

---
*Phase: 04-guest-notification*
*Completed: 2026-08-10*

## Self-Check: PASSED

All 4 files confirmed present on disk (`src/notifications/notificationService.ts`, `test/notification-fetch-timeout.test.ts`, `test/notification-retry-count.test.ts`, `test/notification-sweeper-claim.test.ts`); all 3 commit hashes (`2cde9bf`, `45a86fc`, `91a79ef`) confirmed present in `git log --oneline --all`.
