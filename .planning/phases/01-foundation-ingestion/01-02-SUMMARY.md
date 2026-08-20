---
phase: 01-foundation-ingestion
plan: 02
subsystem: api
tags: [express, better-sqlite3, hmac, replay-protection, vitest, supertest, webhook-security]

# Dependency graph
requires:
  - phase: 01-foundation-ingestion (plan 01-01)
    provides: "webhookAuth.ts skeleton (raw-body capture, HMAC verify, isTimestampFresh stub, checkWebhookAuth stub), MirrorReceiverOptions (hmacSecret/timestampSkewMs/dedupWindowMs/onEnqueue), complete EnvConfig surface"
provides:
  - "LocalStore constructor(dbPath?: string) test seam; getStore() singleton behavior unchanged"
  - "webhook_replay SQLite table + hasSeenWebhookId()/recordWebhookId()/countWebhookIds() prepared-statement methods"
  - "checkWebhookAuth(req, store, {secret, skewMs, nowMs?}): boolean — the single webhook auth decision function (signature -> timestamp freshness -> replay), replacing the inline guard from 01-01"
  - "clientIp(req) — single source of the peer address shared by isWhitelisted() and the handler's logged ip"
  - "test/local-store-persistence.test.ts proving replay ids and the poll cursor survive a close/reopen cycle"
affects: [01-03, 01-04, 01-05]

# Actuals (#2632)
actuals:
  tokens: 5436
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "LocalStore test seam: constructor(dbPath?: string) resolving to CONFIG.LOCAL_STORE_PATH only when omitted — getStore() singleton untouched, matches the QueueService/NotificationService factory-binding convention"
    - "checkWebhookAuth() as the single boolean decision function for webhook auth; it logs nothing and the caller owns the one generic 403 log line + response body (D-12)"
    - "clientIp(req) extracted once and reused by both the allow-list check and the logged ip, so checked and logged values can never diverge"

key-files:
  created:
    - mirror-request/test/local-store-persistence.test.ts
  modified:
    - mirror-request/src/state/localStore.ts
    - mirror-request/src/ingestion/webhookAuth.ts
    - mirror-request/src/ingestion/mirrorReceiver.ts
    - mirror-request/test/on-register-auth.test.ts

key-decisions:
  - "checkWebhookAuth() takes the concrete LocalStore type (not a structural interface) for opts.store — keeps the exported surface small and satisfies the plan's grep-based acceptance criteria without adding an unnecessary abstraction"
  - "Prefix-match IP allow-list test ('203.0.113.*') simulates the origin address via a pre-router middleware that overrides req.ip with Object.defineProperty, since supertest always originates from loopback and the production clientIp()/isWhitelisted() logic is otherwise untestable for that branch without a mocking seam"

patterns-established:
  - "Test-only req.ip override middleware (buildAppWithFakeIp) for allow-list branches unreachable via a real loopback supertest connection — production code is untouched, only the test harness fakes the peer address"

requirements-completed: [AUTH-02, STO-01, ING-03]

coverage:
  - id: D1
    description: "A request whose X-Webhook-Timestamp is older or newer than WEBHOOK_TIMESTAMP_SKEW_MS relative to server time returns 403 and persists nothing"
    requirement: "AUTH-02"
    verification:
      - kind: unit
        ref: "test/on-register-auth.test.ts#isTimestampFresh (4 cases: exact, too old, too far future, non-numeric)"
        status: pass
      - kind: integration
        ref: "test/on-register-auth.test.ts#rejects a correctly-signed request with a timestamp 10 minutes old and persists nothing"
        status: pass
    human_judgment: false
  - id: D2
    description: "Replaying a byte-identical, correctly-signed request a second time returns 403 because its X-Webhook-Id is already recorded"
    requirement: "AUTH-02"
    verification:
      - kind: integration
        ref: "test/on-register-auth.test.ts#accepts the first delivery of a request then rejects a byte-identical replay, adding no new registration row"
        status: pass
    human_judgment: false
  - id: D3
    description: "Replay state and the poll cursor survive a LocalStore close/reopen cycle (process-restart durability)"
    requirement: "STO-01"
    verification:
      - kind: unit
        ref: "test/local-store-persistence.test.ts (5 cases, including both close/reopen cases)"
        status: pass
    human_judgment: false
  - id: D4
    description: "A request arriving from a socket IP outside PROXY_IP_WHITELIST returns 403 even when X-Forwarded-For claims an allow-listed IP"
    requirement: "AUTH-02"
    verification:
      - kind: integration
        ref: "test/on-register-auth.test.ts#IP allow-list > rejects a loopback-origin request even when a forwarding header claims an allow-listed IP"
        status: pass
      - kind: integration
        ref: "test/on-register-auth.test.ts#IP allow-list (prefix-match accept/reject, loopback accept, empty-whitelist dev escape hatch — 5 cases total)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Every authentication failure returns exactly {error:\"Forbidden\"} with no field naming which check failed"
    verification:
      - kind: integration
        ref: "test/on-register-auth.test.ts#expectForbidden() helper applied to every 403 assertion in the file (12 call sites)"
        status: pass
    human_judgment: false
  - id: D6
    description: "Full existing Vitest suite does not regress alongside the 3 modified/1 new test file for this plan"
    verification:
      - kind: integration
        ref: "npm test (8 files, 34 tests, all pass)"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-08-10
