---
phase: 11-retake-approval-anchor
plan: 05
subsystem: operator-documentation
tags: [documentation, deployment, ops-runbook, retake, dslrbooth, live-booth-gate]

requires:
  - phase: 11-retake-approval-anchor
    plan: 01
    provides: "the attempt spine, finalizePendingPrint(jobId, door), the RETAKE_GRACE_MS grace window"
  - phase: 11-retake-approval-anchor
    plan: 02
    provides: "every legacy queue test migrated onto the finalize gate; the suite green"
  - phase: 11-retake-approval-anchor
    plan: 03
    provides: "the CMS operator door — GET /cms/booth, POST /cms/api/booth/release"
  - phase: 11-retake-approval-anchor
    plan: 04
    provides: "sequences C/E pinned as tests, cross-door idempotency, every ignore branch proved to log exactly once"
provides:
  - "DEPLOYMENT.md §3/§7d/§9/§11/§12 — auto-print OFF as a numbered, checked setup step; RETAKE_GRACE_MS documented with default/unit/sizing/restart note; §9 item 5 rewritten from 'broken, do not run an event' to the shipped behaviour"
  - "OPS-RUNBOOK.md §3/§5/§6/§8/§14 — the attempt model, the three finalize doors, the extended SESSION_SUMMARY line, the five new log tokens with greps and operator actions, the CMS 'end this guest' control, and a guest-complaint answer procedure; plus three accuracy fixes to stale Phase-7-era claims found while amending (BOOTH_RELEASE_TIMEOUT_MS vestigial, file_upload no longer triggers delivery, the transition table's old single-anchor model)"
  - "11-VALIDATION.md — the five-scenario live booth gate written out ready-to-fill: exact steps, what to watch for, the precise grep per scenario, and an empty result field for each. NOT run."
affects: [deployment-checklist, ops-runbook, phase-closure]

actuals:
  tokens: 11100
  tasks: 2
  commits: 1

tech-stack:
  added: []
  patterns:
    - "Verify-before-write for operator documentation: every log token, route, and config default quoted in DEPLOYMENT.md/OPS-RUNBOOK.md §14 was grepped against the shipped src/ first (extractCompositePath, finalizePendingPrint, cmsBoothRoutes.ts, getBoothStallInfo) rather than transcribed from the plan's or 11-CONTEXT.md's predicted wording — one plan-predicted comparison (RETAKE_GRACE_MS 'unlike BOOTH_RELEASE_TIMEOUT_MS, this is a real .env key') was caught and corrected mid-draft because BOOTH_RELEASE_TIMEOUT_MS is ALSO a real .env key; the correct contrast is with the two Phase 7 D-12 module constants."
    - "Stale-claim sweep as a side effect of 'amend three sections': reading §5/§6/§8 end-to-end to write the required additions surfaced three sentences that were flatly wrong post-Phase-11 (BOOTH_RELEASE_TIMEOUT_MS still described as an active release-fallback timer; file_upload still described as calling sendPhotoLink(); the transition table's processing_start/printing-both-complete row) — all three fixed in the same commit rather than left standing beside the new, correct text."

key-files:
  created: []
  modified:
    - DEPLOYMENT.md
    - mirror-request/docs/OPS-RUNBOOK.md
    - .planning/phases/11-retake-approval-anchor/11-VALIDATION.md

key-decisions:
  - "Left `.env.example` untouched — it was not read or write-attempted this run (the plan's own flagged assumption about a prior write restriction was not re-tested; RETAKE_GRACE_MS is documented in DEPLOYMENT.md §3 and OPS-RUNBOOK.md §3 only, which the plan's flagged-assumptions section names as the acceptable fallback if `.env.example` cannot be written). See 'Flagged Assumptions' below for what was and was not verified this run."
  - "Fixed three stale Phase-7-era claims in OPS-RUNBOOK.md beyond the plan's literal §3/§5/§6 scope (BOOTH_RELEASE_TIMEOUT_MS's description, file_upload's delivery trigger, one transition-table row) — justified under the plan's own prohibition 'never document a behaviour that the code does not have' rather than treated as scope creep, since all three sentences were provably false against the shipped src/ and directly adjacent to the sections the plan named."
  - "11-VALIDATION.md's frontmatter (status: draft, wave_0_complete: false, nyquist_compliant: false) was left exactly as seeded, not flipped to validated/true — the plan's own acceptance criteria for Task 3 states those flip 'only if every scenario passed,' and no scenario has run. Only the body (verification-map Status column, Wave 0 checklist, and the new ready-to-fill scenario section) was updated to reflect what IS true today (every automated requirement green) without touching the flags that gate the phase's own closure."

