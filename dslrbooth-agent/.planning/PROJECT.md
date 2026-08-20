# Project: dslrbooth-agent

## Overview

**Stateless relay agent** running on Windows booth machines with **dslrBooth Professional**. Bridges:
- **Extension Service** (WebSocket) ←→ **dslrBooth Local API** (HTTP)
- **dslrBooth Triggers** (HTTP webhook) → **Extension Service** (WebSocket)

**Core principle**: Agent is **dumb/stateless** — no queue, no state machine, no business logic. Pure relay only.

---

## Context

### Problem
- dslrBooth runs locally on booth Windows machine
- Extension Service (cloud/central) manages queues, booth state, displays
- Need reliable, auto-recovering bridge between them
- Must run as Windows Service (pre-login, auto-restart)

### Solution
This Agent — minimal, robust, stateless:
1. Receives `start_session` command via WS → calls dslrBooth `/api/start`
2. dslrBooth fires triggers to local HTTP endpoint → Agent forwards to WS
3. Heartbeat every 15s keeps connection alive
4. Auto-reconnect with exponential backoff on any disconnect

---

## Stakeholders

| Role | Interest |
|------|----------|
| **Booth Operator** | Reliable session start, no manual intervention |
| **Extension Service Team** | Clean event stream, predictable protocol |
| **DevOps** | Windows Service, logging, monitoring, deployability |
| **Security** | No secrets in logs, no open ports beyond trigger port |

---

## Constraints & Boundaries

### Hard Constraints (DO NOT VIOLATE)
- ❌ **No queue** — Extension Service owns queue
- ❌ **No state machine** — Extension Service owns IDLE/BUSY
- ❌ **No business logic** — "who's next", printing, uploads, etc.
- ❌ **No multi-booth** — single booth per Agent (future: boothId in messages)
- ❌ **No dslrBooth modification** — only use public API/trigger

### Technical Constraints
- Runtime: **Node.js 20 LTS** on Windows 10/11
- dslrBooth: **Professional v6.40+** (Local API + Triggers)
- Service: **node-windows** (native Windows Service)
- Logs: **Winston daily rotate** (14 days, 10MB, gzip)

---

## Architecture

```
┌─────────────────────┐     WebSocket      ┌──────────────────┐
│  Extension Service  │ ◄──────────────────► │   dslrBooth      │
│  (Queue, State,     │  start_session     │   Agent          │
│   Display Logic)    │  ack, events       │   (this)         │
└─────────────────────┘                    └────────┬─────────┘
                              HTTP :1500            │
                              /api/start            │
                                                     │
                              HTTP :3001            │
                              /dslrbooth-event ◄────┘
                              (dslrBooth triggers)
```

### Message Flow

**1. Session Start (Extension → Agent → dslrBooth)**
```
Extension Service          Agent                    dslrBooth
     │                       │                         │
     ├─ WS: command(start) ─►│                         │
     │                       ├─ HTTP: /api/start ─────►│
     │                       │◄─ {IsSuccessful: true} ─┤
     │◄─ WS: ack(ok=true) ───┤                         │
```

**2. Session Events (dslrBooth → Agent → Extension)**
```
dslrBooth                  Agent                    Extension Service
    │                       │                         │
    ├─ HTTP: trigger ─────►│                         │
    │  200 OK immediately  │                         │
    │                       ├─ WS: event(...) ──────►│
    │                       │                         │
```

---

## Current State (Completion: M1 Done, M2 Active)

### Implemented (M1 ✅)
- All core relay logic (M1 complete)
- Windows Service installer
- Configuration via `.env`
- Structured logging with rotation
- Auto-reconnect + heartbeat

### In Progress (M2 🔄)
- Real integration testing with dslrBooth + Extension Service

### Not Yet Done
- Prometheus metrics (M3)
- CI/CD, installer, fleet deployment (M4)

---

## Milestones

| Milestone | Target | Focus | Status |
|-----------|--------|-------|--------|
| **M1: Core Agent** | Done | Stateless relay, Windows Service | ✅ Complete |
| **M2: Integration Hardening** | Active | Real dslrBooth + Extension Service test | 🔄 In Progress |
| **M3: Observability** | +1 week | Metrics, health, runbooks | 📋 Planned |
| **M4: Production Ready** | +2 weeks | CI/CD, installer, rollout | 📋 Planned |

---

## M2: Integration Hardening — Detailed Plan

### Goal
Validate Agent works end-to-end with **real dslrBooth** and **Extension Service** on booth machine. Identify and fix any protocol mismatches, permission issues, or network problems.

