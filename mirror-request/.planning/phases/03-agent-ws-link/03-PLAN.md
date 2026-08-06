---
plan: 3
phase: 3
wave: 1
title: Receive and process Agent ack and lifecycle events
requirements: [AGT-03, AGT-04]
depends_on: [Plan 01, Plan 02]
files_modified:
  - src/agent/agentServer.ts
new_files: []
autonomous: true
---

## Objective

Handle incoming messages from Agent: `ack` messages that confirm or reject a dispatch, and `event` messages that signal booth state transitions (session_start through session_end).

## Action

1. Edit `src/agent/agentServer.ts` — extend the message handler set up in Plan 02:

   On each incoming WS message:
   - Parse JSON → validate against a discriminated union
   - If `type === 'ack'`: call `this.ackHandler({ jobId, ok, errorMessage })`
   - If `type === 'event'`: forward to `this.eventHandler({ eventType, payload, jobId })`

2. Define handler callbacks in the constructor (default = no-op, wired by Phase 2 QueueService in Plan 04):

   ```
   ackHandler: (msg: { jobId: string; ok: boolean; errorMessage?: string }) => void
   eventHandler: (msg: { eventType: string; jobId?: string; payload?: Record<string, unknown> }) => void
   ```

3. Wire in `package.json` for the `ws` type if not present: install `@types/ws`.

## Read First

- `src/agent/agentServer.ts` (Plans 01-02)
- `src/types.ts` (AgentMessage type)

## Acceptance Criteria

- [ ] AgentServer parses incoming messages and dispatches to ackHandler or eventHandler
- [ ] An `{ type: 'ack', jobId: 'x', ok: true }` message invokes ackHandler with correct params
- [ ] An `{ type: 'event', eventType: 'session_start', jobId: 'x' }` invokes eventHandler
- [ ] Malformed JSON logs error but does not crash the WS connection
- [ ] `npx tsc --noEmit` exits 0
