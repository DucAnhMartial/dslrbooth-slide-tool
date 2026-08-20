# Phase 7: Session Lifecycle & Retake - Context

**Gathered:** 2026-08-12
**Status:** Ready for planning

<domain>
## Phase Boundary

Make one photo session map to exactly one guest, and one guest to exactly one
completion — including when the guest retakes, when dslrBooth re-emits
`session_end`, and when a second guest is already queued behind the first.
Restore the visibility of the Agent event stream that this work has to be
debugged through.

Everything before the booth session — ingestion, the VIEW, the queue's FIFO
ordering, the Agent transport and its auth — is built and verified in Phases 1-6
and is **not** re-opened. The notification *delivery* mechanism (Phase 4's
durable sweeper, its retry budget, its payload shape) is not re-opened either;
what changes is only **which job** a photo is attributed to and **when** the
attribution is decided.

**Out of scope:** the CMS and the event display (Phase 8), the Agent
configuration UI (deferred from Phase 6), `web-slide`, any change to ingestion,
and any change to how notifications are delivered once a job is correctly
identified.

**A hard constraint carried in from `mirror-request/CLAUDE.md`, reaffirmed by
the human during this discussion:** all business logic lives in the Extension
Service; the Agent is a dumb relay. D-04 makes this binding for this phase —
the `dslrbooth-agent` repository is not modified at all.

</domain>

<decisions>
## Implementation Decisions

### What ends a session

- **D-01:** The **print composite** is the completion anchor. A job completes
  when the service sees the print composite named — `processing_start.param5`
  or `printing.param1`, which both carry the same path
  (`...\Prints\20260812_143526_970.jpg`) at 07:35:26 in the evidence file.
  `session_end` is **not** the anchor and cannot be: it carries an empty
  payload `{}` and fires on every exit from the sharing screen — measured three
  times in 52 seconds for one photo session, twice of them from merely browsing
  the gallery afterwards.

  **Why this survives the open research question.** The one thing nobody has
  measured is what a retake emits. The print composite is a *positive* signal
  ("a composite was produced"), and a retake happens inside the capture phase,
  *before* `processing_start` — so a retake cannot reach this anchor no matter
  which events it fires. A design keyed on "the first `session_end` after a real
  capture" would have to know the answer first. This one does not.
  — **Reversibility:** costly — the anchor is the axis every other decision here
  turns on (D-02, D-03, D-06, D-09). Changing it later means revisiting all of
  them, though no persisted data format depends on it directly.

- **D-02:** **Job completion and booth release are two separate anchors, not
  one.** The job completes at the print composite; the booth stays `BUSY` until
  the first `session_end` after that. The guest finishes looking at their photos
  and leaves before the next guest is called — the anchor fires about 30 seconds
  before the guest actually walks away (07:35:26 vs 07:35:57).

  **This needs its own fallback timer, and it must not be BTH-02's.**
  `busyTimer` routes through `handleStall()` (`queueService.ts:139`), which
  charges a retry and requeues the job. Applied to a job that has already
  completed and already has a photo, that would call the guest back to the
  camera. The release fallback must return the booth to service without touching
  the job.
  — **Reversibility:** reversible — collapsing the two anchors back into one is
  a local change; no persisted state distinguishes them.

