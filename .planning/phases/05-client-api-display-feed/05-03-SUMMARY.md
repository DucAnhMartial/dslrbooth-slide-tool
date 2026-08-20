---
phase: 05-client-api-display-feed
plan: 03
subsystem: display-feed
tags: [security, ip-allowlist, websocket, pii, display, D-09, D-10, D-13, D-14, D-15, D-16]
status: complete

requires:
  - "src/ingestion/mirrorReceiver.ts's clientIp/isWhitelisted closures and generic-403 posture (Phase 1) — logic reimplemented, module never imported"
  - "src/agent/agentServer.ts's upgrade-time-rejection-before-handleUpgrade pattern (Phase 3)"
  - "src/queue/queueService.ts's store: LocalStore = getStore() constructor-injection shape (Phase 2)"
  - "LocalStore.getQueuedGuestSummaries()/getBoothState(), QueueService.getQueueLength()/getAnnouncement() (Phase 2)"
provides:
  - "src/security/ipAllowlist.ts — clientIp(req)/isWhitelisted(ip, whitelist), shared by /display-screen and WS /display"
  - "EnvConfig.DISPLAY_IP_WHITELIST, empty-array dev default, production fail-fast"
  - "GET /display-screen gated with the identical Phase 1 generic-403 body"
  - "DisplayServer(queue, agent, store = getStore(), opts = { displayWhitelist?, pollIntervalMs? })"
  - "DisplaySnapshot with no currentJob field — the PII-incapable guarantee is structural"
affects:
  - "05-05 (OPS-RUNBOOK §3 needs a DISPLAY_IP_WHITELIST entry, and §9 the same 'unverified pre-deploy' posture the other two config-surface risks already carry)"

tech-stack:
  added: []
  patterns:
    - "Shared allow-list logic reimplemented as a standalone module (not imported) so the two Phase-1-adjacent call sites can diverge in zero risk from mirrorReceiver.ts's own suite"
    - "Raw-socket 403 + socket.destroy() strictly before wss.handleUpgrade(), copied from agentServer.ts's 401 precedent"
    - "PII/operator-column exclusion expressed as an absent type field plus an absent method call, not a null check (D-15, same idiom as Phase 4's D-05 and this phase's own D-02)"
    - "Change-driven broadcast: single serialised-string comparison per poll tick, no separate 1 Hz timer"
    - "Fake-remoteAddress upgrade listener registered before the server-under-test's own listener, for exercising IP-allow-list branches at the raw WS-upgrade layer where there is no req.ip to override"

key-files:
  created:
    - mirror-request/src/security/ipAllowlist.ts
    - mirror-request/test/display-access-control.test.ts
  modified:
    - mirror-request/src/types.ts
    - mirror-request/src/config.ts
    - mirror-request/src/index.ts
    - mirror-request/src/display/displayServer.ts
    - mirror-request/test/config-validation.test.ts
    - mirror-request/test/phase5-display.test.ts

decisions:
  - "displayServer.ts's five concerns (D-09/D-10/D-13/D-14/D-15/D-16) were landed in one commit (16d1641), not split across tasks, per RESEARCH.md Pitfall 3 — a partial fix here would read as complete in review."
  - "queuePosition is now derived from upNextRaw[0]?.position, not from a separate queue.getQueuePosition(job.id) call against a raw-row job id — removing the raw-row read (D-15) required removing this call site too, since job.id no longer exists in scope."
  - "WINDOWS ledger item 4 is closed for displayServer.ts and its own two test files (neither calls getStore()), but the ledger entry's stated scope is broader (ALL test files sharing one DB) and most other suites (on-register-auth.test.ts, agent-auth.test.ts, etc.) still use the singleton. Not marked fixed in WINDOWS.md — that would overstate what this plan actually touched. Left for the orchestrator/a later cleanup pass to decide."

metrics:
  duration: ~40 min
  completed: 2026-08-11
  tasks: 3
  commits: 3

actuals:
  tokens: 10450
  tasks: 3
  commits: 3
