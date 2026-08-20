---
phase: 05-client-api-display-feed
plan: 05
subsystem: docs, phase-gate
tags: [ops-runbook, phase-gate, windows-ledger, api-01, api-02, auth-03, d-06, d-07, d-09]
status: complete

requires:
  - phase: 05-client-api-display-feed
    provides: "createStatusRouter (05-01/05-02), DisplayServer's allow-list + injected store (05-03), the structurally-unmaskable connection id + non-ingestion masking regression (05-04)"
provides:
  - "OPS-RUNBOOK.md §9 — the published contract for GET /status/:jobId, WS /display, GET /display-screen"
  - "OPS-RUNBOOK.md §3 — DISPLAY_IP_WHITELIST and the three WAIT_ESTIMATE_* keys documented with real defaults"
  - "OPS-RUNBOOK.md §7 — a new subsection documenting the connection-id fix (no prior stale passage existed to correct — see Deviations)"
  - "A human-resolved phase gate: §9 approved, both manual-only verifications explicitly declined with a named blocker, WINDOWS ledger item 4 left open, the boothPaused response-shape change accepted"
  - "05-VALIDATION.md moved to status: validated, nyquist_compliant: true, all 10 Per-Task Verification Map rows claimed and green"
affects:
  - "gsd-ship (WINDOWS ledger items 4 and 6 remain open — /gsd-ship still blocks)"
  - "any future phase touching /status/:jobId, /display, or /display-screen (the published §9 contract)"

tech-stack:
  added: []
  patterns:
    - "Phase-gate checkpoint resolved by an explicit human decision, never self-approved, per this project's unbroken precedent (Phase 1 Task 3, 02-04 Task 3, 03-01 Task 1, 03-05 Task 2, 04-04 Task 3, now 05-05 Task 3)"
    - "A stale-documentation claim in the plan itself, independently checked before being written as fact rather than trusted"

key-files:
  created: []
  modified:
    - mirror-request/docs/OPS-RUNBOOK.md
    - .planning/phases/05-client-api-display-feed/05-VALIDATION.md
    - .planning/WINDOWS.md
    - .planning/REQUIREMENTS.md

decisions:
  - "D-07/D-06 unguessability: human-authorized not-confirmed-accept-risk, dev-only, quoted verbatim in §9's accepted-risks subsection; production remains blocked on WINDOWS ledger item 6 until the backend's id-minting scheme is confirmed CSPRNG-based."
  - "Both manual-only verifications (the room screen, a real guest's phone) declined at the gate — the service is stopped and Phase 3's Agent-auth cutover is still undeployed, so there is no live Agent link or live queue to exercise either check against. Recorded as declined, never as passed, matching Phase 4's own precedent for a declined end-to-end run."
  - "WINDOWS ledger item 4 left open by explicit human choice — closing it now would unlock nothing, since item 6 (D-06/D-07 entropy) blocks /gsd-ship independently and remains open regardless."
  - "The boothState/agentOnline -> boothPaused response-shape change accepted; the observable behind M3 success criterion 5 is preserved and directly asserted by test/status-api.test.ts:507-514. Phase 3 remains closed and AGT-05 remains [x] — this phase did not reopen it."

metrics:
  duration: ~50 min (across two sessions — Tasks 1-2 and the gate resolution)
  completed: 2026-08-11
  tasks: 3
  commits: 1

actuals:
  tokens: 5900
  tasks: 3
  commits: 1
---

# Phase 5 Plan 05: Phase Gate — OPS-RUNBOOK §9, Boundary Verification, and Human-Resolved Disposition Summary

OPS-RUNBOOK.md now carries the published contract for both guest-facing read surfaces this
phase built (§9), extended with four new config keys (§3) and a corrected account of the
connection-id fix (§7). Every boundary and hard-rule check the phase promised was run and
reported. The phase gate was resolved by an explicit human decision on all four required
items — not self-approved, not inferred — closing Phase 5.

## Task 1 — OPS-RUNBOOK §9, §3 additions, §7 connection-id documentation (`ed138a2`)

Every literal quoted was opened and confirmed against its source file before being written:

| Quoted group | Source file confirmed |
|---|---|
| 8-key response set, 6 guest-facing words, `GuestStatusResponse` | `src/status/guestStatus.ts` |
| `STATUS_MAP` mapping, `canServe`/suppression logic, generic-404 body `{"error":"job not found"}` | `src/status/statusRoute.ts` |
| Config keys/defaults (`WAIT_ESTIMATE_*`, `DISPLAY_IP_WHITELIST`, `HOST` default `0.0.0.0`) | `src/config.ts` |
| Allow-list matching rule, dot-star prefix, empty-list escape hatch | `src/security/ipAllowlist.ts` |
| Socket-403-before-handshake ordering, snapshot fields, given-name/full-name split, change-driven broadcast | `src/display/displayServer.ts` |
| `/display-screen`'s exact 403 JSON body `{"error":"Forbidden"}` | `src/index.ts` |
| Connection-id fix (`.replace(/(\d)(?=\d)/g, '$1x')`) | `src/agent/agentServer.ts` |
| `PHONE_RE` (`/\+?\d{7,}/g`) | `src/logging/logger.ts` |
| IPv4 vs. IPv4-mapped address-form measurement | `05-03-PLAN.md`, cross-checked against `test/display-access-control.test.ts` |
| D-07 human resolution, verbatim | `05-01-SUMMARY.md` |

`git show --name-only --format= ed138a2` lists exactly one path, `docs/OPS-RUNBOOK.md`.
`npm test` after this commit: 31 files / 258 tests green, unchanged from baseline.

### Two findings surfaced rather than silently absorbed

**1. The two 403 refusal bodies are NOT literally identical**, contrary to the plan's own
action text. Measured: `GET /display-screen` (Express) returns `403 {"error":"Forbidden"}`;
`WS /display`'s refusal happens at the raw-socket layer, before any HTTP response object
exists, and carries no body at all — only the raw status line
`HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n`. Both are generic and
non-distinguishing (the actual security property D-09 needs), but the literal bytes differ.
§9 states this precisely instead of writing the plan's assumed claim as fact.

**2. §7's promised "stale masking-limitation paragraph" and "stale id-shape description" did
not exist to correct.** Inspection of the full 617-line pre-Task-1 file found no such
paragraph anywhere in §7 — the file's one masking-limitation paragraph (§6, "Reading the logs
vs. reading the database") describes **job-id** masking, a different value from connection
ids, and was never inaccurate. Rather than fabricate a "correction" to text that doesn't
exist, a new §7 subsection ("Connection id format (WINDOWS ledger item 5, fixed in Phase 5)")
was written, opening with an explicit note that this discrepancy exists and is not silently
reconciled.

## Task 2 — Boundary verification and the closing checklist (no commit — no finding required a runbook change)

All ten checks executed and reported with raw output. `mirror-request`'s own working tree was
clean throughout; its stale `.planning/` tree was confirmed untouched
(`git status --short -- .planning/` empty at every checkpoint).

| # | Check | Result |
|---|---|---|
| 1 | Phase boundary (`src/queue/`, `src/notifications/`, `src/ingestion/`, `src/display/displayPage.ts`) | empty on all four; `src/agent/agentServer.ts` appears as expected — full diff quoted and confirmed to touch only the id-mint line and its added comment |
| 2 | Hard rules | MySQL client confined to `src/ingestion/dbPoller.ts`, unchanged across the whole phase; no new `INSERT`/`UPDATE`/`DELETE` against the backend DB (only the English word "delete" inside prose comments); no dslrBooth Local API calls in any new Phase 5 code |
| 3 | No proxy trust | `grep -rn "trust proxy" src/ \| grep -vE ':[0-9]+:[[:space:]]*(//\|\*\|/\*)'` → empty; both raw hits are doc comments explaining the absence |
| 4 | Dead schema (`session_started_at`) | **3** non-comment occurrences — `types.ts:21`, `localStore.ts:41`, `localStore.ts:189` — none an assignment. A 4th raw hit at `localStore.ts:358` is a comment, correctly excluded |
| 5 | Retry policy call sites | `this.handleStall(` in `queueService.ts`: exactly **3**, at lines **120, 179, 292** |
| 6 | No new dependency | `git diff 419763f..HEAD -- package.json package-lock.json` → empty |
| 7 | Closing checklist | Three back-to-back `npm test` runs: **31/258**, **31/258**, **31/258** — identical, no flake. `npm run typecheck` → exit 0. `npm run build` → exit 0 |
| 8 | Validation contract | All 10 rows of `05-VALIDATION.md`'s Per-Task Verification Map claimed (plan+task named) and run green — see below |
| 9 | WINDOWS entry 5 | Confirmed against shipped `agentServer.ts`; marked fixed via `gsd-tools windows fixed 5`, run from `/opt/mirror_request_dslrobooth` |
| 10 | WINDOWS entry 4 | Independently re-measured — see below |

