---
phase: 11-retake-approval-anchor
plan: 04
subsystem: booth-queue-state-machine
tags: [vitest, retake, notifications, dslrbooth, finalize-gate, structural-invariant]

requires:
  - phase: 11-retake-approval-anchor
    plan: 01
    provides: "the attempt spine, finalizePendingPrint(jobId, door) as the one idempotent finalize gate, the composite/approval split (D11-02/D11-03), the RETAKE_GRACE_MS grace window"
  - phase: 11-retake-approval-anchor
    plan: 02
    provides: "every legacy queue test migrated onto the finalize gate; the suite green everywhere"
  - phase: 11-retake-approval-anchor
    plan: 03
    provides: "QueueService.releaseForOperator(jobId) — the operator door, public and directly callable"
provides:
  - "07-EVIDENCE sequences C and E, replayed verbatim, as automated tests — the gallery reprint (both shapes) and the auto-print-ON degradation, previously only asserted in prose"
  - "D11-03's stem-not-string composite comparison pinned against 07-EVIDENCE conclusion 15's own measured copy-suffix pair, plus a genuinely-different-stem negative case"
  - "test/queue-finalize-idempotency.test.ts — the finalize gate proven idempotent from all three doors and every ordering, called directly against the private gate for defense-in-depth beyond what the surrounding call sites already prevent"
  - "test/queue-ignored-branches.test.ts — every ignore branch on the retake/print path proven to log exactly once (behavioural), plus a structural source-invariant that a future silent branch fails the suite rather than pass unnoticed"
  - "one production fix: the 'carried no usable composite path' warn now names the job id, matching every sibling line's own convention"
affects: [notification-service, cms, deployment-checklist, ops-runbook]

actuals:
  tokens: 15384
  tasks: 3
  commits: 3

tech-stack:
  added: []
  patterns:
    - "Reaching a private idempotent gate directly via an `as unknown as {...}` cast to prove defense-in-depth idempotency, independent of whichever call sites happen to make a live race rare today — the exact technique 11-02's own approved_by=operator case established before the CMS route existed."
    - "Brace-depth backward-scan to find a `return` statement's OWN enclosing block (not the whole method), so a structural 'every early return has a logger call in its branch' assertion is precise about WHICH branch, not merely 'somewhere in this function'."
    - "Parameterized, backward-compatible test harness extension (buildStore(opts = {}) defaulting to the prior bare-call shape) instead of forking a second harness for new fixture shapes within the same file."

key-files:
  created:
    - mirror-request/test/queue-finalize-idempotency.test.ts
    - mirror-request/test/queue-ignored-branches.test.ts
  modified:
    - mirror-request/test/queue-retake-anchor.test.ts
    - mirror-request/src/queue/queueService.ts

key-decisions:
  - "Sequence E's two shapes are built from `currentJobId`/`attemptOpen`/`attemptNo` states directly (a bound-but-not-yet-acknowledged booth for 'idle'; an open attempt with its own composite for 'another guest's attempt open'), not from a literal booth-IDLE state — a genuinely idle booth (no job bound at all) hits a DIFFERENT, earlier guard (`arrived with no job bound to the booth`) before D11-03's own 'no attempt open' check is ever reached. This is the real production shape: the Agent's own stale activeJobId stamp is always whichever job it most recently dispatched, so a reprint's jobId is never truly absent once a next guest is bound."
  - "Task 2's door-ordering cases call the private `finalizePendingPrint` directly for the SECOND door in every ordering, rather than only relying on the real event/timer path. In production the surrounding call sites already make a live two-door race structurally rare (a grace timer is cleared by finalize before it could fire again; `releaseForOperator`'s own outer guard refuses once the booth has moved on) — reaching the gate directly proves the GATE ITSELF is idempotent, independent of that surrounding plumbing, which is the actual property D11-05 claims."
  - "The 4-shot copy-suffix composite (07-EVIDENCE conclusion 15) is transcribed with its date REDACTED (`********`), exactly as the evidence file itself redacts it, rather than inventing a plausible date — the plan's own prohibition is 'never paraphrase a measured trigger sequence into a fixture,' and a redacted field is part of what was measured."

