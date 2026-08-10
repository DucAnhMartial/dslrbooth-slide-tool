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
