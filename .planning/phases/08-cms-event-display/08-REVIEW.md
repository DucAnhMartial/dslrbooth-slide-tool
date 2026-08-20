---
phase: 08-cms-event-display
reviewed: 2026-08-13T02:30:00Z
depth: standard
status: issues-found
files_reviewed: 44
findings:
  critical: 1
  warning: 8
  info: 7
  total: 16
fixed:
  - CR-01
  - WR-01
  - WR-02
  - WR-03
  - WR-04
  - WR-05
  - WR-06
  - WR-07
  - WR-08
fixed_at: 2026-08-13T03:40:00Z
fixed_commits:
  - 1ee6e30
  - cca7666
  - 3910260
  - 1490d2a
  - fbdc042
  - e1ea3eb
  - 25d38ac
  - ebc28b0
open:
  - IN-01
  - IN-02
  - IN-03
  - IN-04
  - IN-05
  - IN-06
  - IN-07
scope_note: >
  58 files were in the SUMMARY-derived scope — above the workflow's 50-file
  warning threshold. Rather than one shallow pass, the review was narrowed into
  three domain passes (the narrowing the workflow itself recommends). Six binary
  font/licence files were excluded as unreadable by a reviewer. The three part
  reports are the primary artifacts; this file is the index and the
  orchestrator's independent verification record.
part_reports:
  - 08-REVIEW-security.md
  - 08-REVIEW-data-agent.md
  - 08-REVIEW-display-cms.md
---

# Phase 8 — CMS & Event Display: Code Review

## How this review was run

Three `gsd-code-reviewer` passes at `standard` depth, each with a tight file
list and an explicit list of the LOCKED decisions from `08-CONTEXT.md` it was
required to verify against the code rather than against the code's own comments.

| Pass | Files | Report |
|---|---|---|
| Security surface | 10 | `08-REVIEW-security.md` |
| Data layer + Agent config contract (two repos) | 17 | `08-REVIEW-data-agent.md` |
| Room screen + CMS pages/routes | 17 | `08-REVIEW-display-cms.md` |

**Provenance discipline.** Findings below are marked `[verified]` where the
orchestrator independently re-derived the claim from source — not from the
report asserting it. This follows the Phase 7 lesson recorded in `STATE.md`:
verify claims against the artifact's subject, not against the artifact. Eight
findings are `[unverified]` — plausible, from a reviewer that was correct
everywhere it was checked, but not re-derived here.

**Suite state at review time:** `mirror-request` 56 files / 661 tests pass;
`dslrbooth-agent` 2 files / 28 tests pass; `typecheck` and `build` clean; both
working trees clean before and after the review.

## Findings

| id | sev | where | what | status |
|---|---|---|---|---|
| CR-01 | critical | `cms/cmsAuth.ts:155` | A malformed `Cookie` header throws an uncaught `URIError`, returning 500 instead of the module's own uniform 401 | **[verified]** |
| WR-01 | warning | `cms/cmsRouter.ts` | No rate limiting or lockout on `POST /cms/login` | [unverified] |
| WR-02 | warning | `cms/cmsAuth.ts` | Session store has no size cap and sessions never expire | [unverified] |
| WR-03 | warning | `app.ts`, `cms/uploadHandler.ts` | An oversized `POST /cms/api/assets` body breaks the endpoint's own uniform failure shape; can leak filesystem paths | [unverified] |
| WR-04 | warning | `scripts/hashCmsPassword.ts` | Reads the master password from `argv` — exposed via `ps` and shell history | [unverified] |
| WR-05 | warning | `app.ts:71` vs `app.ts:149` | The `/cms/api/assets` body-size override is mounted ahead of the CMS IP gate | **[verified]** |
| WR-06 | warning | `cms/cmsAgentRoutes.ts:61-106` | `validateAgentConfigSubmission` has no exhaustiveness guard — an allow-listed field with no validation branch is silently dropped, not refused | **[verified]** |
| WR-07 | warning | `agent/agentConfigContract.ts:131-138`, `state/localStore.ts:1233-1260` | A corrupt `agent_config.current_json` is treated as "never configured", overwriting the last-good config and pushing the corrupt blob into `previous_json` — poisoning D-18's one-step restore | **[verified]** |
| WR-08 | warning | `cms/cmsPhotoPages.ts:431` | Event id interpolated into an inline `<script>` via `JSON.stringify`, which does not escape `/` | **[verified]** |
| IN-01 | info | `config.ts` | `CMS_PASSWORD_HASH` startup check validates presence, not shape | [unverified] |
| IN-02 | info | `security/ipAllowlist.ts` | `isWhitelisted()` does not normalize IPv6-mapped IPv4; pre-existing, inert under default `HOST=0.0.0.0` | [unverified] |
| IN-03 | info | `test/agent-config-message.test.ts:214-221` | Vacuous test — asserts on a locally-defined dummy, not the real call site | [unverified] |
| IN-04 | info | `agent/agentConfigContract.ts` | `DEFAULT_AGENT_CONFIG` is not frozen, unlike its sibling `DEFAULT_EVENT_CONFIG` | [unverified] |
| IN-05 | info | `cms/cmsPages.ts:113-190` | Dead code: `renderCmsDashboardPage` unused, duplicates `renderCmsEventListPage` | **[verified]** — already logged as `deferred-items.md` D-2 |
| IN-06 | info | `display/displayPage.ts`, `cms/cmsEventPages.ts` | Layout name `'stage_sidebar'` declared twice with no shared import | [unverified] |
| IN-07 | info | `test/display-hero-moment.test.ts:324` | Vacuous assertion — `toContain('justCaptured')` passes even if the hero branch is unreachable | **[verified]** |

