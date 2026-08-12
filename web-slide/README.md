# Webhook Slideshow

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
