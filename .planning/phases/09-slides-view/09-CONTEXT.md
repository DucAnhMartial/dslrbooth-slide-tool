# Phase 9 — Slides-Only Screen View: Context

**Gathered:** 2026-08-13, direct conversation with the operator (no formal
discuss-phase — the scope arrived as an operator request during the Phase 8
cutover session and was negotiated to a locked shape in-conversation).

## What the operator asked for, in their words

1. "Màn hình slide có thể config hiển thị được những thông tin gì" — what can
   the slideshow screen be configured to show?
2. "Làm thêm màn hình slide riêng đi" — make a separate slides-only screen.
3. "Chỉ slide thôi nhé còn lại ok" — ONLY the slides variant; everything else
   as proposed (the proposal being: query-param variant, two new toggles, no
   queue-only variant).

## Locked decisions

### D9-01: Variant by query parameter, not screen identity — LOCKED
`/display-screen?view=slides`. Phase 8's D-12 ("screens have no identity; all
show the active event") is preserved exactly: no registration, no per-screen
row, no cookie. The URL typed on the TV is the whole selection mechanism. All
screens still render the same active event and the same snapshot — the param
selects which REGIONS of it are drawn.
**Reversibility:** two-way. Removing the param support later breaks nothing:
a TV pointed at `?view=slides` would simply render the default layout again.

### D9-02: Bare `/display-screen` unchanged — LOCKED
The no-param route keeps today's `stage_sidebar` markup, CSS, and behaviour.
The physical cutover ALREADY EXECUTED points real TVs at that URL; this phase
must not move it. Success criterion 2 is a regression pin, not a feature.

### D9-03: No `?view=queue` variant — LOCKED (descope)
Offered, explicitly declined by the operator ("Chỉ slide thôi"). Do not build
it, do not scaffold for it beyond what falling back on unknown values gives
for free.

### D9-04: Two per-event toggles, both defaulting ON — LOCKED
- `show_guest_name` — the guest's name rendered with their photo in the
  slideshow/hero surface.
- `hero_enabled` — D-09's ~10-15s just-captured takeover. OFF means a new
  capture simply joins the rotation with no takeover.
