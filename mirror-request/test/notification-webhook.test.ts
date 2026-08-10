import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'http';
import { NotificationService } from '../src/notifications/notificationService';
import { getStore } from '../src/state/localStore';

describe('NotificationService webhook delivery', () => {
  let server: http.Server | undefined;
  let receivedPayload: unknown;

  beforeEach(() => {
    receivedPayload = null;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
      server = undefined;
    }
  });

  it('posts guest photo payload to the configured webhook', async () => {
    const store = getStore();
    store.upsertRegistration({
      id: 'job-webhook-001',
      name: 'Alice',
      email: 'alice@example.com',
      phone: '0900000000',
      mode: 'print',
      registered_at: new Date().toISOString(),
    });
    store.enqueueJob({ id: 'job-webhook-001', queued_at: Date.now() });

    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          receivedPayload = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          resolve();
        });
      });

      server.listen(0, '127.0.0.1', () => {
        const address = server!.address();
        if (!address || typeof address === 'string') throw new Error('Missing server address');
        const service = new NotificationService(1, `http://127.0.0.1:${address.port}`);
        void service.sendPhotoLink('job-webhook-001', 'https://example.com/photo.jpg');
      });
    });

    expect(receivedPayload).toMatchObject({
      jobId: 'job-webhook-001',
      guestName: 'Alice',
      photoUrl: 'https://example.com/photo.jpg',
      mode: 'print',
    });
  });
});
