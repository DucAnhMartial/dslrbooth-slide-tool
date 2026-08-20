# Feature Landscape

**Domain:** Photobooth Extension Service — single-booth real-time orchestration
**Context:** Bridge between guest registration (via mirror + DB polling) and dslrBooth
booth via Agent Windows relay. Single-booth, Node.js 20 LTS.
**Researched:** 2026-07-22
**Confidence:** HIGH -- requirements fully specified in REQUIREMENTS.md; architecture
and domain well-understood from PROJECT.md, ROADMAP.md, PLAN.md, and STATE.md.

---

## Table Stakes Features

Features users and operators expect. Missing any of these = product feels broken.

| Feature | Why Expected | Complexity | Notes |
|---|---|---|---|
| Registration ingestion (POST /on-register) | Primary entry point; guests scan QR and register via form. If this fails the whole flow breaks. | Low | 200 OK immediately -- async processing -- accepts mirrored payload from reverse proxy -- IP allowlist enforced before handler runs. |
| DB polling fallback (read-only SELECT) | Reverse proxy mirror can fail silently. Polling catches missed registrations -- guarantees no silently dropped registration. | Medium | Periodic SELECT on backend read-only account; polling cursor stored in SQLite; resumes after restart without reprocessing old rows. |
| Single-booth FIFO queue | Fundamental fairness contract -- guests expect first-come-first-served order. | Low | In-memory for 1 booth; SQLite persistence for restart recovery. Pure in-process -- no distributed coordination required. |
| Idempotency (duplicate detection) | Mirror may re-deliver; backend may retry; DB poll may re-scan. Prevents double queueing. | Low | Key on registration/record ID -- dedup before enqueue -- returns duplicate ack for repeat requests. |
| Booth state machine (IDLE / BUSY) | System must know booth availability before dispatching -- prevents double session start. | Low | Three states: IDLE, BUSY, TIMEOUT_RESET. Transitions deterministic and observable in logs. |
| Auto-session dispatch from queue to Agent | No operator should need to manually trigger a photo session. | Low | Booth goes from IDLE to BUSY automatically within one event loop tick when queue has jobs. |
| Auto-timeout recovery from stalled session | A crashed or offline booth mid-session must not stay BUSY forever. | Low | Configurable 5-minute timeout -- reset IDLE + log warning + advance queue. Stalled job preserved for post-mortem. |
| Authenticated WS link to Agent | The entire booth triggering pipeline depends on this channel being reliable. | Medium | WS server -- per-Agent token handshake -- bidirectional command/ack/event/heartbeat protocol. |
| Heartbeat-driven Agent health visibility | Operators and display feed see real-time Agent online/offline status. Prevents futile dispatch to dead Agent. | Low | No heartbeat for >30s -> offline -- resumes on next heartbeat -- offline duration observable in logs. |
| Guest notification (email/SMS after file_upload) | Core value prop: guests register to receive their photo. Without delivery the product has no purpose. | Medium | Async bounded retry (3 attempts, exponential backoff) -- manual-fallback log on exhaustion -- never silently drops a photo. |
| Guest-facing status endpoint (GET /status/:jobId) | Guests need to check their queue position and estimated wait. | Low | Read-only -- returns position, status, estimated wait -- bearer token protected -- no mutation. |
| Booth display feed (WS or SSE) | Physical booth screen shows next guest name and Agent health in real time. | Medium | Push-based -- snapshot on connect -- push on every state change -- at-least-once for initial snapshot. |

---

## Differentiators

Features that set this product apart. Not universally expected in every photobooth
system, but high value when present.

| Feature | Value Proposition | Complexity | Notes |
|---|---|---|---|
| Dual ingestion path (mirror + DB poll) | Zero-registration-loss guarantee. If the reverse proxy mirror fails silently, the read-only DB poll catches everything. No standard photobooth or generic event-relay vendor exposes this two-path ingestion design. | Medium | Poller stores cursor in SQLite after each cycle -- resumes without reprocessing old rows after a service restart. Requires a read-only DB account on the backend. |
| Lossless timeout-driven queue recovery | Operators never need direct manual intervention for stalled sessions. The system auto-resets after 5 minutes and advances the queue on its own. | Low | Configurable timeout; stalled job logged with full context (jobId, timestamp, last known state) for post-mortem and customer follow-up. |
| Heartbeat-driven Agent health exposure | Operators and the display feed explicitly know whether the booth Agent is genuinely online vs. dead. Prevents dispatch commands to a dead Agent. | Low | No heartbeat received for >30 seconds -> Agent marked offline -- status observable via display feed and logs. |
| Bounded notification retry with manual-fallback log | Guest photos are never silently lost on email/SMS delivery failure. Retried with backoff; after exhaustion, failure is logged with full delivery context for human follow-up. | Low | Exponential backoff; max attempts configurable; structured failure log entry includes jobId, guest contact, provider response, and timestamp. |
| Booth display snapshot-on-connect | Display clients never wait blind when they first connect. They receive the full current state (guest name, booth status, Agent health, queue depth) immediately on subscribe. | Medium | Use WS or SSE -- SSE is simpler for browser-based displays and natively supports at-least-once delivery of initial state snapshot. |
| No-queue-loss restart guarantee | Queue state, booth state, polling cursor, and job history all survive a service restart, power loss, or deploy event. Guests are never dropped from the queue because the service bounced. | Medium | Requires a correct SQLite schema and startup recovery path. Architectural differentiator vs. a pure in-memory queue that would lose all state on restart. |

