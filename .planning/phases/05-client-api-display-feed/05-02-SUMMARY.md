---
phase: 05-client-api-display-feed
plan: 02
subsystem: guest-status-api
tags: [api, vocabulary, closed-set, D-05, D-08, D-11, D-12]
status: complete

requires:
  - "createStatusRouter(store, queue, agent, cfg) (05-01)"
  - "GuestStatus/PhotoDelivery/GuestStatusResponse — D-11's closed vocabulary (05-01, extended here)"
  - "LocalStore.getJob() as the only miss-detecting read (Phase 1/2)"
provides:
  - "KNOWN_JOB_STATUSES / PHOTO_DELIVERY_STATES — exported readonly arrays that are the single source both the mapping Record and the vocabulary test are keyed by/iterate"
  - "toGuestStatus() proven exhaustive over the real 30-combination cross-product, with a loud logger.error on any unmapped state"
  - "genericNotFound() — the one producer of the D-08 404 shape, reached by the miss path and by an unexpected-throw catch-all alike"
  - "Structural D-05 suppression: waitEstimate present only via a conditional spread when status is 'waiting' and boothPaused is false"
affects:
  - "05-05 (OPS-RUNBOOK §9 accepted-risk register; the TIMEOUT_RESET-unreachable note carries forward from 05-01 and is restated here)"

tech-stack:
  added: []
  patterns:
    - "Union type derived from an exported array (typeof ARRAY[number]) so the array a test iterates and the type a Record is keyed by are one single source — adding a member without a mapping is a compile error, not a silent default"
    - "Single 404-shape producer function reached from both the miss path and a catch-all, so an unexpected throw cannot become a differentiating 500"
    - "Conditional object spread for an optional key, replacing an assignment of undefined or a post-hoc delete — absence becomes a property of the code, not of the serialiser"

key-files:
  created:
    - mirror-request/test/status-vocabulary.test.ts
  modified:
    - mirror-request/src/status/guestStatus.ts
    - mirror-request/src/status/statusRoute.ts
    - mirror-request/test/status-api.test.ts

decisions:
  - "D-06 + D-08 read together: a valid id belonging to another guest returns 200, not 404 — D-08 forbids distinguishing failure cases from one another, it does not turn a valid capability URL into a failure."
  - "D-05's reset-state suppression trigger (booth persisted in TIMEOUT_RESET) is implemented and pinned by its own test case, but is currently unreachable in production because Phase 2's setBoothTimeout() writes 'IDLE' — carried forward from 05-01, not fixed here (Phase 2 seam, out of bounds)."
  - "No format validation, length cap, or regex guard was added to :jobId — better-sqlite3 binds the parameter so there is no injection surface, and a pre-lookup rejection would be a second oracle on top of the one D-08 closes."

metrics:
  duration: ~8 min
  completed: 2026-08-11
  tasks: 3
  commits: 6

actuals:
  tokens: 10223
  tasks: 3
  commits: 6
---

# Phase 5 Plan 02: Guest Vocabulary, Generic 404, and Estimate Suppression Summary

**Close-out note:** this SUMMARY was written in a follow-up session after the plan's five —
actually six — commits had already landed and the working tree was clean. No source or test
file was touched in this session; the work below documents and independently re-verifies what
was already committed, per the close-out objective.

D-11's guest vocabulary is now proven exhaustive by iterating the implementation's own arrays
rather than a hand-typed copy, every way of missing a `/status/:jobId` lookup collapses into
one byte-identical 404, and the wait estimate is now suppressed by construction — the key is
genuinely absent, not `null` — whenever the booth cannot serve.

## What Was Built

