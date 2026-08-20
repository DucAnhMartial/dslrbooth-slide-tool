# Phase 5: Client API & Display Feed - Research

**Researched:** 2026-08-11
**Domain:** Express/WS read-surface hardening over an existing, working Node.js/TypeScript service (guest status API, big-screen display feed, log masking)
**Confidence:** HIGH for code-level findings (everything below is grounded in files opened this session); MEDIUM/LOW for two specific design choices flagged in the Assumptions Log; the D-07 entropy question is explicitly **unverifiable from inside this repo** and must escalate.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

All decisions below are from `.planning/phases/05-client-api-display-feed/05-CONTEXT.md`, made by Claude (delegated by the user's explicit "Ok tiếp tục đi"), reversible until planning starts, and copied verbatim:

**Estimated wait (closes F-01)**
- **D-01** — The estimate is computed from real session durations, not a constant. The data already exists: `queue_job` carries `session_started_at`, `session_ended_at` and `completed_at` (`src/state/localStore.ts:34-47`). A hardcoded "5 phút × vị trí" would be wrong on day one and stay wrong. **(See "Corrections to F-01/D-01" below — `session_started_at` is verified dead; the usable field is `acknowledged_at`.)**
- **D-02** — Use the median, and exclude poisoned samples. Median, not mean: a single session that hit Phase 2's 5-minute BUSY timeout would drag a mean upward for hours. Sessions that ended via `TIMEOUT_RESET`, or whose job reached `failed`, are excluded from the sample entirely — they measure the fault, not the booth.
- **D-03** — Present a range, rounded up, never a precise ticking number. "khoảng 3-5 phút", not "4:12". Round up: better to call a guest early than late.
- **D-04** — Cold start has an explicit configured fallback. Below a configured minimum sample count, use a configured default duration. Both are config values, not literals.
- **D-05** — When the booth cannot serve, suppress the estimate rather than lie. Agent offline or booth `TIMEOUT_RESET` → no estimate, status says the booth is paused.

**Access control**
- **D-06** — `/status/:jobId` is a capability URL. No additional authentication. The UUID *is* the credential.
- **D-07** — Record the inherited-entropy assumption honestly. The researcher must confirm the backend generates the id with a CSPRNG. If that cannot be confirmed, D-06 is unsound and the phase must escalate. **(See below — confirmed unconfirmable; escalation required, not optional.)**
- **D-08** — Unknown jobId returns a single generic 404. Identical status/body whether never-existed, purged, or someone else's.
- **D-09** — `/display` and `/display-screen` are gated by IP allow-list, NOT a Bearer header — the browser WebSocket API cannot set request headers, so Phase 3's header pattern cannot transfer. Reuse Phase 1's allow-list machinery (`config.PROXY_IP_WHITELIST` pattern, generic-403 posture) with its own separate config key.
- **D-10** — Explicitly reject a shared token in the WebSocket URL. Against an allow-listed attacker it adds nothing; a browser forces it into the query string, landing in logs/history/`Referer`. Do not reintroduce Phase 3's deleted anti-pattern one phase later.

**What the guest sees when things go wrong**
- **D-11** — Guest-facing status is a closed vocabulary; internal words never cross the boundary. `dispatched`, `in_progress`, `stall_reason`, `retries`, `ack_error_message`, `TIMEOUT_RESET` are operator language. The guest-facing set: waiting, your turn now, session in progress, finished (photo sent), finished (photo still sending), please see staff.
- **D-12** — Every terminal/fault state from Phases 2-4 maps to exactly one guest-facing message, exhaustively. Exhausted retries → "please see staff". No Agent → paused. Notification retrying/failed → finished, photo state stated honestly.

**The big screen**
- **D-13** — Broadcast on change, plus one tick/second while a countdown runs. Replace the unconditional 250ms interval.
- **D-14** — Full name for the called guest (hero); given name only for the up-next list. Vietnamese naming: given name is the trailing token (`Nguyễn Văn A` → `A`).
- **D-15** — PII cannot reach the display wire by construction. Replace `currentJob: QueueJob` with a purpose-built projection carrying only what the screen renders. The guarantee lives in the type's shape, not a null check or a deletable step — same structural principle as Phase 4's D-05.
- **D-16** — Inject the store into `DisplayServer`; delete the module-scope `getStore()`. Closes WINDOWS.md ledger item 4. `/gsd-ship` blocks while it's open.

**AUTH-03**
- **D-17** — Enumerate the remaining non-ingestion log surfaces before masking them; don't assume Phase 1 covered everything. Note `mask()`'s `PHONE_RE` over-matches connection-id timestamps (WINDOWS.md item 5).

### Claude's Discretion

CONTEXT.md contains no separate "Claude's Discretion" section — every gray area the user was offered was already resolved into the locked decisions (D-01..D-17) above before this research began. Two implementation-level design choices remain genuinely open within those decisions (how to construct a *range* from a single median; whether to keep or delete the `currentJob` field entirely) — these are called out explicitly in the Assumptions Log, not silently decided here.

### Deferred Ideas (OUT OF SCOPE)

- Idempotency key on the `web-slide` receiver (at-least-once delivery, a different service/phase).
- Historical/analytics views over job history. Not in M5. (There is, in fact, no separate `job_history` table — see "Corrections" below.)
- Operator-facing dashboard. `/display-screen` is guest-facing; an operator console is a different capability.

**Phase boundary (verbatim):** IN scope: the two read surfaces, their access control, their failure presentation, the remaining log-masking surfaces. OUT of scope: any change to queue dispatch policy (Phase 2), the Agent link (Phase 3), or notification delivery (Phase 4) — Phase 5 **reads** their state; it must not alter their behaviour.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| API-01 | `GET /status/:jobId` — queue position + estimated wait for the guest | See "The estimated-wait calculation" and "The `/status/:jobId` guestName bug" below; verified schema in `src/state/localStore.ts`; D-01..D-05, D-08, D-11, D-12 |
| API-02 | `WS /display` — realtime feed: current guest name + Agent online/offline | See "The `DisplaySnapshot.currentJob` type lie" and "Access control for the display feed" below; verified in `src/display/displayServer.ts`, `src/types.ts`; D-09, D-10, D-13, D-14, D-15, D-16 |
| AUTH-03 | Sensitive data masked in all logs (non-ingestion surfaces only — ingestion shipped in Phase 1) | See "AUTH-03's remaining non-ingestion log surfaces" below; every non-ingestion `logger.*`/`queueLogger.*`/`notifyLogger.*` call site enumerated and read; D-17 |
</phase_requirements>

---

## Summary

This is the fourth consecutive hardening phase over working code. Both routes exist, both existing tests pass, and this research reconfirms every one of CONTEXT.md's verified findings (F-01 through F-04) by reading the actual source — but it also found **three load-bearing corrections** CONTEXT.md could not have caught without reading `localStore.ts` end-to-end and querying the live local databases, and they change what the planner must build:

1. **`session_started_at` is dead schema.** CONTEXT.md's D-01 says the estimate can be built from `session_started_at`/`session_ended_at`/`completed_at`. Grepping every `updateJobStatus(` call site in the repository shows `session_started_at` is declared as a column and as a valid map key, but **zero code paths ever write it** — it is permanently `NULL`. The real "session start" timestamp the code actually populates is `acknowledged_at` (written by `sessionAcked()`). A query built against `session_started_at` would silently return zero samples forever, permanently falling back to the D-04 cold-start default and never learning anything — with no error, no test failure, just a wrong number that never gets better.
2. **`/status/:jobId`'s `guestName` field is already broken in production, today, independent of this phase.** `job.registration?.name` at `src/index.ts:47` reads a property that never exists at runtime (`store.getJob()` is `SELECT * FROM queue_job`, a bare row with no `registration` join) — so `guestName` has been `null` on every real response since this route shipped. Phase 5 must fix this as part of redesigning the response shape (via `store.getJobRegistration()`, which does the join correctly and already exists), not just add an estimate on top of a field that was already silently broken.
3. **`DisplaySnapshot.currentJob` is not just a type lie — it is leaking operator-internal fields on the wire today**, to anyone who can open `/display` (currently nobody is blocked — the endpoint has no auth). `store.getNextQueuedJob()` is `SELECT * FROM queue_job ... LIMIT 1`, so every field on that table — `stall_reason`, `ack_error_message`, `retries`, `registration_id` — is serialized into every snapshot broadcast whenever a job is queued. This is D-11's closed-vocabulary principle already being violated on the *other* read surface, not just `/status/:jobId`.

A fourth finding changes the planner's risk posture rather than the implementation: **D-07's entropy assumption cannot be verified from inside this repository, and the only "UUID-shaped" sample this project has ever recorded (`000d3528-c10d-4d0f-...`, quoted in CONTEXT.md's F-04) traces back to this repo's own `crypto.randomUUID()` test fixtures, not to a real dslrBooth-minted id** — the actual production local store contains zero organic backend-minted registrations; every row in it is a hand-typed test/seed value (`registration-20260806-0001`, `job-webhook-001`, etc.). This is not a research gap that more grepping can close — it requires a human with access to dslrBooth's real behaviour (or its vendor) to answer, and D-07 already says what to do if it can't be confirmed: escalate, don't ship quietly.

**Primary recommendation:** build the estimate from `acknowledged_at`→`completed_at` durations on `status='completed'` rows (D-02's exclusion of poisoned samples falls out structurally — a stalled/failed job can never reach `status='completed'`, so no extra filtering code is needed); fix `/status/:jobId`'s response shape and its `guestName` bug together; replace `DisplaySnapshot.currentJob`'s type with a minimal, PII-incapable projection (or delete the field — nothing consumes it, verified against `displayPage.ts` and against `web-slide/`); gate `/display` and `/display-screen` with a new `DISPLAY_IP_WHITELIST` config key using the exact `clientIp`/`isWhitelisted` pattern already proven in `mirrorReceiver.ts`, reimplemented in a new small module rather than editing Phase 1's file; inject `LocalStore` into `DisplayServer`'s constructor exactly like `QueueService`'s existing pattern; and escalate D-07 as a blocking checkpoint rather than assume it.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| `GET /status/:jobId` (position + estimated wait) | API / Backend | Database / Storage | All computation (median, range, vocabulary mapping) happens server-side; SQLite is the sole data source, read-only |
| `WS /display` snapshot construction & broadcast | API / Backend | — | `DisplayServer` owns timing, change-detection, and the projection shape entirely server-side |
| `/display` feed rendering (countdown pulse, guest list) | Browser / Client | API / Backend | `displayPage.ts`'s inline `<script>` renders what the server sends; the server never pushes HTML, only JSON |
| `GET /display-screen` (static page) | API / Backend | Browser / Client | Backend serves one static HTML/CSS/JS payload; the browser then opens its own `/display` WS connection |
| Access control for `/display`, `/display-screen` | API / Backend | — | IP allow-list is enforced at the HTTP `upgrade` event and Express middleware — a browser client cannot participate in its own authorization (D-09) |
| Estimated-wait computation | API / Backend | Database / Storage | Pure function over data queried from SQLite (`acknowledged_at`, `completed_at` on `status='completed'` rows) |
| Log masking (AUTH-03) | API / Backend | — | The winston pipeline runs entirely inside the Node process; it is cross-cutting infrastructure, not a data-tier or client-tier concern |

---

## Standard Stack

No new external packages are required for this phase. Every capability below is buildable with what is already in `package.json`.

### Core (already installed, reused)
| Library | Version (verified in `package.json`) | Purpose in Phase 5 | Why not a new dependency |
|---------|---------|---------|--------------|
| `express` | `^4.21.1` | `/status/:jobId`, `/display-screen` routing, IP-allow-list middleware | Same router/middleware pattern already used in `mirrorReceiver.ts` |
| `ws` | `^8.18.0` | `/display` WS server (already in use) | `WebSocketServer({ noServer: true })` + `httpServer.on('upgrade', ...)` is the exact pattern in both `agentServer.ts:59-80` and `displayServer.ts:23-33` today |
| `better-sqlite3` | `^11.0.0` | Reading `queue_job` for session durations | Synchronous, already the only DB driver in `localStore.ts` |
| `winston` / `winston-daily-rotate-file` | `^3.14.2` / `^5.0.0` | Log masking pipeline (AUTH-03) | Already wraps every log call through `mask()`; no new transport needed |
| `vitest` / `supertest` | `^2.1.4` / `^7.2.2` | New test files for API-01/02/AUTH-03 | Matches every existing test file's tooling |

### Don't add
- A statistics library (`simple-statistics`, `d3-array`, etc.) for the median/range calculation — see "Don't Hand-Roll" below, this is intentionally excluded, not an oversight.
- A rate-limiting or auth middleware package (`express-rate-limit`, `passport`, etc.) — D-06 and D-09 both deliberately choose *no additional auth layer*; adding one would contradict the locked decisions.

**Installation:** none required — `npm install` with the existing `package.json` is sufficient.

## Package Legitimacy Audit

**Not applicable this phase.** No new external packages are introduced by any of the locked decisions (D-01 through D-17); every capability is implemented with libraries already present in `package.json` (verified above) plus in-repo TypeScript. If the planner's task breakdown surfaces a need for any additional package, re-run the Package Legitimacy Gate protocol against it before adding it to `package.json`.

---

## Corrections to CONTEXT.md's Verified Findings

CONTEXT.md's F-01 through F-04 were independently reconfirmed by reading the same files this session. Three additions/corrections were found that materially change what the planner should build. These are not disagreements with CONTEXT.md's decisions (D-01..D-17 stand) — they are corrections to the *data* those decisions assumed.

### Correction 1 — `session_started_at` is dead; use `acknowledged_at`

`src/types.ts:21` declares `session_started_at?: number` on `QueueJob`, and `src/state/localStore.ts:186-194`'s `updateJobStatus()` accepts it as a valid `tsField`:

```
186	  updateJobStatus(id: string, status: QueueJob['status'], tsField: keyof QueueJob, tsValue: number): void {
187	    const map: Record<string, string> = {
188	      dispatched_at: 'dispatched_at', acknowledged_at: 'acknowledged_at',
189	      session_started_at: 'session_started_at', session_ended_at: 'session_ended_at',
190	      completed_at: 'completed_at',
191	    };
```

But every actual call site was grepped (`grep -rn "updateJobStatus(" src/` outside `localStore.ts` itself) and there are exactly two, in `src/queue/queueService.ts`:

```
167:    this.store.updateJobStatus(jobId, 'in_progress', 'acknowledged_at', Date.now());
280:    this.store.updateJobStatus(job.id, 'dispatched', 'dispatched_at', now);
```

`'session_started_at'` never appears as an argument anywhere in `src/` or `test/` (confirmed by a second grep for the literal string `session_started_at\s*=` across both trees — zero matches). The column is permanently `NULL`.

`[VERIFIED: mirror-request/src/queue/queueService.ts:167,280 and mirror-request/src/state/localStore.ts:186-194]` — quoted verbatim above.

The field that *is* actually written and means "the session began, from this service's point of view" is `acknowledged_at`, set inside `sessionAcked()`, which fires on both a positive Agent ack (`onAgentAck(jobId, true, ...)`) and the Agent's own `session_start` event (`onAgentEvent('session_start', jobId)`). `completeInProgressJob()` (`localStore.ts:220-229`) is the sole writer of `session_ended_at`/`completed_at`, both stamped with the same `endedAt` value:

```
220	  completeInProgressJob(endedAt: number): string | undefined {
221	    const job = this.db.prepare(
222	      "SELECT id FROM queue_job WHERE status = 'in_progress' ORDER BY acknowledged_at DESC LIMIT 1"
223	    ).get() as { id: string } | undefined;
224	    if (!job) return undefined;
225	    this.db.prepare(
226	      "UPDATE queue_job SET status = 'completed', session_ended_at = ?, completed_at = ? WHERE id = ?"
227	    ).run(endedAt, endedAt, job.id);
228	    return job.id;
229	  }
```

**Recommended field pair for the duration measurement: `completed_at - acknowledged_at`** (equivalently `session_ended_at - acknowledged_at`, identical value — either column works; `completed_at` is used below for its more final-sounding name).

### Correction 2 — D-02's "exclude poisoned samples" is already structural; no extra filter code is needed

Because `completeInProgressJob()` (above) is the *only* code path that ever writes `status = 'completed'`, and it can only run against a job whose status is currently `'in_progress'` (line 222's `WHERE status = 'in_progress'`), and the *only* code path that ever sets `status = 'in_progress'` is `sessionAcked()`'s `updateJobStatus(jobId, 'in_progress', 'acknowledged_at', ...)` (queueService.ts:167) — a job that stalls (`handleStall()`, `requeueWithRetry`/`requeueNoRetry`/`failJob`) never becomes `'completed'`. Its status goes back to `'queued'` (retry) or to `'failed'` (exhausted). Concretely:

```sql
-- LocalStore method to add:
SELECT completed_at - acknowledged_at AS duration_ms
FROM queue_job
WHERE status = 'completed' AND acknowledged_at IS NOT NULL AND completed_at IS NOT NULL
ORDER BY completed_at DESC
LIMIT ?
```

The `WHERE status = 'completed'` clause *is* D-02's exclusion — there is no `stall_reason IS NULL` or `retries = 0` condition to add, because a poisoned row is structurally incapable of reaching `'completed'`. This is the same "guarantee lives in what the query omits" pattern already used for `requeueWithRetry()` (D-06's FIFO-position guarantee, `localStore.ts:237-246`) and `getDueNotifications()` (Phase 4's D-05, `localStore.ts:424-438`) — Phase 5 should follow the identical idiom rather than add an `if` in application code. A job that eventually *succeeds* after one or more retries is not excluded and should not be: its final `acknowledged_at` is overwritten by the successful attempt's `sessionAcked()` call (the `UPDATE ... SET ... acknowledged_at = ?` on redispatch replaces the earlier failed attempt's stale value), so the measured duration reflects the real completed session, not the earlier stall.

`ORDER BY completed_at DESC LIMIT ?` recency-bounds the sample — recommended (not locked) so the estimate tracks recent booth performance rather than being diluted by data from weeks earlier, given `queue_job` is retained forever by design (D-14 in Phase 1, restated in `docs/OPS-RUNBOOK.md` §2: unbounded growth, manual pruning only).

### Correction 3 — there is no `job_history` table

The phase description's research priorities mention "`job_history`" as a possible data source. `src/state/localStore.ts:22-75`'s `bootstrap()` creates exactly seven tables: `registration`, `queue_job`, `processed_id`, `db_poll_cursor`, `notification_record`, `booth_state`, `webhook_replay`. There is no `job_history` table anywhere in the schema. `queue_job` itself *is* the history — Phase 1's D-14 retention policy means completed/failed rows are never deleted (`docs/OPS-RUNBOOK.md:79-100` §2), so `queue_job` doubles as its own historical record. The planner should not design around a table that doesn't exist.

`[VERIFIED: mirror-request/src/state/localStore.ts:22-75]` (the full `bootstrap()` method, read in this session).

---

## The estimated-wait calculation (F-01, closes API-01's largest gap)

### What data exists, verified against the schema

`queue_job` (`localStore.ts:34-47`) columns relevant to timing, verified verbatim:

```
34	      CREATE TABLE IF NOT EXISTS queue_job (
35	        id TEXT PRIMARY KEY,
36	        registration_id TEXT NOT NULL,
37	        status TEXT NOT NULL DEFAULT 'queued',
38	        queued_at INTEGER NOT NULL,
39	        dispatched_at INTEGER,
40	        acknowledged_at INTEGER,
41	        session_started_at INTEGER,
42	        session_ended_at INTEGER,
43	        completed_at INTEGER,
44	        ack_error_message TEXT,
45	        stall_reason TEXT,
46	        retries INTEGER NOT NULL DEFAULT 0
47	      );
```

Usable timeline per job (verified from the writers above and `dispatchJob()`/`sessionAcked()`/`completeInProgressJob()`):

`queued_at` (enqueue) → `dispatched_at` (Agent told to start) → `acknowledged_at` (Agent confirmed session actually started) → `completed_at`/`session_ended_at` (session finished).

What does **not** exist: no partial-progress signal for an in-flight session (no "N seconds into a 90-second capture sequence"), no historical queue-*wait* telemetry (only session *duration* is recoverable — the time a job spent literally queued before dispatch is derivable as `dispatched_at - queued_at` per job, but that number is itself a function of the current queue depth at the time, not useful as an independent input; the useful invariant to model is *service time per guest*, not *historical wait time*), and no separate `job_history` table (Correction 3, above).

### Recommended computation

1. **Sample:** `completed_at - acknowledged_at` for the most recent N `status='completed'` rows (Correction 2's structurally-clean query). N is a config value (`WAIT_ESTIMATE_SAMPLE_SIZE` or similar), not a literal (consistent with D-04's instruction that both the minimum sample count and the cold-start default are config values).
2. **Median:** sort the sample array, take the middle value (or average of the two middle values on an even count) — pure JS, `Array.prototype.sort` + index math. No library (see Don't Hand-Roll).
3. **Cold start (D-04):** if the sample count is below a configured minimum (e.g. `WAIT_ESTIMATE_MIN_SAMPLES`), use a configured default duration (`WAIT_ESTIMATE_DEFAULT_MS`) instead of the computed median. Both new keys belong in `EnvConfig`/`config.ts` alongside the existing `NEXT_GUEST_COUNTDOWN_MS`/`SESSION_TIMEOUT_MS` pattern (`config.ts:94-97`).
4. **Guests ahead:** for a queued job, `guestsAhead = (queuePosition - 1) + (boothState === 'BUSY' || boothState === 'ANNOUNCING' ? 1 : 0)`. The `+1` accounts for whichever session is currently running or about to be dispatched, which is not itself in the `queued` set `getQueuePosition()`/`getQueueLength()` count (`localStore.ts:196-198,331-341` both filter `WHERE status = 'queued'`).
5. **Point estimate:** `medianDurationMs * guestsAhead`.
6. **Range presentation (D-03):** round the point estimate *up* to the nearest whole minute for the upper bound (never show less time than might really be needed — "better to call a guest early than late," per D-03's own reasoning); use one whole minute below that as the lower bound, floored at a sane minimum (e.g. never below 1 minute once `guestsAhead >= 1`). Example: point estimate 4.2 min → "khoảng 4-5 phút". This directly implements D-03 using only the single median value D-02 mandates, without inventing separate percentile machinery. **This exact range-construction rule is not explicitly locked in CONTEXT.md — flagged in the Assumptions Log below as a genuinely open implementation choice**, not a verified fact.
7. **Suppression (D-05):** if `!agentServer.isAgentOnline()` or `boothState === 'TIMEOUT_RESET'`, omit the estimate field entirely (not `null` inside a wrapper — literally absent, or an explicit `unavailable: true` flag the guest-facing copy keys off of) and set the guest-facing status to "paused."

### Where this lives

A new small pure module (e.g. `src/status/estimateWait.ts`) exporting a function like `estimateWaitMs(durations: number[], guestsAhead: number, config: {...}): { lowMs: number; highMs: number } | null` is the right shape — testable with plain arrays, zero DB, zero mocking, matching the project's existing preference for isolating pure logic (compare `queueService.ts`'s `handleStall()` being the single definition of retry policy, reused by both the sweep and the live timer). `LocalStore` gains one new read method (the `SELECT` in Correction 2); the route composes the two.

---

## Fixing the `DisplaySnapshot.currentJob` type lie (F-02) structurally

### The lie, verified

`src/types.ts:69-79`:

```
69	export interface DisplaySnapshot {
70	  currentJob: QueueJob | null;
71	  queuePosition: number;
72	  queueLength: number;
73	  boothState: BoothState;
74	  agentOnline: boolean;
75	  guestName: string | null;
76	  countdownSeconds: number | null;
77	  announcementEndsAt: number | null;
78	  upNext: Array<{ jobId: string; name: string; position: number }>;
79	}
```

`QueueJob.registration` (`types.ts:15`) is declared `Registration` (required, not optional), and `Registration` (`types.ts:3-11`) carries `email`, `phone`, `qr_token`. At runtime, `currentJob` is populated from `store.getNextQueuedJob()`:

```
204	  getNextQueuedJob(): QueueJob | undefined {
205	    return this.db.prepare("SELECT * FROM queue_job WHERE status = 'queued' ORDER BY queued_at ASC LIMIT 1").get() as QueueJob | undefined;
206	  }
```

a bare `SELECT *` on `queue_job` with **no join to `registration`** — the row has no `registration` property at all, so `.registration` is `undefined` at runtime against a type that promises it is required.

### This is a live leak of operator-internal fields today, not just a hypothetical future PII leak

`SELECT *` on `queue_job` returns every column, including `stall_reason`, `ack_error_message`, `retries`, and `registration_id` (the internal foreign key). `displayServer.ts:55-75`'s `broadcastSnapshot()` puts that row directly on the wire as `currentJob: job ?? null` every time a job is queued, to every connected `/display` client — and today `/display` has no authentication or access control at all (F-01/D-09's subject). `displayPage.ts`'s client-side `render(data)` function (the entire 60-line file was read this session) never references `data.currentJob` in any form — grep for `currentJob` inside the file returns nothing. So the field is pure unused surface area: it adds no guest value and leaks internal vocabulary that D-11 explicitly forbids crossing to a guest-visible surface (D-11 names `/status/:jobId` specifically, but the same "operator words never cross the boundary" principle plainly applies to the other guest/public-facing read surface too).

`[VERIFIED: mirror-request/src/display/displayPage.ts full file, mirror-request/src/display/displayServer.ts:55-75, mirror-request/src/state/localStore.ts:204-206]`

Cross-checked against the sibling `web-slide/` service (a separate, unrelated receiver — out of Phase 5 scope) to make sure nothing external depends on `currentJob`'s current shape: `grep -rn "currentJob" web-slide/` returns nothing.

### Recommended structural fix

**Delete the `currentJob` field from `DisplaySnapshot` entirely.** Nothing consumes it (verified above), and its current shape is actively leaking operator internals. This is a stronger structural guarantee than shrinking its type: a deleted field cannot leak anything, by construction, the same way Phase 4's D-05 expresses a guarantee by what a SQL `WHERE` clause *omits* rather than by a runtime check that a later edit could delete.

**If a future need for a "what job is being served" reference resurfaces**, add a new, deliberately minimal type at that time — e.g. `{ jobId: string; status: 'queued' | 'dispatched' | 'in_progress' }` — with no `registration` property in its type at all, so `snapshot.currentJob.registration.name` is a compile error, not a runtime crash. This is the "unrepresentable" property CONTEXT.md's D-15 asks for: the guarantee lives in the shape having no such property, not in a null check that a later line could route around.

**This specific choice (delete vs. minimal-projection-and-keep) is not explicitly locked by D-15's wording** ("carrying only the fields the screen renders" — which today is zero fields, hence "delete" is the literal reading, but a planner could reasonably choose to keep a minimal id-only field instead). Flagged in the Assumptions Log.

---

## Access control for the display feed and screen

### Why D-09 diverges from Phase 3's pattern, and why that divergence is correct

Phase 3's Agent auth (`agentServer.ts:34-57,65-75`) works because the Agent is a Node.js process that can set an `Authorization: Bearer <token>` header before the WebSocket handshake. A browser's `new WebSocket(url)` constructor has **no mechanism to set arbitrary request headers** — this is a Fetch/WHATWG API limitation, not a library gap, and no combination of `ws`/Express configuration on the server side can work around it from the client. D-09's choice of IP allow-list over Bearer header is therefore not a style preference; it is the only mechanism available given the browser constraint, cross-checked against the fact that `displayPage.ts`'s own client script (`renderDisplayPage()`, line 57) constructs the WS connection with `new WebSocket(protocol + '://' + location.host + '/display')` — no header-setting call exists in the standard API for it to use even if the code wanted to.

### Reuse, don't edit, Phase 1's allow-list logic

`clientIp()` and `isWhitelisted()` (`mirrorReceiver.ts:35-54`) are **not exported** — they are closures defined inside `createMirrorReceiver()`. D-09 says "reuse Phase 1's allow-list machinery... with its own separate config key." Given the phase boundary rule ("Phase 5 reads state; it must not alter behaviour" — explicitly scoped to Phases 2-4, but Phase 1's ingestion tests are equally live and this phase has no reason to touch them), the lowest-risk path is:

**Recommended: create a new, small module (e.g. `src/security/ipAllowlist.ts`) that re-implements the identical `clientIp`/`isWhitelisted` logic as pure exported functions, used by both the new `/display` upgrade check and the `/display-screen` Express route.** Do not edit `mirrorReceiver.ts`. This duplicates roughly 15 lines but leaves Phase 1's already-green test suite (`test/on-register-auth.test.ts` and friends) completely untouched, at zero behavioral-drift risk — consistent with this project's demonstrated caution (STATE.md records four separate "do not touch a prior phase's file" boundaries already respected across Phases 2-4).

```typescript
// Source: pattern verified against mirror-request/src/ingestion/mirrorReceiver.ts:35-54
export function clientIp(req: { ip?: string; socket: { remoteAddress?: string } }): string {
  return (req.ip || req.socket.remoteAddress || '').split(',')[0].trim();
}

export function isWhitelisted(ip: string, whitelist: string[]): boolean {
  if (whitelist.length === 0) return true; // dev escape hatch, same as Phase 1
  return whitelist.some((allowed) => {
    if (allowed.endsWith('.*')) return ip.startsWith(allowed.slice(0, -2));
    return ip === allowed;
  });
}
```

### Where the check runs

- **`/display` (WS):** inside `DisplayServer.start()`'s existing `httpServer.on('upgrade', ...)` handler (`displayServer.ts:27-33`), **before** `wss.handleUpgrade()` is called — the same upgrade-time-rejection pattern Phase 3 chose deliberately (`agentServer.ts:65-75`: write a raw HTTP status line to the socket, then `socket.destroy()`, never letting an unauthorized peer hold an open connection). Use `403`, matching the generic-403 posture `mirrorReceiver.ts:59-62` already established for a blocked IP (not `401`, which implies "provide credentials and retry" — there is nothing to provide here).
- **`/display-screen` (HTTP):** a small Express middleware ahead of the existing `app.get('/display-screen', ...)` route (`index.ts:29`), returning the identical generic `403` body.

### D-10: no `?token=` fallback, and why

Rejecting a URL-embedded token is not just "avoid Phase 3's deleted anti-pattern for symmetry" — it is concretely worse than doing nothing here: a browser cannot avoid putting a WS URL's query string into its own history and into any `Referer` header sent by same-origin subsequent requests, and this server's Express access/error logs would also capture the full URL including the token. Skipping it entirely (D-10) is correct; there is no secondary mechanism to add.

### Where the guest-experience cost would exceed the benefit

`GET /status/:jobId` (D-06) explicitly does **not** get IP-gated or otherwise hardened beyond the capability-URL property itself — a guest's phone is very likely on a different network path than the room's allow-listed LAN (mobile data, a different Wi-Fi VLAN, etc.), so applying `/display`'s IP allow-list to `/status/:jobId` would break the feature for the exact guest it exists to serve. This is the concrete case where "the user's stated priority is guest experience" resolves the tradeoff: `/display`'s room-screen access control costs nothing in guest experience (nobody but the room's own network needs it), while any authentication on `/status/:jobId` would cost real guest experience (a login/PIN step on a phone that just scanned a QR code) for a threat (a stranger guessing another guest's 122-bit id) that D-06/D-07 already judge low, conditional on the entropy assumption holding.

---

## D-07: the entropy assumption cannot be confirmed from inside this repository — escalate

This is the single highest-priority open item for the planner to carry forward as a blocking checkpoint, not a research task to keep chasing.

### What CONTEXT.md's F-04 sample actually is

CONTEXT.md quotes `000d3528-c10d-4d0f-94ba-d502c6202993` as a "sampled" UUIDv4-shaped id and concludes "~122 bits of entropy... inherited from the upstream backend." Tracing where UUID-shaped ids actually appear in this repository:

```
test/queue-idempotency.test.ts:37:    return `${prefix}-${randomUUID().replace(/(\d)(?=\d)/g, '$1x')}`;
test/logging-mask.test.ts:88:  return randomUUID().replace(/(\d)(?=\d)/g, '$1x');
test/on-register-dedup.test.ts (11 call sites): randomUUID()
```

Every one of these is `crypto.randomUUID()` called **inside this repository's own test fixtures**, to synthesize fake registration payloads for testing *this service's* dedup/idempotency logic. `crypto.randomUUID()` genuinely is CSPRNG-backed (Node's implementation), but that only proves this codebase's *test data* is well-randomized — it says nothing about how the real, external dslrBooth backend (a proprietary commercial photobooth product, per `PROJECT.md`: "nhận event từ dslrBooth") generates its own `registrations.id` column, which is the actual value that ends up as `jobId` (`dbPoller.ts:117-126`, `mirrorReceiver.ts:76,111-134`: `id` is taken verbatim from the inbound payload/row with **no `randomUUID` call anywhere in `src/`**, confirmed by `grep -rn "randomUUID" src/` returning zero matches).

### What the actual production data shows — and it contradicts the UUID assumption

Read-only query against this service's own local store (`data/extension-service.sqlite`, the exact command pattern already documented in `docs/OPS-RUNBOOK.md` §6's "Read-only inspection"), run this session:

```
registration count: 6
id: 'registration-20260806-0001'
id: 'registration-20260806-0002'
id: 'clean-test-20260806-154309'
id: 'registration-20260806-02331'
id: 'registration-20260806-04431'
id: 'job-webhook-001'
```

`[VERIFIED: mirror-request/data/extension-service.sqlite, registration table, queried read-only via better-sqlite3 this session — not assumed]`

None of these are UUIDs. They are sequential, human-typed, predictable strings — clearly manual test/seed fixtures from earlier phases (`job-webhook-001` is the exact id STATE.md's Phase 2 checkpoint (02-04) records as a 3.4-day-stale row deleted by the human during the restart-recovery checkpoint). **This service's production local store has never recorded a single organic, dslrBooth-originated registration id.** There is no evidence anywhere in this project — not in the codebase, not in the local databases, not in `docs/OPS-RUNBOOK.md`, not in `.planning/` — of what a real backend-minted id actually looks like.

A web search for dslrBooth's internal database/ID schema (dslrBooth is a real, publicly-sold commercial product, recently rebranded LumaBooth) returned no public technical documentation of its schema or id-generation method — this is proprietary, vendor-internal information not discoverable through research.

### What this means for the plan

**D-06 (`/status/:jobId` as a capability URL, no additional auth) rests entirely on an assumption this research cannot confirm and no available source can confirm either.** Per D-07's own instruction ("If that cannot be confirmed, D-06 is unsound and the phase must escalate rather than quietly ship a guessable capability URL"), the plan must include an explicit blocking checkpoint asking a human with real knowledge of the dslrBooth installation (its config, its documentation, or a direct query against the real backend `registrations.id` column via the existing read-only `DB_POLL` connection, which the human can run but this research phase should not attempt given the "never write, read-only SELECT only" hard rule and the sandbox's denial of `.env*` access) to confirm the id generation mechanism before D-06 ships as designed. If it cannot be confirmed, the fallback is **not** "assume it's fine" — plausible fallbacks to present at that checkpoint include: minting a fresh, service-side, genuinely-CSPRNG `jobId` (e.g. `crypto.randomUUID()`, already available, zero new dependency) distinct from the backend's `registrations.id` and returning that to the guest instead (a real behavior change, needs its own design), or accepting the residual risk explicitly and documenting it in `OPS-RUNBOOK.md` the same way the two other currently-open, explicitly-accepted risks are documented (§3's `NOTIFY_WEBHOOK_URL` reachability, §7's undeployed Agent-auth cutover).

---

## AUTH-03's remaining non-ingestion log surfaces

Every `logger.*`/`queueLogger.*`/`notifyLogger.*`/`log.*` call site outside `src/ingestion/` was enumerated by grep and each one read in context (not just pattern-matched) to confirm it is a live call, not a comment:

```
$ grep -rn "logger\.\(info\|warn\|error\|debug\)\|queueLogger\.\|notifyLogger\.\|log\.\(info\|warn\|error\|debug\)" src/ | grep -v "^src/ingestion/"
```

36 matching lines across 6 files — `src/agent/agentServer.ts` (10), `src/queue/queueService.ts` (11), `src/index.ts` (3), `src/notifications/notificationService.ts` (5), `src/state/localStore.ts` (3), `src/logging/logger.ts` (1, inside `debugRawPayload`'s own doc comment context, itself the D-16-gated dev-only route). Every one of these lines was individually opened in this session (all six files were `Read` in full). **None of them interpolate `email`, `phone`, or a `Registration` object into the log message** — they carry job ids, connection ids, booth states, retry counts, and `err.message` values only. All of them route through the same winston `printf` formatter (`logger.ts:16-46`) that calls `mask(message)` whenever `typeof message === 'string'`, which every call site here satisfies (all are template-string literals, never raw objects — the same discipline `debugRawPayload`'s own doc comment calls out as required, `logger.ts:73-76`).

`[VERIFIED: mirror-request/src/agent/agentServer.ts, src/queue/queueService.ts, src/index.ts, src/notifications/notificationService.ts, src/state/localStore.ts — all Read in full this session; grep output above cross-checked against the full-file reads to exclude any comment false-positive per the project's own documented grep-false-positive history]`

**Conclusion: AUTH-03's remaining non-ingestion surfaces are already structurally clean of raw PII interpolation.** The actual open gap for AUTH-03 is not "un-masked email/phone in a log line" — it is the over-masking defect already recorded as WINDOWS.md item 5, D-17's explicit subject.

### The over-masking defect (WINDOWS.md item 5), and the fix already proven inside this codebase

`agentServer.ts:83`: `` const id = `agent-${Date.now()}-${++this.connSeq}`; `` — `Date.now()` is a 13-digit number, and `mask()`'s `PHONE_RE = /\+?\d{7,}/g` (`logger.ts:8`) matches any run of 7+ digits, so every connection id gets partially asterisked in `Agent connected: ${id}` and `Agent WS replaced: ${displacedId} displaced by ${id}` log lines, degrading (per `docs/OPS-RUNBOOK.md:274-283`) the displaced-Agent diagnostic to sequence-number-only.

**The fix is already a proven pattern in this exact codebase — not a new idea.** `test/logging-mask.test.ts:80-89` solves the identical problem (a `randomUUID()`-shaped test id false-positiving on `PHONE_RE`) with a `safeId()` helper:

```
80	  // A raw randomUUID() occasionally contains a run of 7+ consecutive digits
81	  // by chance, which PHONE_RE (`\+?\d{7,}`, pre-existing, out of scope to
82	  // change per task 1's explicit "do not change the existing regexes")
83	  // would then mask inside an id-carrying log line like "Ingested
84	  // registration <id> from <ip>" — a false positive on the id itself, not a
85	  // real PII leak. Breaking up any digit run keeps this test deterministic
86	  // without touching mask()'s regexes.
87	  function safeId(): string {
88	    return randomUUID().replace(/(\d)(?=\d)/g, '$1x');
89	  }
```

**Recommended fix: apply the identical technique to the real connection-id generator, not the regex.** Reformat the id so it structurally cannot contain a 7+-digit run — e.g. interleave the epoch timestamp into fixed-width groups separated by a non-digit character (or `.toString(36)` for a mixed alphanumeric encoding), so `PHONE_RE`'s digit-run threshold can never be met by construction. **Do not loosen `PHONE_RE` itself** — the same test file's comment (line 81-82, from Phase 1's plan 01-05) explicitly recorded a prior decision *not* to touch that regex, and loosening it risks under-masking a real phone number elsewhere, which is a strictly worse failure mode than the current cosmetic over-masking (per `docs/OPS-RUNBOOK.md:280-283`'s own framing: "known, deliberate limitation... it is not changed here" — note this line will need a documentation update once Phase 5 does change it).

**Verified this fix is safe against existing regression tests:** `test/agent-replacement.test.ts` (read in full) never asserts the literal `agent-\d+-\d+` format — its regex assertions are `/^Agent WS replaced: (.+) displaced by (.+)$/` (any non-empty strings) and `expect(displacedId).not.toBe(arrivingId)` (uniqueness only). `docs/OPS-RUNBOOK.md:400` documents the format as `<old-id> displaced by <new-id>`, generic placeholders, not a literal pattern. `grep -rn "agent-\${?\|connSeq\|agent-[0-9]" test/ docs/ src/` finds the id-format string defined in exactly one place (`agentServer.ts:83`) and asserted nowhere else. **Reformatting the id is a zero-regression, format-only change** — this is what "Phase 5 can close this ledger item as a side effect of work it must do anyway" (research priority #5's framing, reapplied here to item 5) looks like concretely: no other test, doc literal, or comparison depends on the digit-only shape.

---

## `getStore()` module-scope coupling (F-03 / WINDOWS.md item 4)

`displayServer.ts:1-21` verbatim:

```
1	import { WebSocket, WebSocketServer } from 'ws';
...
4	import { getStore } from '../state/localStore';
...
9	const store = getStore();
11	export class DisplayServer {
...
18	  constructor(queue: QueueService, agent: AgentServer) {
```

The constructor-injection seam this needs already exists in the codebase, twice over, as the established pattern:

```typescript
// Source: mirror-request/src/queue/queueService.ts:46-49 (verified, read in full this session)
constructor(
  store: LocalStore = getStore(),
  config: Pick<EnvConfig, 'SESSION_TIMEOUT_MS' | 'NEXT_GUEST_COUNTDOWN_MS' | 'SESSION_MAX_RETRIES'> = getConfig(),
) {
  this.store = store;
  ...
}
```

**Recommended: give `DisplayServer` the identical shape** — `constructor(queue: QueueService, agent: AgentServer, store: LocalStore = getStore())`, store the injected instance as `this.store`, delete the module-scope `const store = getStore()` at line 9, and replace every free `store.` reference inside `broadcastSnapshot()` (`displayServer.ts:56-57`, currently `store.getNextQueuedJob()` and `store.getQueuedGuestSummaries()`) with `this.store.`. The default parameter preserves the existing production call site (`new DisplayServer(queue, agentServer)` in `index.ts:34`) with zero change, exactly as `QueueService`'s default parameter already does for its own callers.

This closes WINDOWS.md item 4 **as a side effect of D-15/D-16's work, not as separate effort** — the same `broadcastSnapshot()` method being edited to fix the `currentJob` type lie is also the method whose store access needs to move from the free `store` variable to `this.store`. One edit accomplishes both. `test/phase5-display.test.ts` already constructs `DisplayServer` via its constructor (`new DisplayServer(mockQueue, mockAgent)`), so extending that call site to also pass a test-local `LocalStore` instance (rather than relying on the shared test-DB singleton the module-scope `getStore()` currently forces every test file into) is the natural, low-risk way to prove this closes the ledger item — a distinct in-memory or per-file SQLite path, matching `LocalStore`'s existing `constructor(dbPath?: string)` seam (`localStore.ts:13`), already built for exactly this in plan 01-02.

---

## Architecture Patterns

### System Architecture Diagram

```
 Guest's phone                          Room's big screen (browser)
      |                                          |
      | GET /status/:jobId                       | GET /display-screen (HTML+JS)
      v                                          v
+-----------------------------------------------------------------+
|                     Express app (src/index.ts)                  |
|                                                                  |
|  /status/:jobId route          /display-screen route            |
|  (no auth — capability URL,    (IP allow-list middleware, NEW)  |
|   D-06/D-07)                                                    |
|       |                              |                          |
|       v                              v (serves static page)     |
|  store.getJob() ---+          renderDisplayPage()                |
|  store.getJobRegistration()         (client opens its own WS)   |
|  estimateWaitMs() (NEW pure fn)          |                      |
|       |                                  |                      |
+-------|----------------------------------|-----------------------+
        |                                  |
        v                                  v
  LocalStore (SQLite,               HTTP upgrade -> /display
  read via prepared stmts)          IP allow-list check (NEW,
        ^                           at upgrade time, before
        |                           handleUpgrade() -- D-09)
        |                                  |
        |                                  v
        |                          DisplayServer.broadcastSnapshot()
        |                          (this.store injected -- D-16)
        +----------------------------------+
                     |
                     v
          WS clients (big-screen browsers only,
          change-driven + 1Hz countdown tick -- D-13)
```

### Recommended module additions
```
src/
├── status/
│   └── estimateWaitMs.ts       # NEW — pure median/range function, D-01..D-05, unit-testable with plain arrays
├── security/
│   └── ipAllowlist.ts          # NEW — clientIp()/isWhitelisted(), reused (not shared-import) from mirrorReceiver.ts's pattern
├── display/
│   ├── displayServer.ts        # MODIFIED — constructor injection (D-16), access control at upgrade (D-09/D-10), currentJob removal (D-15), change-driven broadcast (D-13)
│   └── displayPage.ts          # possibly unchanged, or minor client-JS update if upNext given-name projection needs a client-side tweak (recommend server-side instead, see D-14 below)
├── index.ts                    # MODIFIED — /status/:jobId response redesign (D-01..D-05, D-08, D-11, D-12), /display-screen access-control middleware
```

### Pattern 1: Structural exclusion via SQL WHERE, not application-level filtering
**What:** A guarantee (D-02's "exclude poisoned samples," D-06's FIFO-position preservation, D-05's never-double-deliver) is expressed as a predicate a query cannot match against, rather than an `if` a later edit could delete.
**When to use:** Any time a "this state must never be included/re-armed/re-selected" rule is being implemented.
**Example (this phase, session-duration sampling — see Correction 2 above):**
```sql
-- Source: derived from the verified writer logic in
-- mirror-request/src/state/localStore.ts:186-194,220-229 and
-- mirror-request/src/queue/queueService.ts:133-141,166-170
SELECT completed_at - acknowledged_at AS duration_ms
FROM queue_job
WHERE status = 'completed' AND acknowledged_at IS NOT NULL AND completed_at IS NOT NULL
ORDER BY completed_at DESC
LIMIT ?
```

### Pattern 2: Upgrade-time rejection for WS access control
**What:** Reject an unauthorized WS peer inside the `http.Server`'s `'upgrade'` event, writing a raw HTTP status line and calling `socket.destroy()`, before `wss.handleUpgrade()` runs — so the peer never holds an open socket even briefly.
**When to use:** Any WS endpoint needing access control where the check can be made from the raw `http.IncomingMessage` (headers, remote address) without needing the WS handshake itself.
**Example:**
```typescript
// Source: mirror-request/src/agent/agentServer.ts:65-75, adapted for IP allow-list
httpServer.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;
  if (pathname !== '/display') return;
  const ip = clientIp(req);
  if (!isWhitelisted(ip, displayWhitelist)) {
    logger.warn(`Blocked /display from non-whitelisted IP: ${ip}`);
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
```

### Pattern 3: Given-name-only projection for a list, full name for a hero element
**What:** D-14's split is a per-field projection applied at broadcast time, not a schema change — `getQueuedGuestSummaries()` (`localStore.ts:208-218`) should keep returning full names (it may be reused elsewhere later), and the truncation happens only where the wire payload for `upNext` is assembled.
**Example:**
```typescript
// Source: derived from the naming convention documented in CONTEXT.md D-14
// and verified against mirror-request/src/state/localStore.ts:208-218's
// existing Array<{ jobId, name, position }> shape
function toGivenName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1] ?? fullName;
}
// Hero (called guest): keep full name, unchanged.
// upNext list: map each entry's `name` through toGivenName() only when building
// the outbound snapshot, not when storing/reading from LocalStore.
```

### Anti-Patterns to Avoid
- **Loosening `PHONE_RE` to fix the connection-id false positive.** Already explicitly rejected once in this codebase (Phase 1 plan 01-05's "do not change the existing regexes" instruction, quoted in `test/logging-mask.test.ts:81-82`) — under-masking risk is strictly worse than over-masking (per `docs/OPS-RUNBOOK.md`'s own framing).
- **Reading `job.registration?.name` off a `getJob()`/`getNextQueuedJob()` result.** Both are bare `SELECT *` with no join — `.registration` is always `undefined` at runtime despite the type claiming otherwise (Corrections 1-3, F-02). Use `store.getJobRegistration(jobId)` (`localStore.ts:343-354`), which does the actual join.
- **Building the wait estimate off `session_started_at`.** Verified dead column (Correction 1) — would silently always return zero samples.
- **A `?token=` fallback for `/display`'s WS auth "just in case."** Explicitly rejected by D-10; reintroduces the exact anti-pattern Phase 3's whole cutover existed to delete.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Median of a small in-memory number array | A statistics npm package (`simple-statistics`, `d3-array`, `stats-lite`) | `arr.slice().sort((a,b) => a-b)` + index math, ~6 lines | The sample size is bounded by a config-controlled `LIMIT`, the operation is O(n log n) on a tiny array, and a dependency adds supply-chain surface for something trivially correct to hand-write and unit-test with plain arrays |
| Upgrade-time WS access control | A generic auth/gateway middleware package | The exact `httpServer.on('upgrade', ...)` + raw socket write pattern already proven twice in this codebase (`agentServer.ts`, `displayServer.ts`) | Consistency with an already-tested, already-understood pattern beats a new abstraction for a two-branch IP check |
| Digit-run-safe id formatting | A dedicated ID-formatting library | `.replace(/(\d)(?=\d)/g, '$1x')` or base-36 encoding, both trivial string ops | Already proven inline in `test/logging-mask.test.ts:88` for the identical problem — no new abstraction needed for one line of logic |
| IP CIDR/wildcard matching | A CIDR-parsing library (`ip-range-check`, `netmask`) | The existing `.endsWith('.*')` prefix-match convention in `mirrorReceiver.ts:47-53` | Matches this project's existing, deliberately simple allow-list format; introducing real CIDR support is a larger, unrequested scope change |

**Key insight:** every "don't hand-roll" candidate this phase touches (median math, id formatting, IP matching) is a case where the *correct* answer is the opposite of usual advice — hand-roll it, because the operation is a few lines, a library adds dependency risk for no correctness gain, and this codebase already has a working, tested precedent for each one.

---

## Common Pitfalls

### Pitfall 1: Trusting `QueueJob.registration` as populated
**What goes wrong:** Any new code that reads `job.registration.<field>` off a `getJob()`/`getNextQueuedJob()`/`getQueuedJobs()`/`getInFlightJobs()` result crashes or silently reads `undefined` — none of those four methods join `registration`.
**Why it happens:** The `QueueJob` type declares `registration: Registration` as required, so TypeScript offers zero warning.
**How to avoid:** Only `store.getJobRegistration(jobId)` (`localStore.ts:343-354`) actually performs the join. Every place Phase 5 needs a guest's name, use that method, not a field read off a raw `queue_job` row.
**Warning signs:** A `guestName` (or similar) field that is always `null`/empty in manual testing, with no error anywhere — exactly today's live `/status/:jobId` bug (verified this session).

### Pitfall 2: Assuming `session_started_at` holds data
**What goes wrong:** Any query or code path built against `session_started_at` returns `NULL` forever — zero rows will ever match a `session_started_at IS NOT NULL` filter, so a median calculation silently, permanently falls back to the D-04 cold-start default with no error and no visible symptom beyond "the estimate never changes."
**Why it happens:** The column exists in the schema and in `updateJobStatus()`'s valid-field map, creating the appearance of active use.
**How to avoid:** Use `acknowledged_at` (Correction 1). Before trusting any column as "the data already exists," grep every write call site, not just the schema declaration.
**Warning signs:** An estimate that is always exactly the configured cold-start default, regardless of how many sessions have completed.

### Pitfall 3: Treating `/display`'s current `250ms` broadcast interval as free to keep alongside new access control
**What goes wrong:** D-13 (change-driven broadcast + 1Hz countdown tick) and D-09 (IP access control) are separate concerns but land in the same file (`displayServer.ts`) in the same phase — it is easy to fix one and quietly leave the other as a follow-up "since it's already touched," creating a partial fix that looks complete in a diff review.
**Why it happens:** Both changes touch `broadcastSnapshot()`/`start()` in the same ~76-line file; a plan that scopes one task per decision risks conflicting edits or an incomplete merge if not sequenced carefully.
**How to avoid:** Plan `displayServer.ts`'s rewrite as one coherent task covering D-09, D-10, D-13, D-15, D-16 together (they all touch the same small file), rather than splitting it across waves that each partially edit the same methods.
**Warning signs:** A task that claims D-13 done but the diff still shows `setInterval(() => this.broadcastSnapshot(), 250)` unconditionally, or claims D-09 done but `wss.on('connection', ...)` still adds every peer to `this.clients` with no upgrade-time gate.

### Pitfall 4: Grep-verifying "no PII in logs" without reading the surrounding lines
**What goes wrong:** A grep for `email|phone` inside non-ingestion `src/` files could hit a comment *documenting the absence* of PII (exactly the false-positive class this project has hit at least three times already per the anti-pattern list, and once concretely in Phase 4's `04-04` verification against `notificationService.ts`).
**Why it happens:** Grep matches text, not intent.
**How to avoid:** This research already performed the full-file `Read` for every file containing a non-ingestion log call site (see "AUTH-03's remaining non-ingestion log surfaces" above) — the planner and executor should re-verify against the *current* diff at execution time the same way, not trust this document's snapshot indefinitely if other work lands first.
**Warning signs:** A verification step that reports "grep found N matches" as if that number alone proves or disproves a claim, without quoting the matched lines.

### Pitfall 5: Assuming the connection-id reformat is out of Phase 5's boundary because the file is `agentServer.ts` (a "Phase 3 file")
**What goes wrong:** The phase-boundary rule says "must not alter [Phase 3's] behaviour" — a planner could read that as "do not touch `agentServer.ts` at all" and leave WINDOWS.md item 5 open, which then blocks `/gsd-ship` per D-16's own framing ("`/gsd-ship` blocks while `open_count > 0`").
**Why it happens:** Conflating "don't change behavior" with "don't change the file."
**How to avoid:** CONTEXT.md's D-17 and WINDOWS.md item 5 both explicitly assign this item to Phase 5 to close. The recommended fix (reformatting the id string) changes *log/display formatting only* — verified above to have zero effect on any equality comparison, any existing test assertion, or any documented literal format. This is a behavior-preserving, format-only edit, which is different from "altering the Agent link's behaviour."
**Warning signs:** A plan that leaves WINDOWS.md item 5 open at phase-gate time with no waive justification, when the fix was demonstrably low-risk.

---

## Code Examples

### Generic 404 for `/status/:jobId` (D-08) — already correct, verify it stays that way
```typescript
// Source: mirror-request/src/index.ts:36-39, current shipped code, unchanged behavior needed
const job = store.getJob(req.params.jobId);
if (!job) return res.status(404).json({ error: 'job not found' });
```
This already collapses "never existed," "purged," and "belongs to someone else" into one code path and one body shape — D-08 is already satisfied by construction as long as no new branch is added later that differentiates these cases (e.g. a separate "this job was deleted" 410 or message).

### Exact-shape response assertion (per the project's "a 2xx proves nothing" anti-pattern)
```typescript
// Source: pattern from mirror-request/test/notification-sweeper-restart.test.ts:96-135
// (Phase 4's model for API tests), adapted for API-01
const res = await request(app).get(`/status/${jobId}`);
expect(res.status).toBe(200);
expect(Object.keys(res.body).sort()).toEqual([
  'boothState', 'estimatedWaitMs' /* or omitted per D-05 */, 'jobId', 'queuePosition', 'status',
  // exact final key set is the planner's task — the point is asserting the
  // full key set, not just individual field values
].sort());
```

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | D-07's backend-CSPRNG assumption cannot be confirmed from inside this repository, and must be escalated as a blocking checkpoint rather than assumed true. | "D-07: the entropy assumption cannot be confirmed" | If the plan ships D-06 unchecked and the backend's real id generator turns out to be sequential/predictable (plausible — the local store's only observed samples are sequential test fixtures, not evidence either way for the *real* backend), `/status/:jobId` becomes an enumeration oracle for other guests' queue position and booth state — low-severity PII exposure (no email/phone on this route) but a real information leak, and the fix (minting a fresh server-side id) is a bigger change once already shipped. |
| A2 | The range-construction rule for D-03 ("round the point estimate up to the next whole minute for the high bound, one minute below for the low bound") is a reasonable synthesis of D-02 (median) + D-03 (range, round up) but is not itself explicitly locked in CONTEXT.md. | "The estimated-wait calculation," step 6 | If the planner or a stakeholder wants a different range mechanism (e.g., percentile-based), this specific formula would need revisiting — low risk, purely a UX-copy detail, easy to change later since it's isolated in one pure function. |
| A3 | `DisplaySnapshot.currentJob` should be deleted entirely rather than replaced with a minimal `{jobId, status}` projection, since nothing currently consumes it (verified against `displayPage.ts` and `web-slide/`). | "Fixing the `DisplaySnapshot.currentJob` type lie" | Low risk — if a future consumer needs a job reference, re-adding a minimal field is trivial and this document already specifies exactly what shape it should take when that need arises. |
| A4 | `DISPLAY_IP_WHITELIST` should get the same production-boot fail-fast validation as `PROXY_IP_WHITELIST` (reject unconfigured/default in `NODE_ENV=production`), for consistency, though D-09 doesn't explicitly mandate this. | "Access control for the display feed and screen" | Low-medium — if not enforced, a production deploy could silently leave `/display`/`/display-screen` open to the world (`config.ts`'s current default fallback is `whitelist.length === 0` → allow all, the same dev-escape-hatch Phase 1 uses), which is a real access-control gap on the room screen, though not a PII leak given D-15's fix removes the sensitive payload regardless. |

**If this table is empty:** N/A — see rows above.

---

## Open Questions (RESOLVED — both answered in executable plan content, 2026-08-11)

> **RESOLVED Q1** — the response shape is fixed in `05-01-PLAN.md` §artifacts_produced: a
> top-level optional `waitEstimate: {lowMinutes, highMinutes}`, numbers not pre-formatted
> Vietnamese copy, pinned by the 8-key and 7-key `Object.keys(body).sort()` assertions.
>
> **RESOLVED Q2** — the external-consumer question is carried into `05-01` Task 1's blocking
> `checkpoint:decision` as a mandatory second question, so it reaches a human before any
> `/status` work proceeds rather than being assumed away here.

1. **What exact response shape should `/status/:jobId` have after D-01..D-05, D-08, D-11, D-12 land together?**
   - What we know: the guest-facing status vocabulary is closed (D-11's six states), the estimate is sometimes absent (D-05), the position/queueLength fields already exist and work correctly.
   - What's unclear: whether `estimatedWaitMs`/`estimatedWaitRange` is a top-level optional field, a nested object, or replaced by pre-formatted guest-facing copy strings (Vietnamese) generated server-side. CONTEXT.md's D-11 example strings ("khoảng 3-5 phút") suggest server-generated copy may be preferred over raw numbers for the guest UI to consume directly, similar to how `displayPage.ts` already embeds Vietnamese strings server-side rather than localizing client-side.
   - Recommendation: the planner should decide this as an explicit task-level design choice (numbers vs. pre-formatted copy) rather than defaulting silently — it affects both the API contract and how much logic a hypothetical future guest-facing client (not built yet — currently this response's actual consumer isn't in this repo) needs to duplicate.

2. **Does anything outside this repository actually consume `GET /status/:jobId` today?**
   - What we know: the route exists and is tested for shape only by manual/production traffic implicitly (no automated test today, verified via `grep -rln "/status/" test/ src/` returning only `src/index.ts`).
   - What's unclear: whether a guest-facing web page (analogous to `web-slide/` for the notification photo, or a QR-code-linked page not in this repo) already exists and depends on the *current* field names (`queuePosition`, `queueLength`, `boothState`, `agentOnline`, `guestName`). Changing field names as part of the D-11 redesign could break an external consumer this research has no visibility into.
   - Recommendation: confirm with the human (likely at the same D-07 checkpoint, since both require external-system knowledge) whether a live consumer of the current field names exists before renaming/restructuring them, or design the new response to be additive (new fields alongside old ones) if backward compatibility is unconfirmed.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js 20.x | All of Phase 5 | ✓ (per `package.json` engines and prior-phase precedent) | 20.x | — |
| better-sqlite3 | Estimated-wait query, access-control tests | ✓ (already a dependency, verified in `package.json`) | `^11.0.0` | — |
| Real dslrBooth backend DB access (for D-07's escalation) | Confirming D-07's entropy assumption | ✗ (sandbox denies `.env*` access; this repo has read-only `DB_POLL` config but no live credentials in this session) | — | Escalate to a human with real backend access/documentation — no code-level fallback exists for this specific question |
| A staging/rehearsal environment for `/display`'s IP allow-list | End-to-end verification of D-09 against the real room network | ✗ (STATE.md/OPS-RUNBOOK.md confirm this project has no staging environment — established in Phase 3's checkpoint) | — | Verify with real loopback/local-network IPs in automated tests (same technique Phase 1 used for `PROXY_IP_WHITELIST`, `test/on-register-auth.test.ts`'s `req.ip` override middleware) plus an operator manual check against the real room LAN post-deploy |

**Missing dependencies with no fallback:**
- Real backend access to confirm D-07 — this is a human/process gap, not a tooling gap; no code-level fallback substitutes for it.

**Missing dependencies with fallback:**
- No staging environment — covered by the existing automated-test + manual-post-deploy-check pattern already used for `PROXY_IP_WHITELIST`.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest `^2.1.4` (verified in `mirror-request/package.json`) |
| Config file | `mirror-request/vitest.config.ts` — note line 12: `LOCAL_STORE_PATH: './data/test-extension-service.sqlite'`, a separate DB file from production; `LOG_LEVEL: 'error'` suppresses info/warn/debug output during test runs |
| Quick run command | `cd mirror-request && npx vitest run <path/to/file>.test.ts` |
| Full suite command | `cd mirror-request && npm test` (currently 27 files / 182 tests green at baseline `419763f`) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| API-01 | `GET /status/:jobId` returns exact-shape response with position + estimated wait or explicit suppression | integration (real ephemeral Express app + supertest, real ephemeral `LocalStore`) | `npx vitest run test/status-api.test.ts` | ❌ Wave 0 — no test file exercises `/status/:jobId` today (verified: `grep -rln "/status/" test/ src/` finds only the route definition in `src/index.ts`, zero test files) |
| API-01 | `estimateWaitMs()` median/range/cold-start/exclusion logic | unit (pure function, plain arrays, no DB) | `npx vitest run test/estimate-wait.test.ts` | ❌ Wave 0 — module doesn't exist yet |
| API-01 | Generic 404 for unknown/purged/foreign jobId (D-08) | integration | same `test/status-api.test.ts` file, dedicated `describe` block | ❌ Wave 0 |
| API-01 | Guest-facing vocabulary is exhaustive and closed (D-11, D-12) | unit or integration — a table-driven test iterating every internal `status`/`stall_reason` combination and asserting it maps to exactly one of the six guest-facing strings, with an explicit failure if a new internal state has no mapping | `npx vitest run test/status-vocabulary.test.ts` | ❌ Wave 0 |
| API-02 | `WS /display` broadcasts change-driven + 1Hz countdown tick, not unconditional 250ms (D-13) | integration (real ephemeral `http.Server` + real `ws` client, fake timers or short real intervals per existing project convention) | extend `npx vitest run test/phase5-display.test.ts` | ✅ file exists (`test/phase5-display.test.ts`, 78 lines, 2 tests) — needs new cases, not a new file |
| API-02 | `DisplaySnapshot` never contains a `registration`-shaped or PII-capable field, by type (compile-time) and by wire assertion (runtime) | integration + a `tsc --noEmit` structural check (the type itself is the primary guarantee, per D-15) | `npx vitest run test/phase5-display.test.ts` + `npm run typecheck` | Partially — extend the existing file |
| API-02 | `/display` and `/display-screen` reject non-allow-listed IPs with a generic 403 before any handshake/render (D-09) | integration (real loopback connections, same `req.ip` override technique as `test/on-register-auth.test.ts`) | new `test/display-access-control.test.ts` | ❌ Wave 0 |
| API-02 | `DisplayServer` accepts an injected `LocalStore` and no longer touches the module-scope singleton (D-16 / WINDOWS item 4) | unit/integration — construct with a per-test `LocalStore('./data/test-XXXX.sqlite')` and assert no shared-DB interference | extend `test/phase5-display.test.ts` | Partially — extend |
| AUTH-03 | No non-ingestion log call site interpolates raw email/phone (regression proof, not just a one-time audit) | integration — spy on `logger.info/warn/error/debug` across a realistic Phase 2-4 flow and assert `mask(msg) === msg` for every captured message (the same technique `test/logging-mask.test.ts:168-181` already uses for the ingestion surface) | extend `test/logging-mask.test.ts` with a non-ingestion `describe` block, or a new file | ❌ Wave 0 for the non-ingestion assertion specifically (the ingestion version already exists) |
| AUTH-03 | Connection-id reformat no longer false-positives against `PHONE_RE` (WINDOWS item 5) | unit (call the id generator or a pure formatting helper directly, assert `mask(idContainingLine) === idContainingLine`) | extend `test/logging-mask.test.ts` or `test/agent-replacement.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run <changed-test-file>.test.ts`
- **Per wave merge:** `cd mirror-request && npm test` (full 182+ baseline plus new Phase 5 files)
- **Phase gate:** Full suite green, `npm run typecheck` clean, `npm run build` clean, before `/gsd-verify-work` — matching every prior phase's own closing checklist (STATE.md rows for Phases 1-4 all report exactly this).

### Wave 0 Gaps
- [ ] `test/status-api.test.ts` — covers API-01 (response shape, D-08's generic 404, D-11/D-12's guest-facing vocabulary)
- [ ] `test/estimate-wait.test.ts` — covers the pure `estimateWaitMs()`/median/cold-start/range logic (D-01..D-05)
- [ ] `test/status-vocabulary.test.ts` (or folded into `status-api.test.ts`) — covers D-11/D-12's exhaustive mapping table
- [ ] `test/display-access-control.test.ts` — covers D-09/D-10's IP allow-list at both the WS-upgrade and HTTP-route layers
- [ ] `src/status/estimateWaitMs.ts` — new pure module, no test infra needed beyond plain vitest (no DB, no server)
- [ ] `src/security/ipAllowlist.ts` — new pure module (`clientIp`/`isWhitelisted`), reused by both display surfaces
- [ ] Extend `test/phase5-display.test.ts` — D-13 (change-driven broadcast), D-15 (`currentJob` removal/projection), D-16 (constructor injection)
- [ ] Extend `test/logging-mask.test.ts` — AUTH-03's non-ingestion regression proof, and the connection-id reformat's false-positive fix

No framework install needed — Vitest, Supertest, and `ws`'s test-client usage are all already present and already exercised by 27 existing files.

---

## Security Domain

`security_enforcement` is absent from `.planning/config.json` → treated as enabled per the default rule.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | Partial — `/status/:jobId` substitutes possession-of-URL for authentication (a capability URL / "GUID as credential" pattern). ASVS's own guidance on this pattern requires the identifier to be generated with a CSPRNG and have sufficient entropy (typically ≥128 bits) — this is exactly D-07's unconfirmed premise. No traditional login/session applies anywhere in Phase 5. | No library — this is an architectural property (entropy of an externally-sourced id), not a code control. See the D-07 escalation above. |
| V3 Session Management | No | N/A — no sessions anywhere in this phase |
| V4 Access Control | Yes, for `/display` and `/display-screen` | Network-layer allow-list (IP), reusing the exact pattern already in `mirrorReceiver.ts` — see "Access control for the display feed and screen" above |
| V5 Input Validation | Yes — `:jobId` route parameter | Already parameterized via `better-sqlite3`'s `?` placeholders (`localStore.ts`'s `.prepare(...).get(id)` pattern throughout) — no string concatenation into SQL anywhere in this codebase, verified across every method read this session. No additional validation library needed; D-08's generic-404 collapse already prevents any format-based oracle (a malformed jobId should also 404 generically, not 400, to avoid differentiating "malformed" from "not found" as a second oracle — flag for the planner) |
| V6 Cryptography | No new crypto operations in Phase 5 | N/A — D-06 explicitly avoids adding a comparison secret; the only crypto-adjacent concern (D-07's entropy) is inherited from an external system, not implemented here |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Enumeration oracle via differentiated error responses on `/status/:jobId` | Information Disclosure | D-08's single generic 404 for every failure case — already correct in shipped code, verify it stays that way as the response shape is redesigned (see Pitfall discussion) |
| IP allow-list bypass via `X-Forwarded-For` spoofing if Express `trust proxy` is ever enabled unscoped | Spoofing | Do not enable `app.set('trust proxy', true)` anywhere — `mirrorReceiver.ts:20-34`'s own doc comment already explains why (any client can forge that header without a scoped `trust proxy`), and the new `/display` access control must inherit the same caution since it reads `req.ip`/`socket.remoteAddress` the identical way |
| Operator-internal state disclosure via an unauthenticated WS broadcast (today's live `stall_reason`/`retries`/`ack_error_message` leak via `currentJob`) | Information Disclosure | D-15's structural type fix (delete/minimize `currentJob`), verified above as a real, currently-shipped exposure, not a hypothetical |
| PII exposure via connection-id or job-id false-negatives in log masking (i.e., under-masking a real phone number by loosening `PHONE_RE`) | Information Disclosure | Do not loosen `PHONE_RE`; fix the false-positive at the id-generation layer instead (verified pattern already in this codebase) |
| WS resource exhaustion via unbounded `/display` client accumulation | Denial of Service | Not currently mitigated and not explicitly in scope for this phase's locked decisions — low priority given the room-screen use case (a handful of physical browsers, not internet-facing), but worth a one-line note in `OPS-RUNBOOK.md` if the planner doesn't add a cap, consistent with this project's practice of documenting accepted residual risk rather than leaving it silent |

---

## Sources

### Primary (HIGH confidence — read in full this session)
- `mirror-request/src/index.ts`, `src/display/displayServer.ts`, `src/display/displayPage.ts`, `src/types.ts`, `src/state/localStore.ts`, `src/logging/logger.ts`, `src/config.ts`, `src/queue/queueService.ts`, `src/agent/agentServer.ts`, `src/ingestion/mirrorReceiver.ts` — every claim tagged `[VERIFIED: ...]` above cites a specific line range from one of these
- `mirror-request/test/phase5-display.test.ts`, `test/agent-replacement.test.ts`, `test/logging-mask.test.ts` — read in full to confirm what existing tests do and do not pin
- `mirror-request/docs/OPS-RUNBOOK.md` §2, §3, §5, §6 — read to confirm booth-state vocabulary, stall_reason vocabulary, retention policy, and the pre-existing masking-limitation framing
- `.planning/phases/05-client-api-display-feed/05-CONTEXT.md`, `.planning/REQUIREMENTS.md`, `.planning/WINDOWS.md`, `.planning/STATE.md`, `mirror-request/CLAUDE.md` — the mandatory reading list, all read in full
- Live read-only query against `mirror-request/data/extension-service.sqlite` and `data/test-extension-service.sqlite` (better-sqlite3, `{readonly: true}`), executed this session

### Secondary (MEDIUM confidence)
- WebSearch for dslrBooth's database schema / id-generation scheme — returned no public technical documentation, used here only to confirm the negative (this information is not publicly discoverable, reinforcing the need to escalate rather than keep researching)

### Tertiary (LOW confidence)
- None used as the basis for any claim in this document.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new packages, every recommendation reuses already-installed, already-tested libraries
- Architecture: HIGH — every pattern cited traces to a specific file/line range read this session
- Estimated-wait data model: HIGH for what the schema contains and what is dead (grep + full-file reads); MEDIUM for the specific range-construction formula (Assumption A2, an implementation choice not literally locked by CONTEXT.md)
- Access control: HIGH for the mechanism (browser header limitation is a documented Web Platform constraint, not an assumption); MEDIUM for whether `DISPLAY_IP_WHITELIST` needs production fail-fast validation (Assumption A4)
- D-07 entropy question: explicitly LOW / unconfirmable — this is the correct honest confidence level, not a research gap to be closed with more effort
- Pitfalls: HIGH — three of five are live, currently-shipped bugs verified by reading the actual runtime data flow, not hypothetical

**Research date:** 2026-08-11
**Valid until:** ~14 days (this is fast-moving, actively-developed internal code, not a third-party framework — re-verify against HEAD before planning if more than a couple of days elapse, per this project's own established pattern of baseline-commit tracking)
