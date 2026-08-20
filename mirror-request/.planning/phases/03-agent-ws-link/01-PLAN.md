---
plan: 1
phase: 3
wave: 1
title: WebSocket server with token authentication
requirements: [AGT-01, AUTH-01]
depends_on: []
files_modified: []
new_files:
  - src/agent/agentServer.ts
autonomous: true
---

## Objective

Create a WS server that accepts a single Agent connection, rejecting any client that does not present the correct token in the opening handshake.

## Action

1. Create `src/agent/agentServer.ts`:

   ```
   export class AgentServer {
     - wss: WebSocket.Server
     - agentConn: AgentConnection | null
     - config: EnvConfig
     - logger: Logger

     constructor(server: http.Server, config, logger)
     start(port: number): void
     stop(): void
     isAgentOnline(): boolean
     getAgentConnection(): AgentConnection | null
   }
   ```

2. WS handshake:
   - Attach to a new HTTP server (or the same Express server via `app.listen` returning http.Server)
   - On `connection`, read `sec-websocket-protocol` header or first message for token
   - If token !== `config.AGENT_WS_TOKEN`, close immediately with code 4001 ("unauthorized")
   - If valid, store connection in `agentConn`, log "Agent connected"

3. On disconnect, set `agentConn = null`, log "Agent disconnected"

4. Validate that `AGENT_WS_TOKEN` env is not the placeholder value (already done in config.ts `required()`)

## Read First

- `src/config.ts` (AGENT_WS_TOKEN validation)
- `src/types.ts` (AgentConnection type)

## Acceptance Criteria

- [ ] AgentServer class exists in `src/agent/agentServer.ts`
- [ ] `start()` creates a WS endpoint and listens on a configurable port
- [ ] Connection without valid token is rejected (close code 4001)
- [ ] `isAgentOnline()` returns true when Agent is connected
- [ ] On disconnect, `agentConn` is nulled and logged
- [ ] `npx tsc --noEmit` exits 0
