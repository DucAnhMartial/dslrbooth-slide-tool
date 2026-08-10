import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHmac } from 'crypto';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { LocalStore, getStore } from '../src/state/localStore';
import { createMirrorReceiver } from '../src/ingestion/mirrorReceiver';
import { jsonWithRawBody } from '../src/ingestion/webhookAuth';

const SECRET = 'test-webhook-secret';

describe('LocalStore dedup window', () => {
  let dir: string;
  let dbPath: string;
  let store: LocalStore | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-dedup-'));
    dbPath = path.join(dir, 'test.sqlite');
    store = undefined;
  });

  afterEach(() => {
    if (store) {
      store.close();
      store = undefined;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a store opened on a brand-new file has a registration.received_at column', () => {
    store = new LocalStore(dbPath);
    const columns = new Database(dbPath).prepare('PRAGMA table_info(registration)').all() as Array<{ name: string }>;
    expect(columns.some((c) => c.name === 'received_at')).toBe(true);
  });

  it('a store opened on a pre-phase-schema file gains received_at on open and preserves existing rows', () => {
    // Create a database with the pre-phase schema (no received_at column).
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE registration (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT NOT NULL,
        mode TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        raw_payload TEXT
      );
    `);
    raw.prepare(
      `INSERT INTO registration (id, name, email, phone, mode, registered_at, raw_payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('pre-1', 'Old Guest', 'old@example.com', '', 'standard', '2026-01-01T00:00:00.000Z', '{}');
    raw.close();

    store = new LocalStore(dbPath);
    const columns = new Database(dbPath).prepare('PRAGMA table_info(registration)').all() as Array<{ name: string }>;
    expect(columns.some((c) => c.name === 'received_at')).toBe(true);

    const row = store.getRegistration('pre-1');
    expect(row).toBeDefined();
    expect(row?.name).toBe('Old Guest');
  });

  it('upsertRegistration with no explicit received_at stores the current server time', () => {
    store = new LocalStore(dbPath);
    const before = Date.now();
    store.upsertRegistration({
      id: 'r1', name: 'Guest', email: '', phone: '', mode: 'standard',
      registered_at: '2026-01-01T00:00:00.000Z',
    });
    const after = Date.now();
    const row = store.getRegistration('r1') as unknown as { received_at: number };
    expect(row.received_at).toBeGreaterThanOrEqual(before);
    expect(row.received_at).toBeLessThanOrEqual(after);
  });

  it('findDuplicateRegistration by id returns the row inside the window and undefined once outside it', () => {
    store = new LocalStore(dbPath);
    const now = Date.now();
    store.upsertRegistration({
      id: 'r1', name: 'Guest', email: '', phone: '', mode: 'standard',
      registered_at: '2026-01-01T00:00:00.000Z', received_at: now,
    });

    expect(store.findDuplicateRegistration({ id: 'r1', email: '', phone: '', windowStartMs: now - 1000 })).toEqual({ id: 'r1' });
    expect(store.findDuplicateRegistration({ id: 'r1', email: '', phone: '', windowStartMs: now + 1000 })).toBeUndefined();
  });

  it('findDuplicateRegistration falls back to matching email and returns the earlier registration', () => {
    store = new LocalStore(dbPath);
    const now = Date.now();
    store.upsertRegistration({
      id: 'r1', name: 'Guest', email: 'a@b.co', phone: '', mode: 'standard',
      registered_at: '2026-01-01T00:00:00.000Z', received_at: now,
    });

    const found = store.findDuplicateRegistration({ id: 'r2', email: 'a@b.co', phone: '', windowStartMs: now - 1000 });
    expect(found).toEqual({ id: 'r1' });
  });

  it('two registrations with empty email and empty phone never collide', () => {
    store = new LocalStore(dbPath);
    const now = Date.now();
    store.upsertRegistration({
      id: 'r1', name: 'Guest 1', email: '', phone: '', mode: 'standard',
      registered_at: '2026-01-01T00:00:00.000Z', received_at: now,
    });

    const found = store.findDuplicateRegistration({ id: 'r3', email: '', phone: '', windowStartMs: now - 1000 });
    expect(found).toBeUndefined();
  });

  it('when two rows both match on contact details, the earliest one inside the window is returned', () => {
    store = new LocalStore(dbPath);
    const now = Date.now();
    store.upsertRegistration({
      id: 'r1', name: 'Guest 1', email: 'shared@example.com', phone: '', mode: 'standard',
      registered_at: '2026-01-01T00:00:00.000Z', received_at: now,
    });
    store.upsertRegistration({
      id: 'r2', name: 'Guest 2', email: 'shared@example.com', phone: '', mode: 'standard',
      registered_at: '2026-01-01T00:00:01.000Z', received_at: now + 100,
    });

    const found = store.findDuplicateRegistration({ id: 'r3', email: 'shared@example.com', phone: '', windowStartMs: now - 1000 });
    expect(found).toEqual({ id: 'r1' });
  });
});

