# Phase 8: CMS & Event Display - Context

**Gathered:** 2026-08-12
**Status:** Ready for planning

<domain>
## Phase Boundary

Stop shipping a code change per customer. Today `web-slide/index.html` is 500 lines of
hard-coded layout and `web-slide/server.js:39` keeps guests in `const customers = []` — in
memory, capped at 50, lost on restart. This phase makes a new customer a **configuration
change**, gives the room screen a **single feed that knows the queue**, makes configuration
and photo history **survive restart**, puts the operator console **behind a login**, and lets
the booth Agent be configured **without editing `.env` on the booth PC**.

Requirements in scope: **UI-01, UI-02, CMS-01, CMS-02, CMS-03, CMS-04** (CMS-05's live
exposure was already patched on 2026-08-12, ahead of and separately from this phase — see
Code Insights).

**Not in this phase:** anything that changes the queue, the booth state machine, the Agent
protocol's session commands, or guest-facing `/status/:jobId`. Phases 1–7 are load-bearing
and this phase is additive to them.
</domain>

<decisions>
## Implementation Decisions

### Event model (what "multiple events" actually means)

- **D-01:** CMS-02's "one server, several events" means a **library of saved event
  configurations with exactly ONE active at a time** — NOT concurrent live events. Schema:
  an `event` table (many rows) plus a single-row pointer to the active event. **The global
  FIFO queue, `booth_state`, and the Agent routing built in Phases 1–7 are NOT touched.**
  "Several screens" is satisfied because any number of screens can display the one active
  event. The alternative (truly concurrent events) implies multi-booth, which `PROJECT.md`
  lists as explicitly out of scope and which would force a rewrite of Phase 2's queue,
  Phase 3's single-Agent link, and Phase 7's single-row `booth_state`.
  — **Reversibility:** costly — moving to true multi-event later means adding an
  `event_id` foreign key to `queue_job` and `booth_state` and re-deriving every queue query,
  but no published contract breaks and no data is destroyed.

- **D-02:** Switching the active event while guests are still queued is **warned but
  allowed**. The CMS shows "N guests still waiting" and requires confirmation; the queue is
  **not** touched — waiting guests are still served, only the screen's appearance changes.
  Blocking the switch until the queue is empty was rejected on real evidence: ticket
  `3X818VEJ` sat `queued` with `retries=0` and nobody to shoot it, and had to be fixed by
  hand in the database. That exact situation would have hard-locked the CMS mid-event.

- **D-03:** Event activation is **manual only**. No `start_at`/`end_at`, no scheduler, no
  cron, no timezone handling, no auto-deactivation. Real events start late and run long, so
  a schedule would be wrong precisely when the room is busiest.

- **D-04:** `NOTIFY_WEBHOOK_URL` **stays**, with its role narrowed. The room screen stops
  being fed by it (the service already holds the data and has `WS /display`); the webhook
  remains what Phase 4 built it to be — the delivery path for sending the guest their photo,
  plus third-party integration. Today one channel does both jobs; this separates them.
  **Removing the webhook would break NOT-01/NOT-02, which are already complete.**

### Where the room screen lives

- **D-05:** The room screen is **merged into the Extension Service** as a route, and
  `web-slide` is **retired**. `mirror-request` already serves `/display-screen` via
  `renderDisplayPage()`; it gains event configuration. One process, one deploy, one log,
  one database holding photos + config + queue — no second source of truth to drift.
  ⚠ **This overrides the ROADMAP's locked decision**, which reads *"`web-slide` becomes a
  thin renderer driven by `WS /display`"* — i.e. keep web-slide as the rendering layer. The
  human chose full retirement instead, on 2026-08-12. **ROADMAP.md must be updated to match
  so the two documents do not contradict each other.**
  — **Reversibility:** one-way — retiring `web-slide` frees its port and removes a
  separately-deployable renderer. Restoring it later means re-establishing a second process,
  its deploy story, and its own view of the data. The accepted cost is that the TV and the
  service now fail together.

- **D-06:** Cutover is **hard**: turn `web-slide` off, then change the URL on each TV.
  A redirect shim was offered and declined. **Consequence the planner must handle: there is
  no fast rollback path** — if the new screen misbehaves mid-event, someone must walk to each
  TV. Ship the screen well-tested and cut over between events, never during one.

