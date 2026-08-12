import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueService, queueLogger } from '../src/queue/queueService';
import { LocalStore } from '../src/state/localStore';
import { createPendingPrintRegistry } from './helpers/pendingPrintRegistry';

// SC-2, the phase's tracer. `completeInProgressJob()` used to select the
// most-recently-acknowledged in_progress row with no jobId parameter at all
// — with a queue behind the booth, guest A's second session_end completed
// guest B (WINDOWS item 8, job BZWCWFN6). This file drives two real guests
// through the REAL QueueService dispatch path (announce -> dispatch ->
// session_start -> print composite -> session_end), with only the SQLite
// handle mocked — the same seam test/queue-countdown.test.ts's "booth state
// transitions" block has used since Phase 2 to prove booth-state sequencing.
// See 07-01-PLAN.md <sc2_reconciliation> for why this mocked-store proof and
// local-store-persistence.test.ts's real-database companion are both
// required and neither is a substitute for the other.

const COMPOSITE_PATH = 'C:\\dslrBooth\\Test_event\\Prints\\20260812_143526_970.jpg';

function buildStore() {
  const boothSequence: string[] = ['IDLE'];
  let booth = 'IDLE';
  const queued = [
    { id: 'job-1', name: 'Guest One' },
    { id: 'job-2', name: 'Guest Two' },
  ];
  const jobStatus: Record<string, string> = { 'job-1': 'queued', 'job-2': 'queued' };
  // 07-05 D-14: the summary line's duration is Date.now() - acknowledged_at, so
  // the mock has to record the timestamp updateJobStatus() is given and hand it
  // back through getJob(). Purely additive — nothing above reads it.
  const acknowledgedAt: Record<string, number> = {};
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

  // Mirrors the real SQL's `AND status = 'in_progress'` predicate (07-04).
  const closeJobNoPhoto = vi.fn((jobId: string) => {
    if (jobStatus[jobId] !== 'in_progress') return false;
    jobStatus[jobId] = 'no_photo';
    return true;
  });

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
    setBoothTimeout: () => { pushState('IDLE'); currentJobId = undefined; },
    getBoothCurrentJobId: () => currentJobId,
    setBoothCurrentJob: (jobId: string | null) => { currentJobId = jobId ?? undefined; },
    getJob: (id: string) => (id in jobStatus ? { id, status: jobStatus[id], acknowledged_at: acknowledgedAt[id] } : undefined),
    updateJobStatus: (id: string, status: string, column?: string, value?: number) => {
      jobStatus[id] = status;
      if (column === 'acknowledged_at' && typeof value === 'number') acknowledgedAt[id] = value;
    },
    getQueuedGuestSummaries: () =>
      queued
        .filter((j) => jobStatus[j.id] === 'queued')
        .map((j, index) => ({ jobId: j.id, name: j.name, position: index + 1 })),
    getQueueLength: () => queued.filter((j) => jobStatus[j.id] === 'queued').length,
    completeJob,
    closeJobNoPhoto,
    // The no-photo sweep runs on every tick (07-04). No job here is ever a
    // candidate, but the mock must carry the surface the service calls.
    getJobsAwaitingNoPhotoClose: () => [],
    getQueuePosition: () => 1,
    // tick() sweeps the pending-print registry on every interval and
    // onPrintComposite() opens a slot, so the mocked store must satisfy
    // that part of the real LocalStore surface too. The shared helper is
    // used rather than four inline stubs so the three-status semantics
    // cannot drift away from the SQL they stand in for (07-03).
    ...createPendingPrintRegistry().registry,
    getJobRegistration: (jobId: string) => ({
      job: { id: jobId },
      registration: { id: 'reg-1', name: 'Guest', email: '', phone: '', mode: 'boomerang', registered_at: '' },
    }),
    requeueWithRetry: vi.fn(),
    failJob: vi.fn(),
  } as unknown as LocalStore;

  return { store, boothSequence, jobStatus, completeJob, closeJobNoPhoto };
}

