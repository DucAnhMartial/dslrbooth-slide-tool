---
plan: 1
phase: 2
wave: 1
title: Implement queue job store operations
requirements: [QUE-01, QUE-02, STO-01]
depends_on: []
files_modified:
  - src/state/localStore.ts
autonomous: true
---

## Objective

Replace the stub `getQueuedJobs()` and `getJob()` methods in LocalStore with real SQL queries so the queue can actually dequeue work.

## Action

1. Edit `src/state/localStore.ts` — replace the two stub methods:

   `getQueuedJobs()` → SELECT FROM queue_job WHERE status = 'queued' ORDER BY queued_at ASC

   `getJob(id)` → SELECT FROM queue_job WHERE id = ?, return row or undefined

2. Also add `getNextQueuedJob()` that returns at most one row — the oldest queued entry. This is the method the dispatch loop will call.

## Read First

- `src/state/localStore.ts` (current stubs at lines 100-101)
- `src/types.ts` (QueueJob type)

## Acceptance Criteria

- [ ] `getQueuedJobs()` returns all jobs with status = 'queued', ordered by queued_at ASC
- [ ] `getJob(id)` returns a QueueJob or undefined
- [ ] `getNextQueuedJob()` returns a single job (the oldest queued) or undefined
- [ ] `npx tsc --noEmit` exits 0
