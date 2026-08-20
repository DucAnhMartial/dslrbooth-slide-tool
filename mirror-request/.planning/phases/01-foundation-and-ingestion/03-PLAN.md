---
plan: 3
phase: 1
wave: 2
title: Add IP whitelist and raw_payload to mirrorReceiver
requirements: [ING-01, AUTH-02]
depends_on: [Plan 01, Plan 02]
files_modified:
  - src/ingestion/mirrorReceiver.ts
autonomous: true
---

## Objective

Add IP allowlist enforcement to /on-register and store the raw registration payload in SQLite.

## Action

1. Edit `src/ingestion/mirrorReceiver.ts`:
   - Remove QueueManager import and parameter from createMirrorReceiver
   - Add LocalStore import
   - Add IP whitelist middleware or inline check:
     - Read PROXY_IP_WHITELIST from getConfig()
     - Compare req.ip or req.connection.remoteAddress against whitelist
     - If not matched: return 403 immediately — do NOT process
   - Store raw JSON payload: after registering the parsed Registration, also call a new `store.saveRawPayload(registration.id, JSON.stringify(req.body))`
   - Keep the 200 immediate return pattern
   - Log using `labelLogger('mirror')` — call `mask()` if logging the raw body

2. In `src/state/localStore.ts` (if not done in Plan 01):
   - Add `saveRawPayload(id, json)` method: INSERT OR REPLACE into registration raw_payload
   - The registration table must have `raw_payload TEXT` column (Plan 01)

## Read First
- `src/ingestion/mirrorReceiver.ts`
- `src/state/localStore.ts`
- `src/config.ts` (PROXY_IP_WHITELIST)
- `src/logging/logger.ts` (mask, labelLogger)

## Acceptance Criteria
- [ ] Request from non-whitelisted IP returns 403
- [ ] Request from whitelisted IP returns 200 with `{ accepted: true, jobId }`
- [ ] Duplicate registration ID returns 200 with `{ duplicate: true, jobId }`
- [ ] raw_payload column is populated in SQLite with the full request body JSON
- [ ] Logger output masks email and phone numbers
- [ ] Typecheck passes: `npx tsc --noEmit` exits 0
