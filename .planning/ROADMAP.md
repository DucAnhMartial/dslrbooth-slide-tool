# Roadmap: Extension Service

## Milestone Overview

| Milestone | Target | Focus | Status |
|-----------|--------|-------|--------|
| **M1: Foundation & Ingestion** | Week 1 | SQLite, /on-register, DB polling | Complete |
| **M2: Queue & Booth State** | Week 1-2 | FIFO queue, IDLE/BUSY, timeout | Complete |
| **M3: Agent Link (WebSocket)** | Week 2 | WS command/event/heartbeat | Complete |
| **M4: Guest Notification** | Week 2-3 | file_upload → webhook | Complete |
| **M5: Client API & Display Feed** | Week 3 | /status, WS /display | Complete |
| **M6: Ingestion Cutover** | — | ets_web VIEW, first real guest | Complete |
| **M7: Session Lifecycle & Retake** | — | retake, duplicate session_end, event visibility | Next |
| **M8: CMS & Event Display** | — | per-event config, standby screen, one feed | Planned |

## M1: Foundation & Ingestion

**Req:** ING-01..03, STO-01, AUTH-02
**Success:**

1. `npm run dev` starts server without errors
2. POST /on-register returns 200, logs payload (masked)
3. SQLite file created with schema (queue, booth_state, db_cursor, job_history)
4. DB polling runs every Ns via SELECT, updates cursor locally
5. /on-register rejects non-whitelisted IPs with 403

## M2: Queue & Booth State

**Req:** QUE-01..04, BTH-01..02
**Success:**

1. Multiple registrations queued in FIFO, logged with position numbers
2. Duplicate record IDs detected and skipped
3. Booth IDLE → dispatch first job → become BUSY
4. session_end → booth IDLE → auto-dispatch next job
5. BUSY > 5min without session_end → auto-reset IDLE + warning

## M3: Agent Link

**Req:** AGT-01..05, AUTH-01
**Success:**

1. Agent connects with token, rejected without
2. Dispatch fires {type, action, jobId, mode} via WS
3. Agent ack {jobId, ok} logged, triggers IDLE transition
4. Events from Agent received and processed
5. No heartbeat 30s → Agent offline in status API

## M4: Guest Notification

**Req:** NOT-01..02
**Success:**

1. file_upload → look up guest by jobId → send via webhook
2. Failed sends retried N times, then logged

## M5: Client API & Display Feed

**Req:** API-01..02, AUTH-03
**Success:**

1. GET /status/:jobId returns queue position + estimated wait
2. WS /display broadcasts: current guest + Agent online/offline
3. Sensitive data masked in all logs

## M6: Ingestion Cutover

**Req:** ING-02..03
**Success:**

1. A real landing-page registration reaches the booth queue, with zero web-ticket code changes
2. Cancelled / unpaid registrations are structurally excluded from the queue
3. No guest is lost to a `registered_at` tie or to unseeded-cursor backfill
4. Service DB credentials read `ets_web` and cannot write to it
5. A VIEW broken by an upstream migration is detected before an event, not during one
6. `/status/:jobId` is rate-limited (`registrations.id` becomes `ticket_code` — CSPRNG-minted but only 40 bits)

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Agent WS disconnect mid-session | Medium | High | Timeout safety net; don't auto-dispatch |
| Mirror proxy drop packets | Medium | High | DB polling fallback |
| Email/SMS provider outage | Low | Medium | Retry + manual fallback |
| SQLite corruption on crash | Low | High | WAL; backup before migrations |
| Memory leak in WS | Medium | Medium | Profiling; cleanup |
| Upstream `ets_web` migration breaks the ingestion VIEW | Medium | High | Phase 6 §6: startup + periodic VIEW health probe, alert before an event |

### Phase 1: Foundation & Ingestion

**Goal:** Registrations reaching the central service are cryptographically authenticated, de-duplicated within a configurable window, and durably persisted in SQLite — with read-only MySQL polling recovering anything the webhook missed, and no PII or raw payload leaking into production logs.
**Requirements**: ING-01, ING-02, ING-03, STO-01, AUTH-02, AUTH-03
**Depends on:** Phase 0
**Plans:** 5/5 plans executed

> AUTH-03 is covered here only for the ingestion log surface (D-15/D-16); the remaining
> non-ingestion log surfaces stay with M5. AUTH-01 (Agent WS token) belongs to M3 — the
> `AUTH-01..03 | 1` row in REQUIREMENTS.md's traceability table is a bookkeeping error.

Plans:
**Wave 1**

- [x] 01-01-PLAN.md — Tracer: signed /on-register end-to-end (raw body → HMAC → IP → SQLite → 200), plus the full Phase 1 config surface

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 01-02-PLAN.md — Durable webhook replay state, timestamp freshness, and IP allow-list hardening behind one generic 403

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 01-03-PLAN.md — Read-only DB poller: typed config, warn-and-retry failure posture, reconciliation and audit-skip logs
- [x] 01-04-PLAN.md — Time-windowed duplicate detection (id first, email/phone fallback) returning the original jobId

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 01-05-PLAN.md — PII-free ingestion logs, one gated raw-payload debug route, and the Phase 1 integration-assumption checkpoint

### Phase 2: Queue & Booth State

**Goal:** Every registration is dispatched to the booth in the order it arrived, and no fault — a dead Agent, a lost acknowledgement, or a service restart — can leave the booth permanently BUSY or trap a guest behind a job that will never finish. Persisted booth state is reconciled against wall-clock age before the first tick of every startup, and a stalled job is retried a bounded number of times from its original place in line before failing with a recorded reason.
**Requirements**: QUE-01, QUE-02, QUE-03, QUE-04, BTH-01, BTH-02
**Depends on:** Phase 1
**Plans:** 4/4 plans executed

Success criteria (from M2):

1. Multiple registrations queued in FIFO, logged with position numbers
2. Duplicate record IDs detected and skipped
3. Booth IDLE → dispatch first job → become BUSY
4. session_end → booth IDLE → auto-dispatch next job
5. BUSY > 5min without session_end → auto-reset IDLE + warning

