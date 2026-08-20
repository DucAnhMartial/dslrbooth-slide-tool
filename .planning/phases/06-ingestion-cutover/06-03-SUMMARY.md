---
phase: 06-ingestion-cutover
plan: 03
subsystem: security
tags: [rate-limiting, capability-url, express, vitest, ops]

# Dependency graph
requires:
  - phase: 06-ingestion-cutover
    provides: "index.ts already passes the whole config object to createStatusRouter (06-02) — the mount point this plan's limiter attaches to needed no call-site change"
provides:
  - "rateLimiter.ts — createRateLimitState/checkRateLimit/pruneExpired/createStatusRateLimiter/RATE_LIMITED_STATUS/RATE_LIMITED_BODY, a hand-rolled bounded fixed-window Express limiter"
  - "GET /status/:jobId is now rate limited, gated ahead of store.getJob(), closing D-10 and WINDOWS.md item 6"
  - "STATUS_RATE_LIMIT_WINDOW_MS/MAX/MAX_KEYS config keys, site-independent defaults, no production fail-fast"
affects: [06-05, 06-06]

actuals:
  tokens: 7117
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "Plain exported functions + one small factory, no class — ipAllowlist.ts's shape, applied to a second security-boundary module."
    - "Fixed-window rate limiting via a Map<string, {windowStart, count}>, pure decision function injectable in `now`, exactly the same 'config through the constructor, never a singleton' rule every timing knob in this project follows."
    - "Bounded attacker-controlled memory: prune closed windows first, then oldest-windowStart eviction if still over cap — same discipline as every other never-unbounded structure in this codebase."

key-files:
  created:
    - mirror-request/src/security/rateLimiter.ts
    - mirror-request/test/status-rate-limit.test.ts
  modified:
    - mirror-request/src/config.ts
    - mirror-request/src/types.ts
    - mirror-request/src/status/statusRoute.ts
    - mirror-request/test/status-api.test.ts

key-decisions:
  - "No new npm dependency: express-rate-limit was audited by RESEARCH and returned [SUS] ('too-new'); a hand-rolled ~150-line limiter in ipAllowlist.ts's shape was chosen instead, consistent with zero runtime dependencies added since Phase 1."
  - "30 requests / 60s per client address as the default threshold — arithmetic: a guest polling their own status page every few seconds stays far under 30/minute, while 30/minute turns a 2^40 id-guessing search from theoretically feasible into roughly 2^40/30 minutes (~24,500 years at one guess per allowed request) from a single source address. Distributed enumeration across many addresses remains an accepted residual (T-06-12), recorded for 06-06's OPS-RUNBOOK §10."
  - "The limiter is built inside createStatusRouter() per call, not at module scope, so each constructed router owns independent state — the same seam that lets a test build a fresh router per case with zero state leakage."
  - "Eviction under memory pressure removes closed windows first, then the OLDEST-windowStart entries among survivors — favoring recently-active clients over stale ones, rather than an arbitrary or LRU-by-access eviction."
  - "The pruneExpired capacity sweep runs AFTER the per-request decision, not before — this keeps the size <= maxKeys invariant true at the end of every single request (including the very last one of a burst), not just 'eventually'."
  - "The RATE_LIMITED_BODY is exactly { error: 'too many requests' } — one key, no reason/code/hint/retryAfter field — following statusRoute.ts's genericNotFound() single-response-shape discipline verbatim, since any difference between the throttled and not-found response shapes would be an enumeration oracle."

patterns-established:
  - "A second Express-agnostic, class-free security middleware module (rateLimiter.ts) alongside ipAllowlist.ts — establishes this as the project's standing pattern for any future rate-limited or allow-listed route, without touching express-rate-limit or any other npm dependency."

requirements-completed: [ING-02]

