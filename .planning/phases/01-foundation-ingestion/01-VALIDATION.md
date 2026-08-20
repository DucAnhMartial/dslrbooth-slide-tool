---
phase: 1
slug: foundation-ingestion
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-08-10
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Transcribed from `01-RESEARCH.md` § Validation Architecture and reconciled against the
> per-task `<verify>` blocks of plans 01-01 … 01-05.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest ^2.1.4 — already installed `[VERIFIED: mirror-request/package.json devDependencies]` |
| **Config file** | `mirror-request/vitest.config.ts` — includes `src/**/*.{test,spec}.*` and `test/**/*.{test,spec}.*`; plan 01-01 task 1 adds a hermetic `test.env` block |
| **Quick run command** | `cd mirror-request && npx vitest run test/<file>.test.ts` |
| **Full suite command** | `cd mirror-request && npm test` (runs `vitest run`) |
| **Estimated runtime** | Full suite measured at 4.2 s reported / ~7 s wall on the 5 pre-phase files; projected ~20 s wall once all six Phase 1 test files land. A single-file quick run is ~5–8 s wall, dominated by transform + collect. |

**Harness gap closed in-phase:** `supertest` / `@types/supertest` (the only new devDependencies
in Phase 1) are installed by plan 01-01 task 1. No other framework work is required.

---

## Sampling Rate

- **After every task commit:** Run `cd mirror-request && npx vitest run test/<file>.test.ts` for the file(s) that task touched
- **After every plan wave:** Run `cd mirror-request && npm test`
- **Before `/gsd-verify-work`:** Full suite must be green, plus `npm run typecheck` and `npm run build`
- **Max feedback latency:** 30 seconds

No task uses a watch-mode command (`vitest` without `run`, `--watch`, `--ui`). The
`test:watch` script in `package.json` is a developer convenience and is referenced by no plan.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 1-01-01 | 01 | 1 | ING-01, STO-01 / D-09, D-10, D-12 | T-01-01…05, T-01-SC | Signed request accepted end-to-end; tampered, unsigned or malformed-signature request 403s with a bare body and persists nothing; length guard runs before the constant-time compare | integration (supertest) | `cd mirror-request && npx vitest run test/on-register-auth.test.ts` | ❌ created by this task | ⬜ pending |
| 1-01-02 | 01 | 1 | AUTH-02 / D-01, D-09, D-11 | T-01-06 | Production startup refuses to boot without `WEBHOOK_HMAC_SECRET` and real `PROXY_IP_WHITELIST` entries; no toggle exists to disable authentication | unit | `cd mirror-request && npx vitest run test/config-validation.test.ts` | ❌ created by this task | ⬜ pending |
| 1-02-01 | 02 | 2 | STO-01, ING-03 / D-11, D-14 | T-01-11, T-01-12 | Replay ids and the poll cursor survive a close/reopen; all replay SQL uses `?` placeholders; no in-memory durable state | integration (real SQLite temp file) | `cd mirror-request && npx vitest run test/local-store-persistence.test.ts` | ❌ created by this task | ⬜ pending |
| 1-02-02 | 02 | 2 | AUTH-02 / D-11, D-12 | T-01-08, T-01-09, T-01-13 | Stale, future-dated and replayed webhooks all 403; the replay id is recorded only after full authentication; one generic denial body | unit + integration (supertest) | `cd mirror-request && npx vitest run test/on-register-auth.test.ts` | ✅ from 1-01-01 | ⬜ pending |
| 1-02-03 | 02 | 2 | AUTH-02 / D-09, D-12 | T-01-10 | A forged forwarding header cannot satisfy the allow-list; no Express proxy-trust setting exists anywhere in `src` | integration (supertest) + grep gate | `cd mirror-request && npx vitest run test/on-register-auth.test.ts` | ✅ from 1-01-01 | ⬜ pending |
| 1-03-01 | 03 | 3 | ING-02 / D-08 | T-01-15 | The poller issues `SELECT` only — the executed SQL is asserted against `^SELECT` with no mutating keyword; no `process.env` read remains | unit (mocked `mysql2/promise` pool) | `cd mirror-request && npx vitest run test/db-poller.test.ts` | ❌ created by this task | ⬜ pending |
| 1-03-02 | 03 | 3 | ING-02, ING-03, STO-01 / D-04…D-08 | T-01-16…21 | A first-cycle or mid-cycle failure warns and retries; malformed rows are audited without stalling the cursor; already-ingested rows are reconciled; no credential reaches a log line | unit (mocked pool + `LocalStore`) | `cd mirror-request && npx vitest run test/db-poller.test.ts` | ✅ from 1-03-01 | ⬜ pending |
| 1-04-01 | 04 | 3 | STO-01 / D-01, D-02, D-14 | T-01-22, T-01-24, T-01-27 | Dedup SQL is parameterized; blank email/phone can never collide two guests; `migrate()` is additive only, never destructive | unit + integration (real SQLite temp file) | `cd mirror-request && npx vitest run test/on-register-dedup.test.ts` | ❌ created by this task | ⬜ pending |
| 1-04-02 | 04 | 3 | ING-01 / D-01, D-02, D-03, D-13 | T-01-23, T-01-26 | A duplicate returns the original jobId and reaches no persistence call, so the original `raw_payload` survives; the dedup log names ids only | integration (supertest) | `cd mirror-request && npx vitest run test/on-register-dedup.test.ts` | ✅ from 1-04-01 | ⬜ pending |
| 1-05-01 | 05 | 4 | AUTH-03 / D-15, D-16 | T-01-28 | `debugRawPayload()` emits nothing in production and nothing without `DEBUG`; exactly one masking implementation remains | unit | `cd mirror-request && npx vitest run test/logging-mask.test.ts` | ❌ created by this task | ⬜ pending |
| 1-05-02 | 05 | 4 | AUTH-03, ING-01 / D-13, D-15, D-16 | T-01-29, T-01-30 | Every captured ingestion log message satisfies `mask(msg) === msg`; no object-argument log call bypasses masking; `raw_payload` stays persisted in production | integration (supertest + logger spies) | `cd mirror-request && npx vitest run test/logging-mask.test.ts` | ✅ from 1-05-01 | ⬜ pending |
| 1-05-03 | 05 | 4 | D-09, D-10, D-02, D-14 | T-01-31, T-01-32 | Human confirmation of the HMAC canonical string, the D-02 identity reading, production strictness, and the manual retention posture | manual — `checkpoint:human-verify` (exempt from `<automated>`) | n/a — see Manual-Only Verifications | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

