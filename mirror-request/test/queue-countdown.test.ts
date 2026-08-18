import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueService } from '../src/queue/queueService';
import type { LocalStore } from '../src/state/localStore';
import { createPendingPrintRegistry } from './helpers/pendingPrintRegistry';
import { NO_PHOTO_SWEEP_STUB } from './helpers/noPhotoSweep';

const CONFIG = {
  SESSION_TIMEOUT_MS: 300_000,
  NEXT_GUEST_COUNTDOWN_MS: 7_000,
  SESSION_MAX_RETRIES: 2,
  BOOTH_RELEASE_TIMEOUT_MS: 120_000,
  RETAKE_GRACE_MS: 3_000,
};

describe('Queue countdown with multiple registrations', () => {
  afterEach(() => vi.useRealTimers());

  it('announces and dispatches requests one at a time in FIFO order', () => {
    vi.useFakeTimers();
    const queued = [{ id: 'form-a' }, { id: 'form-b' }, { id: 'form-c' }];
    let booth = 'IDLE';
    let currentJobId: string | undefined;
    let attemptOpen = false;
    let attemptNo = 0;
    const jobStatus: Record<string, string> = {};
    const store = {
      getBoothState: () => booth,
      getBoothStateDetailed: () => ({ state: booth, updated_at: new Date().toISOString() }),
      getInFlightJobs: () => [],
      getNextQueuedJob: () => queued[0],
      setBoothState: (state: string) => { booth = state; currentJobId = undefined; attemptOpen = false; attemptNo = 0; },
      setBoothBusy: (jobId?: string | null) => { booth = 'BUSY'; currentJobId = jobId ?? undefined; attemptOpen = false; attemptNo = 0; },
      setBoothIdle: () => { booth = 'IDLE'; currentJobId = undefined; attemptOpen = false; attemptNo = 0; },
      setBoothTimeout: () => { booth = 'IDLE'; currentJobId = undefined; attemptOpen = false; attemptNo = 0; },
      getBoothCurrentJobId: () => currentJobId,
      setBoothCurrentJob: (jobId: string | null) => { currentJobId = jobId ?? undefined; },
      getBoothAttempt: () => ({ attemptOpen, attemptNo }),
      openBoothAttempt: () => { attemptOpen = true; attemptNo += 1; return { attemptOpen, attemptNo }; },
      closeBoothAttempt: () => { attemptOpen = false; },
      getJob: (id: string) => (id in jobStatus ? { id, status: jobStatus[id] } : { id, status: 'queued' }),
      updateJobStatus: (id: string, status: string) => {
        jobStatus[id] = status;
        if (status === 'dispatched') queued.splice(queued.findIndex(job => job.id === id), 1);
      },
      completeJob: (id: string) => { jobStatus[id] = 'completed'; return true; },
      closeJobNoPhoto: (id: string) => { jobStatus[id] = 'no_photo'; return true; },
      getQueuePosition: () => 1,
      getQueueLength: () => queued.length,
      getQueuedGuestSummaries: () => queued.map((job, index) => ({ jobId: job.id, name: `Guest ${job.id}`, position: index + 1 })),
      // tick() sweeps the pending-print registry on every interval and
      // onPrintComposite() opens a slot, so the mocked store must satisfy
      // that part of the real LocalStore surface too. The shared helper is
      // used rather than four inline stubs so the three-status semantics
      // cannot drift away from the SQL they stand in for (07-03).
      ...createPendingPrintRegistry().registry,
      getJobRegistration: () => undefined,
      getActiveEventId: () => undefined,
      requeueWithRetry: () => ({ retries: 1 }),
      failJob: () => {},
      ...NO_PHOTO_SWEEP_STUB,
    } as unknown as LocalStore;
    const service = new QueueService(store, CONFIG);
    const dispatched: string[] = [];
    service.bindSendCommand(command => dispatched.push(command.jobId));
    service.bindAnnouncement(() => {});

    service.start();
    vi.advanceTimersByTime(250);
    expect(booth).toBe('ANNOUNCING');
    expect(service.getAnnouncement()?.jobId).toBe('form-a');
    expect(dispatched).toEqual([]);

    vi.advanceTimersByTime(7_000);
    expect(dispatched).toEqual(['form-a']);
    expect(booth).toBe('BUSY');

    // D11-01/D11-06: an approving `printing` — not a bare Agent ack — is what
    // both opens and finalizes an attempt now. The real dslrBooth session_start
    // event (not onAgentAck, which only confirms the dispatch command itself)
    // is what opens the attempt, and a matching `printing` finalizes it
    // immediately (D11-05 door 1, 0s wait) so FIFO ordering can be asserted
    // without waiting out RETAKE_GRACE_MS.
    service.onAgentEvent('session_start', 'form-a');
    const composite = 'C:\\dslrBooth\\Test_event\\Prints\\form-a.jpg';
    service.onAgentEvent('processing_start', 'form-a', { param2: composite });
    service.onAgentEvent('printing', 'form-a', { param1: composite });
    expect(service.getAnnouncement()?.jobId).toBe('form-b');

    vi.advanceTimersByTime(7_000);
    expect(dispatched).toEqual(['form-a', 'form-b']);
    expect(queued.map(job => job.id)).toEqual(['form-c']);
    service.stop();
  });
});

