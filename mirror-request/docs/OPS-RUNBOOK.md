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

## 8. Guest notification delivery

This is the third published contract this service owns, alongside §1's
webhook signing contract and §7's Agent auth contract — the last leg of the
guest's journey: when a photo finishes processing, this service tells the
slideshow so the guest sees their own picture appear on screen.

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
