---
phase: 05-client-api-display-feed
plan: 01
subsystem: guest-status-api
tags: [api, wait-estimate, guest-facing, tracer, D-01, D-02, D-03, D-04, D-05, D-11, D-12]
status: complete

requires:
  - "LocalStore.completeInProgressJob() as the sole writer of status='completed' (Phase 2)"
  - "LocalStore.getJobRegistration() as the only registration-joining read (Phase 1/3)"
  - "notification_record.status vocabulary (Phase 4)"
  - "QueueService.getQueuePosition/getQueueLength/getAnnouncement (Phase 2)"
  - "AgentServer.isAgentOnline() (Phase 3)"
provides:
  - "GET /status/:jobId returning the eight-key guest contract with a real wait range"
  - "LocalStore.getRecentSessionDurationsMs(limit)"
  - "estimateWaitMs()/medianMs() — pure, injectable estimator"
  - "GuestStatus/PhotoDelivery/GuestStatusResponse — D-11's closed vocabulary and the response type"
  - "createStatusRouter(store, queue, agent, cfg) — mountable, testable without booting the service"
  - "WAIT_ESTIMATE_SAMPLE_SIZE / WAIT_ESTIMATE_MIN_SAMPLES / WAIT_ESTIMATE_DEFAULT_MS"
affects:
  - "05-02 (suppression/404 cases build on createStatusRouter)"
  - "05-05 (OPS-RUNBOOK §3 config surface and §9 accepted-risk register)"

tech-stack:
  added: []
  patterns:
    - "createX(deps) => Router factory (mirrors createMirrorReceiver)"
    - "Structural guarantee in a SQL WHERE clause rather than a deletable if"
    - "Exhaustive Record over a status union instead of a switch with a default"
    - "Absent optional key rather than an explicit null (suppress-rather-than-lie)"

key-files:
  created:
    - mirror-request/src/status/estimateWaitMs.ts
    - mirror-request/src/status/guestStatus.ts
    - mirror-request/src/status/statusRoute.ts
    - mirror-request/test/status-api.test.ts
    - mirror-request/test/estimate-wait.test.ts
  modified:
    - mirror-request/src/types.ts
    - mirror-request/src/config.ts
    - mirror-request/src/state/localStore.ts
    - mirror-request/src/index.ts

decisions:
  - "D-07 resolved by human as not-confirmed-accept-risk (dev environment); the unguessability assumption behind D-06 remains UNVERIFIED and is recorded as a pre-production blocker."
  - "External-consumer question answered 'no' — the response shape is designed for the guest page only and is pinned by exact-key assertions."
  - "D-02's exclusion lives in the sample query's WHERE clause; no application-level stall or retry filter was added anywhere."
  - "boothPaused's TIMEOUT_RESET arm is currently unreachable because setBoothTimeout() writes 'IDLE' — written anyway, documented, not fixed (Phase 2 seam, out of bounds)."

metrics:
  duration: ~35 min
  completed: 2026-08-11
  tasks: 3
  commits: 3

actuals:
  tokens: 7966
  tasks: 3
  commits: 3
---

# Phase 5 Plan 01: Guest Status API Tracer Summary

`GET /status/:jobId` now returns a real whole-minute wait range computed from the median of
real completed-session durations (`completed_at - acknowledged_at`), alongside the guest's
actual registered name — a field that had been `null` on every response since the route
shipped.

## What Was Built

One vertical slice through every layer the phase touches, proven end to end on a single
guest path before any horizontal expansion:

| Layer | Artifact |
|---|---|
| Config | `WAIT_ESTIMATE_SAMPLE_SIZE` (20), `WAIT_ESTIMATE_MIN_SAMPLES` (5), `WAIT_ESTIMATE_DEFAULT_MS` (180000) |
| Storage | `LocalStore.getRecentSessionDurationsMs(limit)` |
| Domain | `estimateWaitMs.ts` (pure), `guestStatus.ts` (pure + one log seam) |
| Transport | `statusRoute.ts` → `createStatusRouter(store, queue, agent, cfg)` |
| Wiring | `index.ts` mounts the router; the inline route block is gone |
| Proof | `test/status-api.test.ts` (5 cases), `test/estimate-wait.test.ts` (12 cases) |

The response contract is exactly eight keys:
`boothPaused, guestName, jobId, photoDelivery, queueLength, queuePosition, status, waitEstimate`
— with `waitEstimate` **absent** (not null) whenever the booth cannot serve.

## Task 1 — D-07 Checkpoint Resolution

**Recorded verbatim, because the answer and the evidence point in different directions.**

**Chosen option: `not-confirmed-accept-risk`.**

**Human decision, verbatim:** *"Đây là môi trường dev nên bạn cứ làm"* — this is a dev
environment, proceed. This is explicit authorization to implement D-06 as designed. The
executor did not self-approve, infer, or hedge this.

