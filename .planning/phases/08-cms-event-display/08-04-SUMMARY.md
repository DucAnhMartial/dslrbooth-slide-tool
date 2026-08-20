---
phase: 08-cms-event-display
plan: 04
subsystem: infra
tags: [websocket, agent-config, cms, express, winston, allow-list, cross-repo]

requires:
  - phase: 03-agent-link
    provides: the authenticated WS /agent link, AGT-01..05 (connect, dispatch, ack, events, heartbeat)
  - phase: 08-01
    provides: the agent_config table with its current+previous shape, the CMS gate and session boundary
  - phase: 08-03
    provides: the shared disabled-plus-spinner in-flight pattern and the CMS page chrome
provides:
  - "The config_request / config / reload_config message triple, strictly additive to AGT-01..05"
  - "A safe-field allow-list enforced in code in BOTH repositories, asserted equal by test"
  - "Live-mutable dslrBooth credentials on the Agent (DslrBoothClient.updateCredentials)"
  - "The CMS Agent-configuration page with server-side refusal of the four read-only fields and D-18's one step back"
affects: [agent-operations, cms, ops-runbook, phase-09]

actuals:
  tokens: 25692
  tasks: 3
  commits: 6

tech-stack:
  added: []
  patterns:
    - "Two independent allow-lists, one per repository, asserted equal by a cross-repo import in a test"
    - "Live value holder with getters read at call time, replacing values captured at construction"
    - "Request-only inbound message: the handler seam takes no arguments, so the wire cannot be read"

key-files:
  created:
    - mirror-request/src/agent/agentConfigContract.ts
    - mirror-request/src/cms/cmsAgentRoutes.ts
    - mirror-request/src/cms/cmsAgentPages.ts
    - mirror-request/test/agent-config-message.test.ts
    - mirror-request/test/cms-agent-config.test.ts
    - dslrbooth-agent/src/liveConfig.ts
    - dslrbooth-agent/src/agentMessages.ts
    - dslrbooth-agent/test/config-reload.test.ts
  modified:
    - mirror-request/src/agent/agentServer.ts
    - mirror-request/src/cms/cmsRouter.ts
    - mirror-request/src/cms/cmsEventPages.ts
    - mirror-request/src/index.ts
    - dslrbooth-agent/src/dslrbooth/client.ts
    - dslrbooth-agent/src/index.ts

key-decisions:
  - "logDir is read-only, joining D-16's three forbidden fields (RESEARCH Assumption A1 adopted, recorded not dropped)"
  - "Commit order is service-repo-first in every task, so no Agent in the field ever emits a type the deployed service does not know"
  - "config_request is sent bare — no snapshot, no credentials — deviating from RESEARCH Pattern 3's example, which would have put the dslrBooth password on the wire toward the service for no reader"
  - "dslrBoothPassword has no shipped default: absent, not empty, so a seed can never overwrite the password a booth was installed with"
  - "The second restore is refused (409), not a second swap — 08-01's landed one-step semantics kept over the plan's swap-back acceptance wording"
  - "The Agent type-checks inbound values and drops mismatches; protocol hygiene at a network boundary, not the Agent deciding anything"

patterns-established:
  - "Cross-repo contract equality: liveConfig.ts carries only `import type`, so the service's test suite can import it and assert the two allow-lists match"
  - "Handler-arity as a structural control: registerConfigRequestHandler's callback takes zero arguments, so an inbound payload is unreadable by construction"

requirements-completed: [UI-02, CMS-01, CMS-03]