- **D-03:** A session that ends with **no print composite ever seen** completes
  with a **distinct outcome**, not as a stall. Booth `IDLE` immediately, **no
  retry charged**, guest not re-called. This is what makes ROADMAP criterion 3
  ("a session that truly ends with no photo is visible as such, distinctly from
  a retake and from a normal session") achievable rather than aspirational.

- **D-04:** Photos produced while the service has **no dispatched session** are
  dropped, with one `warn`. Today the opposite happens, and it is worse than
  losing a photo: the Agent stamps `activeJobId` onto every outbound event
  (`dslrbooth-agent/src/index.ts:107`) and **never clears it** — the identifier
  has exactly three occurrences in the repository (`:44` declaration, `:84`
  assignment on ack, `:107` use), and none of them is a reset. So a stranger who
  walks up and presses start on the booth's own screen gets their photo sent to
  the email and phone number of the last real guest.

### Where the session ↔ job binding lives

- **D-05:** The fix is **Extension Service only**. The `dslrbooth-agent`
  repository is not touched. Two reasons, both load-bearing: `CLAUDE.md`'s
  dumb-relay rule means session-lifecycle state does not belong in the Agent;
  and any cross-repo change forces the synchronized-deploy / both-or-neither
  rollback window of OPS-RUNBOOK §7 — while the **Phase 3 Agent-auth cutover is
  still undeployed**, which would make this phase's deploy carry that one too.

  Note the consequence, and do not soften it: the Agent's stale-jobId bug is
  **not fixed** by this phase. It is *neutralised* by D-06. A future phase that
  touches the Agent should still clear `activeJobId` — recorded under Deferred.

- **D-06:** `booth_state` gains **`current_job_id`** as the single source of
  truth for "which job owns the booth right now". Written when the session is
  dispatched/acknowledged, cleared when the booth is released. Every event is
  attributed through it.

  **The jobId on an incoming event is used only as a cross-check.** On mismatch
  the event is dropped and one `warn` is written naming both ids. This is the
  deliberate choice over ignoring the field entirely: the Agent's stale stamp is
  precisely the defect that cost this phase its existence, and a design that
  silently papers over it would make the next occurrence invisible too.

  `booth_state` is already a single-row table (`id INTEGER PRIMARY KEY CHECK (id
  = 1)`, columns `state` and `updated_at`), so the value persists across restart
  in the same place, and by the same mechanism, as the state it belongs to.
  — **Reversibility:** costly — an additive column plus a migration; the
  attribution path is rewritten around it.

- **D-07:** A **pending-print registry** holds the slot for a photo that has not
  arrived yet. Seeing the print composite records "job X is awaiting its print
  upload" with a deadline; a later `file_upload` with `param3 === 'print'`
  resolves against **the registry, not the booth state**.

  **This is not an optimisation, it closes a hazard D-04 would otherwise
  create.** The order of the print upload relative to `session_end` is not
  fixed — the evidence file has it 26 seconds *before* (07:35:31 vs 07:35:57),
  while WINDOWS item 9 measured it ~1 second *after* on job `BZWCWFN6`. Without
  the registry, D-04's "no dispatched session → drop" rule would swallow the
  guest's real photo in exactly the `BZWCWFN6` ordering.

  **It also corrects WINDOWS item 9 as a side effect.** The `No print upload
  seen` warn moves off `session_end` and onto **registry expiry** — so it fires
  when a print genuinely never arrives, instead of on every successful session
  as it does today.

- **D-08:** The registry lives in **SQLite, in its own table**. Phase 4's
  precedent is explicit: the work item is written to SQLite *before* anything
  outside the process is depended on. Today's equivalent, `printUploadSeen`
  (`queueService.ts:23`), is an in-memory `Set` and does not survive a restart —
  and a restart mid-session is a documented event in this project's history, not
  a hypothetical.

  Not folded into `notification_record`: that table carries Phase 4's "deliver a
  photo to a guest" semantics, and `getDueNotifications` deliberately excludes
  `photoUrl IS NULL` rows. Adding a second meaning would blur a guarantee that
  currently holds structurally.
  — **Reversibility:** costly — a new table and migration; the notification
  trigger path is rerouted through it.

### The no-photo outcome

- **D-09:** "Finished, no photo" is a **sixth internal job status**, added to
  `KNOWN_JOB_STATUSES` (`src/status/guestStatus.ts:71`; today: `queued`,
  `dispatched`, `in_progress`, `completed`, `failed`).

  Two properties earn it over a reason column. First, `STATUS_MAP` is a
  `Record<InternalJobStatus, …>` derived from that same array, so **forgetting
  to map the new status is a compile error** — measured at plan 05-02, where a
  temporary sixth member produced `TS2741`. Second, the wait-estimate sample
  query is `WHERE status = 'completed'` (`localStore.ts:364`), so a no-photo
  session is excluded from the guests' wait estimate by construction rather than
  by a filter someone could delete.
  — **Reversibility:** costly — the status is persisted in `queue_job`; removing
  it later needs a data migration, and it is a member of a union the router is
  compile-checked against.

- **D-10:** The guest sees **`see_staff`**, with `photoDelivery: 'failed'`. The
  six-word vocabulary Phase 5 deliberately closed (D-11) is **not** reopened.
  Rationale as stated by the human's selection: from the guest's side the
  required action is identical to a retry-exhausted job — go find a person — and
  a seventh word would name the situation without telling them what to do. The
  operator-side distinction is already carried by the internal status from D-09.

- **D-11:** A print photo that arrives **after** the registry entry has expired
  and the job was already closed as no-photo is **still delivered to the guest**,
  and the job's status is **not** changed. The guest getting their photo late
  beats not getting it; and Phase 4's D-05 guarantee — a terminal row is never
  re-armed, enforced in the SQL rather than by a condition — stays intact. One
  `warn` records the late arrival, because a recurring one means the deadline is
  set too tight.

### Observability

- **D-12:** Every AGT-04 event gets **one `info` line, unconditionally**. No new
  config key, no runtime toggle. Today `session_start` writes nothing at all and
  the other seven types fall into a `debug` "Unhandled Agent event" branch
  (`queueService.ts:247`) — of the ten types AGT-04 lists, the operator can see
  two. The Agent side already logs every trigger at `info`
  (`dslrbooth-agent/src/triggers/server.ts`); this brings the service into line
  with it. At roughly 15 lines per session on a single booth, the volume does
  not justify a knob — and a knob would need a restart to turn, which is exactly
  the moment nobody wants to restart.

- **D-13:** Each line carries the **event name, the attributed jobId, and the
  lifecycle-relevant params** — the print composite path, `file_upload`'s
  `param3` type. It does **not** carry the fotoshare URL at `info`. That URL is
  a capability URL to the guest's photo: anyone who can read the log can view
  the photo, rotated logs keep it for days, and the masking filter recognises
  emails and phone numbers but has no concept of a URL. The notification path
  already carries the URL where it is actually needed.

- **D-14:** At job close, **one summary line**: jobId, capture count, whether a
  print composite was seen, duration, outcome. This is what actually discharges
  ROADMAP criterion 3 — an operator greps one token and gets the whole session,
  instead of reading fifteen lines backwards mid-event. It also makes the retake
  count a measured quantity for the first time; nobody currently knows how many
  retakes a real session contains.

### Verification

- **D-15:** ROADMAP criterion 6 (retake exercised end to end at the booth, with
  a second guest queued) is a **phase gate at the end**, answered by a human —
  matching this project's unbroken precedent through Phases 1-6, where no agent
  has ever self-approved a gate. It does **not** block research or planning,
  because D-01's anchor was chosen specifically so the design does not depend on
  knowing what a retake emits.

  **Two prerequisites the gate inherits and cannot discharge itself:** the Phase
  3 Agent-auth cutover must be deployed (server and Agent together,
  OPS-RUNBOOK §7), and test ticket `3X818VEJ` must be marked `failed` by hand
  before any Agent connects, or it will be dispatched for a real session with
  nobody present (OPS-RUNBOOK §10 and §6).

### Claude's Discretion

- Every timing value and its default: the booth-release fallback deadline
  (D-02), the pending-print registry expiry (D-07/D-11). All must be injectable
  through the constructor per the pattern established in Phase 2, not read from
  a singleton.
- The name of the sixth internal status (D-09) and the registry table's name and
  column shape (D-08) — provided the migration is additive and idempotent, in
  the style of Phase 4's `notification_record` migration.
- Whether the mismatch warn in D-06 is throttled, and how (the concern is a
  stuck Agent producing one line per stray event; Phase 3's
  `agentOfflineDispatchSkipLogged` is the closest existing analog).
- Whether the D-14 summary line is emitted from the completion path or the booth
  release path, given D-02 separates them.
- Whether the "capture count" in D-14 is derived by counting `capture_start`
  events in the registry row or held separately.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Repository topology — read first, this project has three `.planning` trees

- `/opt/mirror_request_dslrobooth/.planning/` — **the only authoritative
  planning tree.** `mirror-request/.planning/` and `dslrbooth-agent/.planning/`
  are stale, git-tracked, and must never be read or written. Plan 03-03 wrote to
  the stale tree by accident because a tool resolved its cwd from inside
  `mirror-request/`; run planning tools from `/opt/mirror_request_dslrobooth`.

### The measured evidence — binding, and it outranks research

- `.planning/phases/07-session-lifecycle-retake/07-EVIDENCE-dslrbooth-triggers.md`
  — **read this first.** The operator's own trigger capture from the booth,
  2026-08-12. Its six numbered findings are measurement, not inference; if
  research contradicts it, the research is wrong. It is also explicit about what
  it does *not* answer, and those gaps are the research brief.
- `.planning/ROADMAP.md` § "Phase 7: Session Lifecycle & Retake" — the goal, the
  six success criteria, and the research questions marked ANSWERED vs STILL
  OPEN. **One correction to record:** the "STILL OPEN, now the central question"
  item — what returned `BZWCWFN6` to `in_progress` — was answered during this
  discussion by reading source, not log: `dslrbooth-agent/src/index.ts` never
  clears `activeJobId` (three occurrences, `:44`/`:84`/`:107`, no reset), so
  every post-session event carries the finished job's id, and
  `queueService.ts:242` turns a stray `session_start` into `sessionAcked(jobId)`
  against an unguarded `UPDATE ... WHERE id = ?` (`localStore.ts:187`). The
  unfiltered Agent log is no longer a prerequisite for that question.
- `.planning/WINDOWS.md` items **8** and **9** — both `open`, both owned by this
  phase. Item 8 is the duplicate-completion defect; item 9 is the false
  `No print upload seen` warn, which D-07 closes as a consequence rather than a
  separate fix.
- `.planning/STATE.md` — the `stopped_at` field carries the `BZWCWFN6` run's
  full measured detail.

### Prior decisions that constrain this phase — none are re-opened

- `.planning/phases/02-queue-booth-state/02-CONTEXT.md` — the bounded retry
  policy (D-05..D-07) that D-02's fallback timer must **not** route through, and
  the restart-recovery sweep.
- `.planning/phases/03-agent-websocket-link/03-CONTEXT.md` — D-01/D-13: a
  system-side fault never charges the guest a retry. D-05's one-way auth cutover
  is why D-05 here refuses to touch the Agent repo.
- `.planning/phases/04-guest-notification/04-CONTEXT.md` — D-05 (terminal rows
  are never re-armed, enforced in SQL) is what D-11 is written to preserve; the
  durable-work-item-before-network-call pattern is D-08's precedent.
- `.planning/phases/05-client-api-display-feed/05-CONTEXT.md` — D-11's closed
  six-word guest vocabulary, which D-10 declines to reopen, and D-12's separate
  `photoDelivery` field, which D-10 uses.
- `.planning/phases/06-ingestion-cutover/06-CONTEXT.md` — D-08: `mode` reaches
  dslrBooth unvalidated and the VIEW emits the literal `'print'`, which is why
  the print composite exists on every real session at all.
- `.planning/REQUIREMENTS.md` — QUE-04, BTH-01, BTH-02, AGT-04 are all marked
  `[x]` from Phases 2 and 3 and are **revisited** here, not newly built.
- `mirror-request/CLAUDE.md` — the dumb-relay hard rule behind D-05.

### Extension Service source — the code being changed

- `mirror-request/src/queue/queueService.ts` — `sessionEnded()` `:164`,
  `sessionAcked()` `:186`, `onAgentEvent()` `:239`, `handleStall()` `:139`, the
  in-memory `printUploadSeen` `:23`, and the debug catch-all `:247`. This is the
  phase's centre of gravity.
- `mirror-request/src/state/localStore.ts` — `completeInProgressJob()` `:220`
  (the unscoped `ORDER BY acknowledged_at DESC LIMIT 1` at the heart of WINDOWS
  8), `updateJobStatus()` `:186` (the unguarded `UPDATE ... WHERE id = ?`), the
  `booth_state` table `:66`, and the wait-estimate query `:364`.
- `mirror-request/src/status/guestStatus.ts` — `GUEST_STATUSES` `:14`,
  `PHOTO_DELIVERY_STATES` `:35`, `KNOWN_JOB_STATUSES` `:71`, `STATUS_MAP` `:94`.
  D-09 and D-10 both land here.
- `mirror-request/src/agent/agentServer.ts` — `:123-131`, where an `event`
  message is unpacked into `(eventType, jobId, payload)`. D-06's cross-check
  reads the `jobId` this passes through.
- `mirror-request/src/notifications/notificationService.ts` — the delivery path
  D-07 reroutes the *trigger* of, without changing the delivery itself.
- `mirror-request/docs/OPS-RUNBOOK.md` — §6 (stuck jobs and the session-side
  vocabulary), §7 (deploy and the cross-repo rule), §8 (notification contract),
  §10 (the standing `3X818VEJ` action). All four need the new outcome, the new
  status word and the new config keys recorded.

### Agent repository — read-only this phase, changed in none of it

- `dslrbooth-agent/src/index.ts` — HEAD `e376696`. `:44`/`:84`/`:107` are the
  entire `activeJobId` lifecycle; `:98-111` is the forward-everything handler.
- `dslrbooth-agent/src/triggers/server.ts` — `/dslrbooth-event`, which already
  logs every trigger at `info`. D-12 brings the service to parity with it.

### Codebase maps — treat as stale

- `.planning/codebase/INTEGRATIONS.md` — mapped 2026-08-10 and wrong in two
  places already (it predates Phase 3's header auth and Phase 5's `/display`
  allow-list). Orientation only; verify every claim against source.
- `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/CONVENTIONS.md`.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- `booth_state` (`localStore.ts:66`) — already a single-row table with a
  `CHECK (id = 1)` constraint and an `INSERT OR REPLACE` writer. D-06's
  `current_job_id` is an additive column on it, not a new mechanism.
- `notification_record`'s migration (Phase 4, plan 04-01) — the worked example
  for D-08's additive, idempotent, honest-failure migration, including its
  backfill posture for pre-existing rows.
- `QueueService`'s constructor config injection (Phase 2 D-13, proved by
  `test/queue-config-injection.test.ts`) — every timing value in D-02 and D-07
  follows it.
