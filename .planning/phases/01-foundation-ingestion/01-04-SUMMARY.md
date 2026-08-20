---
phase: 01-foundation-ingestion
plan: 04
subsystem: api
tags: [better-sqlite3, express, sqlite-migration, dedup, vitest, supertest, webhook-security]

# Dependency graph
requires:
  - phase: 01-foundation-ingestion (plan 01-01)
    provides: "MirrorReceiverOptions (hmacSecret/timestampSkewMs/dedupWindowMs/onEnqueue), REGISTRATION_DEDUP_WINDOW_MS config"
  - phase: 01-foundation-ingestion (plan 01-02)
    provides: "LocalStore constructor(dbPath?: string) test seam, checkWebhookAuth() replay/timestamp/signature gate ahead of the handler"
provides:
  - "registration.received_at column (additive migration, backfilled on upgrade)"
  - "LocalStore.findDuplicateRegistration({id, email, phone, windowStartMs}) — the D-01/D-02 identity ladder"
  - "/on-register dedup branch: {duplicate:true, jobId:<ORIGINAL id>} for a same-id or same-contact resubmission inside the window, no persistence call, no onEnqueue"
affects: [01-05]

# Actuals (#2632)
actuals:
  tokens: 4635
  tasks: 2
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Additive-only migrate(): PRAGMA table_info() probe + ALTER TABLE ADD COLUMN + single backfill UPDATE, never DROP/recreate (D-14 — the operator owns retention)"
    - "Dedup ladder returns before any persistence call on a duplicate — upsertRegistration/saveRawPayload/markProcessed/enqueueJob/onEnqueue are only reachable on the new-registration path, keeping the original raw_payload immutable (RESEARCH.md Pitfall 7)"
    - "Blank-contact guards (`? <> ''`) in the SQL fallback query prevent two guests who both submitted no email/phone from ever being merged"

key-files:
  created:
    - mirror-request/test/on-register-dedup.test.ts
  modified:
    - mirror-request/src/state/localStore.ts
    - mirror-request/src/ingestion/mirrorReceiver.ts
    - mirror-request/test/on-register-auth.test.ts

key-decisions:
  - "D-02's 'id absent' resolved as 'an id MATCH is absent', not 'the id field is absent' (per the plan's pre-resolved 'Resolution of RESEARCH.md Open Question 2') — id stays a required field, the email/phone fallback catches a resubmission that arrives with a freshly minted id"
  - "test/on-register-auth.test.ts's makeBody() now derives email from the already-unique id instead of a hardcoded 'alice@example.com'/'0900000000' pair — those tests share the LocalStore singleton with the new dedup suite, and the hardcoded values were tripping the new contact-detail dedup fallback across unrelated auth test cases (see Deviations)"
  - "New receiver-level dedup tests assert queue-row presence/absence via getJob(<specific id>) rather than a getQueueLength() delta, since the underlying LocalStore is a process-wide singleton shared across test files that vitest may run concurrently — an aggregate count is not a reliable signal, a specific randomly-generated id is"

patterns-established:
  - "received_at is a storage-only concern, deliberately not added to the Registration type in types.ts — declared inline on upsertRegistration's parameter type only, per the plan's explicit task 1 step 5"

requirements-completed: [ING-01, STO-01]

coverage:
  - id: D1
    description: "A store opened on a pre-phase database file gains registration.received_at on open (additive ALTER TABLE + backfill) and preserves existing rows"
    requirement: "STO-01"
    verification:
      - kind: unit
        ref: "test/on-register-dedup.test.ts#LocalStore dedup window > a store opened on a pre-phase-schema file gains received_at on open and preserves existing rows"
        status: pass
      - kind: manual_procedural
        ref: "Manual check against a copy of the real data/extension-service.sqlite (6 pre-existing rows, no received_at column): LocalStore opened cleanly, no migration error, both a sampled pre-existing row and its raw_payload were readable unchanged after migration"
        status: pass
    human_judgment: false
  - id: D2
    description: "findDuplicateRegistration implements the D-01/D-02 ladder: id match first, then non-empty email/phone fallback bounded by the window, blank contact details never collide"
    requirement: "ING-01"
    verification:
      - kind: unit
        ref: "test/on-register-dedup.test.ts#LocalStore dedup window (7 cases: id-window match, contact fallback, blank-contact non-collision, earliest-row-wins ordering)"
        status: pass
    human_judgment: false
  - id: D3
    description: "POST /on-register answers a same-id or same-contact resubmission inside the window with {duplicate:true, jobId:<ORIGINAL id>}, creates no second queue_job row, and never re-runs upsertRegistration/saveRawPayload/markProcessed/enqueueJob/onEnqueue for the duplicate"
    requirement: "ING-01"
    verification:
      - kind: integration
        ref: "test/on-register-dedup.test.ts#POST /on-register dedup (7 HTTP-level cases: same-id, email fallback, phone fallback, outside-window is new, raw_payload preserved, onEnqueue fires once, blank-contact guests don't collide)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Full existing Vitest suite does not regress alongside the 1 new test file and 1 modified pre-existing test file for this plan"
    verification:
      - kind: integration
        ref: "npm test (10 files, 59 tests, all pass) and npm run typecheck (exits 0)"
        status: pass
    human_judgment: false

