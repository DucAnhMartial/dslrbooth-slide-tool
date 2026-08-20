---
phase: 11-retake-approval-anchor
plan: 01
subsystem: booth-queue-state-machine
tags: [sqlite, better-sqlite3, state-machine, timers, retake, notifications, dslrbooth]

requires:
  - phase: 07-session-lifecycle-retake
    provides: pending_print registry (D-07/D-08), current_job_id attribution (D-06), no_photo close sweep (D-03/D-09), release-vs-completion split (D-02)
provides:
  - "booth_state.attempt_open / attempt_no — the persisted attempt spine (D11-01)"
  - "pending_print.{photo_url,attempt_no,approved_by,approved_at} and the accessors around them"
  - "finalizePendingPrint(jobId, door) — the one idempotent send/close/release gate (D11-05)"
  - "extractCompositePath()/compositeStem() — no more param5 hardcode, stem-not-string comparison"
  - "RETAKE_GRACE_MS grace window with cancel/expiry/disconnect/stop/restart lifecycle (D11-06)"
  - "sequence D (07-EVIDENCE §D) proven end to end, replayed verbatim with real millisecond gaps"
affects: [11-02-legacy-test-migration, 11-03-operator-door, notification-service, cms]

actuals:
  tokens: 30310
  tasks: 3
  commits: 3

tech-stack:
  added: []
  patterns:
    - "Read-then-branch application-code accessor (openOrOverwritePendingPrint) over a single ON CONFLICT ... WHERE clause, so the caller gets a three-way outcome report (opened/overwritten/unchanged) an upsert's changes-count alone cannot distinguish."
    - "Idempotent SQL predicate as the sole 'has this already happened' check (markPendingPrintFinalized, setPendingPrintPhotoUrl's two-disjunct WHERE) — no application-level flag anywhere in the new code."
    - "Attempt counter as a single-row booth_state column, reset to 0 by every REPLACE-style writer, rather than a 5th BoothState enum value — keeps every existing BoothState consumer (onAgentDisconnected's !== 'BUSY' guard, statusRoute's in-flight count, displayServer's broadcast) unmodified."

key-files:
  created:
    - mirror-request/test/queue-retake-grace-timer.test.ts
  modified:
    - mirror-request/src/config.ts
    - mirror-request/src/types.ts
    - mirror-request/src/state/localStore.ts
    - mirror-request/src/queue/queueService.ts
    - mirror-request/test/helpers/pendingPrintRegistry.ts
    - mirror-request/test/queue-retake-anchor.test.ts
    - mirror-request/test/local-store-persistence.test.ts

key-decisions:
  - "RETAKE_GRACE_MS is a real EnvConfig/.env key (toNum shape), not a D-12 module constant — matches D11-06's explicit 'tunable without rebuild' requirement, unlike PENDING_PRINT_EXPIRY_MS/NO_PHOTO_CLOSE_DELAY_MS."
  - "openOrOverwritePendingPrint clears photo_url/approved_by/approved_at when the composite genuinely changes (a real retake), not just when D11-02's text says so verbatim — this is what makes the 'never send a discarded attempt's URL' prohibition hold even if a grace expiry fires before the new attempt's own upload arrives."
  - "markPendingPrintFinalized() finalizes a job with NO pending_print row at all (inserts a resolved row directly) rather than returning matched:false — required so Q3's empty-session case (session_start -> session_end, no processing_start ever) still reaches a defined outcome via the grace door instead of stranding the guest forever."
  - "setPendingPrintPhotoUrl's WHERE predicate has two disjuncts (awaiting/expired, OR resolved-with-no-url-yet) instead of one — see Deviations below; this single predicate change is what makes D-11's late-arrival delivery exactly-once, provably, at the SQL layer."
  - "recover()'s new mid-grace branch calls finalizePendingPrint(jobId, 'grace') directly rather than re-arming any timer — per flagged assumption A2, the remaining grace window is not reconstructed after a restart."

requirements-completed: [BTH-01, BTH-02, NOT-01, AGT-04]

