# Phase 4: Guest Notifications (Simplified)

## Mục tiêu
Trigger webhook khi file_upload event arrives. User da co he thong tim anh rieng.

## Design
- Webhook delivery (khong email/SMS)
- NotificationService POST JSON voi guest info + photoUrl to NOTIFY_WEBHOOK_URL
- Retry voi exponential backoff, ghi log sau khi het retry

## Plan summary
1. NotificationService (webhook delivery + retry)
2. saveNotification/getNotification persistence
3. Wire NotificationService vao file_upload handler
