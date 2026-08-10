import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID, createHmac } from 'crypto';
import express from 'express';
import request from 'supertest';
import { createMirrorReceiver } from '../src/ingestion/mirrorReceiver';
import { jsonWithRawBody, isTimestampFresh } from '../src/ingestion/webhookAuth';
import { getStore } from '../src/state/localStore';

const SECRET = 'test-webhook-secret';

function buildApp(hmacSecret: string, whitelist: string[] = []): express.Express {
  const app = express();
  app.use(jsonWithRawBody());
  app.use(
    createMirrorReceiver(getStore(), whitelist, {
      hmacSecret,
      timestampSkewMs: 300_000,
      dedupWindowMs: 300_000,
    })
  );
  return app;
}

function sign(timestamp: string, webhookId: string, bodyString: string, secret: string): string {
  const canonical = `${timestamp}.${webhookId}.${bodyString}`;
  return createHmac('sha256', secret).update(canonical).digest('hex');
}

function makeBody(id: string): string {
  // email/phone are derived from `id` (already unique per call via randomUUID())
  // rather than hardcoded, so this auth-focused suite never triggers plan
  // 01-04's contact-detail dedup fallback across unrelated test cases that
  // happen to share the same LocalStore singleton.
  return JSON.stringify({
    id,
    name: 'Alice',
    email: `${id}@example.com`,
    phone: '',
    mode: 'standard',
  });
}

/**
 * Like buildApp, but for the `whitelist = ['203.0.113.*']` prefix-matching
 * behavior that cannot be exercised through a live loopback connection
 * (supertest always originates from loopback). Overrides `req.ip` via a
 * pre-router middleware so only the IP dimension varies — the router's
 * `clientIp()`/`isWhitelisted()` logic under test is completely unaware
 * this happened.
 */
function buildAppWithFakeIp(hmacSecret: string, whitelist: string[], fakeIp: string): express.Express {
  const app = express();
  app.use(jsonWithRawBody());
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', { value: fakeIp, configurable: true });
    next();
  });
  app.use(
    createMirrorReceiver(getStore(), whitelist, {
      hmacSecret,
      timestampSkewMs: 300_000,
      dedupWindowMs: 300_000,
    })
  );
  return app;
}

/**
 * Every 403 in this file must have this exact shape — no reason field, no
 * extra keys naming which check failed (D-12). Used by every 403 assertion
 * below so a future reason field cannot be added silently.
 */
function expectForbidden(res: request.Response): void {
  expect(res.status).toBe(403);
  expect(Object.keys(res.body)).toEqual(['error']);
  expect(res.body.error).toBe('Forbidden');
}

describe('POST /on-register — signed webhook auth', () => {
  let app: express.Express;

  beforeEach(() => {
    app = buildApp(SECRET);
  });

  it('accepts a request with a valid signature over the exact raw body', async () => {
    const id = randomUUID();
    const bodyString = makeBody(id);
    const timestamp = String(Date.now());
    const webhookId = randomUUID();
    const signature = sign(timestamp, webhookId, bodyString, SECRET);

    const res = await request(app)
      .post('/on-register')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Signature', signature)
      .set('X-Webhook-Timestamp', timestamp)
      .set('X-Webhook-Id', webhookId)
      .send(bodyString);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: true, jobId: id });
    expect(getStore().getRegistration(id)).toBeDefined();
  });

  it('rejects a request whose signature was computed over a different body (tampered payload)', async () => {
    const id = randomUUID();
    const originalBody = makeBody(id);
    const tamperedBody = JSON.stringify({ id, name: 'Mallory', email: 'x@example.com', phone: '0911111111', mode: 'standard' });
    const timestamp = String(Date.now());
    const webhookId = randomUUID();
    // signature computed over originalBody, but tamperedBody is actually sent
    const signature = sign(timestamp, webhookId, originalBody, SECRET);

    const res = await request(app)
      .post('/on-register')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Signature', signature)
      .set('X-Webhook-Timestamp', timestamp)
      .set('X-Webhook-Id', webhookId)
      .send(tamperedBody);

    expectForbidden(res);
    expect(getStore().getRegistration(id)).toBeUndefined();
  });

  it('rejects a request with no X-Webhook-Signature header while a secret is configured', async () => {
    const id = randomUUID();
    const bodyString = makeBody(id);
    const timestamp = String(Date.now());
    const webhookId = randomUUID();

    const res = await request(app)
      .post('/on-register')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Timestamp', timestamp)
      .set('X-Webhook-Id', webhookId)
      .send(bodyString);

    expectForbidden(res);
    expect(getStore().getRegistration(id)).toBeUndefined();
  });

  it('rejects a malformed/wrong-length signature header with 403, not 500', async () => {
    const id = randomUUID();
    const bodyString = makeBody(id);
    const timestamp = String(Date.now());
    const webhookId = randomUUID();

    const res = await request(app)
      .post('/on-register')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Signature', 'abc')
      .set('X-Webhook-Timestamp', timestamp)
      .set('X-Webhook-Id', webhookId)
      .send(bodyString);

    expectForbidden(res);
    expect(getStore().getRegistration(id)).toBeUndefined();
  });

  it('accepts an unsigned request when the router is constructed with an empty HMAC secret', async () => {
    const unsignedApp = buildApp('');
    const id = randomUUID();
    const bodyString = makeBody(id);

    const res = await request(unsignedApp)
      .post('/on-register')
      .set('Content-Type', 'application/json')
      .send(bodyString);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: true, jobId: id });
    expect(getStore().getRegistration(id)).toBeDefined();
  });
});