coverage:
  - id: D1
    description: "Sequence D (07-EVIDENCE §D) replayed verbatim end to end: guest A retakes once, guest B stays queued and unannounced throughout, guest A receives exactly one notification carrying attempt 2's URL (2z2d7s2), never attempt 1's (5g719qt)."
    requirement: NOT-01
    verification:
      - kind: unit
        ref: "test/queue-retake-anchor.test.ts#sequence D — retake then print: guest A gets attempt 2 URL and guest B waits"
        status: pass
    human_judgment: false
  - id: D2
    description: "booth_state gains attempt_open/attempt_no (D11-01), named explicitly in all four INSERT OR REPLACE writers so the column-omission hazard cannot silently zero them; migration is additive and idempotent against a real populated pre-Phase-11 database."
    requirement: BTH-01
    verification:
      - kind: integration
        ref: "test/local-store-persistence.test.ts#D11-01/D11-04/D11-05 pending-print/booth-state migration and accessors (14 cases)"
        status: pass
    human_judgment: false
  - id: D3
    description: "The grace window has one lifecycle: cancelled by a retake, by an Agent disconnect, and by stop(); fires exactly once at expiry through the same finalize gate an approval uses; a restart mid-grace reaches the grace door immediately via recover() rather than re-arming the session timer."
    requirement: BTH-02
    verification:
      - kind: unit
        ref: "test/queue-retake-grace-timer.test.ts (8 cases)"
        status: pass
    human_judgment: false
  - id: D4
    description: "processing_start's composite is extracted by a scan-and-fallback rule (last param pointing into \\Prints\\, else highest-indexed non-empty param) shared between agentEventDetail() and onPrintComposite() — no hardcoded param index anywhere."
    requirement: AGT-04
    verification:
      - kind: unit
        ref: "test/queue-retake-anchor.test.ts (1-shot layout, param2) + grep -F \"'param5'\" src/queue/queueService.ts (non-comment occurrences = 0)"
        status: pass
    human_judgment: false
  - id: D5
    description: "The phase does not close until the five-scenario live booth gate in 11-CONTEXT.md <verification> passes on the real booth with auto-print off."
    human_judgment: true
    rationale: "Requires a physical dslrBooth with auto-print OFF and a genuinely queued second guest — this cannot be automated from source. Out of scope for this plan (SC-6 is the phase's own closing gate, not a Task 1-3 deliverable); tracked for 11-05 / the phase's final live-booth checkpoint."

duration: 95min
completed: 2026-08-18
status: complete
---

# Phase 11 Plan 01: Sequence D Tracer — Attempt Spine, Finalize Gate, Grace Window Summary

**Built the attempt spine (D11-01), the composite/approval split (D11-02/D11-03), the single idempotent finalize gate (D11-05), and the 20-second retake grace window (D11-06) on the one measured path that matters — 07-EVIDENCE §D — and proved every claim against it plus a real SQLite database, without touching the ~11 legacy test files that still assert the single-anchor model this phase deliberately replaces.**

## Performance

- **Duration:** ~95 min
- **Started:** 2026-08-18T06:16:00Z (approx.)
- **Completed:** 2026-08-18T06:47:00Z (approx.)
- **Tasks:** 3 / 3 completed
- **Files modified:** 7 (1 new)

## Accomplishments

