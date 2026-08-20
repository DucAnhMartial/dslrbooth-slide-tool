---
phase: 05-client-api-display-feed
plan: 04
subsystem: logging
tags: [auth-03, log-masking, d-17, windows-item-5, agent-server, queue, notifications, display]
status: complete

requires:
  - phase: 01-ingestion-hardening
    provides: "mask()/EMAIL_RE/PHONE_RE in src/logging/logger.ts, locked by plan 01-05 — never edited by this plan"
  - phase: 03-agent-link
    provides: "AgentServer's connSeq-based connection id mint (src/agent/agentServer.ts:83), the surface WINDOWS ledger item 5 was filed against"
  - phase: 02-queue-orchestration
    provides: "QueueService's queueLogger surface (labelLogger('queue')) driven by this plan's standing regression"
  - phase: 04-guest-notification
    provides: "NotificationService's notifyLogger surface (labelLogger('notify')) driven by this plan's standing regression"
provides:
  - "A structurally-unmaskable AgentServer connection id: no two digits are ever adjacent, so PHONE_RE's \\d{7,} threshold can never be reached"
  - "A standing regression test asserting every non-ingestion log message (queue, notify, display, status, base logger) is a plain string left unchanged by mask()"
affects:
  - "05-05 (OPS-RUNBOOK.md §7's masking-limitation paragraph is now stale; WINDOWS ledger item 5 becomes eligible to mark fixed)"

actuals:
  tokens: 5268
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "Digit-run-breaking transform (id.replace(/(\\d)(?=\\d)/g, '$1x')) promoted from a test-only helper (test/logging-mask.test.ts's safeId()) into production code (agentServer.ts's id mint) — the structural fix lives at the id generator, never at the masking regex, because under-masking a real phone number is a strictly worse failure than over-masking an id"
    - "Spying on winston child loggers (labelLogger('queue'), labelLogger('notify')) separately from the base logger — a bare base-logger spy silently misses anything logged through logger.child(), since a child logger is a distinct Logger instance"
    - "Real ephemeral LocalStore (constructor(dbPath?) seam) driving a real QueueService/NotificationService/DisplayServer flow under vi.useFakeTimers(), rather than a hand-rolled mock store, to prove the regression against the actual production log call sites"

key-files:
  created: []
  modified:
    - mirror-request/src/agent/agentServer.ts
    - mirror-request/test/logging-mask.test.ts

key-decisions:
  - "The connection-id fix reformats the WHOLE id (timestamp and sequence number both), not just the timestamp portion, so a sequence number that eventually grows past six digits stays covered by the same 'no two adjacent digits' guarantee rather than a length-dependent one."
  - "Task 2's synthetic job ids use the same digit-run-breaking safeId() technique already established in this file's /on-register describe block, rather than a raw Date.now()-based id — a plain timestamp-based test job id would have hit the exact same PHONE_RE false positive Task 1 fixes for connection ids, which would have been a test-fixture bug, not evidence of a real regression."
  - "index.ts's /display-screen blocked-IP log line could not be exercised via a real import (index.ts opens a live server as an import-time side effect), so it is reproduced verbatim inline using the same exported clientIp/isWhitelisted/renderDisplayPage functions plus an identically-constructed labelLogger('server') child — the same technique test/display-access-control.test.ts already established for the access-control half of this same route."

requirements-completed: [AUTH-03]

coverage:
  - id: D1
    description: "Connection ids can no longer be partially asterisked by mask() — no two digits are ever adjacent by construction, and ids no longer collide across simulated process restarts"
    requirement: "AUTH-03"
    verification:
      - kind: unit
        ref: "test/logging-mask.test.ts#Connection id survives masking (WINDOWS ledger item 5)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every non-ingestion log message across queue dispatch/ack/complete/stall-exhaustion, notification delivery exhaustion, the two Phase 5 blocked-IP surfaces, and guestStatus's unmapped-status path is a plain string that mask() leaves unchanged, with none carrying the fixture email or phone"
    requirement: "AUTH-03"
    verification:
      - kind: integration
        ref: "test/logging-mask.test.ts#Standing regression: every non-ingestion log line survives masking unchanged (AUTH-03, D-17)"
        status: pass
    human_judgment: false

duration: ~35 min
completed: 2026-08-11
---

# Phase 5 Plan 04: Log-Masking Regression Closure Summary

