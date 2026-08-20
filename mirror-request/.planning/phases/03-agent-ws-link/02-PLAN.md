---
plan: 2
phase: 3
wave: 1
title: Dispatch commands to Agent over WebSocket
requirements: [AGT-02]
depends_on: [Plan 01]
files_modified: []
new_files: []
autonomous: true
---

## Objective

Add a `sendCommand()` method to `AgentServer` that serializes a dispatch action and sends it to the connected Agent. Expose `sendCommand` so `QueueService.sessionAcked()` can be followed by a command send in future phases.

## Action

1. Edit `src/agent/agentServer.ts` — add:

   `sendCommand(payload: { type: 'command'; action: string; jobId: string; mode?: string }): boolean` — if Agent is connected, `agentConn.ws.send(JSON.stringify(payload))` and return true. If no Agent, log warning and return false.

   Payload shape matches Requirement AGT-02: `{ type: "command", action: "start_session", jobId, mode }`.

2. Add a simple `onAgentMessage(handler)` setter — stores a callback invoked for each incoming WS message. This is a stub now; Plan 04 will wire the real handlers.

3. Add `sendEvent(payload)` — symmetric `sendCommand` but for events the server might push (Phase 5 booth display feed).

## Read First

- `src/agent/agentServer.ts` (Plan 01 result)
- `src/types.ts` (AgentMessage type)

## Acceptance Criteria

- [ ] `sendCommand({ type: 'command', action: 'start_session', jobId: 'abc', mode: 'standard' })` sends JSON over WS when Agent is online
- [ ] `sendCommand()` returns false and logs warning when no Agent connected
- [ ] `npx tsc --noEmit` exits 0
