import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueService } from '../src/queue/queueService';
import type { LocalStore } from '../src/state/localStore';

// AGT-02 (the fifth gap): the dispatch command must carry the mode the guest
// registered for, sourced from LocalStore.getJobRegistration(). This file
// never reaches for the shared store singleton (03-VALIDATION.md, binding)
// — every case drives a hand-built mock, following queue-countdown.test.ts's
// harness shape.

const CONFIG = { SESSION_TIMEOUT_MS: 30_000, NEXT_GUEST_COUNTDOWN_MS: 5_000, SESSION_MAX_RETRIES: 2 };

function buildStore(queued: Array<{ id: string }>, getJobRegistration: (jobId: string) => unknown) {
  let booth = 'IDLE';
  const store = {
    getBoothState: () => booth,
    getNextQueuedJob: () => queued[0],
    setBoothState: (state: string) => { booth = state; },
    setBoothBusy: () => { booth = 'BUSY'; },
    setBoothIdle: () => { booth = 'IDLE'; },
    setBoothTimeout: () => { booth = 'IDLE'; },
    updateJobStatus: (id: string, status: string) => {
      if (status === 'dispatched') {
        const idx = queued.findIndex(job => job.id === id);
        if (idx >= 0) queued.splice(idx, 1);
      }
    },
    getQueuedGuestSummaries: () =>
      queued.map((job, index) => ({ jobId: job.id, name: `Guest ${job.id}`, position: index + 1 })),
    getQueueLength: () => queued.length,
    completeJob: () => false,
    getBoothCurrentJobId: () => undefined,
    setBoothCurrentJob: () => {},
    getQueuePosition: () => 1,
    getJobRegistration,
    requeueWithRetry: vi.fn().mockReturnValue({ retries: 1 }),
    failJob: vi.fn(),
  } as unknown as LocalStore;

  return { store, getBooth: () => booth };
}

describe('QueueService — dispatch carries the guest-registered mode (AGT-02)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('dispatches a command equal to {type, action, jobId, mode} with the registration mode', () => {
    vi.useFakeTimers();
    const queued = [{ id: 'job-a' }];
    const lookupSpy = vi.fn((jobId: string) => ({
      job: { id: jobId },
      registration: { id: 'reg-a', name: 'Guest', email: '', phone: '', mode: 'gif360', registered_at: '' },
    }));
    const { store } = buildStore(queued, lookupSpy);
    const service = new QueueService(store, CONFIG);
    const captured: Array<{ type: string; action: string; jobId: string; mode?: string }> = [];
    service.bindSendCommand((cmd) => captured.push(cmd));

    service.start();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS);

    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({ type: 'command', action: 'start_session', jobId: 'job-a', mode: 'gif360' });

    service.stop();
  });

  it('calls getJobRegistration exactly once per dispatch, with the dispatched job id', () => {
    vi.useFakeTimers();
    const queued = [{ id: 'job-a' }];
    const lookupSpy = vi.fn((jobId: string) => ({
      job: { id: jobId },
      registration: { id: 'reg-a', name: 'Guest', email: '', phone: '', mode: 'gif360', registered_at: '' },
    }));
    const { store } = buildStore(queued, lookupSpy);
    const service = new QueueService(store, CONFIG);
    service.bindSendCommand(() => {});

    service.start();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS);

    expect(lookupSpy).toHaveBeenCalledTimes(1);
    expect(lookupSpy).toHaveBeenCalledWith('job-a');

    service.stop();
  });

  it('a job with no matching registration row still dispatches, with mode absent and no throw', () => {
    vi.useFakeTimers();
    const queued = [{ id: 'job-a' }];
    const { store, getBooth } = buildStore(queued, () => undefined);
    const service = new QueueService(store, CONFIG);
    const captured: Array<{ type: string; action: string; jobId: string; mode?: string }> = [];

    expect(() => {
      service.bindSendCommand((cmd) => captured.push(cmd));
      service.start();
      vi.advanceTimersByTime(250);
      vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS);
    }).not.toThrow();

    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({ type: 'command', action: 'start_session', jobId: 'job-a', mode: undefined });
    expect(getBooth()).toBe('BUSY');

    service.stop();
  });
});
