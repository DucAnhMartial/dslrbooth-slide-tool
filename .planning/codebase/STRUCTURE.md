# Project Structure

*Mapped: 2026-08-10.*

## Workspace layout

```text
.
├── mirror-request/     central extension service (TypeScript; Git repository)
├── dslrbooth-agent/    Windows local relay (TypeScript)
├── web-slide/          webhook slideshow (JavaScript)
└── .planning/          workspace-level planning and codebase map
```

## Central service: `mirror-request/`

- `src/index.ts` — composition root and HTTP lifecycle.
- `src/config.ts`, `src/types.ts` — configuration and shared contracts.
- `src/ingestion/` — registration webhook and MySQL polling.
- `src/state/localStore.ts` — SQLite schema, data access, idempotency and booth state.
- `src/queue/queueService.ts` — queue state machine and agent bindings.
- `src/agent/agentServer.ts` — authenticated agent WebSocket endpoint.
- `src/display/` — central display WS and HTML page.
- `src/notifications/` — photo webhook delivery.
- `test/` — Vitest tests; `data/`, `logs/`, `dist/` are runtime/generated.

## Windows agent: `dslrbooth-agent/`

- `src/index.ts` — composition root.
- `src/websocket/` — central connection/reconnection.
- `src/dslrbooth/` — local API adapter.
- `src/triggers/` — trigger endpoint and local display.
- `src/display/`, `src/health/`, `src/logging/` — support modules.
- `service/install-service.js` — Windows service installation.
- `dist/`, `logs/`, `dslrbooth-agent.exe` — deployed/generated artifacts.

## Slideshow: `web-slide/`

- `server.js` — Express API, upload handling and SSE broker.
- `index.html` — slideshow UI.
- `uploads/` — stored received images.
- `webhook-json.log` — mutable debug log.

Folders are lowercase; TypeScript modules mainly use camelCase filenames and a feature-oriented folder layout.
