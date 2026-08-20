# Phase 7: Session Lifecycle & Retake - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-12
**Phase:** 07-session-lifecycle-retake
**Areas discussed:** Completion anchor, Session-to-job binding, No-photo outcome, Agent event observability

---

## Completion anchor

### Which signal marks "guest A's job is complete"?

| Option | Description | Selected |
|--------|-------------|----------|
| Print composite | `processing_start.param5` / `printing.param1`, both naming the same path at 07:35:26. A positive signal, unreachable by a retake because a retake precedes `processing_start`. Fires 30s before `session_end`. | ✓ |
| First `session_end` after a real capture + lockout | Smallest change; keeps existing semantics with an added precondition and a lockout window. Risk: depends on whether a retake emits `session_end`, which nobody has measured. | |
| `file_upload param3='print'` | Completion coincides with the notification, so they can never diverge. Risk: depends on the fotoshare network; an outage strands the job until BTH-02's 5-minute timeout. | |

**User's choice:** Print composite
**Notes:** The deciding argument was that the anchor does not depend on the one question research has not answered.

### When does the booth return to IDLE?

| Option | Description | Selected |
|--------|-------------|----------|
| Two separate anchors | Job completes at the print composite; booth stays BUSY until the first `session_end` after it. Needs its own fallback timer — BTH-02's `busyTimer` cannot be reused because `handleStall()` would charge a retry and recall a guest who already has their photo. | ✓ |
| Same anchor, IDLE immediately | Highest throughput, simplest code, no intermediate state. Guest B is called while guest A is still at the sharing screen for another 30 seconds. | |
| Same anchor + fixed N-second delay | Avoids `session_end` entirely. N is a guess: fast guests waste time, slow guests still get cut off. | |

**User's choice:** Two separate anchors

### A session that never produces a print composite

| Option | Description | Selected |
|--------|-------------|----------|
| Distinct "finished, no photo" outcome | Booth IDLE immediately, no retry charged, guest not re-called. Directly serves criterion 3. | ✓ |
| Treat as a stall, requeue with retry | Guest is automatically called back to shoot again; exhausting the budget lands on `see_staff`. Risk: a guest who deliberately walked away gets recalled, and guest B waits out the cycle. | |
| Mark `failed` → `see_staff` | Simplest, reuses `failJob()`. Mixes a no-photo session into the same bucket as a retry-exhausted job, so an operator cannot tell them apart. | |

**User's choice:** Distinct "finished, no photo" outcome

### Photos produced with no dispatched session

| Option | Description | Selected |
|--------|-------------|----------|
| Drop with a warn | No completion, no notification, one warn line. Today's behaviour is the opposite: the Agent's never-cleared `activeJobId` sends a stranger's photo to the last real guest's email and phone. | ✓ |
| Still send to the guest who just finished | Only upside is that a genuinely late photo is never lost. Cannot distinguish the two cases, so the price is sending one person's photo to another. | |
| Record as an orphan photo for manual handling | As safe as dropping, without losing data. Costs a new table and an operational process nobody has committed to. | |

**User's choice:** Drop with a warn

---

## Session-to-job binding

### Where does the binding live?

| Option | Description | Selected |
|--------|-------------|----------|
| Extension Service only | Matches `CLAUDE.md`'s dumb-relay rule. No cross-repo deploy — and the Phase 3 Agent-auth cutover is still undeployed, so touching the Agent would drag it into this phase's window. | ✓ |
| Fix the Agent to clear `activeJobId` | Fixes the defect where it originates, 1-2 lines. Puts session-lifecycle state in the Agent and forces a synchronized both-or-neither deploy (OPS-RUNBOOK §7). | |
| Both | Two independent layers. Still forces the synchronized deploy, and the service layer masks the Agent layer so nobody can tell whether it works. | |

**User's choice:** Extension Service only
**Notes:** Consequence recorded explicitly in CONTEXT.md — the Agent bug is neutralised, not fixed, and is carried as a deferred idea.

### Source of truth for "which job owns this session"