---

# Phase 5 Plan 03: Display Feed Access Control, PII Removal, and Injected Store Summary

`WS /display` and `GET /display-screen` are no longer reachable by anyone who can hit the
port — both are now gated by one shared IP allow-list. The broadcast path can no longer put a
`queue_job` row on the wire even by accident, because the method that used to read one is
gone from the call list entirely, not merely stripped of a field. The wire goes quiet when
nothing changes and ticks once a second during a countdown. Up-next shows given names; the
hero keeps the full name. `DisplayServer` takes its store as a constructor argument instead of
reaching for a module-scope singleton.

## What Was Built

| Concern | Artifact |
|---|---|
| Shared allow-list | `src/security/ipAllowlist.ts` — `clientIp()`/`isWhitelisted()`, reimplemented from `mirrorReceiver.ts`, never imported from it |
| Config | `DISPLAY_IP_WHITELIST` — empty-array dev default, production fail-fast (Assumption A4) |
| `/display-screen` gate | `src/index.ts` — same generic `{ error: 'Forbidden' }` 403 Phase 1 already uses |
| `WS /display` gate | `src/display/displayServer.ts`'s `start()` — raw 403 + `socket.destroy()` strictly before `handleUpgrade` |
| PII removal | `DisplaySnapshot.currentJob` deleted (`types.ts`); `buildSnapshot()` never calls `getNextQueuedJob()` or any other raw-row method |
| Given names | `toGivenName()` applied only to `upNext`, computed after the hero's full-name read |
| Change-driven broadcast | `maybeBroadcast()` — sends only when the serialised snapshot differs from the last-sent one |
| Injected store | Third constructor parameter, default `getStore()`; module-scope `const store = getStore()` deleted |
| Proof | `test/display-access-control.test.ts` (8 cases, new); `test/phase5-display.test.ts` (+6 cases) |

## Task 1 — Shared allow-list module, config key, `/display-screen` gate (`8d637e9`)

`src/security/ipAllowlist.ts` reimplements `mirrorReceiver.ts:20-54`'s `clientIp`/
`isWhitelisted` closures as plain exported functions. `clientIp`'s parameter is a structural
shape (`{ ip?: string; socket: { remoteAddress?: string } }`), not `Request` — it has to serve
both an Express `Request` (which has `.ip`) and the raw `http.IncomingMessage` delivered at the
WS `upgrade` event (which does not), and that fallback is exactly what Task 2's upgrade handler
depends on. `mirrorReceiver.ts` was neither imported from nor edited: `git diff --name-only
419763f..HEAD -- src/ingestion/` is empty across the whole plan.

`DISPLAY_IP_WHITELIST` was added to `EnvConfig` with an empty-array default — deliberately
**not** `PROXY_IP_WHITELIST`'s loopback default, since the room screen's addresses are entirely
site-specific — paired with a production fail-fast pushed into the existing `isProduction`
block in `config.ts`.

`GET /display-screen` in `index.ts` now runs `clientIp`/`isWhitelisted` ahead of
`renderDisplayPage()`, logging one warning and returning the identical `{ error: 'Forbidden' }`
body Phase 1's blocked-IP response already uses.

`test/config-validation.test.ts` gained three cases: throws naming `DISPLAY_IP_WHITELIST` when
unset in production, does not throw when it is set, and the dev-default (`NODE_ENV=test`) case
now also asserts `DISPLAY_IP_WHITELIST` defaults to `[]`.

**Measured:** `grep -rn "trust proxy" src/ | grep -vE ':[0-9]+:[[:space:]]*(//|\*|/\*)'` returns
nothing — no proxy-trust setting exists anywhere in `src/` (the one hit is the doc comment
explaining its absence, correctly excluded by the comment filter).

## Task 2 — `displayServer.ts` rewritten once (`16d1641`)

All five concerns landed in a single commit against a single 77→~130-line file
(`+109/-17` per `git show --stat`), per RESEARCH.md Pitfall 3's warning against a
split-across-waves partial fix.

