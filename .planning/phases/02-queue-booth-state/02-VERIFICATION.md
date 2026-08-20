---
phase: 02-queue-booth-state
verified: 2026-08-10T11:45:00Z
status: passed
score: 15/15 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: passed (unreliable — pre-existing file found at same path, not trusted; independently re-derived)
  previous_score: 15/15 (claimed)
  gaps_closed: []
  gaps_remaining: []
  regressions: []
---

# Phase 2: Queue & Booth State Verification Report

**Phase Goal:** Every registration is dispatched to the booth in the order it arrived, and no
fault — a dead Agent, a lost acknowledgement, or a service restart — can leave the booth
permanently BUSY or trap a guest behind a job that will never finish. Persisted booth state is
reconciled against wall-clock age before the first tick of every startup, and a stalled job is
retried a bounded number of times from its original place in line before failing with a recorded
reason.

**Verified:** 2026-08-10T11:45:00Z
**Status:** passed
**Re-verification:** No — treated as initial. A `02-VERIFICATION.md` already existed at this path
before this run with a matching "passed" verdict; per this workflow's rule that no prior claim is
evidence, it was not trusted and every finding below was independently re-derived by reading the
live source tree, running the suite, and inspecting the live SQLite file myself rather than by
diffing against that file. Where my own findings converge with it, that is noted as corroboration,
not as the basis for the verdict.

## Method

Read `ROADMAP.md`, `REQUIREMENTS.md`, `02-CONTEXT.md`, all four `02-0N-PLAN.md`/`SUMMARY.md`
pairs, `02-VALIDATION.md`, `WINDOWS.md`, `mirror-request/CLAUDE.md`, and
`mirror-request/docs/OPS-RUNBOOK.md`. Then read the full working source: `src/queue/queueService.ts`
(all 277 lines), `src/state/localStore.ts` (all 337 lines), `src/index.ts`, `src/config.ts`,
`src/types.ts`, `src/logging/logger.ts`, `src/ingestion/dbPoller.ts`, and all six
`test/queue-*.test.ts` files in full. Confirmed the git history and diff scope
(`git log --oneline -- src/ingestion/mirrorReceiver.ts` / `dbPoller.ts` — neither touched since
Phase 1; `git log --oneline 5cf3ec1..HEAD --stat -- src/` — only `config.ts`, `index.ts`,
`queue/queueService.ts`, `state/localStore.ts`, `types.ts` changed). Ran `npm run typecheck`
(exit 0) and `npm test` **ten consecutive times** (113/113 tests, 16/16 files, every run — see
flakiness check below). Grepped the live source directly for the specific structural claims in
`02-CONTEXT.md`/plans (retry call-site counts, `process.env`/`console` absence, MySQL write
absence) rather than trusting the plans' own grep results. Read the live SQLite database
(`data/extension-service.sqlite`) read-only and the rotated log file
(`logs/extension-service-2026-08-10.log`) independently to corroborate the live-restart claim in
`02-04-SUMMARY.md`.

## Goal Achievement

### Observable Truths (M2 success criteria)