## CR-01 in full, with a severity dissent

`parseCookies()` at `cms/cmsAuth.ts:155` calls
`decodeURIComponent(part.slice(index + 1).trim())` with no `try/catch`.
Reproduced directly: `cms_session=%`, `cms_session=%E0%A4%A`, and
`cms_session=abc%zz` all throw `URIError: URI malformed`.

Both call sites are reachable:
- `createRequireSession` (`cmsAuth.ts:199`) — every session-gated CMS route.
- `POST /cms/logout` (`cmsRouter.ts:105`) — mounted **before** `requireSession`,
  so it needs no session at all.

Neither `app.ts` nor `index.ts` registers an Express error handler (grep for
`(err, req, res, next)` returns nothing), so the throw reaches Express's default
`finalhandler`. `config.ts:63` reads `get('NODE_ENV') ?? 'development'`, so a
deployment that has not set `NODE_ENV=production` gets a **500 with a full stack
trace including absolute filesystem paths**, where the module's own docstring
promises "one generic refusal for every way of failing the session check…
any difference between them tells an attacker which half of the guess was right."

**Orchestrator's dissent on severity.** The reviewer rated this CRITICAL. Two
facts pull against that rating and belong in the record:

1. `app.ts:149` mounts `createCmsIpGate(config.CMS_IP_WHITELIST)` **ahead of**
   `createCmsRouter`, so D-13's IP-then-password order holds. Reaching this code
   at all requires already being on the CMS IP whitelist.
2. Express catches synchronous throws in middleware and routes them to the error
   handler. This produces a 500 — it does **not** crash the process, and it does
   **not** bypass authentication. Nobody gets in.

So the real impact is an information disclosure (stack trace, paths) plus the
loss of a deliberately-designed anti-oracle property, available to someone
already inside the IP allow-list. That is a genuine defect worth fixing before
the D-06 cutover — the fix is a three-line `try/catch` returning `{}` — but
"CRITICAL" overstates it. Recorded here as **high-severity, not
authentication-bypassing**, so that whoever reads this later is not misled in
either direction.

## What the review confirmed as genuinely held

These were hunted for and found sound. Each was re-derived independently by the
orchestrator, because a false "all clear" is more dangerous than a false alarm.

- **The Agent config allow-list is fail-closed.** `isSafeAgentConfigField()`
  (`agentConfigContract.ts:75-77`) tests membership in a positive list of exactly
  four fields (`:19-24`). A ninth Agent field added later defaults to *refused*,
  not to editable.
- **The two repositories' read-only lists are identical.**
  `agentConfigContract.ts:48-53` and `dslrbooth-agent/src/liveConfig.ts:36-41`
  both hold `extensionServiceWsUrl`, `extensionServiceWsToken`,
  `triggerServerPort`, `logDir` — same four, `logDir` present in both.
