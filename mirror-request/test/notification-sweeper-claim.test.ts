import { describe, expect, it, vi, afterEach } from 'vitest';
import { NotificationService, notifyLogger } from '../src/notifications/notificationService';

const WEBHOOK_URL = 'https://slides.example/webhook';

// D-05/D-10: two overlapping sweep passes must deliver a row exactly once,
// a row stranded 'sending' by a dead process must self-heal on its own
// lease expiry, and one row's unexpected failure must never stop the next
// row's delivery or crash the process.
//
// Models the same status/dueAt predicate LocalStore.getDueNotifications()/
// claimNotification()/saveNotification() actually use in SQL — multiple rows,
// keyed by jobId, so the claim's honest lease-write mechanism (not an
// in-process flag) is what a second concurrent pass would observe.
class MultiRowFakeStore {
  rows: Map<
    string,
    { jobId: string; status: string; attempts: number; photoUrl: string; dueAt: number; lastError?: string }
  >;

  constructor(rows: Array<{ jobId: string; status: string; attempts: number; photoUrl: string; dueAt: number }>) {
    this.rows = new Map(rows.map((r) => [r.jobId, { ...r }]));
  }

  getDueNotifications(now: number) {
    return [...this.rows.values()]
      .filter((r) => ['pending', 'retrying', 'sending'].includes(r.status) && r.dueAt <= now)
      .map((r) => ({ jobId: r.jobId, photoUrl: r.photoUrl, attempts: r.attempts }));
  }

  claimNotification(jobId: string, now: number, leaseUntil: number) {
    const row = this.rows.get(jobId);
    if (!row) return false;
    if (!['pending', 'retrying', 'sending'].includes(row.status) || row.dueAt > now) return false;
    row.status = 'sending';
    row.dueAt = leaseUntil;
    return true;
  }

  saveNotification(n: { jobId: string; status?: string; attempts?: number; lastError?: string; dueAt?: number }) {
    const row = this.rows.get(n.jobId);
    if (!row) return;
    if (n.status !== undefined) row.status = n.status;
    if (n.attempts !== undefined) row.attempts = n.attempts;
    if (n.lastError !== undefined) row.lastError = n.lastError;
    if (n.dueAt !== undefined) row.dueAt = n.dueAt;
  }

  getJobRegistration(jobId: string) {
    if (!this.rows.has(jobId)) return undefined;
    return { job: { id: jobId }, registration: { id: jobId, name: `Guest ${jobId}`, mode: 'print' } };
  }
}

describe('NotificationService.sweep() — claim isolation and per-row failure containment (D-05, D-10)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('test 1 (D-05): two overlapping sweep passes deliver a row exactly once', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const store = new MultiRowFakeStore([
      { jobId: 'job-1', status: 'pending', attempts: 0, photoUrl: 'https://cdn.example/photo.jpg', dueAt: now },
    ]);
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ ok: true, status: 200 }), 50);
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    // Two distinct service instances sharing one store — models two overlapping
    // sweep passes without relying on either instance's own in-process
    // `sweeping` re-entrancy flag, which only guards a single instance against
    // itself. The never-deliver-twice guarantee under test here must come from
    // claimNotification()'s honest lease write, not from that flag.
    const opts = { fetchTimeoutMs: 5_000, claimLeaseMs: 60_000 };
    const serviceA = new NotificationService(2, store as never, WEBHOOK_URL, opts);
    const serviceB = new NotificationService(2, store as never, WEBHOOK_URL, opts);

    const first = serviceA.sweep();
    await vi.advanceTimersByTimeAsync(10);
    const second = serviceB.sweep(); // starts while the first pass's fetch is still in flight
    await vi.advanceTimersByTimeAsync(50);
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('test 2 (D-05, restart shape): a sending row past its lease is due again; one still under lease is not', async () => {
    const now = Date.now();
    const opts = { fetchTimeoutMs: 5_000, claimLeaseMs: 60_000 };

    const expiredStore = new MultiRowFakeStore([
      { jobId: 'job-expired', status: 'sending', attempts: 1, photoUrl: 'https://cdn.example/a.jpg', dueAt: now - 1_000 },
    ]);
    const fetchExpired = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchExpired);
    const serviceExpired = new NotificationService(2, expiredStore as never, WEBHOOK_URL, opts);
    await serviceExpired.sweep();
    // A process that died mid-flight leaves the row 'sending' with an
    // expired lease — this must self-heal with no boot-time recovery pass.
    expect(fetchExpired).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();

    const liveStore = new MultiRowFakeStore([
      { jobId: 'job-live', status: 'sending', attempts: 1, photoUrl: 'https://cdn.example/b.jpg', dueAt: now + 60_000 },
    ]);
    const fetchLive = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchLive);
    const serviceLive = new NotificationService(2, liveStore as never, WEBHOOK_URL, opts);
    await serviceLive.sweep();
    // A row genuinely still in flight under a live lease must not be
    // re-claimed by a concurrent/second pass.
    expect(fetchLive).not.toHaveBeenCalled();
  });

  it('test 3 (D-10): an unexpected exception on one row never throws out of sweep() and never stops the next row', async () => {
    const now = Date.now();
    const store = new MultiRowFakeStore([
      { jobId: 'job-bad', status: 'pending', attempts: 0, photoUrl: 'https://cdn.example/a.jpg', dueAt: now },
      { jobId: 'job-good', status: 'pending', attempts: 0, photoUrl: 'https://cdn.example/b.jpg', dueAt: now },
    ]);
    const realGetJobRegistration = store.getJobRegistration.bind(store);
    // A failure from outside attemptDelivery()'s own try/catch — e.g. a
    // store method throwing synchronously — for job-bad only.
    store.getJobRegistration = (jobId: string) => {
      if (jobId === 'job-bad') throw new Error('registration lookup exploded');
      return realGetJobRegistration(jobId);
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const warnSpy = vi.spyOn(notifyLogger, 'warn');
    const service = new NotificationService(2, store as never, WEBHOOK_URL, { fetchTimeoutMs: 5_000, claimLeaseMs: 60_000 });

    await expect(service.sweep()).resolves.toBeUndefined();

    // The second row was still claimed and still attempted.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.jobId).toBe('job-good');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('job-bad');
  });

  it('test 4 (Pitfall 2): a lost claim produces no log output at all', async () => {
    const now = Date.now();
    const store = new MultiRowFakeStore([
      { jobId: 'job-1', status: 'pending', attempts: 0, photoUrl: 'https://cdn.example/photo.jpg', dueAt: now },
    ]);
    store.claimNotification = () => false; // simulate a lost claim race
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const warnSpy = vi.spyOn(notifyLogger, 'warn');
    const errorSpy = vi.spyOn(notifyLogger, 'error');
    const service = new NotificationService(2, store as never, WEBHOOK_URL, { fetchTimeoutMs: 5_000, claimLeaseMs: 60_000 });

    await service.sweep();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
