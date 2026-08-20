# Phase 11: Retake & Approval Anchor — Context

**Gathered:** 2026-08-18 (conversation with operator, sau ba lần đo trực tiếp trên booth)
**Status:** Ready for planning
**Đọc trước:** `11-RESEARCH-OPERATOR.md` (bằng chứng + tài liệu vendor, viết tay 2026-08-18) và `11-RESEARCH.md` (researcher agent), `07-EVIDENCE-dslrbooth-triggers.md` mục C/D/E,
`07-CONTEXT.md` (những D-* nào giữ, những D-* nào bị thay ghi rõ dưới đây).

<domain>
## Phase Boundary

Làm cho **retake của khách không bao giờ làm mất phiên, không bao giờ gửi
nhầm ảnh, không bao giờ gọi khách kế tiếp lên khi khách hiện tại còn đang
đứng ở booth** — dựa trên hành vi dslrBooth ĐO ĐƯỢC ngày 2026-08-18, không
phải suy luận. Đồng thời sửa lỗi độc lập `param5` mà cùng dữ liệu đó phơi ra.

Phase 7 đã dựng đúng phần lớn cỗ máy: gán ảnh theo `booth_state.current_job_id`
(D-06), registry pending-print mở sớm ở composite (D-07/D-08), tách release
khỏi completion (D-02), vứt ảnh khi không có phiên dispatch (D-04). Phase này
**không** thay những thứ đó. Nó thay đúng hai giả định đã vỡ: (a) `session_end`
là ranh giới nhả booth an toàn, và (b) composite đầu tiên là ảnh của khách.

**Ngoài phạm vi:** `dslrbooth-agent` (không sửa — D-05 Phase 7 giữ nguyên;
`/api/cancel` ghi ở Deferred), ingestion, cơ chế gửi thông báo (Phase 4),
giao thức display feed, web-slide.

**Ràng buộc từ `mirror-request/CLAUDE.md`, không đổi:** logic ở Extension
Service; Agent là relay câm; không gọi Local API trực tiếp; không ghi DB backend.

**Yêu cầu vận hành MỚI, operator xác nhận 2026-08-18, là tiền đề của cả
phase:** **auto-print TẮT trên mọi máy booth.** Bằng chứng số 9: chỉ khi tắt
thì `printing` mới phân biệt được tấm khách lấy với tấm khách bỏ. Phải ghi vào
DEPLOYMENT.md §7/§9 và OPS-RUNBOOK như một bước cấu hình bắt buộc, có cách
kiểm (một phiên chụp không bấm in → log không có `printing`).

</domain>

<decisions>
## Implementation Decisions

### Mô hình: một job = nhiều "lần chụp" (attempt), một lần được duyệt

- **D11-01 — `session_start` mở một attempt, `session_end` đóng attempt đó.
  Attempt là đơn vị mới, nằm DƯỚI job.** Một job có ≥1 attempt; retake = mở
  attempt mới trước khi job chốt. Trạng thái "attempt đang mở" là cờ persist
  trong `booth_state` (cùng hàng với `current_job_id`, cùng cơ chế sống qua
  restart), không phải biến in-memory.
  — *Vì sao:* bằng chứng 7 và 11 — cùng một sự kiện `printing` có nghĩa khác
  nhau tuỳ đang trong attempt hay ngoài; không có cờ này thì không phân biệt
  được in-lại-ảnh-cũ (E) với duyệt.
  — *Reversibility:* costly — cột mới + logic vòng đời viết lại quanh nó.

- **D11-02 — Mốc "có ảnh" và mốc "khách duyệt" tách làm hai. `processing_start`
  = có composite (mở/ĐÈ slot pending-print, ghi composite path). `printing`
  = khách duyệt (chốt job, gửi ảnh, nhả booth ngay).** Thay D-01 Phase 7,
  trong đó `processing_start` và `printing` là hai cửa vào cùng một hành động.
  — *Vì sao:* bằng chứng 8, 9, 10. Composite đầu có thể là tấm bị loại; và với
  auto-print tắt, upload tới TRƯỚC `printing` nên slot vẫn phải mở ở
  `processing_start`.
  — *Reversibility:* costly — là trục của phase.

- **D11-03 — `printing` chỉ được coi là duyệt khi CẢ HAI: (a) attempt đang mở,
  (b) `printing.param1` trùng `composite_path` mà `processing_start` của attempt
  đó đã ghi vào slot — so theo **stem** của tên file (`YYYYMMDD_HHMMSS_mmm`),
  KHÔNG so chuỗi tuyệt đối: bằng chứng 15 đo được `_1x` ở `processing_start`
  và `_2x` ở `printing` cho cùng một composite trên layout 4 kiểu.** Sai một
  trong hai → bỏ qua, một dòng `info` ghi rõ lý do
  (`printing ignored: no attempt open` / `printing ignored: composite X is not
  this attempt's Y`).
  — *Vì sao:* bằng chứng 11 (in lại ảnh cũ từ thư viện: không có `session_start`,
  composite của phiên khác). Điều kiện (b) chặn cả ca operator in lại ảnh cũ
  **trong lúc** một attempt đang mở — (a) một mình không chặn được ca đó.

