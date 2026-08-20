# Triển khai toàn hệ thống Photobooth — từ máy trắng đến sự kiện chạy thật

Tài liệu này là **trình tự triển khai**, đọc từ trên xuống. Nó không thay thế
hai runbook vận hành đã có, mà chỉ ra thứ tự làm và trỏ sang chúng khi cần
chi tiết:

- `mirror-request/docs/OPS-RUNBOOK.md` — vận hành Extension Service (129 KB, 13 mục)
- `dslrbooth-agent/docs/OPS-RUNBOOK-AGENT.md` — vận hành Agent trên máy booth (9 mục)

Viết lại ngày 2026-08-17, đối chiếu với trạng thái thật của máy chủ tại thời
điểm đó. Những chỗ có sai lệch giữa tài liệu và thực tế được ghi thẳng ở
§11.

---

## 0. Hệ thống gồm những gì

Ba thư mục trong repo, nhưng chỉ **hai** cái được triển khai:

| Thành phần | Chạy ở đâu | Vai trò |
|---|---|---|
| `mirror-request` | Máy chủ Linux, cạnh MySQL | **Toàn bộ nghiệp vụ.** Nạp đăng ký, xếp hàng chờ, điều khiển buồng, gửi thông báo, phục vụ màn hình phòng + trang tra cứu + CMS |
| `dslrbooth-agent` | Máy PC của buồng ảnh (Windows) | **Relay ngu.** Chuyển lệnh WebSocket thành lệnh dslrBooth Local API và báo sự kiện về. Không có logic |
| `web-slide` | — | **Đã ngưng dùng.** Giữ lại trong repo làm tham chiếu; `NOTIFY_WEBHOOK_URL` đã để trống để không còn gọi tới nó |

Ranh giới quan trọng nhất, ghi trong `mirror-request/CLAUDE.md` và phải giữ
nguyên khi triển khai:

- **Không bao giờ ghi** (INSERT/UPDATE/DELETE) vào DB nguồn. Chỉ SELECT.
- **Không bao giờ gọi dslrBooth Local API trực tiếp** từ máy chủ. Mọi lệnh đi qua Agent bằng WebSocket.
- Toàn bộ logic nằm ở máy chủ. Agent chỉ là ống dẫn.

Luồng dữ liệu:

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

Cổng: máy chủ **3002**; Agent mở trigger server **3001**; dslrBooth Local API
**1500** (trên chính máy booth).

---

## 1. Yêu cầu trước khi bắt đầu

Trên máy chủ:

- Node.js 20 LTS (bản đang chạy production hiện tại)
- `pm2` cài toàn cục
- MySQL truy cập được, có schema `ets_web` (nguồn) và `photobooth` (đích)
- Quyền tạo VIEW trong `photobooth`, và một tài khoản MySQL chỉ-đọc cho service

Trên máy booth (Windows):

- dslrBooth đã cài, đã bật **Local API** và đặt mật khẩu API
- Cùng mạng LAN với máy chủ, tới được cổng 3002

Trên máy build Agent (Linux, có Docker):

- Docker, để `scripts/build-win.sh` chạy được image `electronuserland/builder:wine`

---

## 2. Bước 1 — Dựng VIEW nạp dữ liệu trong MySQL

Đây là bước đầu tiên và là ranh giới bảo mật của cả hệ thống. Service **không
được** cấp quyền đọc `ets_web`; nó chỉ đọc `photobooth.registrations`.

DDL **không viết tay**. Nó được sinh ra từ code để bản SQL và bản mà poller
thực sự dùng không thể lệch nhau:

```bash
cd mirror-request
npx ts-node src/ops/verifyRegistrationsView.ts --emit-sql
```

Bản đã sinh sẵn nằm ở `docs/migrations/06-registrations-view.sql`. Kịch bản
cutover đầy đủ — kèm cả kiểm tra tiền đề và ghi chú quyền — ở
`docs/migrations/06-cutover.sql`. Chi tiết từng dòng: **OPS-RUNBOOK §10**.

Việc cần làm, theo thứ tự:

1. Chạy `06-cutover.sql`. Nó tạo hai VIEW với `DEFINER = 'ets_web'@'127.0.0.1'`
   và `SQL SECURITY DEFINER` — đó là cơ chế cho phép tài khoản service đọc
   được dữ liệu đã lọc mà không có quyền nào trên `ets_web`.
