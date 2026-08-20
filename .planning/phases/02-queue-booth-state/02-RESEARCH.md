# Phase 2: Queue & Booth State - Research

**Researched:** 2026-08-10
**Domain:** In-process job-queue/state-machine hardening (FIFO dispatch, booth state machine, crash/restart recovery, bounded retry) inside an existing Node.js/TypeScript service backed by `better-sqlite3`
**Confidence:** HIGH for architecture and pitfalls (grounded directly in the live `mirror-request/` codebase and the live production SQLite file, both read this session); MEDIUM for general crash-recovery/testing conventions (WebSearch cross-checked, no official spec — this is a private single-booth system, not a published queue library)

## Summary

Phase 2 is **not greenfield** — `mirror-request/src/queue/queueService.ts` (195 lines) already implements a working three-state booth loop (`IDLE → ANNOUNCING → BUSY → IDLE`), FIFO dispatch, ack/NAK handling, and a session-timeout safety net, and it is fully wired into `src/index.ts`. The phase's job is to *harden* this existing code against exactly one confirmed, reproduced failure mode: **the booth's timeout safety net lives only in an in-memory `setTimeout` (`busyTimer`), while `booth_state` is persisted to SQLite — so a process restart destroys the timer but not the state, and `tick()`'s `if (booth !== 'IDLE') return;` guard then blocks all future dispatch forever.**

This is not hypothetical. This session re-verified it directly against the live database: `booth_state` has read `BUSY` since `2026-08-10T04:29:42.732Z`; the current wall-clock gap is **≈312 minutes**, over 60× the default 5-minute `SESSION_TIMEOUT_MS`. Cross-referencing `dispatched_at` timestamps shows the row `registration-20260806-04431` was dispatched at `04:29:42.515Z` — 217ms before `booth_state.updated_at` was written — confirming it is *the* job tied to the current stuck BUSY state. Critically, **three additional jobs** (`registration-20260806-0001/0002/02331`, all dispatched on **Aug 6**, four days earlier) are *also* sitting in `status='dispatched'` with `acknowledged_at IS NULL`, orphaned from an earlier incident, structurally invisible to any recovery logic that looks only at the single `booth_state` row. See "Live Defect — Verified This Session" below; this reshapes the recovery-query design in a way CONTEXT.md's D-01/D-02 wording alone does not make obvious.

**Primary recommendation:** Add a `recover()` step that runs once before `queue.start()` in `index.ts`. It must (a) read `booth_state` age, (b) query **all** `queue_job` rows with `status IN ('dispatched','in_progress')` — not just one — because the live data proves more than one can accumulate, and a single-booth invariant means any such row is provably stale once the booth itself is being reset, (c) apply the D-05/D-06/D-07 bounded-retry policy to each, and (d) either re-arm `busyTimer` with the remaining time or reset to IDLE and call `tick()`. No schema migration is needed — `queue_job.retries` and `queue_job.stall_reason` already exist with correct types/defaults in the live production table (verified via `PRAGMA table_info`, not just the `CREATE TABLE IF NOT EXISTS` in code).

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| FIFO queue ordering (QUE-01) | Database/Storage (`queue_job` + `ORDER BY queued_at ASC`) | API/Backend (`QueueService.tick()` orchestrates) | Ordering is a durable invariant enforced by the SQL query, not in-memory state; `QueueService` just drives *when* the next row is read |
| Idempotency (QUE-02) | Database/Storage (`processed_id` + `INSERT OR IGNORE` on `queue_job`) | — | Already fully satisfied by Phase 1; Phase 2 adds no new dedup code (D-11) |
| Dispatch to Agent (QUE-03) | API/Backend (`QueueService.dispatchJob()` via `sendCommandCb` seam) | External System (Agent, out of scope — Phase 3 owns WS transport) | Phase 2 owns *when* to dispatch and *what* to send; Phase 3 owns *how* it's carried |
| session_end → auto-dispatch (QUE-04) | API/Backend (`QueueService.sessionEnded()` → `tick()`) | Database/Storage (`completeInProgressJob()`) | Event-driven transition triggered by an Agent WS event Phase 3 delivers; the state change itself is this service's logic |
| Booth state machine (BTH-01) | API/Backend (`QueueService` in-memory timers + `tick()` loop) | Database/Storage (`booth_state` row is the durable projection) | The *authoritative* value crosses both tiers by design — this split is exactly the source of the restart bug; recovery logic must treat SQLite as truth and memory as ephemeral |
| Safety-net timeout (BTH-02) | API/Backend (`busyTimer` `setTimeout`) | Database/Storage (`SESSION_TIMEOUT_MS` config, `booth_state.updated_at` as the recovery anchor) | The live timer is inherently in-process; the recovery mechanism that survives a restart is necessarily anchored in the persisted `updated_at` timestamp |
| Retry/stall bookkeeping (D-05..D-07) | Database/Storage (`queue_job.retries`, `queue_job.stall_reason`) | API/Backend (`QueueService`/`LocalStore` write path) | Durable counters that must survive the exact restart this phase is hardening against — cannot live in memory |
| Startup reconciliation (D-01..D-04) | API/Backend (composition root `index.ts` + a new `QueueService` method) | Database/Storage (`booth_state`, `queue_job` read at boot) | Must run once, before the first `tick()`, in the process that owns `queue.start()` |

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| QUE-01 | Global FIFO queue — correct registration order | Already implemented: `enqueueJob()` inserts with `queued_at`, `getNextQueuedJob()`/`getQueuedJobs()` order `ORDER BY queued_at ASC` `[VERIFIED: mirror-request/src/state/localStore.ts:130-134,146-156]`. Phase 2's job is to keep this guarantee intact through the new retry path (D-06) and prove it with a test, not to build it. |
| QUE-02 | Idempotency — no duplicate processing by record id | Already structurally satisfied by Phase 1's `processed_id` table + `enqueueJob()`'s `INSERT OR IGNORE` `[VERIFIED: mirror-request/src/state/localStore.ts:130-134]`. D-11/D-12 in 02-CONTEXT.md confirm: no new dedup code, but an explicit end-to-end test is owed proving a requeue (D-05 path) cannot create a second `queue_job` row for one registration. |
| QUE-03 | IDLE + queued job → dispatch `start_session` to Agent | Already implemented via `tick()` → `beginAnnouncement()` → (after countdown) `dispatchJob()` → `sendCommandCb?.(...)` `[VERIFIED: mirror-request/src/queue/queueService.ts:93-132]`. D-09/D-10 require this path's *entry* condition (state machine legality) to be fully specified including startup-recovery transitions. |
| QUE-04 | session_end → IDLE → auto-dispatch next | Already implemented: `onAgentEvent('session_end')` → `sessionEnded()` → `completeInProgressJob()` + `setBoothIdle()` + `tick()` `[VERIFIED: mirror-request/src/queue/queueService.ts:57-63,83-91]`. No behavior change required; must remain correct after D-01..D-07 changes are layered in. |
| BTH-01 | IDLE/BUSY state machine | Already a *three*-state machine in production (`IDLE`/`ANNOUNCING`/`BUSY`) though the requirement text only names two; D-09 formally promotes `ANNOUNCING` to first-class. `BoothState` type already has a **fourth**, entirely unused value `'TIMEOUT_RESET'` `[VERIFIED: mirror-request/src/types.ts:1]` — see Pitfall 6. |
| BTH-02 | BUSY > 5 min without session_end → auto-reset IDLE + warning | Already implemented for the *live, non-restarted* case: `startBusyTimer()`'s `setTimeout` fires `setBoothTimeout()` (which logs `logger.warn` and writes `state='IDLE'`) `[VERIFIED: mirror-request/src/queue/queueService.ts:134-142]` `[VERIFIED: mirror-request/src/state/localStore.ts:232-235]`. **This is exactly the mechanism that breaks across a restart** — the whole motivating defect for this phase. |

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Restart recovery — the booth must never be permanently stuck**
- D-01: On startup the service MUST reconcile persisted booth state against wall-clock age before serving. Age is `now - booth_state.updated_at`, which for a BUSY booth is the dispatch moment.
- D-02: If age exceeds `SESSION_TIMEOUT_MS`, the session is dead: reset the booth to IDLE and return its in-flight job to the queue under the retry policy in D-05..D-07.
- D-03: If age is within `SESSION_TIMEOUT_MS`, the session may still be live: keep the booth BUSY and re-arm the timer with only the remaining time (`SESSION_TIMEOUT_MS - age`), so a restart does not grant a stuck session a fresh full timeout. — Reversibility: costly — this changes whether a real in-progress photo session survives a service restart.
- D-04: A booth found in `ANNOUNCING` at startup resets to IDLE and is re-announced by the normal tick. The countdown is only 5–10s, so restoring a partial countdown is not worth the complexity.