**Answer to the second question (external consumers of the `/status` response shape): NO.**
No consumer outside this repository is known to read `queuePosition`, `queueLength`,
`boothState`, `agentOnline` or `guestName`. The response was therefore designed for the
guest-facing page only, and its shape is pinned by the exact-key assertions this plan adds.
Replacing `boothState`/`agentOnline` with `boothPaused` proceeded on that basis.

**Evidence — independently re-measured by the executor, not taken on trust:**

| Check | Command result |
|---|---|
| Registration ids in the production store | 6 rows: `clean-test-20260806-154309`, `job-webhook-001`, `registration-20260806-0001`, `registration-20260806-0002`, `registration-20260806-02331`, `registration-20260806-04431` |
| Backend-minted ids among them | **0** — every one is a hand-typed smoke-test payload, and `-0001`/`-0002` are trivially enumerable |
| `queue_job` rows in production | 1 (status `completed`, both timestamps non-NULL) |
| `randomUUID` call sites in `src/` | **0** |
| Where the jobId comes from | `src/ingestion/mirrorReceiver.ts:112,130` and `src/ingestion/dbPoller.ts:126` take `id` verbatim from the inbound payload |

The 2325 UUIDv4-shaped ids in `data/test-extension-service.sqlite` are this repository's own
`crypto.randomUUID()` **test fixtures**. They demonstrate the properties of the test suite's
generator, not the backend's, and are not evidence about `registrations.id`.

### The honest posture this leaves behind

> **The unguessability assumption behind D-06 is UNVERIFIED and is a pre-production blocker.**
> Before `/status/:jobId` is exposed outside dev, the backend's id-minting scheme must be
> confirmed CSPRNG-based (≥128 bits). A human can settle it with one read-only
> `SELECT id FROM registrations ORDER BY <pk> DESC LIMIT 20` over the existing read-only
> `DB_POLL` credentials — sequential or timestamp-shaped ids are obvious at a glance.
> **Never write to that database.**
>
> If the scheme turns out to be sequential or date-based, **D-06 is unsound** and the design
> needs a separate server-minted status token (option `not-confirmed-mint-own`), which is a
> new plan: a new column, a new lookup path, and a new value that must reach the guest's QR
> code — generated outside this service.
>
> This carries the same posture the project already uses for `NOTIFY_WEBHOOK_URL`
> reachability and the undeployed Phase 3 Agent-auth cutover: explicitly not verified, with
> a stated reason, as the operator's pre-deploy step. **It is never to be silently closed.**
> Plan 05-05 must write it into `OPS-RUNBOOK.md` §9 beside the other two accepted risks.

Exposure if the assumption fails is bounded but real: no email, phone or `qr_token` appears
in the response, so the worst case is an enumeration oracle over other guests' queue
position, status word and booth-paused flag.

## Task 2 — The Tracer (TDD)

**RED** (`1cbfdf0`): `test/status-api.test.ts` written first, failing on the missing module.
**GREEN** (`cf56eae`): implementation; 5/5 green.

### The wait-estimate arithmetic, written out

Fixture: 5 completed sessions of exactly 240000 ms each; the guest is queued at position 1;
the booth is `BUSY`.

```
guestsAhead = (queuePosition - 1) + (booth BUSY or ANNOUNCING ? 1 : 0)
            = (1 - 1) + 1
            = 1
median      = 240000 ms        (5 samples, and 5 is NOT < minSamples 5)
pointMs     = 240000 * 1 = 240000
240000 / 60000 = 4.0 exactly
highMinutes = Math.ceil(4.0)  = 4      <- NOT 5; an exact whole minute is not pushed up
lowMinutes  = 4 - 1           = 3
waitEstimate = { lowMinutes: 3, highMinutes: 4 }
```

The `+1` covers the session currently running: that guest is not in the queued set that
`getQueuePosition()`/`getQueueLength()` count, so omitting it would drop the one session the
waiting guest is most certainly waiting on.

### The always-null `guestName` bug is fixed

`src/index.ts:47` read `job.registration?.name` off the bare `SELECT * FROM queue_job` row
returned by `getJob()`. That row has no `registration` property at runtime, though TypeScript
believed it was a required `Registration` — so the field was `null` on every real response
since the route shipped. The router now reads through `store.getJobRegistration(jobId)`, the
only method that performs the join. Proven by assertion (`guestName === 'Nguyễn Văn A'`), not
by inspection.

### D-02 expressed structurally

`getRecentSessionDurationsMs()` restricts to `WHERE status = 'completed'`. That restriction
**is** the exclusion, not one filter among several: `completeInProgressJob()` is the sole
writer of `'completed'` and only ever fires against a row that is currently `in_progress`, so
a stalled, requeued or failed job cannot structurally reach the sample. No application-level
stall or retry filter exists anywhere to be deleted by a later edit. Same
omission-as-guarantee pattern as `localStore.ts:435` (Phase 4) and `requeueWithRetry` (Phase 2).