coverage:
  - id: D1
    description: "The (max+1)th request from one client inside the window is refused with a 429 and the fixed body { error: 'too many requests' }, with no reason/code/hint field."
    requirement: "ING-02"
    verification:
      - kind: unit
        ref: "test/status-rate-limit.test.ts#checkRateLimit — pure fixed-window decision (D-10) > allows requests 1..max and refuses request max+1"
        status: pass
      - kind: integration
        ref: "test/status-rate-limit.test.ts#GET /status/:jobId — the limiter mounted ahead of the lookup (D-10, T-06-01/T-06-02) > throttles the (max+1)th request from one client with the fixed 429 body"
        status: pass
    human_judgment: false
  - id: D2
    description: "A throttled response for a real job id and a throttled response for a fabricated id are identical on status and body — compared to each other, not each to a literal."
    requirement: "ING-02"
    verification:
      - kind: integration
        ref: "test/status-rate-limit.test.ts#GET /status/:jobId — the limiter mounted ahead of the lookup (D-10, T-06-01/T-06-02) > produces the identical throttled response for a real id and a fabricated id"
        status: pass
    human_judgment: false
  - id: D3
    description: "A throttled request never reaches the store — zero store.getJob() calls, proven by a call-count spy, structurally removing the latency side-channel rather than measuring timings."
    requirement: "ING-02"
    verification:
      - kind: integration
        ref: "test/status-rate-limit.test.ts#GET /status/:jobId — the limiter mounted ahead of the lookup (D-10, T-06-01/T-06-02) > never reaches the store on a throttled request"
        status: pass
    human_judgment: false
  - id: D4
    description: "Under the limit, existing /status/:jobId behaviour (a queued job's 8-key body; the generic 404 for an unknown id) is byte-for-byte unchanged from Phase 5."
    verification:
      - kind: integration
        ref: "test/status-rate-limit.test.ts#GET /status/:jobId — the limiter mounted ahead of the lookup (D-10, T-06-01/T-06-02) > under the limit, an existing job still returns its unchanged 8-key body / an unknown id still returns the generic 404"
      - kind: unit
        ref: "test/status-api.test.ts — full 27-test suite, unchanged, still green"
        status: pass
    human_judgment: false
  - id: D5
    description: "The limiter's memory cannot be grown without bound by an attacker rotating source addresses: expired entries are pruned and the tracked-key count is capped at STATUS_RATE_LIMIT_MAX_KEYS."
    requirement: "ING-02"
    verification:
      - kind: unit
        ref: "test/status-rate-limit.test.ts#pruneExpired — bounded state under key-rotation pressure (T-06-06) — both cases, plus the middleware's 'pushes maxKeys * 2 distinct keys ... size <= maxKeys' case"
        status: pass
    human_judgment: false

duration: 15min
completed: 2026-08-11
status: complete
---

# Phase 6 Plan 03: Rate Limiter for the 40-bit Capability URL Summary

**A hand-rolled, bounded, fixed-window Express limiter mounted as the first handler on `GET /status/:jobId`, proven by call-count spy (not timing) to gate ahead of the store lookup, and proven by direct `toEqual` comparison to make a throttled response for a real id indistinguishable from one for a fabricated id.**

## Performance

- **Duration:** ~15 min
- **Tasks:** 2/2 completed
- **Files modified:** 6 (2 created, 4 modified)
- **Commits:** 2 task commits

## Accomplishments

