---
plan: 3
phase: 2
wave: 1
title: Create QueueService - dispatch and state orchestration
requirements: [QUE-03, QUE-04, BTH-01, BTH-02]
depends_on:
  - Plan 01 (queue store ops)
  - Plan 02 (state machine methods)
files_modified:
  - src/queue/queueService.ts
  - src/types.ts
new_files:
  - src/queue/queueService.ts
autonomous: true
---

## Objective

Create a new `QueueService` class that owns the dispatch loop: when booth is IDLE, dequeue the next job, flip booth to BUSY, and emit a `dispatch` event. Also own a setInterval watchdog that resets booth to IDLE if BUSY > SESSION_TIMEOUT_MS without a session_end signal.

## Action

1. Create `src/queue/queueService.ts`:

   ```
   class QueueService {
     - store: LocalStore
     - config: EnvConfig
     - dispatchTimer: NodeJS.Timeout | null
     - stateHandlers: Map<'idle'|'busy'|'dispatched', callback>

     constructor(store, config)
     onStateChange(stage, handler): void
     start(): void
     stop(): void

     // called when ingestion adds a new job
     enqueueJob(jobId: string): void

     // called externally (phase 3: when Agent sends session_end)
     sessionEnded(): void

     // called externally (phase 3: when Agent sends ack)
     sessionAcked(jobId: string): void
   }
   ```

2. `start()` begins a check loop (250ms interval) — if booth is IDLE and `getNextQueuedJob()` returns a job, dispatch it:

   - `setJobStatus(jobId, 'dispatched', 'dispatched_at', now)`
   - `setBoothBusy(now)`
   - emit 'dispatched' event with `{ jobId, registration }`
   - start a per-job timeout timer (SESSION_TIMEOUT_MS, default 5min) → if fires without ack, mark stall and reset booth to IDLE

3. `sessionEnded()`:
   - Update the current job to 'completed', set session_ended_at
   - `setBoothIdle()`
   - The next check loop tick will auto-dispatch the next queued job

4. `sessionAcked(jobId)`:
   - Update job to 'in_progress', set acknowledged_at
   - Clear the per-job timeout timer — phase 3 will start the session timer when session_start arrives

5. Export `createQueueService(store, config)` factory function.

## Read First

- `src/state/localStore.ts` (store API)
- `src/types.ts` (BoothState, QueueJob)
- `src/config.ts` (SESSION_TIMEOUT_MS defaults to 300_000)

## Acceptance Criteria

- [ ] QueueService class exists in `src/queue/queueService.ts`
- [ ] `start()` begins the dispatch-check loop
- [ ] When booth is IDLE and queue has jobs, a 'dispatched' event is emitted with the oldest job
- [ ] Booth flips to BUSY on dispatch, flips back to IDLE on sessionEnded
- [ ] If 5 minutes pass without sessionAcked, booth resets to IDLE with stall_reason set
- [ ] `npx tsc --noEmit` exits 0
