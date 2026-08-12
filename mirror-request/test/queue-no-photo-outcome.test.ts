import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueService, queueLogger, NO_PHOTO_CLOSE_DELAY_MS } from '../src/queue/queueService';
import { LocalStore } from '../src/state/localStore';
import { createPendingPrintRegistry } from './helpers/pendingPrintRegistry';

/**
 * SC-3 / D-03 / D-09, built as a SWEEP rather than as a session_end handler.
 *
 * The plan (07-04-PLAN.md Task 2) said to close the bound job as no-photo
 * inside sessionEnded(). That version was built and measured first, and it
 * regressed the SC-2 tracer in queue-dual-completion.test.ts: dslrBooth's
 * session_end carries an empty `{}` payload and fires on every exit from the
 * sharing screen (three times in 20s for one session in the measured trace),
 * so a stray duplicate from guest A closed GUEST B's live job as no_photo.
 * The human chose the swept deadline instead. The first test below is the
 * direct regression pin for that, and the SC-2 tracer passing UNCHANGED is the
 * other half of the evidence.
 *
 * The store is mocked at the SQLite seam; the candidate query's SQL is proved
 * separately against a real temp-file database in
 * test/local-store-persistence.test.ts. Neither file substitutes for the other.
 */

const COMPOSITE_PATH = 'C:\\dslrBooth\\Test_event\\Prints\\20260812_143526_970.jpg';

/**
 * `jobIds` defaults to a SINGLE job. Most cases here advance fake time past
 * NO_PHOTO_CLOSE_DELAY_MS, and a second queued guest would be dispatched,
 * time out on the busy timer at SESSION_TIMEOUT_MS, and churn through the
 * retry policy for the rest of the run — noise that has nothing to do with the
 * sweep and that would trip the call-count-zero spies. The two-guest ordering
 * is requested explicitly by the one test that needs it.
 */