**Ordering, quoted (top to bottom, `src/display/displayServer.ts:54-75`):** the `upgrade`
handler resolves the pathname, then — still inside the same handler, before anything else —
reads `clientIp(req)`, checks `isWhitelisted`, and on failure writes the raw 403 status line
and calls `socket.destroy()`, returning immediately. `wss.handleUpgrade(...)` is the next
statement in the function body and is only reached if that `if` block did not already return.
An unauthorised peer therefore never reaches `handleUpgrade` on this code path.

**`buildSnapshot()`'s full call list, quoted (`displayServer.ts:119-142`):**
`this.store.getQueuedGuestSummaries()`, `this.queue.getAnnouncement()`,
`this.queue.getQueueLength()`, `this.store.getBoothState()`, `this.agent.isAgentOnline()`. No
`getNextQueuedJob()`, no `getJob()`, no `getQueuedJobs()`, no `getInFlightJobs()` — none of
which return a raw `queue_job` row are called. `queuePosition` is now derived from
`upNextRaw[0]?.position ?? 0`, replacing the old `job ? this.queue.getQueuePosition(job.id) ??
0 : 0` — that call site had to go too, since `job.id` no longer exists in scope once the
raw-row read is gone.

**Ordering trap avoided:** `guestName` is computed from `upNextRaw` (the unprojected array)
before `upNext` is built by mapping `toGivenName` over it — exactly the ordering RESEARCH.md
flagged as a trap that "typechecks and reads as correct" while silently truncating the hero
name.

**D-13:** `maybeBroadcast()` serialises a freshly-built snapshot on every poll tick and only
sends — and only updates `lastSent` — when it differs from the last string sent. A
newly-connected client always gets an immediate, unconditional send that seeds `lastSent`.

**D-16:** `store: LocalStore = getStore()` is the third constructor parameter, matching
`QueueService`'s exact shape; `opts: { displayWhitelist?; pollIntervalMs? } = {}` is the
fourth. The module-scope `const store = getStore()` at the old line 9 is gone; both former
bare `store.` references inside the broadcast method are now `this.store.`. The production
call site `new DisplayServer(queue, agentServer)` in `index.ts` needed zero change.

**Verified:** `npm run typecheck` and `npm run build` both exit 0 — load-bearing here, since
this is what proves nothing outside this file still reads the removed `currentJob` field.
`git diff --name-only 419763f..HEAD -- src/queue/ src/agent/ src/notifications/ src/ingestion/
src/display/displayPage.ts` is empty.

## Task 3 — Every guarantee proven behaviourally (`1c78bb4`)

`test/display-access-control.test.ts` (new, **8 cases**):
- `/display-screen` Express layer: excluded/included addresses through one shared
  `expectForbidden` helper; the dot-star prefix branch both admits a sharing address and
  refuses a non-sharing one.
- `/display` WS layer, real `http.Server` bound to `'127.0.0.1'`, real `ws` client: an excluded
  peer's connection attempt fails with the `unexpected-response` event's `statusCode` asserted
  to equal exactly `403` — not merely "the socket errored" — and an included peer connects and
  receives a snapshot.
- D-10: a query-string credential (`?token=super-secret-value`) on an excluded address is
  refused identically — no accidental bypass.
- The refused-peer/clients-set case: since there is no `req.ip` to override at the raw upgrade
  layer (unlike the Express route above), a fake-`remoteAddress` upgrade listener is registered
  on the raw `http.Server` **before** `display.start()` adds its own listener, so it runs first
  and mutates the socket the display server's own handler reads. A refused attempt from a faked
  non-whitelisted address is followed by a real, allowed loopback connection, which receives
  both the on-connect snapshot and a subsequent forced-change broadcast correctly — proving no
  crash or dangling reference was left by the refusal.