> Hardening pass over working code, not greenfield: `src/queue/queueService.ts` (195 lines)
> already implements the three-state loop and is wired into `src/index.ts`. The phase exists to
> close a confirmed live defect — `booth_state` stuck `BUSY` since 2026-08-10T04:29:42Z with four
> jobs stranded in `dispatched` and one guest queued behind them — caused by the session timeout
> living in an in-memory `setTimeout` while the state persists to SQLite.

Plans:
**Wave 1**

- [x] 02-01-PLAN.md — Tracer: end-to-end restart recovery (persisted booth age → sweep every in-flight row → bounded retry preserving queue position), plus typed config injection and the real Winston logger

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 02-02-PLAN.md — The live BUSY timeout and the Agent NAK join the same bounded retry budget; both semantically wrong timestamp writes removed
- [x] 02-03-PLAN.md — FIFO position logging at the enqueue choke point, ordering and idempotency guarantees proved against real SQL, and the operator runbook for the state machine and stuck jobs

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 02-04-PLAN.md — Config-injection and full transition-sequence tests, plus the blocking live-database restart verification

### Phase 3: Agent WebSocket Link

**Goal:** Every command the queue sends reaches a booth that is actually there, over a link only an authenticated Agent can open. The Agent's credential travels in an `Authorization: Bearer` header and is verified in constant time at the HTTP upgrade step, so an unauthorized peer never holds an open socket even briefly; the dispatch command finally carries the mode the guest registered for; every event the booth emits reaches a defined outcome; and when the Agent is absent, dies mid-session or is evicted by the heartbeat watchdog, the queue holds the job in its original place in line and returns the booth to service without ever charging the guest a retry for the booth's fault.
**Requirements**: AGT-01, AGT-02, AGT-03, AGT-04, AGT-05, AUTH-01
**Depends on:** Phase 2
**Plans:** 5/5 plans executed

Success criteria (from M3):

1. Agent connects with token, rejected without
2. Dispatch fires {type, action, jobId, mode} via WS
3. Agent ack {jobId, ok} logged, triggers IDLE transition
4. Events from Agent received and processed
5. No heartbeat 30s → Agent offline in status API

> Hardening pass over working code in **two repositories**, not greenfield — the first phase to
> span both. `mirror-request/src/agent/agentServer.ts` (145 lines) and
> `dslrbooth-agent/src/websocket/connection.ts` (185 lines) already work today. D-05 moves the
> credential from the query string to a header with no dual-accept path, so server and Agent must
> deploy together; that is one-way, and 03-01 gates it behind an explicit decision checkpoint.
> Research also surfaced a fifth gap outside D-01..D-14: `dispatchJob()` never sends `mode`, so
> every session the booth has ever run used the Agent's hardcoded fallback.

Plans:
**Wave 1**

- [x] 03-01-PLAN.md — Tracer: header-only Bearer auth rejected with 401 before the handshake, end to end across both repos, plus the Agent repo's first test harness

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 03-02-PLAN.md — Transport observability and liveness: displaced-Agent warning, collision-proof connection ids, injectable heartbeat timing with AGT-05's first test, and the disconnect seam
- [x] 03-03-PLAN.md — Dispatch connectivity gate at both the tick and the countdown, logged once per outage, and the dispatch payload finally carrying the guest's `mode`

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 03-04-PLAN.md — Disconnect returns the guest to the queue with no retry charged and no double-fire with the session timer, plus a defined outcome for all ten Agent event types

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 03-05-PLAN.md — OPS-RUNBOOK §7: the Agent auth contract, the synchronized-deploy and both-or-neither rollback rules, and the cross-repo phase gate

### Phase 4: Guest Notification

**Goal:** When the booth finishes a session the guest's photo reaches the slideshow, and it stays reachable across a restart — because the work item is written to SQLite carrying the photo URL *before* any network call is made, and a periodic sweeper delivers whatever is due. Delivery is bounded in both time and attempts: a hung receiver aborts at a configured deadline, a failing one is retried a stated number of times and then recorded as terminally failed with a reason an operator can look up by guest name. A notification is never delivered twice, because the terminal states are absent from every query the sweeper runs rather than guarded by a condition a later edit could delete.
**Requirements**: NOT-01, NOT-02
**Depends on:** Phase 3
**Plans:** 4/4 plans executed

Success criteria (from M4):

1. file_upload → look up guest by jobId → send via webhook
2. Failed sends retried N times, then logged

> Partially built ahead of schedule: commit `5519364` landed webhook-based delivery in
> `src/notifications/notificationService.ts` plus `test/notification-{service,webhook}.test.ts`
> before this phase was planned. Planning audited that code rather than assuming greenfield.
> Two findings shape the plans. First, `notification_record` has never stored `photoUrl` — it
> exists only as a runtime argument off the live `file_upload` event — so a due-time column
> alone is insufficient and pre-existing rows are un-resumable by construction. Second, the
> receiver (`web-slide/server.js`) returns `200` unconditionally and falls back silently for
> missing fields, so a test asserting only the HTTP status proves nothing: every delivery test
> asserts the exact outbound body, and the phase gate requires one such assertion against a
> real ephemeral HTTP server covering a post-restart-resumed delivery.

Plans:
**Wave 1**

- [x] 04-01-PLAN.md — Tracer: end-to-end restart-resumed photo delivery (persisted `photoUrl` + due time → SQL-claimed sweeper → real HTTP round trip), plus the config surface, the honest migration, and the two pre-existing notification tests brought onto the new contract

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 04-02-PLAN.md — Failure posture: `AbortSignal.timeout()` on every attempt with timeout-versus-refusal classification, the bounded three-attempt budget proved, one operator-facing exhaustion line, and per-row isolation in the sweep
- [x] 04-03-PLAN.md — The storage contract proved where it is enforced: migration honesty and idempotency, terminal rows never re-armed, the photo URL surviving a status-only write, and the claim lease

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 04-04-PLAN.md — OPS-RUNBOOK §8: the published payload contract, status and failure vocabulary, the failed-delivery lookup and manual re-arm; plus the boundary check and the blocking live-data migration gate

### Phase 5: Client API & Display Feed