requirements-completed: [NOT-01, AGT-04, BTH-02]

coverage:
  - id: D1
    description: "Sequence E (the gallery reprint, 07-EVIDENCE §E) finalizes nothing and logs why in both shapes: a bound-but-not-yet-acknowledged booth logs 'no attempt open'; another guest's own open attempt logs the composite mismatch naming both paths. The trailing session_end opens a grace window for that guest instead of releasing the booth, and their own next session_start cancels it and reopens their attempt."
    requirement: NOT-01
    verification:
      - kind: unit
        ref: "test/queue-retake-anchor.test.ts#QueueService — sequence E (07-EVIDENCE §E), the gallery reprint 18 minutes later — D11-03 / SC-2 (4 cases)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Sequence C (07-EVIDENCE §C, auto-print ON), replayed verbatim including the empty ❶ session, as an explicit NAMED test case: printing fires before any upload, the job closes no_photo mid-guest, the booth releases early, and the discarded attempt's URL is the only one ever delivered — pinning the cost of the operator precondition (DEPLOYMENT.md §7/§9) by test rather than prose alone."
    requirement: NOT-01
    verification:
      - kind: unit
        ref: "test/queue-retake-anchor.test.ts#QueueService — sequence C (07-EVIDENCE §C), replayed verbatim: what breaks when AUTO-PRINT IS LEFT ON (2 cases)"
        status: pass
    human_judgment: false
  - id: D3
    description: "D11-03's composite comparison is by filename STEM, not exact string: a printing composite differing only by the measured _1x/_2x (and a double-digit _10x) copy-count suffix still approves; a genuinely different timestamp stem is still refused."
    requirement: AGT-04
    verification:
      - kind: unit
        ref: "test/queue-retake-anchor.test.ts#QueueService — D11-03 composite comparison is by STEM, not exact string (07-EVIDENCE conclusion 15) (3 cases)"
        status: pass
    human_judgment: false
  - id: D4
    description: "No 'no usable composite path' warning fires on either the 4-shot or the 1-shot layout, across processing_start's scan-and-fallback extraction AND printing's own param1 read, asserted as an absence across the whole replay rather than a single event."
    requirement: AGT-04
    verification:
      - kind: unit
        ref: "test/queue-retake-anchor.test.ts#QueueService — D11-07 composite extraction never warns 'no usable composite path' on any measured layout (2 cases)"
        status: pass
    human_judgment: false
  - id: D5
    description: "finalizePendingPrint(jobId, door) is idempotent across all three doors and every ordering: whichever fires first wins, a second door is a no-op that reports (an info log naming the door) rather than mutates, and at most one notification is ever sent per job — proven for all four named orderings plus a parametrized sweep of all six door-ordering pairs."
    requirement: NOT-01
    verification:
      - kind: unit
        ref: "test/queue-finalize-idempotency.test.ts#QueueService.finalizePendingPrint — three doors, one gate, idempotent across every ordering (5 cases)"
        status: pass
    human_judgment: false
  - id: D6
    description: "A job finalized with no URL held closes without a photo, charges no retry, writes no stall reason, and sends nothing; the Phase 7 late-arrival guarantee survives the move of the send site — a late print upload is delivered exactly once with a WARN, a duplicate of that same upload is an INFO no-op, and an upload after a finalize that already sent is also an INFO no-op."
    requirement: NOT-01
    verification:
      - kind: unit
        ref: "test/queue-finalize-idempotency.test.ts#QueueService.finalizePendingPrint — the no-URL close and the late-arrival guarantee survive the move of the send site (3 cases)"
        status: pass
    human_judgment: false
  - id: D7
    description: "Every ignore branch on the retake/print path (no usable composite, no job bound, throttled jobId mismatch, both D11-03 printing refusals, session_end with no job bound, and the three file_upload answers) emits exactly one line, carries the job id where it has one to carry, and never leaks a fotoshare URL or the upload URL field — plus a structural, source-level invariant that a future silent branch fails the suite."
    requirement: BTH-02
    verification:
      - kind: unit
        ref: "test/queue-ignored-branches.test.ts (10 cases: 9 behavioural + 1 structural)"
        status: pass
    human_judgment: false
  - id: D8
    description: "The phase does not close until the five-scenario live booth gate in 11-CONTEXT.md <verification> passes on the real booth with auto-print off (SC-6)."
    human_judgment: true
    rationale: "Requires a physical dslrBooth with auto-print OFF and a genuinely queued second guest — cannot be automated from source. Out of scope for every plan in this phase, unchanged from 11-01/11-02/11-03's own note; tracked as the phase's own closing checkpoint (11-05)."

