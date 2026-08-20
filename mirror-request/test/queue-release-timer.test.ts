import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueService } from '../src/queue/queueService';
import type { LocalStore } from '../src/state/localStore';
import { createPendingPrintRegistry } from './helpers/pendingPrintRegistry';
import { NO_PHOTO_SWEEP_STUB } from './helpers/noPhotoSweep';

/**
 * D-02/D11-06: the two bounds that replaced Phase 7's release-fallback timer.
 *
 * Phase 7's D-02 timer existed for one reason: a booth left BUSY after
 * completion (guest walked away without exiting the sharing screen) had to
 * return to service on its own. Phase 11 (11-01) retires that timer entirely
 * — `startReleaseTimer`/`clearReleaseTimer`/`releaseTimer` and every call
 * site are GONE (`grep -rF 'releaseTimer' src/` is 0) — because D11-05
 * changes what "complete" means: `finalizePendingPrint()` completes the job
 * AND releases the booth in the same act, so the fallback's only trigger
 * site (the old `onPrintComposite`) disappeared with it.
 *
 * The guarantee the old timer provided moved to TWO independent bounds, and
 * this file now names and proves both:
 *   1. RETAKE_GRACE_MS — an attempt that ends unapproved (`session_end`
 *      arrives with no valid `printing`) and is never retaken is released by
 *      grace expiry, via `finalizePendingPrint(jobId, 'grace')`.
 *   2. SESSION_TIMEOUT_MS — a dispatched session that never produces a
 *      single Agent event at all (no `session_start` ever arrives) is still
 *      bounded by the pre-existing busy timer, unchanged by this phase.
 * Neither bound is the retired fallback, and this file also pins that the
 * retired fallback specifically — a timer keyed off `processing_start` alone
 * — no longer exists: `processing_start` opens a slot and starts nothing.
 */

const CONFIG = {
  SESSION_TIMEOUT_MS: 5_000,
  NEXT_GUEST_COUNTDOWN_MS: 5_000,
  SESSION_MAX_RETRIES: 2,
  BOOTH_RELEASE_TIMEOUT_MS: 120_000,
  RETAKE_GRACE_MS: 500,
};

const COMPOSITE_PATH = 'C:\\dslrBooth\\Test_event\\Prints\\composite.jpg';

function buildStore() {
  let booth = 'BUSY';
  let currentJobId: string | undefined = 'job-1';
  let attemptOpen = false;
  let attemptNo = 0;
  const jobStatus: Record<string, string> = { 'job-1': 'in_progress', 'job-2': 'queued' };
  const requeueWithRetry = vi.fn(() => ({ retries: 1 }));
  const requeueNoRetry = vi.fn();
  const failJob = vi.fn();
  const store = {
    getBoothState: () => booth,
    getBoothStateDetailed: () => ({ state: booth, updated_at: new Date().toISOString() }),
    getInFlightJobs: () => [],
    getNextQueuedJob: () => {
      const nextId = Object.keys(jobStatus).find((id) => jobStatus[id] === 'queued');
      return nextId ? { id: nextId } : undefined;
    },
    setBoothState: (s: string) => { booth = s; currentJobId = undefined; attemptOpen = false; attemptNo = 0; },
    setBoothBusy: (jobId?: string | null) => { booth = 'BUSY'; currentJobId = jobId ?? undefined; attemptOpen = false; attemptNo = 0; },
    setBoothIdle: () => { booth = 'IDLE'; currentJobId = undefined; attemptOpen = false; attemptNo = 0; },
    setBoothTimeout: () => { booth = 'IDLE'; currentJobId = undefined; attemptOpen = false; attemptNo = 0; },
    getBoothCurrentJobId: () => currentJobId,
    setBoothCurrentJob: (jobId: string | null) => { currentJobId = jobId ?? undefined; },
    getBoothAttempt: () => ({ attemptOpen, attemptNo }),
    openBoothAttempt: () => { attemptOpen = true; attemptNo += 1; return { attemptOpen, attemptNo }; },
    closeBoothAttempt: () => { attemptOpen = false; },
    getJob: (id: string) => (id in jobStatus ? { id, status: jobStatus[id] } : undefined),
    updateJobStatus: (id: string, status: string) => { jobStatus[id] = status; },
    completeJob: (jobId: string) => {
      if (jobStatus[jobId] !== 'in_progress') return false;
      jobStatus[jobId] = 'completed';
      return true;
    },
    closeJobNoPhoto: (jobId: string) => {
      if (jobStatus[jobId] !== 'in_progress') return false;
      jobStatus[jobId] = 'no_photo';
      return true;
    },
    getQueuedGuestSummaries: () => [],
    getQueueLength: () => Object.values(jobStatus).filter((s) => s === 'queued').length,
    // tick() sweeps the pending-print registry on every interval and
    // onPrintComposite() opens a slot, so the mocked store must satisfy
    // that part of the real LocalStore surface too. The shared helper is
    // used rather than four inline stubs so the three-status semantics
    // cannot drift away from the SQL they stand in for (07-03).
    ...createPendingPrintRegistry().registry,
    getJobRegistration: () => undefined,
    getActiveEventId: () => undefined,
    requeueWithRetry,
    requeueNoRetry,
    failJob,
    ...NO_PHOTO_SWEEP_STUB,
  } as unknown as LocalStore;
  return { store, jobStatus, requeueWithRetry, requeueNoRetry, failJob };
}