2. Kiểm quyền, và **chỉ cấp đúng mức này**:

   ```sql
   SHOW GRANTS FOR 'extension_service_ro'@'%';
   -- mong đợi: USAGE ON *.*  +  SELECT ON `photobooth`.*
   -- KHÔNG được có bất kỳ quyền nào trên ets_web
   ```

3. Đối chiếu VIEW với code — bước này bắt lỗi khi ai đó sửa VIEW bằng tay:

   ```bash
   npx ts-node src/ops/verifyRegistrationsView.ts --source=view
   ```

   Hoặc dùng bản đã build: `node dist/ops/verifyRegistrationsView.js --source=view`.

### Một điều cần biết về `registered_at`

Poller dùng con trỏ `WHERE registered_at > ?` — **lớn hơn tuyệt đối**. Nếu hai
người có cùng `registered_at` và ranh giới lô 50 dòng rơi đúng vào giữa họ,
người thứ hai bị bỏ vĩnh viễn.

D-01 đã lường trước: VIEW cố ý lấy `registered_at` từ
`event_manager_attendance.created_at` (giờ check-in từng vé) **thay vì**
`ticketing_order.created_at` — vì một đơn mua nhiều vé sẽ cho các vé trùng
dấu thời gian y hệt. Có `ORDER_TIE_CONTROL_SQL` trong
`src/ops/registrationsViewSql.ts` để đo cái tie đó.

Kiểm trên dữ liệu thật ngày 2026-08-17: **23 bản ghi, không mốc nào trùng**.
Rủi ro chỉ mở ra khi một nhịp 3 giây có hơn 50 người check-in cùng lúc. Nếu
sự kiện của bạn có quy mô đó, chạy lại truy vấn kiểm tra tie trước khi mở
cửa.

---

## 3. Bước 2 — Cấu hình `.env` của máy chủ

File: `mirror-request/.env`. **Chứa bí mật thật** — không commit, không in ra
log, không dán vào chat.

`NODE_ENV=production` bật **fail-fast**: thiếu bất kỳ khoá nào dưới đây thì
process không chạy sai, nó **không chạy**. Đó là thiết kế (D-09/D-13) — cấu
hình sai an ninh phải làm service chết ngay chứ không âm thầm mở cửa. Hệ quả
thực tế: nếu bạn `pm2 start` khi chưa đủ khoá, nó crash-loop tới
`max_restarts: 10` rồi dừng.

### Bốn khoá bắt buộc — production sẽ từ chối khởi động nếu thiếu

| Khoá | Nội dung | Ghi chú |
|---|---|---|
| `WEBHOOK_HMAC_SECRET` | 64 ký tự hex | Sinh bằng `openssl rand -hex 32` |
| `PROXY_IP_WHITELIST` | IP thật của reverse proxy | Để nguyên mặc định `127.0.0.1` **cũng bị từ chối** — fail-fast kiểm cả trường hợp này |
| `DISPLAY_IP_WHITELIST` | IP các máy chạy màn hình phòng | Không có mặc định hợp lý nào, nên rỗng = bị từ chối |
| `CMS_IP_WHITELIST` | IP laptop người vận hành | **Danh sách riêng**, không phải `DISPLAY_IP_WHITELIST`. Dùng chung một danh sách thì hoặc khoá người vận hành ra ngoài, hoặc phơi CMS cho mọi cái TV |

### Các khoá cần đặt nhưng không có fail-fast

| Nhóm | Khoá |
|---|---|
| Agent | `AGENT_WS_TOKEN` (Bearer token, so sánh bằng `timingSafeEqual`) |
| MySQL | `DB_HOST` `DB_PORT` `DB_NAME` `DB_USER` `DB_PASSWORD` |
| CMS | `CMS_USERNAME` `CMS_PASSWORD_HASH` — xem §6 |
| Email | `SMTP_HOST` `SMTP_PORT` `SMTP_SECURE` `SMTP_USER` `SMTP_PASS` `EMAIL_FROM` |
| SMS | `TWILIO_ACCOUNT_SID` `TWILIO_AUTH_TOKEN` `TWILIO_FROM_NUMBER` |
| Lưu trữ | `LOCAL_STORE_PATH` (mặc định `./data/extension-service.sqlite`) |
| Buồng chụp | `RETAKE_GRACE_MS` (mặc định `20000`) — xem chi tiết ngay dưới đây |

