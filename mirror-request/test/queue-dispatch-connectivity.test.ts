import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueService, queueLogger } from '../src/queue/queueService';
import type { LocalStore } from '../src/state/localStore';

// D-02/D-03/D-04: when the Agent is not connected, the queue must not
// dispatch, must not touch the retry budget, and must log once per outage —
// not once per 250ms tick. This file never reaches for the shared store
// singleton (03-VALIDATION.md, binding): every case below drives a
// hand-built mock, following queue-countdown.test.ts's harness shape.

const CONFIG = { SESSION_TIMEOUT_MS: 30_000, NEXT_GUEST_COUNTDOWN_MS: 5_000, SESSION_MAX_RETRIES: 2 };

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
    getQueuePosition: () => 1,
    getJobRegistration: () => undefined,
    requeueWithRetry,
    failJob,
  } as unknown as LocalStore;

  return { store, updateJobStatus, requeueWithRetry, failJob, getBooth: () => booth };
}

describe('QueueService — no dispatch without a connected Agent (D-01..D-04)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('forty consecutive ticks while offline: no announcement, no status write, no command, no retry increment, exactly one warning', () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(queueLogger, 'warn');
    const queued = [{ id: 'job-a' }];
    const { store, updateJobStatus, requeueWithRetry, getBooth } = buildStore(queued);
    const service = new QueueService(store, CONFIG);
    service.bindIsAgentOnline(() => false);
    const dispatched: string[] = [];
    service.bindSendCommand((cmd) => dispatched.push(cmd.jobId));

    service.start();
    vi.advanceTimersByTime(10_000); // 40 ticks at 250ms

    expect(getBooth()).toBe('IDLE');
    expect(service.getAnnouncement()).toBeNull();
    expect(dispatched).toEqual([]);
    expect(updateJobStatus).not.toHaveBeenCalled();
    expect(requeueWithRetry).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('job-a');
    expect(store.getNextQueuedJob()?.id).toBe('job-a');

    service.stop();
  });

  it('flipping connectivity to true lets the very next ordinary tick announce, and the countdown then dispatches', () => {
    vi.useFakeTimers();
    let agentOnline = false;
    const queued = [{ id: 'job-a' }];
    const { store, getBooth } = buildStore(queued);
    const service = new QueueService(store, CONFIG);
    service.bindIsAgentOnline(() => agentOnline);
    const dispatched: string[] = [];
    service.bindSendCommand((cmd) => dispatched.push(cmd.jobId));

    service.start();
    vi.advanceTimersByTime(1_000); // 4 offline ticks — nothing happens
    expect(getBooth()).toBe('IDLE');

    agentOnline = true;
    vi.advanceTimersByTime(250); // the very next ordinary tick
    expect(getBooth()).toBe('ANNOUNCING');
    expect(dispatched).toEqual([]);

    vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS);
    expect(dispatched).toEqual(['job-a']);
    expect(getBooth()).toBe('BUSY');

    service.stop();
  });

  it('going offline again after a period online produces a second warning — the flag resets on resume', () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(queueLogger, 'warn');
    let agentOnline = false;
    const queued = [{ id: 'job-a' }, { id: 'job-b' }];
    const { store } = buildStore(queued);
    const service = new QueueService(store, CONFIG);
    service.bindIsAgentOnline(() => agentOnline);
    service.bindSendCommand(() => {});

    service.start();
    vi.advanceTimersByTime(1_000); // offline: first warning
    expect(warnSpy).toHaveBeenCalledTimes(1);

    agentOnline = true;
    vi.advanceTimersByTime(250); // resumes — announces job-a
    vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS); // dispatches job-a, booth BUSY

    // Manually return the booth to IDLE to let the next tick see job-b queued.
    store.setBoothIdle();

    agentOnline = false;
    vi.advanceTimersByTime(1_000); // offline again: second warning
    expect(warnSpy).toHaveBeenCalledTimes(2);

    service.stop();
  });

  it('a disconnect mid-announcement leaves the job unwritten, the booth IDLE, no retry, and exactly one further warning', () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(queueLogger, 'warn');
    let agentOnline = true;
    const queued = [{ id: 'job-a' }];
    const { store, updateJobStatus, requeueWithRetry, getBooth } = buildStore(queued);
    const service = new QueueService(store, CONFIG);
    service.bindIsAgentOnline(() => agentOnline);
    const dispatched: string[] = [];
    service.bindSendCommand((cmd) => dispatched.push(cmd.jobId));

    service.start();
    vi.advanceTimersByTime(250); // begins the announcement
    expect(getBooth()).toBe('ANNOUNCING');

    agentOnline = false; // drops during the 5s countdown
    vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS); // countdown elapses -> dispatchJob's guard fires

    expect(updateJobStatus).not.toHaveBeenCalled();
    expect(dispatched).toEqual([]);
    expect(requeueWithRetry).not.toHaveBeenCalled();
    expect(getBooth()).toBe('IDLE');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(store.getNextQueuedJob()?.id).toBe('job-a');

    // The immediate re-entrant tick() inside the guard must not double-log —
    // still offline, still exactly one warning.
    vi.advanceTimersByTime(1_000);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    service.stop();
  });

  it('a QueueService on which the connectivity read was never bound dispatches exactly as it does today', () => {
    vi.useFakeTimers();
    const queued = [{ id: 'job-a' }];
    const { store, getBooth } = buildStore(queued);
    const service = new QueueService(store, CONFIG);
    const dispatched: string[] = [];
    service.bindSendCommand((cmd) => dispatched.push(cmd.jobId));

    service.start();
    vi.advanceTimersByTime(250);
    expect(getBooth()).toBe('ANNOUNCING');
    vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS);
    expect(dispatched).toEqual(['job-a']);
    expect(getBooth()).toBe('BUSY');

    service.stop();
  });

  it('offline the whole time: no announce, no dispatch, no command callback invocation at all', () => {
    vi.useFakeTimers();
    const queued = [{ id: 'job-a' }];
    const { store } = buildStore(queued);
    const service = new QueueService(store, CONFIG);
    service.bindIsAgentOnline(() => false);
    const sendCommand = vi.fn();
    service.bindSendCommand(sendCommand);

    service.start();
    vi.advanceTimersByTime(5_000);

    expect(sendCommand).not.toHaveBeenCalled();

    service.stop();
  });
});
