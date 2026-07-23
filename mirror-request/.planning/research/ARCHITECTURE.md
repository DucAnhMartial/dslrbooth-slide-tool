# Architecture: Extension Service

**Domain:** Photobooth real-time orchestration service
**Researched:** 2025-07-22
**Overall confidence:** HIGH

---

## 1. Recommended Architecture

A single-process Node.js 20 application with five subsystems connected through
a shared internal EventEmitter bus. SQLite persists all state so the service
recovers correctly across restarts.

The Extension Service is the "central brain" of the photobooth system. It
receives guest registrations via HTTP (real-time mirror from the reverse proxy
and a fallback DB poller), manages a single-booth FIFO queue, transitions the
booth through IDLE/BUSY/ERROR/TIMEOUT states, dispatches capture sessions to the
Agent over WebSocket, processes photo upload events, and sends the result to
guests via email or SMS.

**Cross-cutting concerns:** Winston logger provides daily rotating file logs.
An internal EventEmitter bus decouples all five subsystems.

The dslrbooth-agent (built, running in sibling directory) uses exactly this
same stack (ws, express, winston, dotenv, node-windows), confirming library
choices are already proven in this codebase before the Extension Service
starts construction.
---


## 2. Subsystem Details

### 2.1 HTTP Server (Express)

Single Express app; all external entry points.

| Method | Path | Actor | Purpose |
|--------|------|-------|---------|
| POST   | /on-register        | Reverse Proxy    | Receives registration; returns 200 immediately |
| GET    | /status/:jobId      | Guest / Display  | Queue position + booth status; read-only |
| WS     | /ws/display         | Booth display    | Real-time push: guest name + booth state + Agent status |
| GET    | /health             | PM2 / Ops        | Liveness probe |

**Data path for POST /on-register:**

1. Reverse proxy forwards request here.
2. IP-allowlist middleware (AUTH-02) checks caller IP before any logic runs.
3. Request body validated (required fields: jobId, guestName, contact).
4. Idempotency check: if jobId exists in SQLite, return 200 with duplicate flag.
5. Persist registration to SQLite (queue table + job history).
6. Emit `register_received` on the internal bus.
7. If booth is IDLE, emit `dispatch_next` immediately; otherwise, stop.

### 2.2 DB Poller

Runs a SELECT against the backend read-only account on a fixed cadence (every
30 seconds). Advances a stored `cursor` (last-seen registration id) so
registrations that arrived while the mirror path was down are recovered on the
next poll cycle. On restart the poller reads the cursor from SQLite so it never
re-processes old rows.

**Data path:**

1. Read `cursor` from SQLite.
2. SELECT from backend WHERE id > cursor ORDER BY id ASC LIMIT 100.
3. For each new row: idempotency check, persist, emit `register_received`.
4. Update `cursor` in SQLite to highest seen id.
5. If no new rows, sleep until next tick.

### 2.3 Queue Manager

Holds a single in-memory FIFO array (sufficient for one booth). A persist hook
writes the full queue snapshot to SQLite on every enqueue and dequeue. On
startup the Queue Manager hydrates from SQLite instead of starting empty.

| Operation | Trigger | Action |
|-----------|---------|--------|
| enqueue   | `register_received` event | Append to end of queue; persist snapshot |
| dequeue   | Booth becomes IDLE, queue non-empty | Shift head; persist; emit `session_dispatched` |
| peek      | `GET /status/:jobId` | Return array index without mutating |

**Why in-memory is sufficient:** One booth means at most one active session at
a time. A full working-day queue easily fits in heap. The SQLite persist hook
is the crash-recovery mechanism, not a distributed-scaling concern.

### 2.4 Booth State Machine

Four states: IDLE, BUSY, ERROR, TIMEOUT_RESET. Every transition is logged with
timestamp and reason. Current state is written to SQLite on every transition.

| Current State | Event | Next State | Action |
|---------------|-------|------------|--------|
| IDLE | Queue non-empty + idle | BUSY | Emit `dispatch_next` |
| BUSY | `session_start` ack OK | BUSY | No change |
| BUSY | `session_end` event | IDLE | Emit `dispatch_next` |
| BUSY | Heartbeat miss >30 s | ERROR | Log; emit `agent_offline` |
| ERROR | Heartbeat resumes | IDLE | Emit `dispatch_next` |
| BUSY | No `session_end` in 5 min | TIMEOUT_RESET | Log warning; advance queue |
| TIMEOUT_RESET | (immediate) | IDLE | Emit `dispatch_next` |

