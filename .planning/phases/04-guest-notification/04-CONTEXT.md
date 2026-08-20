# Phase 4: Guest Notification - Context

**Gathered:** 2026-08-10
**Status:** Ready for planning

<domain>
## Phase Boundary

One job: when the Agent reports `file_upload`, look up which guest the job belongs
to and POST their name and photo to the slideshow so it appears on the booth's
display screen. Deliver reliably, retry a bounded number of times, and leave a
record when delivery finally fails.

Out of this phase: the queue and booth state machine (Phase 2, done); the Agent
WebSocket transport that carries the `file_upload` event (Phase 3, done); the
guest-facing status API and the `/display` feed (Phase 5).

**This is a hardening pass over working code, not greenfield.**
`mirror-request/src/notifications/notificationService.ts` (86 lines) already
POSTs and already retries. It arrived in commit `5519364` — the pre-existing
uncommitted work that was committed as a baseline before Phase 1 began, ahead of
its own phase. Planning must audit it rather than assume an empty file.

</domain>

<decisions>
## Implementation Decisions

### Where the photo actually goes — settled, and it corrects an assumption

The webhook target is `web-slide/`, the slideshow app in this workspace. This was
confirmed against its source, not inferred.

**`web-slide/server.js` performs no lookup of any kind** — no database, no
outbound fetch, no client library. It reads fields straight off the request body
with fallbacks (`server.js:64-71`):

```js
jobId: body.jobId || null,
name:  body.guestName || body.name || body.customer_name || 'Khách hàng',
phone: body.phone || body.customer_phone || '',
email: body.email || body.customer_email || '',
imageUrl: file ? `/uploads/${file.filename}` : (body.photoUrl || body.imageUrl || null),
```

- **D-01:** The receiver cannot look a guest up. Whatever the slideshow shows must
  be in the payload. Any plan that assumes the far side resolves a `jobId` is wrong.
- **D-02:** The payload carries **name and photo only** — plus `jobId` and `mode`
  as correlation/metadata. **No email, no phone, no other PII.** The slideshow
  displays a name and an image; it has no use for contact details, so they are not
  sent. Not sending PII is cheaper than protecting it in transit.
- **D-03:** `web-slide`'s `phone` and `email` fields are treated as vestigial for
  this phase. They will receive `''`. That is the intended end state, not drift.

**Historical note the planner must not misread.** `web-slide/webhook-json.log`
records a real delivery from 2026-08-07 whose body *did* include
`"phone":"0901234567"`. The current `notificationService.ts` payload does not.
That divergence is now a deliberate decision (D-02), not a regression to repair.

**A hazard worth naming:** `web-slide` falls back to `''` and `'Khách hàng'`
silently. A payload-shape mistake therefore produces no error anywhere — the
slideshow just shows a blank or a placeholder. Nothing on either side would
report it. Verification for this phase must assert the delivered payload's shape
explicitly rather than trusting a 2xx response.

### Retry must survive a restart — the Phase 2 lesson, one layer up

Today the retry loop is an in-memory `for` with `await setTimeout` sleeps
(`notificationService.ts:48-78`), while `notification_record` persists to SQLite.
A restart mid-retry destroys the loop and leaves the row stranded — nothing
resumes it at boot. **This is structurally the same defect Phase 2 just fixed in
the booth state machine:** the timer lived in memory, the state lived on disk.
There, it stranded four jobs for six hours.

- **D-04:** Replace the in-memory retry loop with a **persisted retry queue**.
  `notification_record` gains a due-time, and a periodic sweeper picks up rows
  that are due. This is restart-proof **by construction**, rather than by
  remembering to add a recovery pass — which is the stronger of the two shapes
  and the reason it was chosen over simply copying Phase 2's boot-recovery step.
  — **Reversibility:** costly — changes the delivery mechanism and the meaning of
  rows already in `notification_record`.
- **D-05:** A notification must never be delivered twice for one `file_upload`.
  Terminal states are terminal; the sweeper must not re-send a row already
  `delivered`.
- **D-06:** Fire-and-forget at the call site becomes acceptable once D-04 lands —
  the sweeper owns retries, so the caller no longer needs to hold the outcome.
  Today's un-awaited call at `queueService.ts:225` is only unsafe *because* the
  retry loop is attached to it.

### Failure posture

- **D-07:** `fetch` must have a timeout. Today it has none, so a `web-slide` that
  accepts a connection and never answers holds the attempt open indefinitely, and
  because the caller does not await, nothing anywhere notices.
