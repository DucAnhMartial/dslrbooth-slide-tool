# Requirements: Extension Service

**Version:** v1
**Created:** 2025-07-26

## Core Value

Mỗi khách đăng ký đều được phục vụ đúng thứ tự, không bỏ lỡ đăng ký nào, và nhận được ảnh kết quả tự động.

## Authentication & Security

- [x] **AUTH-01**: Agent xác thực qua token/API key khi kết nối WebSocket
- [x] **AUTH-02**: Endpoint /on-register chỉ chấp nhận IP reverse proxy (403 ngoài whitelist)
- [x] **AUTH-03**: Thông tin nhạy cảm (email, SĐT) được mask một phần trong log

## Ingestion

- [x] **ING-01**: Nhận đăng ký qua POST /on-register (mirror từ proxy), trả 200 ngay, xử lý async
- [x] **ING-02**: Đọc DB backend read-only (SELECT) định kỳ để bắt đăng ký bị miss
- [x] **ING-03**: Cursor DB polling được lưu trong local state, không ghi ngược DB thật

## Queue & Booth State

- [x] **QUE-01**: Queue toàn cục (FIFO) — đúng thứ tự đăng ký
- [x] **QUE-02**: Idempotency — không xử lý trùng đăng ký đã qua (dựa record id)
- [x] **QUE-03**: Khi booth IDLE + queue có job → dispatch job đầu tiên gửi start_session xuống Agent
- [x] **QUE-04**: Nhận session_end → booth IDLE → tự động dispatch job tiếp theo
- [x] **BTH-01**: State machine quản lý IDLE/BUSY
- [x] **BTH-02**: Timeout an toàn — nếu BUSY > 5 phút không nhận session_end, tự động reset IDLE + log warning

## Agent Communication

- [x] **AGT-01**: WS server chấp nhận Agent duy nhất, xác thực token
- [x] **AGT-02**: Gửi lệnh {type: "command", action: "start_session", jobId, mode} khi dispatch
- [x] **AGT-03**: Nhận ack {jobId, ok, errorMessage} từ Agent
- [x] **AGT-04**: Nhận event từ Agent (session_start, countdown_start, countdown, capture_start, file_download, processing_start, sharing_screen, file_upload, printing, session_end)
- [x] **AGT-05**: Heartbeat — nếu > 30s không nhận, Agent offline

## Guest Notification

- [x] **NOT-01**: file_upload event → tra jobId → tìm thông tin liên hệ → gửi ảnh qua webhook trigger
- [x] **NOT-02**: Retry giới hạn khi gửi thất bại — log để xử lý thủ công

## Client-facing API

- [x] **API-01**: GET /status/:jobId — vị trí trong queue cho khách
- [x] **API-02**: WS /display — feed realtime: tên khách hiện tại + trạng thái Agent

## Local State Store

- [x] **STO-01**: SQLite lưu queue, booth state, cursor, job history, processed ids — persist qua restart

## Display & Operator UI

Added 2026-08-12 sau lần chạy end-to-end sạch đầu tiên (job `BZWCWFN6`). Chưa
map vào phase nào.

- [ ] **UI-01**: Màn hình chờ (ảnh/countdown) hiển thị **ngay khi màn hình được
  mở**, không phụ thuộc vào việc đã có request nào chưa. Hôm nay `web-slide`
  chỉ vẽ gì đó sau khi nhận webhook đầu tiên, nên trước khách đầu tiên màn hình
  trong phòng là trắng — trạng thái "chưa có ai" và "hỏng" nhìn giống hệt nhau.
  Idle phải là một trạng thái được vẽ có chủ đích, không phải là chỗ trống.
- [ ] **UI-02**: Cấu hình Agent qua UI thay vì sửa `.env` trên máy booth
  (hoãn từ Phase 6 — xem `06-CONTEXT.md` mục `<deferred>`).

## CMS cho màn hình sự kiện (v2 — chưa cam kết)

Nêu 2026-08-12. Vấn đề vận hành: mỗi khách hàng lại phải **code lại giao diện**.
Đo trên code hiện tại — `web-slide/index.html` là **500 dòng layout cứng**, và
`web-slide/server.js:39` giữ khách trong `const customers = []` **chỉ trong RAM**
(mất sạch khi restart, trần 50). Không có nơi nào để cấu hình thứ gì.