coverage:
  - id: D1
    description: "The Agent requests its configuration on connect and after a reload command; the service answers from agent_config with only allow-listed fields and reads nothing off the request"
    requirement: UI-02
    verification:
      - kind: integration
        ref: "mirror-request/test/agent-config-message.test.ts#answers a config_request with a config message carrying exactly the four allow-listed keys"
        status: pass
      - kind: integration
        ref: "mirror-request/test/agent-config-message.test.ts#ignores every field riding on the inbound config_request — the stored row is left deep-equal"
        status: pass
      - kind: unit
        ref: "dslrbooth-agent/test/config-reload.test.ts#answers reload_config with exactly one config_request and nothing else"
        status: pass
    human_judgment: false
  - id: D2
    description: "A CMS change to dslrBoothApiPort or dslrBoothPassword actually changes which port and password the next start_session call uses"
    requirement: UI-02
    verification:
      - kind: integration
        ref: "dslrbooth-agent/test/config-reload.test.ts#applies a new dslrBoothApiPort so the very next startSession() call lands on it"
        status: pass
      - kind: integration
        ref: "dslrbooth-agent/test/config-reload.test.ts#applies dslrBoothApiPort and dslrBoothPassword together — both reach the next API call"
        status: pass
    human_judgment: false
  - id: D3
    description: "The four non-editable fields are ignored and warned on both sides, and the two allow-lists cannot drift apart silently"
    requirement: UI-02
    verification:
      - kind: unit
        ref: "dslrbooth-agent/test/config-reload.test.ts#The four read-only fields are structurally unreachable from the wire (D-16, T-08-20) — four cases"
        status: pass
      - kind: unit
        ref: "mirror-request/test/agent-config-message.test.ts#the service allow-list and the Agent allow-list name exactly the same four fields"
        status: pass
      - kind: unit
        ref: "mirror-request/test/cms-agent-config.test.ts#refuses a save carrying any of the four non-editable fields, server-side, leaving the row untouched"
        status: pass
    human_judgment: false
  - id: D4
    description: "The CMS Agent-configuration page: four editable fields, four explained read-only rows, a never-echoed password, one bare reload per mutation, and D-18's one step back"
    requirement: CMS-01
    verification:
      - kind: integration
        ref: "mirror-request/test/cms-agent-config.test.ts — 13 cases"
        status: pass
    human_judgment: true
    rationale: "The page's rendered appearance, Vietnamese copy tone and the in-flight spinner behaviour in a real browser are visual properties; the tests assert structure and strings, not that an operator can read and use it under pressure mid-event."
  - id: D5
    description: "Agent configuration survives a service restart because it lives in agent_config"
    requirement: CMS-03
    verification:
      - kind: integration
        ref: "mirror-request/test/cms-agent-config.test.ts#survives a service restart — the configuration lives in agent_config, not in memory (CMS-03)"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-08-12
status: complete
---

# Phase 8 Plan 04: Remote Agent Configuration (UI-02) Summary

**The booth Agent is now configurable from the operator console for exactly four fields, by pull over the existing authenticated link, with the three bootstrap credentials and the log directory structurally unreachable from the network and one step back for a bad save.**

## Performance

- **Duration:** 25 min
- **Tasks:** 3 of 3
- **Files modified:** 14 across two repositories (8 created, 6 modified), plus 3 existing CMS test files updated for the router signature

## Accomplishments

- **UI-02 is functional, not just wired.** `DslrBoothClient` held its port and password as `readonly` constructor parameters, so a plan that shipped only message plumbing would have looked complete and changed nothing. The class is now live-mutable via `updateCredentials()`, and the proof is a test that applies a new port and then drives a real HTTP request at a stub server to read which port it arrived on — an assertion on a holder's getter would have passed against the broken build.
- **The safe/forbidden boundary is structural on both sides.** Each repository carries exactly one named allow-list constant; the service projects to four keys before sending and the Agent applies four keys and warns on anything else, so neither side depends on the other behaving. A cross-repo import in the service's test asserts the two arrays name the same four fields, so drift surfaces as a red test rather than as an applied field.
- **Configuration flows one way by construction.** `registerConfigRequestHandler`'s callback takes zero arguments — there is structurally nothing off the inbound message it could read, even if a future edit wanted to. A `config_request` carrying an unsolicited payload leaves the stored row deep-equal and rotates nothing into the one-step history.
- **The existing Agent link is untouched.** The `ack`, `event`, `heartbeat` and unknown-type branches and the bearer-token upgrade path behave exactly as AGT-01..05 pin them, asserted by a regression case. The dslrBooth Local API call site in the Agent's `index.ts` is byte-identical; the only line added near it wires the credential holder.