`session_started_at` was left strictly alone — still exactly **3** occurrences in `src/`
(`types.ts:21` type field, `localStore.ts:41` schema column, `localStore.ts:189` column-name
whitelist), measured, none an assignment.

## Task 3 — Estimator Boundaries (`b7bc731`)

12 cases, test-only (`git show --name-only --format= b7bc731` lists only
`test/estimate-wait.test.ts`). **Every expected value in the plan matched the implementation
when recomputed by hand — no expectation needed correcting.**

| Case | Arithmetic | Result |
|---|---|---|
| Empty sample | — | `null` |
| Odd length, unsorted input | `[300000,100000,200000]` → sorted middle | `200000` |
| Even length | `(200000 + 300000) / 2` | `250000` |
| Non-mutation | caller array unchanged after `medianMs` | pass |
| Outlier (D-02's reason) | median vs mean of `744000` | `180000` |
| Cold start, 4 samples | `4 < 5` → default `180000`; `ceil(180000/60000)=3` | `{2, 3}` |
| Cold start, exactly 5 | `5 < 5` false → median `600000`; `ceil(10)=10` | `{9, 10}` |
| Exact whole minute | `240000/60000 = 4.0`; `ceil = 4` | `{3, 4}` |
| Fraction | `252000/60000 = 4.2`; `ceil = 5` | `{4, 5}` |
| Multiple ahead | `180000 × 3 = 540000`; `ceil(9) = 9` | `{8, 9}` |
| Floor, median path | `600000 × 0 = 0`; `ceil(0)=0` → floored | `{0, 1}` |
| Floor, cold-start path | same, 4 samples | `{0, 1}` |

The cold-start boundary is proven on **both** sides: the comparison is `<`, not `<=` — at
exactly `minSamples` the computed median wins. This is precisely the off-by-one class the
project has already paid for.

## Verification — Measured, Not Asserted

| Check | Result |
|---|---|
| `npx vitest run test/status-api.test.ts` | 1 file / **5 tests** green |
| `npx vitest run test/estimate-wait.test.ts` | 1 file / **12 tests** green |
| `npm test` run 1 | **29 files / 199 tests** green |
| `npm test` run 2 (back-to-back) | **29 files / 199 tests** green — **identical** |
| Baseline | 27 files / 182 tests → +2 files / +17 tests |
| `npm run typecheck` | exit **0** |
| `npm run build` | exit **0** |
| `git diff --name-only 419763f..HEAD` | **9 files**, matching `files_modified` exactly |
| Deletions in the diff | **none** |
| `git diff 419763f..HEAD -- src/queue/ src/agent/ src/notifications/ src/display/` | **empty** — phase boundary held |
| `session_started_at` non-comment occurrences in `src/` | **3**, all non-writes |
| `mirror-request/.planning/` (stale tree) | **untouched**, confirmed by `git status --short -- .planning/` |
| New npm packages | **0** |

The two back-to-back full-suite runs were identical, so ledger item 4's parallel-worker race
did not manifest here. The new test files do not contribute to it: both construct their own
store (or none at all) and never call the `getStore()` singleton.

## Deviations from Plan

**1. [Rule 2 — missing critical proof] Added a direct duration-sample assertion to `status-api.test.ts`**
- **Found during:** Task 2, while checking that the must-have truth "a session that stalled,
  was requeued, or failed can never enter the duration sample" was actually *proven* rather
  than merely implemented.
- **Issue:** The plan's `<behavior>` for `status-api.test.ts` seeded one `in_progress` job but
  asserted only on the final `waitEstimate`. An `in_progress` row has a NULL `completed_at`,
  so it would be filtered by the NULL guard even if the `status='completed'` restriction were
  loosened — meaning the D-02 truth would have been implemented but never observed.
- **Fix:** Seeded an additional `failed` job (acknowledged, then `failJob()`) and added a case
  asserting `store.getRecentSessionDurationsMs(20)` returns exactly
  `[240000, 240000, 240000, 240000, 240000]` — length **5**, measured. If the WHERE clause
  ever loosens, this count changes before any estimate does.
- **Files modified:** `mirror-request/test/status-api.test.ts`
- **Commit:** `1cbfdf0` (RED), proven green in `cf56eae`

**2. [Documented, not fixed] `boothPaused`'s `TIMEOUT_RESET` arm is currently unreachable**
- **Found during:** Task 2, reading `localStore.ts:320-323` to confirm the reset value.
- **Issue:** `BoothState` declares `'TIMEOUT_RESET'`, but `setBoothTimeout()` writes
  `'IDLE'` — so `getBoothState()` never returns `'TIMEOUT_RESET'` in practice. This is real
  code, not a comment (verified by opening the file, per the grep-false-positive discipline).
  `OPS-RUNBOOK.md` §5 already records this value as dead by design (Phase 2, plan 02-03).
- **Decision:** Implemented the arm exactly as the plan specifies and documented its
  unreachability in a comment above it. **Not fixed** — changing `setBoothTimeout()` alters
  Phase 2's booth state machine, which `<phase_boundary>` puts explicitly out of scope, and
  `boothState` is also read by the display feed. The arm becomes correct for free if Phase 2
  ever persists the state its own type already declares.
- **Practical effect:** `boothPaused` is today driven entirely by `!agent.isAgentOnline()`.
  D-05's agent-offline suppression works; its TIMEOUT_RESET half is latent.

**3. [Test-fixture choice] Test DB lives directly under `./data/`, not in a `mkdtemp` subdirectory**
- The plan asked for "a unique path under `./data/`". A `mkdtemp` subdirectory would **not**
  be gitignored — `.gitignore`'s `data/*.sqlite` glob does not cross a directory separator.
  Used `./data/test-status-api-${pid}-${Date.now()}.sqlite` instead, which is unique, matches
  the ignore rule, and is removed (with its `-wal`/`-shm` siblings) in `afterAll`.

**4. [Test-fixture strengthening] Used a real `QueueService` rather than a hand-written fake**
- `QueueService`'s constructor already accepts an injected store and timing config (Phase 2
  pattern), so the test drives the real `getQueuePosition`/`getQueueLength`/`getAnnouncement`
  over the ephemeral store and never calls `.start()` — no timers, no dispatch, no Agent. Only
  `isAgentOnline` is stubbed, since `AgentServer` needs a real WebSocket server. This makes
  the tracer prove the actual Phase 2 read path rather than a mock of it.

