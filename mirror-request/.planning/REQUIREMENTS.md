
# Requirements: Extension Service

**Defined:** 2025-07-22
**Core Value:** Moi khach dang ky deu duoc phuc vu dung thu tu, khong bo lo dang ky nao, va nhan duoc anh ket qua tu dong

## v1 Requirements

### Ingestion (Nhan dang ky)
- [ ] **ING-01**: Nhan dang ky qua POST /on-register (mirror tu proxy), tra 200 ngay, xu ly async
- [ ] **ING-02**: Doc DB read-only (SELECT) dinh ky de bat dang ky bi miss
- [ ] **ING-03**: Cursor DB polling luu trong local store, khong ghi nguoc DB that

### Hệ thống Xếp hàng & Trạng thái Booth
- [ ] **QUE-01**: Queue toàn cục (FIFO) — đúng thứ tự đăng ký
- [ ] **QUE-02**: Idempotency — không xử lý trùng đăng ký đã qua (dựa record id)
- [ ] **QUE-03**: Booth IDLE + queue có job → dispatch start_session xuống Agent
- [ ] **QUE-04**: Nhận session_end → booth IDLE → tự động dispatch job tiếp theo
- [ ] **BTH-01**: State machine quản lý IDLE/BUSY
- [ ] **BTH-02**: Timeout an toàn — BUSY >5 phút không session_end → reset IDLE + log warning

### Giao tiếp Agent (WebSocket Server)
- [ ] **AGT-01**: WS server chấp nhận Agent kết nối (xác thực token)
- [ ] **AGT-02**: Gửi lệnh command(start_session) khi dispatch
- [ ] **AGT-03**: Nhận ack từ Agent (jobId, ok, errorMessage)
- [ ] **AGT-04**: Nhận event từ Agent (session_start ... session_end, file_upload)
- [ ] **AGT-05**: Heartbeat tracking — >30s không nhận → Agent offline

### Thông báo Khách hàng
- [ ] **NOT-01**: Nhận file_upload → tìm thông tin liên hệ → gửi ảnh qua email/SMS
- [ ] **NOT-02**: Retry giới hạn khi gửi thất bại

### API Cho Khách & Màn hình
- [ ] **API-01**: GET /status/:jobId trả vị trí trong queue (read-only)
- [ ] **API-02**: WebSocket/SSE feed cho màn hình hiển thị (tên khách + trạng thái Agent)

## v2 Requirements (Deferred)
- **V2-01**: Multi-booth support
- **V2-02**: Advanced analytics dashboard

## Out of Scope

| Feature | Reason |
|---------|--------|
| Ghi vào DB thật | Ràng buộc cứng — chỉ SELECT read-only |
| Gọi dslrBooth API trực tiếp | Mọi lệnh phải đi qua Agent |
| UI phức tạp màn hình booth | Chỉ push data, render là frontend khác |
| Multi-booth | V1 chỉ 1 booth |
| Queue phân tán | In-memory queue đủ cho 1 booth |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| AUTH-02 | 1 | Pending |
| AUTH-01 | 3 | Pending |
| AUTH-03 | 5 | Pending |
| ING-01 | 1 | Pending |
| ING-02 | 1 | Pending |
| ING-03 | 1 | Pending |
| STO-01 | 1 | Pending |
| QUE-01 | 2 | Pending |
| QUE-02 | 2 | Pending |
| QUE-03 | 2 | Pending |
| QUE-04 | 2 | Pending |
| BTH-01 | 2 | Pending |
| BTH-02 | 2 | Pending |
| AGT-01 | 3 | Pending |
| AGT-02 | 3 | Pending |
| AGT-03 | 3 | Pending |
| AGT-04 | 3 | Pending |
| AGT-05 | 3 | Pending |
| NOT-01 | 4 | Pending |
| NOT-02 | 4 | Pending |
| API-01 | 5 | Pending |
| API-02 | 5 | Pending |

**Coverage:** 21 total, mapped: 21, unmapped: 0
