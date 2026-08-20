# Architecture

*Mapped: 2026-08-10.*

## System topology

```text
Registration webhook / MySQL
            |
            v
 mirror-request (Express + SQLite queue)
     | WebSocket /agent       | photo webhook
     v                        v
dslrbooth-agent           web-slide (SSE)
     |
     v
dslrBooth local HTTP API + trigger callbacks
```

## Central control flow

1. `mirror-request/src/index.ts` composes Express, store, ingestion, queue, agent server, notifier and display server.
2. Ingestion persists registrations and queued jobs via `src/state/localStore.ts`.
3. `src/queue/queueService.ts` announces the next guest for 5–10 seconds, dispatches `start_session`, records ACKs/events and resets timed-out jobs.
4. A `file_upload` event starts photo-webhook delivery.

## Agent flow

- `dslrbooth-agent/src/index.ts` wires config, logger, WS connection, dslrBooth client and trigger server.
- `src/websocket/connection.ts` provides reconnect backoff and 15-second heartbeats.
- A `start_session` command calls the local booth then returns an ACK; local trigger events are forwarded with the active job ID.

## Displays

- Central display: `mirror-request/src/display/displayServer.ts` sends queue snapshots by WebSocket.
- Agent display: the agent serves a polling next-guest page.
- Photo slideshow: `web-slide` is an independent Express/SSE application.

Each main service owns startup/shutdown in its entry point. The central service closes timers, SQLite and servers; the agent disconnects WS and closes its trigger server; the slideshow has no explicit graceful-shutdown handler.
