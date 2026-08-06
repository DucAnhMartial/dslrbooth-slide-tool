---
plan: 2
phase: 5
wave: 1
title: WebSocket feed for booth display
requirements: [API-02]
depends_on: [Plan 01, Phase 3 Plan 05]
files_modified: []
new_files:
  - src/display/displayServer.ts
autonomous: true
---

## Objective

Create a WS endpoint at /display that pushes realtime updates to the booth display screen: current guest name, queue length, booth state, agent online status.

## Action

1. Create src/display/displayServer.ts:
   - class DisplayServer(server, queueService, agentServer)
   - Track connected display clients in a Set<WebSocket>
   - On state change (queue update, booth state change, agent status change): broadcast to all connected clients
   - Message format: { type: 'snapshot', data: DisplaySnapshot }

2. Edit src/index.ts:
   - Instantiate DisplayServer passing queueService and agentServer
   - Call displayServer.start(server) after agentServer

## Read First

- src/types.ts (DisplaySnapshot)
- src/agent/agentServer.ts (getAgentStatus from Phase 3)
- src/queue/queueService.ts (state expose method)

## Acceptance Criteria

- [ ] WS /display endpoint accepts client connections
- [ ] On dispatch, display clients receive snapshot with current guest name
- [ ] On agent disconnect, display updates to show offline
- [ ] Multiple display clients supported
- [ ] npx tsc --noEmit exits 0
