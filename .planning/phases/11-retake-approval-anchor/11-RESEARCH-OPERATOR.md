# Phase 11: Retake & Approval Anchor — Research

**Researched:** 2026-08-18
**Status:** Ready for context/planning
**Nguồn số 1:** `07-EVIDENCE-dslrbooth-triggers.md` mục C/D/E (đo 2026-08-18).
Mọi thứ dưới đây phải khớp với file đó; tài liệu vendor mâu thuẫn với nó thì
tài liệu sai (nguyên tắc của Phase 7, giữ nguyên).

---

## 1. Tài liệu vendor đã đọc

| Nguồn | Có gì | Kết luận cho phase này |
|---|---|---|
| [Triggers (Webhooks) and API — Lumasoft help center](https://support.lumasoft.co/en/articles/12831651-triggers-webhooks-and-api) | 10 event_type + param của từng loại. `processing_start`: `param1: original_photo_filenames (optional), param2: final_file`. `printing`: `file, num_copies, printer_name`. `file_upload`: `file, url, file_type, album_name`. `session_end`: "when sharing screen completes and start screen is about to display". | **Không có event retake/cancel/review nào.** Không có cam kết thứ tự/thời gian. Composite trong `processing_start` là **param cuối** — layout N kiểu → paramN+1. |
| [dslrBooth for Windows API — Postman](https://documenter.getpostman.com/view/5516194/UVRBnmJ5) (đọc qua collection JSON) | `GET /api/start?mode=`, `/api/print?count=`, `/api/share/email`, `/api/share/sms`, `/api/lockscreen/show`, `/api/lockscreen/hide`. Password là GET param. `/api/start` **lỗi nếu không ở start screen**. | Không có endpoint **status/state**. Không có **cancel** trong tài liệu (xem dòng dưới). Server không thể hỏi dslrBooth "đang ở màn nào" — chỉ suy từ trigger. |
| [Release notes LumaBooth for Windows](https://dslrbooth.com/releases/lumabooth_windows/) — mới nhất v8.3.1 (2026-08-12) | v8.3.0: "`/api/cancel` command now works correctly instead of returning 'Invalid command specified'". v8.3.1: "camera could no longer be triggered after pressing Cancel or Retake". v8.1.28: "cancel button now appears during photo review". | **Có `/api/cancel`, chỉ đáng tin từ v8.3.0.** Có HAI nút riêng: *Cancel* trong pha review, *Retake* trên màn chia sẻ. Đo hôm nay là nút Retake. |
| [LumaBooth v3.3 blog](https://dslrbooth.com/blog/lumabooth-v3-3) (bản iPad, operator gửi) | "Allow guests to retake their session while on the sharing screen. Retaking the session will delete the current session's photos, videos, and final strip." Không nói gì về trigger. | Xác nhận ngữ nghĩa: retake trên màn chia sẻ = **huỷ phiên cũ, mở phiên mới**. Khớp với chuỗi `session_end → session_start` đo được trên Windows. Nếu Windows cũng xoá file thì URL fotoshare của tấm bị loại có thể chết — thêm một lý do không bao giờ gửi nó. |

## 2. Những gì code hiện tại giả định, và giả định nào vỡ

| Vị trí | Giả định | Trạng thái sau 2026-08-18 |
|---|---|---|
| `07-CONTEXT.md` D-01 | "retake nằm trong pha chụp, trước `processing_start`, nên không chạm được mốc composite" | **VỠ.** Retake trên màn chia sẻ đi qua `session_end`/`session_start` và sinh composite + upload print riêng. |
| `queueService.ts:328` `sessionEnded()` | `session_end` = nhả booth ngay, `tick()` gọi khách sau | **VỠ** khi retake: nhả giữa chừng, khách kế bị dispatch, khách cũ mồ côi → `sweepNoPhotoJobs` đóng `no_photo`. |
| `queueService.ts:422` `onPrintComposite()` | composite đầu tiên = job xong; `completeJob` một lần | **VỠ**: composite đầu là tấm bị loại. Job đóng sớm, mọi thứ sau đó là "arrived after the job was already closed". |
| `queueService.ts:431` `param5` cho `processing_start` | layout 4 kiểu | **VỠ** với layout 1 kiểu (param2). Trượt 4/4 lần hôm nay. |
| `queueService.ts:942` `onFileUpload()` + `localStore.ts:1218` `resolvePendingPrint` | upload print đầu tiên = ảnh của khách; lần hai là replay → no-op im lặng | **VỠ**: upload đầu là tấm bị loại → gửi nhầm; tấm đúng bị nuốt không log. |
| `localStore.ts:1178` `openPendingPrint` ON CONFLICT DO NOTHING | double-fire `processing_start`/`printing` cùng composite | Đúng cho double-fire, **sai cho retake** (composite mới phải đè composite cũ). |
| D-07 slot mở ở `processing_start` | upload có thể tới trước `session_end` | **VẪN ĐÚNG**, và càng quan trọng hơn: với auto-print tắt, upload tới **trước** `printing` 6s. Slot phải mở sớm như cũ. |
| D-04/D-06 gán theo `booth_state.current_job_id`, id trong event chỉ cross-check | Agent đóng dấu id cũ, không xoá | **VẪN ĐÚNG**, giữ nguyên. |
| `printing` là mốc hoàn thành ngang hàng `processing_start` | cả hai mang cùng composite | **Đảo vai trò**: `printing` giờ là tín hiệu **duyệt** (chỉ với auto-print tắt), không còn là mốc "có composite". |

## 3. Bản đồ code cần chạm (Extension Service only)

```
src/queue/queueService.ts   (1153 dòng)
  sessionEnded()            :328   → không nhả ngay; xét đã-duyệt / mở ân hạn
  sessionAckedFromEvent()   :387   → session_start khi đang ân hạn = retake: huỷ ân hạn, mở attempt mới
  onPrintComposite()        :422   → tách: processing_start = mở/ĐÈ slot; printing = duyệt (có điều kiện)
  onFileUpload()            :942   → chỉ GHI url vào slot, không gửi
  sweepPendingPrints()      :745   → expiry giờ = "khách bỏ đi không in" hoặc "upload không bao giờ tới"
  logSessionSummary()       :684   → thêm attempts=N, approved_by=printing|grace|operator
  agentEventDetail()        :610   → composite của processing_start = param cuối, không param5

src/state/localStore.ts     (1677 dòng)
  pending_print             :267   → thêm cột: photo_url, attempt_no, approved_at, approved_by; upsert đè
  booth_state                       → thêm cột: attempt_open (0/1), attempt_composite? (hoặc bảng riêng)
  resolvePendingPrint()     :1218  → thành finalizePendingPrint(); vẫn là cổng idempotent, nhưng theo attempt

src/config.ts                → RETAKE_GRACE_MS (mặc định 20_000, đọc lại được qua SIGHUP như LOG_LEVEL?)

src/cms/                     → route mới: POST /cms/api/booth/release  (operator "kết thúc khách này")
                               + nút trên trang CMS đang có (cmsPages.ts) — chỉ khi booth BUSY/ân hạn

test/                        → test/queue-retake-anchor.test.ts hiện pin sai giả định → viết lại theo C/D/E
```

Không chạm: `dslrbooth-agent` (D-05 Phase 7 giữ nguyên; `/api/cancel` để Deferred),
ingestion, notification delivery, display feed protocol.

## 4. Con số

| Đại lượng | Đo được | Nguồn |
|---|---|---|
| Khoảng nghỉ retake `session_end → session_start` | 3.3s, 12.3s | C, D |
| `processing_start → file_upload print` | 5.2s (C1), 5.5s (C2), 5.2s (D1), 4.2s (D2) | C, D |
| `file_upload print → printing` (auto-print tắt) | 5.6s | D2 |
| `printing → session_end` | 4.6s (C1), 2.7s (C2), 4.8s (D2), 0.4s (E) | C, D, E |
| `session_end → file_upload print` (upload sau end) | +0.5s (C1), +1.7s (C2) | C |
| Timer đang có | `SESSION_TIMEOUT_MS`=300 000, `BOOTH_RELEASE_TIMEOUT_MS`=120 000, `PENDING_PRINT_EXPIRY_MS`=600 000 (floor 307 000, `queueService.ts:30-33`) | `config.ts:132,140` |

→ Ân hạn 20s > 12.3s × 1.5, và nhỏ hơn 15 lần so với 5 phút mà hệ thống đang
chấp nhận treo cho khách bỏ dở.

## 5. Câu hỏi còn mở, ai trả lời

| # | Câu hỏi | Ai | Chặn gì |
|---|---|---|---|
| Q1 | Phiên bản dslrBooth trên booth PC (About) | operator | chỉ chặn tuỳ chọn `/api/cancel` (Deferred), không chặn phase |
| Q2 | Nút *Cancel* trong pha review bắn gì | operator, 1 phút đo | thiết kế đã bao phủ mọi chuỗi có `session_start` mới; đo để xác nhận, không để thiết kế |
| Q3 | Phiên rỗng ❶ ở C là gì | operator | quyết `session_end` không có composite có mở ân hạn không |
| Q4 | Retake trên Windows có xoá composite/URL cũ trên fotoshare không | operator, mở URL `332q1vz` | chỉ ảnh hưởng photo wall nếu ta lỡ đã ghi URL loại — thiết kế mới không ghi |
