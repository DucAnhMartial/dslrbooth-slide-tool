# Phase 1: Foundation & Registration Ingestion - Context

**Gathered:** 2025-07-21
**Status:** Ready for planning

## Phase Boundary

Xây dựng lớp ingestion cơ bản:
- Nhận đăng ký qua POST /on-register (mirror từ reverse proxy)
- DB polling định kỳ (read-only fallback)
- Persist state vào SQLite để survive qua restart
- Enforce IP whitelist cho /on-register

Không bao gồm: queue logic chi tiết, state machine IDLE/BUSY, Agent WS link, notification, client API.

## Implementation Decisions

### Registration Payload
- Lưu raw JSON payload trong SQLite (field raw_payload TEXT) để debug/retrospect
- Không parse ngay lúc ingestion — parsed khi cần (file_upload, status check)
- Schema: id (TEXT PK), name, email, phone, mode, qr_token, registered_at, source, raw_payload, created_at, updated_at

### Idempotency
- processed_ids table lưu tập hợp registration IDs đã xử lý
- Check processed_ids trước khi enqueue — nếu đã có → skip

### DB Polling
- Tần suất: 3 giây (configurable qua DB_POLL_INTERVAL_MS)
- Batch size: 50 records/poll (configurable)
- Query: SELECT ... WHERE registered_at > :cursor ORDER BY registered_at ASC LIMIT :batch_size
- Cursor lưu trong SQLite db_cursor table
- Error handling: retry 3 lần exponential backoff, rồi log warning và skip cycle

### Booth State After Restart
- Khi service restart → booth state = IDLE (safe default)
- Queue được rebuild từ SQLite queue_jobs table (jobs có status = 'queued')
- Jobs đang processing (BUSY) khi crash → mark là 'stalled' để admin review

### IP Whitelist
- Source: .env variable PROXY_IP_WHITELIST (comma-separated)
- Format: comma-separated IPs, hỗ trợ CIDR notation
- Reject ngay với 403 nếu IP không match — không fallback mode

### Clarity Guards
- Đã xác định: không parse registration payload ngay lúc ingestion
- Không có fallback mode cho IP whitelist — reject là reject
- Booth state sau restart luôn là IDLE (safe default)

## Specific Ideas

- Dùng raw JSON để preserve nguyên vẹn data từ backend
- Booth state = IDLE sau restart để tránh deadlock

## Deferred

- Parse structured schema vào Phase 2-3 khi cần validate specific fields
- Automatic retry mechanism cho notification — Phase 4

---
*Context for Phase 01-foundation-and-ingestion*
