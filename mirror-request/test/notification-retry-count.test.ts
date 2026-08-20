import { describe, expect, it, vi, afterEach } from 'vitest';
import { NotificationService, notifyLogger } from '../src/notifications/notificationService';

// D-08/D-09/NOT-02: the retry budget terminates at exactly 1 + NOTIFY_MAX_RETRIES
// total attempts, and exhaustion leaves exactly one operator-facing error log
// line naming the job id and the attempt count — never one per retry.

// Models one row's real lifecycle against the same predicate shape
// LocalStore.getDueNotifications()/claimNotification()/saveNotification() use:
// status IN ('pending','retrying','sending') AND dueAt <= now for both the
// due-query and the claim, so the backoff dueAt values genuinely gate the
// next sweep rather than the row being trivially always-due.
class FakeStore {
  row: { jobId: string; status: string; attempts: number; photoUrl: string; dueAt: number; lastError?: string };

  constructor(jobId: string, photoUrl: string, now: number) {
    this.row = { jobId, status: 'pending', attempts: 0, photoUrl, dueAt: now };
  }

  getDueNotifications(now: number) {
    if (['pending', 'retrying', 'sending'].includes(this.row.status) && this.row.dueAt <= now) {
      return [{ jobId: this.row.jobId, photoUrl: this.row.photoUrl, attempts: this.row.attempts }];
    }
    return [];
  }

  claimNotification(jobId: string, now: number, leaseUntil: number) {
    if (jobId !== this.row.jobId) return false;
    if (!['pending', 'retrying', 'sending'].includes(this.row.status) || this.row.dueAt > now) return false;
    this.row.status = 'sending';
    this.row.dueAt = leaseUntil;
    return true;
  }

  saveNotification(n: { jobId: string; status?: string; attempts?: number; lastError?: string; dueAt?: number }) {
    if (n.status !== undefined) this.row.status = n.status;
    if (n.attempts !== undefined) this.row.attempts = n.attempts;
    if (n.lastError !== undefined) this.row.lastError = n.lastError;
    if (n.dueAt !== undefined) this.row.dueAt = n.dueAt;
  }

  getJobRegistration(jobId: string) {
    if (jobId !== this.row.jobId) return undefined;
    return { job: { id: jobId }, registration: { id: jobId, name: 'Nguyen Van A', mode: 'print' } };
  }
}

describe('NotificationService — retry budget terminates at exactly 3 attempts (D-08, D-09, NOT-02)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function buildService() {
    vi.useFakeTimers();
    const now = Date.now();
    const store = new FakeStore('job-a', 'https://cdn.example/photo.jpg', now);
    const fetchMock = vi.fn().mockRejectedValue(new Error('boom'));
    vi.stubGlobal('fetch', fetchMock);
    // maxRetries: 2 is D-15's shipped default — 1 + 2 = 3 total attempts.
    const service = new NotificationService(2, store as never, 'https://slides.example/webhook', {
      fetchTimeoutMs: 5_000,
      baseDelayMs: 1_000,
    });
    return { store, fetchMock, service };
  }

  it('test 1: fetch is called exactly 3 times, never a 4th, no matter how many further sweeps run', async () => {
    const { store, fetchMock, service } = buildService();

    await service.sweep(); // attempt 1 (fails, retries)
    vi.advanceTimersByTime(store.row.dueAt - Date.now() + 1);
    await service.sweep(); // attempt 2 (fails, retries)
    vi.advanceTimersByTime(store.row.dueAt - Date.now() + 1);
    await service.sweep(); // attempt 3 (fails, exhausted -> failed)

    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Further sweeps, even much later, must never call fetch a 4th time.
    vi.advanceTimersByTime(1_000_000);
    await service.sweep();
    await service.sweep();

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('test 2: the terminal record is failed, attempts is 3, and lastError is non-empty', async () => {
    const { store, service } = buildService();

    await service.sweep(); // attempt 1 (fails, retries)
    vi.advanceTimersByTime(store.row.dueAt - Date.now() + 1);
    await service.sweep(); // attempt 2 (fails, retries)
    vi.advanceTimersByTime(store.row.dueAt - Date.now() + 1);
    await service.sweep(); // attempt 3 (fails, exhausted -> failed)

    expect(store.row.status).toBe('failed');
    expect(store.row.attempts).toBe(3);
    expect(store.row.lastError).toBeTruthy();
  });

  it('test 3: notifyLogger.error is called exactly once, naming the job id and the attempt count', async () => {
    const { store, fetchMock, service } = buildService();
    const errorSpy = vi.spyOn(notifyLogger, 'error');

    await service.sweep();
    vi.advanceTimersByTime(store.row.dueAt - Date.now() + 1);
    await service.sweep();
    vi.advanceTimersByTime(store.row.dueAt - Date.now() + 1);
    await service.sweep();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain('job-a');
    expect(String(errorSpy.mock.calls[0][0])).toMatch(/3/);
  });

  it('test 4: after exhaustion, a further sweep performs no fetch at all — a failed row is excluded by the sweeper predicate', async () => {
    const { store, fetchMock, service } = buildService();

    await service.sweep();
    vi.advanceTimersByTime(store.row.dueAt - Date.now() + 1);
    await service.sweep();
    vi.advanceTimersByTime(store.row.dueAt - Date.now() + 1);
    await service.sweep();

    expect(store.row.status).toBe('failed');
    expect(store.row.attempts).toBe(3);
    expect(store.row.lastError).toBeTruthy();

    fetchMock.mockClear();
    vi.advanceTimersByTime(1_000_000);
    await service.sweep();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