**Goal:** The two surfaces anyone other than an operator ever sees are honest and closed. A guest holding their own job id sees their position, their real registered name — a field that has been silently `null` on every response since the route shipped — and a wait range computed from the median duration of real completed sessions: never a hardcoded constant, never a precise ticking number, and never an estimate at all while the Agent is offline and nothing can be dispatched. Every terminal and fault state Phases 2 through 4 can produce resolves to exactly one of six guest-facing words, so a job that exhausted its retry budget tells the guest to see staff instead of leaving them polling a position forever, and every way of asking about a job that is not theirs — unknown, purged, someone else's, malformed — returns one byte-identical 404. The room's big screen is reachable only from allow-listed addresses, refused at the raw socket before the handshake rather than after it, and can no longer carry an operator's stall reason, retry count or ack error onto the wire, because the raw queue row never enters the broadcast path at all; it goes silent when nothing changes and ticks once a second only while a countdown runs. And every log line outside ingestion is proven on every commit to survive masking unchanged — including the connection ids the masking filter itself used to corrupt.
**Requirements**: API-01, API-02, AUTH-03
**Depends on:** Phase 4
**Plans:** 5/5 plans executed

Success criteria (from M5):

1. GET /status/:jobId returns queue position + estimated wait
2. WS /display broadcasts: current guest + Agent online/offline
3. Sensitive data masked in all logs

> AUTH-03's ingestion log surface was already delivered in Phase 1 (D-15/D-16). What remains
> here is the non-ingestion surfaces only.
>
> Fourth consecutive hardening pass over working code. Research verified three defects that are
> shipped and live today, not hypothetical: `/status/:jobId`'s `guestName` reads a property that
> never exists at runtime, so it has been `null` on every real response; `WS /display` puts a whole
> `queue_job` row on the wire four times a second — `stall_reason`, `retries`, `ack_error_message`
> included — to an endpoint with no access control; and `session_started_at`, which D-01 originally
> named as the wait estimate's data source, is declared but never written, so a query built on it
> would have returned zero samples forever with no error. D-01 was corrected to
> `completed_at - acknowledged_at`. D-07's premise — that the backend mints the job id with a
> CSPRNG — is unverifiable from inside this repository and gates the whole capability-URL design,
> so 05-01 opens with a blocking decision checkpoint before the route is redesigned.

Plans:
**Wave 1**

- [x] 05-01-PLAN.md — Tracer: a queued guest's position, real name and median-derived wait range end to end, behind D-07's blocking entropy checkpoint

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 05-02-PLAN.md — The closed guest vocabulary proved exhaustive, one indistinguishable 404 for every miss, and the estimate suppressed rather than faked when the booth cannot serve

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 05-03-PLAN.md — Both display surfaces gated by an address allow-list refused before the handshake, the leaking job row removed from the broadcast path by construction, change-driven broadcasting, given-name projection and an injected store

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 05-04-PLAN.md — AUTH-03's non-ingestion half: the connection id made structurally unmaskable, and a standing regression that every non-ingestion log line survives masking unchanged

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 05-05-PLAN.md — OPS-RUNBOOK §9: the two guest-facing read surfaces, the four new config keys, the accepted residual risks; plus the boundary checks, the ledger disposition and the blocking phase gate

### Phase 6: Ingestion Cutover

**Goal:** Real guests reach the booth. Every phase before this one was built and proven against a source of registrations that does not exist: `photobooth.registrations` is a purpose-made BASE TABLE holding zero rows, nothing on this host has ever POSTed to `/on-register`, and no nginx `mirror` directive exists anywhere — so the entire pipeline from ingestion to slideshow has never once been fed by a real person. This phase closes that gap without touching a line of web-ticket's code or a byte of its data: the empty table becomes a read-only VIEW over `ets_web`'s real ticket chain, and a guest who completes registration on the existing landing page appears in the booth queue with their own name. The VIEW's WHERE clause is the guarantee, not an `if` anyone can delete — a cancelled ticket or an unpaid order is structurally incapable of reaching the queue, which is precisely what the originally-intended nginx mirror could never promise, because a mirrored *request* fires before the response that decides whether registration even succeeded. Four measured hazards are closed with it: `mode` reaches dslrBooth's Local API unvalidated and must be a mode dslrBooth accepts; two tickets on one order share `created_at` to the microsecond while the poller advances its cursor with a strict `>`, so a batch boundary falling mid-tie drops a guest permanently and silently; the cursor starts at 1970, so enabling the poller unseeded would dispatch nine months-old test registrations to a booth with nobody standing at it; and the service's DB user cannot currently see `ets_web` at all.
**Requirements**: ING-02, ING-03
**Depends on:** Phase 5
**Plans:** 6/6 plans executed

Success criteria:

1. A registration completed on the existing landing page appears in the booth queue with the guest's real name, with zero changes to web-ticket code
2. Cancelled tickets and non-completed orders are structurally excluded — not filtered by application logic
3. No registration is lost to a `registered_at` tie at a poll-batch boundary
4. Enabling ingestion does not dispatch pre-existing historical rows
5. The service's DB credentials can read `ets_web` and cannot write to it
6. A broken VIEW (from an upstream `ets_web` migration) is detected before an event, not during one
7. `/status/:jobId` is rate-limited, because the id it treats as a credential is now known to carry 40 bits

> Measured 2026-08-11 against the live databases. `ets_web` and `photobooth` are on the same
> MySQL instance (`127.0.0.1`), so a cross-database VIEW is feasible. The join chain is
> `ticketing_ticket → ticketing_orderdetail → ticketing_order → ticketing_customer`, with
> `ticket_holder_id → account_personalinfo` carrying `first_name`/`last_name`/`phone`. A candidate
> SELECT was executed read-only and returns exactly the six columns `dbPoller.ts:101` queries,
> over real data: 27 tickets, of which 9 are `valid` + `completed`.
>
> The cost of integrating without a code change is a hidden coupling: the VIEW depends on
> `ets_web`'s table and column names, and an upstream migration breaks it silently on the
> photobooth side. Success criterion 6 exists to make that failure loud and early.

Plans:

**Wave 1**

- [x] 06-01-PLAN.md — Tracer: the exact projection executed read-only against live `ets_web` and bound through `LocalStore` into SQLite, proving the dedup CONTEXT D-03 did not anticipate, the order-tie dissolution, the non-empty name, and the mysql2 → better-sqlite3 bind hazard that has never once executed

**Wave 2** *(blocked on Wave 1)*

