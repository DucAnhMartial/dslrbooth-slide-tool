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
//
// D11-01..D11-05 (phase 11): completion is no longer reachable from
// `processing_start` at all — only an approving `printing` (D11-03), a
// grace-timer expiry (D11-06) or an operator release (D11-08, a later plan
// in this phase) can finalize a job, through the one gate,
// `finalizePendingPrint()` (D11-05). Every case below that used to complete
// a job directly off the composite now reaches that SAME terminal state
// through the finalize gate instead — the guarantee under test did not move,
// only how it is reached did. `must_haves`: no test in this file (or
// anywhere else touched by this plan) asserts `processing_start` alone
// completes a job.

const COMPOSITE_PATH = 'C:\\dslrBooth\\Test_event\\Prints\\20260812_143526_970.jpg';
const PHOTO_URL = 'https://fotoshare.co/i/1my7bcw';

const CONFIG = {
  SESSION_TIMEOUT_MS: 300_000,
  NEXT_GUEST_COUNTDOWN_MS: 7_000,
  SESSION_MAX_RETRIES: 2,
  BOOTH_RELEASE_TIMEOUT_MS: 120_000,
  RETAKE_GRACE_MS: 3_000,
};

function buildStore() {
  const boothSequence: string[] = ['IDLE'];
  let booth = 'IDLE';
  let attemptOpen = false;
  let attemptNo = 0;
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
  // Overridable per-test, for the one case (approved_by=none) that reaches
  // the 15-minute sweep's candidate query directly rather than through event
  // choreography — see that case's own comment for why.
  let noPhotoCandidates: (cutoff: number, boundJobId?: string) => string[] = () => [];

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
    setBoothState: (state: string) => { pushState(state); currentJobId = undefined; attemptOpen = false; attemptNo = 0; },
    setBoothBusy: (jobId?: string | null) => { pushState('BUSY'); currentJobId = jobId ?? undefined; attemptOpen = false; attemptNo = 0; },
    setBoothIdle: () => { pushState('IDLE'); currentJobId = undefined; attemptOpen = false; attemptNo = 0; },
    setBoothTimeout: () => { pushState('IDLE'); currentJobId = undefined; attemptOpen = false; attemptNo = 0; },
    getBoothCurrentJobId: () => currentJobId,
    setBoothCurrentJob: (jobId: string | null) => { currentJobId = jobId ?? undefined; },
    getBoothAttempt: () => ({ attemptOpen, attemptNo }),
    openBoothAttempt: () => { attemptOpen = true; attemptNo += 1; return { attemptOpen, attemptNo }; },
    closeBoothAttempt: () => { attemptOpen = false; },
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
    // The no-photo sweep runs on every tick (07-04). Overridable per-test —
    // see noPhotoCandidates above.
    getJobsAwaitingNoPhotoClose: (cutoff: number, boundJobId?: string) => noPhotoCandidates(cutoff, boundJobId),
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
    getActiveEventId: () => undefined,
    requeueWithRetry: vi.fn(),
    failJob: vi.fn(),
    requeueNoRetry: vi.fn(),
  } as unknown as LocalStore;

  return {
    store,
    boothSequence,
    jobStatus,
    completeJob,
    closeJobNoPhoto,
    setNoPhotoCandidates: (fn: (cutoff: number, boundJobId?: string) => string[]) => { noPhotoCandidates = fn; },
  };
}

