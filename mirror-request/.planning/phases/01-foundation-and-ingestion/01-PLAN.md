---
plan: 1
phase: 1
wave: 1
title: Fix SQLite schema in localStore.ts
requirements: [STO-01]
depends_on: []
files_modified:
  - src/state/localStore.ts
autonomous: true
---

## Objective

Add `raw_payload` column to the registration table, fix stub methods for cursor and booth state so ingestion paths have working primitives.

## Action

1. Edit `src/state/localStore.ts` — bootstrap SQL:
   - Add `raw_payload TEXT` column to the `registration` CREATE TABLE statement
   - Add `stall_reason TEXT` to `queue_job` for the timeout-reset flow (Phase 1 stores the stall reason)

2. Edit `upsertRegistration(r: Registration)`:
   - Change signature to `upsertRegistration(r: Registration & { raw_payload?: string })`
   - INSERT OR REPLACE statement must include the `raw_payload` column

3. Implement `getCursor(pollKey)`:
   - Query `db_poll_cursor WHERE poll_key = ?`, return `last_value` or undefined

4. Implement `setCursor(pollKey, value)`:
   - INSERT OR REPLACE into `db_poll_cursor` with poll_key, last_value = value, updated_at = now

5. Implement `getBoothState()`:
   - Query `booth_state` table, return 'IDLE' if no row exists (safe default from CONTEXT.md)

6. Implement `setBoothState(state)`:
   - INSERT OR REPLACE into `booth_state` table

7. Add `booth_state` table to bootstrap:
   ```sql
   CREATE TABLE IF NOT EXISTS booth_state (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     state TEXT NOT NULL DEFAULT 'IDLE',
     updated_at TEXT NOT NULL DEFAULT 'now'
   )
   ```

## Read First
- `src/state/localStore.ts` (current state)
- `src/types.ts` (Registration, QueueJob, BoothState, DBPollCursor types)

## Acceptance Criteria
- [ ] `src/state/localStore.ts` has `raw_payload TEXT` in the registration CREATE TABLE
- [ ] `getCursor()` returns a string or undefined (not undefined stub)
- [ ] `setCursor()` writes to the db_poll_cursor table
- [ ] `getBoothState()` returns 'IDLE' when table is empty
- [ ] `setBoothState('BUSY')` persists and `getBoothState()` returns 'BUSY'
- [ ] `booth_state` table exists with `state TEXT NOT NULL DEFAULT 'IDLE'`
- [ ] Typecheck passes: `npx tsc --noEmit` exits 0
