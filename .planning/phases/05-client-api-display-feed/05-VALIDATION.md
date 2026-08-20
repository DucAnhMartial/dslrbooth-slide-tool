---
phase: 5
slug: client-api-display-feed
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
status: validated
nyquist_compliant: true
wave_0_complete: true
created: 2026-08-11
---

# Phase 5 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Derived from `05-RESEARCH.md` §Validation Architecture. Every "File Exists"
> answer below was **measured**, not assumed.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest `^2.1.4` (verified in `mirror-request/package.json`) |
| **Config file** | `mirror-request/vitest.config.ts` — line 12 sets `LOCAL_STORE_PATH: './data/test-extension-service.sqlite'`, a **separate file from production**; `LOG_LEVEL: 'error'` suppresses info/warn/debug during runs |
| **Quick run command** | `cd mirror-request && npx vitest run <path>.test.ts` |
| **Full suite command** | `cd mirror-request && npm test` |
| **Baseline at phase start** | 27 files / 182 tests green at `419763f` |
| **Estimated runtime** | ~20 s full suite |

> **Caution inherited from ledger item 4 (OPEN):** all test files currently share that
> one test DB through the `getStore()` singleton while Vitest runs files in parallel
> workers. Measured 3 failures in 10 full-suite runs before `e54e22e`. D-16 closes this
> for `DisplayServer`; any new Phase 5 test **must** construct its own `LocalStore` via
> the constructor seam rather than reaching for the singleton.

---

## Sampling Rate

- **After every task commit:** `npx vitest run <changed-test-file>.test.ts`
- **After every plan wave:** `cd mirror-request && npm test` (182 baseline + new files)
- **Before `/gsd-verify-work`:** full suite green, `npm run typecheck` clean, `npm run build` clean — the same closing checklist every prior phase used
- **Max feedback latency:** ~20 s

---

## Per-Task Verification Map

> Seeded from the research's requirement→test map. Task IDs are filled in by the
> planner; the **rows themselves are the contract** and must all be claimed by some
> task before the phase can seal.

| Task ID | Plan | Wave | Requirement | Behavior to prove | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-------------------|-----------|-------------------|-------------|--------|
| 05-01 T2 / 05-02 T2-3 | 05-01, 05-02 | 5 | API-01 | `/status/:jobId` exact-shape response incl. estimated wait or explicit suppression | integration (ephemeral Express + real ephemeral `LocalStore`) | `npx vitest run test/status-api.test.ts` | ✅ | ✅ green (27 tests) |
| 05-01 T3 | 05-01 | 5 | API-01 | `estimateWaitMs()` median / range / cold-start / exclusion | unit (pure, no DB) | `npx vitest run test/estimate-wait.test.ts` | ✅ | ✅ green (12 tests) |
| 05-02 T2 | 05-02 | 5 | API-01 | Generic 404 for unknown, purged, foreign **and malformed** jobId (D-08) | integration | `npx vitest run test/status-api.test.ts` | ✅ | ✅ green (part of 27) |
| 05-02 T1 | 05-02 | 5 | API-01 | Guest-facing vocabulary exhaustive **and closed** (D-11, D-12) | table-driven over every internal `status`×`stall_reason`, failing loudly on an unmapped state | `npx vitest run test/status-vocabulary.test.ts` | ✅ | ✅ green (15 tests) |
| 05-03 T3 | 05-03 | 5 | API-02 | `/display` broadcasts change-driven + 1 Hz countdown, not unconditional 250 ms (D-13) | integration (real `http.Server` + real `ws` client) | `npx vitest run test/phase5-display.test.ts` | ✅ extend | ✅ green (8 tests) |
| 05-03 T2-3 | 05-03 | 5 | API-02 | `DisplaySnapshot` carries no PII-capable field — by type **and** by wire assertion (D-15) | integration + `tsc --noEmit` | `npx vitest run test/phase5-display.test.ts` + `npm run typecheck` | ✅ extend | ✅ green |
| 05-03 T1,T3 | 05-03 | 5 | API-02 | `/display` + `/display-screen` reject non-allow-listed IPs with a generic 403 **before** handshake/render (D-09) | integration (same `req.ip` technique as `test/on-register-auth.test.ts`) | `npx vitest run test/display-access-control.test.ts` | ✅ | ✅ green (8 tests) |
| 05-03 T2-3 | 05-03 | 5 | API-02 | `DisplayServer` takes an injected store; module-scope `getStore()` gone (D-16 / ledger 4) | unit+integration with a per-test `LocalStore` | `npx vitest run test/phase5-display.test.ts` | ✅ extend | ✅ green |
| 05-04 T2 | 05-04 | 5 | AUTH-03 | No **non-ingestion** log call site emits raw email/phone — as a standing regression, not a one-time audit | spy on all four log levels across a realistic Phase 2–4 flow, assert `mask(msg) === msg` | `npx vitest run test/logging-mask.test.ts` | ✅ extend | ✅ green (16 tests, file total) |
| 05-04 T1 | 05-04 | 5 | AUTH-03 | Connection-id no longer false-positives against `PHONE_RE` (ledger 5) | unit on the id generator / formatting helper | `npx vitest run test/logging-mask.test.ts` | ✅ extend | ✅ green (part of 16) |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