- **D11-04 — `file_upload param3=print` chỉ GHI URL vào slot của job đang gắn
  booth (đè URL cũ nếu có), KHÔNG gửi.** Gửi chỉ xảy ra khi job được chốt
  (D11-05). Bộ lọc `param3='print'` giữ nguyên. Tra slot vẫn qua registry (D-07),
  không qua booth state.
  — *Vì sao:* bằng chứng 8. Với slot ghi-đè, tấm cuối cùng thắng, và ta không
  còn phải quyết "gửi hay không" tại thời điểm upload — thời điểm mà ta chưa
  biết khách có retake không.
  — Upload `print` tới khi slot đã `finalized` (double delivery, replay) → no-op
  **có log** `info` — sửa luôn nhánh im lặng hiện tại.

- **D11-05 — Chốt job (`finalize`) có đúng ba cửa, và ghi rõ cửa nào vào
  `pending_print.approved_by`:**
  1. `printing` hợp lệ theo D11-03 → `approved_by='printing'` — đường chính,
     **0 giây chờ**.
  2. hết ân hạn (D11-06) mà không có `session_start` mới → `approved_by='grace'`,
     gửi URL cuối cùng đang giữ (nếu có).
  3. operator bấm "kết thúc khách này" trên CMS (D11-08) → `approved_by='operator'`.
  Chốt = `completeJob` (nếu có URL) hoặc `no_photo` (nếu slot chưa có URL) +
  gửi thông báo + ghi photo history + nhả booth + `tick()`. Idempotent qua
  cổng `finalizePendingPrint(jobId)` trả boolean, thay `resolvePendingPrint`.
  — *Vì sao:* một cửa duy nhất để "gửi ảnh cho khách" thì không thể gửi hai
  lần, và log của nó là chỗ duy nhất phải đọc khi có khiếu nại.

- **D11-06 — Ân hạn (`RETAKE_GRACE_MS`, mặc định 20 000, cấu hình qua `.env`):
  `session_end` của một attempt CHƯA duyệt không nhả booth; nó khởi động một
  timer. `session_start` mới trong lúc timer chạy = retake: huỷ timer, mở
  attempt mới, job giữ nguyên booth. Timer hết = cửa 2 của D11-05.**
  `session_end` của attempt ĐÃ duyệt (đã thấy `printing` hợp lệ) → nhả ngay,
  không ân hạn — thực tế với D11-05 cửa 1 booth đã nhả từ lúc `printing`.
  — *Vì sao:* bằng chứng 7 và 13 — không có cách nào phân biệt "xong" với "sắp
  chụp lại" tại `session_end`; chỉ đợi được. Khách bình thường (bấm in) không
  trả giây nào; chỉ khách bỏ đi không in mới chờ 20s, thay cho 5 phút
  `SESSION_TIMEOUT_MS` mà hệ thống đang chấp nhận hôm nay.
  — *Đánh đổi ghi nhận:* trong 20s đó, một người LẠ bấm start sẽ bị hiểu là
  khách cũ retake. Operator đã được nói rõ và chấp nhận (2026-08-18). Khoảng mơ
  hồ này vốn đã tồn tại suốt 5 phút của `SESSION_TIMEOUT_MS`; phase này nới
  thêm 20s. D11-08 là cách thu hẹp bằng mắt người.
  — Con số 20s: gấp 1.6 lần khoảng nghỉ đo được lớn nhất (12.3s). Có thể hạ
  tại sự kiện qua `.env` không cần build lại.

