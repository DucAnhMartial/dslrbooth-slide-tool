# Research: Phase 1 — Foundation & Registration Ingestion

**Gathered:** 2026-07-24
**Status:** Research complete

## Summary of Existing Codebase

Phase 1 scaffold exists with meaningful implementations. Key findings:

### Solid ✅
- `src/config.ts` — Full env config with validation and defaults
- `src/types.ts` — Comprehensive types for all phases
- `src/logging/logger.ts` — Winston + daily rotation + PII masking
- `src/state/localStore.ts` — SQLite WAL mode, bootstrap, singleton

### Gaps in Scaffold
- `src/index.ts` — Loaded from different project (auth, user, admin routes)
- `src/ingestion/mirrorReceiver.ts` — Imports non-existent QueueManager, no IP whitelist
- `src/ingestion/dbPoller.ts` — Duplicate type definition, stub DB rows, no DB connection
- `src/state/localStore.ts` — Missing `raw_payload` column, stub methods for cursor, booth state

## Plans for Phase 1

1. **Rewrite index.ts** — Create fresh Extension Service Express app with /on-register route
2. **Fix localStore.ts** — Add raw_payload column, implement cursor/booth_state stubs properly
3. **Fix mirrorReceiver.ts** — Remove QueueManager dependency, add IP whitelist middleware
4. **Fix dbPoller.ts** — Remove duplicate type, use { Client } from 'pg' for real DB queries
5. **Create src/server.ts** — Bootstrap: create SQLite tables on startup, start HTTP server
6. **Add PII masking** — EntryAlready processed (isProcessed) — skip
- Enqueue to SQLite queue_job
- Return 200 immediately (do NOT wait for DB poller)

IDEMPOTENCY:
- Check processed_ids table before processing

DB POLLING (separate file, runs on interval):
- SELECT FROM registrations WHERE registered_at > last_cursor ORDER BY registered_at ASC LIMIT batch_size
- For each new row: check processed_ids, upsertRegistration, markProcessed, enqueue, update cursor
- Error handling: catch + log + retry next cycle

## Key Gotchas

1. **better-sqlite3 is synchronous** — No await in dbPoller calls to store
2. **WAL mode** — Required for concurrent reads during writes; already set
3. **Node.js event loop** — dbPoller uses setInterval with void this.poll() to avoid unhandled rejection
4. **IP allowlist** — Check req.ip (Express fills from X-Forwarded-For in proxy mode), compare against whitelist array
5. **PII masking** — logger already has mask() function, use it for all registration data in logs
6. **No QueueManager yet** — Phase 1 only needs SQLite queue_job insertion, not in-memory queue

## Files to Create/Modify

**Create:**
- server.ts (app bootstrap)

**Modify:**
- src/index.ts (rewrite)
- src/state/localStore.ts (add raw_payload, fix stubs)
- src/ingestion/mirrorReceiver.ts (IP whitelist, remove QueueManager dep)
- src/ingestion/dbPoller.ts (fix type conflict, wire real DB)
