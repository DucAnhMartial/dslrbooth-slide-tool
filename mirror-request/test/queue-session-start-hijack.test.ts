import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueService, queueLogger } from '../src/queue/queueService';
import { LocalStore } from '../src/state/localStore';
import { createPendingPrintRegistry } from './helpers/pendingPrintRegistry';

/**
 * CR-01 and WR-01 from 07-REVIEW.md.
 *
 * CR-01 is the half of WINDOWS-8 that phase 7 left open. 07-01 gave
 * sessionAcked() a TERMINAL-status guard, which stops a stray session_start
 * resurrecting a job that already finished. It does nothing about a stray
 * session_start naming a DIFFERENT, still-live job: that call rebinds
 * booth_state.current_job_id unconditionally, so the guest who actually holds
 * the booth is silently unbound while still in_progress — and the sweep added
 * in 07-04 then closes them as no_photo, a terminal, guest-visible outcome for
 * someone who did nothing wrong and was genuinely photographed.
 *
 * The premise is not hypothetical. onPrintComposite()'s own doc comment states
 * that "the Agent stamps a stale activeJobId on every forwarded event and never
 * clears it", which is exactly why THAT handler cross-checks the event's jobId
 * against current_job_id (D-06). session_start reached sessionAcked() with no
 * such check. 07-EVIDENCE-dslrbooth-triggers.md:71-79 records this as the
 * untested hypothesis behind the unexplained BZWCWFN6 incident.
 *
 * The ack path (onAgentAck) is deliberately NOT guarded: its jobId is the id
 * this service itself just dispatched, so it is trustworthy by construction and
 * is the one call that legitimately establishes a new binding.
 *
 * D11-01/D11-06 (phase 11): sessionAckedFromEvent() gained a retake branch —
 * a session_start naming the SAME job the booth is already bound to, with an
 * attempt already counted (attempt_no >= 1), is a retake, not a hijack, and
 * must NOT be refused the way a different job's stray session_start is. This
 * file's mocked store now carries booth_state's attempt fields
 * (getBoothAttempt/openBoothAttempt/closeBoothAttempt) so the retake branch
 * can run at all, and every case that used to complete a job directly off
 * `processing_start` now routes through the finalize gate (`printing`,
 * D11-05) instead — completion moved, the guarantees under test did not.
 */

const COMPOSITE_PATH = 'C:\\dslrBooth\\Test_event\\Prints\\20260812_143526_970.jpg';

const CONFIG = {
  SESSION_TIMEOUT_MS: 300_000,
  NEXT_GUEST_COUNTDOWN_MS: 7_000,
  SESSION_MAX_RETRIES: 2,
  BOOTH_RELEASE_TIMEOUT_MS: 120_000,
  RETAKE_GRACE_MS: 3_000,
};