### Check 8 detail — all 10 validation rows

`05-VALIDATION.md`'s frontmatter set to `status: validated`, `nyquist_compliant: true`,
`wave_0_complete: true`; the Per-Task Verification Map's `TBD`/`⬜ pending` placeholders
replaced with the actual plan/task IDs and results:

| Requirement | Test file | Plan/Task | Tests |
|---|---|---|---|
| API-01 (shape + wait estimate) | `test/status-api.test.ts` | 05-01 T2, 05-02 T2-3 | 27, green |
| API-01 (`estimateWaitMs()`) | `test/estimate-wait.test.ts` | 05-01 T3 | 12, green |
| API-01 (generic 404) | `test/status-api.test.ts` | 05-02 T2 | part of 27, green |
| API-01 (vocabulary) | `test/status-vocabulary.test.ts` | 05-02 T1 | 15, green |
| API-02 (broadcast) | `test/phase5-display.test.ts` | 05-03 T3 | 8, green |
| API-02 (no PII) | `test/phase5-display.test.ts` + `tsc --noEmit` | 05-03 T2-3 | green |
| API-02 (allow-list) | `test/display-access-control.test.ts` | 05-03 T1, T3 | 8, green |
| API-02 (injected store) | `test/phase5-display.test.ts` | 05-03 T2-3 | green |
| AUTH-03 (non-ingestion masking) | `test/logging-mask.test.ts` | 05-04 T2 | 16 file total, green |
| AUTH-03 (connection-id fix) | `test/logging-mask.test.ts` | 05-04 T1 | part of 16, green |

No row was left unclaimed.

### Check 10 detail — WINDOWS ledger item 4, independently re-measured

`grep -rn "getStore" test/ | grep -vE ':[0-9]+:\s*(//|\*|/\*)'` → **32 genuine hits across
exactly 4 files**:

| File | Measured count | Plan's stated count | Match? |
|---|---|---|---|
| `on-register-auth.test.ts` | 14 | 14 | yes |
| `on-register-dedup.test.ts` | 10 | 10 | yes |
| `logging-mask.test.ts` | 5 | 5 | yes |
| `local-store-persistence.test.ts` | **3** (lines 6, 60, 64) | 4 | **no** |

**The `local-store-persistence` 3-vs-4 discrepancy, resolved:** the plan's stated "4" appears
to include line 61 (`// getStore() is a process-wide singleton...`), which is a comment and is
correctly excluded by the mandated `grep -vE ':[0-9]+:\s*(//|\*|/\*)'` filter. This is a
correction to the plan text, stated plainly rather than reconciled silently, and it does not
change the load-bearing number: `local-store-persistence.test.ts` is excluded from the
residual-defect count either way, because — confirmed by opening it — its own `it()` case is
titled `'getStore() with no argument still resolves the configured LOCAL_STORE_PATH exactly
as before'`; it is a dedicated test *of* `getStore()` itself, and migrating it away from the
singleton would delete the coverage, not improve it.

The 7 other named files (`agent-auth`, `agent-disconnect-requeue`, `agent-heartbeat-timeout`,
`agent-replacement`, `queue-event-coverage`, `queue-fifo-retry`, `queue-idempotency`) plus
`phase5-display.test.ts`, `display-access-control.test.ts`, and `status-api.test.ts` all
independently confirmed to have **zero** genuine (non-comment) `getStore()` uses — three of
the named files carry the decoy comment line `// runs getStore() at module load time...`,
correctly filtered.

**Independently measured genuine residual: 3 files** — `on-register-auth.test.ts`,
`on-register-dedup.test.ts`, `logging-mask.test.ts`, all Phase-1 ingestion tests — matching the
plan's corrected number exactly.

## Task 3 — Phase gate, resolved by explicit human decision

