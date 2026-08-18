import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueService, queueLogger } from '../src/queue/queueService';
import { LocalStore } from '../src/state/localStore';
import { createPendingPrintRegistry } from './helpers/pendingPrintRegistry';

/**
 * SC-3 / D-03 / D-09 / D11-05 / D11-06.
 *
 * Phase 11 (D11-02) retires the assumption this file used to test against:
 * that `processing_start` alone completes a job. It does not — only an
 * approving `printing` (D11-03), a grace-timer expiry (D11-06) or an
 * operator release (D11-08, a later plan in this phase) can finalize a job,
 * through the one gate, `finalizePendingPrint()` (D11-05).
 *
 * D11-06 also moves WHEN an unapproved, ended attempt's outcome is decided.
 * Phase 7/07-04's `sessionEnded()` released the booth immediately and left
 * the job for `sweepNoPhotoJobs()`'s NO_PHOTO_CLOSE_DELAY_MS (15-minute)
 * deadline to close later. That immediate release is gone for an unapproved
 * attempt: `sessionEnded()` now keeps the booth bound and opens a grace
 * window (RETAKE_GRACE_MS) instead, and grace's own expiry finalizes the job
 * via `finalizePendingPrint(jobId, 'grace')` directly — with no URL held,
 * that is exactly the no-photo outcome. So every guarantee this file used to
 * pin at the 15-minute sweep — no retry charged, no stall reason written,
 * the guest-facing wording, the summary line's fields, the terminal-state
 * resurrection guard — is REWRITTEN below to be reached through grace expiry
 * instead, per 11-02-PLAN.md's own direction. `sweepNoPhotoJobs()` itself is
 * untouched by this phase (still reachable for a job the booth has moved on
 * from with no registry row at all) and its booth-exclusion / no-double-close
 * guarantees are kept exactly where they were, since neither depends on the
 * anchor that moved.
 *
 * The store is mocked at the SQLite seam; the candidate query's SQL is proved
 * separately against a real temp-file database in
 * test/local-store-persistence.test.ts. Neither file substitutes for the other.
 */

const COMPOSITE_PATH = 'C:\\dslrBooth\\Test_event\\Prints\\20260812_143526_970.jpg';
const PHOTO_URL = 'https://fotoshare.co/i/1my7bcw';

const CONFIG = {
  SESSION_TIMEOUT_MS: 300_000,
  NEXT_GUEST_COUNTDOWN_MS: 7_000,
  SESSION_MAX_RETRIES: 2,
  BOOTH_RELEASE_TIMEOUT_MS: 120_000,
  RETAKE_GRACE_MS: 3_000,
};

/**
 * `jobIds` defaults to a SINGLE job. Most cases here advance fake time past
 * RETAKE_GRACE_MS, and a second queued guest would be dispatched, time out on
 * the busy timer at SESSION_TIMEOUT_MS, and churn through the retry policy
 * for the rest of the run — noise that has nothing to do with the outcome
 * under test and that would trip the call-count-zero spies. The two-guest
 * ordering is requested explicitly by the one test that needs it.
 */
function buildStore(jobIds: string[] = ['job-1']) {
  const boothSequence: string[] = ['IDLE'];
  let booth = 'IDLE';
  let attemptOpen = false;
  let attemptNo = 0;
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
  // pinned against a real database; this stands in for it at the service
  // seam. Under D11-06, a job in grace stays BOUND (id === boundJobId) for
  // the whole window, so this predicate structurally excludes it without any
  // change here — the exclusion was always "not the currently bound job".
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
  const setBoothTimeout = vi.fn(() => { pushState('IDLE'); currentJobId = undefined; attemptOpen = false; attemptNo = 0; });

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
    setBoothTimeout,
    getBoothCurrentJobId: () => currentJobId,
    setBoothCurrentJob: (jobId: string | null) => { currentJobId = jobId ?? undefined; },
    getBoothAttempt: () => ({ attemptOpen, attemptNo }),
    openBoothAttempt: () => { attemptOpen = true; attemptNo += 1; return { attemptOpen, attemptNo }; },
    closeBoothAttempt: () => { attemptOpen = false; },
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
    getActiveEventId: () => undefined,
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
  const service = new QueueService(store, CONFIG);
  service.bindSendCommand(() => {});
  service.start();
  vi.advanceTimersByTime(250); // announce job-1
  vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS); // dispatch job-1, booth BUSY
  service.onAgentEvent('session_start', 'job-1');
  return service;
}

