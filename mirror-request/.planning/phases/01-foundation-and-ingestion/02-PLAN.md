---
plan: 2
phase: 1
wave: 1
title: Rewrite src/index.ts as Extension Service entry point
requirements: [ING-01]
depends_on: [Plan 01]
files_modified:
  - src/index.ts
autonomous: true
---

## Objective

Replace the scaffold index.ts (which imports auth/admin routes from a different project) with a clean Extension Service Express app that serves POST /on-register and wires the HTTP server.

## Action

1. Delete all existing route imports (auth, user, admin, extension)
2. Import `getConfig`, `labelLogger` from config and logger
3. Import `createMirrorReceiver` from ingestion/mirrorReceiver
4. Import `DBPoller` from ingestion/dbPoller  
5. Create Express app:
   - `express.json()` body parser (required for POST /on-register payload)
   - Mount `/on-register` router from createMirrorReceiver
6. Create server via `createServer(app, config.PORT)`
7. Start DB poller on server ready (pass a QueueManager stub or direct store access — Phase 1 uses store directly, no QueueManager yet)
8. Graceful shutdown: close DB poller, close SQLite store on SIGTERM/SIGINT

## Read First
- `src/index.ts` (current broken state)
- `src/ingestion/mirrorReceiver.ts` (import path)
- `src/ingestion/dbPoller.ts` (import path)
- `src/state/localStore.ts` (import path)
- `src/config.ts` (getConfig, EnvConfig)

## Acceptance Criteria
- [ ] `src/index.ts` does NOT import auth, user, or admin routes
- [ ] POST /on-register is mounted on `/on-register` path
- [ ] `npm run dev` starts server without errors
- [ ] Server listens on PORT from .env (default 3002)
- [ ] Graceful shutdown closes poller and store on SIGTERM
- [ ] Typecheck passes: `npx tsc --noEmit` exits 0
