import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueService } from '../src/queue/queueService';
import type { LocalStore } from '../src/state/localStore';
import { createPendingPrintRegistry } from './helpers/pendingPrintRegistry';
import { NO_PHOTO_SWEEP_STUB } from './helpers/noPhotoSweep';

// D-02: a booth left BUSY after completion (guest walked away without
// exiting the sharing screen) must return to service on its own, without
// requeueing the job, without charging a retry and without writing a
// stall_reason — the job is already terminal. This timer is a deliberate
// sibling of busyTimer, never routed through handleStall() (see
// localStore.ts's requeueNoRetry() comment block for the same discipline
// applied to SQL writers instead of timers).

const CONFIG = {
  SESSION_TIMEOUT_MS: 300_000,
  NEXT_GUEST_COUNTDOWN_MS: 7_000,
  SESSION_MAX_RETRIES: 2,
  BOOTH_RELEASE_TIMEOUT_MS: 120_000,
};

const COMPOSITE_PATH = 'C:\\dslrBooth\\Test_event\\Prints\\composite.jpg';

function buildStore() {
  let booth = 'BUSY';
  let currentJobId: string | undefined = 'job-1';
  const jobStatus: Record<string, string> = { 'job-1': 'in_progress' };
  const requeueWithRetry = vi.fn();
  const requeueNoRetry = vi.fn();
  const failJob = vi.fn();
  const store = {
    getBoothState: () => booth,
    getNextQueuedJob: () => undefined,
    setBoothState: (s: string) => { booth = s; currentJobId = undefined; },
    setBoothBusy: (jobId?: string | null) => { booth = 'BUSY'; currentJobId = jobId ?? undefined; },
    setBoothIdle: () => { booth = 'IDLE'; currentJobId = undefined; },
    setBoothTimeout: () => { booth = 'IDLE'; currentJobId = undefined; },
    getBoothCurrentJobId: () => currentJobId,
    setBoothCurrentJob: (jobId: string | null) => { currentJobId = jobId ?? undefined; },
    getJob: (id: string) => (id in jobStatus ? { id, status: jobStatus[id] } : undefined),
    updateJobStatus: (id: string, status: string) => { jobStatus[id] = status; },
    completeJob: (jobId: string) => {
      if (jobStatus[jobId] !== 'in_progress') return false;
      jobStatus[jobId] = 'completed';
      return true;
    },
    getQueuedGuestSummaries: () => [],
    getQueueLength: () => 0,
    // tick() sweeps the pending-print registry on every interval and
    // onPrintComposite() opens a slot, so the mocked store must satisfy
    // that part of the real LocalStore surface too. The shared helper is
    // used rather than four inline stubs so the three-status semantics
    // cannot drift away from the SQL they stand in for (07-03).
    ...createPendingPrintRegistry().registry,
    getJobRegistration: () => undefined,
    requeueWithRetry,
    requeueNoRetry,
    failJob,
    ...NO_PHOTO_SWEEP_STUB,
  } as unknown as LocalStore;
  return { store, jobStatus, requeueWithRetry, requeueNoRetry, failJob };
}

describe('QueueService — booth-release fallback timer (D-02)', () => {
  afterEach(() => vi.useRealTimers());

  it('at BOOTH_RELEASE_TIMEOUT_MS - 1 the booth is still BUSY; at BOOTH_RELEASE_TIMEOUT_MS it is IDLE with current_job_id cleared', () => {
    vi.useFakeTimers();
    const { store, jobStatus } = buildStore();
    const service = new QueueService(store, CONFIG);
    service.bindSendCommand(() => {});

    service.onAgentEvent('processing_start', 'job-1', { param5: COMPOSITE_PATH });
    expect(jobStatus['job-1']).toBe('completed');
    expect(store.getBoothState()).toBe('BUSY');

    vi.advanceTimersByTime(CONFIG.BOOTH_RELEASE_TIMEOUT_MS - 1);
    expect(store.getBoothState()).toBe('BUSY');

    vi.advanceTimersByTime(1);
    expect(store.getBoothState()).toBe('IDLE');
    expect(store.getBoothCurrentJobId()).toBeUndefined();

    service.stop();
  });

  it('after the fallback fires, requeueWithRetry, requeueNoRetry and failJob are never called and the job stays completed', () => {
    vi.useFakeTimers();
    const { store, jobStatus, requeueWithRetry, requeueNoRetry, failJob } = buildStore();
    const service = new QueueService(store, CONFIG);
    service.bindSendCommand(() => {});

    service.onAgentEvent('processing_start', 'job-1', { param5: COMPOSITE_PATH });
    vi.advanceTimersByTime(CONFIG.BOOTH_RELEASE_TIMEOUT_MS);

    expect(requeueWithRetry).not.toHaveBeenCalled();
    expect(requeueNoRetry).not.toHaveBeenCalled();
    expect(failJob).not.toHaveBeenCalled();
    expect(jobStatus['job-1']).toBe('completed');

    service.stop();
  });

  it('a session_end arriving before the fallback deadline releases the booth and cancels the timer, so the fallback never fires afterward', () => {
    vi.useFakeTimers();
    const { store } = buildStore();
    const service = new QueueService(store, CONFIG);
    service.bindSendCommand(() => {});

    service.onAgentEvent('processing_start', 'job-1', { param5: COMPOSITE_PATH });
    vi.advanceTimersByTime(1000);
    service.onAgentEvent('session_end'); // releases the booth well before the 120s deadline

    expect(store.getBoothState()).toBe('IDLE');

    // Advancing past the original fallback deadline must do nothing further
    // — the timer was cancelled by the release, not merely superseded.
    vi.advanceTimersByTime(CONFIG.BOOTH_RELEASE_TIMEOUT_MS);
    expect(store.getBoothState()).toBe('IDLE');

    service.stop();
  });

  it('service.stop() clears the release timer, leaving no open handle', () => {
    vi.useFakeTimers();
    const { store } = buildStore();
    const service = new QueueService(store, CONFIG);
    service.bindSendCommand(() => {});

    service.onAgentEvent('processing_start', 'job-1', { param5: COMPOSITE_PATH });
    service.stop();

    const setBoothIdleSpy = vi.spyOn(store, 'setBoothIdle');
    vi.advanceTimersByTime(CONFIG.BOOTH_RELEASE_TIMEOUT_MS + 1000);
    expect(setBoothIdleSpy).not.toHaveBeenCalled();
  });
});
