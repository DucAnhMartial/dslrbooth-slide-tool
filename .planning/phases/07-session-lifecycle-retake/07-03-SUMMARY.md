---
phase: 07-session-lifecycle-retake
plan: 03
subsystem: queue
tags: [sqlite, better-sqlite3, registry, dslrbooth, websocket-events, notifications]
status: complete

# Dependency graph
requires:
  - phase: 04-guest-notification
    provides: durable-work-item-before-the-network-call precedent, terminal-rows-never-re-armed enforced in SQL (D-05), notificationService.sendPhotoLink seam
  - phase: 07-session-lifecycle-retake
    plan: 01
    provides: booth_state.current_job_id, jobId-scoped completeJob(), onPrintComposite() as the completion anchor, sessionEnded() reduced to booth release, releaseTimer
provides:
  - "pending_print SQLite table (jobId, composite_path, status, opened_at, expires_at, resolved_at, updated_at) created in LocalStore.bootstrap()"
  - "LocalStore.openPendingPrint / getPendingPrint / resolvePendingPrint / expirePendingPrints"
  - "QueueService.onPrintComposite() opening a pending-print slot at the composite anchor"
  - "QueueService.onFileUpload() resolving print uploads against the registry rather than booth_state (D-07), with the D-04 drop and D-11 late-delivery branches"
  - "QueueService.sweepPendingPrints() and the relocated 'No print upload seen' warning, fired at registry expiry"
  - "PENDING_PRINT_EXPIRY_MS / PENDING_PRINT_EXPIRY_FLOOR_MS module constants and the optional constructor injection seam"
  - "test/helpers/pendingPrintRegistry.ts — one shared in-memory stand-in for the registry across every mocked LocalStore"
affects: [07-04-no-photo-outcome, 07-05-phase-gate]

# Actuals (#2632)
actuals:
  tokens: 13408
  tasks: 3
  commits: 6

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Durable registry opened at the anchor, before the awaited event exists — the slot is written when the composite is produced, not when the upload arrives"
    - "Three-status vocabulary where the absence of a row is itself an answer (awaiting / expired / no row), keeping D-04 and D-11 structurally distinguishable"
    - "Expired rows are marked, never deleted — the row IS the evidence, so no cleanup path exists"
    - "Select-and-mark in one better-sqlite3 transaction, bounding a swept row to at most one log line ever"
    - "Constructor-injected timing constant with a derived clamp floor, deliberately NOT an EnvConfig key (D-12)"
    - "One shared test helper implementing the mocked registry semantics, rather than ten hand-copied inline stubs that could drift from the SQL"

key-files:
  created:
    - mirror-request/test/queue-print-registry-expiry.test.ts
    - mirror-request/test/helpers/pendingPrintRegistry.ts
  modified:
    - mirror-request/src/state/localStore.ts
    - mirror-request/src/queue/queueService.ts
    - mirror-request/test/local-store-persistence.test.ts
    - mirror-request/test/queue-file-upload-print.test.ts
    - mirror-request/test/queue-countdown.test.ts
    - mirror-request/test/queue-dual-completion.test.ts
    - mirror-request/test/queue-event-coverage.test.ts
    - mirror-request/test/queue-release-timer.test.ts
    - mirror-request/test/queue-recovery.test.ts
    - mirror-request/test/queue-config-injection.test.ts
    - mirror-request/test/queue-dispatch-connectivity.test.ts
    - mirror-request/test/queue-dispatch-mode.test.ts
    - mirror-request/test/queue-timeout-retry.test.ts
    - mirror-request/test/agent-disconnect-requeue.test.ts

