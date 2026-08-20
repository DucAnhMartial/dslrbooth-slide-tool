---
phase: 08-cms-event-display
plan: 05
subsystem: ui
tags: [express, sqlite, better-sqlite3, server-rendered-html, cms, pagination, winston]

# Dependency graph
requires:
  - phase: 08-01
    provides: the `event_photo` table, the `listEventPhotos`/`countEventPhotos`/`deleteEventPhotos` projections, the CMS IP gate and the session boundary
  - phase: 08-02
    provides: `onFileUpload()`'s photo-history write, attributed through Phase 7's pending-print registry
  - phase: 08-03
    provides: the CMS event list, the typed destructive-confirmation pattern, the escaping helper
  - phase: 08-04
    provides: `page()`, `LOGOUT_FORM` and the ONE in-flight script, exported for reuse
provides:
  - "GET /cms/photos — the durable per-event photo history, 50 rows a page, newest first"
  - "GET /cms/photos/clear — the typed confirmation view for the one deletion path"
  - "POST /cms/api/photos/clear — the ONLY operator-invocable deletion of photo history"
  - "The G4 broken-thumbnail placeholder: a neutral tile, warning icon, visible Vietnamese label"
  - "A suite-level assertion that no timer, schedule or self-pruning identifier exists in the photo surface (D-11)"
affects: [08-06, verification, ship]

actuals:
  tokens: 15500
  tasks: 2
  commits: 5

tech-stack:
  added: []
  patterns:
    - "Sub-router as factory over a narrow store interface (CmsPhotoStore), mounted after requireSession()"
    - "Server-side pagination whose renderer only ever receives one page's slice"
    - "Designed-state placeholder for a media reference the far side may have dropped"
    - "A decision (D-11) asserted against the SOURCE, not only against behaviour"

key-files:
  created:
    - mirror-request/src/cms/cmsPhotoRoutes.ts
    - mirror-request/src/cms/cmsPhotoPages.ts
    - mirror-request/test/cms-photo-history.test.ts
  modified:
    - mirror-request/src/cms/cmsRouter.ts
    - mirror-request/src/cms/cmsEventPages.ts

key-decisions:
  - "The clear action is enforced by a server-side typed confirmation — the operator retypes the event name, exactly as event deletion already requires, so clearing the wrong wedding needs a mistake about its name rather than a mis-click."
  - "An unconfirmed clear returns the confirmation VIEW with a 400, not a bare JSON error: the operator is asked again rather than told no."
  - "A page past the end is never queried at all and renders a distinct 'Không còn ảnh ở trang này' block — the zero-photo copy would be a plain lie to an operator holding 120 photos."
  - "A stored photo URL outside http(s) or this service's own paths never becomes an `<img src>`; it renders the same G4 placeholder, and the row is always kept."
  - "The photo-history link was added to the event list row: a surface nobody can reach is the inverse of the 'control that changes nothing' failure this phase's plans warn about."

patterns-established:
  - "Pattern: the render bound and the query bound are the same constant (PHOTOS_PER_PAGE), so an unbounded DOM list is structurally impossible rather than merely avoided."
  - "Pattern: a locked decision gets a test that reads the source — the D-11 case fails if a future edit reintroduces setInterval/setTimeout/cron/autoDelete/pruneOldest/retention into the photo surface."
  - "Pattern: log assertions check argument COUNT as well as type — a template-string message with an object second argument passes a typeof check and still bypasses masking."

requirements-completed: [CMS-01, CMS-03, CMS-04]

