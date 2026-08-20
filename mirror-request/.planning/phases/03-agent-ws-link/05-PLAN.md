---
plan: 5
phase: 3
wave: 2
title: Heartbeat monitoring and agent online/offline status
requirements: [AGT-05]
depends_on: [Plan 04]
files_modified:
  - src/agent/agentServer.ts
autonomous: true
---

## Objective

Track heartbeat from Agent. If no heartbeat within HEARTBEAT_TIMEOUT_MS (30s default), mark agent offline and close connection. Expose status for Phase 5 display feed.

## Action

1. Edit src/agent/agentServer.ts:
   - On every WS message (ack, event, or heartbeat), update agentConn.lastHeartbeat = Date.now()
   - Add setInterval watchdog (15s interval, less than HEARTBEAT_TIMEOUT_MS):
     - If agentConn exists AND Date.now() - lastHeartbeat > config.HEARTBEAT_TIMEOUT_MS:
       - Set agentConn.online = false
       - Log warning: "Agent heartbeat timeout — marking offline"
       - Close WS connection (triggers disconnect handler in QueueService)
   - Heartbeat message format: { type: 'heartbeat', timestamp: number }

2. Add getAgentStatus() method:
   - Returns { online: boolean, lastHeartbeat: number | null }
   - Used by Phase 5 GET /status endpoint and WS display feed

## Read First

- src/agent/agentServer.ts (current state after Plan 04)
- src/config.ts (HEARTBEAT_TIMEOUT_MS = 30_000)
- src/types.ts (AgentConnection.online)

## Acceptance Criteria

- [ ] Heartbeat updates lastHeartbeat timestamp
- [ ] No heartbeat for 30s → Agent marked offline, connection closed, warning logged
- [ ] getAgentStatus() returns current online state
- [ ] Reconnect after timeout works normally (new connection accepted)
- [ ] npx tsc --noEmit exits 0
