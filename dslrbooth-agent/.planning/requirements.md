# Requirements: dslrbooth-agent

## Project Vision
A stateless, reliable Windows Service that acts as a pure relay between dslrBooth Local API and the Extension Service, enabling centralized booth management without embedding business logic on the booth machine.

---

## Functional Requirements

### FR-1: Command Relay (Extension Service → dslrBooth)
| ID | Requirement | Priority |
|----|-------------|----------|
| FR-1.1 | Receive `start_session` command via WebSocket with `mode` (print/gif/video/...) and `jobId` | MUST |
| FR-1.2 | Call dslrBooth `GET /api/start?mode={mode}&password={pwd}` | MUST |
| FR-1.3 | Parse response: check `IsSuccessful`, extract `ErrorMessage` | MUST |
| FR-1.4 | Send `ack` back via WebSocket: `{type: "ack", jobId, ok: boolean, errorMessage}` | MUST |
| FR-1.5 | Support future commands via extensible message handler (no code change for new actions) | SHOULD |

### FR-2: Trigger Forwarding (dslrBooth → Extension Service)
| ID | Requirement | Priority |
|----|-------------|----------|
| FR-2.1 | HTTP GET endpoint `/dslrbooth-event` on configurable port (default 3001) | MUST |
| FR-2.2 | Accept `event_type` query param + arbitrary additional params | MUST |
| FR-2.3 | **Always return 200 OK immediately** (< 100ms) — dslrBooth does not retry | MUST |
| FR-2.4 | Forward ALL events to Extension Service via WebSocket as `{type: "event", event: "...", params: {...}, timestamp}` | MUST |
| FR-2.5 | Never filter or transform events — pure pass-through | MUST |

### FR-3: WebSocket Connection Management
| ID | Requirement | Priority |
|----|-------------|----------|
| FR-3.1 | Connect to `EXTENSION_SERVICE_WS_URL` on startup | MUST |
| FR-3.2 | Auto-reconnect on disconnect with exponential backoff (base 2s, max 30s) | MUST |
| FR-3.3 | Send heartbeat `{type: "heartbeat", timestamp}` every 15s | MUST |
| FR-3.4 | Handle message parsing errors gracefully (log, continue) | MUST |

### FR-4: Error Handling & Resilience
| ID | Requirement | Priority |
|----|-------------|----------|
| FR-4.1 | dslrBooth API offline → log error, send `ack.ok=false`, continue running | MUST |
| FR-4.2 | WebSocket disconnect → auto-reconnect, queue nothing (stateless) | MUST |
| FR-4.3 | Uncaught exception / unhandled rejection → log full stack, exit gracefully | MUST |
| FR-4.4 | Trigger server errors → always return 200, log error internally | MUST |

---

## Non-Functional Requirements

### NFR-1: Performance
| ID | Requirement | Target |
|----|-------------|--------|
| NFR-1.1 | Trigger endpoint latency (receive → 200 OK) | < 50ms p99 |
| NFR-1.2 | Command → ack latency (local network) | < 2s |
| NFR-1.3 | Memory usage (idle) | < 100MB |
| NFR-1.4 | CPU usage (idle) | < 1% |

### NFR-2: Reliability
| ID | Requirement | Target |
|----|-------------|--------|
| NFR-2.1 | Uptime (with dslrBooth running) | 99.9% |
| NFR-2.2 | Auto-recovery from network blip | < 30s |
| NFR-2.3 | Survive dslrBooth restart | Auto-reconnect on next command |
| NFR-2.4 | Survive Extension Service restart | Auto-reconnect + resume |

### NFR-3: Security
| ID | Requirement | Target |
|----|-------------|--------|
| NFR-3.1 | API password never in logs | Zero occurrences |
| NFR-3.2 | `.env` not in version control | Verified in CI |
| NFR-3.3 | Trigger server binds to `0.0.0.0` (firewall as needed) | Configurable |
| NFR-3.4 | No unauthenticated admin endpoints | Only `/health` public |

### NFR-4: Operability
| ID | Requirement | Target |
|----|-------------|--------|
| NFR-4.1 | Logs to daily rotating files (14-day retention) | Winston |
| NFR-4.2 | Log level configurable (`debug`/`info`/`warn`/`error`) | `.env` |
| NFR-4.3 | Windows Service: auto-start on boot, restart on crash | `node-windows` |
| NFR-4.4 | Health check endpoint `/health` | HTTP 200 + JSON |