// QUE-03/QUE-04, BTH-01, D-09/D-10: the ordered booth-state sequence, the
// exact Agent command payload, and the session_end auto-advance, asserted as
// a whole rather than through the countdown-only mock above. This describe
// block builds its own mock so it cannot interfere with the pre-existing
// case. It never reaches for the shared store singleton (02-VALIDATION.md,
// binding) — booth_state is a single global row, so every case here drives
// a fresh hand-built mock instead.
describe('booth state transitions', () => {
  afterEach(() => vi.useRealTimers());

  function buildStore() {
    // Records every booth-state write, in order, so a case can assert the
    // exact ordered path (e.g. IDLE -> ANNOUNCING -> BUSY -> IDLE) rather
    // than only the latest value.
    const boothSequence: string[] = ['IDLE'];
    let booth = 'IDLE';
    let attemptOpen = false;
    let attemptNo = 0;
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

    const requeueWithRetry = vi.fn(() => ({ retries: 1 }));
    const failJob = vi.fn();

    const store = {
      getBoothState: () => booth,
      // Inert startup-recovery surface — these cases never call recover(),
      // but the mock must satisfy the full store surface QueueService needs.
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
      getJob: (id: string) => (id in jobStatus ? { id, status: jobStatus[id] } : undefined),
      updateJobStatus: (id: string, status: string) => {
        jobStatus[id] = status;
      },
      getQueuedGuestSummaries: () =>
        queued
          .filter((j) => jobStatus[j.id] === 'queued')
          .map((j, index) => ({ jobId: j.id, name: j.name, position: index + 1 })),
      getQueueLength: () => queued.filter((j) => jobStatus[j.id] === 'queued').length,
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
      getQueuePosition: () => 1,
      // tick() sweeps the pending-print registry on every interval and
      // onPrintComposite() opens a slot, so the mocked store must satisfy
      // that part of the real LocalStore surface too. The shared helper is
      // used rather than four inline stubs so the three-status semantics
      // cannot drift away from the SQL they stand in for (07-03).
      ...createPendingPrintRegistry().registry,
      getJobRegistration: (jobId: string) => ({
        job: { id: jobId },
        registration: { id: 'reg-1', name: 'Guest One', email: '', phone: '', mode: 'boomerang', registered_at: '' },
      }),
      getActiveEventId: () => undefined,
      requeueWithRetry,
      failJob,
      ...NO_PHOTO_SWEEP_STUB,
    } as unknown as LocalStore;

    return { store, boothSequence, jobStatus, requeueWithRetry, failJob };
  }

  it('IDLE with two queued guests: the first tick writes ANNOUNCING and sends no Agent command; getAnnouncement() reports the first guest', () => {
    vi.useFakeTimers();
    const { store, boothSequence } = buildStore();
    const service = new QueueService(store, CONFIG);
    const dispatched: Array<{ type: string; action: string; jobId: string }> = [];
    service.bindSendCommand((cmd) => dispatched.push(cmd));
    service.bindAnnouncement(() => {});

    service.start();
    vi.advanceTimersByTime(250);

    expect(boothSequence).toEqual(['IDLE', 'ANNOUNCING']);
    expect(service.getAnnouncement()?.jobId).toBe('job-1');
    expect(dispatched).toEqual([]);

    service.stop();
  });

  it('while ANNOUNCING, further ticks announce nothing else and dispatch nothing — the second guest waits', () => {
    vi.useFakeTimers();
    const { store, boothSequence } = buildStore();
    const service = new QueueService(store, CONFIG);
    service.bindSendCommand(() => {});
    service.bindAnnouncement(() => {});

    service.start();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(250); // further tick cycles, still inside the 7000ms countdown
    vi.advanceTimersByTime(250);

    expect(boothSequence).toEqual(['IDLE', 'ANNOUNCING']); // no second push
    expect(service.getAnnouncement()?.jobId).toBe('job-1');

    service.stop();
  });

  it('the countdown elapsing: booth is BUSY, the job is dispatched, and exactly one command is sent shaped {type, action, jobId, mode} (QUE-03, AGT-02)', () => {
    vi.useFakeTimers();
    const { store, boothSequence, jobStatus } = buildStore();
    const service = new QueueService(store, CONFIG);
    const dispatched: Array<{ type: string; action: string; jobId: string; mode?: string }> = [];
    service.bindSendCommand((cmd) => dispatched.push(cmd));
    service.bindAnnouncement(() => {});

    service.start();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(7_000);

    expect(boothSequence).toEqual(['IDLE', 'ANNOUNCING', 'BUSY']);
    expect(jobStatus['job-1']).toBe('dispatched');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toEqual({ type: 'command', action: 'start_session', jobId: 'job-1', mode: 'boomerang' });

    service.stop();
  });

  it('session_start moves the job to in_progress and leaves the booth BUSY; no second guest is announced', () => {
    vi.useFakeTimers();
    const { store, boothSequence, jobStatus } = buildStore();
    const service = new QueueService(store, CONFIG);
    service.bindSendCommand(() => {});
    service.bindAnnouncement(() => {});

    service.start();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(7_000);

    service.onAgentEvent('session_start', 'job-1');

    expect(jobStatus['job-1']).toBe('in_progress');
    expect(store.getBoothState()).toBe('BUSY');
    expect(boothSequence).toEqual(['IDLE', 'ANNOUNCING', 'BUSY']); // unchanged

    // A further tick cycle still finds the booth BUSY — no second announcement.
    vi.advanceTimersByTime(250);
    expect(boothSequence).toEqual(['IDLE', 'ANNOUNCING', 'BUSY']);
    expect(service.getAnnouncement()).toBeNull();

    service.stop();
  });

  it('a print composite alone does not begin the announcement — an unapproved session_end holds the booth (and the second guest) through the whole grace window; only grace expiry (or an approving printing) frees it (QUE-04, D-01/D-02, D11-02/D11-06)', () => {
    vi.useFakeTimers();
    const { store, boothSequence, jobStatus } = buildStore();
    const service = new QueueService(store, CONFIG);
    service.bindSendCommand(() => {});
    service.bindAnnouncement(() => {});

    service.start();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(7_000);
    service.onAgentEvent('session_start', 'job-1');
    service.onAgentEvent('processing_start', 'job-1', { param5: 'C:\\dslrBooth\\Test_event\\Prints\\composite.jpg' });

    // D11-02: the composite alone opens the slot and completes nothing.
    expect(jobStatus['job-1']).toBe('in_progress');
    expect(boothSequence).toEqual(['IDLE', 'ANNOUNCING', 'BUSY']);

    service.onAgentEvent('session_end'); // unapproved — opens grace, does NOT release

    // THE HELD WINDOW NOW INCLUDES GRACE, NOT ONLY THE DISPATCHED WINDOW: no
    // new booth-state entry, and job-2 is not announced, for the entire
    // grace duration — the announcement must not begin while the booth is
    // still held for a possible retake.
    expect(boothSequence).toEqual(['IDLE', 'ANNOUNCING', 'BUSY']);
    expect(service.getAnnouncement()).toBeNull();
    vi.advanceTimersByTime(CONFIG.RETAKE_GRACE_MS - 1);
    expect(boothSequence).toEqual(['IDLE', 'ANNOUNCING', 'BUSY']);
    expect(service.getAnnouncement()).toBeNull();

    // Grace expires: no retake arrived, no photo was ever uploaded, so the
    // grace door closes job-1 as no_photo and releases the booth — only then
    // is job-2 announced.
    vi.advanceTimersByTime(1);
    expect(jobStatus['job-1']).toBe('no_photo');
    expect(boothSequence).toEqual(['IDLE', 'ANNOUNCING', 'BUSY', 'IDLE', 'ANNOUNCING']);
    expect(service.getAnnouncement()?.jobId).toBe('job-2');

    service.stop();
  });

  it('neither requeueWithRetry nor failJob is called anywhere on the happy path', () => {
    vi.useFakeTimers();
    const { store, requeueWithRetry, failJob } = buildStore();
    const service = new QueueService(store, CONFIG);
    service.bindSendCommand(() => {});
    service.bindAnnouncement(() => {});

    service.start();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(7_000);
    service.onAgentEvent('session_start', 'job-1');
    const composite = 'C:\\dslrBooth\\Test_event\\Prints\\composite.jpg';
    service.onAgentEvent('processing_start', 'job-1', { param5: composite });
    service.onAgentEvent('printing', 'job-1', { param1: composite }); // approves — releases with 0s wait
    vi.advanceTimersByTime(7_000);

    expect(requeueWithRetry).not.toHaveBeenCalled();
    expect(failJob).not.toHaveBeenCalled();

    service.stop();
  });

  it('after stop(), advancing timers produces no further dispatch', () => {
    vi.useFakeTimers();
    const { store } = buildStore();
    const service = new QueueService(store, CONFIG);
    const dispatched: string[] = [];
    service.bindSendCommand((cmd) => dispatched.push(cmd.jobId));
    service.bindAnnouncement(() => {});

    service.start();
    vi.advanceTimersByTime(250);
    service.stop();

    vi.advanceTimersByTime(20_000);
    expect(dispatched).toEqual([]);
  });
});