function buildStore(jobIds: string[] = ['job-1']) {
  const boothSequence: string[] = ['IDLE'];
  let booth = 'IDLE';
  const queued = jobIds.map((id, i) => ({ id, name: `Guest ${i + 1}` }));
  const jobStatus: Record<string, string> = Object.fromEntries(jobIds.map((id) => [id, 'queued']));
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

  const closeJobNoPhoto = vi.fn((jobId: string) => {
    if (jobStatus[jobId] !== 'in_progress') return false;
    jobStatus[jobId] = 'no_photo';
    return true;
  });

  const registry = createPendingPrintRegistry();

  // Mirrors getJobsAwaitingNoPhotoClose()'s four predicates. The real SQL is
  // pinned against a real database; this stands in for it at the service seam.
  const getJobsAwaitingNoPhotoClose = vi.fn((cutoff: number, boundJobId?: string) =>
    Object.keys(jobStatus).filter((id) =>
      jobStatus[id] === 'in_progress'
      && acknowledgedAt[id] !== undefined
      && acknowledgedAt[id] <= cutoff
      && id !== boundJobId
      && !registry.rows.has(id),
    ),
  );

  // Returns the real writer's shape so an unrelated busy-timer stall in a
  // long-running case cannot fail a test by destructuring undefined.
  const requeueWithRetry = vi.fn(() => ({ retries: 0 }));
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
    // acknowledged_at is handed back so D-14's summary line can compute the
    // session duration from it (07-05). The map was already recorded below for
    // the candidate query's age predicate; only the read-back is new.
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
    getJobsAwaitingNoPhotoClose,
    getQueuePosition: () => 1,
    ...registry.registry,
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
    getJobsAwaitingNoPhotoClose,
    requeueWithRetry,
    requeueNoRetry,
    failJob,
    setBoothTimeout,
    registryRows: registry.rows,
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

describe('QueueService — the no-photo sweep (SC-3, D-03/D-09)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('leaves a live guest untouched when the PREVIOUS guest stray session_end arrives mid-session', () => {
    vi.useFakeTimers();
    const { store, jobStatus, closeJobNoPhoto } = buildStore(['job-1', 'job-2']);
    const service = startSession(store);

    // job-1 completes properly at the print composite, then its session_end
    // releases the booth and job-2 is announced, dispatched and acknowledged.
    service.onAgentEvent('processing_start', 'job-1', { param5: COMPOSITE_PATH });
    service.onAgentEvent('session_end');
    vi.advanceTimersByTime(7_000);
    service.onAgentEvent('session_start', 'job-2');
    expect(jobStatus['job-2']).toBe('in_progress');

    // job-1's stray duplicate session_end, arriving while guest B holds the
    // booth. This is the exact ordering that made the plan's session_end
    // version write no_photo onto job-2.
    service.onAgentEvent('session_end');
    vi.advanceTimersByTime(250); // let a tick (and therefore a sweep) run

    expect(closeJobNoPhoto).not.toHaveBeenCalled();
    expect(jobStatus['job-2']).toBe('in_progress');

    service.stop();
  });

  it('does not close a job while the booth is still serving it', () => {
    vi.useFakeTimers();
    const { store, jobStatus, closeJobNoPhoto } = buildStore();
    const service = startSession(store);

    // Deliberately stops short of SESSION_TIMEOUT_MS. A job that still holds
    // the booth cannot reach the no-photo deadline at all, because the busy
    // timer stalls a session that never ends long before then — so the booth
    // exclusion is a second, independent guarantee rather than the only one.
    // Its controlled proof (same row, same age, only the binding differs) is
    // the store-level case in local-store-persistence.test.ts.
    vi.advanceTimersByTime(250_000);

    expect(closeJobNoPhoto).not.toHaveBeenCalled();
    expect(jobStatus['job-1']).toBe('in_progress');

    service.stop();
  });

  it('does not close an unbound job before the deadline has passed', () => {
    vi.useFakeTimers();
    const { store, jobStatus, closeJobNoPhoto } = buildStore();
    const service = startSession(store);

    service.onAgentEvent('session_end'); // releases the booth; job-1 stays in_progress
    vi.advanceTimersByTime(NO_PHOTO_CLOSE_DELAY_MS / 2);

    expect(closeJobNoPhoto).not.toHaveBeenCalled();
    expect(jobStatus['job-1']).toBe('in_progress');

    service.stop();
  });

  it('closes a genuinely photo-less job once the deadline passes, and warns exactly once', () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(queueLogger, 'warn').mockImplementation(() => undefined as never);
    const { store, jobStatus, closeJobNoPhoto } = buildStore();
    const service = startSession(store);

    // A session that produced nothing: no processing_start, no printing, no
    // print composite of any kind. The booth is released and the row ages out.
    service.onAgentEvent('session_end');
    vi.advanceTimersByTime(NO_PHOTO_CLOSE_DELAY_MS + 1_000);

    expect(jobStatus['job-1']).toBe('no_photo');
    expect(closeJobNoPhoto).toHaveBeenCalledTimes(1);
    expect(closeJobNoPhoto).toHaveBeenCalledWith('job-1', expect.any(Number));

    const lines = warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('job-1'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('No print upload seen');
    expect(lines[0].toLowerCase()).toContain('no print composite');

    service.stop();
  });

  it('keeps sweeping on later ticks without closing the same job twice', () => {
    vi.useFakeTimers();
    const { store, closeJobNoPhoto } = buildStore();
    const service = startSession(store);

    service.onAgentEvent('session_end');
    vi.advanceTimersByTime(NO_PHOTO_CLOSE_DELAY_MS + 1_000);
    expect(closeJobNoPhoto).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000); // 240 more ticks

    // The row is no longer in_progress, so it stops being a candidate — the
    // sweep is idempotent by the same predicate that makes it safe.
    expect(closeJobNoPhoto).toHaveBeenCalledTimes(1);

    service.stop();
  });

  it('charges no retry and writes no stall reason — no retry writer is called at all (D-03, T-07-18)', () => {
    vi.useFakeTimers();
    const { store, requeueWithRetry, requeueNoRetry, failJob, setBoothTimeout, jobStatus } = buildStore();
    const service = startSession(store);

    service.onAgentEvent('session_end');
    vi.advanceTimersByTime(NO_PHOTO_CLOSE_DELAY_MS + 1_000);
    expect(jobStatus['job-1']).toBe('no_photo');

    // The three call-count-zero spies ARE the guarantee: a guest whose session
    // produced nothing is never called back to the camera.
    expect(requeueWithRetry).not.toHaveBeenCalled();
    expect(requeueNoRetry).not.toHaveBeenCalled();
    expect(failJob).not.toHaveBeenCalled();
    // handleStall()'s booth-side effect; its absence pins that the stall path
    // was never entered either.
    expect(setBoothTimeout).not.toHaveBeenCalled();

    service.stop();
  });

  it('never closes a job that completed at the print composite', () => {
    vi.useFakeTimers();
    const { store, jobStatus, closeJobNoPhoto } = buildStore();
    const service = startSession(store);

    service.onAgentEvent('processing_start', 'job-1', { param5: COMPOSITE_PATH });
    expect(jobStatus['job-1']).toBe('completed');

    service.onAgentEvent('session_end');
    vi.advanceTimersByTime(NO_PHOTO_CLOSE_DELAY_MS * 2);

    expect(closeJobNoPhoto).not.toHaveBeenCalled();
    expect(jobStatus['job-1']).toBe('completed');

    service.stop();
  });

  it('passes the booth current job id into the candidate query, so the query can exclude it', () => {
    vi.useFakeTimers();
    const { store, getJobsAwaitingNoPhotoClose } = buildStore();
    const service = startSession(store);

    vi.advanceTimersByTime(250);

    // The exclusion of the live guest is decided inside the query, from
    // booth_state, not by a caller-side `if` a later edit could delete.
    expect(getJobsAwaitingNoPhotoClose).toHaveBeenCalledWith(expect.any(Number), 'job-1');

    service.stop();
  });

  // D-14 / SC-3, the no-photo side. The sweep is the OTHER place a job closes,
  // so it is the other place the summary line is emitted from. The plan text
  // for this task said to emit it from sessionEnded()'s no-photo branch; no
  // such branch exists — 07-04 shipped the close as a swept deadline by human
  // decision after the session_end version regressed the SC-2 tracer, and
  // sessionEnded() is release-only. The close path is what D-14 asks for, and
  // here the close path is sweepNoPhotoJobs().
  it('closing a job as no_photo emits exactly one summary line with the no-photo outcome and no composite seen', () => {
    vi.useFakeTimers();
    const infoSpy = vi.spyOn(queueLogger, 'info');
    const { store, jobStatus } = buildStore();
    const service = startSession(store);

    service.onAgentEvent('session_end');
    vi.advanceTimersByTime(NO_PHOTO_CLOSE_DELAY_MS + 1_000);
    expect(jobStatus['job-1']).toBe('no_photo');

    const lines = infoSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('SESSION_SUMMARY'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('job=job-1');
    expect(lines[0]).toContain('outcome=no_photo');
    expect(lines[0]).toContain('print_composite=no');
    expect(lines[0]).toMatch(/duration_ms=\d+/);

    service.stop();
  });

  // THE RESIDUAL MADE OBSERVABLE. Option C narrows the wrongful-close window to
  // fifteen minutes; it does not eliminate it. A job closed no_photo while its
  // capture count is greater than zero is precisely the shape of a session that
  // photographed a guest and was closed anyway — the one thing an operator must
  // be able to see if the residual ever fires in production. This assertion is
  // the design requirement, not a nicety: without the capture count on the
  // no-photo line, a wrongful close is indistinguishable from a guest who
  // walked away before the first shot.
  it('carries the capture count on the no-photo line too, so a wrongful close is visible as captures>0 with outcome=no_photo', () => {
    vi.useFakeTimers();
    const infoSpy = vi.spyOn(queueLogger, 'info');
    const { store } = buildStore();
    const service = startSession(store);

    service.onAgentEvent('capture_start', 'job-1', {});
    service.onAgentEvent('capture_start', 'job-1', {});
    service.onAgentEvent('session_end');
    vi.advanceTimersByTime(NO_PHOTO_CLOSE_DELAY_MS + 1_000);

    const line = infoSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('SESSION_SUMMARY'))!;
    expect(line).toContain('outcome=no_photo');
    expect(line).toContain('captures=2');

    service.stop();
  });

  it('a guest who walked away before any shot is distinguishable — captures=unknown, not captures=2', () => {
    vi.useFakeTimers();
    const infoSpy = vi.spyOn(queueLogger, 'info');
    const { store } = buildStore();
    const service = startSession(store);

    service.onAgentEvent('session_end');
    vi.advanceTimersByTime(NO_PHOTO_CLOSE_DELAY_MS + 1_000);

    const line = infoSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('SESSION_SUMMARY'))!;
    expect(line).toContain('captures=unknown');

    service.stop();
  });

  it('later ticks emit no second summary for a job the sweep already closed', () => {
    vi.useFakeTimers();
    const infoSpy = vi.spyOn(queueLogger, 'info');
    const { store } = buildStore();
    const service = startSession(store);

    service.onAgentEvent('session_end');
    vi.advanceTimersByTime(NO_PHOTO_CLOSE_DELAY_MS + 1_000);
    vi.advanceTimersByTime(60_000); // 240 more ticks

    const lines = infoSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('SESSION_SUMMARY'));
    expect(lines).toHaveLength(1);

    service.stop();
  });

  it('a stray session_start cannot resurrect a job the sweep already closed', () => {
    vi.useFakeTimers();
    const { store, jobStatus } = buildStore();
    const service = startSession(store);

    service.onAgentEvent('session_end');
    vi.advanceTimersByTime(NO_PHOTO_CLOSE_DELAY_MS + 1_000);
    expect(jobStatus['job-1']).toBe('no_photo');

    service.onAgentEvent('session_start', 'job-1');

    // Without the terminal-state guard this would write the row back to
    // in_progress, where the next tick would make it a candidate all over
    // again.
    expect(jobStatus['job-1']).toBe('no_photo');

    service.stop();
  });
});