coverage:
  - id: D1
    description: "A capture driven in through onFileUpload() appears in the operator's per-event history and is still there after the store is closed and reopened (durable across a restart)"
    requirement: CMS-03
    verification:
      - kind: integration
        ref: "mirror-request/test/cms-photo-history.test.ts#lists a photo driven in through onFileUpload(), with the guest name, the thumbnail and the capture time"
        status: pass
      - kind: integration
        ref: "mirror-request/test/cms-photo-history.test.ts#still lists the row after the store is closed and reopened against the same file (survives a restart)"
        status: pass
    human_judgment: false
  - id: D2
    description: "History is per event — one event's page never shows another's rows, on listing or on clearing"
    requirement: CMS-03
    verification:
      - kind: integration
        ref: "mirror-request/test/cms-photo-history.test.ts#lists only the requested event's rows when two events both hold photos"
        status: pass
      - kind: integration
        ref: "mirror-request/test/cms-photo-history.test.ts#clears exactly the confirmed event, reports the count, and leaves a second event untouched"
        status: pass
    human_judgment: false
  - id: D3
    description: "Pagination at 50 a page, newest first, with the page count rendered and no unbounded DOM list"
    requirement: CMS-03
    verification:
      - kind: integration
        ref: "mirror-request/test/cms-photo-history.test.ts#splits 120 rows into 50, 50 and 20, renders the page count, and leads with the newest capture"
        status: pass
      - kind: integration
        ref: "mirror-request/test/cms-photo-history.test.ts#treats a nonsense page parameter as page one rather than failing or querying with NaN"
        status: pass
    human_judgment: false
  - id: D4
    description: "The zero-photo state is the authored UI-SPEC copy with no table element at all"
    requirement: CMS-01
    verification:
      - kind: integration
        ref: "mirror-request/test/cms-photo-history.test.ts#renders the UI-SPEC empty copy and no table at all when the event has no photos"
        status: pass
    human_judgment: false
  - id: D5
    description: "Photo history is deleted ONLY by a confirmed operator action — no expiry, no row cap, no scheduled cleanup anywhere in the surface"
    requirement: CMS-03
    verification:
      - kind: integration
        ref: "mirror-request/test/cms-photo-history.test.ts#renders the confirmation view and deletes NOTHING when the clear action arrives unconfirmed"
        status: pass
      - kind: unit
        ref: "mirror-request/test/cms-photo-history.test.ts#has no timer, no schedule and no self-pruning identifier anywhere in the photo surface (D-11)"
        status: pass
      - kind: integration
        ref: "mirror-request/test/cms-photo-history.test.ts#never trims history as a side effect of reading it — 500 rows survive being listed"
        status: pass
    human_judgment: false
  - id: D6
    description: "Both CMS-04 layers refuse the photo page and the clear action independently, and a whitelisted operator with a session is served"
    requirement: CMS-04
    verification:
      - kind: integration
        ref: "mirror-request/test/cms-photo-history.test.ts#refuses a non-whitelisted IP with 403 on both the page and the clear action"
        status: pass
      - kind: integration
        ref: "mirror-request/test/cms-photo-history.test.ts#refuses a whitelisted IP with no session, separately from the IP layer"
        status: pass
      - kind: integration
        ref: "mirror-request/test/cms-photo-history.test.ts#serves the page to a whitelisted operator WITH a session — the refusals above are not vacuous"
        status: pass
    human_judgment: false
  - id: D7
    description: "Guest names reach the log only through the masking formatters, as single string arguments"
    requirement: CMS-04
    verification:
      - kind: integration
        ref: "mirror-request/test/cms-photo-history.test.ts#records only string arguments, and nothing phone-shaped survives the masking formatter"
        status: pass
      - kind: integration
        ref: "mirror-request/test/cms-photo-history.test.ts#logs exactly one line per clear, carrying the event id and the count and no guest name"
        status: pass
    human_judgment: false
  - id: D8
    description: "A thumbnail that fails to load renders the G4 placeholder tile — neutral, warning icon, visible Vietnamese label — and never the browser's broken-image glyph"
    requirement: CMS-01
    verification:
      - kind: integration
        ref: "mirror-request/test/cms-photo-history.test.ts#ships the placeholder tile, its warning icon and its visible Vietnamese label with every row"
        status: pass
      - kind: integration
        ref: "mirror-request/test/cms-photo-history.test.ts#renders the placeholder server-side for a URL no browser should be asked to load, and KEEPS the row"
        status: pass
    human_judgment: true
    rationale: "The server-rendered markup and the swap handler are proven by tests, but 'a neutral tile that reads as a designed state rather than an error' is a visual judgment — only a human looking at the page in a browser can confirm the tile looks deliberate at the CMS type scale, and that no broken-image glyph flashes before the swap on a slow connection."