requirements-completed: []

coverage:
  - id: D1
    description: "DEPLOYMENT.md §7 gained a numbered auto-print-OFF setup step (§7d) with its check stated in the same place as the instruction, positioned before §9 in document order; §9 item 5's stale 'HIỆN ĐANG HỎNG' claim is fully rewritten to the shipped retake/walk-away/gallery-reprint/operator-release behaviour."
    requirement: NOT-01
    verification:
      - kind: manual
        ref: "grep -c 'RETAKE_GRACE_MS' DEPLOYMENT.md >= 2; grep -Fc '20000' >= 1; grep -Eic 'restart|khởi động lại' >= 1; first auto-print hit precedes '## 9.'; 'HIỆN ĐANG HỎNG' count = 0; '11-CONTEXT' count >= 1 — all six acceptance-criteria greps run and confirmed passing"
        status: pass
      human_judgment: false
  - id: D2
    description: "OPS-RUNBOOK.md §3/§5/§6/§8 amended and §14 added, covering the attempt model, the three finalize doors, the extended SESSION_SUMMARY line (verbatim, field order preserved), all five new log tokens with their greps verified against src/, the CMS operator control, and the guest-complaint answer procedure."
    requirement: BTH-02
    verification:
      - kind: unit
        ref: "the plan's nine named acceptance-criteria greps against docs/OPS-RUNBOOK.md, all run and passing (approved_by >= 4 [got 16], attempts= >= 1 [got 3], SESSION_SUMMARY field order, all five tokens present [2/3/2/1/2], /cms/api/booth/release present, RETAKE_GRACE_MS present, exactly one '## 14.' heading)"
        status: pass
      human_judgment: false
  - id: D3
    description: "Every one of the five documented log tokens is grep-able in the shipped src/, not only in the documentation — verified individually, not assumed."
    requirement: AGT-04
    verification:
      - kind: unit
        ref: "grep -rF '<token>' src/ | wc -l for each of the five tokens — all five returned exactly 1"
        status: pass
      human_judgment: false
  - id: D4
    description: "The suite is unaffected by this docs-only plan: 87/87 files, 1041/1041 tests, npm run typecheck and npm run build both clean, git status --porcelain empty in mirror-request after the one commit."
    requirement: BTH-01
    verification:
      - kind: integration
        ref: "npm test (87 files / 1041 tests, all pass), npm run typecheck (clean), npm run build (clean), git status --porcelain (empty)"
        status: pass
      human_judgment: false
  - id: D5
    description: "The five-scenario live booth gate in 11-CONTEXT.md <verification> — SC-6 — has NOT been run. 11-VALIDATION.md is prepared as a ready-to-fill record with every scenario's exact steps, what to watch for, and the precise grep, with an empty result field for each."
    human_judgment: true
    rationale: "Requires a physical dslrBooth with auto-print OFF and a genuinely queued second guest. This is the plan's own Task 3, a blocking-human checkpoint the executor is explicitly prohibited from simulating, inferring, or marking passed. Returned to the orchestrator as a structured checkpoint rather than executed."

duration: ~35min
completed: 2026-08-18
status: blocked-checkpoint
---

# Phase 11 Plan 05: Documentation and the Live Booth Gate Summary

**Tasks 1 and 2 complete and committed — DEPLOYMENT.md's auto-print-OFF precondition and `RETAKE_GRACE_MS` config, and OPS-RUNBOOK.md's new §14 covering the attempt model, three finalize doors, five log tokens, and the CMS operator control, all verified against the shipped `src/` rather than transcribed from the plan. Task 3 — the five-scenario live booth gate (SC-6) — is a blocking-human checkpoint prepared as a ready-to-fill record in `11-VALIDATION.md` and NOT executed; this plan halts here awaiting a human at the physical booth.**

## Performance