**Precedent held.** `workflow.autoApprove` and `workflow._auto_chain_active` are both false;
this plan's Task 3 was not self-approved, inferred, or proceeded past. The executor halted
with a `## CHECKPOINT REACHED` message laying out all four items with every measured number,
and a fresh continuation resumed only after the human answered.

### 1. OPS-RUNBOOK §9 + §3 + §7 — **APPROVED**

The human selected "Duyệt" (approve), unchanged. The approval explicitly covers both
discrepancies surfaced in Task 1 before the approval was given: the non-identical 403 bodies
between `/display-screen` and `/display`, and the §7 passage that did not exist and was
documented as new content rather than a fabricated correction. Both were surfaced, then
approved as-is — no runbook edit followed the gate.

### 2. Manual-only verifications — **BOTH DECLINED**

The human selected "Hoãn cả hai" (defer both):

- **The room's big screen** (`/display-screen` on the real display machine, from an
  allow-listed address, confirming the current guest, countdown, and Agent indicator update
  live) — **declined**.
- **A real guest's phone** (after the Phase 3 Agent-auth cutover deploys, register through the
  real QR flow, confirm the wait shows as a range) — **declined**.

**Reason, recorded verbatim in intent:** the service is stopped and the Phase 3 Agent-auth
cutover is still undeployed, so there is no live Agent link and no live queue to run either
check against. This is a deliberate deferral with a named blocker, exactly as Phase 4 recorded
its own declined end-to-end run. **No proxy test was substituted for either check, and neither
API-01 nor API-02 is credited with automated coverage it does not have** — both remain open
manual verifications, carried forward past this phase's close.

### 3. WINDOWS ledger entry 4 — **LEFT OPEN**

The human selected "Để mở" (leave open). `gsd-tools windows waive 4` was **not** run; the 3
remaining files were **not** migrated; the entry is unchanged from Task 2's re-measurement.

**Reasoning context, recorded:** WINDOWS ledger item 6 (the D-06/D-07 capability-URL entropy
question) blocks `/gsd-ship` independently and remains open regardless of item 4's
disposition, so closing item 4 now would unlock nothing. The independently measured residual
stands as reported above: **3 files** (`on-register-auth.test.ts`, `on-register-dedup.test.ts`,
`logging-mask.test.ts`), with `local-store-persistence.test.ts` excluded because it is a
deliberate test of `getStore()` itself, and the 3-vs-4 discrepancy in that file's own count
resolved as a comment-inclusion error in the plan's earlier text (line 61).

`.planning/WINDOWS.md` at the close of this plan: `open_count: 2` (entries 4 and 6),
`fixed_count: 3` (entries 1, 3, 5), `waived_count: 1` (entry 2).

### 4. The `/status/:jobId` response-shape change — **ACCEPTED**

The human selected "Chấp nhận" (accept). `boothState` and `agentOnline` are gone from the
response; `boothPaused` stands as the single guest-facing flag.

**Accepted on the cited evidence:** `test/status-api.test.ts:507-514`
(`'emits no waitEstimate key at all and reports the booth paused when the Agent is offline'`)
asserts `boothPaused === true` when `isAgentOnline()` returns `false`, preserving the
observable behind M3 success criterion 5 ("No heartbeat 30s → Agent offline in status API").
**Phase 3 remains closed and AGT-05 remains `[x]`** — this phase did not reopen either.

