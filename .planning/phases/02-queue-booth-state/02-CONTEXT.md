# Phase 2: Queue & Booth State - Context

**Gathered:** 2026-08-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Own the ordering and dispatch of registrations that Phase 1 already ingested: a
global FIFO queue, the booth state machine, the command that sends a job to the
Agent, and the safety net that stops a dead session from blocking every guest
behind it.

Out of this phase: the WebSocket transport, token auth and heartbeat that carry
the dispatch command (Phase 3); photo delivery to the guest (Phase 4); the
guest-facing status API and the display feed (Phase 5).

**This is a hardening pass over working code, not greenfield.**
`src/queue/queueService.ts` (195 lines) already exists and is fully wired into
`src/index.ts`. Planning must audit it rather than assume an empty file.

</domain>

<decisions>
## Implementation Decisions

### Restart recovery — the booth must never be permanently stuck

Motivating evidence, observed in the live database during this discussion (not
hypothetical): `booth_state` has read `BUSY` since `2026-08-10T04:29:42Z`, with
4 jobs stranded in `dispatched` and 1 guest (`job-webhook-001`) queued behind
them, unreachable.

Root cause: `startBusyTimer()` holds the session timeout in an in-memory
`setTimeout`, while `booth_state` is persisted to SQLite. A restart destroys the
timer but not the state. `start()` only resumes the 250 ms tick, and `tick()`
returns immediately while `booth !== 'IDLE'` — so a booth that was BUSY at
shutdown stays BUSY forever.

- **D-01:** On startup the service MUST reconcile persisted booth state against
  wall-clock age before serving. Age is `now - booth_state.updated_at`, which for
  a BUSY booth is the dispatch moment.
- **D-02:** If age exceeds `SESSION_TIMEOUT_MS`, the session is dead: reset the
  booth to IDLE and return its in-flight job to the queue under the retry policy
  in D-05..D-07.
- **D-03:** If age is within `SESSION_TIMEOUT_MS`, the session may still be live:
  keep the booth BUSY and re-arm the timer with only the remaining time
  (`SESSION_TIMEOUT_MS - age`), so a restart does not grant a stuck session a
  fresh full timeout.
  — **Reversibility:** costly — this changes whether a real in-progress photo
  session survives a service restart.
- **D-04:** A booth found in `ANNOUNCING` at startup resets to IDLE and is
  re-announced by the normal tick. The countdown is only 5–10 s, so restoring a
  partial countdown is not worth the complexity.

**Rationale for the age-based reading over the two simpler alternatives:**
always resetting to IDLE risks dispatching a second job on top of a session the
Agent is genuinely running; always waiting for the Agent reproduces exactly the
deadlock observed above whenever the Agent dies with the service. Age is the
only signal available locally that distinguishes the two.

### Timeout policy — optimized for the waiting guest

Decided by the agent at the user's explicit request ("choose what is optimal,
especially for user experience").

- **D-05:** A timed-out job returns to the queue and increments `queue_job.retries`
  (column already exists, currently unused). It is retried up to
  `SESSION_MAX_RETRIES` times, default 2 (3 dispatch attempts total), configurable.
- **D-06:** A requeued job MUST retain its original `queued_at`. Because
  `getNextQueuedJob()` orders by `queued_at ASC`, this returns the guest to their
  original position rather than the back of the line. A guest must never be
  demoted for a fault that was the system's, not theirs. This behavior is currently
  implicit — `updateJobStatus()` happens not to touch `queued_at` — and must become
  an explicit, tested guarantee.
- **D-07:** Once retries are exhausted, the job is marked `failed`, the reason is
  written to `queue_job.stall_reason` (column already exists, currently unused),
  a warning is logged, and **the queue advances to the next guest**. One broken
  job must never hold the whole queue hostage.
- **D-08:** Notifying a guest whose session failed is out of scope here — the
  delivery channel is Phase 4. Phase 2's obligation is to record `stall_reason`
  precisely enough that an operator, or a later phase, can act on it.

