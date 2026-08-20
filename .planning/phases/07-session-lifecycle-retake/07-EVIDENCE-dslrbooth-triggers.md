# Bằng chứng: chuỗi trigger thật của dslrBooth

Operator ghi lại trên máy booth, 2026-08-12. **Đây là dữ liệu đo, không phải suy
luận** — mọi thiết kế của Phase 7 phải khớp với file này, và nếu research mâu
thuẫn với nó thì research sai.

Giờ trong log là UTC; tên file là giờ máy booth (UTC+7). `07:35:24` ↔
`143524`.

## A. Một phiên chụp đầy đủ (4 kiểu, có retake)

```
07:35:24.112  capture_start    {}
07:35:24.364  file_download    {param1: 20260812_143524_363.jpg}
07:35:26.970  processing_start {param1: ...143505_029.jpg, param2: ...143511_466.jpg,
                                param3: ...143517_880.jpg, param4: ...143524_363.jpg,
                                param5: C:\dslrBooth\Test_event\Prints\20260812_143526_970.jpg}
07:35:27.317  sharing_screen   {}
07:35:28.064  printing         {param1: ...Prints\20260812_143526_970.jpg, param2: "1", param3: "DS-RX1"}
07:35:31.909  file_upload      {param3: "print",    param2: https://fotoshare.co/i/1my7bcw}
07:35:32.030  file_upload      {param3: "original", param2: https://fotoshare.co/i/3c67t72}
07:35:36.114  file_upload      {param3: "original", param2: https://fotoshare.co/i/1646s6a}
07:35:40.295  file_upload      {param3: "original", param2: https://fotoshare.co/i/4dnj86z}
07:35:44.373  file_upload      {param3: "original", param2: https://fotoshare.co/i/2z0nwcv}
07:35:57.337  session_end      {}
```

## B. Duyệt thư viện ảnh sau khi phiên đã xong

Operator bấm vào danh sách ảnh rồi thoát ra — hai lần liên tiếp:

```
07:36:08.217  sharing_screen {}
07:36:09.722  session_end    {}
07:36:16.241  sharing_screen {}
07:36:17.576  session_end    {}
```

## Những gì file này CHỨNG MINH

1. **`session_end` mang payload rỗng `{}`.** dslrBooth không gắn bất kỳ định
   danh phiên nào vào đó. Nên việc gắn `session_end` với đúng job **không thể**
   lấy từ payload của dslrBooth — nó phải đến từ trạng thái mà Agent hoặc
   Extension Service tự giữ. Mọi thiết kế kiểu "scope theo jobId trong event"
   là bất khả thi ngay từ đầu.

2. **`session_end` KHÔNG có nghĩa "khách đã xong".** Nó bắn mỗi lần thoát khỏi
   màn hình chia sẻ — kể cả khi chỉ xem lại thư viện ảnh, 11 giây sau khi phiên
   thật đã kết thúc, rồi lại 8 giây sau đó nữa. Ba `session_end` trong 52 giây
   cho **một** phiên chụp. Đây chính là cơ chế đứng sau `session_end` kép của
   job `BZWCWFN6` (07:09:26 và 07:10:13), và nó là hành vi bình thường của máy,
   không phải sự cố.

3. **`sharing_screen` không phải mốc kết thúc.** Nó xuất hiện ở 07:35:27, tức
   là *trước* toàn bộ 5 lần `file_upload`. Không dùng được làm tín hiệu chốt.

4. **Ảnh ghép print nhận diện được SỚM, và chắc chắn hơn `session_end`.**
   `processing_start.param5` và `printing.param1` cùng trỏ tới
   `Prints\20260812_143526_970.jpg` từ 07:35:26 — trước lần upload của chính nó
   5 giây, và trước `session_end` 30 giây. Đây là mốc neo đáng tin cậy hơn.

5. **Bộ lọc `param3 === 'print'` được dữ liệu thật xác nhận.** Một phiên sinh ra
   1 bản `print` + 4 bản `original`. Không có bộ lọc thì mỗi khách nhận 5 thông
   báo. (Đã vá ở commit `9865afa`.)

