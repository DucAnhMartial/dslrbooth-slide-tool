# Webhook Slideshow — RETIRED

> **This app is retired and is no longer deployed.** Do not start it, and do
> not point a TV at it.
>
> **Replacement:** the room screen now lives inside the Extension Service
> (`mirror-request`) at **`GET /display-screen`** — one fixed URL for every TV,
> served on that service's own `PORT` (default `3002`), not on `3001`. It is
> driven by the same `WS /display` feed that already knows the queue, and it is
> themed per event from the operator console at `/cms`. Everything this app did
> for the room — receive photos, hold a queue of guests, rotate a slideshow —
> is done there now, by one process against one database.
>
> **Why this source is still here:** it is kept deliberately as **layout
> reference** (Phase 8, decision D-08). `index.html` is where the replacement
> screen's layout and fluid typography came from, and it stays readable for
> that reason. Nothing here is deployed, nothing here is maintained, and
> nothing in `mirror-request` imports or calls it.
>
> **If this app is still running somewhere, that is the bug.** It predates the
> Extension Service's hardening: `server.js` accepted anonymous uploads and, at
> one point, exposed destructive endpoints with no authentication at all. A
> copy left alive on `:3001` also keeps serving *stale* content, which looks
> like the new screen being broken rather than the old one being alive. See
> `mirror-request/docs/OPS-RUNBOOK.md` §12 ("The cutover: retiring
> `web-slide`") for how to find and stop whatever is supervising it — stopping
> the process alone is not enough if a supervisor will restart it.
>
> **Guest photo delivery did not move here or away.** `NOTIFY_WEBHOOK_URL` in
> the Extension Service still delivers each guest their own photo exactly as
> before (OPS-RUNBOOK §8). What changed is that it no longer feeds a room
> screen (D-04).

---

## Historical documentation

Everything below describes this app as it was when it was in service. It is
kept for reference and is **not** instructions to run anything.

Web app nhận webhook và trình chiếu ảnh khách hàng dạng slideshow real-time.

## Cài đặt & chạy

```bash
npm install
node server.js
```

Mở trình duyệt: http://localhost:3001

---

## Webhook Endpoints

### 1. Multipart/form-data (có file upload)
```
POST http://<server>:3001/webhook
Content-Type: multipart/form-data
```

| Field | Mô tả |
|---|---|
| `name` | Tên khách hàng |
| `phone` | Số điện thoại |
| `email` | Email |
| `note` | Ghi chú |
| `image` | File ảnh (jpg, png...) |

**Ví dụ curl:**
```bash
curl -X POST http://localhost:3001/webhook \
  -F "name=Nguyen Van A" \
  -F "phone=0912345678" \
  -F "email=a@example.com" \
  -F "note=Khách VIP" \
  -F "image=@/path/to/photo.jpg"
```

---

### 2. JSON với mirror-request payload
```
POST http://<server>:3000/webhook/json
Content-Type: application/json
```

```json
{
  "jobId": "registration-20260806-0002",
  "guestName": "Nguyễn Minh Anh",
  "photoUrl": "https://example.com/photo.jpg",
  "timestamp": "2026-08-07T10:00:00.000Z",
  "mode": "print"
}
```

App cũng vẫn chấp nhận các trường legacy như `name`, `image_url`, `imageUrl` hoặc `image_base64`.

---

### 3. JSON với Base64 image
```json
{
  "name": "Nguyen Van A",
  "phone": "0912345678",
  "image_base64": "data:image/jpeg;base64,/9j/4AAQ...",
  "image_type": "jpg"
}
```

---

## Field mapping linh hoạt

Server chấp nhận nhiều tên field:
- Tên: `name` hoặc `customer_name`
- SĐT: `phone` hoặc `customer_phone`
- Email: `email` hoặc `customer_email`
- Ghi chú: `note` hoặc `message`
- Ảnh URL: `image_url` hoặc `imageUrl`

---

## Tính năng giao diện

- **Real-time**: Ảnh mới hiện ngay không cần refresh (SSE)
- **Auto slideshow**: Tự chuyển ảnh 4s / 6s / 10s hoặc tắt
- **Sidebar queue**: Danh sách tất cả khách, click để chuyển
- **Phím tắt**: ← → hoặc Space để chuyển slide
- **Fallback**: Nếu không có ảnh, hiển thị avatar chữ cái đầu
- **Toast notification**: Thông báo khi có khách mới

---

## Deploy trên SLES / Linux

### Chạy bằng systemd
```ini
# /etc/systemd/system/webhook-slideshow.service
[Unit]
Description=Webhook Slideshow
After=network.target

[Service]
WorkingDirectory=/opt/webhook-slideshow
ExecStart=/usr/bin/node server.js
Restart=always
User=nobody

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable webhook-slideshow
systemctl start webhook-slideshow
```

### Mở firewall (SLES với firewalld)
```bash
firewall-cmd --permanent --add-port=3000/tcp
firewall-cmd --reload
```
