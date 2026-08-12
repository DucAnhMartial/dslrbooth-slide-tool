import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueService, queueLogger } from '../src/queue/queueService';
import { LocalStore } from '../src/state/localStore';
import { createPendingPrintRegistry } from './helpers/pendingPrintRegistry';

/**
 * SC-3 / D-03 / D-09. A session that ends with no print composite ever seen
 * must resolve to its own outcome — not to 'completed' (which would make it
 * indistinguishable from a successful session and would poison the guests'
 * wait estimate), and not to a stall (which would charge the guest a retry and
 * call them back to a camera they have already walked away from).
 *
 * The store is mocked at the SQLite seam, the same seam
 * queue-dual-completion.test.ts uses, because what is under test here is the
 * SERVICE's branching: which store writers the session_end path calls, and
 * which it must never call. The SQL those writers stand for is proved
 * separately against a real temp-file database in
 * test/local-store-persistence.test.ts. Neither file substitutes for the other.
 */

const COMPOSITE_PATH = 'C:\\dslrBooth\\Test_event\\Prints\\20260812_143526_970.jpg';

function buildStore() {
  const boothSequence: string[] = ['IDLE'];
  let booth = 'IDLE';
  const queued = [
    { id: 'job-1', name: 'Guest One' },
    { id: 'job-2', name: 'Guest Two' },
  ];
  const jobStatus: Record<string, string> = { 'job-1': 'queued', 'job-2': 'queued' };
  let currentJobId: string | undefined;

  const pushState = (state: string) => {
    booth = state;
    boothSequence.push(state);
  };

  const completeJob = vi.fn((jobId: string) => {
    if (jobStatus[jobId] !== 'in_progress') return false;
    jobStatus[jobId] = 'completed';
    return true;
  });

  // Mirrors the real SQL's `AND status = 'in_progress'` predicate: a terminal
  // row matches zero rows and the call reports false.
  const closeJobNoPhoto = vi.fn((jobId: string) => {
    if (jobStatus[jobId] !== 'in_progress') return false;
    jobStatus[jobId] = 'no_photo';
    return true;
  });

  const requeueWithRetry = vi.fn();
  const requeueNoRetry = vi.fn();
  const failJob = vi.fn();
  const setBoothTimeout = vi.fn(() => { pushState('IDLE'); currentJobId = undefined; });

  const store = {
    getBoothState: () => booth,
    getBoothStateDetailed: () => ({ state: booth, updated_at: new Date().toISOString() }),
    getInFlightJobs: () => [],
    getNextQueuedJob: () => {
      const next = queued.find((j) => jobStatus[j.id] === 'queued');
      return next ? { id: next.id } : undefined;
    },
    setBoothState: (state: string) => { pushState(state); currentJobId = undefined; },
    setBoothBusy: (jobId?: string | null) => { pushState('BUSY'); currentJobId = jobId ?? undefined; },
    setBoothIdle: () => { pushState('IDLE'); currentJobId = undefined; },
    setBoothTimeout,
    getBoothCurrentJobId: () => currentJobId,
    setBoothCurrentJob: (jobId: string | null) => { currentJobId = jobId ?? undefined; },
    getJob: (id: string) => (id in jobStatus ? { id, status: jobStatus[id] } : undefined),
    updateJobStatus: (id: string, status: string) => { jobStatus[id] = status; },
    getQueuedGuestSummaries: () =>
      queued
        .filter((j) => jobStatus[j.id] === 'queued')
        .map((j, index) => ({ jobId: j.id, name: j.name, position: index + 1 })),
    getQueueLength: () => queued.filter((j) => jobStatus[j.id] === 'queued').length,
    completeJob,
    closeJobNoPhoto,
    getQueuePosition: () => 1,
    ...createPendingPrintRegistry().registry,
    getJobRegistration: (jobId: string) => ({
      job: { id: jobId },
      registration: { id: 'reg-1', name: 'Guest', email: '', phone: '', mode: 'boomerang', registered_at: '' },
    }),
    requeueWithRetry,
    requeueNoRetry,
    failJob,
  } as unknown as LocalStore;

  return {
    store,
    boothSequence,
    jobStatus,
    completeJob,
    closeJobNoPhoto,
    requeueWithRetry,
    requeueNoRetry,
    failJob,
    setBoothTimeout,
  };
}

/** Drives the real dispatch path up to "job-1 is in_progress at the booth". */
function startSession(store: LocalStore) {
  const service = new QueueService(store);
  service.bindSendCommand(() => {});
  service.start();
  vi.advanceTimersByTime(250); // announce job-1
  vi.advanceTimersByTime(7_000); // dispatch job-1, booth BUSY
  service.onAgentEvent('session_start', 'job-1');
  return service;
}