- **The migrations cannot damage an existing production database.** Every
  `ALTER TABLE` in `src/` (4 of them) predates Phase 8. Phase 8 adds only new
  tables — `event`, `active_event`, `event_photo`, `agent_config` — all
  `CREATE TABLE IF NOT EXISTS`. No pre-existing table is touched.
- **No secret leakage.** `dslrBoothPassword` and `extensionServiceWsToken` do not
  appear in any log line, HTML page, or JSON response in the reviewed code.
- **D-15 held under adversarial probing.** The security reviewer wrote and ran
  throwaway probes against SVG/HTML/JS polyglots, traversal-shaped filenames, and
  the oversize boundary; magic-byte validation, server-minted filenames, and
  path-traversal-safe serving all survived. Probe files were deleted — both
  working trees verified clean afterwards.
- **D-07, D-09, D-02 held.** The hero-moment TTL does not thrash the broadcast
  diff (`display-hero-moment.test.ts:315-322` runs four 250ms ticks and asserts
  one distinct serialization), the reconnect path retains content, and the
  active-event switch confirmation is enforced server-side, not by a browser
  dialog a direct POST could skip.

## Fixes applied (2026-08-13)

Four findings closed, test-first, four atomic commits. Suite went
**56 files / 661 tests → 59 files / 677 tests**, all passing; `typecheck` and
`build` clean; `mirror-request` tree clean. `dslrbooth-agent` untouched
(2 files / 28 tests, still passing).

| id | commit | evidence the test was not vacuous |
|---|---|---|
| CR-01 | `1ee6e30` | 4 cases failed on the old parser, incl. an integration case that observed the literal `status: 500`. 2 cases pass before *and* after — `%20` still decodes, a real login still authenticates end to end — so the fix cannot be "stop decoding". |
| WR-07 | `cca7666` | 3 cases failed; corruption injected through a second sqlite connection because no writer in the codebase can produce it. 2 cases pass before and after — an absent row is still seeded and persisted — so the fix cannot be "never seed". |
| WR-06 | `3910260` | No runtime test can fail today (no such field exists). Proved by **mutation instead**: adding a fifth safe field with no validation branch fails typecheck with `TS2322: Type '"newlyAddedField"' is not assignable to type 'never'` at `cmsAgentRoutes.ts:116`. Mutation reverted. |
| WR-08 | `1490d2a` | 3 cases failed, incl. a structural one counting `<script`/`</script>` balance (`{opens:2, closes:3}` before). 2 cases pass before and after — an ordinary uuid still reaches the script as a working redirect, the event name is still HTML-escaped in its HTML context. |

**One fix went beyond the finding, and that is recorded rather than folded in.**
WR-07 as written named `readAgentConfigForAgent` + `getAgentConfig`. While
fixing it, `restorePreviousAgentConfig()` (`localStore.ts:1272`) was found to
have the same defect from the other end: it wrote `previous_json` into
`current_json` and only *then* tried to parse it, so a corrupt previous
destroyed a working current and returned `undefined` — no configuration and no
step back. It now parses before writing. This was the orchestrator's call, not
the reviewer's finding and not a human decision.

**One test assertion in this batch was wrong and was corrected, not the code.**
The first WR-08 draft asserted `not.toContain('&lt;/script&gt;"')` unscoped,
which fails against *correct* code — the same id also lands in a
`data-event-id` attribute where `&lt;` is the right escape. The assertion was
rescoped to the `<script>` block. Two contexts, two escapes; an unscoped
assertion cannot tell them apart.

## Second pass — WR-01…WR-05 (2026-08-13)

The five defense-in-depth findings, closed on the operator's instruction after
being presented as their call. Four commits: `fbdc042` + `ebc28b0` (WR-01,
WR-02), `e1ea3eb` (WR-03, WR-05), `25d38ac` (WR-04). Suite
**59 files / 677 tests → 63 files / 706 tests**, all passing; typecheck and
build clean; tree clean.

