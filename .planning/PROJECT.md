_id: project-ext
name: Extension Service
short: extension-service
tagline: Bộ não trung tâm — kết nối Agent ↔ Mirror Request cho photobooth QR

## What This Is

Extension Service là thành phần "bộ não" trung tâm của hệ thống photobooth kích hoạt qua QR code. Là một service độc lập chạy trên server/cloud, quản lý toàn bộ logic nghiệp vụ: nhận đăng ký từ mirror request hoặc DB polling, duy trì queue khách chờ, điều phối trạng thái IDLE/BUSY của booth, gửi lệnh chụp xuống Agent qua WebSocket, nhận event từ dslrBooth, và gửi ảnh kết quả cho khách qua webhook.

## Core Value

Đảm bảo mỗi khách đăng ký đều được phục vụ đúng thứ tự, không bỏ lỡ đăng ký nào, và nhận được ảnh kết quả tự động — tất cả tự động hóa hoàn toàn, không can thiệp thủ công.

## Scope

### MVP (1 booth)
- Nhận đăng ký real-time qua mirror (POST /on-register) + DB polling dự phòng
- Queue FIFO toàn cục — đúng thứ tự đăng ký
- State machine IDLE/BUSY với timeout an toàn
- Gửi lệnh start_session xuống Agent qua WebSocket (xác thực token)
- Nhận ack + event từ Agent, đồng bộ trạng thái booth
- Nhận file_upload → gửi ảnh cho khách qua webhook (email/SMS)
- GET /status/:jobId — vị trí trong queue cho khách
- WS /display — feed realtime cho màn hình booth (tên khách + trạng thái Agent)
- Idempotency — không xử lý trùng
- Local state store (SQLite) — persist qua restart

### Out of Scope
- Không ghi INSERT/UPDATE/DELETE vào DB thật (chỉ SELECT read-only)
- Không multi-booth — chỉ 1 booth
- Queue phân tán — in-memory là đủ

## Stack
- Runtime: Node.js 20 LTS
- Language: TypeScript
- Packages: express, ws, better-sqlite3, winston, dotenv, pg (read-only)
- Deployment: PM2 / Docker

## Related Projects
- `mirror-request/` — extension service source + planning chi tiết
- `dslrbooth-agent/` — relay Agent trên máy booth (dumb relay, xử lý WS inbound/outbound)
