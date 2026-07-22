# Roadmap: Extension Service

## Milestone Overview

| Milestone | Target | Focus | Status |
|-----------|--------|-------|--------|
| **M1: Foundation & Ingestion** | Week 1 | Local store, ingestion, security basics | Next |
| **M2: Queue & Booth State** | Week 1-2 | Queue logic, IDLE/BUSY, timeout | Planned |
| **M3: Agent Link (WebSocket)** | Week 2 | WS server, command dispatch, event handling | Planned |
| **M4: Guest Notification** | Week 2-3 | file_upload handler, email/SMS | Planned |
| **M5: Client API & Display Feed** | Week 3 | /status endpoint, WS feed for display | Planned |

---

## M1: Foundation & Ingestion

### Goal
Setup project scaffolding, local state store, and the two ingestion channels (mirror mirror + DB polling).

### Requirements
ING-01, ING-02, ING-03, STO-01, AUTH-02

### Success criteria
1. npm run dev starts server on configurable port without errors
2. POST /on-register returns 200 immediately, logs registration payload (masked)
3. Local SQLite file is created with schema (queue, booth_state, db_cursor, job_history)
4. DB polling runs every N seconds, reads new records via SELECT, updates cursor locally
5. /on-register rejects requests from non-whitelisted IPs with 403

---

## M2: Queue & Booth State

### Goal
Implement the single-booth queue and IDLE/BUSY state machine with safety timeout.

### Requirements
QUE-01, QUE-02, QUE-03, QUE-04, BTH-01, BTH-02

### Success criteria
1. Multiple registrations are queued in FIFO order, logged with position numbers
2. Duplicate record IDs are detected and skipped (idempotency)
3. When booth IDLE, first queued job is dispatched and booth becomes BUSY
4. When session_end event received, booth returns IDLE and next job is dispatched automatically
5. If booth stays BUSY > 5 minutes without session_end, auto-reset to IDLE with warning log

---

## M3: Agent Link (WebSocket)

### Goal
Connect to Agent via WebSocket, send commands, receive events, track heartbeat.

### Requirements
AGT-01, AGT-02, AGT-03, AGT-04, AGT-05, AUTH-01

### Success criteria
1. Agent can connect with valid token, rejected without token
2. When dispatch fires, command {type, action, jobId, mode} is sent over WS
3. Agent ack {jobId, ok} is logged and triggers booth IDLE transition
4. Events from Agent (session_start through session_end, file_upload) are received and processed
5. If no heartbeat for 30s, Agent status flips to offline (exposed via status API)

---

## M4: Guest Notification

### Goal
Send photo results to guests via email/SMS when file_upload event arrives.

### Requirements
NOT-01, NOT-02

### Success criteria
1. On file_upload event, system looks up guest contact info by jobId from local store
2. Email/SMS is sent with direct photo link
3. Failed sends are retried up to N times, then logged for manual follow-up

---

## M5: Client API & Display Feed

### Goal
Expose read-only endpoints for guests (queue position) and booth display (realtime feed).

### Requirements
API-01, API-02, AUTH-03

### Success criteria
1. GET /status/:jobId returns current queue position and estimated wait
2. Booth display WS client receives realtime updates: current guest name + Agent online/offline status
3. Sensitive data (email, phone) is masked in all logs

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Agent WS disconnect mid-session | Medium | High | Timeout safety net; don't auto-dispatch |
| Mirror proxy drop packets | Medium | High | DB polling fallback already planned |
| Email/SMS provider outage | Low | Medium | Retry + manual fallback queue |
| SQLite corruption on crash | Low | High | Write-ahead log; backup before migrations |
| Memory leak in long-running WS | Medium | Medium | Memory profiling; event listener cleanup |

---

*Roadmap created: 2025-07-21*
