---
phase: 09-slides-view
plan: 01
subsystem: ui
tags: [express, better-sqlite3, websocket, vietnamese-i18n, sqlite-migration]

# Dependency graph
requires:
  - phase: 08-cms-event-display
    provides: "the /display-screen route, DisplayServer.buildSnapshot(), EventConfig projection, and the PRAGMA table_info() + conditional ALTER TABLE migration idiom this plan extends"
provides:
  - "GET /display-screen?view=slides — a standalone, full-width, queue-free photo surface (renderSlidesPage())"
  - "event.show_guest_name / event.hero_enabled columns, both INTEGER NOT NULL DEFAULT 1"
  - "EventConfig.showGuestName / EventConfig.heroEnabled, on the wire in every DisplaySnapshot"
  - "both toggles honoured (hero takeover gate + guest-name element gate) on both renderDisplayPage() and renderSlidesPage()"
affects: [09-02-cms-toggle-form, 09-cms-screen-labels]

# Actuals (#2632)
actuals:
  tokens: 15934
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "View-variant-by-query-param, selected strictly inside the second handler of an already IP-gated route chain, never as a second mounted route"
    - "Standalone duplicate template-string page (slidesPage.ts) instead of shared partials, to keep a regression pin on the sibling page trivially true"
    - "Module-scope boolean flags (heroTakeoverEnabled, guestNameEnabled) re-derived every render() call and read by functions the render() call stack does not control (shotTile() called from a setInterval closure)"

key-files:
  created:
    - mirror-request/src/display/slidesPage.ts
    - mirror-request/test/display-slides-view.test.ts
    - mirror-request/test/display-default-view-regression.test.ts
    - mirror-request/test/local-store-event-toggles.test.ts
  modified:
    - mirror-request/src/types.ts
    - mirror-request/src/state/localStore.ts
    - mirror-request/src/app.ts
    - mirror-request/src/display/displayPage.ts

key-decisions:
  - "The slides screen's agent-connectivity indicator and eyebrow state label were dropped rather than carried forward — my own discretion, not directed by the plan, recorded because it narrows the surface beyond what D9-01's explicit list (aside, queue list, guest-count, announcing, capturing) named."
  - "The two module-scope flags are named heroTakeoverEnabled/guestNameEnabled (not heroEnabled/showGuestName) to avoid shadowing the identically-named EventConfig wire fields inside the same script scope — my own naming choice, not specified by the plan."
  - "The pre-phase event DDL used to seed the migration-idempotency test was reconstructed by hand from the Phase 8 commit at HEAD d375c16 (via `git show d375c16:src/state/localStore.ts`), not copied from a live production snapshot — this repo has no separate pre-phase fixture file."

requirements-completed: [UI-01, SC-1, SC-2, SC-4, SC-5]

