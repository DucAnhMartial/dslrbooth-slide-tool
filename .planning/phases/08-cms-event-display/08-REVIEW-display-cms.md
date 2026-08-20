---
phase: 08-cms-event-display
reviewed: 2026-08-13T00:00:00Z
depth: standard
files_reviewed: 17
files_reviewed_list:
  - mirror-request/src/display/displayServer.ts
  - mirror-request/src/display/displayPage.ts
  - mirror-request/src/app.ts
  - mirror-request/src/index.ts
  - mirror-request/src/cms/cmsPages.ts
  - mirror-request/src/cms/cmsEventPages.ts
  - mirror-request/src/cms/cmsEventRoutes.ts
  - mirror-request/src/cms/cmsPhotoPages.ts
  - mirror-request/src/cms/cmsPhotoRoutes.ts
  - mirror-request/test/display-room-screen.test.ts
  - mirror-request/test/display-hero-moment.test.ts
  - mirror-request/test/display-idle-default.test.ts
  - mirror-request/test/cms-event-config.test.ts
  - mirror-request/test/cms-active-event-switch.test.ts
  - mirror-request/test/cms-photo-history.test.ts
  - mirror-request/test/cms-event-tracer.test.ts
  - mirror-request/test/phase8-cutover-readiness.test.ts
  - mirror-request/test/phase5-display.test.ts
findings:
  critical: 0
  warning: 1
  info: 3
  total: 4
status: issues_found
---

# Phase 08: Code Review Report — Room Screen & CMS Page/Route Surface

**Reviewed:** 2026-08-13T00:00:00Z
**Depth:** standard (with targeted cross-file tracing on the eight hunted risk areas)
**Files Reviewed:** 17 (9 source, 8 test)
**Status:** issues_found (no blockers; one warning, three info items)

## Summary

I traced each of the eight adversarial hunt areas by hand against both the implementation and the store/queue methods it calls, rather than trusting the file headers' own claims:

