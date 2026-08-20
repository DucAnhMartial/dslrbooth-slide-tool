## Thay đổi gì

<!-- Một đoạn: cái gì đổi và vì sao. Đừng chép lại diff. -->

## Pha / yêu cầu liên quan

<!-- Mã pha trong .planning/ROADMAP.md, hoặc REQ-ID. Ghi "không" nếu ngoài roadmap. -->

## Kiểm chứng thế nào

<!-- Lệnh đã chạy và kết quả thật. Với bản vá lỗi: nói rõ test nào đỏ trước khi
     vá và xanh sau khi vá. -->

```
```

## Checklist

- [ ] `npm run typecheck` xanh ở dự án bị đụng tới
- [ ] `npm run lint` xanh (`mirror-request`)
- [ ] `npm test` xanh
- [ ] Lỗi được vá có kèm test chứng minh (đỏ trước, xanh sau)
- [ ] Không có `.env`, DB SQLite, ảnh upload hay log chạy thật trong diff
- [ ] Runbook / `DEPLOYMENT.md` đã cập nhật nếu hành vi vận hành đổi
- [ ] Không phá ba ranh giới kiến trúc (DB nguồn chỉ đọc · không gọi thẳng
      dslrBooth API từ máy chủ · logic nằm ở máy chủ)

## Rủi ro khi triển khai

<!-- Cần đổi biến môi trường? Cần chạy migration? Có cần khởi động lại Agent
     trên từng máy booth không? Ghi "không" nếu không có. -->