describe('QueueService — a print composite completes exactly the job it is bound to (SC-2 tracer)', () => {
  afterEach(() => vi.useRealTimers());

  it('processing_start completes job-1 while the booth stays BUSY; session_end then releases it and dispatches job-2; a stray duplicate session_end afterward completes nothing and leaves job-2 in_progress', () => {
    vi.useFakeTimers();
    const { store, jobStatus, completeJob } = buildStore();
    const service = new QueueService(store);
    service.bindSendCommand(() => {});

    service.start();
    vi.advanceTimersByTime(250); // announce job-1
    vi.advanceTimersByTime(7_000); // dispatch job-1, booth BUSY
    service.onAgentEvent('session_start', 'job-1');

    service.onAgentEvent('processing_start', 'job-1', { param5: COMPOSITE_PATH });

    expect(jobStatus['job-1']).toBe('completed');
    // Completion alone does not release the booth — that is D-02's split.
    expect(store.getBoothState()).toBe('BUSY');

    service.onAgentEvent('session_end'); // the first, legitimate session_end

    expect(store.getBoothState()).toBe('ANNOUNCING');
    expect(service.getAnnouncement()?.jobId).toBe('job-2');

    vi.advanceTimersByTime(7_000); // dispatch job-2
    expect(store.getBoothState()).toBe('BUSY');
    service.onAgentEvent('session_start', 'job-2');
    expect(jobStatus['job-2']).toBe('in_progress');

    completeJob.mockClear();

    // THE LOAD-BEARING ASSERTION (SC-2). dslrBooth's session_end fires on
    // every exit from the sharing screen — measured 3x in 52s for one
    // session — and carries no session identity at all (empty payload), so
    // the server cannot distinguish "job-1's stray duplicate" from a
    // legitimate session_end. Under the removed positional
    // completeInProgressJob(), this second delivery would have completed
    // WHATEVER job was currently in_progress — job-2, the exact BZWCWFN6
    // mechanism (job A's second session_end, 47s after the first, completed
    // job B). sessionEnded() no longer completes anything at all, so job-2
    // cannot be completed by it no matter which session's session_end this
    // is.
    service.onAgentEvent('session_end');

    expect(jobStatus['job-2']).toBe('in_progress');
    expect(completeJob).not.toHaveBeenCalled();

    service.stop();
  });

  it('printing delivered immediately after processing_start for the same job matches completeJob exactly once — the double-fire is absorbed structurally', () => {
    vi.useFakeTimers();
    const { store, jobStatus, completeJob } = buildStore();
    const service = new QueueService(store);
    service.bindSendCommand(() => {});

    service.start();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(7_000); // dispatch job-1
    service.onAgentEvent('session_start', 'job-1');

    service.onAgentEvent('processing_start', 'job-1', { param5: COMPOSITE_PATH });
    service.onAgentEvent('printing', 'job-1', { param1: COMPOSITE_PATH });

    expect(jobStatus['job-1']).toBe('completed');
    // Both events call completeJob('job-1', ...) — the second is the
    // double-fire, absorbed structurally: it matches zero rows (the mock's
    // status-guard returns false) rather than throwing or double-completing.
    expect(completeJob).toHaveBeenCalledTimes(2);
    const results = completeJob.mock.results.map((r) => r.value);
    expect(results.filter((matched) => matched === true)).toHaveLength(1);
    expect(results.filter((matched) => matched === false)).toHaveLength(1);
    expect(completeJob).toHaveBeenNthCalledWith(1, 'job-1', expect.any(Number));
    expect(completeJob).toHaveBeenNthCalledWith(2, 'job-1', expect.any(Number));

    service.stop();
  });

  it('processing_start stamped with a stale jobId that does not match booth_state.current_job_id completes nothing and warns naming both ids (D-06 cross-check)', () => {
    vi.useFakeTimers();
    const { store, jobStatus, completeJob } = buildStore();
    const service = new QueueService(store);
    const warnSpy = vi.spyOn(queueLogger, 'warn');
    service.bindSendCommand(() => {});

    service.start();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(7_000); // dispatch job-1
    service.onAgentEvent('session_start', 'job-1');
    service.onAgentEvent('processing_start', 'job-1', { param5: COMPOSITE_PATH }); // completes job-1
    service.onAgentEvent('session_end'); // releases booth, announces job-2
    vi.advanceTimersByTime(7_000); // dispatch job-2
    service.onAgentEvent('session_start', 'job-2');
    warnSpy.mockClear();
    completeJob.mockClear();

    // job-1's stale activeJobId, forwarded verbatim by the Agent, arrives
    // while job-2 owns the booth.
    service.onAgentEvent('processing_start', 'job-1', { param5: COMPOSITE_PATH });

    expect(jobStatus['job-2']).toBe('in_progress');
    expect(completeJob).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = String(warnSpy.mock.calls[0][0]);
    expect(message).toContain('job-1');
    expect(message).toContain('job-2');

    service.stop();
  });
});