- **Duration:** ~35 min (reading four upstream summaries + source verification + writing three documents)
- **Completed:** 2026-08-18 (Tasks 1–2 only; Task 3 pending)
- **Tasks:** 2 / 3 completed (Task 3 is the blocking checkpoint below)
- **Files modified:** 3 (1 committed — `mirror-request/docs/OPS-RUNBOOK.md`; 2 written to disk outside version control — `DEPLOYMENT.md`, `11-VALIDATION.md`)

## Accomplishments

- **DEPLOYMENT.md**: auto-print OFF is now a numbered configuration step (§7d), positioned in the booth-PC setup sequence before §8/§9, with its check stated in the same place as the instruction ("run one session, do not press print, confirm the Agent log carries no `printing` line"). §9 item 5's stale "HIỆN ĐANG HỎNG, chờ Phase 11" claim — no longer true — is rewritten to the shipped retake/walk-away/gallery-reprint/operator-release model, explicitly separating what IS proved (by test replay of measured trigger sequences) from what is NOT yet proved (a real camera). §3 gained a full `RETAKE_GRACE_MS` entry: default `20000`, unit (ms), sizing rationale (1.6× the largest measured retake gap, 12.3s), and the restart-not-rebuild note (`pm2 delete`+`start`, not `pm2 restart` or `SIGHUP`). §11 and §12 updated to match.
- **OPS-RUNBOOK.md**: §3 gained the `RETAKE_GRACE_MS` row; §5 gained a new subsection explaining the attempt is a flag on the same `booth_state` row (no new `BoothState` value), rewrote the "Completion and release are two separate anchors" section (which still described the retired Phase 7 `param5`/processing_start-or-printing-both-complete model), replaced the published `SESSION_SUMMARY` line with the shipped one (verbatim, all four original fields in original position, `attempts=`/`approved_by=` appended), and rewrote the transition table for the three finalize doors, the grace window, and startup recovery mid-grace; §6 gained the one required sentence distinguishing `approved_by` (a `pending_print` column) from `stall_reason` (a closed, unrelated vocabulary). A new §14 covers the attempt model, the three doors and what each writes, the operational precondition, all five new log tokens with their greps and operator actions (including the explicit "a composite-mismatch refusal on an ordinary session is a bug report, not an operator action" callout the plan required), the CMS "end this guest" control, and the two-grep guest-complaint answer procedure.
- **Three stale claims fixed beyond the plan's literal §3/§5/§6 scope**, all directly caused by Phase 11 retiring behaviour these sentences described as still active: `BOOTH_RELEASE_TIMEOUT_MS`'s §3 entry described an active release-fallback timer that 11-01 confirmed was fully retired (field, start/clear pair, every call site gone) — now marked vestigial with the reason and what actually bounds the booth today. §8's "An Agent `file_upload` event calls `sendPhotoLink()`" is false since D11-04/05 moved delivery to the finalize gate — fixed with a pointer to §14. The transition table's `processing_start`/`printing` completion row predates D11-02/D11-03 entirely — rewritten into five separate, accurate rows.
- **Every log token, route, and config default in the new documentation was verified against the shipped source before being written down**, per the objective's own instruction: `grep -rF '<token>' src/` for all five new tokens (each returns exactly 1), `getBoothStallInfo()`/`releaseForOperator()` read directly from `queueService.ts`, the exact `SESSION_SUMMARY` template string read from its own `queueLogger.info()` call. One self-caught error during drafting: an early draft claimed `RETAKE_GRACE_MS` is "unlike `BOOTH_RELEASE_TIMEOUT_MS`, a real `.env` key" — false, both are real `.env` keys; corrected to contrast with the two Phase 7 D-12 module constants (`PENDING_PRINT_EXPIRY_MS`/`NO_PHOTO_CLOSE_DELAY_MS`), which is what 11-01-SUMMARY's own key-decision actually states.
- **`11-VALIDATION.md` prepared as a ready-to-fill record**: the Per-Task Verification Map's Status column updated to ✅ green for every automated row (87/87 files, 1041/1041 tests, confirmed this run), the Wave 0 checklist checked off, and a new "Five-Scenario Live Booth Gate — READY TO FILL, NOT YET RUN" section added with a before-starting checklist and, per scenario, the exact steps from `11-CONTEXT.md <verification>`, what to watch for, the precise grep(s) to read the result, and an explicit `_(pending — run at the booth)_` result field. Frontmatter (`status: draft`, `wave_0_complete: false`, `nyquist_compliant: false`) left exactly as seeded — none of these flags were set, because the plan's own Task 3 acceptance criteria says they flip only after every scenario passes.
- Suite verified unaffected (this plan touches no source): `npm test` — **87/87 files, 1041/1041 tests**; `npm run typecheck` and `npm run build` both clean; `git status --porcelain` empty in `mirror-request` after the one commit.