- **D11-07 — `processing_start` composite = param CUỐI CÙNG trỏ vào `\Prints\`;
  nếu không param nào khớp thì param có chỉ số lớn nhất không rỗng. Bỏ hardcode
  `param5`.** `printing` vẫn `param1`. Áp cho cả `agentEventDetail()` (log) lẫn
  `onPrintComposite()`.
  — *Vì sao:* bằng chứng 12 + tài liệu vendor ("param1 originals (optional),
  param2 final_file"). Độc lập với mọi quyết định khác; làm trước cũng được.

### Operator control

- **D11-08 — CMS có nút "Kết thúc khách này" (`POST /cms/api/booth/release`),
  chỉ hiển thị khi booth đang BUSY hoặc đang ân hạn, hiện tên khách + đã chờ
  bao lâu.** Bấm = D11-05 cửa 3. Đi qua đúng auth/IP gate/CSRF của CMS hiện có.
  Ghi `stall_reason`/`approved_by='operator'` để phân biệt được với timer khi
  đọc log.
  — *Vì sao:* thông tin "khách đã bỏ đi" chỉ mắt người có; nút này làm timer
  thành lưới an toàn thay vì đường chính cho ca bỏ dở. Operator yêu cầu tránh
  mọi độ trễ khi đông khách; đây là câu trả lời cho ca duy nhất còn độ trễ.

### Quan sát được

- **D11-09 — `SESSION_SUMMARY` thêm hai trường, GIỮ thứ tự cũ, chèn cuối:
  `attempts=N approved_by=printing|grace|operator|none`.** `captures` giữ nguyên
  (đếm `capture_start` qua mọi attempt). Mọi nhánh "bỏ qua" mới đều log `info`
  một dòng, không nhánh im lặng nào được thêm.

- **D11-10 — Test hiện tại `test/queue-retake-anchor.test.ts` pin đúng giả
  định đã vỡ ("retake = capture events lặp") → viết lại: fixture là chuỗi C, D,
  E nguyên văn (bỏ countdown), assert: đúng 1 thông báo với URL của attempt
  cuối; khách 2 không được dispatch trong ân hạn; E không chốt gì; layout 1
  kiểu và 4 kiểu đều tìm ra composite.**

### Giữ nguyên từ Phase 7 (không mở lại)

D-02 (release ≠ completion — giờ càng đúng), D-04 (không có phiên dispatch →
vứt), D-05 (không sửa Agent), D-06 (`current_job_id` là nguồn thật, id trong
event chỉ cross-check), D-07/D-08 (registry SQLite, mở sớm), D-11 (slot hết hạn
mà ảnh tới thì vẫn gửi — chuyển sang: slot hết hạn = ân hạn/expiry đã chốt
`no_photo`, ảnh tới sau vẫn gửi và log warn), D-14 (đếm capture).

**Bị thay:** D-01 (anchor) → D11-02/03. D-03 (`no_photo` khi không có composite)
→ giữ ngữ nghĩa nhưng thời điểm quyết là D11-05, không phải `session_end`.

</decisions>

<open_questions>
## Còn mở — không chặn planning, planner ghi vào plan như giả định

- **Q3 (RESEARCH):** `session_end` của một attempt KHÔNG có composite (phiên
  rỗng ❶ ở C — 12s không chụp) → mở ân hạn hay nhả ngay? **Giả định làm việc:
  mở ân hạn như mọi attempt chưa duyệt** — an toàn hơn; giá là 20s cho ca khách
  vào rồi ra ngay, và D11-08 xử lý được bằng tay. Đo lại ❶ để quyết dứt điểm.
- **Q2:** nút *Cancel* trong pha review. Giả định: cũng là `session_end →
  session_start` hoặc `session_start` thẳng; cả hai đều rơi vào D11-06.
- Số attempt tối đa cho một job (chống chiếm booth)? Không đặt trong phase này;
  D11-08 đủ. Ghi Deferred.
</open_questions>

<deferred>
## Deferred

- `/api/cancel` (dslrBooth ≥ v8.3.0) qua Agent như một `command` action mới —
  cho D11-08 không chỉ nhả booth phía server mà còn đá dslrBooth về start screen.
  Cần sửa Agent (vi phạm D-05 của phase này) + xác nhận version (Q1). Phase sau.
- Agent vẫn không xoá `activeJobId` (Deferred từ Phase 7, giữ).
- Giới hạn số attempt / job.
</deferred>

<verification>
## Gate trên booth thật (bắt buộc trước khi đóng phase)

Auto-print TẮT, khách A dispatch, khách B đang `queued`:
1. A chụp → Retake trên màn chia sẻ → chụp lại → bấm in. Kỳ vọng: A nhận đúng
   1 ảnh = URL attempt 2; B **không** được announce/dispatch cho tới `printing`
   của A; `SESSION_SUMMARY job=A outcome=completed captures=2 attempts=2
   approved_by=printing`.
2. A chụp → không in → bỏ đi. Kỳ vọng: sau `RETAKE_GRACE_MS` B được gọi;
   A `approved_by=grace`, nhận URL attempt cuối.
3. Trong lúc B đang chụp, operator in lại ảnh của A từ thư viện. Kỳ vọng: log
   `printing ignored: composite … is not this attempt's …`; B không bị chốt.
4. A chụp, không in, operator bấm "Kết thúc khách này". Kỳ vọng: nhả ngay,
   `approved_by=operator`.
5. Layout 4 kiểu VÀ 1 kiểu: không còn `warn … no usable composite path`.
</verification>