key-decisions:
  - "Schema shipped verbatim as the human approved at Task 0's checkpoint (option-a). The earlier checkpoint framing claimed this shape matched notification_record's naming register; it does not — notification_record is fully camelCase (jobId, status, attempts, lastError, photoUrl, dueAt, updatedAt) while pending_print pairs a camelCase jobId with snake_case timestamps, which is booth_state's register (state, updated_at). The DDL is unchanged; only the justification is corrected."
  - "PENDING_PRINT_EXPIRY_MS is a module constant plus an optional constructor property, NOT a key in src/config.ts or EnvConfig. This deviates from the plan's Task 2 step 1 and one of its acceptance criteria — see Deviations. NOTE ADDED BY THE ORCHESTRATOR 2026-08-12: this deviation was made on a WRONG INSTRUCTION FROM THE ORCHESTRATOR, not on a real constraint. D-12 (07-CONTEXT.md:183) bans a config key/toggle for AGT-04 EVENT LOGGING only; 07-CONTEXT.md:222 puts timing defaults like this one under Claude's Discretion, needing only constructor injection. The plan's Task 2 was CORRECT and this executor should not have been told to deviate from it. The code works and is injectable, but the D-12 rationale recorded throughout this SUMMARY is unsound."
  - "600000ms is justified against a DERIVED floor: SESSION_TIMEOUT_MS (300000, src/config.ts:103) + NEXT_GUEST_COUNTDOWN_MS (7000, src/config.ts:104) = 307000ms, giving ~1.95x headroom. The service clamps any injected value up to that floor."
  - "Expired rows are never deleted and no cleanup path was added, because the row's existence is the only thing separating D-11's late-but-legitimate print from D-04's out-of-session photo."
  - "The mocked-registry semantics live in one shared helper rather than being re-typed into ten buildStore() functions, so a mock cannot drift away from the SQL it stands in for."

metrics:
  duration: ~25 min
  completed: 2026-08-12
  tests_before: 40 files / 368 tests
  tests_after: 41 files / 390 tests
---

# Phase 7 Plan 03: Durable pending-print registry Summary

A `pending_print` SQLite table now holds the slot for a photo that has not arrived
yet, opened at the print composite and resolved by the later `file_upload`, so the
`No print upload seen` warning moved off `session_end` — where it fired on every
successful session — onto registry expiry, where it means something.

## What was built

**Task 1 — the table and its accessors** (`src/state/localStore.ts`).
`pending_print` is declared in `bootstrap()`'s `CREATE TABLE IF NOT EXISTS` block,
because it is a brand-new table rather than a new column, and `IF NOT EXISTS` is
already this file's idempotency mechanism for new tables. Four accessors follow
`claimNotification()`'s id-scoped, changes-count-returning shape:

- `openPendingPrint()` — `ON CONFLICT(jobId) DO NOTHING`, which absorbs the
  `processing_start`/`printing` double fire without an application-level flag.
- `getPendingPrint()` — deliberately unfiltered by status, so the caller keeps all
  three answers.
- `resolvePendingPrint()` — `WHERE ... status IN ('awaiting','expired')`. The
  absence of `'resolved'` IS the no-second-notification guarantee; the presence of
  `'expired'` IS D-11.
- `expirePendingPrints()` — select and mark inside one `db.transaction`, so a row
  can never be returned without also being marked.

**Task 2 — resolution against the registry** (`src/queue/queueService.ts`).
`onPrintComposite()` opens the slot at the completion anchor, before the upload
exists. `onFileUpload()` takes a three-way decision on `getPendingPrint(jobId)`:
`awaiting` resolves then delivers, `expired` delivers late with one warn and no
job-status write, no row at all drops with one warn. The in-memory
`printUploadSeen` Set and the `session_end` print warning are gone.

**Task 3 — the sweep** (`src/queue/queueService.ts`). `sweepPendingPrints()` is
the first statement of `tick()`, above the `booth !== 'IDLE'` guard, because a slot
can only be open while a session is in progress. It emits one warn per expired
slot, keeping the literal token `No print upload seen` unchanged so operator greps
and the runbook keep working.

## Deviations from Plan

### 1. `PENDING_PRINT_EXPIRY_MS` is not a config key — instructed deviation

**Found during:** Task 2, before any code was written.