describe('POST /on-register dedup', () => {
  function buildApp(dedupWindowMs: number, onEnqueue?: (jobId: string) => void): express.Express {
    const app = express();
    app.use(jsonWithRawBody());
    app.use(
      createMirrorReceiver(getStore(), [], {
        hmacSecret: SECRET,
        timestampSkewMs: 300_000,
        dedupWindowMs,
        onEnqueue,
      })
    );
    return app;
  }

  function makeBody(id: string, overrides: { email?: string; phone?: string } = {}): string {
    return JSON.stringify({
      id,
      name: 'Guest',
      email: overrides.email ?? '',
      phone: overrides.phone ?? '',
      mode: 'standard',
    });
  }

  // Every request needs a distinct X-Webhook-Id: plan 01-02's replay
  // protection rejects a second submission carrying an already-seen
  // webhook id with a bare 403 before the request ever reaches the dedup
  // ladder, so reusing a webhook id across two "different" submissions in
  // these tests would mask the behavior under test.
  function signedRequest(app: express.Express, bodyString: string) {
    const timestamp = String(Date.now());
    const webhookId = randomUUID();
    const canonical = `${timestamp}.${webhookId}.${bodyString}`;
    const signature = createHmac('sha256', SECRET).update(canonical).digest('hex');
    return request(app)
      .post('/on-register')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Signature', signature)
      .set('X-Webhook-Timestamp', timestamp)
      .set('X-Webhook-Id', webhookId)
      .send(bodyString);
  }

  // Assertions below check for the presence/absence of a queue_job row tied
  // to a SPECIFIC job id via getJob(id), rather than an aggregate
  // getQueueLength() count. The underlying LocalStore is a process-wide
  // singleton shared by every test file in this suite (LOCAL_STORE_PATH is
  // fixed by vitest.config.ts's test.env), and vitest may run other test
  // files' queue-mutating cases concurrently, so an aggregate count is not a
  // reliable signal — checking a specific, randomly-generated id is.

  it('two submissions with the same id return 200 twice, the second echoing {duplicate:true,jobId:<same id>}, one queue_job row', async () => {
    const app = buildApp(300_000);
    const id = randomUUID();

    const first = await signedRequest(app, makeBody(id));
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ accepted: true, jobId: id });
    expect(getStore().getJob(id)).toBeDefined();

    const second = await signedRequest(app, makeBody(id));
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ duplicate: true, jobId: id });
  });

  it('two submissions with different ids but the same email: the second echoes the FIRST id as jobId, no job row for the second id', async () => {
    const app = buildApp(300_000);
    const idA = randomUUID();
    const idB = randomUUID();
    const email = `${randomUUID()}@example.com`;

    const first = await signedRequest(app, makeBody(idA, { email }));
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ accepted: true, jobId: idA });
    expect(getStore().getJob(idA)).toBeDefined();

    const second = await signedRequest(app, makeBody(idB, { email }));
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ duplicate: true, jobId: idA });
    expect(getStore().getJob(idB)).toBeUndefined();
  });

  it('two submissions with different ids but the same phone: the second echoes the FIRST id as jobId, no job row for the second id', async () => {
    const app = buildApp(300_000);
    const idA = randomUUID();
    const idB = randomUUID();
    const phone = `090${Date.now()}`;

    const first = await signedRequest(app, makeBody(idA, { phone }));
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ accepted: true, jobId: idA });
    expect(getStore().getJob(idA)).toBeDefined();

    const second = await signedRequest(app, makeBody(idB, { phone }));
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ duplicate: true, jobId: idA });
    expect(getStore().getJob(idB)).toBeUndefined();
  });

  it('the same email outside the window is treated as a new registration with its own jobId and its own queue_job row', async () => {
    const dedupWindowMs = 50;
    const app = buildApp(dedupWindowMs);
    const idA = randomUUID();
    const idB = randomUUID();
    const email = `${randomUUID()}@example.com`;

    const first = await signedRequest(app, makeBody(idA, { email }));
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ accepted: true, jobId: idA });

    await new Promise((resolve) => setTimeout(resolve, dedupWindowMs + 50));

    const second = await signedRequest(app, makeBody(idB, { email }));
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ accepted: true, jobId: idB });
    expect(getStore().getJob(idB)).toBeDefined();
  });

  it("after a duplicate is detected, the original registration's raw_payload is byte-identical to before", async () => {
    const app = buildApp(300_000);
    const idA = randomUUID();
    const idB = randomUUID();
    const email = `${randomUUID()}@example.com`;

    await signedRequest(app, makeBody(idA, { email }));
    const rawBefore = getStore().getRegistration(idA) as unknown as { raw_payload: string };

    await signedRequest(app, makeBody(idB, { email }));
    const rawAfter = getStore().getRegistration(idA) as unknown as { raw_payload: string };

    expect(rawAfter.raw_payload).toBe(rawBefore.raw_payload);
  });

  it('onEnqueue is invoked once for the original submission and not at all for the duplicate', async () => {
    const calls: string[] = [];
    const app = buildApp(300_000, (jobId) => calls.push(jobId));
    const idA = randomUUID();
    const idB = randomUUID();
    const email = `${randomUUID()}@example.com`;

    await signedRequest(app, makeBody(idA, { email }));
    await signedRequest(app, makeBody(idB, { email }));

    expect(calls).toEqual([idA]);
  });

  it('two guests, both with empty email and empty phone, each receive their own jobId', async () => {
    const app = buildApp(300_000);
    const idA = randomUUID();
    const idB = randomUUID();

    const first = await signedRequest(app, makeBody(idA));
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ accepted: true, jobId: idA });

    const second = await signedRequest(app, makeBody(idB));
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ accepted: true, jobId: idB });
  });
});
