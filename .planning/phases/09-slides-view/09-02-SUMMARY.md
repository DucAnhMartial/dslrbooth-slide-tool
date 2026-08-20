---
phase: 09-slides-view
plan: 02
subsystem: ui
tags: [express, better-sqlite3, websocket, vietnamese-i18n, cms]

# Dependency graph
requires:
  - phase: 09-slides-view
    provides: "plan 09-01's renderSlidesPage(), the show_guest_name/hero_enabled columns and EventConfig fields, EVENT_UPDATABLE_COLUMNS already including both columns"
provides:
  - "boolField validator (cmsEventRoutes.ts), registered for show_guest_name and hero_enabled — accepts only a real JSON boolean, maps to 1/0, never yields null"
  - "checkboxField control on /cms/events/:id — an operator can now tick/untick both toggles and save"
  - "SLIDES_SCREEN_URL_PATH, and the D9-06 two-labeled-type screen-address card on /cms/events"
  - "slidesPage.ts design pass: name-over-scrim, centred single-column idle state, fault-only Agent-offline signal"
  - "a cross-page invariant test block (fonts, config-applier property set, banner copy, backoff) pinning drift between slidesPage.ts and displayPage.ts"
  - "OPS-RUNBOOK.md §13"
affects: []

# Actuals (#2632)
actuals:
  tokens: 12662
  tasks: 2
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Checkbox controls in the CMS event form read `input.checked` in a dedicated branch of collect(), ordered before the generic .value-reading branches — the same pattern any future boolean CMS-01 field should follow"
    - "Slides-page design changes append derived DOM (the name scrim) INSIDE an already-built element (the frame) returned by a lower-level builder, rather than restructuring the builder's own signature — keeps existing regex-based structural tests (e.g. the shotTile()/guestNameEnabled pin from 09-01) valid across a visual redesign"
    - "CSS class toggling (idle-compose) rather than a second template branch, to compose one element differently across render() states without duplicating markup"

key-files:
  created:
    - mirror-request/test/cms-event-toggles.test.ts
  modified:
    - mirror-request/src/cms/cmsEventPages.ts
    - mirror-request/src/cms/cmsEventRoutes.ts
    - mirror-request/src/display/slidesPage.ts
    - mirror-request/test/display-slides-view.test.ts
    - mirror-request/docs/OPS-RUNBOOK.md

key-decisions:
  - "The name-over-scrim's colours (white text, black-to-transparent gradient) are fixed and NOT themed via var(--event-*) — my own design call, not directed by the plan's <action> text beyond \"scrim gradient\". Reasoned as a legibility requirement: an event's branding must not be able to pick a scrim/text combination that makes the guest's own name unreadable over their own photo. No human reviewed this specific choice; CONTEXT's D9-04/D-16-style precedent (operational and legibility-critical elements are fixed, not themeable) is the closest existing decision it follows, but that precedent was written about connectivity/error colours, not this element, so I am recording this as my own extension of it rather than implying it was already decided."
  - "The outer margin for the slides page dropped from 4.5vw (inherited from wave 1's copy of the two-column layout) to 3vw. The plan's <behavior> asked for a reduced margin without specifying a value; 3vw is my own choice, reasoned from '4.5vw exists to separate two columns, and there is no second column here' — not measured against a real screen, since no screen was available to this run."
  - "The Agent-offline corner signal's exact position (bottom-right, fixed pixel offsets, a rounded pill) and its exact Vietnamese copy ('● Agent mất kết nối', reusing the default page's own status-line string verbatim) are my own choices. The plan's <action> specified the constraints (fault-only, fixed destructive colour, never var(--event-*)) but not the visual treatment."
  - "OPS-RUNBOOK §12's existing route-inventory row for /display-screen was edited (one line) to mention the ?view=slides variant, beyond what Task 2's file list strictly required (only docs/OPS-RUNBOOK.md was listed as modified, without specifying which sections). I judged the pre-existing row ('One URL for every TV') would otherwise read as inaccurate once §13 exists, and the repository's own stated discipline treats an unverified/inconsistent runbook claim as a defect. No human reviewed this edit specifically; it is a one-line factual correction, not a rewrite of §12's substance."

requirements-completed: []