#### `RETAKE_GRACE_MS` — ân hạn retake (Phase 11)

Mặc định **`20000`** (đơn vị **mili-giây**, tức 20 giây). Đây là khoảng chờ
sau khi khách rời màn hình chia sẻ mà **CHƯA duyệt** (chưa bấm in): trong
khoảng đó booth vẫn giữ khách hiện tại, khách kế tiếp **không** được gọi lên.
`session_start` mới trong khoảng đó = khách đang chụp lại (retake); hết
khoảng đó mà không có `session_start` mới = khách đã bỏ đi, job chốt qua cửa
ân hạn (`approved_by=grace`, xem OPS-RUNBOOK §14).

Con số 20s được chọn bằng **gấp 1.6 lần khoảng nghỉ retake lớn nhất đo được
trên booth thật** (12.3 giây, `07-EVIDENCE-dslrbooth-triggers.md` mục D) —
không phải một con số tuỳ ý.

**Đọc một lần lúc khởi động tiến trình, không có fail-fast riêng cho nó.**
Đổi giá trị này trong `.env` giữa lúc sự kiện đang chạy cần **khởi động lại
(restart)** tiến trình — **không cần build lại** (`pm2 delete` + `start` lại,
xem bẫy pm2 ở §5) — chứ `pm2 restart` một mình hay tín hiệu `SIGHUP` (§9,
mục 4) đều **không** nạp lại giá trị mới: `SIGHUP` chỉ nạp lại `LOG_LEVEL`,
không nạp lại khoá này.

Đánh đổi khi hạ số này: cửa sổ ân hạn là thứ duy nhất ngăn khách kế tiếp bị
gọi lên trong lúc khách hiện tại còn đang cân nhắc chụp lại — hạ ngắn nó là
hạ ngắn đúng khoảng bảo vệ đó, đổi lấy khách kế được gọi sớm hơn nếu khách
hiện tại đúng là đã bỏ đi.

Còn lại đều có mặc định đúng ngay: `PORT=3002`, `HOST=0.0.0.0`,
`DB_POLL_INTERVAL_MS=3000`, `DB_POLL_BATCH_SIZE=50`,
`SESSION_TIMEOUT_MS=300000`, `BOOTH_RELEASE_TIMEOUT_MS=120000`,
`STATUS_RATE_LIMIT_MAX=30`/phút/IP, `CMS_LOGIN_RATE_LIMIT_MAX=10`/15 phút/IP.
Bảng đầy đủ kèm thông điệp lỗi từng khoá: **OPS-RUNBOOK §3**.

Đặt `NOTIFY_WEBHOOK_URL=` (trống) — `web-slide` đã ngưng.

### Kiểm cấu hình *trước* khi start, để không crash-loop

```bash
cd mirror-request
NODE_ENV=production node -e "require('dotenv').config();require('./dist/config').loadConfig();console.log('config OK')"
```

Bước này đáng làm mọi lần: nó biến một crash-loop 10 lần thành một dòng chữ.

---

## 4. Bước 3 — Build, seed con trỏ, chạy thử

```bash
cd mirror-request
npm ci
npm run build            # tsc -> dist/
npm test                 # 82 file, 967 test
npm run lint             # 0 lỗi (12 cảnh báo là baseline đã ghi nhận)
```

**Seed con trỏ trước lần chạy đầu tiên.** Nếu không, poller thấy con trỏ rỗng,
lấy mốc `1970-01-01` và nạp lại **toàn bộ** lịch sử đăng ký thành hàng chờ:

```bash
node dist/ops/seedRegistrationsCursor.js
```

Chi tiết: **OPS-RUNBOOK §10** (mục seed cursor).

Chạy thử một lần ở foreground để đọc log khởi động bằng mắt:

```bash
npm start
```

Hai dòng cần thấy (nguyên văn từ `src/index.ts`):

```
Extension Service ready on 0.0.0.0:3002
DB poller connected: <host>:3306/photobooth
```

Dòng thứ ba nhắc rằng đổi `LOG_LEVEL` chỉ cần **SIGHUP**, không cần restart.

