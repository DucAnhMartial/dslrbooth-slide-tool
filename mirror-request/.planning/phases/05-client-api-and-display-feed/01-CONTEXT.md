# Phase 5: Client API & Display Feed

## Mục tiêu
Expose GET /status/:jobId cho khách và WS /display feed cho màn hình booth.

## Design
- REST endpoint đọc từ LocalStore (masked)
- WS display feed broadcast snapshot khi state thay đổi
- Depends on Phase 2 (queue) + Phase 3 (agent status)

## Plan summary
1. GET /status/:jobId
2. WS /display feed
3. Smoke test