| Option | Description | Selected |
|--------|-------------|----------|
| `booth_state.current_job_id` + cross-check | Additive column on the existing single-row table; survives restart alongside the state it belongs to. The event's jobId is used only to cross-check, warning on mismatch, so the Agent's stale stamp stays visible. | ✓ |
| `current_job_id`, ignore the event's jobId | Less code, fewer log lines. If the Agent stamps wrong again, nobody finds out — which is exactly what cost this phase its existence. | |
| Infer from `queue_job`, no schema change | No migration; tighten `completeInProgressJob()` and guard `updateJobStatus()`. "Which job holds the booth" stays an `ORDER BY … LIMIT 1` inference — the shape that produced the bug. | |

**User's choice:** `booth_state.current_job_id` + cross-check

### Holding a slot for a photo that arrives after the session closes

| Option | Description | Selected |
|--------|-------------|----------|
| Pending-print registry | Seeing the composite records "job X awaits its print upload" with a deadline; `file_upload param3='print'` resolves against the registry, not booth state, so the ordering against `session_end` stops mattering. Also moves WINDOWS 9's warn onto registry expiry, where it belongs. | ✓ |
| Two fields + grace window | `current_job_id` plus `last_completed_job_id` and a timestamp. Both fields must stay consistent, and it covers only one just-finished job. | |
| Delay clearing `current_job_id` by N seconds | Least code. If guest B is dispatched inside the window the field is overwritten and A's photo is lost — the exact queued scenario this phase exists to fix. | |

**User's choice:** Pending-print registry
**Notes:** Raised by the user's mid-discussion question about whether a retaken photo still reaches the webhook. The measured ordering conflicts — evidence file has the print upload 26s *before* `session_end`, WINDOWS 9 has it ~1s *after* — which is what made a booth-state-independent mechanism necessary.

### Where the registry lives

| Option | Description | Selected |
|--------|-------------|----------|
| SQLite, its own table | Phase 4's precedent: the work item is durable before anything external is depended on. Today's `printUploadSeen` is an in-memory `Set` (`queueService.ts:23`) lost on restart, and mid-session restarts have really happened here. | ✓ |
| In memory | Keeps the existing `Set` shape, adds only an expiry. A restart mid-flight means the photo lands with no owner and is dropped as out-of-session. | |
| Reuse `notification_record` | No new table; already keyed by jobId with `photoUrl` and `dueAt`. Adds a second meaning to a table whose `getDueNotifications` deliberately excludes `photoUrl IS NULL`, blurring a guarantee that currently holds structurally. | |

**User's choice:** SQLite, its own table

---

## No-photo outcome

### Shape of the "finished, no photo" outcome in data

| Option | Description | Selected |
|--------|-------------|----------|
| A sixth internal status | Added to `KNOWN_JOB_STATUSES`. `STATUS_MAP` is a full `Record` over that union, so an unmapped status is a compile error — measured as `TS2741` at plan 05-02. The wait-estimate query `WHERE status='completed'` excludes it by construction. | ✓ |
| Stay `completed`, add a reason column | Does not touch the vocabulary. No-photo sessions then fall into the wait-estimate sample (`localStore.ts:364`) and skew the estimate shown to queued guests. | |
| Infer from `notification_record` | No migration at all. Creates an implicit constraint between two tables owned by different phases, and an operator needs a join to answer "did this session produce a photo". | |

**User's choice:** A sixth internal status

### What the guest sees

| Option | Description | Selected |
|--------|-------------|----------|
| `see_staff` + `photoDelivery: 'failed'` | Reuses the closed six-word vocabulary. From the guest's side the required action is identical to a retry-exhausted job; the operator-side distinction is carried by the internal status. | ✓ |
| A seventh word (e.g. `finished_no_photo`) | More precise about what happened. Reopens the vocabulary Phase 5 deliberately closed, and names the situation without telling the guest what to do next. | |

**User's choice:** `see_staff` + `photoDelivery: 'failed'`

### A print photo that arrives after the no-photo conclusion

| Option | Description | Selected |
|--------|-------------|----------|
| Deliver it, do not change the job status | The guest gets their photo late rather than never; Phase 4's D-05 guarantee that terminal rows are never re-armed stays intact. One warn, because a recurring one means the deadline is too tight. | ✓ |
| Drop it with a warn | Perfectly consistent with the out-of-session rule, one code path, no special case. The guest loses a real photo because fotoshare was slower than our timeout. | |
| Deliver it and reopen the job as completed | Most faithful to what actually happened. Requires overwriting a terminal row, breaking the structural guarantee, and mutating session-duration data after it has been read. | |