Nếu thấy `DB poller skipped: DB_USER not configured` hoặc
`DB poller: mysql2 not available` — poller **không chạy**, và nó chỉ `warn`
chứ không crash (D-05). Đây là kiểu lỗi im lặng nhất của hệ thống này: web
vẫn phục vụ, CMS vẫn vào được, chỉ là không ai vào hàng chờ. Đọc log, đừng
chỉ xem process có `online` không.

Ctrl-C, sang bước sau.

---

## 5. Bước 4 — Chạy dưới pm2

```bash
cd mirror-request
pm2 start ecosystem.config.js       # env: NODE_ENV=production
pm2 save
```

Có sẵn `--env staging` (`NODE_ENV=staging`) cho buổi tổng duyệt trên máy chưa
có bí mật thật. **Không dùng cho sự kiện thật**: nó tắt xác thực chữ ký
webhook và tắt cả hai IP allow-list.

### Cái bẫy của pm2 mà dự án này đã đạp phải một lần

pm2 **ghi nhớ biến môi trường ở thời điểm `start`** và giữ nguyên qua mọi
`restart` sau đó. Đổi `.env` rồi `pm2 restart` là **không đủ** — process vẫn
mang `NODE_ENV` cũ. Muốn đổi thật:

```bash
pm2 delete mirror-service
pm2 start ecosystem.config.js
pm2 save
```

Xác nhận bằng `pm2 env 0 | grep NODE_ENV`, đừng tin `pm2 list`.

### Còn treo: tự khởi động sau khi reboot

```bash
pm2 startup systemd        # cần sudo, in ra một câu lệnh để chạy lại
pm2 save
```

**Chưa làm** (cần sudo). Hiện tại `/etc/systemd/system/pm2-*.service` không
tồn tại, nghĩa là **máy chủ reboot thì service không tự lên**. Làm việc này
trước sự kiện.

---

## 6. Bước 5 — CMS cho người vận hành

Mật khẩu lưu dạng scrypt salted (`salt:hash` hex). **Không bao giờ để plaintext**
trong `.env`:

```bash
cd mirror-request
npm run cms:hash-password        # gõ mật khẩu ở prompt
```

Truyền mật khẩu bằng tham số dòng lệnh **bị từ chối** — để nó không rơi vào
shell history. Dán kết quả vào `CMS_PASSWORD_HASH`, đặt `CMS_USERNAME`, rồi
`pm2 delete` + `start` lại (xem bẫy ở §5).

Vào `http://<máy-chủ>:3002/cms` từ một IP nằm trong `CMS_IP_WHITELIST`. Hai
lớp bảo vệ theo đúng thứ tự: chặn IP trước, đòi session sau.

Trong CMS, tạo sự kiện và đặt nó thành sự kiện đang phát. Chi tiết: **OPS-RUNBOOK §12**.

Dashboard có dải `/health` ở đầu trang — dùng nó thay vì `curl` khi cần xem
nhanh trạng thái.

---

## 7. Bước 6 — Agent trên máy booth

### 7a. Build (trên máy build, không phải máy booth)

```bash
cd dslrbooth-agent
npm ci
npm run build
./scripts/build-win.sh
```

Ra ba artifact trong `release/` (bản 1.0.0 đã build sẵn ngày 2026-08-13):

- `dslrbooth-agent-Setup-1.0.0-x64.exe` — **bản nên dùng** cho máy booth cố định
- `dslrbooth-agent-Portable-1.0.0-x64.exe` — không cần cài
- `dslrbooth-agent-1.0.0-x64.zip` — để soi thủ công / chuyển máy tách mạng

Mọi artifact đều **không có chữ ký số**. Không có certificate, nên thứ duy
nhất chứng minh nguồn gốc là digest của builder image trong
`release/.builder-image-digest`:

```
electronuserland/builder@sha256:41ae540902461b6cbc988987db79547fcc10cda04d2a6c6367504f59d4b37c64
```

Chuyển sang máy booth bằng kênh bạn kiểm soát được (USB của bạn, copy trực
tiếp) — **không qua hộp thư**. Runbook Agent **§1**.

### 7b. Cài trên máy booth

