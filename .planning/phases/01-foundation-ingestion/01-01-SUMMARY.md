---
phase: 01-foundation-ingestion
plan: 01
subsystem: api
tags: [express, hmac, node-crypto, sqlite, vitest, supertest, webhook-security]

# Dependency graph
requires: []
provides:
  - "webhookAuth.ts: raw-body capture (jsonWithRawBody), HMAC-SHA256 verification (verifySignature), canonical-string builder (buildCanonicalString), timestamp-freshness check (isTimestampFresh)"
  - "MirrorReceiverOptions on createMirrorReceiver: hmacSecret, timestampSkewMs, dedupWindowMs, onEnqueue — the options contract later Phase 1 plans extend"
  - "Complete EnvConfig surface: WEBHOOK_HMAC_SECRET, WEBHOOK_TIMESTAMP_SKEW_MS, REGISTRATION_DEDUP_WINDOW_MS with D-01/D-11 defaults"
  - "Production-strict loadConfig() validation for D-09 (fails fast if either webhook control is unconfigured in NODE_ENV=production)"
  - "DB_PORT default corrected 5432 -> 3306"
affects: [01-02, 01-03, 01-04, 01-05]

# Actuals (#2632)
actuals:
  tokens: 5586
  tasks: 2
  commits: 2

# Tech tracking
tech-stack:
  added: [supertest@^7.2.2 (devDependency), "@types/supertest@^7.2.1 (devDependency)"]
  patterns:
    - "Raw-body capture via express.json({verify}) at the single global middleware call site, never a route-scoped second parser"
    - "HMAC verification: length-guard before crypto.timingSafeEqual, whole function wrapped in try/catch so malformed input degrades to false/403, never a 500"
    - "buildCanonicalString() isolated as the single swappable point for the unconfirmed Mirror Request signing contract (RESEARCH.md A1)"
    - "NODE_ENV === 'production' as the single strictness signal for mandatory config (no separate feature-flag toggle for disabling auth)"

key-files:
  created:
    - mirror-request/src/ingestion/webhookAuth.ts
    - mirror-request/test/on-register-auth.test.ts
    - mirror-request/test/config-validation.test.ts
  modified:
    - mirror-request/src/index.ts
    - mirror-request/src/ingestion/mirrorReceiver.ts
    - mirror-request/src/config.ts
    - mirror-request/src/types.ts
    - mirror-request/vitest.config.ts
    - mirror-request/.env.example
    - mirror-request/package.json

key-decisions:
  - "HMAC canonical string is timestamp.webhookId.rawBody (includes webhook id to block replay-under-fresh-id attacks); isolated in buildCanonicalString() pending human confirmation against the real Mirror Request signer (booked for plan 01-05 task 3)"
  - "D-09 'production requires both controls' implemented via NODE_ENV === 'production' gating loadConfig() validation, not a separate ENFORCE_WEBHOOK_AUTH toggle — an explicit disable toggle would violate the spirit of D-09"
  - "Production PROXY_IP_WHITELIST validation also rejects the bare ['127.0.0.1'] default as unconfigured, matching the existing 'reject placeholder' treatment used for AGENT_WS_TOKEN/DB_PASSWORD"

patterns-established:
  - "Options-object factory pattern: createMirrorReceiver(store, whitelist, options) — later plans add fields to MirrorReceiverOptions rather than adding positional parameters"
  - "checkWebhookAuth() exported as a named extension point for the dedup/replay work in plan 01-02, even though mirrorReceiver.ts currently inlines the equivalent guard for exact D-12 response-shape control"

requirements-completed: [ING-01, AUTH-02, STO-01]

