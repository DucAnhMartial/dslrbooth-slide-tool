import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID, createHmac } from 'crypto';
import express from 'express';
import request from 'supertest';
import { createMirrorReceiver } from '../src/ingestion/mirrorReceiver';
import { jsonWithRawBody } from '../src/ingestion/webhookAuth';
import { getStore } from '../src/state/localStore';

const SECRET = 'test-webhook-secret';

function buildApp(hmacSecret: string): express.Express {
  const app = express();
  app.use(jsonWithRawBody());
  app.use(
    createMirrorReceiver(getStore(), [], {
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
  return JSON.stringify({
    id,
    name: 'Alice',
    email: 'alice@example.com',
    phone: '0900000000',
    mode: 'standard',
  });
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

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
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

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
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

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
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
