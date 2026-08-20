# Bảo mật

Kho này phục vụ một hệ thống đang chạy thật, xử lý **tên, số điện thoại và ảnh
của khách tại sự kiện**. Phần lớn rủi ro ở đây không phải lỗ hổng mã nguồn mà
là dữ liệu vô tình lọt vào git history.

## Không bao giờ commit

| Thứ | Vì sao |
|---|---|
| `.env` và mọi bản `.env.bak-*` | Chứa `DB_PASSWORD`, `WEBHOOK_HMAC_SECRET`, `AGENT_WS_TOKEN`, `TWILIO_AUTH_TOKEN`, `CMS_PASSWORD_HASH`, `DSLRBOOTH_PASSWORD`. Một bản sao mang nguyên độ nhạy cảm của bản gốc. |
| `mirror-request/data/*.sqlite` và `data/backups/` | Hàng chờ thật, có PII của khách. |
| `mirror-request/data/uploads/`, `web-slide/uploads/` | Ảnh và logo do khách/khách hàng tải lên. |
| `logs/`, `*.log`, `web-slide/webhook-json.log` | Log chạy thật có tên và số điện thoại ở dạng rõ. |
| Khoá, chứng chỉ (`*.pem`, `*.key`, `*.p12`) | Kể cả khi chỉ đặt tạm để copy sang máy khác. |

Cả `.gitignore` gốc lẫn `.gitignore` của từng dự án con đều chặn những mục
trên. Đừng dùng `git add -f` để lách.

## Trước mỗi lần commit

```bash
git status --short                    # có gì lạ ngoài dự kiến không?
git diff --cached --name-only         # đúng những file mình định thêm chứ?
git diff --cached -S'PASSWORD' -S'SECRET' -S'TOKEN'   # có giá trị thật nào lọt vào không?
```

Chỉ tên biến (`DB_PASSWORD=`) thì được. Giá trị thật thì không.

## Lỡ commit secret rồi thì làm gì

Coi như khoá đó **đã lộ**, kể cả khi chưa push. Thứ tự đúng:

1. **Xoay khoá trước.** Đổi mật khẩu DB, sinh lại `WEBHOOK_HMAC_SECRET`
   (`openssl rand -hex 32`), sinh lại `AGENT_WS_TOKEN`, xoay token Twilio.
   Xem `mirror-request/docs/OPS-RUNBOOK.md` §3.
2. **Rồi mới dọn history** (`git filter-repo` hoặc BFG), và force-push.
3. Báo cho những ai đã clone để họ clone lại — bản cũ vẫn còn khoá cũ.

Làm ngược thứ tự là vô nghĩa: dọn history không thu hồi được khoá đã lộ.

## Ranh giới bảo mật của hệ thống

- **DB nguồn chỉ đọc.** Tài khoản MySQL của service phải là tài khoản chỉ có
  quyền `SELECT` trên VIEW `photobooth.registrations`. Đây là hàng rào ở tầng
  quyền, không chỉ là quy ước trong mã.
- **Agent xác thực bằng Bearer token**, so sánh bằng `timingSafeEqual` để không
  rò rỉ qua thời gian so sánh.
- **Webhook ký bằng HMAC** với `WEBHOOK_HMAC_SECRET`.
- **Mật khẩu CMS lưu dạng băm**, sinh bằng `npm run cms:hash-password` để mật
  khẩu rõ không đi qua shell history.

## Báo lỗi bảo mật

Đây là kho riêng. Báo trực tiếp cho chủ sở hữu kho — đừng mở issue công khai
mô tả lỗ hổng chưa vá.
