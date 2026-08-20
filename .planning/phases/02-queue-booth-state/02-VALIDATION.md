---
phase: 2
slug: queue-booth-state
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-08-10
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Populated from `02-RESEARCH.md` § Validation Architecture at plan-phase time,
> so the plan-checker sees a real contract rather than an unfilled template.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest ^2.1.4 (running 2.1.9) — `mirror-request/package.json:42` |
| **Config file** | `mirror-request/vitest.config.ts` |
| **Quick run command** | `cd mirror-request && npx vitest run test/<file>.test.ts` |
| **Full suite command** | `cd mirror-request && npm test` |
| **Estimated runtime** | ~3 s measured (11 files, 69 tests, 2.70 s wall) |

**Test isolation note (corrected 2026-08-10).** `vitest.config.ts:12` already
points tests at `./data/test-extension-service.sqlite`, separate from the
production database — the production file is NOT touched by the suite. The open
problem (WINDOWS.md ledger item 4) is narrower: all test *files* share that one
test DB through the `getStore()` singleton, and vitest runs files in parallel
workers, so tests interfere across files. Measured 3 failures in 10 runs before
commit `e54e22e`.

**This matters more in Phase 2 than it did in Phase 1.** Phase 1 assertions could
scope themselves to a freshly generated id. `booth_state` is a **single global
row** — there is no per-test id to scope to. Any test asserting on booth state
against the shared store is inherently racy. Therefore:

- Booth-state and timer tests MUST use either a mocked `LocalStore` or a
  per-file temp DB via the `constructor(dbPath?)` seam. They must NOT use
  `getStore()`.
- No test may assert on a global count or on the absence of rows it did not create.

---

## Sampling Rate

- **After every task commit:** `cd mirror-request && npx vitest run test/<file>.test.ts` for the file(s) touched
- **After every plan wave:** `cd mirror-request && npm test` (full suite — 2.7 s, cheap enough to run every merge)
- **Before `/gsd-verify-work`:** full suite green
- **Max feedback latency:** 30 s

**Additional phase-gate check, specific to this phase.** This phase exists
because of a defect only observable against real persisted state. After the fix
ships and the service restarts, re-inspect the live database's `booth_state` and
`queue_job` rows read-only: the booth must no longer be stuck `BUSY`, the four
stranded `dispatched` rows must be resolved, and `job-webhook-001` must have
progressed. Unit tests alone cannot demonstrate this.

---

## Per-Task Verification Map

Task IDs are assigned by the planner; this map is keyed by requirement and
decision so the planner can attach each row to whichever task implements it.

| Requirement / Decision | Behavior | Test Type | Automated Command | File Exists |
|---|---|---|---|---|
| QUE-01 / D-06 | FIFO order survives a retry — a requeued job returns to its original position, not the back | unit (mocked `LocalStore`) | `npx vitest run test/queue-fifo-retry.test.ts` | ❌ Wave 0 |
| QUE-02 / D-11 / D-12 | A requeue under the retry path cannot create a second `queue_job` row for one registration | integration (real `LocalStore` via `constructor(dbPath?)`, temp dir) | `npx vitest run test/queue-idempotency.test.ts` | ❌ Wave 0 |
| QUE-03 / BTH-01 / D-09 / D-10 | IDLE + queued job → ANNOUNCING → BUSY, full transition sequence | unit (fake timers, mocked store) | `npx vitest run test/queue-countdown.test.ts` | ✅ exists — extend |
| QUE-04 | `session_end` → IDLE → auto-dispatch next | unit (fake timers, mocked store) | `npx vitest run test/queue-countdown.test.ts` | ✅ exists — extend |
| BTH-02 / D-05 / D-06 / D-07 | Live BUSY timeout (no restart) → retry preserving `queued_at`, then `failed` once `SESSION_MAX_RETRIES` is exhausted, with a warning emitted | unit (fake timers, `vi.advanceTimersByTime()`) | `npx vitest run test/queue-timeout-retry.test.ts` | ❌ Wave 0 |
| D-01 / D-02 | Startup recovery: BUSY booth, age ≥ `SESSION_TIMEOUT_MS` → IDLE + **all** in-flight jobs resolved (plural — see Pitfall 1) | unit (`vi.setSystemTime()`) + integration seeded to reproduce the live 4-row scenario | `npx vitest run test/queue-recovery.test.ts` | ❌ Wave 0 |
| D-03 | Startup recovery: BUSY booth, age < `SESSION_TIMEOUT_MS` → stays BUSY, timer re-armed for the remainder only | unit (mocked store, fake timers) | `npx vitest run test/queue-recovery.test.ts` | ❌ Wave 0 |
| D-04 | Startup recovery: ANNOUNCING booth → IDLE, job untouched, re-announced by the next tick | unit (mocked store, fake timers) | `npx vitest run test/queue-recovery.test.ts` | ❌ Wave 0 |
| D-13 | `queueService.ts` reads timeouts from injected `EnvConfig`, not `process.env` | unit (construct with an explicit config object; assert behavior follows the injected value) | `npx vitest run test/queue-config-injection.test.ts` | ❌ Wave 0 |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `mirror-request/test/queue-recovery.test.ts` — D-01..D-04, including an integration case seeded to reproduce the exact live 4-row scenario
- [ ] `mirror-request/test/queue-timeout-retry.test.ts` — D-05..D-07 on the live `busyTimer` path
- [ ] `mirror-request/test/queue-fifo-retry.test.ts` — D-06's explicit `queued_at`-preservation guarantee
- [ ] `mirror-request/test/queue-idempotency.test.ts` — D-12's requeue-cannot-duplicate guarantee
- [ ] `mirror-request/test/queue-config-injection.test.ts` — D-13
- [x] No framework install needed — Vitest with fake timers covers every test type this phase needs

**Known mocking caveat.** `vi.mock()` does not intercept runtime `require()`
calls in this codebase; Phase 1's `test/db-poller.test.ts` worked around it with
`createRequire(import.meta.url)` + `vi.spyOn()`. Reuse that pattern rather than
rediscovering it.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|---|---|---|---|
| Live production database recovers on first restart after the fix | D-01, D-02 | The defect is a property of real persisted state; the stranded rows exist only in the live DB | Restart the service, then read-only query `booth_state` and `queue_job`: booth not `BUSY`, the 4 stale `dispatched` rows resolved, `job-webhook-001` progressed |
| A real Agent honours the dispatch after ANNOUNCING | QUE-03, D-09 | Requires the actual Agent over WebSocket; the transport is Phase 3 | Manual end-to-end run with the booth Agent connected |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30 s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
