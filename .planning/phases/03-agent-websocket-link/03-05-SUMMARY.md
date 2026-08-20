---
phase: 03-agent-websocket-link
plan: 05
subsystem: operations
tags: [documentation, runbook, phase-gate, cross-repo-smoke-check]
dependency-graph:
  requires:
    - phase: "03-01"
      provides: "The exact wire contract (header name, scheme, rejection response, query-string deletion) quoted verbatim into §7"
    - phase: "03-02"
      provides: "The displaced-Agent warning wording and connection-id format quoted into §7's log table"
    - phase: "03-03"
      provides: "Both dispatch-skip warning strings quoted into §7's log table"
    - phase: "03-04"
      provides: "The disconnect-requeue warning text and the no-retry/no-stall_reason contrast with §6"
  provides:
    - "mirror-request/docs/OPS-RUNBOOK.md §7 — the Agent WebSocket auth contract, synchronized-deploy rule, both-or-neither rollback, honest no-staging statement, and the six-line log guide"
    - "Phase 3 closed: all four preceding plans' work verified together, both repositories green and buildable, real cross-repo smoke check executed and passed"
  affects:
    - "Phase 4/5: whoever deploys any future change to the Agent link reads §7 first"
tech-stack:
  added: []
  patterns:
    - "Documentation-only task, verified by grep-count acceptance criteria against the rendered markdown rather than code assertions"
key-files:
  created: []
  modified:
    - mirror-request/docs/OPS-RUNBOOK.md
decisions:
  - "Task 2's blocking checkpoint (gate=\"blocking\") was resolved by explicit human decision, not self-approved — consistent with this phase's established precedent (03-01 Task 1). The human approved §7 unchanged and chose to run the optional cross-repo smoke check rather than decline it."
  - "The smoke check used the real dslrbooth-agent.exe-equivalent build (dist/index.js) against a real server instance on an ephemeral port with an isolated LOCAL_STORE_PATH, rather than a hand-rolled ws client — the human's stated reason was that a hand-rolled client would only re-test the server side, which unit tests already cover; the query-string-rejection case specifically required a real pre-D-05 client artifact standing in for an unupdated Agent, which no server-side test can construct."
  - "The masking defect the smoke check surfaced (connection ids partially asterisked in logs) is recorded here and in .planning/WINDOWS.md but deliberately NOT fixed — it is out of this plan's scope (documentation only, no src/ changes) and is a diagnostics-only degradation, not a functional defect."
metrics:
  duration: "~45 min (interactive: checkpoint pause + resume with smoke-check evidence)"
  completed: 2026-08-10
status: complete
actuals:
  tokens: 4600
  tasks: 2
  commits: 1
---

# Phase 3 Plan 05: Operations Runbook & Phase Gate Summary

Published the second integration contract this service owns — the Agent WebSocket auth
handshake, its synchronized-deploy requirement, and its both-or-neither rollback rule — in the
same file and voice as the first, then closed Phase 3 behind a real cross-repo smoke check that
proved the two independently-tested halves of the auth contract actually meet on a real wire,
including proof that the deleted query-string form is genuinely gone from the server's
perspective.

## What Was Built

**Task 1 — commit `9b20d9e`:**

Appended `## 7. Agent WebSocket auth contract (\`/agent\`)` to `mirror-request/docs/OPS-RUNBOOK.md`,
directly after §6, in the file's established voice (concrete headers and copy-pasteable commands,
tables over prose, absences stated outright):

- **The contract:** `Authorization: Bearer <token>` as the sole accepted form; `AGENT_WS_TOKEN`
  (server) and `EXTENSION_SERVICE_WS_TOKEN`/`EXTENSION_SERVICE_WS_URL` (Agent) named as the two
  variables that must hold the same secret; the 401-before-handshake rejection quoted verbatim
  from `agentServer.ts`; the never-logged-secret rule stated explicitly.
- **What breaks:** framed as an outage, not a degradation — every connection from an unupdated
  Agent is rejected, registrations keep queueing, nothing is ever dispatched.
- **Deploy ordering:** the concrete two-command sequence (`npm run build` in `mirror-request/`,
  `npm run build:exe` in `dslrbooth-agent/`), naming `dslrbooth-agent.exe` as the paired artifact.