- `agentOfflineDispatchSkipLogged` (`queueService.ts`, Phase 3 D-04) — the
  project's existing shape for "log this condition once, not once per event",
  the closest analog for throttling D-06's mismatch warn.
- `guestStatus.ts`'s array-derived unions — the mechanism that turns D-09's new
  status into a compile error until it is mapped. Do not hand-write the union.

### Established Patterns

- **Omission as guarantee.** Phase 2's `requeueWithRetry`, Phase 4's
  `getDueNotifications`, Phase 6's VIEW join: structural guarantees are
  expressed by what the SQL leaves out, never by an `if` a later edit can
  delete. D-11 depends on this holding for terminal rows.
- **A system-side fault never charges the guest a retry.** Phase 3 D-01/D-13.
  D-02's fallback timer and D-03's no-photo close both inherit it.
- **Never crash on a boundary; log and continue.** Phase 1 D-05, Phase 4 D-10,
  Phase 6 D-09.
- **Tests are proved non-vacuous by mutation.** Plans 04-03, 05-02, 06-01 and
  06-03 all temporarily broke the guard under test, watched the right tests
  fail, and reverted. Expect the same here — several of this phase's assertions
  will pass at RED because the code path already exists.
- **Comment-matching greps have produced four false positives in this project.**
  Any count used to justify a decision must be verified by opening the files.