| Layer | Artifact | Commits |
|---|---|---|
| Task 1 — closed vocabulary | `KNOWN_JOB_STATUSES`, `PHOTO_DELIVERY_STATES` exported arrays; `InternalJobStatus`/`PhotoDelivery` derived from them; `test/status-vocabulary.test.ts` (15 tests, 30-combination cross-product) | `eb252a6` (RED), `42d490e` (GREEN) |
| Task 2 — one generic 404 | `genericNotFound()` as the sole 404 producer; try/catch collapsing an unexpected throw into the same shape; 6 malformed-id shapes + purged/never-existed/foreign cases in `status-api.test.ts` | `abaf034` (RED), `d00c530` (GREEN) |
| Task 3 — structural suppression | Single `canServe` decision; conditional spread of `waitEstimate`; `computeEstimate()` extracted, reached only on the serve branch; 8 new suppression cases in `status-api.test.ts` | `d1ed0b9` (RED), `4f89b11` (REFACTOR) |

## Task 1 — The vocabulary is exhaustive by iteration, not by inspection

`guestStatus.ts` exports `KNOWN_JOB_STATUSES` (5 values) and `PHOTO_DELIVERY_STATES` (3 values)
as `readonly` arrays; `InternalJobStatus` and `PhotoDelivery` are derived from them via
`typeof ARRAY[number]`, and `STATUS_MAP` is a `Record<InternalJobStatus, ...>` rather than a
`switch` with a `default`. Re-verified: adding a sixth member to `KNOWN_JOB_STATUSES` without
extending `STATUS_MAP` is a `Record` type error at compile time (TS2741), not a silent
fallthrough — confirmed by reading the type definitions, not by trusting the commit message.

`test/status-vocabulary.test.ts` builds the cross-product by iterating the exported arrays
(never copying their contents), asserting the count is `5 × 3 × 2 = 30` two ways — against the
literal `30` and against the product of the arrays' own `.length`s — so a future narrowing of
either array cannot silently shrink coverage. Every one of the 30 combinations is checked
against a literal expected-word table, `failed` resolves to `see_staff` on all six of its rows
(both `announced` values × all three photo states), and `GUEST_STATUSES.length === 6` pins the
vocabulary closed. An unmapped status (`'stalled'`, and separately `''`) returns `see_staff`
**and** produces exactly one `logger.error` naming the offending value, spied with `vi.spyOn`
following `test/logging-mask.test.ts`'s shape; a separate case asserts the spy is never called
across all 30 mapped combinations, so the loud path cannot itself become noise.

**Independently re-measured:** `npx vitest run test/status-vocabulary.test.ts` — **15 tests
passed**. `git show --name-only --format= eb252a6` lists only `test/status-vocabulary.test.ts`;
`git show --name-only --format= 42d490e` lists only `src/status/guestStatus.ts`. Together the
two Task 1 commits touch exactly the two files the plan named — nothing else.

## Task 2 — One indistinguishable 404, and a valid foreign id still works

`genericNotFound()` is the single function that produces the `{ error: 'job not found' }`
shape; both the "job not found in store" branch and a `try/catch` wrapping the entire handler
body call it, so an unexpected throw during lookup cannot surface as Express's default 500 —
which would have re-opened the exact enumeration oracle D-08 closes, by accident, through a
code path nobody meant to be security-relevant. No format validation, length cap, or regex
guard was added to `:jobId`: `better-sqlite3` binds the route parameter, so there is no
injection surface, and rejecting a badly *shaped* id before the lookup would itself be a second
oracle stacked on the one D-08 already closes.

`test/status-api.test.ts` extends its D-08 `describe` block with:
- `expectGenericNotFound(res)` — the one helper every 404 case in the file routes through,
  asserting `status === 404`, `Object.keys(body)` deep-equals `['error']`, and the exact literal
  body. Re-verified: `grep -c "expectGenericNotFound(" test/status-api.test.ts` after excluding
  the function's own declaration line shows every 404-asserting `it`/`it.each` case calls it.
- Never-existed vs. genuinely-purged (deleted over a second connection to the same ephemeral
  file, with the deletion verified before the assertion) compared to each other with `toEqual`
  on both status and body — not merely each independently asserted 404.
- **Six** distinct malformed-id shapes: path traversal, a SQL-ish payload, a 1000-character id,
  a percent-encoded slash, a single space, and a percent-encoded null byte — exceeding the
  plan's minimum of 4. Each answers identically to the well-formed-but-absent case.