Windows sẽ hiện cảnh báo SmartScreen vì file không có chữ ký. Đường click
chính xác nằm ở **runbook Agent §2**; nếu máy bật **Smart App Control** thì
**không có cách override cho từng ứng dụng** — §3 nói rõ.

Cấu hình lần đầu qua form trong ứng dụng, cần bốn giá trị:

| Trường | Giá trị |
|---|---|
| `EXTENSION_SERVICE_WS_URL` | `ws://<ip-máy-chủ>:3002/agent` |
| `EXTENSION_SERVICE_WS_TOKEN` | đúng `AGENT_WS_TOKEN` ở §3 |
| `DSLRBOOTH_API_PORT` | `1500` (mặc định của dslrBooth) |
| `DSLRBOOTH_PASSWORD` | mật khẩu Local API của dslrBooth |

**Đây là chỗ duy nhất trong toàn hệ thống có một URL được cấu hình** — và nó
nằm ở phía Agent, không hardcode trong code máy chủ.

Cấu hình và log ở:

```
%APPDATA%\dslrbooth-agent\config.json
%APPDATA%\dslrbooth-agent\logs\app-<YYYY-MM-DD>.log
```

Tên thư mục là `dslrbooth-agent`, **không** phải `dslrBooth Agent` — cái sau
chỉ là tên installer và shortcut. Sai chỗ này đã làm một người vận hành kết
luận ứng dụng không ghi log nào (UAT-02). Dán đường dẫn vào `Win+R` thay vì
gõ tay.

Bí mật trong `config.json` được bọc qua Windows credential store (DPAPI qua
`safeStorage`); nếu không dùng được thì lưu thô **kèm cảnh báo trong log**,
không bao giờ âm thầm.

### 7c. Hành vi cần biết

- Bấm **X** là **thu xuống tray**, relay vẫn chạy. Cố ý — một relay chết vì
  ai đó đóng cửa sổ là lỗi hạng D9-07 mà dự án coi là không chấp nhận được.
- **Quit** chỉ có trong menu chuột phải ở tray.
- Hai ô **"tự chạy relay khi mở app"** và **"khởi động cùng Windows"** độc
  lập, **cả hai bật mặc định**.

Runbook Agent **§5, §6**.

### 7d. Tắt auto-print trên dslrBooth (bước cấu hình bắt buộc — tiền đề Phase 11)

Đây là một **bước thiết lập**, không phải một ghi chú kiểm thử — làm cùng
lúc với 7b, trên cùng máy booth, trước khi máy chạy sự kiện thật:

1. Trong dslrBooth, trên chính máy booth: mở màn **Printing** và **tắt Auto
   Print** (tên đúng của tuỳ chọn tuỳ bản dslrBooth — tìm mục "auto print"
   trong màn Printing/Settings).
2. **Kiểm ngay tại chỗ, cùng bước này:** chạy một phiên chụp thử và **không
   bấm in**. Kỳ vọng: log Agent (`%APPDATA%\dslrbooth-agent\logs\app-<ngày>.log`,
   xem §7b) của phiên đó **không có** dòng nào mang sự kiện `printing`.

Vì sao bắt buộc: chỉ khi auto-print **TẮT** thì sự kiện `printing` mới có
nghĩa là khách đã **duyệt** tấm ảnh (D11-03, `11-CONTEXT.md`) — bật auto-print,
`printing` bắn ngay sau composite đầu tiên bất kể khách có chụp lại hay
không, và mọi guarantee Phase 11 xây (retake không mất phiên, không gửi nhầm
ảnh, không gọi khách kế quá sớm) không còn đúng. Hành vi đo được khi auto-print
BẬT (`07-EVIDENCE-dslrbooth-triggers.md` mục C, pin lại bằng test trong
`mirror-request/test/queue-retake-anchor.test.ts`) và toàn bộ mô hình attempt
mới: **OPS-RUNBOOK §14**.

---

## 8. Bước 7 — Màn hình phòng

Mỗi máy chạy màn hình mở trình duyệt full-screen tới:

```
http://<máy-chủ>:3002/display-screen
```

IP của máy đó **phải** nằm trong `DISPLAY_IP_WHITELIST`. Danh sách được kiểm
**trước** khi nâng cấp lên WebSocket, nên IP sai sẽ nhận 403 chứ không phải
một kết nối treo. Nếu màn hình trắng, kiểm allow-list trước mọi thứ khác.

