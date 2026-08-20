---
phase: 11-retake-approval-anchor
plan: 03
subsystem: cms-operator-control
tags: [express, cms, queue-service, retake, notifications, dslrbooth]

requires:
  - phase: 11-retake-approval-anchor
    plan: 01
    provides: "the attempt spine, finalizePendingPrint(jobId, door) as the one idempotent finalize gate, the RETAKE_GRACE_MS grace window"
  - phase: 11-retake-approval-anchor
    plan: 02
    provides: "every legacy queue test migrated onto the finalize gate; the suite green everywhere except test/cms-photo-history.test.ts, deliberately left for this plan"
provides:
  - "GET /cms/booth and POST /cms/api/booth/release — D11-08's operator finalize door, mounted behind the existing CMS IP allow-list and session cookie with no new auth/CSRF mechanism"
  - "QueueService.getBoothStallInfo()/releaseForOperator(jobId) — the narrow CmsBoothLink surface, reaching one QueueService method for the mutation and no store handle at all"
  - "toGivenName exported from displayServer.ts — one given-name projection shared by the room screen and the CMS panel"
  - "createCmsRouter's fourth positional parameter (boothLink), and test/helpers/cmsBoothLink.ts's BOOTH_LINK stub every other CMS test now passes"
  - "test/cms-photo-history.test.ts migrated onto the finalize gate — the one file 11-02 deliberately left red is green again"
affects: [notification-service, cms, operator-workflow]

actuals:
  tokens: 11030
  tasks: 3
  commits: 3

tech-stack:
  added: []
  patterns:
    - "Structural-typing link injection: QueueService itself satisfies CmsBoothLink (getBoothStallInfo/releaseForOperator are public methods on the real class), so app.ts threads the existing queue instance straight through createCmsRouter's new parameter — no adapter object, no new construction."
    - "Visibility-as-data-absence: getBoothStallInfo() returns null (not a flag) when there is no guest to show, so the CMS page's rendering branch is driven entirely by whether the read returned anything — the same discipline DisplayServer's own D-09/D-10 justCaptured projection already uses."
    - "Document-level <meta http-equiv=refresh> instead of a client-side timer for the one value (elapsed seconds) that must advance without an operator action — no setInterval anywhere in cmsBoothPages.ts; the browser's own reload is what keeps the number honest across a stale tab."

key-files:
  created:
    - mirror-request/src/cms/cmsBoothRoutes.ts
    - mirror-request/src/cms/cmsBoothPages.ts
    - mirror-request/test/helpers/cmsBoothLink.ts
    - mirror-request/test/cms-booth-release.test.ts
  modified:
    - mirror-request/src/queue/queueService.ts
    - mirror-request/src/display/displayServer.ts
    - mirror-request/src/cms/cmsRouter.ts
    - mirror-request/src/app.ts
    - mirror-request/src/cms/cmsEventPages.ts
    - mirror-request/test/cms-access-control.test.ts
    - mirror-request/test/cms-agent-config.test.ts
    - mirror-request/test/cms-cookie-parse-hardening.test.ts
    - mirror-request/test/cms-event-tracer.test.ts
    - mirror-request/test/cms-login-hardening.test.ts
    - mirror-request/test/cms-photo-history.test.ts
    - mirror-request/test/cms-upload-validation.test.ts

key-decisions:
  - "getBoothStallInfo()'s visibility gate is booth_state.attempt_no >= 1, not merely 'a job is bound to the booth'. A job is bound from setBoothBusy() at dispatch, but attempt_no stays 0 until the guest's own session_start is acknowledged — the same window sessionAckedFromEvent()'s retake branch already treats as 'no attempt has happened yet'. Showing the control in that pre-acknowledgement window would render a guest who has not yet walked up, with an elapsed time that has no honest value (acknowledged_at is unset). Not explicitly spelled out in the plan's <behavior> list, which only names IDLE/BUSY-with-attempt-open/grace; derived directly from 'the attempt state from the booth attempt accessor' the plan's own <action> names as one of the read's composed pieces."
  - "The release button's own submit handling reuses the page-wide cmsBusy/cmsRelease/cmsHandleAuth in-flight script every other mutating CMS control already carries (G1) — interpreting the plan's 'do not add a script' as scoped to the elapsed-time counter specifically (satisfied by the meta-refresh tag, not a setInterval), not as a prohibition on the one shared, already-established in-flight-disable script every other mutating control in this console uses. Omitting it would have been the one CMS mutating control that could be double-submitted."
  - "releaseForOperator()'s three outcomes ('released'/'wrong_job'/'already_finished') are logged with distinct 'refused: not the bound job' / 'refused: already finished' wording at the QueueService layer (never the guest name), matching the plan's own artifacts_produced log-token list verbatim, rather than relying solely on finalizePendingPrint()'s own internal (differently-worded) already-finalized log line."