**Sampling continuity:** every `auto`/`tracer`/`tdd` task above carries a runnable
`<automated>` command; the longest run of tasks without one is 1 (the single exempt
checkpoint, which is also the final task of the phase). Nyquist sampling holds.

---

## Wave 0 Requirements

There is no separate Wave 0 plan. Vitest is already installed and configured, and every test
file below is created red-first inside the `tdd="true"` task that first depends on it, so the
scaffolding and the behavior it guards land in the same commit sequence:

- [ ] `mirror-request/test/on-register-auth.test.ts` — created by 01-01 task 1; covers ING-01, AUTH-02, D-09…D-12
- [ ] `mirror-request/test/config-validation.test.ts` — created by 01-01 task 2; covers D-01, D-09, D-11 startup validation
- [ ] `mirror-request/test/local-store-persistence.test.ts` — created by 01-02 task 1; covers ING-03, STO-01, `webhook_replay`
- [ ] `mirror-request/test/db-poller.test.ts` — created by 01-03 task 1; covers ING-02, D-04…D-08 via a `vi.mock('mysql2/promise', …)` pool (no existing mock pattern in this codebase)
- [ ] `mirror-request/test/on-register-dedup.test.ts` — created by 01-04 task 1; covers D-01…D-03, STO-01
- [ ] `mirror-request/test/logging-mask.test.ts` — created by 01-05 task 1; covers AUTH-03, D-15, D-16
- [ ] `npm install --save-dev supertest @types/supertest` — the only framework install, performed by 01-01 task 1

`wave_0_complete` flips to `true` once 01-01 task 1 lands the `supertest` devDependencies and
the hermetic `vitest.config.ts` `test.env` block, which together unblock every remaining file.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Mirror Request's real signer produces the same canonical string, digest encoding and timestamp unit this service expects | D-09, D-10 (RESEARCH.md Open Question 1 / A1) | The signing contract lives in another system that this repository cannot read or call | 01-05 task 3, item 1 — inspect the Mirror Request signer or ask its owner; a mismatch is a two-function change in `webhookAuth.ts` |
| The D-02 identity reading (id match first, non-empty email/phone fallback, `id` still required) matches developer intent | D-02 (RESEARCH.md Open Question 2 / A2) | Intent question, not a code property | 01-05 task 3, item 2 |
| The production environment actually carries a real HMAC secret and real proxy IPs before the next deploy | D-09 | Depends on deployment secrets not present in the repository | 01-05 task 3, item 3 — dry run `NODE_ENV=production npm run build && NODE_ENV=production node -e "require('./dist/config').loadConfig()"` |
| Manual-retention posture is acknowledged (nothing in the service deletes data) | D-14 | Policy acknowledgement, not a testable behavior | 01-05 task 3, item 4 |
| Polling against the real read-only MySQL replica | ING-02 | No live MySQL instance is reachable from the build environment; automated coverage uses a mocked `mysql2/promise` pool (RESEARCH.md § Environment Availability) | 01-05 task 3, item 5 — point `DB_*` at the read-only replica, run `npm run dev`, confirm the `DB poller connected` line and that the cursor advances |
| End-to-end smoke against ROADMAP M1 success criteria | ING-01, STO-01, AUTH-02 | Requires a running server and a real HTTP client | 01-05 task 3, item 5 |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies — the sole exception is 1-05-03, an exempt `checkpoint:human-verify`
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references — every test file is created by a named task; no `<automated>` command references a file no task creates
- [x] No watch-mode flags
- [x] Feedback latency < 30s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending — `status` flips to `validated` when `/gsd-validate-phase` signs off after execution.