describe('QueueService — a print composite completes exactly the job it is bound to, through the finalize gate (SC-2 tracer, D11-02/D11-05)', () => {
  afterEach(() => vi.useRealTimers());

  it('processing_start opens the slot without completing job-1 while the booth stays BUSY; an approving printing then completes it and releases the booth in one act; a stray duplicate session_end afterward completes nothing and leaves job-2 in_progress', () => {
    vi.useFakeTimers();
    const { store, jobStatus, completeJob } = buildStore();
    const service = new QueueService(store, CONFIG);
    service.bindSendCommand(() => {});
    service.bindAnnouncement(() => {});

    service.start();
    vi.advanceTimersByTime(250); // announce job-1
    vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS); // dispatch job-1, booth BUSY
    service.onAgentEvent('session_start', 'job-1');

    service.onAgentEvent('processing_start', 'job-1', { param5: COMPOSITE_PATH });

    // D11-02: a composite alone opens the pending-print slot; it completes
    // nothing.
    expect(jobStatus['job-1']).toBe('in_progress');
    expect(store.getBoothState()).toBe('BUSY');

    service.onAgentEvent('file_upload', 'job-1', { param3: 'print', param2: PHOTO_URL });
    service.onAgentEvent('printing', 'job-1', { param1: COMPOSITE_PATH }); // D11-05 door 1: 0s wait

    expect(jobStatus['job-1']).toBe('completed');
    // Finalize releases the booth in the SAME act — D-02's split still holds
    // (completion and release are one event's outcome here, not two), and
    // the queue has already begun announcing job-2.
    expect(store.getBoothState()).toBe('ANNOUNCING');
    expect(service.getAnnouncement()?.jobId).toBe('job-2');

    vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS); // dispatch job-2
    expect(store.getBoothState()).toBe('BUSY');
    service.onAgentEvent('session_start', 'job-2');
    expect(jobStatus['job-2']).toBe('in_progress');

    completeJob.mockClear();

    // THE LOAD-BEARING ASSERTION (SC-2). dslrBooth's session_end fires on
    // every exit from the sharing screen — measured 3x in 52s for one
    // session — and carries no session identity at all (empty payload), so
    // the server cannot distinguish "job-1's stray duplicate" from a
    // legitimate session_end. sessionEnded() (D11-06) NEVER calls
    // completeJob at all any more — only finalizePendingPrint() does, and
    // only from an approving printing, a grace expiry or an operator release
    // — so job-2 cannot be completed by any session_end, stray or otherwise.
    service.onAgentEvent('session_end');

    expect(jobStatus['job-2']).toBe('in_progress');
    expect(completeJob).not.toHaveBeenCalled();

    service.stop();
  });

  it('processing_start never calls completeJob — only an approving printing does, exactly once; the old two-doors-into-one-action shape is retired (D11-02), and a genuine double-fire of printing itself is still absorbed structurally', () => {
    vi.useFakeTimers();
    const { store, jobStatus, completeJob } = buildStore();
    const service = new QueueService(store, CONFIG);
    service.bindSendCommand(() => {});
    service.bindAnnouncement(() => {});

    service.start();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS); // dispatch job-1
    service.onAgentEvent('session_start', 'job-1');

    service.onAgentEvent('processing_start', 'job-1', { param5: COMPOSITE_PATH });
    expect(completeJob).not.toHaveBeenCalled();

    service.onAgentEvent('file_upload', 'job-1', { param3: 'print', param2: PHOTO_URL });
    expect(completeJob).not.toHaveBeenCalled();

    service.onAgentEvent('printing', 'job-1', { param1: COMPOSITE_PATH });
    expect(completeJob).toHaveBeenCalledTimes(1);
    expect(completeJob).toHaveBeenCalledWith('job-1', expect.any(Number));
    expect(jobStatus['job-1']).toBe('completed');

    // A duplicate/replayed printing for job-1, arriving after the booth has
    // already moved on (current_job_id cleared by finalize) — absorbed at
    // the D-06 cross-check now, rather than at completeJob's own idempotent
    // SQL predicate, but completeJob is still called AT MOST ONCE either way.
    completeJob.mockClear();
    service.onAgentEvent('printing', 'job-1', { param1: COMPOSITE_PATH });
    expect(completeJob).not.toHaveBeenCalled();

    service.stop();
  });

  it('processing_start stamped with a stale jobId that does not match booth_state.current_job_id completes nothing and warns naming both ids (D-06 cross-check)', () => {
    vi.useFakeTimers();
    const { store, jobStatus, completeJob } = buildStore();
    const service = new QueueService(store, CONFIG);
    const warnSpy = vi.spyOn(queueLogger, 'warn');
    service.bindSendCommand(() => {});
    service.bindAnnouncement(() => {});

    service.start();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS); // dispatch job-1
    service.onAgentEvent('session_start', 'job-1');
    service.onAgentEvent('processing_start', 'job-1', { param5: COMPOSITE_PATH });
    service.onAgentEvent('file_upload', 'job-1', { param3: 'print', param2: PHOTO_URL });
    service.onAgentEvent('printing', 'job-1', { param1: COMPOSITE_PATH }); // completes job-1, releases immediately
    vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS); // dispatch job-2
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
// terminal state must not write it back to in_progress. Unaffected by phase
// 11: sessionAcked() itself (as opposed to its caller sessionAckedFromEvent(),
// covered in test/queue-session-start-hijack.test.ts) carries no attempt
// bookkeeping and needs no new mock surface.
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
 *
 * D11-09 (phase 11): the line now carries two trailing fields,
 * `attempts=N approved_by=printing|grace|operator|none`, order preserved.
 * The block below keeps every pre-11-01 case (re-reached through the finalize
 * gate where completion is involved) and adds one dedicated case per approval
 * word.
 */
const SUMMARY_TOKEN = 'SESSION_SUMMARY';

function summaryLines(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes(SUMMARY_TOKEN));
}