New test files:

- [ ] `test/status-api.test.ts` — API-01 response shape, D-08 generic 404, D-11/D-12 vocabulary
- [ ] `test/estimate-wait.test.ts` — D-01..D-05 pure estimator logic
- [ ] `test/display-access-control.test.ts` — D-09/D-10 allow-list at both the WS-upgrade and HTTP-route layers

New source modules (no new test infra needed):

- [ ] `src/status/estimateWaitMs.ts` — pure, no DB, no server
- [ ] `src/security/ipAllowlist.ts` — pure `clientIp`/`isWhitelisted`, shared by both display surfaces

Extensions to existing files:

- [ ] `test/phase5-display.test.ts` (78 lines, 2 tests today) — D-13, D-15, D-16
- [ ] `test/logging-mask.test.ts` — AUTH-03 non-ingestion regression + ledger-5 id fix

**No framework install required** — Vitest, Supertest and `ws` test-client usage are already present and exercised by 27 existing files.

> **Measured gap:** `grep -rln "/status/" test/ src/` finds the route definition in
> `src/index.ts` and **zero test files**. `/status/:jobId` — half of this milestone's
> client surface — has never had a single test.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| The room's big screen actually renders the feed correctly | API-02 | No automated test can prove a physical browser on a physical screen renders legibly at room distance. A passing WS test proves the bytes are correct, not that the screen is usable. | Open `/display-screen` on the real display machine from an allow-listed IP; confirm the current guest, the countdown, and the Agent online/offline indicator all update live. Record the result in the plan's SUMMARY. |
| A real guest's phone shows a sane status + wait estimate | API-01 | Requires a real registration flowing through the real booth. | After the Phase 3 cutover is deployed, register through the real QR flow and open `/status/:jobId` on a phone. Confirm the wait estimate is a range, is plausible, and never shows a precise ticking number (D-03). |
| **`:jobId` is minted with a CSPRNG and has ≥128 bits of entropy** | API-01 / D-06, D-07 | **Unconfirmable from inside this repository.** Research verified every registration id ever recorded in the real local store is a hand-typed seed value (`registration-20260806-0001`, `job-webhook-001`), never an organic backend-minted one — so the repo contains no evidence either way. | **BLOCKING CHECKPOINT.** D-07 itself instructs escalation rather than assumption. A human must confirm with the backend team how the id is generated. If it is a sequence, a timestamp, or anything guessable, **D-06 is unsound** and the capability-URL design must change before `/status/:jobId` is exposed. Do not ship a guessable capability URL on the strength of an assumption. |
| No consumer outside this repo depends on `/status/:jobId`'s current field names | API-01 | Unconfirmable from this repo. | Confirm with whoever owns the guest-facing web client before changing the response shape. |

---

## Validation Sign-Off

- [ ] All tasks have an `<automated>` verify or a declared Wave 0 dependency
- [ ] Sampling continuity: no 3 consecutive tasks without an automated verify
- [ ] Wave 0 covers every MISSING reference above
- [ ] No watch-mode flags
- [ ] Feedback latency < 30 s
- [ ] Every row in the Per-Task Verification Map is claimed by a real task
- [ ] The D-07 blocking checkpoint is present in a plan as a `checkpoint:decision`, not resolved silently
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