Closes AUTH-03's remaining half. `AgentServer`'s connection id can no longer be partially
asterisked by `mask()`'s phone pattern, because the id is now structurally incapable of
containing two adjacent digits — not merely "usually short enough." And the "we read every
non-ingestion log line once" audit from research is now a test that runs on every commit: a
realistic flow through the queue, notification, display, and status surfaces asserts every
collected message is a plain string `mask()` leaves byte-identical.

## What Was Built

| Concern | Artifact |
|---|---|
| Connection id fix | `src/agent/agentServer.ts`'s id mint gains a digit-run-breaking `.replace(/(\d)(?=\d)/g, '$1x')`, promoted from `test/logging-mask.test.ts`'s existing `safeId()` helper |
| Connection id proof | `test/logging-mask.test.ts`'s new `describe('Connection id survives masking ...')` — 5 cases |
| Non-ingestion standing regression | `test/logging-mask.test.ts`'s new `describe('Standing regression: ...')` — 1 integration case driving queue, notify, display, and status surfaces through logger spies |

## Task 1 — Connection id structurally unmaskable (`5301c0e`)

**The fix, quoted in full** (`src/agent/agentServer.ts`, only the id mint and its comment
changed — `git diff 1c78bb4..HEAD -- src/agent/agentServer.ts` shows nothing else):

```diff
-      const id = `agent-${Date.now()}-${++this.connSeq}`;
+      // WINDOWS ledger item 5: mask()'s phone pattern (`PHONE_RE`, ...) ...
+      const id = `agent-${Date.now()}-${++this.connSeq}`.replace(/(\d)(?=\d)/g, '$1x');
```

The transform is applied to the whole assembled id (timestamp and sequence number both), not
just the timestamp portion, so a sequence number that eventually grows past six digits stays
covered by the same guarantee. `src/logging/logger.ts`'s `PHONE_RE`/`EMAIL_RE` are untouched —
`git diff 1c78bb4..HEAD -- src/logging/` is empty.

**Proven behaviourally**, not asserted on faith, by 5 new cases in
`test/logging-mask.test.ts`, each connecting real WebSocket clients to a real `AgentServer`
over a real loopback `http.Server` (the same pattern `test/agent-replacement.test.ts` already
uses) and reading the id back off the log messages `AgentServer` itself produces:

1. The exact log-line templates (`Agent connected: <id>`, `Agent WS replaced: <a> displaced by
   <b>`) survive `mask()` unchanged.
2. A generated id contains no run of two adjacent digits — strictly stronger than "no run of
   seven," so `PHONE_RE`'s threshold can never be reached regardless of how large the timestamp
   or sequence number grow.
3. Two ids generated in the same process (successive connections) differ.
4. Two ids generated across two separate `AgentServer` instances — simulating a restart, where
   `connSeq` resets to its initial value — differ. This is the second half of ledger item 5:
   ids used to repeat across restarts once the timestamp was masked away.
5. **Control case:** a locally-built (never produced by production code) unreformatted id of
   the old `agent-<13-digit-timestamp>-1` shape is *not* left unchanged by `mask()` — proving
   the fix is load-bearing rather than a change that happened not to break anything.

Confirmed no existing assertion depended on the id's format before making this change:
`test/agent-replacement.test.ts`'s own assertions on captured ids are `not.toBe(...)` and a
`(.+)` capture group only.

## Task 2 — Standing regression: non-ingestion logs survive masking (`2c0dd44`)

