# Testing

*Mapped: 2026-08-10.*

## Test runner

`mirror-request` is the only service with an automated test command. `npm test` runs Vitest using `mirror-request/vitest.config.ts`, discovering `*.test.*` and `*.spec.*` files in `src/` and `test/`.

## Existing tests

- `mirror-request/test/queue-countdown.test.ts` — queue announcement/countdown behavior.
- `mirror-request/test/agent-websocket.test.ts` — agent WebSocket behavior.
- `mirror-request/test/phase5-display.test.ts` — display WebSocket snapshots.
- `mirror-request/test/notification-service.test.ts` — notification service.
- `mirror-request/test/notification-webhook.test.ts` — webhook payload/delivery.

The central service's factory callbacks make queue behavior testable without launching an entire live deployment; notification tests mock the HTTP boundary.

## Coverage gaps

- `dslrbooth-agent/package.json` has no test script or test directory.
- `web-slide/package.json` has no test script or test directory.
- No coverage threshold or CI workflow was found at workspace level.
- End-to-end coverage is still needed for MySQL polling, dslrBooth HTTP, authenticated agent connectivity and photo-to-slide delivery.

## Recommended direction

Add unit tests around external adapters using mocks (MySQL, dslrBooth HTTP, WebSocket, filesystem), then add a small smoke suite for real local infrastructure.