function buildStore(jobIds: string[] = ['job-1', 'job-2']) {
  let booth = 'IDLE';
  let attemptOpen = false;
  let attemptNo = 0;
  const queued = jobIds.map((id, i) => ({ id, name: `Guest ${i + 1}` }));
  const jobStatus: Record<string, string> = Object.fromEntries(jobIds.map((id) => [id, 'queued']));
  const acknowledgedAt: Record<string, number> = {};
  let currentJobId: string | undefined;

  const registry = createPendingPrintRegistry();

  const completeJob = vi.fn((jobId: string) => {
    if (jobStatus[jobId] !== 'in_progress') return false;
    jobStatus[jobId] = 'completed';
    return true;
  });

  const closeJobNoPhoto = vi.fn((jobId: string) => {
    if (jobStatus[jobId] !== 'in_progress') return false;
    jobStatus[jobId] = 'no_photo';
    return true;
  });

  // Mirrors the real writer: the status goes back to 'queued' so the job is a
  // genuine redispatch candidate. WR-01's whole point is what survives ACROSS
  // that boundary, so a no-op mock would hide the defect.
  const requeueWithRetry = vi.fn((jobId: string) => {
    jobStatus[jobId] = 'queued';
    delete acknowledgedAt[jobId];
    return { retries: 0 };
  });

  const openBoothAttempt = vi.fn(() => { attemptOpen = true; attemptNo += 1; return { attemptOpen, attemptNo }; });

  const store = {
    getBoothState: () => booth,
    getBoothStateDetailed: () => ({ state: booth, updated_at: new Date().toISOString() }),
    getInFlightJobs: () => [],
    getNextQueuedJob: () => {
      const next = queued.find((j) => jobStatus[j.id] === 'queued');
      return next ? { id: next.id } : undefined;
    },
    setBoothState: (state: string) => { booth = state; currentJobId = undefined; attemptOpen = false; attemptNo = 0; },
    setBoothBusy: (jobId?: string | null) => { booth = 'BUSY'; currentJobId = jobId ?? undefined; attemptOpen = false; attemptNo = 0; },
    setBoothIdle: () => { booth = 'IDLE'; currentJobId = undefined; attemptOpen = false; attemptNo = 0; },
    setBoothTimeout: vi.fn(() => { booth = 'IDLE'; currentJobId = undefined; attemptOpen = false; attemptNo = 0; }),
    getBoothCurrentJobId: () => currentJobId,
    setBoothCurrentJob: (jobId: string | null) => { currentJobId = jobId ?? undefined; },
    getBoothAttempt: () => ({ attemptOpen, attemptNo }),
    openBoothAttempt,
    closeBoothAttempt: () => { attemptOpen = false; },
    getJob: (id: string) => (id in jobStatus
      ? { id, status: jobStatus[id], acknowledged_at: acknowledgedAt[id] }
      : undefined),
    updateJobStatus: (id: string, status: string, column?: string, value?: number) => {
      jobStatus[id] = status;
      if (column === 'acknowledged_at' && typeof value === 'number') acknowledgedAt[id] = value;
    },
    getQueuedGuestSummaries: () => queued
      .filter((j) => jobStatus[j.id] === 'queued')
      .map((j, index) => ({ jobId: j.id, name: j.name, position: index + 1 })),
    getQueueLength: () => queued.filter((j) => jobStatus[j.id] === 'queued').length,
    completeJob,
    closeJobNoPhoto,
    getJobsAwaitingNoPhotoClose: vi.fn(() => [] as string[]),
    getQueuePosition: () => 1,
    ...registry.registry,
    getJobRegistration: (jobId: string) => ({
      job: { id: jobId },
      registration: {
        id: 'reg-1', name: 'Guest', email: '', phone: '', mode: 'boomerang', registered_at: '',
      },
    }),
    getActiveEventId: () => undefined,
    requeueWithRetry,
    requeueNoRetry: vi.fn(),
    failJob: vi.fn(),
  } as unknown as LocalStore;

  return { store, jobStatus, completeJob, closeJobNoPhoto, requeueWithRetry, openBoothAttempt, currentJobId: () => currentJobId };
}

/** Drives the real dispatch path up to "job-1 is in_progress and holds the booth". */
function startSession(store: LocalStore) {
  const service = new QueueService(store, CONFIG);
  service.bindSendCommand(() => {});
  service.bindAnnouncement(() => {});
  service.start();
  vi.advanceTimersByTime(250);   // announce job-1
  vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS); // dispatch job-1, booth BUSY
  service.onAgentEvent('session_start', 'job-1');
  return service;
}

