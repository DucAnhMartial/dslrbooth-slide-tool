# Phase 8: CMS & Event Display - Research

**Researched:** 2026-08-12
**Domain:** Express-based CMS + room-screen consolidation into an existing Node/TypeScript service; SQLite persistence; session auth with Node builtin crypto; WS protocol extension for Agent remote config
**Confidence:** HIGH for architecture/schema/session mechanics (directly verified against live source), MEDIUM for font-sourcing specifics (web-verified, not fetched into repo this session), LOW/flagged where CONTEXT itself leaves a gap (Agent's 8th config field, `logDir`)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** CMS-02's "one server, several events" means a **library of saved event
  configurations with exactly ONE active at a time** — NOT concurrent live events. Schema:
  an `event` table (many rows) plus a single-row pointer to the active event. **The global
  FIFO queue, `booth_state`, and the Agent routing built in Phases 1–7 are NOT touched.**
  Reversibility: costly (adding `event_id` to `queue_job`/`booth_state` later) but not destructive.
- **D-02:** Switching the active event while guests are queued is **warned but allowed**
  ("N guests still waiting" + confirm); the queue itself is untouched.
- **D-03:** Event activation is **manual only** — no scheduler, no start/end times.
- **D-04:** `NOTIFY_WEBHOOK_URL` **stays**, role narrowed to guest-photo delivery + 3rd-party
  integration; the room screen stops being fed by it.
- **D-05:** The room screen is **merged into the Extension Service** as a route;
  `web-slide` is **retired outright**. ⚠ Overrides ROADMAP's original "thin renderer"
  wording — ROADMAP.md must be corrected to match.
- **D-06:** Cutover is **hard** — turn `web-slide` off, change the URL on each TV. No
  redirect shim. No fast rollback; ship well-tested, cut over between events.
- **D-07:** On WS disconnect the screen **keeps last content on display** + a small
  "reconnecting" banner, retry with backoff. Must NOT blank to idle.
- **D-08:** `web-slide/` source **kept in git** (baseline `edb33c6`), not deleted; add a
  README marking it retired.
- **D-09:** A guest who just finished shooting gets a **hero moment**: new photo + name
  fill the screen ~10–15s, then joins the rotating slideshow. New snapshot field
  `justCaptured { photoUrl, name }` — **cannot reuse `guestName`** (that field is the
  guest being announced/called next, a different person at the same moment).
- **D-10:** Photos stored as a **URL row in SQLite**, not downloaded. New table keyed by
  `jobId`, with `event_id`, guest name, photo URL, captured-at.
- **D-11:** Photo history kept **per event, deleted only by hand** via CMS action + confirm.
  No auto-expiry, no row cap.
- **D-12:** Screens carry **no identity of their own** — every TV opens the same URL and
  renders whatever event is active.
- **D-13:** CMS sits behind **two layers: IP whitelist first, then password**. Reuse the
  existing `isWhitelisted()` machinery (do not write a second implementation of the
  algorithm) — do not re-litigate whether two layers are needed.
- **D-14:** Login is a **single operator account** — username/password from `.env`,
  password **stored hashed, never plaintext**, HttpOnly session cookie, **no automatic
  inactivity timeout**, logout is manual. No user table, no account CRUD, no reset flow.
- **D-15:** Logo/background upload is **authenticated and tightly bounded**: login
  required; images only, validated by **content (magic bytes)**, not extension; ~5MB cap;
  **server-generated filenames**; stored outside the code directory; served with a fixed
  `Content-Type`.
- **D-16:** Only **safe fields** remotely editable: `logLevel`, `autoOpenDisplay`,
  `dslrBoothApiPort`, `dslrBoothPassword`. `extensionServiceWsUrl`, `extensionServiceWsToken`,
  `triggerServerPort` are **FORBIDDEN** from remote editing (shown read-only in CMS).
  (Source cited as "8 fields" in `dslrbooth-agent/src/config.ts` — see Assumption A1 below,
  the 8th field `logDir` is not classified by either list.)
- **D-17:** Config reaches the Agent by **pull, not file-push**: Agent requests on connect;
  on operator save, service sends a **reload command** and the Agent **re-requests**. Agent
  applies values **in memory**, never rewrites its own `.env`.
- **D-18:** Service keeps the **previous** Agent configuration; CMS offers **one-step
  "restore previous."** Not full history.

### Claude's Discretion

- Exact table/column names and migration order (follow the additive + idempotent pattern,
  proved against a real temp-file DB).
- `maxlength` caps per CMS text field (numbers are Claude's call, must match what the Room
  Screen renders well).
- Session cookie mechanics (name, signing, storage) and password hashing algorithm, subject
  to D-14's "hashed, never plaintext."
- Whether hero-moment duration (D-09) is a fixed constant or a CMS-01 field — default to a
  constructor-injectable constant unless CMS-01's field list makes exposing it natural.
- How `justCaptured` is cleared (timer vs. next-snapshot) as long as D-09's behaviour holds.

### Deferred Ideas (OUT OF SCOPE)

- Truly concurrent multi-event / multi-booth (D-01 rejects for this phase).
- Additional room-screen layouts beyond the single stage+sidebar (Open Q2, answered).
- Multi-operator accounts, roles, password reset (D-14).
- Full configuration version history beyond one step back (D-18).
- Deleting `web-slide/` from disk (D-08 keeps it).
- Rate limiting on CMS login — worth doing if D-13's IP layer is ever relaxed; not needed
  while the IP whitelist stands in front. **Do not add it this phase**, but do not treat its
  absence as an oversight either — it is deliberately out of scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| UI-01 | Idle screen renders on open, before any request exists | `buildSnapshot()`/`renderDisplayPage()` extension pattern below; idle default already proven in the incumbent `displayPage.ts`; Validation Architecture maps this to a supertest hit on `/display-screen` before any registration exists |
| UI-02 | Agent configurable via UI, not `.env` on the booth PC | D-16/D-17 message-pair design below (`config_request`/`config`/`reload_config`), full Agent-side mutability analysis, `logDir` gap flagged |
| CMS-01 | Per-event config (logo, colors, font, idle image, copy, QR/CTA, photo count, per-photo duration, layout) | `event` table schema below; font-sourcing plan; QR/CTA modeled as upload-asset + text field to avoid a new QR-generation dependency |
| CMS-02 | One server, several events/screens, each screen knows its event | D-01's single-active-event library + `active_event` pointer; D-12 screen-identity-free design |
| CMS-03 | Config + photo history survive restart | All new state lives in SQLite (`event`, `active_event`, `event_photo`, `agent_config`), following `LocalStore`'s existing `bootstrap()`/`migrate()` pattern |
| CMS-04 | CMS behind login | D-13/D-14 two-layer auth design (IP allowlist middleware + session), CMS_IP_WHITELIST config key proposal |
| CMS-05 | (live hole already patched; do-not-reintroduce) | Upload route design explicitly excludes `.svg`/`.html`/`.js`, hand-rolled serving route with fixed Content-Type, server-generated filenames |
</phase_requirements>

## Summary

This phase is mostly **integration and schema design**, not new-technology adoption: every
piece — express routing, SQLite persistence, WS message extension, session auth — has a
close working precedent already in `mirror-request/src/`. The two genuinely new primitives
are (1) password hashing/session cookies and (2) file upload handling, and Node 20's builtin
`crypto` module (`scryptSync`, `timingSafeEqual`, `randomBytes`, `randomUUID` — all verified
present) covers the first with **zero new dependencies**. For the second, this research
recommends **avoiding `multer` entirely** in favor of a base64-JSON upload body parsed with
the already-present `express.json()` (route-scoped limit) — verified via a live web search
that `multer` has a recurring history of DoS-class advisories in its multipart parser
(CVE-2025-47944, CVE-2025-7338, and 2026 GitLab advisories for incomplete-cleanup and
deeply-nested-field DoS), all specific to the multipart-parsing code path that a base64-JSON
upload sidesteps completely.

The event/photo data model is fully **additive** — no existing table (`registration`,
`queue_job`, `booth_state`, `notification_record`, `pending_print`) needs a column added or
touched, unlike Phases 6/7's migrations. Four new tables cover the whole phase: `event`,
`active_event` (single-row pointer, same `CHECK(id=1)` idiom as `booth_state`),
`event_photo`, and `agent_config` (also single-row, holding current+previous JSON blobs for
D-18's one-step restore).

The `justCaptured` hero-moment field (D-09) should be **computed, not pushed**: like
`countdownSeconds`/`announcementEndsAt` are already recomputed from a stored end-time on
every poll tick, `justCaptured` should be derived from `event_photo`'s most recent row's
`captured_at` timestamp compared against `Date.now()` — self-clearing, zero new
cross-module wiring between `queueService` and `displayServer`, and structurally immune to
the "diff never clears" and "thrashes every tick" failure modes this research was asked to
check, because it only transitions state twice per capture (appear, then disappear) exactly
like the countdown field already does today.

The Agent-side config split (D-16/D-17) requires one real code change beyond message
plumbing: `DslrBoothClient`'s `port`/`password` are `readonly` constructor parameters today
(`dslrbooth-agent/src/dslrbooth/client.ts:10-13`) — applying a remote config change "in
memory" per D-17 means these must become live-mutable, not re-read from `process.env` (which
D-17 explicitly forbids touching) and not requiring a process restart (which defeats the
whole point of UI-02).

**Primary recommendation:** build the CMS as a third `createXRouter()`-style Express router
(mirroring `createStatusRouter()`), mounted behind a new dedicated `CMS_IP_WHITELIST` config
key (not a reuse of `DISPLAY_IP_WHITELIST` — different physical network, different audience)
using a **new**, purpose-reimplemented IP-gate middleware (matching this project's
established "reimplement, don't import, at a phase boundary" convention), plus an in-memory
session-token store (no new table — CMS-03 covers event config and photo history, not
session survival; losing sessions on a service restart is an acceptable, even correct,
failure mode since a restart already requires an operator to be present).

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Room screen rendering (hero, slideshow, queue sidebar) | Frontend Server (SSR, inline template) | Browser (WS client JS) | `renderDisplayPage()` already serves fully-formed HTML+inline-JS; the browser only re-renders on each WS snapshot, no client routing/state library |
| Event config CRUD, active-event switch | API / Backend | — | Mutating state that must be authenticated, validated, and audited (D-02's warn-on-switch) — belongs in Express route handlers, not the browser |
| Photo history persistence + display | Database / Storage | API / Backend | URL rows only (D-10); backend reads/writes SQLite, never touches the actual image bytes |
| CMS login/session | API / Backend | Browser (cookie) | Session state and password verification must live server-side; the browser only carries the opaque HttpOnly cookie |
| Logo/background upload | API / Backend | Database/Storage (filesystem, outside code dir) | Validation (magic bytes, size) and filename generation are server responsibilities per D-15; browser only provides raw bytes |
| Static font assets | CDN / Static (self-hosted, `express.static`) | — | Trusted, immutable, build-time assets — no validation needed at request time, unlike uploads |
| Agent config (safe fields) | API / Backend (source of truth, `agent_config` table) | Booth PC (Agent applies in memory) | D-17: server is the single source of truth; Agent is a receiver only, never decides or persists |
| WS `/display` feed (queue, boothState, justCaptured) | API / Backend (`DisplayServer`) | Browser (renders snapshot) | Existing Phase 5 pattern extended, not replaced |
| WS `/agent` config pull/reload | API / Backend (`AgentServer`) | Booth PC (`WsConnection`) | New additive message pair riding the existing authenticated link — no new transport |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| express | ^4.21.1 (already a dependency) | CMS + room-screen routing, session middleware, upload body parsing | Already the project's only HTTP framework; zero new dependency |
| better-sqlite3 | ^11.0.0 (already a dependency) | `event`/`active_event`/`event_photo`/`agent_config` tables | Already the project's only persistence layer |
| ws | ^8.18.0 (already a dependency) | `WS /display` snapshot extension, `WS /agent` config message pair | Already the transport for both surfaces this phase touches |
| Node builtin `crypto` | Node 20 LTS builtin | Password hashing (`scryptSync`), session token minting (`randomBytes`), constant-time comparison (`timingSafeEqual`), event/session ids (`randomUUID`) | **[VERIFIED: direct `node -e` execution this session]** — `typeof crypto.scryptSync/timingSafeEqual/randomBytes/randomUUID` all resolve to `"function"` on the installed runtime; `AgentServer.isValidBearerToken()` (`mirror-request/src/agent/agentServer.ts:46-57`) already uses this exact `timingSafeEqual` idiom for the Agent's own auth, so this phase's session/password code has a proven in-repo precedent to copy, not invent |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| winston (already a dependency, both repos) | ^3.14.2 / ^3.13.0 | CMS/photo-write log lines | Reuse `labelLogger('cms')` / `queueLogger` pattern; `mask()` (masking formatters, `src/logging/logger.ts:10-14`) already strips phone/email patterns — new CMS logs must pass guest names through the same masked logger, never `console.log` |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| base64-JSON upload body (recommended) | `multer` v2.x (multipart/form-data) | `multer` gives a more conventional `<input type=file>` UX with no client-side base64 encoding step, but adds a dependency with a **recurring DoS-advisory history specifically in its multipart parser** (CVE-2025-47944 fixed in 2.0.0, CVE-2025-7338 fixed in 2.0.2, plus 2026 GitLab advisories GHSA-class for incomplete aborted-upload cleanup and deeply-nested field-name DoS — `[CITED: web search, GitLab Advisory Database / Wiz / ZeroPath, 2026-08-12]`). If a future team prefers `multer` anyway, it must be pinned `^2.2.0` (verified current: `npm view multer version` → `2.2.0`, published 2026-06-15, not deprecated) — never the 1.x line. |
| Node builtin `crypto.scryptSync` | `bcrypt` / `argon2` npm packages | Both need native compilation (bcrypt) or a WASM/native binding (argon2) and are a genuinely new dependency for a single-account login; Node's builtin scrypt is OWASP's explicitly endorsed fallback when Argon2id isn't available `[CITED: OWASP Password Storage Cheat Sheet, web search 2026-08-12]` and needs zero new install |
| Hand-rolled QR generation from a URL string | `qrcode` npm package | Adds a new backend dependency for a feature the operator's existing ticketing/registration flow may already produce a QR for; recommended default is to model "QR/CTA" as an **uploaded image asset** (reuses D-15's upload machinery) plus a short editable CTA text string — zero new dependency, and matches how `logo`/`background` are already modeled |

**Installation:** none — no new package for either repo this phase, under the recommended design.

**Version verification:** `npm view multer version` → `2.2.0` (published 2026-06-15, checked live this session — see Package Legitimacy Audit). No other new package is proposed.

## Package Legitimacy Audit

No new runtime dependency is recommended for either repo under this research's design (base64
upload avoids `multer`; Node builtin `crypto` avoids `bcrypt`/`argon2`; upload-asset modeling
of QR/CTA avoids `qrcode`). The audit below covers the one alternative package a planner might
still reach for, so it is pre-vetted either way.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| multer | npm | mature (long-standing expressjs-org package) | very high (millions/week, not independently re-measured this session) | github.com/expressjs/multer | OK, **but** pin `^2.2.0` — `[CITED: web search, multiple 2025-2026 CVE advisories against the 1.x line]` | Not adopted by this research's recommended design; documented here only as a vetted fallback if the planner chooses multipart over base64-JSON |