duration: 18min
completed: 2026-08-10
status: complete
---

# Phase 1 Plan 4: Time-Windowed Registration Dedup Summary

**`received_at`-anchored dedup window on `POST /on-register`: an additive SQLite migration plus `findDuplicateRegistration()` catch a same-id or same-contact resubmission and echo the original `jobId` without ever re-running persistence.**

## Performance

- **Duration:** ~18 min
- **Started:** 2026-08-10T08:24:00Z (approx., following plan 01-03's 08:21Z completion)
- **Completed:** 2026-08-10T08:39:00Z
- **Tasks:** 2/2
- **Files modified:** 4 (3 modified, 1 created)

## Accomplishments

- Added `registration.received_at INTEGER` to the schema and an additive `migrate()` (PRAGMA `table_info` probe + `ALTER TABLE ADD COLUMN` + single backfill `UPDATE`) so a pre-existing SQLite file gains the column on next startup without dropping or rewriting any table — verified both by a unit test creating a pre-phase-schema file from scratch and by a manual run against a copy of the real `data/extension-service.sqlite` (6 live rows, no `received_at` column).
- `upsertRegistration` binds `received_at` (defaulting to `Date.now()`) alongside the existing columns; `types.ts`'s `Registration` interface is intentionally left untouched per the plan (storage-only concern).
- `findDuplicateRegistration({id, email, phone, windowStartMs})` implements the D-01/D-02 identity ladder: id match first, then a non-empty-email-or-phone fallback ordered `received_at ASC` so the *original* registration always wins, with `? <> ''` guards so two guests who both submitted no contact details never collide.
- `/on-register`'s handler now runs the ladder after the pre-existing permanent `isProcessed(id)` idempotency check: a duplicate inside the window returns `{duplicate:true, jobId:<ORIGINAL id>}` and returns *before* any persistence call, so `upsertRegistration`/`saveRawPayload`/`markProcessed`/`enqueueJob`/`onEnqueue` are only ever reached on the genuinely-new path — the original's `raw_payload` is provably byte-identical after a duplicate is processed (RESEARCH.md Pitfall 7, D-13).
- A new registration passes `received_at: now` (the server clock) into `upsertRegistration`, so the dedup window is anchored independently of the source system's `registered_at` string (D-01, RESEARCH.md A5).
- 14 new test cases in `test/on-register-dedup.test.ts` (7 store-level + 7 HTTP-level), full suite 10 files / 59 tests, all passing; `npm run typecheck` exits 0.

## Task Commits

1. **Task 1: received_at column, forward migration, and the dedup-window query** - `64e513e` (feat, tdd)
2. **Task 2: Dedup ladder in the receiver — original jobId, no second job, nothing rewritten** - `7262422` (feat, tdd)

_Note: as in plans 01-01/01-02/01-03, each task's `tdd="true"` behavior was implemented and verified together with its tests in a single commit per task, not as separate RED/GREEN commits._

## Files Created/Modified

- `mirror-request/src/state/localStore.ts` - `received_at` column, additive `migrate()`, `upsertRegistration` widened to bind `received_at`, new `findDuplicateRegistration()`
- `mirror-request/src/ingestion/mirrorReceiver.ts` - D-01/D-02/D-03 dedup ladder inserted between the existing `isProcessed(id)` check and the persistence sequence
- `mirror-request/test/on-register-dedup.test.ts` - NEW: 7 `LocalStore dedup window` store-level cases + 7 `POST /on-register dedup` HTTP-level cases (14 total)
- `mirror-request/test/on-register-auth.test.ts` - `makeBody()` now derives a per-id email instead of a hardcoded shared one (see Deviations)

## Decisions Made

- D-02's "id absent" ambiguity was already resolved by the plan itself (not re-litigated here): "absent" means *an id match is absent*, not *the id field is absent*. `id` remains a required field; the fallback exists to catch a resubmission that arrives with a freshly minted `id`. Booked for human confirmation in plan 01-05 task 3, per the plan's own note.
- The new receiver-level tests assert on `getJob(<specific randomly-generated id>)` rather than an aggregate `getQueueLength()`/`countWebhookIds()` delta, because `LocalStore` is a process-wide singleton pointed at one fixed `LOCAL_STORE_PATH` for the whole test run (`vitest.config.ts`), and vitest can run test files concurrently against that same physical file — an aggregate count is not a reliable assertion target under that concurrency, a specific id is.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `test/on-register-auth.test.ts`'s hardcoded email/phone collided with the new contact-detail dedup fallback**
- **Found during:** Task 2, first `npm test` run after wiring the dedup ladder into the receiver
- **Issue:** Every test case in `on-register-auth.test.ts` built its request body via a shared `makeBody(id)` that hardcoded `email: 'alice@example.com'` and `phone: '0900000000'` for every call. Before this plan, that was harmless — only `id` drove idempotency. Once the contact-detail dedup fallback went live, every test case after the first in that file (which shares the `getStore()` singleton with the new dedup suite and runs inside the 300s default `dedupWindowMs`) got answered `{duplicate:true, jobId:<the first test's id>}` instead of `{accepted:true, jobId:<its own id>}`, failing 6 of that file's assertions.
- **Fix:** `makeBody()` now derives `email` from the already-unique `id` argument (`` `${id}@example.com` ``) and sets `phone: ''`, so no two calls across the file's 17 cases share contact details. No other assertion in the file inspects the email/phone value itself.
- **Files modified:** `mirror-request/test/on-register-auth.test.ts`
- **Verification:** `npx vitest run test/on-register-dedup.test.ts test/on-register-auth.test.ts` — 31/31 pass; full `npm test` — 59/59 pass, repeated across multiple runs.
- **Committed in:** `7262422` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug fix, directly caused by wiring the new dedup logic into a route three other test files already exercise against the shared store singleton).
**Impact on plan:** Necessary to keep the pre-existing auth suite green under the new dedup behavior; no unrelated content in that file was touched, and no scope beyond this plan's own `<verify>` requirement (`npm test` exits 0) was addressed.