### Integration Points

- `queueService.ts:164` `sessionEnded()` — currently does completion, booth
  release and the print warn in one function. D-02 splits the first two; D-07
  moves the third.
- `queueService.ts:239` `onAgentEvent()` — the single entry point every decision
  here funnels through. `session_end` currently ignores `jobId` entirely;
  `session_start` trusts it without a guard.
- `localStore.ts:220` `completeInProgressJob(endedAt)` — its signature has no
  jobId parameter at all. D-06 changes that, and the change is visible to every
  caller.
- `localStore.ts:364` — the wait-estimate sample query. D-09's new status
  silently changes what this samples; that is intended, and worth a test.
- `notificationService.sendPhotoLink(jobId, url)` — the seam D-07 reroutes the
  trigger of. Its own contract does not change.

</code_context>

<specifics>
## Specific Ideas

The human's framing, which shaped D-01: **the print composite is the firmer
anchor, and `session_end` is not an ending.** The evidence file states it as
measurement — `processing_start.param5` and `printing.param1` both name
`Prints\20260812_143526_970.jpg` from 07:35:26, five seconds before its own
upload and thirty before `session_end`, while `session_end` fires on every exit
from the sharing screen.

Asked mid-discussion, and it changed the design: *"nếu người dùng chụp lại ảnh
ok thì webhook có nhận ảnh nữa không"* — if the guest retakes and is happy, does
the webhook still get the photo? The answer under this design is **yes**: the
retake sits inside the capture phase, so the accepted shot produces the print
composite normally and the print `file_upload` follows with its URL. But
answering it surfaced that D-04's drop rule and the variable ordering of the
print upload relative to `session_end` would together have eaten the guest's
photo in exactly the `BZWCWFN6` case. D-07 exists because of that question.

