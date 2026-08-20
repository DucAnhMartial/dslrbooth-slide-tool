---
plan: 6
phase: 3
wave: 2
title: Integration test: Agent WS lifecycle
requirements: [AGT-01, AGT-02, AGT-03, AGT-04, AGT-05]
depends_on: [Plan 01, Plan 02, Plan 03, Plan 04, Plan 05]
files_modified: []
new_files:
  - test/phase3-ws.test.ts
autonomous: true
---

## Objective

Write a focused integration test using the ws library's WebSocket client that exercises the full Phase 3 flow: auth rejection, command dispatch, ack round-trip, event handling, and heartbeat timeout.

## Action

1. Create test/phase3-ws.test.ts:
   - Use vitest + ws WebSocket client
   - Spin up AgentServer in-process on an ephemeral port
   - Use LocalStore with temp SQLite file (fs.mkdtemp)

   Test cases:

   a. Auth rejection
      - Connect without token → connection closes with code 4001 within 1s
      - isAgentOnline() returns false

   b. Auth success
      - Connect with correct token → isAgentOnline() returns true

   c. Command dispatch
      - After connect, call sendCommand({ type: 'command', action: 'start_session', jobId: 'test-1', mode: 'standard' })
      - Mock client receives the JSON payload

   d. Ack round-trip
      - Mock Agent sends { type: 'ack', jobId: 'test-1', ok: true }
      - ackHandler is invoked (assert via spy)

   e. Event handling
      - Mock Agent sends { type: 'event', eventType: 'session_start', jobId: 'test-1' }
      - eventHandler is invoked

   f. Heartbeat timeout
      - Connect, then stop sending messages
      - Fast-forward timers (vi.useFakeTimers) past HEARTBEAT_TIMEOUT_MS
      - Assert connection closes, isAgentOnline() returns false

   g. Nack ack resets booth
      - Mock Agent sends { type: 'ack', jobId: 'test-1', ok: false, errorMessage: 'camera busy' }
      - Assert stall_reason set, booth state = IDLE

2. Run npx vitest run test/phase3-ws.test.ts and all tests pass.

## Read First

- test/ directory (create if missing)
- package.json (test scripts)
- src/agent/agentServer.ts (full implementation after Plan 05)

## Acceptance Criteria

- [ ] All 7 test cases pass
- [ ] npx vitest run exits 0
- [ ] No external network or service dependencies needed for tests