duration: 25min
completed: 2026-08-18
status: complete
---

# Phase 11 Plan 04: The Branches The Tracer Did Not Walk Summary

**Pinned 07-EVIDENCE sequences C (auto-print ON degradation) and E (the gallery reprint, both shapes) as automated tests, proved D11-03's composite comparison is by filename stem against the measured `_1x`/`_2x` copy-suffix pair, proved the finalize gate idempotent across all three doors and every ordering by reaching it directly, and proved every ignore branch on the retake/print path logs exactly once — both behaviourally and structurally against the stripped source — closing SC-2 and SC-5's automated half with one small production fix (a warn line that was missing its own job id).**

## Performance

- **Duration:** ~25 min (commit timestamps span 08:24–08:36 UTC; plus upstream reading/context time)
- **Started:** 2026-08-18T08:12:00Z (approx.)
- **Completed:** 2026-08-18T08:36:34Z
- **Tasks:** 3 / 3 completed
- **Files modified:** 4 (2 new, 2 modified)

## Accomplishments

- Sequence E's gallery reprint is refused in both measured shapes — a bound-but-not-yet-acknowledged booth logs `printing ignored: no attempt open`; another guest's own open attempt logs the exact composite mismatch, naming both paths — and neither shape finalizes anything or sends anything. The trailing `session_end` opens a grace window for the guest genuinely at the booth rather than releasing it, and their own next `session_start` cancels that grace and reopens their attempt, exactly as the plan's flagged assumption predicted.
- Sequence C, replayed verbatim including the empty 12-second ❶ session, is now a NAMED test that reads as the reason for the operator-locked auto-print-OFF precondition rather than as accepted behaviour: with auto-print ON, `printing` fires before any upload arrives, the job closes `no_photo` mid-guest, the booth releases early, and the guest's discarded photo — not the one they wanted — is the only one ever delivered. A second, dedicated case proves this wrong delivery cannot double-fire even if the same upload is resent.
- D11-03's stem-not-string composite comparison is pinned directly against 07-EVIDENCE conclusion 15's own measured instance (a `_1x`/`_2x` copy-count suffix pair on the same timestamp stem), plus a double-digit `_10x` boundary case and a genuinely-different-stem negative case — proving the stem rule is a real normalization, not "compare loosely."
- A dedicated test proves the `no usable composite path` warning never fires on either the 4-shot (`param5`) or 1-shot (`param2`) layout, across both `processing_start`'s scan-and-fallback extraction and `printing`'s own `param1` read, asserted as an absence across the whole replay.
- `test/queue-finalize-idempotency.test.ts` (new, 8 cases) proves `finalizePendingPrint(jobId, door)` is idempotent from every door and every ordering — printing→grace, printing→operator, grace→(late printing, reported via a real warn, not silently dropped), operator→grace, plus a parametrized sweep of all six door-ordering pairs — reaching the gate directly so the guarantee holds independent of the surrounding plumbing that already makes a live race rare. The Phase 7 late-arrival guarantee is proved to have survived the move of the send site: a no-URL close charges no retry and writes no stall reason; a late upload is delivered exactly once with a WARN; a duplicate of that same upload, or an upload after a finalize that already sent, is an INFO no-op.
- `test/queue-ignored-branches.test.ts` (new, 10 cases) proves every ignore branch on the retake/print path — the no-usable-composite warn, the no-job-bound warn, the throttled jobId-mismatch warn, both D11-03 printing refusals, the no-job-bound `session_end`, and all three `file_upload` answers — logs exactly once, carries the job id where it has one to carry, and never leaks a fotoshare URL. A structural half reads `queueService.ts`'s own stripped source and asserts every early `return` across the four methods that make up this surface is preceded by a `queueLogger.` call in its own enclosing branch — a property no behavioural sample alone can prove, since a future edit could add a silent branch no existing fixture reaches.
- One real gap found and fixed while building Task 3's fixtures (see Deviations): the `${eventType} carried no usable composite path` warn did not name the job id, unlike every sibling line on the same path.

