---
phase: 11-retake-approval-anchor
plan: 02
subsystem: booth-queue-state-machine
tags: [vitest, sqlite, state-machine, timers, retake, notifications, dslrbooth, test-migration]

requires:
  - phase: 11-retake-approval-anchor
    plan: 01
    provides: "the attempt spine (booth_state.attempt_open/attempt_no), the finalizePendingPrint() single gate, the composite/approval split (D11-02/D11-03), the RETAKE_GRACE_MS grace window, and the extended pendingPrintRegistry test helper"
provides:
  - "Every legacy test file that pinned the retired single-anchor/send-on-upload model now pins the finalize gate instead — no case was deleted to make the suite pass"
  - "A source-level invariant file (test/queue-send-site-invariant.test.ts) pinning sendPhotoLink and recordEventPhoto at exactly one call site each, plus the absence of the retired releaseTimer/resolvePendingPrint names"
  - "A Rule 1 fix: sessionAckedFromEvent()'s retake branch now checks the job's terminal status before treating attemptNo>=1 as a legitimate retake"
  - "A corrected D11-09 SESSION_SUMMARY pin covering all four approval words (printing/grace/operator/none), each with its own case"
  - "D11-07's composite extraction pinned on both measured layouts (4-shot param5, 1-shot param2) plus the no-Prints-match fallback"
affects: [11-03-operator-door, notification-service, cms-photo-history]

actuals:
  tokens: 43600
  tasks: 3
  commits: 3

tech-stack:
  added: []
  patterns:
    - "Reading a service's own source file with fs, stripping block-then-line comments, then counting `.methodName(` call-site occurrences — a structural single-call-site invariant a behavioral test cannot prove (a future edit could add a second call site no existing fixture happens to reach)."
    - "A shared `approve(store, qs)` / `finalizeDirectly(service, jobId, door)` test helper that binds the booth, opens an attempt, and drives the approving `printing` event (or calls the private finalize gate directly via an `as unknown as {...}` cast) — the one new fixture shape every rewritten file in this plan converged on, since D11-05 moved completion/delivery off `processing_start`/`file_upload` onto one gate reachable only through printing, grace, or a direct call."

key-files:
  created:
    - mirror-request/test/queue-send-site-invariant.test.ts
  modified:
    - mirror-request/src/queue/queueService.ts
    - mirror-request/test/queue-dual-completion.test.ts
    - mirror-request/test/queue-release-timer.test.ts
    - mirror-request/test/queue-no-photo-outcome.test.ts
    - mirror-request/test/queue-countdown.test.ts
    - mirror-request/test/queue-session-start-hijack.test.ts
    - mirror-request/test/queue-file-upload-print.test.ts
    - mirror-request/test/queue-event-photo.test.ts
    - mirror-request/test/queue-print-registry-expiry.test.ts
    - mirror-request/test/queue-event-coverage.test.ts
    - mirror-request/test/queue-config-injection.test.ts
    - mirror-request/test/queue-photo-image-resolution.test.ts
    - mirror-request/test/phase8-cutover-readiness.test.ts

key-decisions:
  - "The true single-call-site invariant is not 'how many places call recordPhotoHistory()/sendNotification()' (both are legitimately called from two places: finalizePendingPrint()'s normal doors, and onFileUpload()'s D-11 late-arrival direct branch) — it is that those two wrapper methods are themselves the ONLY callers of the irreversible primitives, notificationService.sendPhotoLink() and store.recordEventPhoto(). The invariant file pins the primitives, not the wrappers, matching must_haves.truths' own literal wording ('sendPhotoLink is reachable from exactly one call site')."
  - "Every rewritten mocked-store fixture defaults booth_state.attempt_open/attempt_no to false/0 (not true/1) even when a job is pre-bound — this is the REAL state setBoothBusy() leaves at dispatch, and defaulting it open would let a bare session_start in the fixture take the retake branch instead of the normal sessionAcked() path, silently skipping the terminal-state guard the fixture was trying to exercise. Cases needing an attempt already open call session_start first to open it legitimately."
  - "queue-print-registry-expiry.test.ts's base CONFIG sets RETAKE_GRACE_MS to 20x its own EXPIRY_MS (not the production default) so the pre-existing registry-expiry-only assertions keep testing that sweep in isolation, undisturbed by a grace door firing first; the one new independence case overrides it back down to a value shorter than EXPIRY_MS specifically to prove the two timers really are independent rather than merely both eventually firing on the same row."
  - "phase8-cutover-readiness.test.ts's D-01 schema pin was rewritten, not weakened: booth_state's expected SQL now includes Phase 11's own attempt_open/attempt_no columns explicitly, with the reasoning recorded in the test itself for why a LATER, deliberate phase's documented schema addition does not retroactively falsify Phase 8's own 'additive' claim — an UNDOCUMENTED column would still fail the assertion."