# Coverage metadata — Task 3 (the blocking human gate) has not run; every
# deliverable below is proven structurally/functionally by the automated
# suite, but UI-01's real test (legibility at guest distance) and the
# physical-TV half of SC-2/SC-3/SC-4 remain for the human gate. Per the
# plan's own <done> criteria this was never claimed to be settled here.
coverage:
  - id: D1
    description: "An operator ticks/unticks show_guest_name or hero_enabled on /cms/events/:id, saves, and the value round-trips (form re-renders the new state) and reaches a live WS /display snapshot with no reload (SC-3)"
    requirement: "SC-3"
    verification:
      - kind: unit
        ref: "test/cms-event-toggles.test.ts > CMS event save — a toggle reaches a live WS /display snapshot with no reload (SC-3) (both cases)"
        status: pass
      - kind: unit
        ref: "test/cms-event-toggles.test.ts > CMS event form — the two toggles render as checkboxes reflecting the stored value (all 4 cases)"
        status: pass
    human_judgment: false
  - id: D2
    description: "A save carrying a non-boolean value for either toggle (string, number, null) is refused whole, with the standard save-error body, writing nothing"
    verification:
      - kind: unit
        ref: "test/cms-event-toggles.test.ts > CMS event save — a bad value for either toggle refuses the WHOLE patch (10 cases)"
        status: pass
    human_judgment: false
  - id: D3
    description: "The CMS event-list page's fixed screen-address card presents two labeled screen types (D9-06) and the D-12 invariant (count does not grow with the event list) still holds with the added slides URL"
    verification:
      - kind: unit
        ref: "test/cms-event-toggles.test.ts > CMS event list — the fixed screen-address card presents two labeled screen types (D9-06) (3 cases)"
        status: pass
      - kind: unit
        ref: "test/cms-active-event-switch.test.ts > CMS-02: one switch updates every connected screen > surfaces ONE copyable screen URL, the same fixed path for every event (D-12)"
        status: pass
    human_judgment: false
  - id: D4
    description: "The slides page's photo surface is contained (never cropped) with the guest's name drawn over it against a scrim, keeping the shrink-to-fit rule; the idle state composes as a centred single column; a fault-only Agent-offline signal renders in the fixed destructive colour"
    verification:
      - kind: unit
        ref: "test/display-slides-view.test.ts > Slides screen — the design pass (UI-01, SC-1) (all 6 cases)"
        status: pass
    human_judgment: true
    rationale: "Whether the photo surface actually READS as legible and well-composed at real TV viewing distance — the plan's own stated purpose for Task 3 — is a judgement no automated check in this repository can make. This deliverable is structurally proven (the scrim/containment/centering rules exist and are wired) but not visually judged; that judgement is exactly what Task 3's blocking checkpoint exists for and has not yet run."
  - id: D5
    description: "displayPage.ts and slidesPage.ts cannot drift on the four font files, the config applier's --event-*-only property set, the reconnect banner copy, the growing backoff, or the absence of any CDN/external stylesheet link"
    verification:
      - kind: unit
        ref: "test/display-slides-view.test.ts > Cross-page invariant — the two screens cannot drift on what they must never disagree on (all 4 cases)"
        status: pass
    human_judgment: false
  - id: D6
    description: "OPS-RUNBOOK.md §13 documents both screen URLs, the unknown-view fallback, both toggles with their both-views scope, and the no-screen-identity reminder, with every quoted route/string verified against src/"
    verification:
      - kind: other
        ref: "grep -c 'view=slides' docs/OPS-RUNBOOK.md (returns 3, > 0); manual grep of every quoted route/env-var/setting name against src/ during this run — see below"
        status: pass
    human_judgment: false
  - id: D7
    description: "The slides view is legible at real TV viewing distance, the bare /display-screen route is confirmed unchanged by a human looking at a real television, and a live toggle change reaching a real screen is observed"
    requirement: "UI-01"
    verification: []
    human_judgment: true
    rationale: "This is Task 3 itself — the blocking checkpoint.human-verify gate. It has not run in this session; no human has verified any of it. This SUMMARY documents that the gate is pending, not passed."

# Metrics
duration: ~35min (Tasks 1-2 only; Task 3 not run)
completed: 2026-08-13
status: halted
---

# Phase 9 Plan 2: The Toggle Controls, the Slides Design Pass, and OPS-RUNBOOK §13 Summary