Both live on the `event` table and in `EventConfig`, edited in the existing
`/cms/events/<id>` form, applied live over WS like every other config field
(the room screen's config applier already runs per-snapshot).
Defaults ON because ON is exactly today's behaviour — an operator who never
opens the form sees no change anywhere, including on the default layout.
**Scope note:** the toggles affect what BOTH views render (they are event
config, not view config) — e.g. hero off means no hero on the default layout
either. The operator approved the two-toggle proposal as stated ("còn lại
ok"); the proposal did not promise view-scoped behaviour, and event-scoped is
the simpler, D-12-consistent reading.

### D9-06: The CMS presents the screens as TWO LABELED TYPES — LOCKED
Decided 2026-08-13 after planning had started (AskUserQuestion, operator chose
"Là màn hiện tại (Khuyến nghị)"). The CMS event page's screen-address card
lists both URLs as two named types:
- **Type 1 — Thứ tự + slide:** `/display-screen` (the existing screen,
  UNCHANGED — "màn hình số thứ tự" in the operator's words IS this screen)
- **Type 2 — Chỉ slide:** `/display-screen?view=slides`
This is presentation only: two copyable, labeled URLs. It does NOT revive
`?view=queue` (D9-03 stands — the operator was offered a queue-only screen
again in the same question and chose the existing screen instead), and it does
NOT add per-screen identity (D9-01 stands).

### D9-07: The booth kiosk popup is retired by CONFIGURATION, not by code — LOCKED
Decided 2026-08-13, same conversation. The operator first said the display
screen "sẽ thay cho màn hình popup ở agent", then — offered a choice of which
view the popup should show — answered "Nó ko cần thiết vì màn hình /display
đã làm điều đó r": the popup is simply NOT NEEDED. The room screen on the
venue TVs already serves that purpose.

Consequences:
- **No Phase 9 code work in `dslrbooth-agent`.** The launcher, the local
  `/display` page, and the `AgentDisplayState` seam all stay as they are
  (including the queue-column removal already committed as `4f8fc67`).
- The popup is turned off with `autoOpenDisplay = false` — one of the four
  D-16 safe fields, settable in the booth `.env` (`AUTO_OPEN_DISPLAY=false`)
  or live from `/cms/agent` once the Agent connects. Reversible the same way.
- The Agent-side default stays `true` in code. Changing the shipped default
  is a separate decision affecting fresh installs; the operator's statement
  was about THIS deployment, and the CMS control exists precisely so this
  kind of preference does not require a build.

### D9-05: First ALTER TABLE on a Phase 8 table — acknowledged
Phase 8 shipped zero `ALTER TABLE` (four new tables only), and that fact was
used as deployment-safety evidence during the cutover. This phase knowingly
ends that: two additive columns with defaults on `event`, using the exact
`PRAGMA table_info()` + conditional `ALTER TABLE` idiom `localStore.ts`
already uses four times (Phases 2-7 on Phase 1 tables). Idempotent on re-run,
safe on a populated production database, no NOT-NULL-without-default.

## Constraints carried forward from Phase 8 (all still bind)

- **D-07:** WS drop → keep last content + reconnecting banner. Never blank to
  idle. Applies to the slides view identically.
- **D-09 mechanics:** `justCaptured` is COMPUTED per `buildSnapshot()` tick
  from `event_photo.captured_at` vs an injected TTL. It is never a timer, and
  the serialized snapshot must stay byte-identical between broadcasts within
  the hero window (the `maybeBroadcast` diff trap — `display-hero-moment`
  tests pin exactly two broadcasts per capture; do not break that).
- **D-11:** photo history is deleted only by hand. The slides view reads the
  same `photos` array; it introduces no retention behaviour.
- **D-12:** screens have no identity (see D9-01).
- **UI-SPEC fonts:** system-ui + Be Vietnam Pro + Lora, self-hosted, weights
  400/700 only, never a CDN.
- **UI-01:** legibility at real TV viewing distance. The slides view drops the
  sidebar, so the photo surface must reclaim the full width — this is a
  design task, not `display:none` on the aside.
- Server-rendered idle-before-first-snapshot backstop (Phase 8's UI-01 note in
  `displayPage.ts`): the slides view needs its own sensible pre-snapshot
  state, not a blank page.
- `DisplaySnapshot` already carries everything the slides view needs
  (`photos`, `justCaptured`, `eventConfig`, `agentOnline`). Adding the two
  toggle fields to `EventConfig` extends the existing config projection; no
  new snapshot mechanism.

## Claude's discretion

- Whether `renderDisplayPage()` takes a param vs. two render functions sharing
  partials — pick whatever keeps the D9-02 regression pin trivially true.
- Exact copy for the slides view's idle state (there is no queue to explain;
  "come take photos" energy, consistent with the event's configured strings
  where sensible).
- Whether the QR block appears on the slides view. Lean YES (it drives
  registrations and the surface has room), but if it fights the full-bleed
  design, dropping it is acceptable — record the choice.
- How the guest-name overlay is styled when `show_guest_name` is on.
- Unknown `view` values: fall back to default layout (success criterion 5);
  no error surface.

## Deferred / out of scope

- `?view=queue` (D9-03, operator descope).
- Separate idle image vs background image (`deferred-items.md` D-3) — do not
  entangle; this phase does not touch `background_url` semantics.
- Any per-screen identity, registration, or CMS listing of screens.
- Retiring `renderCmsDashboardPage` dead code (deferred-items D-2) — separate
  concern, only relevant if a plan happens to own `cmsPages.ts` anyway.

## Deployment note for the planner

The service is LIVE in production as of 2026-08-13 (~04:30): PM2
`mirror-service`, Phase 8 code, real TVs pointed at `/display-screen`. Plans
must keep the working tree releasable at every commit — the operator may
restart the service at any moment. This is also why D9-02 is a hard pin.
