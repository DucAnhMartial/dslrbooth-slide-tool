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
| `CMS_IP_WHITELIST` | Must be set to the real operator-laptop address(es), comma-separated. Added in Phase 8 (see §12). **It is NOT `DISPLAY_IP_WHITELIST`** — see the warning below the table. Empty is rejected outright, same as the display list. | Startup throws: `CMS_IP_WHITELIST must be configured in production with the real operator-laptop addresses (D-13) — it is NOT DISPLAY_IP_WHITELIST` |
| `CMS_USERNAME` | Must be set and must not still read `replace-with-cms-username`. Required in **every** environment, not only production — the CMS has exactly one account (D-14) and there is no fallback login. | Startup throws: `CMS_USERNAME must be configured (not placeholder)` |
| `CMS_PASSWORD_HASH` | Must be set to a salted scrypt digest in `salt:hash` hex form and must not still read `replace-with-cms-password-hash`. Required in every environment. **Never a plaintext password** — mint it with `npm run cms:hash-password` and type the password at the prompt (§12). Passing it as an argument is refused. | Startup throws: `CMS_PASSWORD_HASH must be configured (not placeholder)` |

⚠ **`CMS_IP_WHITELIST` and `DISPLAY_IP_WHITELIST` must not be set to the same
value.** They describe two different audiences on two different network paths:
`DISPLAY_IP_WHITELIST` holds the room's TVs, `CMS_IP_WHITELIST` holds the
operator's laptop. Copying one into the other fails in one of two directions
and both are bad — either the operator is locked out of the console mid-event,
or the console becomes reachable from every address that can reach a TV, which
is the whole of D-13's network layer given away in one paste. The service
cannot detect this for you: two identical lists are a legal configuration.

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

CMS variables added in Phase 8 that are optional and have working defaults
(the two that are **not** optional, `CMS_USERNAME` and `CMS_PASSWORD_HASH`,
are in the fail-fast table above; see §12 for the console these govern):

| Variable | Default | Meaning |
|---|---|---|
| `CMS_SESSION_COOKIE_NAME` | `cms_session` | The name of the operator's session cookie. Override only if it collides with something else served from the same host. The cookie carries `HttpOnly` and `SameSite=Lax` and deliberately **no `Secure` flag** — see §12's security posture, which explains why and what that costs. |
| `CMS_UPLOAD_DIR` | `./data/uploads` | Where uploaded logo/background/QR images are written. Must stay **outside** the code directory (D-15): a written file must never land somewhere the process could later execute or serve as source. The directory is created if missing. Files here are served only through `GET /uploads/:filename`, which types them from their own bytes and can emit only PNG, JPEG, GIF or WebP. |
| `CMS_UPLOAD_MAX_BYTES` | `5242880` (5 MiB) | The cap on one decoded image. Raising it also raises the JSON body limit on `POST /cms/api/assets`, which is derived from this value (`ceil(value × 4/3) + 65536`, for base64 inflation plus envelope) — the global 100 kb body limit stays in force on every other route, including `/on-register`. Lowering it does not shrink files already on disk. |

Login throttle variables, added by the Phase 8 code review (WR-01). All three
are optional with working defaults; **none is in `.env.example`**, so add them
only if you need to change the shipped behaviour:

| Variable | Default | Meaning |
|---|---|---|
| `CMS_LOGIN_RATE_LIMIT_WINDOW_MS` | `900000` (15 min) | The fixed window a login budget is counted in, per source address. |
| `CMS_LOGIN_RATE_LIMIT_MAX` | `10` | Attempts allowed per window per address, counting successes as well as failures. The eleventh gets `429` and the shipped Vietnamese "wait a few minutes" page, **without the password being examined at all** — so the refusal cannot differ between a right guess and a wrong one. An operator who has fumbled ten times in a quarter hour will not succeed on the eleventh, and the wait is short enough to sit out. |
| `CMS_LOGIN_RATE_LIMIT_MAX_KEYS` | `1000` | Upper bound on distinct addresses tracked at once — bounds memory if someone rotates source addresses. |

**Why this exists even though the CMS is already IP-gated:** a
`CMS_IP_WHITELIST` entry is very often a whole venue subnet (`10.0.0.*`), and
inside one an attacker previously had unlimited online guesses against a single
scrypt hash. If you see repeated `CMS login throttled for <ip>` warnings,
that is this control working — check §5's log vocabulary and find out whose
device that address is.

Session lifecycle variables added in Phase 7 (optional, working default —
see §5 for the two anchors this governs):

| Variable | Default | Meaning |
|---|---|---|
| `BOOTH_RELEASE_TIMEOUT_MS` | `120000` (2 min) | **Vestigial as of Phase 11 (§14) — read into config, clamped, and stored, but no timer is ever started from it any more.** Before Phase 11 it was the release-fallback deadline for a job that had already completed at the print composite. Phase 11's D11-05 finalize gate retired the whole release-fallback timer, its field, and every call site — a job now leaves the booth held (never completed-but-still-bound) between its print composite and its own approval, so there is no "completed but session_end never arrived" state left for this timer to bound. What actually bounds an unapproved attempt now is `RETAKE_GRACE_MS` (below); a session that never even acknowledges (no `session_start` at all) is still bounded by `SESSION_TIMEOUT_MS` (§6), unchanged. Setting this variable in `.env` does nothing functional today — it is accepted for backward compatibility with existing deployments' `.env` files, not because anything reads it for a decision. |

Retake/approval variable added in Phase 11 (optional, working default — see
§14 for the attempt model and the three approval doors this governs):

| Variable | Default | Meaning |
|---|---|---|
| `RETAKE_GRACE_MS` | `20000` (20 s) | How long the booth stays held — bound, `booth_state.attempt_open = 0` — after an **unapproved** attempt's `session_end`, before the grace door (§14) finalizes it with `approved_by=grace`. Sized against the largest measured retake gap on the real booth, 12.3 s (`07-EVIDENCE-dslrbooth-triggers.md` §D) — 20000 is 1.6× that. Deliberately a real `.env` key, unlike the two Phase 7 module constants below (D11-06): the operator may need to shorten it at a live event. **Read once at process startup — lowering it during an event needs a process restart, not a rebuild** (`pm2 delete` + `start`, §5's pm2-env trap applies here too). `pm2 restart` alone does **not** pick up a new value, and neither does the `SIGHUP` log-level reload (§11) — that signal reloads `LOG_LEVEL` only, nothing else. What you are trading by shortening it: the window is what stops the next guest being called while the current guest is still deciding whether to retake; shortening it shortens exactly that protection. |

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

### The booth still has exactly these three states (Phase 11)