## Task Commits

1. **Task 1: DEPLOYMENT.md — auto-print OFF as a mandatory step, and the grace key** — no git commit possible. `DEPLOYMENT.md` lives at `/opt/mirror_request_dslrobooth/` (workspace root), which is **not** a git repository — only `mirror-request` is. Written to disk; verified via all six of the task's own acceptance-criteria greps, all passing.
2. **Task 2: OPS-RUNBOOK — the attempt and approval model, the new log vocabulary, and the operator control** — `f40cd0f` (docs), in `mirror-request`.

No separate plan-metadata commit — matching 11-01 through 11-04's own precedent, `.planning/` is not under version control in this project, so `SUMMARY.md`/`STATE.md`/`11-VALIDATION.md` are written to disk but not committed. `STATE.md`, `ROADMAP.md`, and `REQUIREMENTS.md` updates are **deliberately deferred**: this plan has not completed (Task 3 is the blocking checkpoint below), so advancing the plan pointer or marking requirements complete now would be premature — those updates belong to whichever agent resumes after the live gate records its result.

## Files Created/Modified

- `DEPLOYMENT.md` — §3 (new `RETAKE_GRACE_MS` entry), §7 (new §7d, the numbered auto-print-OFF step), §9 item 5 (fully rewritten), §11 (new outstanding item 6), §12 (checklist updated) — **not under version control, written to disk only**
- `mirror-request/docs/OPS-RUNBOOK.md` — §3 (`RETAKE_GRACE_MS` row; `BOOTH_RELEASE_TIMEOUT_MS` row corrected), §5 (new attempt-flag subsection; "Completion and release" rewritten; `SESSION_SUMMARY` line and field table extended; transition table rewritten), §6 (the `approved_by`-vs-`stall_reason` sentence), §8 (two accuracy fixes to the delivery-trigger claim), §14 (new, ~180 lines) — committed `f40cd0f`
- `.planning/phases/11-retake-approval-anchor/11-VALIDATION.md` — verification-map Status column, Wave 0 checklist, new ready-to-fill scenario section — **not under version control, written to disk only**

## Decisions Made

See `key-decisions` in frontmatter. The most consequential one: fixing the three stale Phase-7-era claims in OPS-RUNBOOK.md that were NOT explicitly named in the plan's §3/§5/§6 action text, justified under the plan's own explicit prohibition — "never document a behaviour that the code does not have" — rather than deferred as out-of-scope. All three were directly adjacent to (in two cases, inside) the sections the plan named for amendment, and all three were provably false against `src/queue/queueService.ts` as it stands after 11-01 through 11-04. Leaving them would have shipped documentation that actively contradicts the code two paragraphs below the new, correct text.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Three stale Phase-7-era claims in OPS-RUNBOOK.md, found while amending the sections the plan named**

