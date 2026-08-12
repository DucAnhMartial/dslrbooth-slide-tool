# Extension Service — Operations Runbook

This document is for whoever operates this service in production, and for
whoever implements the webhook sender on the Mirror Request / form-proxy
side. It does not assume you have read the planning tree — everything you
need to deploy safely and integrate correctly is here.

## 1. Webhook signing contract (`POST /on-register`)

This service authenticates every registration webhook with an HMAC-SHA256
signature. **This is the published contract** — as of Phase 1, Mirror
Request has no signer implemented yet, so this service's format is
authoritative. Implement your sender to match it exactly; do not guess.

### Required headers

| Header | Meaning |
|---|---|
| `X-Webhook-Signature` | HMAC-SHA256 digest, **hex-encoded** |
| `X-Webhook-Timestamp` | Epoch time in **milliseconds** (as a string), e.g. `1770000000000` |
| `X-Webhook-Id` | A unique ID for this specific delivery attempt (used for replay rejection — see below) |

### Canonical string to sign

```
${X-Webhook-Timestamp}.${X-Webhook-Id}.${rawRequestBodyBytes}
```

Concretely: the timestamp string, a literal `.`, the webhook id string,
another literal `.`, then the exact raw HTTP request body bytes (UTF-8) —
**not** a re-serialized/re-stringified version of the JSON. Any
re-serialization (different key order, whitespace, unicode escaping) will
produce a different byte sequence and the signature will not verify.

### Computing the signature

```
signature = hex( HMAC-SHA256( key = WEBHOOK_HMAC_SECRET, message = canonicalString ) )
```

`WEBHOOK_HMAC_SECRET` is the shared secret configured on this service (see
§3). Both sides must use the exact same secret value.

### Freshness / replay rules this service enforces

- The request is rejected (403) if `X-Webhook-Timestamp` is more than
  `WEBHOOK_TIMESTAMP_SKEW_MS` (default 300,000 ms = 5 minutes) away from
  this service's clock, in either direction. Keep your sender's clock
  reasonably synced (NTP).
- Every `X-Webhook-Id` is recorded permanently after a successful delivery
  (in SQLite, survives restarts). A repeated `X-Webhook-Id` is rejected
  (403) even if the signature and timestamp are otherwise valid — always
  generate a fresh, unique `X-Webhook-Id` per delivery attempt, including
  retries.
- Any authentication failure (bad signature, missing header, stale
  timestamp, replayed id, non-allow-listed source IP) returns a bare
  `403 {"error":"Forbidden"}` with no further detail — this is deliberate
  (never leak which specific check failed).

### Why this exact format

The canonical string includes `X-Webhook-Id` (not just timestamp + body) so
that an attacker who captures one valid signed request cannot replay it
under a different `X-Webhook-Id` to dodge replay detection. If Mirror
Request's real sender ever needs a different format, the change is
confined to two functions on this service's side:
`buildCanonicalString()` and `isTimestampFresh()` in
`src/ingestion/webhookAuth.ts`.

### Reference implementation (this service's own verification code)

```ts
// src/ingestion/webhookAuth.ts
function buildCanonicalString(timestamp: string, webhookId: string, rawBody: Buffer): string {
  return `${timestamp}.${webhookId}.${rawBody.toString('utf8')}`;
}
```

## 2. What happens to your data (retention)

This service does **not** delete data automatically. By design (see
"Decisions" below), the following SQLite tables grow without bound for as
long as the service runs:

| Table | Contains | Grows on |
|---|---|---|
| `registration` | Guest `id`, `name`, `email`, `phone`, `mode`, timestamps, and the full raw JSON payload received from Mirror Request (`raw_payload`) | Every new (non-duplicate) registration |
| `webhook_replay` | Every `X-Webhook-Id` ever seen | Every accepted webhook delivery |
| `processed_id` | Every registration `id` ever fully processed | Every new registration |
| `queue_job` | Queue/session history | Every new registration |

**Deleting old data is the operator's responsibility.** There is no
built-in retention job, TTL, or cleanup tooling in this service as of
Phase 1. If you need to prune old rows (for disk space, guest privacy
requests, or query performance as the tables grow), do it manually against
the SQLite file (`LOCAL_STORE_PATH`, default `./data/extension-service.sqlite`)
— take a backup first, and be aware that `registration.raw_payload`
contains full guest contact details (email, phone), so treat the database
file itself as sensitive (file permissions, backup encryption, access
control) even though runtime *logs* are PII-masked (see below).

**Log files are not the same as the database.** Runtime logs (Winston,
rotated daily under `logs/`) mask email addresses and phone numbers
(`mask()` in `src/logging/logger.ts`), and the raw request payload is never
written to logs in production under any configuration — only the SQLite
database retains the raw payload, and only there is retention manual.

## 3. Environment variables that must be set before a production deploy

Startup **fails immediately** (the process refuses to boot) in production
if either of these is missing or left as a placeholder:

| Variable | Requirement in production | What happens if missing |
|---|---|---|
| `WEBHOOK_HMAC_SECRET` | Must be set to a real, non-empty shared secret matching your sender's secret (see §1) | Startup throws: `WEBHOOK_HMAC_SECRET must be configured in production (D-09)` |
| `PROXY_IP_WHITELIST` | Must be set to the real reverse-proxy source IP(s), comma-separated. **The default `127.0.0.1` alone is rejected as "not really configured"** in production. | Startup throws: `PROXY_IP_WHITELIST must be configured in production with the real reverse-proxy IPs (D-09)` |
| `DISPLAY_IP_WHITELIST` | Must be set to the real display-machine address(es), comma-separated. Added in Phase 5 (see §9). Unlike `PROXY_IP_WHITELIST`, there is no loopback default that could be mistaken for "configured" — an empty list is rejected outright. | Startup throws: `DISPLAY_IP_WHITELIST must be configured in production with the real display-machine addresses (D-09, Assumption A4)` |

This is a deliberate, hard fail-fast: there is no configuration flag to
disable webhook authentication in production. If you see one of these
errors on boot, set the corresponding variable in your `.env` / PM2
ecosystem env and restart — do not work around it.

Other webhook-related variables (optional, have working defaults):

| Variable | Default | Meaning |
|---|---|---|
| `WEBHOOK_TIMESTAMP_SKEW_MS` | `300000` (5 min) | Timestamp freshness window, symmetric (past and future) |
| `REGISTRATION_DEDUP_WINDOW_MS` | `300000` (5 min) | Time window for the id/email/phone duplicate-registration check |

Queue and booth timing variables added in Phase 2 (optional, have working
defaults — none of them is required, and no production deploy needs to set
any of them):

| Variable | Default | Meaning |
|---|---|---|
| `SESSION_TIMEOUT_MS` | `300000` (5 min) | How long a dispatched/in-progress session may run before the booth is considered stalled — used both by the live busy timer and by startup recovery's age check (see §5, §6) |
| `NEXT_GUEST_COUNTDOWN_MS` | `7000` (7 s) | How long the `ANNOUNCING` state holds before the next guest's session is dispatched; the effective value is always clamped to 5000-10000 ms regardless of what this is set to |
| `SESSION_MAX_RETRIES` | `2` | How many times a stalled job is returned to the queue before it is marked `failed` — 2 retries means 3 dispatch attempts total (see §6) |

Guest notification variables added in Phase 4 (optional, have working
defaults — see §8 for the full delivery contract these govern):

| Variable | Default | Meaning |
|---|---|---|
| `NOTIFY_WEBHOOK_URL` | unset (empty string) | Where the guest's name and photo are POSTed (see §8). **When unset, the service warns and skips delivery rather than failing** — safe, but silent: a misconfigured or forgotten value produces no error anywhere and looks identical to "no photos were taken." Confirm this is set to the real slideshow receiver URL before a production deploy. |
| `NOTIFY_MAX_RETRIES` | `2` | **Meaning changed in Phase 4 (D-08, D-15).** This is now the count of retries *after* the first attempt, matching `SESSION_MAX_RETRIES`'s meaning — the default of `2` yields 3 total delivery attempts, the same total as before this phase. If you set this explicitly in a production `.env`/PM2 environment under the old meaning (where the number was the *total* attempt count), re-read your value: under the new meaning the same number now yields one more attempt than before. See §8's retry-budget note. |
| `NOTIFY_FETCH_TIMEOUT_MS` | `10000` (10 s) | How long a single delivery attempt waits for the receiver to respond before the attempt is aborted and counted as a timeout (see §8) |
| `NOTIFY_SWEEP_INTERVAL_MS` | `3000` (3 s) | How often the sweeper checks `notification_record` for rows that are due |
| `NOTIFY_CLAIM_LEASE_MS` | `60000` (1 min) | How long a claimed row is held before it becomes eligible to be picked up again if the process claiming it dies mid-delivery. The effective value is always clamped to at least twice `NOTIFY_FETCH_TIMEOUT_MS`, so a misconfiguration can never expire a lease under a live in-flight request. |

Client API and display feed variables added in Phase 5 (see §9 for the full
contract these govern; `DISPLAY_IP_WHITELIST` itself is **required** in
production and is listed in the fail-fast table above, not here):

| Variable | Default | Meaning |
|---|---|---|
| `WAIT_ESTIMATE_SAMPLE_SIZE` | `20` | How many of the most recent completed sessions (`status = 'completed'`, ordered most-recent-first) feed the median wait-time calculation. |
| `WAIT_ESTIMATE_MIN_SAMPLES` | `5` | Below this many real completed-session samples, the estimator does not compute a median at all — it serves `WAIT_ESTIMATE_DEFAULT_MS` instead (the cold-start fallback, D-04). |
| `WAIT_ESTIMATE_DEFAULT_MS` | `180000` (3 min) | The cold-start fallback duration. Measured fact as of this writing: the production database holds exactly **1** usable completed session, so with the default `WAIT_ESTIMATE_MIN_SAMPLES` of `5` this value — rendered as "khoảng 2–3 phút" — is what production actually serves on day one, not an edge case. |
| `DISPLAY_IP_WHITELIST` (dev default) | unset → `[]` (empty list) outside production | In any non-production `NODE_ENV`, an unset or empty value is an allow-everything development escape hatch — every request is treated as whitelisted (`isWhitelisted()` in `src/security/ipAllowlist.ts` returns `true` for an empty list). This branch is unreachable in production because of the fail-fast check above. |

Ingestion VIEW and capability-URL rate-limiting variables added in Phase 6
(optional, have working defaults — see §10 for the full contract these
govern):

