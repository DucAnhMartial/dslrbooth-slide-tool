# Changelog

Định dạng theo [Keep a Changelog](https://keepachangelog.com/vi/1.1.0/).

## [Chưa phát hành]

### Thêm
- Gộp ba dự án con thành một monorepo, giữ nguyên lịch sử commit của từng dự án
  qua `git subtree` (`mirror-request` 195 commit, `dslrbooth-agent` 20 commit,
  `web-slide` 2 commit).
- Bộ khung production ở gốc kho: `README.md`, `DEPLOYMENT.md`, `CONTRIBUTING.md`,
  `SECURITY.md`, `LICENSE`, `.gitignore`, `.gitattributes`, `.editorconfig`.
- CI trên GitHub Actions: typecheck, lint, test và build cho `mirror-request`;
  typecheck và test cho `dslrbooth-agent`; quét bí mật bằng gitleaks.
- Dependabot gộp nâng cấp npm và GitHub Actions theo tháng.

---

Lịch sử trước thời điểm gộp kho nằm trong chính commit của từng dự án con:

```bash
git log --follow mirror-request/src/
git log --follow dslrbooth-agent/src/
```
