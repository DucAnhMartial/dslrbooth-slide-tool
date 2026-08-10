import { describe, expect, it, vi, afterEach } from 'vitest';
import http from 'node:http';
import type { Socket } from 'node:net';
import { NotificationService } from '../src/notifications/notificationService';

// D-07: every delivery attempt must be bounded in wall-clock time, and its
// failure mode must be recorded distinguishably (hung receiver vs. refused
// connection vs. non-2xx status). Test 1 below is the load-bearing case —
// RESEARCH.md's Assumption A4 rates the `err.name === 'TimeoutError'` shape
// MEDIUM confidence, cross-checked from docs but never executed against this
// runtime, so it must be proven against a real never-responding server, not
// a mock.

describe('NotificationService — fetch timeout and error classification (D-07)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // restoreAllMocks() does not undo vi.stubGlobal — without this the
    // stubbed global fetch leaks into whatever file the worker runs next
    // (same convention as notification-service.test.ts).
    vi.unstubAllGlobals();
  });

  function buildStore(row: { jobId: string; photoUrl: string; attempts: number }) {
    const saveNotification = vi.fn();
    const store = {
      getDueNotifications: () => [row],
      claimNotification: () => true,
      saveNotification,
      getJobRegistration: () => ({
        job: { id: row.jobId },
        registration: { id: row.jobId, name: 'Nguyen Van A', mode: 'print' },
      }),
    };
    return { store, saveNotification };
  }

  it('test 1 (load-bearing): a real server that accepts a connection and never responds aborts at the configured deadline, and the recorded reason is the timeout string', async () => {
    const sockets = new Set<Socket>();
    // Deliberately never completes the HTTP response on the delivery
    // request path — the whole point is to observe the runtime's real
    // abort behaviour, not a mock.
    const server = http.createServer((req) => {
      req.resume();
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected a bound TCP address');
    const webhookUrl = `http://127.0.0.1:${address.port}/webhook`;

    const row = { jobId: 'job-hang', photoUrl: 'https://cdn.example/photo.jpg', attempts: 0 };
    const { store, saveNotification } = buildStore(row);
    const service = new NotificationService(2, store as never, webhookUrl, { fetchTimeoutMs: 150 });

    await service.sweep();

    expect(saveNotification).toHaveBeenCalledTimes(1);
    const call = saveNotification.mock.calls[0][0];
    expect(call.lastError).toBe('timeout');

    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('test 2: a mocked fetch rejecting with an error named TimeoutError records the timeout reason', async () => {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    const fetchMock = vi.fn().mockRejectedValue(err);
    vi.stubGlobal('fetch', fetchMock);
    const row = { jobId: 'job-timeout', photoUrl: 'https://cdn.example/photo.jpg', attempts: 0 };
    const { store, saveNotification } = buildStore(row);
    const service = new NotificationService(2, store as never, 'https://slides.example/webhook', { fetchTimeoutMs: 150 });

    await service.sweep();

    const call = saveNotification.mock.calls[0][0];
    expect(call.lastError).toBe('timeout');
  });

  it('test 3: a mocked fetch rejecting with a TypeError records a distinguishable, non-timeout reason carrying the underlying message', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);
    const row = { jobId: 'job-refused', photoUrl: 'https://cdn.example/photo.jpg', attempts: 0 };
    const { store, saveNotification } = buildStore(row);
    const service = new NotificationService(2, store as never, 'https://slides.example/webhook', { fetchTimeoutMs: 150 });

    await service.sweep();

    const call = saveNotification.mock.calls[0][0];
    expect(call.lastError).not.toBe('timeout');
    expect(call.lastError).toContain('fetch failed');
  });

  it('test 4: a resolved but non-2xx response records a reason naming the HTTP status', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal('fetch', fetchMock);
    const row = { jobId: 'job-503', photoUrl: 'https://cdn.example/photo.jpg', attempts: 0 };
    const { store, saveNotification } = buildStore(row);
    const service = new NotificationService(2, store as never, 'https://slides.example/webhook', { fetchTimeoutMs: 150 });

    await service.sweep();

    const call = saveNotification.mock.calls[0][0];
    expect(call.lastError).toContain('503');
  });
});