- **Verification before cutover:** the two fast per-side test commands, followed by an explicit
  statement that they do not prove the two sides meet on a wire, followed by the honest
  no-staging-environment paragraph (no Dockerfile, no compose file, only `ecosystem.config.js`
  for pm2) and the local-rehearsal description.
- **Rollback:** the both-or-neither rule, with the reverse-outage explained rather than implied.
- **The log table:** six lines quoted verbatim from `agentServer.ts` and `queueService.ts` as they
  stand after all four preceding plans, each with its meaning, closing with the no-retry/no-
  `stall_reason` explanation tied explicitly to §6's session-side vocabulary.

Verification: `grep -c '^## 7\.'` → 1; `grep -c '^## '` → 7 (sections 1-6 untouched, unrenumbered);
`AGENT_WS_TOKEN` → 1; `EXTENSION_SERVICE_WS_TOKEN` → 2; `build:exe` → 2; `staging` (case-
insensitive) → 2; `git show --name-only HEAD -- src/` → empty (doc-only commit, as required);
`npm test` — 23 files, 155 tests, all green; `npm run typecheck` — clean.

**Task 2 — checkpoint, no files modified, no commit (as the plan specified):**

The blocking phase-gate checkpoint was presented to the human with the automated evidence
gathered in this session (both suites green, both typechecks clean, both builds clean, working
trees clean in both repos, all §7 content gates verified). The human resolved it explicitly:

**§7 approved as written, no changes requested.** The human specifically flagged three passages
as load-bearing and not to be edited away in any future touch of this file: the explicit
statement that the per-side tests "do not prove the two sides meet correctly on a real wire"; the
plain no-staging paragraph with its concrete evidence; and the closing note that a requeue with a
flat `retries` and empty `stall_reason` means a booth that was not there, not a bad job.

**The optional cross-repo smoke check was run, not declined, and passed.** Executed against the
real Agent build (`dslrbooth-agent/dist/index.js`), not a hand-rolled `ws` client — deliberately,
because a hand-rolled client would only have re-tested the server side, and the query-string-
rejection case specifically needed a real artifact predating D-05 to stand in for an unupdated
Agent.

**Setup:** server started on port 3199 with `AGENT_WS_TOKEN='smoke-test-shared-secret'` and an
isolated `LOCAL_STORE_PATH` in a scratchpad directory; the real Agent build pointed at it with a
matching `EXTENSION_SERVICE_WS_TOKEN`. Both freshly built.

**Results — all four cases behaved exactly as the contract requires:**

| Case | Result |
|---|---|
| Real Agent, matching token | Agent logs `WebSocket connected to Extension Service`; server logs `Agent connected` |
| Old form `?token=<secret>` | **HTTP 401** — the clean break is real, not just intended |
| No `Authorization` header | HTTP 401 |
| `Bearer wrong-secret` | HTTP 401 |
| `Bearer <correct>` | connects |

The old-query-string case is the one that mattered most: it is the only proof anywhere in this
phase that the deleted path is genuinely gone from a *client's* perspective, which no
server-side unit test could establish about a client that predates the contract.

**Cleanup:** both processes stopped; no stray `dist/index.js` running; the production database
was never touched (its mtime is unchanged from the Phase 2 restart) — the smoke run used its own
isolated SQLite file.

**The cutover decision:** the human explicitly accepted that the next production deploy must
ship server and Agent together. Production currently runs the pre-Phase-3 pairing, unaffected,
until that deploy happens.

**Resolution: approved.** The phase gate is closed.

## One Real Defect Found — Not Fixed, Out of Scope

The smoke check surfaced a defect no automated test caught: **connection ids are partially masked
in logs, degrading the displaced-Agent diagnostic §7 documents.**

Connection ids are minted in `agentServer.ts` as `` `agent-${Date.now()}-${++connSeq}` ``, which
contains a 13-digit millisecond timestamp. `mask()`'s `PHONE_RE = /\+?\d{7,}/g` in
`src/logging/logger.ts` rewrites any run of 7 or more consecutive digits, so every connection id
reaches the log asterisked. Observed live during the smoke check:

```
Agent connected: agent-*************-1
Agent connected: agent-*************-2
```