describe('QueueService — one summary line per closed job, from the close path (D-14, SC-3, D11-09)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Drives the real dispatch path to "job-1 is in_progress and owns the booth". */
  function startFirstSession(store: LocalStore) {
    const service = new QueueService(store, CONFIG);
    service.bindSendCommand(() => {});
    service.bindAnnouncement(() => {});
    service.start();
    vi.advanceTimersByTime(250); // announce job-1
    vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS); // dispatch job-1, booth BUSY
    service.onAgentEvent('session_start', 'job-1');
    return service;
  }

  it('completing via the finalize gate emits exactly one summary line carrying every D-14 field plus attempts= and approved_by=printing', () => {
    vi.useFakeTimers();
    const { store } = buildStore();
    const infoSpy = vi.spyOn(queueLogger, 'info');
    const service = startFirstSession(store);

    service.onAgentEvent('capture_start', 'job-1', {});
    vi.advanceTimersByTime(4_000); // a session takes real time; duration must reflect it
    service.onAgentEvent('processing_start', 'job-1', { param5: COMPOSITE_PATH });
    service.onAgentEvent('file_upload', 'job-1', { param3: 'print', param2: PHOTO_URL });
    service.onAgentEvent('printing', 'job-1', { param1: COMPOSITE_PATH });

    const lines = summaryLines(infoSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('job=job-1');
    expect(lines[0]).toContain('outcome=completed');
    expect(lines[0]).toContain('captures=1');
    expect(lines[0]).toContain('print_composite=yes');
    expect(lines[0]).toMatch(/duration_ms=\d+/);
    expect(lines[0]).toContain('attempts=1');
    expect(lines[0]).toContain('approved_by=printing');

    service.stop();
  });

  it('processing_start alone emits no summary; a printing double-fire afterward still emits exactly one, not two', () => {
    vi.useFakeTimers();
    const { store } = buildStore();
    const infoSpy = vi.spyOn(queueLogger, 'info');
    const service = startFirstSession(store);

    service.onAgentEvent('processing_start', 'job-1', { param5: COMPOSITE_PATH });
    expect(summaryLines(infoSpy)).toHaveLength(0); // D11-02: no completion, no close, no summary

    service.onAgentEvent('file_upload', 'job-1', { param3: 'print', param2: PHOTO_URL });
    service.onAgentEvent('printing', 'job-1', { param1: COMPOSITE_PATH });
    expect(summaryLines(infoSpy)).toHaveLength(1);

    // The second printing's own D-06 cross-check absorbs it (current_job_id
    // was cleared by the first finalize) — no second summary either.
    service.onAgentEvent('printing', 'job-1', { param1: COMPOSITE_PATH });
    expect(summaryLines(infoSpy)).toHaveLength(1);

    service.stop();
  });

  it('an approved job\'s session_end after its summary already logged emits NO second summary line — the line belongs to the close, not any later release (D-02)', () => {
    vi.useFakeTimers();
    const { store } = buildStore();
    const infoSpy = vi.spyOn(queueLogger, 'info');
    const service = startFirstSession(store);

    service.onAgentEvent('processing_start', 'job-1', { param5: COMPOSITE_PATH });
    service.onAgentEvent('file_upload', 'job-1', { param3: 'print', param2: PHOTO_URL });
    service.onAgentEvent('printing', 'job-1', { param1: COMPOSITE_PATH });
    expect(summaryLines(infoSpy)).toHaveLength(1);
    infoSpy.mockClear();

    // job-1 is already resolved, so its session_end (or a stray duplicate of
    // it) takes the immediate-release branch — no new close, no new summary.
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
    service.onAgentEvent('file_upload', 'job-1', { param3: 'print', param2: PHOTO_URL });
    service.onAgentEvent('printing', 'job-1', { param1: COMPOSITE_PATH });

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
    service.onAgentEvent('file_upload', 'job-1', { param3: 'print', param2: PHOTO_URL });
    service.onAgentEvent('printing', 'job-1', { param1: COMPOSITE_PATH });

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
    service.onAgentEvent('file_upload', 'job-1', { param3: 'print', param2: PHOTO_URL });
    service.onAgentEvent('printing', 'job-1', { param1: COMPOSITE_PATH });

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
    service.onAgentEvent('file_upload', 'job-1', { param3: 'print', param2: PHOTO_URL });
    service.onAgentEvent('printing', 'job-1', { param1: COMPOSITE_PATH }); // releases immediately

    vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS); // dispatch job-2
    service.onAgentEvent('session_start', 'job-2');
    service.onAgentEvent('capture_start', 'job-2', {});
    const composite2 = 'C:\\dslrBooth\\Test_event\\Prints\\job-2-composite.jpg';
    service.onAgentEvent('processing_start', 'job-2', { param5: composite2 });
    service.onAgentEvent('file_upload', 'job-2', { param3: 'print', param2: 'https://fotoshare.co/i/job2' });
    service.onAgentEvent('printing', 'job-2', { param1: composite2 });

    const lines = summaryLines(infoSpy);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('captures=2');
    // 1, not 3. A map that were never cleaned would read 3 here, and would also
    // grow without bound across a long event.
    expect(lines[1]).toContain('job=job-2');
    expect(lines[1]).toContain('captures=1');
    service.stop();
  });

  it('approved_by=grace — an unapproved attempt that ends and is never retaken finalizes at grace expiry with no URL held, closing no_photo', () => {
    vi.useFakeTimers();
    const { store, jobStatus } = buildStore();
    const infoSpy = vi.spyOn(queueLogger, 'info');
    const service = startFirstSession(store);

    service.onAgentEvent('session_end'); // unapproved — opens grace
    vi.advanceTimersByTime(CONFIG.RETAKE_GRACE_MS);

    expect(jobStatus['job-1']).toBe('no_photo');
    const line = summaryLines(infoSpy).find((m) => m.includes('job=job-1'))!;
    expect(line).toContain('outcome=no_photo');
    expect(line).toContain('attempts=1');
    expect(line).toContain('approved_by=grace');

    service.stop();
  });

  it('approved_by=operator — a direct finalizePendingPrint(jobId, \'operator\') call (the CMS route itself lands in 11-03) completes the job and logs the operator door', () => {
    vi.useFakeTimers();
    const { store, jobStatus } = buildStore();
    const infoSpy = vi.spyOn(queueLogger, 'info');
    const service = startFirstSession(store);

    service.onAgentEvent('processing_start', 'job-1', { param5: COMPOSITE_PATH });
    service.onAgentEvent('file_upload', 'job-1', { param3: 'print', param2: PHOTO_URL });

    // D11-05 door 3. The CMS route that calls this in production is 11-03's
    // own scope; the gate itself is already real and callable today.
    (service as unknown as { finalizePendingPrint: (jobId: string, door: string) => boolean })
      .finalizePendingPrint('job-1', 'operator');

    expect(jobStatus['job-1']).toBe('completed');
    const line = summaryLines(infoSpy).find((m) => m.includes('job=job-1'))!;
    expect(line).toContain('approved_by=operator');
    expect(line).toContain('attempts=1');

    service.stop();
  });

  it('approved_by=none — a job the 15-minute no-photo sweep closes directly (never through finalizePendingPrint) reports approved_by=none', () => {
    vi.useFakeTimers();
    const { store, jobStatus, setNoPhotoCandidates } = buildStore();
    const infoSpy = vi.spyOn(queueLogger, 'info');
    const service = new QueueService(store, CONFIG);
    service.bindSendCommand(() => {});
    service.bindAnnouncement(() => {});

    // An aged, orphaned in_progress job with no pending_print row and not the
    // currently bound job — the sweep's own candidate shape. Under D11-06
    // every unapproved session_end now opens grace instead of releasing
    // immediately, so this state is rare in practice (recover()'s own
    // mid-grace branch and this sweep are the two remaining paths that can
    // still produce it); reproduced here at the query seam, matching the
    // precedent test/local-store-persistence.test.ts uses to prove the real
    // SQL predicate directly.
    jobStatus['job-1'] = 'in_progress';
    setNoPhotoCandidates(() => ['job-1']);

    service.start();
    vi.advanceTimersByTime(250);

    expect(jobStatus['job-1']).toBe('no_photo');
    const line = summaryLines(infoSpy).find((m) => m.includes('job=job-1'))!;
    expect(line).toContain('outcome=no_photo');
    expect(line).toContain('approved_by=none');
    expect(line).not.toContain('attempts=1'); // the sweep never reads the finalize gate's attempt count
    expect(line).toContain('attempts=unknown');

    service.stop();
  });
});

