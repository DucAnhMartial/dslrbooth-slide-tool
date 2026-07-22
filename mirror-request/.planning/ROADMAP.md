# Extension Service — Roadmap

> Central brain of a photobooth system — Node.js 20 LTS service managing registration ingestion, single-booth FIFO queue, Agent WebSocket link, guest notifications, and display API feed.
> Granularity: Standard | 5 phases | 21 requirements, 0 orphans

## Phases

- [ ] **Phase 1: Foundation & Registration Ingestion** — Inbound events, local persistence, security guardrails
- [ ] **Phase 2: Queue & Booth State Machine** — FIFO queue, IDLE/BUSY transitions, auto-dispatch
- [ ] **Phase 3: Agent Link (WebSocket)** — Bidirectional real-time channel to the Windows booth machine
- [ ] **Phase 4: Guest Notifications** — Email/SMS delivery on photo upload with retry handling
- [ ] **Phase 5: Client API & Booth Display Feed** — Job status endpoint and real-time display feed

## Phase Details

### Phase 1: Foundation & Registration Ingestion

**Goal:** The service can receive guest registrations from both real-time mirror and periodic DB polling, persist all local state through restarts, and enforce IP-level security on the ingest endpoint.

**Depends on:** Nothing

**Requirements:** ING-01, ING-02, ING-03, STO-01, AUTH-02

**Success Criteria** (what must be TRUE):
1. A registration POST forwarded by the reverse proxy mirror lands in local state, returns HTTP 200 immediately, and does not block the caller.
2. The DB poller runs on a fixed schedule, reads the backend read-only via SELECT, and ingests any new registrations not already captured by the mirror path — no registration is silently dropped when the mirror path fails.
3. The polling cursor is stored in SQLite; after a service restart the poller resumes where it left off without re-processing old rows.
4. Requests to POST /on-register that originate outside an allowed IP range receive HTTP 403 before any business logic runs.
5. Queue state, booth state, and cursor position survive a service restart with no data loss.

**Plans:** TBD

---

### Phase 2: Queue & Booth State Machine

**Goal:** The service maintains a single FIFO queue of registrations, automatically transitions the booth between IDLE and BUSY, and dispatches sessions without manual intervention — with safe timeout recovery for stalled sessions.

**Depends on:** Phase 1

**Requirements:** QUE-01, QUE-02, QUE-03, QUE-04, BTH-01, BTH-02

**Success Criteria** (what must be TRUE):
1. Three registrations received in sequence are dispatched exactly in that order — first-in-first-out — when the booth becomes available.
2. A second call for a registration ID already in the queue or already processed returns a duplicate acknowledgment and is not queued again.
3. When the booth state is IDLE and the queue is non-empty, a start_session command is dispatched to the Agent within one event loop tick.
4. On receiving session_end for the current job, the booth returns to IDLE and the next queued job is dispatched automatically.
5. If a session has been BUSY for more than five minutes without a session_end event, the booth resets to IDLE, the stalled job is logged, and the next queued job may proceed.
6. Booth transitions are deterministic: every state change (IDLE→BUSY, BUSY→IDLE, BUSY→TIMEOUT_RESET→IDLE) can be observed in the state machine logs.

**Plans:** TBD

---

### Phase 3: Agent WebSocket Link

**Goal:** The service maintains a persistent, authenticated WebSocket connection to the Agent on the booth machine, exchanges lifecycle commands and events, and tracks Agent health in real time.

**Depends on:** Phase 2

**Requirements:** AGT-01, AGT-02, AGT-03, AGT-04, AGT-05

**Success Criteria** (what must be TRUE):
1. An Agent connection is accepted only if it presents the correct WS handshake token; unauthenticated connections are rejected immediately.
2. When Phase 2 dispatches a job, a command({ type: "start_session", jobId }) message is written to the WS within one event loop tick.
3. The service records an ack response from the Agent (including ok: true, ok: false, or errorMessage) against the relevant jobId and surfaces it in the status endpoint.
4. The service recognizes and handles each Agent event type — session_start, session_end, file_upload — and dispatches the appropriate downstream action (queue advancement or notification).
5. If no heartbeat is received from the Agent for more than 30 seconds, the Agent status transitions to offline; when a heartbeat resumes within the window, status returns to online.

**Plans:** TBD

---

### Phase 4: Guest Notifications

**Goal:** When a photo upload event arrives for a completed job, the service sends the resulting image to the guest via email or SMS, with bounded retry behavior for transient failures — all delivered asynchronously without blocking the primary queue pipeline.

**Depends on:** Phase 3

**Requirements:** NOT-01, NOT-02

**Success Criteria** (what must be TRUE):
1. On receiving a file_upload event, the service looks up the guest's contact details from local state, calls the email or SMS provider, and logs success or failure against the jobId.
2. If a notification send fails with a retryable error, the service retries up to a configured maximum (e.g. 3 attempts) with exponential back-off; after exhausting retries the failure is logged with full context for manual follow-up. Notification pipeline failures do not crash the service or block queue processing.
3. A guest whose notification is successfully delivered receives the photo at their registered email or phone number; the service records delivery timestamp alongside job history.

**Plans:** TBD

---

### Phase 5: Client API & Booth Display Feed

**Goal:** Guests and the booth display screen can observe the queue position and live booth status in real time through a read-only HTTP endpoint and a WebSocket/SSE push feed — with authenticated access protected by service token and IP allowlist.

**Depends on:** Phase 4

**Requirements:** API-01, API-02, AUTH-01, AUTH-03

**Success Criteria** (what must be TRUE):
1. A GET /status/:jobId request returns the job's current queue position, estimated wait, and registration status without mutating any state.
2. A connected display client receives an immediate snapshot (current guest name, booth state, Agent online/offline status) on subscribe, followed by push updates on every queue or state change.
3. Requests to the status endpoint without a valid bearer token receive HTTP 401 before any data is returned.
4. The display WebSocket/SSE endpoint accepts connections only from IPs on an allowlist; disallowed IPs receive HTTP 403 on connection attempt.
5. A display client disconnected and reconnected within the same session receives the current snapshot immediately on reconnect (at-least-once delivery semantics for the initial state).

**Plans:** TBD

---

## Progress Tracker

| Phase | Goal | Requirements | Success Criteria Count | Plans Complete | Status |
|-------|------|--------------|----------------------|----------------|--------|
| 1 | Foundation & Registration Ingestion | ING-01, ING-02, ING-03, STO-01, AUTH-02 | 5 | 0/3 | Not started |
| 2 | Queue & Booth State Machine | QUE-01, QUE-02, QUE-03, QUE-04, BTH-01, BTH-02 | 6 | 0/3 | Not started |
| 3 | Agent WebSocket Link | AGT-01, AGT-02, AGT-03, AGT-04, AGT-05 | 5 | 0/3 | Not started |
| 4 | Guest Notifications | NOT-01, NOT-02 | 3 | 0/3 | Not started |
| 5 | Client API & Booth Display Feed | API-01, API-02, AUTH-01, AUTH-03 | 5 | 0/3 | Not started |