- **D-08:** Retry-count semantics align with Phase 2: the configured number is the
  count of retries **after** the first attempt, not the total. Today's loop
  (`attempt <= maxRetries`) means the total, so `NOTIFY_MAX_RETRIES` and
  `SESSION_MAX_RETRIES` currently mean different things in the same system. One
  meaning, both places.
- **D-09:** When retries are exhausted, record the failure durably with a reason
  and log it — matching how Phase 2 records `stall_reason`. An operator must be
  able to find which guests never got their photo.
- **D-10:** Delivery failure must never crash the process or block the queue,
  consistent with Phase 1 D-05's warn-and-continue posture.

### Architecture — settled explicitly, because it decides the whole phase

- **D-11:** `web-slide` **stays a separate service**, reached over HTTP. Confirmed by
  the user. It runs its own Express process on port 3001, with its own
  `package.json` and `uploads/`; `mirror-request` runs on 3002. They are coupled
  only by `NOTIFY_WEBHOOK_URL`.

  This is what makes D-04's persisted retry queue necessary rather than
  over-engineering: a network call between two processes can fail, so delivery
  needs durable retry. Had the two been merged, there would be no webhook and no
  retry layer at all — the photo would be a table write the display reads. That
  alternative was considered and rejected; keeping them separate lets the
  slideshow run on the machine beside the screen and lets its UI change without
  touching the brain.

- **D-12:** There are **two distinct display surfaces**; do not conflate them.
  `web-slide` (port 3001) is the photo slideshow this phase feeds — name and image
  of completed sessions. `mirror-request`'s `WS /display` (port 3002,
  `src/display/displayServer.ts`) is the live booth status feed — current guest,
  queue position, Agent online/offline — and belongs to **Phase 5**. This phase
  must not touch it.

### Scope calls resolved by the orchestrator after research

- **D-13:** `notification_record` has **never stored `photoUrl`** — it exists only as
  a runtime argument read off the live `file_upload` event (`queueService.ts:224-225`).
  Research surfaced this; it was not visible when D-04 was written. A persisted retry
  queue that adds only a due-time is therefore **insufficient**: a restart-resumed
  sweeper would hold a `jobId` with nothing to send. `photoUrl` must become a
  persisted column written at enqueue time. Pre-existing rows with a null `photoUrl`
  cannot be resumed and must be marked failed with an explanatory reason by the
  migration — honestly, rather than left to retry forever against nothing.
- **D-14:** Fixing `test/notification-webhook.test.ts`'s `getStore()` call and its
  hardcoded `'job-webhook-001'` id is **in scope**. The file must be touched anyway for
  the enqueue/sweep split, and it is the last `getStore()` coupling in the notification
  tests. Leaving it would knowingly ship a known-flaky pattern in a file this phase
  already edits.
- **D-15:** Under D-08's semantic flip, `NOTIFY_MAX_RETRIES`'s default becomes **2**,
  giving 3 total attempts. Today's `attempt <= maxRetries` with a default of 3 also
  yields 3 total attempts, so **behaviour is unchanged — only the meaning of the number
  changes.** Keeping the value at 3 while flipping the semantics would silently turn 3
  attempts into 4. This also makes it identical to Phase 2's `SESSION_MAX_RETRIES=2`, in
  both meaning and value.

### The agent's Discretion

- The `fetch` timeout value (a sane default around 10 s) and the sweeper's polling
  interval, provided both are typed config rather than literals — Phases 1-3 all
  removed direct `process.env` reads and that pattern holds.
- The exact schema change to `notification_record` for the due-time, and whether
  the sweeper is its own module or folded into an existing one.
- Backoff curve for the persisted queue, provided it is bounded per D-08.

</decisions>

<specifics>
## Specific Ideas

The end-to-end promise: *"khách đăng ký đều được phục vụ đúng thứ tự... và nhận
được ảnh kết quả tự động"* (PROJECT.md Core Value). Phases 1-3 delivered the first
half. This phase delivers the second — the moment the guest actually sees their
photo. A silently dropped notification is the most visible possible failure to a
guest who is standing right there, and the least visible to the operator, because
nothing errors.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Product scope and requirements

- `.planning/PROJECT.md` — Core Value and the end-to-end flow.
- `.planning/REQUIREMENTS.md` — NOT-01, NOT-02.
- `.planning/ROADMAP.md` §"### Phase 4: Guest Notification" — the two M4 success criteria.

