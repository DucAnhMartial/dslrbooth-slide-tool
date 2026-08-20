# Phase 8: CMS & Event Display — Discussion Log

**Date:** 2026-08-12
**Mode:** default (interactive), 5 areas, 17 decisions
**Note:** human-reference record only. Downstream agents read `08-CONTEXT.md`, not this file.

---

## Before the questions: what was scouted

Three findings shaped every area that followed:

1. `web-slide` receives guests and photos through Phase 4's **guest-notification webhook**
   (`NOTIFY_WEBHOOK_URL` → `localhost:3001/webhook/json`). The "send the guest their photo"
   channel and the "feed the room screen" channel are the same channel today.
2. `/display` and `/display-screen` are gated by **IP whitelist only** — no token, no cookie
   (D-09), with production-required validation in `config.ts:69,72`.
3. `mirror-request/src/` has **no** static-file middleware, **no** upload handling, and
   **no** session/cookie/password machinery. All of that is new work.

---

## Area 1 — What "multiple events" means

**Q1.** CMS-02 says one server serves several events at once — what does that mean in practice?
- Options: *Config library, 1 live event (recommended)* / *Truly concurrent events* / *You decide*
- **Chose:** config library, one active event.
- Rationale surfaced during the question: concurrent events implies multi-booth, which
  `PROJECT.md` lists as out of scope and which would force rewrites of Phase 2's queue,
  Phase 3's single-Agent link, and Phase 7's single-row `booth_state`.

**Q2.** Switching the live event while guests are still queued?
- Options: *Warn but allow (recommended)* / *Block until queue is empty* / *You decide*
- **Chose:** warn and allow; the queue is untouched.
- The blocking option was argued against with real evidence: `3X818VEJ` sat `queued` with
  `retries=0` and nobody to shoot it. That state would have hard-locked the CMS mid-event.

**Q3.** Scheduled events or manual on/off?
- Options: *Manual (recommended)* / *Date field, still manual activation*
- **Chose:** manual only. No scheduler, cron, or timezone handling.

**Q4.** Does `NOTIFY_WEBHOOK_URL` → web-slide survive?
- Options: *Keep, but only for third parties (recommended)* / *Remove it*
- **Chose:** keep, role narrowed.
- ⚠ **The user found this question confusing, and the confusion was the orchestrator's
  fault** — it asked about the data path before establishing where the screen would live
  (Area 2). The user asked directly: "there's still a web-slide screen, right?" It was
  answered with a before/after diagram: the room screen absolutely still exists; only its
  data source moves from webhook to `WS /display`, and the webhook keeps its original job of
  delivering photos to guests. Ordering the areas the other way would have avoided this.

---

## Area 2 — Where the room screen lives

**Q1.** Which process serves the TV?
- Options: *Merge into extension service (recommended)* / *Keep web-slide as a thin renderer* / *You decide*
- **Chose:** merge; retire `web-slide`.
- ⚠ **Flagged at the time:** this **overrides ROADMAP's locked decision**, which says
  web-slide *becomes* a thin renderer. Recorded in CONTEXT as D-05 with an instruction to
  update ROADMAP so the documents stop contradicting each other.

**Q2.** The TV points at `:3001` — how to cut over?
- Options: *Redirect shim from web-slide (recommended)* / *Change the URL on each TV, kill 3001*
- **Chose:** hard cutover, against the recommendation.
- **Consequence recorded:** no fast rollback. If the new screen misbehaves mid-event someone
  must walk to every TV. CONTEXT D-06 tells the planner to cut over between events.

**Q3.** Service restarts mid-event — what does the TV do?
- Options: *Reconnect, keep last content (recommended)* / *Drop to idle immediately*
- **Chose:** keep last content plus a reconnecting banner.

**Q4.** What happens to `web-slide/` source?
- Options: *Keep in git, don't run (recommended)* / *Delete the directory*
- **Chose:** keep, with a README marking it retired.

---

## Area 3 — Photos

Opened by a direct user question: **"if it's merged into extension, will the photo and name
show on the slide after the guest finishes shooting?"**

Answered from code rather than assertion:
- `buildSnapshot()` (`displayServer.ts:119`) currently carries six fields and **no photo**.
- But `onFileUpload()` (`queueService.ts:913`) already receives the photo URL, and Phase 7's
  `pending_print` registry already attributes it to the right `jobId` — the hard part is done.