`test/phase5-display.test.ts` (extended, **+6 cases**; the pre-existing 2 cases' own assertions
are byte-for-byte unmodified — only their shared `beforeAll` now constructs an explicit
`LocalStore` via the constructor seam and passes it to `DisplayServer` instead of relying on
the default `getStore()` parameter):
- D-16: two `DisplayServer` instances on two different `LocalStore` databases (both mock
  `QueueService`s pinned to the **same** constant `getQueueLength()` so the test cannot pass for
  the wrong reason) report different `upNext.length` values (2 vs. 5) — proven by reading
  `this.store` directly, the dimension `buildSnapshot()` actually touches.
- D-15, wire assertion: `Object.keys(snapshot.data).sort()` deep-equals the exact 8-key set;
  `JSON.stringify(snapshot.data)` contains none of `stall_reason`, `ack_error_message`,
  `retries`, `registration_id`, `email`, `phone`, `qr_token`.
- D-15, structural assertion: a hand-written store stub whose `getNextQueuedJob()` and `getJob()`
  both throw is injected; a broadcast still completes and delivers the expected `guestName`.
- D-13, idle: with a real (empty, hence frozen) store and `pollIntervalMs: 50`, a connected
  client receives **exactly 1** message over 600ms — measured, not merely asserted. Arithmetic
  recorded in-test: the old 250ms interval would have sent `1 + floor(600/250) = 3`; the
  injected 50ms rate would have sent `1 + 12 = 13`.
- D-13, countdown: a real `endsAt` ~3s ahead, `pollIntervalMs: 100`, over ~2200ms — **3
  messages observed**, measured by temporarily instrumenting the test and running it 3 times
  (`3, 3, 3`), then reverting the instrumentation before commit (`messages.length` asserted
  `>= 2`, the robust floor), and no two consecutive payloads byte-identical (`JSON.stringify`
  compared pairwise). 3, not a larger number, is expected: `remainingSeconds` (the only field
  that changes while idle-otherwise) only changes once per second, so a ~2.2s window crosses
  that boundary twice past the on-connect snapshot.
- D-14: `Nguyễn Văn A` announced — hero `guestName === 'Nguyễn Văn A'`, matching `upNext` entry
  `name === 'A'`; a second, single-token-named guest (`'Madonna'`) survives the projection
  unchanged.

## Verification — Measured, Not Asserted

| Check | Result |
|---|---|
| `npx vitest run test/display-access-control.test.ts test/phase5-display.test.ts` | 2 files / **16 tests** green |
| `npm test` run 1 | **31 files / 252 tests** green |
| `npm test` run 2 (back-to-back) | **31 files / 252 tests** green — identical |
| Baseline (05-02) | 30 files / 236 tests → +1 file / +16 tests (2 config-validation + 6 phase5-display + 8 display-access-control) |
| `npm run typecheck` | exit **0** |
| `npm run build` | exit **0** |
| `grep -rn "trust proxy" src/` (comment-filtered) | **0** non-comment hits |
| `git diff --name-only 419763f..HEAD -- src/queue/ src/agent/ src/notifications/ src/ingestion/ src/display/displayPage.ts` | **empty** — phase boundary held |
| `git diff --name-only 419763f..HEAD` | 15 files, matches this plan's `files_modified` plus 05-01's and 05-02's exactly |
| `git diff --stat` for `src/display/displayServer.ts` (Task 2 commit) | **+109/-17**, one commit, all five concerns |
| New npm packages | **0** — `git diff 419763f..HEAD -- package.json package-lock.json` empty |
| `mirror-request/.planning/` (stale tree) | untouched — `git status --short` clean at every checkpoint |
| Working tree at close-out | clean |

## Deviations from Plan