# Metrics
duration: 15min
completed: 2026-08-12
status: complete
---

# Phase 8 Plan 05: CMS Photo History Summary

**The operator's durable per-event photo history — 50 a page, newest first, with a graceful placeholder for images the far side has dropped — and exactly one way to delete it: by hand, with the event's name retyped and checked on the server.**

## Performance

- **Duration:** 15 min
- **Started:** 2026-08-12T18:07:31Z
- **Completed:** 2026-08-12T18:21:42Z
- **Tasks:** 2 of 2
- **Files modified:** 5 (3 created, 2 modified)

## Accomplishments

- **CMS-03's durability claim proved end to end.** A photo driven in the way production writes one — a registration, a queued job, an open pending-print slot, then the Agent's `file_upload` through `QueueService.onAgentEvent` — appears in the operator's history, and is still listed after the SQLite file is closed and reopened. That is the property `web-slide`'s 50-entry in-memory array could not have: the restart is a non-event because the row is a URL in a table.
- **The DOM is bounded even though the table deliberately is not.** `PHOTOS_PER_PAGE` is the query's `LIMIT` and the renderer's whole input, so `renderCmsPhotoHistoryPage` never sees more than one page and could not render an unbounded list if asked. 120 rows split 50/50/20 with the page count rendered; 500 rows page cleanly and are still 500 rows afterwards.
- **One deletion path, narrow and loud.** `POST /cms/api/photos/clear` requires the event's name retyped and compares it server-side; without it the confirmation view comes back and nothing is deleted. There is no expiry, no row cap and no scheduled cleanup — and that is now asserted against the source, not only against behaviour, so a future retention sweep fails the suite instead of quietly deleting a wedding.
- **A missing image is a designed state.** Every row ships the G4 placeholder tile — neutral, warning icon, visible Vietnamese label — revealed by a capture-phase `error` listener plus a post-`load` sweep for images that failed before the script ran. The row is never removed or hidden: a far side that dropped the file has not un-photographed the guest.
- **Both CMS-04 layers proved independently on this surface**, including a positive case so the two refusals cannot pass for the wrong reason, and the mount into `createCmsRouter` proved by that same positive case.

## Task Commits

1. **Task 1 (tracer, TDD): a real capture appears in the operator's history** — `79d321b` (test, RED) → `2b66d12` (feat, GREEN)
2. **Task 2 (TDD): deleting history is a deliberate act, a missing image is a designed state** — `4cf65f1` (test, RED) → `127f9f1` (feat, GREEN)
3. **Mutation-driven test hardening** — `0ebe5b5` (test)

_No refactor commit: the GREEN implementations needed no clean-up pass._

## Files Created/Modified

- `mirror-request/src/cms/cmsPhotoRoutes.ts` — the three photo routes over a narrow `CmsPhotoStore` (no `recordEventPhoto`, no queue, no booth), the page-parameter clamp, and the D-11 constraint recorded above the clear route.
- `mirror-request/src/cms/cmsPhotoPages.ts` — the history page, the pager, the G4 placeholder and its swap script, the typed clear-confirmation view, and the UI-SPEC copy constants.
- `mirror-request/test/cms-photo-history.test.ts` — 23 cases: durability, isolation, pagination, both gate layers, the confirmation, the placeholder, the logging discipline, and the source-level D-11 guard.
- `mirror-request/src/cms/cmsRouter.ts` — mounts the photo routes fifth, after `requireSession()`; the store parameter widened to `& CmsPhotoStore`.
- `mirror-request/src/cms/cmsEventPages.ts` — `WARNING_ICON` exported for reuse, and a `Lịch sử ảnh` link added to each event-list row.

## Decisions Made

