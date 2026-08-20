---
plan: 4
phase: 2
wave: 1
title: Wire QueueService into the server and ingestion paths
requirements: [QUE-01, QUE-02, QUE-03, QUE-04, BTH-01, BTH-02]
depends_on: [Plan 01, Plan 02, Plan 03]
files_modified:
  - src/index.ts
  - src/ingestion/mirrorReceiver.ts
  - src/ingestion/dbPoller.ts
  - src/state/localStore.ts
autonomous: true
---

## Objective

Hook `QueueService` into the server startup and both ingestion paths so that every newly enqueued job immediately triggers the dispatch check.

## Action

1. Edit `src/index.ts`:
   - Import `createQueueService` from `./queue/queueService`
   - Instantiate: `const queue = createQueueService(store, config);`
   - Call `queue.start()` after `poller.start()` in the server ready callback
   - Call `queue.stop()` in `shutdown()`

   ```
   const server = app.listen(config.PORT, config.HOST, () => {
     log.info(`Extension Service ready on ${config.HOST}:${config.PORT}`);
     poller.start();
     queue.start();
   });
   ```

2. Edit `src/ingestion/mirrorReceiver.ts`:
   - Reshape `createMirrorReceiver` to also accept the `QueueService` instance
   - After `store.enqueueJob(...)` (line 54), call `queue.enqueueJob(id)` so the dispatch loop fires

3. Edit `src/ingestion/dbPoller.ts`:
   - After `store.enqueueJob(...)` (line 73), call `queue.enqueueJob(id)` the same way

4. Edit `src/queue/queueService.ts`:
   - `enqueueJob(id)` should just call `this.triggerCheck()` — the check loop picks it up on its next tick

## Read First

- `src/index.ts` (current wiring)
- `src/ingestion/mirrorReceiver.ts` (enqueueJob call at line 54)
- `src/ingestion/dbPoller.ts` (enqueueJob call at line 73)

## Acceptance Criteria

- [ ] `npm run dev` starts, QueueService initializes on startup
- [ ] POST /on-register still returns 200 immediately
- [ ] Server shutdown calls `queue.stop()` and `poller.stop()`
- [ ] Duplicate registration IDs are still rejected (existing behavior preserved)
- [ ] `npx tsc --noEmit` exits 0