Rationale for the age-based reading over the two simpler alternatives: always resetting to IDLE risks dispatching a second job on top of a session the Agent is genuinely running; always waiting for the Agent reproduces exactly the deadlock observed above whenever the Agent dies with the service. Age is the only signal available locally that distinguishes the two.

**Timeout policy — optimized for the waiting guest**
- D-05: A timed-out job returns to the queue and increments `queue_job.retries` (column already exists, currently unused). It is retried up to `SESSION_MAX_RETRIES` times, default 2 (3 dispatch attempts total), configurable.
- D-06: A requeued job MUST retain its original `queued_at`. Because `getNextQueuedJob()` orders by `queued_at ASC`, this returns the guest to their original position rather than the back of the line. A guest must never be demoted for a fault that was the system's, not theirs. This behavior is currently implicit — `updateJobStatus()` happens not to touch `queued_at` — and must become an explicit, tested guarantee.
- D-07: Once retries are exhausted, the job is marked `failed`, the reason is written to `queue_job.stall_reason` (column already exists, currently unused), a warning is logged, and the queue advances to the next guest. One broken job must never hold the whole queue hostage.
- D-08: Notifying a guest whose session failed is out of scope here — the delivery channel is Phase 4. Phase 2's obligation is to record `stall_reason` precisely enough that an operator, or a later phase, can act on it.