describe('QueueService — the no-photo outcome, now decided at the finalize gate via grace expiry (SC-3, D-03/D-09, D11-05/D11-06)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not close a job while the booth is still serving it', () => {
    vi.useFakeTimers();
    const { store, jobStatus, closeJobNoPhoto } = buildStore();
    const service = startSession(store);

    // Deliberately stops short of even RETAKE_GRACE_MS — the attempt has not
    // ended yet, so grace has not opened and the sweep's own booth exclusion
    // (a second, independent guarantee) is what this pins.
    vi.advanceTimersByTime(CONFIG.RETAKE_GRACE_MS - 1);

    expect(closeJobNoPhoto).not.toHaveBeenCalled();
    expect(jobStatus['job-1']).toBe('in_progress');

    service.stop();
  });

  it('does not finalize via grace before RETAKE_GRACE_MS has passed', () => {
    vi.useFakeTimers();
    const { store, jobStatus, closeJobNoPhoto } = buildStore();
    const service = startSession(store);

    service.onAgentEvent('session_end'); // unapproved — opens grace, keeps the booth bound
    vi.advanceTimersByTime(CONFIG.RETAKE_GRACE_MS - 1);

    expect(closeJobNoPhoto).not.toHaveBeenCalled();
    expect(jobStatus['job-1']).toBe('in_progress');
    expect(store.getBoothCurrentJobId()).toBe('job-1');

    service.stop();
  });

  it('closes a genuinely photo-less job once grace expires, releases the booth, and warns exactly once with the guest-facing no-composite wording', () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(queueLogger, 'warn').mockImplementation(() => undefined as never);
    const { store, jobStatus, closeJobNoPhoto } = buildStore();
    const service = startSession(store);

    // A session that produced nothing: no processing_start, no printing, no
    // print composite of any kind.
    service.onAgentEvent('session_end');
    vi.advanceTimersByTime(CONFIG.RETAKE_GRACE_MS);

    expect(jobStatus['job-1']).toBe('no_photo');
    expect(closeJobNoPhoto).toHaveBeenCalledTimes(1);
    expect(closeJobNoPhoto).toHaveBeenCalledWith('job-1', expect.any(Number));
    expect(store.getBoothCurrentJobId()).not.toBe('job-1');

    const lines = warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('job-1'));
    // sweepPendingPrints()'s separate expiry warning ("No print upload seen")
    // must not fire here — no slot was ever opened, so there is nothing for
    // that sweep to expire. Only the grace door's own warning (if any) or
    // none is expected; the guarantee under test is that no MISLEADING
    // "no print upload seen" line is emitted for a session with no slot.
    expect(lines.every((l) => !l.includes('No print upload seen'))).toBe(true);

    service.stop();
  });

  it('keeps sweeping on later ticks without closing the already-finalized job twice — grace is the one idempotent gate', () => {
    vi.useFakeTimers();
    const { store, closeJobNoPhoto } = buildStore();
    const service = startSession(store);

    service.onAgentEvent('session_end');
    vi.advanceTimersByTime(CONFIG.RETAKE_GRACE_MS);
    expect(closeJobNoPhoto).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000); // 240 more ticks

    // The row is no longer in_progress, so it stops being a candidate for
    // the separate 15-minute sweep too — the sweep is idempotent by the same
    // predicate that makes it safe, on top of finalizePendingPrint()'s own
    // idempotent SQL predicate.
    expect(closeJobNoPhoto).toHaveBeenCalledTimes(1);

    service.stop();
  });

  it('charges no retry and writes no stall reason — no retry writer is called at all (D-03, T-07-18)', () => {
    vi.useFakeTimers();
    const { store, requeueWithRetry, requeueNoRetry, failJob, setBoothTimeout, jobStatus } = buildStore();
    const service = startSession(store);

    service.onAgentEvent('session_end');
    vi.advanceTimersByTime(CONFIG.RETAKE_GRACE_MS);
    expect(jobStatus['job-1']).toBe('no_photo');

    // The three call-count-zero spies ARE the guarantee: a guest whose session
    // produced nothing is never called back to the camera. finalizePendingPrint()
    // never routes through handleStall()/requeueWithRetry()/requeueNoRetry()/
    // failJob()/setBoothTimeout(), by its own documented discipline.
    expect(requeueWithRetry).not.toHaveBeenCalled();
    expect(requeueNoRetry).not.toHaveBeenCalled();
    expect(failJob).not.toHaveBeenCalled();
    expect(setBoothTimeout).not.toHaveBeenCalled();

    service.stop();
  });

  it('processing_start alone neither completes nor closes the job — only an approving printing finalizes it, and once finalized session_end releases immediately with no grace', () => {
    vi.useFakeTimers();
    const { store, jobStatus } = buildStore();
    const service = startSession(store);

    service.onAgentEvent('processing_start', 'job-1', { param5: COMPOSITE_PATH });
    // D11-02: a composite alone opens the pending-print slot; it completes
    // nothing. The job is still exactly where the guest left it.
    expect(jobStatus['job-1']).toBe('in_progress');
    expect(store.getBoothState()).toBe('BUSY');

    service.onAgentEvent('file_upload', 'job-1', { param3: 'print', param2: PHOTO_URL });
    expect(jobStatus['job-1']).toBe('in_progress'); // D11-04: written, not sent

    service.onAgentEvent('printing', 'job-1', { param1: COMPOSITE_PATH });
    expect(jobStatus['job-1']).toBe('completed');

    // D11-06: an APPROVED attempt's session_end releases immediately — no
    // grace window opens for it, so advancing well past RETAKE_GRACE_MS
    // afterward changes nothing further.
    service.onAgentEvent('session_end');
    expect(store.getBoothCurrentJobId()).not.toBe('job-1');
    vi.advanceTimersByTime(CONFIG.RETAKE_GRACE_MS * 5);
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

  // D-14 / SC-3, the no-photo side, now reached through the grace door.
  it('closing a job as no_photo via grace emits exactly one summary line with the no-photo outcome, no composite seen, and the grace approval door', () => {
    vi.useFakeTimers();
    const infoSpy = vi.spyOn(queueLogger, 'info');
    const { store, jobStatus } = buildStore();
    const service = startSession(store);

    service.onAgentEvent('session_end');
    vi.advanceTimersByTime(CONFIG.RETAKE_GRACE_MS);
    expect(jobStatus['job-1']).toBe('no_photo');

    const lines = infoSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('SESSION_SUMMARY'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('job=job-1');
    expect(lines[0]).toContain('outcome=no_photo');
    expect(lines[0]).toContain('print_composite=no');
    expect(lines[0]).toMatch(/duration_ms=\d+/);
    expect(lines[0]).toContain('approved_by=grace');

    service.stop();
  });

  // THE RESIDUAL MADE OBSERVABLE. A job closed no_photo while its capture
  // count is greater than zero is precisely the shape of a session that
  // photographed a guest and was closed anyway — the one thing an operator
  // must be able to see if that residual ever fires in production.
  it('carries the capture count on the no-photo line too, so a wrongful close is visible as captures>0 with outcome=no_photo', () => {
    vi.useFakeTimers();
    const infoSpy = vi.spyOn(queueLogger, 'info');
    const { store } = buildStore();
    const service = startSession(store);

    service.onAgentEvent('capture_start', 'job-1', {});
    service.onAgentEvent('capture_start', 'job-1', {});
    service.onAgentEvent('session_end');
    vi.advanceTimersByTime(CONFIG.RETAKE_GRACE_MS);

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
    vi.advanceTimersByTime(CONFIG.RETAKE_GRACE_MS);

    const line = infoSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('SESSION_SUMMARY'))!;
    expect(line).toContain('captures=unknown');

    service.stop();
  });

  it('later ticks emit no second summary for a job the grace door already closed', () => {
    vi.useFakeTimers();
    const infoSpy = vi.spyOn(queueLogger, 'info');
    const { store } = buildStore();
    const service = startSession(store);

    service.onAgentEvent('session_end');
    vi.advanceTimersByTime(CONFIG.RETAKE_GRACE_MS);
    vi.advanceTimersByTime(60_000); // 240 more ticks

    const lines = infoSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('SESSION_SUMMARY'));
    expect(lines).toHaveLength(1);

    service.stop();
  });

  it('a stray session_start cannot resurrect a job the grace door already closed', () => {
    vi.useFakeTimers();
    const { store, jobStatus } = buildStore();
    const service = startSession(store);

    service.onAgentEvent('session_end');
    vi.advanceTimersByTime(CONFIG.RETAKE_GRACE_MS);
    expect(jobStatus['job-1']).toBe('no_photo');

    service.onAgentEvent('session_start', 'job-1');

    // Without the terminal-state guard this would write the row back to
    // in_progress, where the next tick would make it a candidate all over
    // again.
    expect(jobStatus['job-1']).toBe('no_photo');

    service.stop();
  });

  it('leaves a live guest untouched when the PREVIOUS guest\'s stray session_end arrives mid-session — it can only open grace for whoever the booth is bound to, never close the wrong job outright', () => {
    vi.useFakeTimers();
    const { store, jobStatus, closeJobNoPhoto } = buildStore(['job-1', 'job-2']);
    const service = startSession(store);

    // job-1 is approved (printing) and releases the booth immediately, then
    // job-2 is announced, dispatched and acknowledged.
    service.onAgentEvent('processing_start', 'job-1', { param5: COMPOSITE_PATH });
    service.onAgentEvent('file_upload', 'job-1', { param3: 'print', param2: PHOTO_URL });
    service.onAgentEvent('printing', 'job-1', { param1: COMPOSITE_PATH });
    expect(jobStatus['job-1']).toBe('completed');
    vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS);
    service.onAgentEvent('session_start', 'job-2');
    expect(jobStatus['job-2']).toBe('in_progress');

    // job-1's stray duplicate session_end, arriving while guest B holds the
    // booth. dslrBooth's session_end carries no identity at all, so the
    // server can only ever act on whoever the booth is CURRENTLY bound to —
    // here, that is job-2, and job-2 has not yet been approved, so this
    // opens grace for job-2. It must NOT close job-2 outright and it must
    // not touch job-1 (already terminal).
    service.onAgentEvent('session_end');

    expect(closeJobNoPhoto).not.toHaveBeenCalled();
    expect(jobStatus['job-2']).toBe('in_progress');
    expect(jobStatus['job-1']).toBe('completed');
    expect(store.getBoothCurrentJobId()).toBe('job-2'); // still bound — grace, not release

    service.stop();
  });
});
