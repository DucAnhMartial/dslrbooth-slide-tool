import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueService } from '../src/queue/queueService';
import type { LocalStore } from '../src/state/localStore';
import { createPendingPrintRegistry } from './helpers/pendingPrintRegistry';

// D-13: queueService.ts must read its timing and retry knobs from the
// injected typed config object, never from process.env directly. Every case
// below proves a timing/retry assertion follows a value that exists only in
// the constructor's second argument. This file never reaches for the shared
// store singleton (02-VALIDATION.md, binding: booth_state is a single
// global row) — each case drives its own hand-built mock instead.

interface BuildStoreOptions {
  // requeueWithRetry's successive return values, so a case can control
  // exactly which stall crosses the configured retry ceiling.
  requeueSequence?: number[];
}

function buildStore(opts: BuildStoreOptions = {}) {
  let booth = 'IDLE';
  let jobAlive = true;
  const job = { id: 'job-x' };
  const requeueSequence = opts.requeueSequence ?? [];
  let requeueCallIndex = 0;

  const failJob = vi.fn(() => {
    jobAlive = false;
  });
  const requeueWithRetry = vi.fn(() => {
    const retries = requeueSequence[requeueCallIndex] ?? requeueCallIndex + 1;
    requeueCallIndex++;
    return { retries };
  });

  const store = {
    getBoothState: () => booth,
    getNextQueuedJob: () => (jobAlive ? job : undefined),
    setBoothState: (state: string) => {
      booth = state;
    },
    setBoothBusy: () => {
      booth = 'BUSY';
    },
    setBoothIdle: () => {
      booth = 'IDLE';
    },
    setBoothTimeout: () => {
      booth = 'IDLE';
    },
    updateJobStatus: () => {},
    getQueuedGuestSummaries: () => (jobAlive ? [{ jobId: job.id, name: 'Guest', position: 1 }] : []),
    getQueueLength: () => (jobAlive ? 1 : 0),
    completeJob: () => false,
    getBoothCurrentJobId: () => undefined,
    setBoothCurrentJob: () => {},
    getJobRegistration: () => undefined,
    requeueWithRetry,
    failJob,
    // tick() sweeps the pending-print registry on its first statement, above
    // the IDLE guard, so every mocked store a QueueService is built with has to
    // satisfy that part of the real LocalStore surface. The shared helper is
    // used rather than an inline stub so the three-status semantics cannot
    // drift away from the SQL they stand in for (07-03).
    ...createPendingPrintRegistry().registry,
  } as unknown as LocalStore;

  return { store, requeueWithRetry, failJob, jobId: job.id };
}