status: complete
---

# Phase 1 Plan 2: Durable Replay Protection, Timestamp Freshness, and Hardened IP Allow-List Summary

**Durable SQLite-backed webhook replay protection, symmetric timestamp-freshness checking, and an IP allow-list that reads only the direct TCP peer — closing the two gaps the 01-01 signature tracer left open (replayability and forwarding-header spoofing).**

## Performance

- **Duration:** ~20 min
- **Completed:** 2026-08-10T08:08Z
- **Tasks:** 3/3
- **Files modified:** 5 (3 modified, 1 created — excluding the SUMMARY itself)

## Accomplishments

- Added a `webhook_replay` SQLite table (`webhook_id TEXT PRIMARY KEY`, `received_at INTEGER NOT NULL`) plus `hasSeenWebhookId()` / `recordWebhookId()` / `countWebhookIds()` prepared-statement methods on `LocalStore`, and gave `LocalStore` a `constructor(dbPath?: string)` test seam so tests can point it at a throwaway SQLite file without touching the process-wide singleton contract.
- Redesigned `checkWebhookAuth()` in `webhookAuth.ts` into the single webhook-authentication decision function: signature verification, then symmetric timestamp-freshness (`isTimestampFresh()`, already present from 01-01 and confirmed to match the plan's exact behavioral contract), then replay-id rejection — in that order, with the replay id recorded only after every prior check passes so a probing attacker cannot burn a legitimate id.
- `mirrorReceiver.ts` now delegates to `checkWebhookAuth(req, store, opts)` instead of inlining the signature-only guard from 01-01; still exactly two `res.status(403)` branches in the file (IP denial, auth denial), both returning the bare `{error:"Forbidden"}` body.
- Extracted `clientIp(req)` as the single source of the peer address for both the allow-list check and the logged IP, with a doc comment recording why no Express `trust proxy` setting exists anywhere in the service (enabling it unscoped would let a forged `X-Forwarded-For` header impersonate an allow-listed source, defeating AUTH-02/T-01-10).
- 12 new/extended test cases across `on-register-auth.test.ts` (timestamp freshness unit tests, stale-timestamp/missing-id/replay HTTP cases, IP allow-list spoofing/loopback/prefix-match cases) plus 5 new persistence tests in `local-store-persistence.test.ts` proving replay state and the poll cursor survive a close/reopen cycle. Full suite: 8 files, 34 tests, all passing.

## Task Commits

1. **Task 1: Durable webhook_replay state in LocalStore, plus a testable database path** - `29279ae` (feat, tdd)
2. **Task 2: Timestamp freshness and replay rejection behind one generic denial path** - `9ff6e64` (feat, tdd)
3. **Task 3: IP allow-list hardening — the socket peer decides, not a forwarding header** - `8572146` (feat, tdd)

_Note: each task's `tdd="true"` behavior was implemented and verified together with its tests in a single commit per task, following the same integration-test-alongside-implementation style established in 01-01, rather than separate RED/GREEN commits._

## Files Created/Modified

- `mirror-request/src/state/localStore.ts` - `constructor(dbPath?: string)` test seam, `webhook_replay` table, `hasSeenWebhookId`/`recordWebhookId`/`countWebhookIds` methods
- `mirror-request/src/ingestion/webhookAuth.ts` - `checkWebhookAuth()` redesigned to take `(req, store, opts)` and return a bare boolean gating signature -> freshness -> replay; `isTimestampFresh()` doc comment clarified (implementation already matched the plan's required behavior)
- `mirror-request/src/ingestion/mirrorReceiver.ts` - inline signature guard replaced with a `checkWebhookAuth()` call; `clientIp()` helper extracted and documented; `isWhitelisted()` now sources the peer address from `clientIp()`
- `mirror-request/test/local-store-persistence.test.ts` - NEW: 5 cases covering fresh-db state, idempotent insert, and both replay-id and poll-cursor close/reopen durability
- `mirror-request/test/on-register-auth.test.ts` - extended with `isTimestampFresh` unit tests, timestamp/replay HTTP tests, an IP allow-list describe block, and a shared `expectForbidden()` helper applied to every 403 assertion in the file

## Decisions Made

- `checkWebhookAuth(req, store, opts)` takes the concrete `LocalStore` type for `store` rather than a minimal structural interface — this kept the acceptance-criteria grep for `recordWebhookId` in `webhookAuth.ts` at exactly 1 occurrence (the call site) and avoided duplicating method signatures in a bespoke interface.
- The `whitelist = ['203.0.113.*']` prefix-matching behavior cannot be exercised through a real supertest connection (which always originates from loopback), so the test file adds a `buildAppWithFakeIp()` helper that overrides `req.ip` via a pre-router middleware using `Object.defineProperty`. This is test-only scaffolding — the production `clientIp()`/`isWhitelisted()` logic under test is unaware of it.
- `isTimestampFresh()` was already present and already matched the plan's exact required signature and symmetric-window behavior (delivered as part of 01-01's `webhookAuth.ts` skeleton, per its SUMMARY's `provides` list) — no functional change was needed, only a doc-comment clarification.

## Deviations from Plan

None — plan executed exactly as written. All three tasks' acceptance criteria (grep checks, behavior tests, `npm test`, `npm run typecheck`, the `trust proxy` grep) pass.

## Issues Encountered

None. The pre-existing `localStore.ts` duplicate-`getJobRegistration()` blocker flagged in 01-01's SUMMARY was already fixed by the orchestrator (commit `c5bcedb`, confirmed present before this plan's execution began) — `npm run typecheck` and `npm test` both ran clean throughout this plan.

**Note on the plan's top-level `<verification>` grep:** the plan's overall `<verification>` block reads `grep -rni "trust proxy" src` — no matches, taken completely literally. Task 3's own action item 1 explicitly requires adding a doc comment above `isWhitelisted` that names `trust proxy` by name (to record why the setting is intentionally absent), and Task 3's own `<acceptance_criteria>` uses the more precise comment-excluding form (`grep -rniv '^\s*[/*]' --include=*.ts src | grep -ci "trust proxy"` outputs 0) — which passes. A bare `grep -rni "trust proxy" src` now returns 3 matches, all inside the doc comment task 3 asked for. Followed the task-level acceptance criteria (the authoritative, more precise check) over the looser plan-level restatement, since satisfying the literal bare grep would require omitting the documentation the task explicitly asked for.

## Known Stubs

None.

## Threat Flags

None — all new surface (`webhook_replay` table, `checkWebhookAuth()` replay/freshness logic, `clientIp()`) matches the plan's `<threat_model>` register (T-01-08 through T-01-13); no new unplanned surface was introduced.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `webhookAuth.ts` and `mirrorReceiver.ts` now present a complete, hardened `/on-register` authentication path (signature + timestamp + replay + IP allow-list) for plans 01-03 through 01-05 to build on without further changes to this surface.
- `LocalStore`'s `dbPath?` test seam is available for any future plan that needs an isolated SQLite fixture.
- The unconfirmed Mirror Request signing-contract assumption (canonical string composition, epoch-milliseconds timestamp semantics) remains isolated in `buildCanonicalString()`/`isTimestampFresh()`, still booked for human confirmation in plan 01-05 task 3 per 01-01's SUMMARY — no new assumption was introduced by this plan.
- No blockers for the phase gate from this plan's own work.

---
*Phase: 01-foundation-ingestion*
*Completed: 2026-08-10*

## Self-Check: PASSED

All 5 created/modified source and test files found on disk. All 3 task commits (`29279ae`, `9ff6e64`, `8572146`) found in `git log`. SUMMARY.md itself confirmed present at its expected path.