- ⚠ A design trap was surfaced: snapshot `guestName` is the guest being **announced next**,
  not the guest who **just finished**. Showing "photo + name of whoever just shot" needs a new
  field; reusing `guestName` would name the wrong person.

**Q1.** How is a just-finished guest shown?
- Options: *Hero moment then join slideshow (recommended)* / *Straight into the slideshow* / *You decide*
- **Chose:** hero moment, ~10–15s, then joins rotation.
- Argument that landed: with 8 photos at 6s, a guest could wait ~18s to see their own shot.

**Q2.** Where do photos live?
- Options: *URL row in SQLite, file stays at source (recommended)* / *Download and self-host*
- **Chose:** URL row only. No disk management, no second copy of real guests' photographs.

**Q3.** Retention?
- Options: *Per event, manual delete only (recommended)* / *Cap at N most recent*
- **Chose:** manual only — no silent automatic deletion of real guests' photos.

---

## Area 4 — Screen identity and access control

Opened with a correction: earlier option previews said the service runs on `:3000`; it is
actually **`:3002`** (`config.ts:80`). No decision changed, but the right number went into
CONTEXT.

Also noted: D-01 (one active event) **dissolves most of this area** — with a single live
event, "each screen knows its event" is trivially true.

**Q1.** Do screens need their own identity?
- Options: *No, always the active event (recommended)* / *Per-event slug in the URL*
- **Chose:** no identity. Every TV opens the same URL.
- A slug would mean editing the URL on each TV to change customer — exactly what ROADMAP
  success criterion 1 exists to eliminate.

**Q2.** What protects the CMS?
- Options: *IP whitelist + password (recommended)* / *Password only*
- **Chose:** both layers, reusing the existing `isWhitelisted()` machinery.

**Q3.** How is logo/background upload secured?
- Options: *Authenticated + tightly bounded (recommended)* / *You decide the details*
- **Chose:** authenticated, MIME allowlist validated by magic bytes, ~5MB cap,
  server-generated filenames, stored outside the code directory, fixed `Content-Type`.
- This is the surface that produced CMS-05: `web-slide` took anonymous 20MB uploads straight
  into `./uploads/`.

---

## Area 5 — Agent configuration (UI-02)

Raised by the orchestrator at the "are we done?" gate: UI-02 is success criterion 7 and had
not been discussed at all. The user chose to discuss it rather than leave it to the planner.

Grounding read first: `dslrbooth-agent/src/config.ts` has 8 fields, and they are **not
equally risky**. `extensionServiceWsUrl` and `extensionServiceWsToken` are the bootstrap
credentials that create the very WebSocket a config change would travel over.

**Q1.** Which fields are remotely editable?
- Options: *Safe fields only (recommended)* / *All fields, with confirmation*
- **Chose:** safe fields only. The three bootstrap fields are read-only in the CMS.
- The failure mode named: one mistyped character in the token at 8pm mid-wedding and the
  Agent never reconnects — recoverable only by physically visiting the booth.

**Q2.** How does config reach the Agent?
- Options: *Agent pulls on connect + reload command (recommended)* / *Agent rewrites its own `.env`*
- **Chose:** pull, applied in memory. Keeps the service as the single source of truth and
  preserves `CLAUDE.md`'s "Agent is a dumb relay" rule.

**Q3.** What is the rollback when a config change breaks the booth?
- Options: *Keep previous version, one restore button (recommended)* / *Just retype it*
- **Chose:** one-step restore. Not version history — enough for "it broke right after I
  saved", which is the case that happens mid-event.

---

## Deferred ideas

Concurrent multi-event/multi-booth; extra room-screen layouts; multi-operator accounts and
password reset; full config version history; deleting `web-slide/` from disk; CMS login rate
limiting (only needed if the IP layer is relaxed).

## Claude's discretion

Table/column names and migration order; per-field `maxlength` caps; session cookie mechanics
and password hashing algorithm; whether the hero-moment duration is a constant or a CMS field;
how `justCaptured` is cleared.

## Scope creep

None. Every area stayed inside the phase boundary; the one adjacent topic raised
(multi-booth) was recorded as deferred rather than pursued.