requirements-completed: [BTH-01, BTH-02]

coverage:
  - id: D1
    description: "The narrow CmsBoothLink interface (one read, one write) is declared beside the route file and holds no store handle; the route file itself contains zero references to LocalStore/getStore, and the POST route reaches exactly one QueueService method for the mutation (releaseForOperator), which itself calls the single finalizePendingPrint gate through the operator door — never booth_state or pending_print directly."
    requirement: BTH-01
    verification:
      - kind: unit
        ref: "grep -Ec 'LocalStore|getStore' src/cms/cmsBoothRoutes.ts = 0; test/cms-booth-release.test.ts (12 cases)"
        status: pass
    human_judgment: false
  - id: D2
    description: "The control's visibility rule (never IDLE/announcing, always when there is a guest bound with at least one attempt opened) is a property of getBoothStallInfo()'s return value, not the template — proved by rendering with a null stall (no control) and with two different stall shapes (standing in for busy and grace, since the interface makes no distinction between the two)."
    requirement: BTH-01
    verification:
      - kind: unit
        ref: "test/cms-booth-release.test.ts#GET /cms/booth (4 cases)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Both existing CMS gates (address allow-list, session cookie) refuse the new route independently, with no new auth/CSRF mechanism added; the POST body is validated all-or-nothing (extra field, missing field, empty field all refused whole); the wrong-job and already-finished races are both reported (409) and reach the operator door's write exactly once, never twice."
    requirement: BTH-02
    verification:
      - kind: unit
        ref: "test/cms-booth-release.test.ts#POST /cms/api/booth/release (8 cases)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Every existing CMS test (nine createCmsRouter call sites across seven files) passes the router factory's now-required fourth argument, unchanged in every other line; the production mount threads the real QueueService instance through with no new construction; the one file 11-02 deliberately left red (test/cms-photo-history.test.ts, still driving the old file_upload-alone-sends assumption) is migrated onto the finalize gate and green again."
    requirement: BTH-01
    verification:
      - kind: unit
        ref: "npm test — 85/85 files, 1012/1012 tests"
        status: pass
    human_judgment: false
  - id: D5
    description: "The phase does not close until the five-scenario live booth gate in 11-CONTEXT.md <verification> passes on the real booth with auto-print off, including scenario 4, the operator release (SC-6)."
    human_judgment: true
    rationale: "Requires a physical dslrBooth with auto-print OFF and an operator pressing the real CMS control mid-session — cannot be automated from source. Out of scope for this plan; tracked as the phase's own closing checkpoint, unchanged from 11-01/11-02's own note."

duration: ~40min
completed: 2026-08-18
status: complete
---

# Phase 11 Plan 03: The CMS Operator Door Summary

**Built D11-08's "end this guest" control end to end — `GET /cms/booth`, `POST /cms/api/booth/release`, the narrow `CmsBoothLink` interface, `QueueService.getBoothStallInfo()`/`releaseForOperator()` reaching the single `finalizePendingPrint` gate through the operator door, and the wiring through nine existing CMS test call sites — closing SC-4 and bringing the suite fully green (85/85 files, 1012/1012 tests) by migrating the one file 11-02 deliberately left red.**

## Performance

- **Duration:** ~40 min
- **Completed:** 2026-08-18
- **Tasks:** 3 / 3 completed
- **Files touched:** 16 (4 new, 12 modified)

## Accomplishments

