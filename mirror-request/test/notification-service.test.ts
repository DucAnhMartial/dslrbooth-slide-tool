import { describe, expect, it, vi, afterEach } from 'vitest';
import { NotificationService } from '../src/notifications/notificationService';

describe('NotificationService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // restoreAllMocks() does not undo vi.stubGlobal — without this the
    // stubbed global fetch leaks into whatever file the worker runs next.
    vi.unstubAllGlobals();
  });

  it('sendPhotoLink enqueues the work item and performs no network call (D-06)', async () => {
    const store = {
      getJobRegistration: () => ({
        job: { id: 'job-123' },
        registration: { id: 'job-123', name: 'Nguyen Van A', mode: 'print' },
      }),
      enqueueNotification: vi.fn(),
    };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const service = new NotificationService(1, store as never, 'https://slides.example/webhook');

    await service.sendPhotoLink('job-123', 'https://cdn.example/photo.jpg');

    expect(store.enqueueNotification).toHaveBeenCalledTimes(1);
    const call = store.enqueueNotification.mock.calls[0][0];
    expect(call.jobId).toBe('job-123');
    expect(call.photoUrl).toBe('https://cdn.example/photo.jpg');
    expect(typeof call.dueAt).toBe('number');
    // The call site is only safe to leave un-awaited (queueService.ts:225)
    // because sendPhotoLink performs no network I/O of its own — this is
    // what pins D-06.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sweep delivers the exact five-key payload for a due row', async () => {
    const store = {
      getJobRegistration: () => ({
        job: { id: 'job-123' },
        registration: { id: 'job-123', name: 'Nguyen Van A', mode: 'print' },
      }),
      getDueNotifications: () => [
        { jobId: 'job-123', photoUrl: 'https://cdn.example/photo.jpg', attempts: 0 },
      ],
      claimNotification: () => true,
      saveNotification: vi.fn(),
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const service = new NotificationService(1, store as never, 'https://slides.example/webhook');

    await service.sweep();

    expect(fetchMock).toHaveBeenCalledWith('https://slides.example/webhook', expect.objectContaining({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // Exact-keys form, not toMatchObject: toMatchObject would not fail if
    // phone/email were ever re-added to the payload (D-02, D-03; this is
    // exactly RESEARCH.md's Security Domain regression).
    expect(Object.keys(body).sort()).toEqual(['guestName', 'jobId', 'mode', 'photoUrl', 'timestamp']);
    expect(body.jobId).toBe('job-123');
    expect(body.guestName).toBe('Nguyen Van A');
    expect(body.photoUrl).toBe('https://cdn.example/photo.jpg');
    expect(body.mode).toBe('print');
    expect(typeof body.timestamp).toBe('string');
    expect(store.saveNotification).toHaveBeenCalledWith(expect.objectContaining({ status: 'delivered', attempts: 1 }));
  });
});
