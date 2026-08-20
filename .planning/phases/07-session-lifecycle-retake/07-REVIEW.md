---
phase: 07-session-lifecycle-retake
reviewed: 2026-08-12T14:46:44Z
depth: standard
files_reviewed: 24
files_reviewed_list:
  - mirror-request/docs/OPS-RUNBOOK.md
  - mirror-request/src/config.ts
  - mirror-request/src/index.ts
  - mirror-request/src/logging/logger.ts
  - mirror-request/src/ops/logLevelControl.ts
  - mirror-request/src/queue/queueService.ts
  - mirror-request/src/state/localStore.ts
  - mirror-request/src/status/guestStatus.ts
  - mirror-request/src/status/statusRoute.ts
  - mirror-request/src/types.ts
  - mirror-request/test/agent-disconnect-requeue.test.ts
  - mirror-request/test/helpers/noPhotoSweep.ts
  - mirror-request/test/helpers/pendingPrintRegistry.ts
  - mirror-request/test/helpers/realSessionUploads.ts
  - mirror-request/test/local-store-persistence.test.ts
  - mirror-request/test/log-level-runtime.test.ts
  - mirror-request/test/queue-config-injection.test.ts
  - mirror-request/test/queue-dual-completion.test.ts
  - mirror-request/test/queue-event-coverage.test.ts
  - mirror-request/test/queue-file-upload-print.test.ts
  - mirror-request/test/queue-no-photo-outcome.test.ts
  - mirror-request/test/queue-print-registry-expiry.test.ts
  - mirror-request/test/queue-recovery.test.ts
  - mirror-request/test/queue-release-timer.test.ts
  - mirror-request/test/queue-retake-anchor.test.ts
  - mirror-request/test/status-api.test.ts
  - mirror-request/test/status-vocabulary.test.ts
resolved: 2026-08-12 — CR-01 and WR-01 both fixed in commits 721939c (failing tests) and f8412d2 (fix). WR-02 (config-pattern split) left open: it is untidy, not harmful, and was caused by an orchestrator misreading of D-12 — see STATE.md.
findings:
  critical: 1
  warning: 2
  info: 0
  total: 3
status: fixed
---

# Phase 7: Code Review Report