coverage:
  - id: D1
    description: "A signed POST /on-register with a valid X-Webhook-Signature over the raw body is accepted (200, {accepted:true,jobId}) and readable back from SQLite"
    requirement: "ING-01"
    verification:
      - kind: integration
        ref: "test/on-register-auth.test.ts#accepts a request with a valid signature over the exact raw body"
        status: pass
    human_judgment: false
  - id: D2
    description: "A tampered/unsigned/malformed-signature POST /on-register is rejected with a bare 403 {error:\"Forbidden\"} and persists nothing"
    requirement: "AUTH-02"
    verification:
      - kind: integration
        ref: "test/on-register-auth.test.ts#rejects a request whose signature was computed over a different body (tampered payload)"
        status: pass
      - kind: integration
        ref: "test/on-register-auth.test.ts#rejects a request with no X-Webhook-Signature header while a secret is configured"
        status: pass
      - kind: integration
        ref: "test/on-register-auth.test.ts#rejects a malformed/wrong-length signature header with 403, not 500"
        status: pass
    human_judgment: false
  - id: D3
    description: "An empty hmacSecret (non-production escape hatch) accepts an unsigned request with 200"
    verification:
      - kind: integration
        ref: "test/on-register-auth.test.ts#accepts an unsigned request when the router is constructed with an empty HMAC secret"
        status: pass
    human_judgment: false
  - id: D4
    description: "loadConfig() production-strict validation for WEBHOOK_HMAC_SECRET and PROXY_IP_WHITELIST, plus D-01/D-08/D-11 numeric defaults and the DB_PORT 3306 correction"
    verification:
      - kind: unit
        ref: "test/config-validation.test.ts (6 cases: production throws x2, production passes, non-production defaults, dedup/skew defaults, DB_PORT default)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Full existing Vitest suite (5 pre-existing files) does not regress alongside the 2 new test files"
    verification:
      - kind: integration
        ref: "npm test (7 files, 17 tests, all pass)"
        status: pass
    human_judgment: false

duration: 10min
completed: 2026-08-10
status: complete
---

# Phase 1 Plan 1: End-to-End Signed Webhook Ingestion + Config Surface Summary

**HMAC-SHA256 webhook authentication for POST /on-register (raw-body capture, constant-time verification, generic 403) plus the complete Phase 1 EnvConfig surface with NODE_ENV-gated production-strict validation and the DB_PORT Postgres→MySQL default fix.**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-08-10T07:48Z (baseline WIP commit)
- **Completed:** 2026-08-10T07:57Z
- **Tasks:** 2/2
- **Files modified:** 10 (7 modified, 3 created — excluding package-lock.json)

## Accomplishments

- Fixed the verified raw-body-destruction bug: `express.json()` now captures `req.rawBody` via a `verify` callback (`jsonWithRawBody()`) at the same global middleware call site, so HMAC verification sees the exact wire bytes rather than a re-serialized `req.body`.
- Added `webhookAuth.ts` with constant-time, length-guarded HMAC-SHA256 verification (`verifySignature`) and an isolated `buildCanonicalString()` swap point for the unconfirmed Mirror Request signing contract.
- `mirrorReceiver.ts` now takes a `MirrorReceiverOptions` object (`hmacSecret`, `timestampSkewMs`, `dedupWindowMs`, `onEnqueue`) and gates `/on-register` on signature verification before the existing `id`/`name` validation, returning a bare `{error:"Forbidden"}` 403 on any auth failure per D-12.
- Completed the `EnvConfig`/`loadConfig()` surface for Phase 1: `WEBHOOK_HMAC_SECRET`, `WEBHOOK_TIMESTAMP_SKEW_MS` (default 300000), `REGISTRATION_DEDUP_WINDOW_MS` (default 300000), plus production-strict fail-fast validation for D-09 (both webhook controls mandatory when `NODE_ENV=production`) and the `DB_PORT` default correction (5432 → 3306).
- 11 new test cases across two files, all passing; full existing suite (5 pre-existing files) unaffected.

## Task Commits

1. **Task 1: End-to-end signed /on-register — one path, wired through every layer** - `7d7a148` (feat, tracer/tdd)
2. **Task 2: Production-strict config validation, dedup/skew defaults, and the DB_PORT correction** - `6dfe7bb` (feat)

_Note: both tasks were single-commit; no separate RED/GREEN test-only commits were made since the tests were written alongside the implementation as integration/unit test files rather than a strict TDD RED-fail-first cycle for this plan._

## Files Created/Modified