- **D-07:** When the WebSocket drops, the screen **keeps the last content on display** and
  shows a small "reconnecting" banner, retrying with backoff. It must NOT blank to the idle
  screen — a guest watching their own photo should not see it wiped during a 3-second
  restart. This is the `08-UI-SPEC.md` "feed disconnected" state.

- **D-08:** `web-slide/` source is **kept in git, not deleted** (baseline commit `edb33c6`,
  2026-08-12). Add a README marking it retired and pointing at the replacement. Its
  `index.html` is the origin of the new layout and stays useful as reference.

### Photos

- **D-09:** A guest who has just finished shooting gets a **hero moment**: their new photo
  fills the screen with their name for ~10–15 seconds, then joins the rotating slideshow.
  This requires a **new snapshot field** (e.g. `justCaptured { photoUrl, name }`).
  ⚠ **It cannot reuse the existing `guestName` field**: `buildSnapshot()`
  (`displayServer.ts:119`) sets `guestName` to the guest being *announced/called next*, not
  the guest who just finished. They are different people at the same moment.

- **D-10:** Photos are stored as a **URL row in SQLite**, not downloaded. New table keyed by
  `jobId` with `event_id`, guest name, photo URL, captured-at. The image file stays wherever
  `file_upload` already points. No disk quota, no garbage collection, no second copy of real
  guests' photographs to secure. Accepted cost: if the far side deletes a file the slideshow
  gets a broken image — already covered by `08-UI-SPEC.md`'s G4 placeholder rule (neutral
  tile + warning icon + label, never the browser's broken-image glyph).

- **D-11:** Photo history is **kept per event, deleted only by hand** via an explicit CMS
  action with confirmation. **No automatic expiry or row cap** — silently deleting real
  guests' photos on a timer is not acceptable, and since only URLs are stored the table does
  not grow expensively.

### Screen identity and access control

- **D-12:** Screens carry **no identity of their own**. Every TV opens the same URL and
  renders whatever event is active; changing the active event in the CMS updates every screen
  automatically over the WebSocket. A per-event slug was rejected because it would force
  someone to edit the URL on each TV to change customer — exactly what ROADMAP success
  criterion 1 exists to eliminate. D-01 (one active event) is what makes CMS-02's "each
  screen knows which event it belongs to" trivially true.

- **D-13:** The CMS sits behind **two layers: IP whitelist first, then password**. Reuse the
  existing `isWhitelisted()` / D-09 machinery already gating `/display` and
  `/display-screen` — do not write a second implementation. The reason for two layers is
  recorded in CMS-05: `web-slide` exposed `DELETE /api/customers` to the whole internet
  because it had only one (and briefly, none).

- **D-14:** Login is a **single operator account** — one username/password from `.env` with
  the password **stored hashed, never plaintext**, an HttpOnly session cookie, and **no
  automatic inactivity timeout** (being logged out mid-event is worse than a lingering
  session). Logout is manual. No user table, no account CRUD, no password-reset flow.

- **D-15:** Logo/background upload is **authenticated and tightly bounded**: login required;
  images only, validated by **content (magic bytes), not just the file extension**; a size
  cap around 5MB; **filenames generated by the server**, never taken from the client; stored
  outside the code directory; served with a fixed `Content-Type`. This is the exact surface
  that made CMS-05 — `web-slide` accepted anonymous 20MB uploads written straight into
  `./uploads/`.

### Agent configuration (UI-02)

- **D-16:** Only **safe fields** are remotely editable: `logLevel`, `autoOpenDisplay`,
  `dslrBoothApiPort`, `dslrBoothPassword`. **`extensionServiceWsUrl`,
  `extensionServiceWsToken`, and `triggerServerPort` are FORBIDDEN from remote editing** —
  they are the bootstrap credentials that create the very WebSocket a change would travel
  over, so a wrong value means the Agent can never reconnect and someone must physically
  visit the booth. Show these three in the CMS as **read-only**, labelled as requiring manual
  edit on the booth machine. (Source: `dslrbooth-agent/src/config.ts`, 8 fields.)
  — **Reversibility:** one-way for the forbidden three — the failure mode is loss of remote
  access to the booth itself, recoverable only by physical presence.