**Reviewed:** 2026-08-12T14:46:44Z
**Depth:** standard
**Files Reviewed:** 24 (of 30 listed — `test/queue-countdown.test.ts`, `test/queue-dispatch-connectivity.test.ts`, `test/queue-dispatch-mode.test.ts`, `test/queue-timeout-retry.test.ts`, `test/queue-event-coverage.test.ts` were spot-checked for the specific claims below rather than read end-to-end line by line; every file that carries assertions relevant to this review's findings was read in full)
**Status:** issues_found

## Summary

Phase 7's split of completion (print composite, jobId-scoped) from release
(`session_end`) is sound and is proven both at the mocked-service seam
(`queue-dual-completion.test.ts`) and against a real temp-file SQLite database
(`local-store-persistence.test.ts`). The no-photo sweep's four SQL predicates
in `getJobsAwaitingNoPhotoClose()` correctly exclude a job that is genuinely
bound to `booth_state.current_job_id`, and — for the documented residual
where a stray `session_end` unbinds a live guest — the age gate on
`acknowledged_at` cannot be bypassed or shortened; every clamp on
`PENDING_PRINT_EXPIRY_MS` / `NO_PHOTO_CLOSE_DELAY_MS` / `BOOTH_RELEASE_TIMEOUT_MS`
holds its floor under `undefined`, `NaN`, negative and zero injection. The
hand-rolled migrations in `localStore.ts` are additive-only and idempotent,
and this was re-verified in this review by reproducing the pending-print /
booth-binding idempotency proofs. `logLevelControl.ts` never mutates
`process.env` and never throws past its own boundary.

One finding rises to **critical**: `sessionAcked()` — the handler for both
the dispatch ack and the `session_start` Agent event — has no cross-check
between the event's `jobId` and `booth_state.current_job_id`, unlike its
sibling `onPrintComposite()`, which does have exactly that check (D-06). A
single stray or stale `session_start` event naming any non-terminal job
immediately and unconditionally rebinds the booth away from the guest who is
actually standing at it — no age gate, no delay, no retry budget involved.
This is very plausibly the still-unexplained mechanism behind the production
incident (`BZWCWFN6` going back to `in_progress`) that Phase 7's own evidence
file records as an open question. It was reproduced against the real
`QueueService` during this review (see below).

Two findings are **warnings**: the D-14 capture counter can accumulate across
a stall/retry cycle, contradicting its own "bounded by construction" comment;
and the `BOOTH_RELEASE_TIMEOUT_MS` vs. `PENDING_PRINT_EXPIRY_MS` /
`NO_PHOTO_CLOSE_DELAY_MS` config-key asymmetry is real but has no technical
justification now that D-12's actual scope (AGT-04 logging only) is
understood correctly.

**Two items from the review brief, resolved:**
- The "stale comment referencing `completeInProgressJob`" at
  `guestStatus.ts:59` is **refuted**. `git diff` against `bd14c0e2` shows this
  comment was rewritten in this same phase (commit `4719101`) to name
  `completeJob` instead; the current text is accurate. A repo-wide grep found
  no other stale reference to `completeInProgressJob` outside comments/tests
  that deliberately assert its *absence*.
- The `BOOTH_RELEASE_TIMEOUT_MS` vs. `PENDING_PRINT_EXPIRY_MS`/
  `NO_PHOTO_CLOSE_DELAY_MS` config-pattern split is **confirmed as a real,
  if minor, inconsistency** — see WR-02 below.

## Critical Issues

### CR-01: `sessionAcked()` has no jobId cross-check against `booth_state.current_job_id` — a single stray `session_start` event steals the booth from a live guest, unconditionally

**File:** `mirror-request/src/queue/queueService.ts:328-342`

**Issue:** `onPrintComposite()` (the completion anchor) treats the event's
own `jobId` as a cross-check only, never as the source of truth — if it
disagrees with `booth_state.current_job_id` the event is dropped and warned
(D-06, `queueService.ts:376-385`). `sessionAcked()` — reached both from
`onAgentAck(jobId, true)` (safe: `jobId` there is always the id the server
itself just dispatched) **and** from the independent `session_start` Agent
event via `onAgentEvent()` (`queueService.ts:630-631`) — has no such
cross-check at all:

```ts
sessionAcked(jobId: string): void {
  const job = this.store.getJob(jobId);
  if (job && (job.status === 'completed' || job.status === 'failed' || job.status === 'no_photo')) {
    queueLogger.warn(`session_start ignored for ${jobId}: already ${job.status}`);
    return;
  }
  this.store.updateJobStatus(jobId, 'in_progress', 'acknowledged_at', Date.now());
  this.store.setBoothCurrentJob(jobId);   // <-- unconditional rebind
  this.clearBusyTimer();
  this.startBusyTimer(jobId);
}
```

The guard added in this phase (07-01, commit `d0d6239`) only blocks
*resurrecting a terminal job* (D-09/WINDOWS-8's "second half"). It does
**not** block stealing the booth from a *different, currently live*
`in_progress` job, and it does not require the target job to even be in
`dispatched` status (the expected precondition for an ack) before accepting
it.

Every other event handler that receives an Agent-forwarded `jobId`
(`onPrintComposite`) treats that id as untrustworthy — the code's own,
repeated documentation states "the Agent stamps a stale activeJobId on every
forwarded event and never clears it." Phase 7's own evidence file
(`07-EVIDENCE-dslrbooth-triggers.md:71-79`) records this exact mechanism as
an **open, unresolved question**: a real production incident (`BZWCWFN6`)
went back to `in_progress` with no explanation, and the file names the only
two write paths as `session_start` (via `onAgentEvent`) and `ack` (via
`onAgentAck`), explicitly flagging "Agent stamps the old jobId onto an event
that fires after the job is already done" as the untested hypothesis. This
review's finding is that hypothesis, confirmed at the code level: `ack` is
safe (its jobId is server-controlled), but `session_start` is not, and
nothing in this phase closed that gap — only the terminal-status half of it.

**Reproduced during this review** (scratch test against the real
`QueueService`, not just static reading — deleted after confirming, per this
review's read-only mandate):

1. Guest X is genuinely `in_progress`, `booth_state.current_job_id = 'job-X'`.
2. A `session_start` event arrives naming an unrelated, still-`queued` job
   `'job-W'` (the stale-activeJobId shape, or simply a duplicate/late event).
3. `service.onAgentEvent('session_start', 'job-W')` — **no cross-check
   fires** — `booth_state.current_job_id` becomes `'job-W'`, and `'job-W'` is
   written `in_progress` despite never having been dispatched, announced, or
   had its guest called to the booth at all.
4. Guest X's own, genuine print composite now arrives
   (`processing_start` for `'job-X'`). `onPrintComposite()`'s D-06
   cross-check correctly rejects it — `jobId !== currentJobId` — so **X's job
   is never completed, no pending-print slot is ever opened for X's real
   photo**, and X's job will eventually be swept as `no_photo` despite the
   guest genuinely having been photographed (the `outcome=no_photo
   captures>0` signature the runbook already tells operators to watch for —
   except this occurrence is reached through a completely different,
   *undocumented* mechanism, unbounded by the 15-minute
   `NO_PHOTO_CLOSE_DELAY_MS` window the runbook's "residual" section
   describes: the theft itself is instantaneous, only the eventual sweep
   close is delayed).

**What test would have caught it:** none of the existing tests exercise this.
`queue-dual-completion.test.ts:257-266` and
`queue-event-coverage.test.ts:321-329` both explicitly assert the *opposite*
— that `sessionAcked()`/`session_start` for a queued/dispatched job "still
writes `in_progress`... the guard does not change the normal path" — but
every such test only ever names **one** job in its mock store and never
arranges for a *second, currently-bound-and-`in_progress`* job to be present
when the event fires. No test asserts what `booth_state.current_job_id`
should be, or that the previously-bound job is protected, after a
`session_start` for a different id.

**Fix:** apply the same D-06 discipline `onPrintComposite()` already uses.
`sessionAcked()` needs to know whether it is being called from the trusted
`onAgentAck` path or the untrusted `session_start` event path, and only the
latter needs the check — e.g. split the event-sourced call into its own
method that cross-checks `jobId` against `getBoothCurrentJobId()` (and/or
requires the target job's status to be `'dispatched'`, the correct
precondition for an ack) before writing anything, mirroring
`onPrintComposite()`'s throttled mismatch warn:

```ts
private sessionAckedFromEvent(jobId: string): void {
  const currentJobId = this.store.getBoothCurrentJobId();
  if (currentJobId !== undefined && jobId !== currentJobId) {
    queueLogger.warn(`session_start jobId ${jobId} does not match booth_state.current_job_id ${currentJobId}; ignored`);
    return;
  }
  this.sessionAcked(jobId);
}
```
and route `onAgentEvent`'s `'session_start'` branch through it, leaving
`onAgentAck`'s direct call to `sessionAcked()` untouched (that path's `jobId`
is already trustworthy by construction).

## Warnings

### WR-01: D-14's `captureCounts` is not bounded by construction — a stalled-and-retried job's count survives and accumulates across dispatch attempts

**File:** `mirror-request/src/queue/queueService.ts:107-130` (the field and its
doc comment), `queueService.ts:576-581` (`countCapture`), `queueService.ts:262-270`
(`handleStall`)

**Issue:** The field's own comment states: "Bounded by construction:
`logSessionSummary()` deletes the entry it reads, and every job reaches
exactly one of the two close paths, so a long-running process accumulates
nothing." This is not true. `logSessionSummary()` — the only place that
reads and deletes a `captureCounts` entry — is called from exactly two
places: `onPrintComposite()` (the `completed` close) and
`sweepNoPhotoJobs()` (the `no_photo` close). A job that stalls via the busy
timer (`session_ack_timeout`) or an Agent NAK (`agent_nak`) goes through
`handleStall()` → `requeueWithRetry()` (status back to `'queued'`) — **not**
one of the two close paths — and its `captureCounts` entry is left in the
map. If the guest had already produced one or more `capture_start` events
before the stall (plausible: camera hangs mid-session after the first shot),
and the job is later redispatched with the same jobId (which
`requeueWithRetry()` deliberately preserves, D-06), `countCapture()` on the
retry attempt adds onto the **stale leftover count** from the abandoned
attempt (`this.captureCounts.set(attributedJobId, (this.captureCounts.get(attributedJobId) ?? 0) + 1)`),
inflating the `SESSION_SUMMARY` line's `captures=` field for a session that
took fewer shots than reported. If the job is instead permanently `failJob()`'d
without ever reaching a close path, the entry is never deleted at all —
a small, unbounded-by-construction leak for the life of the process.

Per the code's own comment this is diagnostic-only (nothing branches on it),
so this does not corrupt guest-visible behaviour — but it directly
contradicts OPS-RUNBOOK §5's operator guidance ("the one combination worth
alerting on is `outcome=no_photo` with `captures` greater than zero"), which
now can also be triggered by *stale* counts from an earlier, abandoned
dispatch attempt of the same job, not only by the documented residual.

**What test would have caught it:** none of `queue-dual-completion.test.ts`'s
D-14 cases (`queueService.ts` lines 296-461) drive a stall/retry cycle
between two rounds of `capture_start` events for the same jobId; they only
prove the count resets across two *different* job ids
("the counter is deleted at close, so a second session reads its own count
and not an accumulated one").

**Fix:** clear the entry on every path that returns a job to `'queued'` for
retry, not only on close — e.g. in `handleStall()`:

```ts
private handleStall(jobId: string, reason: string): void {
  const { retries } = this.store.requeueWithRetry(jobId);
  this.captureCounts.delete(jobId); // a retried job's captures belong to an abandoned attempt
  if (retries > this.sessionMaxRetries) {
    this.store.failJob(jobId, reason);
    ...
```
(and equivalently wherever a job is requeued via `requeueNoRetry()` after an
Agent disconnect, and in the terminal `failJob()` case that never retries
again, if the field is meant to describe "this dispatch attempt" and not to
leak indefinitely).

### WR-02: `BOOTH_RELEASE_TIMEOUT_MS` vs. `PENDING_PRINT_EXPIRY_MS`/`NO_PHOTO_CLOSE_DELAY_MS` — an unjustified config-pattern split

**File:** `mirror-request/src/config.ts:111`, `mirror-request/src/queue/queueService.ts:29,58`

**Issue:** All three values are booth-session-lifecycle timing constants of
identical epistemic status (per this phase's own context doc, all three are
required to be constructor-injectable), and all three already self-clamp to
a safe derived floor regardless of what is injected — `BOOTH_RELEASE_TIMEOUT_MS`
falls back to `120_000` unless the configured value is a finite number
`>= 30_000`; `PENDING_PRINT_EXPIRY_MS` and `NO_PHOTO_CLOSE_DELAY_MS` clamp to
their own derived floors the same way. Yet only `BOOTH_RELEASE_TIMEOUT_MS` is
exposed as an `EnvConfig`/`.env` key; the other two are module constants with
a constructor-only seam, on the stated rationale (D-12) that a runtime toggle
must not exist for them.

Re-reading D-12 (`07-CONTEXT.md:183`) confirms it forbids a knob for **AGT-04
event logging specifically** — it does not forbid configuration keys
phase-wide, and `BOOTH_RELEASE_TIMEOUT_MS` itself is proof that phase 7 did
add a new env key when it judged one appropriate. There is no technical
reason visible in the code for treating these three timings differently:
none of the three can be pushed below its safety floor by a misconfigured
`.env`, so "an operator could set it unsafely low" cannot be the
distinguishing factor (it would apply equally to `BOOTH_RELEASE_TIMEOUT_MS`,
which *is* exposed). This is genuinely just an inconsistency, not a
functional bug — OPS-RUNBOOK §3 documents the split honestly and an operator
who reads it will not be surprised — but it has no principled basis now that
D-12's actual scope is understood, and it will read as arbitrary to the next
person who has to decide which pattern a fourth timing value should follow.

**Fix:** pick one pattern for all three. Given `BOOTH_RELEASE_TIMEOUT_MS`
already ships as a safely-clamped env key with no observed harm, the more
consistent fix is exposing `PENDING_PRINT_EXPIRY_MS` and
`NO_PHOTO_CLOSE_DELAY_MS` as `EnvConfig` keys with the same floor-clamping
`config.ts` already does for `BOOTH_RELEASE_TIMEOUT_MS`, and updating
OPS-RUNBOOK §3's "deliberately NOT environment variables" section
accordingly. If the team prefers to keep them constructor-only, then
`BOOTH_RELEASE_TIMEOUT_MS` should be pulled out of `EnvConfig` to match —
either resolution is defensible; leaving the asymmetry as-is on the current
stated rationale is not.

---

_Reviewed: 2026-08-12T14:46:44Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