| id | commit | evidence the test was not vacuous |
|---|---|---|
| WR-01 | `fbdc042` | 4 cases failed. The sharp one: a **correct** password is refused with 429 while throttled, which a limiter placed after `verifyPassword` would pass. 2 pass before and after — one typo does not lock the operator out, a first-attempt login still mints a cookie. |
| WR-02 | `ebc28b0` | 2 cases failed on the unbounded map. 2 pass before and after, one of them pinning **D-14 itself**: a session minted three days earlier is still valid, so the case fails the moment anyone turns the cap into an expiry. |
| WR-03 | `e1ea3eb` | 5 cases failed. The stack leak was **reproduced, not assumed** — the 413 page carried `…/node_modules/raw-body/index.js:163:17` and nine more frames. 2 pass before and after: a real png is still accepted (201). |
| WR-05 | `e1ea3eb` | Needed a genuinely blocked peer, which no header can fake (`clientIp` does not trust `X-Forwarded-For`, T-05-02), so it lives in its own file with a whitelist excluding loopback. Before the fix the oversized case saw **413** — proof the parser had already run for a peer the gate would refuse. |
| WR-04 | `25d38ac` | 7 cases against the extracted reader. Plus a regression case asserting the CLI now **refuses** an argv password, so restoring it "for convenience" fails the suite. |

**Three things went differently than planned, and are recorded as such.**

1. **WR-02 was NOT fixed the way the reviewer proposed.** Its suggested fix
   offered a size cap *or* a 24–72h absolute lifetime. The lifetime option
   would violate **D-14**, a locked human decision ("no auto-timeout" — an
   event runs for hours and ejecting the operator mid-event is worse than a
   lingering session on an IP-allow-listed LAN). Only the cap was implemented,
   and a test now pins the absence of any expiry.
2. **WR-04 changed a documented interface.** The CLI no longer accepts a
   positional password at all. That broke an existing case in
   `cms-access-control.test.ts`, which was updated to pipe stdin, and
   `OPS-RUNBOOK` §3 and §12 were rewritten. **`.env.example` could NOT be
   updated — this environment denies write access to it.** The three new
   `CMS_LOGIN_RATE_LIMIT_*` keys are optional with working defaults, and §3
   now states explicitly that they are absent from that file.
3. **WR-03 introduced one new asymmetry, pinned rather than hidden.** The
   scoped parser is mounted at app level and runs before the router's
   `requireSession`, so an *unauthenticated* oversized body now gets 400 where
   an ordinary one gets 401. Judged acceptable — the two refusals belong to
   different families, the response reveals only that a body exceeded a
   published limit, and after WR-05 the caller is already inside
   `CMS_IP_WHITELIST`. A test asserts both codes so the boundary cannot drift
   unnoticed.

## Still open after both passes

All seven `IN-` items, none of them behavioural. `IN-05` is already logged as
`deferred-items.md` D-2. `IN-03` and `IN-07` are the two vacuous assertions —
worth replacing, though both have a stronger sibling covering the behaviour.

## Recommended order of work

1. **CR-01** — `try/catch` around `decodeURIComponent`, returning `{}` on a
   malformed cookie. Test-first: a request with `Cookie: cms_session=%` must get
   401, not 500. Do this before the cutover.
2. **WR-07** — distinguish "corrupt" from "unset" in `getAgentConfig()` so a bad
   blob cannot evict the last-good config from `previous_json`. This is the one
   finding that silently destroys data.
3. **WR-06, WR-08** — both are small, both are latent traps rather than live
   bugs, both are cheap to close while the context is fresh.
4. **WR-01…WR-05** — defense-in-depth. Judgement call against the deployment's
   actual threat model: a venue LAN behind an IP allow-list, already documented
   as running without TLS.
5. **IN-03, IN-07** — replace the two vacuous assertions. Neither leaves a
   behaviour uncovered (both have a stronger sibling test), but a test that
   cannot fail is worse than no test: it reads as coverage.
6. **IN-05** — already in `deferred-items.md` as D-2; fold into whichever plan
   next owns `cmsPages.ts`.

## Not covered by this review

- The six binary font and licence files.
- `docs/OPS-RUNBOOK.md`, `web-slide/README.md`, `package.json`,
  `vitest.config.ts` — documentation and build configuration.
- Everything behind 08-06's blocking human gate: the physical cutover, the room
  screen at real TV viewing distance, and a real Agent applying a config change
  over a real socket. No automated review substitutes for those.
