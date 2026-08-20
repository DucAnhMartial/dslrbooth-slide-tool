---
plan: 3
phase: 4
wave: 1
title: Wire NotificationService into file_upload handler
requirements: [NOT-01]
depends_on: [Plan 01]
files_modified:
  - src/queue/queueService.ts
autonomous: true
---

## Objective

Connect NotificationService to the file_upload event so photo delivery triggers automatically.

## Action

1. Edit src/queue/queueService.ts (Plan 04 from Phase 2 updated):
   - Accept notificationService in constructor
   - On file_upload event (from AgentServer): call notificationService.sendPhotoLink(jobId, photoUrl)
   - Log success/failure

2. Edit src/index.ts:
   - Instantiate: const notifier = createNotificationService(store, config)
   - Pass to createQueueService(store, config, agentServer, notifier)

## Read First

- src/queue/queueService.ts
- src/index.ts
- src/notifications/notificationService.ts

## Acceptance Criteria

- [ ] npm run dev starts with NotificationService initialized
- [ ] file_upload event triggers sendPhotoLink()
- [ ] npx tsc --noEmit exits 0
