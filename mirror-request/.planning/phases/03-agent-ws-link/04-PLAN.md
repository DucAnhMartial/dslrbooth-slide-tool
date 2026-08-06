---
plan: 4
phase: 3
wave: 2
title: Wire AgentServer into server and QueueService
requirements: [AGT-02, AGT-03, AGT-04]
depends_on: [Plan 01, Plan 02, Plan 03]
files_modified:
  - src/index.ts
  - src/queue/queueService.ts
autonomous: true
---

## Objective

Integrate AgentServer into the Express server lifecycle and plug it into QueueService so dispatch sends WS commands to Agent, and Agent responses flow back into queue state.

## Action

1. Edit src/index.ts:
   - Import AgentServer from ./agent/agentServer
   - After server.listen(), call agentServer.start(server)
   - Pass agentServer into createQueueService(store, config, agentServer)
   - Call agentServer.stop() in shutdown()

2. Edit src/queue/queueService.ts:
   - Accept optional agentServer in constructor
   - On dispatch: after setBoothBusy(), call agentServer?.sendCommand({ type: 'command', action: 'start_session', jobId, mode })
   - Register handlers:
     - onAck: if ok=true → sessionAcked(jobId); if ok=false → log error, set stall_reason, reset booth IDLE
     - onEvent(eventType): route session_start/session_end/file_upload to respective handlers

## Read First

- src/index.ts
- src/agent/agentServer.ts (Plans 01-03)
- src/queue/queueService.ts (Phase 2 Plan 03)

## Acceptance Criteria

- [ ] npm run dev starts, AgentServer initializes on same port
- [ ] On dispatch, JSON command sent to connected Agent over WS
- [ ] Agent ack { ok: true } triggers sessionAcked in QueueService
- [ ] Agent ack { ok: false } resets booth to IDLE with stall_reason
- [ ] Agent event session_end triggers sessionEnded() in QueueService
- [ ] npx tsc --noEmit exits 0
