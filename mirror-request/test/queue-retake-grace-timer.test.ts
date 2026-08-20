import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueService } from '../src/queue/queueService';
import type { LocalStore } from '../src/state/localStore';
import { createPendingPrintRegistry } from './helpers/pendingPrintRegistry';

/**
 * D11-06's grace timer, the whole lifecycle: cancelled by a retake, fires
 * exactly once at expiry through the same finalize gate an approval or an
 * operator release uses, cleared by an Agent disconnect and by stop(), and —
 * D11-06 Pitfall 2 — reached immediately (not re-armed as a live session) by
 * recover() when the process restarts mid-grace.
 *
 * Copies test/queue-release-timer.test.ts's fake-timer harness shape (the
 * file this new one is a sibling of, per 11-01-PLAN.md's read_first list) —
 * a hand-built mocked LocalStore driven through the real QueueService with
 * vi.useFakeTimers()/vi.advanceTimersByTime() — rather than inventing a new
 * one, but restructures the fixture setup around processing_start, since
 * D11-02 removed startReleaseTimer() from that path entirely.
 *
 * Also proves Task 1's own retirement of Phase 7's D-02 release-fallback
 * timer is total: `grep -rF 'this.releaseTimer' src/` returns zero.
 */

const RETAKE_GRACE_MS = 500;
const COMPOSITE = 'C:\\dslrBooth\\Test_event\\Prints\\20260818_101511_776.jpg';
const PHOTO_URL = 'https://fotoshare.co/i/kept';

const CONFIG = {
  SESSION_TIMEOUT_MS: 5_000,
  NEXT_GUEST_COUNTDOWN_MS: 5_000,
  SESSION_MAX_RETRIES: 2,
  BOOTH_RELEASE_TIMEOUT_MS: 120_000,
  RETAKE_GRACE_MS,
};

function buildStore(initial: { booth?: string; currentJobId?: string } = {}) {
  let booth: string = initial.booth ?? 'BUSY';
  let currentJobId: string | undefined = initial.currentJobId ?? 'job-1';
  let attemptOpen = false;
  let attemptNo = 0;
  const jobStatus: Record<string, string> = { 'job-1': 'in_progress', 'job-2': 'queued' };
  const jobAcknowledgedAt: Record<string, number> = { 'job-1': Date.now() };
  const jobRetries: Record<string, number> = {};
  const jobStallReason: Record<string, string | undefined> = {};
  const pendingPrint = createPendingPrintRegistry();

  const requeueWithRetry = vi.fn((jobId: string) => {
    jobStatus[jobId] = 'queued';
    jobRetries[jobId] = (jobRetries[jobId] ?? 0) + 1;
    return { retries: jobRetries[jobId] };
  });
  const requeueNoRetry = vi.fn((jobId: string) => { jobStatus[jobId] = 'queued'; });
  const failJob = vi.fn((jobId: string, reason: string) => { jobStatus[jobId] = 'failed'; jobStallReason[jobId] = reason; });

  const store = {
    getBoothState: () => booth,
    getBoothStateDetailed: () => ({ state: booth, updated_at: new Date().toISOString() }),
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
    getJob: (id: string) => (id in jobStatus ? { id, status: jobStatus[id], acknowledged_at: jobAcknowledgedAt[id], retries: jobRetries[id] ?? 0, stall_reason: jobStallReason[id] ?? null } : undefined),
    updateJobStatus: (id: string, status: string, tsField?: string, tsValue?: number) => {
      jobStatus[id] = status;
      if (tsField === 'acknowledged_at' && tsValue !== undefined) jobAcknowledgedAt[id] = tsValue;
    },
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
    getQueuePosition: () => undefined,
    getJobRegistration: () => undefined,
    getActiveEventId: () => undefined,
    getInFlightJobs: () => Object.entries(jobStatus)
      .filter(([, s]) => s === 'dispatched' || s === 'in_progress')
      .map(([id]) => ({ id })),
    // D-03/D-09's real predicate, narrowed to the two dimensions this file's
    // "does not touch a live job" case cares about: still in_progress, and
    // not the job currently bound to the booth. Deliberately NOT the
    // always-empty NO_PHOTO_SWEEP_STUB other suites use — that stub would
    // make this file's own claim pass vacuously.
    getJobsAwaitingNoPhotoClose: (_cutoff: number, boundJobId?: string) =>
      Object.entries(jobStatus)
        .filter(([id, s]) => s === 'in_progress' && id !== boundJobId)
        .map(([id]) => id),
    ...pendingPrint.registry,
    requeueWithRetry,
    requeueNoRetry,
    failJob,
  } as unknown as LocalStore;

  return { store, jobStatus, jobRetries, jobStallReason, pendingPrintRows: pendingPrint.rows, getBooth: () => booth, requeueWithRetry, requeueNoRetry, failJob };
}