requirements-completed: [BTH-01, BTH-02, NOT-01, AGT-04]

coverage:
  - id: D1
    description: "Every test file that pinned processing_start-alone-completes or file_upload-alone-sends now pins the finalize gate (an approving printing, a grace expiry, or a direct operator-door call) instead — no case deleted, each disposition recorded below."
    requirement: NOT-01
    verification:
      - kind: unit
        ref: "npm test — 997/1000 passing, 84 files (1 red: test/cms-photo-history.test.ts, plan 11-03's)"
        status: pass
    human_judgment: false
  - id: D2
    description: "sendPhotoLink and recordEventPhoto are each reachable from exactly one call site in queueService.ts, pinned against the stripped source text rather than assumed from behavior."
    requirement: NOT-01
    verification:
      - kind: unit
        ref: "test/queue-send-site-invariant.test.ts (4 cases)"
        status: pass
    human_judgment: false
  - id: D3
    description: "D11-07's composite extraction is pinned on the measured 4-shot layout (param5), the measured 1-shot layout (param2), and the no-\\Prints\\-match fallback (highest-indexed non-empty param), asserting both the log detail string and the pending-print slot's stored composite."
    requirement: AGT-04
    verification:
      - kind: unit
        ref: "test/queue-event-coverage.test.ts#QueueService — D11-07: processing_start composite extraction, pinned on both measured layouts plus the fallback (3 cases)"
        status: pass
    human_judgment: false
  - id: D4
    description: "SESSION_SUMMARY's attempts=/approved_by= fields are pinned for all four approval words: printing, grace, operator (via a direct finalizePendingPrint call, since the CMS route lands in 11-03), and none (the 15-minute no-photo sweep, which never reaches the finalize gate)."
    requirement: BTH-02
    verification:
      - kind: unit
        ref: "test/queue-dual-completion.test.ts#QueueService — one summary line per closed job, from the close path (D-14, SC-3, D11-09) (4 dedicated cases, one per word)"
        status: pass
    human_judgment: false
  - id: D5
    description: "The retired release fallback cannot be silently reintroduced: queue-release-timer.test.ts pins its absence directly (advancing well past its old default with no session_end changes nothing), and queue-send-site-invariant.test.ts pins the absence of the releaseTimer field name and the resolvePendingPrint method name from the source."
    requirement: BTH-02
    verification:
      - kind: unit
        ref: "test/queue-release-timer.test.ts (4 cases) + test/queue-send-site-invariant.test.ts (2 of its 4 cases)"
        status: pass
    human_judgment: false
  - id: D6
    description: "The phase does not close until the five-scenario live booth gate in 11-CONTEXT.md <verification> passes on the real booth with auto-print off (SC-6)."
    human_judgment: true
    rationale: "Requires a physical dslrBooth with auto-print OFF — out of scope for this plan, same as 11-01. Tracked for this phase's own closing checkpoint."

duration: ~50min
completed: 2026-08-18
status: complete
---

# Phase 11 Plan 02: Legacy Test Migration Onto the Finalize Gate Summary