Phase 11 added a retake/approval model (§14) that could easily have needed
a fourth state — "waiting to see if the guest retakes" looks like it wants
its own name. It does not have one, on purpose. The attempt is a flag on
the **same row** — `booth_state.attempt_open` (0/1) and `attempt_no`
(an integer, reset to 0 on every release) — not a new `BoothState` value.
Every existing consumer of `booth_state.state` (the `!== 'BUSY'` disconnect
guard in §7, the in-flight count `/health` reports, the display feed's
broadcast) keeps working unmodified, because from their point of view the
booth is still just `BUSY`.

**The grace window (§14) is BUSY with a job bound and no attempt open** —
`booth_state.state = 'BUSY'`, `current_job_id` still set, `attempt_open = 0`.
There is no separate "GRACE" value to look for in the database; read
`attempt_open` alongside `state` if you need to tell "a guest is actively
being photographed" from "a guest just left the sharing screen unapproved
and the grace timer is running" — both are `BUSY` at the `booth_state.state`
column alone.

### Completion and release are two separate anchors (Phase 7, superseded by Phase 11 — see §14)

**Before Phase 7 there was one anchor: `session_end` both completed the job
and released the booth. That was wrong, and it is the defect Phase 7 fixed.**
Phase 11 (§14) then split "has a composite" from "guest approved it," because
retake proved a composite can be a rejected attempt. What is still true from
Phase 7: completion and release are not the same moment, and an operator
diagnosing a session has to know which one they are looking at.