- [x] 06-02-PLAN.md — The VIEW health probe: two failure classes branched on `err.code`, alert through `NOTIFY_WEBHOOK_URL`, never blocks startup; plus D-05's name-fallback warn, exactly once per guest and restart-safe, with `dbPoller.ts` untouched
- [x] 06-04-PLAN.md — Cutover preparation: the cursor seed in the VIEW's own lexical format read from the MySQL server, the pre-phase `CREATE TABLE` and grant baseline captured into version control, and the generated cutover script

**Wave 3** *(blocked on Wave 2)*

- [x] 06-03-PLAN.md — A bounded hand-rolled rate limiter mounted ahead of `/status/:jobId`'s store lookup, with a throttled response identical for real and fabricated ids and no new npm dependency

**Wave 4** *(blocked on Wave 3)*

- [x] 06-05-PLAN.md — The live cutover behind a blocking `checkpoint:decision`: DROP TABLE / CREATE VIEW / GRANT, verified through the service account including a deliberate write that must be refused, then the cursor seeded and the service started

**Wave 5** *(blocked on Wave 4)*

- [x] 06-06-PLAN.md — OPS-RUNBOOK §10 plus the §3/§7 extensions, the ten boundary checks, the validation map bound, and the phase gate: one real registration on the live landing page, end to end

## M7: Session Lifecycle & Retake

**Req:** QUE-04, BTH-01..02 (revisited), AGT-04
**Status:** Not planned — raised 2026-08-12

### Phase 7: Session Lifecycle & Retake

**Goal:** One photo session must map to exactly one guest, and one guest to
exactly one completion — a promise the service does not currently keep. Every
test through Phase 6 ran with an **empty queue**, which is the only reason this
has never shown: with nobody waiting, a duplicated completion lands back on the
same job and looks harmless.

**What was measured, live, 2026-08-12 (job `BZWCWFN6`, single pm2 process, not
the earlier dual-server incident):** dslrBooth emitted `session_end` **twice**,
47 seconds apart (07:09:26 and 07:10:13), and both completed the job. The second
could only succeed if the job had returned to `in_progress` in between, and
exactly one code path writes that status — `sessionAcked()`, from a
`session_start` event. So the booth re-opened a session the service had already
closed.

**The operator's explanation, and why it makes this worse rather than better:**
dslrBooth offers **retake** — the guest rejects the shot and shoots again. The
Agent still reports `session_end`, and that end carries **no photo**. So the
duplicate pair is not a vendor bug to be tolerated; it is *normal guest
behaviour*, on a path with no photo at the end of it. Anyone who dislikes their
first shot walks straight into it.

**A better anchor than `session_end` already exists in the data:**
`processing_start.param5` and `printing.param1` both name the print composite
(`...\Prints\20260812_143526_970.jpg`) 5 seconds before its own upload and 30
seconds before `session_end`. A design keyed on the print composite has a
firmer footing than one keyed on an event that fires whenever a screen closes.

**Why it is dangerous with a queue:** `session_end` #1 completes guest A, sets
the booth IDLE and `tick()` dispatches guest B; B's `session_start` marks B
`in_progress`; then A's second `session_end` arrives and completes **B** —
because `completeInProgressJob()` (`localStore.ts:220`) selects
`WHERE status='in_progress' ORDER BY acknowledged_at DESC LIMIT 1` and is **not
scoped to a jobId**. B is freed while still at the camera, guest C is called,
and B's photo — if it ever arrives — is attributed to a session that no longer
exists. Every guest after the first is exposed.

**Research must establish, not assume** (this phase is research-led):

- What dslrBooth actually emits across a retake: the full trigger sequence, and
  whether `session_start` repeats, `session_end` repeats, or both.

- Whether a retake is distinguishable from a genuine session end at the moment
  it arrives — or only in hindsight, which would force a settle-delay design.

- ~~Which event carries an identifier tying it to its session~~ — **ANSWERED
  2026-08-12, and the answer closes a door**: `session_end` carries an empty
  payload `{}`. dslrBooth attaches no session identity at all, so scoping the
  completion by an id *in the event* is impossible. The binding can only come
  from state the Agent or this service keeps. See
  `07-EVIDENCE-dslrbooth-triggers.md`.

- **ANSWERED, and it reframes the phase**: `session_end` does not mean "the
  guest is finished". It fires on **every exit from the sharing screen** —
  measured three times in 52 seconds for one photo session, twice of them from
  merely browsing the gallery afterwards. The duplicate is normal machine
  behaviour, not an anomaly to detect.

- **STILL OPEN, and now the central question**: what returned `BZWCWFN6` to
  `in_progress` between its two completions. Only `session_start` and `ack`
  write that status, and the measured gallery-browsing sequence contains
  neither. Leading hypothesis: the Agent stamps a stale jobId onto events that
  arrive after the job is done. Needs the **unfiltered** Agent log and a read of
  `dslrbooth-agent` HEAD `e376696`.

- What the Agent forwards versus what it drops (`dslrbooth-agent`, HEAD
  `e376696`), since the service can only act on what reaches it.

- Whether `printing` / `sharing_screen` / `processing_start` mark the point
  after which a retake is no longer possible.

**A blocker for that research, found while looking:** the service logs **none**
of the Agent's event stream at `info`. `session_start` writes no line at all,
and everything else falls to a `debug` "Unhandled Agent event". AGT-04 lists ten
event types; the operator can see two. The retake sequence is therefore
currently unobservable in production — restoring that visibility is a
prerequisite of this phase, not a nice-to-have.

Success criteria:

1. A retake does not complete the guest's job, and does not free the booth
2. A `session_end` belonging to guest A can never complete guest B — proven with
   a queued second guest, not reasoned about

3. A session that truly ends with no photo is visible as such, distinctly from a
   retake and from a normal session

4. The `No print upload seen` warning fires only when no print arrives — today
   it fires on **every** successful session, because dslrBooth delivers the
   composite about one second *after* `session_end` (WINDOWS 9)

5. The Agent event stream is observable at the log level an event actually runs
   at, without a redeploy

6. Retake is exercised end to end at the booth, with a second guest queued

