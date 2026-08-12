import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueService, queueLogger } from '../src/queue/queueService';
import type { LocalStore } from '../src/state/localStore';

// Booth state is a single global row shared by every test file that reaches
// for the shared store singleton under parallel Vitest workers
// (02-VALIDATION.md, binding). This file never touches that singleton — every
// test below drives QueueService against a hand-built mocked store, following
// queue-countdown.test.ts's harness shape.

const CONFIG = { SESSION_TIMEOUT_MS: 30_000, NEXT_GUEST_COUNTDOWN_MS: 7_000, SESSION_MAX_RETRIES: 2 };

function buildStore(queued: Array<{ id: string }>) {
  let booth = 'IDLE';
  const updateJobStatus = vi.fn((id: string, status: string) => {
    if (status === 'dispatched') {
      const idx = queued.findIndex(job => job.id === id);
      if (idx >= 0) queued.splice(idx, 1);
    }
  });
  const requeueWithRetry = vi.fn().mockReturnValue({ retries: 1 });
  const failJob = vi.fn();
  const store = {
    getBoothState: () => booth,
    getNextQueuedJob: () => queued[0],
    setBoothState: (state: string) => { booth = state; },
    setBoothBusy: () => { booth = 'BUSY'; },
    setBoothIdle: () => { booth = 'IDLE'; },
    setBoothTimeout: () => { booth = 'IDLE'; },
    updateJobStatus,
    getQueuedGuestSummaries: () =>
      queued.map((job, index) => ({ jobId: job.id, name: `Guest ${job.id}`, position: index + 1 })),
    getQueueLength: () => queued.length,
    completeJob: () => false,
    getBoothCurrentJobId: () => undefined,
    setBoothCurrentJob: () => {},
    getJob: () => undefined,
    getJobRegistration: () => undefined,
    requeueWithRetry,
    failJob,
  } as unknown as LocalStore;

  return { store, updateJobStatus, requeueWithRetry, failJob, getBooth: () => booth };
}

describe('QueueService — live busyTimer timeout joins the bounded retry policy (BTH-02, D-05..D-07)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('resets the booth to IDLE and requeues exactly once on timeout', () => {
    vi.useFakeTimers();
    const queued = [{ id: 'job-a' }];
    const { store, requeueWithRetry, getBooth } = buildStore(queued);
    const service = new QueueService(store, CONFIG);
    service.bindSendCommand(() => {});

    service.start();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS);
    expect(getBooth()).toBe('BUSY');

    vi.advanceTimersByTime(CONFIG.SESSION_TIMEOUT_MS);

    expect(getBooth()).toBe('IDLE');
    expect(requeueWithRetry).toHaveBeenCalledTimes(1);
    expect(requeueWithRetry).toHaveBeenCalledWith('job-a');
    service.stop();
  });

  it('emits exactly one warning naming the job id and the attempt number', () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(queueLogger, 'warn');
    const queued = [{ id: 'job-a' }];
    const { store } = buildStore(queued);
    const service = new QueueService(store, CONFIG);
    service.bindSendCommand(() => {});

    service.start();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS);
    warnSpy.mockClear();

    vi.advanceTimersByTime(CONFIG.SESSION_TIMEOUT_MS);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('job-a');
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/attempt \d+\/\d+/);
    service.stop();
  });

  it('fails the job once retries exceed SESSION_MAX_RETRIES, with a warning saying the job failed', () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(queueLogger, 'warn');
    const queued = [{ id: 'job-a' }];
    const { store, requeueWithRetry, failJob } = buildStore(queued);
    requeueWithRetry.mockReturnValue({ retries: 3 });
    const service = new QueueService(store, CONFIG);
    service.bindSendCommand(() => {});

    service.start();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS);
    warnSpy.mockClear();

    vi.advanceTimersByTime(CONFIG.SESSION_TIMEOUT_MS);

    expect(failJob).toHaveBeenCalledWith('job-a', 'session_ack_timeout');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('failed');
    service.stop();
  });

  it('makes no updateJobStatus call for the timed-out job', () => {
    vi.useFakeTimers();
    const queued = [{ id: 'job-a' }];
    const { store, updateJobStatus, requeueWithRetry } = buildStore(queued);
    const service = new QueueService(store, CONFIG);
    service.bindSendCommand(() => {});

    service.start();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS);
    expect(updateJobStatus).toHaveBeenCalledTimes(1); // dispatchJob's dispatched_at write
    updateJobStatus.mockClear();

    vi.advanceTimersByTime(CONFIG.SESSION_TIMEOUT_MS);

    expect(updateJobStatus).not.toHaveBeenCalled();
    expect(requeueWithRetry).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it('advances to the next queued guest after the stall resolves, without waiting for a further timeout', () => {
    vi.useFakeTimers();
    const queued = [{ id: 'job-a' }, { id: 'job-b' }];
    const { store } = buildStore(queued);
    const service = new QueueService(store, CONFIG);
    const dispatched: string[] = [];
    service.bindSendCommand(cmd => dispatched.push(cmd.jobId));

    service.start();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS);
    expect(dispatched).toEqual(['job-a']);

    vi.advanceTimersByTime(CONFIG.SESSION_TIMEOUT_MS);
    expect(service.getAnnouncement()?.jobId).toBe('job-b');

    vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS);
    expect(dispatched).toEqual(['job-a', 'job-b']);
    service.stop();
  });

  it('a job acknowledged before the timeout re-arms the timer from the ack, and no stall is recorded', () => {
    vi.useFakeTimers();
    const queued = [{ id: 'job-a' }];
    const { store, requeueWithRetry } = buildStore(queued);
    const service = new QueueService(store, CONFIG);
    service.bindSendCommand(() => {});

    service.start();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS); // dispatch job-a, BUSY
    vi.advanceTimersByTime(CONFIG.SESSION_TIMEOUT_MS - 5_000); // 25s of a 30s window elapsed

    service.onAgentAck('job-a', true); // ack re-arms the busy timer, fresh, from now

    vi.advanceTimersByTime(5_000); // total elapsed since dispatch would have hit the original 30s deadline here
    expect(requeueWithRetry).not.toHaveBeenCalled();
    service.stop();
  });
});

