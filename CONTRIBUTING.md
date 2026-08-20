# Đóng góp

## Trước khi bắt đầu

Đọc ba ranh giới kiến trúc trong [README](README.md#ba-ranh-giới-kiến-trúc-không-được-phá).
Chúng không phải gợi ý — vi phạm một trong ba sẽ bị trả lại PR.

Đọc `.planning/STATE.md` để biết đang ở pha nào, và `.planning/ROADMAP.md` để
biết việc bạn định làm đã nằm trong kế hoạch chưa.

## Luồng nhánh

`main` là nhánh tích hợp và luôn phải ở trạng thái triển khai được. Làm việc
trên nhánh riêng, đặt tên theo pha nếu có:

```
feat/11-retake-approval
fix/10-04-preload-sandbox
docs/deployment-refresh
chore/ci-node-matrix
```

## Quy ước commit

Theo [Conventional Commits](https://www.conventionalcommits.org/), giữ đúng
kiểu đang dùng trong lịch sử kho:

```
feat(09-03): add dynamic slide captions
fix(11-06): stamp activeJobId before dslrBooth can fire session_start
docs(08-06): mark web-slide retired and name its replacement (D-08)
chore: baseline web-slide under version control
```

- Kiểu: `feat` `fix` `docs` `refactor` `test` `chore` `perf` `build` `ci`
- Scope là **mã pha** (`11-06`) khi việc thuộc một pha trong roadmap.
- Dòng đầu ở thể mệnh lệnh, nói *cái gì thay đổi*, không quá 72 ký tự.
- Thân commit nói **vì sao**, không nói lại *thế nào* — diff đã nói rồi.

Commit nguyên tử: một commit một thay đổi logic. Đừng gộp đổi tên biến với sửa
lỗi vào cùng một commit.

## Phải xanh trước khi mở PR

```bash
# mirror-request
cd mirror-request && npm ci && npm run typecheck && npm run lint && npm test

# dslrbooth-agent
cd dslrbooth-agent && npm ci && npm run typecheck && npm test
```

CI chạy đúng những lệnh này trên Node 20. Đừng đẩy lên rồi chờ CI báo hộ.

## Test

- Mỗi lần sửa lỗi phải kèm test **thất bại trước khi vá và xanh sau khi vá**.
  Test không chứng minh được điều đó là test rỗng.
- Suite dùng [vitest](https://vitest.dev/) ở cả hai dự án: `npm run test:watch`
  khi đang làm.

## Tài liệu

Sửa hành vi vận hành thì phải sửa runbook tương ứng trong cùng PR:

- đổi biến môi trường, cổng, hoặc bước triển khai → `DEPLOYMENT.md`
- đổi cách vận hành máy chủ → `mirror-request/docs/OPS-RUNBOOK.md`
- đổi cách vận hành máy booth → `dslrbooth-agent/docs/OPS-RUNBOOK-AGENT.md`

Tài liệu lệch với thực tế còn tệ hơn không có tài liệu.

## Bí mật

Đọc [SECURITY.md](SECURITY.md) trước lần commit đầu tiên. Tóm tắt: `.env`, DB
SQLite, ảnh upload và log chạy thật không bao giờ vào git.
