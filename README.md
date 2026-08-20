# Photobooth — Extension Service & dslrBooth Agent

Hệ thống buồng chụp ảnh tự phục vụ theo mã QR: khách quét mã đăng ký, hệ thống
xếp hàng chờ, điều khiển buồng chụp, rồi gửi ảnh và thông báo về cho khách.

> **Phần mềm độc quyền.** Xem [LICENSE](LICENSE). Kho này chứa tài liệu vận
> hành của một hệ thống đang chạy thật — đọc [SECURITY.md](SECURITY.md) trước
> khi commit bất cứ thứ gì có dính cấu hình.

---

## Hệ thống gồm những gì

| Thư mục | Chạy ở đâu | Vai trò | Trạng thái |
|---|---|---|---|
| [`mirror-request/`](mirror-request/) | Máy chủ Linux, cạnh MySQL | **Toàn bộ nghiệp vụ.** Nạp đăng ký, xếp hàng chờ, điều khiển buồng, gửi thông báo, phục vụ màn hình phòng + trang tra cứu + CMS | Đang chạy production |
| [`dslrbooth-agent/`](dslrbooth-agent/) | PC của buồng ảnh (Windows) | **Relay thuần.** Chuyển lệnh WebSocket thành lệnh dslrBooth Local API và báo sự kiện ngược về. Không chứa logic | Đang chạy production |
| [`web-slide/`](web-slide/) | — | Bộ nhận webhook trình chiếu đời đầu | **Đã ngưng dùng**, giữ làm tham chiếu |

### Luồng dữ liệu

```
ets_web (vé, đơn hàng)
   │  VIEW photobooth.registrations  (chỉ 6 cột, SELECT-only)
   ▼
DBPoller — 3 giây/nhịp, tối đa 50 dòng, con trỏ registered_at
   │
   ├─► hàng chờ SQLite ──► lệnh WS ──► Agent ──► dslrBooth
   │                                     │
   │                             sự kiện WS ◄─┘
   ▼
màn hình phòng (WS /display) · trang khách (/status/:jobId) · email/SMS
```

Cổng mặc định: máy chủ **3002** · Agent trigger server **3001** · dslrBooth
Local API **1500** (trên chính máy booth).

---

## Ba ranh giới kiến trúc không được phá

Ba quy tắc này quyết định hình dạng của toàn bộ mã nguồn. Vi phạm một trong ba
là lỗi thiết kế, không phải lỗi cần vá:

1. **Không bao giờ ghi vào DB nguồn.** `ets_web` là hệ thống bán vé đang vận
   hành. Chỉ đọc qua VIEW `photobooth.registrations`, chỉ `SELECT`.
2. **Không bao giờ gọi dslrBooth Local API trực tiếp từ máy chủ.** Mọi lệnh đi
   qua Agent bằng WebSocket. Máy booth nằm sau NAT của địa điểm sự kiện.
3. **Toàn bộ logic nằm ở máy chủ.** Agent là ống dẫn. Muốn đổi hành vi thì sửa
   `mirror-request/`, không sửa Agent — Agent phải cài lại trên từng máy booth.

Chi tiết trong [`mirror-request/CLAUDE.md`](mirror-request/CLAUDE.md).

---

## Bắt đầu nhanh (máy dev)

Yêu cầu: **Node.js 20 LTS** (`mirror-request` khai báo `engines.node = 20.x`),
npm 10+, và MySQL truy cập được nếu muốn chạy phần nạp đăng ký.

```bash
git clone https://github.com/DucAnhMartial/dslrbooth-slide-tool.git
cd dslrbooth-slide-tool

# --- Extension Service (máy chủ) ---
cd mirror-request
npm ci
cp .env.example .env        # điền giá trị thật, xem DEPLOYMENT.md §3
npm run typecheck && npm run lint && npm test
npm run dev                 # ts-node, cổng 3002

# --- Agent (máy booth Windows) ---
cd ../dslrbooth-agent
npm ci
cp .env.example .env        # xem DEPLOYMENT.md §7
npm run typecheck && npm test
npm run electron:dev        # giao diện desktop
```

`.env` **không bao giờ** được commit — cả hai dự án đều ignore nó, và
`.env.example` chỉ có tên biến với giá trị rỗng.

### Lệnh hay dùng

| Việc | `mirror-request` | `dslrbooth-agent` |
|---|---|---|
| Kiểm tra kiểu | `npm run typecheck` | `npm run typecheck` |
| Lint | `npm run lint` | — |
| Test | `npm test` | `npm test` |
| Build | `npm run build` | `npm run build` |
| Chạy | `npm start` (từ `dist/`) | `npm start` |
| Đóng gói Windows | — | `npm run build:exe` |
| Cài Windows service | — | `npm run service:install` |
| Băm mật khẩu CMS | `npm run cms:hash-password` | — |

---

## Triển khai

[**`DEPLOYMENT.md`**](DEPLOYMENT.md) là trình tự triển khai từ máy trắng đến sự
kiện chạy thật — đọc từ trên xuống. Hai runbook vận hành đi kèm:

- [`mirror-request/docs/OPS-RUNBOOK.md`](mirror-request/docs/OPS-RUNBOOK.md) — vận hành Extension Service
- [`dslrbooth-agent/docs/OPS-RUNBOOK-AGENT.md`](dslrbooth-agent/docs/OPS-RUNBOOK-AGENT.md) — vận hành Agent trên máy booth

---

## Cấu trúc kho

```
.
├── mirror-request/       Extension Service — TypeScript, Express, ws, better-sqlite3
│   ├── src/              mã nguồn
│   ├── test/             vitest
│   ├── docs/             runbook vận hành + migration SQL
│   └── data/             SQLite runtime (không track)
├── dslrbooth-agent/      Agent — TypeScript, Electron, node-windows
│   ├── src/              mã nguồn (main, preload, relay)
│   ├── service/          cài đặt Windows service
│   └── build/            tài nguyên đóng gói (icon, installer)
├── web-slide/            bộ nhận webhook cũ, đã ngưng dùng
├── .planning/            tài liệu kế hoạch GSD — roadmap, phase, UAT, quyết định
├── DEPLOYMENT.md         trình tự triển khai toàn hệ thống
└── .github/workflows/    CI — typecheck, lint, test
```

Kho này là **monorepo**: lịch sử commit của ba dự án con đã được nhập vào đây
bằng `git subtree`, nên `git log --follow mirror-request/src/...` vẫn truy được
tới tận commit gốc.

---

## Tài liệu kế hoạch

`.planning/` là bộ nhớ dài hạn của dự án, không phải rác sinh ra tự động. Trước
khi đổi hành vi hệ thống, đọc:

- `.planning/PROJECT.md` — bối cảnh và ràng buộc
- `.planning/REQUIREMENTS.md` — yêu cầu v1 kèm REQ-ID
- `.planning/ROADMAP.md` — chia pha và tiêu chí hoàn thành
- `.planning/STATE.md` — pha đang làm

---

## Đóng góp

Xem [CONTRIBUTING.md](CONTRIBUTING.md) — quy ước commit, luồng nhánh, và những
gì phải xanh trước khi mở PR.