**Requirements**: none mapped — QUE-04, BTH-01..02 and AGT-04 are revisited, not
newly built. Coverage is tracked against the six success criteria above as
SC-1 … SC-6, and each plan's `requirements` frontmatter lists the SC-IDs it covers.
**Depends on:** Phase 6
**Plans:** 5 plans

Plans:

**Wave 1**

- [ ] 07-01-PLAN.md — Tracer: jobId-scoped `completeJob()` replacing the positional `ORDER BY … LIMIT 1` selection, `booth_state.current_job_id` as the attribution source of truth, print-composite completion handlers, release-only `session_end`, and the release-fallback timer that never charges a retry — proven with a genuinely queued second guest (SC-1, SC-2)
- [ ] 07-02-PLAN.md — The runtime half of SC-5: `setLogLevel()` plus a SIGHUP reload of the existing `LOG_LEVEL` from `.env`, so the Agent event stream can be watched without a redeploy or a restart, adding no new config key (SC-5)

**Wave 2** *(blocked on Wave 1)*

- [ ] 07-03-PLAN.md — The durable pending-print registry: a `pending_print` table replacing the in-memory Set, print uploads resolved against the registry rather than momentary booth ownership, and the `No print upload seen` warning moved onto registry expiry so it stops firing on every successful session (SC-4, closes WINDOWS 9)

**Wave 3** *(blocked on Wave 2)*

- [ ] 07-04-PLAN.md — The no-photo outcome: a sixth internal job status whose omission from the mapping is a compile error, `closeJobNoPhoto()` charging no retry and writing no stall reason, and the guest-facing translation to `see_staff` with a failed photo state (SC-3)

**Wave 4** *(blocked on Wave 3)*

- [ ] 07-05-PLAN.md — One `info` line per AGT-04 event carrying the attributed jobId and never the capability URL, one summary line per closed job, the runbook and WINDOWS brought up to date, and the human-answered phase gate at the booth (SC-3, SC-5, SC-6)

## M8: CMS & Event Display

**Req:** UI-01..02, CMS-01..05
**Status:** Not planned — raised 2026-08-12

### Phase 8: CMS & Event Display

**Goal:** Stop shipping a code change per customer. Today `web-slide` is two
files — `index.html` is 500 lines of hard-coded layout, and `server.js:39`
keeps guests in `const customers = []`, in memory, capped at 50 and lost on
restart. There is nowhere to configure anything, so every new customer is a
new build.

**Locked decision (2026-08-12, REVISED same day — see `08-CONTEXT.md` D-05):** the CMS lives
**in the Extension Service**, and the room screen becomes a **route inside that service**
(`/display-screen`, which already exists) driven by `WS /display`. **`web-slide` is retired
outright, not kept as a thin renderer** — its source stays in git (baseline `edb33c6`) as
layout reference and is not deployed. The earlier wording of this paragraph said web-slide
*becomes* the thin renderer; the human overrode that during `/gsd-discuss-phase 8` in favour
of a single process, a single deploy, and a single database holding config + photos + queue.
The accepted cost is that the TV and the service now fail together, and that cutover is hard
(D-06: no redirect shim — the URL on each TV is changed once, then `:3001` is switched off).
This is not only a preference for one process over three — it closes a real split. Phase 5
built `WS /display` to broadcast the current guest and the Agent's health, and
`index.html:458` **does not consume it**: the room screen listens only to
`web-slide`'s own SSE `/events`. Two feeds reach one screen and the one that is
wired up is the one that knows nothing about the queue. A CMS layered on top
would make it three.

Success criteria:

1. A new customer's screen is a configuration change, not a deploy
2. The standby screen renders the moment the display is opened, before any guest
   exists (UI-01) — today the room screen is blank until the first webhook, so
   "nobody yet" and "broken" look identical

3. Configuration and photo history survive a restart (CMS-03)
4. One server drives several events and several screens (CMS-02)
5. The room screen consumes one feed, and that feed knows the queue
6. The CMS is behind a login (CMS-04)
7. The Agent is configurable without editing `.env` on the booth PC (UI-02)

> Not in this phase: `web-slide`'s exposed write surface was patched on
> 2026-08-12, ahead of and separately from this work — see OPS notes and
> `web-slide/server.js.20260812-pre-hardening.bak`.

**Requirements:** UI-01, UI-02, CMS-01, CMS-02, CMS-03, CMS-04, CMS-05
**Plans:** 6 plans / 17 tasks / 5 waves — planned 2026-08-12

Plans:

**Wave 1**

- [ ] 08-01-PLAN.md — Tracer: the event-config spine end to end — four SQLite tables, the CMS IP-then-password gate, the single-active-event pointer, `DisplaySnapshot.eventConfig`, and all `index.ts` wiring (D-01, D-13, D-14; CMS-02/03/04)

**Wave 2** *(blocked on Wave 1)*

- [ ] 08-02-PLAN.md — The room screen: hero moment computed per tick from durable photo history, the deliberately-drawn idle state, slideshow, queue sidebar, disconnect banner, and three self-hosted fonts (D-04, D-07, D-09, D-10; UI-01, SC-2, SC-5)
- [ ] 08-03-PLAN.md — The CMS console: content-validated uploads, the full CMS-01 configuration form with defaults and caps, and the active-event switch that warns about waiting guests without touching the queue (D-02, D-03, D-12, D-15; CMS-01, SC-1, SC-4)

**Wave 3** *(blocked on Wave 1)*

- [ ] 08-04-PLAN.md — Agent remote configuration across both repos: the `config_request`/`config`/`reload_config` pull, a safe-field allow-list enforced in code on each side, live-mutable dslrBooth credentials, and one-step restore (D-16, D-17, D-18; UI-02, SC-7)

**Wave 4** *(blocked on Waves 1-3)*

- [ ] 08-05-PLAN.md — Durable per-event photo history in the CMS: 50-per-page listing, the broken-thumbnail placeholder, and the only deletion path in the system — by hand, confirmed (D-10, D-11; CMS-03)

**Wave 5** *(phase gate, blocked on Waves 1-4)*

- [ ] 08-06-PLAN.md — Cutover readiness probe, OPS-RUNBOOK §12, the `web-slide` retirement notice, and the blocking human gate for the physical TV cutover (D-05, D-06, D-08)

### Phase 9: Slides-Only Screen View