- `src/security/rateLimiter.ts` — a plain-function, class-free module in `ipAllowlist.ts`'s exact shape: `checkRateLimit(key, now, state, opts)` is a pure decision function with `now` injected as a parameter (no `Date.now()` call anywhere inside it, asserted by reading the function's own `toString()`); `pruneExpired(state, now, windowMs, maxKeys)` removes closed windows first, then the oldest-`windowStart` survivors if still over `maxKeys`; `createStatusRateLimiter(opts)` is the Express middleware factory, deriving its key with `clientIp()` imported (not re-derived) from `ipAllowlist.ts`.
- Three new `EnvConfig` keys — `STATUS_RATE_LIMIT_WINDOW_MS` (default 60000), `STATUS_RATE_LIMIT_MAX` (default 30), `STATUS_RATE_LIMIT_MAX_KEYS` (default 10000) — with site-independent defaults and, deliberately, no production fail-fast check, matching `VIEW_PROBE_INTERVAL_MS`'s precedent from 06-02.
- `statusRoute.ts`'s `StatusConfig` widened to a six-key `Pick<EnvConfig, ...>`; `createStatusRouter()` builds one limiter per router call (not module scope) and mounts it as the literal first argument to `router.get('/status/:jobId', rateLimiter, ...)`, ahead of `store.getJob()`. The comment above the mount names the exact edit that would silently reintroduce the timing side-channel this plan closes.
- 16 new tests in `test/status-rate-limit.test.ts`: 10 pure-function tests (both sides of the window boundary asserted, two independent-budget keys, memory-bound proof under `maxKeys * 2` key rotation) plus a 6-test supertest suite over a real `LocalStore`/`Express` app proving throttling, non-distinguishability (`toEqual` of `{status, body}` between a real and a fake id), gate-ordering (`vi.spyOn(store, 'getJob')` — zero additional calls across a throttled request), unchanged under-limit behaviour, and no cross-case state leakage between freshly-constructed routers.
- WINDOWS.md item 6 (open since Phase 5, `/gsd-ship`'s long-standing blocker on capability-URL entropy) marked **fixed** — the factual question D-10 answers was already recorded in `06-CONTEXT.md`; this plan ships the mitigation the entry was waiting on.

## Task Commits

Each task was committed atomically in `mirror-request`:

1. **Task 1: A bounded fixed-window limiter in this project's own middleware shape** — `f73e20b` (feat)
2. **Task 2: Mount it ahead of the lookup, and prove throttling reveals nothing** — `65237a2` (feat)

Both tasks carry `tdd="true"`. Task 1 genuinely went RED first (`rateLimiter.ts` did not exist prior to implementation). Task 2's new assertions were written against the already-passing Task 1 implementation plus a not-yet-mounted limiter, so per the plan's own house rule, non-vacuousness for Task 2's assertions was proven by targeted mutation rather than by a natural RED phase (see below).

## Files Created/Modified

- `mirror-request/src/security/rateLimiter.ts` — `createRateLimitState`, `checkRateLimit`, `pruneExpired`, `createStatusRateLimiter`, `RATE_LIMITED_STATUS`, `RATE_LIMITED_BODY`, `RateLimitOptions`, `RateLimitState` (Task 1, new file).
- `mirror-request/src/config.ts` / `mirror-request/src/types.ts` — the three `STATUS_RATE_LIMIT_*` keys (Task 1).
- `mirror-request/src/status/statusRoute.ts` — widened `StatusConfig`, the limiter built and mounted inside `createStatusRouter()` (Task 2).
- `mirror-request/test/status-rate-limit.test.ts` — 10 pure-function tests (Task 1) + 6 supertest integration tests (Task 2), 16 total.
- `mirror-request/test/status-api.test.ts` — deviation fix, see below (Task 2).

## Measured Numbers

- `cd mirror-request && npm test`: **34 files / 315 tests** green (baseline confirmed live at plan start: 33 files / 299 tests, matching `06-04-SUMMARY.md`'s stated baseline). +1 file, +16 tests. Full run performed twice (once after each task's mutation-check restoration), identical green result both times.
- `npm run typecheck` / `npm run build`: both exit 0, checked after each task.
- `git diff --quiet 9699374 -- src/ingestion/dbPoller.ts`: exits 0 (D-02, byte-identical — untouched).
- `git diff --name-only 9699374..HEAD -- src/queue src/agent src/display src/notifications src/ingestion`: empty (phase boundary held for this plan's own diff range).
- `git diff 9699374 -- package.json package-lock.json`: empty — no new dependency, no lockfile change.
- `git diff --quiet 9699374 -- src/index.ts`: exits 0 — `index.ts` needed no change, confirmed rather than assumed, since `index.ts:50` already passes the whole `config` object to `createStatusRouter`.

## Decisions Made

- **Threshold arithmetic (recorded here for 06-06's OPS-RUNBOOK §10 to quote):** default `STATUS_RATE_LIMIT_MAX=30` per `STATUS_RATE_LIMIT_WINDOW_MS=60000`ms. A guest polling their own status page every few seconds stays far under 30/minute. An attacker limited to 30 guesses/minute from one source address facing a 2^40-value space needs roughly 2^40 / 30 minutes (~24,500 years) for exhaustive coverage from a single address — the practical deterrent this plan's threat model calls for. Distributed enumeration across many source addresses remains an accepted residual (T-06-12, `06-03-PLAN.md`'s threat register) — closing it would require widening `ticket_code`, which needs an `ets_web` code change the human has forbidden absolutely.
- **Exact throttled response shape, quoted verbatim for 06-06:** HTTP `429`, body `{ "error": "too many requests" }` — exactly one key, no `reason`/`code`/`hint`/`retryAfter` field, no `Retry-After` header.
- **Eviction under capacity pressure evicts the oldest-`windowStart` survivors, not an arbitrary or LRU-by-access set** — closed windows are removed first (the cheap, always-correct pass); only if the map is still over `maxKeys` after that does the oldest-`windowStart` pass run. This favors clients that have been active most recently.
- **`pruneExpired` is called AFTER the per-request decision inside the middleware, not before** — this is what keeps the `size <= maxKeys` invariant true at the end of every single request rather than only "on average" or "eventually"; verified directly by the `maxKeys * 2`-key-rotation test asserting the bound after every push, not just at the end.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking correctness] `test/status-api.test.ts`'s four `createStatusRouter()` call sites needed the three new config keys**
- **Found during:** Task 2, immediately after widening `StatusConfig` to include the three `STATUS_RATE_LIMIT_*` keys.
- **Issue:** `StatusConfig` is now `Pick<EnvConfig, ...>` over six keys, but four object literals in `test/status-api.test.ts` (each a direct argument to `createStatusRouter(...)`) only supplied the original three `WAIT_ESTIMATE_*` keys. This did not fail `npm run typecheck` (tsconfig's `include` is `src/**/*` only — test files are never type-checked by `tsc` in this project, a pre-existing convention, not something introduced here) and did not fail `vitest run` either, since at runtime the three missing keys resolved to `undefined`, and `undefined` compared against any number in `checkRateLimit` is always `false` — an accidental no-op that happened to preserve prior behaviour, not a designed one.
- **Fix:** Added the three keys to all four call sites with a generous `STATUS_RATE_LIMIT_MAX: 1000`, so `status-api.test.ts` continues to exercise Phase 5's wait-estimate/404 behaviour rather than accidentally exercising (or silently bypassing) the limiter.
- **Files modified:** `mirror-request/test/status-api.test.ts`
- **Verification:** All 27 pre-existing tests in that file still pass, unchanged in behaviour; typecheck and build both still exit 0.
- **Committed in:** `65237a2` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 3 — a test fixture left out of sync with a type it claims to satisfy, invisible to `tsc` only because this project's tsconfig never type-checks `test/`, and invisible to the runtime suite only by an accidental `undefined`-comparison no-op).
**Impact on plan:** Fully contained within `test/status-api.test.ts`, which is not in this plan's declared `files_modified`, but the change is a pure type/fixture-completeness fix with zero behavioural effect on that file's own 27 tests — flagged here per the house rule that deviations get reported, not absorbed.

## Non-Vacuousness Proof (mutation)

Task 1's `checkRateLimit`/`pruneExpired` genuinely went RED before GREEN (the module did not exist). Per the house rule requiring proof for assertions that cannot go RED first, three targeted mutations were run and reverted before commit, `diff` confirmed clean after each revert:

1. **Off-by-one on the limit condition** (`count > opts.max` → `count >= opts.max`, both call sites): broke 2 of 10 pure-function tests (`allows requests 1..max ...`, `gives two distinct keys two fully independent budgets`).
2. **Off-by-one on the window-reset boundary** (`now - existing.windowStart >= opts.windowMs` → `> opts.windowMs`): broke 1 of 10 (`resets exactly at the window boundary`).
3. **Disabled the capacity-eviction pass in `pruneExpired`** (removed the second `if (state.entries.size > maxKeys)` block): broke 2 of 10 (`evicts oldest-windowStart entries first ...`, and the middleware's `maxKeys * 2`-key size-bound test).

Task 2's gate-ordering/non-distinguishability assertions were checked by mutating production code rather than the test:

4. **Removed the limiter from the route mount** (`router.get('/status/:jobId', rateLimiter, ...)` → `router.get('/status/:jobId', ...)`, i.e. simulating the exact bug D-10 exists to prevent): broke exactly 4 of the 6 supertest integration tests — the throttling test, the non-distinguishability test, the gate-ordering (call-count) test, and the no-cross-case-leakage test. All 4 failures were `429` becoming `200` or the call-count spy no longer being exercised, i.e. the tests failed for the reason they exist to catch, not for an unrelated reason.

All four mutations reverted; `git diff` after each revert showed no residual change before the corresponding commit.

## Issues Encountered

None beyond the one test-fixture deviation documented above, found and fixed within Task 2's own commit before it landed.

## User Setup Required

None — no external service configuration required. The three new config keys have safe defaults (60000ms / 30 / 10000) and no production fail-fast check, matching `VIEW_PROBE_INTERVAL_MS`'s precedent.

## Next Phase Readiness

- **For plan 06-06's OPS-RUNBOOK §10:** quote the threshold arithmetic and exact throttled response shape recorded in "Decisions Made" above verbatim, alongside the accepted residual (T-06-12, distributed enumeration across source addresses) — the plan's own threat register already records this as `disposition: accept`, and the successful-guess consequence to name is "another guest's name and queue position, not their photo."
- **WINDOWS.md item 6 closed.** `/gsd-ship`'s long-standing blocker on capability-URL entropy is resolved: D-10 answered the factual question (Phase 5) and this plan ships the mitigation (Phase 6). One WINDOWS.md item remains open (item 4, a pre-existing shared-test-DB coupling from Phase 1, unrelated to this plan).
- No blockers for 06-05 (the live DDL cutover) or 06-06 (docs).

## Self-Check: PASSED

All 6 created/modified files confirmed present on disk; both task commit hashes (`f73e20b`, `65237a2`) confirmed present in `git log --oneline --all`.

---
*Phase: 06-ingestion-cutover*
*Completed: 2026-08-11*
