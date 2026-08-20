# Stack Research: Extension Service

**Domain:** Node.js real-time queue orchestration service
**Researched:** 2025-07-21
**Confidence:** HIGH

## Runtime
- Node.js 20 LTS
- TypeScript 5.6 with strict mode

## HTTP Framework
- **express** 4.21.x — Unopinionated, battle-tested, huge ecosystem
  - Why: Simple middleware model fits our few routes (/on-register, /status/:jobId, /health)
  - Alt: fastify (faster but steeper curve)

## WebSocket Server
- **ws** 8.18.x — Lightweight, no extra dependencies
  - Why: Server-side WS to accept Agent connections. Standard choice.
  - Alt: socket.io (adds overhead, not needed)

## Local State Store
- **better-sqlite3** 11.x — Synchronous, fast, zero-config
  - Why: Sync API simpler for single-process model. Queryable for DB polling cursor.
  - Alt: lowdb (JSON file, not queryable)

## Logging
- **winston** 3.14 + **winston-daily-rotate-file** 5.0
  - Why: Daily rotation, 14-day retention, gzip. Flexible transport system.
  - Config: 10MB per file, 14 files max

## Config
- **dotenv** 16.4 — Load .env into process.env
  - Pair with typed config module for validation at startup

## Testing
- **vitest** 2.1+ — Fast, ESM-first, good TypeScript support

## Deployment
- PM2 or Docker on server/cloud