---

## Interface Contracts

### WebSocket Messages

**Extension Service → Agent**
```json
{ "type": "command", "action": "start_session", "mode": "print", "jobId": "uuid-v4" }
```

**Agent → Extension Service (ack)**
```json
{ "type": "ack", "jobId": "uuid-v4", "ok": true, "errorMessage": "" }
```

**Agent → Extension Service (event forward)**
```json
{ "type": "event", "event": "session_end", "params": {}, "timestamp": 1721395200000 }
```

**Agent → Extension Service (heartbeat)**
```json
{ "type": "heartbeat", "timestamp": 1721395200000 }
```

### dslrBooth Trigger (HTTP GET)
```
GET /dslrbooth-event?event_type=session_end&param1=value1&param2=value2
→ 200 OK
```

### dslrBooth Local API (HTTP GET)
```
GET /api/start?mode=print&password=xxx
→ { "ApiVersion": 1, "Command": "start?mode=print", "IsSuccessful": true, "ErrorMessage": "" }
```

---

## Configuration

| Env Var | Required | Default | Description |
|---------|----------|---------|-------------|
| `EXTENSION_SERVICE_WS_URL` | YES | — | WebSocket URL (e.g., `ws://host:8080/agent`) |
| `DSLRBOOTH_API_PORT` | NO | 1500 | dslrBooth API port |
| `DSLRBOOTH_PASSWORD` | YES | — | API password from dslrBooth Settings |
| `TRIGGER_SERVER_PORT` | NO | 3001 | Local trigger HTTP port |
| `LOG_LEVEL` | NO | info | Winston log level |
| `LOG_DIR` | NO | logs | Log directory (relative to CWD) |

---

## Acceptance Criteria

| Scenario | Given | When | Then |
|----------|-------|------|------|
| **AC-1** | Agent running, WS connected, dslrBooth healthy | Extension Service sends `start_session` | Agent calls API, sends `ack.ok=true` |
| **AC-2** | Agent running, dslrBooth API down | Extension Service sends `start_session` | Agent sends `ack.ok=false` with error, no crash |
| **AC-3** | Agent running, WS disconnects | Extension Service restarts | Agent reconnects within 30s, resumes |
| **AC-4** | dslrBooth session completes | dslrBooth calls trigger URL with `session_end` | Agent returns 200, forwards event via WS |
| **AC-5** | Agent installed as Windows Service | Machine reboots | Service starts automatically before login |
| **AC-6** | Agent running | Unhandled error occurs | Error logged with stack, process exits, service restarts |
| **AC-7** | Log inspection | Any log file | No `DSLRBOOTH_PASSWORD` value visible |

---

## Dependencies

### External
- dslrBooth Professional for Windows v6.40+
- Extension Service (WebSocket server) — separate deployment

### Internal (npm)
- `ws@^8.18` — WebSocket client
- `express@^4.19` — Trigger HTTP server
- `winston@^3.13` + `winston-daily-rotate-file@^5.0` — Logging
- `node-windows@^1.0.0-beta.8` — Service wrapper
- `dotenv@^16.4` — Config

---

## Out of Scope (Explicitly NOT in Agent)

- ❌ Queue management / job scheduling
- ❌ Booth state machine (IDLE/BUSY)
- ❌ "Who's next" display logic
- ❌ Photo upload / email / SMS / print orchestration
- ❌ Multi-booth coordination
- ❌ Analytics / reporting

*All above belong in Extension Service.*

---

## Traceability to Implementation

| Req | File |
|-----|------|
| FR-1.1–1.5 | `src/index.ts` (message handler) |
| FR-1.2–1.3 | `src/dslrbooth/client.ts` |
| FR-2.1–2.5 | `src/triggers/server.ts` + `src/index.ts` (forward) |
| FR-3.1–3.4 | `src/websocket/connection.ts` |
| FR-4.1–4.4 | `src/index.ts` (error handlers) + all files |
| NFR-3.1 | `src/dslrbooth/client.ts` (password in memory only) |
| NFR-4.1 | `src/logging/logger.ts` |
| NFR-4.3 | `service/install-service.js` |