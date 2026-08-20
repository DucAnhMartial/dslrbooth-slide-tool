---
phase: 05-client-api-display-feed
verified: 2026-08-11T05:00:00Z
status: human_needed
score: 8/8 must-haves verified
behavior_unverified: 0
overrides_applied: 0
overrides:
  - must_have: "The room's big screen actually renders the feed correctly on the physical display"
    reason: "Explicitly DECLINED by the human at the 05-05 phase gate (\"Hoãn cả hai\" — defer both). Named blocker: the service is stopped and the Phase 3 Agent-auth cutover is undeployed, so there is no live Agent/queue to drive a real display. Recorded verbatim in 05-05-SUMMARY.md Task 3 §2. NOT credited as verified — carried forward as an open manual-verification item, same posture 04-VERIFICATION.md used for Phase 4's declined end-to-end run."
    accepted_by: "human (Phase 5 gate, recorded in 05-05-SUMMARY.md Task 3)"
    accepted_at: "2026-08-11T00:00:00Z"
  - must_have: "A real guest's phone shows a sane status and wait estimate end to end"
    reason: "Explicitly DECLINED by the human at the same gate, same reason (no live Agent link). NOT credited as verified. No proxy/mock test was substituted for this check."
    accepted_by: "human (Phase 5 gate, recorded in 05-05-SUMMARY.md Task 3)"
    accepted_at: "2026-08-11T00:00:00Z"
re_verification: null
human_verification:
  - test: "Open /display-screen on the real display machine from an allow-listed address; confirm the current guest, countdown, and Agent online/offline indicator all update live"
    expected: "Screen renders legibly and updates in real time as the queue and Agent state change"
    why_human: "No automated test can prove a physical browser on a physical screen renders legibly at room distance; declined at the phase gate because the service is stopped and the Phase 3 Agent-auth cutover is undeployed (no live Agent/queue exists to drive it)"
  - test: "After the Phase 3 cutover is deployed, register a real guest through the QR flow and open /status/:jobId on a phone; confirm the wait estimate is a range, is plausible, and never shows a precise ticking number"
    expected: "A real guest sees position, real name, and a 'khoảng N-M phút' range, or an explicit paused state"
    why_human: "Requires a real registration flowing through the real booth; declined at the same gate for the same reason"
  - test: "Confirm with the backend team (or a read-only SELECT id FROM registrations ORDER BY <pk> DESC LIMIT 20 over DB_POLL credentials) whether registrations.id is minted with a CSPRNG (>=128 bits)"
    expected: "Either confirmation the id is unguessable (closing WINDOWS ledger item 6), or a decision to replace D-06's capability-URL model with a server-minted status token before any non-dev exposure"
    why_human: "Unconfirmable from inside this repository — 0 randomUUID() call sites in src/, ids are inherited verbatim from the upstream backend payload. Human explicitly accepted this as a dev-only risk (not-confirmed-accept-risk), not a closed question — this is WINDOWS ledger item 6, still open"
---

# Phase 5: Client API & Display Feed — Verification Report

**Phase Goal:** The two surfaces anyone other than an operator ever sees are honest and closed. A guest holding their own job id sees their position, their real registered name — a field that has been silently `null` on every response since the route shipped — and a wait range computed from the median duration of real completed sessions: never a hardcoded constant, never a precise ticking number, and never an estimate at all while the Agent is offline and nothing can be dispatched. Every terminal and fault state Phases 2 through 4 can produce resolves to exactly one of six guest-facing words, so a job that exhausted its retry budget tells the guest to see staff instead of leaving them polling a position forever, and every way of asking about a job that is not theirs — unknown, purged, someone else's, malformed — returns one byte-identical 404. The room's big screen is reachable only from allow-listed addresses, refused at the raw socket before the handshake rather than after it, and can no longer carry an operator's stall reason, retry count or ack error onto the wire, because the raw queue row never enters the broadcast path at all; it goes silent when nothing changes and ticks once a second only while a countdown runs. And every log line outside ingestion is proven on every commit to survive masking unchanged — including the connection ids the masking filter itself used to corrupt.