**Consequence:** §7's log table promises `Agent WS replaced: <old-id> displaced by <new-id>` as
the way to diagnose two Agents flapping against one server, but both ids render with their
timestamps asterisked — only the trailing sequence number still distinguishes them. Within one
process lifetime that is still enough; across a restart the counter resets to 1 and ids can
repeat. The diagnostic plan 03-02 deliberately built is **degraded, not destroyed.**

**Severity: minor** — diagnostics only, no functional impact on auth, dispatch, or the disconnect
policy. Notably, Phase 2's plan 02-03 anticipated exactly this class of problem ("log durations in
seconds/minutes, never milliseconds, because `mask()` would asterisk a millisecond figure") and
the same masking trap caught the connection id instead, in a different phase. A future fix would
give the id a non-numeric or shorter-run component; §7 may deserve a one-line caveat when that
lands.

**Recorded, not fixed:** this plan's scope is documentation only (`docs/OPS-RUNBOOK.md`, zero
`src/` changes per the task's own acceptance criteria) — fixing `agentServer.ts` is out of scope
here. Logged to `.planning/WINDOWS.md` as entry 5 (`kind: deviation`, phase 3, `open`).

## Deviations from Plan

None in Task 1 — executed exactly as written, every grep-count and content acceptance criterion
matched on the first attempt.

Task 2 executed exactly as the plan's own explicit instruction: the smoke check was run (not
declined) and its result — including the one defect it surfaced — is recorded here rather than
assumed away, per the plan's `<output>` requirement.

## Auth Gates

None. No CLI authentication was required for this plan.

## Known Stubs

None. §7 is complete, production-shaped documentation with no placeholder content.

## Threat Flags

None beyond what the plan's own `<threat_model>` already registered (T-03-24 through T-03-27) —
all four were discharged as designed: T-03-24 (unpaired-deploy DoS) and T-03-25 (secret in docs)
by §7's content; T-03-26 (requeue misdiagnosis) by §7's closing note; T-03-27 (the two halves not
meeting on a real wire) by the executed and passed smoke check.

## Verification

- `cd mirror-request && npm test` — 23 files, 155 tests, all green
- `cd mirror-request && npm run typecheck` — clean
- `cd mirror-request && npm run build` — clean
- `cd dslrbooth-agent && npm test` — 1 file, 4 tests, all green
- `cd dslrbooth-agent && npx tsc --noEmit -p tsconfig.json` — clean
- `cd dslrbooth-agent && npm run build` — clean
- Working tree clean in both repos after Task 1's commit
- `cd mirror-request && grep -c '^## ' docs/OPS-RUNBOOK.md` → 7
- Cross-repo smoke check executed and passed (see above) — the one Manual-Only Verification row
  in `03-VALIDATION.md` this plan could discharge with real evidence rather than a documented rule
- Neither obsolete `.planning/` tree (`mirror-request/.planning/`, `dslrbooth-agent/.planning/`)
  was read or written during this plan

## Self-Check: PASSED

- FOUND: `/opt/mirror_request_dslrobooth/mirror-request/docs/OPS-RUNBOOK.md` (§7 present)
- FOUND: commit `9b20d9e` (Task 1)
- Working tree clean in `mirror-request/` after the commit
- `cd mirror-request && npm test` — 23 files / 155 tests, all passing
- `cd dslrbooth-agent && npm test` — 1 file / 4 tests, all passing
- All grep-based content gates for §7 verified to match their required counts exactly
- `.planning/WINDOWS.md` entry 5 recorded for the masking defect

## Phase 3 Close-Out

All five plans executed. All six requirements (AUTH-01, AGT-01..05) already `[x]` in
`REQUIREMENTS.md` as of plan 03-04 — not re-marked here. `mirror-request/docs/OPS-RUNBOOK.md` now
carries both of this service's published integration contracts (§1 webhook signing, §7 Agent
auth) in the same voice. Both repositories are green, buildable, and clean. The one-way D-05
cutover is accepted by the human, with the cross-repo smoke check executed and passed rather than
left as an assumed gap. One minor, non-blocking diagnostics defect (connection-id masking) is
recorded and deferred, not silently dropped.

---
*Phase: 03-agent-websocket-link*
*Completed: 2026-08-10*
