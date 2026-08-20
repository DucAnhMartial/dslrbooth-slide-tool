# Phase 8 — Deferred Items

Out-of-scope discoveries logged during execution. Not fixed, per the
scope-boundary rule (only auto-fix issues directly caused by the current
task's changes).

## D-1: malformed CSS declaration in `displayPage.ts` (pre-existing)

**Found during:** plan 08-01 Task 1, while editing `src/display/displayPage.ts`.

**File:** `mirror-request/src/display/displayPage.ts`, the `aside h2` rule.

**Issue:** the declaration reads `margin:0 0:2.5rem` — a stray colon where a
space belongs. The browser discards the whole declaration as invalid, so the
sidebar heading currently has no bottom margin. Introduced before Phase 8;
`git blame` places it in the original Phase 5 page, not in this plan's edits.

**Why not fixed here:** pre-existing, in a rule this plan does not otherwise
touch, and purely cosmetic. Plan **08-02** rebuilds this page's layout in
full (hero moment, slideshow, reconnect banner), so the fix belongs there
rather than as an unrelated one-character change inside a security-and-schema
commit.

**Action for 08-02:** correct to `margin:0 0 2.5rem` as part of the room-screen
rebuild, or drop the rule if the sidebar heading is restyled anyway.

## D-2: `renderCmsDashboardPage()` in `cmsPages.ts` is superseded and now unused

**Found during:** plan 08-03 Task 2.

**File:** `mirror-request/src/cms/cmsPages.ts`.

**Issue:** plan 08-03 replaces the 08-01 tracer dashboard with
`renderCmsEventListPage()` in `cmsEventPages.ts`, and repoints both `GET /cms/`
and `GET /cms/events` at it. `renderCmsDashboardPage()` is now exported but
called from nowhere. It also advertises `maxlength="80"` for the event name,
which contradicts this plan's recorded 60-character cap — harmless while it is
unreachable, misleading if it is ever remounted.

**Why not fixed here:** `cmsPages.ts` is outside plan 08-03's declared
`files_modified`, and plan 08-02 was executing in the same working tree at the
same time. Deleting a function from a shared file under concurrent execution is
exactly the kind of edit that silently loses a sibling's work.

**Action:** delete `renderCmsDashboardPage()` and the now-dead dashboard styles
in a follow-up that owns `cmsPages.ts`. Also worth promoting `CMS_STYLES` to an
export at that point — `cmsEventPages.ts` currently duplicates the token block
for the same file-boundary reason.

## D-3: CMS-01's "ảnh chờ" shares a column with "nền"

**Found during:** plan 08-03 Task 2.

**Issue:** REQUIREMENTS CMS-01 lists `nền` (background) and `ảnh chờ` (idle
image) as separate configurable properties. The Phase 8 schema, fixed by plan
08-01 and already committed, has one image column for both — `background_url` —
and `EventConfig` projects exactly that. The form therefore ships a single
control labelled `Ảnh nền / ảnh chờ`.

**Why not split here:** a separate `idle_image_url` would need a new column, a
new field on `EventConfig` in `src/types.ts`, and a new render path in
`src/display/displayPage.ts`. Both of those files belonged to plan 08-02, which
was executing concurrently. Shipping the column WITHOUT the projection and the
render path would have produced a control that changes nothing on any screen —
the precise failure this plan's own `key_links` warns about.

**Action:** if the operator wants a distinct idle backdrop, add
`idle_image_url` to the `event` table, to `EventConfig`, to the room screen's
idle state, and to this form — as one change, in one plan, so the field and its
effect land together.