Trang tự kết nối `WS /display` và nhận snapshot mỗi **250 ms**. Font **tự
host** từ `/assets/fonts`, không gọi CDN nào — để màn hình vẫn vẽ được khi
wifi hội trường chết.

Hai công tắc hiển thị và chế độ chỉ-slide: **OPS-RUNBOOK §9 và §13**.

---

## 9. Bước 8 — Kiểm tra trước khi mở cửa

Theo thứ tự này, mỗi bước xác nhận một mắt xích:

```bash
# 1. Service sống và tự đánh giá được
curl -s localhost:3002/health

# 2. Poller có thật đang đọc DB
grep "DB poller connected" mirror-request/logs/*.log | tail -1

# 3. Agent đã kết nối
grep -i "agent" mirror-request/logs/*.log | tail -5

# 4. Đổi mức log không cần restart
pm2 sendSignal SIGHUP mirror-service
```

`/health` trả **200 kể cả khi degraded** — nội dung mới là thứ phải đọc, đừng
chỉ xem HTTP status. Nó cảnh báo khi buồng giữ một job ở `dispatched`/
`in_progress` quá **150 giây** (lâu hơn hẳn một lượt chụp), và câu cảnh báo
có **nêu job id** để tra được ở `/status/:jobId`.

4. **Một lượt chụp thật, từ đầu đến cuối** — đăng ký thật → buồng chụp →
   ảnh lên màn hình phòng → khách nhận email/SMS. Đây là phép thử duy nhất
   không có gì thay thế được. **Chưa làm** (UAT bước 8, xem §11).

5. **Retake — Phase 11 đã đóng ở mã nguồn (87/87 file test, 1041/1041 test
   xanh); việc còn treo là năm kịch bản chạy tay trên booth thật, chưa chạy.**
   Đo trực tiếp trên booth ngày 2026-08-18
   (`07-EVIDENCE-dslrbooth-triggers.md` §C/D/E) cho thấy retake trên màn chia
   sẻ là **một phiên dslrBooth mới** (`session_end` → `session_start`), và mỗi
   lần chụp — kể cả lần bị loại — đều upload composite riêng lên fotoshare.
   Phase 11 xây một mô hình "một job = nhiều lần chụp (attempt), một lần được
   duyệt" đúng cho cả ba đường:

   - **Retake (khách chụp lại rồi bấm in):** booth **không** nhả cho khách kế
     tiếp ngay khi khách hiện tại rời màn hình chia sẻ mà chưa duyệt — nó mở
     một cửa sổ ân hạn (`RETAKE_GRACE_MS`, §3) thay vì nhả ngay.
     `session_start` mới trong cửa sổ đó = retake hợp lệ: attempt cũ bị huỷ,
     attempt mới mở, job vẫn giữ nguyên booth. Khách chỉ nhận **đúng một**
     ảnh — của lần chụp cuối cùng được duyệt — không bao giờ là tấm bị loại.
   - **Bỏ đi không in (walk-away):** hết `RETAKE_GRACE_MS` mà không có
     `session_start` mới → job chốt qua cửa ân hạn (`approved_by=grace`), gửi
     ảnh cuối cùng đang giữ nếu có, rồi mới nhả booth cho khách kế.
   - **In lại ảnh cũ từ thư viện (gallery reprint) trong lúc khách khác đang
     đứng ở booth:** bị từ chối và ghi log rõ lý do (`printing ignored:
     composite … is not this attempt's …`); không chốt gì, khách đang đứng ở
     booth không bị ảnh hưởng.

   Operator còn có một cửa thứ ba, chủ động: nút "Kết thúc khách này" trên
   CMS (`POST /cms/api/booth/release`) — chốt ngay lập tức, không cần chờ ân
   hạn, ghi `approved_by=operator`. Mô hình attempt đầy đủ, ba cửa duyệt, năm
   token log mới và cách trả lời khiếu nại của khách: **OPS-RUNBOOK §14**.

   **Cái còn thiếu, và cách nó được đóng:** mọi khẳng định ở trên được chứng
   minh bằng test replay đúng chuỗi trigger đã đo (§C/D/E), chưa test nào
   chạy trên camera thật. Gate còn lại — bắt buộc trước khi chạy sự kiện thật
   — là năm kịch bản trên booth thật, auto-print **TẮT** (§7d), một khách thứ
   hai thật sự đang xếp hàng, đúng như `11-CONTEXT.md` <verification> ghi:
   retake + khách 2 đang chờ; bỏ đi không in; in lại ảnh cũ trong lúc khách
   khác chụp; operator kết thúc; layout 1 kiểu và 4 kiểu. Đây không phải việc
   mã nguồn tự chứng minh được — cần người chạy tay ở booth. Kết quả ghi ở
   `.planning/phases/11-retake-approval-anchor/11-VALIDATION.md`.

   Việc còn treo từ trước, không đổi bởi Phase 11: ghi lại **phiên bản
   dslrBooth** (About) trên máy booth — `/api/cancel` (Deferred, xem
   OPS-RUNBOOK §14) chỉ đáng tin từ v8.3.0.

   Tiền đề chung cho mọi bài test có Agent (không đổi bởi Phase 11): không
   được còn job nào `queued` trước khi Agent kết nối, nếu không lần đầu buồng
   lên sóng sẽ dispatch một phiên chụp không có ai đứng đó. Kiểm bằng:

   ```bash
   node -e "const D=require('better-sqlite3');const db=new D('./data/extension-service.sqlite',{readonly:true});
   console.log(db.prepare(\"SELECT id FROM queue_job WHERE status='queued'\").all())"
   ```

   Ngày 2026-08-17: rỗng (`3X818VEJ` đã `failed`, `stall_reason =
   manual_operator_stop`). Chi tiết: **OPS-RUNBOOK §6**.