| Variable | Default | Meaning |
|---|---|---|
| `VIEW_PROBE_INTERVAL_MS` | `60000` (1 min) | How often the VIEW health probe (§10) checks that `photobooth.registrations` still resolves and that its ordering backstop (`COUNT(*)` vs `COUNT(DISTINCT registered_at)`) still holds. Also the cadence of the D-05 name-fallback audit. |
| `STATUS_RATE_LIMIT_WINDOW_MS` | `60000` (1 min) | The fixed window `GET /status/:jobId`'s rate limiter (§10) counts requests within, per client address. |
| `STATUS_RATE_LIMIT_MAX` | `30` | Requests allowed per client address per window before the (max+1)th is refused with `429`. |
| `STATUS_RATE_LIMIT_MAX_KEYS` | `10000` | The upper bound on how many distinct client addresses the limiter tracks simultaneously — bounds memory under key-rotation pressure from an attacker rotating source addresses. |

None of these four belongs in the fail-fast table above: all four have
site-independent defaults that are correct out of the box, and — per
D-09's own reasoning for `VIEW_PROBE_INTERVAL_MS` — no supported way
exists to switch off the only signal that ingestion is dead.

Session lifecycle variables added in Phase 7 (optional, working default —
see §5 for the two anchors this governs):

| Variable | Default | Meaning |
|---|---|---|
| `BOOTH_RELEASE_TIMEOUT_MS` | `120000` (2 min) | How long the booth stays held for a job that has already **completed** at the print composite, waiting for the `session_end` that releases it. If that `session_end` never arrives, this fallback releases the booth anyway and the queue moves on. The effective value is clamped to at least `30000`. **If you set it too low, the deadline fires while the guest is still standing at the sharing screen** — the booth is handed to the next guest, who is announced and dispatched on top of a session that is visibly still running. It never charges a retry and never writes a `stall_reason` (§6), because the job it releases is already terminal — it is a booth-release deadline, not a stall timer. |

### Phase 7 timing values that are deliberately NOT environment variables

Two Phase 7 timing values look like configuration and are not. They are
module constants in `src/queue/queueService.ts` with a constructor seam used
only by tests — there is **no environment variable, no `.env` key and no
runtime toggle for either**, by decision (Phase 7 D-12). Setting either name
in `.env` or in the PM2 environment does nothing at all; the process will
not warn you, because nothing reads it.

| Constant | Default | Why it is not a knob, and what happens if it were set too low |
|---|---|---|
| `PENDING_PRINT_EXPIRY_MS` | `600000` (10 min) | How long a pending-print slot stays open before the sweep marks it `expired` and writes the `No print upload seen` warning (§8). Its floor is **derived, not chosen**: `SESSION_TIMEOUT_MS` + `NEXT_GUEST_COUNTDOWN_MS` = `307000`, and the value is clamped to at least that at construction. Below that floor a legitimately late print could expire before the next guest could even physically be dispatched — the service would drop a real guest's photo. Note that an expired slot still delivers the photo late (§8); the expiry governs the warning and the diagnosis, not the delivery. |
| `NO_PHOTO_CLOSE_DELAY_MS` | `900000` (15 min) | How long an unbound `in_progress` job must sit before the tick sweep closes it as `no_photo` (§6). Clamped at runtime to this instance's `PENDING_PRINT_EXPIRY_MS` + `NEXT_GUEST_COUNTDOWN_MS`. The two failure directions are not symmetric, which is what sets the generous default: closing **late** costs an operator a delayed diagnostic line, while closing **early** writes a terminal, persisted, guest-visible outcome onto a session that was still alive. |

Both are therefore absent from `.env.example` on purpose. If a future phase
decides either genuinely needs to be tunable per site, that is a decision to
reopen deliberately — not something to work around by adding a key here.

See `.env.example` for the full list of environment variables this service
reads.

## 4. Quick production-readiness check

Before deploying, from the `mirror-request/` directory:

```bash
NODE_ENV=production npm run build
NODE_ENV=production node -e "require('./dist/config').loadConfig()"
```

This should print nothing and exit `0`. If it throws, the error message
names exactly which variable (§3) is missing or still a placeholder in
your production environment — fix that variable and re-run.

## 5. Booth state machine

There is exactly one booth, tracked as a single row in the `booth_state`
table (`id = 1`). It has three live states:

- **IDLE** — nothing dispatched, nothing being announced. The queue tick
  looks for the next guest every 250 ms.
- **ANNOUNCING** — a guest has been picked and is being counted down
  (5-10 s, configurable via `NEXT_GUEST_COUNTDOWN_MS`, §3) before dispatch.
  This is a first-class state with its own transitions, not an
  implementation detail — treating it as one is how the restart defect this
  phase fixed came to exist.
- **BUSY** — a session has been dispatched to the Agent and is either
  awaiting acknowledgement or actively running.

The type `BoothState` in `src/types.ts` declares a fourth value,
`TIMEOUT_RESET`, which no code path in this service ever writes. It is
dead by design — do not look for it in the database.

### Completion and release are two separate anchors (Phase 7)

**Before Phase 7 there was one anchor: `session_end` both completed the job
and released the booth. That was wrong, and it is the defect Phase 7
exists to fix.** The two are now split, and an operator diagnosing a
session has to know which of the two they are looking at.

- **Completion happens at the print composite.** dslrBooth emits the
  finished composite file in `processing_start.param5` and again in
  `printing.param1` — measured pointing at the same file, about 30 seconds
  *before* that session's `session_end`. Whichever arrives first completes
  the job, scoped to `booth_state.current_job_id`; the second is absorbed
  and completes nothing. Completion does **not** release the booth.
- **Release happens at the first `session_end` after that**, or at the
  `BOOTH_RELEASE_TIMEOUT_MS` fallback deadline (§3) if no `session_end`
  ever arrives.

**`session_end` fires on every exit from the sharing screen, not once per
guest.** Measured on the real booth: three `session_end` events in 52
seconds for a single photo session, because the operator browsed the photo
gallery twice after the session had already finished. Its payload is empty
`{}` — dslrBooth attaches no session identity to it whatsoever, so the
server cannot tell a stray duplicate from a real one.

**Duplicate `session_end` events are therefore normal machine behaviour,
not an incident.** Do not open an investigation because you see several per
guest in the log. What matters is that a stray one now has nothing to
damage: it completes no job, and if no job is bound to the booth it is
ignored outright (`session_end received with no job bound to the booth`).

### A stray `session_start` is refused, and it says so (Phase 7 code review, CR-01)

`session_end` is not the only event that arrives stray. The Agent stamps its
`activeJobId` onto **every** event it forwards and never clears it, so a
`session_start` can arrive carrying the id of a job that is not the one at the
booth. When that happens you will see, at `warn`:

```
session_start ignored for <jobId>: booth is bound to <otherJobId>
```

**This line means the server refused to move the booth, and the guest who was
actually standing at it was protected.** Nothing is broken at the moment you
read it — the refusal is the fix working.

It is still worth looking at, because it tells you the Agent is emitting a
stale job id. Grep it:

```bash
grep "session_start ignored for" logs/extension-service-*.log
```

| What you see | What it means |
|---|---|
| Nothing | Normal. Most events are healthy. |
| One line around a session boundary | Ordinary late/duplicate event. No action. |
| A run of them naming the same `<otherJobId>` | The Agent is stuck on one stale id. The current session is safe, but restart the Agent between guests when convenient. |

**Why this matters historically.** Before this guard the rebind was
unconditional: a stray `session_start` took the booth from a live guest, who
then stayed `in_progress` but unbound — which made them eligible for the
no-photo sweep (§6), *and* made their own print composite fail its
`current_job_id` cross-check. The result was a guest who was genuinely
photographed being closed as `no_photo` and shown "see staff". That is the
`outcome=no_photo` + `captures>0` signature below, reached by a mechanism that
had nothing to do with the 15-minute residual window §6 describes — the theft
was instant. Job `BZWCWFN6` is the recorded real-world instance.

### The session summary line — one grep per session (Phase 7, D-14)

Every job that closes writes exactly one line, at `info`, with a fixed
leading token and a stable `key=value` field order:

```
SESSION_SUMMARY job=<jobId> outcome=<completed|no_photo> captures=<n|unknown> print_composite=<yes|no> duration_ms=<n|unknown>
```

To read a whole session, grep the job id and take this line — you do not
need to reconstruct the session from the per-event lines:

```bash
grep "SESSION_SUMMARY job=<jobId>" logs/extension-service-*.log
```

| Field | What it tells you |
|---|---|
| `outcome` | `completed` — a print composite was seen and the job closed normally. `no_photo` — the session ended with no composite ever seen (§6). |
| `captures` | How many `capture_start` events the session produced, which is the shot count **including retakes**. `unknown` means no counter entry existed — the count is held in memory only, so a service restart mid-session degrades it to `unknown` rather than to a wrong `0`. |
| `print_composite` | Whether a composite was actually seen. |
| `duration_ms` | Now minus `acknowledged_at`; `unknown` if the job never recorded one. |

**The one combination worth alerting on is `outcome=no_photo` with
`captures` greater than zero.** That is a session which photographed a
guest and was closed as having produced nothing — see §6's note on the
residual window. `outcome=no_photo captures=unknown` is the ordinary case
of a guest who walked away, and is not interesting.

The line is emitted from the **close** path, never the release path, so it
is not written a second time when a duplicate `session_end` arrives.

### Transition table

| From | To | Trigger | What happens to the job |
|---|---|---|---|
| IDLE | ANNOUNCING | The 250 ms tick finds a queued job and the booth is idle | The job stays `queued`; its guest name and countdown are broadcast to the display feed |
| ANNOUNCING | BUSY | The countdown (`NEXT_GUEST_COUNTDOWN_MS`) elapses | The job is marked `dispatched`, `dispatched_at` is stamped, and the dispatch command is sent to the Agent |
| BUSY | BUSY (unchanged) | The Agent reports a print composite (`processing_start` / `printing`) | **The completion anchor since Phase 7.** The job named by `booth_state.current_job_id` is marked `completed` and `completed_at` is stamped; a pending-print slot is opened for it (§8) and the summary line is written. The booth is **not** released and the queue does **not** advance |
| BUSY | IDLE | The Agent reports `session_end` | **Release only since Phase 7 — this completes nothing.** The booth is released, `current_job_id` is cleared, and the tick immediately looks for the next guest. If no job is bound to the booth (a stray duplicate), nothing happens at all |
| BUSY | IDLE | The `BOOTH_RELEASE_TIMEOUT_MS` fallback deadline fires for a completed job whose `session_end` never arrived | The booth is released with a warning naming the job, and the tick looks for the next guest. **No retry is charged and no `stall_reason` is written** — the job is already terminal (§6) |
| BUSY | BUSY (timer re-armed) | The Agent acknowledges the session (`session_start` or a positive ack) | The job is marked `in_progress`, `acknowledged_at` is stamped, and the busy timer restarts for a full `SESSION_TIMEOUT_MS` |
| BUSY | IDLE | The Agent rejects the session (a negative ack / NAK) | The job is requeued under the bounded retry policy (`stall_reason = 'agent_nak'`, see §6) or failed if retries are exhausted, and the tick immediately looks for the next guest |
| BUSY | IDLE | The busy timer fires — no acknowledgement or `session_end` arrived within `SESSION_TIMEOUT_MS` | The job is requeued under the bounded retry policy (`stall_reason = 'session_ack_timeout'`, see §6) or failed if retries are exhausted, and the tick immediately looks for the next guest |
| ANNOUNCING (at startup) | IDLE | The service starts and finds the booth left `ANNOUNCING` from before a restart | The job is left untouched (still `queued`) — the countdown is only 5-10 s, so it is simply re-announced by the next tick rather than resumed |
| BUSY (at startup, session stale) | IDLE | The service starts and finds the booth `BUSY`, but `now - booth_state.updated_at` is at or past `SESSION_TIMEOUT_MS` (or the timestamp cannot be parsed) | Every in-flight (`dispatched`/`in_progress`) job is swept through the bounded retry policy (`stall_reason = 'restart_recovery_timeout'`, see §6) |
| BUSY (at startup, session possibly live) | BUSY (timer re-armed) | The service starts and finds the booth `BUSY` with `now - booth_state.updated_at` under `SESSION_TIMEOUT_MS`, and at least one in-flight job | The booth stays `BUSY`; the most recently dispatched job is treated as the survivor and its timer is re-armed for only the *remaining* time (`SESSION_TIMEOUT_MS` minus the elapsed age) — never a fresh full timeout. Any other in-flight job found at the same time is swept through the retry policy as an orphan from an earlier incident |

