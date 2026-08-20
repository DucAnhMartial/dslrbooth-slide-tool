import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'http';
import { NotificationService } from '../src/notifications/notificationService';
import { LocalStore } from '../src/state/localStore';

describe('NotificationService webhook delivery', () => {
  let dir: string;
  let dbPath: string;
  let store: LocalStore | undefined;
  let server: http.Server | undefined;
  let receivedPayload: unknown;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notif-webhook-'));
    dbPath = path.join(dir, 'test.sqlite');
    store = undefined;
    receivedPayload = null;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
      server = undefined;
    }
    if (store) {
      store.close();
      store = undefined;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('posts guest photo payload to the configured webhook', async () => {
    // D-14: a per-test temp-path store, constructed directly — not borrowed
    // from the process-wide store singleton. The two-argument
    // `new NotificationService(maxRetries, webhookUrl)` overload internally
    // falls back to that singleton, so the three-argument form below is
    // required, not merely the removal of an explicit lookup call.
    store = new LocalStore(dbPath);
    const jobId = `job-webhook-${Date.now()}`;
    store.upsertRegistration({
      id: jobId,
      name: 'Alice',
      email: 'alice@example.com',
      phone: '0900000000',
      mode: 'print',
      registered_at: new Date().toISOString(),
    });
    store.enqueueJob({ id: jobId, queued_at: Date.now() });

    // Resolution is gated on the client-side sweep() promise, not on the
    // server having merely received bytes — sweep()'s own saveNotification()
    // write happens after the client processes the response, and the test's
    // store must stay open until that write completes.
    await new Promise<void>((resolve, reject) => {
      server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          receivedPayload = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      });

      server.listen(0, '127.0.0.1', () => {
        const address = server!.address();
        if (!address || typeof address === 'string') throw new Error('Missing server address');
        const service = new NotificationService(1, store!, `http://127.0.0.1:${address.port}`);
        service
          .sendPhotoLink(jobId, 'https://example.com/photo.jpg')
          .then(() => service.sweep())
          .then(resolve, reject);
      });
    });

    const body = receivedPayload as Record<string, unknown>;
    // Exact-keys form, not toMatchObject: web-slide returns 200
    // unconditionally, so a status-only or toMatchObject assertion proves
    // nothing about payload shape (D-02, D-03).
    expect(Object.keys(body).sort()).toEqual(['guestName', 'jobId', 'mode', 'photoUrl', 'timestamp']);
    expect(body.jobId).toBe(jobId);
    expect(body.guestName).toBe('Alice');
    expect(body.photoUrl).toBe('https://example.com/photo.jpg');
    expect(body.mode).toBe('print');
    expect(typeof body.timestamp).toBe('string');
  });
});
