---
phase: 11
slug: retake-approval-anchor
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-08-18
---

# Phase 11 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Source: `11-RESEARCH.md` §Validation Architecture (2026-08-18).

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest ^2.1.4 |
| **Config file** | `mirror-request/vitest.config.ts` (`LOCAL_STORE_PATH: './data/test-extension-service.sqlite'`, `LOG_LEVEL: 'error'`, `globalSetup: ['./test/global-teardown.ts']`) |
| **Quick run command** | `cd /opt/mirror_request_dslrobooth/mirror-request && npx vitest run test/<file>.test.ts` |
| **Full suite command** | `cd /opt/mirror_request_dslrobooth/mirror-request && npm test` |
| **Estimated runtime** | 27.8 s full suite — **measured 2026-08-18 at HEAD `9092729`: 82 files / 967 tests, all green.** That is the baseline every "no case was lost" floor in the plans is counted against. |

Two harness shapes in use: (1) mocked `LocalStore` object driven through the real `QueueService` with `vi.useFakeTimers()` — the majority of `queue-*.test.ts`; shared fixture `test/helpers/pendingPrintRegistry.ts`; (2) real temp-file SQLite (`fs.mkdtempSync` + `new LocalStore(path)`) in `test/local-store-persistence.test.ts` for migrations and SQL predicates. Agent events are fed with `service.onAgentEvent(eventType, jobId, payload)` directly — the seam for replaying the measured C/D/E sequences.

---

## Sampling Rate

- **After every task commit:** Run the file(s) named in that task's automated command (`npx vitest run test/<file>.test.ts`)
- **After every plan wave:** Run `npm test`
- **Before `/gsd-verify-work`:** Full suite green + `npm run typecheck` + `npm run build` clean
- **Max feedback latency:** 15 s

---

## Per-Task Verification Map

