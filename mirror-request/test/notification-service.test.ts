import { describe, expect, it, vi, afterEach } from 'vitest';
import { NotificationService } from '../src/notifications/notificationService';

describe('NotificationService', () => {
  afterEach(() => vi.restoreAllMocks());

  it('posts the slide payload with the registered guest information', async () => {
    const store = {
      getJobRegistration: () => ({
        job: { id: 'job-123' },
        registration: { id: 'job-123', name: 'Nguyen Van A', mode: 'print' },
      }),
      saveNotification: vi.fn(),
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const service = new NotificationService(1, store as never, 'https://slides.example/webhook');

    await service.sendPhotoLink('job-123', 'https://cdn.example/photo.jpg');

    expect(fetchMock).toHaveBeenCalledWith('https://slides.example/webhook', expect.objectContaining({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      jobId: 'job-123',
      guestName: 'Nguyen Van A',
      photoUrl: 'https://cdn.example/photo.jpg',
      mode: 'print',
    });
    expect(body.timestamp).toEqual(expect.any(String));
    expect(store.saveNotification).toHaveBeenCalledWith(expect.objectContaining({ status: 'delivered', attempts: 1 }));
  });
});
