# Requirements: Extension Service

**Defined:** 2025-07-21
**Core Value:** Moi khach dang ky deu duoc phuc vu dung thu tu, khong bo lo dang ky nao, va nhan duoc anh ket qua tu dong

## v1 Requirements

### Authentication & Security
- [ ] **AUTH-01**: Agent phải xác thực qua token/API key khi kết nối WebSocket
- [ ] **AUTH-02**: Endpoint /on-register chỉ chấp nhận request từ IP reverse proxy
- [ ] **AUTH-03**: Thông tin nhạy cảm (email, SĐT) được mask một phần trong log

### Ingestion
- [ ] **ING-01**: Hệ thống nhận đăng ký qua POST /on-register (mirror từ proxy), trả 200 ngay, xử lý async
- [ ] **ING-02**: Hệ thống đọc DB read-only (SELECT) định kỳ để bắt đăng ký bị miss
- [ ] **ING-03**: Cursor DB polling được lưu trong local state store, không ghi ngược DB thật

### Queue & Booth State
- [ ] **QUE-01**: Queue toàn cục (FIFO) — đúng thứ tự đăng ký
- [ ] **QUE-02**: Idempotency — không xử lý trùng đăng ký đã qua (dựa vào record id)
- [ ] **QUE-03**: Khi booth IDLE và queue có job → dispatch job đầu tiên gửi start_session xuống Agent
- [ ] **QUE-04**: Nhận session_end → booth IDLE → tự động dispatch job tiếp theo
- [ ] **BTH-01**: State machine quản lý trạng thái IDLE/BUSY
- [ ] **BTH-02**: Timeout an toàn — nếu BUSY > 5 phút không nhận session_end, tự động reset IDLE + log warning

### Agent Communication (WebSocket)
- [ ] **AGT-01**: WS server chấp nhận Agent duy nhất kết nối vào (xác thực token)
- [ ] **AGT-02**: Gửi lệnh {type: "command", action: "start_session", jobId, mode} khi dispatch
- [ ] **AGT-03**: Nhận ack {jobId, ok, errorMessage} từ Agent sau khi gọi API
- [ ] **AGT-04**: Nhận event từ Agent (session_start, countdown_start, countdown, capture_start, file_download, processing_start, sharing_screen, file_upload, printing, session_end)
- [ ] **AGT-05**: Theo dõi heartbeat — nếu > 30s không nhận, đánh dấu Agent offline

### Guest Notification
- [ ] **NOT-01**: Nhận file_upload → tra jobId → tìm thông tin liên hệ khách → gửi ảnh qua email/SMS
- [ ] **NOT-02**: Retry giới hạn số lần khi gửi thất bại — log để xử lý thủ công

### Client-facing Endpoints
- [ ] **API-01**: GET /status/:jobId trả vị trí trong queue cho khách (read-only)
- [ ] **API-02**: WebSocket/SSE feed cho màn hình hiển thị booth (tên khách hiện tại + trạng thái Agent)

### Local State Store
- [ ] **STO-01**: SQLite lưu queue, booth state, cursor, job history, processed ids — persist qua restart

## v2 Requirements (Deferred)
- **V2-01**: Multi-booth support
- **V2-02**: Advanced analytics dashboard

## Out of Scope

| Feature | Reason |
|---------|--------|
| Ghi vao DB that | Rang buoc cung - khong duoc INSERT/UPDATE/DELETE |
| Goi dslrBooth API truc tiep | Moi lenh phai di qua Agent |
| UI phuc tap man hinh booth | Chi push data qua WS |
| Multi-booth | Chi ho tro 1 booth duy nhat |
| Queue phan tan | In-memory queue du cho 1 booth |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| ING-01 .. ING-03 | 1 | Pending |
| STO-01 | 1 | Pending |
| QUE-01 .. QUE-04 | 2 | Pending |
| BTH-01 .. BTH-02 | 2 | Pending |
| AGT-01 .. AGT-05 | 3 | Pending |
| NOT-01 .. NOT-02 | 4 | Pending |
| API-01 .. API-02 | 5 | Pending |

**Coverage:** 21 total, mapped: 21, unmapped: 0