**Packages removed due to [SLOP] verdict:** none — no candidate reached SLOP.
**Packages flagged as suspicious [SUS]:** none.

*No package-legitimacy seam tool call was made this session (no MCP registry-check tool was
invoked); the `multer` verdict above is `[CITED]` from `npm view multer version/deprecated`
(directly executed) plus a corroborating public-advisory web search, not from the
`gsd-tools query package-legitimacy check` seam. If the planner does choose `multer`, re-run
that seam before locking the version.*

## Architecture Patterns

### System Architecture Diagram

```
                        ┌─────────────────────────────────────────────┐
                        │              Extension Service                │
                        │                (single process)               │
                        │                                                │
  Operator laptop ──┐   │  ┌──────────────┐   ┌─────────────────────┐   │
  (CMS_IP_WHITELIST)├──►│  │ IP gate (new)│──►│ Session-auth (new)  │   │
                     │   │  └──────────────┘   └──────────┬───────────┘   │
                     │   │                                 ▼               │
                     │   │                     ┌──────────────────────┐   │
                     │   │                     │  CMS router (new)    │   │
                     │   │  GET/POST /cms/*    │  events, photos,     │   │
                     │   │                     │  agent config, login │   │
                     │   │                     └──────────┬───────────┘   │
                     │   │                                 │ writes        │
                     │   │                                 ▼               │
                     │   │              ┌───────────────────────────────┐ │
                     │   │              │   SQLite (LocalStore, +4 new  │ │
                     │   │              │   tables: event, active_event,│ │
                     │   │              │   event_photo, agent_config)  │ │
                     │   │              └───────────────┬───────────────┘ │
                     │   │                               │ reads           │
  Room-screen TV ────┼──►│  ┌──────────────┐   ┌─────────▼───────────┐   │
  (DISPLAY_IP_       │   │  │ IP gate       │──►│ DisplayServer        │   │
   WHITELIST)         │   │  │ (existing)    │   │ buildSnapshot() ext. │   │
                     │   │  └──────────────┘   │ + justCaptured        │   │
                     └──►│  GET /display-screen │ (computed from        │   │
                         │  WS  /display         │  event_photo, TTL)    │   │
                         │                       └──────────┬────────────┘  │
                         │                                  │ pushes on WS  │
                         │                                  ▼               │
                         │                         (room-screen browser,    │
                         │                          inline JS renders it)   │
                         │                                                │
  Booth PC (Agent) ─────►│  ┌──────────────┐                              │
  Authorization: Bearer  │  │ AgentServer   │◄── config_request ──────────┤
                         │  │ (existing +   │──► config / reload_config ──┤
                         │  │  new branches)│                              │
                         │  └───────┬───────┘                              │
                         │          │ onFileUpload()                       │
                         │          ▼                                      │
                         │   writes event_photo row (D-10, keyed by jobId, │
                         │   guest name via getJobRegistration())          │
                         └─────────────────────────────────────────────────┘
```

