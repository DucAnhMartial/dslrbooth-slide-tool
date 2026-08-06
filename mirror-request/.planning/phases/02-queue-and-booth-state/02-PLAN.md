---
plan: 2
phase: 2
wave: 1
title: Booth state machine methods in LocalStore
requirements: [BTH-01]
depends_on: []
files_modified:
  - src/state/localStore.ts
autonomous: true
---

## Objective

Add transition-aware methods so the existing `getBoothState()` / `setBoothState()` become a real state machine with guard logic.

## Action

1. Edit `src/state/localStore.ts` — add these methods to the `LocalStore` class:

   `setBoothBusy(dispatchedAt: number)` — transitions state to BUSY, sets updated_at and the dispatched_at timestamp
   
   `setBoothIdle()` — transitions state back to IDLE, updates timestamp
   
   `setBoothTimeout(stallReason: string)` — transitions to IDLE, records stall_reason
   
   `getBoothStateDetailed()` — returns `{ state: BoothState, updated_at: string, dispatched_at?: number }` for the timeout loop

2. Keep direct `setBoothState(string)` as a raw override for testing only — the typed methods above are the primary public API.

## Read First

- `src/state/localStore.ts` (getBoothState, setBoothState lines 121-127)
- `src/types.ts` (BoothState type)

## Acceptance Criteria

- [ ] `setBoothBusy(Date.now())` sets booth_state to BUSY and persists
- [ ] `setBoothIdle()` resets booth_state to IDLE
- [ ] `setBoothTimeout('no_session_end')` resets to IDLE with log-callable detail
- [ ] `getBoothStateDetailed()` returns state + timestamps
- [ ] `npx tsc --noEmit` exits 0
