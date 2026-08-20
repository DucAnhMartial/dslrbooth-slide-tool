---
phase: 4
slug: guest-notification
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-08-10
---

# Phase 4 — Validation Strategy

> Populated from `04-RESEARCH.md` § Validation Architecture at plan-phase time, so the
> plan-checker sees a real contract rather than an unfilled template.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest ^2.1.4 (running 2.1.9) |
| **Config file** | `mirror-request/vitest.config.ts` (`LOG_LEVEL=error`, separate test DB path — unchanged by this phase) |
| **Quick run command** | `cd mirror-request && npx vitest run test/<file>.test.ts` |
| **Full suite command** | `cd mirror-request && npm test` |
| **Estimated runtime** | ~4.8 s measured (23 files, 155 tests) |

**The "2xx proves nothing" hazard — binding on every verify block.** `web-slide/server.js`
returns `200` unconditionally and falls back to `''` / `'Khách hàng'` for missing fields.
A test asserting only the HTTP status proves nothing about payload shape. Every delivery
test MUST assert the exact outbound body.

**Test isolation.** WINDOWS.md item 4 is open: all test files share one test DB through
the `getStore()` singleton under parallel vitest workers. `notification_record` is keyed
by `jobId`, so per-test generated ids are naturally safer than Phase 2's single-row
`booth_state`. No new test may call `getStore()`.

---

## Sampling Rate

- **After every task commit:** `npx vitest run <file>` for the files touched
- **After every plan wave:** `cd mirror-request && npm test` (155 tests, ~4.8 s)
- **Before `/gsd-verify-work`:** full suite green
- **Max feedback latency:** 30 s

**Phase gate additionally requires** at least one assertion of the exact outbound payload
against a **real** ephemeral HTTP server (not a mocked `fetch`), covering a
**post-restart-resumed** delivery specifically. A mocked `fetch` cannot prove the sweeper's
SQL-driven resumption path reconstructs the same payload shape end to end.

---

## Per-Requirement Verification Map

| Req / Decision | Behavior | Test Type | Automated Command | File |
|---|---|---|---|---|
| NOT-01 | `file_upload` → lookup → enqueue with correct name/photo/mode, no PII | unit (mocked store, asserts exact enqueue args) | `npx vitest run test/notification-service.test.ts` | ✅ **must be updated** — `sendPhotoLink()` becomes enqueue-only |
| NOT-01 | Real HTTP round-trip payload shape (exact field names, name + photo only) | integration (real ephemeral server) | `npx vitest run test/notification-webhook.test.ts` | ✅ **must be fixed** — see D-11 |
| D-04 / D-05 | Restart mid-retry resumes from the persisted `photoUrl`; an already-`delivered` row is never re-sent | unit (temp-path `LocalStore`, two service instances simulating a restart) | `npx vitest run test/notification-sweeper-restart.test.ts` | ❌ Wave 0 |
| D-05 | Overlapping sweep passes cannot double-claim a row | unit (mocked store + fake timers) | `npx vitest run test/notification-sweeper-claim.test.ts` | ❌ Wave 0 |
| D-07 | A hung target times out at `NOTIFY_FETCH_TIMEOUT_MS`; `lastError` distinguishes timeout from connection-refused | unit (mocked `fetch`: never-resolving vs. rejecting) | `npx vitest run test/notification-fetch-timeout.test.ts` | ❌ Wave 0 |
| D-08 | Total attempts are `1 + NOTIFY_MAX_RETRIES`, not `NOTIFY_MAX_RETRIES` | unit (always-rejecting `fetch`, count calls) | `npx vitest run test/notification-retry-count.test.ts` | ❌ Wave 0 |
| D-09 / NOT-02 | Retries exhausted → `status='failed'`, `lastError` set, one `logger.error` | unit (`vi.spyOn` on the logger object, intercepting before Winston's level filter) | same file as above | ❌ Wave 0 |
| D-10 | One row's failure never throws out of `sweep()` or stops the next row | unit (two due rows, first throws) | `npx vitest run test/notification-sweeper-claim.test.ts` | ❌ Wave 0 |
| Migration | Pre-existing rows with `photoUrl IS NULL` are marked `failed` with an explanatory reason, idempotently across repeated `migrate()` calls | integration (temp-path `LocalStore`, pre-migration row, reopen) | `npx vitest run test/local-store-persistence.test.ts` | ✅ existing file, new case |

---

## Wave 0 Requirements

- [ ] `test/notification-sweeper-restart.test.ts` — D-04, D-05
- [ ] `test/notification-sweeper-claim.test.ts` — D-05, D-10
- [ ] `test/notification-fetch-timeout.test.ts` — D-07
- [ ] `test/notification-retry-count.test.ts` — D-08, D-09
- [ ] `test/notification-service.test.ts` — **updated**, not merely extended
- [ ] `test/notification-webhook.test.ts` — **fixed** for the `getStore()` coupling (D-11)
- [ ] `test/local-store-persistence.test.ts` — extended with the migration-backfill case
- [ ] `src/config.ts` — `NOTIFY_FETCH_TIMEOUT_MS` and `NOTIFY_SWEEP_INTERVAL_MS` as typed config via the existing `toNum('KEY', default)` idiom. Wave 0 groundwork every test above depends on.
- [x] No framework install needed

**Known caveat:** `vi.mock()` does not intercept runtime `require()` in this codebase (see
`test/db-poller.test.ts`'s header). `fetch` is a Node 20 global, not a require — establish
the interception approach explicitly rather than assuming either pattern applies.

---

## Manual-Only Verifications

| Behavior | Why Manual | Instructions |
|---|---|---|
| Production `NOTIFY_WEBHOOK_URL` is reachable from the server | `.env*` is sandbox-denied; the real URL is unknown here | At the phase gate, confirm the configured URL resolves from the deploy host. Existing warn-and-skip when unset is the safe fallback. |
| A real photo appears on the slideshow | Requires the booth, the Agent and `web-slide` running together | End-to-end run after the Phase 3 cutover deploy |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Every delivery test asserts the exact outbound payload, never only HTTP status
- [ ] No new test calls `getStore()`
- [x] `nyquist_compliant: true`

**Approval:** pending
