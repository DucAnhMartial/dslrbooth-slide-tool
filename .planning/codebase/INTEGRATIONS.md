# Integrations

*Mapped: 2026-08-10.*

## Inputs

- `mirror-request/src/ingestion/mirrorReceiver.ts`: `POST /on-register`; IP allow-list, required `id` and `name`, idempotent local enqueue.
- `mirror-request/src/ingestion/dbPoller.ts`: optional MySQL polling of `registrations`, using `DB_*` settings and a SQLite cursor.

## Booth integration

- `dslrbooth-agent/src/dslrbooth/client.ts` calls dslrBooth's loopback HTTP API at `127.0.0.1:<port>/api/start`.
- `dslrbooth-agent/src/triggers/server.ts` accepts `GET /dslrbooth-event` and offers `/health`, `/display`, and `/display-state`.
- The agent connects to the central `/agent` WebSocket using `EXTENSION_SERVICE_WS_URL` and `EXTENSION_SERVICE_WS_TOKEN`.

## Real-time interfaces

- `mirror-request/src/agent/agentServer.ts` authenticates agent WebSockets at `/agent`, carrying commands, ACKs, events and heartbeats.
- `mirror-request/src/display/displayServer.ts` broadcasts unauthenticated queue snapshots at `/display` every 250 ms.
- `mirror-request/src/index.ts` serves central HTML display at `/display-screen` and JSON status at `/status/:jobId`.

## Notification and slideshow

- `mirror-request/src/notifications/notificationService.ts` POSTs a photo payload to `NOTIFY_WEBHOOK_URL`, with retries.
- `web-slide/server.js` accepts JSON at `POST /webhook/json` and multipart at `POST /webhook`, then streams updates through SSE `GET /events`.
- Slideshow data is retained in memory (maximum 50); uploaded images are written below `web-slide/uploads/`.

## Trust boundaries

- Agent WS uses a query-string token.
- Registration ingestion uses source-IP filtering, not a signature.
- The slideshow enables global CORS and currently has no access control.