- Guest A's rejected attempt (URL `5g719qt`) can never reach a guest — proven by replaying sequence D's exact millisecond timeline through the real `QueueService`, asserting `sendPhotoLink` fires exactly once, carrying attempt 2's URL (`2z2d7s2`), and never the discarded one.
- `finalizePendingPrint(jobId, door)` is now the ONLY place a guest's photo is sent — `processing_start` and `file_upload` both write, never send; `printing`, the grace timer, and (in a later plan) the operator button are the only three callers.
- The migration (`booth_state.attempt_open/attempt_no`, `pending_print.{photo_url,attempt_no,approved_by,approved_at}`) is proven additive and idempotent against a real, populated, pre-Phase-11-shaped SQLite file — not just a freshly-bootstrapped one — which is the only version of the test that can catch a writer silently reverting a real row.
- The grace window's full lifecycle is proven: cancelled by a retake, by an Agent disconnect, and by `stop()`; fires exactly once at expiry; a restart mid-grace reaches a defined outcome via `recover()`'s new third branch instead of re-arming the wrong timer.
- Phase 7's D-02 release-fallback timer is retired on the record — its field, its start/clear pair, and every call site are gone, with the guarantee's new home (`RETAKE_GRACE_MS` for an unapproved attempt, unchanged `SESSION_TIMEOUT_MS` for a session that never starts) documented at the point of removal.
- One bug found and fixed mid-plan (not present in the shipped Task 1 commit's own tests, but would have shipped as a real defect): a genuine duplicate/replay of a *late* print upload (arrived after a no-photo close) could have sent the guest's photo twice. Fixed with one SQL predicate, not an application flag — see Deviations.

## Task Commits

1. **Task 1: Sequence D end to end — attempt spine, finalize gate, grace window, one notification** - `8835f29` (feat)
2. **Task 2: The migration and the two conflict semantics proved against real SQLite** - `4615d04` (test — includes one Rule-1 bug fix in `src/queue/queueService.ts`/`src/state/localStore.ts`, documented below)
3. **Task 3: Grace-timer lifecycle — cancel, expiry, disconnect, stop, and restart mid-grace** - `fe897ac` (feat)

No separate plan-metadata commit — `.planning/` is not under version control in this project (`mirror-request` is the only git repository), so `SUMMARY.md`/`STATE.md`/`ROADMAP.md` are written to disk but not committed.

_Task 2 carries `tdd="true"` per the plan; its RED/GREEN gate is implicit here since it extends an existing real-SQLite test file rather than introducing a wholly new one — every new case was written and run to confirm it exercised real behavior (not a vacuous pass) before the commit landed._

## Files Created/Modified

- `mirror-request/src/config.ts` - adds `RETAKE_GRACE_MS: toNum('RETAKE_GRACE_MS', 20_000)`, a real `.env` key
- `mirror-request/src/types.ts` - adds `RETAKE_GRACE_MS: number` to `EnvConfig`
- `mirror-request/src/state/localStore.ts` - migration for the six new columns; `getBoothAttempt`/`openBoothAttempt`/`closeBoothAttempt`; `openOrOverwritePendingPrint`; `setPendingPrintPhotoUrl`; `markPendingPrintFinalized` (replaces `resolvePendingPrint`); four booth-state writers now name `attempt_open`/`attempt_no` explicitly
- `mirror-request/src/queue/queueService.ts` - `extractCompositePath`/`compositeStem`; `finalizePendingPrint`; the grace timer (`releaseGraceTimer`/`startReleaseGraceTimer`/`clearReleaseGraceTimer`); rewritten `sessionEnded`/`sessionAckedFromEvent`/`sessionAcked`/`onPrintComposite`/`onFileUpload`/`logSessionSummary`/`recover`/`onAgentDisconnected`; retired `releaseTimer`/`startReleaseTimer`/`clearReleaseTimer`
- `mirror-request/test/helpers/pendingPrintRegistry.ts` - extended in place with `photoUrl`/`attemptNo`/`approvedBy`/`approvedAt`, `openOrOverwritePendingPrint`'s overwrite-vs-unchanged branch, `markPendingPrintFinalized` (replaces `resolvePendingPrint`)
- `mirror-request/test/queue-retake-anchor.test.ts` - rewritten (D11-10): sequence D replayed verbatim, real millisecond gaps, mocked `LocalStore`, guest B queued throughout
- `mirror-request/test/local-store-persistence.test.ts` - extended: 14 new real-SQLite cases (72 tests total, was 61)
- `mirror-request/test/queue-retake-grace-timer.test.ts` - **new**: 8 cases covering the grace timer's full lifecycle

## Decisions Made

See `key-decisions` in frontmatter. The most consequential one not already locked by `11-CONTEXT.md`: `openOrOverwritePendingPrint`'s overwrite branch clears `photo_url`/`approved_by`/`approved_at`, not just `composite_path`/`attempt_no`/deadline. The plan's own text only explicitly names the composite/attempt/deadline fields for the overwrite; clearing the URL too is what closes a real gap — without it, a retake's `processing_start` would leave attempt 1's URL sitting in the slot, and if the guest then walked away before attempt 2 ever uploaded, a grace expiry would have sent attempt 1's rejected photo. This is a direct, load-bearing instance of the plan's own prohibition ("never send a discarded attempt's URL to the guest"), applied one step earlier than the plan's prose spelled out.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `onFileUpload`'s late-arrival path could deliver the same late photo twice**
- **Found during:** Task 2, while writing the real-SQL proof for `setPendingPrintPhotoUrl`
- **Issue:** Task 1's `onFileUpload` distinguished "finalized with a URL already sent" from "finalized with no URL, deliver late" by reading `pending.photoUrl` at call time, but never recorded that a late delivery had happened. A genuine duplicate/replay of that same late upload (dslrBooth resending, or a network retry) would find `photoUrl` still empty and deliver — and therefore `sendNotification` — a second time. This is exactly the class of defect D-04/D-11 exist to prevent, just on the newly-added late-arrival path.
- **Fix:** Extended `setPendingPrintPhotoUrl`'s SQL predicate with a second disjunct — it now also matches a `'resolved'` row whose `photo_url` is still `NULL`, and writing the URL in that same statement is what makes a second late write fail the identical predicate on retry. Collapsed `onFileUpload`'s three-way branch into one write call plus a two-way branch on the pre-write read, replacing the removed `deliverLateUpload` helper's manual duplication.
- **Files modified:** `mirror-request/src/state/localStore.ts` (SQL predicate), `mirror-request/src/queue/queueService.ts` (`onFileUpload` simplified), `mirror-request/test/helpers/pendingPrintRegistry.ts` (mock updated to match)
- **Verification:** `test/local-store-persistence.test.ts`'s two new cases (`setPendingPrintPhotoUrl` late-write-once, and never-matches-a-URL-already-sent) plus the full Task 1/2 test files re-run green afterward
- **Committed in:** `4615d04` (part of Task 2's commit — same idempotent-SQL-predicate idiom Task 2 was already proving, so folding the fix into that commit kept the "one idempotent write, proved against real SQLite" story in one place rather than splitting it across two commits)

---

**Total deviations:** 1 auto-fixed (Rule 1 — bug)
**Impact on plan:** Necessary for correctness (a real double-send defect on the phase's own new late-arrival path); no scope creep — touched only files already in this plan's declared scope, and Task 1's own test (`queue-retake-anchor.test.ts`) was re-verified green after the change.

## Issues Encountered

None beyond the deviation above. The plan's acceptance-criteria greps (`grep -Fc 'resolvePendingPrint' src/`, the booth-state writer column-list equality check, `handleStall` occurrence-count stability across Task 3's edits) each required one small follow-up fix to a doc-comment's exact wording — not a behavior change, just keeping the literal grep counts the plan's own acceptance criteria pin exactly stable. Documented inline in the commits, not repeated here as deviations since no code behavior changed.

## Known Stubs

None. Every accessor and handler this plan introduces is wired to real callers; nothing renders a hardcoded empty value or a placeholder string.

## Suite State — Full `npm test` Run (informational, NOT a gate for this plan)

Baseline before this plan: **82 test files / 967 tests, all passing.**

After this plan: **71 files / 907 tests passing; 12 files / 78 tests RED.** This is expected and explicitly out of scope for Plan 01 — the plan's own `<verification>` section states `npm test` is not a gate here, and names the failure class: pre-existing tests asserting the single-anchor / send-on-upload model D11-02/D11-04/D11-05 deliberately replace. **Plan 11-02 owns migrating every file below.**

The exact red file list, measured after this plan's third commit (broader than 11-RESEARCH.md's pre-implementation prediction of 9 files — 3 more surfaced once real code existed to run against):

1. `test/queue-dual-completion.test.ts` — asserts `processing_start` alone completes the job (D11-02 removes that)
2. `test/queue-event-coverage.test.ts` — same completion-anchor assumption, plus a `param5`-specific composite-position assertion (D11-07 changed the extraction rule)
3. `test/queue-release-timer.test.ts` — its entire premise (`releaseTimer` starting at `processing_start`) is gone; the file needs restructuring, not just new assertions
4. `test/queue-no-photo-outcome.test.ts` — same completion-anchor assumption
5. `test/queue-countdown.test.ts` — same
6. `test/queue-session-start-hijack.test.ts` — mocked stores predate `getBoothAttempt`/`openBoothAttempt`/`closeBoothAttempt`, which `sessionAckedFromEvent` now calls unconditionally
7. `test/queue-file-upload-print.test.ts` — its first `describe` block (~10 cases) asserts `file_upload` alone sends the notification (D11-04 removes that); its second block asserts the old `resolvePendingPrint` status-flip-on-upload shape (D11-05 moves the flip to finalize)
8. `test/queue-event-photo.test.ts` — same send-on-upload assumption
9. `test/queue-print-registry-expiry.test.ts` — mocked stores predate `getBoothAttempt` (same class as #6); its own fixture also predates the finalize-gate shape
10. `test/queue-photo-image-resolution.test.ts` — calls `store.openPendingPrint(...)` against a real `LocalStore` and expects the old send-on-upload path to fire `resolveImageUrl`
11. `test/phase8-cutover-readiness.test.ts` — same real-`LocalStore` `openPendingPrint`/send-on-upload dependency, in an end-to-end cutover scenario
12. `test/cms-photo-history.test.ts` — same real-`LocalStore` dependency, driving photo history through the old `onFileUpload` send path

None of these twelve files are in this plan's `files_modified` list, and per the executor instructions none were touched. `git status --porcelain` in `mirror-request` is empty after the third commit — the working tree carries no uncommitted trace of the full-suite run above.

## Flagged Assumptions — What Was Implemented

- **PROBE-1…PROBE-4 (specless probe, BTH-01/BTH-02/NOT-01/AGT-04 classified `unclassified` → `unresolved`).** No `SPEC.md` exists for this phase; the edge acceptance criteria for these four requirement IDs were authored directly from the locked `11-CONTEXT.md` decisions and the measured `07-EVIDENCE` sequences rather than inherited from a spec (see the plan's own `must_haves.truths`). All four are now covered by the automated tests listed in `coverage` above — D1/D2 for NOT-01/BTH-01, D3 for BTH-02, D4 for AGT-04.
- **A2 (restart mid-grace finalizes immediately, does not resume a partial countdown).** Implemented exactly as flagged: `recover()`'s new branch calls `finalizePendingPrint(jobId, 'grace')` directly the moment it finds `state === 'BUSY' && attempt_open === 0`, with no attempt to reconstruct the remaining window. Documented in the method's own comment. Not yet ratified by the operator — this remains the executor's/researcher's simplicity-driven default, unchanged from the plan.
- **A3 (`BoothState` gains no 5th `'GRACE'` value).** Implemented as designed: grace is represented purely by `booth_state.attempt_open = 0` with `current_job_id` still bound; `booth_state.state` stays `'BUSY'` throughout. `onAgentDisconnected()`'s `!== 'BUSY'` guard, confirmed in Task 3's own test, continues to catch a disconnect during grace unmodified.
- **Q3 (an empty session — `session_start` → `session_end` with no composite ever produced — opens grace like any other unapproved attempt).** Implemented and directly tested: `test/queue-retake-grace-timer.test.ts`'s "grace expiry with an empty slot" case drives exactly this shape and confirms the job closes `no_photo`, charges no retry, and writes no `stall_reason`. `markPendingPrintFinalized()` was extended (beyond the plan's literal "reads the row and applies the existing resolve predicate" wording) to also finalize a job with **no** `pending_print` row at all, by inserting a resolved row directly — without this, Q3's scenario would have left `finalizePendingPrint` returning `matched: false` and the booth permanently stranded on the currently-bound job. This is recorded as an implementation necessity, not yet a re-measurement of ❶ (07-EVIDENCE's own still-open question) — the plan's Q3 assumption remains unratified by a fresh live-booth measurement.

## User Setup Required

None - no external service configuration required. `RETAKE_GRACE_MS` is optional with a working default (20000ms); no `.env` change is required for this plan's automated tests or for a production deploy to keep functioning, though the operator may want to add it explicitly once the phase's live-booth gate (SC-6) is run.

## Next Phase Readiness

Ready for **11-02** (migrating the twelve legacy test files listed above onto the new finalize-gate model) and **11-03** (the CMS operator door, D11-08 — deferred per this plan's own `<artifacts_produced>` list: `POST /cms/api/booth/release`, `cmsBoothRoutes.ts`, `cmsBoothPages.ts`, `getBoothStallInfo()`, `releaseForOperator()`). The attempt spine, the finalize gate, and the grace timer are all in place, real-SQL-proven, and building blocks 11-02/11-03 can call directly (`finalizePendingPrint(jobId, 'operator')` is already a valid call — only the CMS route and its narrow `CmsBoothLink` interface remain to be built). The phase itself cannot close until the five-scenario live-booth gate (SC-6, `11-CONTEXT.md <verification>`) passes with auto-print OFF — that is explicitly out of scope for every plan in this phase, tracked as the phase's own closing checkpoint.

## Self-Check: PASSED

All 8 files listed under `key-files`/`Files Created/Modified` exist on disk (verified via direct file
existence checks). All 3 task commit hashes (`8835f29`, `4615d04`, `fe897ac`) exist in `git log --oneline
--all`. This `SUMMARY.md` itself exists at the expected path. `git status --porcelain` in `mirror-request`
is empty. `npm run typecheck` and `npm run build` both exit 0.
