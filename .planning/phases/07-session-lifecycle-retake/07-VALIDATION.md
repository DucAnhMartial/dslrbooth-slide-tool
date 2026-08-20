---
phase: 7
slug: session-lifecycle-retake
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-08-12
updated: 2026-08-12
---

# Phase 7 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest ^2.1.4 |
| **Config file** | `mirror-request/vitest.config.ts` (sets `LOG_LEVEL: 'error'` in the test env, a fixed `LOCAL_STORE_PATH`, and a `globalSetup` that removes per-test SQLite files) |
| **Quick run command** | `cd /opt/mirror_request_dslrobooth/mirror-request && npx vitest run test/<file>.test.ts` |
| **Full suite command** | `cd /opt/mirror_request_dslrobooth/mirror-request && npm test` |
| **Static gates** | `npm run typecheck` and `npm run build` — both measured clean at the pre-phase baseline |
| **Measured runtime** | ~9 seconds full suite (pre-phase baseline measured live 2026-08-12: **36 files / 335 tests / 8.09s**, 100% green). A single-file `npx vitest run` returns in under 5 seconds. |
| **Expected end-of-phase size** | 42 files (6 new test files, listed under Wave 0), no file removed, no test skipped or deleted |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run <file>` for the test file(s) named in that task's `<verify><automated>`. Under 5 seconds.
- **After every plan:** Run `cd /opt/mirror_request_dslrobooth/mirror-request && npm test`. Under 15 seconds. This matches the project's established per-plan pattern — every prior phase's SUMMARY documents a full-suite run per plan.
- **After every wave:** Full suite plus `npm run typecheck` and `npm run build`.
- **Before `/gsd-verify-work`:** Full suite green at or above the 36 files / 335 tests baseline, with no skipped tests.
- **Max feedback latency:** 15 seconds (worst case: a full-suite run). No task in this phase depends on a verification slower than that.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | SC-ID | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------|------------|-----------------|-----------|-------------------|-------------|--------|
| 7-01-01 | 01 | 1 | SC-1, SC-2 | T-07-01 / T-07-04 | Completion is scoped to server-held `booth_state.current_job_id`; the event's own jobId is a cross-check that drops on mismatch. New log lines carry no guest PII and no fotoshare URL. | unit + integration (real temp-file SQLite) | `npx vitest run test/queue-dual-completion.test.ts test/local-store-persistence.test.ts && npm run typecheck && npm test` | ❌ W0 (`queue-dual-completion`) / ✅ (`local-store-persistence`) | ⬜ pending |
| 7-01-02 | 01 | 1 | SC-1, SC-2 | T-07-02 / T-07-05 | A `session_start` naming a terminal job cannot resurrect it; the mismatch warn is throttled so a stuck Agent cannot flood the log. | unit | `npx vitest run test/queue-dual-completion.test.ts test/queue-retake-anchor.test.ts && npm test` | ❌ W0 (both) | ⬜ pending |
| 7-01-03 | 01 | 1 | SC-1, SC-2 | T-07-03 | The booth-release fallback returns the booth to service without requeueing, without charging a retry and without writing a `stall_reason`. | unit (fake timers) | `npx vitest run test/queue-release-timer.test.ts test/queue-config-injection.test.ts && npm test` | ❌ W0 (`queue-release-timer`) / ✅ (`queue-config-injection`) | ⬜ pending |
| 7-02-01 | 02 | 1 | SC-5 | T-07-07 | Raising the level is bounded by the existing 20 MB/14-day rotation; blast radius unchanged from today's `.env`-plus-restart path. | unit | `npx vitest run test/log-level-runtime.test.ts && npm test` | ❌ W0 | ⬜ pending |
| 7-02-02 | 02 | 1 | SC-5 | T-07-06 / T-07-08 / T-07-09 | The control is a POSIX signal, not an HTTP endpoint — no new auth surface. Only `LOG_LEVEL` is read from the parsed `.env`; `process.env` is never mutated. The handler cannot terminate the service. | unit | `npx vitest run test/log-level-runtime.test.ts && npm run typecheck && npm test` | ❌ W0 | ⬜ pending |
| 7-03-00 | 03 | 2 | SC-4 | — | Blocking decision gate (one-way: a new table in a live SQLite file under an additive-only migration policy). | checkpoint:decision | N/A — human-answered gate, no automated command | N/A | ⬜ pending |
| 7-03-01 | 03 | 2 | SC-4 | T-07-12 / T-07-14 | `resolvePendingPrint`'s status predicate makes a replayed upload unable to resolve twice; `expirePendingPrints` marks rows in the same transaction that returns them, capping each slot at one warning ever. | integration (real temp-file SQLite) | `npx vitest run test/local-store-persistence.test.ts && npm test` | ✅ | ⬜ pending |
| 7-03-02 | 03 | 2 | SC-4 | T-07-10 / T-07-11 / T-07-13 | A photo is delivered only when a registry row exists for that job, so an out-of-session photo reaches nobody; resolution is keyed by the registry, not by momentary booth ownership. | unit | `npx vitest run test/queue-file-upload-print.test.ts && npm test` | ✅ | ⬜ pending |
| 7-03-03 | 03 | 2 | SC-4 | T-07-14 | The no-print warning fires at most once per slot, at expiry, and is silent on every successful session. | unit (fake timers) | `npx vitest run test/queue-print-registry-expiry.test.ts && npm test` | ❌ W0 | ⬜ pending |
| 7-04-00 | 04 | 3 | SC-3 | — | Blocking decision gate (one-way: the sixth status is persisted in `queue_job` and is a member of a compile-checked union). | checkpoint:decision | N/A — human-answered gate, no automated command | N/A | ⬜ pending |
| 7-04-01 | 04 | 3 | SC-3 | T-07-15 | The sixth status maps to the existing `see_staff` word and adds no seventh guest-facing token, so the guest response leaks no new operator detail. | unit + typecheck (`TS2741` exhaustiveness) | `npx vitest run test/status-vocabulary.test.ts && npm run typecheck && npm test` | ✅ | ⬜ pending |
| 7-04-02 | 04 | 3 | SC-3 | T-07-16 / T-07-18 / T-07-19 | `closeJobNoPhoto()`'s `AND status = 'in_progress'` predicate cannot overwrite a terminal outcome; the path writes no `stall_reason`, spends no retry and never requeues. | unit + integration (real temp-file SQLite) | `npx vitest run test/queue-no-photo-outcome.test.ts test/local-store-persistence.test.ts && npm test` | ❌ W0 (`queue-no-photo-outcome`) / ✅ (`local-store-persistence`) | ⬜ pending |
| 7-04-03 | 04 | 3 | SC-3 | T-07-15 / T-07-17 | The `/status/:jobId` response key set stays at eight; the outcome is persisted rather than inferred, so it survives a log rotation. | unit | `npx vitest run test/status-api.test.ts test/status-vocabulary.test.ts && npm test` | ✅ | ⬜ pending |
| 7-05-01 | 05 | 4 | SC-5 | T-07-20 / T-07-21 / T-07-22 | Per-event parameters are an explicit allow-list (`param5`, `param1`, `param3`), not a payload spread; asserted against the real captured fixture that no emitted message contains the fotoshare URL. Every line is a template string so `mask()` applies. | unit | `npx vitest run test/queue-event-coverage.test.ts && npm test` | ✅ | ⬜ pending |
| 7-05-02 | 05 | 4 | SC-3 | T-07-21 / T-07-24 | One stable `key=value` line per closed job makes the session greppable after the fact; the summary reads no guest name, email or phone. | unit | `npx vitest run test/queue-dual-completion.test.ts test/queue-no-photo-outcome.test.ts && npm test` | ❌ W0 (both) | ⬜ pending |
| 7-05-03 | 05 | 4 | SC-3, SC-5 | T-07-23 | The runbook records the new config keys, the new outcome word and the log volume assessment, so an operator can find the knob before the disk fills. | docs grep + full suite | `grep -c "BOOTH_RELEASE_TIMEOUT_MS\|PENDING_PRINT_EXPIRY_MS" docs/OPS-RUNBOOK.md && npm test` | ✅ | ⬜ pending |
| 7-05-04 | 05 | 4 | SC-6 | — | Human-answered phase gate at the physical booth (D-15). See Manual-Only Verifications below. | manual-only | N/A — no harness can emit a real retake trigger sequence | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*
*File Exists: ✅ = the file is in the repo today · ❌ W0 = created by the task itself, listed under Wave 0*

> Phase 7 has no REQ-IDs mapped in ROADMAP.md. Coverage is tracked against the
> six ROADMAP success criteria, referenced as SC-1 … SC-6. QUE-04, BTH-01,
> BTH-02 and AGT-04 are marked `[x]` from Phases 2 and 3 and are *revisited*
> here, not newly built.

**Sampling continuity check:** 15 of the 17 tasks carry an `<automated>` command.
The two that do not (7-03-00 and 7-04-00) are `checkpoint:decision` gates that
produce no code, and they are never consecutive — each is immediately followed by
an automated task in its own plan. 7-05-04 is the terminal human gate. No three
consecutive code-producing tasks run without automated feedback.

---

## Wave 0 Requirements

Six new test files. Each is created by the task that needs it, inside the plan that
owns the behaviour — the phase has no separate scaffolding wave, because every new
file is a vitest file in an existing suite with an in-repo analog to copy.

- [ ] `test/queue-dual-completion.test.ts` (plan 07-01, Tasks 1-2) — proves SC-2
      with a genuinely queued second guest driven through the real `QueueService`
      dispatch path. Research identified this as the single most load-bearing new
      test file in the phase. Analog: `test/queue-countdown.test.ts`'s "booth state
      transitions" describe block.
- [ ] `test/queue-retake-anchor.test.ts` (plan 07-01, Task 2) — proves SC-1
      structurally: no capture-phase event sequence reaches the completion anchor.
      Analog: `test/queue-event-coverage.test.ts`'s `buildStore()`.
- [ ] `test/queue-release-timer.test.ts` (plan 07-01, Task 3) — proves D-02's
      booth-release fallback never requeues, never charges a retry and never writes
      a `stall_reason`. Analog: `test/queue-countdown.test.ts`'s fake-timer driving.
- [ ] `test/log-level-runtime.test.ts` (plan 07-02, Tasks 1-2) — proves SC-5's
      runtime half: a label logger observes a level change, and a malformed `.env`
      cannot throw.
- [ ] `test/queue-print-registry-expiry.test.ts` (plan 07-03, Task 3) — proves
      SC-4 in both directions: silent on a successful session, exactly one warning
      at genuine expiry.
- [ ] `test/queue-no-photo-outcome.test.ts` (plan 07-04, Task 2) — proves SC-3's
      no-photo close charges no retry and writes no stall reason.

**Existing files extended rather than created** (no Wave 0 gap, but their current
assertions change and must not be silently broken):
`test/local-store-persistence.test.ts` (07-01 T1 — D-06's column migration and the
SQL-layer SC-2 proof; 07-03 T1 — D-08's table; 07-04 T2 — the no-photo writer),
`test/queue-event-coverage.test.ts` (07-05 T1 — its 6 existing cases assert the
`debug` catch-all that D-12 removes and must be rewritten to assert `info`),
`test/queue-file-upload-print.test.ts` (07-03 T2 — its two `session_end`-time warn
assertions are replaced by registry-keyed ones), `test/status-api.test.ts` (07-01
T1 fixture repair, 07-04 T3), `test/status-vocabulary.test.ts` (07-04 T1, T3), and
the seven mocked-store files repaired in 07-01 T1 step 12.

---

## Manual-Only Verifications

| Behavior | SC-ID | Why Manual | Test Instructions |
|----------|-------|------------|-------------------|
| Retake exercised end to end at the booth, with a second guest genuinely queued | SC-6 | Requires physical dslrBooth hardware and a live guest interaction. No harness can emit a real retake trigger sequence — its trigger order has never been measured (Open Question 3), which is precisely why D-01 chose an anchor that does not depend on knowing it. D-15 makes this a human-answered phase gate, matching this project's unbroken precedent through Phases 1-6. | **Prerequisites, neither dischargeable by the gate itself:** (1) the Phase 3 Agent-auth cutover must be deployed, server and Agent together, per OPS-RUNBOOK §7 — until then the Agent cannot connect at all; (2) test ticket `3X818VEJ` must be marked `failed` by hand BEFORE any Agent connects (OPS-RUNBOOK §10 and §6), or it will be dispatched for a real session with nobody present. **Then, at the booth:** (a) raise the deployed `.env`'s `LOG_LEVEL` and `pm2 sendSignal SIGHUP <app>`; confirm the confirmation line appears, no restart. (b) Register TWO guests so a second is genuinely queued — every test through Phase 6 ran with an empty queue, which is the only reason this defect class never showed. (c) Guest A takes a photo, uses dslrBooth's RETAKE at least once, then accepts a shot and finishes normally. (d) Record: during the retake A's job stays `in_progress` and the booth stays BUSY; after the accepted shot A's job completes exactly once and the photo arrives; B is announced only after A's `session_end`; then browse the booth gallery twice to force the extra `session_end` events the evidence file measured, and confirm B's job is STILL `in_progress` — this is SC-2 at the real booth. `grep` A's job id and confirm exactly one summary line with a capture count greater than 1 and a print composite seen. (e) If cheap, run once more where the guest walks away without accepting a shot and confirm the no-photo outcome with no retry charged. Full text: `07-05-PLAN.md` Task 4. |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or are declared checkpoint/manual-only above (15 automated, 2 decision gates, 1 human phase gate)
- [x] Sampling continuity: no 3 consecutive code-producing tasks without an automated verify
- [x] Wave 0 covers all MISSING references (6 new files, each owned by the task that creates it)
- [x] No watch-mode flags — every command is `vitest run`, never `vitest`
- [x] Feedback latency < 15s (measured baseline: full suite 8.09s, single file under 5s)
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** ready — `wave_0_complete` flips to `true` once the six files above exist and pass; `status` flips to `validated` by `/gsd-validate-phase` §6 after execution.