**Goal:** A venue can point a TV at a slideshow-only surface. Today every TV
renders the one `stage_sidebar` layout — hero + slideshow on the left, queue
on the right. The operator has asked for a screen that is ONLY the photos:
full-bleed slideshow, no queue column. The booth kiosk page dropped its own
queue column the same day (dslrbooth-agent `4f8fc67`), so after this phase the
queue renders in exactly one place.

**Locked decisions (2026-08-13, conversation with operator):**

- The variant is selected by **query parameter** (`/display-screen?view=slides`),
  NOT by per-screen identity — D-12 (screens have no identity) stays intact:
  nothing is registered or stored per screen, every screen still shows the
  active event, only which REGIONS render differs by the URL typed on the TV.

- Bare `/display-screen` is UNCHANGED — same layout, same markup, same
  behaviour. The cutover already executed points TVs at it.

- **No `?view=queue` variant.** Explicitly descoped by the operator.
- Two new per-event toggles, editable in the existing event form: **show the
  guest's name under the photo**, and **keep the hero moment** (the ~10-15s
  just-captured takeover, D-09). Both default ON (current behaviour).

- These toggles are the FIRST `ALTER TABLE` on a Phase 8 table. Additive
  columns with defaults, via the repo's `PRAGMA table_info()` + conditional
  `ALTER TABLE` idiom — the same shape Phases 2-7 used on Phase 1 tables.

Success criteria:

1. A TV opened at `?view=slides` shows only the slideshow surface — no queue
   column, no queue metadata — at full width

2. Bare `/display-screen` is byte-identical in behaviour to before the phase
3. The two toggles round-trip through the CMS form and change what the slides
   view renders, live over WS, no reload

4. Hero moment and reconnect-banner semantics (D-07, D-09) hold in the new
   view: WS drop keeps last content, hero appears only when its toggle is on

5. An unknown `view` value falls back to the default layout rather than a
   blank or error page

**Requirements:** extends CMS-01 (event config), UI-01 (screen legibility). Coverage is otherwise
tracked against the five success criteria above as SC-1 … SC-5, and each plan's `requirements`
frontmatter lists the IDs it covers.
**Depends on:** Phase 8
**Plans:** 2 plans / 6 tasks / 2 waves — planned 2026-08-13

> The service is LIVE as of 2026-08-13 (~04:30): PM2 `mirror-service`, Phase 8 code, real TVs
> pointed at `/display-screen`. Success criterion 2 is therefore a regression pin rather than a
> feature, and every commit must leave the tree releasable. This phase also knowingly ends Phase
> 8's zero-`ALTER TABLE` record (D9-05): two additive, defaulted columns on `event`, behind the
> `PRAGMA table_info()` idiom `localStore.ts` already uses four times.

Plans:

**Wave 1**

- [ ] 09-01-PLAN.md — Tracer: the two `event` toggle columns through `EventConfig` to the wire, `/display-screen?view=slides` served below the existing IP gate with every unknown value falling back, and both toggles honoured on both views — plus the D9-02 regression pin, the populated-database migration proof and the broadcast-diff guard (D9-01…D9-05; UI-01, SC-1, SC-2, SC-4, SC-5)

**Wave 2** *(blocked on Wave 1)*

- [ ] 09-02-PLAN.md — The two toggles become real CMS controls that round-trip to the wire, the slides surface designed for viewing distance with a cross-page invariant test against drift, OPS-RUNBOOK §13, and the blocking human gate at a real television (D9-01, D9-04; CMS-01, UI-01, SC-1, SC-2, SC-3, SC-4)

### Phase 10: Agent Desktop App

**Goal:** Starting the booth Agent stops being a command-line ritual. Today the
operator opens a terminal in exactly the right directory, with a hand-written
`.env` beside the exe, and a missing variable is a crash with no explanation.
The operator named this directly (2026-08-13): "chạy bằng command để khởi chạy
... thật không tự nhiên. Tôi nghĩ nên chuyển sang dạng desktop." The Agent
becomes a real Windows desktop application — Electron, chosen by the operator
over the lighter local-control-panel option with the cost stated (~150-200MB,
new build chain, the largest Agent-side phase of the project).

**Locked decisions (2026-08-13, conversation with operator):**

- Electron shell AROUND the existing Agent core — WsConnection, trigger server
  (:3001), LiveConfig, agentMessages and their 31 tests stay the working core;
  the desktop app hosts them, it does not rewrite them.

- The GUI configures the BOOTSTRAP fields locally (WS URL, token, dslrBooth
  password, ports) — replacing hand-editing `.env` on the booth PC. This is a
  sanctioned refinement of D-17's wording: D-16/D-17's threat model forbids
  REMOTE writes to bootstrap config, and that stays absolute — the CMS pull
  path still applies the four safe fields in memory only. A local GUI on the
  booth PC itself is the same act as walking to the machine and editing
  `.env`, which is exactly the recovery path D-16 preserves.

- The remote-config contract (config_request / config / reload_config, the
  allow-lists on both sides) is UNTOUCHED.

- The booth kiosk popup stays retired (D9-07) — the desktop app does not
  revive it.

Success criteria:

1. Double-clicking one installed application starts the Agent — no terminal,
   no working-directory discipline, no hand-written `.env`

2. First run with no configuration opens a setup form, not a crash; the
   connection can be started, stopped and restarted from the window

3. Connection state, dslrBooth reachability, and recent log lines are visible
   in the window; the app can minimize to the system tray and optionally
   start with Windows

4. The four CMS-editable fields still arrive by pull and apply in memory
   (UI-02 regression pin); local GUI edits of bootstrap fields take effect
   without reinstalling

5. A build produced on this Linux machine installs and runs on the Windows
   booth PC (or the researched fallback — portable zip — does, with the
   installer path documented as the gap)

**Requirements:** extends UI-02. **Mode:** mvp
**Depends on:** Phase 3 (Agent link), Phase 8 (remote config)

**Story:** As a booth operator, I want to start and configure the Agent from a window on the booth
PC, so that running a photo booth never depends on remembering a terminal command.

**Plans:** 3/4 plans executed

Plans:

**Wave 1**