**Verified:** 2026-08-11T05:00:00Z
**Status:** human_needed (all automatable truths VERIFIED; three items are open, human-only, and explicitly declined at the phase gate — not silently absorbed into a pass)
**Re-verification:** No — initial verification

**Verdict:** every clause of the goal that code and tests can prove is genuinely shipped and traced to real evidence, not SUMMARY prose. Two manual verifications (big screen, real guest phone) were explicitly declined by the human with a named blocker (service stopped, Phase 3 cutover undeployed) and are recorded as declined overrides, not passes. One structural risk — D-06's capability-URL entropy — was explicitly accepted as `not-confirmed-accept-risk` for dev only and remains a tracked, open, pre-production blocker (WINDOWS ledger item 6). None of this was found by trusting a SUMMARY claim; every row below was re-derived from source or from a command run in this session.

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A queued guest sees their real registered name, not `null` | VERIFIED | `src/status/statusRoute.ts:108` — `store.getJobRegistration(jobId)?.registration.name`, replacing the old `job.registration?.name` read off a bare `SELECT *` (F-02 fix). `getJobRegistration()` at `localStore.ts:375-386` performs a genuine two-table join (`queue_job` → `registration`). Proven by assertion, not code inspection alone: `test/status-api.test.ts:171` `expect(res.body.guestName).toBe(GUEST_NAME)` and `:350` `expect(res.body.guestName).toBe('Foreign Guest')` |
| 2 | Wait estimate is computed from the median of real completed sessions, never a hardcoded constant, never a precise ticking number, and structurally absent (not `null`) when the booth cannot serve | VERIFIED | Source: `localStore.ts:362-373` `SELECT completed_at - acknowledged_at ... WHERE status = 'completed'`. Estimator: `estimateWaitMs.ts:33-68` — `medianMs()` sorts a copy, D-04 cold-start uses `<` strictly, output is a `{lowMinutes, highMinutes}` range (never a single tick). Absence is structural: `statusRoute.ts:152` `...(canServe ? { waitEstimate: ... } : {})` — a conditional spread, not `null`/`undefined` assignment. Confirmed by test, not by reading the type: `test/status-api.test.ts:452` `expect('waitEstimate' in body).toBe(false)`, `:537` `expect('waitEstimate' in res.body).toBe(true)` (present-when-should-be), `:570` absent for non-queued statuses. `test/estimate-wait.test.ts` (12 tests) pins median, cold-start boundary, and the outlier-resistance test (`:41-49`) that is D-02's actual reason for choosing median over mean |
| 3 | The duration query uses `completed_at - acknowledged_at` on `status='completed'` rows; the exclusion of failed/timeout jobs is structural (in the WHERE clause), not an app-level filter | VERIFIED | `localStore.ts:363-371` — `WHERE status = 'completed' AND acknowledged_at IS NOT NULL AND completed_at IS NOT NULL`. The query cannot run without this clause; there is no separate `if` anywhere that could be deleted to silently readmit failed/timeout rows. Independently confirmed `session_started_at` is dead schema, not the query's basis: `grep -rn session_started_at src/` (this session) returns exactly 4 hits — `types.ts:21` (field decl), `localStore.ts:41` (schema col), `localStore.ts:189` (column-name whitelist, unreachable — see below), `localStore.ts:358` (comment) — and 0 of those are writes. `grep -rn "updateJobStatus(" src/` (excluding the definition) returns exactly 2 call sites — `queueService.ts:167` (`acknowledged_at`) and `:280` (`dispatched_at`) — neither ever passes `session_started_at` |
| 4 | Every terminal/fault state Phases 2-4 can produce maps to exactly one of six guest-facing words; an unmapped internal status is a compile error, not a silent fallthrough | VERIFIED | Mechanism, not claim: `src/status/guestStatus.ts:94` declares `STATUS_MAP: Record<InternalJobStatus, ...>` — a `Record` over the full union derived from `KNOWN_JOB_STATUSES` (`:71-77`), so adding a 6th internal status to that array without adding a matching key to `STATUS_MAP` fails `tsc` (verified: this is the exact TS `Record` exhaustiveness idiom, confirmed clean by this session's `npm run typecheck` against the shipped code — no `default:` arm exists anywhere in the map). The runtime safety net for an *unexpected string* that bypasses the type (`input.jobStatus` is a bare `string` at the boundary) is separate and also proven: `:108-115` logs loudly (`logger.error`) and returns `see_staff`, silent on the guest's phone. `test/status-vocabulary.test.ts` (15 tests) iterates all 30 status×stall combinations and specifically asserts the loud-unmapped-state behavior (log line: `Unmapped internal job status "stalled" reached the guest status boundary`, reproduced live in this session's `npm test` output). `failed → see_staff` explicitly at `:100-102` |
| 5 | Every miss (unknown/purged/foreign/malformed job id) returns one byte-identical 404; a valid *foreign* id returns 200, by design | VERIFIED | Single 404 producer: `statusRoute.ts:19-21` `genericNotFound()`, called from exactly two sites (miss at `:87`, caught throw at `:95`) — no second literal exists. `test/status-api.test.ts:313-320` asserts purged and never-existed answer byte-identically (`JSON.stringify` equality). `:322-337` malformed paths collapse to the same body. `:364-386` an unexpected internal throw collapses to the same 404, not a 500 (reproduced live: this session's `npm test` output shows the exact log line `Status lookup failed, returning the generic 404: simulated internal failure`). The deliberate reading confirmed as intended, not an oversight: `:339-352` — comment states "D-06 + D-08 read together... holding the id IS the authorisation" — asserts `res.status).toBe(200)` for `foreignJobId`, full 8-key body, correct foreign guest name |
| 6 | Both display surfaces refuse non-allow-listed addresses; the WS refusal happens before the handshake, at the raw socket | VERIFIED | Shared module `src/security/ipAllowlist.ts` used by both. HTTP: `src/index.ts:36-42` gates `/display-screen` with `isWhitelisted()`, 403 JSON before `next()`. WS: `displayServer.ts:54-75` — the `403 Forbidden` raw HTTP response is written directly to the socket (`socket.write(...)`, `socket.destroy()`) **before** `wss.handleUpgrade()` is ever called — the handshake literally cannot proceed past this point. Proven behaviorally, not just read: `test/display-access-control.test.ts:159-178` connects to a real `http.Server`, asserts `result.opened === false` and `statusCode === 403` at the `unexpected-response` event (i.e., no WS ever opens). `:203-217` (D-10) confirms a `?token=` query string does not bypass the gate |
| 7 | The raw queue row cannot enter the broadcast path; `stall_reason`, `retries`, `ack_error_message` are structurally unreachable, not filtered | VERIFIED | `DisplaySnapshot` (`types.ts:69-84`) has no `currentJob: QueueJob` field and no field capable of carrying those three columns — the guarantee is in the type's shape. `displayServer.ts:119-142` `buildSnapshot()` never calls `getJob()`, `getNextQueuedJob()`, or any method returning a raw row; it calls only `getQueuedGuestSummaries()` (`localStore.ts:208-218`), whose SQL `SELECT q.id AS jobId, r.name AS name FROM queue_job q JOIN registration r ...` cannot project a column it never names in the `SELECT` clause — structural, not filtered. Confirmed decoy: `displayServer.ts:104` names `getNextQueuedJob()` in a comment specifically to say it is **never called** — read in full, not grepped blindly |
| 8 | Every non-ingestion log line survives masking unchanged, including connection ids; `PHONE_RE` was not weakened | VERIFIED | `src/logging/logger.ts:8` `PHONE_RE = /\+?\d{7,}/g` — byte-identical to the pre-Phase-5 regex (confirmed via `git diff 419763f ed138a2 -- src/logging/logger.ts`, no diff on that file at all). A real phone number still masks: `test/logging-mask.test.ts:31-34` `expect(mask('call 0900000000')).toBe('call **********')`. Connection-id fix applied at the mint, not the regex: `agentServer.ts` id generation now does `.replace(/(\d)(?=\d)/g, '$1x')` — no two digits ever adjacent, so `PHONE_RE`'s 7-digit-run threshold is structurally unreachable regardless of timestamp/sequence growth. Proven, not asserted: `test/logging-mask.test.ts:325-337` `expect(id).not.toMatch(/\d\d/)`; `:382-389` an explicit **control case** proves the fix is load-bearing — an unreformatted id (built locally, mimicking the old code) IS still altered by `mask()`. Standing regression at `:455+` spies all four log levels across a realistic queue/notify/display/status flow and asserts `mask(msg) === msg` for every collected message (16 tests total in the file, all green in this session's `npm test`) |

**Score:** 8/8 truths verified (0 present, behavior-unverified). Three separate items (big-screen render, real-guest-phone flow, id-entropy confirmation) are **not truths of this phase's goal text** and are recorded as declined/open manual-verification items below, not folded into this score.

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/status/statusRoute.ts` | `/status/:jobId` router: real name, wait estimate, generic 404, closed vocabulary | VERIFIED | 184 lines; all behaviors above traced to it |
| `src/status/estimateWaitMs.ts` | Pure median/range/cold-start estimator, no DB/clock/logger | VERIFIED | 68 lines; confirmed pure (no imports beyond its own type) |
| `src/status/guestStatus.ts` | Exhaustive `Record`-keyed status map, closed vocabulary types | VERIFIED | 129 lines; `Record<InternalJobStatus, ...>` exhaustiveness confirmed |
| `src/security/ipAllowlist.ts` | Shared `clientIp`/`isWhitelisted`, structural shape param (not `Request`) | VERIFIED | 43 lines; used by both `index.ts` and `displayServer.ts` |
| `src/display/displayServer.ts` | Injected store, gated WS upgrade, PII-free projection, change-driven broadcast | VERIFIED | 162 lines; all D-09/D-13/D-14/D-15/D-16 mechanisms present and traced above |
| `src/types.ts` `DisplaySnapshot` | Purpose-built projection, no raw `QueueJob` | VERIFIED | `:69-84`, no `currentJob: QueueJob` field |
| `src/config.ts` | `DISPLAY_IP_WHITELIST`, `WAIT_ESTIMATE_*` typed keys, production fail-fast | VERIFIED | `:59, 71-73, 106-112` — fail-fast throws in production when whitelist unset |
| `test/status-api.test.ts` | Exact-shape + D-08 + D-11/12 coverage | VERIFIED | 598 lines added; **27 tests**, all green (measured in this session) |
| `test/estimate-wait.test.ts` | D-01..D-05 pure estimator pins | VERIFIED | 110 lines; **12 tests**, all green |
| `test/status-vocabulary.test.ts` | Exhaustive 30-combination table + loud-unmapped-state | VERIFIED | 321 lines; **15 tests**, all green |
| `test/display-access-control.test.ts` | Allow-list at both HTTP and raw-WS-upgrade layers | VERIFIED | 277 lines; **8 tests**, all green |
| `test/phase5-display.test.ts` | D-13/D-15/D-16 against a real server + real ws client | VERIFIED | extended to 282 lines; **8 tests**, all green |
| `test/logging-mask.test.ts` | AUTH-03 standing regression + connection-id fix | VERIFIED | extended to 403 lines; **16 tests**, all green |
| `docs/OPS-RUNBOOK.md` §9 | Read surfaces, config keys, accepted risks | VERIFIED | `:671-895`; Accepted-risks subsection states D-06/D-07 plainly (quoted below) |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `index.ts:36-42` | `security/ipAllowlist.ts` | `clientIp`/`isWhitelisted` import | WIRED | Same functions the WS layer uses — cannot diverge on what "allowed" means |
| `displayServer.ts:64-70` | `security/ipAllowlist.ts` | same functions | WIRED | Refusal happens in the raw `upgrade` handler, before `handleUpgrade()` |
| `statusRoute.ts:108` | `localStore.ts:375` `getJobRegistration()` | direct call | WIRED | Real join, not the old bare-`SELECT *` read |
| `statusRoute.ts:174` `computeEstimate()` | `estimateWaitMs.ts:51` | direct call | WIRED | Sample from `getRecentSessionDurationsMs()`, config from `StatusConfig` |
| `displayServer.ts:119` `buildSnapshot()` | `localStore.ts:208` `getQueuedGuestSummaries()` | direct call | WIRED | The *only* row-shaped read in the broadcast path |
| `agentServer.ts` connection mint | `logging/logger.ts` `mask()` | log call → regex | WIRED (structurally unreachable, not merely untriggered) | Proven by the explicit control-case test that the un-fixed form WOULD be altered |

---

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `/status/:jobId` response | `guestName` | `store.getJobRegistration(jobId)?.registration.name` — real 2-table JOIN | Yes, proven by assertion against a fixture name | FLOWING |
| `/status/:jobId` response | `waitEstimate` | `getRecentSessionDurationsMs()` → real `completed_at - acknowledged_at` rows → `estimateWaitMs()` | Yes; test drives real `enqueueJob`→`updateJobStatus`→`completeInProgressJob` write path, not a fixture row shaped like the result | FLOWING |
| `/display` snapshot | `guestName`/`upNext` | `getQueuedGuestSummaries()` — real JOIN, projected columns only | Yes | FLOWING |
| production `data/extension-service.sqlite` | `queue_job.status='completed'` sample count | measured this session (see Behavioral Spot-Checks) | Bounded by D-04 cold-start fallback on day one | FLOWING (small sample, by design) |

---

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full suite green | `cd mirror-request && npm test` | **31 files, 258 tests, all passed**, 7.29s (measured this session) | PASS |
| Types clean | `npm run typecheck` | no output, exit 0 | PASS |
| Build clean | `npm run build` | no output, exit 0 | PASS |
| `session_started_at` is dead schema (D-01 correction) | `grep -rn session_started_at src/` | 4 hits (field decl, schema col, column-whitelist, 1 comment); `grep -rn "updateJobStatus(" src/` finds 2 call sites, neither writes it | PASS |
| Real phone still masked | `mask('call 0900000000')` reasoning traced in `test/logging-mask.test.ts:31-34` | `'call **********'` | PASS |
| `PHONE_RE` byte-identical to pre-Phase-5 | `git diff 419763f ed138a2 -- src/logging/logger.ts` | no diff | PASS |
| Phase boundary — queue/notifications/ingestion/web-slide untouched | `git diff --stat 419763f ed138a2 -- src/queue/ src/notifications/ src/ingestion/ web-slide/` | empty output | PASS |
| `agentServer.ts` changed only at the id mint | `git diff 419763f ed138a2 -- src/agent/agentServer.ts` | single-line change plus a comment block, at the `const id = ...` mint | PASS |
| WINDOWS ledger residual (item 4) is genuinely 3 files | `grep -rn getStore test/ \| grep -vE ':[0-9]+:\s*(//\|\*\|/\*)'` then `awk -F: '{print $1}' \| sort \| uniq -c` | **4 files** with genuine (non-comment) hits: `local-store-persistence.test.ts` (3), `logging-mask.test.ts` (5), `on-register-auth.test.ts` (14), `on-register-dedup.test.ts` (10) — 32 total. `local-store-persistence.test.ts` correctly excluded from the residual count (its own `it()` deliberately tests `getStore()` itself) | PASS — matches the 3-file claim exactly (`on-register-auth`, `on-register-dedup`, `logging-mask`) |
| No debt markers in changed files | `grep -nE "TBD\|FIXME\|XXX\|TODO\|HACK\|PLACEHOLDER"` over every file in the phase diff | 0 matches | PASS |
| WS refusal is pre-handshake, not post | `test/display-access-control.test.ts:159-178` | `result.opened === false`, `statusCode === 403` at `unexpected-response` (never an open socket) | PASS |
| A valid foreign id returns 200 (deliberate) | `test/status-api.test.ts:344-352` | 200, correct 8-key body, correct foreign guest name | PASS |
| §9 Accepted-risks states D-06/D-07 plainly | `docs/OPS-RUNBOOK.md:868-888` | "UNVERIFIED, a pre-production blocker" ... "explicitly not a resolution for production" | PASS |

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|--------------|--------|----------|
| API-01 | 05-01, 05-02 | `GET /status/:jobId` — queue position + estimated wait for the guest | SATISFIED (with open manual item) | Truths 1-5; automated coverage complete. Real-guest-phone end-to-end explicitly declined at the gate — recorded as override, not credited |
| API-02 | 05-03 | `WS /display` — realtime feed: current guest + Agent status | SATISFIED (with open manual item) | Truths 6-7; automated coverage complete. Physical-screen render explicitly declined at the gate — recorded as override, not credited |
| AUTH-03 | 05-04 | Sensitive data masked in all logs (non-ingestion surfaces; ingestion done in Phase 1) | SATISFIED | Truth 8; `test/logging-mask.test.ts` standing regression (16 tests) plus WINDOWS ledger item 5 marked `fixed` |

No orphaned requirements: `REQUIREMENTS.md:63` maps API-01/02 to Phase 5 with the manual-only items explicitly carried forward, not silently dropped; `REQUIREMENTS.md:58` records AUTH-03's non-ingestion closure by plan 05-04.

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| — | — | — | — | None found in the Phase 5 diff |

Grep false positives explicitly ruled out (five decoys flagged in the verification brief, all opened and read in place, none a real finding):
- Three test files containing the literal line "Never calls getStore()" / similar — comments documenting an absence, correctly excluded by the mandated comment filter.
- `displayServer.ts:104` names `getNextQueuedJob()` in a comment specifically to say it is never called — confirmed true by reading `buildSnapshot()`'s actual call list (`getQueuedGuestSummaries()` only).
- `mirrorReceiver.ts:20-34` / `ipAllowlist.ts` discuss `trust proxy` to explain why it is NOT enabled — confirmed no `app.set('trust proxy', ...)` exists anywhere in `src/index.ts` (grep, 0 hits).
- `session_started_at` mentions — measured directly above; 4 total hits, 0 writes, matches D-01's corrected reasoning.

---

## Declined / Open Items (recorded, not failures — carried as overrides + human_verification)

1. **The room's big screen — DECLINED.** Human selected "Hoãn cả hai" at the 05-05 gate. Named blocker: service stopped, Phase 3 Agent-auth cutover undeployed, no live queue exists to drive it. No proxy test substituted.
2. **A real guest's phone — DECLINED.** Same gate, same reason.
3. **D-06/D-07 id-entropy — UNVERIFIED, accepted for dev only.** Human resolution recorded verbatim (`05-01-SUMMARY.md:95`): *"Đây là môi trường dev nên bạn cứ làm"* ("this is a dev environment, go ahead") — chosen option `not-confirmed-accept-risk`. This is **not** a closed question: WINDOWS ledger item 6 remains `open`, `/gsd-ship` blocks on it, and `OPS-RUNBOOK.md` §9 states plainly that production exposure requires confirming the backend mints ids with a CSPRNG first.
4. **WINDOWS ledger item 4 — left open by explicit human choice** ("Để mở" at the gate), not by omission. Independently re-measured in this session: genuine residual is exactly **3 files** (`on-register-auth.test.ts`, `on-register-dedup.test.ts`, `logging-mask.test.ts`), matching the plan's claim after its own self-correction from a 4-count that had wrongly included a comment line. `local-store-persistence.test.ts` is correctly excluded — it deliberately tests `getStore()` itself.

---

## Gaps Summary

**No genuine unresolved code gaps.** Every observable truth this phase's goal text asserts is backed by shipped code and a passing, behaviorally-real test — not a SUMMARY claim. The full suite (31 files / 258 tests), typecheck, and build were re-run in this verification session, not taken on report. The phase boundary held: `src/queue/`, `src/notifications/`, `src/ingestion/`, and `web-slide/` are byte-identical to the Phase 4 baseline (`419763f`), and `src/agent/agentServer.ts` changed only at the connection-id mint.

What remains open is exactly what the phase itself declared open, and it is reported here rather than allowed to read as closed:
- Two manual-only verifications (physical screen, real guest phone) were **declined**, not passed, with a named environmental blocker.
- The capability-URL's entropy assumption (D-06/D-07) was **accepted as a dev-only risk**, not confirmed sound — it is a tracked pre-production blocker (WINDOWS item 6), and `/gsd-ship` correctly still blocks on it.
- WINDOWS item 4's residual (3 test files still sharing the `getStore()` singleton) is an accepted, explicitly-chosen leftover, independently re-measured and confirmed accurate.

None of these three items were softened into a pass, and none was invented where the code was actually solid — every one of the eight goal-derived truths traced cleanly to real, running, tested code.

---

_Verified: 2026-08-11T05:00:00Z_
_Verifier: Claude (gsd-verifier)_