| # | Truth | Status | Evidence |
|---|---|---|---|
| 1 | Multiple registrations queued in FIFO, logged with position numbers | ✓ VERIFIED | `LocalStore.enqueueJob()` (localStore.ts:137-150) captures `RunResult.changes`; on a real insert logs `` `Queued job ${id} at position ${pos} of ${len}` `` through the module-level masked Winston `logger`. Proven against real SQL in `test/queue-fifo-retry.test.ts` (positions 1/2 asserted from captured log lines). `mask(msg) === msg` asserted on the new line for realistic ids; `test/logging-mask.test.ts` (10 tests) still green. |
| 2 | Duplicate record IDs detected and skipped | ✓ VERIFIED | `INSERT OR IGNORE` unchanged (`grep -c 'INSERT OR IGNORE INTO queue_job'` → 1), plus Phase 1's `processed_id` table — D-11 explicitly adds no new dedup code, confirmed by `git diff --name-only` for the idempotency-test commit touching no file under `src/`. `test/queue-idempotency.test.ts` (5 real-SQL cases) proves one registration can never become two rows, including across the retry and terminal-fail paths this phase introduced (D-12). |
| 3 | Booth IDLE → dispatch first job → become BUSY | ✓ VERIFIED | `tick()` → `beginAnnouncement()` → `dispatchJob()`, config-injected, unchanged in shape. `test/queue-countdown.test.ts`'s "booth state transitions" block asserts the exact ordered sequence `['IDLE','ANNOUNCING','BUSY']` and the exact Agent payload `{ type: 'command', action: 'start_session', jobId }`. |
| 4 | session_end → booth IDLE → auto-dispatch next job | ✓ VERIFIED | `sessionEnded()` → `completeInProgressJob()` + `setBoothIdle()` + `tick()`. Same test file asserts the full sequence `['IDLE','ANNOUNCING','BUSY','IDLE','ANNOUNCING']` after `session_end`, second guest announced with no further external input, and `requeueWithRetry`/`failJob` never called on the happy path. |
| 5 | BUSY > 5 min without session_end → auto-reset IDLE + warning | ✓ VERIFIED | `startBusyTimer()`'s `setTimeout` callback (queueService.ts:220-228): `setBoothTimeout('session_ack timeout')` (→ IDLE + `logger.warn`) → `handleStall(jobId, 'session_ack_timeout')` (→ `queueLogger.warn`) → `tick()`. `test/queue-timeout-retry.test.ts` drives the real callback through real fake timers and spies on the real exported `queueLogger.warn`, asserting exactly one warning naming the job id and attempt number. Before this phase the queue's local logger had no `warn` method and never reached Winston at all — this is a genuine capability that did not exist pre-phase, not a cosmetic change. |

**Score:** 5/5 M2 success criteria verified.

### Requirements Coverage

| Requirement | Description | Status | Evidence |
|---|---|---|---|
| QUE-01 | Global FIFO queue — correct registration order | ✓ SATISFIED | `getNextQueuedJob()` orders `queued_at ASC`, unchanged. `requeueWithRetry()`'s SQL (localStore.ts:206-212) omits `queued_at` from its SET list — read directly, confirmed absent — and three independent test files assert the requeued guest is returned first with byte-identical `queued_at`. |
| QUE-02 | Idempotency — no double-processing by record id | ✓ SATISFIED | Structurally unchanged (D-11), proven end-to-end across the retry path by `test/queue-idempotency.test.ts`. |
| QUE-03 | IDLE + queued → dispatch start_session to Agent | ✓ SATISFIED | Exact payload shape asserted in `test/queue-countdown.test.ts`; `sendCommandCb` seam untouched (Phase 3 dependency preserved). |
| QUE-04 | session_end → auto-dispatch next | ✓ SATISFIED | See M2 criterion 4. |
| BTH-01 | State machine managing IDLE/BUSY (+ANNOUNCING, D-09) | ✓ SATISFIED | 9-row transition table in `docs/OPS-RUNBOOK.md` §5, cross-checked against `test/queue-countdown.test.ts`'s transition suite — no discrepancy found on my own independent read either. `this.announcingJobId` guard prevents a second announce/dispatch while non-IDLE, asserted behaviorally. |
| BTH-02 | Safety timeout: BUSY > 5 min → auto-reset IDLE + warning | ✓ SATISFIED | See M2 criterion 5 and the deep-dive below. |

**Score:** 6/6 requirements satisfied. `REQUIREMENTS.md`'s traceability table's Phase 2 row
(`QUE-01..04, BTH-01..02 | 2 | Complete`) is accurate — every requirement it marks has matching
code and passing tests, independently confirmed rather than taken on the document's own word.

### Scrutiny points (per verification brief)

**1. CLAUDE.md hard rule 1 — backend MySQL stays read-only.**
`grep -rln "mysql2" src/` → only `src/ingestion/dbPoller.ts`, which is absent from
`git diff --name-only 5cf3ec1..HEAD -- src/` (Phase 2 never touched it). Its only MySQL query is
a parameterized `SELECT ... FROM registrations WHERE registered_at > ? ORDER BY ... LIMIT ?`
(dbPoller.ts:100-103); every write in that file (`upsertRegistration`, `markProcessed`,
`enqueueJob`, `setCursor`) targets the local SQLite `LocalStore`, not MySQL.
`grep -rn "conn\.\|pool\." src/ | grep -iE "insert|update|delete"` returns nothing. Phase 2's new
`LocalStore` methods (`getInFlightJobs`, `requeueWithRetry`, `failJob`) all use
`this.db.prepare(...)` against the same local `better-sqlite3` handle every other `LocalStore`
method already writes through — a different database entirely from the backend MySQL source.
**Hard rule upheld, no new or existing MySQL write path found.**

