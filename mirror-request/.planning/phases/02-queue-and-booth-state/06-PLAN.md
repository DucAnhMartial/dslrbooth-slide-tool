---
plan: 6
phase: 2
wave: 2
title: End-to-end smoke test of queue dispatch flow
requirements: [QUE-01, QUE-02, QUE-03, QUE-04, BTH-01, BTH-02]
depends_on: [Plan 01, Plan 02, Plan 03, Plan 04]
files_modified: []
new_files:
  - test/phase2-smoke.test.ts
autonomous: true
---

## Objective

Write a focused integration test that exercises the full Phase 2 flow without requiring a running server: enqueue two registrations, verify FIFO order, simulate dispatch → ack → session_end → auto-dispatch of next job, and verify the 5-minute timeout resets a stalled session.

## Action

1. Create `test/phase2-smoke.test.ts`:

   Test cases (use vitest):
   
   a. **FIFO order** — enqueue job A then job B; `getQueuedJobs()` returns [A, B]; `getNextQueuedJob()` returns A first
   
   b. **Dispatch first job** — call `queueService.sessionAcked` indirectly by setting booth state BUSY then calling queue.start(); verify booth is BUSY and job A status is 'dispatched'
   
   c. **Session end → auto-dispatch** — call `queueService.sessionEnded()`; verify booth back to IDLE and job B is now dispatched
   
   d. **Timeout reset** — with booth BUSY, advance system clock (or directly call the timeout handler) beyond SESSION_TIMEOUT_MS; verify booth resets to IDLE and stall_reason is recorded
   
   e. **Duplicate detection** — enqueue same id twice; second enqueue is a no-op (idempotent); `getQueuedJobs()` length = 1

2. Add to `package.json` test script if not present: `"test": "vitest run"`

3. Run `npx vitest run test/phase2-smoke.test.ts` and all tests pass.

## Read First

- `src/queue/queueService.ts` (after Plan 03-04 implemented)
- `src/state/localStore.ts` (full store API)
- `package.json` (test scripts)

## Acceptance Criteria

- [ ] All 5 test cases pass
- [ ] `npx vitest run` exits 0
- [ ] No network calls or external dependencies required by tests