describe('QueueService — timing and retry budget follow the injected config, not the environment (D-13)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('an injected 9000ms countdown dispatches at exactly 9000ms — not at 8999ms, not at the 7000ms default', () => {
    vi.useFakeTimers();
    const { store } = buildStore();
    const service = new QueueService(store, {
      SESSION_TIMEOUT_MS: 300_000,
      NEXT_GUEST_COUNTDOWN_MS: 9_000,
      SESSION_MAX_RETRIES: 2,
    });
    const dispatched: string[] = [];
    service.bindSendCommand((cmd) => dispatched.push(cmd.jobId));

    service.start();
    vi.advanceTimersByTime(250);
    expect(service.getAnnouncement()?.jobId).toBe('job-x');

    vi.advanceTimersByTime(8_999);
    expect(dispatched).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(dispatched).toEqual(['job-x']);

    service.stop();
  });

  it('a configured countdown of 3000ms clamps up to the 5000ms floor', () => {
    vi.useFakeTimers();
    const { store } = buildStore();
    const service = new QueueService(store, {
      SESSION_TIMEOUT_MS: 300_000,
      NEXT_GUEST_COUNTDOWN_MS: 3_000,
      SESSION_MAX_RETRIES: 2,
    });
    const dispatched: string[] = [];
    service.bindSendCommand((cmd) => dispatched.push(cmd.jobId));

    service.start();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(4_999);
    expect(dispatched).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(dispatched).toEqual(['job-x']);

    service.stop();
  });

  it('a configured countdown of 30000ms clamps down to the 10000ms ceiling', () => {
    vi.useFakeTimers();
    const { store } = buildStore();
    const service = new QueueService(store, {
      SESSION_TIMEOUT_MS: 300_000,
      NEXT_GUEST_COUNTDOWN_MS: 30_000,
      SESSION_MAX_RETRIES: 2,
    });
    const dispatched: string[] = [];
    service.bindSendCommand((cmd) => dispatched.push(cmd.jobId));

    service.start();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(9_999);
    expect(dispatched).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(dispatched).toEqual(['job-x']);

    service.stop();
  });

  it('an injected 12000ms session timeout stalls the job at exactly 12000ms after dispatch — not at the 300000ms default', () => {
    vi.useFakeTimers();
    const { store, requeueWithRetry } = buildStore({ requeueSequence: [1] });
    const service = new QueueService(store, {
      SESSION_TIMEOUT_MS: 12_000,
      NEXT_GUEST_COUNTDOWN_MS: 5_000,
      SESSION_MAX_RETRIES: 2,
    });
    service.bindSendCommand(() => {});

    service.start();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(5_000); // dispatch -> BUSY, busyTimer armed for 12_000ms
    expect(requeueWithRetry).not.toHaveBeenCalled();

    vi.advanceTimersByTime(11_999);
    expect(requeueWithRetry).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(requeueWithRetry).toHaveBeenCalledTimes(1);

    service.stop();
  });

  it('a retry budget of 0 fails the job on its first stall instead of requeueing it', () => {
    vi.useFakeTimers();
    const { store, requeueWithRetry, failJob } = buildStore({ requeueSequence: [1] });
    const service = new QueueService(store, {
      SESSION_TIMEOUT_MS: 1_000,
      NEXT_GUEST_COUNTDOWN_MS: 5_000,
      SESSION_MAX_RETRIES: 0,
    });
    service.bindSendCommand(() => {});

    service.start();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(5_000); // dispatch
    vi.advanceTimersByTime(1_000); // stall

    expect(requeueWithRetry).toHaveBeenCalledTimes(1);
    expect(failJob).toHaveBeenCalledTimes(1);
    expect(failJob).toHaveBeenCalledWith('job-x', 'session_ack_timeout');

    service.stop();
  });

  it('a retry budget of 3 survives three stalls and fails the job on the fourth', () => {
    vi.useFakeTimers();
    const { store, requeueWithRetry, failJob } = buildStore({ requeueSequence: [1, 2, 3, 4] });
    const service = new QueueService(store, {
      SESSION_TIMEOUT_MS: 1_000,
      NEXT_GUEST_COUNTDOWN_MS: 5_000,
      SESSION_MAX_RETRIES: 3,
    });
    service.bindSendCommand(() => {});

    service.start();
    vi.advanceTimersByTime(250);
    for (let attempt = 0; attempt < 4; attempt++) {
      vi.advanceTimersByTime(5_000); // dispatch
      vi.advanceTimersByTime(1_000); // stall
    }

    expect(requeueWithRetry).toHaveBeenCalledTimes(4);
    expect(failJob).toHaveBeenCalledTimes(1);
    expect(failJob).toHaveBeenCalledWith('job-x', 'session_ack_timeout');

    service.stop();
  });

  it('environment variables set to conspicuously different values before construction change none of the injected timing', () => {
    // Belt-and-braces only: getConfig() caches its result at first module
    // load, so a late environment mutation would not reach the service even
    // if the old process.env-reading code were still in place. The primary
    // evidence for D-13 is plan 02-01's grep gate (no process.env reads
    // under src/queue/) together with every other timing assertion in this
    // file following a value that exists only in the injected object.
    vi.useFakeTimers();

    const prevCountdown = process.env.NEXT_GUEST_COUNTDOWN_MS;
    const prevTimeout = process.env.SESSION_TIMEOUT_MS;
    const prevRetries = process.env.SESSION_MAX_RETRIES;
    process.env.NEXT_GUEST_COUNTDOWN_MS = '999999';
    process.env.SESSION_TIMEOUT_MS = '999999';
    process.env.SESSION_MAX_RETRIES = '999999';

    try {
      const { store, requeueWithRetry } = buildStore({ requeueSequence: [1] });
      const service = new QueueService(store, {
        SESSION_TIMEOUT_MS: 6_000,
        NEXT_GUEST_COUNTDOWN_MS: 5_000,
        SESSION_MAX_RETRIES: 2,
      });
      const dispatched: string[] = [];
      service.bindSendCommand((cmd) => dispatched.push(cmd.jobId));

      service.start();
      vi.advanceTimersByTime(250);
      vi.advanceTimersByTime(4_999);
      expect(dispatched).toEqual([]);
      vi.advanceTimersByTime(1); // dispatch at the injected 5000ms, not env's 999999ms
      expect(dispatched).toEqual(['job-x']);

      vi.advanceTimersByTime(5_999);
      expect(requeueWithRetry).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1); // stall at the injected 6000ms, not env's 999999ms
      expect(requeueWithRetry).toHaveBeenCalledTimes(1);

      service.stop();
    } finally {
      if (prevCountdown === undefined) delete process.env.NEXT_GUEST_COUNTDOWN_MS;
      else process.env.NEXT_GUEST_COUNTDOWN_MS = prevCountdown;
      if (prevTimeout === undefined) delete process.env.SESSION_TIMEOUT_MS;
      else process.env.SESSION_TIMEOUT_MS = prevTimeout;
      if (prevRetries === undefined) delete process.env.SESSION_MAX_RETRIES;
      else process.env.SESSION_MAX_RETRIES = prevRetries;
    }
  });

  it('constructed with no config argument at all, the service still works and uses the config.ts defaults — 7000ms countdown', () => {
    vi.useFakeTimers();
    const { store } = buildStore();
    const service = new QueueService(store);
    const dispatched: string[] = [];
    service.bindSendCommand((cmd) => dispatched.push(cmd.jobId));

    service.start();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(6_999);
    expect(dispatched).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(dispatched).toEqual(['job-x']);

    service.stop();
  });
});