1. **The typed confirmation is the event's name, checked server-side.** The UI-SPEC pins the confirmation *question*; it does not pin the token. Reusing 08-03's retype-the-event-name control makes the confirmation specific to one event, which a generic "yes" cannot be, and puts the check where a second tab or a replayed fetch still meets it.
2. **An unconfirmed clear renders the confirmation view with a 400.** The plan asked for exactly this; it also means the mismatch path costs the operator a retype and never a row.
3. **A page past the end is not the empty state.** Telling an operator with 120 photos "Chưa có ảnh nào" would be false. That case renders `Không còn ảnh ở trang này`, the true page count, and a `Trang 1` control. The UI-SPEC empty copy is reserved for a history that really is empty.
4. **The clear log names the event id and the count and nothing else** — not even the event name, which is operator-authored free text that may carry a couple's name.
5. **`/cms/photos` with no `?event=` falls back to the active event**, because mid-event the operator's question is about the wedding in front of them.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 — missing critical functionality] The photo-history page was unreachable from the CMS**

- **Found during:** Task 1
- **Issue:** The plan declared `files_modified` without `cmsEventPages.ts`, so nothing in the console linked to `/cms/photos`. A page reachable only by typing a URL is the inverse of the "a control that changes nothing" failure this phase's own plans warn about.
- **Fix:** Added a `Lịch sử ảnh` link to each event-list row and widened that row's grid to five columns.
- **Files modified:** `src/cms/cmsEventPages.ts`
- **Verification:** full suite green (no test asserted the old column count); the link target is exercised by this plan's cases.
- **Committed in:** `2b66d12`

**2. [Rule 2 — security] A stored photo URL was rendered into `<img src>` with no scheme restriction**

- **Found during:** Task 2
- **Issue:** The threat model names `stored photo URL → CMS <img src>` as a trust boundary but assigns it no mitigation. The URL arrives from the Agent's `file_upload` payload; escaping alone still puts `data:` and `javascript:` URLs into the operator's DOM.
- **Fix:** `isRenderableImageUrl()` accepts `http(s)` and this service's own root-relative paths and nothing else. A refused URL is not an error — it renders the same G4 placeholder a dead link renders, and the row is kept.
- **Files modified:** `src/cms/cmsPhotoPages.ts`
- **Verification:** `renders the placeholder server-side for a URL no browser should be asked to load, and KEEPS the row`, paired with `still renders an ordinary https thumbnail as an image` so the refusal is not a blanket one.
- **Committed in:** `127f9f1`

**3. [Rule 2 — robustness] `?page=` reached the SQLite bind parameter unvalidated**

- **Found during:** Task 1
- **Issue:** A non-numeric, negative or absurd (`1e999`) page would have produced `NaN`/`-Infinity`/an out-of-range offset in the query — a 500 available to anyone who can type in the URL bar.
- **Fix:** `parsePageParam()` accepts only a safe whole number ≥ 1 and falls back to page one; a page past the end is never queried at all.
- **Files modified:** `src/cms/cmsPhotoRoutes.ts`
- **Verification:** `treats a nonsense page parameter as page one rather than failing or querying with NaN`
- **Committed in:** `2b66d12`

**4. [Rule 1 — test defect found by mutation] The clear-log assertion checked argument type but not argument count**

- **Found during:** post-Task-2 mutation run
- **Issue:** A log line whose message stays a template string but gains an object second argument passes a `typeof call[0] === 'string'` check and still carries whatever that object holds past the winston masking formatters, which run on the message alone. Mutation M6b was green against the original assertion.
- **Fix:** the clear-log case now asserts `expect(lines[0]).toHaveLength(1)`.
- **Files modified:** `test/cms-photo-history.test.ts`
- **Verification:** M6b re-run — the case goes red.
- **Committed in:** `0ebe5b5`

---

**Total deviations:** 4 auto-fixed (3× Rule 2, 1× Rule 1). No Rule 4 architectural questions arose.
**Impact on plan:** All four are correctness, security or reachability requirements for what the plan asked for. No scope creep: two files outside the declared set were touched, both for one-line reuse/reachability changes described above.

## Conflicts Between Plan and Constraints

**None material.** Two points worth recording:

- The plan's behaviour bullet says a page beyond the end "renders the empty state rather than an error". Taken literally that would print the zero-photo copy over a history that is not empty. The constraint that copy must be true to the operator won; the out-of-range page renders an empty *result* with accurate copy and a way back. Documented as decision 3 above rather than followed to the letter.
- The plan's `<verify>` for Task 2 filters on `-t "clear"`; the G4 placeholder cases do not match that filter. Both the filtered run (9 passed) and the whole file (23 passed) were run.