6. **Không có `capture_start` thứ hai sau `processing_start`.** Retake mà
   operator thực hiện nằm *trong* pha chụp, trước đoạn log này — nên đoạn A
   **không** chứa bằng chứng về việc retake sinh ra `session_end`/`session_start`
   thừa. Xem mục còn bỏ ngỏ.

## Những gì file này KHÔNG trả lời (research phải làm)

- **Chưa giải thích được vì sao `BZWCWFN6` quay lại `in_progress`.** Chỉ hai
  đường ghi trạng thái đó: `session_start` (qua `onAgentEvent`) và `ack`
  (qua `onAgentAck`). Đoạn B **không chứa `session_start`**, nên duyệt thư viện
  ảnh một mình không giải thích được. Giả thuyết cần kiểm chứng: **Agent đóng
  dấu jobId cũ lên sự kiện phát sinh sau khi job đã xong.** Cần log Agent
  KHÔNG lọc quanh 07:09–07:10, và cần đọc `dslrbooth-agent` (HEAD `e376696`)
  xem nó gắn jobId vào event như thế nào.
- Retake ở giữa pha chụp bắn ra chuỗi trigger gì — đoạn A bắt đầu quá muộn.
- Có `session_start` nào đi kèm các cặp ở đoạn B không (log có thể đã lọc).

---

# Bổ sung 2026-08-18 — retake đo được từ đầu đến cuối

Operator ghi lại trên máy booth, 2026-08-18, log của Agent (chưa lọc). Layout
**1 kiểu** (`PrintOnly`), khác layout 4 kiểu của ngày 12/08. Giờ UTC. Các dòng
`countdown` đã bỏ để dễ đọc; số lượng và nhịp của chúng không thay đổi so với
đoạn A.

Flow operator thực hiện ở cả C và D: *chụp → xem ảnh, không ưng → bấm Retake
trên màn hình chia sẻ → chụp lại → ưng.*

## C. Retake, auto-print BẬT

```
03:04:42.600  session_start    {param1: PrintOnly}
03:04:54.430  session_end      {}                                   ← ❶ phiên rỗng, 12s, không chụp
03:04:57.041  session_start    {param1: PrintOnly}                  ← LẦN CHỤP 1 (bị loại)
03:05:05.923  capture_start    {}
03:05:06.291  file_download    {param1: 20260818_100506_286.jpg}
03:05:10.105  processing_start {param1: 20260818_100506_286.jpg,
                                param2: C:\dslrBooth\Test_event\Prints\20260818_100510_104.jpg}
03:05:10.748  sharing_screen   {}
03:05:12.059  printing         {param1: ...Prints\20260818_100510_104.jpg, param2: "1", param3: "DS-RX1"}
03:05:16.502  file_upload      {param3: "original", param2: https://fotoshare.co/i/4gfw7cy}
03:05:16.726  session_end      {}                                   ← ❷ retake bắt đầu từ đây
03:05:17.236  file_upload      {param3: "print",    param2: https://fotoshare.co/i/332q1vz}   ← ẢNH BỊ LOẠI
03:05:20.038  session_start    {param1: PrintOnly}                  ← LẦN CHỤP 2 (được lấy), 3.3s sau ❷
03:05:26.605  capture_start    {}
03:05:27.141  file_download    {param1: 20260818_100527_138.jpg}
03:05:29.769  processing_start {param1: 20260818_100527_138.jpg,
                                param2: C:\dslrBooth\Test_event\Prints\20260818_100529_768.jpg}
03:05:30.153  sharing_screen   {}
03:05:30.911  printing         {param1: ...Prints\20260818_100529_768.jpg, param2: "1", param3: "DS-RX1"}
03:05:33.601  session_end      {}
03:05:34.435  file_upload      {param3: "original", param2: https://fotoshare.co/i/35qz6vs}
03:05:35.291  file_upload      {param3: "print",    param2: https://fotoshare.co/i/2yrxhff}   ← ẢNH ĐÚNG
```

