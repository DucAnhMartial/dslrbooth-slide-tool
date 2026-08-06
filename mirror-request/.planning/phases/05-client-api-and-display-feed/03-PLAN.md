---
plan: 3
phase: 5
wave: 1
title: End-to-end Phase 5 smoke test
requirements: [API-01, API-02, AUTH-03]
depends_on: [Plan 01, Plan 02]
files_modified: []
new_files:
  - test/phase5-display.test.ts
autonomous: true
---

## Objective

Smoke test covering GET /status/:jobId with real data and WS display feed receiving state updates.

## Action

1. Create test/phase5-display.test.ts:

   a. GET /status/:jobId
      - Enqueue job, GET /status/:jobId
      - Assert response has queuePosition, boothState, estimatedWaitSeconds
      - Assert email/phone are masked

   b. GET /status/:jobId (unknown)
      - Assert 404

   c. WS display feed
      - Connect to /display
      - Trigger dispatch via QueueService
      - Assert display client receives snapshot with current guest name

2. Run npx vitest run test/phase5-display.test.ts.

## Acceptance Criteria

- [ ] All test cases pass
- [ ] npx vitest run exits 0
