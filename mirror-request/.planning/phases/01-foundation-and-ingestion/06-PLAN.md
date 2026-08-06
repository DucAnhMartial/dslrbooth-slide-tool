---
plan: 6
phase: 1
wave: 3
title: Verify all Phase 1 requirements pass
requirements: [ING-01, ING-02, ING-03, STO-01, AUTH-02]
depends_on: [Plan 05]
files_modified: []
autonomous: true
---

## Objective

Confirm the server starts, ENDPOINTS respond correctly, SQLite schema is correct, and the DB poller runs without errors.

## Action

Execute the following verification sequence and log results:

1. `npx tsc --noEmit` — must exit 0
2. `npm run dev` in background — must print "Extension Service ready on port"
3. Send POST request to localhost:3002/on-register with valid body and X-Forwarded-For from whitelist:
   - Expect HTTP 200 with `{ accepted: true, jobId: "<id>" }`
   - Query SQLite: `SELECT * FROM registration WHERE id = '<id>'` — must have raw_payload
4. Send POST to /on-register with same duplicate id from non-whitelisted IP (or no header):
   - Expect HTTP 403
5. Send POST to /on-register with duplicate id from whitelisted IP:
   - Expect HTTP 200 with `{ duplicate: true, jobId: "<id>" }`
6. Insert a row directly in the backend DB with registered_at in the future, start the server:
   - Wait for next DB poll cycle (configurable, e.g. 3s)
   - Verify row was ingested: query SQLite registration table
7. Shutdown: kill process — verify graceful shutdown log appears

## Read First
- `src/index.ts`
- `src/ingestion/mirrorReceiver.ts`
- `src/ingestion/dbPoller.ts`
- `src/state/localStore.ts`
- `.env` (current values)

## Acceptance Criteria
- [ ] Typecheck passes (exit 0)
- [ ] Server starts cleanly on configured port
- [ ] Whitelisted POST returns 200 with accepted:true
- [ ] Non-whitelisted POST returns 403
- [ ] Duplicate id returns 200 with duplicate:true
- [ ] raw_payload is stored in SQLite
- [ ] DB poller ingests new backend records without errors
- [ ] Graceful shutdown on SIGTERM completes within 1 second
- [ ] All Phase 1 requirements (ING-01, ING-02, ING-03, STO-01, AUTH-02) are satisfied