**5-minute timeout rationale:** A session BUSY for 5 minutes without
`session_end` is almost certainly stalled (Agent crashed, dslrBooth hung, or
hardware unrecoverable). Rather than block the queue indefinitely, the State
Machine resets to IDLE, logs the stall, and advances the next queued job. The
stalled job is marked for ops review, not silently dropped.

### 2.5 Command Dispatcher + Retry Queue

Responsibility: take the next job from the queue, format a `start_session`
command, send it over the Agent WebSocket, and track the ack.

**Retry policy:**

- Send immediately when booth is IDLE and queue is non-empty.
- If no ack within 10 seconds: retry up to 3 times with 2s, 4s, 8s backoff.
- If all retries fail: log error, mark job as failed, emit `session_completed_with_error`
  so the State Machine advances to IDLE and dispatches the next job.
- The Agent already implements exponential-backoff transport reconnection, so
  the Dispatcher only handles message-level ack timeouts, not transport failures.


---


## 3. Internal Event Bus

All subsystems communicate through a single EventEmitter instance. No
subsystem calls another subsystem's methods directly.

**Canonical events:**

| Event Name                | Emitted By          | Consumed By                  |
|---------------------------|---------------------|------------------------------|
| `register_received`       | HTTP Server, Poller | Queue Manager                |
| `session_dispatched`      | Queue Manager       | Command Dispatcher           |
| `ack_received`            | WS Server           | Command Dispatcher, Queue    |
| `session_started`         | WS Server           | Booth State Machine          |
| `session_ended`           | WS Server           | Booth State Machine          |
| `agent_online`            | WS Server           | Booth State Machine          |
| `agent_offline`           | WS Server           | Booth State Machine          |
| `file_upload_received`    | WS Server           | Notification Service         |
| `notify_sent`             | Notification        | Job history (SQLite)         |

**Why EventEmitter instead of direct calls:** It prevents circular
dependencies, makes it trivial to add a debug-logging interceptor on every
event, and lets each phase be tested in isolation by listening for its events
without wiring the full system.

---


## 4. Data Flow Diagrams

### 4.1 Happy Path: Registration to Delivery

```
Guest scans QR
    |
    v
POST /on-register --HTTP--> Extension Service
    |                            (200 immediately)
    |                       enqueue in SQLite + memory
    |                       emit register_received
    v
Booth is IDLE + queue non-empty
    |
    v
emit dispatch_next
    |
    v
Command Dispatcher sends
{ type: "command", action: "start_session", jobId }
    |
    |  WebSocket
    v
Agent (Windows)
    |
    |  HTTP to 127.0.0.1:1500
    v
dslrBooth Professional
    |
    |  hardware fires
    v
Agent receives trigger event
(forwarded instantly from dslrBooth)
    |
    v
Agent sends ack --WS--> Extension Service
    |
    v
Booth -> BUSY; session_start logged
    |
    |  [user photographed, image processed]
    v
Agent receives session_end event
    |
    v
Agent sends { type: "event", event: "session_end" } --WS-->
    |
    v
Extension Service booth -> IDLE
dispatch next job if queue non-empty
    |
    v
Agent receives file_upload event
    |
    v
Agent sends { type: "event", event: "file_upload", url: "..." } --WS-->
    |
    v
Notification Service: send email/SMS to guest
    |
    v
PHOTO DELIVERED; booth IDLE, waiting for next job
```

### 4.2 Mirror Outage: DB Poller Fills the Gap

```
[Reverse proxy down for 3 min]
    |                                   [incoming registrations queue on backend]
    v
Service keeps running; Agent still connected
    |
    v
DB Poller fires (every 30 s, no new rows during outage -> no-ops)
    |
    v
Reverse proxy comes back
    |
    v
DB Poller fires: SELECT WHERE id > cursor
    |                        -> finds 5 registrations missed
    v
Each row: idempotency check, persist, emit register_received
(same code path as mirror; no special-case handling needed)
    |
    v
All registrations queued and served; no loss.
```

### 4.3 Agent Unreachable

```
Booth IDLE, queue has jobs
    |
    v
Command Dispatcher sends start_session
    |
    v
WebSocket: Agent not connected
    |
    v
send() returns false
    |
    v
Retry: 2 s, 4 s, 8 s (3 attempts total)
    |
    v
All retries fail: log error, mark job as failed,
emit `session_completed_with_error`
    |
    v
State Machine: IDLE + advance queue -> next job dispatched
    |
    v
Monitor/logs notify ops. Queue keeps processing remaining guests.
The Agent reconnects independently (exponential backoff in its WsConnection).
```