**Issue:** The plan's Task 2 step 1 instructs adding `PENDING_PRINT_EXPIRY_MS` to
`EnvConfig` in `src/types.ts` and to `loadConfig()` in `src/config.ts` as
`toNum('PENDING_PRINT_EXPIRY_MS', 600_000)`, and its acceptance criteria include
`grep -n "PENDING_PRINT_EXPIRY_MS" src/config.ts src/types.ts src/queue/queueService.ts`
showing the key in all three files. The executing instructions carry a hard
constraint that overrides it: **no new key in `src/config.ts`, no runtime toggle,
`process.env` never mutated**, with the value constructor-injected per the Phase 2
config pattern.

**Resolution:** The instruction was followed and the plan step was not. The value is
an exported module constant in `queueService.ts`, and the constructor's config
parameter is `Pick<EnvConfig, ...> & { PENDING_PRINT_EXPIRY_MS?: number }` — an
intersection rather than a `Pick`, so the injection seam exists for tests without
the key entering `EnvConfig` or `config.ts`. There is no environment variable and
no runtime toggle. `git diff` confirms `src/config.ts` and `src/types.ts` are
byte-for-byte unchanged by this plan, and `grep -rn "process.env.PENDING_PRINT"`
over `src/` and `test/` returns nothing.

**Consequence, stated plainly:** the plan's acceptance criterion
`grep -n "PENDING_PRINT_EXPIRY_MS" src/config.ts src/types.ts src/queue/queueService.ts`
**does not hold** — the key appears in `queueService.ts` only. That criterion and
the constraint are mutually exclusive; the constraint won. If the intent was to make
the expiry operator-tunable, that is a follow-up, not something this plan delivered.

**Files:** `src/queue/queueService.ts` — commit `4c797f2`.

### 2. Checkpoint framing corrected (no code impact)

The Task 0 checkpoint justified the schema as matching `notification_record`'s
naming register. It does not. `notification_record` (`localStore.ts:57-65`) is
fully camelCase; `pending_print` pairs a camelCase `jobId` with snake_case
timestamps, which is `booth_state`'s register (`localStore.ts:66-69`). The DDL was
shipped verbatim as approved — the human chose this shape knowing it — and the
false claim appears in neither the code comments nor this summary's justification.
The comment on the table declaration names `booth_state` explicitly.

### 3. One shared test helper instead of ten inline mock stubs

**Found during:** Task 2, extended in Task 3.

**Issue:** Task 2 step 5 says to extend `queue-file-upload-print.test.ts`'s
`buildStore()` with the four accessors "backed by a simple in-memory map", and
Task 3 step 4 says to add them to every other mocked `LocalStore`. Ten
hand-copied maps would be ten chances for a mock's semantics to drift from the SQL
it stands in for — at which point a test would pass against semantics the database
does not have.

**Resolution:** `test/helpers/pendingPrintRegistry.ts` holds one implementation,
spread into each mock as `...createPendingPrintRegistry().registry`. Ten test files
use it. The real SQL is proved separately against a real temp-file database. No
defensive `typeof` guards were added to `queueService.ts` to work around a mock, as
the plan required.

**Files:** `test/helpers/pendingPrintRegistry.ts` and the ten test files listed in
`key-files.modified` — commits `9d7f3ed`, `4c797f2`, `17223d6`.

### 4. `queue-event-coverage.test.ts`'s file_upload case now drives the anchor first

Its "file_upload still reaches the notification service through the real handler"
case delivered a print upload with no slot ever opened, which is now D-04's drop.
Rather than seeding the registry, the case now fires `processing_start` first, so
it proves the whole handler path — which is what it was there to assert.

**Files:** `test/queue-event-coverage.test.ts` — commit `4c797f2`.

## Flagged assumption — PRESERVED, not resolved

**RESEARCH.md Pitfall 3.** The registry is keyed by the jobId the Agent stamped on
the print-composite event. The Agent never clears `activeJobId` — D-05 leaves that
defect in place deliberately this phase — so a print upload arriving *after* a
third guest has been acknowledged would carry that third guest's id, miss the
original guest's registry row, and fall through to D-04's drop rule losing a real
photo, or in the worst ordering match a different guest's open slot.