**Both per-event display toggles are now real checkboxes on the CMS event form (with a whole-patch-refusing boolean validator), the CMS event-list page shows both screen URLs as two labeled types, the slides view got its UI-01 design pass (name-over-scrim, centred idle, fault-only Agent signal), a cross-page invariant test now pins drift between the two screen templates, and OPS-RUNBOOK §13 documents all of it — Task 3's blocking human-verification gate has NOT run.**

## Performance

- **Duration:** ~35 min for Tasks 1-2 (Task 3 not attempted — no human was available to this run)
- **Tasks:** 2 of 3 completed (Task 3 is `type="checkpoint:human-verify" gate="blocking"` and was correctly left unresolved)
- **Files modified:** 6 (5 modified, 1 new test file)

## Accomplishments

- **`boolField` validator** (`cmsEventRoutes.ts`): accepts only a real JSON boolean and maps it to `1`/`0`, refusing (never coercing) a string, a number, or `null`, and — critically — never yielding `null` itself, since `show_guest_name`/`hero_enabled` are `INTEGER NOT NULL` and `updateEvent()` maps `patch[column] ?? null`. Registered in `FIELD_VALIDATORS` for both columns.
- **Two real checkboxes on `/cms/events/:id`** (`cmsEventPages.ts`): a `checkboxField` builder, a scoped `.checkbox-row` style block (the shared `label{display:block}`/44px-minimum rules are for text inputs and would otherwise stretch a checkbox), Vietnamese copy stating both toggles affect BOTH screens, and — the one edit the plan called out as load-bearing — a checkbox branch in `collect()` that reads `input.checked`, placed before the number branch, because a checkbox's `.value` is a constant string regardless of ticked state.
- **D9-06 on the event-list page**: a new `SLIDES_SCREEN_URL_PATH` constant (`${SCREEN_URL_PATH}?view=slides`), and the SAME fixed screen-address card now shows both URLs labeled "Loại 1 — Thứ tự + slide" and "Loại 2 — Chỉ slide" — never a per-event row, so the D-12 occurrence-count invariant still holds (proven by extending, not weakening, the existing D-12 test's assertion set).
- **The slides surface's design pass** (`slidesPage.ts`): the guest's name now draws INSIDE the photo frame, over a fixed dark scrim gradient, instead of as a sibling block below it; the fluid outer margin dropped from the two-column default's `4.5vw` to `3vw`; the idle state composes as a centred single column via a toggled `.idle-compose` class (applied server-side in the pre-snapshot backstop too); a fault-only Agent-offline corner signal renders only while `agentOnline` is explicitly `false`, in the fixed `#a33127` destructive colour, unreachable from `applyEventConfig()`.
- **A cross-page invariant test block** (`display-slides-view.test.ts`): asserts `displayPage.ts` and `slidesPage.ts` agree on the four font file paths, the exact set of `--event-*` custom properties their config appliers write, the reconnect banner copy, the growing backoff expression, and the absence of any external stylesheet/font host — the compensating control 09-01's summary flagged as owed for the deliberate two-template duplication.
- **OPS-RUNBOOK.md §13**: both URLs and what each renders, the unknown-`?view=` fallback, both toggles with their defaults and both-views scope, and the no-screen-identity reminder — every quoted route, env var, and column/setting name verified against `src/` by grep before committing (see Verification below). §12's route-inventory row for `/display-screen` was also updated to mention the new variant.

## Task Commits

Each task was committed atomically:

1. **Task 1: The two toggles become controls an operator can actually use** — `acdebc9` (feat)
2. **Task 2: The slides surface at viewing distance, the cross-page invariants, and the runbook** — `1ed44cb` (feat)
3. **Task 3: The slides view on a real television, at guest distance** — NOT RUN. `type="checkpoint:human-verify" gate="blocking"`. Per this run's explicit instructions, no human was available; the checkpoint was returned to the orchestrator unanswered rather than performed, simulated, or marked done.

_No plan-metadata commit was made — per this run's explicit instructions, STATE.md is the orchestrator's file and was not touched; `.planning/` sits outside the `mirror-request` git repository and is never `git add`ed._

## Files Created/Modified

- `mirror-request/src/cms/cmsEventRoutes.ts` — `boolField`, registered for `show_guest_name`/`hero_enabled` in `FIELD_VALIDATORS`.
- `mirror-request/src/cms/cmsEventPages.ts` — `checkboxField`, `CHECKBOX_STYLES`, both toggles rendered in the slideshow section, the `collect()` checkbox branch, `SLIDES_SCREEN_URL_PATH`, and the two-labeled-type screen-address card + generalized `bindCopy()` script.
- `mirror-request/src/display/slidesPage.ts` — the design pass: `.scrim`/name-over-photo, `.hero.idle-compose`, `#agentOffline` element + CSS + guard, reduced outer margin.
- `mirror-request/test/cms-event-toggles.test.ts` (new) — 26 cases: form rendering both directions, save round-trip both directions, whole-patch refusal (10 table-driven cases), the live-WS-snapshot round trip (SC-3), the `collect()` checkbox-branch assertion, and the D9-06/D-12 screen-address-card assertions. Two mutation-proof passes were run and reverted (removing the `collect()` checkbox branch; loosening `boolField` to accept a string) — both caught by this file's own assertions, confirming non-vacuity.
- `mirror-request/test/display-slides-view.test.ts` — extended with the cross-page invariant block (4 cases) and the design-pass block (6 cases): 26 → 37 cases in this file.
- `mirror-request/docs/OPS-RUNBOOK.md` — new §13, and one line in §12's route-inventory table.

## Decisions Made

See `key-decisions` in the frontmatter for the four decisions made without human review during this run: the scrim's fixed (non-themed) colours, the 3vw margin value, the Agent-offline signal's visual treatment, and the one-line §12 route-inventory edit beyond the plan's literal file-list scope. None of these contradict a locked D9-0x decision; all are discretion the plan either explicitly left open or did not specify to this level of detail.

## Deviations from Plan

None that changed scope or contradicted a `<behavior>`/`<acceptance_criteria>` line. The four items above are discretion calls, not deviations from what the plan asked for.

## Issues Encountered

- **A single-quote apostrophe inside a `describe()` string broke esbuild's transform** on the first draft of `cms-event-toggles.test.ts` ("this file's harness" inside a single-quoted string). Caught immediately by the first test run; fixed by rewording the string to avoid the apostrophe.
- **The first D-12 "slides URL appears exactly once" assertion was wrong.** The slides URL legitimately appears twice in the rendered event-list page — once in the `<code>` element and once inside the copy button's script literal (`JSON.stringify(SLIDES_SCREEN_URL_PATH)`). Rewrote the assertion to check the count is identical between a one-event and a two-event page (the actual load-bearing D-12 property), not a fixed literal count.

## User Setup Required

None — no external service configuration required. The two toggle columns already exist on disk from 09-01's migration; this plan only added a way to write them from the browser and a design pass to two already-shipped page templates.

## Known Stubs

None. Every deliverable is a real, wired implementation: the checkbox controls write through the real validator to the real `updateEvent()` path, the slides page's design elements are rendered by the same `render()`/`shotTile()` functions the wire actually drives, and OPS-RUNBOOK §13's claims are grep-verified against the real source rather than asserted from memory.

## Next Phase Readiness

- **This plan does not resolve on its own.** Task 3 is `gate="blocking"` and is the phase's stated last word: nothing in this repository can settle UI-01's real claim (legibility at guest distance) except a human standing in the room. The orchestrator should re-spawn a continuation agent once a human is available to perform Task 3's five verification steps, using the completed-tasks table in the checkpoint return.
- **Baseline at the start of this run:** HEAD `979838a`, working tree clean, `npm test` = 66 files / 746 tests, typecheck/build clean.
- **State at the end of this run:** HEAD `1ed44cb`, working tree clean, `npm test` = 67 files / 783 tests (+1 file, +37 tests over baseline), `npm run typecheck && npm run build` both exit 0. No change to `package.json` or any lockfile in either commit.
- **No blockers for Task 3 beyond needing a human at a real TV.** Both `/display-screen` and `/display-screen?view=slides` are live routes today; the two toggles are now editable from the CMS form Task 3 asks the human to use in step 4.

---
*Phase: 09-slides-view*
*Completed: 2026-08-13 (Tasks 1-2 only — Task 3 pending)*

## Self-Check: PASSED

All 6 files created/modified by this plan verified present on disk; both task commit hashes (`acdebc9`, `1ed44cb`) verified present in `git log --oneline --all` inside `mirror-request`. Task 3 was not performed and is not claimed as done anywhere above.
