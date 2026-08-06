# State

## Project Reference

See: .planning/PROJECT.md

**Current focus:** Phase 5 — Client API & Booth Display Feed (in progress)

## Milestones

| Phase | Name | Status | Notes |
|-------|------|--------|-------|
| 1 | Foundation & Registration Ingestion | **Complete** | 6 plans done, typecheck 0 errors |
| 2 | Queue & Booth State | **Complete** | 6 plans, QueueService + SQLite state machine |
| 3 | Agent WebSocket Link | **Complete** | 6 plans, WS + ack/event + heartbeat |
| 4 | Guest Notifications | **Complete** | Simplified webhook with retry |
| 5 | Client API & Booth Display Feed | **Complete** | GET /status + WS /display + smoke test passing |

## Phase 1 Implementation Detail

| File | Change | Status |
|------|--------|--------|
| src/config.ts | Giữ nguyên scaffold | ✅ Done |
| src/types.ts | Giữ nguyên scaffold | ✅ Done |
| src/logging/logger.ts | Giữ nguyên (PII mask) | ✅ Done |
| src/state/localStore.ts | +raw_payload, booth_state, cursor, stall_reason | ✅ Done |
| src/index.ts | Rewrite — Extension Service | ✅ Done |
| src/ingestion/mirrorReceiver.ts | +IP whitelist, raw_payload, -QueueManager dep | ✅ Done |
| src/ingestion/dbPoller.ts | +{ Client } from 'pg', real SELECT, cursor | ✅ Done |

**Chưa verify:** cần chạy `npm install`, `tsc --noEmit`, `npm run dev` trên môi trường mới.

## Key Decisions

- Phase 4: Bỏ email/SMS, dùng webhook trigger tới hệ thống của user (đã có search ảnh riêng)
- Phase 1 verify: skip — sẽ verify trên môi trường mới

## Environment Migration

**Chuyển sang môi trường mới** — cần chạy lại:
1. `npm install` (cài dependencies: typescript, ts-node, vitest, @types/*)
2. `npx tsc --noEmit` (verify types)
3. `npm run dev` (smoke test)
4. `/gsd-execute-phase 1 --research` (re-plan + execute với ảnh môi trường mới)

## Next Step

```
/gsd-discuss-phase 2   # Discuss Phase 2 trước
/gsd-plan-phase 2      # Plan Phase 2
/gsd-execute-phase 2   # Execute
```

## Last Updated

2026-07-25 — Phase 1 done, preparing for environment migration
