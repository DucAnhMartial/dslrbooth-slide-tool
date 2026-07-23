# Research Summary: Extension Service

## Stack
- Node.js 20 LTS + TypeScript strict
- express (HTTP), ws (WebSocket), better-sqlite3 (local store)
- winston + daily-rotate-file (logging)
- dotenv (config), vitest (testing)
- PM2/Docker (deployment)

## Table Stakes
- POST /on-register (200 OK, async)
- DB polling (read-only, cursor-based)
- SQLite local state (persist across restarts)
- Idempotency (record-id based)
- IP whitelist
- In-memory FIFO queue (1 booth)
- IDLE/BUSY state machine with 5min timeout
- Agent WS link (auth token, heartbeat)
- Command dispatch + ack/event handling
- Guest notification (email/SMS, retry)
- GET /status/:jobId
- Display feed (WS/SSE realtime)

## Differentiators
- Booth display WS/SSE feed (separate from Agent WS)
- DB polling fallback (no missed registrations)
- Safety timeout recovery

## Anti-Features
- Writing to real backend DB (read-only only)
- Calling dslrBooth API directly
- Multi-booth, distributed queue, complex UI

## Watch Out For
- Agent WS disconnect: don't auto-dispatch, use timeout
- Mirror proxy drops: DB polling fallback
- Email/SMS outage: bounded retry + manual fallback
- SQLite corruption: WAL mode, backup
- Memory leaks: clean event listeners

## Build Order
1. Foundation: config, logger, localStore schema
2. Ingestion: mirrorReceiver + dbPoller
3. Queue: queueManager + boothStateMachine
4. Agent link: wsServer + commandDispatcher
5. Notification: sendPhotoToGuest
6. Client API: statusEndpoint + displayFeed
7. Wire in index.ts