- [x] 10-01-PLAN.md — `createAgent()` with a real lifecycle: nothing bound until `start()`, the
  `start_session` branch moved to a seam a test can drive, an error seam so an occupied trigger port
  is a message rather than a crash, one config validator for both entry points, and a status
  snapshot carrying no credentials (D10-01, D10-03; UI-02, SC-2, SC-4)

**Wave 2** *(blocked on Wave 1)*

- [x] 10-02-PLAN.md — The Electron shell end to end: user-data config store with the
  no-secret-reaches-the-renderer contract, IPC-only surface, isolated sandboxed window, settings form
  and Start/Stop, the four CMS-safe fields applying live through `LiveConfig.apply()`, and both build
  paths coexisting (D10-01, D10-02, D10-03; UI-02, SC-1, SC-2, SC-4)

**Wave 3** *(blocked on Wave 2)*

- [x] 10-03-PLAN.md — The operator surface: one-click import of the booth PC's existing `.env`,
  per-field save errors, status panel with dslrBooth reachability, a bounded masked log tail, tray
  with close-to-tray, launch auto-start and start-with-Windows (D10-02, D10-04; UI-02, SC-1, SC-2,
  SC-3, SC-4)

**Wave 4** *(blocked on Wave 3)*

- [ ] 10-04-PLAN.md — Windows artifacts built on this Linux machine in the packaging project's Wine
  image, the packaging invariants pinned by test, the Agent's own operations runbook including the
  honest unsigned-application experience, and the blocking human gate on the real booth PC (D10-01;
  UI-02, SC-1, SC-3, SC-5)

### Phase 11: Retake & Approval Anchor

**Goal:** A guest who retakes never loses their session, never receives the
photo they rejected, and never has the next guest called up while they are
still at the booth. Phase 7 built the attribution machinery on one assumption
that three live measurements on 2026-08-18 falsified: that a retake happens
inside the capture phase. It does not — the sharing-screen Retake is a NEW
dslrBooth session (`session_end` → `session_start`), and every attempt, kept
or discarded, produces its own composite and its own fotoshare `print` upload.
Today that means the guest is dropped at the first `session_end`, the job is
completed on the discarded composite, the rejected URL is sent, and the real
one is swallowed silently. Evidence: `07-EVIDENCE-dslrbooth-triggers.md` §C/D/E,
conclusions 7–14.

**Operational precondition, locked by the operator 2026-08-18:** auto-print is
OFF on every booth. Only then does `printing` fire once, on the kept attempt,
after the guest presses print — the single trigger in dslrBooth's vocabulary
that distinguishes "kept" from "discarded".