## Non-Vacuity Mutations

Each applied, run, reverted. Every one went red on **exactly** the case believed to cover it — the check 08-01's finding demands.

| # | Mutation | Test that went red |
|---|----------|--------------------|
| M1 | list reads `events[0].id` instead of the resolved event | `lists only the requested event's rows when two events both hold photos` |
| M2 | `PHOTOS_PER_PAGE` 50 → 500 | the three pagination/no-trim cases |
| M3 | the typed-confirmation comparison always passes | `renders the confirmation view and deletes NOTHING when the clear action arrives unconfirmed` |
| M4 | the G4 placeholder tile is not rendered | both placeholder cases |
| M5 | the photo routes are not mounted into `cmsRouter` | `serves the page to a whitelisted operator WITH a session` |
| M6 | the clear line is logged object-form | `logs exactly one line per clear…` |
| M6b | the clear line keeps its string but gains an object second argument | `logs exactly one line per clear…` (only after the hardening in `0ebe5b5` — see deviation 4) |
| M7 | the photo routes are mounted ABOVE `requireSession()` | `refuses a whitelisted IP with no session, separately from the IP layer` |

## Deferred Items Reviewed

Both open CMS items in `deferred-items.md` were read and deliberately **left in place**:

- **D-2 — `renderCmsDashboardPage()` in `cmsPages.ts` is superseded and unused.** Not in this plan's scope. This plan only *imports* `escapeHtml` from that file; deleting a dead renderer and its styles is unrelated churn inside commits about photo history, and it needs its own verification that nothing else mounts it. Its sibling recommendation — promoting the shared chrome to an export — was already satisfied by 08-04 (`page()`, `LOGOUT_FORM`) and extended here (`WARNING_ICON`), so the duplicate token block in `cmsEventPages.ts` is the only part still outstanding. A follow-up that owns `cmsPages.ts` should take both.
- **D-3 — CMS-01's "ảnh chờ" shares `background_url`.** Squarely out of scope: it needs a new column, a new `EventConfig` field, a new room-screen render path and a new form control, landing together. Nothing in this plan touches the schema, `src/types.ts` or the display.

## Issues Encountered

The plan's Task 1 acceptance criteria put the logging case in the tracer task, but the only log-emitting path this surface has — the clear action — belongs to Task 2. Rather than pull deletion forward or let the case pass vacuously against zero captured calls, Task 1's logging case drives the one read that legitimately logs (a stale bookmark pointing at a deleted event, answered 404 with a masked warn), and Task 2 adds the clear-line case. Both assert the same discipline.

## Known Stubs

None. No placeholder data, no unwired control, no `TODO`/`FIXME`, no skipped test, and every `<verify>` in the plan was run.

## Threat Flags

None. No new endpoint, auth path, file access pattern or schema change beyond the three routes the plan specified; `event_photo`'s schema is unchanged, and `deleteEventPhotos` still has exactly two callers in the system — this confirmed operator action and 08-03's equally-confirmed event deletion.

## User Setup Required

None — no external service configuration, no new environment variable, no new npm package.

## Next Phase Readiness

- Suite: **55 files / 653 tests green** (baseline 54/630 — +1 file, +23 cases, nothing regressed). `npm run typecheck` and `npm run build` exit 0.
- `git diff --name-only 6e22ef1..HEAD -- src/queue src/agent src/display src/ingestion src/notifications` is empty: the FIFO queue, the Agent link, the room screen, ingestion and notifications are untouched, as D-01 requires.
- Open for 08-06: the only `setTimeout` anywhere in `src/cms/` is 08-04's browser-side 600 ms page reload in `cmsAgentPages.ts` — a UI reload, unrelated to any retention path. Verified, benign, recorded here so a future D-11 grep across `src/cms/` is not read as a violation.

## Self-Check: PASSED

All three created files, both modified files and all five commits verified present; the working tree is clean.

---
*Phase: 08-cms-event-display*
*Completed: 2026-08-12*