**Migrated the eleven files 11-01's own SUMMARY predicted would go red (five in the completion-anchor group, five in the send-on-upload group, plus SESSION_SUMMARY's approval-word coverage) plus two more the orchestrator's scope extension named (queue-photo-image-resolution.test.ts, phase8-cutover-readiness.test.ts) onto D11-02/D11-04/D11-05's finalize gate, added a new source-level single-send-site invariant file, and fixed one real Rule-1 bug in the retake branch found while pinning it — leaving 997/1000 tests passing across 84 files, with exactly one file (test/cms-photo-history.test.ts, owned by plan 11-03) deliberately left red.**

## Performance

- **Duration:** ~50 min (estimate; task commits themselves span 07:11–07:37 UTC, plus upstream reading/context time)
- **Started:** 2026-08-18T06:50:00Z (approx.)
- **Completed:** 2026-08-18T07:37:22Z
- **Tasks:** 3 / 3 completed
- **Files modified:** 14 (1 new, 13 modified — 11 named in this plan's `files_modified`, 2 added by the orchestrator's explicit scope extension)

## Accomplishments

- Every test file that asserted "`processing_start` alone completes the job" now asserts the opposite explicitly, and no test anywhere in this plan's scope makes that assertion any more — confirmed by re-reading every rewritten case, not merely by the suite passing.
- Every test file that asserted "`file_upload` alone sends the notification" now asserts it only WRITES the URL, with an approving `printing`/grace/operator door required to deliver — including two new cases pinning the exact post-finalize upload answers (already-sent no-op vs. finalized-without-URL late delivery).
- `queue-print-registry-expiry.test.ts` gained a dedicated case proving the pending-print registry's own 600s expiry sweep and the job's finalize gate (grace door included) are genuinely independent timers — a grace expiry finalizing a job does not by itself mark the registry slot expired, and the sweep still warns at most once if its own much-longer window later elapses.
- `queue-event-coverage.test.ts` gained three new cases pinning D11-07's composite extraction on the measured 4-shot layout (`param5`), the measured 1-shot layout (`param2`), and the no-`\Prints\`-match fallback — transcribed verbatim from `07-EVIDENCE-dslrbooth-triggers.md` §A/§C/§D, asserting both the log detail string and the pending-print slot's stored composite since one extractor serves both.
- `queue-dual-completion.test.ts`'s SESSION_SUMMARY block now has one dedicated case per D11-09 approval word (`printing`, `grace`, `operator` — via a direct `finalizePendingPrint` call since the CMS route is 11-03's scope — and `none`, the 15-minute sweep's own path), each asserting `attempts=`/`approved_by=` exactly.
- A new `test/queue-send-site-invariant.test.ts` reads `queueService.ts`'s own source (stripped of comments) and pins `sendPhotoLink`/`recordEventPhoto` at exactly one call site each, plus the absence of the retired `releaseTimer` field and `resolvePendingPrint` method names — a structural guarantee a behavioral test alone cannot prove.
- One real bug found and fixed while pinning CR-01 against the new retake branch: `sessionAckedFromEvent()`'s retake branch (`attemptNo >= 1`) bypassed the terminal-state guard `sessionAcked()` already enforces on its own door, since the retake branch returns without ever calling `sessionAcked()`. Fixed with a two-line guard checked before the retake branch, matching the message format the existing guard already uses.
- Orchestrator-authorized scope extension: `test/queue-photo-image-resolution.test.ts` (11 cases, real temp-file SQLite) and `test/phase8-cutover-readiness.test.ts` (the full-stack cutover-readiness probe) both migrated onto the finalize gate too, since neither is claimed by any plan in this phase and this plan's own must-have is a green suite. `test/cms-photo-history.test.ts` (plan 11-03's) was deliberately left untouched and red.

## Task Commits

1. **Task 1: The completion-anchor group — five files moved off "a composite completes the job"** - `db4093b` (test)
2. **Task 2: The send-on-upload group — five files moved off "an upload sends the photo"** - `733d48f` (test)
3. **Task 3: The single-send-site invariant, and the suite green end to end** - `15fa1a8` (test)

No separate plan-metadata commit — `.planning/` is not under version control in this project (`mirror-request` is the only git repository), so `SUMMARY.md`/`STATE.md`/`ROADMAP.md` are written to disk but not committed, matching 11-01's own precedent.