coverage:
  - id: D1
    description: "/display-screen?view=slides serves a themed, self-hosted-font, reconnecting photo surface with no queue region and no queue metadata"
    requirement: SC-1
    verification:
      - kind: unit
        ref: "test/display-slides-view.test.ts > GET /display-screen?view=slides — serves the slides variant, byte for byte"
        status: pass
      - kind: unit
        ref: "test/display-slides-view.test.ts > Slides screen — carries no queue region and no queue metadata of any kind (SC-1, T-09-07)"
        status: pass
    human_judgment: true
    rationale: "Legibility and visual full-bleed correctness at real TV viewing distance is a human judgement call, explicitly deferred to plan 09-02's gate per this plan's <done> criterion and CONTEXT's UI-01 note; this plan proves structural/functional correctness only."
  - id: D2
    description: "Bare /display-screen renders exactly what it rendered before this phase — the D9-02 regression pin"
    requirement: SC-2
    verification:
      - kind: unit
        ref: "test/display-default-view-regression.test.ts > Default room screen — the D9-02 regression pin (bare /display-screen is unchanged)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Every unrecognized ?view= value (queue, empty, wrong case, trailing space, __proto__, repeated param) falls back to the default page byte-for-byte, never an error"
    requirement: SC-5
    verification:
      - kind: unit
        ref: "test/display-slides-view.test.ts > GET /display-screen — every unknown view value falls back to the default page (D9-03, SC-5)"
        status: pass
    human_judgment: false
  - id: D4
    description: "show_guest_name and hero_enabled land on event (additive, idempotent, lossless migration against a populated pre-phase table), EventConfig, and every DisplaySnapshot, both defaulting ON"
    requirement: SC-1
    verification:
      - kind: unit
        ref: "test/local-store-event-toggles.test.ts (all 4 cases)"
        status: pass
      - kind: unit
        ref: "test/display-slides-view.test.ts > Wire — the two new toggles reach a live WS client (D9-04)"
        status: pass
      - kind: unit
        ref: "test/display-default-view-regression.test.ts > maybeBroadcast() diff guard — the two new EventConfig fields cannot flood the venue (T-09-05, D-09)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Both toggles are honoured on both render paths: heroEnabled gates the just-captured takeover branch (photo still joins the slideshow rotation when off), showGuestName gates the name element on a photo tile"
    requirement: SC-4
    verification:
      - kind: unit
        ref: "test/display-slides-view.test.ts > Slides screen — D9-04, both toggles honoured (hero takeover + guest name)"
        status: pass
      - kind: unit
        ref: "test/display-default-view-regression.test.ts > Default room screen — D9-04, both toggles honoured (hero takeover + guest name)"
        status: pass
      - kind: unit
        ref: "test/display-slides-view.test.ts > Wire — both toggles, applied at the buildSnapshot() level (D9-04)"
        status: pass
    human_judgment: true
    rationale: "Whether the takeover visually does not appear, and whether the name visually does not render, on a real screen is judged by plan 09-02's human gate per this plan's own test comments; this plan proves the guard logic and the wire data only."
  - id: D6
    description: "The slides view's reconnect banner and growing backoff hold, and it never falls back to idle on a dropped WS (D-07)"
    requirement: SC-4
    verification:
      - kind: unit
        ref: "test/display-slides-view.test.ts > Slides screen — D-07, a dropped feed never blanks the wall"
        status: pass
    human_judgment: false

# Metrics
duration: 18min
completed: 2026-08-13
status: complete
---

# Phase 9 Plan 1: Slides-Only Screen View Summary

**`/display-screen?view=slides` (full-width photo surface, no queue) plus two per-event display toggles (show_guest_name, hero_enabled) wired through the event table, EventConfig, the wire, and both render paths — bare `/display-screen` proved byte-identical to its pre-phase output.**

## Performance

- **Duration:** ~18 min (05:48 → 06:06 UTC, by commit timestamps)
- **Started:** 2026-08-13T05:48:29Z (baseline commit d375c16)
- **Completed:** 2026-08-13T06:06:31Z
- **Tasks:** 3 (all `autonomous: true`, no checkpoints)
- **Files modified:** 8 (4 source, 1 new source, 3 new test files)

## Accomplishments
- `GET /display-screen?view=slides` serves `renderSlidesPage()`, a standalone, production-quality, full-width photo surface: same self-hosted fonts, same theming allow-list, same tile construction, same D-07 reconnect discipline as the default screen, with no queue region and no queue metadata anywhere in its markup.
- The route's variant selection lives strictly inside the existing IP-gated second handler in `app.ts` — a non-whitelisted peer gets the identical generic 403 for both URLs, and every unrecognized `?view=` value (`queue`, empty, wrong case, trailing space, `__proto__`, a repeated param that Express turns into an array) falls back to the default page byte-for-byte.
- `show_guest_name` and `hero_enabled` (`INTEGER NOT NULL DEFAULT 1`) were added to the `event` table via the repo's existing `PRAGMA table_info()` + conditional `ALTER TABLE ADD COLUMN` idiom — the first ALTER TABLE against this table since Phase 8 shipped it with zero — proved idempotent and lossless against a table rebuilt in its exact pre-phase shape and seeded with rows, not against a fresh one.
- Both fields ride the existing `EventConfig` projection (no new snapshot field), proved not to introduce any per-tick-varying value: four consecutive `buildSnapshot()` evaluations with nothing changed still serialise identically, and a single toggle write produces exactly one further distinct serialisation.
- Both toggles are honoured identically on both screens: `heroEnabled` gates the just-captured takeover branch of the stage-precedence chain (order unchanged; the photo still lands in the slideshow rotation array when hero is off) and `showGuestName` gates the name element inside the shared tile builder. Both are re-derived from the snapshot on every `render()` call and compared against the literal `false`, never truthiness, so a snapshot missing the fields entirely (a rolling-deploy edge case) still reads as ON.

