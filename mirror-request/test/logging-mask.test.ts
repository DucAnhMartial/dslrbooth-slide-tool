import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID, createHmac } from 'crypto';
import express from 'express';
import request from 'supertest';
import { mask, debugRawPayload, logger } from '../src/logging/logger';
import { createMirrorReceiver } from '../src/ingestion/mirrorReceiver';
import { jsonWithRawBody } from '../src/ingestion/webhookAuth';
import { getStore } from '../src/state/localStore';

describe('mask', () => {
  it('replaces an email address with [EMAIL REDACTED] and removes the original', () => {
    const result = mask('contact alice@example.com now');
    expect(result).toContain('[EMAIL REDACTED]');
    expect(result).not.toContain('alice@example.com');
  });

  it('replaces a phone number with asterisks of the same length', () => {
    const result = mask('call 0900000000');
    expect(result).toBe('call **********');
  });

  it('leaves ordinary ingestion log text unchanged (no false positives)', () => {
    const input = 'registration r-1 status=accepted';
    expect(mask(input)).toBe(input);
  });
});

describe('debugRawPayload gating (D-16)', () => {
  let originalNodeEnv: string | undefined;
  let originalDebug: string | undefined;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    originalDebug = process.env.DEBUG;
    debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => logger);
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalDebug === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = originalDebug;
    debugSpy.mockRestore();
  });

  it('emits nothing when NODE_ENV is production, even with DEBUG set', () => {
    process.env.NODE_ENV = 'production';
    process.env.DEBUG = '1';

    debugRawPayload('on-register', '{"email":"a@b.co"}');

    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('emits nothing when DEBUG is unset, whatever NODE_ENV is', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.DEBUG;

    debugRawPayload('on-register', '{"email":"a@b.co"}');

    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('emits exactly one logger.debug call with a string message when NODE_ENV is not production and DEBUG is set', () => {
    process.env.NODE_ENV = 'test';
    process.env.DEBUG = '1';

    debugRawPayload('on-register', '{"email":"a@b.co"}');

    expect(debugSpy).toHaveBeenCalledTimes(1);
    const [message] = debugSpy.mock.calls[0];
    expect(typeof message).toBe('string');
  });
});

describe('/on-register log surface', () => {
  const SECRET = 'test-webhook-secret';

  // A raw randomUUID() occasionally contains a run of 7+ consecutive digits
  // by chance, which PHONE_RE (`\+?\d{7,}`, pre-existing, out of scope to
  // change per task 1's explicit "do not change the existing regexes")
  // would then mask inside an id-carrying log line like "Ingested
  // registration <id> from <ip>" — a false positive on the id itself, not a
  // real PII leak. Breaking up any digit run keeps this test deterministic
  // without touching mask()'s regexes.
  function safeId(): string {
    return randomUUID().replace(/(\d)(?=\d)/g, '$1x');
  }

  function buildApp(): express.Express {
    const app = express();
    app.use(jsonWithRawBody());
    app.use(
      createMirrorReceiver(getStore(), [], {
        hmacSecret: SECRET,
        timestampSkewMs: 300_000,
        dedupWindowMs: 300_000,
      })
    );
    return app;
  }

  function sign(timestamp: string, webhookId: string, bodyString: string): string {
    const canonical = `${timestamp}.${webhookId}.${bodyString}`;
    return createHmac('sha256', SECRET).update(canonical).digest('hex');
  }

  function sendSignedRegistration(bodyString: string): request.Test {
    const app = buildApp();
    const timestamp = String(Date.now());
    const webhookId = randomUUID();
    const signature = sign(timestamp, webhookId, bodyString);
    return request(app)
      .post('/on-register')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Signature', signature)
      .set('X-Webhook-Timestamp', timestamp)
      .set('X-Webhook-Id', webhookId)
      .send(bodyString);
  }

  // email/phone are derived per-call from `id` and a random suffix (never a
  // shared literal like alice@example.com/0900000000) so the three cases
  // below never collide inside plan 01-04's contact-detail dedup fallback —
  // they share the LocalStore singleton and all run inside the same 5-minute
  // dedupWindowMs. Both still match EMAIL_RE/PHONE_RE, which is all mask()
  // masking cares about.
  function payloadWithPii(id: string): string {
    const phone = `09${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`;
    return JSON.stringify({
      id,
      name: 'Alice',
      email: `${id}@example.com`,
      phone,
      mode: 'standard',
    });
  }

  let originalNodeEnv: string | undefined;
  let originalDebug: string | undefined;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    originalDebug = process.env.DEBUG;
    infoSpy = vi.spyOn(logger, 'info');
    warnSpy = vi.spyOn(logger, 'warn');
    debugSpy = vi.spyOn(logger, 'debug');
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalDebug === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = originalDebug;
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    debugSpy.mockRestore();
  });

  function collectMessages(): unknown[] {
    return [...infoSpy.mock.calls, ...warnSpy.mock.calls, ...debugSpy.mock.calls].map(call => call[0]);
  }

  it('produces log messages that are all plain strings and all unchanged by mask()', async () => {
    const id = safeId();
    const bodyString = payloadWithPii(id);

    const res = await sendSignedRegistration(bodyString);

    expect(res.status).toBe(200);
    const messages = collectMessages();
    expect(messages.length).toBeGreaterThan(0);
    for (const msg of messages) {
      expect(typeof msg).toBe('string');
      expect(mask(msg as string)).toBe(msg);
    }
  });

  it('under NODE_ENV=production produces no message containing the payload JSON, yet raw_payload is still stored', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DEBUG = '1'; // D-16: even with DEBUG set, production must stay silent

    const id = safeId();
    const bodyString = payloadWithPii(id);

    const res = await sendSignedRegistration(bodyString);

    expect(res.status).toBe(200);
    const messages = collectMessages();
    for (const msg of messages) {
      expect(typeof msg === 'string' && msg.includes(bodyString)).toBe(false);
    }
    expect(getStore().getRegistration(id)?.raw_payload).toBeTruthy();
  });

  it('under NODE_ENV=test with DEBUG=1 produces exactly one message containing the payload JSON', async () => {
    process.env.NODE_ENV = 'test';
    process.env.DEBUG = '1';

    const id = safeId();
    const bodyString = payloadWithPii(id);

    const res = await sendSignedRegistration(bodyString);

    expect(res.status).toBe(200);
    const messages = collectMessages();
    const matching = messages.filter(msg => typeof msg === 'string' && msg.includes(bodyString));
    expect(matching.length).toBe(1);
    expect(getStore().getRegistration(id)?.raw_payload).toBeTruthy();
  });

  it('raw_payload is populated for a new registration under the default (non-production) test environment', async () => {
    const id = safeId();
    const bodyString = payloadWithPii(id);

    const res = await sendSignedRegistration(bodyString);

    expect(res.status).toBe(200);
    expect(getStore().getRegistration(id)?.raw_payload).toBe(bodyString);
  });
});