describe('D-06 mismatch warn throttling (Task 2)', () => {
  afterEach(() => vi.useRealTimers());

  it('ten consecutive mismatching print-composite events produce exactly one warn, and a further mismatch after a matching event warns once more', () => {
    vi.useFakeTimers();
    const { store } = buildStore();
    const service = new QueueService(store, CONFIG);
    const warnSpy = vi.spyOn(queueLogger, 'warn');
    service.bindSendCommand(() => {});
    service.bindAnnouncement(() => {});

    service.start();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS); // dispatch job-1
    service.onAgentEvent('session_start', 'job-1');
    warnSpy.mockClear();

    for (let i = 0; i < 10; i++) {
      service.onAgentEvent('processing_start', 'job-2', { param5: COMPOSITE_PATH });
    }

    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockClear();
    // A matching event (opens/overwrites job-1's slot — resets the throttle,
    // regardless of whether it completes anything) resets the throttle flag.
    service.onAgentEvent('processing_start', 'job-1', { param5: COMPOSITE_PATH });
    expect(warnSpy).not.toHaveBeenCalled();

    service.onAgentEvent('processing_start', 'job-2', { param5: COMPOSITE_PATH });
    expect(warnSpy).toHaveBeenCalledTimes(1);

    service.stop();
  });
});