**External-consumer question:** no new information has emerged since 05-01 Task 1's answer
("no known external consumer of `queuePosition`, `queueLength`, `boothState`, `agentOnline` or
`guestName`"). That answer **stands unchanged**, not re-confirmed — nothing new was checked at
this gate.

## Deviations from Plan

**1. [Rule 1 — measurement correction, disclosed] The plan's claim of "both refusals share an
identical body" is inaccurate**
- **Found during:** Task 1, while writing §9's display-surfaces section.
- **Issue:** the plan's action text asserted the `/display-screen` and `/display` 403 refusals
  carry "an identical body." Measured against `src/index.ts` and
  `src/display/displayServer.ts`: the Express route returns a JSON body,
  `{"error":"Forbidden"}`; the raw-socket WS refusal, which happens before any HTTP response
  object exists, carries no body at all.
- **Fix:** §9 states the accurate distinction — both are a generic, non-distinguishing 403
  with no failure-reason detail (the actual security property), but the literal bytes differ —
  rather than writing the plan's unverified claim as fact.
- **Files modified:** `mirror-request/docs/OPS-RUNBOOK.md` (within Task 1's already-planned
  commit; no separate commit).
- **Not corrected in the plan itself** — this SUMMARY and the runbook are the record.

**2. [Rule 1 — measurement correction, disclosed] §7's promised stale passage did not exist**
- **Found during:** Task 1, reading the full pre-existing `OPS-RUNBOOK.md` before editing §7.
- **Issue:** the plan instructed "correct §7's stale masking-limitation paragraph and
  id-shape description." No such paragraph exists anywhere in the 617-line file at
  `2c0dd44` — the file's one masking-limitation paragraph (§6) describes job-id masking, a
  different value, and was never inaccurate.
- **Fix:** wrote a new §7 subsection describing the connection-id fix, opening with an
  explicit note that no prior stale passage was found, rather than silently absorbing the
  discrepancy or fabricating a "correction" to non-existent text.
- **Files modified:** `mirror-request/docs/OPS-RUNBOOK.md` (within Task 1's already-planned
  commit; no separate commit).

**3. [Correction, disclosed] `local-store-persistence.test.ts`'s "4 genuine uses" is measured
as 3**
- **Found during:** Task 2, check 10, independently re-measuring WINDOWS ledger item 4.
- **Issue:** the plan's own corrected table stated `local-store-persistence` has 4 genuine
  non-comment `getStore` uses. The comment-filtered grep finds 3 (lines 6, 60, 64); a 4th raw
  hit at line 61 is a comment (`// getStore() is a process-wide singleton...`), correctly
  excluded by the mandated filter.
- **Fix:** none required — this file is excluded from the residual-defect count under either
  number, since it is a dedicated test of `getStore()` itself. Recorded as a correction to the
  plan's own text per the "say so plainly, do not reconcile silently" instruction, with no
  effect on the gate's load-bearing 3-file residual number.
- **Files modified:** none.

No acceptance criterion from `05-05-PLAN.md` was found unmet by the committed work.

## Known Stubs

None. This plan wrote documentation and verification only; no source or test file was created
or modified in `mirror-request/src/` or `mirror-request/test/` (only
`mirror-request/docs/OPS-RUNBOOK.md`), matching the plan's own prohibition.

## Threat Flags

None beyond what `05-05-PLAN.md`'s own `<threat_model>` already registers.
T-05-12 (`DISPLAY_IP_WHITELIST` unset in production) is mitigated: §3 documents the fail-fast.
T-05-06 (capability-URL entropy) is mitigated per the human's dev-only resolution, with the
production gap tracked openly as WINDOWS ledger item 6 — never silently closed.
T-05-05 (uncapped `/display` connections) is documented as accepted in §9.
T-05-15 (a phase closed on an unverified claim) is mitigated: Task 2 ran every check with raw
output recorded, and Task 3 was a real blocking human gate, not self-approved.
T-05-SC (npm/pip/cargo installs) is confirmed closed: `package.json`/`package-lock.json`
unchanged across the entire phase (check 6).

## Verification — Measured, Not Asserted (final, post-gate)

Re-run after gate resolution, per the coordinator's instruction:

| Check | Result |
|---|---|
| `npm test` | 31 files / 258 tests, green |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| `git status --short` (mirror-request) | clean |
| `git status --short -- .planning/` (mirror-request's stale tree) | empty — untouched |

Baseline (05-04): 31 files / 258 tests — unchanged. This plan added no source or test file.

## Self-Check: PASSED

`docs/OPS-RUNBOOK.md` modified and confirmed present with §9, extended §3, new §7 subsection —
FOUND. Commit `ed138a2` verified in `git log --oneline` — FOUND. `.planning/WINDOWS.md`
confirmed `open_count: 2`, entry 5 `status: fixed`, entry 4 `status: open` — FOUND.
`.planning/phases/05-client-api-display-feed/05-VALIDATION.md` confirmed
`status: validated`, `nyquist_compliant: true` — FOUND. `.planning/REQUIREMENTS.md` confirmed
API-01, API-02, AUTH-03 all `[x]` — FOUND (see next section for the honesty check behind
this).

`npm test` re-run at close-out: 31 files / 258 tests, green. `npm run typecheck` and
`npm run build`: exit 0 both. `mirror-request`'s own `git status --short` clean; its stale
`.planning/` tree confirmed untouched.