## Task Commits

Commits are listed in the order they were made. **Ordering rationale is in its own section below.**

**mirror-request** (branch `master`):

1. **Task 1 (RED)** — `67e0520` `test(08-04): failing cases for the Agent config pull triple (D-16, D-17)`
2. **Task 1 (GREEN)** — `50e1891` `feat(08-04): answer the Agent's config_request from agent_config (D-16, D-17)`
3. **Task 2** — `5872abf` `test(08-04): the service's allow-list boundary, and cross-repo list equality`
4. **Task 3 (RED)** — `f06c7e7` `test(08-04): failing cases for the CMS Agent-configuration page (UI-02, D-16, D-18)`
5. **Task 3 (GREEN)** — `6e22ef1` `feat(08-04): the CMS Agent-configuration page, the reload, and one step back`

**dslrbooth-agent** (branch `master`, a separate repository):

1. **Task 1 (RED)** — `1fb9617` `test(08-04): failing cases for live Agent config and the reload round trip`
2. **Task 1 (GREEN)** — `fe7d21f` `feat(08-04): live in-memory config on the Agent, applied by pull (D-16, D-17)`
3. **Task 2** — `ff5a23c` `test(08-04): all four safe fields applied, all four read-only ones ignored`

No commit mixes the two repositories; the Agent's files are not in the service's repository and were committed with a separate working directory.

## Commit Ordering Across Two Repos

**Chosen order: the service repository first, in every task.**

Both message directions were checked against an older peer before choosing:

- **Newer service, older Agent (the order shipped).** An old Agent never sends `config_request`, so the new branch is dead code for it. If an operator saves in the CMS, the service sends `{type:'reload_config'}`; the old Agent's `onMessage` chain falls through `announcement` and then `if (msg.type !== 'command') return` — silently ignored, no crash, no behaviour change. A `config` message would be ignored the same way. **AGT-01..05 keep working unchanged.**
- **Newer Agent, older service (the order avoided).** The Agent would send `config_request` on every connect and every reconnect, and the old service's final `else` would log `Agent WS: unknown message type "config_request"` each time. Functionally safe — the Agent keeps its `.env` values — but it fills the operational log with warnings about a message the deployment cannot answer, exactly where the displaced-Agent diagnostics live.

Service-first is therefore strictly better: the source of truth exists before anything asks it for anything, and no Agent in the field ever emits a type the deployed service does not know. Within each task the RED test commit precedes its implementation, matching the repository's established `test(08-0x)` → `feat(08-0x)` pattern.

## Files Created/Modified

**mirror-request**
- `src/agent/agentConfigContract.ts` (new) — the one allow-list on this side, the four read-only field names, the shipped defaults, `pickSafeAgentConfig()` (warns once per dropped key, names only), and `readAgentConfigForAgent(store)`.
- `src/agent/agentServer.ts` — a `config_request` branch beside `ack`/`event`/`heartbeat`, and `registerConfigRequestHandler(fn)`. `isValidBearerToken()` and the upgrade path untouched.
- `src/cms/cmsAgentRoutes.ts` (new) — `GET /cms/agent`, `POST /cms/api/agent`, `.../restore`, `.../test`; `validateAgentConfigSubmission()` refuses any submission carrying a non-editable field.
- `src/cms/cmsAgentPages.ts` (new) — the page, the Vietnamese copy constants, and the read-only rows that explain the trip to the booth.
- `src/cms/cmsRouter.ts` — mounts the Agent routes behind the same session boundary; now takes the Agent link.
- `src/cms/cmsEventPages.ts` — `page()` and `LOGOUT_FORM` promoted to exports (see Deviations).
- `src/index.ts` — registers the config-request answer and passes `agentServer` to the CMS router.
- `test/agent-config-message.test.ts` (new, 13 cases), `test/cms-agent-config.test.ts` (new, 13 cases).