// Task 2: the second, independently-closable half of the WINDOWS-8
// mechanism. Task 1 closed the completion path; this closes the resurrection
// path — a stray session_start naming a job that has already reached a
// terminal state must not write it back to in_progress.
describe('QueueService.sessionAcked — terminal-state guard prevents resurrecting a closed job (WINDOWS-8, second half)', () => {
  afterEach(() => vi.restoreAllMocks());

  function buildAckStore(initialStatus: Record<string, string>) {
    const jobStatus = { ...initialStatus };
    const updateJobStatus = vi.fn((id: string, status: string) => { jobStatus[id] = status; });
    const setBoothCurrentJob = vi.fn();
    const store = {
      getJob: (id: string) => (id in jobStatus ? { id, status: jobStatus[id] } : undefined),
      updateJobStatus,
      setBoothCurrentJob,
    } as unknown as LocalStore;
    return { store, jobStatus, updateJobStatus, setBoothCurrentJob };
  }

  it('a session_start for a job whose stored status is completed leaves that status unchanged and emits exactly one warn naming the job id; updateJobStatus is never called', () => {
    const { store, jobStatus, updateJobStatus } = buildAckStore({ 'job-1': 'completed' });
    const service = new QueueService(store);
    const warnSpy = vi.spyOn(queueLogger, 'warn');

    service.sessionAcked('job-1');

    expect(jobStatus['job-1']).toBe('completed');
    expect(updateJobStatus).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('job-1');
    service.stop();
  });

  it('a session_start for a job whose stored status is failed behaves identically', () => {
    const { store, jobStatus, updateJobStatus } = buildAckStore({ 'job-1': 'failed' });
    const service = new QueueService(store);
    const warnSpy = vi.spyOn(queueLogger, 'warn');

    service.sessionAcked('job-1');

    expect(jobStatus['job-1']).toBe('failed');
    expect(updateJobStatus).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it('a session_start for a queued job still writes in_progress — the guard does not change the normal path', () => {
    const { store, jobStatus, updateJobStatus } = buildAckStore({ 'job-2': 'queued' });
    const service = new QueueService(store);

    service.sessionAcked('job-2');

    expect(updateJobStatus).toHaveBeenCalledWith('job-2', 'in_progress', 'acknowledged_at', expect.any(Number));
    expect(jobStatus['job-2']).toBe('in_progress');
    service.stop();
  });

  it('a session_start for a dispatched job still writes in_progress — the guard does not change the normal path', () => {
    const { store, jobStatus, updateJobStatus } = buildAckStore({ 'job-3': 'dispatched' });
    const service = new QueueService(store);

    service.sessionAcked('job-3');

    expect(updateJobStatus).toHaveBeenCalledWith('job-3', 'in_progress', 'acknowledged_at', expect.any(Number));
    expect(jobStatus['job-3']).toBe('in_progress');
    service.stop();
  });

  it('a job absent from the store (getJob returns undefined) keeps today behaviour and is not blocked', () => {
    const { store, updateJobStatus } = buildAckStore({});
    const service = new QueueService(store);

    service.sessionAcked('job-unknown');

    expect(updateJobStatus).toHaveBeenCalledWith('job-unknown', 'in_progress', 'acknowledged_at', expect.any(Number));
    service.stop();
  });
});

describe('LocalStore.prototype carries no positional completion method (SC-2 invariant)', () => {
  it('completeInProgressJob is undefined on the prototype — this assertion goes red the instant a future phase reintroduces the positional assumption', () => {
    expect((LocalStore.prototype as Record<string, unknown>).completeInProgressJob).toBeUndefined();
  });
});

/**
 * D-14 / SC-3, the completion side. One line per CLOSED JOB, greppable by one
 * token, carrying everything an operator needs about that session — so the
 * question "what did this session do" is answered by one grep on the job id
 * instead of by reading fifteen interleaved event lines backwards.
 *
 * Every count here filters on SUMMARY_TOKEN rather than counting total
 * queueLogger.info calls. Task 1 emits one line per event and the handlers emit
 * their own, so a total-call count would be a tripwire on unrelated work — and
 * would have to be re-tuned by every future plan that adds a log line.
 */
const SUMMARY_TOKEN = 'SESSION_SUMMARY';

function summaryLines(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes(SUMMARY_TOKEN));
}

describe('QueueService — one summary line per closed job, from the close path (D-14, SC-3)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Drives the real dispatch path to "job-1 is in_progress and owns the booth". */
  function startFirstSession(store: LocalStore) {
    const service = new QueueService(store);
    service.bindSendCommand(() => {});
    service.start();
    vi.advanceTimersByTime(250); // announce job-1
    vi.advanceTimersByTime(7_000); // dispatch job-1, booth BUSY
    service.onAgentEvent('session_start', 'job-1');
    return service;
  }

  it('completing at the print composite emits exactly one summary line carrying every D-14 field', () => {
    vi.useFakeTimers();
    const { store } = buildStore();
    const infoSpy = vi.spyOn(queueLogger, 'info');
    const service = startFirstSession(store);

    service.onAgentEvent('capture_start', 'job-1', {});
    vi.advanceTimersByTime(4_000); // a session takes real time; duration must reflect it
    service.onAgentEvent('processing_start', 'job-1', { param5: COMPOSITE_PATH });

    const lines = summaryLines(infoSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('job=job-1');
    expect(lines[0]).toContain('outcome=completed');
    expect(lines[0]).toContain('captures=1');
    expect(lines[0]).toContain('print_composite=yes');
    expect(lines[0]).toMatch(/duration_ms=\d+/);

    service.stop();
  });

  it('the processing_start/printing double fire still emits exactly one summary, not two', () => {
    vi.useFakeTimers();
    const { store } = buildStore();
    const infoSpy = vi.spyOn(queueLogger, 'info');
    const service = startFirstSession(store);

    service.onAgentEvent('processing_start', 'job-1', { param5: COMPOSITE_PATH });
    service.onAgentEvent('printing', 'job-1', { param1: COMPOSITE_PATH });

    // The second event's completeJob matches zero rows, so it returns before
    // reaching the summary — the same structural absorption that keeps the
    // registry slot from being reopened.
    expect(summaryLines(infoSpy)).toHaveLength(1);
    service.stop();
  });

  it('releasing the booth emits NO summary line — the line belongs to the close, not the release (D-02)', () => {
    vi.useFakeTimers();
    const { store } = buildStore();
    const infoSpy = vi.spyOn(queueLogger, 'info');
    const service = startFirstSession(store);

    service.onAgentEvent('processing_start', 'job-1', { param5: COMPOSITE_PATH });
    expect(summaryLines(infoSpy)).toHaveLength(1);
    infoSpy.mockClear();

    // The legitimate session_end, then job-2's whole dispatch, then job-1's
    // stray duplicate session_end — the measured 3-in-52s shape. A summary
    // attached to the release path would report a session that ended minutes
    // earlier here, and on the stray-duplicate path no session at all.
    service.onAgentEvent('session_end');
    vi.advanceTimersByTime(7_000);
    service.onAgentEvent('session_start', 'job-2');
    service.onAgentEvent('session_end');

    expect(summaryLines(infoSpy)).toHaveLength(0);
    service.stop();
  });

  it('three capture_start events for the job that owns the booth yield captures=3 — a retake is a counted quantity for the first time', () => {
    vi.useFakeTimers();
    const { store } = buildStore();
    const infoSpy = vi.spyOn(queueLogger, 'info');
    const service = startFirstSession(store);

    service.onAgentEvent('capture_start', 'job-1', {});
    service.onAgentEvent('capture_start', 'job-1', {});
    service.onAgentEvent('capture_start', 'job-1', {});
    service.onAgentEvent('processing_start', 'job-1', { param5: COMPOSITE_PATH });

    expect(summaryLines(infoSpy)[0]).toContain('captures=3');
    service.stop();
  });

  it('a capture_start stamped with a jobId that is not the attributed one increments nothing', () => {
    vi.useFakeTimers();
    const { store } = buildStore();
    const infoSpy = vi.spyOn(queueLogger, 'info');
    const service = startFirstSession(store);

    // The Agent's stale-activeJobId shape, arriving mid-session for job-1.
    service.onAgentEvent('capture_start', 'job-2', {});
    service.onAgentEvent('processing_start', 'job-1', { param5: COMPOSITE_PATH });

    // No entry was ever created, so the count is an explicit unknown rather
    // than a zero that would read as "the guest was never photographed".
    expect(summaryLines(infoSpy)[0]).toContain('captures=unknown');
    service.stop();
  });

  it('a job closed with no counter entry at all reports captures=unknown, not captures=0', () => {
    vi.useFakeTimers();
    const { store } = buildStore();
    const infoSpy = vi.spyOn(queueLogger, 'info');
    const service = startFirstSession(store);

    // The restart-mid-session shape: the counter is in memory only, so a
    // process that restarted after the captures degrades to unknown. Reporting
    // 0 would be a wrong number rather than a missing one.
    service.onAgentEvent('processing_start', 'job-1', { param5: COMPOSITE_PATH });

    expect(summaryLines(infoSpy)[0]).toContain('captures=unknown');
    service.stop();
  });

  it('the counter is deleted at close, so a second session reads its own count and not an accumulated one', () => {
    vi.useFakeTimers();
    const { store } = buildStore();
    const infoSpy = vi.spyOn(queueLogger, 'info');
    const service = startFirstSession(store);

    service.onAgentEvent('capture_start', 'job-1', {});
    service.onAgentEvent('capture_start', 'job-1', {});
    service.onAgentEvent('processing_start', 'job-1', { param5: COMPOSITE_PATH });
    service.onAgentEvent('session_end');

    vi.advanceTimersByTime(7_000); // dispatch job-2
    service.onAgentEvent('session_start', 'job-2');
    service.onAgentEvent('capture_start', 'job-2', {});
    service.onAgentEvent('processing_start', 'job-2', { param5: COMPOSITE_PATH });

    const lines = summaryLines(infoSpy);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('captures=2');
    // 1, not 3. A map that were never cleaned would read 3 here, and would also
    // grow without bound across a long event.
    expect(lines[1]).toContain('job=job-2');
    expect(lines[1]).toContain('captures=1');
    service.stop();
  });
});

describe('D-06 mismatch warn throttling (Task 2)', () => {
  afterEach(() => vi.useRealTimers());

  it('ten consecutive mismatching print-composite events produce exactly one warn, and a further mismatch after a matching event warns once more', () => {
    vi.useFakeTimers();
    const { store } = buildStore();
    const service = new QueueService(store);
    const warnSpy = vi.spyOn(queueLogger, 'warn');
    service.bindSendCommand(() => {});

    service.start();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(7_000); // dispatch job-1
    service.onAgentEvent('session_start', 'job-1');
    warnSpy.mockClear();

    for (let i = 0; i < 10; i++) {
      service.onAgentEvent('processing_start', 'job-2', { param5: COMPOSITE_PATH });
    }

    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockClear();
    // A matching event (completes job-1) resets the throttle flag.
    service.onAgentEvent('processing_start', 'job-1', { param5: COMPOSITE_PATH });
    expect(warnSpy).not.toHaveBeenCalled();

    service.onAgentEvent('processing_start', 'job-2', { param5: COMPOSITE_PATH });
    expect(warnSpy).toHaveBeenCalledTimes(1);

    service.stop();
  });
});
