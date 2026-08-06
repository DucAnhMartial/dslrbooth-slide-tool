---
plan: 1
phase: 5
wave: 1
title: GET /status/:jobId endpoint
requirements: [API-01, AUTH-03]
depends_on: [Phase 2 Plan 05]
files_modified:
  - src/index.ts
autonomous: true
---

## Objective

Expose a read-only GET /status/:jobId endpoint that returns queue position, estimated wait time, and booth status.

## Action

1. Edit src/index.ts:
   - Add route: app.get('/status/:jobId', (req, res) => { ... })
   - Look up job in store: getJob(jobId) and getQueuePosition(jobId)
   - Return JSON: { jobId, queuePosition, queueLength, boothState, estimatedWaitSeconds }
   - Estimated wait = queuePosition * averageSessionDuration (config.AVG_SESSION_MS, default 120000 = 2 min)
   - Mask sensitive fields (email, phone) in response using mask() from logger

2. Edge cases:
   - Job not found: 404 { error: 'job not found' }
   - Job completed/expired: 200 with status = 'completed' and position = null

## Read First

- src/index.ts
- src/state/localStore.ts (Phase 2 getJob, getQueuePosition)
- src/logging/logger.ts (mask function)

## Acceptance Criteria

- [ ] GET /status/:jobId returns queue position and wait time
- [ ] Unknown jobId returns 404
- [ ] Sensitive fields masked in response
- [ ] npx tsc --noEmit exits 0