**dslrbooth-agent**
- `src/liveConfig.ts` (new) — the Agent's allow-list, live getters, `apply()` that warns on and drops anything not allow-listed, `snapshot()`, and log-level fan-out to every transport.
- `src/agentMessages.ts` (new) — the `config`, `reload_config` and `announcement` branches, testable outside `main()`.
- `src/dslrbooth/client.ts` — `port`/`password` no longer `readonly`; `updateCredentials()` added. Nothing else changed.
- `src/index.ts` — builds the live holder, requests config on connect, delegates the three branches. The `command` branch and the dslrBooth call site are unchanged.
- `test/config-reload.test.ts` (new, 24 cases).

## Decisions Made

1. **`logDir` is read-only — RESEARCH Assumption A1 resolved, not dropped.** D-16 classified 7 of the Agent's 8 fields and left `logDir` unnamed. The restrictive default is adopted, on RESEARCH's stated reasoning: it is filesystem-path configuration, closer in kind to the bootstrap fields than to the operational-tuning ones; no `logDir` control appears anywhere in 08-UI-SPEC's Agent surface; and an unwritable path would silently blackhole every future Agent log — a failure that destroys the evidence of itself. It is named in both repositories' `READ_ONLY_AGENT_CONFIG_FIELDS` constants, refused by the CMS save, ignored-and-warned by the Agent, and rendered as a read-only row. **This is my decision as executor, following the planner's adoption of RESEARCH's recommendation — it is not a human-approved decision.**
2. **`config_request` is sent bare.** RESEARCH Pattern 3's example sends `{ type: 'config_request', current: snapshot() }`. The snapshot includes `dslrBoothPassword`, and the service ignores inbound fields on this message by construction — so that payload would be the booth's dslrBooth password travelling toward the service for no reader. Dropped.
3. **`dslrBoothPassword` has no shipped default.** `DEFAULT_AGENT_CONFIG` seeds `logLevel`, `autoOpenDisplay` and `dslrBoothApiPort` only. An empty string is a value; seeding it and sending it would overwrite the password the booth was installed with on the first CMS visit. The Agent also refuses an empty password on receipt, as a second guard.
4. **The Agent type-checks what it applies.** A `logLevel` outside winston's npm levels, a non-integer or out-of-range port, a non-boolean flag or an empty password is warned about and dropped. This is protocol hygiene at a network boundary, not the Agent deciding anything — it refuses nonsense, it never chooses a better value.
5. **The connection test sends nothing.** It reads `isAgentOnline()`, which the existing heartbeat already maintains. Inventing a second liveness probe would give the operator two answers that can disagree.

## Deviations from Plan

### 1. [Rule 3 — Blocking] A new Agent module, `src/agentMessages.ts`, beyond the plan's declared file list

- **Found during:** Task 1.
- **Issue:** Two of the plan's own acceptance criteria are behavioural and live inside the Agent's `ws.onMessage` chain: "a `reload_config` message causes exactly one outgoing `config_request` and no other outgoing message", and "the announcement path reads the auto-open flag through the live holder by flipping it and observing the display-open call count change". That chain was inline in `index.ts`, which builds its whole world inside `main()` and calls `main()` at module load — importing it from vitest would run `loadConfig()`, fail on missing env, and call `process.exit(1)`. Both criteria were untestable as written, and the plan forbids asserting a constant's contents by grepping source.
- **Fix:** Extracted only the `config`, `reload_config` and `announcement` branches into `src/agentMessages.ts` behind a handler that returns `false` for anything it does not consume. The `command` branch — the dslrBooth Local API call site that AGT-02/AGT-03 pin — deliberately stayed in `index.ts`, so the acceptance criterion "`git diff` touches no dslrBooth Local API call site other than the credential holder" holds literally (verified: the only added line near it is the `updateCredentials` wiring).
- **Verification:** `dslrbooth-agent` suite 28 tests green, `npm run build` exit 0, and the diff of `src/dslrbooth/` contains only the credential-holder change.
- **Committed in:** `fe7d21f`.

### 2. [Rule 3 — Blocking] `page()` and `LOGOUT_FORM` promoted to exports in `cmsEventPages.ts`