**1. [Rule 1 — necessary consequence of the plan's own required change] `queue.getQueuePosition(job.id)` call site removed**
- **Found during:** Task 2, while removing `getNextQueuedJob()` from `buildSnapshot()`.
- **Issue:** the old `queuePosition` computation was `job ? this.queue.getQueuePosition(job.id)
  ?? 0 : 0` — it depended on `job`, the exact raw-row variable D-15 requires deleting. Once
  `job` is gone, this line cannot compile unchanged.
- **Fix:** `queuePosition: upNextRaw[0]?.position ?? 0` — `getQueuedGuestSummaries()` already
  computes each entry's 1-based position from the same `queued_at ASC` ordering
  `getQueuePosition()` uses internally, so the value is unchanged for the common case (the next
  queued job is `upNext[0]`); the plan's own `key_links` anticipated this exact substitution
  ("`broadcastSnapshot` derives `queuePosition` from the up-next projection instead of from a
  raw `queue_job` row").
- **Files modified:** `mirror-request/src/display/displayServer.ts` (within the already-planned
  rewrite; no separate commit).

**2. [Scope note, not a code change] WINDOWS ledger item 4 not marked fixed**
- 05-CONTEXT.md's D-16 states this plan "closes open ledger item 4." Re-read against the
  ledger entry's own text: item 4 describes **ALL** test files sharing one DB through the
  `getStore()` singleton, not only the display surface. This plan closes it specifically for
  `displayServer.ts` and its own two test files (neither calls `getStore()`, both close their
  stores in teardown) — but `on-register-auth.test.ts`, `agent-auth.test.ts`, and most of the
  rest of the suite still use the singleton. Marking the ledger item globally `fixed` would
  overstate what changed. Left open, with this note, for the orchestrator or a dedicated
  cleanup pass to close for real.

No acceptance criterion from `05-03-PLAN.md` was found unmet by the committed code.

## Known Stubs

None. No placeholder values, no hardcoded empty returns, no TODO/FIXME introduced by this
plan's commits.

## Threat Flags

None beyond what `05-03-PLAN.md`'s own `<threat_model>` already registers. T-05-02, T-05-03,
T-05-10, T-05-11 and T-05-12 are all closed exactly as that table describes: `clientIp` reads
only the direct TCP peer with no proxy trust; the raw-row lookup is gone from the broadcast
path (proven by the throwing-stub test, not merely a grep); the WS upgrade rejects with a raw
403 + `socket.destroy()` before `handleUpgrade`; no credential of any kind is accepted in the
`/display` URL; `DISPLAY_IP_WHITELIST` fails production boot when unset. T-05-05 (no connection
cap on `/display`) remains the plan's own accepted residual risk, to be recorded in
`OPS-RUNBOOK.md` §9 by plan 05-05, not addressed here.

## Carry-Forward State for Phase 5 (05-05 gate)

1. **New config key needs `OPS-RUNBOOK.md` §3 entry:** `DISPLAY_IP_WHITELIST`, with the same
   "production values cannot be verified from this sandbox" caveat the other two config-surface
   risks already carry.
2. **T-05-05 (unbounded `/display` client accumulation, accepted risk)** needs its own line in
   `OPS-RUNBOOK.md` §9 beside `NOTIFY_WEBHOOK_URL` reachability, the undeployed Agent-auth
   cutover, and the D-06/D-07 unguessability blocker carried forward from 05-01.
3. **WINDOWS ledger item 4** is narrowed but not closed — see Deviation 2 above. `/gsd-ship`
   still blocks on it (plus item 5 and item 6, both also still open) until a human or a later
   plan decides how to close it for the whole suite.

## Self-Check: PASSED

All created files verified present on disk:
`src/security/ipAllowlist.ts`, `test/display-access-control.test.ts` — both FOUND.

All modified files verified present with expected content:
`src/types.ts`, `src/config.ts`, `src/index.ts`, `src/display/displayServer.ts`,
`test/config-validation.test.ts`, `test/phase5-display.test.ts` — all FOUND.

All three commit hashes verified in `git log --oneline`:
`8d637e9`, `16d1641`, `1c78bb4` — all FOUND.

`npm test` re-run in this session, twice back-to-back: **31 files / 252 tests**, identical,
green both times. `npm run typecheck` and `npm run build`: exit 0 both.
`mirror-request/.planning/` (stale tree) confirmed untouched: `git status --short -- .planning/`
returned empty throughout.
