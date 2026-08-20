# Roadmap: dslrbooth-agent

## Milestone Overview

| Milestone | Target | Focus | Status |
|-----------|--------|-------|--------|
| **M1: Core Agent** | Week 1 | Stateless relay, Windows Service | ✅ Done |
| **M2: Integration Hardening** | Week 2 | Real dslrBooth + Extension Service testing | 🔄 Next |
| **M3: Observability** | Week 3 | Metrics, alerting, operational docs | 📋 Planned |
| **M4: Production Ready** | Week 4 | CI/CD, installer, rollout guide | 📋 Planned |

---

## M1: Core Agent (COMPLETED)

### Delivered Features
- [x] **Project scaffolding** — TypeScript, ESLint/Prettier config, npm scripts
- [x] **Config layer** — `.env` validation, required fields, defaults
- [x] **Logger** — Winston + daily rotate (14-day, 10MB, gzip)
- [x] **dslrBooth HTTP client** — GET `/api/start`, parse `IsSuccessful`/`ErrorMessage`, 10s timeout
- [x] **WebSocket client** — `ws` library, auto-reconnect (2s→30s exponential), heartbeat 15s
- [x] **Message handler** — `command` → `start_session` → API call → `ack`
- [x] **Trigger HTTP server** — Express, `/dslrbooth-event` + `/health`, always 200
- [x] **Trigger → WS forward** — All `event_type` params passed through
- [x] **Error handling** — API errors, WS disconnect, uncaught exceptions
- [x] **Windows Service** — `node-windows` installer, auto-start, restart on crash
- [x] **Security** — `.gitignore` for `.env`/logs, password never logged
- [x] **README** — Install, configure, run, troubleshoot

### Files Created
```
src/
├── index.ts                 # Entry point, wires all components
├── config.ts                # loadConfig() with validation
├── dslrbooth/client.ts      # HTTP API client
├── websocket/connection.ts  # WS client with reconnect + heartbeat
├── triggers/server.ts       # Trigger HTTP server
├── health/heartbeat.ts      # Heartbeat sender (used by WS connection)
└── logging/logger.ts        # Winston factory
service/install-service.js   # Windows Service installer
.env.example
.gitignore
package.json / tsconfig.json
README.md
```

---

## M2: Integration Hardening (NEXT)

### Goal
Validate Agent works end-to-end with **real dslrBooth** and **Extension Service** on booth machine.

### Tasks
| ID | Task | Owner | Est. |
|----|------|-------|------|
| M2-1 | Install Agent on booth machine (Windows Service) | Dev | 1h |
| M2-2 | Configure dslrBooth: API port/password, Trigger URL | Dev | 30m |
| M2-3 | Start Extension Service (dev instance) | Dev | 30m |
| M2-4 | Run full session: trigger → command → session → triggers | Dev | 1h |
| M2-5 | Verify all events forwarded: session_start → session_end | Dev | 30m |
| M2-6 | Test WS reconnect: kill Extension Service, verify auto-reconnect | Dev | 30m |
| M2-7 | Test dslrBooth offline: stop dslrBooth, send command, verify ack.ok=false | Dev | 30m |
| M2-8 | Test machine reboot: verify service auto-starts | Dev | 1h (wait for reboot) |
| M2-9 | Log review: search for password, verify rotation | Dev | 15m |
| M2-10 | Document any config adjustments needed | Dev | 15m |

### Acceptance Test Scenarios
| Scenario | Expected |
|----------|----------|
| Happy path: full photo session | All 11 event types received by Extension Service |
| Network blip: Extension Service down 10s | Agent reconnects, resumes heartbeats |
| dslrBooth crash mid-session | Agent logs error, Extension Service gets session_end eventually |
| Machine reboot | Service running within 60s of boot |

---

## M3: Observability

### Goal
Production-grade visibility into Agent health and performance.

### Tasks
| ID | Task | Est. |
|----|------|------|
| M3-1 | Add Prometheus metrics endpoint (`/metrics`) | 2h |
| M3-2 | Metrics: `ws_connected`, `trigger_received_total`, `command_handled_total`, `ack_ok/err`, `dslrbooth_api_latency_ms` | 1h |
| M3-3 | Structured JSON logging option (for log aggregation) | 1h |
| M3-4 | Health check: `/health` returns dslrBooth API reachability | 1h |
| M3-5 | Alert rules doc: WS down > 1min, trigger rate drop, API errors > 5% | 1h |
| M3-6 | Runbook: common issues & fixes | 2h |

### Dependencies
- `prom-client` npm package
- Extension Service / monitoring stack to scrape `/metrics`

---

## M4: Production Ready

### Goal
Zero-touch deployment and reliable rollout across multiple booth machines.

### Tasks
| ID | Task | Est. |
|----|------|------|
| M4-1 | CI/CD: GitHub Actions build + test on Windows runner | 3h |
| M4-2 | Single-executable build (pkg/nexe) — no Node runtime needed | 2h |
| M4-3 | MSI/EXE installer with silent install flags | 4h |
| M4-4 | Config management: remote config fetch on startup (optional) | 3h |
| M4-5 | Rollout guide: staging → production, rollback procedure | 2h |
| M4-6 | Versioning: semver, changelog, release notes | 1h |
| M4-7 | Unattended install script for fleet deployment | 2h |

---

## Phase Traceability

| Phase | Requirements Covered |
|-------|---------------------|
| M1 | All FR-1, FR-2, FR-3, FR-4, NFR-3.1, NFR-3.2, NFR-4.1, NFR-4.3 |
| M2 | Validates all AC-1 through AC-7 |
| M3 | NFR-4.1 (extended), NFR-4.4 (health endpoint already in M1) |
| M4 | NFR-2.1, NFR-2.2 (operational maturity) |

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| dslrBooth API changes | Low | High | Version pin in config; integration test in M2 |
| Windows Service permission issues | Medium | High | Test install as Admin; document required privileges |
| Extension Service protocol drift | Medium | Medium | Version in WS handshake; backward-compatible ack |
| Log disk full | Low | Medium | Max 14 files × 10MB = 140MB; monitor disk |
| Password leakage in logs | Low | Critical | Code review; grep check in CI (M4-1) |

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Agent uptime (with dslrBooth running) | > 99.9% |
| Trigger → Extension Service latency | < 100ms p99 |
| Command → ack latency | < 2s p99 |
| Zero password occurrences in logs | 100% |
| Service auto-restart after crash | < 30s |
| Machine boot → Agent ready | < 60s |

---

*Roadmap created: 2025-07-19*
*Next review: After M2 integration testing*