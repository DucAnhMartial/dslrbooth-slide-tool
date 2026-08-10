# GSD State: dslrbooth-agent

## Current Milestone: M2 — Integration Hardening 🔄 IN PROGRESS

### Phase: M2-P1 (Deploy to Booth Machine)

---

## Milestone Progress

| Phase | Task | Status | Notes |
|-------|------|--------|-------|
| M2-P1.1 | Build production bundle | ⏳ Pending | |
| M2-P1.2 | Copy to target machine | ⏳ Pending | |
| M2-P1.3 | Configure booth .env | ⏳ Pending | |
| M2-P1.4 | Install Windows Service | ⏳ Pending | |
| M2-P2.1 | Record dslrBooth API settings | ⏳ Pending | |
| M2-P2.2 | Configure Trigger URL | ⏳ Pending | |
| M2-P2.3 | Test trigger endpoint | ⏳ Pending | |
| M2-P3.1 | Start Extension Service | ⏳ Pending | |
| M2-P3.2 | Verify Agent WS connection | ⏳ Pending | |
| M2-P3.3 | Verify heartbeat | ⏳ Pending | |
| M2-P4.1 | Trigger full session | ⏳ Pending | |
| M2-P4.2 | Verify all 11 events | ⏳ Pending | |
| M2-P4.3 | Verify command ack | ⏳ Pending | |
| M2-P5.1 | Test WS reconnect | ⏳ Pending | |
| M2-P5.2 | Test dslrBooth API offline | ⏳ Pending | |
| M2-P5.3 | Test machine reboot | ⏳ Pending | |
| M2-P5.4 | Test network latency | ⏳ Optional | |
| M2-P6.1 | Password not in logs | ⏳ Pending | |
| M2-P6.2 | Log rotation verified | ⏳ Pending | |
| M2-P6.3 | Config UI local-only | ⏳ Pending | |
| M2-P6.4 | Config UI basic auth | ⏳ Optional | |

---

## Completed Milestones

### M1: Core Agent ✅ COMPLETED
- All 15 implementation steps done
- TypeScript project with full relay logic
- Windows Service installer
- Configuration, logging, error handling
- README and documentation

---

## Active Decisions (carried from M1)

| Decision | Rationale |
|----------|-----------|
| Stateless relay only | Keeps Agent simple, reliable; all logic in Extension Service |
| `ws` library over `socket.io` | Lighter, native WS, no extra protocol |
| Express for trigger server | Simple, battle-tested, easy health endpoint |
| Winston daily rotate | No external log shipper needed; 14-day local retention |
| `node-windows` for service | Native SCM integration, auto-start, crash recovery |

---

## M2-Specific Decisions (to be made during integration)

| Decision | Options | Status |
|----------|---------|--------|
| Config UI password | None / Simple shared secret / HTTP Basic Auth | ⏳ Decide in P8 |
| Trigger param mapping | Pass through as-is / Normalize keys | ⏳ Test in P4 |
| dslrBooth API timeout | Current 10s / Adjust based on real perf | ⏳ Measure in P4 |
| Heartbeat interval | 15s (current) / Adaptive based on latency | ⏳ Review in P5 |

---

## Blockers / Risks

| Item | Status | Mitigation |
|------|--------|------------|
| Booth machine access | ⏳ Need physical/virtual access | Schedule time with ops |
| Extension Service dev instance | ⏳ Need WS endpoint URL | Coordinate with backend team |
| Windows Admin rights on booth | ⏳ Need for Service install | Confirm with IT |
| dslrBooth license on booth | ⏳ Verify v6.40+ Professional | Check with booth setup |

---

## Next Actions (Immediate)

1. **Get booth machine access** — coordinate with team
2. **Get Extension Service WS URL** — need dev instance endpoint
3. **Run `npm run build`** on dev machine
4. **Copy artifacts** to `C:\dslrbooth-agent\` on booth machine
5. **Start M2-P1.1**

---

## Metrics (M1 Baseline)

| Metric | Value |
|--------|-------|
| Lines of code (src/) | ~550 TS |
| Files created | 15 |
| Dependencies (prod) | 6 |
| Dependencies (dev) | 5 |
| Build status | ✅ TypeScript strict passes |

---

## Notes for Next Phase (M3)

- `/metrics` endpoint needed (prom-client)
- Structured JSON logging option
- Health check should probe dslrBooth API
- Alert rules doc for: WS down > 1min, trigger rate drop, API errors > 5%
- Runbook for common issues

---

*Updated: 2025-07-19*
*Milestone: M2 — Integration Hardening*
*Phase: M2-P1 (Deploy)*