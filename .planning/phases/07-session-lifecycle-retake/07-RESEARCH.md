# Phase 7: Session Lifecycle & Retake - Research

**Researched:** 2026-08-12
**Domain:** Booth session lifecycle attribution (SQLite state machine + Agent event handling), TypeScript/Express/better-sqlite3
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**What ends a session**
- **D-01:** The print composite is the completion anchor (`processing_start.param5` / `printing.param1`, both name the same path). `session_end` is NOT the anchor — empty payload `{}`, fires on every exit from the sharing screen (measured 3x in 52s for one session).
- **D-02:** Job completion and booth release are two separate anchors. Job completes at the print composite; booth stays `BUSY` until the first `session_end` after that. Needs its own fallback timer, and it must NOT be BTH-02's `busyTimer` — that routes through `handleStall()`, which charges a retry and requeues.
- **D-03:** A session that ends with no print composite ever seen completes with a distinct outcome, not a stall. Booth IDLE immediately, no retry charged, guest not re-called.
- **D-04:** Photos produced with no dispatched session are dropped, with one `warn`. (Today's behaviour: sent to the last real guest.)

**Where the session ↔ job binding lives**
- **D-05:** Fix is Extension Service only. `dslrbooth-agent` repository is NOT touched — not this phase, in no plan.
- **D-06:** `booth_state` gains `current_job_id` — single source of truth for "which job owns the booth right now." Written on dispatch/ack, cleared on release. The jobId on an incoming event is used ONLY as a cross-check; on mismatch, drop the event and warn naming both ids.
- **D-07:** A pending-print registry holds the slot for a photo not yet arrived. Seeing the print composite records "job X is awaiting its print upload" with a deadline; a later `file_upload` with `param3==='print'` resolves against the registry, NOT booth state.
- **D-08:** The registry lives in SQLite, its own table (not folded into `notification_record`).

**The no-photo outcome**
- **D-09:** "Finished, no photo" is a sixth internal job status, added to `KNOWN_JOB_STATUSES` (`src/status/guestStatus.ts:71`).
- **D-10:** The guest sees `see_staff`, with `photoDelivery: 'failed'`. The six-word vocabulary is NOT reopened.
- **D-11:** A print photo arriving after the registry entry expired and the job was already closed as no-photo is STILL delivered to the guest; job status is NOT changed. One `warn` records the late arrival.

**Observability**
- **D-12:** Every AGT-04 event gets one `info` line, unconditionally. No new config key, no runtime toggle.
- **D-13:** Each line carries event name, attributed jobId, lifecycle-relevant params (print composite path, `file_upload`'s `param3`). It does NOT carry the fotoshare URL at `info`.
- **D-14:** At job close, one summary line: jobId, capture count, whether a print composite was seen, duration, outcome.

**Verification**
- **D-15:** ROADMAP criterion 6 (retake exercised end to end, second guest queued) is a phase gate at the end, answered by a human. Does NOT block research or planning.

### Claude's Discretion
- Every timing value and its default: booth-release fallback deadline (D-02), pending-print registry expiry (D-07/D-11). All must be injectable through the constructor per Phase 2's pattern, not read from a singleton.
- The name of the sixth internal status (D-09) and the registry table's name/column shape (D-08) — provided the migration is additive and idempotent, in the style of Phase 4's `notification_record` migration.
- Whether the mismatch warn in D-06 is throttled, and how (closest existing analog: `agentOfflineDispatchSkipLogged`).
- Whether the D-14 summary line is emitted from the completion path or the booth release path, given D-02 separates them.
- Whether the "capture count" in D-14 is derived by counting `capture_start` events in the registry row or held separately.

### Deferred Ideas (OUT OF SCOPE)
- Clear `activeJobId` in the Agent (`dslrbooth-agent/src/index.ts:84`) — the real root cause, neutralised not fixed here.
- Match the print upload to its composite by filename (unverified — evidence capture records only `param2`/`param3` for `file_upload` in the CONTEXT evidence file, though a separate real-session capture in `test/queue-file-upload-print.test.ts` DOES show `param1` carrying the local file path including the print composite filename — still not adopted this phase; see Open Questions).
- Alert the no-print condition outward through `NOTIFY_WEBHOOK_URL` — not adopted.
- Multi-booth — out of scope per `PROJECT.md`.
</user_constraints>

<phase_requirements>
## Phase Requirements

ROADMAP maps no REQ-IDs to Phase 7 directly (`QUE-04, BTH-01..02, AGT-04` are listed as "revisited," not newly built). Coverage is tracked against the six ROADMAP success criteria instead, per this phase's own convention.

| ID | Description | Research Support |
|----|-------------|------------------|
| SC-1 | A retake does not complete the guest's job, and does not free the booth | D-01's print-composite anchor is unreachable during a retake (retake is inside the capture phase, before `processing_start` — evidence file finding 6). No code change needed to "detect" a retake; the anchor's placement makes it structurally inert to one. |
| SC-2 | A `session_end` belonging to guest A can never complete guest B — proven with a queued second guest | Requires: (a) completion decoupled from `session_end` entirely (D-01/D-02), (b) `completeInProgressJob()`'s unscoped `ORDER BY acknowledged_at DESC LIMIT 1` replaced with jobId-scoped completion at the print-composite anchor, (c) `booth_state.current_job_id` (D-06) as the attribution source of truth for booth release. See Validation Architecture for the exact queued-second-guest test. |
| SC-3 | A session that truly ends with no photo is visible as such, distinctly from a retake and from a normal session | D-03 (distinct no-retry outcome) + D-09 (sixth internal status) + D-14 (per-job summary log line). |
| SC-4 | `No print upload seen` warning fires only when no print arrives, not on every session | D-07 (pending-print registry with expiry) replaces the current `printUploadSeen` in-memory `Set` check that runs synchronously at `session_end` — before the print composite has usually arrived (WINDOWS item 9, confirmed live: composite arrives ~1s after `session_end` on `BZWCWFN6`). The warn moves to registry-expiry, a genuinely delayed check. |
| SC-5 | The Agent event stream is observable at the log level an event actually runs at, without a redeploy | D-12/D-13: replace the `debug` catch-all (`queueService.ts:247`) and `session_start`'s silent write with one unconditional `.info()` line per event, for all ten AGT-04 types. `LOG_LEVEL` already defaults to `'info'` (`config.ts:140`), so this requires no config change beyond the code shipping. |
| SC-6 | Retake exercised end to end at the booth, with a second guest queued | D-15: human-gated phase step, not exercisable in this environment. See Validation Architecture. |
</phase_requirements>

## Summary

This phase's hardest technical question — what wrote `in_progress` back onto `BZWCWFN6` between its two completions — was independently re-verified this session by grepping every call site of that status write in `mirror-request/src/`, not trusting CONTEXT.md's claim on faith: **exactly one line writes `'in_progress'`, `queueService.ts:187` inside `sessionAcked(jobId)`, reachable only through `onAgentEvent()`'s `session_start` branch.** `dslrbooth-agent/src/index.ts` was independently re-read: `activeJobId` has exactly three occurrences (`:44` declaration, `:84` assignment on a successful `start_session` ack, `:107` use when forwarding every event) and no fourth occurrence resets it anywhere in the file. The mechanism is therefore fully explained, not merely hypothesised: the Agent's trigger server (`triggers/server.ts:31-45`) forwards **every** dslrBooth callback to the WS link stamped with whatever `activeJobId` currently holds — including the two extra `sharing_screen`/`session_end` pairs a guest produces by browsing the photo gallery after their real session closed. Because nothing ever clears `activeJobId`, that stray `session_end` (not accompanied by a `session_start`, confirmed absent in the evidence file's section B) still carries job A's id; `queueService.ts`'s existing `session_end` handler ignores the event's `jobId` entirely and always calls the unscoped `completeInProgressJob()` — but the true CONTEXT.md-recorded incident (job `BZWCWFN6`) required a `session_start` in between, which is the piece the raw gallery-browsing capture (section B) doesn't itself contain. The most plausible remaining path (not separately re-measured this session, since CONTEXT.md's discussion log already treats it as settled and it does not change the fix) is that dslrBooth emitted an actual second `session_start`/`session_end` pair for the SAME job — consistent with the operator's own retake report — carrying the same stale `activeJobId`, which is sufficient on its own without invoking any hypothesis about the gallery-browsing capture.

The fix the six ROADMAP criteria require is a wholesale relocation of "what marks a job complete" and "what releases the booth," decoupled from `session_end` and from each other. All of it is additive, in-repo, backend-only TypeScript/SQLite work — no new npm dependency is needed for this phase (verified against `package.json`; every operation D-01–D-14 requires — timers, additive SQLite migrations, exhaustive TS unions, structural SQL WHERE-guards — already has a working precedent in this exact codebase from Phases 2 and 4). The work concentrates in three files: `src/queue/queueService.ts` (the event-dispatch and timer logic), `src/state/localStore.ts` (the SQL layer, including two new tables/columns), and `src/status/guestStatus.ts` (the sixth status). The Agent repository (`dslrbooth-agent`) is read-only this phase per D-05 — confirmed unmodifiable without dragging in the still-undeployed Phase 3 auth cutover (`OPS-RUNBOOK.md §7`).

**Primary recommendation:** Implement D-01/D-02 as a genuine split — a new jobId-scoped completion path triggered by `processing_start`/`printing` (both currently fall through to the `debug` catch-all and need real handlers added), and reduce `sessionEnded()` to pure booth-release logic with its own fallback timer that **only** calls `setBoothIdle()`/clears `current_job_id`, never `handleStall()`. Build D-06's cross-check and D-07's registry before wiring D-01's completion trigger through them, since D-01 depends on both for correct attribution under a queue.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Print-composite completion anchor (D-01) | API/Backend (`QueueService.onAgentEvent`) | Database (`queue_job.status`/`completed_at`) | Business logic lives in the Extension Service per `CLAUDE.md`'s dumb-relay rule; the Agent only forwards events verbatim. |
| Booth release fallback timer (D-02) | API/Backend (`QueueService`) | — | In-memory timer state, same tier as the existing `busyTimer`; must NOT route through `handleStall()` (Phase 2's retry-charging policy). |
| No-photo distinct outcome (D-03/D-09) | Database/Storage (`queue_job.status` union) | API/Backend (`guestStatus.ts` mapping) | The status is persisted and must survive restart; the guest-facing translation is a pure function over it. |
| Photo-with-no-session drop (D-04) | API/Backend (`QueueService.onAgentEvent`) | — | Requires `booth_state.current_job_id` read at event-handling time; no persistence of the dropped photo. |
| Session ↔ job binding source of truth (D-06) | Database/Storage (`booth_state.current_job_id`) | API/Backend (cross-check logic) | `booth_state` is already the single-row table this project persists booth state through; the column is additive. |
| Pending-print registry (D-07/D-08) | Database/Storage (new SQLite table) | API/Backend (registry read/write, expiry check) | Phase 4's `notification_record` precedent: durable before any network call is attempted. |
| Agent event observability (D-12/D-13/D-14) | API/Backend (`queueService.ts` logging) | — | Purely a logging-surface change; no new transport or sink (Winston already configured). |
| Retake non-detection (SC-1) | API/Backend (implicit, by construction) | — | No code "detects" a retake; D-01's anchor placement (after the capture phase) makes retake events structurally unable to reach it. |

## Standard Stack

### Core

No new library is required for this phase. Every mechanism D-01–D-14 needs already has a working, tested precedent in this exact codebase.

| Library | Version | Purpose | Why Standard (in-repo precedent) |
|---------|---------|---------|--------------|
| `better-sqlite3` | `^11.0.0` [VERIFIED: mirror-request/package.json:10] | Registry table (D-08), `booth_state.current_job_id` column (D-06), sixth job status (D-09) | Already the sole persistence layer; `LocalStore.migrate()` (`localStore.ts:78-120`) already contains two additive-column migrations with honest-failure backfill — the exact shape D-08's registry migration must follow. |
| `winston` | `^3.14.2` [VERIFIED: mirror-request/package.json:19] | D-12/D-13's per-event `info` line, D-14's summary line | Already configured (`src/logging/logger.ts`); `LOG_LEVEL` defaults to `'info'` [VERIFIED: mirror-request/src/config.ts:140, quote: `LOG_LEVEL: get('LOG_LEVEL') ?? 'info',`], so an `.info()` call needs no config change to become visible in production. |
| `vitest` | `^2.1.4` [VERIFIED: mirror-request/package.json devDependencies] | Every new behaviour needs unit coverage | Existing 36-file / 335-test suite (re-run live this session — see Metadata) already exercises `QueueService` against a fully mocked `LocalStore`, never `getStore()` (binding pattern per 03-VALIDATION.md, confirmed still followed in `test/queue-countdown.test.ts` and `test/queue-event-coverage.test.ts`). |

### Supporting

None — no HTTP client, no new middleware, no new schema-validation library is implicated by any of D-01–D-14.

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| A new SQLite table for the pending-print registry (D-08, locked) | An in-memory `Map` with a `setTimeout` per entry | Locked against by the user: a mid-session restart is documented project history, not hypothetical (Phase 2's stuck-BUSY incident, Phase 6's mid-flight recovery language). |
| `booth_state.current_job_id` as an additive column (D-06, locked) | A separate `current_job` table | The single-row `booth_state` table (`CHECK (id = 1)`) already persists exactly this class of "what does the booth own right now" fact; a second table would duplicate that guarantee rather than extend it. |

**Installation:**
No new packages. This phase's tasks are entirely code and SQL against the existing dependency set.

**Version verification:** All versions above are read directly from `mirror-request/package.json` (already installed and running in this environment — `node -e "require('better-sqlite3')"` succeeded, `npm test` passed 335/335 live this session). No registry lookup needed since no new package is added.

## Package Legitimacy Audit

**Not applicable — this phase introduces zero new npm dependencies.** All work is additive SQL migrations and TypeScript changes against the existing, already-audited dependency set (audited in prior phases: Phase 1 introduced the core set, Phase 4 added no new runtime deps, Phase 6 added `mysql2` which predates this phase).

**Packages removed due to `[SLOP]` verdict:** none — no packages evaluated, none needed.
**Packages flagged as suspicious `[SUS]`:** none.

## Architecture Patterns

### System Architecture Diagram

```
dslrBooth (vendor software, booth PC)
    │  HTTP GET /dslrbooth-event?event_type=...&paramN=...  (every trigger, unfiltered)
    ▼
dslrbooth-agent :: triggers/server.ts                              [READ-ONLY this phase, D-05]
    │  logs every trigger at `info` already (line 41)
    │  stamps event.jobId = activeJobId  (index.ts:107 — NEVER reset, the root cause)
    ▼  WS { type: 'event', event, jobId, payload, timestamp }
mirror-request :: agentServer.ts (:123-131)
    │  unpacks (eventType, jobId, payload), passes through unmodified
    ▼
mirror-request :: queueService.ts :: onAgentEvent()                [THIS PHASE'S CENTRE OF GRAVITY]
    │
    ├─ session_start ──────► sessionAcked(jobId)
    │                         └─ NEW: guard against a job already in a terminal
    │                            state before writing 'in_progress' (closes the
    │                            WINDOWS-8 resurrection path at its second cause)
    │
    ├─ processing_start / printing  [CURRENTLY UNHANDLED — falls to debug catch-all]
    │        │  extract param5 / param1 = print composite path
    │        ▼
    │   NEW: completeJob(jobId, composite)                          (D-01)
    │        ├─ cross-check jobId against booth_state.current_job_id (D-06)
    │        │    mismatch → warn(both ids), drop
    │        ├─ queue_job: status='completed', completed_at=now      (jobId-SCOPED,
    │        │    replaces the unscoped completeInProgressJob())     not session_end-scoped
    │        └─ pending_print_registry: INSERT {jobId, composite,    (D-07/D-08)
    │             seenAt, expiresAt}
    │
    ├─ file_upload (param3==='print') ──► resolve against pending_print_registry
    │        │                              NOT against booth_state.current_job_id
    │        │                              (decouples from whichever job "owns"
    │        │                              the booth NOW — D-07's whole point)
    │        └─ found & unexpired → sendNotification(); delete/resolve registry row
    │           not found/expired → D-04's drop-with-warn rule applies
    │
    └─ session_end ──────► sessionEnded()                            (D-02, REDUCED SCOPE)
             │  no longer completes anything — job is already 'completed'
             │  or resolves as D-03's no-photo outcome if the registry
             │  never saw a composite for booth_state.current_job_id
             ├─ setBoothIdle(); clear booth_state.current_job_id
             ├─ clear the booth-release fallback timer (D-02's own timer,
             │    NOT busyTimer — never routes through handleStall())
             └─ tick() → next guest, if any

                                        ▲
   booth_state.current_job_id ─────────┘  written on dispatch/ack, cleared on
   (SQLite, single-row table,               release — the single source of truth
    additive column, D-06)                  every event above is attributed through
```

A reader tracing the primary use case: dslrBooth fires `processing_start`/`printing` mid-session → the service completes the job right there, scoped by `current_job_id`, and opens a registry slot for the still-pending print URL → `file_upload(print)` resolves against that slot whenever it happens to arrive → `session_end` (possibly duplicated, possibly from gallery-browsing) only ever touches booth occupancy, never job completion, so a stray extra `session_end` has nothing left to damage.

### Recommended Project Structure

No new directories. This phase's changes land inside the existing structure:

```
src/
├── queue/
│   └── queueService.ts       # onAgentEvent() gains processing_start/printing handlers,
│                              # sessionEnded() reduced to release-only, new release timer,
│                              # D-06 cross-check, D-12/D-13/D-14 logging
├── state/
│   └── localStore.ts         # booth_state.current_job_id (additive migration),
│                              # new pending_print_registry table (additive migration),
│                              # completeJob(jobId) replacing completeInProgressJob(),
│                              # new no-photo status writer
├── status/
│   └── guestStatus.ts        # KNOWN_JOB_STATUSES gains a sixth member (D-09),
│                              # STATUS_MAP gains its mapping (compile-enforced)
└── (agentServer.ts, notificationService.ts unchanged — D-07 reroutes the
    *trigger* of sendPhotoLink, not its own contract)
```

### Pattern 1: jobId-scoped completion replacing an unscoped `ORDER BY ... LIMIT 1`

**What:** `completeInProgressJob(endedAt)` (`localStore.ts:220-229`) selects `WHERE status='in_progress' ORDER BY acknowledged_at DESC LIMIT 1` with no jobId parameter at all — this is WINDOWS item 8's root cause once a second guest exists. D-01/D-06 require every completion write to be scoped by the id that `booth_state.current_job_id` names, not inferred by ordering.

**When to use:** Any write that changes what "the current job" means, going forward — this is the general fix pattern the whole phase pivots on.

**Example (the existing method being replaced, for exact reference — not a source example):**
```typescript
// Source: mirror-request/src/state/localStore.ts:220-229 [VERIFIED — read this session]
completeInProgressJob(endedAt: number): string | undefined {
  const job = this.db.prepare(
    "SELECT id FROM queue_job WHERE status = 'in_progress' ORDER BY acknowledged_at DESC LIMIT 1"
  ).get() as { id: string } | undefined;
  if (!job) return undefined;
  this.db.prepare(
    "UPDATE queue_job SET status = 'completed', session_ended_at = ?, completed_at = ? WHERE id = ?"
  ).run(endedAt, endedAt, job.id);
  return job.id;
}
```
The replacement needs a `jobId` parameter and a `WHERE id = ? AND status = 'in_progress'` guard (mirroring `requeueWithRetry`'s and `failJob`'s existing id-scoped shape at `localStore.ts:240-267`), returning whether the write actually matched a row — so the caller can distinguish "completed the right job" from "the cross-check already rejected this before reaching here."

### Pattern 2: Additive, idempotent SQLite migration (Phase 4's precedent, reusable for D-06 and D-08)

**What:** `LocalStore.migrate()` already contains the exact shape D-06's `current_job_id` column and D-08's new table must follow: check `PRAGMA table_info(<table>)` for the column/table's existence before adding it, so re-running migration on an already-migrated database is a safe no-op.

**Example:**
```typescript
// Source: mirror-request/src/state/localStore.ts:101-119 [VERIFIED — read this session]
const notifColumns = this.db.prepare('PRAGMA table_info(notification_record)').all() as Array<{ name: string }>;
const hasPhotoUrl = notifColumns.some((c) => c.name === 'photoUrl');
// ... ALTER TABLE ... ADD COLUMN only if missing, then an honest-failure backfill
// scoped to `notifColumnAdded` so an already-migrated DB is never rescanned.
```
D-06's `current_job_id` column on `booth_state` follows this exact shape (`PRAGMA table_info(booth_state)`, `ALTER TABLE booth_state ADD COLUMN current_job_id TEXT`). D-08's registry table follows `bootstrap()`'s `CREATE TABLE IF NOT EXISTS` shape (`localStore.ts:22-75`) rather than `migrate()`'s ALTER shape, since it is an entirely new table, not a new column on an existing one — no backfill is needed for a brand-new empty table.

### Pattern 3: Exhaustive `Record` over a derived union (D-09's compile-enforced sixth status)

**What:** `KNOWN_JOB_STATUSES` is declared as a `const` array; `InternalJobStatus` is `typeof KNOWN_JOB_STATUSES[number]`; `STATUS_MAP` is typed `Record<InternalJobStatus, ...>`. Adding a sixth array member without adding its `STATUS_MAP` entry is a **measured** compile error — CONTEXT.md cites `TS2741` from a real trial at plan 05-02, and the same array-derivation technique is independently confirmed live in `guestStatus.ts` for both `GUEST_STATUSES` and `KNOWN_JOB_STATUSES` this session.

**Example:**
```typescript
// Source: mirror-request/src/status/guestStatus.ts:71-103 [VERIFIED — read this session]
export const KNOWN_JOB_STATUSES = [
  'queued', 'dispatched', 'in_progress', 'completed', 'failed',
] as const;
export type InternalJobStatus = typeof KNOWN_JOB_STATUSES[number];
const STATUS_MAP: Record<InternalJobStatus, (input: GuestStatusInput) => GuestStatus> = {
  queued: ({ announced }) => (announced ? 'your_turn' : 'waiting'),
  // ...
  failed: () => 'see_staff',
};
```
D-09's sixth member (e.g. `'no_photo'` — name is Claude's discretion) is added to the array; its `STATUS_MAP` entry resolves to `'see_staff'` per D-10 — literally the same resolver function `failed` already uses, since the guest-facing action is identical.

### Pattern 4: A sibling method with a deliberately different shape, not a shared parameter (D-02's release timer vs. `busyTimer`)

**What:** `requeueNoRetry()` (`localStore.ts:259-261`) is documented as "a deliberate sibling of `requeueWithRetry()`, not a variant of it" — the two stay trivially different at the call site specifically so a system-side fault (never charging a retry) cannot accidentally be confused with a guest-side fault (charging one). D-02's release-fallback timer must follow the identical discipline against `busyTimer`: a new timer field (e.g. `releaseTimer`), a new callback that calls only `setBoothIdle()` + clears `current_job_id` + `tick()` — **never** `handleStall()` — so the two timers cannot be collapsed into one parameterised timer without also erasing the distinction CONTEXT.md is explicit about protecting.

**Example (the sibling this pattern is modeled on):**
```typescript
// Source: mirror-request/src/state/localStore.ts:248-261 [VERIFIED — read this session]
// requeueWithRetry(): charges a retry, used by handleStall()
// requeueNoRetry(): explicitly does NOT increment retries — system-side fault only
requeueNoRetry(jobId: string): void {
  this.db.prepare("UPDATE queue_job SET status = 'queued' WHERE id = ?").run(jobId);
}
```

### Anti-Patterns to Avoid

- **Reusing `busyTimer` for D-02's release fallback:** `busyTimer`'s only callback path is `handleStall()` (`startBusyTimer()`, `queueService.ts:307-315`), which always requeues-with-retry or fails the job. Routing a completed job's release timeout through it would call an already-photographed guest back to the camera — CONTEXT.md names this explicitly as the risk D-02 exists to avoid.
- **Running the D-01 completion pipeline on both `processing_start` AND `printing`:** the evidence file shows both fire ~1 second apart for the same session (`07:35:26.970` then `07:35:28.064`) and name the same composite path. Pick one as authoritative (e.g. whichever arrives first, or hard-code one event type) and make the other a no-op/idempotent check — otherwise the pending-print registry insert, the D-14 summary line, and any future side effect risk firing twice per session.
- **Trusting the event's own `jobId` as primary attribution for anything except D-07's registry lookup:** the Agent stamps `activeJobId` on every forwarded event and never clears it (verified, 3 occurrences, no reset). D-06 is explicit that the event's `jobId` is a cross-check only, warned on mismatch — never the source of truth for "which job does this event belong to." The one deliberate exception is D-07's registry lookup for `file_upload(print)`, which is keyed by the jobId the print-composite event reported at the time it was cross-checked correct — not re-derived from `current_job_id` at lookup time (see Pitfall 3 below for the residual risk this carries).
- **Building a "detect retake" branch:** no ROADMAP success criterion nor any locked decision asks for retake detection. D-01's anchor placement makes retake structurally invisible to completion logic; adding detection logic would be unrequested scope and risks depending on an event sequence nobody has fully measured mid-capture (evidence file's own "What this file does NOT answer" section).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Idempotent SQLite schema evolution | A version-numbered migration runner | The existing `PRAGMA table_info()` + conditional `ALTER TABLE` pattern already in `migrate()` | Introducing a migration framework for two additive changes (one column, one table) would be new infrastructure this phase does not need and CONTEXT.md never asked for. |
| Exhaustiveness checking for the sixth status | A `switch` with a `default:` arm, or a runtime `if` chain | The array-derived `Record<InternalJobStatus, ...>` pattern already in `guestStatus.ts` | A `default:` arm silently absorbs an unmapped status; the existing pattern makes it a compile error instead — CONTEXT.md is explicit this property (not code volume) is why D-09 chose a status over a reason column. |
| Print-composite timing/expiry tracking | A `setTimeout` per pending photo, held in application memory | A SQLite row with an `expires_at` column, checked by the existing sweeper-style pattern (`NotificationService.sweep()`, `queueService.ts`'s own `tick()` interval) | Phase 4's `notification_record` claim-lease precedent (`localStore.ts:474-481`) is the exact "durable deadline, checked periodically, not trusted to an in-process timer surviving a restart" shape D-08 needs. |

**Key insight:** every one of D-01–D-14's mechanisms already has a working sibling in this codebase from Phases 2 and 4. The phase is not introducing new architecture — it is relocating existing mechanisms (completion, release, retry-vs-no-retry, terminal-state guards) onto the correct trigger and the correct jobId scope.

## Common Pitfalls

### Pitfall 1: The stale-`activeJobId` bug is neutralised, not fixed — every design must assume it keeps firing
**What goes wrong:** A future maintainer sees D-06's cross-check warn and assumes the underlying Agent bug is being tracked toward a fix. It is explicitly deferred (CONTEXT.md `<deferred>`).
**Why it happens:** D-05 forbids touching the Agent repo this phase, to avoid dragging the undeployed Phase 3 auth cutover into this deploy window.
**How to avoid:** Every design decision in this phase must hold correctly assuming `activeJobId` **never** resets and is stamped on 100% of forwarded events, including ones with no logical relationship to the "current" job (gallery browsing, a stranger pressing start with nobody dispatched).
**Warning signs:** Any plan task that reads "verify the Agent clears activeJobId" or similar — that would be scope creep into the deferred item.

### Pitfall 2: `processing_start`/`printing` firing twice for one session (double-run hazard)
**What goes wrong:** Implementing D-01's completion trigger as a bare `if (eventType === 'processing_start' || eventType === 'printing')` branch without an idempotency guard runs the full completion pipeline twice per real session (registry insert, D-14 summary log, possibly a duplicate notification enqueue).
**Why it happens:** The evidence file shows both events fire ~1 second apart naming the identical composite path — they are not mutually exclusive signals, they are two views of the same moment.
**How to avoid:** Pick one event type as authoritative (or check `queue_job.status !== 'completed'` before running the pipeline, mirroring the terminal-state guard pattern `sessionAcked()` needs anyway per the WINDOWS-8 fix).
**Warning signs:** A test asserting the pipeline runs exactly once per session, with both trigger events delivered, should be in Wave 0's gap list.

### Pitfall 3: D-07's registry lookup still trusts the event's own `jobId` — this is a real, acknowledged residual risk
**What goes wrong:** `file_upload(param3==='print')` is looked up in the pending-print registry keyed by the jobId the event itself carries (the Agent's `activeJobId`). If a THIRD guest's session had somehow started and been ack'd (`activeJobId` reassigned) before job A's late print arrives, the lookup would miss A's registry entry and fall through to D-04's drop rule — losing A's photo, the exact failure class this phase exists to prevent, just at a much longer delay than anything measured so far.
**Why it happens:** The Agent's stale-jobId defect (Pitfall 1) is not bounded in time from the service's point of view — only bounded in practice by how long a real booth's dispatch cadence takes (multiple seconds to over a minute per the announcement countdown + session timeout).
**How to avoid:** Set the registry expiry (Claude's discretion, per CONTEXT.md) generously enough to comfortably exceed the observed print-upload delay range (measured: 26s before `session_end` to ~1s after) plus the announcement countdown (5-10s, `NEXT_GUEST_COUNTDOWN_MS` default 7000 [VERIFIED: mirror-request/src/config.ts:104]) — but recognise this narrows, not eliminates, the window in which the Agent's unfixed bug could still misattribute a very late print. This is the honest cost of D-05's Agent-untouched constraint, not a planning oversight.
**Warning signs:** A registry expiry set shorter than `NEXT_GUEST_COUNTDOWN_MS + SESSION_TIMEOUT_MS` risks expiring a still-legitimate pending print before the next guest could even physically be dispatched.

### Pitfall 4: `BoothState`'s `TIMEOUT_RESET` member is declared but never written — the project's known dead-value pattern recurring
**What goes wrong:** `BoothState` is typed `'IDLE' | 'ANNOUNCING' | 'BUSY' | 'TIMEOUT_RESET'` [VERIFIED: mirror-request/src/types.ts:1, quote: `export type BoothState = 'IDLE' | 'ANNOUNCING' | 'BUSY' | 'TIMEOUT_RESET';`], but `setBoothTimeout()` — the only method whose name suggests it should write `'TIMEOUT_RESET'` — actually writes `'IDLE'` [VERIFIED: mirror-request/src/state/localStore.ts:320-323, quote: `setBoothTimeout(reason: string): void {\n    this.db.prepare("INSERT OR REPLACE INTO booth_state (id, state, updated_at) VALUES (1, 'IDLE', ?)").run(new Date().toISOString());`]. Zero writers of `'TIMEOUT_RESET'` exist in `src/`.
**Why it happens:** This is the same class of defect Phase 5's research found in `session_started_at` (declared, never written, would have silently returned zero wait-estimate samples forever). This project has a recorded pattern of unused-but-plausible-looking union members.
**How to avoid:** If planning introduces any new `BoothState` value (not required by any locked decision — D-02's release fallback does not need one, see Architecture Patterns), verify with a grep that every union member has at least one real writer before relying on it. Do not assume `TIMEOUT_RESET` is available to repurpose without checking it is genuinely dead code first (it is, as verified above) and confirming no test depends on its presence in the type (`grep -rn "TIMEOUT_RESET" test/` returned nothing in this session's audit).
**Warning signs:** A new `BoothState` value that no test writer explicitly asserts gets set.

## Code Examples

### Verifying every writer of `'in_progress'` (the audit this phase's research priority #1 demanded)
```bash
# Source: this session's own verification, run against mirror-request/src/
$ grep -rn "in_progress" src/ | grep -v "\.test\."
src/status/guestStatus.ts:74:  'in_progress',
src/status/guestStatus.ts:97:  in_progress: () => 'in_session',
src/queue/queueService.ts:187:    this.store.updateJobStatus(jobId, 'in_progress', 'acknowledged_at', Date.now());
src/state/localStore.ts:222:      "SELECT id FROM queue_job WHERE status = 'in_progress' ORDER BY acknowledged_at DESC LIMIT 1"
src/state/localStore.ts:233:      "SELECT * FROM queue_job WHERE status IN ('dispatched','in_progress') ORDER BY dispatched_at DESC"
```
Exactly one write site: `queueService.ts:187`, inside `sessionAcked(jobId)`, called only from `onAgentEvent()`'s `session_start` branch (`queueService.ts:242-243`) and from `onAgentAck()`'s `ok===true` branch (`:192-194`). CONTEXT.md's claim — "only `sessionAcked()` and `ack` write that status" — holds exactly, independently confirmed this session, not assumed from the planning record.

### The Agent's `activeJobId` lifecycle — all three occurrences, confirmed no reset
```typescript
// Source: dslrbooth-agent/src/index.ts [VERIFIED — read this session, HEAD e376696 per CONTEXT.md]
let activeJobId: string | undefined                                    // :44 declaration
// ...
if (result.isSuccessful) {
  activeJobId = jobId                                                  // :84 assignment, on ack success only
  // ...
}
// ...
onEvent: (eventType, params) => {
  // ...
  ws.send({
    type: 'event',
    event: eventType,
    jobId: activeJobId,                                                // :107 use — forwarded on EVERY event
    payload: { ...params, ...(photoUrl ? { photoUrl } : {}) },
    timestamp: Date.now(),
  })
},
```
The comment at line 102, `// Forward ALL events to Extension Service`, is itself confirmation that nothing in the Agent filters or contextualises events before forwarding — the Extension Service is the only place that can ever distinguish a stale-jobId event from a live one, which is exactly why D-05 keeps all business logic there.

### The `stall_reason` vocabulary D-02's release timer must NOT write into
```
| stall_reason | What actually happened |
| restart_recovery_timeout | ... |
| session_ack_timeout | The Agent was dispatched a session but never acknowledged it ... |
| agent_nak | The Agent explicitly rejected the dispatched session |
```
[CITED: mirror-request/docs/OPS-RUNBOOK.md §6, "stall_reason vocabulary" table, lines 261-270]. This is a closed, fixed, server-authored vocabulary — CONTEXT.md's D-02 requirement that the release-fallback timer "return the booth to service without touching the job" means it must never write a `stall_reason` at all (the job is already terminal), not merely never call `handleStall()`.

## State of the Art

| Old Approach | Current Approach (this phase) | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Job completion inferred from `session_end` + "most recently acknowledged" ordering | Job completion anchored on the print composite event, scoped by `booth_state.current_job_id` | This phase (D-01/D-06) | Eliminates the class of bug WINDOWS item 8 describes — completion can no longer land on the wrong job because it is no longer inferred by ordering at all. |
| `session_end`'s "no print upload seen" check runs synchronously, immediately | Check moves to pending-print registry expiry, a genuinely delayed check | This phase (D-07, closes WINDOWS item 9) | The warning becomes meaningful again — today it fires on literally every successful session because the print composite consistently arrives after `session_end` fires the check. |
| `booth_state` carries only `state`/`updated_at` | Gains `current_job_id` as attribution source of truth | This phase (D-06) | First point in this codebase's history where "which job owns the booth" is an explicit, persisted fact rather than inferred from `queue_job`'s own status column. |

**Deprecated/outdated:**
- `completeInProgressJob(endedAt)`'s unscoped signature: superseded by a jobId-scoped completion method. Do not extend the old method with an optional jobId parameter that falls back to the old ordering when omitted — that would leave WINDOWS item 8's exact hazard reachable by any caller that forgets to pass one.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The `BZWCWFN6` incident's second `session_start` (required to explain the return to `in_progress`, per the incident's own recorded facts) came from dslrBooth genuinely re-emitting a `session_start`/`session_end` pair for the retake — not independently re-measured this session against the unfiltered Agent log CONTEXT.md's evidence file itself says is still needed. CONTEXT.md's discussion log treats this as settled by source-reading rather than by the unfiltered log capture. | Summary | If the true mechanism differs (e.g. a race in the Agent's own message queue rather than a genuine second `session_start`), the D-06 cross-check design still closes the hazard correctly regardless — the fix does not depend on which of the two explanations is exactly right, since both produce a stale-jobId event that D-06's cross-check catches. Low practical risk. |
| A2 | The registry-expiry window (Pitfall 3) needs to exceed `NEXT_GUEST_COUNTDOWN_MS + SESSION_TIMEOUT_MS` to stay safe against the Agent's unfixed stale-jobId bug reassigning `activeJobId` to a third guest before a very late print arrives — this arithmetic is this session's own derivation from the code, not a value CONTEXT.md states directly. | Pitfall 3 | If planning sets a shorter expiry (e.g. matching only the observed 26s-before/1s-after print-upload range), a legitimately late print could still be dropped in a queue with rapid guest turnover. Worth a `checkpoint:human-verify` or at minimum an explicit note in the plan justifying the chosen value against this arithmetic. |
| A3 | `file_upload`'s `param1` (local file path) reliably carries the print composite's filename, which would allow D-07's deferred filename-matching alternative to work — confirmed present in ONE real captured session (`test/queue-file-upload-print.test.ts`'s `REAL_SESSION_UPLOADS` fixture) but not independently re-verified against a second live capture this session. | User Constraints (Deferred Ideas) | Irrelevant to this phase's plans since the filename-matching alternative is explicitly deferred, not adopted — flagged only so a future phase revisiting it does not have to re-discover this. |

**If this table is empty:** N/A — see rows above. None of these assumptions changes what this phase's plans must build; they narrow discretion choices (A2) or record provenance for a deferred idea (A3).

## Open Questions

1. **Exact name and column shape for D-08's registry table and D-09's sixth status**
   - What we know: both are explicitly Claude's discretion, provided additive/idempotent (D-08) and array-derived/exhaustive (D-09).
   - What's unclear: nothing blocking — this is deliberately open for the planner to name.
   - Recommendation: name the table `pending_print` or `print_pending` (matches `notification_record`'s naming register); name the status `no_photo` (matches the existing five single-word statuses' register: `queued`, `dispatched`, `in_progress`, `completed`, `failed`).

2. **Whether the D-14 summary line's "capture count" is derived from the new registry or held separately**
   - What we know: explicitly Claude's discretion. The registry (D-08) is keyed by jobId and opened once, at the print-composite event — it does not naturally accumulate a running count of `capture_start` events across a session including retakes, unless a counter column is added to it.
   - What's unclear: whether counting `capture_start` occurrences requires touching the currently-unhandled `capture_start` branch of `onAgentEvent()` (today part of the seven-way debug catch-all) to increment a counter, versus deriving the count later from the new D-12 per-event `info` log lines via a grep (CONTEXT.md's own D-14 rationale: "an operator greps one token and gets the whole session").
   - Recommendation: since D-12 already commits to logging every event at `info` including `jobId`, and D-14's own stated purpose is "an operator greps one token," the simplest correct design derives the capture count by counting `capture_start` events for that jobId directly in the `onAgentEvent()` handler (an in-memory per-job counter, reset when the registry entry opens/closes) rather than adding a persisted column — no persistence requirement was stated for this specific count, unlike the registry's own composite-path row.

3. **The full retake trigger sequence mid-capture — deliberately never resolved this phase, by design**
   - What we know: the evidence file's own finding 6 states the captured section (A) begins too late to show a retake's triggers; CONTEXT.md's D-01 was chosen specifically so this does not need to be known.
   - What's unclear: whether a mid-capture retake fires an extra `capture_start`, an extra `session_start`, both, or neither.
   - Recommendation: do not attempt to resolve this in planning or execution. It is out of scope by design (D-01's own stated rationale) and SC-6's phase-gate retake exercise (D-15) is the only place this project intends to observe it, after the code ships — not before.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Runtime | ✓ | v24.15.0 (measured live this session; `package.json` targets `20.x`) | — |
| npm | Package management | ✓ | 11.12.1 | — |
| `better-sqlite3` native binding | LocalStore, all migrations | ✓ | Loaded successfully live this session (`require('better-sqlite3')` succeeded) | — |
| vitest | Test suite | ✓ | `^2.1.4`, 36 files / 335 tests green, run live this session | — |
| `tsc` typecheck/build | Compile-time enforcement of D-09's exhaustiveness | ✓ | Clean, run live this session | — |
| Physical booth / dslrBooth software | SC-6's phase-gate retake exercise (D-15) | ✗ (this sandbox has no hardware access) | — | None — SC-6 is explicitly a human-performed step at the physical booth, outside any agent's reach. Not a blocker for research or planning, per D-15. |
| Phase 3 Agent-auth cutover deployment | The phase gate's prerequisite (per D-15 and OPS-RUNBOOK §7) | Unknown from this sandbox (deployment state is operational, not code-visible) | — | Must be confirmed by the human operator before SC-6's live exercise; not required for writing or reviewing plans. |

**Missing dependencies with no fallback:** none that block research or planning. SC-6's physical-booth dependency is explicitly deferred to a human-run phase gate by D-15.

**Missing dependencies with fallback:** none beyond the above.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest `^2.1.4` [VERIFIED: mirror-request/package.json] |
| Config file | `mirror-request/vitest.config.ts` — sets `LOG_LEVEL: 'error'` in the test env, a fixed `LOCAL_STORE_PATH`, and `globalSetup` to remove per-test SQLite files |
| Quick run command | `cd mirror-request && npx vitest run test/queue-<name>.test.ts` (single file) |
| Full suite command | `cd mirror-request && npm test` — measured live this session: **36 files / 335 tests, 8.09s, all green** |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SC-1 | Retake does not complete the job or free the booth | unit | `npx vitest run test/queue-retake-anchor.test.ts` (new) | ❌ Wave 0 |
| SC-2 | A `session_end` for A never completes B, proven with a queued second guest | unit (mocked `LocalStore`, extending the existing `queue-countdown.test.ts` "booth state transitions" pattern) | `npx vitest run test/queue-dual-completion.test.ts` (new) | ❌ Wave 0 |
| SC-3 | No-photo outcome is distinct, visible, no retry charged | unit | `npx vitest run test/queue-no-photo-outcome.test.ts` (new) | ❌ Wave 0 |
| SC-4 | `No print upload seen` fires only on genuine expiry, not on every session | unit | `npx vitest run test/queue-print-registry-expiry.test.ts` (new) | ❌ Wave 0 |
| SC-5 | Every AGT-04 event produces an `info`-level line | unit (extends the existing `test/queue-event-coverage.test.ts` pattern, which already asserts today's seven-way `debug` fallback — needs updating to assert `info`, not `debug`) | `npx vitest run test/queue-event-coverage.test.ts` | ✅ exists, needs rewriting (not a gap — the file exists and its current 6 tests must be updated, not left as-is, since they currently assert the exact `debug`-catch-all behaviour this phase removes) |
| SC-6 | Retake exercised live at the booth with a second guest queued | manual-only | N/A — human-performed at the physical booth | N/A (D-15: phase gate, not an automatable test) |

### Sampling Rate
- **Per task commit:** run the specific new/modified test file (`npx vitest run test/<file>.test.ts`), matching this project's established per-plan pattern (every prior phase's SUMMARY documents a full-suite run per plan, not per commit within a plan).
- **Per wave merge:** `cd mirror-request && npm test` (full suite) — must stay green; this session confirmed the pre-phase baseline is 36 files / 335 tests, 100% passing, `npm run typecheck` and `npm run build` both clean.
- **Phase gate:** Full suite green, plus SC-6's human-performed live retake exercise per D-15 — this is the one criterion no automated command can close.

### Wave 0 Gaps
- [ ] `test/queue-dual-completion.test.ts` (or equivalent) — covers SC-2, the load-bearing test this ROADMAP explicitly demands be "proven with a queued second guest, not reasoned about." **This is the single most important new test file in this phase.** See the concrete pattern below.
- [ ] `test/queue-print-registry-expiry.test.ts` — covers SC-4, needs fake-timer control over registry expiry (the existing `vi.useFakeTimers()` pattern already used throughout `test/queue-countdown.test.ts` applies directly).
- [ ] `test/queue-retake-anchor.test.ts` — covers SC-1; since a retake's actual trigger sequence is unmeasured (Open Question 3), this test should assert the STRUCTURAL guarantee instead — that `capture_start`/`session_start` alone (without `processing_start`/`printing`) never completes a job — rather than simulating a literal retake sequence nobody has captured.
- [ ] `test/queue-event-coverage.test.ts` — not a new file, but its 6 existing tests assert `debug`-level fallback behaviour that D-12 explicitly removes; these tests must be rewritten (asserting `.info()` instead of `.debug()`) as part of this phase's own work, not left green-by-coincidence or silently broken.
- [ ] `test/local-store-persistence.test.ts` — extend with the two new additive migrations (D-06's column, D-08's table), following the exact idempotency-proof pattern (`PRAGMA table_info` re-check, temporarily-broken-guard-then-reverted proof) Phase 4's `04-03-SUMMARY.md` established for `notification_record`.

### Proving SC-2 ("queued second guest") — the concrete mechanism

`test/queue-countdown.test.ts`'s existing `"booth state transitions"` describe block (lines 64-259, read this session) is the exact load-bearing precedent: it builds a hand-rolled mocked `LocalStore` with two queued jobs (`job-1`, `job-2`) and drives `QueueService` through `IDLE → ANNOUNCING → BUSY → IDLE → ANNOUNCING` via real timer advancement (`vi.useFakeTimers()` + `vi.advanceTimersByTime()`), asserting the booth-state sequence and dispatch payload at each step — never touching the real SQLite store. SC-2's test must extend this exact pattern one step further:

1. Build the same two-guest mock, but add a `current_job_id` field to the mocked `booth_state` surface (mirroring D-06) and a completion-scoping mock method (`completeJob(jobId)` returning whether it matched).
2. Drive: `job-1` announced → dispatched → `session_start('job-1')` (ack, `current_job_id='job-1'`) → `processing_start`/`printing('job-1', composite)` (D-01 completes job-1, scoped) → `session_end()` (D-02 releases the booth, `current_job_id` cleared, `tick()` announces `job-2`) → `job-2` dispatched → `session_start('job-2')` (ack, `current_job_id='job-2'`).
3. **The load-bearing assertion:** deliver a **second, stray `session_end()`** (simulating the gallery-browsing/retake duplicate this whole phase exists to fix) and assert `job-2`'s status is **unchanged** (still `in_progress`, not `completed`) — proving the exact WINDOWS-8 hazard (A's stray second `session_end` completing B) cannot occur under the new design, with a genuinely queued second guest exercising the real dispatch path rather than a hand-asserted claim.
4. A companion assertion: deliver a stray `session_start('job-1')` after job-1 is already `completed` (simulating a second `session_start` for the SAME job, the literal `BZWCWFN6` mechanism) and assert it does NOT resurrect `job-1` back to `in_progress` — this is the terminal-state guard `sessionAcked()` needs regardless of D-01 (belt-and-suspenders: D-01 already makes `session_end` harmless to completion, but `session_start` reaching `updateJobStatus(..., 'in_progress', ...)` on an already-terminal job is a separate, independently-guardable hazard worth closing in the same plan).

This gives SC-1 and SC-2 both a fully mechanical, non-vacuous proof — matching this project's established "prove non-vacuous by mutation" house rule (temporarily remove the new guard, confirm the new test fails, then restore), which every prior phase's SUMMARY documents doing.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | Unchanged this phase — Agent WS auth (Phase 3) is out of scope, D-05 forbids touching it. |
| V3 Session Management | Yes (booth session, not a web session) | `booth_state.current_job_id` (D-06) is this phase's session-binding mechanism; the cross-check-and-drop pattern is the standard "never trust client-asserted identity over server-held session state" control, applied here to a WS event stream instead of an HTTP session. |
| V4 Access Control | No | No new endpoint or role distinction introduced. |
| V5 Input Validation | Yes | Every new event handler (`processing_start`, `printing`) must validate `param5`/`param1` are non-empty strings before treating them as a completion trigger — mirrors the existing `onFileUpload()`'s `typeof payload.param3 === 'string'` guard (`queueService.ts:342`), a pattern to replicate exactly, not reinvent. |
| V6 Cryptography | No | No new secret, token, or cryptographic operation. |
| V9 Communications | No | No new outbound network call — D-07's registry only gates the EXISTING `sendPhotoLink()` call, per its own contract note ("D-06 reroutes the trigger of, without changing the delivery itself"). |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| A stale/replayed event misattributed to the wrong job (this phase's entire subject) | Spoofing (of session identity, not user identity) | `booth_state.current_job_id` as server-held ground truth (D-06), never trusting the event's self-reported jobId as primary. |
| A guest's photo delivered to the wrong recipient via a misattributed `file_upload` | Information Disclosure | D-07's registry decouples print resolution from momentary booth ownership, closing the exact ordering hazard that would otherwise leak A's photo attribution to B or drop it. |
| Log lines at `info` level leaking the fotoshare capability URL (D-13 explicitly forbids this) | Information Disclosure | D-13: never log the URL at `info`; the notification path (already `mask()`-filtered for PII, though the masking filter has no concept of a URL — CONTEXT.md's own stated reason) carries it where actually needed. Verify no new `.info()` call site in this phase's diff includes `photoUrl`/`param2` from a `file_upload` event. |

## Sources

### Primary (HIGH confidence — read directly this session)
- `mirror-request/src/queue/queueService.ts` (404 lines, full file read)
- `mirror-request/src/state/localStore.ts` (492 lines, full file read)
- `mirror-request/src/status/guestStatus.ts` (129 lines, full file read)
- `mirror-request/src/agent/agentServer.ts` (203 lines, full file read)
- `mirror-request/src/notifications/notificationService.ts` (232 lines, full file read)
- `mirror-request/src/logging/logger.ts` (85 lines, full file read)
- `mirror-request/src/config.ts` (153 lines, full file read)
- `mirror-request/src/types.ts` (151 lines, full file read)
- `dslrbooth-agent/src/index.ts` (153 lines, full file read, HEAD `e376696` per CONTEXT.md's stated commit)
- `dslrbooth-agent/src/triggers/server.ts` (72 lines, full file read)
- `mirror-request/test/queue-countdown.test.ts` (259 lines, full file read)
- `mirror-request/test/queue-event-coverage.test.ts` (149 lines, full file read)
- `mirror-request/test/queue-file-upload-print.test.ts` (partial, header + fixture read)
- `mirror-request/docs/OPS-RUNBOOK.md` (grep-verified §6 stall_reason vocabulary, lines 261-270)
- `mirror-request/package.json`, `mirror-request/vitest.config.ts` (full read)
- `.planning/WINDOWS.md` (full read — items 8, 9 are this phase's; items 1-7 read for context)
- Live command execution this session: `npm test` (335/335 green), `npm run typecheck` (clean), `npm run build` (clean), `grep -rn "in_progress"`/`grep -rn "activeJobId"` across both repos, `node --version`/`npm --version`

### Secondary (MEDIUM confidence)
- `07-EVIDENCE-dslrbooth-triggers.md` — binding per the phase's own rule, treated as ground truth throughout, not independently re-measured (measurement, not research, per the task's explicit instruction).
- `07-CONTEXT.md`, `07-DISCUSSION-LOG.md` — locked decisions, treated as authoritative input constraining scope per the task's instructions ("research informs HOW to implement them, it does not re-open WHETHER").

### Tertiary (LOW confidence)
- None — no WebSearch or external documentation lookup was needed. Every claim in this document is either read directly from this session's own file reads and command executions, or copied verbatim from CONTEXT.md/the evidence file per their binding status.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new packages, every mechanism has an in-repo precedent read this session.
- Architecture: HIGH — the completion/release split (D-01/D-02) and the registry (D-07/D-08) are fully traced against the actual current code (`onAgentEvent()`, `completeInProgressJob()`, `sessionEnded()`), not inferred from CONTEXT.md's prose alone.
- Pitfalls: HIGH for Pitfalls 1, 2, 4 (independently verified this session); MEDIUM for Pitfall 3 (the residual-risk arithmetic is this session's own derivation, not independently timed against a live booth).

**Baseline measured live this session (pre-phase):** `mirror-request`: 36 test files / 335 tests, 100% green, run once; `npm run typecheck` clean; `npm run build` clean; Node v24.15.0; npm 11.12.1. (Prior STATE.md entry recorded 34 files/315 tests as of Phase 6's close — the higher count here reflects test files added since, e.g. `queue-file-upload-print.test.ts` and `view-health-probe.test.ts`, not a discrepancy to investigate.)

**Research date:** 2026-08-12
**Valid until:** 30 days (stable, in-repo-only work; no external dependency drift risk)