**User's choice:** Deliver it, do not change the job status

---

## Agent event observability

### How criterion 5 is met

| Option | Description | Selected |
|--------|-------------|----------|
| Fixed `info`, one line per event | Covers `session_start` (writes nothing today) and the seven types falling into the `debug` catch-all at `queueService.ts:247`. The Agent already logs every trigger at `info`. ~15 lines per session on one booth. Needs neither redeploy nor restart. | ✓ |
| A dedicated config key | Separates event-stream verbosity from `LOG_LEVEL`. Still needs a process restart to take effect — at exactly the moment nobody wants to restart. | |
| Runtime-togglable | Literally satisfies "without a redeploy". Adds a write surface needing its own IP allow-list, a new capability outside this phase's subject. | |

**User's choice:** Fixed `info`, one line per event

### What each line carries

| Option | Description | Selected |
|--------|-------------|----------|
| Event name + jobId + lifecycle params | Enough to reconstruct a retake sequence, including the print composite path and `file_upload`'s `param3`. Excludes the fotoshare URL — a capability URL to the guest's photo, and the masking filter knows emails and phones but not URLs. | ✓ |
| Full raw payload | Never short of information during an investigation. Puts guests' photo URLs in the service's main log. | |
| Event name + jobId only | Smallest surface, no risk. Loses `param5` — the exact datum the whole design is anchored on, and the first thing to look at when it misbehaves. | |

**User's choice:** Event name + jobId + lifecycle params

### Distinguishing a retake from a no-photo session

| Option | Description | Selected |
|--------|-------------|----------|
| One summary line at job close | jobId, capture count, composite seen or not, duration, outcome. Grep one token, get the whole session. Also makes retake count a measured quantity for the first time. | ✓ |
| The event sequence is enough | Repeated `capture_start` is the retake; `processing_start` present or absent is the photo. No new code. Requires reading the sequence by eye every time, mid-event. | |
| A counter column on `queue_job` | Outlives log rotation, queryable by SQL. An operator mid-event opens the log, not SQLite, and it adds a 13th column to that table. | |

**User's choice:** One summary line at job close

### Where criterion 6's live retake test sits

| Option | Description | Selected |
|--------|-------------|----------|
| Phase gate at the end, after the code | Matches this project's unbroken precedent — no agent has self-approved a gate through Phases 1-6. D-01's anchor was chosen so the design does not need the answer in advance. Inherits two prerequisites: deploy the Phase 3 Agent-auth cutover, and mark ticket `3X818VEJ` failed by hand. | ✓ |
| Measure first, block the phase | Design would rest on end-to-end measured data. The phase stalls until someone stands at the booth, and the data would confirm rather than change any decision already made. | |
| Measure in parallel, non-blocking | Research proceeds; whoever is free goes and measures. "Whoever is free" is how a task never gets done, and criterion 6 would close on assertion rather than measurement. | |

**User's choice:** Phase gate at the end, after the code

---

## Claude's Discretion

- All timing values and their defaults (booth-release fallback deadline, pending-print registry expiry), injectable per Phase 2's pattern
- The sixth status's name, and the registry table's name and column shape, provided the migration is additive and idempotent
- Whether and how the jobId-mismatch warn is throttled
- Whether the summary line is emitted from the completion path or the booth-release path
- How the capture count is derived

## Deferred Ideas

- Clear `activeJobId` in the Agent (`dslrbooth-agent/src/index.ts:84`) — the actual root cause, neutralised rather than fixed here to keep the undeployed Phase 3 auth cutover out of this deploy window
- Match the print upload to its composite by filename, if `file_upload` turns out to carry one — unverified, the evidence capture records only `param2` and `param3`
- Alert the no-print condition outward through `NOTIFY_WEBHOOK_URL` (Phase 6 D-09's channel) — not adopted, nobody asked to be paged for one guest's missing photo
- Multi-booth — out of scope per `PROJECT.md`; `booth_state`'s `CHECK (id = 1)` enforces the single-booth assumption structurally