- **Found during:** Task 3.
- **Issue:** The plan requires the Agent page to reuse plan 08-03's shared in-flight disabled-plus-spinner pattern "rather than re-invent" it, but `page()`, `STYLES` and `INFLIGHT_SCRIPT` were module-private. `cmsEventPages.ts` is not in this plan's declared file list.
- **Fix:** Two `export` keywords added, no behaviour change. This is exactly the follow-up `cmsEventPages.ts`'s own header comment recorded ("promoting the block to a shared export is a two-line follow-up"), now safe because no parallel plan owns that file.
- **Verification:** Full mirror-request suite green (630 tests), typecheck and build exit 0.
- **Committed in:** `6e22ef1`.

### 3. [Rule 3 — Blocking] `createCmsRouter` signature gained a third argument; three existing CMS test files updated

- **Found during:** Task 3.
- **Issue:** The Agent routes need `isAgentOnline()` and `sendEvent()`, which live on `AgentServer`; `createCmsRouter(store, cfg)` had no way to reach it. A default-to-offline stub was rejected — a production wiring mistake would then present as "Agent always offline" rather than a type error.
- **Fix:** `createCmsRouter(store, cfg, agent)`. `index.ts` passes `agentServer`. The three existing suites that build the real router (`cms-access-control`, `cms-event-tracer`, `cms-upload-validation`) now pass an explicit `OFFLINE_AGENT` stub — those files are outside the declared list, but leaving them silently passing `undefined` would have been a latent trap that typecheck cannot catch (tsconfig includes `src/**` only).
- **Verification:** All three suites green; full suite 630 tests green.
- **Committed in:** `6e22ef1`.

### 4. [Plan-internal conflict] Restore-previous keeps 08-01's one-step semantics rather than swapping back

- **Found during:** Task 3.
- **Conflict:** The plan's Task 3 `<behavior>` says "a second restore does not rotate a third time", while its acceptance criteria say to "restore again and assert the values have swapped back". These describe different mechanisms. Plan 08-01 already landed `restorePreviousAgentConfig()` clearing `previous_json` as it restores, with an explicit docstring rationale: "Without that, a second restore would hand back the configuration the operator had just rejected — the same button doing the opposite thing on the second press, with no indication it had."
- **Resolution:** Kept 08-01's landed semantics and the plan's `<behavior>` wording. The second restore returns `409` with `Không có cấu hình trước đó để khôi phục.`, the stored row is unchanged, and no reload is sent. Implementing the swap would have required modifying `localStore.ts` — outside this plan's file list — and reversing a documented prior-wave decision. **Recorded as my own resolution, not a human decision.** If the swap is genuinely wanted, it is a store-level change and belongs in its own plan.
- **Verification:** `test/cms-agent-config.test.ts#steps back exactly one configuration, and a second restore rotates nothing new in (D-18)`.

### 5. [Process] Task 2 had no RED phase of its own on the Agent side

- **Issue:** `LiveConfig.apply()` could not be half-written in Task 1 — a version that applied a field without the allow-list check would have been a knowingly unsafe intermediate commit on the exact boundary this plan exists to build. So Task 2's Agent behaviour was already implemented when its tests were written, and those tests passed on first run.
- **Compensation:** The plan's own non-vacuity procedure was run instead, on both sides, and is the substitute proof — see "Non-Vacuity Mutations" below.

### 6. [Process] The tracer human-review gate was not surfaced as a stop