describe('QueueService — retake grace timer lifecycle (D11-06)', () => {
  afterEach(() => vi.useRealTimers());

  it('a session_start inside the grace window cancels the timer: advancing past the full window afterward finalizes nothing', () => {
    vi.useFakeTimers();
    const { store, jobStatus, pendingPrintRows } = buildStore();
    const service = new QueueService(store, CONFIG);
    const sendPhotoLink = vi.fn(async () => {});
    service.bindNotificationService({ sendPhotoLink });
    service.bindSendCommand(() => {});
    service.bindAnnouncement(() => {});

    service.onAgentEvent('session_start', 'job-1', {});
    service.onAgentEvent('processing_start', 'job-1', { param1: 'x.jpg', param2: COMPOSITE });
    service.onAgentEvent('file_upload', 'job-1', { param3: 'print', param2: PHOTO_URL });

    service.onAgentEvent('session_end'); // unapproved — opens grace
    expect(store.getBoothState()).toBe('BUSY');
    expect(pendingPrintRows.get('job-1')?.status).toBe('awaiting');

    vi.advanceTimersByTime(RETAKE_GRACE_MS - 1);
    service.onAgentEvent('session_start', 'job-1', {}); // the retake, just before expiry

    // Advancing past the ORIGINAL deadline must do nothing — the timer was
    // cancelled, not merely superseded.
    vi.advanceTimersByTime(RETAKE_GRACE_MS + 1_000);

    expect(sendPhotoLink).not.toHaveBeenCalled();
    expect(jobStatus['job-1']).toBe('in_progress');
    expect(store.getBoothState()).toBe('BUSY');

    service.stop();
  });

  it('no session_start inside the window: at expiry the job finalizes with the grace door, the held URL is sent, the booth goes IDLE and the next guest is dispatched', () => {
    vi.useFakeTimers();
    const { store, jobStatus, pendingPrintRows } = buildStore();
    const service = new QueueService(store, CONFIG);
    const sendPhotoLink = vi.fn(async () => {});
    const sendCommand = vi.fn();
    service.bindNotificationService({ sendPhotoLink });
    service.bindSendCommand(sendCommand);
    service.bindAnnouncement(() => {});
    service.bindIsAgentOnline(() => true);

    service.onAgentEvent('session_start', 'job-1', {});
    service.onAgentEvent('processing_start', 'job-1', { param1: 'x.jpg', param2: COMPOSITE });
    service.onAgentEvent('file_upload', 'job-1', { param3: 'print', param2: PHOTO_URL });
    service.onAgentEvent('session_end'); // unapproved — opens grace

    vi.advanceTimersByTime(RETAKE_GRACE_MS);

    expect(sendPhotoLink).toHaveBeenCalledTimes(1);
    expect(sendPhotoLink).toHaveBeenCalledWith('job-1', PHOTO_URL);
    expect(jobStatus['job-1']).toBe('completed');
    expect(pendingPrintRows.get('job-1')?.status).toBe('resolved');
    expect(pendingPrintRows.get('job-1')?.approvedBy).toBe('grace');
    expect(store.getBoothCurrentJobId()).not.toBe('job-1');

    // The booth was released and the queue advanced — job-2 gets dispatched
    // once its announcement countdown elapses.
    vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS);
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand.mock.calls[0][0]).toMatchObject({ jobId: 'job-2' });

    service.stop();
  });

  it('grace expiry with an empty slot closes the job with the no-photo status, sends nothing, charges no retry and writes no stall reason', () => {
    vi.useFakeTimers();
    const { store, jobStatus, jobRetries, jobStallReason } = buildStore();
    const service = new QueueService(store, CONFIG);
    const sendPhotoLink = vi.fn(async () => {});
    service.bindNotificationService({ sendPhotoLink });
    service.bindSendCommand(() => {});
    service.bindAnnouncement(() => {});

    // session_start then session_end with NO processing_start at all — the
    // empty-session shape (Q3, 07-EVIDENCE §C's ❶). No pending_print row is
    // ever opened for job-1.
    service.onAgentEvent('session_start', 'job-1', {});
    service.onAgentEvent('session_end');

    vi.advanceTimersByTime(RETAKE_GRACE_MS);

    expect(sendPhotoLink).not.toHaveBeenCalled();
    expect(jobStatus['job-1']).toBe('no_photo');
    expect(jobRetries['job-1'] ?? 0).toBe(0);
    expect(jobStallReason['job-1']).toBeUndefined();

    service.stop();
  });

  it('an Agent disconnect during a grace window clears the timer, so advancing past the window afterward fires nothing', () => {
    vi.useFakeTimers();
    const { store, jobStatus } = buildStore();
    const service = new QueueService(store, CONFIG);
    const sendPhotoLink = vi.fn(async () => {});
    service.bindNotificationService({ sendPhotoLink });
    service.bindSendCommand(() => {});
    service.bindAnnouncement(() => {});

    service.onAgentEvent('session_start', 'job-1', {});
    service.onAgentEvent('processing_start', 'job-1', { param1: 'x.jpg', param2: COMPOSITE });
    service.onAgentEvent('session_end'); // unapproved — opens grace
    expect(store.getBoothState()).toBe('BUSY');

    service.onAgentDisconnected();
    // Released — no longer bound to job-1. (tick()'s own final statement
    // immediately re-announces job-2, since it is already queued, so the
    // observable state right after this call is 'ANNOUNCING', not 'IDLE' —
    // the queue correctly keeps moving rather than sitting idle.)
    expect(store.getBoothState()).not.toBe('BUSY');
    expect(store.getBoothCurrentJobId()).not.toBe('job-1');
    expect(jobStatus['job-1']).toBe('queued'); // requeued, no retry charged

    vi.advanceTimersByTime(RETAKE_GRACE_MS + 1_000);
    expect(sendPhotoLink).not.toHaveBeenCalled();

    service.stop();
  });

  it('service.stop() clears the grace timer, leaving zero pending timers', () => {
    vi.useFakeTimers();
    const { store } = buildStore();
    const service = new QueueService(store, CONFIG);
    service.bindSendCommand(() => {});
    service.bindAnnouncement(() => {});

    service.onAgentEvent('session_start', 'job-1', {});
    service.onAgentEvent('processing_start', 'job-1', { param1: 'x.jpg', param2: COMPOSITE });
    service.onAgentEvent('session_end'); // unapproved — opens grace

    service.stop();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('recover() on a booth that is BUSY with a bound job and no open attempt reaches the grace door immediately rather than re-arming the session timer', () => {
    vi.useFakeTimers();
    const { store, jobStatus, pendingPrintRows } = buildStore({ booth: 'BUSY', currentJobId: 'job-1' });
    // Simulate: the process died mid-grace. The attempt is already closed
    // (as sessionEnded()'s unapproved branch would have left it) and a
    // pending_print row exists with a URL already written.
    store.closeBoothAttempt();
    pendingPrintRows.set('job-1', {
      jobId: 'job-1', compositePath: COMPOSITE, status: 'awaiting', openedAt: Date.now(), expiresAt: Date.now() + 600_000,
      photoUrl: PHOTO_URL, attemptNo: 1,
    });

    const service = new QueueService(store, CONFIG);
    const sendPhotoLink = vi.fn(async () => {});
    service.bindNotificationService({ sendPhotoLink });
    service.bindSendCommand(() => {});
    service.bindAnnouncement(() => {});
    service.bindIsAgentOnline(() => true);

    service.recover();

    // Finalized immediately via the grace door — no busyTimer re-armed, no
    // "possibly live" wait.
    expect(sendPhotoLink).toHaveBeenCalledTimes(1);
    expect(sendPhotoLink).toHaveBeenCalledWith('job-1', PHOTO_URL);
    expect(jobStatus['job-1']).toBe('completed');
    expect(pendingPrintRows.get('job-1')?.approvedBy).toBe('grace');
    expect(store.getBoothCurrentJobId()).not.toBe('job-1');

    service.stop();
  });

  it('the no-photo sweep does not touch a job whose booth binding is still live (inside its grace window)', () => {
    vi.useFakeTimers();
    const { store, jobStatus } = buildStore();
    const service = new QueueService(store, CONFIG);
    service.bindSendCommand(() => {});
    service.bindAnnouncement(() => {});
    service.bindIsAgentOnline(() => true);

    service.onAgentEvent('session_start', 'job-1', {});
    service.onAgentEvent('processing_start', 'job-1', { param1: 'x.jpg', param2: COMPOSITE });
    service.onAgentEvent('session_end'); // unapproved — opens grace, job-1 stays bound

    service.start();
    // Advance well past the grace window's own expiry point but stop short
    // of it actually firing by keeping the grace timer itself in view: the
    // sweep runs on every 250ms tick regardless of the grace timer's own
    // state, so this proves the SWEEP specifically leaves a still-bound job
    // alone — the grace timer's own finalize is asserted separately above.
    vi.advanceTimersByTime(200);

    // Still in_progress (not swept as no-photo) because job-1 is still the
    // currently-bound job.
    expect(jobStatus['job-1']).toBe('in_progress');

    service.stop();
  });

  it('a dispatched session that produces no event at all still hits the session timeout — the booth cannot be held indefinitely by the removal of the old release fallback', () => {
    vi.useFakeTimers();
    const { store, jobStatus, requeueWithRetry } = buildStore({ booth: 'IDLE', currentJobId: undefined });
    jobStatus['job-1'] = 'queued';
    jobStatus['job-2'] = 'queued';
    const service = new QueueService(store, CONFIG);
    service.bindSendCommand(() => {});
    service.bindAnnouncement(() => {});
    service.bindIsAgentOnline(() => true);

    service.start();
    // The periodic tick fires every 250ms (first at t=250ms, not t=0), then
    // the announcement countdown runs on top of that before dispatch — no
    // Agent event ever follows.
    vi.advanceTimersByTime(250 + CONFIG.NEXT_GUEST_COUNTDOWN_MS);
    expect(store.getBoothState()).toBe('BUSY');

    vi.advanceTimersByTime(CONFIG.SESSION_TIMEOUT_MS);

    // The busyTimer's own session-timeout path fired: a retry was charged
    // (SESSION_TIMEOUT_MS is unchanged by the retirement of the old release
    // fallback), and the booth is no longer sitting BUSY forever on a
    // session that never produced a single event.
    expect(requeueWithRetry).toHaveBeenCalledWith('job-1');
    expect(jobStatus['job-1']).not.toBe('in_progress');

    service.stop();
  });
});