## Task Commits

1. **Task 1: Sequences C and E, and the copy-suffix composite** - `edc0ac7` (test)
2. **Task 2: Three doors, one gate — idempotency and the late-arrival guarantee** - `86d0170` (test)
3. **Task 3: No silent branch — every ignore path proved to log exactly once** - `147101e` (test — includes one Rule-2 fix in `src/queue/queueService.ts`, documented below)

No separate plan-metadata commit — `.planning/` is not under version control in this project (`mirror-request` is the only git repository), so `SUMMARY.md`/`STATE.md`/`ROADMAP.md` are written to disk but not committed, matching 11-01/11-02/11-03's own precedent.

## Files Created/Modified

- `mirror-request/test/queue-retake-anchor.test.ts` — extended (not rewritten): `buildStore()` parameterized, backward-compatible with 11-01's own bare call; sequences C and E, the stem-comparison pair, and the no-usable-composite-path absence check added as new `describe` blocks (12 tests total, was 1)
- `mirror-request/test/queue-finalize-idempotency.test.ts` — **new**: the finalize gate's three-door idempotency and the late-arrival guarantee (8 tests)
- `mirror-request/test/queue-ignored-branches.test.ts` — **new**: every ignore branch's exactly-once log line, behaviourally and structurally (10 tests)
- `mirror-request/src/queue/queueService.ts` — one-line message fix: `onPrintComposite()`'s no-usable-composite-path warn now names the job id

## Decisions Made

See `key-decisions` in frontmatter. The most consequential one not already locked by `11-CONTEXT.md`: **sequence E's "booth idle" shape is built as bound-but-not-yet-acknowledged (`currentJobId` set, `attemptOpen: false`), not as a genuinely idle booth.** A truly idle booth (`currentJobId === undefined`) hits `onPrintComposite()`'s EARLIER `arrived with no job bound to the booth` guard before D11-03's own `no attempt open` check is ever reached — the two guards are ordered, and only one of them is reachable per event. The plan's own must-have text ("with the booth idle it logs that no attempt is open") is satisfied by the REAL production shape: the Agent's own stale `activeJobId` stamp (D-06) is always whichever job it most recently dispatched, so by the time a next guest is bound to the booth, a stray reprint's `jobId` matches that guest, not `undefined`. Modeling it any other way would have pinned a shape that cannot occur in production.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical Functionality] `processing_start`/`printing`'s no-usable-composite-path warn did not name the job id**