describe('CR-01 — a stray session_start must not steal the booth from a live guest', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('ignores a session_start naming a different, still-queued job while a guest is live', () => {
    vi.useFakeTimers();
    const { store, jobStatus, currentJobId } = buildStore();
    const service = startSession(store);

    expect(jobStatus['job-1']).toBe('in_progress');
    expect(currentJobId()).toBe('job-1');

    // The stale-activeJobId shape: an event naming job-2, which has never been
    // dispatched, announced, or had its guest called to the booth.
    service.onAgentEvent('session_start', 'job-2');

    // The booth must still belong to the guest who is actually standing at it.
    expect(currentJobId()).toBe('job-1');
    expect(jobStatus['job-1']).toBe('in_progress');
    expect(jobStatus['job-2']).toBe('queued');

    service.stop();
  });

  it('leaves the live guest completable — their own print composite, and the printing that approves it, are not rejected as a mismatch', () => {
    vi.useFakeTimers();
    const { store, jobStatus, completeJob } = buildStore();
    const service = startSession(store);

    service.onAgentEvent('session_start', 'job-2');

    // Before the fix the booth was bound to job-2, so job-1's own genuine
    // composite failed onPrintComposite()'s D-06 cross-check and the guest was
    // never completed — they were photographed and then swept as no_photo.
    // D11-02/D11-05 (phase 11): completion now requires the composite AND the
    // approving `printing`, both routed through the same D-06 cross-check —
    // both must survive the stray job-2 event exactly the way the bare
    // composite used to.
    service.onAgentEvent('processing_start', 'job-1', { param5: COMPOSITE_PATH });
    expect(jobStatus['job-1']).toBe('in_progress'); // D11-02: not completed yet
    service.onAgentEvent('file_upload', 'job-1', { param3: 'print', param2: 'https://fotoshare.co/i/1my7bcw' });
    service.onAgentEvent('printing', 'job-1', { param1: COMPOSITE_PATH });

    expect(completeJob).toHaveBeenCalledWith('job-1', expect.any(Number));
    expect(jobStatus['job-1']).toBe('completed');

    service.stop();
  });

  it('warns once, naming both ids, so the mismatch is greppable', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(queueLogger, 'warn').mockImplementation(() => queueLogger);
    const { store } = buildStore();
    const service = startSession(store);

    service.onAgentEvent('session_start', 'job-2');

    const mismatch = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('job-2'));
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]).toContain('job-1');

    service.stop();
  });

  it('still binds the booth on the very first session_start, when nothing is bound yet', () => {
    vi.useFakeTimers();
    const { store, jobStatus, currentJobId } = buildStore();
    const service = new QueueService(store, CONFIG);
    service.bindSendCommand(() => {});
    service.bindAnnouncement(() => {});
    service.start();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS);

    // The normal path must be untouched: this is the guard's own non-vacuity
    // check. A guard that rejected everything would pass the three cases above
    // and break every real session.
    service.onAgentEvent('session_start', 'job-1');

    expect(currentJobId()).toBe('job-1');
    expect(jobStatus['job-1']).toBe('in_progress');

    service.stop();
  });

  // D11-01/D11-06 (phase 11): the new retake branch is a SECOND door into
  // sessionAckedFromEvent(), and it must not weaken the terminal-state guard
  // that sessionAcked() already enforces on the other door. `attemptNo >= 1`
  // alone is not proof of a legitimate retake — it is only proof that at
  // least one attempt was ever opened for this job. This pins that a job
  // whose own row is already terminal is refused through this branch too,
  // even in the (should-never-happen, but not proof-checked away) shape
  // where the booth is still bound to it with an attempt already counted.
  it('a session_start naming a job that is already completed is still refused, even through the retake branch, while the booth remains (unexpectedly) bound to that same job id with an attempt already counted', () => {
    vi.useFakeTimers();
    const { store, jobStatus, openBoothAttempt } = buildStore();
    const service = startSession(store); // job-1 in_progress, bound, attempt_no=1

    // Simulate the row reaching a terminal state independently of the booth
    // binding — e.g. a defect elsewhere, or a future door this guard must
    // not have to trust. The booth is still bound to job-1 with attempt_no
    // already at 1, which is exactly the shape the bare `attemptNo >= 1`
    // check cannot, by itself, tell apart from a legitimate retake.
    jobStatus['job-1'] = 'completed';
    openBoothAttempt.mockClear();

    service.onAgentEvent('session_start', 'job-1');

    expect(jobStatus['job-1']).toBe('completed'); // unchanged
    // The retake branch must not have run: no new attempt opened.
    expect(openBoothAttempt).not.toHaveBeenCalled();

    service.stop();
  });
});

describe('WR-01 — captureCounts must not survive a stall into the next dispatch', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reports only the retry attempt\'s captures, not the abandoned attempt\'s', () => {
    vi.useFakeTimers();
    const info = vi.spyOn(queueLogger, 'info').mockImplementation(() => queueLogger);
    const { store, requeueWithRetry } = buildStore(['job-1']);
    const service = startSession(store);

    // Two shots, then the camera hangs and the busy timer stalls the session.
    service.onAgentEvent('capture_start', 'job-1');
    service.onAgentEvent('capture_start', 'job-1');
    vi.advanceTimersByTime(CONFIG.SESSION_TIMEOUT_MS);
    expect(requeueWithRetry).toHaveBeenCalledWith('job-1');

    // Same jobId is redispatched (requeueWithRetry preserves it, D-06).
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS);
    service.onAgentEvent('session_start', 'job-1');
    service.onAgentEvent('capture_start', 'job-1');
    service.onAgentEvent('processing_start', 'job-1', { param5: COMPOSITE_PATH });
    // D11-02/D11-05: the composite alone no longer closes the session (and
    // therefore no longer logs the summary) — an approving printing does.
    service.onAgentEvent('printing', 'job-1', { param1: COMPOSITE_PATH });

    const summary = info.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.startsWith('SESSION_SUMMARY') && m.includes('job=job-1'));

    expect(summary).toBeDefined();
    // Three capture_start events fired in total; only one belongs to the
    // session being closed here.
    expect(summary).toContain('captures=1');

    service.stop();
  });
});
