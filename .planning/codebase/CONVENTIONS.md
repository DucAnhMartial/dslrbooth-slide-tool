# Conventions

*Mapped: 2026-08-10.*

## Code style

- TypeScript projects are strict and produce declarations/source maps.
- Classes and factory functions are the dominant public API: `QueueService`, `WsConnection`, `createQueueService`, and `createTriggerServer`.
- Shared central-service contracts are interfaces in `mirror-request/src/types.ts`; use type-only imports when suitable.
- Central service uses semicolons; the agent is semicolon-free. Preserve each service's established style.

## Architecture conventions

- Entry points construct concrete dependencies and bind callbacks, as in `mirror-request/src/index.ts` and `dslrbooth-agent/src/index.ts`.
- `QueueService` accepts injected agent/notification adapters through factory bindings, providing test seams.
- Prefer typed configuration in `config.ts`; a few queue timings still read environment variables directly.
- Persist central state only through `LocalStore` and its SQLite prepared statements.

## Errors, logging and protocols

- Configuration failures stop startup; poller, webhook, and WS failures are logged and generally recover/retry.
- Agent triggers return 200 even on errors because dslrBooth expects no retry; see `dslrbooth-agent/src/triggers/server.ts`.
- Winston is normal service logging, but `queueService.ts` currently wraps `console`.
- WS messages are discriminated by `type` (`command`, `ack`, `event`, `heartbeat`, `announcement`) with manual runtime checks.

## HTTP behavior

- Express handlers generally return JSON validation/auth errors.
- Webhook payloads are normalized at the boundary before being inserted into queue or slideshow state.