## Known Stubs

None. No placeholder values, no hardcoded empty returns, no TODO/FIXME introduced.

The one *latent* branch — `boothPaused`'s `TIMEOUT_RESET` arm — is deliberate, documented in
code, and recorded above as deviation 2; it is a Phase 2 seam, not a stub in this plan's work.

## Threat Flags

None. No new network endpoint, auth path, file access pattern, or schema change at a trust
boundary beyond what the plan's `<threat_model>` already registers. `T-05-01`'s single
generic 404 was carried forward byte-identical; no new failure shape was added.

`T-05-06` remains **mitigate/open** — see the D-07 posture above. It is answered by a human
for dev, and is explicitly *not* closed for production.

## Cold-Start Note for Production

The production database holds exactly **1** usable completed session (measured:
`status='completed'` with both `acknowledged_at` and `completed_at` non-NULL). With
`WAIT_ESTIMATE_MIN_SAMPLES` at 5, `1 < 5`, so **the configured 180000 ms default is what
production will actually serve on day one** — a flat "2–3 phút" until the fifth real session
completes. This is D-04 working exactly as designed, not a bug.

## Carry-Forward State for Phase 5

1. **D-07 / D-06 unguessability: UNVERIFIED, pre-production blocker.** Full statement above.
   Plan 05-05 must land it in `OPS-RUNBOOK.md` §9 beside `NOTIFY_WEBHOOK_URL` reachability and
   the undeployed Agent-auth cutover. Never silently closed.
2. **Three new config keys** need `OPS-RUNBOOK.md` §3 entries (plan 05-05):
   `WAIT_ESTIMATE_SAMPLE_SIZE`, `WAIT_ESTIMATE_MIN_SAMPLES`, `WAIT_ESTIMATE_DEFAULT_MS`.
   Per the standing constraint, their production values cannot be verified from this sandbox
   (`.env*` access is denied) — operator's pre-deploy step.
3. **`boothState`/`agentOnline` are gone from the response**, replaced by `boothPaused`. The
   phase-gate question about whether this preserves M3 success criterion 5 is still open and
   still belongs to a human at the 05-05 gate. Task 1's second answer (no known external
   consumer) is an input to that decision, not a substitute for it.
4. **`createStatusRouter` is the extension point** for 05-02's suppression and 404 cases — the
   route is constructible against an ephemeral store with no service boot.

## Self-Check: PASSED

All created files verified present on disk:
`src/status/estimateWaitMs.ts`, `src/status/guestStatus.ts`, `src/status/statusRoute.ts`,
`test/status-api.test.ts`, `test/estimate-wait.test.ts` — all FOUND.

All commit hashes verified in `git log`:
`1cbfdf0`, `cf56eae`, `b7bc731` — all FOUND.

Stale planning trees (`mirror-request/.planning/`, `dslrbooth-agent/.planning/`) confirmed
neither read nor written; `git status --short -- .planning/` inside `mirror-request/` returned
empty at every checkpoint.