1. **Broadcast diff loop (`justCaptured`)** — verified correct. `buildSnapshot()` derives `justCaptured` purely from `Date.now() - recentPhoto.capturedAt < heroMomentDurationMs` on every evaluation; the object is recomputed but re-serializes byte-identically on every tick inside the window (confirmed by the `serialises identically on repeated evaluations` test and by re-reading `maybeBroadcast()`'s `msg === this.lastSent` guard). No countdown/remaining-ms field leaks into the object, so there is no broadcast flood, and there is no `setTimeout`-cleared field, so a mid-window restart cannot pin a stale hero photo. Two guests finishing inside one window is handled correctly: `getMostRecentEventPhoto()` always returns the row with the highest `captured_at`, so the second guest's capture atomically supersedes the first's hero moment on the very next poll tick (one extra broadcast, not a flood, and not a stuck state).
2. **D-07 fidelity** — verified correct. `ws.onclose` only sets the banner and schedules a growing-backoff reconnect; it never touches `hero.innerHTML`, `queue.innerHTML`, or calls `renderIdle`. `wss.on('connection', ...)` unconditionally pushes a full snapshot to every newly-accepted socket (including reconnects) before any poll tick, so there is no gap where a reconnected client is left rendering nothing. A reconnect's first snapshot legitimately reflects the current real state (which could be idle) — that is correct live behavior, not the blanking D-07 forbids, since the *stale* content is only ever replaced by *live* content, never by a synthetic default.
3. **XSS** — every operator/guest-authored string (`event.name`, `guestName`, `idleHeading`, etc.) that reaches an HTML sink server-side goes through `escapeHtml()`, including inside `title=` and other attribute contexts (which also escapes quotes). Client-side, guest/photo data is assigned via `textContent`/`.src` property, never concatenated into `innerHTML`. Asset and photo URLs are constrained to a `/uploads/<uuid>.<ext>` shape or a strict `https?://` regex that excludes quotes/angle-brackets before ever reaching an `<img src>` or a CSS custom property. One real gap found — see **WR-01** below.
4. **Font self-hosting** — confirmed no `fonts.googleapis.com`, `fonts.gstatic.com`, or any external `<link>`/`@import`/`src:` reference anywhere in the served room-screen HTML; all four `@font-face` declarations point at `/assets/fonts/*.woff2`, served by `express.static` from the local `assets/fonts` directory.
5. **Route ordering / auth coverage** — traced `app.ts` end to end. `/display-screen` and the `/display` WS upgrade both gate on `DISPLAY_IP_WHITELIST` independently but consistently; `/cms` is mounted as `createCmsIpGate(...)` then `createCmsRouter(...)`, and inside the router the IP layer is applied before `requireSession()`, which is applied before the event/agent/photo route factories — matches the documented and tested ordering. `/uploads/:filename` is intentionally ungated by session (a TV has no session) but gated by the *union* of the CMS and display allow-lists, matching D-12/D-15's stated rationale. No CMS route is reachable ahead of its guard.
6. **Pagination** — `parsePageParam()` correctly rejects non-digit, negative, zero, and unsafe-integer inputs by falling back to page 1; a page past the end is never queried (guarded before the `LIMIT`/`OFFSET` call), so there is no off-by-one and no `NaN` reaching SQLite. Verified against `cms-photo-history.test.ts`'s 120-row 50/50/20 split and its `abc/-4/0/1e999/''` fuzz case.
7. **D-02 confirmation** — enforced server-side in `POST /api/events/:id/activate`: the route reads `confirmed === true` from the JSON body and refuses with 409 (never silently proceeding) when guests are waiting and confirmation was not carried; `cms-active-event-switch.test.ts` proves this by posting directly without going through the confirmation page.
8. **Test vacuousness** — the suites are unusually rigorous (second independent `better-sqlite3` handles used to prove `queue_job`/`booth_state` are byte-identical after an event switch; XSS payloads posted as event names and asserted absent from the rendered page; log-line masking asserted with real phone-shaped substrings). One genuinely weak assertion found — see **IN-03**.

No blocker-level defect was found in the areas the review brief specifically asked to be adversarial about. The items below are real, but none of them threatens a guest's photo being lost, a screen blanking, or a stated locked decision being violated.

## Warnings

### WR-01: Event id interpolated into an inline `<script>` via `JSON.stringify` without HTML-escaping, breaking this file's own escaping discipline

**File:** `mirror-request/src/cms/cmsPhotoPages.ts:431`
**Issue:** Every other dynamic value this file (and its siblings `cmsEventPages.ts`, `cmsPages.ts`) puts into HTML goes through `escapeHtml()` — including inside `data-event-id="${id}"` attributes that JS then reads back via `dataset`. This one line breaks that pattern:

```js
if (ok) { location.href = ${JSON.stringify(`/cms/photos?event=${data.event.id}`)}; return; }
```

`JSON.stringify()` escapes quotes and backslashes for a JS string literal, but it does **not** escape `/`. If `data.event.id` ever contained the literal substring `</script>`, the generated page would have its `<script>` block terminated early by the browser's HTML parser, and everything after that point would be parsed as raw HTML/markup rather than executed as JS — a classic "JSON-in-script" XSS primitive.

This is **not currently exploitable**: `event.id` is always a server-minted `crypto.randomUUID()` value (see `LocalStore.createEvent()`), never user-supplied, so it can never contain `</script>`. But it is a live landmine: the moment any future change lets an operator supply or influence the event id/slug (a reasonable-sounding feature request), this becomes a stored-XSS path with no escaping stopgap — and it will not be caught by the existing test suite, which never posts a hostile id (only a hostile *name*, which the file escapes correctly).

**Fix:** Route the id through the HTML-escaped attribute pattern the rest of the file already uses (as `renderCmsDeleteConfirmPage`/`renderCmsActivateConfirmPage` in `cmsEventPages.ts` do via `form.dataset.eventId`), or at minimum escape `/` before embedding in a `<script>`-JSON context:

```js
// Read the id back from the already-escaped data attribute instead of
// re-embedding it as a fresh JS literal:
if (ok) { location.href = '/cms/photos?event=' + encodeURIComponent(form.dataset.eventId); return; }
```

## Info

### IN-01: Dead code — `renderCmsDashboardPage` in `cmsPages.ts` is unused and duplicates `renderCmsEventListPage`

**File:** `mirror-request/src/cms/cmsPages.ts:113-190`
**Issue:** `cmsRouter.ts` only imports `renderCmsLoginPage` from `cmsPages.ts` (`grep -rn "renderCmsDashboardPage" src/ test/` finds only the definition, no callers). The function is a near-complete, independently-maintained duplicate of `renderCmsEventListPage` in `cmsEventPages.ts` — same markup shape, its own copy of the create/activate fetch calls, its own copy of the in-flight-disable logic (`inFlight()` instead of the shared `cmsBusy()`/`cmsRelease()`). Because it is never rendered, it cannot itself cause a live defect, but it is a maintenance hazard: a future edit to the real dashboard (escaping, copy, a new field) has no reason to touch this file and will silently leave the stale copy behind, and any static/dependency-graph tooling will overcount this surface's test coverage need.
**Fix:** Delete `renderCmsDashboardPage` (and `CMS_STYLES`'s duplicate design tokens if unused elsewhere) from `cmsPages.ts`, or explicitly wire it as a fallback with a comment explaining why two implementations exist, whichever is intended.

### IN-02: The shipped layout name is declared twice, independently, with no shared import

**File:** `mirror-request/src/display/displayPage.ts:29` and `mirror-request/src/cms/cmsEventPages.ts:49`
**Issue:** `displayPage.ts` declares `export const SHIPPED_LAYOUT_STYLE = 'stage_sidebar'` and `cmsEventPages.ts` independently declares `export const LAYOUT_STYLES = ['stage_sidebar'] as const`. Nothing ties these two literals together. A future change that adds a second layout (exactly the scenario both files' comments anticipate) has to remember to update both string literals in two different modules; if only one is updated, the CMS would offer a layout option the room screen has no branch for (or vice versa), and nothing in the type system or the test suite would catch the mismatch structurally (the room-screen test only asserts the *current* single value is present).
**Fix:** Have one module export the canonical list of shipped layouts and have the other import it, the same way `cmsEventPages.ts`'s `FONT_CHOICES` is consumed by `displayPage.ts`'s `FONTS` map (which the code already keeps in sync by comment discipline rather than import — worth doing for both at once).

### IN-03: Weak assertion in `display-hero-moment.test.ts` for the served-page hero branch

**File:** `mirror-request/test/display-hero-moment.test.ts:324-326`
**Issue:**
```js
it('the served page carries the hero branch keyed on justCaptured', () => {
  expect(renderDisplayPage()).toContain('justCaptured');
});
```
This assertion would pass against a page where `justCaptured` appears only in a comment, a dead variable, or an unreachable branch — it does not prove the hero tile is actually rendered when `data.justCaptured` is truthy, nor that it takes precedence over the announcing/capturing/slideshow branches (that precedence is real and correctly implemented in `displayPage.ts`'s `render()`, and is exercised properly by `display-room-screen.test.ts`'s state-branch tests and by the end-to-end `phase8-cutover-readiness.test.ts` case that asserts `snapshot.justCaptured` on a live WS feed — so the *behavior* is well covered elsewhere in the suite). Taken in isolation, though, this specific test is vacuous with respect to its own stated claim.
**Fix:** Either delete this assertion (the behavior is already pinned by the stronger tests noted above) or strengthen it to check the precedence-ordering markup pattern the way the "one photo, no rotation" test in `display-room-screen.test.ts` does (asserting the surrounding `if (data.justCaptured)` structure, not just string presence).

---

_Reviewed: 2026-08-13T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