### Phase 1: Deploy to Booth Machine
| Task | Description | Deliverable |
|------|-------------|-------------|
| M2-P1.1 | Build production bundle (`npm run build`) | `dist/` folder with compiled JS |
| M2-P1.2 | Copy `dist/`, `service/`, `.env` to `C:\dslrbooth-agent\` | Files on target machine |
| M2-P1.3 | Edit `.env` with booth-specific values (WS URL, dslrBooth password) | Configured `.env` |
| M2-P1.4 | Install Windows Service (Admin PowerShell: `npm run service:install`) | Service "dslrBooth Agent" running |

### Phase 2: Configure dslrBooth
| Task | Description | Deliverable |
|------|-------------|-------------|
| M2-P2.1 | Settings → General → API: verify Port = 1500, copy Password | Confirmed values |
| M2-P2.2 | Settings → General → Triggers → URL: `http://127.0.0.1:3001/dslrbooth-event` | Trigger configured |
| M2-P2.3 | Test trigger endpoint: `curl "http://127.0.0.1:3001/dslrbooth-event?event_type=test"` | Returns 200 OK |

### Phase 3: Connect Extension Service
| Task | Description | Deliverable |
|------|-------------|-------------|
| M2-P3.1 | Start Extension Service dev instance | WS server running |
| M2-P3.2 | Verify Agent WS connection (logs show "WebSocket connected") | WS connected |
| M2-P3.3 | Verify heartbeat flowing (logs show "Heartbeat sent" every 15s) | Heartbeat active |

### Phase 4: End-to-End Session Test
| Task | Description | Deliverable |
|------|-------------|-------------|
| M2-P4.1 | Trigger full photo session via Extension Service or dslrBooth UI | Session initiated |
| M2-P4.2 | Verify all 11 event types received by Extension Service: session_start, countdown_start, countdown, capture_start, file_download, processing_start, sharing_screen, file_upload, printing, session_end | Complete event log |
| M2-P4.3 | Verify `ack.ok=true` for start_session command | Command acknowledgment |

### Phase 5: Failure Mode Testing
| Task | Description | Deliverable |
|------|-------------|-------------|
| M2-P5.1 | Kill Extension Service process, wait 10s, restart — verify Agent auto-reconnects | WS reconnect < 30s |
| M2-P5.2 | Stop dslrBooth, send start_session from Extension Service — verify `ack.ok=false` with error | Graceful API error |
| M2-P5.3 | Reboot Windows machine — verify Agent service starts automatically | Service running post-reboot |
| M2-P5.4 | Simulate network latency (clumsy/tool) — verify no message loss | Resilient to latency |

### Phase 6: Security & Log Validation
| Task | Description | Deliverable |
|------|-------------|-------------|
| M2-P6.1 | grep logs for `DSLRBOOTH_PASSWORD` — must return zero matches | No secret leakage |
| M2-P6.2 | Verify log rotation works (14-day retention, daily files) | Rotating logs |
| M2-P6.3 | Verify `/config` endpoint binds only to 127.0.0.1 (not 0.0.0.0) | Local-only config UI |
| M2-P6.4 | Test remote access to `/config` from another machine on LAN — must fail | No LAN exposure |

---

## Risks & Mitigations for M2

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| dslrBooth trigger params differ from spec | Medium | High | Log all params during test; adapt forwarding |
| Windows Service permission issues on target | Medium | High | Test install as Admin; run service as SYSTEM |
| Extension Service protocol mismatch | Medium | Medium | Version handshake; backward-compatible ack |
| Firewall blocks trigger port | Medium | High | Ensure port 3001 allow rule; test locally first |
| Agent fails to read .env as Service | Low | High | Use `env` in service config; verify in logs |

---

## Acceptance Criteria for M2

| AC | Scenario | Pass Condition |
|----|----------|----------------|
| M2-AC1 | Full photo session triggered | All 11 events forwarded, ack.ok=true |
| M2-AC2 | Extension Service down 10s | Agent reconnects < 30s, heartbeats resume |
| M2-AC3 | dslrBooth API offline | ack.ok=false with error, Agent continues |
| M2-AC4 | Machine reboot | Service running < 60s post-boot |
| M2-AC5 | Password in logs | zero occurrences |
| M2-AC6 | /config not accessible from LAN | 404 or connection refused from remote |

---

## Traceability

| Phase | Requirements |
|-------|--------------|
| M2-P1 to M2-P3 | NFR-4.3 (Windows Service), FR-3.1 (WS connect) |
| M2-P4 | FR-1.1-1.4 (command relay), FR-2.1-2.5 (trigger forward) |
| M2-P5 | FR-3.2 (reconnect), FR-4.1-4.3 (error handling) |
| M2-P6 | NFR-3.1, NFR-3.2, NFR-3.3 (security) |

---

## Risks

| Risk | Mitigation |
|------|------------|
| dslrBooth API changes | Pin API version in config; integration test in M2 |
| Windows Service perms | Test install as Admin; document required privileges |
| WS protocol drift | Version in handshake; backward-compatible ack |
| Log disk full | 14-day rotation × 10MB = 140MB max; monitor disk |

---

## References

- **dslrBooth Local API**: Settings → General → API (port, password)
- **dslrBooth Triggers**: Settings → General → Triggers → URL
- **Extension Service WS**: `ws://host:port/agent` (configured in `.env`)
- **Repo**: Local folder `dslrbooth-agent`

---

*Project initialized: 2025-07-19*
*Last updated: 2025-07-19*
*Current Milestone: M2 — Integration Hardening*