- The operator's third finalize door is live: `POST /cms/api/booth/release` reaches exactly one `QueueService` method (`releaseForOperator`), which re-checks the job id still owns the booth before calling the same idempotent `finalizePendingPrint(jobId, 'operator')` gate the `printing` and grace doors already use — no direct write to `booth_state` or `pending_print` anywhere in the route file (`grep -Ec 'LocalStore|getStore' src/cms/cmsBoothRoutes.ts` = 0).
- The control's visibility is a property of the data, not the template: `getBoothStallInfo()` returns `null` — not an empty object or a boolean flag — whenever there is no guest to end, including the pre-acknowledgement window right after dispatch where a job is bound but the guest has not yet started their own session (a case the plan's `<behavior>` list did not spell out explicitly, derived from the plan's own instruction to compose the read from "the attempt state from the booth attempt accessor").
- Both existing gates (the CMS IP allow-list, the session cookie) refuse the new route independently — proved through the real `createCmsIpGate` + `createCmsRouter` chain, not a hand-assembled copy — with **zero** new auth, session or CSRF mechanism introduced.
- The all-or-nothing body rule holds: exactly one expected field (`jobId`, non-empty string); an extra field, a missing field, or an empty field are each refused whole with a 400, never silently dropped.
- The two races D11-05/D11-08 name are both answered rather than silently mishandled: a job id that no longer owns the booth, and a job that finalized between page render and click, both report 409 and mutate nothing — the already-finished case is asserted on **both halves** (the reported answer AND that `releaseForOperator` was reached exactly once for that POST), which is what rules out a route that double-finalized and simply relayed the second call's result.
- `toGivenName` is now exported from `displayServer.ts` and imported into `queueService.ts` — one given-name projection, two consumers (the room screen's up-next list and the CMS operator panel), never a second implementation.
- The CMS router factory's fourth positional parameter (`boothLink`) is **required**, not optional, on purpose — an optional link would let a future wiring change drop the operator's only override with a silently absent route instead of a loud compile failure. That cost nine mechanical call-site edits across seven test files, all landed with `test/helpers/cmsBoothLink.ts`'s shared `BOOTH_LINK` stub (idle, refusing release) so none of the seven had to know anything about the booth.
- `test/cms-photo-history.test.ts` — the one file 11-02 deliberately left red — is migrated onto the finalize gate: its `captureThroughUpload()` helper now opens the booth attempt and sends an approving `printing` after the `file_upload`, matching `test/queue-photo-image-resolution.test.ts`'s own `approve()` pattern from 11-02. The suite is fully green: **85 files / 1012 tests**, up from 11-02's 84/1000 (997 passing, 1 file red).

## Task Commits

1. **Task 1: The narrow booth link, the two QueueService methods, and the route pair** - `212a15a` (feat)
2. **Task 2: Wiring — thread the queue into the CMS router, mount the routes, link the page, update every call site** - `3959c17` (feat)
3. **Task 3: The route test — gates inherited, body refused, race answered, door recorded** - `6c5f184` (test)

No separate plan-metadata commit — `.planning/` is not under version control in this project (`mirror-request` is the only git repository), so `SUMMARY.md`/`STATE.md`/`ROADMAP.md` are written to disk but not committed, matching 11-01's and 11-02's own precedent.

## Files Created/Modified

- `mirror-request/src/cms/cmsBoothRoutes.ts` — **new**: `CmsBoothLink` interface, `createCmsBoothRoutes()` — `GET /booth`, `POST /api/booth/release` with all-or-nothing body validation
- `mirror-request/src/cms/cmsBoothPages.ts` — **new**: `renderCmsBoothPage()` — no-guest and guest-with-elapsed-time states, document-level meta-refresh, escaped guest name and job id
- `mirror-request/src/queue/queueService.ts` — adds `getBoothStallInfo()`/`releaseForOperator(jobId)` (public), imports `toGivenName`
- `mirror-request/src/display/displayServer.ts` — exports `toGivenName` (was module-private)
- `mirror-request/src/cms/cmsRouter.ts` — `createCmsRouter` gains a required fourth positional `boothLink` parameter; mounts `createCmsBoothRoutes` right after the agent routes, below `requireSession()`; mount-order header comment updated
- `mirror-request/src/app.ts` — threads the existing `queue` instance through `createCmsRouter(store, config, agentServer, queue)`
- `mirror-request/src/cms/cmsEventPages.ts` — one dashboard link, "Kết thúc khách này" → `/cms/booth`
- `mirror-request/test/helpers/cmsBoothLink.ts` — **new**: `BOOTH_LINK`, the idle-and-refusing stub every non-booth CMS test now passes
- `mirror-request/test/cms-booth-release.test.ts` — **new**: 12 cases — both gates, all-or-nothing body, both races, GET visibility, no PII rendered
- `mirror-request/test/cms-access-control.test.ts`, `test/cms-agent-config.test.ts`, `test/cms-cookie-parse-hardening.test.ts`, `test/cms-event-tracer.test.ts`, `test/cms-login-hardening.test.ts`, `test/cms-upload-validation.test.ts` — one line each, `BOOTH_LINK` threaded through their `createCmsRouter(...)` call site(s); no other line changed
- `mirror-request/test/cms-photo-history.test.ts` — `captureThroughUpload()` migrated onto the finalize gate (booth bound, attempt opened, approving `printing` sent), plus the same `BOOTH_LINK` wiring as the other six

## The Nine Updated Call Sites (Task 2's own instruction to state plainly)

| # | File | Line(s) |
|---|------|---------|
| 1 | `test/cms-login-hardening.test.ts` | 68 |
| 2 | `test/cms-event-tracer.test.ts` | 97 |
| 3 | `test/cms-access-control.test.ts` | 131 |
| 4 | `test/cms-access-control.test.ts` | 148 |
| 5 | `test/cms-cookie-parse-hardening.test.ts` | 71 |
| 6 | `test/cms-photo-history.test.ts` | 341 |
| 7 | `test/cms-agent-config.test.ts` | 324 |
| 8 | `test/cms-agent-config.test.ts` | 334 |
| 9 | `test/cms-upload-validation.test.ts` | 252 |

Plus the tenth, production, call site: `src/app.ts:230` (`createCmsRouter(store, config, agentServer, queue)`).

## The Panel: Its Own Page, Not Merged Into the Dashboard (A4, stated plainly per this plan's `<output>` instruction)

Built as its own page, `GET /cms/booth`, following `cmsAgentPages.ts`'s shape exactly as A4 assumed — not merged into the event dashboard. The dashboard gained one link to it ("Kết thúc khách này") so the surface is reachable without typing a URL, per the plan's own `key_links`. Merging it into the dashboard instead remains, as A4 flagged, a later and cheap move if the operator prefers it — nothing in this plan's shape forecloses that.

## Decisions Made

See `key-decisions` in frontmatter. The most consequential one not already locked by `11-CONTEXT.md`: **the visibility gate is `attempt_no >= 1`, not merely "a job is bound."** The plan's own `<behavior>` list names three states explicitly (IDLE with no control; BUSY-with-attempt-open showing the guest; grace showing the guest) but does not name the fourth, real state a real booth passes through on every dispatch — bound-but-not-yet-acknowledged, the window between `setBoothBusy()` at dispatch and the guest's own `session_start` ack. In that window `acknowledged_at` is unset, so "elapsed time since acknowledgement" (the plan's own explicit instruction — "do not add a second wait clock") has no honest value to report. The plan's `<action>` text does say to compose the read from "the attempt state from the booth attempt accessor" as one of its three inputs; treating `attemptNo < 1` as an additional "nothing to show yet" branch is the direct, necessary consequence of taking that instruction seriously rather than only checking whether a job id is bound.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - missing critical functionality, discovered during Task 2] `test/cms-photo-history.test.ts` still drove the retired send-on-upload path**

- **Found during:** Task 2, running the plan's own seven-file verify command, which includes this file
- **Issue:** 11-02 deliberately left this file untouched and red (documented in its own SUMMARY and in this plan's `<upstream_state>`), since it was explicitly this plan's `files_modified` responsibility. `captureThroughUpload()` drove a `file_upload` event and asserted a photo-history row appeared immediately — the model D11-04/D11-05 retired in 11-01/11-02, where an upload only WRITES the URL into the pending-print slot and delivery/history-writing wait for one of the three finalize doors.
- **Fix:** Extended `captureThroughUpload()` to bind the booth and open an attempt directly (this harness never runs a full dispatch/`session_start` cycle), then send an approving `printing` whose composite stem matches the slot the helper already opens — the exact pattern 11-02's `test/queue-photo-image-resolution.test.ts#approve()` established for the same class of file.
- **Files modified:** `mirror-request/test/cms-photo-history.test.ts`
- **Verification:** All 23 cases in the file pass; full suite re-run green afterward (85/85 files, 1012/1012 tests)
- **Committed in:** `3959c17` (Task 2's commit)

---

**Total deviations:** 1 auto-fixed (Rule 2 — missing critical functionality, explicitly assigned to this plan by the orchestrator's own `<upstream_state>` note, not a surprise discovery outside scope)
**Impact on plan:** Necessary — the plan's own Task 2 `<verify>` command runs this exact file and could not have passed otherwise. No scope creep: the file was already named in Task 2's `<files>` list.

## Issues Encountered

- **One acceptance-criterion grep is imprecise against pre-existing prose, not against this plan's own code.** Task 2's acceptance criterion `grep -rF 'createCmsRouter(' test/ | wc -l` equals `grep -rF 'BOOTH_LINK' test/ | grep -F 'createCmsRouter(' | wc -l` computes 11 vs 9 rather than an exact match: two lines in `test/cms-upload-validation.test.ts` (its header comment, present in the file since before this plan — confirmed via `git log`) mention the literal string `createCmsRouter()` in prose while describing why that file's harness composes the chain by hand instead of calling the factory. Task 2's own instruction is explicit — "Do not change any other line of those seven files" — so these two pre-existing comment lines were left untouched. Every ACTUAL `createCmsRouter(...)` invocation (all 9 test call sites plus the production mount) verifiably passes `BOOTH_LINK`/`queue`, confirmed both by direct inspection (`grep -n` above) and by the full suite passing. Judged as a plan-authoring gap in a mechanical grep rather than a defect to fix by violating the plan's own stricter, plainly-stated instruction.

## Known Stubs

None. Every route, method and page this plan introduces is wired to a real caller (`QueueService`'s two new public methods, called from the real route file, mounted in the real router, threaded from the real `app.ts` mount with the real `queue` instance — no mock or placeholder anywhere in the production path). `test/helpers/cmsBoothLink.ts`'s `BOOTH_LINK` stub is test-only infrastructure, exactly the same role `OFFLINE_AGENT` already plays in six of these same files.

## Threat Flags

None beyond what `11-03-PLAN.md`'s own `<threat_model>` already registered (T-11-10 through T-11-15, T-11-SC) — no new network endpoint, auth path, file-access pattern or schema change was introduced outside that register. `POST /cms/api/booth/release` and `GET /cms/booth` are both named in the plan's own threat model.

## User Setup Required

None — no external service configuration required. The route is mounted automatically wherever `app.ts` is already deployed; no new environment variable, no new dependency (`11-RESEARCH.md`'s package-legitimacy audit remains not applicable — this plan added zero packages).

## Next Phase Readiness

D11-08's operator door is built, tested, and reachable from the CMS dashboard. The phase's remaining, and only remaining, gate is the physical one both 11-01 and 11-02 already named and deferred: the five-scenario live-booth verification in `11-CONTEXT.md`'s own `<verification>` section, with auto-print OFF on the real booth, including scenario 4 (the operator pressing this exact control mid-session). That gate requires a human at a physical dslrBooth and cannot be discharged from source — it is the phase's own closing checkpoint, not a Task 1–3 deliverable of any plan in this phase.

## Self-Check: PASSED

All 4 new files (`src/cms/cmsBoothRoutes.ts`, `src/cms/cmsBoothPages.ts`, `test/helpers/cmsBoothLink.ts`, `test/cms-booth-release.test.ts`) exist on disk. All 3 task commit hashes (`212a15a`, `3959c17`, `6c5f184`) exist in `git log --oneline --all`. This `SUMMARY.md` itself exists at the expected path. `git status --porcelain` in `mirror-request` is empty after the third commit. `npm test` reports 85/85 files, 1012/1012 tests passing. `npm run typecheck` and `npm run build` both exit 0.

---
*Phase: 11-retake-approval-anchor*
*Completed: 2026-08-18*