Task 1 is `type="tracer"`, which normally means committing the slice and then pausing for a human to verify the working end-to-end path before any expansion task. This run was scoped end-to-end by the orchestrator (execute the plan, report both suites' final status), so I ran the tracer's automated `<verify>` and continued rather than stopping. **I am flagging this as my own decision, the same way two earlier executors in this phase did — no human verified the tracer slice.** What a human has not seen: an operator changing a value in a real browser and a real Agent process picking it up over a real socket. Everything below that level is covered by the tests listed in `coverage`.

---

**Total deviations:** 3 auto-fixed (all Rule 3), 1 plan-internal conflict resolved, 2 process notes.
**Impact on plan:** No scope creep. Every deviation was required to make a stated acceptance criterion testable or to avoid contradicting a landed prior-wave decision.

## Non-Vacuity Mutations (run and reverted)

The plan requires proving the allow-lists are load-bearing rather than decorative. Each mutation was applied, the suite run, and the mutation reverted; the reverted state is what is committed.

| Mutation | Result |
|---|---|
| `dslrbooth-agent`: add `triggerServerPort` to `SAFE_AGENT_CONFIG_FIELDS` | **5 cases red**, including the per-field ignore case and the cross-list overlap assertion |
| `mirror-request`: add `triggerServerPort` to `SAFE_AGENT_CONFIG_FIELDS` | **7 cases red**, including "never lets a forbidden field reach the wire" and the cross-repo equality case |
| `mirror-request`: make `validateAgentConfigSubmission` skip non-allow-listed keys instead of refusing | **red** — "refuses a save carrying any of the four non-editable fields" |
| `mirror-request`: render a value into the password input | **red** — "never renders the stored dslrBooth password back into the page" |

Both suites verified green again after every revert.

## Issues Encountered

- **A flaky unhandled ENOENT in the Agent suite.** The case that asserts log-level fan-out builds a real logger via `createLogger()` with a temp `logDir`; deleting that directory in cleanup raced the daily-rotate transport's asynchronous flush and surfaced as an unhandled error that could have failed unrelated runs. Resolved by closing the logger and leaving the small temp file behind, with the reason written at the call site.
- **Cross-repo import viability.** The equality test imports `dslrbooth-agent/src/liveConfig` from the service's suite. This works only because that module has no runtime imports (`import type` only, erased at build) and because `mirror-request/tsconfig.json` includes `src/**` alone, so `tsc` never sees the test file. Both constraints are documented in the module header — breaking either one breaks the drift detector.

## Verification

| Check | Result |
|---|---|
| `mirror-request` `npm test` | **54 files / 630 tests green** (baseline 52 / 604 — +2 files, +26 tests) |
| `mirror-request` `npm run typecheck` | exit 0 |
| `mirror-request` `npm run build` | exit 0 |
| `dslrbooth-agent` `npm test` | **2 files / 28 tests green** (baseline 1 / 4 — +1 file, +24 tests) |
| `dslrbooth-agent` `npm run build` | exit 0 |
| `git diff 5244e3a..HEAD -- src/queue src/display src/ingestion` | empty — D-01's blast-radius boundary held |
| Zero new npm packages | confirmed, both `package.json` files unchanged |

## Known Stubs

None. Every field the page renders is wired to a real store read or a real store write, and the connection test reads the live link rather than a placeholder.

## Threat Flags

None. The surfaces this plan adds are the ones already enumerated in the plan's threat register (T-08-19 through T-08-24); no new endpoint, auth path or trust boundary appeared beyond them.

## User Setup Required

None — no environment variable is added on either side. An existing `.env` on a booth PC keeps working unchanged, and its values become the Agent's boot values until an operator saves in the CMS.

## Next Phase Readiness

- ROADMAP SC-7 / UI-02 is implemented and covered by tests on both sides.
- **Not yet done by a human:** the end-to-end walk — open `/cms/agent` in a browser, change the log level, and watch a real Agent process apply it over a real socket. `coverage` D4 is flagged `human_judgment: true` for the page's visual and copy qualities.
- **Worth carrying forward:** `OPS-RUNBOOK` has no section describing the new message triple or the fact that four Agent fields are now server-owned while four remain `.env`-only. An operator reading the runbook today would not know which is which.
- The Agent repository now has a test harness with a working stub-HTTP and logger pattern, which is the thing that made this phase's Agent-side work possible and did not exist before it.

## Self-Check: PASSED

All 8 claimed source/test files exist on disk; all 8 claimed commit hashes (5 in
`mirror-request`, 3 in `dslrbooth-agent`) resolve in their respective repositories;
both working trees are clean. `.planning/` is outside every git repository, so this
summary is intentionally not committed.

---
*Phase: 08-cms-event-display*
*Completed: 2026-08-12*