### Recommended Project Structure

```
mirror-request/src/
├── cms/
│   ├── cmsRouter.ts        # createCmsRouter(store, agentServer, config) — routes below
│   ├── cmsAuth.ts          # session store, login/logout, hashPassword/verifyPassword,
│   │                       # requireSession() middleware
│   ├── cmsPages.ts         # inline-HTML template strings (login, dashboard, event form,
│   │                       # photo history, agent config) — sibling of displayPage.ts
│   └── uploadHandler.ts    # base64-JSON body -> magic-byte validation -> server-generated
│                            # filename -> write outside src/, GET /uploads/:filename route
├── display/
│   ├── displayServer.ts    # buildSnapshot() extended: event config fields + justCaptured
│   └── displayPage.ts      # extended to read event-config fields (font, colors, copy)
├── agent/
│   └── agentServer.ts      # + config_request/reload_config branches, sendEvent() reused
├── state/
│   └── localStore.ts       # + event, active_event, event_photo, agent_config tables
assets/
└── fonts/                   # be-vietnam-pro-{400,700}.woff2, lora-{400,700}.woff2, OFL.txt
```

### Pattern 1: Router-as-factory, IP-gate-then-session middleware chain

**What:** `createCmsRouter(deps)` returns an `express.Router`; `index.ts` mounts it with
`app.use('/cms', cmsIpGate, cmsRouter)`. The router itself applies `requireSession` to every
route except `/login` (GET+POST) and static asset routes.

**When to use:** Exactly the shape `createStatusRouter()` already uses
(`src/status/statusRoute.ts:1-50`, verified read this session) — narrow injected interfaces
(`StatusQueue`, `StatusAgent`) rather than the full concrete classes, so CMS routes can be
tested with a supertest `app` and a temp-file `LocalStore`, no WebSocket server needed —
exactly `test/display-access-control.test.ts`'s pattern (verified read this session,
`uniqueStorePath()`/`makeStore()`/`makeMockQueue()`/`makeMockAgent()` helpers already exist
and are directly reusable for CMS route tests).