describe('QueueService — an Agent NAK counts against the same retry budget (BTH-02, D-05, D-07)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a NAK sets the booth IDLE, clears the busy timer, requeues once, and warns once', () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(queueLogger, 'warn');
    const queued = [{ id: 'job-a' }];
    const { store, requeueWithRetry, getBooth } = buildStore(queued);
    const service = new QueueService(store, CONFIG);
    service.bindSendCommand(() => {});

    service.start();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS); // dispatch job-a, BUSY
    warnSpy.mockClear();

    service.onAgentAck('job-a', false, 'camera offline');

    expect(getBooth()).toBe('IDLE');
    expect(requeueWithRetry).toHaveBeenCalledTimes(1);
    expect(requeueWithRetry).toHaveBeenCalledWith('job-a');
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // The old busyTimer must actually be cleared — advancing past the
    // original session timeout must not double-count the stall.
    vi.advanceTimersByTime(CONFIG.SESSION_TIMEOUT_MS);
    expect(requeueWithRetry).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it('a NAK on a job already at the retry ceiling fails it with agent_nak, and the next tick announces the following guest', () => {
    vi.useFakeTimers();
    const queued = [{ id: 'job-a' }, { id: 'job-b' }];
    const { store, requeueWithRetry, failJob } = buildStore(queued);
    requeueWithRetry.mockReturnValue({ retries: 3 });
    const service = new QueueService(store, CONFIG);
    const dispatched: string[] = [];
    service.bindSendCommand(cmd => dispatched.push(cmd.jobId));

    service.start();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS); // dispatch job-a
    expect(dispatched).toEqual(['job-a']);

    service.onAgentAck('job-a', false, 'camera offline');

    expect(failJob).toHaveBeenCalledWith('job-a', 'agent_nak');
    expect(service.getAnnouncement()?.jobId).toBe('job-b');

    vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS);
    expect(dispatched).toEqual(['job-a', 'job-b']);
    service.stop();
  });

  it('makes no updateJobStatus call in the NAK branch', () => {
    vi.useFakeTimers();
    const queued = [{ id: 'job-a' }];
    const { store, updateJobStatus } = buildStore(queued);
    const service = new QueueService(store, CONFIG);
    service.bindSendCommand(() => {});

    service.start();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS);
    updateJobStatus.mockClear();

    service.onAgentAck('job-a', false, 'camera offline');

    expect(updateJobStatus).not.toHaveBeenCalled();
    service.stop();
  });

  it('onAgentAck(jobId, true) is unaffected: still transitions via sessionAcked and re-arms the busy timer', () => {
    vi.useFakeTimers();
    const queued = [{ id: 'job-a' }];
    const { store, updateJobStatus, requeueWithRetry } = buildStore(queued);
    const service = new QueueService(store, CONFIG);
    service.bindSendCommand(() => {});

    service.start();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS);
    updateJobStatus.mockClear();

    service.onAgentAck('job-a', true);

    expect(updateJobStatus).toHaveBeenCalledWith('job-a', 'in_progress', 'acknowledged_at', expect.any(Number));

    // The busy timer was re-armed fresh from the ack, for the full SESSION_TIMEOUT_MS.
    vi.advanceTimersByTime(CONFIG.SESSION_TIMEOUT_MS - 1);
    expect(requeueWithRetry).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(requeueWithRetry).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it('three consecutive NAKs of one job under a budget of 2 produce exactly one failJob call', () => {
    vi.useFakeTimers();
    const queued = [{ id: 'job-a' }];
    const { store, requeueWithRetry, failJob } = buildStore(queued);
    requeueWithRetry
      .mockReturnValueOnce({ retries: 1 })
      .mockReturnValueOnce({ retries: 2 })
      .mockReturnValueOnce({ retries: 3 });
    const service = new QueueService(store, CONFIG);
    service.bindSendCommand(() => {});

    service.start();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS); // dispatch job-a

    service.onAgentAck('job-a', false, 'nak-1');
    service.onAgentAck('job-a', false, 'nak-2');
    service.onAgentAck('job-a', false, 'nak-3');

    expect(requeueWithRetry).toHaveBeenCalledTimes(3);
    expect(failJob).toHaveBeenCalledTimes(1);
    expect(failJob).toHaveBeenCalledWith('job-a', 'agent_nak');
    service.stop();
  });
});
