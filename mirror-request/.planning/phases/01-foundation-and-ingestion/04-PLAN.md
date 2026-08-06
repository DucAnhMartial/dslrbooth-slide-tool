---
plan: 4
phase: 1
wave: 2
title: Wire real DB polling with cursor persistence
requirements: [ING-02, ING-03]
depends_on: [Plan 01, Plan 02]
files_modified:
  - src/ingestion/dbPoller.ts
autonomous: true
---

## Objective

Replace the stub DB query in dbPoller.ts with a real read-only SELECT using the 'pg' library using the DB credentials from config, and persist the polling cursor in SQLite.

## Action

1. Edit `src/ingestion/dbPoller.ts`:
   - Remove the local `export interface DBPollCursor` — use `DBPollCursor` from `../types` instead
   - Import `Client` from 'pg'
   - In constructor, also create a `{ Client }` instance using config (DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD)
   - On `start()`: connect the client before starting the interval
   - In `poll()`:
     - Query the local store for the last cursor value via `store.getCursor('registrations')`
     - Build SQL: `SELECT id, name, email, phone, mode, registered_at FROM registrations WHERE registered_at > $1 ORDER BY registered_at ASC LIMIT $2`
     - Execute with parameters: cursor as $1, batchSize as $2
     - For each row: if `store.isProcessed(id)` → skip, else `upsertRegistration`, `markProcessed(id)`, log masked row
     - After processing all rows: `store.setCursor('registrations', lastRow.registered_at)`
   - Error handling: catch errors in poll(), log via `labelLogger('dbpoller')`, do NOT crash — next cycle will retry
   - `stop()`: disconnect the { Client }

2. In `src/index.ts`:
   - Instantiate DBPoller: `new DBPoller(config.DB_POLL_INTERVAL_MS, config.DB_POLL_BATCH_SIZE)`
   - Call `poller.start()` after SQLite store is initialized

## Read First
- `src/ingestion/dbPoller.ts` (current stub)
- `src/ingestion/mirrorReceiver.ts` (pattern for store and logger usage)
- `src/state/localStore.ts` (getCursor, setCursor, isProcessed, markProcessed)
- `src/config.ts` (DB_* env vars)

## Acceptance Criteria
- [ ] Duplicate DBPollCursor type definition is removed; uses type from src/types.ts
- [ ] Poller connects to the real DB using config credentials
- [ ] SELECT query filters by cursor, orders by registered_at ASC, limits to batchSize
- [ ] Each new row is upserted to SQLite, marked processed, and logged (masked)
- [ ] Cursor is persisted in SQLite after each poll cycle
- [ ] Errors in poll() are caught and logged — service stays running
- [ ] `npm run dev` starts, DB poller runs without errors
- [ ] Typecheck passes: `npx tsc --noEmit` exits 0