- **Found during:** Task 3, while writing the behavioural fixture for this exact branch
- **Issue:** `queueLogger.warn(\`${eventType} carried no usable composite path\`)` — every other warn/info line on the print path names the job id (or `'unknown'`), including the very next branch in the same method (`${eventType} for job ${jobId ?? 'unknown'} arrived with no job bound to the booth`). This one did not, which is a real diagnosability gap: an operator grepping a job id would silently miss this line. This is NOT one of D11-03's two literal-wording-locked lines (`printing ignored: no attempt open` / `printing ignored: composite X is not this attempt's Y`, which `11-CONTEXT.md` specifies verbatim and were deliberately left unchanged) — there was no locked text constraining this one.
- **Fix:** Changed the message to `\`${eventType} for job ${jobId ?? 'unknown'} carried no usable composite path\``, matching the sibling line's own established convention. `jobId` was already in scope as the method's own parameter.
- **Files modified:** `mirror-request/src/queue/queueService.ts`
- **Verification:** `test/queue-ignored-branches.test.ts`'s dedicated case for this branch asserts the exact new text and the presence of the job id; `test/queue-retake-anchor.test.ts`'s Task 1 assertions (already committed) only substring-match the unchanged suffix `"carried no usable composite path"`, confirmed still passing unmodified after this change.
- **Committed in:** `147101e` (Task 3's commit)

---

**Total deviations:** 1 auto-fixed (Rule 2 — missing diagnosability)
**Impact on plan:** Necessary for correctness of the diagnostic surface this whole plan exists to prove is non-silent; not locked by any D11-03 literal wording, so no conflict with a human decision. No scope creep — touched only the one branch this task's own fixture was pinning.

## Issues Encountered

None beyond the deviation above. Every other branch enumerated in Task 3's `<read_first>` was already correctly logged by 11-01 through 11-03 — the structural half's "every early return has a logger call in its own branch" assertion passed on its first run with zero further production changes, matching this plan's own framing: "test-only by design."

## Known Stubs

None. Every test drives real `QueueService` code through its real public/private surface (the private `finalizePendingPrint` reached via the same documented cast technique 11-02 already established); no mock renders a hardcoded empty value standing in for real behaviour.

## Threat Flags

None beyond what `11-04-PLAN.md`'s own `<threat_model>` already registered (T-11-16 through T-11-20, T-11-SC) — no new network endpoint, auth path, file-access pattern or schema change was introduced; this plan is test-only plus one diagnostic-message fix.

## User Setup Required

None — no external service configuration required. This plan touched only test files and one log-message string in `queueService.ts`.

## Next Phase Readiness

Every automated must-have this plan was scoped to discharge is now pinned: SC-2 (sequence E finalizes nothing, in both shapes) and the automated half of SC-5 (no unusable-composite warning on either layout; no silent branch, behaviourally and structurally) are both closed. The finalize gate's cross-door idempotency (D11-05) and the Phase 7 late-arrival guarantee's survival through the move of the send site (D-11/D11-04) are both proved directly against the gate, independent of whichever call sites happen to make a live race rare today.

**Ready for 11-05** — the phase's own closing checkpoint: the five-scenario live-booth gate in `11-CONTEXT.md`'s `<verification>` section, requiring a physical dslrBooth with auto-print OFF and a genuinely queued second guest. Every plan in this phase (11-01 through 11-04) has deferred this identically; nothing in this plan's own scope could discharge it. The suite is fully green: 87/87 files, 1041/1041 tests; `npm run typecheck` and `npm run build` both exit 0; `git status --porcelain` in `mirror-request` is empty.

## Self-Check: PASSED

Both new files (`test/queue-finalize-idempotency.test.ts`, `test/queue-ignored-branches.test.ts`) and both modified files (`test/queue-retake-anchor.test.ts`, `src/queue/queueService.ts`) exist on disk. All 3 task commit hashes (`edc0ac7`, `86d0170`, `147101e`) exist in `git log --oneline --all`. This `SUMMARY.md` itself exists at the expected path. `git status --porcelain` in `mirror-request` is empty. `npm test` reports 87/87 files, 1041/1041 tests passing. `npm run typecheck` and `npm run build` both exit 0.

---
*Phase: 11-retake-approval-anchor*
*Completed: 2026-08-18*