---

## Anti-Features

Features to explicitly NOT build. Each maps to a stated constraint or architectural
boundary in the project docs.

| Anti-Feature | Why Avoid | What to Do Instead |
|---|---|---|
| Writing to the production backend database | Hard constraint: Extension Service must not INSERT, UPDATE, or DELETE in the real backend DB. | Read-only DB account for polling only. Outbound email/SMS on file_upload exclusively. |
| Calling dslrBooth Local API directly | All booth commands must route through Agent. Two independent writers to dslrBooth create state conflicts and double sessions. | Agent running on the booth Windows machine is the sole caller of /api/start. |
| Complex booth display UI rendering | Extension Service pushes data -- rendering is a separate frontend concern that belongs in a dedicated display client project. | WS/SSE endpoints deliver data only. Booth display is a thin client consuming the push feed. |
| Multi-booth queue coordination | v1 constraint: only 1 booth is in scope. Distributed queue is premature over-engineering. | Include boothId in message design at the schema level; implement multi-booth queue coordination in a planned v2 iteration. |
| Persisting state into the real backend | Extension Service should not write back to the backend -- the read-only boundary is an explicit design contract. | Local SQLite only. Backend data flows unidirectionally into Extension Service via polling or mirror. |
| Embedding business logic in the Agent | Agent is defined as stateless and dumb: no queue, no state machine, no "who is next" logic. | Agent relays commands and events only. All queue management, dispatch decisions, and notifications belong in Extension Service. |

---

## Feature Dependencies

Key explicit dependency chains in this system:

- ING-01 (POST /on-register) -> QUE-01 (FIFO enqueue) -> QUE-03 (dispatch on idle)
- QUE-03 (dispatch) depends on BTH-01 (IDLE state) -- no dispatch while BUSY
- AGT-02 (send command to Agent) depends on FR-3.1 (WS connection established)
- AGT-04 (receive event from Agent) -> BTH-01B (state transition to IDLE) -> QUE-04 (auto-advance queue)
- AGT-04 (file_upload event) -> NOT-01 (guest notification via email/SMS)
- STO-01 (SQLite store) underpins ING-02, QUE-01, BTH-01 -- all state persistence flows through it
- AUTH-02 (IP allowlist on /on-register) must be in place before ING-01 is considered complete

---

## MVP Recommendation

The v1 product should finalize these features in priority order:

1. Registration ingestion (ING-01) -- without this the system has no input
2. DB polling fallback (ING-02/ING-03) -- mirrors are not enough alone
3. SQLite local persistence (STO-01) -- without it a restart wipes the queue
4. Idempotency (QUE-02) -- duplicate prevention is foundational for correctness
5. FIFO queue + state machine (QUE-01, BTH-01/BTH-02) -- the core scheduling logic
6. Auto-dispatch on idle (QUE-03/QUE-04) -- the automated trigger pipeline
7. Authenticated WS link to Agent (AGT-01 through AGT-05) -- the bridge to the booth hardware
8. Guest notifications (NOT-01/NOT-02) -- the value delivery to end users
9. Guest status endpoint (API-01) -- the read-only visibility layer
10. Booth display feed (API-02) -- the physical booth experience

Defer to v2:
- Multi-booth coordination (V2-01) -- add boothId and a per-booth queue only if the business expands
- Advanced analytics dashboard (V2-02) -- this is operational reporting, not a v1 requirement

All AUTH-01/AUTH-03 hardening (token-protected status endpoint, PII masking in logs)
are table-stakes security hygiene and should ship alongside the features they protect
rather than in a separate phase.

---

## Sources

- REQUIREMENTS.md (ING-01..03, QUE-01..04, BTH-01..02, AGT-01..05, NOT-01..02, API-01..02, STO-01, AUTH-01..03)
- PROJECT.md (architecture sketch, constraints, out-of-scope boundary, milestones)
- ROADMAP.md (phase ordering, acceptance criteria, success criteria)
- PLAN.md (M2 integration test plan with 11 dslrBooth event types)
- ARCHITECTURE.md (component boundaries, data flow, scalability notes)