**2. Single bounded-retry policy — no bypass reopens the poison-job hole.**
Direct grep against the live file (not trusting the plan's own grep output):
```
$ grep -n 'this.handleStall(' src/queue/queueService.ts
109:      this.handleStall(job.id, 'restart_recovery_timeout');   # recover() sweep
165:      this.handleStall(jobId, 'agent_nak');                    # onAgentAck NAK branch
225:      this.handleStall(jobId, 'session_ack_timeout');          # startBusyTimer timeout
```
`this.store.requeueWithRetry(` and `this.store.failJob(` each appear exactly once in the file,
both inside `handleStall()` itself (lines 123 and 125) — there is no second call site that could
bypass the budget. `this.store.updateJobStatus(` has exactly two remaining sites
(`sessionAcked()` line 153, `dispatchJob()` line 213), neither of which sets `status='queued'` —
read directly, not inferred. **All three fault classes named in the phase goal (restart, NAK,
silent timeout) funnel through the one policy; no path requeues without consuming budget.**

**3. D-06's queue-position guarantee — held in code and asserted by tests, not by accident.**
`requeueWithRetry()`'s SQL (localStore.ts:206-212) is
`UPDATE queue_job SET status = 'queued', retries = retries + 1 WHERE id = ?` — `queued_at` is
absent from the SET list, confirmed by direct read. This is asserted against real SQL in three
independent places: `test/queue-recovery.test.ts` (after `recover()`, the earliest-`queued_at`
requeued row leads, not the never-dispatched row queued later), `test/queue-fifo-retry.test.ts`
(dispatch → `requeueWithRetry` → `getNextQueuedJob()` returns the same guest with byte-identical
`queued_at` and `retries=1`), and `test/queue-idempotency.test.ts` (re-enqueue after a requeue
leaves `queued_at` untouched). None of these are mock-only assertions — all three drive a real
`LocalStore` against a real per-file temp SQLite database.

**4. Retry arithmetic — dispatch-attempt count and warning wording.**
```
const { retries } = this.store.requeueWithRetry(jobId);      // retries = post-increment count
if (retries > this.sessionMaxRetries) {                       // default SESSION_MAX_RETRIES = 2
  this.store.failJob(jobId, reason);
  queueLogger.warn(`Job ${jobId} failed after ${retries} attempts: ${reason}`);
} else {
  queueLogger.warn(`Job ${jobId} requeued (attempt ${retries + 1}/${this.sessionMaxRetries + 1}): ${reason}`);
}
```
Traced by hand against the default of 2: dispatch 1 stalls → `retries=1`, `1 > 2` false → requeue,
warns "attempt 2/3"; dispatch 2 stalls → `retries=2`, `2 > 2` false → requeue, warns "attempt
3/3"; dispatch 3 stalls → `retries=3`, `3 > 2` true → fail, warns "failed after 3 attempts". The
job was genuinely dispatched three times before failing (dispatch 1, requeue→dispatch 2,
requeue→dispatch 3, then fail on the third stall) — "failed after 3 attempts" is literally
accurate, matching D-05's stated "3 dispatch attempts total." No off-by-one found. This exact
arithmetic is independently proven at non-default budgets in
`test/queue-config-injection.test.ts` ("a retry budget of 0 fails the job on its first stall",
"a retry budget of 3 survives three stalls and fails on the fourth") and against real SQL at the
default in `test/queue-recovery.test.ts` (a job seeded at `retries=2` ends `failed` at
`retries=3`).

**5. Success criterion 5's warning — genuinely reaches the masked pipeline.**
`export const queueLogger = labelLogger('queue');` (queueService.ts:8) is a Winston **child**
logger of the same singleton `logger` in `src/logging/logger.ts` — the same instance whose printf
formatters run `mask()` and whose transports include the rotated `DailyRotateFile`. This is not a
new parallel logger; it shares every transport the base logger has. `grep -c 'console'
src/queue/queueService.ts` → 0; `grep -c "labelLogger('queue')"` → 1 — the pre-phase hand-rolled
console-wrapping object (no `warn` method, never reached the file transport) is fully gone. The
D-07 exhaustion warning is asserted behaviorally in `test/queue-timeout-retry.test.ts` by
spying on the real exported `queueLogger` instance (not a fake), driven through real fake timers
against the real production method body.

**6. Test integrity — the phase's biggest risk.**
- `grep -n "getStore(" test/queue-recovery.test.ts test/queue-timeout-retry.test.ts test/queue-fifo-retry.test.ts test/queue-idempotency.test.ts test/queue-config-injection.test.ts test/queue-countdown.test.ts` → only two hits, both in comments (`queue-fifo-retry.test.ts:10`, `queue-idempotency.test.ts:10`), zero executable calls. No new Phase 2 test touches the shared `getStore()` singleton or the single global `booth_state` row through it.
- The store-boundary integration suites (`queue-recovery.test.ts`'s first `describe`, `queue-fifo-retry.test.ts`, `queue-idempotency.test.ts`) construct a real `LocalStore` against a real, per-file `fs.mkdtempSync` temp SQLite database — genuine SQL execution, not mocks, and every count assertion is scoped to that file's own rows (never a global count, never an unfiltered total).
- The mocked-store suites (`queue-recovery.test.ts`'s second/third `describe` blocks, `queue-timeout-retry.test.ts`, `queue-countdown.test.ts`'s transition block, `queue-config-injection.test.ts`) all construct a **real** `QueueService` and drive it through **real** `vi.useFakeTimers()`/`vi.advanceTimersByTime()` — only the `LocalStore` dependency is a hand-built stub. This is the correct unit boundary (booth state is a single global SQLite row, unsafe to share across parallel Vitest workers), and every assertion checks resulting state or spy call arguments, not merely "a function was called."
- **Ran the full suite 10 consecutive times myself** (not once): 16 files, 113 tests, all green on every run, no flake observed. This directly answers the emphasis instruction — Phase 1 shipped a test that failed 3/10 runs; Phase 2's new tests show no equivalent instability across 10 runs in this environment.
- `npm run typecheck` → exit 0.

**7. Whether anything was marked complete that is not delivered.**
Audited all six checked boxes in the authoritative `.planning/REQUIREMENTS.md` (not the stale
`mirror-request/.planning/REQUIREMENTS.md`, which is a known-obsolete tree per the task's
topology note and still shows Phase 2 unchecked — correctly ignored) against the code and tests
above. All six hold. No requirement is checked without corresponding, working, tested code.

**8. Regressions.**
`git log --oneline -- src/ingestion/mirrorReceiver.ts` and `-- src/ingestion/dbPoller.ts` both
show their last touch was Phase 1 (`01-05`, `01-03`) — Phase 2 never edited either file.
`git diff --name-only 5cf3ec1..HEAD -- src/` lists exactly `config.ts, index.ts,
queue/queueService.ts, state/localStore.ts, types.ts` — no ingestion or logging source file.
`test/on-register-dedup.test.ts` (14 tests), `test/on-register-auth.test.ts`, `test/db-poller.test.ts`
(11 tests), and `test/logging-mask.test.ts` (10 tests) all pass, run both in the full suite and in
isolation. The one log line this phase adds inside `LocalStore.enqueueJob()` — the single choke
point both `mirrorReceiver.ts` and `dbPoller.ts` call through — contains only a job id and two
small integers; `test/queue-fifo-retry.test.ts` asserts `mask(msg) === msg` on it directly, and it
cannot alter either ingestion path's own behavior because neither file was edited.

**9. Live recovery evidence — what it does and does not prove.**
Read the live SQLite database read-only myself:
```
booth: [{"id":1,"state":"IDLE","updated_at":"2026-08-10T11:13:43.299Z"}]
non-terminal jobs: []
all job statuses: [{"status":"completed","n":1}]
```
This matches `02-04-SUMMARY.md`'s claimed AFTER state exactly, and the rotated log
(`logs/extension-service-2026-08-10.log`) ends with:
```
warn: Booth timeout reset: restart recovery: booth was BUSY at startup
info [queue]: Recovery complete: booth was BUSY, swept 0 in-flight job(s)
info: AgentServer started at /agent
```
— independently confirmed present, not taken on the summary's word. **This is genuine, real live
evidence that the booth-BUSY-across-a-restart deadlock (D-01/D-02, the phase's central defect) is
fixed**: a `booth_state` row over six and a half hours stale at boot was correctly classified as
dead and reset to a fresh `IDLE`. **However, as the verification brief anticipated, the *sweep*
half of `recover()` — the loop that resolves multiple stranded `dispatched`/`in_progress` rows
through the bounded retry policy — was NOT exercised on live production data.** The five
non-terminal rows (four stranded `dispatched`, one `queued`) were deleted by an explicit,
documented human decision before the restart (`02-04-SUMMARY.md` "Checkpoint Resolution", human
chose "delete all 5 non-terminal rows" over the checkpoint's offered options of "let the retry
policy run" or "mark them failed by hand"), so `swept 0 in-flight job(s)` in the log is not a
failure — it is the correct, honest count given there was nothing left to sweep. The sweep-of-
multiple-rows behavior is instead proven only by `test/queue-recovery.test.ts`'s first integration
case, which reproduces the exact shape of the original live incident (4 rows, 2 under budget, 1 at
the retry ceiling, 1 never dispatched) against a real temp SQLite database with real SQL. That
test is a faithful, high-fidelity reproduction of the actual defect — as strong as automated
testing gets for this scenario — but it is not the same as observing the sweep against the actual
historical rows, because those rows no longer exist to observe. **I judge this adequate to close
the phase** (the core deadlock is proven live, the sweep is proven by a test built specifically to
reproduce the live incident's shape, and the human's decision to delete rather than sweep was an
explicit, in-scope operational choice, not an execution gap) but record it plainly as a residual
scope note rather than silently treating "live restart verified" as covering everything the
checkpoint originally asked for.

### Anti-Patterns Found

None. `grep -n -E "TBD|FIXME|XXX|TODO|HACK|PLACEHOLDER"` across every file this phase created or
modified (`src/types.ts`, `src/config.ts`, `src/state/localStore.ts`, `src/queue/queueService.ts`,
`src/index.ts`, all six `test/queue-*.test.ts`, `docs/OPS-RUNBOOK.md`) returns zero matches. No
stub return values, no empty handlers, no hardcoded-empty data reaching a caller.

### Known, pre-existing, out-of-scope items (informational only — not Phase 2 gaps)

- `WINDOWS.md` ledger item 4 remains `open`: all test files still share one test-mode SQLite
  database through the `getStore()` singleton across parallel Vitest workers. Phase 2 correctly
  avoided the hazard locally — confirmed above, zero executable `getStore()` calls in any new
  queue test — but did not fix it globally, which `02-CONTEXT.md`'s own deferred-items list marks
  as out of scope for this phase.
- `src/logging/logger.ts`'s `formatFile`/`formatConsole` printf functions compute a `timestamp`
  field via `winston.format.timestamp()` but never interpolate it into the emitted line — log
  entries on disk carry no per-line wall-clock timestamp. Pre-existing Phase 1 code, untouched
  here; it is why ordering in the log had to be read positionally rather than by timestamp above.

### Human Verification Required

None outstanding as a blocking item. The one blocking checkpoint this phase defined
(`02-04-PLAN.md` Task 3) was executed and resolved during the phase itself, and I independently
re-confirmed its resulting database and log state read-only rather than accepting the summary's
account alone (see point 9). The one thing worth a human's attention, non-blocking: the sweep of
multiple real stranded rows through the retry policy is proven by a faithful integration test but
was not observed against the actual historical production rows, because an operator chose to
delete them first. If a future incident produces a similar stranded-row backlog, that would be the
first opportunity to observe the sweep loop against real data end to end.

## Gaps Summary

None that block the phase goal. All 5 M2 success criteria and all 6 requirement IDs are backed by
code that matches the plans, by tests that exercise real behavior (fake-timer-driven real
`QueueService`, or real `LocalStore` against real per-file SQLite — never assertions on a mock's
call alone), and by live production evidence for the phase's central defect (a restart no longer
leaves the booth permanently `BUSY`), independently re-derived rather than taken from any prior
document. CLAUDE.md's read-only-MySQL hard rule holds. No regression to Phase 1's dedup ladder,
read-only poller, or PII masking. No test-isolation violation of `02-VALIDATION.md`'s binding
constraints, confirmed across 10 consecutive full-suite runs with no flake. One residual scope
note, not a gap: the sweep of multiple stranded rows is proven by a high-fidelity test rather than
by live data, because the specific historical rows were deleted by an in-scope human decision
before the verifying restart — recorded above for whoever handles the next real incident.

---

*Verified: 2026-08-10T11:45:00Z*
*Verifier: Claude (gsd-verifier)*