## Files Created/Modified

- `mirror-request/src/queue/queueService.ts` — Rule 1 fix: `sessionAckedFromEvent()`'s retake branch now checks the job's terminal status before treating `attemptNo >= 1` as a legitimate retake (2 lines of guard + comment)
- `mirror-request/test/queue-dual-completion.test.ts` — rewritten: completion via the finalize gate, one SESSION_SUMMARY case per approval word (20 tests, was 17)
- `mirror-request/test/queue-release-timer.test.ts` — rewritten: the two bounds that replaced the retired release fallback (grace expiry, session timeout), plus an explicit absence pin (4 tests, was 4)
- `mirror-request/test/queue-no-photo-outcome.test.ts` — rewritten: the no-photo outcome reached through grace expiry instead of the 15-minute sweep for the common case (13 tests, was 13)
- `mirror-request/test/queue-countdown.test.ts` — rewritten: the held window now includes the grace window, not only the dispatched window (8 tests, was 8)
- `mirror-request/test/queue-session-start-hijack.test.ts` — rewritten: completion via printing, plus a new case pinning the retake branch does not weaken the terminal-state guard (6 tests, was 5)
- `mirror-request/test/queue-file-upload-print.test.ts` — rewritten header + body: an upload records the URL and never delivers it; two new post-finalize-upload cases (18 tests, was 16)
- `mirror-request/test/queue-event-photo.test.ts` — rewritten: photo history written by the finalize gate, re-reached through an approving printing (7 tests, was 7)
- `mirror-request/test/queue-print-registry-expiry.test.ts` — rewritten: registry expiry and finalize-gate independence proven directly (6 tests, was 5)
- `mirror-request/test/queue-event-coverage.test.ts` — rewritten: two obsolete cases inverted, three new D11-07 layout/fallback cases added (18 tests, was 15)
- `mirror-request/test/queue-config-injection.test.ts` — extended: RETAKE_GRACE_MS coverage including its 20000ms default (9 tests, was 8)
- `mirror-request/test/queue-photo-image-resolution.test.ts` — orchestrator scope extension: an `approve()` helper drives the finalize gate before every resolver assertion (8 tests, was 11 — case count re-organized around the shared helper, no guarantee dropped)
- `mirror-request/test/phase8-cutover-readiness.test.ts` — orchestrator scope extension: `session_start`+`printing` driven over the real Agent socket before the upload assertion; D-01's schema pin updated for Phase 11's own booth_state columns (8 tests, was 8)
- `mirror-request/test/queue-send-site-invariant.test.ts` — **new**: 4 cases pinning the single-send-site guarantee against the stripped source

## Disposition Table

Every case named in `11-RESEARCH.md`'s Common Pitfalls breakage table, plus the two files the orchestrator's scope extension added, with its disposition:

| File | Case(s) | Disposition | Where the guarantee moved / why |
|---|---|---|---|
| `queue-dual-completion.test.ts` | `:113-117` completion-anchor tracer | **Inverted** | Now asserts `processing_start` alone leaves the job `in_progress`; an approving `printing` (with a prior `file_upload`) completes it |
| `queue-dual-completion.test.ts` | double-fire (`processing_start`+`printing`) | **Inverted** | The old "two doors, one action" shape is gone structurally — `processing_start` never calls `completeJob`; a genuine `printing` double-fire is now absorbed at the D-06 cross-check, not at `completeJob`'s own SQL idempotency |
| `queue-event-coverage.test.ts` | `:319-327` "processing_start still completes" | **Inverted** | Renamed to state the new guarantee: opens the slot, completes nothing; printing completes it |
| `queue-event-coverage.test.ts` | `:339-356` "file_upload still reaches notification" | **Inverted** | Renamed: writes the slot, sends nothing; printing delivers it |
| `queue-release-timer.test.ts` | whole file premise (`releaseTimer` at `processing_start`) | **Restructured, guarantee kept** | Renamed top-level describe to name the two surviving bounds: `RETAKE_GRACE_MS` (grace expiry) and `SESSION_TIMEOUT_MS` (a session that never starts); added an explicit absence pin for the retired fallback |
| `queue-no-photo-outcome.test.ts` | `:279,:285` completion-anchor case | **Inverted** | New case: `processing_start` alone neither completes nor closes; only `printing` finalizes, and once finalized `session_end` releases with no grace |
| `queue-no-photo-outcome.test.ts` | the other 12 cases (sweep exclusion, capture counts, summary fields, terminal-state guard) | **Kept, differently reached** | Re-reached through `RETAKE_GRACE_MS` expiry instead of the 15-minute `NO_PHOTO_CLOSE_DELAY_MS` sweep, since `session_end` for an unapproved attempt now opens grace (keeping the booth bound) rather than releasing immediately |
| `queue-countdown.test.ts` | `:234` "a print composite completes... session_end releases" | **Kept, differently reached** | Renamed to state the held-window guarantee explicitly: the announcement must not begin while the booth is held for a *possible retake*, not only while dispatched — asserted through the full grace window, then at expiry |
| `queue-session-start-hijack.test.ts` | `:145-156` completion via `completeJob` directly off composite | **Kept, differently reached** | The live guest's own composite+printing still survive the stray job-2 `session_start` exactly as before; `completeJob` assertion moved to after the approving `printing` |
| `queue-session-start-hijack.test.ts` | (new) retake branch vs. terminal guard | **Added** | New case pins that `sessionAckedFromEvent`'s retake branch does not bypass the terminal-state guard — the Rule 1 fix's own regression test |
| `queue-file-upload-print.test.ts` | `:109-230` first describe block (10 cases, send-on-upload) | **Kept, differently reached** | Converted to write-only assertions (`rows.get(JOB)?.photoUrl`), with the delivery-subject cases extended to add the approving `printing` at the end |
| `queue-file-upload-print.test.ts` | `:275-296` status-flip-on-upload | **Split into two, kept + inverted** | "already-resolved-and-sent" kept as a no-op pin; "resolved but no URL" (the old "expired" case) inverted — an `'expired'` row is now write-only too, since the registry's own expiry and the finalize gate are independent |
| `queue-event-photo.test.ts` | `:130-240` send-on-upload history assumption | **Kept, differently reached** | Every case now calls an `approve()` helper after the upload; `recordEventPhoto`'s attribution/additive/replay/no-active-event guarantees are unchanged |
| `queue-print-registry-expiry.test.ts` | `:190-199` sendPhotoLink+status-flip directly | **Kept, differently reached** | The "full successful session" case gained the approving `printing`; a brand-new case proves the registry-expiry-sweep and the finalize gate's grace door are independent timers |
| `queue-photo-image-resolution.test.ts` (unowned, orchestrator scope) | all 11 cases (real `LocalStore`, send-on-upload) | **Kept, differently reached** | An `approve()` helper (bind booth, open attempt, send `printing`) added before every resolver/history/delivery assertion |
| `phase8-cutover-readiness.test.ts` (unowned, orchestrator scope) | "turns a real print upload into durable history..." | **Kept, differently reached** | `session_start`+`printing` driven over the real authenticated Agent socket, matching this file's own "no direct store manipulation for the thing under test" discipline; one legitimate `store.setBoothIdle()` setup call added (see Deviations) |
| `phase8-cutover-readiness.test.ts` (unowned, orchestrator scope) | "leaves queue_job and booth_state character-for-character as Phase 7 left them (D-01)" | **Rewritten, not weakened** | `queue_job`'s expected SQL is untouched (Phase 11 never touches it — confirmed); `booth_state`'s expected SQL now names Phase 11's own `attempt_open`/`attempt_no` columns explicitly, with the reasoning recorded in the test for why a later, documented phase addition doesn't retroactively falsify Phase 8's own claim |
| `cms-photo-history.test.ts` (plan 11-03's) | 4 cases, real `LocalStore`, send-on-upload | **NOT TOUCHED — deliberately left red** | Owned by plan 11-03 per the orchestrator's explicit scope note; left exactly as it was |
| `queue-config-injection.test.ts` | (not in breakage table — already green) | **Extended, not migrated** | Gained `RETAKE_GRACE_MS` coverage per the plan's own Task 2 direction, including its 20000ms default when the config key is absent |

## Decisions Made

See `key-decisions` in frontmatter. The most consequential one not already stated there: **the "one send site" invariant is pinned at the primitive (`sendPhotoLink`, `recordEventPhoto`), not the wrapper (`sendNotification`, `recordPhotoHistory`)**. The plan's own `<action>` text described "the notification helper... invoked from exactly one place outside its own declaration," but the actual 11-01 implementation legitimately calls the wrapper methods from TWO places — `finalizePendingPrint()`'s three normal doors, and `onFileUpload()`'s D-11 late-arrival direct-delivery branch (a photo arriving for a job already closed `no_photo`, delivered immediately rather than through a finalize gate that has already run and will not run again). Pinning the wrapper at "exactly one call site" would have been factually false against the real, correct, already-shipped code — and `must_haves.truths` itself only claims singularity for `sendPhotoLink`, not for the wrapper. The invariant test pins what is actually true and actually load-bearing: neither primitive has a second call site anywhere in the file, which is the property that makes a double notification or a duplicate history row structurally impossible.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `sessionAckedFromEvent()`'s retake branch bypassed the terminal-state guard**
- **Found during:** Task 1, while writing `queue-session-start-hijack.test.ts`'s pin for "the new retake branch does NOT weaken" the terminal-state guard
- **Issue:** The retake branch (`attemptNo >= 1`) returns without ever calling `sessionAcked()`, which is the only place the terminal-status guard (`job.status === 'completed'/'failed'/'no_photo'` → refuse) lived. Under the normal flow this is unreachable (`finalizePendingPrint()` always clears the booth binding and resets `attempt_no` to 0 in the same synchronous act, so a terminal job can never still be bound with `attemptNo >= 1`), but the guard's whole design principle — per D-06/D-09 — is to not depend on "should never happen."
- **Fix:** Added a two-line check before the retake branch: if the bound job's own status is already terminal, warn and refuse, in the exact same message format `sessionAcked()`'s own guard already uses (`session_start ignored for X: already Y`).
- **Files modified:** `mirror-request/src/queue/queueService.ts`
- **Verification:** New test case in `queue-session-start-hijack.test.ts` directly seeds the (should-never-happen) inconsistent state and asserts `openBoothAttempt` is never called and the job status stays unchanged
- **Committed in:** `db4093b` (Task 1's commit)

**2. [Rule 3 - Blocking] `phase8-cutover-readiness.test.ts`'s cutover probe needed a `booth_state` row seeded before its first `session_start`**
- **Found during:** Task 3, while migrating this orchestrator-scoped file onto the finalize gate
- **Issue:** `booth_state`'s single row is created lazily by its own writers (`bootstrap()`'s `CREATE TABLE IF NOT EXISTS` seeds no row) — the row only comes into existence the first time `setBoothState`/`setBoothBusy`/`setBoothIdle`/`setBoothTimeout` runs (each is an `INSERT OR REPLACE`). This probe deliberately never calls `queue.start()` (its own header states "leaves the timers stopped so the walk below is the only thing moving"), so the row had never been created by the time this specific test tried to drive a `session_start` — and `setBoothCurrentJob()`/`openBoothAttempt()` are plain `UPDATE`s that silently no-op against a missing row, so the attempt never actually opened and every downstream `printing` check failed silently (confirmed by tracing: `session_start` DID run `sessionAcked()` — job status flipped to `in_progress` — but the booth-state row itself never existed to be updated).
- **Fix:** Added one legitimate setup call, `store.setBoothIdle()`, before the socket sends — the same class of direct-store preparation this harness already does for the registration/job/pending-print rows. A real production boot always calls `queue.start()` first (well before any Agent can connect), so this gap is a property of this probe's own deliberate "leave the timers stopped" design, not of the production boot sequence — no source change was warranted.
- **Files modified:** `mirror-request/test/phase8-cutover-readiness.test.ts`
- **Verification:** The file's full 8-case walk passes; traced with temporary debug logging (removed before commit) to confirm the exact mechanism before applying the fix
- **Committed in:** `15fa1a8` (Task 3's commit)

---

**Total deviations:** 2 auto-fixed (1 Rule 1 — bug, 1 Rule 3 — blocking)
**Impact on plan:** Both necessary for correctness. The Rule 1 fix closes a real (if currently unreachable) gap in a guard this exact task was asked to pin. The Rule 3 fix is test-infrastructure-only — no production code path was affected, and no guarantee was weakened to reach it.

## Issues Encountered

- **Package-manager confusion, avoided by design, not by luck:** several test files needed a `CONFIG` object explicitly including `RETAKE_GRACE_MS`/`BOOTH_RELEASE_TIMEOUT_MS` rather than relying on `new QueueService(store)`'s real `getConfig()` fallback — this sandbox cannot read `.env`/`.env.example` (a standing restriction recorded in `STATE.md` since Phase 1), so any test relying on the real environment's `RETAKE_GRACE_MS` value would have been non-deterministic from this executor's own perspective. Every rewritten file that needed grace timing now passes an explicit `CONFIG` constant instead.
- **`onFileUpload`'s early-return branches meant several rewritten cases needed a `file_upload` (for the photo URL) added *before* the approving `printing`**, not just the `printing` alone — `finalizePendingPrint()` reads whichever URL the slot currently holds, and without one it correctly falls through to the `no_photo`/`closeJobNoPhoto` branch instead of `completeJob`. Caught by the tests themselves failing with the wrong outcome status on the first run of several files (`queue-no-photo-outcome.test.ts`, `queue-session-start-hijack.test.ts`, `queue-event-coverage.test.ts`, `queue-dual-completion.test.ts`) — fixed by adding the upload before each approving `printing`, not by weakening the assertion.

## Known Stubs

None. Every rewritten assertion exercises real `QueueService`/`LocalStore` code paths (mocked at the SQLite seam for the mocked-store files, a real temp-file SQLite for `queue-photo-image-resolution.test.ts` and `phase8-cutover-readiness.test.ts`).

## User Setup Required

None — no external service configuration required. This plan touched only test files and one small guard in `queueService.ts`.

## Next Phase Readiness

Ready for **11-03** (the CMS operator door, D11-08 — `POST /cms/api/booth/release`, `cmsBoothRoutes.ts`, `cmsBoothPages.ts`), which is the plan that will finally bring `test/cms-photo-history.test.ts` back to green (the one file this plan deliberately left untouched, per the orchestrator's explicit scope note). `finalizePendingPrint(jobId, 'operator')` is already a valid, tested call — proven directly in `queue-dual-completion.test.ts`'s `approved_by=operator` case — so 11-03 only needs to build the CMS route and page that calls it. The suite is green everywhere else: 997/1000 tests, 84 files, `npm run typecheck` and `npm run build` both clean. The phase itself still cannot close until the five-scenario live-booth gate (SC-6, `11-CONTEXT.md <verification>`) passes with auto-print OFF — unchanged from 11-01's own note, out of scope for every plan in this phase, tracked as the phase's own closing checkpoint.

## Self-Check: PASSED

All 14 files listed under `key-files`/`Files Created/Modified` exist on disk (verified via direct file existence checks — the new file `test/queue-send-site-invariant.test.ts` and all 13 modified files). All 3 task commit hashes (`db4093b`, `733d48f`, `15fa1a8`) exist in `git log --oneline --all`. This `SUMMARY.md` itself exists at the expected path. `git status --porcelain` in `mirror-request` is empty. `npm test` reports 997/1000 passing across 84 files (1 red: `test/cms-photo-history.test.ts`, plan 11-03's, deliberately untouched). `npm run typecheck` and `npm run build` both exit 0.

---
*Phase: 11-retake-approval-anchor*
*Completed: 2026-08-18*