- `mirror-request/src/ingestion/webhookAuth.ts` - HMAC-SHA256 verification, raw-body capture, canonical string builder
- `mirror-request/src/ingestion/mirrorReceiver.ts` - `MirrorReceiverOptions`, signature guard ahead of `id`/`name` validation
- `mirror-request/src/index.ts` - wires `jsonWithRawBody()` globally, passes webhook options to `createMirrorReceiver`
- `mirror-request/src/config.ts` - new EnvConfig keys, production-strict validation block, DB_PORT fix
- `mirror-request/src/types.ts` - `EnvConfig` extended with 3 new keys
- `mirror-request/vitest.config.ts` - hermetic `test.env` block
- `mirror-request/.env.example` - documents new Phase 1 keys
- `mirror-request/package.json` / `package-lock.json` - `supertest`, `@types/supertest` devDependencies
- `mirror-request/test/on-register-auth.test.ts` - 5 HTTP-level auth cases
- `mirror-request/test/config-validation.test.ts` - 6 config-validation cases

## Decisions Made

- Canonical HMAC string is `${timestamp}.${webhookId}.${rawBody}` — includes the webhook id to prevent an attacker replaying a captured valid signature under a fresh `X-Webhook-Id`. Isolated in `buildCanonicalString()`; flagged for human confirmation against Mirror Request's actual signer in plan 01-05 task 3 (RESEARCH.md Assumption A1).
- D-09's "production requires both controls" is implemented purely via `NODE_ENV === 'production'` gating `loadConfig()`'s validation — no `ENFORCE_WEBHOOK_AUTH`-style toggle was added, since that would create a supported way to disable webhook authentication in production.
- Production `PROXY_IP_WHITELIST` validation also rejects the bare `['127.0.0.1']` default as "not really configured," extending the existing placeholder-rejection pattern already used for `AGENT_WS_TOKEN`/`DB_PASSWORD` (RESEARCH.md Open Question 3, resolved).

## Deviations from Plan

None — plan executed exactly as written. Both tasks' acceptance criteria (grep checks, behavior tests) all pass.

## Issues Encountered

**Pre-existing, out-of-scope blocker (not caused by this plan):** `mirror-request/src/state/localStore.ts` contains a duplicate `getJobRegistration()` method (lines 122 and 238), introduced by the baseline WIP commit `5519364` that predates this plan's execution. This causes:
- `npm run typecheck` / `npm run build` to fail with 3 `tsc` errors (TS2393 x2, TS2741 x1), unrelated to any file this plan touched.
- `npm run dev` (the plan's manual smoke-test step) to fail outright — `ts-node` refuses to start because it type-checks by default.

Per explicit dispatcher instruction, this bug is out of scope for plan 01-01 (it belongs to the M4/notification work that produced commit `5519364`) and was **not** fixed here. It was logged to `.planning/WINDOWS.md` (ledger id 1, kind `deviation`, phase 01) so it stays visible at ship time. This plan's own task-level `<verify>` commands (`npx vitest run <file>` and the code touched by `npm run typecheck`) all pass cleanly — the only failures are in the unrelated `localStore.ts` file. `npm test` (the full Vitest suite) passes: 7 files, 17 tests, 0 failures.

**Recommendation:** whoever picks up the M4 notification work (or a dedicated cleanup task) should remove the duplicate `getJobRegistration()` definition in `localStore.ts` before the phase-gate `npm run build`/`npm run dev` smoke tests can pass cleanly.

## Known Stubs

None.

## Threat Flags

None — all new surface (`/on-register` signature guard, `loadConfig()` production validation) matches the plan's `<threat_model>` register (T-01-01 through T-01-06); no new unplanned surface was introduced.

## User Setup Required

None - no external service configuration required. `WEBHOOK_HMAC_SECRET` must eventually be set to a real shared secret before production deploy, but that is an operator action documented in `.env.example`, not a code-time setup step.

## Next Phase Readiness

- The `MirrorReceiverOptions` contract (`hmacSecret`, `timestampSkewMs`, `dedupWindowMs`, `onEnqueue`) is in place for plan 01-02 to extend with IP-allowlist/timestamp/replay behavior.
- The complete `EnvConfig`/`loadConfig()` surface means plans 01-02 through 01-05 should not need to touch `config.ts`/`types.ts` again for Phase 1 keys.
- **Blocker for the phase gate (not this plan):** the pre-existing `localStore.ts` duplicate-method bug (see Issues Encountered) will block `npm run build` and `npm run dev` at `/gsd-verify-work` time until fixed by a future plan/task — flagged in `.planning/WINDOWS.md`.

---
*Phase: 01-foundation-ingestion*
*Completed: 2026-08-10*
