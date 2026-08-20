# Changelog

Định dạng theo [Keep a Changelog](https://keepachangelog.com/vi/1.1.0/).

## [Chưa phát hành]

### Sửa
- Gỡ khỏi toàn bộ lịch sử ba file trạng thái SQLite (`extension-service.sqlite`,
  `-shm`, `-wal`) mà commit `Truong Backup` từng đưa vào rồi untrack sau đó.
  Untrack không xoá blob khỏi history. Nội dung đã được kiểm tra trước khi gỡ:
  chỉ có dữ liệu test (`test@example.com`, `+84912345678`, các dòng
  `capture-test-*`), không có PII khách thật. Gỡ ở đây để đúng với chính điều
  `mirror-request/.gitignore` đã viết: những file này không bao giờ được vào
  git history.

### Thêm
- Gộp ba dự án con thành một monorepo, giữ nguyên lịch sử commit của từng dự án
  (`mirror-request` 195 commit, `dslrbooth-agent` 20 commit, `web-slide` 2
  commit). Đường dẫn được viết lại xuống dưới tiền tố tương ứng trước khi gộp,
  nên `git log --follow` và `git blame` truy được tới commit gốc — điều mà
  `git subtree add` không làm được vì nó ghép cây bằng merge `-s ours`.
- Bộ khung production ở gốc kho: `README.md`, `DEPLOYMENT.md`, `CONTRIBUTING.md`,
  `SECURITY.md`, `LICENSE`, `.gitignore`, `.gitattributes`, `.editorconfig`.
- CI trên GitHub Actions: typecheck, lint, test và build cho `mirror-request`;
  typecheck và test cho `dslrbooth-agent`; quét bí mật bằng gitleaks.
- Dependabot gộp nâng cấp npm và GitHub Actions theo tháng.

---

Lịch sử trước thời điểm gộp kho nằm trong chính commit của từng dự án con:

```bash
git log --follow -- mirror-request/src/index.ts
git log --follow -- dslrbooth-agent/src/index.ts
```