The 600000ms expiry narrows this window; **it does not close it.** This is the
honest cost of D-05's Agent-untouched constraint, not a planning oversight. D-06's
mismatch warn (plan 07-01) is what will tell anyone whether it is still firing in
production. The deferred idea "clear `activeJobId` in the Agent" is the real fix and
belongs to a future phase that opens that repository for another reason.

This assumption is carried forward unchanged and was **not** treated as resolved by
anything in this plan.

## Non-vacuity proofs (both required by the plan, both run)

1. `resolvePendingPrint`'s `AND status IN ('awaiting','expired')` predicate was
   temporarily replaced with a bare `WHERE jobId = ?`. The duplicate-resolve
   assertion failed as predicted (`1 failed | 35 passed`). Reverted; 36 passed.
2. `sweepPendingPrints()` was temporarily moved below `tick()`'s `booth !== 'IDLE'`
   guard. "the sweep runs while the booth is still BUSY" failed as predicted
   (`1 failed | 4 passed`). Reverted; 5 passed.

## Verification

| Check | Result |
|-------|--------|
| `npm test` | 41 files / 390 tests passed, 0 skipped (baseline 40 / 368) |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| `grep -c "pending_print" src/state/localStore.ts` | 7 (plan requires >= 6) |
| `printUploadSeen` on non-comment lines of `queueService.ts` | 0 |
| `sweepPendingPrints` on non-comment lines | 2 — the definition and one call site, the first statement of `tick()` |
| `git -C dslrbooth-agent status --porcelain` | empty (D-05 honoured) |
| `src/config.ts` / `src/types.ts` diff | empty (D-12 honoured) |
| `.planning/` artifacts committed to git | none — the tree sits outside every repo |

Test counts by file: `local-store-persistence` 26 -> 36 (+10),
`queue-file-upload-print` 9 -> 16 (+7), `queue-print-registry-expiry` new (+5).

## Success criteria

- **SC-4 holds in both directions.** A full successful session produces zero warns
  across the whole run including timer advancement past expiry — asserted directly,
  replacing the previous opposite assertion. A session whose print never arrives
  produces exactly one warn, only after the expiry elapses, naming the job and the
  composite path, and no second warn across ten further expiry periods.
- **D-04 and D-11 are distinguishable structurally**, by whether a registry row was
  ever opened, not by a heuristic. Both branches have their own test.
- **The registry survives a restart** — a slot written before `close()` is still
  present, still `awaiting`, with the same `expires_at`, after reopening the same
  file, proved against a real temp-file database.

## Known Stubs

None. No hardcoded empty values, placeholder text, TODO or FIXME markers were
introduced, and no test is skipped.

## Threat Flags

None. No new network endpoint, auth path, file access pattern or trust-boundary
schema change beyond the `pending_print` table already covered by the plan's
threat register (T-07-10 through T-07-14). The two new warn lines carry the job id
and the booth-local composite path only; neither passes the fotoshare URL to a log
call site (D-13), and both are template strings so the existing `mask()` formatter
applies.

## Not done / follow-ups

- **WINDOWS item 9** is closed by this plan's code, but the ledger entry itself was
  not edited — `.planning/WINDOWS.md` is outside every git repo and the orchestrator
  owns planning-tree writes.
- **`OPS-RUNBOOK.md`** is untouched. 07-CONTEXT's canonical-refs note says §6, §7,
  §8 and §10 need the new outcome and status word recorded; that belongs to plan
  07-04 (the no-photo outcome), which introduces them.
- **The expiry is not operator-tunable**, per Deviation 1. If production shows the
  600000ms window is wrong, changing it is a code edit and a redeploy.

## Self-Check: PASSED

All created files exist on disk and all six commit hashes resolve in
`mirror-request`'s git history.
