# Extension Service

## What This Is

**Extension Service** là thành phần "bộ não" trung tâm của hệ thống photobooth kích hoạt qua QR code. Là một service độc lập chạy trên server/cloud, quản lý toàn bộ logic nghiệp vụ: nhận đăng ký từ mirror request hoặc DB polling, duy trì queue khách chờ, điều phối trạng thái IDLE/BUSY của booth, gửi lệnh chụp xuống Agent qua WebSocket, nhận event từ dslrBooth, và gửi ảnh kết quả cho khách qua email/SMS.

## Core Value

Đảm bảo mỗi khách đăng ký đều được phục vụ đúng thứ tự, không bỏ lỡ đăng ký nào, và nhận được ảnh kết quả tự động — tất cả tự động hóa hoàn toàn, không cần can thiệp thủ công.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Nhận đăng ký từ mirror request (POST /on-register) — real-time, trả 200 ngay
- [ ] Nhận đăng ký từ DB polling (read-only, dự phòng) — chạy định kỳ, tránh miss
- [ ] Queue toàn cục (1 queue, vì chỉ 1 booth) — xếp hàng FIFO, đúng thứ tự đăng ký
- [ ] State machine IDLE/BUSY cho booth — tự động chuyển trạng thái theo event
- [ ] Timeout an toàn — reset IDLE nếu session kéo dài quá 5 phút không có session_end
- [ ] Gửi lệnh start_session xuống Agent qua WebSocket khi booth IDLE và queue có job
- [ ] Nhận ack/event/heartbeat từ Agent qua WebSocket
- [ ] Đồng bộ boothState sau session_end → tự động dispatch job tiếp theo
- [ ] Xác thực Agent khi connect WS (token/API key riêng)
- [ ] Theo dõi heartbeat — expose trạng thái Agent online/offline (🟢/🔴)
- [ ] Nhận event file_upload → ghép với thông tin khách → gửi ảnh qua email/SMS
- [ ] Retry giới hạn cho email/SMS thất bại — log để xử lý thủ công
- [ ] GET /status/:jobId — trả vị trí trong queue cho khách (read-only)
- [ ] WebSocket/SSE feed cho màn hình hiển thị booth (tên khách hiện tại + trạng thái Agent)
- [ ] Idempotency — không xử lý trùng đăng ký đã qua
- [ ] Local state store (SQLite) — persist queue, booth state, cursor, job history qua restart

### Out of Scope

- Không ghi (INSERT/UPDATE/DELETE) vào database thật của backend — chỉ SELECT read-only
- Không tự gọi dslrBooth Local API trực tiếp — mọi lệnh phải đi qua Agent
- Không xử lý UI phức tạp cho màn hình booth — chỉ push data qua WS/SSE, render là trách nhiệm frontend khác
- Không multi-booth — chỉ hỗ trợ 1 booth duy nhất
- Không có queue phân tán — queue trong-memory là đủ cho 1 booth

## Context

### Vấn đề
- Khách quét QR → đăng ký → backend xử lý → nhưng cần trigger booth chụp ảnh tự động
- Reverse proxy đặt trước backend: forward request gốc + mirror sang Extension Service
- Agent trên máy booth chỉ relay lệnh/event, không tự quyết định

### Kiến trúc hệ thống
```
┌──────────────┐    HTTP POST     ┌──────────────────┐
│  Reverse Proxy │────────────────►│  Backend (gốc)  │
│  (nginx/caddy) │                  └──────────────────┘
│  mirror ──────┼────────────────►│  Extension Service│
└──────────────┘                    │  (bộ não)         │
                                    └────────┬─────────┘
                                              │ WebSocket
                                    ┌────────▼─────────┐
                                    │      Agent       │
                                    │  (máy Windows)   │
                                    └────────┬─────────┘
                                              │ HTTP Local API
                                    ┌────────▼─────────┐
                                    │   dslrBooth       │
                                    │   Professional   │
                                    └──────────────────┘
```

### Luồng hoạt động
1. Khách quét QR → form đăng ký → HTTP POST
2. Reverse proxy forward + mirror sang Extension Service
3. Extension Service nhận → đẩy vào queue → nếu booth IDLE → dispatch start_session xuống Agent
4. Agent gọi dslrBooth API → session bắt đầu
5. dslrBooth fire trigger → Agent forward event lên Extension Service
6. Extension Service nhận session_end → booth IDLE → dispatch job tiếp theo
7. Nhận file_upload → gửi ảnh cho khách qua email/SMS

## Constraints

- **Runtime**: Node.js 20 LTS, express, ws, better-sqlite3, winston, dotenv
- **Không đụng DB thật**: chỉ SELECT read-only qua account riêng
- **Local state store**: SQLite/file — độc lập hoàn toàn với DB thật
- **Idempotency bắt buộc**: mỗi đăng ký có id duy nhất
- **Bảo mật**: Token riêng cho Agent WS, giới hạn IP cho /on-register
- **Deployment**: PM2 / Docker / service bình thường trên server/cloud

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Queue in-memory (1 booth) | Đơn giản, đủ cho 1 booth duy nhất, restart mất queue nhưng DB polling sẽ recover | — Pending |
| SQLite cho local state | Nhẹ, embed, không cần server riêng | — Pending |
| WebSocket server cho Agent | Real-time bidirectional, phù hợp event-driven | — Pending |
| DB polling dự phòng | Đảm bảo không miss đăng ký khi mirror fail | — Pending |
| Trả 200 ngay cho /on-register | Không chặn luồng proxy, xử lý async | — Pending |

---

*Last updated: 2025-07-22 after initialization*