Startup recovery (the last three rows) runs once, before the first tick,
every time the service boots. It exists because a restart destroys the
in-memory session timer but never the persisted `booth_state`/`queue_job`
rows — see §6.

## 6. When a job gets stuck

On every startup, before serving anything, the service reconciles the
persisted booth state against wall-clock age and resolves every job left in
`dispatched` or `in_progress` (see §5's last three transition rows). Most of
the time this means a stuck booth heals itself on the next restart. This
section is for diagnosing a job that is stalled *right now*, without
restarting the service, and for handling the case where a job should never
be re-dispatched at all.

### Read-only inspection

Run this from the `mirror-request/` directory with the service either
running or stopped — it opens the database read-only and cannot write to
it:

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database(process.env.LOCAL_STORE_PATH || './data/extension-service.sqlite', { readonly: true });
console.log('booth_state:', db.prepare('SELECT * FROM booth_state WHERE id = 1').get());
console.log('non-terminal queue_job rows:');
console.log(db.prepare(
  \"SELECT id, status, retries, stall_reason, queued_at, dispatched_at FROM queue_job WHERE status NOT IN ('completed','failed')\"
).all());
"
```

### `stall_reason` vocabulary

Every job that goes through the bounded retry policy carries one of these
fixed, server-authored `stall_reason` values — never guest-supplied text:

| `stall_reason` | What actually happened |
|---|---|
| `restart_recovery_timeout` | The service restarted and found this job still in flight with a booth state too old to trust as live (§5's startup-BUSY-stale row) |
| `session_ack_timeout` | The Agent was dispatched a session but never acknowledged it (and never sent `session_end`) within `SESSION_TIMEOUT_MS` |
| `agent_nak` | The Agent explicitly rejected the dispatched session |

**An empty `stall_reason` on a terminal job is now meaningful, not a bug.**
Two Phase 7 paths deliberately write no `stall_reason` at all, because
neither is a stall and `stall_reason` is a closed, server-authored
vocabulary that must not gain a value for them: the `no_photo` close below,
and the `BOOTH_RELEASE_TIMEOUT_MS` release fallback (§3, §5). If you find a
terminal job with no reason recorded, read its status and its
`SESSION_SUMMARY` line (§5) rather than treating the empty field as missing
data.

### `no_photo` — the sixth job status (Phase 7)

`queue_job.status` now has six values: `queued`, `dispatched`,
`in_progress`, `completed`, `failed`, and **`no_photo`**.

**What it means operationally:** the session ran but ended with **no print
composite ever seen** — the guest was called, the booth went busy, and
nothing was produced. The commonest cause is a guest who walked away
without accepting a shot.

**What it deliberately does NOT do:**

- **No retry is charged.** The guest is not called back to the camera.
  Nothing about this outcome is the guest's fault or a system fault, so it
  never routes through the bounded retry policy above.
- **No `stall_reason` is written** (see the note above).
- **The guest is not re-dispatched.** `no_photo` is terminal; a stray
  `session_start` naming a `no_photo` job is refused rather than
  resurrecting it.

**What the guest sees:** `see_staff`, with a failed photo-delivery state.

**How it is decided:** not at `session_end` — that event cannot be
attributed to a job (empty payload, fires on every sharing-screen exit,
§5). Instead a sweep on the 250 ms tick closes a job that is
`in_progress`, is **not** the job currently bound to the booth, has **no**
pending-print row of any status, and whose `acknowledged_at` is older than
`NO_PHOTO_CLOSE_DELAY_MS` (§3, default 15 minutes).

**The residual, stated plainly:** those four predicates narrow the window
in which a live session could be wrongly closed; they do not eliminate it.
A session still genuinely running 15 minutes after acknowledgement, with no
composite produced and the booth already rebound to someone else, would be
closed as `no_photo` while the guest was still present. **This is what the
summary line makes visible**: such a case appears as `outcome=no_photo`
with `captures` greater than zero (§5). If you ever see that combination in
production, it is worth reporting — it is the one shape this design
knowingly did not rule out.

### Retries and failure

Every stall increments `queue_job.retries`. A job is retried up to
`SESSION_MAX_RETRIES` times (default `2`, meaning 3 dispatch attempts
total, §3); once that budget is exceeded the job's status becomes `failed`,
its `stall_reason` records why, a warning is logged, and **the queue moves
on to the next guest** — one broken job never holds up everyone behind it.

**No guest is notified when their job fails.** Recording `stall_reason`
precisely enough to act on is this phase's obligation; sending the guest a
message about it is a later phase's delivery channel (Phase 4). A `failed`
row means somebody may need to be contacted by hand.

### Marking a job as "do not re-dispatch"

A job only re-enters the dispatch cycle while its status is `queued`. To
stop a specific job being re-dispatched — for example a registration from
days ago whose guest has long since left — mark it `failed` by hand.
**Take a backup of the database file first** (§2's retention posture
applies here too):

```bash
sqlite3 ./data/extension-service.sqlite \
  "UPDATE queue_job SET status = 'failed', stall_reason = 'manual_operator_stop' WHERE id = '<job-id>';"
```

`queue_job` rows in `failed` status are not pruned by anything in this
service — they are covered by §2's manual retention policy like every
other row.

### Reading the logs vs. reading the database

The masking filter in `src/logging/logger.ts` replaces any run of 7 or
more consecutive digits with asterisks. Job ids this service actually
receives can contain such a run, so a job id may appear partially
asterisked in the rotated log files under `logs/`. This is a known,
deliberate limitation carried over from Phase 1 — the same rule also
protects guest phone numbers, and it is not changed here. **The
authoritative record of what happened to a job is `queue_job.stall_reason`
and `queue_job.retries` in the database, not the log line.**

## 7. Agent WebSocket auth contract (`/agent`)

This service authenticates every WebSocket upgrade to `/agent` — the link to
the booth machine's Agent process. **This is the second published contract
this service owns**, alongside §1's webhook signing contract, and it has a
live counterparty: `dslrbooth-agent` is its own repository with its own
deploy artifact, so — unlike §1, where this service is the only
implementation — a release of one side that is not paired with a release of
the other breaks the link completely. Implement and deploy it exactly.

### The contract

| Header | Meaning |
|---|---|
| `Authorization` | `Bearer <token>` — the shared secret, and nothing else. This service accepts **only** this header form. |

- The server reads its half of the shared secret from `AGENT_WS_TOKEN` (§3).
  The Agent reads its half from `EXTENSION_SERVICE_WS_TOKEN`, alongside
  `EXTENSION_SERVICE_WS_URL` for the connection URL itself
  (`dslrbooth-agent/src/config.ts`). Both variables, on both machines, must
  hold the exact same secret value.
- An upgrade that fails verification is answered with a bare
  `HTTP/1.1 401 Unauthorized` written directly to the raw socket, and the
  socket is then destroyed — **before** the WebSocket handshake completes.
  A rejected client never holds an open socket, even briefly.
- The secret never belongs in a URL. An older Agent build that still appends
  `?token=<secret>` to the connection URL will be rejected outright — the
  server no longer reads a query-string credential in any form. If you are
  debugging a connection from an Agent that predates this contract, that is
  the query-string form it is still using; there is nothing on the server
  side left to accept it.
- This service never writes the secret to a log line, at any level,
  including on the rejection path. A rejected upgrade logs one generic line
  — `invalid or missing Authorization header` — and nothing more specific.
  That is by design, matching §1's "never leak which specific check failed"
  rule; do not go looking for a more detailed reason in the logs, because
  none is ever written.

### What breaks, and why

This is an outage, not a degradation. A server running this contract
**rejects every connection** from an Agent that has not been updated to send
the header. The queue keeps accepting registrations exactly as before —
nothing on the ingestion side changes — but nothing is ever dispatched to
the booth, because `isAgentOnline()` never reports true and §6's
connectivity gate holds the queue at `IDLE` indefinitely. No guest is
turned away and no job is marked `failed`; every registration simply queues
forever, unserved, until an operator notices the booth is not running
sessions.

### Deploy ordering

Both components go out in the **same maintenance window**. Never one and
then the other later.

```bash
# Server
cd mirror-request && npm run build

# Agent — rebuilds the deployable binary
cd dslrbooth-agent && npm run build:exe
```

`build:exe` produces `dslrbooth-agent.exe`, the artifact that actually runs
on the booth machine. Deploying a new server without also rebuilding and
redeploying this binary leaves the booth running an Agent that still speaks
the old contract.

### Verification before cutover, honestly scoped

Fast, non-production checks — run these first, but understand what they do
and do not prove:

```bash
cd mirror-request && npx vitest run test/agent-auth.test.ts
cd dslrbooth-agent && npm test
```

These prove each side against its own expectations — that the server
rejects and accepts the header correctly in isolation, and that the Agent
builds the header correctly in isolation. **They do not prove the two sides
meet correctly on a real wire.**

**There is no staging environment referenced anywhere in this repository's
configuration or in this runbook.** Say that plainly rather than implying a
rehearsal tier exists: `config.ts` on both sides distinguishes production
from everything else and nothing further; there is no Dockerfile, no
compose file, and no staging deploy target — only `ecosystem.config.js` for
pm2 in production. The only rehearsal actually available before a real
cutover is local: run the updated server on your own machine, point an
updated Agent build's `EXTENSION_SERVICE_WS_URL` at it with a matching
`EXTENSION_SERVICE_WS_TOKEN`, and confirm the server logs `Agent connected`
rather than the rejection line, and that a dispatched `start_session`
command reaches the Agent.

### Rollback

The server accepts the header form only — there is no fallback path. Rolling
the server back to a pre-contract build while the Agent has already been
updated reproduces the **identical outage in the opposite direction**: the
old server never sent a 401 for a missing header in the first place, but an
updated Agent's handshake will not match whatever the old server expects
either, and the booth stops being served exactly as above, just with the
two sides' roles reversed.

**Roll back both, or neither.** There is no partial-rollback state that
leaves the booth working.

### What the operator will see in the logs

Every line below is quoted verbatim from the source as it now stands.

| Log line | Level | Meaning |
|---|---|---|
| `Agent WS rejected: invalid or missing Authorization header` | warn | An upgrade to `/agent` failed verification — missing header, wrong scheme, or wrong secret. Never tells you which; see above. |
| `Agent WS replaced: <old-id> displaced by <new-id>` | warn | A second Agent connected while one was already connected. Last-wins: the new one takes over, naming both connection ids. This is not itself a failure — a real Agent recovering from a flaky network drop looks exactly like this — but two Agents pointed at one server by mistake also looks exactly like this, and now it is visible instead of silent. |
| `Agent heartbeat timeout (<elapsed>ms > <timeout>ms)` | warn | No heartbeat arrived within `HEARTBEAT_TIMEOUT_MS` (default 30 s, §3). The connection is torn down and treated as a disconnect. |
| `Skipping dispatch: Agent not connected (job <id> stays queued)` | warn | The queue found a job ready to announce, but the Agent is not connected, so nothing was dispatched. This logs **once per outage**, not once per 250 ms tick — its absence during a long outage is the tick working correctly, not a lost log line. |
| `Skipping dispatch: Agent disconnected during announcement (job <id> stays queued)` | warn | The Agent dropped during the 5-10 s announcement countdown, after the tick-gate above already passed. Same no-retry outcome as the tick-gate case. |
| `Job <id> requeued after Agent disconnect (no retry charged)` | warn | The Agent disconnected while a job was dispatched or in progress. The job returns to `queued` immediately. |

**The one fact an operator would otherwise misread**, tying back to §6's
`stall_reason` vocabulary: a requeue caused by the Agent disconnecting or
being absent does **not** increment `queue_job.retries` and records **no**
`stall_reason` — the row simply goes back to `queued` exactly as it was. A
job that has bounced back with a flat retry count and an empty stall reason
was not a bad job; it was a booth that was not there. This is deliberate
(D-01): a booth-side fault must never spend the guest's retry budget, or a
handful of ordinary outages would eventually mark a perfectly valid
registration `failed` for a fault that was never the guest's job at all.

Contrast this with §6's vocabulary, which is exclusively **session-side**:
an acknowledgement timeout (`session_ack_timeout`) or an explicit Agent
rejection (`agent_nak`) still charges a retry and still records a reason,
exactly as before this phase. If you see `retries` incrementing and a
`stall_reason` populated, the fault was in the session, not the link — go
look at §6. If you see a job back in `queued` with `retries` unchanged and
`stall_reason` empty, the fault was the link being down — look here
instead.

### Connection id format (WINDOWS ledger item 5, fixed in Phase 5)

**Correction note:** an earlier revision of this section was expected to
carry a paragraph describing a connection-id masking limitation and a stale
id-shape description. On inspection at this writing, no such paragraph
exists anywhere in this file — the passage above (§6, "Reading the logs vs.
reading the database") describes **job-id** masking, a different value,
and was never inaccurate about connection ids. This subsection is
therefore new content, not a correction of existing text, and that
discrepancy is called out rather than silently absorbed.

Every connection id this service mints for an Agent WS connection has the
shape `agent-<timestamp>-<sequence>`, e.g. `Agent connected: agent-...`
(quoted from `src/agent/agentServer.ts`'s log line templates). Before this
phase, the raw id was `` `agent-${Date.now()}-${++connSeq}` `` — a literal
13-digit epoch timestamp, which §6's `mask()` filter (`PHONE_RE`, any run
of 7 or more adjacent digits) partially asterisked in every log line,
degrading the `Agent WS replaced: <old-id> displaced by <new-id>`
diagnostic above to sequence-number-only. Ids also repeated across process
restarts, since `connSeq` resets to its initial value on every boot.

The fix, quoted from `src/agent/agentServer.ts`:

```ts
const id = `agent-${Date.now()}-${++this.connSeq}`.replace(/(\d)(?=\d)/g, '$1x');
```

Every adjacent pair of digits in the assembled id (timestamp and sequence
number both) has an `x` inserted between them, so no run of two or more
digits can ever occur — structurally, not merely "usually short enough."
`PHONE_RE`'s 7-digit threshold can therefore never be reached by a
connection id, regardless of how large the timestamp or the sequence
number grows.

**The fix was made at the id generator, not by relaxing `PHONE_RE`.**
`src/logging/logger.ts`'s masking patterns are untouched — under-masking a
real guest phone number is a strictly worse failure than over-masking an
id, so the regex that protects phone numbers stays exactly as Phase 1
locked it, and the id format bends around it instead.

### The ingestion VIEW cutover, deploy ordering (Phase 6 addendum)

Unlike this section's own Agent-auth contract above, the Phase 6 ingestion
cutover needs **no coordinated deploy of a second component**:
`dbPoller.ts`'s query is unchanged (D-02), so an old, already-running
build reads the new `photobooth.registrations` VIEW exactly as it read
the old table — there is no equivalent of "roll back both, or neither"
here.

The ordering, as actually run during this phase's own cutover (see §10
for what each step depends on and why):

1. Stop the service.
2. Capture the rollback artefact — `SHOW CREATE TABLE
   photobooth.registrations` plus `SHOW GRANTS`, written to a committed,
   runnable restore script (`src/ops/captureRegistrationsRollback.ts` →
   `docs/migrations/06-rollback-registrations-table.sql`). This must exist
   and be reviewed before the next step: MySQL has no DDL undo.
3. Apply the DDL — `docs/migrations/06-cutover.sql`'s `DROP TABLE` and the
   two `CREATE OR REPLACE VIEW` statements. **Pipe the file into `mysql`;
   never paste it into an interactive session** — see §10's "Applying DDL
   with a non-ASCII literal" for why this is not optional caution.
4. Verify as the service account (`extension_service_ro`), not the admin
   account that ran the DDL — the account that matters is the one
   `dbPoller.ts` actually uses. `npx ts-node
   src/ops/verifyRegistrationsView.ts --source=view` (or the built
   `dist/` equivalent) is the harness; see §10.
5. Seed the cursor — `node dist/ops/seedRegistrationsCursor.js`, before
   the process (re)starts. `DBPoller` is constructed unconditionally in
   `index.ts`, with no enable flag, so an unseeded cursor at boot would
   dispatch every historical row.
6. Build — `npm run build`.
7. Start the service.

**Rollback:** the two `DROP VIEW` statements
(`DROP VIEW IF EXISTS photobooth.registrations; DROP VIEW IF EXISTS
photobooth.registrations_name_audit;`) plus the `CREATE TABLE` captured in
step 2 — the full runnable script lives at
`docs/migrations/06-rollback-registrations-table.sql`.

## 8. Guest notification delivery

This is the third published contract this service owns, alongside §1's
webhook signing contract and §7's Agent auth contract — the last leg of the
guest's journey: when a photo finishes processing, this service tells the
slideshow so the guest sees their own picture appear on screen.

### What Phase 7 changed here: the trigger, not the mechanism

**The delivery mechanism below is unchanged** — the same payload contract,
the same `notification_record` sweeper, the same retry budget, the same
status and failure vocabularies. Only the question "**which job is this
photo for?**" is answered differently, and the change matters because the
old answer was wrong whenever a queue existed.

Previously a print upload was attributed to whichever job happened to own
the booth at the moment the upload arrived. But a print upload's ordering
relative to `session_end` is not fixed — measured 26 seconds *before* it on
one session and about one second *after* it on another — so in the second
ordering the booth had already been released and rebound, and a real
guest's photo would have been sent to the **next** guest's email and phone.

Uploads are now resolved against a durable **pending-print registry**. A
slot is opened for the job at the completion anchor (§5), before the upload
exists, so the record of who is owed the photo survives the booth moving on.
Three outcomes, and all three are deliberate:

| Registry state | What happens | What you see in the log |
|---|---|---|
| `awaiting` — a slot is open | The ordinary path. The photo is delivered to that job's guest and the slot moves to `resolved`. | Nothing unusual |
| `expired` — the slot's deadline passed before the upload arrived | **The photo is still delivered.** Getting it late beats not getting it. The job's own status is deliberately left untouched. | A `warn` naming the job and how late it was. **A recurring one means `PENDING_PRINT_EXPIRY_MS` (§3) is set too tight** |
| no slot was ever opened | **The photo is dropped and reaches nobody.** No session was awaiting a print for that job — this is the case where a stranger pressing start on the booth's own screen would otherwise have their photo sent to the last real guest, because the Agent stamps a stale job id on every event and never clears it. | A `warn`: `Print upload for <job> dropped: no session was awaiting a print for it` |

Expired slots are **marked, never deleted**, which is what keeps the second
and third rows distinguishable after the fact.

One warning also moved. `No print upload seen` used to be evaluated at
`session_end`, where it fired on every successful session and told an
operator nothing (WINDOWS ledger item 9). It is now written once per slot
at registry expiry — the only anchor at which it can be correct — and the
literal token is unchanged, so existing greps keep working.

### The published payload contract

When a delivery is attempted, this service POSTs exactly these five keys as
a JSON body to `NOTIFY_WEBHOOK_URL` (§3):

```json
{
  "jobId": "job-abc123",
  "guestName": "Nguyễn Văn A",
  "photoUrl": "https://example.com/photos/job-abc123.jpg",
  "timestamp": "2026-08-10T09:15:32.104Z",
  "mode": "boomerang"
}
```

**The receiver performs no lookup of any kind.** `web-slide/server.js`
reads these fields straight off the request body and falls back silently
when one is absent — `body.guestName` (or two other fallback field names)
defaulting to the literal string `'Khách hàng'`, `body.photoUrl` defaulting
to `null` (no image shown), and so on. There is no schema validation, no
required-field check, and no error response for a malformed or
short-payload body — a well-formed request always gets a `200`. **This
means anything the slideshow is supposed to show must be in this payload,
and a field rename on either side — this service renaming `guestName`, or
the receiver being changed to read a different key — produces a blank
display or a `'Khách hàng'` placeholder and no error anywhere.** Nothing on
either side would report it; the only way to know is a person watching the
screen. This is why the contract lives here as prose, not just as
whatever the current code happens to send.

**What this service deliberately does not send:** no `phone`, no `email`,
no other guest contact detail. The slideshow displays a name and an image;
it has no use for contact details, so none are sent — not sending PII is
cheaper than protecting it in transit (D-02, D-03). `web-slide`'s `phone`
and `email` fields exist in its own data model but are treated as
vestigial for this integration: they will always receive `''` from this
service. That is the intended end state, not a bug or drift to fix.

**This webhook is unsigned**, unlike the inbound `/on-register` contract in
§1. The reason is the absence of personal data in the body — there is
nothing in a stolen or forged payload worth protecting beyond a guest's
name and a photo URL that already exists on this service's own storage. If
the payload ever grows to carry contact details or anything else sensitive,
signing must be revisited before that change ships.

### The delivery model

An Agent `file_upload` event calls `sendPhotoLink()`, which writes a
durable work item to `notification_record` carrying the photo URL and a due
time — it performs no network I/O itself and returns immediately. A
periodic sweeper (`NOTIFY_SWEEP_INTERVAL_MS`, §3) claims and delivers rows
that are due. **There is no in-memory retry loop and no startup recovery
pass** — the sweeper's own due-time query is the recovery mechanism, which
is what makes a restart mid-retry harmless (D-04). A process killed
mid-delivery leaves its row claimed with a lease (`status = 'sending'`,
`dueAt` set to the lease deadline); the row becomes deliverable again on
its own, with no special-case code, once that lease expires and the
sweeper's normal due-time query finds it again.

### The status vocabulary

| Status | Meaning | Terminal? | What moves it out |
|---|---|---|---|
| `pending` | Enqueued, not yet attempted | No | The sweeper claims it once its `dueAt` has passed |
| `retrying` | A previous attempt failed and a further attempt is scheduled | No | The sweeper claims it once its (backed-off) `dueAt` has passed |
| `sending` | Currently claimed by a sweeper process, mid-delivery | No | Delivery succeeds (→ `delivered`), fails and retries remain (→ `retrying`), fails and retries are exhausted (→ `failed`), or the claiming process dies and the lease in `dueAt` expires (→ eligible to be claimed again, same as `pending`/`retrying`) |
| `delivered` | The receiver answered `2xx` | **Yes** | Nothing — a terminal state, excluded from every query the sweeper runs |
| `failed` | Retries exhausted, or the row could never be delivered (no registration found, or a pre-migration row with no photo URL) | **Yes** | Nothing automatic — see "Re-arming a failed notification by hand" below |

`sending` carries a lease deadline in `dueAt` rather than being a dead
end — it is not a status a row gets stuck in. The two terminal states,
`delivered` and `failed`, are excluded from every query the sweeper runs
(`getDueNotifications()`'s `status IN ('pending','retrying','sending')`
and `claimNotification()`'s matching predicate in `src/state/localStore.ts`),
which is what guarantees a guest's photo is never sent twice (D-05).

### The failure vocabulary

The `lastError` reason strings this service actually writes, from
`classifyError()` in `src/notifications/notificationService.ts`:

| `lastError` value | What it tells the operator |
|---|---|
| `timeout` | The delivery attempt was aborted after `NOTIFY_FETCH_TIMEOUT_MS` with no response. **The receiver is alive and stuck**, not absent — it accepted the connection but never answered. |
| `Webhook returned HTTP <status>` | The receiver responded, but not with `2xx`. Check the receiver's own logs for that status code. |
| the underlying `Error.message` (e.g. a `TypeError` for connection refused) | The receiver was not reachable at all — **the receiver is absent**, not stuck. A `fetch` connection-refused error surfaces its own message here. |
| `registration not found` | The row's `jobId` no longer resolves to a guest registration. Not a network fault — this delivery can never succeed regardless of retries. |
| `photoUrl unavailable — record predates persisted-queue migration` | Written once, by the migration itself, not by a delivery attempt — see "One migration note" below. |

A `timeout` and a connection-refused `Error.message` lead to different
fixes: a `timeout` means go look at why the receiver process is hung
(deadlocked, out of memory, stuck request handler); a connection failure
means go check whether the receiver process is running at all, or whether
a network/firewall change broke the path to it.

When retries are exhausted, exactly one line is logged, after the durable
`failed` write, quoted verbatim from the source:

```
Notification permanently failed for job ${row.jobId} after ${nextAttempt} attempts: ${reason}
```

This is the only operator-visible log signal that a specific guest never
got their photo — grep for `Notification permanently failed` in the
rotated logs under `logs/` to find every occurrence. No error-level log
fires on a retry that still has budget remaining (D-09).

### Finding guests who never got their photo

```sql
SELECT
  n.jobId,
  r.name AS guestName,
  n.lastError,
  n.attempts,
  n.updatedAt
FROM notification_record n
JOIN queue_job q ON q.id = n.jobId
JOIN registration r ON r.id = q.registration_id
WHERE n.status = 'failed'
ORDER BY n.updatedAt DESC;
```

This is what D-09 exists for, and what NOT-02's "log để xử lý thủ công"
("log for manual handling") means in practice — a query, not a code path,
because a `failed` notification is not something the service can safely
resolve on its own.

### Re-arming a failed notification by hand

**Take a backup of the database file first** (§2's retention posture
applies here too):

```sql
UPDATE notification_record
SET status = 'pending', dueAt = strftime('%s','now') * 1000
WHERE jobId = '<job-id>';
```

**The code will not do this for you by design.** A repeat `file_upload`
event for a job whose notification has already reached a terminal state
does not re-arm it — `enqueueNotification()`'s `ON CONFLICT ... WHERE
status NOT IN ('delivered','failed')` clause in `src/state/localStore.ts`
makes that a structural no-op, not an `if` a later edit could accidentally
delete. Terminal is terminal; re-arming a failed delivery is always an
explicit, deliberate operator action, taken with a backup in hand and a
specific reason to believe delivery will succeed this time (for example,
the receiver being confirmed back online after an outage).

### The retry budget

`NOTIFY_MAX_RETRIES` counts retries **after** the first attempt (D-08), not
the total. The shipped default of `2` therefore yields **3 total delivery
attempts** — `attemptDelivery()`'s boundary is written and confirmed as
strictly `nextAttempt < 1 + this.maxRetries`, not `<=`.

This meaning changed in this phase, and the default moved from `3` to `2`
in the same change specifically so the real number of attempts stayed at
3 — under the old code, `NOTIFY_MAX_RETRIES=3` with an `attempt <=
maxRetries` loop also yielded 3 total attempts. **Anyone who set this
variable explicitly in a production environment file, to any value, is now
getting one more attempt than before and should re-read their value** (see
§3's table entry for the same note). The new default also matches
`SESSION_MAX_RETRIES`'s meaning and value exactly — both now mean "retries
after the first attempt," both default to `2`.

### One migration note, stated plainly

The first boot after this deploy rewrites rows. `notification_record` never
stored a photo URL before this phase (D-13) — it existed only as a runtime
value passed through a live `file_upload` event and was never persisted.
Any row in `notification_record` that predates this change therefore has no
`photoUrl` and can never be resumed by the new sweeper. The migration marks
every such non-terminal row `failed`, with:

```
lastError = 'photoUrl unavailable — record predates persisted-queue migration'
```

**This is one-way.** There is no code path that recovers a photo URL for
one of these rows after the fact — the URL was never written anywhere
durable, so there is nothing to recover it from. This is honest rather than
silent: the alternative was leaving those rows looking deliverable forever,
never actually sending, and never telling anyone why. See Task 3's phase
gate below for the human decision this triggers before a production
deploy.

## 9. Guest-facing read surfaces (`GET /status/:jobId`, `WS /display`, `GET /display-screen`)

This is the fourth published contract this service owns, alongside §1's
webhook signing contract, §7's Agent auth contract, and §8's notification
payload contract. Unlike those three, these are the surfaces a **guest**
and a **room full of people** see directly, not another service's
integration point.

### The guest status endpoint

`GET /status/:jobId` (`src/status/statusRoute.ts`). The job id **is** the
credential — a guest receives it by scanning their own QR code, and there
is no additional authentication of any kind (no login, no PIN, no IP
allow-list). The reason is a hard constraint, not a preference: a guest's
phone is on a different network path than the room LAN, so an address
allow-list would lock out every legitimate guest the endpoint exists to
serve.

**The exact response key set**, quoted from `GuestStatusResponse` in
`src/status/guestStatus.ts`: `jobId`, `queuePosition`, `queueLength`,
`guestName`, `status`, `photoDelivery`, `boothPaused`, and the optional
`waitEstimate`.

**The six guest-facing words**, quoted from `GUEST_STATUSES` in the same
file, and which internal state from Phases 2-4 produces each one (via
`STATUS_MAP` in `src/status/guestStatus.ts` and the `boothPaused`
computation in `src/status/statusRoute.ts`):

| Guest-facing `status` | Produced when |
|---|---|
| `waiting` | `queue_job.status = 'queued'` and this job is not the announced one |
| `your_turn` | `queue_job.status = 'queued'` and this job **is** the announced one, or `status = 'dispatched'` |
| `in_session` | `queue_job.status = 'in_progress'` |
| `finished_photo_sent` | `queue_job.status = 'completed'` and the Phase 4 `notification_record` for this job is `'delivered'` |
| `finished_photo_pending` | `queue_job.status = 'completed'` and the notification is anything other than `'delivered'` (including no record at all, or a terminally `'failed'` delivery — the guest's session is honestly finished either way; only the photo's arrival is still open) |
| `see_staff` | `queue_job.status = 'failed'` — this job exhausted Phase 2's bounded retry budget (§6), or an internal state the router does not recognise reached the boundary (an operator-visible `logger.error`, never a guest-visible detail) |

An operator reading a guest's screenshot of `see_staff` can work backwards
to §6's `stall_reason`/`retries` columns for that job id to find out what
actually happened — the guest is never shown that detail themselves
(D-11's closed vocabulary: `dispatched`, `in_progress`, `stall_reason`,
`retries`, `ack_error_message`, `TIMEOUT_RESET` never cross this boundary).

**The separate `photoDelivery` field**, quoted from `PHOTO_DELIVERY_STATES`:
`sent`, `pending`, `failed`. Stated separately from `status` rather than
folded into it (D-12) — a guest whose session genuinely finished but whose
photo notification is still retrying or has permanently failed is still
honestly `finished_photo_pending` or `finished_photo_sent` on the status
axis, with the photo's own state told straight rather than hidden inside a
combined word.

**`waitEstimate` is absent, never `null`, whenever the booth cannot serve.**
The key only appears (`statusRoute.ts`'s conditional object spread) when
`status === 'waiting'` **and** `boothPaused === false`. This is deliberate:
a client rendering `waitEstimate: null` would show "0 phút" — no wait at
all — to precisely the guest whose wait is indefinite. An absent key cannot
be misread that way.

**Every failed lookup returns one identical `404`, on purpose.** Quoted
verbatim from `genericNotFound()` in `src/status/statusRoute.ts`:
`{ "error": "job not found" }`. A job id that never existed, one that was
purged, one belonging to another guest that happens to be malformed, and
an unexpected internal error while looking it up all produce this exact
same status and body (D-08). **This means an operator who is told "it 404s
for this guest" has learned nothing about why** — never treat a 404 report
as diagnostic on its own; go look up the job id directly in the database
(§6) instead. Note also, deliberately: a **valid** id belonging to a
different guest than the one asking still returns `200` with the full
body, not a 404 — under the capability-URL model, holding the id **is**
the authorisation, so D-08's "never distinguish among failures" rule does
not turn a valid, working id into a manufactured failure.

### The wait estimate

Measures `completed_at - acknowledged_at` on rows where
`queue_job.status = 'completed'` — restricting the sample to that status is
itself the exclusion of stalled, requeued and failed sessions (D-02): a job
that stalled or failed never reaches `'completed'`, so it cannot
structurally enter the sample, with no separate application-level filter
for a later edit to accidentally remove.

**Median, not mean.** A single session that hit Phase 2's `SESSION_TIMEOUT_MS`
before failing over would otherwise drag a mean upward for hours; a median
is not moved by one outlier.

**Whole-minute range, rounded up.** The guest sees a range like "khoảng
3–5 phút", never a precise ticking number (D-03) — a number that counts
down and then jumps back up when the queue shifts destroys trust faster
than a vague answer ever will. The high end is `Math.ceil(ms / 60000)`; the
low end is one minute below that. Rounding is always **up**: it is always
better for a guest to be called earlier than the estimate suggested than
later.

**Cold-start fallback.** Below `WAIT_ESTIMATE_MIN_SAMPLES` (§3) real
completed-session samples, the estimator does not compute a median from
one or two sessions — it serves the configured `WAIT_ESTIMATE_DEFAULT_MS`
(§3) instead (D-04). **Measured fact as of this writing: the production
database holds exactly 1 completed `queue_job` row.** With the shipped
default of 5 minimum samples, `1 < 5`, so the configured default —
"khoảng 2–3 phút" — is what production will actually serve to every guest
on day one, until the fifth real completed session lands. This is D-04
working exactly as designed, not a bug to fix before deploy.

### The display surfaces

Both `WS /display` and `GET /display-screen` are gated by the same address
allow-list (`DISPLAY_IP_WHITELIST`, §3), **not** by a token or a Bearer
header — a deliberate divergence from §7's Agent auth contract, forced by
a hard browser constraint rather than a preference: the browser
`WebSocket` API cannot set request headers, so §7's
`Authorization: Bearer` pattern cannot transfer to a page running in a
browser (D-09).

**The socket refusal happens before the handshake.** Quoted from
`src/display/displayServer.ts`'s `upgrade` handler: an unauthorised peer's
connection is refused with a raw `HTTP/1.1 403 Forbidden\r\nConnection:
close\r\n\r\n` written directly to the socket, followed immediately by
`socket.destroy()`, strictly before `wss.handleUpgrade(...)` is ever
called — an unauthorised peer never holds an open WebSocket connection,
even briefly.

**The two refusal bodies are not literally identical**, and that is worth
stating precisely rather than assumed: `GET /display-screen` is an Express
route and returns a JSON body, `{"error":"Forbidden"}`, with status `403`
(`src/index.ts`) — the same shape §1's blocked-webhook-IP response already
uses. The `WS /display` refusal happens at the raw-socket layer, before
any HTTP response object exists to attach a JSON body to, so it carries
**no body at all** — only the raw status line quoted above. Both are a
generic, non-distinguishing `403` with no detail about which check failed,
which is the property D-09 actually needs; only the literal bytes on the
wire differ between the two surfaces, and an operator comparing the two
in a HAR file or `curl -v` capture should expect that difference rather
than read it as a bug.

**The matching rule**, quoted from `isWhitelisted()` in
`src/security/ipAllowlist.ts`: an entry ending in `.*` matches by prefix
(`ip.startsWith(prefix)`); every other entry matches by exact string
equality. An empty whitelist matches everything — a development escape
hatch only, unreachable in production because of §3's fail-fast check.

**Warning: the allow-list matches the address form the runtime reports for
the direct TCP peer, and that form depends on how the server binds.**
Measured during Phase 5 (`05-03-PLAN.md`, confirmed against
`test/display-access-control.test.ts`): a plain IPv4 bind
(`server.listen(port, '127.0.0.1')`) yields the plain form, e.g.
`127.0.0.1`; a bind with no explicit host (`server.listen(port)`, which
binds `::` and is IPv6-capable) yields the IPv4-mapped form instead, e.g.
`::ffff:127.0.0.1`. **The shipped `HOST` default is `0.0.0.0`**
(`src/config.ts`), an IPv4 bind, so production sees the **plain** form —
an allow-list entry written as `::ffff:192.168.1.50` would never match a
production deployment running the default `HOST`, and the reverse is true
if `HOST` is ever changed to bind IPv6. No address normalisation exists
anywhere in this service (`src/security/ipAllowlist.ts` does not rewrite
either form into the other, deliberately, matching §1's un-normalised
`PROXY_IP_WHITELIST` matching so the two allow-list surfaces do not
disagree) — write the allow-list entry in whichever form your actual
deployment's bind produces, and verify it rather than assume it.

**No proxy trust is enabled anywhere in this service.** Express's
`app.set('trust proxy', ...)` is never called (confirmed:
`grep -rn "trust proxy" src/` matches only the doc comments in
`src/security/ipAllowlist.ts` and `src/ingestion/mirrorReceiver.ts`
explaining its absence — zero live calls). Without it, the address the
allow-list checks is always the direct TCP peer, never a
client-controlled `X-Forwarded-For` header. Enabling proxy trust
unscoped would let any client forge that header and impersonate an
allow-listed address, defeating the control entirely — the same reasoning
§1 already carries for `PROXY_IP_WHITELIST`.

### The broadcast behaviour

The feed sends only when something changed: every poll tick builds a fresh
snapshot and compares its serialised form against the last one actually
sent, sending (and updating the comparison baseline) only on a difference
(`maybeBroadcast()` in `src/display/displayServer.ts`, D-13). In practice
this produces one message per second while a countdown is running — the
only field that changes on its own while nothing else moves is the
remaining-seconds count, which the change detector catches once per
second — and nothing at all while the room is idle and no state has
moved. A newly-connected client always receives one unconditional snapshot
on connect, independent of this comparison.

The up-next list shows given names; the guest currently being called shows
their full name on the hero line. The full name is being announced in the
room anyway, so the called guest needs to recognise themselves instantly;
a room full of strangers waiting behind them does not need everyone's full
name on a shared screen. In Vietnamese naming the given name is the
trailing element (`toGivenName()` in `src/display/displayServer.ts`:
`"Nguyễn Văn A"` → `"A"`), which is also how a person would actually be
addressed (D-14).

### Accepted risks

In the same register §3 uses for `NOTIFY_WEBHOOK_URL` reachability and §7
uses for the undeployed Agent-auth cutover — stated plainly, never left
silent.

**The capability-URL's inherited entropy (D-06/D-07) — UNVERIFIED, a
pre-production blocker.** `/status/:jobId`'s security model depends
entirely on the job id being unguessable. This service does not mint that
id — it is taken verbatim from the inbound registration payload
(`src/ingestion/mirrorReceiver.ts`, `src/ingestion/dbPoller.ts`) — so its
entropy is inherited from the upstream backend and was not verified during
this phase. **The human's own resolution, quoted verbatim from
`05-01-SUMMARY.md`:** *"Đây là môi trường dev nên bạn cứ làm"* — this is a
dev environment, proceed — chosen option `not-confirmed-accept-risk`. This
is explicit authorization to ship the design as-is **in dev**. It is
explicitly **not** a resolution for production: before `/status/:jobId` is
exposed outside dev, the backend's id-minting scheme must be confirmed
CSPRNG-based (≥128 bits) — a human can settle this with one read-only
`SELECT id FROM registrations ORDER BY <pk> DESC LIMIT 20` over the
existing read-only `DB_POLL` credentials; a sequential or timestamp-shaped
id is obvious at a glance. **Never write to that database.** If the scheme
turns out to be guessable, this design is unsound and needs a separate,
server-minted status token instead — a new column, a new lookup path, and
a new value that must reach the guest's QR code, generated outside this
service. This is tracked as WINDOWS ledger item 6 and is never to be
silently closed.

**No connection cap on `/display` — accepted, judged low risk.** Nothing
in `src/display/displayServer.ts` limits how many WebSocket clients may
hold an open `/display` connection simultaneously. Judged acceptable
because, after D-09, the endpoint is now LAN-restricted by
`DISPLAY_IP_WHITELIST` and in practice serves a handful of physical
browsers in one room, not an internet-facing audience.

## 10. The ingestion VIEW (`photobooth.registrations`)

This is the fifth published contract this service owns, alongside §1's
webhook signing contract, §7's Agent auth contract, §8's notification
payload contract, and §9's guest-facing read surfaces — except this one is
not code this repository controls. It is a MySQL `VIEW` living inside the
`photobooth` database, defined over six tables owned by a different
application (`ets_web`) in a different repository this project never
modifies. Everything below exists because nobody upstream will ever be told
this VIEW depends on their schema.

### What it is and what it depends on

`photobooth.registrations` and its sibling `photobooth.registrations_name_audit`
are `VIEW`s, not tables, over `ets_web.ticketing_ticket`,
`ets_web.event_manager_attendance`, `ets_web.ticketing_orderdetail`,
`ets_web.ticketing_order`, `ets_web.ticketing_customer` and
`ets_web.account_personalinfo`. `ets_web` and `photobooth` share one MySQL
instance, which is the only reason a cross-database VIEW is possible at
all — there is no application code anywhere on this path. The fallback
chain that resolves a guest's name, the validity filter that excludes
cancelled/unpaid tickets, and the per-ticket de-duplication are all SQL,
defined once in `src/ops/registrationsViewSql.ts`'s
`REGISTRATIONS_INNER_SELECT` and generated — never hand-typed a second
time — into every other artefact on this list.

`dbPoller.ts` (closed to edits, D-02) reads exactly this query against
`photobooth.registrations`, unchanged from before this phase:

```
SELECT id, name, email, phone, mode, registered_at
FROM registrations WHERE registered_at > ? ORDER BY registered_at ASC LIMIT ?
```

The VIEW satisfies that query by producing exactly those six columns, in
that order, for every ticket that is `valid` and whose order is
`completed` — nothing on the polling side needed to change, or ever will,
for this integration to keep working.

### The standing cost, stated plainly

An upstream `ets_web` migration that renames a table or a column referenced
above breaks ingestion on this side with **no signal to whoever ran it.**
Nobody on the `ets_web` side of the organisation knows this VIEW exists.
This section is the only place that fact is written down. The health probe
below (§10, "The health probe") is the only automated defence against it,
and it detects that the VIEW broke — not why, and not that a *behavioural*
change upstream (see "A VALID ticket with zero attendance rows" below) made
the VIEW quietly wrong instead of loudly broken.

### The files

Name them by path; their SQL is not reproduced here because a copy that
drifts from the generated original is worse than no copy at all.

| File | What it is |
|---|---|
| `docs/migrations/06-registrations-view.sql` | The DDL — both `CREATE OR REPLACE VIEW` statements, generated (never hand-edited) from `src/ops/registrationsViewSql.ts` via `npx ts-node src/ops/verifyRegistrationsView.ts --emit-sql`. |
| `docs/migrations/06-cutover.sql` | The ordered, 8-section cutover script a human runs by hand: pre-flight checks, the destructive `DROP TABLE`, the two `CREATE VIEW` statements (copied verbatim from the file above), the grant, post-checks run as the service account, the deliberate write-refusal check, a documented fallback, and the rollback. |
| `docs/migrations/06-rollback-registrations-table.sql` | The captured pre-phase `CREATE TABLE` definition plus the pre-cutover grant baseline, generated by `src/ops/captureRegistrationsRollback.ts` before the cutover ran. This is the entire recovery path — MySQL has no DDL undo. |

### Applying DDL with a non-ASCII literal — pipe the file, never paste it

**This happened during this phase's own cutover, not a hypothetical.** The
DDL contains one non-ASCII literal: D-04's last-resort name label,
`'Khách • '`. The operator applied `06-cutover.sql`'s two `CREATE OR
REPLACE VIEW` statements by copy-pasting them into an interactive `mysql>`
prompt — exactly as the script's own header instructed ("copied VERBATIM").
The paste path double-encoded that one literal: the server stored
`'KhÃ¡ch â€¢ '` instead of `'Khách • '`. This was caught, not assumed, by
measuring the stored bytes directly:

```sql
SELECT HEX(SUBSTRING(VIEW_DEFINITION, LOCATE('Kh', VIEW_DEFINITION), 6))
FROM information_schema.VIEWS
WHERE TABLE_SCHEMA='photobooth' AND TABLE_NAME='registrations';
```

returned `4B68C383C2A16368` (`KhÃ¡ch`) where the correct value is
`4B68C3A16368` (`Khách`). The server itself was exonerated by measurement
before assuming the corruption was somewhere else: every `character_set_*`
session variable was `utf8mb4`, and a piped round-trip
(`printf "SELECT HEX('Khách •');" | mysql`) on this same server returned
the byte-exact `4B68C3A1636820E280A2`, even without
`--default-character-set`. The corruption lived entirely in the interactive
paste path — a terminal is itself a lossy channel for non-ASCII bytes, and
an echoed-back terminal display can look correct while the stored bytes are
not. It was fixed by re-running only the two `CREATE OR REPLACE VIEW`
statements via `mysql < docs/migrations/06-registrations-view.sql`
(piping the file, not pasting it — that file carries no `DROP`/`GRANT`, so
nothing destructive was at risk), then re-measuring: `4B68C3A16368`,
correct.

**The rule this leaves behind:** "copy the statements verbatim" defends
against transcription error but not against encoding corruption, because
copy-paste through an interactive terminal is itself a lossy channel. Any
DDL carrying a non-ASCII literal must be applied by **piping the file**
(`mysql < path/to/file.sql`), never by pasting it into an interactive
session, and verified afterward with a `HEX()` check on the stored
definition — do not trust the echoed terminal output, and do not skip the
`HEX()` check because the paste "looked fine."

### The grant

The account resolved by `SELECT CURRENT_USER()` during cutover is
`extension_service_ro@%` — matching `config.ts`'s `DB_USER` default
exactly (measured, not assumed). Its only relevant grant is:

```
GRANT SELECT ON `photobooth`.* TO `extension_service_ro`@`%`
```

That grant is schema-wide (`photobooth.*`), so it already covers both
VIEWs the moment they exist — no per-VIEW grant is needed, and none was
issued beyond this one statement. Neither VIEW needs `extension_service_ro`
to hold **any** grant on `ets_web` at all: both are defined
`DEFINER = 'ets_web'@'127.0.0.1'` with `SQL SECURITY DEFINER`, so the VIEW
runs as its definer account, not as the account that queries it. Re-check
the live grant with:

```sql
SHOW GRANTS FOR CURRENT_USER();
```

The deliberate write that must be refused, run as the service account:

```sql
INSERT INTO photobooth.registrations (id, name, email, phone, mode, registered_at)
VALUES ('write-refusal-check', 'test', 'test@example.com', '0000000000', 'print', NOW());
```

This is expected to fail with `ERROR 1142 (42000): INSERT command denied to
user 'extension_service_ro'@'...' for table 'registrations'` — refused on
privilege, before the VIEW's own structure is ever reached. A second,
independent line of defence exists even if privilege were ever mistakenly
widened: the VIEW's derived subquery contains a `JOIN` and a window
function, which MySQL's own updatable-view rules make structurally
non-insertable regardless of grant, producing `ERROR 1471 (HY000): The
target table registrations of the INSERT is not insertable-into` instead.
Both were independently confirmed during this phase's cutover — 1142 as the
service account, 1471 as the admin account. **A successful `INSERT` here is
a blocking finding**, not a warning: it means `CLAUDE.md`'s "never write to
the real backend DB" guarantee does not hold at the database layer, and
guest traffic must not proceed until the grant is corrected.

### Cursor seeding

`DBPoller` is constructed unconditionally in `index.ts` — there is no
enable/disable flag — so the `registrations` cursor must be seeded to
"now" **before the process (re)starts** against a live, non-empty VIEW.
Run this before `npm run build && npm start` (or your process manager's
restart), never after:

```bash
node dist/ops/seedRegistrationsCursor.js
```

The part nobody would guess: the seed must be written in the VIEW's own
lexical format, `YYYY-MM-DD HH:MM:SS.ffffff`, read from **MySQL's own
clock** (`SELECT DATE_FORMAT(NOW(6), '%Y-%m-%d %H:%i:%s.%f')`), never from
`new Date().toISOString()` on the Node host. `dbPoller.ts`'s cursor filter
(`registered_at > ?`) is a **lexical string comparison**, not a
type-aware date comparison, and an ISO-8601 seed sorts *below* a
same-day VIEW-format value:

```
'2026-08-11 14:00:01.000000' > '2026-08-11T14:00:00.000Z'  →  false
```

An ISO-shaped seed would therefore fail to exclude same-day historical
rows for the rest of that calendar day — the opposite of what seeding is
for. `seedRegistrationsCursor.ts` asserts the MySQL-returned value matches
the correct format and throws rather than silently falling back to
`toISOString()` if it does not. Re-seeding an already-seeded cursor is
refused unless `--force` is passed, naming the existing value, so a
re-run cannot silently skip every guest between the old seed and the new
one.

### The health probe

`VIEW_PROBE_INTERVAL_MS` (default `60000`ms, §3) controls how often
`src/ops/viewHealthProbe.ts`'s `ViewHealthProbe` runs one query against the
VIEW, at startup and on that interval thereafter. It branches on the MySQL
error code:

- **`ER_VIEW_INVALID` or `ER_NO_SUCH_USER`** — the VIEW itself is broken
  (an upstream schema change, or its DEFINER account no longer exists).
  Logs one `error` and dispatches exactly one alert through
  `NOTIFY_WEBHOOK_URL` (§8). The exact alert payload, quoted verbatim from
  `viewHealthProbe.ts`:
  ```json
  { "source": "extension-service", "severity": "error", "message": "...", "timestamp": "2026-08-12T01:00:00.000Z" }
  ```
- **Connection-class codes** (`ECONNREFUSED`, `PROTOCOL_CONNECTION_LOST`,
  `ETIMEDOUT`, `ER_ACCESS_DENIED_ERROR`) **and any unrecognised code** —
  logged as a `warn`, zero alerts dispatched. A transient outage must
  never page anyone (Phase 1 D-05's lineage) — a page firing on an unknown
  code would train the operator to ignore alerts.
- **A healthy cycle logs nothing.** Silence is the expected steady state,
  not a gap in observability.

`start()` returns synchronously and the first cycle is never awaited, so a
broken VIEW can never block `app.listen()`'s callback or terminate the
process (D-09) — this deliberately departs from `config.ts`'s production
fail-fast pattern, and the departure is the decision: refusing to start
would convert an ingestion outage into a total outage for the queue,
booth, display and every guest notification already in flight.

**State this explicitly to whoever is on call: the probe detects schema
breakage, not business-logic regressions upstream.** A change to how
`ets_web` cancels a ticket, or to which rows get an
`event_manager_attendance` row, would pass this probe cleanly — the query
still runs, still returns rows — and still be wrong. See "A VALID ticket
with zero attendance rows" below for the concrete shape of that failure
mode.

### The tie detector

The same probe query, `SELECT COUNT(*) AS total, COUNT(DISTINCT
registered_at) AS distinct_registered_at FROM registrations`, does double
duty: it also makes the `ordering` backstop observable.
`total != distinct_registered_at` means two or more registrations share
the exact same `registered_at` value. Because `dbPoller.ts`'s cursor
advances to the **last row of the batch** and its filter is a strict `>`,
a `LIMIT` boundary that happens to fall between two rows sharing that
timestamp drops the second one permanently and silently — a guest lost at
a poll-batch boundary. This was a real, measured hazard in the source data
before this phase (two order-level ties, dissolved by D-01's choice of
`event_manager_attendance.created_at` over `ticketing_order.created_at`),
and the live VIEW currently shows `total = distinct = 9`, i.e. zero
residual. If the alert ever fires — it names both numbers in its message —
treat it as: (a) confirm whether `ets_web` gained a new write path that
can produce two attendance rows with the same microsecond timestamp, and
(b) check whether any guest queued around that timestamp was skipped, by
comparing `photobooth.registrations` against `queue_job` for that window.

### The name fallback chain

Five rungs, in order, each a `name_source` value in
`photobooth.registrations_name_audit` (never exposed in the six-column
ingestion VIEW itself, keeping that contract at exactly six columns):

1. `personalinfo_name` — `TRIM(CONCAT(first_name, ' ', last_name))`
2. `personalinfo_display_name` — `account_personalinfo.display_name`
3. `customer_display_name` — `ticketing_customer.display_name`
4. `customer_username` — `ticketing_customer.username`
5. `synthetic` — `Khách • <last 4 of ticket_code>`, the last-resort label
   that never leaves `name` empty

Every fall-through past rung 1 emits exactly one `warn`, once per guest,
restart-safe (persisted via `LocalStore.setCursor('name_audit', ...)`).
Quoted verbatim from `viewHealthProbe.ts`:

```
Guest name for ticket <code> came from <rung>, not first_name/last_name
```

This warn arrives **within one `VIEW_PROBE_INTERVAL_MS` of the guest
registering, not at the instant of ingest** — the audit runs on the
probe's own cadence, a deliberate design forced by `dbPoller.ts` being
closed to edits (D-02), not a delay anyone chose for its own sake.

**Operational note:** a guest showing on the room's display as `Khách •
<last 4>` means the landing page did not capture a name for that
registration — every other rung produces *some* real value from
`ets_web`, so reaching the synthetic label specifically means none of
rungs 1-4 resolved anything at all.

### A VALID ticket with zero attendance rows

RESEARCH's Pitfall 3, carried forward as an operational note rather than a
code path this service can defend against: an upstream `ets_web` flow can
commit `ticket.status = 'valid'` and then fail, for whatever reason, to
create the corresponding `event_manager_attendance` row. Because the VIEW
reaches every row through an `INNER JOIN` on that attendance table, such a
ticket **never appears in `photobooth.registrations` at all** — not as an
error, not as a warn, not as anything the health probe can see, because
there is no broken row to detect; there is simply no row. If a guest
reports that they registered and were never called, check this case
*before* assuming an ingestion bug on this side: the VIEW cannot see a row
that does not exist, and nothing in this service can compensate for a gap
upstream that produces no signal of any kind.

### Rate limiting `/status/:jobId`

Three keys, all optional with site-independent defaults, none in the §3
fail-fast table (§3):

| Key | Default | Meaning |
|---|---|---|
| `STATUS_RATE_LIMIT_WINDOW_MS` | `60000` | The fixed window a client address's request count is measured within. |
| `STATUS_RATE_LIMIT_MAX` | `30` | Requests allowed per address per window before the next one is refused. |
| `STATUS_RATE_LIMIT_MAX_KEYS` | `10000` | Cap on distinct tracked client addresses — bounds memory under an attacker rotating source addresses. |

The (max+1)th request in a window gets `429` with exactly this body,
quoted verbatim from `rateLimiter.ts`'s `RATE_LIMITED_BODY`:

```json
{ "error": "too many requests" }
```

One key, deliberately — no `reason`, `code`, `hint`, or `retryAfter`
field, and no `Retry-After` header. This is not an oversight: the
throttled response for a real job id and for a fabricated one must be
byte-identical, or the extra field itself becomes a signal that
distinguishes them, defeating the point of the limiter.

### Accepted risks

In the same register §9's "Accepted risks" uses — stated plainly, never
left silent.

**The 40-bit capability id.** `registrations.id` is `ticketing_ticket.
ticket_code`, minted by `ets_web`'s `short_code.py` with `secrets.choice`
(a CSPRNG) over an 8-character Crockford base32 alphabet — 40 bits of
entropy, well below the ≥128-bit guidance for a capability URL. A
successful guess yields a guest's **name and queue position** — the
`GuestStatusResponse` body — never a photo and never contact details. The
rate limiter above turns brute-forcing this from one source address into
roughly 2^40 / 30 minutes (~24,500 years) of guessing; see below for what
it does not stop.

**Distributed enumeration.** A per-address limiter cannot stop an attacker
spreading guesses across many source addresses. Closing this would need a
wider id — an `ets_web` code change, which the human has forbidden
absolutely for this project. Accepted as a residual risk, not solved.

**The alert shares `NOTIFY_WEBHOOK_URL` with the guest-photo receiver.**
The health probe's alert (above) and §8's guest notification both POST to
the same configured URL. `web-slide`'s receiver performs no schema
validation and reads specific field names (`guestName`, `photoUrl`, ...) —
none of which the alert payload's `{source, severity, message, timestamp}`
shape contains — so a misrouted or misconfigured receiver could silently
absorb an alert (answering `200` with nothing rendered) rather than
surfacing it as a delivery failure. No dedicated alert channel exists as
of this phase.

**The unwatched `ets_web` schema contract.** Restated from "The standing
cost" above because it belongs in this list too: nobody upstream is aware
this VIEW exists or depends on their table/column names. This is the
single largest standing risk this phase introduces, and the health probe
is only a detector for the "broken loudly" half of it — not the "broken
quietly" half described in "A VALID ticket with zero attendance rows."

### Standing operator action required — a live test registration in the queue

**`3X818VEJ` (guest name "Phase6 Cutover") is sitting in the booth queue
right now (`queue_job.status = 'queued'`, `retries = 0`) and cannot be
cancelled upstream.** It was created deliberately, with a clearly-marked
synthetic identity (`phase6-cutover-20260812@example.com`, an RFC 2606
reserved domain; phone `0000000006`), to perform this phase's D-07 proof —
see "Known gaps" below for what that proof did and did not cover. Research
established that `ets_web`'s `cancel_order()` requires the order to be
`PENDING` (`ticketing/models.py:155-259`, `admin.py:794-836`); this order
is `completed` and the ticket is `valid` and attended, so there is **no
application path on the `ets_web` side to cancel it.**

**Before a real event, and before an Agent is ever connected against this
VIEW, an operator must mark this specific job `failed` by hand** using
§6's documented mechanism ("Marking a job as 'do not re-dispatch'"):

```bash
sqlite3 ./data/extension-service.sqlite \
  "UPDATE queue_job SET status = 'failed', stall_reason = 'manual_operator_stop' WHERE id = '3X818VEJ';"
```

**Take a backup first**, per §6's own instruction. If this is skipped, the
first time an Agent connects and the booth goes live, this test guest will
be dispatched for a real photo session with nobody present to run it.

**This action is also a prerequisite of Phase 7's live booth gate**, which
exercises a retake end to end with a second guest genuinely queued. That
gate connects an Agent against a live booth, which is exactly the condition
under which this queued job gets dispatched — so it must be marked `failed`
**before** any Agent connects, not afterwards. The gate's other prerequisite
is the Phase 3 Agent-auth cutover (§7), deployed server and Agent together,
both-or-neither.

### Known gaps, honestly, as of this writing

- **Production readiness fails today.** `WEBHOOK_HMAC_SECRET`,
  `PROXY_IP_WHITELIST` and `DISPLAY_IP_WHITELIST` are all unset in the
  live `.env` — §4's readiness check exits non-zero. The service has been
  run, each time this phase needed live verification, in non-production
  mode (`NODE_ENV` unset), not production, and left stopped afterward. Set
  all three real values before any production deploy; §3/§4 above already
  document the mechanism.
- **The Phase 3 Agent-auth cutover (§7) has never been deployed.** No
  Agent has ever connected against this live VIEW. D-07's proof (plan
  06-06) confirmed the landing page → `ets_web` → VIEW → poller → **queue**
  leg end to end, live, with a real registration (`3X818VEJ`) reaching the
  queue under the guest's own captured name and the top rung of D-04's
  fallback chain (`personalinfo_name`) — see plan 06-06's SUMMARY for the
  full hop-by-hop record. The **queue → Agent → booth → slideshow** legs
  remain unproven: the log line `Skipping dispatch: Agent not connected
  (job 3X818VEJ stays queued)` fired exactly as §7 documents, and the job
  stayed queued at zero cost to it (`retries = 0`). This is a prerequisite
  gap, not a defect this phase introduced — those legs were already
  verified independently in Phases 2-4 against a connected Agent; they
  have simply never been exercised together with this phase's live VIEW.

## 11. Changing the log level without a redeploy (SC-5)

`LOG_LEVEL` (§3) governs the process-wide sink threshold for every log line
this service writes — `src/logging/logger.ts`'s single winston `Logger`
instance and every `labelLogger()` child created from it. Before this
section's mechanism, the only way to change it was to edit `.env` and
restart the process, losing whatever in-flight state a restart discards.
As of this phase, the running process can be raised or lowered **in
place**, without a restart and without a redeploy.

**This adds no new configuration key (D-12).** The mechanism reuses the
existing `LOG_LEVEL` key exactly as `config.ts` already reads it at
startup — see `07-02-PLAN.md`'s `<d12_reconciliation>` for the full
reasoning. It also does not change what gets logged: the AGT-04 event
lines are separately made unconditional `info` calls (plan 07-05); this
section's SIGHUP reload only changes the threshold those lines are
filtered against, exactly as setting `LOG_LEVEL=warn` at startup already
does today.

### How to change it

1. Edit `LOG_LEVEL` in the deployed `.env` file (accepted values below).
2. Send `SIGHUP` to the running process:
   - **PM2:** `pm2 sendSignal SIGHUP <app-name>`
   - **Raw process:** `kill -HUP <pid>`
   - **Docker:** `docker kill --signal=HUP <container>`
3. Watch the log for the confirmation line (see below). No restart, no
   redeploy, no dropped connections.

### Accepted values

The seven winston npm levels, from least to most verbose:
`error`, `warn`, `info`, `http`, `verbose`, `debug`, `silly` — the same
`LOG_LEVELS` array `src/logging/logger.ts` exports and validates against.

### What happens on an invalid or missing value

An invalid value (a typo, an empty string, anything not in the list
above) is rejected: the running level is left exactly as it was, and
exactly one `warn` names the rejected value and the accepted vocabulary.
The reload never throws and never terminates the process (T-07-09) — a
malformed `.env` can only fail to change the level, never crash the
service.

### The confirmation line, and its one caveat

Every `SIGHUP` reload — successful, unchanged, or rejected — writes exactly
one confirmation line, at `warn`, quoted verbatim from
`src/ops/logLevelControl.ts`:

```
Log level reload (SIGHUP): <previous> -> <current>
```

**Deliberately written at `warn`, not `info`:** the confirmation must stay
visible even when the operator has already pinned the process above
`info`. The one caveat this does not solve: pinning the level above `warn`
(i.e. to `error`) silences this confirmation line **itself**, along with
everything else at `warn` and below — that is standard logging semantics
(a raised threshold silences its own announcement), not a bug in the
handler. If you cannot see the confirmation after sending `SIGHUP`, check
what the level actually is now (§6's read-only inspection pattern applies
equally here, or simply `SIGHUP` again while watching at `debug`).

### In-memory only

The change made by a `SIGHUP` reload lives only in the running process's
memory. It is **not** written back to `.env`. A process restart (whether
from a crash, a deploy, or an intentional restart) returns to whatever
`.env` holds at that moment — if you want a level change to survive a
restart, edit `.env` and leave it edited; the `SIGHUP` reload is for
observing the process **right now**, not for a permanent configuration
change.

### Why SIGHUP, not SIGUSR2

`SIGUSR2` is claimed by common Node deployment tooling — PM2 uses it for
log-file reopening, nodemon uses it for restart-on-signal — so binding the
level reload to it would collide with the deployment's own signal use.
`SIGHUP` was otherwise unused by this service and, left unhandled, would
have terminated the process by default; registering a handler for it
(`src/index.ts`, at startup) converts that default into the safe, in-place
reload documented above.

See §3's environment-variable table for `LOG_LEVEL`'s own row (the default
it starts at, `info`, is unchanged by this section).