## D. Retake, auto-print TẮT

```
03:14:58.283  session_start    {param1: PrintOnly}                  ← LẦN CHỤP 1 (bị loại)
03:15:08.502  capture_start    {}
03:15:08.727  file_download    {param1: 20260818_101508_719.jpg}
03:15:11.777  processing_start {param1: 20260818_101508_719.jpg,
                                param2: C:\dslrBooth\Test_event\Prints\20260818_101511_776.jpg}
03:15:12.414  sharing_screen   {}
03:15:16.964  file_upload      {param3: "print",    param2: https://fotoshare.co/i/5g719qt}   ← ẢNH BỊ LOẠI, vẫn upload
03:15:17.605  file_upload      {param3: "original", param2: https://fotoshare.co/i/2fh3brs}
03:15:24.455  session_end      {}                                   ← retake
03:15:36.796  session_start    {param1: PrintOnly}                  ← LẦN CHỤP 2, 12.3s sau session_end
03:15:44.655  capture_start    {}
03:15:45.017  file_download    {param1: 20260818_101545_000.jpg}
03:15:48.163  processing_start {param1: 20260818_101545_000.jpg,
                                param2: C:\dslrBooth\Test_event\Prints\20260818_101548_163.jpg}
03:15:48.779  sharing_screen   {}
03:15:52.411  file_upload      {param3: "print",    param2: https://fotoshare.co/i/2z2d7s2}   ← ẢNH ĐÚNG
03:15:52.920  file_upload      {param3: "original", param2: https://fotoshare.co/i/25tk3yq}
03:15:58.044  printing         {param1: ...Prints\20260818_101548_163.jpg, param2: "1", param3: "DS-RX1"}  ← khách bấm in
03:16:02.800  session_end      {}
```

## E. In lại ảnh cũ từ thư viện, 18 phút sau

Operator mở thư viện, chọn composite của lần chụp 03:05, bấm in:

```
03:23:15.614  sharing_screen   {}
03:23:20.545  printing         {param1: ...Prints\20260818_100529_768.jpg, param2: "1", param3: "DS-RX1"}
03:23:20.960  session_end      {}
```

Không có `session_start`, không có `processing_start`, không có `file_upload`.
`param1` là composite của **phiên trước đó 18 phút**.

## Những gì C/D/E CHỨNG MINH

7. **Retake trên màn hình chia sẻ là MỘT PHIÊN dslrBooth MỚI, không phải một
   shot thêm trong phiên cũ.** Nó bắn `session_end` rồi `session_start`. Kết
   luận số 6 ở trên ("retake nằm trong pha chụp") **sai với retake kiểu này** —
   D-01 của Phase 7 đứng trên giả định đó, và giả định đó không đúng.
   Hệ quả trực tiếp với code hiện tại (`sessionEnded()` nhả booth ngay tại
   `session_end`): khách đang retake bị nhả booth sau ❷, khách kế tiếp được
   dispatch chen vào, khách cũ mồ côi → sweeper đóng `no_photo`.

8. **Mỗi lần chụp — kể cả lần bị loại — đều sinh `processing_start` VÀ
   `file_upload param3=print` với URL fotoshare RIÊNG.** Đo ở cả C và D. Tắt
   auto-print **không** ngăn upload của lần bị loại. Với D-07 hiện tại (slot mở
   ở composite đầu, `resolvePendingPrint` một lần duy nhất), khách sẽ nhận URL
   của **tấm mình vừa từ chối**, và URL đúng rơi vào nhánh `resolvePendingPrint
   === false` — nhánh **không log**.