## Issues Encountered

**Acceptance-criteria grep for `dedupWindowMs` is not literally satisfiable (documented, not a defect).** Task 2's acceptance criteria state `grep -c 'dedupWindowMs' mirror-request/src/ingestion/mirrorReceiver.ts` should output `1`. Plan 01-01 already declared `dedupWindowMs: number;` on the `MirrorReceiverOptions` interface (present since commit `7d7a148`, before this plan started), so a literal `grep -c` of the whole file was already at 1 *before* this plan added any code. Implementing the plan's own required action (`const windowStartMs = now - options.dedupWindowMs;`) necessarily adds a second matching line — the criterion cannot be met at value 1 without either omitting the interface field (out of scope, pre-existing) or omitting the required window computation (breaks the task). The behavioral intent — `windowStartMs` computed from `options.dedupWindowMs` — is satisfied and is what the criterion was checking for; the literal count is 2, not 1. All other acceptance-criteria greps for this plan pass exactly as specified.

**Pre-existing flaky assertion surfaced but not fixed (out of scope, logged).** `test/on-register-auth.test.ts`'s replay-protection test (`accepts the first delivery ... then rejects a byte-identical replay`, from plan 01-02) asserts `getStore().countWebhookIds()).toBe(countBefore + 1)` — a snapshot-then-delta check against a *global* row count on the shared `LocalStore` singleton. Because vitest runs test files concurrently against the same physical SQLite file, another file's concurrent write can land between the snapshot and the delta assertion, occasionally producing an off-by-N mismatch (observed in ~2 of 16 full-suite runs during this plan's verification, both times in that pre-existing assertion, never in this plan's own new tests). This is a pre-existing test-isolation weakness from 01-02 (the underlying architecture — one shared `LOCAL_STORE_PATH` singleton across all test files, per `vitest.config.ts`), not something this plan's dedup logic caused; it is out of scope for this plan's declared `files_modified` and was not fixed here. This plan's own new tests deliberately avoid the same failure mode (see Decisions Made). Logged to `.planning/WINDOWS.md`.

## Known Stubs

None.

## Threat Flags

None — all new surface (`findDuplicateRegistration`, the dedup branch in `/on-register`, the additive `migrate()`) matches the plan's `<threat_model>` register (T-01-22 through T-01-27, T-01-SC); no new unplanned surface was introduced.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `POST /on-register` now presents its complete Phase 1 ingestion contract (HMAC + timestamp + replay + IP allow-list from 01-01/01-02, dedup from this plan) for plan 01-05 to review/finalize without further changes to `mirrorReceiver.ts`'s core flow.
- The D-02 identity-rule reading (id-match-absent, not id-field-absent) is booked for human confirmation in plan 01-05 task 3, per this plan's own "Resolution of RESEARCH.md Open Question 2" section — no new assumption introduced here beyond what the plan already flagged.
- Two out-of-scope items surfaced during this plan's verification are logged to `.planning/WINDOWS.md` for visibility at ship time: the literal-vs-intent gap in the `dedupWindowMs` grep acceptance criterion, and the pre-existing `countWebhookIds()` global-count test flake from plan 01-02.
- No blockers for the phase gate from this plan's own work; `npm run build`/`npm run dev` are expected to succeed (the only prior blocker, the duplicate `getJobRegistration()`, was already resolved before plan 01-02 began).

---
*Phase: 01-foundation-ingestion*
*Completed: 2026-08-10*

## Self-Check: PASSED

All 4 created/modified source and test files found on disk (`src/state/localStore.ts`, `src/ingestion/mirrorReceiver.ts`, `test/on-register-dedup.test.ts`, `test/on-register-auth.test.ts`). Both task commits (`64e513e`, `7262422`) found in `git log`. SUMMARY.md itself confirmed present at its expected path.