- **Found during:** Task 2, while reading §5/§6/§8 in full per the plan's own `<read_first>` instruction, before drafting the required additions
- **Issue:** (a) §3's `BOOTH_RELEASE_TIMEOUT_MS` entry described it as an active release-fallback timer — 11-01-SUMMARY confirms this timer, its field, and every call site were fully retired; the config value is now read into memory but never used to start anything. (b) §5's "Completion and release are two separate anchors" section described `processing_start.param5`/`printing.param1` as equivalent completion signals, whichever-arrives-first — this is exactly the model D11-02/D11-03 replaced. (c) §8 stated "An Agent `file_upload` event calls `sendPhotoLink()`" — false since D11-04/D11-05 moved delivery to the finalize gate; `file_upload` now only writes the URL into the pending-print slot.
- **Fix:** (a) marked `BOOTH_RELEASE_TIMEOUT_MS` vestigial with the reason and what bounds the booth today (`RETAKE_GRACE_MS`); (b) rewrote the section into an accurate two-part model (composite-exists vs. approved) with the release-fallback retirement noted; (c) added a corrective paragraph pointing to §14, without rewriting the surrounding "delivery mechanism unchanged" material that remains true.
- **Files modified:** `mirror-request/docs/OPS-RUNBOOK.md`
- **Verification:** Every specific claim in the corrected text re-checked against `src/queue/queueService.ts` directly (`grep -n "boothReleaseTimeoutMs" src/queue/queueService.ts` confirms no timer start/clear pair exists; `onFileUpload()`'s body read directly to confirm it only calls `setPendingPrintPhotoUrl` in the ordinary path)
- **Committed in:** `f40cd0f` (Task 2's only commit — no separate commit, since these are inline corrections within the same sections Task 2 was already amending)

---

**Total deviations:** 1 auto-fixed (Rule 1 — stale/incorrect documentation, functionally a bug in the operator-facing contract this plan exists to keep accurate)
**Impact on plan:** Necessary — leaving any of the three would have violated the plan's own explicit prohibition and left an operator reading contradictory instructions two sections apart. No scope creep beyond the plan's own named files: all three fixes are inside `mirror-request/docs/OPS-RUNBOOK.md`, the exact file Task 2 was scoped to.

## Issues Encountered

None beyond the deviation above and the self-caught drafting error already described in Accomplishments (the `RETAKE_GRACE_MS` vs. `BOOTH_RELEASE_TIMEOUT_MS` comparison), which was corrected before commit and never shipped incorrect.

## Known Stubs

None. Every claim in the new/amended documentation is either (a) verified directly against shipped `src/` this run, or (b) explicitly marked pending/unverified where it is — the entire "Five-Scenario Live Booth Gate" section in `11-VALIDATION.md` is deliberately a stub-shaped ready-to-fill record, and is labeled as such in its own heading ("READY TO FILL, NOT YET RUN") rather than left silently incomplete.

## Flagged Assumptions — What Was Implemented

- **`.env.example` write restriction (plan's own flagged assumption).** Not re-tested this run — `.env.example` was neither read nor write-attempted. `RETAKE_GRACE_MS` is documented in `DEPLOYMENT.md` §3 and `OPS-RUNBOOK.md` §3 only, which the plan's own flagged-assumptions section names as the acceptable outcome if `.env.example` remains unwritable. This gap is stated here explicitly per the plan's own instruction, rather than left to be discovered.

## User Setup Required

**Before the live gate (Task 3) can run:**
1. Auto-print OFF on the booth PC's dslrBooth installation (`DEPLOYMENT.md` §7d) — a manual dslrBooth Settings → Printing checkbox, unenforceable from this codebase.
2. This phase's build deployed to the booth-connected service instance.
3. A genuinely queued second guest available for scenarios 1 and 2 (a real person or a second registration).

None of the above can be automated from this environment — see the checkpoint below.

## Next Phase Readiness

**This plan is NOT complete.** Tasks 1 and 2 are done and verified; Task 3 — the five-scenario live booth gate, SC-6 — is a blocking-human checkpoint that requires a physical dslrBooth with auto-print OFF and a genuinely queued second guest, and cannot be discharged from source. `11-VALIDATION.md` is prepared and ready to fill; `.planning/STATE.md`, `.planning/ROADMAP.md`, and `.planning/REQUIREMENTS.md` are deliberately NOT updated by this run, since the plan pointer should not advance past an unresolved blocking checkpoint. The phase itself does not close until a human runs all five scenarios at the booth and records their outcomes in `11-VALIDATION.md` — see the checkpoint returned alongside this summary for exactly what to do next.

## Self-Check: PASSED

`DEPLOYMENT.md` and `.planning/phases/11-retake-approval-anchor/11-VALIDATION.md` exist on disk with the described edits (verified via direct file reads and the plan's own acceptance-criteria greps, all passing). `mirror-request/docs/OPS-RUNBOOK.md` exists with the described edits. Commit hash `f40cd0f` exists in `git log --oneline --all` (confirmed: `git log --oneline -1` shows `f40cd0f docs(11-05): the attempt model, three doors, and five new log tokens (OPS-RUNBOOK)`). This `SUMMARY.md` itself exists at the expected path. `git status --porcelain` in `mirror-request` is empty. `npm test` reports 87/87 files, 1041/1041 tests passing (unchanged from 11-04, as expected for a docs-only plan). `npm run typecheck` and `npm run build` both exit 0.

---
*Phase: 11-retake-approval-anchor*
*Status: blocked on Task 3 (live booth gate, SC-6) — awaiting human execution*