describe('QueueService — a session that produced no photo (SC-3, D-03/D-09)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('closes the job as no_photo when session_end arrives with no print composite ever seen', () => {
    vi.useFakeTimers();
    const { store, jobStatus, closeJobNoPhoto } = buildStore();
    const service = startSession(store);

    expect(jobStatus['job-1']).toBe('in_progress');

    service.onAgentEvent('session_end');

    expect(closeJobNoPhoto).toHaveBeenCalledTimes(1);
    expect(closeJobNoPhoto).toHaveBeenCalledWith('job-1', expect.any(Number));
    expect(jobStatus['job-1']).toBe('no_photo');
  });

  it('still releases the booth and dispatches the next guest — the queue is not stalled by the outcome', () => {
    vi.useFakeTimers();
    const { store, boothSequence, jobStatus } = buildStore();
    const service = startSession(store);

    service.onAgentEvent('session_end');

    // The booth went IDLE (the release), then straight into ANNOUNCING for the
    // next guest via the tick that follows it.
    expect(boothSequence).toContain('IDLE');
    expect(store.getBoothState()).toBe('ANNOUNCING');
    expect(service.getAnnouncement()?.jobId).toBe('job-2');

    vi.advanceTimersByTime(7_000);
    expect(store.getBoothState()).toBe('BUSY');
    service.onAgentEvent('session_start', 'job-2');
    expect(jobStatus['job-2']).toBe('in_progress');
  });

  it('charges no retry and writes no stall reason — no retry writer is called at all (D-03, T-07-18)', () => {
    vi.useFakeTimers();
    const { store, requeueWithRetry, requeueNoRetry, failJob, setBoothTimeout } = buildStore();
    const service = startSession(store);

    service.onAgentEvent('session_end');

    // The three call-count-zero spies ARE the guarantee. A guest whose session
    // produced nothing is not called back to the camera, and the outcome is
    // not recorded as a stall.
    expect(requeueWithRetry).not.toHaveBeenCalled();
    expect(requeueNoRetry).not.toHaveBeenCalled();
    expect(failJob).not.toHaveBeenCalled();
    // handleStall() is reachable only through the busy timer; setBoothTimeout
    // is its booth-side effect, so its absence pins that handleStall() was
    // never entered from this path either.
    expect(setBoothTimeout).not.toHaveBeenCalled();
  });

  it('emits one warning that names the job and is distinguishable from the registry-expiry warning', () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(queueLogger, 'warn').mockImplementation(() => undefined as never);
    const { store } = buildStore();
    const service = startSession(store);

    service.onAgentEvent('session_end');

    const lines = warnSpy.mock.calls.map((call) => String(call[0]));
    const noPhotoLines = lines.filter((line) => line.includes('job-1'));
    expect(noPhotoLines).toHaveLength(1);
    // 07-03's expiry warning means "a composite was produced but its upload
    // never arrived". This one means "no composite was ever produced". An
    // operator must be able to tell them apart at a glance, so this wording
    // must not be the expiry warning's wording.
    expect(noPhotoLines[0]).not.toContain('No print upload seen');
    expect(noPhotoLines[0].toLowerCase()).toContain('no print composite');
  });

  it('does NOT close as no_photo when the print composite already completed the job', () => {
    vi.useFakeTimers();
    const { store, jobStatus, closeJobNoPhoto, completeJob } = buildStore();
    const service = startSession(store);

    service.onAgentEvent('processing_start', 'job-1', { param5: COMPOSITE_PATH });
    expect(completeJob).toHaveBeenCalledTimes(1);
    expect(jobStatus['job-1']).toBe('completed');

    service.onAgentEvent('session_end');

    // The contrasting case. The job is already terminal, so the no-photo
    // branch must not be entered at all — not merely be absorbed by the SQL
    // predicate afterwards.
    expect(closeJobNoPhoto).not.toHaveBeenCalled();
    expect(jobStatus['job-1']).toBe('completed');
  });

  it('a stray duplicate session_end after a no-photo close does not call the writer again', () => {
    vi.useFakeTimers();
    const { store, jobStatus, closeJobNoPhoto } = buildStore();
    const service = startSession(store);

    service.onAgentEvent('session_end');
    expect(closeJobNoPhoto).toHaveBeenCalledTimes(1);
    closeJobNoPhoto.mockClear();

    // dslrBooth fires session_end on every exit from the sharing screen —
    // measured 3x in 52s for one session. By now the booth holds no job, so
    // the stray must have no effect whatsoever.
    service.onAgentEvent('session_end');

    expect(closeJobNoPhoto).not.toHaveBeenCalled();
    expect(jobStatus['job-1']).toBe('no_photo');
  });

  it('a stray session_start cannot resurrect a job already closed as no_photo', () => {
    vi.useFakeTimers();
    const { store, jobStatus } = buildStore();
    const service = startSession(store);

    service.onAgentEvent('session_end');
    expect(jobStatus['job-1']).toBe('no_photo');

    service.onAgentEvent('session_start', 'job-1');

    // The terminal-state guard added in 07-01 must treat the sixth status as
    // terminal too, or a stray session_start would write a closed job back to
    // in_progress and it would hang there forever.
    expect(jobStatus['job-1']).toBe('no_photo');
  });
});