**Example (IP gate, new file, do not touch `ipAllowlist.ts`'s existing exports):**
```typescript
// src/cms/cmsIpGate.ts — a NEW middleware factory, deliberately not a refactor of the
// existing inline check at index.ts:43-50 (Phase 5's own code stays untouched, matching
// this project's established phase-boundary discipline — see ipAllowlist.ts's own header
// comment: "reimplemented here as plain exported functions rather than imported").
import { Request, Response, NextFunction } from 'express';
import { clientIp, isWhitelisted } from '../security/ipAllowlist';
import logger from '../logging/logger';

export function createCmsIpGate(whitelist: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = clientIp(req);
    if (!isWhitelisted(ip, whitelist)) {
      logger.warn(`Blocked /cms from non-whitelisted IP: ${ip}`);
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}
```

### Pattern 2: `justCaptured` computed from the newest `event_photo` row, not pushed

**What:** `DisplayServer.buildSnapshot()` queries the single most recent `event_photo` row
for the active event and compares `Date.now() - capturedAt` against an injected
`heroMomentDurationMs` constant; returns `{ photoUrl, name }` while inside the window, `null`
after.

**When to use:** Always — this is the direct answer to Pitfall 1 below, and it is the
"next-snapshot" option CONTEXT explicitly permits ("How `justCaptured` is cleared (timer vs.
next-snapshot) as long as D-09's behaviour holds").

**Example (extends the exact function read this session, `displayServer.ts:119-142`):**
```typescript
// Constructor gains: private heroMomentDurationMs: number (default e.g. 12_000,
// injected per the Phase 2 constructor-injection convention, not read from a
// singleton at call time).
private buildSnapshot(): DisplaySnapshot {
  // ...unchanged upNextRaw/announcement/guestName/upNext logic...
  const activeEventId = this.store.getActiveEventId();
  const recentPhoto = activeEventId ? this.store.getMostRecentEventPhoto(activeEventId) : undefined;
  const justCaptured =
    recentPhoto && Date.now() - recentPhoto.capturedAt < this.heroMomentDurationMs
      ? { photoUrl: recentPhoto.photoUrl, name: recentPhoto.guestName }
      : null;

  return {
    // ...existing fields unchanged...
    justCaptured,
  };
}
```
This is evaluated on every `maybeBroadcast()` poll tick exactly like `countdownSeconds`
already is (`displayServer.ts:144-153`'s own comment: "No separate 1 Hz countdown timer is
needed... recomputed from the announcement's end time on every evaluation") — the serialized-
diff guard at `maybeBroadcast()` (`msg === this.lastSent`) means `justCaptured` produces
exactly two broadcasts per capture (appear, then disappear after the TTL), never a thrash,
because nothing else in the JSON changes on the polling ticks in between.

### Pattern 3: Agent config pull/reload — reuse `sendEvent()`, add two message branches

**What:** No new WS send primitive is needed. `AgentServer.sendEvent(payload: { type:
string; data?: unknown })` (`agentServer.ts:178-182`, verified read this session) is already
fully generic — `sendEvent({ type: 'config', data: safeFields })` and
`sendEvent({ type: 'reload_config' })` both fit its existing signature with zero change to
that method.

**When to use:** `AgentServer`'s `ws.on('message', ...)` handler
(`agentServer.ts:107-134`) gains one new `else if (type === 'config_request')` branch,
mirroring the existing `ack`/`event`/`heartbeat` branches exactly; a new
`registerConfigRequestHandler(fn)` seam (mirroring `registerAckHandler`/`registerEventHandler`
at `agentServer.ts:30-32`) lets `index.ts` wire the handler that reads/writes `agent_config`.

**Example (Agent side, `dslrbooth-agent/src/index.ts`'s `ws.onMessage` handler, extending
the exact `if (msg.type === 'announcement') {...}` / `if (msg.type !== 'command') return`
chain read this session at lines 52-92):**
```typescript
ws.onMessage(async (msg) => {
  if (msg.type === 'config') {
    const data = (msg.data ?? {}) as Partial<{
      logLevel: string; autoOpenDisplay: boolean;
      dslrBoothApiPort: number; dslrBoothPassword: string;
    }>;
    mutableSafeConfig.apply(data); // updates in-memory only — never process.env, never .env
    logger.info('Applied config update from Extension Service');
    return;
  }
  if (msg.type === 'reload_config') {
    ws.send({ type: 'config_request' }); // re-request per D-17's literal round trip
    return;
  }
  if (msg.type === 'announcement') { /* ...unchanged... */ }
  // ...unchanged command branch...
});

// On connect (ws.onStatusChange('connected') handler), send the initial pull:
ws.onStatusChange((status) => {
  if (status === 'connected') {
    ws.send({ type: 'config_request', current: mutableSafeConfig.snapshot() });
  }
});
```
`mutableSafeConfig` is a small new module wrapping the 4 safe fields with a live getter each
consumer reads at call time — this is the one real production code change `DslrBoothClient`
needs (see Pitfall 4 below), because its `port`/`password` are `readonly` constructor
parameters today and cannot be live-updated without this change.

### Anti-Patterns to Avoid

- **Server pushing `{type:'config', data}` directly on save, skipping the round trip:** D-17's
  literal wording is "the service sends a reload command and the Agent re-requests" — a plan
  that "simplifies" this to a direct push changes the protocol's failure semantics (a push
  that arrives while the Agent is mid-reconnect has nowhere reliable to land; a pull the Agent
  initiates always has a live socket to answer on) and would silently deviate from a locked
  decision.
- **`express.static()` for `/uploads`:** correct for `/fonts` (trusted, build-time, immutable)
  but wrong for guest/operator-uploaded assets — `express.static` serves whatever extension
  is on disk with a MIME type derived from that extension, which is exactly the CMS-05
  mechanism (`.svg`/`.html` served from the uploads directory, browser executes it). Use a
  hand-rolled route that looks up the **validated** MIME type recorded at upload time (or
  re-sniffs magic bytes) and serves a **fixed, allow-listed** `Content-Type` — never trust the
  extension on disk for a user-supplied file.
- **Storing the CMS password in `.env` as plaintext even temporarily:** D-14 requires the
  `.env` value itself be a hash. Provide a one-off helper script (`npm run cms:hash-password`
  or similar) so the operator generates `CMS_PASSWORD_HASH` offline rather than the service
  ever seeing/logging the plaintext.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Password hashing | A custom KDF, or plaintext + "obfuscation" | Node builtin `crypto.scryptSync` (OWASP-endorsed fallback when Argon2id is unavailable) | Hand-rolled hashing is the single most common source of credential-storage vulnerabilities; Node's implementation is maintained by the OpenSSL/Node security team, not this project |
| Multipart file parsing | A hand-rolled MIME-boundary parser | Base64-in-JSON via existing `express.json()` (recommended) or, if multipart UX is preferred, `multer@^2.2.0` (patched line) | Multipart parsing has produced multiple real CVEs even in a widely-used, actively-maintained library (`multer`); a from-scratch parser in this codebase would be strictly higher risk, not lower |
| Timing-safe comparison | `===` or `String.prototype.localeCompare` on secrets | `crypto.timingSafeEqual` (already the in-repo idiom, `agentServer.ts:46-57`) | `===` on strings short-circuits on the first mismatched byte, leaking timing information about how many leading bytes were correct |
| Magic-byte image sniffing | A hand-rolled byte-signature table (acceptable actually, see below) | — | This one is small and low-risk enough to hand-roll deliberately: PNG (`89 50 4E 47 0D 0A 1A 0A`), JPEG (`FF D8 FF`), GIF (`47 49 46 38`), WEBP (`RIFF....WEBP`, bytes 0-3 `RIFF` + bytes 8-11 `WEBP`) are four fixed, well-documented signatures — a ~15-line function, not a library-shaped problem. Do not add an npm image-type-sniffing package for four signatures. |

**Key insight:** the two things this phase must NOT hand-roll (password hashing, timing-safe
comparison) both already have a proven in-repo idiom from Phase 3's Agent-auth work
(`agentServer.ts:46-57`) — copy that shape rather than reinvent it. The two things that ARE
fine to hand-roll (magic-byte sniffing, base64 upload parsing) are fine specifically because
they are small, fixed, and auditable in a few lines — the general rule ("don't hand-roll
security-critical parsing") does not forbid a 15-line closed-form check, only an
open-ended parser.

## Runtime State Inventory

> This is not a rename/refactor phase for the Extension Service side, but `web-slide`'s
> retirement (D-05/D-06/D-08) is a live-cutover phase for that surface, so this inventory is
> included for that half.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | `web-slide`'s `const customers = []` (server.js:39) — **in-memory only, already lost on every restart today**; nothing to migrate out of it, since D-10's new `event_photo` table starts empty and is populated going forward from real captures, not backfilled from `web-slide`'s RAM | None — no migration needed, the source of truth being retired never had durable data |
| Live service config | None found — `web-slide` has no external config store beyond its own `.env`/hardcoded values (`server.js` constants); nothing in a UI-managed external service references `web-slide` by name (no n8n/Datadog/Tailscale integration exists in this repo's scope) | None |
| OS-registered state | `web-slide` is presumably a standalone PM2/systemd process today (not verified this session — the repo does not contain its process-manager config) — **the planner must confirm how `web-slide` is currently started/supervised in production and add a task to stop that supervision as part of D-06's cutover**, or the retired process will auto-restart after the new route is live | Flagged as a genuine gap — could not verify from source alone; needs an operator-facing runbook step, likely a `checkpoint:human-verify` at the phase gate mirroring Phase 6/7's precedent |
| Secrets/env vars | `web-slide` likely has its own `PORT`/upload-dir env vars, none of which are referenced by `mirror-request`'s `.env` — no key rename needed | None |
| Build artifacts | None — `web-slide` is plain Node, no compiled/installed-package artifact outside `node_modules` | None |

## Common Pitfalls

### Pitfall 1: `justCaptured` broadcast-loop thrash or never-clears

**What goes wrong:** A naive implementation stores `justCaptured` as a field set once (e.g.
by a callback from `queueService.onFileUpload()`) and cleared by a `setTimeout` inside
`DisplayServer`. Two failure modes: (a) if the clear is a separate timer independent of the
poll loop, a race between the timer firing and `maybeBroadcast()`'s 250ms tick can leave a
stale `justCaptured` visible for up to one extra poll interval, or worse, the timer callback
mutates state but nothing calls `maybeBroadcast()` immediately, so the guest actually sees a
5-15s extra delay before the hero moment visibly ends, only correcting itself on the *next*
scheduled tick, not immediately, and if `DisplayServer` is ever restarted mid-hero-moment the
timer is lost and the field never clears at all (stuck forever) unless recomputed from
persisted state.

**Why it happens:** The existing `announcementEndsAt`/`countdownSeconds` fields already solve
this exact class of problem by being *computed* from a stored end-timestamp on every
evaluation, not pushed once and cleared by a separate timer. A `justCaptured` implementation
that doesn't follow that precedent reinvents a bug this codebase already fixed once.

**How to avoid:** Store only `capturedAt` (a timestamp) durably (in `event_photo`, which
D-10 already requires); compute `justCaptured` freshly inside `buildSnapshot()` every tick by
comparing `Date.now() - capturedAt` to the injected TTL, exactly as Pattern 2 above shows.
This also survives a `DisplayServer`/process restart correctly — `event_photo`'s persisted
`captured_at` means a restart mid-hero-moment either still shows the hero (if still inside
the TTL) or correctly shows nothing (if the TTL already elapsed), with no separate in-memory
timer to lose.

**Warning signs:** Any implementation with `setTimeout(() => { this.justCaptured = null; },
heroDurationMs)` inside `DisplayServer` is the anti-pattern — flag it in review.

### Pitfall 2: Reusing `DISPLAY_IP_WHITELIST` for the CMS

**What goes wrong:** D-13 says "reuse the existing `isWhitelisted()` machinery" — a plan
could misread this as "reuse the `DISPLAY_IP_WHITELIST` *value*," gating the CMS with the
same list of TV addresses. That either locks the operator's laptop out (if the TV network and
operator network are genuinely different, which the phase description explicitly frames them
as — "operator laptop vs TV") or, worse, opens the CMS to every address that can reach a TV,
which is a much larger and less-trusted set of endpoints than "the operator's own laptop."

**Why it happens:** D-13's phrasing is about the *algorithm* (`isWhitelisted()`), not the
*value* — easy to conflate the two when skimming.

**How to avoid:** Add a new `CMS_IP_WHITELIST` config key, following the exact
production-required-validation pattern `DISPLAY_IP_WHITELIST` already uses (`config.ts:63,
71-73`, verified read this session — empty-array dev default, `isProduction &&
cmsIpWhitelist.length === 0` fail-fast). Reuse the `isWhitelisted(ip, whitelist)` *function*
against this new, independent list.

**Warning signs:** A plan or PR that adds zero new config keys for CMS network access control
is very likely reusing the wrong list.

### Pitfall 3: Session cookie posture on a LAN with no TLS

**What goes wrong:** Setting `Secure: true` on the session cookie on a deployment that has no
TLS termination anywhere (verified: nothing in `mirror-request/src/` sets up HTTPS, and
OPS-RUNBOOK.md's known deployment story is PM2/Docker on a LAN) means the browser silently
refuses to ever send the cookie over plain HTTP, and the operator can never actually log in —
a "secure-by-default" setting that produces a total, confusing outage.

**Why it happens:** `Secure` is usually reflexive best practice, but it is contingent on TLS
actually terminating somewhere in the request path, which this deployment does not have.

**How to avoid:** Do not set `Secure` on the cookie given the current deployment reality;
document this honestly as an accepted LAN-only risk (the session cookie is visible to
anyone who can passively observe LAN traffic between the operator's laptop and the server) —
this is the same risk class D-13's IP-allowlist layer already exists to bound (only
whitelisted LAN addresses can reach the CMS at all), so the residual exposure is to other
devices *already on the trusted LAN segment*, not the open internet. If TLS is ever added in
front of this service, `Secure` should be added at that time — flag this explicitly as a
carried-forward follow-up, not a silent gap.

**Warning signs:** A cookie flag audit that finds `Secure: true` shipped alongside a login
that "just doesn't work" in manual testing is this exact bug.

### Pitfall 4: `DslrBoothClient`'s config fields are captured once, at construction

**What goes wrong:** `dslrbooth-agent/src/dslrbooth/client.ts:9-13` (verified read this
session):
```
export class DslrBoothClient {
  constructor(
    private readonly port: number,
    private readonly password: string,
  ) {}
```
`readonly` constructor parameters mean a config-reload message that updates
`dslrBoothApiPort`/`dslrBoothPassword` in some other module has **no effect** on the already-
constructed `DslrBoothClient` instance used by `index.ts`'s `start_session` handler — the
Agent will silently keep using its boot-time port/password forever, defeating UI-02, with no
error or warning anywhere.

**Why it happens:** This class predates the phase and was never designed to be
reconfigurable; the `readonly` modifier is exactly correct for a value that truly never
changes, which was a valid assumption until this phase.

**How to avoid:** Either (a) drop `readonly` and add an `updateCredentials(port, password)`
method the config-reload handler calls, or (b) reconstruct the `DslrBoothClient` instance
whenever the safe fields update (simpler, fewer moving parts, and matches CLAUDE.md's "Agent
decides nothing" — the reload handler doesn't decide, it just replaces a value holder). Either
way, this is a real, load-bearing production code change this phase must make on the Agent
side — do not scope UI-02 as "wiring only."

**Warning signs:** A plan that touches only `index.ts`'s message handler and never
`client.ts` has not actually made `dslrBoothApiPort`/`dslrBoothPassword` remotely editable —
verify by testing a config update actually changes which port `startSession()` calls.

### Pitfall 5: `logDir` — the Agent's 8th config field is unclassified by D-16

**What goes wrong:** D-16 names exactly 7 of the Agent's 8 config fields (4 safe:
`logLevel`, `autoOpenDisplay`, `dslrBoothApiPort`, `dslrBoothPassword`; 3 forbidden:
`extensionServiceWsUrl`, `extensionServiceWsToken`, `triggerServerPort`) and cites "8 fields"
as its source count. Reading `dslrbooth-agent/src/config.ts:1-10` directly
(**[VERIFIED: dslrbooth-agent/src/config.ts:1-10]**, quoted verbatim below) confirms the
`Config` interface really does have 8 members, and `logDir` is not among either named group:

```typescript
export interface Config {
  extensionServiceWsUrl: string
  extensionServiceWsToken: string
  dslrBoothApiPort: number
  dslrBoothPassword: string
  triggerServerPort: number
  logLevel: string
  logDir: string
  autoOpenDisplay: boolean
}
```

A plan that silently invents a classification for `logDir` (either exposing it or hiding it)
is making a decision D-16 does not actually cover.

**Why it happens:** D-16's prose enumerates two groups totalling 7 and says "8 fields" as a
citation of the interface's total size, without accounting for the 8th by name — most likely
an oversight during the discuss-phase session, not a deliberate omission.

**How to avoid:** Flag this explicitly for the planner (see Assumptions Log, A1). This
research's recommendation, offered as a default rather than a locked decision: treat `logDir`
as **read-only** alongside the 3 forbidden fields, on the reasoning that (a) it is
filesystem-path configuration, closer in kind to the bootstrap/infra fields than to the
operational-tuning fields, and (b) the safest default when a decision is genuinely unmade is
the more restrictive one — remotely editing where the Agent writes its logs has no obvious
operator-facing benefit this phase's UI-SPEC anticipates (no `logDir` field appears anywhere
in `08-UI-SPEC.md`'s CMS Agent-config surface), while getting it wrong (e.g. an operator
typing an unwritable path) can silently blackhole all future Agent logs.

## Code Examples

Verified patterns from in-repo sources:

### SQLite schema additions (`localStore.ts` `bootstrap()`, all `CREATE TABLE IF NOT EXISTS`)

```typescript
// Source: mirror-request/src/state/localStore.ts:22-102 (verified read this session) —
// pattern matched exactly: IF NOT EXISTS in bootstrap(), new columns only via migrate().
CREATE TABLE IF NOT EXISTS event (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  logo_url      TEXT,
  background_url TEXT,
  color_dominant TEXT,
  color_secondary TEXT,
  color_accent  TEXT,
  color_text    TEXT,
  color_text_muted TEXT,
  font_choice   TEXT NOT NULL DEFAULT 'system-ui',
  idle_heading  TEXT,
  idle_sub      TEXT,
  qr_image_url  TEXT,
  qr_cta_text   TEXT,
  photo_count   INTEGER,
  photo_duration_ms INTEGER,
  layout_style  TEXT NOT NULL DEFAULT 'stage_sidebar',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- D-01: single-row active-event pointer, same CHECK(id=1) idiom as booth_state
-- (localStore.ts:66-70: "CREATE TABLE IF NOT EXISTS booth_state (id INTEGER
-- PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL DEFAULT 'IDLE', ...)").
CREATE TABLE IF NOT EXISTS active_event (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  event_id TEXT,
  updated_at TEXT NOT NULL DEFAULT 'now'
);

-- D-10: keyed by jobId (natural key — onFileUpload()'s own comment establishes
-- "exactly one print composite exists per session", so no separate surrogate
-- key or duplicate-row concern).
CREATE TABLE IF NOT EXISTS event_photo (
  jobId      TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL,
  guest_name TEXT NOT NULL,
  photo_url  TEXT NOT NULL,
  captured_at INTEGER NOT NULL
);

-- D-18: single-row, current + previous, mirroring active_event's shape.
CREATE TABLE IF NOT EXISTS agent_config (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  current_json TEXT NOT NULL,
  previous_json TEXT,
  updated_at   TEXT NOT NULL DEFAULT 'now'
);
```

### Photo-history write site (`queueService.ts`'s `onFileUpload()`)

```typescript
// Source: mirror-request/src/queue/queueService.ts:913-973 (verified read this
// session). Both success branches — the ordinary 'awaiting' resolve at :970
// and the late-but-legitimate 'expired' resolve at :959 — are real captures
// and both must write event_photo; only the D-04 "no slot was ever opened"
// branch (:944) and the D-11 duplicate/replay no-op (:962/:972 false-return)
// must NOT write a row.
if (this.store.resolvePendingPrint(jobId, Date.now())) {
  const registration = this.store.getJobRegistration(jobId)?.registration; // types.ts:5, "name: string"
  const activeEventId = this.store.getActiveEventId();
  if (activeEventId && registration) {
    this.store.recordEventPhoto({
      jobId, eventId: activeEventId,
      guestName: registration.name, photoUrl, capturedAt: Date.now(),
    });
  } else {
    queueLogger.warn(`Print upload for ${jobId} resolved but no active event — photo not recorded to history`);
  }
  void this.sendNotification(jobId, photoUrl);
}
```

### Node builtin password hashing (no new dependency)

```typescript
// crypto.scryptSync's default `maxmem` (32MB) is TOO SMALL for OWASP's
// recommended N=2^17 — [VERIFIED: direct `node -e` execution this session]:
//   crypto.scryptSync('pw','salt',64,{N:131072,r:8,p:1})
//   -> throws "Invalid scrypt params: ... memory limit exceeded"
//   crypto.scryptSync('pw','salt',64,{N:16384,r:8,p:1})  -> succeeds (64-byte key)
// Recommendation: N=16384 (2^14), r=8, p=1 — fits the default maxmem with no
// extra option, and is a defensible trade-off for a single LAN-only, IP-
// allowlisted, non-internet-facing account (OWASP's 2^17 target assumes an
// internet-exposed, high-value credential store).
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
```

## State of the Art

| Old Approach (web-slide) | Current Approach (this phase) | When Changed | Impact |
|--------------------------|-------------------------------|---------------|--------|
| Guests held in `const customers = []`, RAM only, capped at 50, lost on restart | SQLite `event_photo` table, unbounded (D-11: no auto-expiry), survives restart | This phase (CMS-03) | Photo history is now durable and queryable per event |
| `index.html` listens to its own SSE `/events`, never `WS /display` | Room screen consumes `WS /display` exclusively — one feed that knows the queue | This phase (D-05, success criterion 5) | Eliminates the "two feeds reach one screen, the wired-up one knows nothing" split the phase exists to close |
| No auth on `web-slide` at all (briefly, and now `trustedOnly` IP-only) | Two-layer IP-allowlist + password session on `/cms` | This phase (CMS-04, D-13/D-14) | Closes CMS-05's exposure class permanently rather than patching one route |
| Anonymous uploads, extension-derived filenames, arbitrary extension served via `express.static` | Authenticated, magic-byte-validated, server-generated filenames, fixed-Content-Type hand-rolled serving route, `.svg` explicitly excluded | This phase (D-15) | Closes the stored-XSS-via-uploaded-file class of vulnerability CMS-05 documents |
| Agent config only editable by hand-editing `.env` on the physical booth PC | 4 of 8 fields remotely editable via CMS, pull-based over the existing WS link | This phase (UI-02, D-16/D-17) | Removes the "someone must walk to the booth" step for routine config changes, while explicitly preserving it for the 3 bootstrap-credential fields where that physical step is a deliberate safety property, not a limitation |

**Deprecated/outdated:**
- `web-slide/` as a deployed process: retired outright per D-05/D-06, kept in git only as
  layout reference (D-08).
- `NOTIFY_WEBHOOK_URL` feeding the room screen: no longer does so (D-04) — its remaining role
  is guest photo delivery + third-party integration, unchanged from Phase 4.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `logDir` (the Agent's 8th config field) should default to **read-only/forbidden** alongside the 3 named-forbidden fields, since D-16 does not classify it | Pitfall 5, `Standard Stack`/`Code Examples` (config message shape) | Low-to-medium — if the planner or a future session decides `logDir` should instead be safely editable, only the CMS form and the `config`/`data` message shape need a one-field addition; no schema or protocol redesign. The risk of the wrong DEFAULT (read-only) is near-zero; the risk of silently making it editable without a human decision is a possible-but-unlikely booth outage (unwritable log path) with no clear operator benefit anticipated by the UI-SPEC. |
| A2 | Session tokens should be stored **in-memory** (a `Map`), not a new SQLite table, since CMS-03 explicitly names "config and photo history" surviving restart, not sessions | `Standard Stack` intro, Pattern 1 | Low — if a persistent CMS session store turns out to be desired (e.g. operator dislikes re-logging-in after every deploy), adding a `cms_session` table later is a small, additive, non-breaking change; nothing else in this design depends on sessions being in-memory specifically. |
| A3 | `multer` should be avoided in favor of a base64-JSON upload body, given its 2025-2026 DoS advisory history in the multipart parser specifically | `Standard Stack` (Alternatives Considered), `Don't Hand-Roll` | Low-medium — this is a defensible engineering judgment call, not a fact; a planner who prefers conventional multipart UX and is comfortable pinning `multer@^2.2.0` (patched) can reasonably choose that path instead. Flagged as `[CITED]`, not `[VERIFIED]`, because the CVE details were sourced from a web search summary, not read directly from the GitHub advisory database. |
| A4 | Font sourcing recipe (Google Fonts CSS2 API → extract `@font-face` blocks → download referenced `.woff2` → self-host) is accurate and current | `Standard Stack`, `Common Pitfalls` area (implied), font bundling guidance | Low — this is a well-established, widely-documented technique (`[CITED: web search, dev.to/zarino/wildandfreetools self-hosting guides, 2026-08-12]`), not independently executed this session (no font files were actually downloaded/verified). The executor must actually perform this fetch and verify Vietnamese diacritic glyphs render (Đ, ơ, ư, combining tone marks) before shipping — do not assume the CSS2 API's Vietnamese-subset coverage without checking the rendered result. |
| A5 | `web-slide`'s production process-supervision mechanism (PM2/systemd/manual) is unknown from source alone, so D-06's "turn `web-slide` off" cutover step cannot be fully specified by this research | `Runtime State Inventory` | Medium — if the planner does not add an explicit task to identify and stop whatever currently keeps `web-slide` running, the retired process may auto-restart and continue serving stale content on `:3001` after the new route ships, confusing anyone still pointed at the old URL during the manual TV-by-TV cutover (D-06). |

**If this table is empty:** N/A — five assumptions logged above, all flagged for planner
confirmation before being treated as locked.

## Open Questions

1. **CMS event → Room Screen URL contract (CMS-02) — explicitly left to the planner by
   CONTEXT itself (Open Q4).**
   - What we know: D-12 makes this mostly moot for the *room screen's own behavior* — every
     TV opens the identical URL (`/display-screen`) and renders whatever event is active,
     with no per-screen identity or slug. What remains open is purely the CMS's own
     "copyable Screen URL" affordance (UI-SPEC's locked visual requirement) — what string
     does the CMS show the operator to paste into a TV's browser?
   - What's unclear: whether that string is simply the bare `/display-screen` URL (since
     D-12 says there is no per-event distinction at the URL level at all — every event uses
     the exact same URL, and switching the active event in the CMS is what changes what
     that URL renders) or something more elaborate.
   - Recommendation: given D-12's "no identity of their own" is unconditional, the simplest
     and most consistent answer is that the "copyable Screen URL" the CMS shows is just the
     one fixed `/display-screen` URL, identical for every event — the CMS UI's "copy" action
     exists mainly so an operator setting up a *new* TV doesn't have to remember or type the
     path, not because the URL varies per event. This keeps CMS-02's requirement ("each
     screen knows which event it belongs to") true entirely through the server-side active-
     event pointer, never through URL structure — matching D-12 exactly. Flag this
     recommendation for the planner to confirm or override, since CONTEXT deliberately left
     it open rather than locking it.

2. **`web-slide`'s current production process supervision.**
   - What we know: nothing in this repo's source describes how `web-slide/server.js` is
     started/kept-alive in production (no PM2 ecosystem file, no systemd unit, no Docker
     compose file found in the paths read this session).
   - What's unclear: whether stopping it is a one-command operator action or requires
     locating an out-of-repo supervisor config.
   - Recommendation: add an explicit task at the phase gate (mirroring Phase 6/7's precedent
     of a blocking `checkpoint:human-verify`/`checkpoint:decision` for anything requiring
     live-system knowledge this repo's source can't answer) asking the operator how
     `web-slide` is currently supervised, before D-06's cutover step is executed.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js 20.x runtime | Both repos (`engines.node`) | ✓ (verified: `node --version` → v24.15.0 on this dev machine, satisfies `>=20`; production target is stated as Node 20 LTS) | 20.x (prod target) / v24.15.0 (this session's shell) | — |
| Node builtin `crypto` (scryptSync/timingSafeEqual/randomBytes/randomUUID) | Password hashing, session tokens, event ids | ✓ (verified this session via direct `node -e` execution) | builtin | — |
| better-sqlite3 | All 4 new tables | ✓ (already an installed dependency, ^11.0.0) | ^11.0.0 | — |
| express | CMS router, upload body parsing | ✓ (already installed, ^4.21.1) | ^4.21.1 | — |
| Font source files (`.woff2` for Be Vietnam Pro / Lora, weights 400+700) | Room Screen CMS-01 font picker | ✗ — not present in this repo; must be fetched by the executor | — | Fetch via Google Fonts CSS2 API and self-host (see Assumption A4); until fetched, ship `system-ui` as the only available option and treat the other two as a fast-follow, since `system-ui` is already the locked default (UI-SPEC) |
| TLS termination | `Secure` cookie flag | ✗ — no TLS anywhere in this deployment's known topology (Pitfall 3) | — | Ship without `Secure`; document the accepted LAN-only residual risk |

**Missing dependencies with no fallback:** none — every gap above has a stated fallback.

**Missing dependencies with fallback:** font files (fallback: ship `system-ui` only until
fetched — this is already the correct default per UI-SPEC, not a degraded state); TLS
(fallback: document the accepted risk, matching D-13's existing posture).

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest ^2.1.4 (both repos — `mirror-request/package.json`, `dslrbooth-agent/package.json`, both verified read this session) |
| Config file | `mirror-request`: none found (vitest defaults); `dslrbooth-agent`: `vitest.config.ts` (verified read this session — `include: ['test/**/*.{test,spec}.?(c|m)[jt]s?(x)']`) |
| Quick run command | `cd mirror-request && npx vitest run test/<file>.test.ts` / `cd dslrbooth-agent && npx vitest run test/<file>.test.ts` |
| Full suite command | `cd mirror-request && npm test` (baseline verified this session: **43 files / 448 tests, green**); `cd dslrbooth-agent && npm test` (baseline: **1 test file, 4 tests**, `test/connection-auth.test.ts`, verified read/counted this session) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| UI-01 | `/display-screen` renders the idle state before any registration exists | integration (supertest, mirroring `test/display-access-control.test.ts`'s pattern — `makeStore()`, no registrations inserted) | `npx vitest run test/display-idle-default.test.ts -t "idle"` | ❌ Wave 0 |
| UI-02 | Agent applies a config update in memory; forbidden fields rejected/read-only; `DslrBoothClient` actually uses the new port/password | unit (Agent side, mocked `ws`, mirroring `test/connection-auth.test.ts`'s `vi.mock('ws', ...)` pattern) + unit (server side, `agentServer.ts` new branches) | `cd dslrbooth-agent && npx vitest run test/config-reload.test.ts`; `cd mirror-request && npx vitest run test/agent-config-message.test.ts` | ❌ Wave 0 (both repos) |
| CMS-01 | Event config CRUD; every field has a working default (empty event still renders) | integration (supertest against CMS router + temp-file `LocalStore`) | `npx vitest run test/cms-event-config.test.ts` | ❌ Wave 0 |
| CMS-02 | Switching active event updates every connected screen; "N guests waiting" warn is shown | integration (WS client against a live `DisplayServer`, mirroring `test/agent-websocket.test.ts`'s live-socket pattern) | `npx vitest run test/cms-active-event-switch.test.ts` | ❌ Wave 0 |
| CMS-03 | Event config + `event_photo` rows survive a `LocalStore` close/reopen against the same temp file | unit (extends `test/local-store-persistence.test.ts`'s existing `beforeEach`/`afterEach` temp-file harness, verified read this session at lines 14-26) | `npx vitest run test/local-store-persistence.test.ts -t "event"` | ⚠️ extend existing file, not new |
| CMS-04 | `/cms/*` refuses a non-whitelisted IP (403) and refuses a missing/invalid session (redirect/401), independent of each other | integration (supertest, mirroring `test/display-access-control.test.ts`'s IP-gate test shape) | `npx vitest run test/cms-access-control.test.ts` | ❌ Wave 0 |
| CMS-05 (regression, not new work) | Upload route rejects a `.svg`/`.html` payload even with a spoofed `image/png` header, by magic-byte content | unit (mirrors `test/queue-file-upload-print.test.ts`'s fixture-driven style) | `npx vitest run test/cms-upload-validation.test.ts` | ❌ Wave 0 |
| D-09 (hero moment) | `justCaptured` appears immediately after a resolved print upload, and clears itself after the injected TTL, without a separate timer | unit (`DisplayServer` constructed with injected `heroMomentDurationMs`, mirroring `AgentServer`'s `heartbeatIntervalMs` constructor-injection test pattern at `test/agent-heartbeat-timeout.test.ts`) | `npx vitest run test/display-hero-moment.test.ts` | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** the specific new/modified test file(s) via `npx vitest run <file>`.
- **Per wave merge:** full suite in both repos (`npm test` in `mirror-request` AND in
  `dslrbooth-agent` — this is the **first phase to modify the Agent repo since Phase 3**, so
  do not skip the Agent-side full run even though most of this phase's work lands in
  `mirror-request`).
- **Phase gate:** both full suites green before `/gsd-verify-work`; re-confirm the
  `mirror-request` baseline (43/448) and `dslrbooth-agent` baseline (1 file/4 tests) grew,
  never shrank, and that `dbPoller.ts`/`queue_job` schema/`booth_state` schema remain
  byte-identical to their pre-phase baselines (per D-01's explicit "queue/booth_state not
  touched" boundary — this is directly checkable via `git diff --name-only` on those files).

### Wave 0 Gaps

- [ ] `test/cms-access-control.test.ts` — covers CMS-04 (IP gate + session gate, independent)
- [ ] `test/cms-event-config.test.ts` — covers CMS-01
- [ ] `test/cms-active-event-switch.test.ts` — covers CMS-02, D-02's warn-on-switch
- [ ] `test/cms-upload-validation.test.ts` — covers CMS-05 regression (magic-byte, extension
      exclusion, size cap, server-generated filename)
- [ ] `test/display-idle-default.test.ts` — covers UI-01
- [ ] `test/display-hero-moment.test.ts` — covers D-09/Pitfall 1
- [ ] `test/agent-config-message.test.ts` (mirror-request side) — covers UI-02/D-16/D-17
      server-side message branches
- [ ] `dslrbooth-agent/test/config-reload.test.ts` — covers UI-02/D-17 Agent-side in-memory
      application, and Pitfall 4's `DslrBoothClient` mutability fix specifically
- [ ] Extend `test/local-store-persistence.test.ts` with `event`/`active_event`/
      `event_photo`/`agent_config` migration-idempotency cases, following the file's own
      existing `beforeEach`/`afterEach` temp-file pattern — no new test file needed, this is
      an addition to an existing one
- [ ] No new framework install needed in either repo — vitest is already present and
      configured

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Single-account password login, `scryptSync` hash storage, `timingSafeEqual` verification (Node builtin `crypto`, no hand-rolled comparison) |
| V3 Session Management | yes | HttpOnly cookie carrying a `crypto.randomBytes(32)` opaque token; server-side session-token store (in-memory, per Assumption A2); no `Secure` flag given the LAN/no-TLS reality (Pitfall 3, documented residual risk); no auto-timeout by explicit design (D-14) |
| V4 Access Control | yes | Two independent layers per D-13: `CMS_IP_WHITELIST` (network-level) then session cookie (identity-level); the two layers must be independently testable (see CMS-04's test-map row: "independent of each other") |
| V5 Input Validation | yes | Magic-byte content sniffing for uploads (not extension/MIME-header trust); `maxlength` caps on every CMS text input (UI-SPEC G3); size cap (~5MB) enforced both on the base64 payload's decoded length and, ideally, on the raw request body size via a route-scoped `express.json({ limit: ... })` |
| V6 Cryptography | yes | Node builtin `crypto.scryptSync` for password hashing — never a hand-rolled KDF; `crypto.randomBytes`/`crypto.randomUUID` for all token/id generation — never `Math.random()` |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Stored XSS via uploaded file served with an attacker-controlled extension/MIME (the exact CMS-05 mechanism) | Tampering, Elevation of Privilege | Magic-byte validation at upload time; server-generated filenames (D-15); hand-rolled serving route with a fixed, allow-listed `Content-Type` that **excludes `.svg`** even though SVG is technically an image format (SVG can carry `<script>`) — this exclusion is directly required by CMS-05's own documented incident, which named `.svg` explicitly as one of the exploitable extensions |
| Path traversal on the uploaded-asset serving route | Tampering, Information Disclosure | `path.basename()` on the requested filename before any filesystem lookup; serve only from the dedicated uploads directory, never construct a path from unsanitized user input |
| Login brute force | Elevation of Privilege | Deliberately deferred this phase (CONTEXT's Deferred Ideas explicitly names rate limiting as "worth doing if D-13's IP layer is ever relaxed; not needed while the IP whitelist stands in front") — the IP allowlist is the actual control this phase relies on; do not silently add rate limiting as an unplanned extra, and do not treat its absence as an unflagged gap either |
| CSRF on CMS mutation routes (session cookie, no CSRF token) | Tampering | `SameSite=Lax` on the session cookie (blocks cross-site POST submission in all evergreen browsers) combined with the IP allowlist (a cross-site attacker's browser, even if it could forge a request, is very unlikely to be running on an allow-listed LAN address) — no CSRF-token library needed given this combination and the single-operator, no-public-write-surface design |
| Session hijacking via LAN packet capture (no TLS) | Information Disclosure | Documented residual risk (Pitfall 3) — mitigated only by the IP allowlist bounding who is on the trusted network segment at all, not eliminated |
| SSRF via a photo/logo URL fetched server-side | (not applicable — verify at build time) | Not applicable this phase: `event_photo.photo_url` (D-10) is stored and referenced in `<img src>` only, never fetched server-side by this service; uploaded logo/background bytes come directly from the operator's own upload, not a server-side fetch of an attacker-supplied URL. If a future "paste an image URL" field is ever added, this row must be revisited. |

## Sources

### Primary (HIGH confidence — read directly this session)

- `mirror-request/src/display/displayServer.ts` (full file) — `buildSnapshot()`,
  `maybeBroadcast()`, WS upgrade IP-gate pattern
- `mirror-request/src/display/displayPage.ts` (full file) — inline-HTML/CSS/JS pattern,
  idle-state default, WS reconnect client logic
- `mirror-request/src/queue/queueService.ts:790-978` — `onFileUpload()`, `dispatchJob()`,
  `getJobRegistration()` usage
- `mirror-request/src/state/localStore.ts:1-259` — full `bootstrap()`/`migrate()`, table
  schemas, `getJobRegistration`
- `mirror-request/src/types.ts` (full file) — `Registration`, `QueueJob`, `DisplaySnapshot`,
  `EnvConfig` shapes
- `mirror-request/src/config.ts` (full file) — production-required-validation pattern,
  `DISPLAY_IP_WHITELIST`/`PROXY_IP_WHITELIST` precedent
- `mirror-request/src/security/ipAllowlist.ts` (full file) — `clientIp()`/`isWhitelisted()`,
  the "reimplement, don't import, at a phase boundary" convention stated in its own header
- `mirror-request/src/index.ts` (full file) — express wiring order, existing `/display-screen`
  gate, service startup/shutdown sequence
- `mirror-request/src/agent/agentServer.ts` (full file) — bearer-token `timingSafeEqual`
  pattern, message-type branch structure, `sendEvent()`/`sendCommand()` primitives
- `mirror-request/src/logging/logger.ts` (full file) — `mask()`, `setLogLevel()`,
  `labelLogger()`
- `mirror-request/src/status/statusRoute.ts:1-50` — `createXRouter()` factory pattern,
  narrow injected-interface testing pattern
- `mirror-request/CLAUDE.md` (full file) — hard rules
- `mirror-request/test/local-store-persistence.test.ts:1-40` — temp-file DB harness
- `mirror-request/test/display-access-control.test.ts:1-40` — supertest + mock-queue/agent
  test pattern for IP-gated routes
- `mirror-request/test/queue-file-upload-print.test.ts:1-40` — fixture-driven upload/photo
  test style
- `mirror-request/test/status-api.test.ts` (grep) — supertest usage confirmation
- `dslrbooth-agent/src/config.ts` (full file) — the 8-field `Config` interface, verbatim
- `dslrbooth-agent/src/index.ts` (full file) — `ws.onMessage`/`ws.onStatusChange` handler
  shape, `DslrBoothClient` construction site
- `dslrbooth-agent/src/websocket/connection.ts` (full file) — `WsConnection` reconnect/
  heartbeat logic, `send()`
- `dslrbooth-agent/src/dslrbooth/client.ts` (full file) — the `readonly port`/`password`
  finding (Pitfall 4)
- `dslrbooth-agent/src/triggers/server.ts` (full file) — Agent's own local display page,
  precedent for inline-HTML-with-poll pattern reused on the booth PC side
- `dslrbooth-agent/test/connection-auth.test.ts` — confirmed 4 tests, the repo's only test
  file
- `dslrbooth-agent/vitest.config.ts` (full file)
- `mirror-request/package.json`, `dslrbooth-agent/package.json` (full files) — confirmed no
  `multer`/`bcrypt`/`argon2`/`cookie-parser`/`express-session`/`helmet` present in either
- `.planning/phases/08-cms-event-display/08-CONTEXT.md` (full file, 17 decisions)
- `.planning/phases/08-cms-event-display/08-UI-SPEC.md` (full file)
- `.planning/REQUIREMENTS.md` (full file) — verbatim Vietnamese requirement text, confirming
  CMS-01's exact 10-field list and CMS-05's stale-vs-current status
- `.planning/ROADMAP.md:452-490` — Phase 8 goal, 7 success criteria, the D-05 override note
- `.planning/STATE.md:1-137` — Phase 7 durable record, project history, confirmed 43/448
  baseline
- Direct `node -e` execution this session — `crypto.scryptSync/timingSafeEqual/randomBytes/
  randomUUID` availability; the N=2^17-vs-maxmem failure and N=2^14 success
- `cd mirror-request && npm test` executed this session — confirmed 43 files / 448 tests
  green, 9.94s

### Secondary (MEDIUM confidence — web-verified, not fetched into repo)

- OWASP Password Storage Cheat Sheet (via web search) — scrypt fallback parameters when
  Argon2id unavailable
- `npm view multer version` / `npm view multer deprecated` (executed this session) — `2.2.0`,
  published 2026-06-15, not deprecated
- Web search corroboration of `multer` CVE-2025-47944 (fixed 2.0.0), CVE-2025-7338 (fixed
  2.0.2), and 2026 GitLab Advisory Database entries for incomplete-cleanup and deeply-nested-
  field DoS in `multer`'s multipart parser
- Web search corroboration of Be Vietnam Pro / Lora OFL licensing and general self-hosting
  technique (`gwfh.mranftl.com`, `dev.to`/`zarino.co.uk`/`wildandfreetools.com` self-hosting
  guides)

### Tertiary (LOW confidence — flagged for validation)

- Exact `.woff2` file sizes for Be Vietnam Pro / Lora at 400+700 weights — not independently
  measured this session; UI-SPEC's own "a few hundred KB total" estimate is the only figure
  available and should be treated as approximate until the executor actually downloads the
  files
- `web-slide`'s production process-supervision mechanism (Open Question 2) — genuinely
  unknown from source alone

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every recommended primitive (Node `crypto`, existing `express`/
  `better-sqlite3`/`ws`) was either directly read from source this session or directly
  executed and observed
- Architecture: HIGH — every pattern proposed extends a structure read directly from the
  live codebase this session (router factories, WS message branches, poll-based computed
  fields), not invented from scratch
- Pitfalls: HIGH for Pitfalls 1/2/4/5 (each traced to a specific, quoted line range read this
  session); MEDIUM for Pitfall 3 (the "no TLS anywhere" claim is an absence-of-evidence
  finding, not a positive confirmation of the production topology)

**Research date:** 2026-08-12
**Valid until:** 30 days (stable in-repo patterns; font-file specifics and the `multer`
CVE landscape should be re-checked if this research is reused past that window)