- **A composite existing is no longer the same thing as completion.**
  `processing_start` opens (or, on a retake, overwrites) a pending-print slot
  for the current attempt — it never marks the job `completed` and never
  starts any timer. The composite path is read by a scan-and-fallback rule
  (the last parameter pointing into `\Prints\`, or else the highest-indexed
  non-empty parameter) rather than a hardcoded position — Phase 7's
  `param5`-only extraction broke on the measured 1-shot layout and is gone.
- **Completion (approval) happens at a valid `printing`, or at one of the two
  other finalize doors.** `printing` is only treated as the guest's approval
  when the attempt it belongs to is still open AND its composite matches (by
  filename **stem**, not exact string — see §14's D11-03 note) the composite
  that attempt's own `processing_start` recorded. A `printing` that fails
  either check is refused and logged, never treated as completion (§14).
- **Release now happens in the same act as completion**, through the one
  finalize gate `finalizePendingPrint()` (§14) — not at a following
  `session_end`. Before that finalize gate runs, an unapproved attempt's
  `session_end` does **not** release the booth; it opens `RETAKE_GRACE_MS`
  (§3) instead, so the next guest is not called up while this guest might
  still be about to retake. The old `BOOTH_RELEASE_TIMEOUT_MS` release
  fallback (waiting for a `session_end` after an already-completed job) no
  longer has anything to wait for and was retired — see §3's note on that
  variable.

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

### The session summary line — one grep per session (Phase 7, D-14; extended Phase 11, D11-09)

Every job that closes writes exactly one line, at `info`, with a fixed
leading token and a stable `key=value` field order. Phase 11 (D11-09) added
two fields, `attempts=` and `approved_by=`, **appended at the end** — every
field that existed before Phase 11 keeps its exact name and position, so an
existing grep for any of the first four fields keeps working unchanged. The
shipped line, quoted verbatim from `src/queue/queueService.ts`:

```
SESSION_SUMMARY job=<jobId> outcome=<completed|no_photo> captures=<n|unknown> print_composite=<yes|no> duration_ms=<n|unknown> attempts=<n|unknown> approved_by=<printing|grace|operator|none>
```

To read a whole session, grep the job id and take this line — you do not
need to reconstruct the session from the per-event lines:

```bash
grep "SESSION_SUMMARY job=<jobId>" logs/extension-service-*.log
```

| Field | What it tells you |
|---|---|
| `outcome` | `completed` — a print composite was seen AND approved through one of the three doors (§14), and the job closed normally. `no_photo` — the session finalized with no photo URL ever approved (§6). |
| `captures` | How many `capture_start` events the session produced across **every attempt**, including retakes. `unknown` means no counter entry existed — the count is held in memory only, so a service restart mid-session degrades it to `unknown` rather than to a wrong `0`. |
| `print_composite` | Whether a composite was actually seen (on any attempt), regardless of whether it was ever approved. |
| `duration_ms` | Now minus `acknowledged_at`; `unknown` if the job never recorded one. Spans the whole job, including every retake — not just the final attempt. |
| `attempts` | **New in Phase 11.** How many attempts (`session_start`s that opened a slot) this job went through — `1` for an ordinary session, `2` or more for a retake. `unknown` mirrors `captures`' own in-memory-counter caveat. |
| `approved_by` | **New in Phase 11.** Which of the three finalize doors (§14) closed this job: `printing` — the guest pressed print and it matched their open attempt (the ordinary path, 0s wait); `grace` — `RETAKE_GRACE_MS` (§3) expired with no retake; `operator` — the CMS "end this guest" control (§14) was pressed; `none` — the job closed through the 15-minute no-photo sweep (§6) without ever reaching the finalize gate at all (an attempt was never opened, so there was no door to approve through). |

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
| BUSY | BUSY (unchanged) | `processing_start` reports a print composite (any attempt, including a retake's second one) | **D11-02/D11-07: opens or overwrites the pending-print slot** for the CURRENT attempt with that composite's path (the last one written always wins). Nothing is completed and no timer starts. The composite path is read by a scan-and-fallback rule, not a hardcoded `param5` — see §14 |
| BUSY | BUSY (unchanged) | `printing` arrives with no attempt open, or with a composite that does not match (by stem) the open attempt's own `processing_start` composite | **Refused, not completion (D11-03, §14).** Logged at `info`: `printing ignored: no attempt open` / `printing ignored: composite … is not this attempt's …`. Nothing about the job changes |
| BUSY | IDLE | `printing`'s composite DOES match the open attempt (D11-03) | **Door 1 of finalize (§14, D11-05): `approved_by=printing`, 0 s wait.** The single finalize gate completes the job with the held photo URL (or closes it `no_photo` if none was ever written), sends the guest's notification, writes photo history, writes the summary line, and releases the booth — all in the same act |
| BUSY | BUSY (attempt closed, grace running) | The Agent reports `session_end` for an attempt that has **not yet been approved** | **Opens `RETAKE_GRACE_MS` instead of releasing (§14, D11-06).** `booth_state.attempt_open` is cleared, but `current_job_id` stays bound — the booth remains BUSY and the next guest is **not** called |
| BUSY (mid-grace) | BUSY (new attempt) | A new `session_start` arrives while `RETAKE_GRACE_MS` is still running | **A retake (§14, D11-01/D11-06).** The grace timer is cancelled, a new attempt opens (`attempt_no` increments), the job stays bound to the same booth — no new guest is called and the guest keeps their place |
| BUSY (mid-grace) | IDLE | `RETAKE_GRACE_MS` expires with no new `session_start` | **Door 2 of finalize (§14, D11-05): `approved_by=grace`.** Same finalize gate as door 1, called with whichever photo URL was last held (or `no_photo` if none) |
| BUSY | IDLE | The operator presses "Kết thúc khách này" on the CMS booth page (`POST /cms/api/booth/release`, §14) | **Door 3 of finalize (§14, D11-05/D11-08): `approved_by=operator`.** Same gate as doors 1/2, immediately, without waiting for grace. Refused with no mutation if the job id no longer owns the booth, or if it already finalized through another door in the gap between page render and click |
| BUSY | IDLE (no-op) | The Agent reports `session_end` for a job already finalized (through any of the three doors above) | **Nothing to do — the finalize gate already released the booth in the same act as approval.** This `session_end`, or any later stray one, finds no job bound and is ignored, same as Phase 7's stray-duplicate case below |
| BUSY | BUSY (timer re-armed) | The Agent acknowledges the session (`session_start` or a positive ack), not during a grace window | The job is marked `in_progress`, `acknowledged_at` is stamped, and the busy timer restarts for a full `SESSION_TIMEOUT_MS` |
| BUSY | IDLE | The Agent rejects the session (a negative ack / NAK) | The job is requeued under the bounded retry policy (`stall_reason = 'agent_nak'`, see §6) or failed if retries are exhausted, and the tick immediately looks for the next guest |
| BUSY | IDLE | The busy timer fires — no acknowledgement or `session_end` arrived within `SESSION_TIMEOUT_MS` (an attempt never even opened) | The job is requeued under the bounded retry policy (`stall_reason = 'session_ack_timeout'`, see §6) or failed if retries are exhausted, and the tick immediately looks for the next guest |
| ANNOUNCING (at startup) | IDLE | The service starts and finds the booth left `ANNOUNCING` from before a restart | The job is left untouched (still `queued`) — the countdown is only 5-10 s, so it is simply re-announced by the next tick rather than resumed |
| BUSY (at startup, session stale) | IDLE | The service starts and finds the booth `BUSY`, but `now - booth_state.updated_at` is at or past `SESSION_TIMEOUT_MS` (or the timestamp cannot be parsed) | Every in-flight (`dispatched`/`in_progress`) job is swept through the bounded retry policy (`stall_reason = 'restart_recovery_timeout'`, see §6) |
| BUSY (at startup, mid-grace) | IDLE | The service starts and finds the booth `BUSY` with `attempt_open = 0` — it was mid-grace when the process stopped | **Finalizes immediately through the grace door (§14, `approved_by=grace`), rather than resuming the remaining countdown.** The remaining grace window is not reconstructed after a restart — a deliberate, working simplicity assumption, not yet re-measured against a live restart-mid-grace |
| BUSY (at startup, session possibly live) | BUSY (timer re-armed) | The service starts and finds the booth `BUSY` with `attempt_open = 1` and `now - booth_state.updated_at` under `SESSION_TIMEOUT_MS`, and at least one in-flight job | The booth stays `BUSY`; the most recently dispatched job is treated as the survivor and its timer is re-armed for only the *remaining* time (`SESSION_TIMEOUT_MS` minus the elapsed age) — never a fresh full timeout. Any other in-flight job found at the same time is swept through the retry policy as an orphan from an earlier incident |

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
Paths that deliberately write no `stall_reason` at all do so because neither
is a stall and `stall_reason` is a closed, server-authored vocabulary that
must not gain a value for them: the `no_photo` close below, and — since
Phase 11 — every job finalized through any of the three approval doors
(§14: `printing`, `grace`, `operator`), which is now the ordinary case for
every completed session, not an edge case. (Phase 7's own
`BOOTH_RELEASE_TIMEOUT_MS` release fallback, previously the third
no-`stall_reason` path, was retired in Phase 11 along with the release
timer it belonged to — see §3's note on that variable.) If you find a
terminal job with no reason recorded, read its status and its
`SESSION_SUMMARY` line (§5) rather than treating the empty field as missing
data.

**Phase 11's `approved_by` (§14) is a `pending_print` column, not a
`stall_reason` value, and the two vocabularies are never mixed.** A job's
approval door lives on `pending_print.approved_by` and is read out through
the `SESSION_SUMMARY` line (§5); `queue_job.stall_reason` stays exactly the
three-value closed vocabulary in the table above. An empty `stall_reason` on
a terminal job gained no new meaning from this phase — it is still simply
"not a stall," whether the job finalized through a door or closed
`no_photo`.

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
slot is opened for the job at `processing_start` — the moment a composite
exists, before either the upload or the guest's own approval — so the
record of who is owed the photo survives the booth moving on.

**Phase 11 (§14) changed WHEN delivery fires again, on top of this.** The
table below still describes the registry-slot mechanics accurately, but
"delivered" in the `awaiting` row no longer means "at upload time" — since
Phase 11, `file_upload` only WRITES the URL into the slot; sending happens
only when one of the three finalize doors (§14) approves that attempt.
The one exception is the `expired` row below, which — like before Phase 11
— still delivers directly at upload time, because by the time an `expired`
upload arrives the job has usually already finalized through one of the
three doors with no URL, and this is Phase 7's D-11 late-arrival guarantee
surviving that move (§14 covers the exact wording of that log line).

| Registry state | What happens | What you see in the log |
|---|---|---|
| `awaiting` — a slot is open | The URL is written into the slot; nothing is sent yet. Delivery happens later, when a finalize door (§14) approves this attempt — see §14 for the full attempt-and-approval model. | Nothing unusual |
| `expired` — the slot's deadline passed before the upload arrived | **The photo is still delivered, directly, the moment the late upload arrives** — by then the job has normally already finalized (through grace or operator) with no URL held. Getting it late beats not getting it. The job's own status is deliberately left untouched. | A `warn` naming the job and how late it was. **A recurring one means `PENDING_PRINT_EXPIRY_MS` (§3) is set too tight** |
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

**Since Phase 11 (§14), `sendPhotoLink()` is called from the finalize gate**
— whichever of the three approval doors (`printing`, `grace`, `operator`)
closes the job — not from `file_upload` itself; `file_upload` only writes
the photo URL into the pending-print slot (see the table above), except for
the D-11 late-arrival case, which still delivers directly. Wherever it is
called from, `sendPhotoLink()` writes a
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

## 12. The CMS operator console, and the `web-slide` cutover (Phase 8)

Phase 8 did two things that change what an operator does day to day. It added
an operator console at `/cms` — a single-account, IP-gated web UI for event
branding, photo history and the booth Agent's four safe settings. And it moved
the room screen **into this service**, at `GET /display-screen`, so that
`web-slide` is retired (D-05).

This section covers running the console, performing that cutover, and reading
the log lines both produce.

### What moved, and what did not

**The room screen moved.** It is now a route on this service, fed by the same
`WS /display` feed §9 already documents, themed by whichever event is active.
One process, one deploy, one log, one database holding config, photos and the
queue — no second source of truth to drift.

**`NOTIFY_WEBHOOK_URL` did not move, and was not removed** (D-04). It still
does exactly what §8 says it does: it delivers the guest their own photo, and
it remains available for third-party integration. What changed is that it no
longer feeds the room screen — that used to be the same channel doing both
jobs, and it is now two. If you are reading §8 and this section together: §8 is
still correct and still current. Turning `NOTIFY_WEBHOOK_URL` off to "stop
feeding the screen" would break NOT-01/NOT-02 and stop guests receiving their
photos, while changing nothing about the screen.

**The queue and the booth state machine did not move and were not touched.**
Phase 8 is additive to Phases 1-7 by decision (D-01), and that is measured
rather than asserted: `test/phase8-cutover-readiness.test.ts` reads the
`queue_job` and `booth_state` definitions back out of SQLite and compares them
character for character with their pre-Phase-8 form. §5 and §6 are unchanged.

### Logging in

The console is at `http://<server>:<PORT>/cms` — the same `PORT` this service
already serves on (§3, default `3002`), not a second port and not a second
process.

Two independent layers stand in front of it (D-13), in this order:

1. **The IP allow-list.** `CMS_IP_WHITELIST` (§3) is checked first, before any
   session logic runs at all. A non-allow-listed address gets the same generic
   `{"error":"Forbidden"}` 403 that every other refused surface in this service
   returns — no login form, no hint that a CMS exists here.
2. **The password.** One account: `CMS_USERNAME` and `CMS_PASSWORD_HASH` (§3).
   There is no user table, no account CRUD, no password-reset flow and **no
   automatic inactivity timeout** — being logged out mid-event is worse than a
   lingering session (D-14). Log out with the button; that is the only thing
   that ends a session, other than restarting the service.

A wrong password and an unknown username produce byte-identical responses, on
purpose: the console never tells a caller whether an account name was right.

**If you cannot log in, check the IP layer first.** A 403 is the network layer
refusing you and your password is irrelevant to it; a 401 with the Vietnamese
error copy means you reached the login and the credentials did not match.

### Rotating the CMS password

The service is never given a plaintext password. Mint the digest **offline, on
your own machine**, and paste the result into `.env`:

```bash
cd mirror-request && npm run cms:hash-password
```

It prompts for the password and **does not echo it while you type**. For a
scripted install, pipe it instead:

```bash
printf '%s\n' "$PASSWORD" | npm run cms:hash-password
```

**Passing the password as an argument is refused, on purpose** (Phase 8 code
review, WR-04). The old `-- 'the-password'` form put the plaintext in your
shell's history file and made it readable by every other process on the
machine through `ps aux` and `/proc/<pid>/cmdline` for as long as the command
ran. Both are checked more often on a shared machine than "does it touch
disk", which was the only exposure the helper originally reasoned about. If
you run it the old way it prints an explanation and exits non-zero rather than
quietly working — an operator following an older note would otherwise keep the
exposure while believing it fixed.

It prints one line, `CMS_PASSWORD_HASH=<salt>:<hash>`. Replace the value in
`.env` and restart the service.

**Running it twice on the same password prints different output. That is the
fresh 16-byte salt, not an error** — it is what stops two installations that
happen to share a password from sharing a digest. Nothing about this helper
touches the service: it does not import the config, the logger or the app, so
the plaintext never enters a process that has log transports attached.

### Creating and configuring an event

`GET /cms/events` lists the event library; `GET /cms/events/new` creates one.
An event is a saved set of branding: name, logo, background, QR image and CTA
text, five colours, one of three fonts, the idle heading and sub-heading, and
how many photos the slideshow holds and for how long.

Three things are worth knowing before an operator is surprised by them:

- **Every cap and range is enforced on the server, not just in the form.** Name
  60 characters, idle heading 80, idle sub 120, QR CTA 60; photo count 1-50;
  photo duration 2000-30000 ms. An out-of-range number is **refused, never
  silently clamped** — a clamp would leave the form and the wall disagreeing,
  and the operator would find out from the wall.
- **A save with one bad field writes nothing at all.** The whole patch is
  refused rather than partially applied, for the same reason.
- **Colours accept six-digit hex and nothing else.** `red` and `rgb(0,0,0)` are
  valid CSS and are refused anyway — these values are written into CSS custom
  properties on every TV in the room.

Uploads go through `POST /cms/api/assets` (the form does this for you). The
server mints the filename itself and types the file from its own first bytes;
nothing the browser claims about the name or the content type is read. Only
PNG, JPEG, GIF and WebP can be stored or served. An SVG will be refused, and
that is deliberate rather than an oversight.

**The Screen URL is one fixed path for every event.** The event configuration
page shows it as a copyable string; it is `/display-screen`, identical for
every event and every TV. Screens carry no identity (D-12) — activating a
different event in the console is what changes what that one URL renders. If
you ever find yourself editing a URL on a TV to change customer, something has
gone wrong: that is exactly the chore this phase exists to remove.

### Switching the active event while guests are queued (D-02)

Exactly one event is active at a time. Activating a second one **replaces** the
pointer rather than adding to it.

If guests are still queued when you switch, the console refuses the first
attempt with a `409` and tells you how many are waiting, then lets you confirm
and proceed. **This is a warning, not a block, and the distinction is
deliberate.** The refusal is conditional on you not having confirmed — never on
the queue being non-empty. Blocking was considered and rejected on measured
evidence: a real ticket (`3X818VEJ`) sat queued with nobody left to shoot it
and had to be fixed by hand in the database. An operator who genuinely needs to
switch mid-queue must be able to.

The confirmation is checked **on the server**, not in a browser dialog, so a
second tab or a replayed request meets it too.

**What switching does not do:** it does not touch the queue. Queued guests stay
queued, in order, with their retry counts unchanged; the booth state machine is
not consulted and not modified. What changes is the branding on the wall and
which event new photos are recorded against.

### Photo history, and the only way anything is ever deleted (D-11)

`GET /cms/photos` shows the durable per-event photo history — 50 rows a page,
newest first. Rows are written when a print upload resolves (§8's attribution
point, unchanged), and they store the photo's **URL**, not the photo: no second
copy of a real guest's photograph exists on this server to secure or to lose.

A thumbnail whose far side has dropped the file renders a neutral placeholder
tile with a warning icon and a visible label — never the browser's broken-image
glyph, and **the row is never removed**. A far side that deleted a file has not
un-photographed the guest.

**There is no expiry, no row cap and no scheduled cleanup anywhere in this
surface.** Photo history is deleted by exactly one action:
`POST /cms/api/photos/clear`, reached from `GET /cms/photos/clear`, which
requires you to retype **the event's own name** and checks it on the server. A
generic "yes" would confirm that you meant to delete something; the name
confirms you meant to delete *this* one.

Deleting an event (`POST /cms/api/events/:id/delete`, also typed-confirmed)
removes that event's photo history with it, in one transaction.

Those two are the whole deletion story for this service. Nothing else in the
codebase removes an `event_photo` row, and a future change that added a
retention sweep would fail the test suite rather than quietly deleting a
wedding.

### Agent configuration, and one step back (D-16, D-18)

`GET /cms/agent` configures the booth Agent remotely. **Four fields are
editable** — `logLevel`, `autoOpenDisplay`, `dslrBoothApiPort`,
`dslrBoothPassword` — and **four are shown read-only**:
`extensionServiceWsUrl`, `extensionServiceWsToken`, `triggerServerPort` and
`logDir`. The read-only four are not a UI convenience: the server refuses a
save carrying any of them, and the Agent ignores them on receipt. They are the
bootstrap credentials that create the very WebSocket a change would travel
over — a wrong value means the Agent can never reconnect and **someone must
physically go to the booth**. To change one of those four, edit the Agent's own
`.env` on the booth machine and restart it.

Configuration travels by **pull, not push** (D-17). The Agent asks for its
configuration when it connects; when you save in the console the service sends
a bare `reload_config` and the Agent asks again. The Agent applies values in
memory and never rewrites its own `.env`.

**If the Agent is offline when you save, the save still succeeds** and the
console says so. The values are stored here and the Agent will pull them on its
next connect. Nothing is lost and nothing needs re-doing.

**"It broke right after I saved."** That is what the restore button is for.
`POST /cms/api/agent/restore` puts back the configuration that was in place
before your last save, in one step, and sends the Agent a reload. Two things
about it that will otherwise surprise you at 8pm:

- **It is one step back, not an undo history.** Restoring clears the stored
  previous configuration as it applies it. A second press is refused with a
  `409` and the message `Không có cấu hình trước đó để khôi phục.` — it does
  not hand you back the configuration you just rejected. The same button doing
  the opposite thing on a second press, with nothing to indicate it had, was
  the failure this avoids.
- **It restores the Agent's configuration only.** It has nothing to do with
  events, branding or photo history.

### The cutover: retiring `web-slide` (D-05, D-06)

This is a one-way operational change. Read all of it before starting.

**There is no redirect shim and therefore no fast rollback.** A shim was
offered during planning and declined (D-06). Nothing will answer on
`web-slide`'s old port after you stop it, and nothing will forward a TV that is
still pointed there. If the new screen misbehaves after the cutover, the
recovery is the same walk you are about to do, in reverse, TV by TV.

**Do it between events, never during one.** This is the same both-or-neither
honesty §7 applies to the Agent contract: the cost of getting it wrong is paid
in front of guests.

Before you start, note what has already been checked automatically. The
readiness probe proves, against a temporary database, that the room screen
renders on an empty database, that both CMS layers refuse and admit correctly,
that an event's configuration reaches an already-connected screen with no
reload, that an uploaded asset serves with its sniffed type, that a capture
becomes durable history and a hero moment, and that the Agent's configuration
pull answers from the allow-list only:

```bash
cd mirror-request && npx vitest run test/phase8-cutover-readiness.test.ts
```

What it cannot prove is anything physical: whether the screen is legible on a
real TV at real viewing distance, and how `web-slide` is currently kept alive.

**1. Identify how `web-slide` is supervised.** This is the step the repository
cannot answer for you, and it is the one that decides whether the cutover
holds. Neither `web-slide/` nor this repository contains a deployed process
manager configuration — no PM2 ecosystem file, no installed systemd unit, no
compose file. `web-slide/README.md` does carry a **template** systemd unit
(`webhook-slideshow.service`, `WorkingDirectory=/opt/webhook-slideshow`,
`Restart=always`), which is the best lead available and is **not** evidence
that it is what is actually running. Check, in roughly this order:

```bash
systemctl status webhook-slideshow      # the README's template name
pm2 list                                # if pm2 is installed
ss -lntp | grep 3001                    # what is actually holding the port
```

`Restart=always` in that template is the trap: **killing the process without
stopping its supervisor gets you a fresh one within seconds**, still serving
stale content on the old port, and the cutover will look like it worked until
somebody opens the old URL.

**2. Stop it, and stop its supervision.** For systemd that is `stop` **and**
`disable`; for pm2 it is `stop` **and** `delete` plus rewriting the saved
process list. Then confirm the old URL no longer answers at all:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://<server>:3001/   # expect a connection failure, not a page
```

**3. Confirm this service is serving the screen.** From an allow-listed
address, before you touch any TV:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://<server>:<PORT>/display-screen   # expect 200
```

A `403` here means the requesting address is not in `DISPLAY_IP_WHITELIST`
(§3, §9) — fix that before walking anywhere, because every TV will get the same
403.

**4. Re-point each TV.** The same URL for every screen:
`http://<server>:<PORT>/display-screen`. The console shows it as a copyable
string. Confirm each TV renders the idle standby screen before moving to the
next one.

**5. Judge the screen at real viewing distance**, standing where guests stand.
Is the idle heading legible from several metres? Do Vietnamese diacritics
render correctly at hero size? Does "nobody has been photographed yet" clearly
read as a designed state rather than as a broken screen? No automated check
substitutes for this one.

**Ports, for the avoidance of doubt:** `web-slide` served the slideshow on
`3001` and this service serves on `PORT` (§3, default `3002`). They are
different ports on the same host, so both can be running at once during the
cutover — which is exactly why step 2 must actually stop the old one rather
than rely on a port conflict to do it.

**`web-slide`'s source stays in git** (D-08). It is not deleted, its `README.md`
now says it is retired and names the replacement route, and its `index.html`
remains useful as the layout reference the new screen came from. Nothing
deploys it.

### What the operator will see in the logs

Every line below is quoted verbatim from the source as it now stands, and each
was grep-verified against `src/` before this section was written.

**The CMS gate and login:**

| Log line | Level | Meaning |
|---|---|---|
| `Blocked /cms from non-whitelisted IP: <ip>` | warn | Layer one refused an address before any session logic ran. If an operator reports "the console is down", this line with their address is the answer. |
| `Blocked /uploads from non-whitelisted IP: <ip>` | warn | An address outside the **union** of the display and CMS allow-lists asked for an uploaded asset. A TV logging this means its address is in neither list, and its logo and background will not render. |
| `Failed CMS login attempt from <ip>` | warn | Wrong password **or** unknown username — the line does not distinguish them, matching the response, which does not either. |
| `CMS login succeeded from <ip>` | info | A session was issued. |

**Uploads** (all four refusals leave the upload directory untouched):

| Log line | Level | Meaning |
|---|---|---|
| `Refused an oversize CMS asset upload before decoding it` | warn | The encoded body exceeded the bound derived from `CMS_UPLOAD_MAX_BYTES` and was rejected without allocating its decoded form. |
| `Refused a CMS asset upload larger than the configured cap` | warn | The decoded image exceeded `CMS_UPLOAD_MAX_BYTES` (§3). |
| `Refused a CMS asset upload whose content is not one of the four allowed image types` | warn | The bytes are not PNG, JPEG, GIF or WebP. An SVG or an HTML file renamed `.png` lands here — the extension was never consulted. |
| `Failed to store a validated CMS asset upload` | warn | The image passed every check and the write itself failed: a full disk or a bad `CMS_UPLOAD_DIR`. This is the one in this group that is an operator problem rather than a caller problem. |
| `Stored CMS asset <name> (<type>, <n> bytes)` | info | A successful upload. The name is the server-minted one. |
| `Refused upload request for a non-file name: <id>` | warn | A request for a stored asset whose name is not a plain filename. |
| `Refused upload request resolving outside the upload directory: <id>` | warn | A path-traversal-shaped request for a stored asset. |
| `Refused upload request for a non-image payload: <id>` | warn | The file on disk is not one of the four types. Serving re-derives the type from the bytes every time, so a file that changed underneath the service is refused rather than served. |

**Events:**

| Log line | Level | Meaning |
|---|---|---|
| `Created event <id> ("<name>")` | info | A new event was added to the library. |
| `Saved configuration for event <id>` | info | An event's branding was updated. Field values are not logged. |
| `Active-event switch to <id> needs confirmation — <n> guests still waiting` | info | The first, unconfirmed attempt at a mid-queue switch (D-02). Not an error; the operator was asked. |
| `Activated event <id> with <n> guests still waiting` | info | The switch happened. `<n>` is `0` for an ordinary between-events switch, which is what makes a non-zero value worth noticing here. |
| `Deleted event <id> and <n> photo history rows` | info | An event was deleted. When it was the active one, the line continues ` — it was the active event, screens return to the shipped defaults`, which is also the explanation for every TV in the room changing appearance at that moment. |
| `Cleared photo history for event <id> — <n> rows deleted by a confirmed operator action` | info | The **only** operator-invoked deletion of photo history. This is the audit trail for an irreversible act; it deliberately carries no guest name and not even the event's name, which is operator-authored free text that may carry a couple's names. |

**Photo history written from a capture** (both from the queue, both `warn`):

| Log line | Level | Meaning |
|---|---|---|
| `Print upload for <jobId> resolved but no active event — photo not recorded to history` | warn | A real capture completed and the guest was still sent their photo, but no event was active so there was nowhere to file it. **Seeing this during an event means nobody activated one** — the room screen will also be showing shipped defaults rather than the customer's branding. |
| `Print upload for <jobId> could not be recorded to photo history: <reason>` | warn | The history write itself failed — a locked database, a full disk. Delivery to the guest is deliberately **not** on this path and proceeded anyway; history is the less important of the two and fails alone. |

**Agent configuration:**

| Log line | Level | Meaning |
|---|---|---|
| `Refused Agent configuration save carrying non-editable field "<key>"` | warn | A save named one of the four read-only fields. The whole save was refused and the stored row is untouched. From the console's own form this cannot happen; seeing it means something else posted to the endpoint. |
| `Saved Agent configuration (<field names>)` | info | Field **names** only — `dslrBoothPassword`'s value is treated exactly like the Agent bearer token and never appears in a log line. The line continues either ` and asked the Agent to reload` or ` — Agent offline, it will pull on reconnect`. |
| `Restored the previous Agent configuration` | info | D-18's one step back, with the same two continuations as above. |
| `Dropped non-editable field "<key>" from the stored Agent configuration` | warn | A stored row contained a field outside the allow-list and it was projected away before being sent. Names only, never values. |
| `Seeded agent_config with the shipped defaults on first Agent request` | info | The first time an Agent ever asks on a fresh database. Expected exactly once per installation. |
| `Agent WS: config_request received but no configuration source is registered` | warn | An Agent asked and the service had nothing wired to answer with, so it sent nothing rather than sending an empty configuration the Agent would dutifully apply. This is a wiring fault in the service, not a booth fault. |

Note that `Blocked /display-screen from non-whitelisted IP: <ip>` is a Phase 5
line and is documented in §9 with the rest of the display surfaces; it is
listed here only because the room screen now lives on this service and an
operator debugging a blank TV after the cutover will be looking for it.

### Security posture, stated honestly

**No TLS terminates anywhere in this deployment.** Nothing in this service sets
up HTTPS, and the known deployment story is a Node process on a venue LAN. The
consequence is recorded rather than glossed:

- **The session cookie carries `HttpOnly` and `SameSite=Lax` and deliberately
  no `Secure` flag.** Setting `Secure` on a deployment with no TLS would mean
  the browser never sends the cookie back over plain HTTP and the operator can
  never log in — a "secure-by-default" setting that produces a total,
  confusing outage. **If TLS is ever put in front of this service, add the flag
  at that time.** This is a carried-forward follow-up, not a closed question.
- **The residual exposure is real and is bounded, not eliminated.** The cookie
  and everything else on this connection cross the LAN in the clear, readable
  by anything that can passively observe that segment. `CMS_IP_WHITELIST`
  bounds *who can reach the console at all* to a short list of already-trusted
  addresses; it does nothing about observation. The accepted risk is other
  devices already on the trusted LAN segment — not the open internet.

**There is no rate limiting on CMS login, and that is a decision rather than an
omission.** `GET /status/:jobId` is rate-limited (§10) because it is reachable
by guests; the CMS is not reachable at all from an address outside
`CMS_IP_WHITELIST`, so the network layer is doing the work a login limiter
would do. **If that IP layer is ever relaxed — an operator working from a
phone tether, a VPN range added, an "allow everything" list in a hurry — login
rate limiting stops being optional.** Treat widening `CMS_IP_WHITELIST` as the
trigger to revisit this, not as a routine configuration change.

Two things that are *not* accepted risks, recorded so nobody re-derives them as
gaps: the password is stored only as a salted scrypt digest and no plaintext
password key exists anywhere in the configuration, and uploaded assets are
typed from their own bytes with server-minted filenames, so neither the file
name nor the declared content type from a request participates in any code
path.

### Route inventory (Phase 8)

| Route | Gate | Purpose |
|---|---|---|
| `GET /display-screen` | `DISPLAY_IP_WHITELIST` | The room screen. `?view=slides` selects the slides-only variant (§13); any other or missing value renders the default layout. |
| `WS /display` | `DISPLAY_IP_WHITELIST` | The feed that drives it (§9). |
| `GET /assets/fonts/*` | none | The three self-hosted screen fonts. Deliberately ungated: a font carries no event or guest data, and a TV that could not fetch one would render everything in a fallback face. |
| `GET /uploads/:filename` | union of the display and CMS allow-lists | Uploaded branding assets, typed from their bytes. No session — a TV has no session and cannot get one. |
| `GET`/`POST /cms/login`, `POST /cms/logout` | CMS IP allow-list | Session lifecycle. |
| `GET /cms/`, `GET /cms/events`, `GET /cms/events/new`, `GET /cms/events/:id` | IP + session | The event library and its forms. |
| `POST /cms/api/events`, `POST /cms/api/events/:id`, `POST /cms/api/events/:id/activate`, `POST /cms/api/events/:id/delete` | IP + session | Event mutations. Activate and delete are confirmed server-side. |
| `POST /cms/api/assets` | IP + session | Image upload. |
| `GET /cms/agent`, `POST /cms/api/agent`, `POST /cms/api/agent/restore`, `POST /cms/api/agent/test` | IP + session | Agent configuration, one step back, and a liveness read. |
| `GET /cms/photos`, `GET /cms/photos/clear`, `POST /cms/api/photos/clear` | IP + session | Photo history and its one deletion path. |

## 13. The slides-only screen, and the two display toggles (Phase 9)

Phase 9 added a second way to view the room screen and two per-event settings
that change what both views draw. Nothing about how screens are pointed at
this service changed — see §12's "Screen URL is one fixed path for every
event": that is still true, generalized to two fixed paths, one per screen
TYPE.

### The two URLs

| URL | Renders |
|---|---|
| `GET /display-screen` | The default layout — stage, slideshow/hero and the up-next queue sidebar. Unchanged by this phase, byte for byte, and pinned by a regression test. |
| `GET /display-screen?view=slides` | The slides-only layout — the same photo surface at full width, with no queue column and no queue metadata anywhere in the page. |

Both are gated by the same `DISPLAY_IP_WHITELIST` (§3), both are fed by the
same `WS /display` feed (§9), and both always render whichever event is
currently active (D-12 — see §12). There is still no per-screen identity: a
TV is pointed at one of these two URLs by typing it, once, and stays there.
Nothing is registered anywhere, and there is no CMS listing of "screens" —
re-pointing a TV means retyping its URL, and changing what every TV shows is
still a CMS action (activating a different event), exactly as before.

**An unrecognized `?view=` value falls back to the default layout, never an
error.** `?view=queue`, an empty value, wrong case, a trailing space, and a
repeated `?view=` parameter (which Express turns into an array) all render
`GET /display-screen`'s default page. The comparison is strict equality
against the one literal `'slides'`, so nothing about this can be tricked into
serving the wrong page or crashing.

The CMS event page's fixed screen-address card (§12) shows both URLs,
labeled as two types: **"Loại 1 — Thứ tự + slide"** for the default screen and
**"Loại 2 — Chỉ slide"** for the slides-only screen. This is presentation
only — copy the label that matches what you want on a given TV.

### The two toggles

Every event carries two additional settings, both defaulting **ON**, editable
on the same `/cms/events/:id` form every other CMS-01 field lives on:

| Setting | Column | Default | Effect when OFF |
|---|---|---|---|
| Hiển thị tên khách trên ảnh | `show_guest_name` | ON | The guest's name is not drawn on any photo tile, on either screen. |
| Hiệu ứng "ảnh vừa chụp" phóng to | `hero_enabled` | ON | A new capture joins the slideshow rotation directly — no enlarged just-captured takeover — on either screen. The photo itself is never dropped or delayed, only the takeover presentation. |

**Both toggles are event configuration, not view configuration.** They
change what BOTH `/display-screen` and `/display-screen?view=slides` render
for the currently active event — there is no way to turn a toggle on for one
screen type and off for the other, by design (D9-04): a TV showing the
slides-only view and a TV showing the default view are always looking at the
same event's same choices.

A save is applied exactly like every other CMS-01 field: the whole patch is
refused, with the standard save-error copy, if either toggle is not a real
boolean; nothing is written if a save is refused. A saved value reaches every
connected screen on the next `WS /display` snapshot, with no reload.

### What did not change

The queue, the booth state machine, the Agent, and `NOTIFY_WEBHOOK_URL` are
untouched by this phase (same posture as §12's "what moved, and what did
not"). The booth kiosk popup at the Agent is not retired by any code in this
service — it is turned off with the Agent's own `autoOpenDisplay` setting
(`AUTO_OPEN_DISPLAY=false` in the booth `.env`, or live from `/cms/agent`),
because the room screen this section documents already serves the purpose
the popup used to.

## 14. Retake and approval — the attempt model, the three doors, and the new log vocabulary (Phase 11)

Phase 11 answers the question Phase 7 never had to ask: what happens when a
guest presses **Retake** on the sharing screen? Measured on the real booth
(`07-EVIDENCE-dslrbooth-triggers.md` §C/D/E), a retake is a brand-new
dslrBooth session — `session_end` then `session_start` — and every attempt,
including the one the guest rejects, uploads its own composite. Before this
phase the server had no way to tell a rejected attempt from an approved one:
whichever composite arrived first won, the booth released to the next guest
mid-retake, and a guest could receive the photo they had just thrown away.
This section is what an operator needs to diagnose any of that today, and it
assumes nothing from §5's Phase 7 history — read §5 first if a term here
(attempt, finalize gate, grace) looks unfamiliar.

### The attempt model, in one paragraph

A job can now hold **more than one attempt** — one per `session_start` —
and exactly one of them gets approved. `booth_state.attempt_open` (0/1) and
`attempt_no` track whether an attempt is currently open and how many this
job has had; they live on the same row as `current_job_id` and `state`, not
as a new booth state (§5). `processing_start` opens (or, on a retake,
overwrites) a pending-print slot with that attempt's composite path — no
hardcoded parameter position, a scan-and-fallback rule instead (the last
parameter pointing into `\Prints\`, or the highest-indexed non-empty
parameter). `printing` only counts as the guest's approval when the attempt
is still open AND its composite matches, by filename **stem**
(`YYYYMMDD_HHMMSS_mmm`, stripping any trailing `_Nx` copy-count suffix — a
measured `_1x`/`_2x` pair on the same composite is the same photo), the
composite that attempt's own `processing_start` recorded.

### The three doors — where `approved_by` is set

Exactly one of three doors closes a job, and the door is recorded on
`pending_print.approved_by` (never `stall_reason` — §6), then published on
the `SESSION_SUMMARY` line (§5):

| Door | `approved_by` | Fires when | Wait |
|---|---|---|---|
| Printing | `printing` | A `printing` event matches the open attempt (above) | 0 s — the ordinary path |
| Grace | `grace` | `RETAKE_GRACE_MS` (§3) expires after an unapproved attempt's `session_end` with no new `session_start` | Up to `RETAKE_GRACE_MS` |
| Operator | `operator` | The operator presses "Kết thúc khách này" on the CMS booth page (below) | However long the operator takes |

All three reach the same single idempotent gate
(`finalizePendingPrint(jobId, door)`), which is the only place a guest's
photo is ever sent: it completes the job with whatever URL the slot holds
(or closes it `no_photo` if none was ever written), sends the notification,
writes photo history, writes the `SESSION_SUMMARY` line, and releases the
booth — all in the same act. A second door firing for an already-finalized
job is a no-op, reported at `info`
(`finalizePendingPrint ignored for <jobId>: already finalized (door=<door>)`),
never a silent drop and never a second send.

### The operational precondition everything above rests on

**Auto-print must be OFF on every booth** (`DEPLOYMENT.md` §7d). This is a
dslrBooth checkbox on the booth PC — nothing in this codebase can enforce
it. With auto-print ON, `printing` fires immediately after the first
composite regardless of whether the guest ever retakes, which collapses the
printing door's own precondition (D11-03) and reproduces exactly the
pre-Phase-11 defect this whole model exists to prevent — pinned as a named
regression test, `07-EVIDENCE-dslrbooth-triggers.md` sequence C, in
`test/queue-retake-anchor.test.ts`. Check it the same way `DEPLOYMENT.md`
§7d does: run one session and do not press print — the Agent log for that
session must carry no `printing` line at all.

### The five new log tokens

All five are `info` or `warn`, never `debug` — an operator does not need to
raise `LOG_LEVEL` (§11) to see any of them.

| Token to grep | Level | What it means | What to do |
|---|---|---|---|
| `printing ignored: no attempt open` | `info` | A `printing` event arrived with no attempt currently open on the booth — most often a gallery reprint (07-EVIDENCE §E) with no preceding `session_start`. | Nothing, ordinarily — this is the refusal working. If it appears during what should have been an ordinary, uninterrupted guest session (a `session_start` genuinely did precede it), that is a diagnosis to escalate: something between `session_start` and `printing` did not open the attempt as expected. |
| `printing ignored: composite <X> is not this attempt's <Y>` | `info` | An attempt IS open, but the `printing` event's composite does not match (by stem) the composite this attempt's own `processing_start` recorded — another guest's stray reprint while this attempt is live, or a genuinely different photo. | **On an ordinary, uninterrupted session where the same guest's own composite is what triggered `printing`, this line means the composite-stem comparison itself is wrong — it is a bug report, not an operator action.** Do not dismiss it as "just a mismatch" in that case; capture the two composite paths from the line and file it. |
| `Retake detected for job <jobId>: attempt <n> opened` | `info` | A new `session_start` arrived while `RETAKE_GRACE_MS` was still running for this job — a legitimate retake. The prior attempt's grace timer is cancelled and a new attempt opens. | Nothing — this is the retake path working. `<n>` is the new attempt number; two or more retakes in a row show `<n>` climbing. |
| `Grace opened for job <jobId>: attempt <n> ended unapproved, <ms>ms to retake` | `info` | An attempt's `session_end` arrived without ever seeing a matching `printing` — the guest left the sharing screen without pressing print (or without dslrBooth ever emitting `printing`, if auto-print is misconfigured ON). The booth stays held for `<ms>` (`RETAKE_GRACE_MS`, §3) before the grace door fires. | Nothing during the window — this is expected for a guest who is deciding whether to retake, or who is walking away. If this line appears on **every** session across an event, suspect auto-print is ON (precondition above), not a code fault. |
| `Grace expired for job <jobId>` | `info` | `RETAKE_GRACE_MS` ran out with no new `session_start` — the guest walked away without approving. This IS the grace door firing (`approved_by=grace`); look at the `SESSION_SUMMARY` line for the same job id for the outcome (photo sent late-held, or `no_photo`). | Nothing automatic is required. If this fires constantly for guests who are known to have pressed print, `RETAKE_GRACE_MS` may be too short for your booth's real retake gaps, or `printing`'s composite match is failing (see the composite-mismatch row above). |

### The operator control — "Kết thúc khách này" (D11-08)

**Where:** `GET /cms/booth` — a link labeled "Kết thúc khách này" on the CMS
event dashboard (§12). Behind the same `CMS_IP_WHITELIST` and session cookie
as every other CMS page; no separate auth or CSRF mechanism.

**When it appears:** only when there is a guest to end — `attempt_no >= 1`
for the job currently bound to the booth. It does **not** appear for a
genuinely idle booth, nor in the brief window right after dispatch before
the guest's own `session_start` has been acknowledged (in that window
`acknowledged_at` is unset, so there is no honest elapsed time to show). The
page shows the guest's given name and how long they have been at the booth,
and reloads itself every 5 seconds (a plain HTML `<meta refresh>`, not a
script) so the elapsed time stays current without any action.

**What it writes:** pressing it POSTs to `POST /cms/api/booth/release` with
the job id, which calls `releaseForOperator(jobId)` — the operator door
above, `approved_by=operator`. Two races are both refused rather than
silently mishandled, and reported apart in the log:

```
Operator release for <jobId>: refused: not the bound job
Operator release for <jobId>: refused: already finished
```

The first means the job id the page rendered no longer owns the booth
(someone else's session started, or a retake was already under way) — reload
the page. The second means the job DID own the booth, but finalized (through
printing or grace) in the gap between page render and click — nothing was
double-sent; that refusal is the proof.

**Why it exists:** the timer (`RETAKE_GRACE_MS`) is a safety net for the
walk-away case, not the fast path. Only a human watching the booth knows a
guest has genuinely left rather than being mid-retake; this control lets an
operator finalize immediately instead of waiting out the grace window when
they can see the answer with their own eyes.

### Answering a guest who says they got the wrong photo, or no photo

Two greps, in order — you do not need to reconstruct the session from
per-event lines:

```bash
# 1. The one-line outcome for that job
grep "SESSION_SUMMARY job=<jobId>" logs/extension-service-*.log

# 2. Every reason a printing/upload event for that job was NOT what sent their photo
grep "<jobId>" logs/extension-service-*.log | grep -E "ignored|Grace (opened|expired)|Retake detected"
```

The summary line's `attempts=` and `approved_by=` (§5) answer "how many
times did they shoot, and which door closed it" in one read. The second grep
answers "what happened to every OTHER attempt or upload that did not become
the delivered photo" — a guest who insists they took a better second shot
that never arrived almost always has a `printing ignored: composite …`
line for the reprint they think should have counted, or a `Grace expired`
line for a retake attempt that never actually opened because they were
outside `RETAKE_GRACE_MS` by the time they came back to the camera.

### What did not change

The Agent (D-05), the notification delivery mechanism (`notification_record`,
its sweeper, its retry budget — §8), the display feed protocol, and
`web-slide` are all untouched by this phase. `dslrbooth-agent`'s
`/api/cancel` command (deferred — would let the operator's control also push
dslrBooth back to its start screen, not just release the booth server-side)
is not called by anything in this phase; the operator control above only
ever changes this service's own state.