---


## 5. Component Boundaries

### What the Extension Service OWNs (never delegates)

- All queue ordering and dispatch logic
- Booth state machine transitions
- DB polling cursor tracking
- Idempotency checks (by record ID)
- Email/SMS retry policy (up to 3 attempts with backoff)
- Masking sensitive fields in logs (PII: email, phone numbers)
- Local SQLite persistence for all local state

### What the Agent OWNs (Extension Service never touches)

- Transport to dslrBooth (HTTP calls to 127.0.0.1:1500)
- Receiving hardware trigger events from dslrBooth
- WS reconnection logic (exponential backoff — proven in its WsConnection class)
- Windows service lifecycle

### What the backend OWNs (Extension Service only reads)

- Read-only DB account: SELECT access for registrations
- Read-only DB account: SELECT access for guest contact details
- Reverse proxy: mirrors POST /on-register to the Extension Service
- All write operations (INSERT/UPDATE/DELETE) remain with the backend

**Rule enforced at every boundary:** Extension Service NEVER executes
INSERT/UPDATE/DELETE against the backend DB. Only SELECT, and only through a
dedicated read-only DB account with limited table access. All local state
(queues, booth state, idempotency, cursor) lives exclusively in SQLite.

---


## 6. Build Order

Build from the outside in: ingestion first, then the pipeline, then outputs.

### Phase 1: Foundation & Registration Ingestion
- Express server with a single POST /on-register endpoint
- IP-allowlist middleware
- SQLite schema defined and migrations ready
- Registration Service: validate, idempotency check, persist, emit event
- DB Poller: cron loop, read-only SELECT, cursor in SQLite
- Winston logger wired with PII masking
- Success: service receives and persists registrations from both sources

### Phase 2: Queue & Booth State Machine
- Queue Manager: in-memory FIFO + SQLite persist hook
- Booth State Machine: IDLE → BUSY → IDLE transitions
- Auto-dispatch from Queue Manager when booth IDLE and queue has jobs
- Safety timeout (5 min) for stalled sessions
- Hmm actually the timeout logic should be in the State Machine
- Success: three registrations dispatched in order, timeout recovers stalled sessions

### Phase 3: Agent WebSocket Link
- WS Server with token authentication
- Message handler for Agent acks and events
- Heartbeat tracking with 30-second miss detection
- Command Dispatcher: format start_session, send, track ack, retry with backoff
- WsConnection (reusable, already implemented in dslrbooth-agent for the
  Agent side — implement the matching server side here)
- Success: Agent connects, receives commands, sends events, goes offline/online

### Phase 4: Guest Notifications
- Notification Service: send email/SMS on file_upload event
- Retry queue with exponential backoff (3 attempts)
- Failure logging with full context for manual follow-up
- Success: test guest receives email/SMS with photo attachment/link

### Phase 5: Client API & Booth Display Feed
- GET /status/:jobId (queue position lookup)
- WS /ws/display (real-time feed for booth panel)
- Admin-facing monitoring endpoints
- Success: external panel shows current guest name and booth state live


---


## 7. Common Architectural Mistakes

### Mistake 1: Writing to the Backend DB
The Agent has absolutely no authorization to perform INSERT, UPDATE, or DELETE operations against the backend database. Any such request is silently ignored by the Agent, and writes MUST go through the backend API using proper authentication instead.

### Mistake 2: Bypassing the Agent for dslrBooth Commands
The dslrBooth local API is intentionally isolated behind the Agent. Any service that attempts to call it directly will break the architecture and lose the security boundary that the Agent provides.

### Mistake 3: Not Handling Agent Disconnection Gracefully
The Agent may disconnect at any time (network issues, Windows sleep, etc.). The service must handle this without crashing and must queue commands for when the Agent reconnects.

### Mistake 4: Blocking the Event Loop
All I/O operations (DB queries, HTTP calls to Agent, email/SMS sending) must be async. Blocking the event loop will prevent heartbeat processing and can cause the Agent to mark the service as offline.

### Mistake 5: Not Implementing Idempotency
Network retries and duplicate webhooks are real. Every registration must be processed exactly once. The idempotency store in SQLite is the safeguard.