*(Task IDs filled by planner; rows below are the requirement→test contract the plans must honour.)*

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 11-01-T2 | 11-01 | 1 | BTH-01/02 (re-opened) — `attempt_open` migration additive+idempotent; booth stays BUSY through grace | — | N/A | integration (real SQLite) | `npx vitest run test/local-store-persistence.test.ts` | ✅ extend | ✅ green |
| 11-01-T1 + 11-02-T2 | 11-01, 11-02 | 1, 2 | NOT-01 (re-opened) — exactly one notification, LAST attempt's URL, sent only at finalize (D11-04/05) | — | N/A | unit | `npx vitest run test/queue-retake-anchor.test.ts test/queue-file-upload-print.test.ts` | ✅ rewrite | ✅ green |
| 11-02-T2 | 11-02 | 2 | AGT-04 (extended) — composite = last `\Prints\` param, 1-shot and 4-shot layouts (D11-07) | — | N/A | unit | `npx vitest run test/queue-event-coverage.test.ts` | ✅ extend | ✅ green |
| 11-04-T1 | 11-04 | 3 | D11-03 — `printing` ignored: no attempt open / composite stem mismatch (sequence E; `_1x`/`_2x` stem rule) | — | N/A | unit | `npx vitest run test/queue-retake-anchor.test.ts` | ✅ rewrite | ✅ green |
| 11-04-T2 | 11-04 | 3 | D11-05 — `finalizePendingPrint` idempotent across the three doors | T-11 (operator/printing race) | second door is a no-op, reported not silent | unit | `npx vitest run test/queue-finalize-idempotency.test.ts` | ✅ created | ✅ green |
| 11-01-T3 | 11-01 | 1 | D11-06 — grace timer: `session_start` inside window cancels; expiry finalizes via door 2; `stop()` clears | — | N/A | unit (fake timers) | `npx vitest run test/queue-retake-grace-timer.test.ts` | ✅ created | ✅ green |
| 11-03-T3 | 11-03 | 3 | D11-08 — CMS "end this guest": visible only BUSY/grace; POST behind auth+IP gate; `approved_by='operator'` | T-11 (CMS route) | inherits `cmsAuth`/`cmsIpGate`; refuses unexpected body fields | unit + integration | `npx vitest run test/cms-booth-release.test.ts` | ✅ created | ✅ green |
| 11-02-T1 | 11-02 | 2 | D11-09 — `SESSION_SUMMARY … attempts=N approved_by=…`, field order preserved | — | N/A | unit | `npx vitest run test/queue-dual-completion.test.ts` | ✅ extend | ✅ green |
| 11-02-T1/T2/T3 | 11-02 | 2 | Suite rewrite — the 9 files asserting the old single-anchor / send-on-upload model (RESEARCH §Common Pitfalls table) | — | N/A | unit | `npm test` | ✅ rewrite | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

**Measured 2026-08-18, after 11-04's third commit and unchanged by 11-05 (docs-only):
87/87 test files, 1041/1041 tests, `npm run typecheck` and `npm run build` both clean,
`git status --porcelain` in `mirror-request` empty.** Every row above is now automated-green;
this table's own last gap (the two Wave 0 files) closed in 11-01/11-04 as noted below.

---

## Wave 0 Requirements

- [x] `test/queue-finalize-idempotency.test.ts` — D11-05 three-door idempotency — **created by 11-04 Task 2 (wave 3)**
- [x] `test/queue-retake-grace-timer.test.ts` — D11-06 grace timer lifecycle — **created by 11-01 Task 3 (wave 1)**
- [x] `test/cms-booth-release.test.ts` — D11-08 route + visibility — **created by 11-03 Task 3 (wave 3)**
- [x] `test/helpers/pendingPrintRegistry.ts` — EXTEND (not replace): `photoUrl`, `approvedBy`, `attemptNo`, overwrite-vs-DO-NOTHING branch, so all five importing files move together — **extended by 11-01 Task 1 (wave 1), in the same commit as the code it stands in for**
- [x] Framework install: none — vitest present

Two further files are added beyond the gaps this contract originally listed, both found while
laying out the plans:

- [x] `test/queue-send-site-invariant.test.ts` — the one-send-site property asserted against the stripped source — **created by 11-02 Task 3 (wave 2)**
- [x] `test/queue-ignored-branches.test.ts` — every ignore branch logs exactly once, behaviourally and structurally — **created by 11-04 Task 3 (wave 3)**
- [x] `test/helpers/cmsBoothLink.ts` — the idle booth-link stub the nine existing CMS router call sites pass — **created by 11-03 Task 2 (wave 3)**

All Wave 0 test-infrastructure gaps are built and green. This checklist tracks
**test-infrastructure existence only** — it is deliberately independent of the live-booth
gate below, which no amount of Wave 0 test infrastructure can discharge (SC-6 requires a
physical camera).

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Retake + second guest queued: A gets exactly one photo (last attempt), B not dispatched before A's `printing`, summary `attempts=2 approved_by=printing` | SC-1, SC-6 | needs real dslrBooth trigger stream and a human pressing Retake/print | `11-CONTEXT.md` <verification> step 1; auto-print OFF |
| Walk-away without print → grace expiry releases, `approved_by=grace` | SC-3, SC-6 | timing of a real guest | <verification> step 2 |
| Gallery reprint during another guest's open attempt → ignored with reason | SC-2, SC-6 | requires operator gallery action on booth | <verification> step 3 |
| CMS "end this guest" during a live session | SC-4, SC-6 | operator action on real CMS | <verification> step 4 |
| No `no usable composite path` warn on 4-shot AND 1-shot layouts | SC-5 | requires switching dslrBooth layout | <verification> step 5 |
| Auto-print is OFF on every booth (precondition) | precondition | dslrBooth settings | one session without pressing print → Agent log has no `printing` line |

---

## The Five-Scenario Live Booth Gate (SC-6) — READY TO FILL, NOT YET RUN

**This section is prepared, not executed.** Every result field below is empty by design — no
scenario has been run against a real camera. Every automated claim in the table above is proved
against replays of the exact measured trigger sequences (`07-EVIDENCE-dslrbooth-triggers.md`
§C/D/E); none of it has run against a real dslrBooth. Do not fill in a result without physically
running the corresponding scenario at the booth. Source: `11-CONTEXT.md` `<verification>`,
verbatim; `mirror-request/docs/OPS-RUNBOOK.md` §14 for every log token/grep referenced below.

### Before starting (once, covers all five scenarios)

- [ ] Auto-print is OFF in dslrBooth on the booth PC (`DEPLOYMENT.md` §7d) — confirmed by running
      one session and pressing no print, then confirming the Agent log carries no `printing` line
      for it.
- [ ] The service running is this phase's build (commit `f40cd0f` or later on `master`).
- [ ] No job is left `queued` before the Agent connects (`DEPLOYMENT.md` §9 item 5's check query).
- [ ] A second guest — a real person or a second registration — is genuinely available to queue
      for scenarios 1 and 2.

### Scenario 1 — Retake with a guest queued (SC-1, D11-01/02/03/05)

**Steps:** Guest A shoots, presses Retake on the sharing screen, shoots again, presses print,
with Guest B already `queued`.

**Watch for:** B is never announced or dispatched at any point before A's approving `printing`.
A's own log shows `Retake detected for job <A>: attempt 2 opened` between the two shots, and no
`printing ignored: …` line for A's own approving `printing`.

**Expected `SESSION_SUMMARY`:**
```
SESSION_SUMMARY job=<A> outcome=completed captures=2 attempts=2 approved_by=printing
```

**Grep to read the result:**
```bash
grep "SESSION_SUMMARY job=<A>" logs/extension-service-*.log
grep "<A>" logs/extension-service-*.log | grep -E "Retake detected|printing ignored"
```

**Result:** _(pending — run at the booth)_

### Scenario 2 — Walk-away (SC-3, D11-06)

**Steps:** Guest A shoots and leaves without pressing print.

**Watch for:** B is called only AFTER `RETAKE_GRACE_MS` (default 20000 ms) has elapsed since A's
`session_end` — not before. A's summary line reads `approved_by=grace`; A receives the last
attempt's photo if one was ever uploaded, or closes with no photo if none arrived.

**Grep to read the result:**
```bash
grep "Grace opened for job <A>" logs/extension-service-*.log
grep "Grace expired for job <A>" logs/extension-service-*.log
grep "SESSION_SUMMARY job=<A>" logs/extension-service-*.log
```

**Result:** _(pending — run at the booth)_

### Scenario 3 — Gallery reprint during another guest's session (SC-2, D11-03)

**Steps:** While B is shooting (attempt open), the operator reprints A's photo from the dslrBooth
gallery.

**Watch for:** the reprint is refused with the composite-mismatch reason, naming both paths; B's
own session is not finalized by it and completes normally afterward.

**Grep to read the result:**
```bash
grep "printing ignored: composite" logs/extension-service-*.log
grep "SESSION_SUMMARY job=<B>" logs/extension-service-*.log
```

**Result:** _(pending — run at the booth)_

### Scenario 4 — Operator end (SC-4, D11-08)

**Steps:** Guest A shoots, does not print. Operator opens `GET /cms/booth`, confirms it shows A
with an elapsed time, presses "Kết thúc khách này".

**Watch for:** immediate release (no wait for `RETAKE_GRACE_MS`); A's summary line reads
`approved_by=operator`.

**Grep to read the result:**
```bash
grep "Operator release for <A>: released" logs/extension-service-*.log
grep "SESSION_SUMMARY job=<A>" logs/extension-service-*.log
```

**Result:** _(pending — run at the booth)_

### Scenario 5 — Both booth layouts (SC-5, D11-07)

**Steps:** Run one full session on the 4-shot composite layout and one on the 1-shot layout.

**Watch for:** no `carried no usable composite path` warning on either session, across both
`processing_start`'s extraction and `printing`'s own read.

**Grep to read the result (expect zero hits across both sessions):**
```bash
grep -i "carried no usable composite path" logs/extension-service-*.log
```

**Result:** _(pending — run at the booth)_

### Recording a result that differs from expectation

A scenario that behaves differently from the expectation above is a result to report, not a
failure to work around at the booth (per the plan's own `<how-to-verify>`). Record what actually
happened, the summary line it produced, and any unexpected log line, and compare the observed
trigger sequence against `07-EVIDENCE-dslrbooth-triggers.md` before concluding whether it is a
new measurement or a regression.

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter — **withheld deliberately.** Every automated
      requirement above is green, but `nyquist_compliant` for this phase also depends on SC-6, the
      five-scenario live booth gate above, which has not run. Setting it `true` before that gate
      records a real result would be recording the phase as sampling-sufficient for a claim no
      sample has yet confirmed against the one signal source (a physical camera) this phase's own
      domain statement names as authoritative.

**Approval:** pending — blocked on the five-scenario live booth gate above. `status` and
`wave_0_complete` in this file's frontmatter stay at their seeded values (`draft`, `false`) until
a human runs all five scenarios and records their outcomes; per this plan's own acceptance
criteria, both flip **only if every scenario passed**.
