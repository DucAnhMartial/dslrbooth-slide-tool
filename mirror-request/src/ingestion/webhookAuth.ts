import { createHmac, timingSafeEqual } from 'crypto';
import express, { Request } from 'express';
import type { LocalStore } from '../state/localStore';

/**
 * Header names as Express sees them: Express lower-cases all incoming header
 * keys, so `req.get('X-Webhook-Signature')` and `req.headers['x-webhook-signature']`
 * both work, but the constants below use the lower-case wire form for direct
 * `req.headers[...]` lookups. The wire names sent by Mirror Request are
 * `X-Webhook-Signature`, `X-Webhook-Timestamp`, `X-Webhook-Id` (D-10).
 */
export const SIGNATURE_HEADER = 'x-webhook-signature';
export const TIMESTAMP_HEADER = 'x-webhook-timestamp';
export const WEBHOOK_ID_HEADER = 'x-webhook-id';

export type RawBodyRequest = Request & { rawBody?: Buffer };

/**
 * The one and only raw-byte capture point. `express.json()`'s `verify` callback
 * runs after the body has been read off the socket but before it is parsed into
 * `req.body`, so this is the only place the exact wire bytes are still available.
 * Signature verification MUST use this Buffer, never a re-serialized `req.body`
 * (RESEARCH.md Pitfall 1 / Anti-Patterns: re-serialization can differ in
 * whitespace, key order, or unicode escaping from what was actually signed).
 */
export function jsonWithRawBody(): express.RequestHandler {
  return express.json({
    verify: (req, _res, buf) => {
      (req as RawBodyRequest).rawBody = buf;
    },
  });
}

export function getRawBody(req: Request): Buffer | undefined {
  return (req as RawBodyRequest).rawBody;
}

/**
 * The single swappable point where the signing contract with Mirror Request is
 * expressed (RESEARCH.md assumption A1). The exact canonical-string composition
 * is unconfirmed against Mirror Request's real signer — CONTEXT.md explicitly
 * delegates this choice to the agent's discretion, provided the three agreed
 * headers and raw-body HMAC validation remain compatible with the source system.
 * If the assumption proves wrong, this is the one function to change.
 *
 * Including the webhook id in the signed content (not just timestamp + body)
 * blocks an attacker from replaying a captured valid signature under a fresh
 * `X-Webhook-Id` to dodge the persisted replay-ID check.
 */
export function buildCanonicalString(timestamp: string, webhookId: string, rawBody: Buffer): string {
  return `${timestamp}.${webhookId}.${rawBody.toString('utf8')}`;
}

/**
 * Verifies `signatureHeader` (hex-encoded) against the HMAC-SHA256 digest of
 * the canonical string, using a constant-time comparison. Never uses `===` or
 * `Buffer.equals` (timing-attack risk). Guards buffer length before calling
 * `timingSafeEqual`, since that function throws `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`
 * on a length mismatch rather than returning false (RESEARCH.md Pitfall 2) —
 * an unguarded call here would let a malformed/short signature header surface
 * as an uncaught 500 instead of a clean 403 (D-12). The whole body is wrapped
 * in try/catch so a non-hex header also cannot produce a 500.
 */
export function verifySignature(
  rawBody: Buffer,
  timestamp: string,
  webhookId: string,
  signatureHeader: string,
  secret: string
): boolean {
  try {
    const canonical = buildCanonicalString(timestamp, webhookId, rawBody);
    const expected = createHmac('sha256', secret).update(canonical).digest('hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    const receivedBuf = Buffer.from(signatureHeader, 'hex');
    if (expectedBuf.length !== receivedBuf.length) return false;
    return timingSafeEqual(expectedBuf, receivedBuf);
  } catch {
    return false;
  }
}

/**
 * The header value is treated as epoch milliseconds — the same unconfirmed
 * signing-contract caveat as `buildCanonicalString()` (RESEARCH.md A1). The
 * window is symmetric on purpose: a future-dated timestamp is exactly as
 * suspicious as a stale one (clock-skew abuse must not have a free direction).
 */
export function isTimestampFresh(timestamp: string, skewMs: number, nowMs: number = Date.now()): boolean {
  const ts = Number.parseInt(timestamp, 10);
  if (Number.isNaN(ts)) return false;
  return Math.abs(nowMs - ts) <= skewMs;
}

export interface CheckWebhookAuthOptions {
  secret: string;
  skewMs: number;
  nowMs?: number;
}

/**
 * The single webhook-authentication decision function: signature, timestamp
 * freshness, and replay all gate through here. Returns a bare boolean and
 * logs nothing — the caller (`mirrorReceiver.ts`) owns the single generic
 * denial log line and response body, which is what keeps D-12 ("never reveal
 * which check failed") enforceable in one place instead of scattered across
 * every check.
 *
 * The replay id is recorded only after every other check has passed, so a
 * probing attacker who sends a bad signature or a stale timestamp cannot
 * burn a legitimate `X-Webhook-Id` for the real sender.
 */
export function checkWebhookAuth(req: Request, store: LocalStore, opts: CheckWebhookAuthOptions): boolean {
  const signature = req.headers[SIGNATURE_HEADER];
  const timestamp = req.headers[TIMESTAMP_HEADER];
  const webhookId = req.headers[WEBHOOK_ID_HEADER];
  const rawBody = getRawBody(req);

  if (
    typeof signature !== 'string' ||
    typeof timestamp !== 'string' ||
    typeof webhookId !== 'string' ||
    !rawBody
  ) {
    return false;
  }

  if (!verifySignature(rawBody, timestamp, webhookId, signature, opts.secret)) {
    return false;
  }

  if (!isTimestampFresh(timestamp, opts.skewMs, opts.nowMs ?? Date.now())) {
    return false;
  }

  if (store.hasSeenWebhookId(webhookId)) {
    return false;
  }

  store.recordWebhookId(webhookId, Date.now());
  return true;
}