**Locked decisions (2026-08-18):** see `11-CONTEXT.md` D11-01 … D11-10. In
one line each: `session_start`/`session_end` open and close an *attempt* under
the job (D11-01); `processing_start` opens/overwrites the pending-print slot,
`printing` approves (D11-02), but only inside an open attempt AND for that
attempt's own composite — gallery reprints are ignored (D11-03); print uploads
only record the URL, never send (D11-04); one finalize gate with three doors —
printing / grace timer / operator (D11-05); `session_end` of an unapproved
attempt starts `RETAKE_GRACE_MS`=20 s instead of releasing, a new
`session_start` inside it is the retake (D11-06); composite = last `\Prints\`
param, no hardcoded `param5` (D11-07); CMS "end this guest" button (D11-08);
`SESSION_SUMMARY` gains `attempts=` `approved_by=` (D11-09); the retake test is
rewritten from the measured sequences (D11-10).

Success criteria:

1. Sequence C/D replayed against the service with guest B queued: A receives
   exactly one notification carrying the LAST attempt's URL; B is not announced
   or dispatched before A's `printing`; `SESSION_SUMMARY job=A … attempts=2
   approved_by=printing`

2. Sequence E (gallery reprint, no `session_start`) finalizes nothing and logs
   why — including when it happens while another guest's attempt is open

3. An unapproved `session_end` with no following `session_start` finalizes
   after `RETAKE_GRACE_MS` with the last held URL (`approved_by=grace`); a
   guest who presses print waits 0 s

4. The CMS shows and acts on "end this guest" while a booth is busy or in
   grace (`approved_by=operator`)

5. No `no usable composite path` warning on either the 4-shot or the 1-shot
   layout; every new "ignored" branch writes one `info` line — no silent branch
   is added and the existing silent `resolvePendingPrint === false` branch is
   removed

6. Live booth gate in `11-CONTEXT.md` <verification> passes on the real booth
   with auto-print off (retake + queued second guest; unapproved walk-away;
   gallery reprint during another guest's session; operator end)

**Requirements:** re-opens BTH-*/NOT-01 attribution; extends AGT-04 handling.
**Depends on:** Phase 7 (registry, `current_job_id`), Phase 8 (CMS auth/IP gate).
**Does not touch:** `dslrbooth-agent` (Phase 7 D-05 held; `/api/cancel` deferred).

**Story:** As a guest, I want to retake my photo and still get exactly the one
I kept, without the next person being called up while I'm still there.

**Plans:** 4/5 plans executed / 15 tasks / 4 waves — planned 2026-08-18, plus one gap-closure
plan (11-06) executed 2026-08-18 outside the original wave structure, spanning both
`mirror-request` and `dslrbooth-agent`

> Tracer-first. The suite is deliberately RED between 11-01 and 11-02: nine existing test files
> pin the retired single-anchor and send-on-upload model (`11-RESEARCH.md` §Common Pitfalls), and
> 11-02 exists so that list is worked through in one plan rather than discovered one red file at a
> time. Baseline measured 2026-08-18 at HEAD `9092729`: 82 files / 967 tests green in 27.8 s.
> One superseded mechanism is retired on the record: Phase 7's release-fallback timer loses its
> only trigger site when the finalize gate completes and releases in one act (D-02 as a principle
> is unchanged; the bounds move to the grace timer and the session timer).

Plans:

**Wave 1**

- [x] 11-01-PLAN.md — Tracer: measured sequence D end to end with guest B queued — the persisted
  attempt (`booth_state.attempt_open`/`attempt_no`), the composite/approval anchor split, the
  stem-compared `printing` guard, write-only uploads, the one idempotent `finalizePendingPrint`
  gate, `RETAKE_GRACE_MS` and the grace window, `extractCompositePath` replacing the `param5`
  hardcode, and the two new summary fields (D11-01…D11-07, D11-09, D11-10; BTH-01, BTH-02,
  NOT-01, AGT-04; SC-1, SC-3, SC-5) — complete 2026-08-18, `11-01-SUMMARY.md`, commits `8835f29`/
  `4615d04`/`fe897ac`. Suite deliberately RED (71/907, was 82/967) — 12 legacy files owned by 11-02.

**Wave 2** *(blocked on Wave 1)*

- [x] 11-02-PLAN.md — The suite rewrite: ten existing test files moved off "a composite completes
  the job" and "an upload sends the photo" with no case silently dropped, plus the single-send-site
  invariant asserted against the source (D11-02, D11-04, D11-05, D11-07, D11-09, D11-10)

**Wave 3** *(blocked on Wave 2)*

- [x] 11-03-PLAN.md — The operator door: `GET /cms/booth` and `POST /cms/api/booth/release` behind
  the existing address and session gates, the first CMS-reachable queue mutation in this codebase,
  through one narrow link that holds no store handle (D11-05 door 3, D11-08; BTH-01, BTH-02; SC-4)

- [x] 11-04-PLAN.md — The branches the tracer did not walk: sequence E in both shapes, the
  copy-suffix composite from evidence 15, the auto-print-ON degradation pinned as a named case,
  three-door idempotency, and every ignore branch proved to log exactly once (D11-03, D11-04,
  D11-05; SC-2, SC-5)

**Wave 4** *(phase gate, blocked on Wave 3)*

- [ ] 11-05-PLAN.md — DEPLOYMENT §3/§7/§9/§11/§12 with auto-print OFF promoted to a numbered setup
  step, OPS-RUNBOOK §14 plus §3/§5/§6, and the blocking five-scenario live booth gate (D11-03,
  D11-05, D11-06, D11-08, D11-09; SC-6)

**Gap closure (found on a live booth run, outside the original wave structure)**

- [x] 11-06-PLAN.md — the live 2026-08-18 11:22 defect: the first `session_start` of every
  dispatched session raced `dslrbooth-agent`'s own `activeJobId` stamp and reached the server
  with `jobId: undefined`, so `attempt_no` never reached 1 and a real retake finalised on the
  guest's REJECTED photo via the grace door. Fixed in both repos — `mirror-request`'s
  `onAgentEvent` now falls back to the booth's own binding (`current_job_id`, D-06) when the
  Agent supplies nothing; `dslrbooth-agent`'s `commands.ts` now stamps `activeJobId` before
  calling the dslrBooth API that can fire the race, not after. Complete 2026-08-18,
  `11-06-SUMMARY.md`, commits `ef14c2a`/`b4259cb`/`d5f99f9`. The Agent fix requires a rebuild
  and reinstall on each booth PC before it takes effect; the server fix alone is sufficient to
  stop the guest receiving the rejected photo in the meantime.

## Backlog

### Phase 999.1: Slide caption config — template, position, fit (BACKLOG)

**Goal:** Three per-event CMS fields that let an operator write the room screen's caption
line, place it, and choose whether the photo fills the screen. Design decided with the
operator 2026-08-19; this item is ready to plan, not to re-discuss.
**Requirements:** TBD (derives from CMS-01's event config path and D9-04's toggle discipline)
**Plans:** 0 plans

**The three fields**

| Field | Default | Meaning |
|---|---|---|
| `guestNameTemplate` | `{guest_name}` | Caption text; the literal `{guest_name}` is replaced with the guest's name |
| `captionPosition` | bottom-left | 9-point grid, anchored to the PHOTO's box, not the stage |
| `photoFit` | `contain` | `contain` keeps the whole photo (today's behaviour); `cover` fills the screen and crops |

Every default reproduces today's output exactly — an operator who never opens the form sees
no pixel change. Same discipline D9-04 set for its two toggles.

**Why position needs a photo anchor.** `.slide-overlay` is `left:0;right:0` on a
stage-filling `.slide`, so the caption anchors to the STAGE. With a portrait composite on a
16:9 TV the caption lands in the black letterbox bar, far from the photo it describes.
Measured share of stage width: 2x6 strip 19%, 4x6 portrait 37%, 4x6 landscape 84%. Anchoring
to the photo needs the `img` wrapped in a shrink-to-fit layer.

**`cover` crops, and how much depends on the frame.** On a 4x6 landscape frame it removes
~18% of height — where event logos usually sit. On a 2x6 portrait strip it would show only
~19% of the photo's height, roughly one cell of four. The CMS form must say plainly that this
switch is for landscape frames. Do not block it: the operator can see their own screen, the
same reasoning CMS-10 used for `backgroundOverlay`.

**The two settings interact.** Under `cover` the photo box equals the stage, so photo-anchored
and stage-anchored positions coincide and the caption always sits over the photo. The dark
legibility gradient must therefore follow the caption's position, and is unnecessary when the
caption sits on a black bar under `contain`. Derive the gradient; do not add a fourth field.

**Hard constraint — the substitution must not reopen the injection hole.**
`overlay.innerHTML = template.replace(...)` would reintroduce exactly the guest-string
interpolation that `slidesPage.ts`'s header and T-08-10/T-09-03 forbid. Substitute into a
STRING and assign through `textContent`:
`name.textContent = template.replace(/\{guest_name\}/g, photo.name || '')`.

**Scope — follow `idleHeading`'s existing path.** `localStore.ts` (DEFAULT_EVENT_CONFIG, row
mapping, writable-column allow-list, schema, `ALTER TABLE event` migration), `types.ts`
EventConfig, `cmsEventPages.ts` form fields, `cmsEventRoutes.ts` validator (must never return
null), then the render in BOTH `slidesPage.ts` AND `displayPage.ts` — both screens draw the
guest name and both honour event config, so changing one leaves the two disagreeing. Still to
decide at plan time: truncation when a long template meets a long name on one line (proposed:
wrap to two lines, then ellipsis).

**Explicitly deferred by the operator:** styling the guest's name differently from the rest of
the sentence (bold). To be configured later; keep the line one uniform style for now.

**A template with no placeholder is legal** — that is an operator choosing one fixed sentence
for the whole event.

Plans:
- [ ] TBD (promote with /gsd-review-backlog when ready)
