---
plan: 5
phase: 1
wave: 3
title: Create server.ts bootstrap for startup and lifecycle
requirements: [ING-01, ING-02, STO-01, AUTH-02]
depends_on: [Plan 01, Plan 02, Plan 03, Plan 04]
files_modified:
  - src/index.ts
  - src/state/localStore.ts
autonomous: true
---

## Objective

Ensure the server starts reliably, SQLite schema is complete on first run, and the process shuts down cleanly.

## Action

1. In `src/index.ts`:
   - Import `getStore`, `getConfig` at the top (not inside handlers)
   - On server `listen()` callback: log "Extension Service ready on port {PORT}" via `labelLogger('server')`
   - Add SIGTERM and SIGINT handlers:
     - Stop DB poller
     - Close SQLite store
     - Log shutdown via `labelLogger('server').info('Shutting down')`
     - `process.exit(0)` after 500ms grace period

2. In `src/state/localStore.ts`:
   - In `bootstrap()`, add `raw_payload TEXT` to the registration table
   - Add `booth_state` table (already in Plan 01, verify it's there)
   - Add `processed_id` table (already exists, verify)
   - Ensure WAL mode is set: `this.db.pragma('journal_mode = WAL')`
   - Add `saveRawPayload(id, json)` method: INSERT OR REPLACE into registration SET raw_payload = ?

## Read First
- `src/index.ts`
- `src/state/localStore.ts`
- `src/config.ts`

## Acceptance Criteria
- [ ] `npm run dev` starts the server without errors
- [ ] SQLite file is created at path from LOCAL_STORE_PATH
- [ ] registration table has: id, name, email, phone, mode, registered_at, raw_payload
- [ ] booth_state table exists with DEFAULT 'IDLE'
- [ ] processed_id unique constraint on reg_id
- [ ] SIGTERM triggers clean shutdown: poller stops, store closes, process exits
- [ ] Typecheck passes: `npx tsc --noEmit` exits 0
