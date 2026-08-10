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

### Transition table

| From | To | Trigger | What happens to the job |
|---|---|---|---|
| IDLE | ANNOUNCING | The 250 ms tick finds a queued job and the booth is idle | The job stays `queued`; its guest name and countdown are broadcast to the display feed |
| ANNOUNCING | BUSY | The countdown (`NEXT_GUEST_COUNTDOWN_MS`) elapses | The job is marked `dispatched`, `dispatched_at` is stamped, and the dispatch command is sent to the Agent |
| BUSY | IDLE | The Agent reports `session_end` | The in-progress job is marked `completed`, `session_ended_at`/`completed_at` are stamped, and the tick immediately looks for the next guest |
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
