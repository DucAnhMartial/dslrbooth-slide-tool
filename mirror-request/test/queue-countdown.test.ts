import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueService } from '../src/queue/queueService';
import type { LocalStore } from '../src/state/localStore';

describe('Queue countdown with multiple registrations', () => {
  afterEach(() => vi.useRealTimers());

  it('announces and dispatches requests one at a time in FIFO order', () => {
    vi.useFakeTimers();
    const queued = [{ id: 'form-a' }, { id: 'form-b' }, { id: 'form-c' }];
    let booth = 'IDLE';
    const completed: string[] = [];
    const store = {
      getBoothState: () => booth,
      getNextQueuedJob: () => queued[0],
      setBoothState: (state: string) => { booth = state; },
      setBoothBusy: () => { booth = 'BUSY'; },
      setBoothIdle: () => { booth = 'IDLE'; },
      setBoothTimeout: () => { booth = 'IDLE'; },
      updateJobStatus: (id: string, status: string) => {
        if (status === 'dispatched') queued.splice(queued.findIndex(job => job.id === id), 1);
      },
      completeInProgressJob: () => {
        const id = completed.length === 0 ? 'form-a' : 'form-b';
        completed.push(id);
        return id;
      },
      getQueuePosition: () => 1,
      getQueueLength: () => queued.length,
      getQueuedGuestSummaries: () => queued.map((job, index) => ({ jobId: job.id, name: `Guest ${job.id}`, position: index + 1 })),
    } as unknown as LocalStore;
    const service = new QueueService(store);
    const dispatched: string[] = [];
    service.bindSendCommand(command => dispatched.push(command.jobId));

    service.start();
    vi.advanceTimersByTime(250);
    expect(booth).toBe('ANNOUNCING');
    expect(service.getAnnouncement()?.jobId).toBe('form-a');
    expect(dispatched).toEqual([]);

    vi.advanceTimersByTime(7_000);
    expect(dispatched).toEqual(['form-a']);
    expect(booth).toBe('BUSY');

    service.onAgentAck('form-a', true);
    service.sessionEnded();
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
    const queued = [
      { id: 'job-1', name: 'Guest One' },
      { id: 'job-2', name: 'Guest Two' },
    ];
    const jobStatus: Record<string, string> = { 'job-1': 'queued', 'job-2': 'queued' };
    let inProgressJobId: string | null = null;

    const pushState = (state: string) => {
      booth = state;
      boothSequence.push(state);
    };

    const requeueWithRetry = vi.fn();
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
      setBoothState: (state: string) => pushState(state),
      setBoothBusy: () => pushState('BUSY'),
      setBoothIdle: () => pushState('IDLE'),
      setBoothTimeout: () => pushState('IDLE'),
      updateJobStatus: (id: string, status: string) => {
        jobStatus[id] = status;
        if (status === 'in_progress') inProgressJobId = id;
      },
      getQueuedGuestSummaries: () =>
        queued
          .filter((j) => jobStatus[j.id] === 'queued')
          .map((j, index) => ({ jobId: j.id, name: j.name, position: index + 1 })),
      getQueueLength: () => queued.filter((j) => jobStatus[j.id] === 'queued').length,
      completeInProgressJob: () => {
        const id = inProgressJobId;
        if (id) jobStatus[id] = 'completed';
        inProgressJobId = null;
        return id ?? undefined;
      },
      getQueuePosition: () => 1,
      requeueWithRetry,
      failJob,
    } as unknown as LocalStore;

    return { store, boothSequence, jobStatus, requeueWithRetry, failJob };
  }

  it('IDLE with two queued guests: the first tick writes ANNOUNCING and sends no Agent command; getAnnouncement() reports the first guest', () => {
    vi.useFakeTimers();
    const { store, boothSequence } = buildStore();
    const service = new QueueService(store);
    const dispatched: Array<{ type: string; action: string; jobId: string }> = [];
    service.bindSendCommand((cmd) => dispatched.push(cmd));

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
    const service = new QueueService(store);
    service.bindSendCommand(() => {});

    service.start();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(250); // further tick cycles, still inside the 7000ms countdown
    vi.advanceTimersByTime(250);

    expect(boothSequence).toEqual(['IDLE', 'ANNOUNCING']); // no second push
    expect(service.getAnnouncement()?.jobId).toBe('job-1');

    service.stop();
  });

  it('the countdown elapsing: booth is BUSY, the job is dispatched, and exactly one command is sent shaped {type, action, jobId} (QUE-03)', () => {
    vi.useFakeTimers();
    const { store, boothSequence, jobStatus } = buildStore();
    const service = new QueueService(store);
    const dispatched: Array<{ type: string; action: string; jobId: string }> = [];
    service.bindSendCommand((cmd) => dispatched.push(cmd));

    service.start();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(7_000);

    expect(boothSequence).toEqual(['IDLE', 'ANNOUNCING', 'BUSY']);
    expect(jobStatus['job-1']).toBe('dispatched');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toEqual({ type: 'command', action: 'start_session', jobId: 'job-1' });

    service.stop();
  });

  it('session_start moves the job to in_progress and leaves the booth BUSY; no second guest is announced', () => {
    vi.useFakeTimers();
    const { store, boothSequence, jobStatus } = buildStore();
    const service = new QueueService(store);
    service.bindSendCommand(() => {});

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

  it('session_end completes the in-flight job, returns the booth to IDLE, and announces the second guest without further external input (QUE-04)', () => {
    vi.useFakeTimers();
    const { store, boothSequence, jobStatus } = buildStore();
    const service = new QueueService(store);
    service.bindSendCommand(() => {});

    service.start();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(7_000);
    service.onAgentEvent('session_start', 'job-1');

    service.onAgentEvent('session_end');

    expect(jobStatus['job-1']).toBe('completed');
    expect(boothSequence).toEqual(['IDLE', 'ANNOUNCING', 'BUSY', 'IDLE', 'ANNOUNCING']);
    expect(service.getAnnouncement()?.jobId).toBe('job-2');

    service.stop();
  });

  it('neither requeueWithRetry nor failJob is called anywhere on the happy path', () => {
    vi.useFakeTimers();
    const { store, requeueWithRetry, failJob } = buildStore();
    const service = new QueueService(store);
    service.bindSendCommand(() => {});

    service.start();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(7_000);
    service.onAgentEvent('session_start', 'job-1');
    service.onAgentEvent('session_end');
    vi.advanceTimersByTime(7_000);

    expect(requeueWithRetry).not.toHaveBeenCalled();
    expect(failJob).not.toHaveBeenCalled();

    service.stop();
  });

  it('after stop(), advancing timers produces no further dispatch', () => {
    vi.useFakeTimers();
    const { store } = buildStore();
    const service = new QueueService(store);
    const dispatched: string[] = [];
    service.bindSendCommand((cmd) => dispatched.push(cmd.jobId));

    service.start();
    vi.advanceTimersByTime(250);
    service.stop();

    vi.advanceTimersByTime(20_000);
    expect(dispatched).toEqual([]);
  });
});