## Task Commits

Each task was committed atomically:

1. **Task 1: One path end to end — the two columns reach the wire, and `?view=slides` renders from them** — `5ee7534` (feat)
2. **Task 2: The regression pins — the live screen, the live database, and the diff guard** — `b9784ac` (test)
3. **Task 3: Both toggles honoured on both views** — `979838a` (feat)

_No SUMMARY/STATE/ROADMAP metadata commit was made — per this run's explicit instructions, STATE.md is the orchestrator's file and was not touched; `.planning/` sits outside this repository and was never `git add`ed._

## Files Created/Modified
- `mirror-request/src/display/slidesPage.ts` (new) - `renderSlidesPage()`, the argument-free slides-only template: 4 self-hosted `@font-face` rules, the same 5-colour-plus-font `applyEventConfig()` allow-list, `photoFrame`/`shotTile`/`getInitials`, the 3-state stage precedence (hero → slideshow → idle), the D-07 reconnect banner and growing backoff. `data-view="slides"` on `<body>`.
- `mirror-request/src/state/localStore.ts` - `show_guest_name`/`hero_enabled` in the `event` CREATE TABLE and in `migrate()`'s conditional `PRAGMA table_info('event')` guard; `EventRow`, `toEventConfig()` (null-coalescing to the shipped default, 0 to `false`), `DEFAULT_EVENT_CONFIG`, `EVENT_UPDATABLE_COLUMNS` all extended.
- `mirror-request/src/types.ts` - `EventConfig.showGuestName`/`EventConfig.heroEnabled`, both `boolean`.
- `mirror-request/src/app.ts` - the `view` branch inside `/display-screen`'s existing second handler, below the IP gate; strict equality against the single literal `'slides'`, guarded by `typeof`.
- `mirror-request/src/display/displayPage.ts` - exactly two guards added (module-scope `heroTakeoverEnabled`/`guestNameEnabled`, derived in `render()`, read by the stage-precedence `if` and by `shotTile()`'s name-element block) and nothing else in this file.
- `mirror-request/test/display-slides-view.test.ts` (new) - end-to-end route/variant/wire/guard proof (26 cases across Tasks 1 and 3).
- `mirror-request/test/display-default-view-regression.test.ts` (new) - the D9-02 pin, the diff-guard proof, and the default-page half of the Task 3 toggle-guard proof (10 cases across Tasks 2 and 3).
- `mirror-request/test/local-store-event-toggles.test.ts` (new) - the migration idempotency/lossless-ness proof against a pre-phase-shaped, seeded `event` table (4 cases).

## Decisions Made
- **The slides screen carries no agent-connectivity indicator and no eyebrow booth-state label.** The plan's explicit list of what to drop (aside, queue list, guest-count line, announcing state, capturing state) did not name these two elements, and I dropped them anyway on my own judgement — they reflect booth/queue status rather than the photo surface itself, and the slides screen's 3-state precedence (hero/slideshow/idle) never exercises the ANNOUNCING/BUSY booth states the eyebrow label would otherwise describe. No human approved this narrowing; it is my own reading of "the photo surface alone." If this is wrong, plan 09-02's human gate is the place to catch it and I would restore a minimal status indicator.
- **The two toggle-derived flags in both page scripts are named `heroTakeoverEnabled`/`guestNameEnabled`, not `heroEnabled`/`showGuestName`.** Purely my own naming choice to avoid a variable shadowing the identically-spelled fields already present on the `data.eventConfig` object passed into `render()` in the same function scope. No behavioral significance; recorded because it's a naming decision the plan didn't specify.
- **The pre-phase `event` table DDL used in `test/local-store-event-toggles.test.ts` and `test/display-slides-view.test.ts`'s NULL-projection case was reconstructed by hand** via `git show d375c16:src/state/localStore.ts` rather than pulled from a separate fixture — this repo has no dedicated pre-phase schema fixture, so I read it directly off the baseline commit's source. No human reviewed this reconstruction; I verified it character-for-character against the baseline `CREATE TABLE event` block before using it.

## Deviations from Plan

None — the plan executed as written for all three tasks. The three decisions above are choices the plan left to discretion (explicitly, in the case of the QR-block precedent) or simply didn't specify; none of them contradict a locked D9-0x decision or a `<behavior>`/`<acceptance_criteria>` line, and none required a Rule 1–4 auto-fix.

## Issues Encountered
- **The BACKTICK trap, twice.** Both `displayPage.ts` and `slidesPage.ts` are single template literals, and their own header comments warn against backticks inside comments. I wrote a new comment containing a backtick around the word `false` in both files on the first pass, which broke the vitest/esbuild transform with `Expected ";" but found "false"`. Caught immediately by the first test run after the Task 3 edit; fixed by removing the backtick from both comments (`` `false` `` → "the literal false"). No functional code was affected — this was comment text only.
- **A false start on the mutation-proof step for Task 1's route logic.** I initially mutated `src/app.ts`'s comparison and expected `test/display-slides-view.test.ts` to go red, but that test reproduces the route chain inline (matching this repo's established `display-access-control.test.ts`/`display-idle-default.test.ts` idiom) rather than importing `app.ts`'s `createApp()`, so the mutation had no effect on it. I reverted `app.ts` and instead mutated the test file's own inline route-reproduction function to confirm the test's own assertions are load-bearing, then reverted that. No source code was affected by this false start.
- **A NOT NULL constraint correctly rejected my first NULL-projection test.** My first draft of "a column holding NULL projects to the shipped default" tried `UPDATE event SET show_guest_name = NULL ...` against the store's own schema, which threw `NOT NULL constraint failed` — correctly, since the column is `NOT NULL DEFAULT 1` by design. I rewrote the case to build a separate raw table with the two columns left nullable (the shape a hand-edited or pre-constraint row could actually carry) and seed a genuine NULL there, which is what `toEventConfig()`'s null-coalescing is actual defence-in-depth against.

## User Setup Required

None - no external service configuration required. The two new columns are added automatically the next time the running service restarts and `LocalStore`'s constructor calls `migrate()` — no manual step, no environment variable, no CMS action required for the toggles to exist and read as ON.

## Known Stubs

None. Every deliverable in this plan is a real, wired implementation: the slides page renders from real `EventConfig`/`DisplaySnapshot` data over the real WS feed, the migration runs against the real `LocalStore` constructor path, and both toggle guards read the real snapshot field on every render.

## Next Phase Readiness

- **Ready for plan 09-02 (wave 2, blocked by a human gate not touched in this run):** `EVENT_UPDATABLE_COLUMNS` already includes `show_guest_name`/`hero_enabled` with a comment noting the validator must never yield null; the CMS form task can write both columns immediately via the existing `updateEvent()` path. The CMS screen-address card (D9-06) can link `/display-screen?view=slides` as-is — the route is live and gated identically to the bare URL.
- **No blockers.** `npm test` is green at 66 files / 746 tests (baseline was 63 files / 706 tests: +3 files, +40 tests), `npm run typecheck` and `npm run build` both exit 0, and `git status --short` is clean on `mirror-request` after all three commits.
- **Deferred to plan 09-02's human gate, per this plan's own scope:** the visual/legibility half of D1 (full-bleed correctness at TV distance) and D5 (the takeover/name actually disappearing on screen) — both are structurally proven here (byte-identical markup, correct guard logic, correct wire data) but not visually judged, matching the plan's stated `<done>` criteria.

---
*Phase: 09-slides-view*
*Completed: 2026-08-13*

## Self-Check: PASSED

All 8 files created/modified by this plan verified present on disk; all 3 task commit hashes (`5ee7534`, `b9784ac`, `979838a`) verified present in `git log --oneline --all` inside `mirror-request`.
