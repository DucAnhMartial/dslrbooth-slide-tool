---
plan: 5
phase: 2
wave: 2
title: Add getQueuePosition to LocalStore
requirements: [QUE-01]
depends_on: [Plan 01]
files_modified:
  - src/state/localStore.ts
autonomous: true
---

## Objective

Add a `getQueuePosition(jobId)` method so the system can report a guest's position in line. Needed by the GET /status endpoint in Phase 5, and should expose the count from `getQueuedJobs`.

## Action

1. Edit `src/state/localStore.ts`:

   `getQueuePosition(jobId: string): number | undefined` — finds the job's `queued_at` timestamp, then counts how many queued jobs have a lower (earlier) timestamp. Returns 1-indexed position (oldest job = 1), or undefined if the job is not queued.

   ```
   getQueuePosition(jobId: string): number | undefined {
     const job = this.db.prepare('SELECT queued_at FROM queue_job WHERE id = ? AND status = ?').get(jobId, 'queued') as { queued_at: number } | undefined;
     if (!job) return undefined;
     const row = this.db.prepare('SELECT COUNT(*) as cnt FROM queue_job WHERE status = ? AND queued_at < ?').get('queued', job.queued_at) as { cnt: number };
     return row.cnt + 1;
   }
   ```

2. Also add `getQueueLength(): number` that returns `SELECT COUNT(*) FROM queue_job WHERE status = 'queued'`.

## Read First

- `src/state/localStore.ts` (existing query patterns)
- `src/types.ts` (QueueJob)

## Acceptance Criteria

- [ ] `getQueuePosition('job1')` returns 1 when it is the only queued job
- [ ] `getQueuePosition('job2')` returns 2 when job2 was enqueued after job1
- [ ] `getQueuePosition('job3')` returns undefined when job3 is already dispatched/completed
- [ ] `getQueueLength()` returns the count of queued (not dispatched/completed) jobs
- [ ] `npx tsc --noEmit` exits 0
