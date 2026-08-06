---
plan: 1
phase: 4
wave: 1
title: Create NotificationService with webhook delivery
requirements: [NOT-01]
depends_on: []
files_modified: []
new_files:
  - src/notifications/notificationService.ts
autonomous: true
---

## Objective

Create NotificationService that, on file_upload event, looks up guest info by jobId and sends a webhook POST to the external image search system.

## Action

1. Create src/notifications/notificationService.ts:
   - class NotificationService(store, webhookUrl, maxRetries)
   - async sendPhotoLink(jobId, photoUrl):
     - Look up registration via store
     - POST JSON payload to webhookUrl
     - On failure: retry with exponential backoff up to maxRetries
     - After exhaustion: log error for manual follow-up
   - Factory: createNotificationService(store, config)

2. Add NOTIFY_WEBHOOK_URL to config.ts if not present.

## Read First

- src/state/localStore.ts
- src/types.ts
- src/config.ts

## Acceptance Criteria

- [ ] NotificationService class exists
- [ ] sendPhotoLink() looks up registration and POSTs to webhook
- [ ] Failed sends retry with backoff
- [ ] npx tsc --noEmit exits 0
