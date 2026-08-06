# Environment Migration Guide

## Trạng thái khi chuyển

Phase 1 (Foundation & Ingestion) đã implement xong. Cần setup lại trên môi trường mới.

## Các file đã thay đổi (commit cần đưa theo)

| File | Change |
|------|--------|
| `src/config.ts` | Giữ nguyên |
| `src/types.ts` | Giữ nguyên |
| `src/logging/logger.ts` | Giữ nguyên |
| `src/state/localStore.ts` | Thêm raw_payload, booth_state, cursor, stall_reason |
| `src/index.ts` | **Rewrite** — giờ là Extension Service |
| `src/ingestion/mirrorReceiver.ts` | Thêm IP whitelist, raw_payload |
| `src/ingestion/dbPoller.ts` | Thêm { Client } from 'pg', real SELECT |

## Setup trên môi trường mới

### 1. Clone repo
```bash
git clone <repo-url> mirror-request
cd mirror-request
```

### 2. Install dependencies
```bash
npm install
```

### 3. Tạo .env từ .env.example
```bash
cp .env.example .env
# Sửa giá trị cho đúng môi trường
```

### 4. Verify Phase 1
```bash
npx tsc --noEmit        # phải exit 0
npm run dev             # phải thấy "Extension Service ready on 0.0.0.0:3002"
```

### 5. Nếu có lỗi typecheck
- Kiểm tra `node_modules` đã đủ chưa
- Chạy `npm install` lại nếu thiếu

## Tiếp theo sau khi verify Phase 1

```bash
/gsd-discuss-phase 2    # Discuss Queue & Booth State
/gsd-plan-phase 2       # Plan Phase 2
/gsd-execute-phase 2    # Execute
```

## Lưu ý

- Phase 4 đã simplified — dùng webhook thay vì built-in email/SMS
- DB_POLLER cần `pg` package — đảm bảo có trong package.json dependencies