Rationale: unlimited retry (today's behavior) lets one poisoned job block every guest behind it forever; failing on the first timeout throws away a guest over a transient glitch. A small bounded retry that preserves queue position loses neither.

**Booth state machine**
- D-09: `ANNOUNCING` is promoted to a first-class third state alongside IDLE and BUSY, with explicit transitions and its own timeout. It already runs in production and already gates dispatch timing; leaving it out of the specified state machine is how the restart bug above came to exist.
- D-10: The full legal transition set, the trigger for each, and what happens to the in-flight job on each transition must be specified and tested — including the transitions that fire on startup recovery (D-01..D-04).

**Idempotency (QUE-02)**
- D-11: QUE-02 is already satisfied structurally: ingestion-level dedup landed in Phase 1 (D-01..D-03 there, plus the `processed_id` table), and `enqueueJob()` uses `INSERT OR IGNORE`. Phase 2 adds no new dedup code.
- D-12: Phase 2 owes an end-to-end test proving one registration can never produce two queue jobs, including under the retry path in D-05 — a requeue must not be able to create a second row.

**Configuration**
- D-13: `queueService.ts` reads `process.env` directly in two places (`NEXT_GUEST_COUNTDOWN_MS` at line 103, `SESSION_TIMEOUT_MS` at line 136). These move to the typed `EnvConfig` surface, matching what Phase 1 established when it removed the same anti-pattern from `dbPoller.ts`. `SESSION_TIMEOUT_MS` is already declared in `config.ts`; the queue simply is not reading it.

### Claude's Discretion

- The exact startup-reconciliation mechanism (a dedicated `recover()` method versus folding it into `start()`), provided it runs before the first tick and is unit-testable without a real restart.
- How `SESSION_MAX_RETRIES` is surfaced in logs.
- Whether the ANNOUNCING timeout gets its own config key or reuses the existing countdown bounds.

### Deferred Ideas (OUT OF SCOPE)

- Notifying a guest whose session failed after exhausted retries — needs the Phase 4 delivery channel; Phase 2 only records `stall_reason` (D-08).
- WebSocket transport, Agent token auth and heartbeat — Phase 3. Phase 2 dispatches through the existing `sendCommandCb` seam without touching how it is carried.
- Guest-facing queue position API and the display feed — Phase 5.
- Multi-booth support and a distributed queue — explicitly out of scope per PROJECT.md.
- Isolating the test database from the production SQLite file — currently open ledger item 4; flagged as a candidate for this phase, not yet committed.
</user_constraints>

## Project Constraints (from CLAUDE.md)

`mirror-request/CLAUDE.md` states hard rules that apply directly to this phase:

- **NEVER call dslrBooth Local API directly — all commands go through Agent via WS.** Confirms Phase 2 must dispatch only through the existing `sendCommandCb` seam (`bindSendCommand`), never anything more direct — matches the CONTEXT.md integration-point guidance not to touch that seam.
- **All business logic lives HERE [the central service]. Agent is a dumb relay only.** Confirms the entire state machine, retry policy, and recovery logic belong in `mirror-request/`, with zero logic pushed to the Agent (out of scope for Phase 2 anyway).
- Runtime: Node.js 20 LTS, TypeScript. Packages: express, ws, better-sqlite3, winston, dotenv. Deployment: PM2 or Docker — PM2/Docker both restart the process on crash or deploy, which is precisely the restart vector this phase must survive.

## Live Defect — Verified This Session

This session queried the real production SQLite file directly (read-only) rather than relying on 02-CONTEXT.md's account alone:

```
booth_state: [{"id":1,"state":"BUSY","updated_at":"2026-08-10T04:29:42.732Z"}]
now (this session): 2026-08-10T09:41:38.189Z → age ≈ 312 minutes (SESSION_TIMEOUT_MS default is 5 minutes)

queue_job rows in status IN ('dispatched','queued') at time of research:
  registration-20260806-0001    status=dispatched  dispatched_at=2026-08-06T15:29:58.001Z  acknowledged_at=NULL  retries=0  stall_reason=NULL
  registration-20260806-0002    status=dispatched  dispatched_at=2026-08-06T15:40:06.930Z  acknowledged_at=NULL  retries=0  stall_reason=NULL
  registration-20260806-02331   status=dispatched  dispatched_at=2026-08-06T15:48:27.480Z  acknowledged_at=NULL  retries=0  stall_reason=NULL
  registration-20260806-04431   status=dispatched  dispatched_at=2026-08-10T04:29:42.515Z  acknowledged_at=NULL  retries=0  stall_reason=NULL
  job-webhook-001                status=queued      queued_at=2026-08-08T ~14:22:41Z (1786069361363)
```
`[VERIFIED: live query against mirror-request/data/extension-service.sqlite this session, read-only]`

**Key finding not obvious from 02-CONTEXT.md's summary alone:** `booth_state.updated_at` (`1786336182732`) and `registration-20260806-04431`'s `dispatched_at` (`1786336182515`) differ by only **217ms** — confirming this is *the* job the current BUSY state is tied to (`dispatchJob()` calls `setBoothBusy()` and `updateJobStatus(..., 'dispatched_at', now)` in the same synchronous call, so their timestamps are near-identical by construction `[VERIFIED: mirror-request/src/queue/queueService.ts:125-132]`). But the other **three** dispatched rows are from **August 6**, four days before the current incident — an earlier, separate stuck-booth episode that has no relationship to the current `booth_state` row at all.

**Design implication for the planner:** a recovery mechanism that reads *only* `booth_state.updated_at` and resolves *only the single job whose timestamp matches it* will correctly fix the immediate symptom (the currently-stuck booth) but will **not** satisfy CONTEXT.md's stated acceptance signal ("the 4 stale `dispatched` jobs resolve under D-02") — three of the four are orphaned independently of the current booth-state row. Because this is a **single-booth system** (PROJECT.md explicitly scopes out multi-booth/distributed queue), the correct invariant to enforce is: *at any moment there should be at most one row in `('dispatched','in_progress')`*. Therefore recovery should not search for "the one job matching the timestamp" — it should sweep **every** row currently in `status IN ('dispatched','in_progress')` and run each through the D-05..D-07 retry/fail policy. This also naturally self-heals any future orphan of this kind, not just the ones present today.

**A second, sharper implication:** `LocalStore.completeInProgressJob()` — the only existing query that looks for "the current in-flight job" — filters `WHERE status = 'in_progress'` `[VERIFIED: mirror-request/src/state/localStore.ts:170-179]`. **None of the 4 stuck rows are `'in_progress'`** — all 4 are still `'dispatched'`, because `acknowledged_at IS NULL` on every one of them (the Agent never sent an ack event, or the ack was lost with the process). A naive recovery implementation that reuses `completeInProgressJob()`'s query pattern will find **zero** stuck jobs and silently do nothing. **A new query is required**, e.g. `SELECT * FROM queue_job WHERE status IN ('dispatched','in_progress')`, with no existing `LocalStore` method currently providing it.

## Standard Stack

No new production dependencies are needed for this phase — it is entirely internal logic changes to `mirror-request/src/queue/queueService.ts`, `src/state/localStore.ts`, `src/config.ts`, `src/types.ts`, and `src/index.ts`, all using libraries already installed and already verified working in this session (`better-sqlite3` 11.10.0 loaded and queried live; `vitest` 2.1.9 confirmed via `npx vitest --version`).

### Core (all already installed)

| Library | Version (installed) | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `better-sqlite3` | ^11.0.0, loaded as 11.10.0 `[VERIFIED: live module load + query this session]` | All durable queue/booth state | Already the project's persistence layer; synchronous API is what makes `getNextQueuedJob()`/`updateJobStatus()` safe to call from a 250ms tick without async races |
| `winston` | ^3.14.2 | Structured, masked logging for D-05/D-07 warnings | Already the project's logging stack (`src/logging/logger.ts`) — see Pitfall 7 for why `queueService.ts` currently bypasses it |
| `dotenv` | ^16.4.5 | Loads new `SESSION_MAX_RETRIES`/`NEXT_GUEST_COUNTDOWN_MS` config keys | Already in use in `config.ts` |

### Supporting (test-only, already installed — no new devDependency needed)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `vitest` | ^2.1.4, running 2.1.9 `[VERIFIED: npx vitest --version this session]` | `vi.useFakeTimers()`/`vi.advanceTimersByTime()` to test the 250ms tick loop, the ANNOUNCING countdown, and `busyTimer` deterministically without real waits | Already used exactly this way in `test/queue-countdown.test.ts` — that file is the pattern to extend, not replace |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Sweeping `queue_job` for orphans on every startup | A dedicated "stale job reaper" running on an interval (BullMQ-style lock/lease pattern) | Rejected as over-engineering for a single-booth system — there is at most one in-flight job ever; a one-shot startup sweep plus the existing live `busyTimer` safety net covers both the restart case and the live case without adding a second periodic mechanism `[CITED, MEDIUM confidence — general job-queue crash-recovery pattern, cross-checked via WebSearch against BullMQ's "stalled job" docs]` |
| `queue_job.retries`/`stall_reason` columns (already exist) | A separate `queue_job_retry_log` table | Rejected — D-05/D-07 explicitly point at the two existing unused columns; a new table would be unrequested scope and duplicate what's already in the schema |

**Installation:** none — no new packages for this phase.

**Version verification performed this session:**
```
node --version                                     → v24.15.0 (sandbox; project pins Node 20.x per CLAUDE.md/package.json — not a Phase 2 concern, same caveat Phase 1 flagged)
node -e "require('better-sqlite3/package.json').version" → 11.10.0 (matches ^11.0.0 pin, loads and queries successfully)
npx vitest --version                               → vitest/2.1.9 (matches ^2.1.4 pin)
```

## Package Legitimacy Audit

**No new packages are proposed for this phase.** All work uses libraries already installed and already verified (Phase 1's audit covered `better-sqlite3`, `express`, `winston`; this phase adds no new imports). This section is included for completeness per the required-whenever-installing-packages rule, but the audit table is empty by design.

**Packages removed due to [SLOP] verdict:** none (no packages proposed)
**Packages flagged as suspicious [SUS]:** none (no packages proposed)

## Architecture Patterns

### System Architecture Diagram

```text
                          [250ms setInterval tick — QueueService.start()]
                                          |
                                          v
                          +----------------------------+
                          |   QueueService.tick()       |
                          |   reads booth_state (SQLite)|
                          +---------------+--------------+
                                          |
                     booth === 'IDLE' and queue non-empty?
                                          | yes
                                          v
   +-----------------------------------------------------------------------+
   |  beginAnnouncement(job)                                               |
   |   - setBoothState('ANNOUNCING')  [persisted]                         |
   |   - announcingJobId, announcementEndsAt  [in-memory]                 |
   |   - announcementTimer = setTimeout(..., countdownMs)  [in-memory]    |
   |   - sendAnnouncementCb (display feed, unaffected by Phase 2)          |
   +-----------------------------------------+-----------------------------+
                                              | countdownMs elapses
                                              v
   +-----------------------------------------------------------------------+
   |  dispatchJob(job)                                                     |
   |   - updateJobStatus(id, 'dispatched', dispatched_at, now) [persisted]|
   |   - setBoothBusy()  [persisted, state='BUSY']                        |
   |   - startBusyTimer(jobId)  [in-memory setTimeout, SESSION_TIMEOUT_MS]|
   |   - sendCommandCb → Agent (Phase 3 owns the wire, not this phase)    |
   +-----------------------------+----------------------+-------------------+
                                  |                      |
                     Agent ack (session_start /   busyTimer fires (no ack
                     onAgentAck ok=true)            or session_end in time)
                                  |                      |
                                  v                      v
              +-------------------------+   +-----------------------------+
              | sessionAcked(jobId)      |   | [TODAY] setBoothTimeout()   |
              | status='in_progress'     |   |  state→IDLE, job→'queued'   |
              | re-arm busyTimer         |   |  (acknowledged_at stamped — |
              +------------+-------------+   |   see Pitfall 5)            |
                           |                  | [PHASE 2 must add: retry   |
              session_end  |                  |  count, preserved          |
              event        |                  |  queued_at, bounded fail]  |
                           v                  +-----------------------------+
              +-------------------------+
              | sessionEnded()           |
              | completeInProgressJob()  |
              | status='completed'       |
              | setBoothIdle()            |
              | clearBusyTimer(), tick() |
              +-------------------------+

   ============ PROCESS RESTART (PM2/Docker) — the gap this phase closes ============

   In-memory timers (timer, busyTimer, announcementTimer) are ALL destroyed.
   booth_state row in SQLite is UNCHANGED — may still read 'BUSY' or 'ANNOUNCING'.

   [PHASE 2 NEW] recover() — runs once, before queue.start()'s first tick:
     1. Read booth_state (state, updated_at) from SQLite.
     2. state === 'ANNOUNCING' → setBoothIdle(); no job action needed (D-04) —
        job is still 'queued', untouched by beginAnnouncement().
     3. state === 'BUSY' →
          age = now - parseISO(updated_at)
          in-flight jobs = SELECT * FROM queue_job WHERE status IN
                            ('dispatched','in_progress')   <-- NEW QUERY, does
                            not exist today (completeInProgressJob() only
                            matches 'in_progress', missing 'dispatched' rows
                            — see "Live Defect" section)
          if age >= SESSION_TIMEOUT_MS:
             setBoothIdle()
             for each in-flight job: apply D-05/D-06/D-07 retry policy
          else:
             keep booth BUSY; re-arm busyTimer for (SESSION_TIMEOUT_MS - age),
             bound to the single most-recently-dispatched job's id
     4. state === 'IDLE' → nothing to do.
     5. queue.start() begins its normal 250ms tick loop.
```

### Recommended Project Structure (extends existing layout — no new top-level folders)
```
mirror-request/src/
├── queue/
│   └── queueService.ts      # existing — add recover(), retry-aware timeout handler,
│                             #   config injection (D-13), full transition table (D-09/D-10)
├── state/
│   └── localStore.ts        # existing — add getInFlightJobs(), requeueWithRetry(),
│                             #   failJob() methods (no schema change — columns exist)
├── config.ts                 # existing — add SESSION_MAX_RETRIES, NEXT_GUEST_COUNTDOWN_MS
├── types.ts                   # existing — add SESSION_MAX_RETRIES, NEXT_GUEST_COUNTDOWN_MS
│                             #   to EnvConfig; QueueJob.status stays `string` (no union
│                             #   change needed) but gains a documented 'failed' value
└── index.ts                   # existing — call queue.recover() (or equivalent) before
                              #   queue.start()
```

### Pattern 1: Age-based restart reconciliation (D-01..D-04)
**What:** On boot, before the tick loop starts, compare `booth_state.updated_at` against `SESSION_TIMEOUT_MS` to decide whether a BUSY booth's session is provably dead or possibly still live.
**When to use:** Once, at process startup, before `queue.start()`.
**Example:**
```typescript
// Source: derived directly from queueService.ts's existing startBusyTimer()/
// setBoothTimeout() logic — this is the restart-safe equivalent of the same
// decision the live setTimeout already makes, just anchored to a persisted
// timestamp instead of process memory.
recover(): void {
  const { state, updated_at } = this.store.getBoothStateDetailed(); // [VERIFIED: localStore.ts:237-241 — already returns updated_at]
  const now = Date.now();

  if (state === 'ANNOUNCING') {
    this.store.setBoothIdle(); // D-04 — job is still 'queued', untouched
    return;
  }
  if (state === 'BUSY') {
    const ageMs = now - Date.parse(updated_at);
    const inFlight = this.store.getInFlightJobs(); // NEW — see Pattern 2
    if (ageMs >= this.sessionTimeoutMs) {
      this.store.setBoothIdle();
      for (const job of inFlight) this.handleStall(job, 'restart_recovery_timeout');
    } else if (inFlight.length > 0) {
      // most-recently-dispatched job is the one tied to this BUSY state
      const current = inFlight[0]; // ordered by dispatched_at DESC
      this.startBusyTimer(current.id, this.sessionTimeoutMs - ageMs);
    }
  }
  // state === 'IDLE' → nothing to do
}
```
Note: `getBoothStateDetailed()` already exists and already returns `updated_at` `[VERIFIED: mirror-request/src/state/localStore.ts:237-241]` — no schema or method signature change needed there, only a new caller.

### Pattern 2: Single-booth invariant sweep, not single-job lookup
**What:** Query *all* non-terminal `queue_job` rows, not just the one whose timestamp happens to match `booth_state.updated_at` — justified directly by the live defect (3 of 4 stuck rows predate the current `booth_state` row and would otherwise never be found).
**Example:**
```typescript
// New LocalStore method — no existing method covers 'dispatched' status;
// completeInProgressJob() only matches 'in_progress' [VERIFIED: localStore.ts:170-179]
getInFlightJobs(): QueueJob[] {
  return this.db.prepare(
    "SELECT * FROM queue_job WHERE status IN ('dispatched','in_progress') ORDER BY dispatched_at DESC"
  ).all() as QueueJob[];
}
```

### Pattern 3: Bounded retry preserving queue position (D-05/D-06/D-07)
**What:** A requeued job must increment `retries`, keep `queued_at` unchanged, and eventually fail without touching any other queued job.
**Why not reuse `updateJobStatus()`:** its signature is `(id, status, tsField, tsValue)` — one status + one timestamp write `[VERIFIED: mirror-request/src/state/localStore.ts:136-144]`. It has no path to increment a counter (`retries`) or write `stall_reason`, and its internal `map` of allowed `tsField` values does not include either column. New purpose-built methods are needed, not a `tsField` extension.
**Example:**
```typescript
// New LocalStore methods
requeueWithRetry(jobId: string): { retries: number } {
  // queued_at is NOT in the SET list — this is what makes D-06's guarantee
  // explicit and testable, vs. today's *incidental* omission.
  this.db.prepare(
    "UPDATE queue_job SET status = 'queued', retries = retries + 1 WHERE id = ?"
  ).run(jobId);
  const row = this.db.prepare('SELECT retries FROM queue_job WHERE id = ?').get(jobId) as { retries: number };
  return row;
}

failJob(jobId: string, stallReason: string): void {
  this.db.prepare(
    "UPDATE queue_job SET status = 'failed', stall_reason = ? WHERE id = ?"
  ).run(stallReason, jobId);
}
```
```typescript
// QueueService orchestration — the shared decision point for BOTH the live
// busyTimer path and the restart-recovery path (Pattern 1), so the retry
// policy is defined exactly once.
private handleStall(job: { id: string }, reason: string): void {
  const { retries } = this.store.requeueWithRetry(job.id);
  if (retries > this.sessionMaxRetries) {
    this.store.failJob(job.id, reason);
    logger.warn(`Job ${job.id} failed after ${retries} attempts: ${reason}`);
  } else {
    logger.warn(`Job ${job.id} requeued (attempt ${retries + 1}/${this.sessionMaxRetries + 1}): ${reason}`);
  }
}
```
Note: `requeueWithRetry` always increments, then the caller decides fail-vs-requeue based on the *returned* count — this means a "failed" job's `retries` column also reflects the attempt that pushed it over the limit, which is useful for the stall_reason/operator story (D-08) without a second write.

### Pattern 4: Typed config injection, matching the `NotificationService` precedent (D-13)
**What:** Move `queueService.ts`'s two `process.env` reads (`NEXT_GUEST_COUNTDOWN_MS` at line 103, `SESSION_TIMEOUT_MS` at line 136) onto the typed `EnvConfig` surface, using constructor-default injection — the exact pattern already used by `NotificationService`, not the alternative pattern `DBPoller` uses (explicit params threaded through `index.ts`).
**Why this pattern over `DBPoller`'s:** `QueueService`'s constructor already has an injectable default (`store: LocalStore = getStore()`) `[VERIFIED: mirror-request/src/queue/queueService.ts:25-27]`; `NotificationService` uses the identical style for `maxRetries = config.NOTIFY_MAX_RETRIES` `[VERIFIED: mirror-request/src/notifications/notificationService.ts:13-19]`. Extending `QueueService`'s existing constructor shape is the smaller, more consistent change, and keeps every timing knob overridable in tests without touching `index.ts` call sites unnecessarily.
**Example:**
```typescript
// config.ts / types.ts — new EnvConfig fields (neither exists today)
// [VERIFIED absence: grep across src/ found SESSION_TIMEOUT_MS only in
//  config.ts/types.ts, never NEXT_GUEST_COUNTDOWN_MS or SESSION_MAX_RETRIES]
NEXT_GUEST_COUNTDOWN_MS: toNum('NEXT_GUEST_COUNTDOWN_MS', 7000),
SESSION_MAX_RETRIES:     toNum('SESSION_MAX_RETRIES', 2),   // D-05 default: 2 retries = 3 attempts total

// queueService.ts — constructor gains config, defaulting to getConfig()
constructor(
  store: LocalStore = getStore(),
  config: Pick<EnvConfig, 'SESSION_TIMEOUT_MS' | 'NEXT_GUEST_COUNTDOWN_MS' | 'SESSION_MAX_RETRIES'> = getConfig(),
) {
  this.store = store;
  this.sessionTimeoutMs = config.SESSION_TIMEOUT_MS;
  this.countdownMs = config.NEXT_GUEST_COUNTDOWN_MS;
  this.sessionMaxRetries = config.SESSION_MAX_RETRIES;
}
```
The `Pick<...>` narrows the injected type to exactly the fields this constructor needs — following the same narrowing style `NotificationService` uses for its own config slice.

### Full Transition Table (D-09/D-10) — audited against current code

| From | To | Trigger | In-flight job effect | Status today |
|------|----|---------|----------------------|---------------|
| IDLE | ANNOUNCING | `tick()` finds `booth==='IDLE'` and a queued job | none (job stays `queued`) | Implemented `[VERIFIED: queueService.ts:93-100,102-123]` |
| ANNOUNCING | BUSY | `announcementTimer` fires after countdown | `status→'dispatched'`, `dispatched_at` set | Implemented `[VERIFIED: queueService.ts:117-132]` |
| BUSY | IDLE | `session_end` event (Agent) | `status→'completed'` via `completeInProgressJob()` | Implemented `[VERIFIED: queueService.ts:57-63,83-91]` |
| BUSY | BUSY (no state change) | Agent ack (`session_start` event or `onAgentAck(ok=true)`) | `status→'in_progress'`, `acknowledged_at` set, `busyTimer` re-armed | Implemented `[VERIFIED: queueService.ts:65-69,71-81,86-87]` |
| BUSY | IDLE | Agent NAK (`onAgentAck(ok=false)`) | `status→'queued'`, `session_started_at` stamped (semantically odd — see Pitfall 4), no retry increment | Implemented but **not retry-aware** — D-05 arguably applies here too (open question, see below) |
| BUSY | IDLE | `busyTimer` fires (live process, no restart) | `status→'queued'`, `acknowledged_at` re-stamped (see Pitfall 4) | Implemented but **not retry-aware** — this is the exact site D-05/D-06/D-07 must land in |
| ANNOUNCING | IDLE | **Startup recovery, booth found ANNOUNCING** | none — job still `queued` | **Missing (D-04)** |
| BUSY | IDLE | **Startup recovery, age ≥ SESSION_TIMEOUT_MS** | all in-flight jobs → retry/fail policy | **Missing (D-01/D-02/D-05..D-07)** |
| BUSY | BUSY | **Startup recovery, age < SESSION_TIMEOUT_MS** | none — `busyTimer` re-armed with remaining time | **Missing (D-03)** |
| dispatched/in_progress (via retry) | queued | Timeout, retries remaining | `retries+=1`, `queued_at` preserved | **Missing (D-05/D-06)** |
| dispatched/in_progress (via retry) | failed | Timeout, retries exhausted | `stall_reason` set, queue advances | **Missing (D-07)** |

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|--------------|-----|
| "How much time is left on a BUSY session after restart" | A new persisted "remaining time" counter that ticks down and needs its own persistence/migration | `now - booth_state.updated_at` computed fresh at boot, compared to the already-configured `SESSION_TIMEOUT_MS` | `updated_at` is already written on every `setBoothBusy()` call `[VERIFIED: localStore.ts:224-226]`; no new column, no new write path, no drift between two clocks |
| Finding "the currently in-flight job" | A second/parallel tracking table or in-memory index of "the current job" | A plain `SELECT ... WHERE status IN ('dispatched','in_progress')` query (Pattern 2) | The `queue_job.status` column is already the single source of truth for job lifecycle; a parallel tracker would have to be kept in sync and could itself drift after a restart — the same class of bug this phase exists to fix |
| Periodic "reaper" process for stalled jobs | A `setInterval`-based background sweep separate from the existing 250ms `tick()` | One-shot `recover()` at startup + the existing live `busyTimer` for the already-running case | Single-booth system: there is only ever at most one in-flight job; a background reaper is solving a multi-worker problem this system doesn't have `[CITED, MEDIUM confidence — cross-checked against BullMQ's stalled-job docs, which explicitly targets multi-worker Redis-backed queues, not this system's shape]` |
| Retry counting | A separate `retry_log` table, or counting rows in `queue_job` history | The existing `queue_job.retries INTEGER NOT NULL DEFAULT 0` column, already in the live schema `[VERIFIED: PRAGMA table_info(queue_job) against the live production DB this session — column present, type INTEGER, notnull=1, default=0]` | Exactly what D-05 names; building anything else would duplicate a column that already exists and is already correctly typed |

**Key insight:** every piece of durable state this phase needs (`retries`, `stall_reason`, `booth_state.updated_at`) already exists in the live schema with the right shape. The entire phase is: (1) a new read-path query (`getInFlightJobs()`) that nothing currently calls, (2) two new write-path methods (`requeueWithRetry`, `failJob`) that use existing columns `updateJobStatus()` structurally cannot reach, and (3) one new orchestration method (`recover()`) that runs those at the right moment. Resist the urge to add new tables or new persisted counters — none are needed.

## Common Pitfalls

### Pitfall 1: Naive recovery only fixes the newest stuck job, not the historical orphans
**What goes wrong:** A recovery implementation that finds "the job whose `dispatched_at` matches `booth_state.updated_at`" (a natural first instinct, since that's the literal wording of D-01/D-02: "its in-flight job") will correctly fix `registration-20260806-04431` but leave the three August-6 orphans (`0001`/`0002`/`02331`) permanently stuck in `status='dispatched'` forever — silently failing CONTEXT.md's stated acceptance signal that "the 4 stale dispatched jobs resolve."
**Why it happens:** `booth_state` is a single row with no history; it can only ever describe the *most recent* transition. Any job left stranded by an *earlier* incident — one that predates the current BUSY episode — has no persisted link back to a `booth_state` row that could ever point at it again.
**How to avoid:** Sweep `WHERE status IN ('dispatched','in_progress')` unconditionally (Pattern 2), not `WHERE dispatched_at ≈ booth_state.updated_at`. The single-booth invariant (at most one truly in-flight job) makes this safe: any additional rows found are provably stale by construction, not a design compromise.
**Warning signs:** After deploying the fix and restarting, `SELECT COUNT(*) FROM queue_job WHERE status='dispatched'` is still > 0.

### Pitfall 2: `completeInProgressJob()`'s `WHERE status = 'in_progress'` filter misses every currently-stuck row
**What goes wrong:** All 4 live stuck jobs are `status='dispatched'` (never acked), not `'in_progress'`. Reusing or extending `completeInProgressJob()`'s query shape for recovery purposes will match zero rows.
**Why it happens:** `completeInProgressJob()` was written for the `session_end` happy path, where a job has already passed through `sessionAcked()`'s `status→'in_progress'` transition. The timeout/restart failure modes this phase targets happen *before* that transition — exactly why they're stuck.
**How to avoid:** The new `getInFlightJobs()` query (Pattern 2) must explicitly include both `'dispatched'` and `'in_progress'` in its `IN (...)` clause.
**Warning signs:** A recovery-path unit test that seeds a `'dispatched'` (not `'in_progress'`) row and expects it to be swept returns nothing.

### Pitfall 3: `SESSION_TIMEOUT_MS`/`NEXT_GUEST_COUNTDOWN_MS` default drift between two independent parse sites
**What goes wrong:** `queueService.ts` currently re-implements its own `parseInt(process.env.X || 'default', 10)` at two call sites (`beginAnnouncement()` line 103, `startBusyTimer()` line 136) `[VERIFIED: mirror-request/src/queue/queueService.ts:102-104,134-136]`, each hardcoding its own default literal (`'7000'`, `'300000'`) independently of `config.ts`'s `toNum('SESSION_TIMEOUT_MS', 300_000)` `[VERIFIED: mirror-request/src/config.ts:94]`. The two `300000`/`300_000` defaults happen to agree today, but nothing enforces that — this is exactly the class of bug Phase 1's Pitfall 4 (`DB_PORT` 5432-vs-3306 drift) already demonstrated in this same codebase.
**Why it happens:** Historical: `queueService.ts` predates the typed `EnvConfig` extension that added `SESSION_TIMEOUT_MS` there.
**How to avoid:** D-13's fix (Pattern 4) — route both values through the single `getConfig()` call, deleting the local `parseInt`/`process.env` reads entirely, not just adding a fallback path alongside them.
**Warning signs:** `.env` sets `SESSION_TIMEOUT_MS` but the booth still times out at 5 minutes (or vice versa) — a sign two different code paths are reading two different sources of truth.

### Pitfall 4: Timeout/NAK paths stamp semantically wrong timestamp fields
**What goes wrong:** `startBusyTimer()`'s timeout callback calls `updateJobStatus(jobId, 'queued', 'acknowledged_at', Date.now())` `[VERIFIED: mirror-request/src/queue/queueService.ts:136-141]` — this writes the *current* time into `acknowledged_at` even though the job was **never actually acknowledged** (that's the whole reason it timed out). Similarly, `onAgentAck(ok=false)` (NAK) writes `Date.now()` into `session_started_at` `[VERIFIED: mirror-request/src/queue/queueService.ts:76]` even though the session never started. Both pollute fields whose name implies "this really happened" with "we gave up waiting for this to happen."
**Why it happens:** `updateJobStatus()`'s signature forces every status transition to also write *some* timestamp field, and these two call sites picked the nearest-sounding existing field rather than adding a new one.
**How to avoid:** Since Phase 2 is already replacing the timeout path with `requeueWithRetry()` (Pattern 3, which does **not** take a `tsField` at all), this pollution is naturally removed for the `busyTimer`-timeout case. Flag the NAK path (`onAgentAck(ok=false)`) as a decision point for the planner: should it also stop writing `session_started_at`, and should a NAK also count toward `retries` (see Open Questions)?
**Warning signs:** A job's `acknowledged_at` is set but its `status` is `'queued'` (contradictory — "acknowledged" jobs shouldn't be waiting) or its history shows `session_started_at` set on a job that later shows zero Agent-side session evidence.

### Pitfall 5: `queueService.ts`'s local logger bypasses the masked Winston pipeline
**What goes wrong:** `queueService.ts` defines its own tiny logger wrapping `console.debug`/`console.info` `[VERIFIED: mirror-request/src/queue/queueService.ts:173-176]`, entirely separate from `logging/logger.ts`'s Winston instance, which is the only pipeline that runs every message through `mask()` and writes to the rotated file transport `[VERIFIED: mirror-request/src/logging/logger.ts:16-26,48-56]`. `.planning/codebase/CONVENTIONS.md` already flags this: "Winston is normal service logging, but `queueService.ts` currently wraps `console`." D-05's exhausted-retry warning and D-07's stall-reason warning are new log statements this phase adds — if they go through the existing local `logger` object, they print to stdout only, never reach the rotated `logs/extension-service-%DATE%.log` file, and never get PII-masked (not a live risk today since queue logs don't carry email/phone, but inconsistent with the rest of the codebase's logging discipline).
**Why it happens:** `queueService.ts` predates the Winston setup, or was never migrated.
**How to avoid:** Not one of D-01..D-13 explicitly, but strongly recommended alongside D-13's config fix: replace the local `logger` object with `labelLogger('queue')` from `logging/logger.ts`, matching `index.ts`'s `labelLogger('server')` pattern `[VERIFIED: mirror-request/src/index.ts:17]`. Flag for planner discretion if considered out of the phase's literal scope.
**Warning signs:** Retry/stall warnings appear in `console`/PM2 logs but never in `logs/extension-service-*.log`.

### Pitfall 6: `BoothState` type declares a fourth value, `'TIMEOUT_RESET'`, that is never written anywhere
**What goes wrong:** `export type BoothState = 'IDLE' | 'ANNOUNCING' | 'BUSY' | 'TIMEOUT_RESET';` `[VERIFIED: mirror-request/src/types.ts:1]` — a grep across `src/` and `test/` for `TIMEOUT_RESET` returns only this one declaration; no code path ever sets `booth_state.state` to that value (`setBoothTimeout()` writes `'IDLE'` directly `[VERIFIED: mirror-request/src/state/localStore.ts:232-235]`). BTH-02's requirement text itself says "auto-reset IDLE," matching current behavior, not a distinct transitional state.
**Why it happens:** Likely an earlier design intent (a visible "just timed out" state for the display) that was never wired up.
**How to avoid:** Do not treat this as a state the recovery logic must produce or transition through — D-09/D-10's transition table (above) should stay 3-state (`IDLE`/`ANNOUNCING`/`BUSY`) matching what's actually implemented and what CONTEXT.md's decisions describe. If the planner wants a distinct display-visible "timeout just happened" moment, that's new scope beyond D-01..D-13 and should be called out explicitly, not assumed from the dead type.
**Warning signs:** Code or tests referencing `'TIMEOUT_RESET'` as a value `booth_state.state` can actually hold — it currently cannot.

### Pitfall 7: Booth state is one global SQLite row — tests that don't isolate the DB will interfere with each other
**What goes wrong:** `booth_state` has a `CHECK (id = 1)` constraint — there is exactly one row, ever, for the whole database file `[VERIFIED: mirror-request/src/state/localStore.ts:64-68]`. `.planning/WINDOWS.md` ledger item 4 (open) documents that several existing test files call `getStore()` (the singleton) rather than `new LocalStore(dbPath)` (the constructor seam), so they all share one SQLite file and race under Vitest's default parallel-worker execution. For Phase 1's ingestion tests this caused an intermittent flaky assertion (~2/16 runs); for Phase 2, two vitest files both driving the *single* `booth_state` row concurrently (one setting it BUSY while another asserts it's IDLE) is a much sharper collision, not just an occasional flake.
**Confirmed this session:** `test/queue-countdown.test.ts` already avoids the problem entirely by not touching real SQLite at all — it hand-builds a `store` object mock with an in-memory `booth` variable and casts it `as unknown as LocalStore` `[VERIFIED: mirror-request/test/queue-countdown.test.ts:13-31]`. `test/db-poller.test.ts` avoids it a different way — by using the `constructor(dbPath?)` seam with a fresh `fs.mkdtempSync` temp directory per test file `[VERIFIED: mirror-request/test/db-poller.test.ts:36-39]`.
**How to avoid:** For Phase 2's new tests, prefer `test/queue-countdown.test.ts`'s pattern (fully mocked `LocalStore`, combined with `vi.useFakeTimers()`) for pure state-machine/timer-transition tests — this is fast and has zero cross-file interference by construction. For tests that need to exercise real `LocalStore` SQL (e.g., proving `requeueWithRetry()` genuinely preserves `queued_at`, or that `getInFlightJobs()`'s `ORDER BY dispatched_at DESC` is correct against real rows), use `db-poller.test.ts`'s pattern: `new LocalStore(path.join(mkdtempSync(...), 'test.sqlite'))`, never `getStore()`. **Recommendation for the planner:** given booth state's single-row exposure is sharper than anything Phase 1 tested, this phase should NOT reuse `getStore()` in any new test file, even though WINDOWS.md ledger item 4 (isolating the shared test DB globally) remains formally undecided/deferred — Phase 2 can and should just avoid the singleton locally without resolving the global ledger item.
**Warning signs:** A Phase 2 test passes alone (`npx vitest run test/queue-recovery.test.ts`) but fails intermittently in the full suite (`npm test`) — the signature of cross-file `booth_state` interference.

## Code Examples

### Verifying the live defect's exact numbers (reproducible against the real DB, read-only)
```typescript
// Run from mirror-request/ — read-only, does not touch the DB.
// Source: this research session, verified live 2026-08-10T09:41Z
const Database = require('better-sqlite3');
const db = new Database('data/extension-service.sqlite', { readonly: true });
db.prepare('SELECT * FROM booth_state').all();
// → [{ id: 1, state: 'BUSY', updated_at: '2026-08-10T04:29:42.732Z' }]
db.prepare(`SELECT id, status, dispatched_at, acknowledged_at, retries, stall_reason
            FROM queue_job WHERE status IN ('dispatched','in_progress')`).all();
// → 4 rows, all status='dispatched', all acknowledged_at=NULL, all retries=0
```

### Fake-timer test pattern to extend for D-01..D-04 (recovery) and D-05..D-07 (retry)
```typescript
// Source: mirror-request/test/queue-countdown.test.ts:1-53 (existing pattern,
// verbatim structure) — extend with a fake `getBoothStateDetailed` returning a
// controllable `updated_at`, and drive `Date.now()` via vi.useFakeTimers()
// (which also mocks Date — confirmed via WebSearch, vitest.dev/api/vi.html
// cross-check [CITED, MEDIUM confidence]) to deterministically simulate "age
// exceeds SESSION_TIMEOUT_MS" without a real 5-minute wait.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueService } from '../src/queue/queueService';

describe('recover() — startup reconciliation', () => {
  afterEach(() => vi.useRealTimers());

  it('resets a BUSY booth to IDLE and requeues the in-flight job when age exceeds timeout', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T09:41:38.189Z')); // mirrors the real observed "now"
    const store = {
      getBoothStateDetailed: () => ({ state: 'BUSY', updated_at: '2026-08-10T04:29:42.732Z' }),
      getInFlightJobs: () => [{ id: 'registration-20260806-04431', retries: 0 }],
      setBoothIdle: vi.fn(),
      requeueWithRetry: vi.fn().mockReturnValue({ retries: 1 }),
      failJob: vi.fn(),
      // ...remaining LocalStore surface stubbed as needed
    };
    const service = new QueueService(store as any, { SESSION_TIMEOUT_MS: 300_000, SESSION_MAX_RETRIES: 2, NEXT_GUEST_COUNTDOWN_MS: 7000 });
    service.recover();
    expect(store.setBoothIdle).toHaveBeenCalled();
    expect(store.requeueWithRetry).toHaveBeenCalledWith('registration-20260806-04431');
  });
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Unlimited retry (today: timeout always requeues, forever) | Bounded retry (`SESSION_MAX_RETRIES`, default 2) + terminal `failed` status | This phase (D-05/D-07) | Matches the general job-queue "bounded stalled-recovery count" pattern (e.g., BullMQ's `maxStalledCount`, default 1) that exists specifically to stop one poisoned job from looping forever `[CITED, MEDIUM confidence — WebSearch cross-check against BullMQ stalled-job docs]` |
| In-memory-only timeout safety net | Persisted-state-anchored recovery (age from `booth_state.updated_at`) | This phase (D-01..D-04) | Standard "treat the DB as external source of truth, not process memory" pattern for durable job queues `[CITED, MEDIUM confidence — WebSearch cross-check]`; this project already follows this convention everywhere else (`LocalStore` for all durable state) — Phase 2 closes the one place `queueService.ts` didn't |

**Deprecated/outdated:**
- The pattern of writing timeout/NAK outcomes into semantically-unrelated timestamp columns (`acknowledged_at` on a timeout, `session_started_at` on a NAK — Pitfall 4) should not be extended to any new transition this phase adds; the new `requeueWithRetry()`/`failJob()` methods deliberately do not take a `tsField` parameter at all.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Recovery should sweep ALL `status IN ('dispatched','in_progress')` rows, not just the one matching `booth_state.updated_at` | Live Defect / Pattern 2 / Pitfall 1 | This is inferred from the live data (3 of 4 stuck rows predate the current booth_state row) plus CONTEXT.md's stated acceptance signal ("the 4 stale dispatched jobs resolve"), not from D-01/D-02's literal text alone, which only says "its in-flight job" (singular). If the intended scope is narrower (only fix the one job tied to the current booth_state row, treat the 3 August-6 orphans as a separate manual-cleanup concern), the recovery method's query should be scoped down and the 3 old rows handled by a one-time manual `UPDATE`/script instead of code. Low implementation cost either way — flag for planner/discuss confirmation. |
| A2 | A NAK (`onAgentAck(ok=false)`) should NOT count toward `SESSION_MAX_RETRIES` — only silent timeouts (no ack, no NAK, no session_end within `SESSION_TIMEOUT_MS`) should | Full Transition Table / Pitfall 4 | D-05's wording ("A timed-out job returns to the queue and increments retries") describes the `busyTimer`-expiry path specifically; it's silent on the NAK path, which already has its own immediate-requeue behavior today. If NAK should also be retry-bounded (an Agent that immediately NAKs every dispatch could otherwise loop forever, same class of problem D-05 solves for silent timeouts), the planner should extend `handleStall()`'s reuse to the NAK branch too. Flagged as an open design question below, not assumed either way in the Code Examples. |
| A3 | `SESSION_MAX_RETRIES` and `NEXT_GUEST_COUNTDOWN_MS` should be added to `EnvConfig`/`config.ts` using the same `toNum(key, fallback)` helper already used for every other numeric config value | Pattern 4 | Very low risk — this is a direct, mechanical extension of an existing, uniform pattern (`config.ts:10-19`); no plausible alternative reading. |
| A4 | `QueueJob.status`'s TypeScript type stays a bare `string` (not narrowed to a union) even though this phase adds a new `'failed'` value | Full Transition Table | `types.ts` currently declares `status: string` with no union `[VERIFIED: mirror-request/src/types.ts:16]`; narrowing it to a union (`'queued' | 'dispatched' | 'in_progress' | 'completed' | 'failed'`) would be a stricter, arguably better change but touches every existing string comparison against `.status` across the codebase (a larger diff than this phase's stated scope). Recommend leaving the type as `string` and documenting the vocabulary in a comment, unless the planner explicitly wants the stricter typing as part of this hardening pass. |

## Open Questions (RESOLVED)

> All three were resolved by the orchestrator before planning, on 2026-08-10. The resolutions
> are recorded inline below and are implemented in the plans — see 02-01-PLAN.md's
> "Resolved by the orchestrator before planning" note. Nothing here is still open.

1. **Should a NAK (`onAgentAck(ok=false)`) also be retry-bounded under `SESSION_MAX_RETRIES`, or does it stay unlimited-retry as it is today?**
   - **RESOLVED — yes, bounded, same budget as a timeout.** Leaving NAK unbounded reproduces
     exactly the poison-job problem D-05/D-07 exist to prevent: an Agent with a persistent
     hardware fault would NAK forever and hold the queue. Implemented in 02-02 by routing the
     NAK branch through the same `handleStall()` helper.
   - What we know: D-05's language targets the timeout path explicitly. The NAK path already requeues immediately today with no bound.
   - What's unclear: Whether an Agent that NAKs every dispatch (e.g., a persistent local hardware fault) should eventually also produce a `failed` job with `stall_reason`, the same protection D-07 gives the silent-timeout case.
   - Recommendation: Confirm during planning; if in scope, `onAgentAck(ok=false)` should call the same `handleStall()` helper (Pattern 3) instead of its current bespoke `updateJobStatus(...)` call.

2. **Does the retry-exhaustion warning (D-07) need to go through the masked Winston `logger`, or is the existing local `console`-wrapping logger acceptable for this phase?**
   - **RESOLVED — required, not discretionary.** This research framed it as a consistency
     question; it is stronger than that. The local logger at `queueService.ts:173-176` defines
     only `debug` and `info` — it has **no `warn` method at all**. M2 success criterion 5 and
     D-07 both require a warning, so without this fix the phase cannot satisfy its own success
     criterion. Implemented in 02-01 by swapping in `labelLogger('queue')`.
   - What we know: `.planning/codebase/CONVENTIONS.md` already flags `queueService.ts`'s console-wrapping as a known deviation from the rest of the codebase (Pitfall 5). Neither `stall_reason` nor retry counts are PII, so masking isn't a security requirement here — this is a consistency question, not a security one.
   - What's unclear: Whether fixing this incidentally (while D-13 already touches this file's logging surface for config) is in scope, or should be left for a future cleanup pass.
   - Recommendation: Low-risk either way; flag for planner discretion, lean toward fixing it since the file is already being touched for D-13 and the change is small (swap one import, no behavior change to any existing log message).

3. **Should the three orphaned August-6 `queue_job` rows be resolved purely by code (the general sweep, Pattern 2) or does the operator need a one-time manual note in `docs/OPS-RUNBOOK.md` documenting that this specific historical incident was cleared by the Phase 2 fix?**
   - **RESOLVED — code only; no per-incident note.** A note about three specific rows rots the
     moment the sweep clears them. What goes in `OPS-RUNBOOK.md` instead is durable: how to
     inspect stuck jobs and what each `stall_reason` value means. Implemented in 02-03.
   - What we know: Phase 1 established the precedent of documenting operationally-relevant facts in `OPS-RUNBOOK.md` (e.g., manual retention policy, D-14).
   - What's unclear: Whether this phase's recovery fix, once shipped, should also add a short note to `OPS-RUNBOOK.md` about the sweep-on-startup behavior (so a future operator understands why old `dispatched` rows can silently flip to `failed` on the next deploy).
   - Recommendation: Low-cost, recommend adding a short paragraph to `OPS-RUNBOOK.md` alongside the Phase 2 implementation, consistent with Phase 1's pattern of using that file as the durable "what does this system actually do" reference for operators.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Runtime | ✓ | v24.15.0 in this research sandbox (project pins `20.x`) `[VERIFIED: node --version this session]` | Deployment target should use Node 20 LTS per `CLAUDE.md`/`package.json engines`; same sandbox-vs-deploy caveat Phase 1 flagged, not a Phase 2-specific concern |
| `better-sqlite3` native module | All queue/booth persistence | ✓ (loads and queries the live production DB successfully) | 11.10.0 `[VERIFIED this session]` | — |
| `vitest` (with fake timers) | Deterministic testing of the 250ms tick loop, ANNOUNCING countdown, `busyTimer` | ✓ | 2.1.9 `[VERIFIED: npx vitest --version this session]` | — |
| Live production SQLite file (`data/extension-service.sqlite`) | Confirming/reproducing the restart defect against real data | ✓ (read-only access confirmed this session) | — | — |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** none — this phase needs nothing beyond what's already installed and already verified working.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest ^2.1.4, running 2.1.9 `[VERIFIED: mirror-request/package.json:42, npx vitest --version this session]` |
| Config file | `mirror-request/vitest.config.ts` — includes `src/**/*.{test,spec}.*` and `test/**/*.{test,spec}.*`; sets a dedicated `LOCAL_STORE_PATH: './data/test-extension-service.sqlite'` distinct from the production file, plus fixed `AGENT_WS_TOKEN`/`DB_PASSWORD`/`WEBHOOK_HMAC_SECRET` for hermetic config validation `[VERIFIED: mirror-request/vitest.config.ts:1-15]` |
| Quick run command | `cd mirror-request && npx vitest run test/queue-countdown.test.ts` (or the new recovery/retry test file) |
| Full suite command | `cd mirror-request && npm test` (runs `vitest run`) — **measured this session: 11 files, 69 tests, 2.70s wall time** `[VERIFIED: npm test run this session, all 69 passing]` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|---------------------|--------------|
| QUE-01 | FIFO order preserved through a retry (requeued job returns to original position, not the back) | unit (mocked `LocalStore`, matches `queue-countdown.test.ts` style) | `npx vitest run test/queue-fifo-retry.test.ts` | ❌ Wave 0 |
| QUE-02/D-11/D-12 | A requeue under the retry path cannot create a second `queue_job` row for one registration | integration (real `LocalStore` via `constructor(dbPath?)` seam, temp dir — matches `db-poller.test.ts` style) | `npx vitest run test/queue-idempotency.test.ts` | ❌ Wave 0 |
| QUE-03/BTH-01 | IDLE + queued job → ANNOUNCING → BUSY, full transition sequence | unit (fake timers, mocked store — extend `queue-countdown.test.ts`) | `npx vitest run test/queue-countdown.test.ts` | ✅ existing, extend |
| QUE-04 | session_end → IDLE → auto-dispatch next | unit (fake timers, mocked store) | `npx vitest run test/queue-countdown.test.ts` | ✅ existing, extend |
| BTH-02/D-05/D-06/D-07 | BUSY > SESSION_TIMEOUT_MS (live, no restart) → retry with preserved `queued_at`, then `failed` after `SESSION_MAX_RETRIES` exhausted | unit (fake timers, mocked store, `vi.advanceTimersByTime()`) | `npx vitest run test/queue-timeout-retry.test.ts` | ❌ Wave 0 |
| D-01/D-02 | Startup recovery: BUSY booth, age ≥ `SESSION_TIMEOUT_MS` → IDLE + all in-flight jobs (plural — Pitfall 1) resolved under retry policy | unit (mocked store, `vi.setSystemTime()`) + integration (real `LocalStore`, seeded rows reproducing the live 4-row scenario) | `npx vitest run test/queue-recovery.test.ts` | ❌ Wave 0 |
| D-03 | Startup recovery: BUSY booth, age < `SESSION_TIMEOUT_MS` → stays BUSY, `busyTimer` re-armed for the remainder | unit (mocked store, fake timers) | `npx vitest run test/queue-recovery.test.ts` | ❌ Wave 0 |
| D-04 | Startup recovery: ANNOUNCING booth → IDLE, job untouched, re-announced by next tick | unit (mocked store, fake timers) | `npx vitest run test/queue-recovery.test.ts` | ❌ Wave 0 |
| D-13 | `queueService.ts` reads `SESSION_TIMEOUT_MS`/`NEXT_GUEST_COUNTDOWN_MS` from injected `EnvConfig`, not `process.env` | unit (construct `QueueService` with an explicit config object, assert behavior matches the injected values, not `process.env`) | `npx vitest run test/queue-config-injection.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** targeted `npx vitest run <file>` for the file(s) touched
- **Per wave merge:** `cd mirror-request && npm test` (full suite — currently 69 tests, ~2.7s, cheap enough to run every merge)
- **Phase gate:** Full suite green before `/gsd-verify-work`; additionally, a manual (or scripted, read-only-safe) re-check of the live production DB's `booth_state`/`queue_job` rows after the fix ships and the service restarts, since this phase's whole premise is a defect only observable against real persisted state, not just unit-test mocks

### Wave 0 Gaps
- [ ] `mirror-request/test/queue-recovery.test.ts` — covers D-01..D-04 (both mocked-store unit style and a real-`LocalStore` integration case seeded to reproduce the exact live 4-row scenario captured in this research)
- [ ] `mirror-request/test/queue-timeout-retry.test.ts` — covers D-05..D-07 (live busyTimer path)
- [ ] `mirror-request/test/queue-fifo-retry.test.ts` — covers D-06's explicit `queued_at`-preservation guarantee
- [ ] `mirror-request/test/queue-idempotency.test.ts` — covers D-12's requeue-cannot-duplicate guarantee
- [ ] `mirror-request/test/queue-config-injection.test.ts` — covers D-13
- [ ] No framework install needed — `vitest` with fake timers already covers every test type this phase needs

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|----------------|---------|--------------------|
| V2 Authentication | No | This phase touches no authentication surface (Agent WS auth is Phase 3, AGT-01/AUTH-01) |
| V3 Session Management | No (in the ASVS web-session sense) — "session" here means a photobooth capture session, not an HTTP session | — |
| V4 Access Control | No new surface | `/status/:jobId` (existing, unauthenticated by design per current scope) is unaffected by this phase's internal queue/booth changes |
| V5 Input Validation | Marginal | `queue_job.retries`/`stall_reason` are written only from server-computed values (a counter increment, a fixed set of internal reason strings) — never from external/guest input, so no new injection surface |
| V6 Cryptography | No | Not applicable to this phase |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|-----------------------|
| SQL injection in new recovery/retry queries | Tampering | `better-sqlite3` prepared statements only, matching every existing `LocalStore` method (Don't Hand-Roll table) — the new `getInFlightJobs()`/`requeueWithRetry()`/`failJob()` methods take no unsanitized string interpolation |
| Denial of service via one guest's session poisoning the whole queue | Denial of Service | This is precisely what D-05/D-07's bounded retry + `failed` terminal state exists to prevent — one broken job now provably cannot block the queue past `SESSION_MAX_RETRIES` attempts, closing an availability gap that exists in the *current* unbounded-retry code today |
| Log injection / inconsistent PII exposure via new retry/stall log lines | Information Disclosure | `stall_reason` values should be fixed, server-authored strings (e.g. `'restart_recovery_timeout'`, `'session_ack_timeout'`), never guest-supplied text, and routed through the masked Winston pipeline if Pitfall 5's recommendation is adopted |

## Sources

### Primary (HIGH confidence — read directly this session)
- `mirror-request/src/queue/queueService.ts` — the entire existing state machine, timer lifecycle, dispatch/ack/timeout logic
- `mirror-request/src/state/localStore.ts` — existing SQLite schema, prepared statements, `booth_state`/`queue_job` methods
- `mirror-request/src/config.ts`, `mirror-request/src/types.ts` — existing typed config, `EnvConfig`, `BoothState`, `QueueJob`
- `mirror-request/src/index.ts` — composition root, startup/shutdown sequencing
- `mirror-request/src/agent/agentServer.ts`, `mirror-request/src/notifications/notificationService.ts`, `mirror-request/src/display/displayServer.ts` — established config-injection and store-injection precedents
- `mirror-request/src/logging/logger.ts` — Winston/mask() pipeline `queueService.ts` currently bypasses
- `mirror-request/src/ingestion/dbPoller.ts` — Phase 1's alternative (explicit-param) config-injection precedent, for contrast with D-13's chosen pattern
- `mirror-request/test/queue-countdown.test.ts`, `mirror-request/test/db-poller.test.ts` — the two existing, contrasting test-isolation patterns (full mock vs. `constructor(dbPath?)` temp-dir seam)
- `mirror-request/data/extension-service.sqlite` — the **live production database**, queried read-only this session (`booth_state`, `queue_job`, `PRAGMA table_info`) to independently re-verify the defect and confirm no schema migration is needed
- `mirror-request/CLAUDE.md`, `mirror-request/docs/OPS-RUNBOOK.md`, `mirror-request/package.json`, `mirror-request/vitest.config.ts`
- `.planning/phases/02-queue-booth-state/02-CONTEXT.md`, `.planning/REQUIREMENTS.md`, `.planning/STATE.md`, `.planning/ROADMAP.md` (Phase 2 section), `.planning/WINDOWS.md`, `.planning/config.json`
- `.planning/phases/01-foundation-ingestion/01-CONTEXT.md`, `.planning/phases/01-foundation-ingestion/01-RESEARCH.md` — inherited decisions and established structure/depth to match
- `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/CONVENTIONS.md` — system topology and confirmed conventions (config injection, `LocalStore`-only persistence, `queueService.ts`'s console-logging deviation)
- Live command output this session: `node --version`, `better-sqlite3` version + live query, `npx vitest --version`, full `npm test` run (69/69 passing, 2.70s), `git log -p vitest.config.ts` (confirms when test-DB isolation for `LOCAL_STORE_PATH` was introduced, in the same commit as Phase 1's HMAC work)

### Secondary (MEDIUM confidence — WebSearch cross-checked)
- Job-queue crash-recovery / stalled-job patterns (BullMQ "stalled jobs" documentation and cross-referenced blog posts) — general shape of lock/lease + bounded-recovery-count patterns, used only to validate that this phase's simpler one-shot `recover()` approach is proportionate for a single-booth system, not to import any BullMQ-specific mechanism
- Vitest `vi.useFakeTimers()` behavior (vitest.dev/api/vi.html, cross-referenced dev.to/blog sources) — confirms fake timers also mock `Date`, which is load-bearing for testing the age-based recovery calculation deterministically

### Tertiary (LOW confidence)
- None retained as authoritative — all WebSearch findings above were cross-checked across multiple independent results before being tagged `[CITED]`/MEDIUM, matching Phase 1's sourcing bar.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies; all versions verified live this session (`better-sqlite3`, `vitest`) against the actual installed modules
- Architecture: HIGH — every claim about current behavior is grounded in source read this session with cited line numbers, and the live defect's exact mechanics were independently re-verified against the real production SQLite file (not just taken from CONTEXT.md's summary)
- Pitfalls: HIGH for pitfalls 1-4, 6-7 (directly verified against source code and live data); MEDIUM for pitfall 5's recommendation (a judgment call, not a locked decision) and Open Question 1-3 items (explicitly flagged as needing planner/discuss confirmation, not verified facts)

**Research date:** 2026-08-10
**Valid until:** 2026-09-09 (30 days — stable domain, single-service internal logic; re-verify sooner only if the live production `booth_state`/`queue_job` rows are manually altered before this phase ships, which would invalidate the "Live Defect — Verified This Session" numbers as a reproduction case)