- **A valid id belonging to another guest returns 200**, not 404, with the full eight-key body.
  This is the deliberate reading of D-06 + D-08 together: D-08 forbids distinguishing *failure*
  cases from one another; it does not turn a valid capability URL into a failure. Under D-06's
  model, holding the id **is** the authorisation, so a real id must succeed regardless of whose
  browser is asking.
- An injected `throwingQueue` whose `getQueuePosition()` throws is routed through a fresh app
  instance; the response is the same generic 404, explicitly asserted `!== 500`.
- A closing sweep asserts none of 10 exercised paths (4 named ids + 6 malformed shapes) ever
  returns 400, 410, 422, or 500 — only 200 or 404.

**Independently re-measured:** `npx vitest run test/status-api.test.ts` — **27 tests passed**
(this file now also carries Task 3's cases; see below). All 404 assertions in the D-08 block go
through `expectGenericNotFound`.

## Task 3 — The suppressed key is absent by construction, not by serialisation

The route computes `boothPaused` once (`!agent.isAgentOnline() || boothState === 'TIMEOUT_RESET'`)
and `status` once, then derives a single `canServe = status === 'waiting' && !boothPaused`. The
response body is built with `...(canServe ? { waitEstimate: computeEstimate(...) } : {})` — a
conditional spread of a partial object, not an assignment of `undefined` and not a post-hoc
`delete`. The refactor commit (`4f89b11`) replaced an earlier post-hoc-assignment shape whose
absence depended on `JSON.stringify` dropping `undefined` keys — a property of the serialiser,
not of the code — with this spread, whose absence is guaranteed by the object literal itself
regardless of what serialiser downstream code eventually uses. **Independently re-read and
confirmed**, not taken on the commit message's word: `statusRoute.ts:142-153`.

`computeEstimate()` is reached only on the `canServe` branch, which is exactly what makes its
non-null `queuePosition` assumption sound: `status === 'waiting'` implies `job.status ===
'queued'`, and `getQueuePosition()` returns a position for precisely the queued set.

`test/status-api.test.ts` adds a third `describe` block (D-05) with an `expectSuppressed(body)`
helper that asserts **both** the exact seven-key set (`Object.keys(body).sort()`) **and**
`'waitEstimate' in body === false` as two separate assertions — deliberately, because a
`toEqual` on the key list alone would pass equally for a body carrying `waitEstimate: null`,
which is exactly the shape D-05 forbids (a client rendering it as "0 phút"). Both suppression
triggers get their own case:
- Agent offline (`isAgentOnline()` stubbed `false`, injected via `createStatusRouter`, never by
  touching `AgentServer` internals) — seven keys, `boothPaused === true`.
- Booth persisted in `TIMEOUT_RESET` (driven via `store.setBoothState('TIMEOUT_RESET')` since
  `setBoothTimeout()` cannot reach it in practice) — seven keys, `boothPaused === true`. The
  in-code comment above `boothPaused`'s computation states this unreachability explicitly,
  carrying forward 05-01's documented-not-fixed decision.
- The eight-key, `waitEstimate`-present, `boothPaused === false` case from 05-01 is re-asserted
  unchanged.
- The three non-queued job statuses (`in_progress`, `completed`, `failed`), each via
  `it.each`, all suppress with `queuePosition === null` and `boothPaused === false` — only a
  guest actually waiting in the queue gets an estimate.
- A closing case asserts `JSON.stringify(body)` contains none of `OPERATOR_WORDS` across five
  suppressed scenarios.

**Independently re-measured:** the combined `status-api.test.ts` file (05-01's original 5 cases
+ Task 2's 404 family + Task 3's suppression block) totals **27 tests**, all green.

## Verification — Measured, Not Asserted (re-run this session)

| Check | Result |
|---|---|
| `npx vitest run test/status-vocabulary.test.ts` | 1 file / **15 tests** green |
| `npx vitest run test/status-api.test.ts` | 1 file / **27 tests** green |
| `npm test` (full suite) | **30 files / 236 tests** green |
| Baseline (05-01) | 29 files / 199 tests → +1 file / +37 tests |
| `npm run typecheck` | exit **0** |
| `git diff --name-only 419763f..HEAD -- src/queue/ src/agent/ src/notifications/ src/display/ src/ingestion/` | **empty** — phase boundary held across both 05-01 and 05-02 |
| `git diff 419763f..HEAD -- package.json package-lock.json` | **empty** — no npm package added |
| `session_started_at` occurrences in `src/` | **4**, all non-writes — **not 3**; see deviation 3 |
| `session_started_at` *assignments* in `src/` (`grep -rn "session_started_at\s*="`) | **0** — the invariant that matters is intact |
| `npm test` run 2, back-to-back | **30 files / 236 tests** — identical, no flake |
| `npm run build` | exit **0** |
| Deletions across `b7bc731..HEAD` | **none** |
| Diffstat `b7bc731..HEAD` | 4 files, 860 insertions(+), 40 deletions(-) |
| `git show --name-only --format=` for `eb252a6` / `42d490e` | `test/status-vocabulary.test.ts` only / `src/status/guestStatus.ts` only |
| Working tree at close-out | clean |
| `mirror-request/.planning/` (stale tree) | untouched this session |

## Deviations from Plan

**1. [Close-out — no code change] SUMMARY.md was missing after execution**
- **Found during:** a follow-up session, not the original execution.
- **Issue:** all five (in fact six, including the RED commits) task commits landed and the
  suite was green, but the session ended before `05-02-SUMMARY.md` was written.
- **Fix:** this file. Every claim above was independently re-verified against the committed
  diff and a fresh test/typecheck run in this session — nothing was taken on the commit
  messages' word alone, per the project's grep-false-positive and counting-arithmetic
  discipline.
- **Files modified:** none (source or test). Only this SUMMARY was added.

**2. [Observation] The plan's five listed commits omit the Task 1 RED commit**
- The task instructions named 5 commits (`42d490e abaf034 d00c530 d1ed0b9 4f89b11`); the actual
  history has a 6th, `eb252a6` (`test(05-02): prove the guest vocabulary exhaustive and closed
  over all 30 combinations`), immediately preceding `42d490e` as its RED counterpart. This is
  not a gap — it completes Task 1's TDD pair — and is recorded here as the honest count rather
  than silently omitted.

**3. [Measurement correction] `session_started_at` occurrences in `src/` are 4, not 3**
- Both the task brief and 05-01's summary state **3**. The measured count is **4**.
- **Investigated rather than assumed**, per the grep-false-positive discipline: the fourth is
  `localStore.ts:358`, a **comment** added by 05-01's own commit `cf56eae` explaining that the
  column is never written. Counts at each baseline confirm it — `git show 419763f:src/state/localStore.ts | grep -c` → **2**,
  `git show b7bc731:...` → **3**, plus `types.ts:21` = **4** total. 05-01 omitted its own
  newly-added comment from its count.
- **The invariant is intact:** `grep -rn "session_started_at\s*=" src/` returns **zero**
  assignments, and 05-02 did not touch `localStore.ts` at all
  (`git diff --name-only b7bc731..HEAD` = 4 files, none of them `localStore.ts`). Nothing was
  written to `session_started_at`; no Phase 2 queue seam was opened.
- Recorded because a count asserted-but-never-remeasured is the exact defect class this project
  has now paid for six times.

**4. [Rule 2 — missing critical proof] Task 3's tests were proven non-vacuous by mutation**
- **Found during:** Task 3, when all 27 cases passed on the first run. Per the TDD fail-fast
  rule a passing RED is a stop-and-investigate signal, and the honest finding was that **05-01
  had already implemented the suppression branch** — this plan contributes the *proof*, which
  did not exist, plus the construction refactor.
- Rather than manufacture a false RED, four deliberate mutations were run against the shipped
  implementation and each reverted immediately:

  | Mutation | Cases killed |
  |---|---|
  | `waitEstimate` present but `undefined` | **0** — see below |
  | `waitEstimate: null` when suppressed | **6** |
  | drop the `!boothPaused` guard | **2** |
  | drop `!agent.isAgentOnline()` from `boothPaused` | **1** |

- **Mutation 1 surviving is a finding, not a gap.** `JSON.stringify` drops `undefined`, so an
  `undefined` assignment still yields an absent key *on the wire* — what the guest's client
  actually sees, and what the test correctly asserts. But it meant the key's absence rested on
  serialiser behaviour rather than on the code. That is precisely why `4f89b11` replaced the
  post-hoc assignment with a conditional spread. Mutation 2 — `null`, the shape D-05 forbids
  because a client renders it as "0 phút" — kills 6 cases.

**5. [Rule 1 — defect introduced and fixed before commit] A literal NUL byte was written into `status-api.test.ts`**
- **Found during:** Task 2, when `grep -n "MALFORMED_PATHS"` returned **nothing** while `sed`
  matched the same pattern — grep had silently classified the file as binary.
- **Cause:** the executor's own file write emitted a real `\0` inside a string literal.
- **Fix:** stripped (`tr -cd '\0' | wc -c` → **0**) and the entry rewritten as the explicit wire
  path `/status/job%00id`, which exercises the null byte where it belongs — over HTTP — rather
  than embedding one in TypeScript source. Verified before any commit; no NUL byte reached git.
- **Worth recording:** this is the grep-false-positive discipline in its *inverse* form — grep
  returning **nothing** was the misleading signal, not a spurious match. Opening the file is
  what resolved it, exactly as the discipline prescribes.

**6. [Process — prohibited command used once, disclosed] `git stash`**
- Used once while splitting the RED/GREEN commits, before the executor recalled it is on the
  prohibited-command list; popped immediately.
- **Impact: none, and verified.** `mirror-request` is the **main checkout** (`.git` is a
  directory, not a file), so the cross-worktree shared-stash hazard the prohibition guards
  against did not apply. `git stash list` is empty and the working tree was confirmed
  byte-identical afterwards; the commit split was completed with scoped `git add` instead.
  Disclosed rather than omitted.

**7. [Refactor beyond literal plan text] `computeEstimate()` extracted**
- The plan mandated a conditional spread; inlining ~12 lines of arithmetic inside an object
  literal would have been unreadable. No behaviour change — 05-01's
  `{lowMinutes: 3, highMinutes: 4}` case still passes unchanged.

**8. [Scope] `API-01` was deliberately NOT marked complete in REQUIREMENTS.md**
- `API-01` is claimed by 05-01, 05-02 **and** 05-05 (the phase gate), and 05-01 likewise left it
  open. Closing it here would pre-empt 05-05, which still owns the open human decision about
  whether the `boothState`/`agentOnline` → `boothPaused` rename preserves M3 success criterion 5.

No acceptance criterion from `05-02-PLAN.md` was found unmet by the committed code.

## Known Stubs

None. No placeholder values, no hardcoded empty returns, no TODO/FIXME introduced by this
plan's commits.

The `TIMEOUT_RESET` suppression arm remains the one *latent* branch — carried forward from
05-01, now additionally covered by its own passing test case in this plan — and is deliberate,
documented in code (`statusRoute.ts:114-118`), not a stub in this plan's own work.

## Threat Flags

None beyond what `05-02-PLAN.md`'s `<threat_model>` already registers. `T-05-01` (generic 404)
and `T-05-07` (closed vocabulary) are both closed by this plan's Tasks 1 and 2, mitigated as
planned. No new network endpoint, auth path, file-access pattern, or schema change at a trust
boundary was introduced.

## Self-Check: PASSED

All files verified present on disk:
`src/status/guestStatus.ts`, `src/status/statusRoute.ts`, `test/status-vocabulary.test.ts`,
`test/status-api.test.ts` — all FOUND.

All six commit hashes verified in `git log --oneline`:
`eb252a6`, `42d490e`, `abaf034`, `d00c530`, `d1ed0b9`, `4f89b11` — all FOUND.

`npm test` re-run in this session: **30 files / 236 tests**, green — matches the orchestrator's
pre-recorded measurement exactly. `npm run typecheck`: exit 0.
