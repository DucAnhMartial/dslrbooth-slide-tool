import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Database from 'better-sqlite3';
import { LocalStore } from '../src/state/localStore';
import { NotificationService } from '../src/notifications/notificationService';

describe('notification sweeper — restart-resumed delivery', () => {
  let dir: string;
  let dbPath: string;
  let store: LocalStore | undefined;
  let storeB: LocalStore | undefined;
  let server: http.Server | undefined;
  let requestCount: number;
  let receivedBodies: Array<Record<string, unknown>>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-notif-sweep-'));
    dbPath = path.join(dir, 'test.sqlite');
    store = undefined;
    storeB = undefined;
    server = undefined;
    requestCount = 0;
    receivedBodies = [];
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
      server = undefined;
    }
    if (storeB) {
      storeB.close();
      storeB = undefined;
    }
    if (store) {
      store.close();
      store = undefined;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // A real ephemeral HTTP server that records every request it receives —
  // deliberately not a mocked fetch, so the sweeper's SQL-driven resumption
  // path is proven end to end, not merely that it constructs the right JS
  // object (VALIDATION.md's binding "2xx proves nothing" hazard).
  function startCapturingServer(): Promise<number> {
    return new Promise((resolve) => {
      server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          requestCount += 1;
          receivedBodies.push(JSON.parse(body || '{}'));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      });
      server.listen(0, '127.0.0.1', () => {
        const address = server!.address();
        if (!address || typeof address === 'string') throw new Error('Missing server address');
        resolve(address.port);
      });
    });
  }

  it('sendPhotoLink persists the work item and performs no network call', async () => {
    const port = await startCapturingServer();
    store = new LocalStore(dbPath);
    const jobId = `job-sweep-${Date.now()}-1`;
    store.upsertRegistration({
      id: jobId,
      name: 'Alice',
      email: 'alice@example.com',
      phone: '0900000000',
      mode: 'print',
      registered_at: new Date().toISOString(),
    });
    store.enqueueJob({ id: jobId, queued_at: Date.now() });

    const service = new NotificationService(2, store, `http://127.0.0.1:${port}`);
    await service.sendPhotoLink(jobId, 'https://cdn.example/photo-1.jpg');

    expect(requestCount).toBe(0);
    const record = store.getNotification(jobId);
    expect(record?.status).toBe('pending');
    expect(record?.photoUrl).toBe('https://cdn.example/photo-1.jpg');
  });

  it('a second process lifetime delivers the enqueued work item with the exact payload', async () => {
    const port = await startCapturingServer();
    const jobId = `job-sweep-${Date.now()}-2`;

    const storeA = new LocalStore(dbPath);
    storeA.upsertRegistration({
      id: jobId,
      name: 'Bob',
      email: 'bob@example.com',
      phone: '0911111111',
      mode: 'gif360',
      registered_at: new Date().toISOString(),
    });
    storeA.enqueueJob({ id: jobId, queued_at: Date.now() });
    const serviceA = new NotificationService(2, storeA, `http://127.0.0.1:${port}`);
    await serviceA.sendPhotoLink(jobId, 'https://cdn.example/photo-2.jpg');
    storeA.close();

    // A fresh LocalStore/NotificationService pair, opened on the same
    // database file after the first pair closed — this is the "different
    // process lifetime" the tracer must prove, not merely a second method
    // call on the same objects.
    storeB = new LocalStore(dbPath);
    const serviceB = new NotificationService(2, storeB, `http://127.0.0.1:${port}`);
    await serviceB.sweep();

    expect(requestCount).toBe(1);
    const body = receivedBodies[0];
    // Exact-keys form, not toMatchObject: toMatchObject would not fail if
    // phone/email were ever re-added to the payload (D-02, D-03).
    expect(Object.keys(body).sort()).toEqual(['guestName', 'jobId', 'mode', 'photoUrl', 'timestamp']);
    expect(body.jobId).toBe(jobId);
    expect(body.guestName).toBe('Bob');
    expect(body.photoUrl).toBe('https://cdn.example/photo-2.jpg');
    expect(body.mode).toBe('gif360');
    expect(typeof body.timestamp).toBe('string');

    const record = storeB.getNotification(jobId);
    expect(record?.status).toBe('delivered');
  });

  it('a delivered row is never re-sent', async () => {
    const port = await startCapturingServer();
    const jobId = `job-sweep-${Date.now()}-3`;

    const storeA = new LocalStore(dbPath);
    storeA.upsertRegistration({
      id: jobId,
      name: 'Carol',
      email: 'carol@example.com',
      phone: '0922222222',
      mode: 'boomerang',
      registered_at: new Date().toISOString(),
    });
    storeA.enqueueJob({ id: jobId, queued_at: Date.now() });
    const serviceA = new NotificationService(2, storeA, `http://127.0.0.1:${port}`);
    await serviceA.sendPhotoLink(jobId, 'https://cdn.example/photo-3.jpg');
    storeA.close();

    storeB = new LocalStore(dbPath);
    const serviceB = new NotificationService(2, storeB, `http://127.0.0.1:${port}`);

    await serviceB.sweep();
    expect(requestCount).toBe(1);

    await serviceB.sweep();
    expect(requestCount).toBe(1);
  });

  it('a pre-migration row with no photoUrl is marked failed, not left pending', () => {
    // Simulate a genuine pre-Phase-4 notification_record row: create the
    // old-shape table directly (no photoUrl/dueAt columns), the same
    // pattern test/on-register-dedup.test.ts uses for registration's
    // received_at migration. Writing the row through a LocalStore's
    // saveNotification() cannot exercise this path: bootstrap() gives any
    // brand-new database the new columns directly, so migrate()'s "at least
    // one column was actually added" gate would never fire and the backfill
    // would never run.
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE notification_record (
        jobId TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        lastError TEXT,
        updatedAt TEXT NOT NULL DEFAULT 'now'
      );
    `);
    const jobId = `job-premigration-${Date.now()}`;
    raw.prepare(
      `INSERT INTO notification_record (jobId, status, attempts, lastError, updatedAt)
       VALUES (?, 'pending', 1, NULL, ?)`
    ).run(jobId, new Date().toISOString());
    raw.close();

    store = new LocalStore(dbPath);
    const record = store.getNotification(jobId);
    expect(record?.status).toBe('failed');
    expect(record?.lastError).toMatch(/photoUrl unavailable/);
  });
});