6. Đóng app Agent về tray, rồi reboot máy booth và xác nhận relay tự lên
   (UAT bước 9, 10 — **chưa làm**).

### Đã đo dưới tải, để bạn biết ngưỡng ở đâu

Kiểm tải toàn trình đã chạy trên chính stack này:

| Tình huống | Kết quả |
|---|---|
| 60 khách / 12 màn hình | 60/60 ảnh, 152 đăng ký/giây, 0 request bị từ chối, CPU 13.5% |
| 400 đăng ký @ 100 luồng / 30 màn hình | 141/giây, 0 từ chối, CPU 34.7% (sau khi sửa) |
| Chụp → hiện lên tường | p50 132 ms |
| Trang tra cứu | p50 8 ms qua 25.860 request |
| Fan-out theo số màn hình | CPU **phẳng** — snapshot dựng và `JSON.stringify` một lần mỗi nhịp, gửi cùng một chuỗi cho mọi màn hình |

Thứ tự hàng chờ khi nhiều người đăng ký cùng một mili-giây: **ổn định** (1
thứ tự duy nhất qua 200 lần đọc), **khớp thứ tự đến**, đúng dưới cả hai cách
SQLite sắp xếp. Chống trùng khi một khách bấm gửi 3 lần đồng thời: luôn ra
đúng một jobId.

Lưu ý về `STATUS_RATE_LIMIT_MAX=30`/phút/IP: nếu khán giả cùng ra Internet qua
**một NAT**, họ dùng chung hạn mức đó. Có mạng khách kiểu vậy thì nâng giá
trị này trước sự kiện.

---

## 10. Khi cần lùi lại

| Lùi cái gì | Cách |
|---|---|
| Máy chủ | `pm2 stop mirror-service`. Dữ liệu nằm trong SQLite tại `LOCAL_STORE_PATH`, không mất |
| VIEW MySQL | `docs/migrations/06-rollback-registrations-table.sql` — có ghi cả baseline quyền trước cutover |
| Agent | Runbook Agent **§8** |
| Job kẹt | **OPS-RUNBOOK §6** |

Đổi mức log **không cần redeploy**: **OPS-RUNBOOK §11**.

---

## 11. Trạng thái thật ngày 2026-08-17, và việc còn treo

Đang chạy:

- `mirror-service` online dưới pm2, uptime 10 giờ, RSS 85 MB, `NODE_ENV=production`
- DB poller đã kết nối `localhost:3306/photobooth`, 23 bản ghi trong VIEW
- Agent 1.0.0 đã build, artifact nằm trong `release/`

Còn treo — **cần xử lý trước sự kiện thật**:

1. **`pm2 startup systemd` chưa chạy** (cần sudo). Máy chủ reboot là service không tự lên.
2. **Chưa cài Agent lên máy booth thật.** UAT bước 8 — một lượt chụp thật — là phép thử quyết định phase 10 và vẫn chưa có.
3. UAT bước 9 và 10 (đóng về tray, reboot cùng Windows) chưa xác nhận.
4. Chưa ghi lại nguyên văn câu cảnh báo SmartScreen thấy trên máy booth thật.
5. Bốn job `agent_nak` cũ có lý do lỗi không còn truy được — dữ liệu lịch sử, không ảnh hưởng vận hành.
6. **Phase 11 (retake) đã đóng ở mã nguồn** (87/87 file, 1041/1041 test xanh,
   `npm run typecheck`/`npm run build` sạch) **nhưng chưa đóng ở booth thật.**
   Năm kịch bản gate ở `11-CONTEXT.md` <verification> chưa chạy — cần auto-print
   TẮT (§7d) và một khách thứ hai thật sự đang xếp hàng. Xem §9 mục 5 và
   OPS-RUNBOOK §14. **Không chạy sự kiện thật cho tới khi gate này ghi kết
   quả** ở `.planning/phases/11-retake-approval-anchor/11-VALIDATION.md`.

Ưu tiên thấp hơn, đã ghi nhận:

- 12 cảnh báo lint để làm baseline
- Thêm tiebreaker `, rowid ASC` vào thứ tự hàng chờ để biến hành vi đúng-trên-thực-tế thành cam kết tường minh
- Người vận hành **không có màn hình nào xem được hàng chờ** — CMS chỉ đọc `getQueueLength()`, tức một con số. Khách phàn nàn chờ lâu thì không tra được họ đang ở vị trí nào
- Rủi ro NAT của rate limit theo IP (§9)

---

## 12. Checklist một trang

```
MySQL
  [ ] chạy 06-cutover.sql, hai VIEW tạo xong
  [ ] SHOW GRANTS — chỉ SELECT trên photobooth, không quyền nào trên ets_web
  [ ] verifyRegistrationsView.ts --source=view  → khớp

Máy chủ
  [ ] .env đủ 4 khoá bắt buộc (không để PROXY_IP_WHITELIST mặc định)
  [ ] dry-run loadConfig() → "config OK"
  [ ] npm ci && npm run build && npm test
  [ ] seedRegistrationsCursor.js  ← trước lần start đầu tiên
  [ ] pm2 delete + start + save (đừng chỉ restart)
  [ ] pm2 startup systemd   ← đang thiếu
  [ ] log có "DB poller connected"

CMS
  [ ] cms:hash-password, đặt CMS_USERNAME + CMS_PASSWORD_HASH
  [ ] vào /cms được từ IP trong CMS_IP_WHITELIST
  [ ] tạo sự kiện và đặt đang phát

Agent
  [ ] cài từ artifact chuyển qua kênh tin cậy, digest đã đối chiếu
  [ ] cấu hình 4 trường, relay báo connected trong log máy chủ
  [ ] hai ô tự khởi động đang bật
  [ ] ghi lại phiên bản dslrBooth (About) — /api/cancel chỉ đáng tin từ v8.3.0

Màn hình
  [ ] mỗi IP màn hình có trong DISPLAY_IP_WHITELIST
  [ ] /display-screen vẽ được ở chế độ full-screen

Trước khi mở cửa
  [ ] curl /health — đọc nội dung, không chỉ xem 200
  [ ] MỘT LƯỢT CHỤP THẬT, trọn vẹn tới email/SMS   ← chưa làm
  [ ] không còn job nào 'queued' trước khi Agent kết nối
  [ ] auto-print TẮT trên MỌI máy booth (bắt buộc, §7d) — kiểm: 1 phiên
      không bấm in → log Agent không có dòng `printing`
  [ ] Phase 11 (retake) đã xanh ở mã nguồn — gate 5 kịch bản trong 11-CONTEXT
      chưa chạy trên booth thật, xem §9 mục 5 / §11 mục 6 / OPS-RUNBOOK §14
  [ ] reboot máy booth, relay tự lên               ← chưa làm
  [ ] cân nhắc nâng STATUS_RATE_LIMIT_MAX nếu khách đi qua một NAT
```