The human's consistent preference across all four areas, worth carrying into
planning: **make the failure visible rather than absorb it.** Chosen at D-04
(warn on out-of-session photos), D-06 (cross-check the Agent's jobId and warn on
mismatch rather than ignore the field), D-11 (warn on a late arrival because it
means the deadline is wrong), and D-14 (a summary line so a retake is a counted
thing). Where a cheaper silent option existed, it was declined every time.

</specifics>

<deferred>
## Deferred Ideas

- **Clear `activeJobId` in the Agent.** The real root cause of WINDOWS item 8
  lives at `dslrbooth-agent/src/index.ts:84` — it is set on ack and never reset.
  D-05 neutralises its effect from the service side rather than fixing it,
  deliberately, to avoid dragging the undeployed Phase 3 auth cutover into this
  phase's deploy window. A future phase that opens the Agent repo for any reason
  should clear it, and D-06's mismatch warn is what will tell anyone whether it
  is still firing.
- **Match the print upload to the composite by filename.** The composite's path
  is known at `processing_start`; if `file_upload` also carries the filename,
  attribution could be exact rather than registry-ordered. The evidence capture
  records only `param2` (URL) and `param3` (type) for `file_upload`, so this is
  unverified and was not built on. Cheap to revisit once someone captures a full
  `file_upload` parameter set.
- **Alerting the no-print condition outward.** D-12/D-14 make it visible in the
  log; Phase 6's D-09 established a `NOTIFY_WEBHOOK_URL` alert channel that
  could carry it further. Not adopted — no one asked for a page on a single
  guest's missing photo.
- **Multi-booth.** Every decision here assumes one booth, and `booth_state`'s
  `CHECK (id = 1)` enforces it structurally. `PROJECT.md` puts multi-booth out
  of scope; D-06 does not make it harder, but it does not anticipate it either.

</deferred>

---

*Phase: 07-session-lifecycle-retake*
*Context gathered: 2026-08-12*