- **D-17:** Config reaches the Agent by **pull, not file-push**: on connect the Agent
  requests its configuration and the service answers; when the operator saves in the CMS the
  service sends a reload command and the Agent re-requests. The Agent applies values **in
  memory** and never rewrites its own `.env`. This keeps the service the single source of
  truth and preserves `CLAUDE.md`'s "Agent is a dumb relay" rule — the Agent decides nothing,
  it receives and applies. The rejected alternative (Agent overwrites its own `.env` and
  self-restarts) would create two divergent sources of truth and could corrupt `.env`
  mid-write, leaving an Agent that cannot start at all.

- **D-18:** The service keeps the **previous Agent configuration** and the CMS offers a
  one-step **"restore previous"**. Not full version history — one step back is enough for the
  "it broke right after I saved" case, which is the one that happens mid-event.

### Claude's Discretion

- Exact table and column names, and the migration order. Follow the established additive +
  idempotent pattern (`PRAGMA table_info()` + conditional `ALTER TABLE`,
  `CREATE TABLE IF NOT EXISTS`) proven in Phases 4 and 7, and prove idempotency against a
  real temp-file database, not a mock.
- The `maxlength` cap on each CMS text field (`08-UI-SPEC.md` G3 requires caps that match
  what the room screen renders well; the specific numbers are Claude's call).
- Session cookie mechanics (name, signing, storage) and the password hashing algorithm,
  subject to D-14's "hashed, never plaintext".
- Whether the hero-moment duration (D-09) is a fixed constant or a CMS-01 field. Default to
  a constructor-injectable constant per the Phase 2 config pattern unless CMS-01's field list
  makes it natural to expose.
- How `justCaptured` is cleared (timer vs. next-snapshot) as long as D-09's behaviour holds.
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### This phase's own contracts
- `.planning/phases/08-cms-event-display/08-UI-SPEC.md` — the approved visual/interaction
  contract. Checker-verified 6/6. Contains the locked font list (system-ui, Be Vietnam Pro,
  Lora — self-hosted, weights 400/700 only), the single stage+sidebar layout, the Vietnamese
  copywriting contract, the fixed non-themeable Agent-status colors, the accessibility rule
  that no icon-only control ships, and the resolved UI Considerations table.
- `.planning/ROADMAP.md` — M8/Phase 8 goal and the 7 success criteria. ⚠ Its "Locked
  decision" paragraph is **superseded by D-05** and must be corrected.
- `.planning/REQUIREMENTS.md` — UI-01, UI-02, CMS-01..CMS-05 (written in Vietnamese).
  ⚠ CMS-05's "what is open RIGHT NOW" text is **stale** — verified 2026-08-12: the hole was
  patched (`trustedOnly` on the DELETE route, `cors` narrowed to GET/HEAD/OPTIONS).
- `.planning/PROJECT.md` — project scope. Note its "no multi-booth, one booth only"
  constraint, which is what D-01 respects.

### Code the phase builds on
- `mirror-request/src/display/displayServer.ts` — `WS /display`, `buildSnapshot()` at :119.
  Current snapshot carries exactly `queuePosition`, `queueLength`, `boothState`,
  `agentOnline`, `guestName`, `countdownSeconds` — **no photo and no config fields**. D-09
  and event config both extend this.
- `mirror-request/src/display/displayPage.ts` — the inline-HTML room screen already served at
  `/display-screen`; the incumbent for D-05, and the source of the proven fluid-typography
  pattern.
- `mirror-request/src/queue/queueService.ts` — `onFileUpload()` at :913 is where the photo
  URL arrives (`payload.photoUrl ?? payload.param2`); Phase 7 D-07 already attributes it to
  the correct `jobId` via the `pending_print` registry rather than by whoever holds the
  booth. This correct attribution is what makes D-09/D-10 safe.
- `mirror-request/src/state/localStore.ts` — 8 existing tables and the hand-rolled additive
  migration pattern the new tables must follow.
- `mirror-request/src/config.ts` — `PORT` defaults to **3002** (:80); `PROXY_IP_WHITELIST`
  (:58) and `DISPLAY_IP_WHITELIST` (:63) plus their production-required validation (:69,
  :72). D-13 reuses this machinery.
- `mirror-request/src/index.ts` — express wiring and the existing `/display-screen` IP gate
  (D-09 comment). **There is currently no static-file middleware, no upload middleware, and
  no session/cookie/password machinery anywhere in `src/` — all of it is new in this phase.**
- `dslrbooth-agent/src/config.ts` — the Agent's 8 config fields; the split in D-16 is drawn
  directly from it.
- `web-slide/index.html`, `web-slide/server.js` — the retiring implementation. `index.html`
  is the visual origin of the new layout; `server.js` shows the anonymous-upload mistake D-15
  must not repeat.
- `mirror-request/CLAUDE.md` — "Agent is a dumb relay", the rule D-17 is shaped by, plus the
  read-only-backend-DB rule.
- `mirror-request/docs/OPS-RUNBOOK.md` — operator procedures; §5's log vocabulary and §7's
  synchronized-deploy rule are the models for whatever D-06's cutover needs documented.
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`WS /display` + `buildSnapshot()`** — the feed already exists, already broadcasts on
  change with a serialised-diff guard, and already sends an immediate snapshot on connect.
  This phase extends its payload; it does not build a new feed.
- **`renderDisplayPage()` / inline HTML template strings** — the project's established way to
  serve UI with no build pipeline. Both new surfaces (room screen, CMS) follow it.
- **`isWhitelisted()` + `DISPLAY_IP_WHITELIST`** — IP gating with production-required
  validation already exists and is reused verbatim for D-13.
- **`pending_print` registry (Phase 7)** — already solves photo→guest attribution correctly.
- **`toGivenName()`** — the given-name projection (D-14 of Phase 5) already applied to the
  up-next list; reuse rather than re-derive.
- **Additive idempotent migration pattern** — `localStore.ts` has 9 `CREATE TABLE IF NOT
  EXISTS` sites and a documented conditional-`ALTER TABLE` idiom.

### Established Patterns
- Zero frontend framework, zero build step beyond `tsc`. Node 20 + express + ws +
  better-sqlite3 + winston only. No npm frontend dependency may be added.
- Timing/limit values are **constructor-injected** (Phase 2 pattern), not read from a
  singleton at use time.
- Guest- and operator-facing copy is **Vietnamese**; names carry diacritics and must render.
- TDD: a failing test commit precedes the implementing commit; non-vacuity is proved by
  mutation (break the guard, watch it go red, revert).

### Integration Points
- `buildSnapshot()` — gains event configuration and photo fields (D-09).
- `onFileUpload()` — gains a write to the new photo-history table (D-10).
- `index.ts` — gains the CMS router, session middleware, upload handling, and static serving
  for uploaded assets; all new.
- `AgentServer` — gains the config-request/reload message pair (D-17). This is the first time
  the Agent link carries anything other than session commands and events, so the message
  types are additive and must not disturb AGT-01..05.
- `NOTIFY_WEBHOOK_URL` — unchanged in mechanism, narrowed in role (D-04).
</code_context>

<specifics>
## Specific Ideas

- The hero moment (D-09) was described as the point of the whole screen: the guest is
  standing there waiting to see their shot, and making them wait a full slideshow cycle
  (~18s with 8 photos at 6s) is how you lose them.
- The rollback anxiety behind D-18 is specific: "it broke right after I saved" at 8pm,
  mid-event, with guests waiting and nobody able to remember the previous port number.
- D-02's shape came from a real incident, not a hypothetical: `3X818VEJ` queued with nobody
  to shoot it, fixed by hand in the DB.
</specifics>

<deferred>
## Deferred Ideas

- **Truly concurrent multi-event / multi-booth** — rejected for this phase by D-01. Would
  require `event_id` on `queue_job` and `booth_state`, per-event Agent routing, and a change
  to `PROJECT.md`'s stated scope. A future milestone.
- **Additional room-screen layouts** (fullscreen slideshow, portrait TV) — the `layout_style`
  field ships with a single value so later layouts need no migration, but only the
  stage+sidebar layout is built here (`08-UI-SPEC.md` Open Question 2, answered).
- **Multi-operator accounts, roles, password reset** — deferred by D-14.
- **Full configuration version history** — D-18 ships one step back only.
- **Deleting `web-slide/` from disk** — D-08 keeps it; revisit after the new screen has run
  real events.
- **Rate limiting on the CMS login** — worth doing if D-13's IP layer is ever relaxed; not
  needed while the IP whitelist stands in front.
</deferred>

---

*Phase: 8-cms-event-display*
*Context gathered: 2026-08-12*