9. **`printing` là tín hiệu duyệt, NHƯNG CHỈ KHI auto-print TẮT.** So C và D:
   auto-print bật → `printing` bắn ở cả hai lần chụp (không phân biệt được);
   auto-print tắt → `printing` bắn **đúng một lần, ở lần được lấy, sau khi khách
   bấm in**. Đây là tín hiệu duy nhất trong 10 loại trigger phân biệt được
   "tấm khách lấy" với "tấm khách bỏ". → **Tắt auto-print là yêu cầu vận hành
   bắt buộc**, operator xác nhận 2026-08-18.

10. **Tắt auto-print ĐẢO thứ tự `printing` và `file_upload print`.**
    Bật: `processing_start → printing → upload`. Tắt: `processing_start →
    upload → printing` (upload 03:15:52, printing 03:15:58). Không thể dời mốc
    mở slot sang `printing` — upload sẽ tới trước khi có slot và bị vứt theo D-04.
    Slot phải vẫn mở ở `processing_start`; `printing` chỉ quyết định **gửi**.

11. **`printing` cũng bắn khi in lại ảnh cũ từ thư viện (E), không có
    `session_start` đi kèm, và `param1` là composite của phiên khác.** Nên
    `printing` chỉ có nghĩa khi (a) đang có một lần chụp mở — đã thấy
    `session_start` và chưa thấy `session_end` của nó — VÀ (b) `param1` trùng
    composite mà `processing_start` của chính lần chụp đó đã báo. Thiếu một
    trong hai → bỏ qua.

12. **Vị trí composite trong `processing_start` phụ thuộc layout.** Layout 4
    kiểu: `param5` (đoạn A). Layout 1 kiểu: `param2` (C, D). Tài liệu chính
    thức ghi `param1: original_photo_filenames (optional), param2: final_file`
    — tức các file gốc liệt kê trước, composite là **param cuối**. Code đọc cứng
    `param5` (`queueService.ts:431`) trượt cả 4 lần hôm nay
    (`warn: processing_start carried no usable composite path in param5`), chỉ
    thoát nhờ `printing.param1` — mà theo (9) `printing` giờ không còn xuất
    hiện ở lần bị loại nữa.

13. **Khoảng nghỉ retake đo được: 3.3s (C) và 12.3s (D).** Khách thật do dự sẽ
    lâu hơn operator đang test.

14. Ở C, `file_upload print` của lần 1 tới **sau** `session_end` ❷ 0.5s. Xác
    nhận lại D-07: upload không có thứ tự cố định với `session_end`.

15. **(Từ log Extension Service 2026-08-14, job `9ZB3QK9G`, layout 4 kiểu, auto-print
    bật.)** `processing_start` báo composite `…\Prints\********_094130_744_1x.jpg`,
    còn `printing.param1` 2 giây sau là `…\Prints\********_094130_744_2x.jpg` —
    **cùng timestamp stem, khác hậu tố `_1x`/`_2x`** (biến thể số bản in của
    dslrBooth). Ở layout 1 kiểu (C, D) hai bên trùng nhau tuyệt đối. → So sánh
    composite giữa `printing` và slot **không được** so chuỗi tuyệt đối; phải so
    theo stem `YYYYMMDD_HHMMSS_mmm` của tên file trong `\Prints\`, bỏ hậu tố
    `_Nx` và phần mở rộng.

## Còn bỏ ngỏ sau 2026-08-18

- Phiên rỗng ❶ ở C (12 giây, `session_start`→`session_end` không chụp) là gì —
  operator chọn chế độ, hay màn hình chờ tự bắn? Ảnh hưởng tới việc `session_end`
  không có composite có nên mở ân hạn không.
- Retake bằng nút **Cancel trong pha review ảnh** (khác nút Retake trên màn
  chia sẻ) bắn ra gì — chưa đo. Release notes v8.3.1: "camera could no longer be
  triggered after pressing Cancel or Retake" xác nhận hai nút này tồn tại riêng.
- Phiên bản dslrBooth đang chạy trên máy booth — cần ≥ v8.3.0 nếu muốn dùng
  `/api/cancel` (release notes v8.3.0: "`/api/cancel` command now works
  correctly instead of returning 'Invalid command specified'").
