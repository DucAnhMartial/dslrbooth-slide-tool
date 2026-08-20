# Technology Stack

*Mapped: 2026-08-10. Scope: all three deployable applications in this workspace.*

## Overview

This photobooth system has three Node.js services: `mirror-request` is the central extension service, `dslrbooth-agent` is the Windows-side relay, and `web-slide` receives and presents photos.

## Runtime and language

- Node.js 20.x: `mirror-request/package.json`; Node 18+: `web-slide/package.json`.
- TypeScript ES2022 with strict type checking: `mirror-request/tsconfig.json` and `dslrbooth-agent/tsconfig.json`.
- `mirror-request` uses Node `node20` modules; `dslrbooth-agent` compiles to CommonJS.
- `web-slide/server.js` and `web-slide/index.html` use plain JavaScript/HTML/CSS.

## Dependencies by service

| Service | Core packages | Role |
| --- | --- | --- |
| `mirror-request` | Express, `ws`, `better-sqlite3`, `mysql2`, Winston | orchestration, local queue, optional DB polling, logging |
| `dslrbooth-agent` | Express, `ws`, Winston, `node-windows` | relay, local API bridge, Windows service |
| `web-slide` | Express, CORS, Multer | webhook receiver, uploads, SSE slideshow |

`mirror-request/package.json` also has PostgreSQL, email and SMS-era dependencies/configuration, but the active source uses MySQL, SQLite and an HTTP webhook.

## Build and operations

- `mirror-request`: `npm run build`, `npm test` (Vitest), output in `dist/`.
- `dslrbooth-agent`: `npm run build`; `npm run build:exe` produces a Windows executable with `pkg`; its service script is `service/install-service.js`.
- `web-slide`: `npm start` runs `server.js`.

## Configuration and data

- Services load local `.env` files through `dotenv`; examples are kept alongside source.
- `mirror-request/src/config.ts` validates agent token and DB password at startup.
- `mirror-request/src/state/localStore.ts` uses SQLite WAL mode (default `data/extension-service.sqlite`) for registrations, queue, cursors, notification records and booth state.
- `dist/`, logs, SQLite files, executable and `web-slide/uploads/` are generated or mutable runtime data.