describe('QueueService — the two bounds that replaced the retired release fallback (D-02/D11-06)', () => {
  afterEach(() => vi.useRealTimers());

  it('an attempt that ends unapproved and is never retaken is released by grace expiry — BUSY right up to RETAKE_GRACE_MS - 1, IDLE at RETAKE_GRACE_MS with current_job_id cleared', () => {
    vi.useFakeTimers();
    const { store, jobStatus } = buildStore();
    const service = new QueueService(store, CONFIG);
    service.bindSendCommand(() => {});
    service.bindAnnouncement(() => {});

    service.onAgentEvent('processing_start', 'job-1', { param2: COMPOSITE_PATH });
    expect(jobStatus['job-1']).toBe('in_progress'); // D11-02: opens the slot, completes nothing
    service.onAgentEvent('session_end'); // unapproved — opens grace, keeps the booth bound
    expect(store.getBoothState()).toBe('BUSY');

    vi.advanceTimersByTime(CONFIG.RETAKE_GRACE_MS - 1);
    expect(store.getBoothState()).toBe('BUSY');

    vi.advanceTimersByTime(1);
    expect(store.getBoothState()).not.toBe('BUSY');
    expect(store.getBoothCurrentJobId()).toBeUndefined();
    expect(jobStatus['job-1']).toBe('no_photo'); // no file_upload arrived — the grace door's own outcome

    service.stop();
  });

  it('a session that emits nothing after dispatch is still bounded by the session timeout, not RETAKE_GRACE_MS — busyTimer, unchanged by this phase, is what fires', () => {
    vi.useFakeTimers();
    const { store, jobStatus, requeueWithRetry } = buildStore();
    // Start from IDLE with job-1 queued, so the real dispatch path (tick ->
    // announce -> dispatch -> startBusyTimer) is what arms the timer under
    // test, not a hand-reached-into private method.
    store.setBoothIdle();
    jobStatus['job-1'] = 'queued';
    const service = new QueueService(store, CONFIG);
    service.bindSendCommand(() => {});
    service.bindAnnouncement(() => {});
    service.bindIsAgentOnline(() => true);

    service.start();
    vi.advanceTimersByTime(250); // announce job-1
    vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS); // dispatch job-1, booth BUSY
    expect(store.getBoothState()).toBe('BUSY');

    // No session_start ever arrives. Well past RETAKE_GRACE_MS (500ms) but
    // short of SESSION_TIMEOUT_MS (5000ms) — grace was never opened (no
    // session_end arrived, and no attempt was ever open to end), so nothing
    // fires yet.
    vi.advanceTimersByTime(CONFIG.RETAKE_GRACE_MS * 2);
    expect(store.getBoothState()).toBe('BUSY');

    vi.advanceTimersByTime(CONFIG.SESSION_TIMEOUT_MS);
    expect(requeueWithRetry).toHaveBeenCalledWith('job-1');
    expect(jobStatus['job-1']).not.toBe('in_progress');

    service.stop();
  });

  it('processing_start alone starts no release timer of any kind — the retired fallback stays retired: advancing well past its old BOOTH_RELEASE_TIMEOUT_MS default with no session_end leaves the booth exactly as it was', () => {
    vi.useFakeTimers();
    const { store, jobStatus } = buildStore();
    const service = new QueueService(store, CONFIG);
    service.bindSendCommand(() => {});
    service.bindAnnouncement(() => {});

    service.onAgentEvent('processing_start', 'job-1', { param2: COMPOSITE_PATH });
    expect(store.getBoothState()).toBe('BUSY');

    // The old retired fallback used to release the booth after
    // BOOTH_RELEASE_TIMEOUT_MS (120000ms here) from exactly this event, with
    // no session_end required. If it were ever silently reintroduced, this
    // assertion would go red.
    vi.advanceTimersByTime(CONFIG.BOOTH_RELEASE_TIMEOUT_MS + 1_000);
    expect(store.getBoothState()).toBe('BUSY');
    expect(store.getBoothCurrentJobId()).toBe('job-1');
    expect(jobStatus['job-1']).toBe('in_progress');

    service.stop();
  });

  it('service.stop() during an open attempt (before any session_end) leaves zero pending timers — the retired fallback is not lurking behind another entry point', () => {
    vi.useFakeTimers();
    const { store } = buildStore();
    const service = new QueueService(store, CONFIG);
    service.bindSendCommand(() => {});
    service.bindAnnouncement(() => {});

    service.onAgentEvent('processing_start', 'job-1', { param2: COMPOSITE_PATH });
    service.stop();

    expect(vi.getTimerCount()).toBe(0);
  });
});
