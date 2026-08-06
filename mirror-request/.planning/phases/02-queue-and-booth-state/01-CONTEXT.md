# Phase 2: Queue & Booth State

## Mục tiêu
Xây dựng queue FIFO và state machine IDLE/BUSY với timeout an toàn.

## Thiết kế chính
- Queue: in-memory dispatch, SQLite là source of truth cho persistence
- Dispatch trigger: polling loop 250ms, check booth state + queue
- Timeout: per-job timer, config qua SESSION_TIMEOUT_MS (mặc định 5 phút)
- Coupling Phase 3: sessionEnded() và sessionAcked() được gọi từ Agent WS handler

## Files
- src/queue/queueService.ts — mới
- src/state/localStore.ts — thêm queue queries
- src/index.ts, mirrorReceiver.ts, dbPoller.ts — wire QueueService

## Plan summary
1. Implement store queue operations (getQueuedJobs, getNextQueuedJob)
2. Booth state machine methods (setBoothBusy/Idle/Timeout)
3. Create QueueService class (dispatch loop, timeout watchdog)
4. Wire QueueService into server + ingestion paths
5. Add getQueuePosition for status endpoint
6. End-to-end smoke test (vitest)