Test-only, per the plan's explicit "do not fix here" instruction — no production log line was
added or changed. `test/logging-mask.test.ts` gained a new `describe` block spying on **four**
distinct logger surfaces (the base logger, `queueLogger`, `notifyLogger`, and a
`labelLogger('server')` instance mirroring `index.ts`'s own), because a winston child logger
(`logger.child(...)`) is a separate `Logger` instance from its parent — spying on the base
logger alone would silently miss anything logged through `queueService.ts`'s or
`notificationService.ts`'s labelled loggers.

**One flow, driven through a real ephemeral `LocalStore`** (constructor(dbPath?) seam, closed
in `afterEach`), exercising:

- **Queue** (`src/queue/queueService.ts`, `src/state/localStore.ts`): a real `QueueService`
  under `vi.useFakeTimers()` — enqueue (storage layer's "Queued job ... at position ..." line),
  announce, dispatch ("Dispatched job ... → Agent"), acknowledge, complete ("Completed job ...
  after session_end"); then a second job driven through two stalls with
  `SESSION_MAX_RETRIES: 1` so both the retry line ("requeued (attempt 1/2)") and the failure
  line ("failed after 2 attempts") fire.
- **Notifications** (`src/notifications/notificationService.ts`): a real ephemeral
  `http.Server` responding `503` and a real `NotificationService(maxRetries: 0, ...)`, so
  `sweep()` reaches the terminal branch on the first attempt and logs the exhaustion error line.
- **Phase 5's two blocked-IP surfaces**: `/display-screen`'s route reproduced verbatim (same
  `clientIp`/`isWhitelisted`/`renderDisplayPage` functions `index.ts` itself uses, since
  `index.ts` cannot be imported directly — it opens a real server as an import-time side
  effect) and a real `DisplayServer`'s WS `/display` upgrade handler, both refused with a real
  non-whitelisted address and both asserted to log the peer address.
- **`src/status/guestStatus.ts`**: `toGuestStatus({ jobStatus: 'weird_unmapped_status', ... })`
  called directly, exercising the unmapped-internal-status error line.

**Assertions:**
- Every collected message's type is `string` (an object argument would bypass masking
  entirely) and `mask(msg) === msg`.
- The collected-message count is `> 0` — **measured at 29** in this run — so a future refactor
  that silences a whole surface cannot make the test vacuously pass.
- At least one collected message matches `/requeued|Dispatched/` (proves the `queue` labelled
  surface was actually reached) and at least one matches `/Notification/` (proves the `notify`
  labelled surface was actually reached) — a bare `length > 0` check would have passed even if
  both child-logger surfaces were silently missed, since `index.ts`, `localStore.ts`,
  `displayServer.ts`, and `guestStatus.ts` all log through the base logger alone.
- No collected message contains the fixture registration's email (`auth03-regression@example.com`)
  or phone (`0912345678`) as a substring.

**Honest coverage statement** — surfaces the flow reached vs. did not, by file:

| File | Reached | Not reached this run |
|---|---|---|
| `src/state/localStore.ts` | enqueue position line | — |
| `src/queue/queueService.ts` | announce, dispatch, requeue (retry), fail (exhaustion) | NAK path, disconnect-requeue path, unhandled-event debug line (already covered by other test files, e.g. `test/agent-disconnect-requeue.test.ts`) |
| `src/notifications/notificationService.ts` | permanently-failed exhaustion line | successful-delivery line, timeout classification (already covered by `test/notification-webhook.test.ts`, `test/notification-fetch-timeout.test.ts`) |
| `src/index.ts` (`/display-screen`) | blocked-IP warn (reproduced inline — `index.ts` itself cannot be imported) | — |
| `src/display/displayServer.ts` | blocked WS `/display` upgrade warn | — |
| `src/status/guestStatus.ts` | unmapped-status error | — |
| `src/agent/agentServer.ts` | not driven in this describe block | covered separately by Task 1's own block and by `test/agent-replacement.test.ts`'s existing "no captured log message contains the credential" case |

One genuine false positive found and fixed **in the test fixture itself** (not production
code): a `Date.now()`-based synthetic job id would have embedded the same 13-digit run Task 1
just fixed for connection ids, so the fixture uses the same digit-run-breaking `safeId()`
technique the file's `/on-register` block already established. This is the identical, already
documented and accepted, "a raw UUID/timestamp occasionally collides with `PHONE_RE` by
chance" caveat — not a new defect and not something this plan's scope covers fixing at the
source (real job ids are backend-minted UUIDs per F-04, not `Date.now()`-based).

## Verification — Measured, Not Asserted

| Check | Result |
|---|---|
| `npx vitest run test/logging-mask.test.ts test/agent-replacement.test.ts test/agent-auth.test.ts test/agent-heartbeat-timeout.test.ts test/agent-disconnect-requeue.test.ts` | 5 files / **42 tests** green |
| `npx vitest run test/logging-mask.test.ts` alone | 1 file / **16 tests** green (9 pre-existing + 5 Task 1 + 1 Task 2 [wait: see note] + 1 `mask` group unchanged) |
| `npm test` run 1 | **31 files / 258 tests** green |
| `npm test` run 2 (back-to-back) | **31 files / 258 tests** green — identical |
| Baseline (05-03) | 31 files / 252 tests → +0 files / +6 tests (5 in Task 1's `describe`, 1 in Task 2's `describe`) |
| `npm run typecheck` | exit **0** |
| `npm run build` | exit **0** |
| `git diff --name-only 1c78bb4..HEAD -- src/logging/ src/queue/ src/notifications/ src/ingestion/` | **empty** — masking patterns and every out-of-scope subsystem untouched |
| `git diff --name-only 1c78bb4..HEAD` | `src/agent/agentServer.ts`, `test/logging-mask.test.ts` — matches this plan's `files_modified` exactly |
| `git diff 1c78bb4..HEAD -- src/agent/agentServer.ts` | quoted in full above — only the id mint and its comment |
| Observed message count, Task 2's flow | **29** |
| New npm packages | **0** |
| `mirror-request/.planning/` (stale tree) | untouched — `git status --short -- .planning/` clean throughout |
| Working tree at close-out | clean |

Note on the vitest count line above: `test/logging-mask.test.ts` reports **16** tests total
(3 `mask` + 3 `debugRawPayload gating` + 4 `/on-register log surface` + 5 Task 1's connection-id
block + 1 Task 2's standing-regression block = 16), consistent with the file-level count
reported by `npm test`.

## Deviations from Plan

**1. [Test-fixture-only, not a code deviation] Synthetic job ids in Task 2's flow use the
existing digit-run-breaking `safeId()` technique instead of a raw `Date.now()`-based id**
- **Found during:** Task 2, first run — a `Date.now()`-based job id (`job-flow-${Date.now()}-1`)
  failed the `mask(msg) === msg` assertion because it embedded the same 13-digit run Task 1
  fixes for connection ids.
- **Fix:** job ids built as `` `job-flow-${label}-${randomUUID().replace(/(\d)(?=\d)/g, '$1x')}` ``,
  matching the file's pre-existing `/on-register` block convention.
- **Files modified:** `mirror-request/test/logging-mask.test.ts` (within the already-planned
  Task 2 commit; no separate commit).
- **Not a WINDOWS ledger item:** this is a test-fixture artifact, not a production defect —
  real job ids are backend-minted UUIDs (F-04), and this exact "occasional digit-run collision"
  caveat is already documented at this file's `safeId()` helper for the ingestion surface.

No other acceptance criterion from `05-04-PLAN.md` was found unmet by the committed code.

## Known Stubs

None. No placeholder values, no hardcoded empty returns, no TODO/FIXME introduced by this
plan's commits.

## Threat Flags

None beyond what `05-04-PLAN.md`'s own `<threat_model>` already registers. T-05-04 (mask()
under-masking a real phone number) is closed exactly as that table describes: the false
positive is fixed at the id generator, `src/logging/logger.ts` is byte-for-byte untouched, and
the control case in Task 1 proves the fix is load-bearing without a pattern change. T-05-13 (a
future non-ingestion log line interpolating PII or an object) is closed by Task 2's standing
regression, which drives real code paths through logger spies rather than a one-time audit.
T-05-14 (degraded displaced-Agent diagnostic) is closed: the full id is restored to the log,
and ids no longer repeat across restarts.

## Carry-Forward State for Phase 5 (05-05 gate)

1. **`OPS-RUNBOOK.md` §7's masking-limitation paragraph is now stale** — it describes the old
   id format and the phone-pattern false positive this plan fixes. 05-05 Task 1 updates it.
2. **WINDOWS ledger item 5 becomes eligible to be marked fixed** — this plan closes it (the
   connection id can no longer be partially masked, and ids no longer repeat across restarts).
   Not marked fixed here, per this plan's explicit scope boundary ("Do NOT mark WINDOWS ledger
   item 4 fixed... its disposition is a human decision at the 05-05 gate" — the same posture
   applies to item 5, whose fixed-marking this plan's own `<verification>` section explicitly
   hands to 05-05 Task 2).
3. **WINDOWS ledger item 4 remains open**, untouched by this plan (out of scope, per this plan's
   explicit instruction to leave it alone).
4. **WINDOWS ledger item 6** (D-06 capability-URL entropy, unverified backend id randomness)
   remains open, untouched — out of scope for this plan.

## Self-Check: PASSED

All modified files verified present with expected content:
`src/agent/agentServer.ts`, `test/logging-mask.test.ts` — both FOUND.

Both commit hashes verified in `git log --oneline`: `5301c0e`, `2c0dd44` — both FOUND.

`npm test` re-run in this session, twice back-to-back: **31 files / 258 tests**, identical,
green both times. `npm run typecheck` and `npm run build`: exit 0 both.
`mirror-request/.planning/` (stale tree) confirmed untouched: `git status --short -- .planning/`
returned empty throughout.