### Decisions inherited

- `.planning/phases/01-foundation-ingestion/01-CONTEXT.md` — D-05 (warn-and-continue,
  never crash), D-13 (SQLite retains contact details), D-15 (masked logs).
- `.planning/phases/02-queue-booth-state/02-CONTEXT.md` — the bounded-retry policy and
  `stall_reason` recording this phase mirrors; **and D-01..D-04, the restart-recovery
  reasoning that D-04 here is a direct descendant of.**
- `.planning/phases/03-agent-websocket-link/03-CONTEXT.md` — D-01, system-side faults
  never charge the guest.

### The receiver

- `web-slide/server.js` §64-71 — the payload fields it reads and its silent fallbacks.
- `web-slide/webhook-json.log` — one real historical delivery, useful as a shape reference
  but **not** as a target shape (see D-02).

</canonical_refs>

<code_context>
## Existing Code Insights

### Repository topology — READ THIS FIRST

- `/opt/mirror_request_dslrobooth` — workspace root. **NOT a git repository.**
- `/opt/mirror_request_dslrobooth/.planning/` — **THE AUTHORITATIVE planning tree.**
- `/opt/mirror_request_dslrobooth/mirror-request/` — the server repo; all of this
  phase's code lives here.
- `/opt/mirror_request_dslrobooth/mirror-request/.planning/` — **STALE, obsolete, git-tracked. DO NOT READ.**
- `/opt/mirror_request_dslrobooth/dslrbooth-agent/` — the Agent repo; not touched by this phase.
- `/opt/mirror_request_dslrobooth/dslrbooth-agent/.planning/` — **a THIRD obsolete tree. DO NOT READ.**
- `/opt/mirror_request_dslrobooth/web-slide/` — the slideshow receiver. **Not a git
  repository either.** This phase should not need to change it; if planning concludes
  otherwise, that is a scope question to raise, not to absorb.

`gsd-tools` resolves planning paths from the current working directory — during plan
03-03 this silently wrote to the stale tree. Run every `gsd_run` command from the
workspace root and check `git status` afterwards.

### Reusable Assets

- `mirror-request/src/notifications/notificationService.ts` — `sendPhotoLink()`, the
  payload construction, the retry loop being replaced, and `NotificationRecord` persistence.
- `mirror-request/src/state/localStore.ts` — `saveNotification()`, `getNotification()`,
  the `notification_record` table (`jobId` PK, `status`, `attempts`, `lastError`,
  `updatedAt`), and `getJobRegistration()` for the guest lookup.
- `mirror-request/src/queue/queueService.ts` — `bindNotificationService()` and the
  `file_upload` branch at line 225 that triggers delivery.
- `mirror-request/src/config.ts` — `NOTIFY_WEBHOOK_URL`, `NOTIFY_MAX_RETRIES`,
  `NOTIFY_RETRY_BASE_DELAY_MS` already typed.

### Established Patterns

- Persist state that must survive a restart; never leave a timer as the only record
  of pending work (Phase 2, learned the hard way).
- Typed config injection, no direct `process.env` reads (Phases 1-3).
- Warn-and-continue at network boundaries.

### Test-suite caveat (inherited, still open)

`.planning/WINDOWS.md` ledger item 4 remains open: all test files share one test DB
via the `getStore()` singleton while vitest runs files in parallel. `notification_record`
is keyed by `jobId`, so tests scoped to their own generated ids are naturally safer here
than Phase 2's single-row `booth_state` was — but no new test may call `getStore()`, and
the two pre-existing notification test files (`test/notification-service.test.ts`,
`test/notification-webhook.test.ts`, both from `5519364`) should be audited for that
coupling. Ledger item 5 (connection-id log masking) is unrelated to this phase.

</code_context>

<deferred>
## Deferred Ideas

- Sending the photo to the guest directly by email or SMS. The slideshow is a
  display surface, not a delivery channel to the guest's phone. If that capability
  is wanted, it is a separate channel and a separate decision — explicitly not
  folded into this phase (D-02).
- Signing the outbound webhook the way `/on-register` is signed inbound (Phase 1
  §1 contract). Not needed while the payload carries no PII; revisit if D-02 is
  ever reversed.
- Changing `web-slide` itself — out of scope.
- Giving each test file its own database — still open ledger item 4.

</deferred>

---

*Phase: 04-guest-notification*
*Context gathered: 2026-08-10*