**Rationale:** unlimited retry (today's behavior) lets one poisoned job block
every guest behind it forever; failing on the first timeout throws away a guest
over a transient glitch. A small bounded retry that preserves queue position
loses neither.

### Booth state machine

- **D-09:** `ANNOUNCING` is promoted to a first-class third state alongside
  IDLE and BUSY, with explicit transitions and its own timeout. It already runs
  in production and already gates dispatch timing; leaving it out of the
  specified state machine is how the restart bug above came to exist.
- **D-10:** The full legal transition set, the trigger for each, and what happens
  to the in-flight job on each transition must be specified and tested — including
  the transitions that fire on startup recovery (D-01..D-04).

### Idempotency (QUE-02)

- **D-11:** QUE-02 is already satisfied structurally: ingestion-level dedup landed
  in Phase 1 (D-01..D-03 there, plus the `processed_id` table), and
  `enqueueJob()` uses `INSERT OR IGNORE`. Phase 2 adds **no new dedup code**.
- **D-12:** Phase 2 owes an end-to-end test proving one registration can never
  produce two queue jobs, including under the retry path in D-05 — a requeue must
  not be able to create a second row.

### Configuration

- **D-13:** `queueService.ts` reads `process.env` directly in two places
  (`NEXT_GUEST_COUNTDOWN_MS` at line 103, `SESSION_TIMEOUT_MS` at line 136).
  These move to the typed `EnvConfig` surface, matching what Phase 1 established
  when it removed the same anti-pattern from `dbPoller.ts`. `SESSION_TIMEOUT_MS`
  is already declared in `config.ts`; the queue simply is not reading it.

### The agent's Discretion

- The exact startup-reconciliation mechanism (a dedicated `recover()` method
  versus folding it into `start()`), provided it runs before the first tick and
  is unit-testable without a real restart.
- How `SESSION_MAX_RETRIES` is surfaced in logs.
- Whether the ANNOUNCING timeout gets its own config key or reuses the existing
  countdown bounds.

</decisions>

<specifics>
## Specific Ideas

The guest-facing promise this phase protects is PROJECT.md's Core Value: *"mỗi
khách đăng ký đều được phục vụ đúng thứ tự, không bỏ lỡ đăng ký nào"* — every
guest served in order, none dropped. Both failure modes this phase fixes are
direct violations: a stuck booth drops everyone, and requeueing to the back of
the line breaks the ordering promise.

The stranded rows currently in the database are a live test fixture. After
startup recovery lands, the first boot should sweep them: the 4 stale
`dispatched` jobs resolve under D-02, and `job-webhook-001` finally dispatches.
That is a concrete acceptance signal worth using.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Product scope and requirements

- `.planning/PROJECT.md` — Core Value, MVP scope, and the explicit out-of-scope
  note that a distributed queue is not needed (single booth).
- `.planning/REQUIREMENTS.md` — QUE-01..04 and BTH-01..02.
- `.planning/ROADMAP.md` §"### Phase 2: Queue & Booth State" — the five M2
  success criteria.

### Decisions inherited from Phase 1

- `.planning/phases/01-foundation-ingestion/01-CONTEXT.md` — D-01..D-03
  (ingestion dedup, which settles QUE-02), D-05 (warn-and-retry rather than
  killing the process), D-15 (masked logs).
- `.planning/phases/01-foundation-ingestion/01-VERIFICATION.md` — what Phase 1
  actually delivered, verified against source.

### Codebase and operations

- `.planning/codebase/ARCHITECTURE.md` — system topology and data flow.
- `.planning/codebase/CONVENTIONS.md` — config, storage, error and logging patterns.
- `mirror-request/CLAUDE.md` — project hard rules.
- `mirror-request/docs/OPS-RUNBOOK.md` — production env vars and the unbounded-growth
  tables an operator must prune.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- `mirror-request/src/queue/queueService.ts` — the whole phase already exists in
  draft: 250 ms tick, `beginAnnouncement()`, `dispatchJob()`, `startBusyTimer()`,
  `sessionEnded()`, `onAgentAck()`, `onAgentEvent()`. Audit, do not rewrite.
- `mirror-request/src/state/localStore.ts` — `getBoothState()`,
  `getBoothStateDetailed()` (already returns `updated_at`, which D-01 needs),
  `setBoothBusy/Idle/State/Timeout()`, `getNextQueuedJob()`,
  `completeInProgressJob()`, `getQueuePosition()`, `getQueueLength()`.
- `queue_job.retries` and `queue_job.stall_reason` — both columns exist in the
  schema and are currently written by nothing. D-05 and D-07 give them their
  first use; no migration needed.
- `mirror-request/src/config.ts` — `SESSION_TIMEOUT_MS` is already parsed and
  defaulted to 300 000; the queue just never reads it.

### Established Patterns

- Phase 1 removed direct `process.env` reads from `dbPoller.ts` in favour of a
  typed config object passed to the constructor. D-13 applies the same treatment
  to `queueService.ts`.
- Failure posture is warn-and-continue, never crash the process (Phase 1 D-05).
- All durable state goes through `LocalStore` prepared statements.

### Integration Points

- Startup reconciliation (D-01..D-04) hooks into `src/index.ts` before
  `queue.start()`.
- `QueueService` already binds to the Agent via `bindSendCommand()` and to
  notifications via `bindNotificationService()` — Phase 2 must not change those
  seams, since Phase 3 and Phase 4 own them.

### Test-suite caveat (inherited) — corrected 2026-08-10

`.planning/WINDOWS.md` ledger item 4 is open, but its original wording was wrong
and is corrected here. The suite does **not** touch the production database:
`vitest.config.ts:12` already sets
`LOCAL_STORE_PATH=./data/test-extension-service.sqlite`, and the production file
is untouched (test DB holds 1457 `webhook_replay` rows; production holds 0).

The real, narrower defect: all test **files** share that one test DB through the
`getStore()` singleton rather than the `constructor(dbPath?)` seam, and vitest
runs files in parallel workers — so tests interfere across files. Measured at 3
failures in 10 full-suite runs before commit `e54e22e`.

Phase 2 tests must not assert on global counts or rely on cross-file isolation.
Queue tests are far more exposed than any Phase 1 test was, because `booth_state`
is a **single global row** — there is no per-test id to scope an assertion to.
Planning should decide whether giving each test file its own temp DB belongs in
this phase.

</code_context>

<deferred>
## Deferred Ideas

- Notifying a guest whose session failed after exhausted retries — needs the
  Phase 4 delivery channel; Phase 2 only records `stall_reason` (D-08).
- WebSocket transport, Agent token auth and heartbeat — Phase 3. Phase 2 dispatches
  through the existing `sendCommandCb` seam without touching how it is carried.
- Guest-facing queue position API and the display feed — Phase 5.
- Multi-booth support and a distributed queue — explicitly out of scope per
  PROJECT.md.
- Isolating the test database from the production SQLite file — currently open
  ledger item 4; flagged above as a candidate for this phase, not yet committed.

</deferred>

---

*Phase: 02-queue-booth-state*
*Context gathered: 2026-08-10*