describe('isTimestampFresh', () => {
  it('is true for the exact current timestamp', () => {
    const now = Date.now();
    expect(isTimestampFresh(String(now), 300_000, now)).toBe(true);
  });

  it('is false for a timestamp older than the skew window', () => {
    const now = Date.now();
    expect(isTimestampFresh(String(now - 400_000), 300_000, now)).toBe(false);
  });

  it('is false for a timestamp further in the future than the skew window (symmetric)', () => {
    const now = Date.now();
    expect(isTimestampFresh(String(now + 400_000), 300_000, now)).toBe(false);
  });

  it('is false for a non-numeric timestamp', () => {
    const now = Date.now();
    expect(isTimestampFresh('not-a-number', 300_000, now)).toBe(false);
  });
});

describe('POST /on-register — timestamp freshness + replay protection', () => {
  let app: express.Express;

  beforeEach(() => {
    app = buildApp(SECRET);
  });

  it('rejects a correctly-signed request with a timestamp 10 minutes old and persists nothing', async () => {
    const id = randomUUID();
    const bodyString = makeBody(id);
    const timestamp = String(Date.now() - 10 * 60_000);
    const webhookId = randomUUID();
    const signature = sign(timestamp, webhookId, bodyString, SECRET);

    const res = await request(app)
      .post('/on-register')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Signature', signature)
      .set('X-Webhook-Timestamp', timestamp)
      .set('X-Webhook-Id', webhookId)
      .send(bodyString);

    expectForbidden(res);
    expect(getStore().getRegistration(id)).toBeUndefined();
  });

  it('rejects a fresh, correctly-signed request with no X-Webhook-Id header', async () => {
    const id = randomUUID();
    const bodyString = makeBody(id);
    const timestamp = String(Date.now());
    // Sign with a webhookId that is never sent as a header, so the
    // signature itself is irrelevant — the request is missing the header
    // checkWebhookAuth requires before it even reaches signature verification.
    const signature = sign(timestamp, randomUUID(), bodyString, SECRET);

    const res = await request(app)
      .post('/on-register')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Signature', signature)
      .set('X-Webhook-Timestamp', timestamp)
      .send(bodyString);

    expectForbidden(res);
    expect(getStore().getRegistration(id)).toBeUndefined();
  });

  it('accepts the first delivery of a request then rejects a byte-identical replay, adding no new registration row', async () => {
    const id = randomUUID();
    const bodyString = makeBody(id);
    const timestamp = String(Date.now());
    const webhookId = randomUUID();
    const signature = sign(timestamp, webhookId, bodyString, SECRET);
    const countBefore = getStore().countWebhookIds();

    const sendRequest = () =>
      request(app)
        .post('/on-register')
        .set('Content-Type', 'application/json')
        .set('X-Webhook-Signature', signature)
        .set('X-Webhook-Timestamp', timestamp)
        .set('X-Webhook-Id', webhookId)
        .send(bodyString);

    const first = await sendRequest();
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ accepted: true, jobId: id });

    const second = await sendRequest();
    expectForbidden(second);

    expect(getStore().countWebhookIds()).toBe(countBefore + 1);
  });
});

describe('IP allow-list', () => {
  function signedRequest(app: express.Express, id: string) {
    const bodyString = makeBody(id);
    const timestamp = String(Date.now());
    const webhookId = randomUUID();
    const signature = sign(timestamp, webhookId, bodyString, SECRET);
    return request(app)
      .post('/on-register')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Signature', signature)
      .set('X-Webhook-Timestamp', timestamp)
      .set('X-Webhook-Id', webhookId)
      .send(bodyString);
  }

  it('rejects a loopback-origin request even when a forwarding header claims an allow-listed IP', async () => {
    const app = buildApp(SECRET, ['203.0.113.9']);
    const id = randomUUID();
    const bodyString = makeBody(id);
    const timestamp = String(Date.now());
    const webhookId = randomUUID();
    const signature = sign(timestamp, webhookId, bodyString, SECRET);

    const res = await request(app)
      .post('/on-register')
      .set('Content-Type', 'application/json')
      .set('X-Forwarded-For', '203.0.113.9')
      .set('X-Webhook-Signature', signature)
      .set('X-Webhook-Timestamp', timestamp)
      .set('X-Webhook-Id', webhookId)
      .send(bodyString);

    expectForbidden(res);
    expect(getStore().getRegistration(id)).toBeUndefined();
  });

  it('accepts a loopback-origin signed request when the whitelist includes every loopback address form', async () => {
    const app = buildApp(SECRET, ['127.0.0.1', '::ffff:127.0.0.1', '::1']);
    const id = randomUUID();
    const res = await signedRequest(app, id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: true, jobId: id });
  });

  it('allows every request when the whitelist is empty (development escape hatch)', async () => {
    const app = buildApp(SECRET, []);
    const id = randomUUID();
    const res = await signedRequest(app, id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: true, jobId: id });
  });

  it('the prefix branch matches an IP sharing the prefix', async () => {
    const app = buildAppWithFakeIp(SECRET, ['203.0.113.*'], '203.0.113.44');
    const id = randomUUID();
    const res = await signedRequest(app, id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: true, jobId: id });
  });

  it('the prefix branch rejects an IP that does not share the prefix', async () => {
    const app = buildAppWithFakeIp(SECRET, ['203.0.113.*'], '203.0.114.1');
    const id = randomUUID();
    const res = await signedRequest(app, id);

    expectForbidden(res);
    expect(getStore().getRegistration(id)).toBeUndefined();
  });
});