- [ ] **CMS-01**: Cấu hình theo sự kiện, không phải theo commit — logo, nền,
  màu, font, ảnh chờ (UI-01), tiêu đề/lời chào, QR/CTA, số ảnh hiển thị, thời
  gian mỗi ảnh, kiểu layout. Đổi khách hàng = đổi cấu hình, không deploy.
- [ ] **CMS-02**: Một server phục vụ nhiều sự kiện / nhiều màn hình cùng lúc;
  mỗi màn hình biết nó thuộc sự kiện nào.
- [ ] **CMS-03**: Cấu hình và lịch sử ảnh phải **sống qua restart** — hiện tại
  cả hai đều không.
- [ ] **CMS-04**: CMS có đăng nhập. Xem CMS-05 để biết vì sao đây không phải
  chuyện "làm sau cũng được".

### CMS-05 — những gì đang hở NGAY BÂY GIỜ

`web-slide` đang NAT ra Internet công cộng (`:3001`), `app.use(cors())`, không
một lớp xác thực nào. Đo trên `server.js`:

- `DELETE /api/customers` (dòng 145) — **bất kỳ ai trên Internet xoá sạch màn
  hình giữa sự kiện**, không cần gì cả.
- `POST /webhook` (dòng 61) — nhận file 20MB ẩn danh, ghi thẳng vào `./uploads/`.
- Nhánh base64 (dòng 78, 118) — tên file là
  `` `${Date.now()}-b64.${ext}` `` với `ext` lấy từ `body.image_type` do người
  gọi tự đặt, chỉ qua `.replace('image/','')`. Path traversal ra ngoài
  `./uploads/` thì **không** làm được (tiền tố `<timestamp>-b64.` luôn đứng
  trước, nên mọi `..` phải đi sau một thư mục không tồn tại → `ENOENT`). Cái
  làm được là **đuôi file tuỳ ý bên trong `./uploads/`**, mà thư mục đó được
  `express.static` phục vụ (dòng 18): kẻ gọi ghi được `.html` / `.svg` / `.js`
  chứa script và nó chạy trên chính origin của màn hình sự kiện. Stored XSS +
  hosting file tuỳ ý, không phải ghi đè `server.js`.

### Quan sát kiến trúc

`index.html` chỉ nối tới SSE `/events` của chính `web-slide` (dòng 458). Nó
**không hề dùng** `WS /display` mà Extension Service đã dựng ở Phase 5 (API-02).
Tức là đang có hai đường phát tới cùng một màn hình, và đường đang chạy là đường
không biết gì về hàng đợi, tên khách đang chụp, hay Agent còn sống hay không.
Quyết định CMS nên giải quyết luôn chuyện này, chứ không đắp thêm một tầng nữa
lên trên.

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| AUTH-01 | 3 | Complete |
| AUTH-02..03, ING-01..03 | 1 | Complete (AUTH-03's non-ingestion log surfaces closed by Phase 5, plan 05-04 — see WINDOWS ledger item 5, fixed) |
| STO-01 | 1 | Complete |
| QUE-01..04, BTH-01..02 | 2 | Complete |
| AGT-01..05 | 3 | Complete |
| NOT-01..02 | 4 | Complete |
| API-01..02 | 5 | Complete — gate approved 2026-08-11 (05-05); both manual-only verifications (room screen, real guest phone) explicitly declined pending a live Agent link, carried forward as open follow-ups, not blocking |
| ING-02..03 | 6 | Complete — cutover verified `human_needed`; the Agent/booth/slideshow leg it left unproven is now proven live (job `BZWCWFN6`, 2026-08-12 07:08–07:10) |
| UI-01..02 | 8 (+9 extends UI-01) | Complete — audited 2026-08-13; UI-01's at-the-TV legibility judgment remains a human gate |
| CMS-01..04 | 8 | Complete — audited 2026-08-13; two documented narrowings: CMS-01 idle-image/background share one column (deferred D-3), CMS-02 narrowed to one-active-event by human decision (08-CONTEXT D-01/D-12) |
| CMS-05 | 8 | **Closed** — web-slide off (:3001 refused, verified live), all three exposures structurally closed in the replacement (D-15); audited 2026-08-13 |

**Coverage:** 28 total, mapped: 28. Full audit with per-requirement verdicts and
runtime findings: `.planning/AUDIT-2026-08-13.md` — headline: 0 NOT-MET, but
`NOTIFY_WEBHOOK_URL` still points at retired web-slide (delivery failing in
production) and `ack_error_message` is a never-written column.
