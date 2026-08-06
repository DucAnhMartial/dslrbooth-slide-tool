---
plan: 2
phase: 4
wave: 1
title: Record notification attempts in LocalStore
requirements: [NOT-02]
depends_on: [Plan 01]
files_modified:
  - src/state/localStore.ts
autonomous: true
---

## Objective

Implement saveNotification and getNotification in LocalStore so retry state persists across restarts.

## Action

1. Edit src/state/localStore.ts:
   - saveNotification(n): INSERT OR REPLACE INTO notification_record
   - getNotification(jobId): SELECT * FROM notification_record WHERE jobId = ?
   - Add notification_record table to bootstrap:
     CREATE TABLE IF NOT EXISTS notification_record (
       jobId TEXT PRIMARY KEY,
       status TEXT NOT NULL DEFAULT 'pending',
       attempts INTEGER NOT NULL DEFAULT 0,
       lastError TEXT,
       updatedAt TEXT NOT NULL DEFAULT 'now'
     )

## Read First

- src/state/localStore.ts (existing table patterns)

## Acceptance Criteria

- [ ] saveNotification() persists notification state
- [ ] getNotification() returns saved record
- [ ] npx tsc --noEmit exits 0
