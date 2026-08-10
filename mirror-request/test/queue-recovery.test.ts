import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { LocalStore } from '../src/state/localStore';
import { QueueService } from '../src/queue/queueService';

// `booth_state` is a single global row (`CHECK (id = 1)`), shared across every
// test file that uses the shared store singleton under parallel Vitest
// workers (02-VALIDATION.md, binding). This file never reaches for that
// singleton — every test below either drives a real `LocalStore` on its own
// per-file temp database (`constructor(dbPath?)`, following
// db-poller.test.ts's pattern) or a hand-built mocked store.

describe('QueueService.recover() — end-to-end restart recovery (D-01, D-02, Pitfall 1)', () => {
  let dir: string;
  let dbPath: string;
  let store: LocalStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-queue-recovery-'));
    dbPath = path.join(dir, 'test.sqlite');
    store = new LocalStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resets a six-hour-stale BUSY booth and resolves every stranded row under the bounded retry policy', () => {
    // Seed 4 queue_job rows with explicit ascending queued_at, reproducing
    // the live 4-row scenario (3 stranded 'dispatched' rows + 1 guest queued
    // behind them, never dispatched).
    store.enqueueJob({ id: 'job-a', queued_at: 1_000 });
    store.enqueueJob({ id: 'job-b', queued_at: 2_000 });
    store.enqueueJob({ id: 'job-c', queued_at: 3_000 });
    store.enqueueJob({ id: 'job-d', queued_at: 4_000 });

    // job-a and job-c: dispatched, under the retry budget (retries=0).
    store.updateJobStatus('job-a', 'dispatched', 'dispatched_at', 1_500);
    store.updateJobStatus('job-c', 'dispatched', 'dispatched_at', 3_500);

    // job-b: already requeued twice before this test begins (retries=2),
    // then put back in flight — arrives at recover() already at the retry
    // ceiling for SESSION_MAX_RETRIES=2.
    store.requeueWithRetry('job-b');
    store.requeueWithRetry('job-b');
    store.updateJobStatus('job-b', 'dispatched', 'dispatched_at', 2_500);

    // job-d stays 'queued' — never dispatched. Recovery must touch only
    // in-flight rows.

    store.setBoothState('BUSY');

    // LocalStore has no setter that backdates booth_state.updated_at — every
    // setter stamps the current time — so open a second short-lived
    // better-sqlite3 connection to the same temp path and backdate directly.
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const raw = new Database(dbPath);
    raw.prepare('UPDATE booth_state SET updated_at = ? WHERE id = 1').run(sixHoursAgo);
    raw.close();

    const queue = new QueueService(store, {
      SESSION_TIMEOUT_MS: 300_000,
      NEXT_GUEST_COUNTDOWN_MS: 7_000,
      SESSION_MAX_RETRIES: 2,
    });

    queue.recover();

    expect(store.getBoothState()).toBe('IDLE');
    expect(store.getInFlightJobs()).toHaveLength(0);

    const jobA = store.getJob('job-a')!;
    expect(jobA.status).toBe('queued');
    expect(jobA.retries).toBe(1);
    expect(jobA.queued_at).toBe(1_000);

    const jobC = store.getJob('job-c')!;
    expect(jobC.status).toBe('queued');
    expect(jobC.retries).toBe(1);
    expect(jobC.queued_at).toBe(3_000);

    const jobB = store.getJob('job-b')!;
    expect(jobB.status).toBe('failed');
    expect(jobB.retries).toBe(3);
    expect(jobB.stall_reason).toBe('restart_recovery_timeout');

    const jobD = store.getJob('job-d')!;
    expect(jobD.status).toBe('queued');
    expect(jobD.retries).toBe(0);

    // The requeued job with the smallest original queued_at leads the queue
    // — not job-d, which was queued behind the stranded rows and never
    // dispatched (QUE-01, D-06: a requeued guest is not demoted).
    expect(store.getNextQueuedJob()?.id).toBe('job-a');
  });

  it('sweeps an orphan dispatched row from an earlier incident even when the booth is IDLE (Pitfall 1)', () => {
    store.enqueueJob({ id: 'orphan-job', queued_at: 1_000 });
    store.updateJobStatus('orphan-job', 'dispatched', 'dispatched_at', 1_500);
    // booth_state defaults to IDLE; never set BUSY — this orphan has no link
    // back to the current booth state, which is exactly why the sweep must
    // be unconditional.

    expect(store.getBoothState()).toBe('IDLE');

    const queue = new QueueService(store, {
      SESSION_TIMEOUT_MS: 300_000,
      NEXT_GUEST_COUNTDOWN_MS: 7_000,
      SESSION_MAX_RETRIES: 2,
    });

    queue.recover();

    expect(store.getBoothState()).toBe('IDLE');
    expect(store.getInFlightJobs()).toHaveLength(0);

    const orphan = store.getJob('orphan-job')!;
    expect(orphan.status).toBe('queued');
    expect(orphan.retries).toBe(1);
    expect(orphan.queued_at).toBe(1_000);
  });
});

describe('QueueService.recover() — D-03 age-based BUSY survival, D-04 ANNOUNCING reset', () => {
  const NOW = Date.UTC(2026, 7, 10, 12, 0, 0);

  afterEach(() => vi.useRealTimers());

  it('BUSY at 60s of a 300_000ms timeout with one in-flight row leaves the booth BUSY and re-arms the timer for exactly the 240_000ms remainder', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const setBoothTimeout = vi.fn();
    const setBoothIdle = vi.fn();
    const requeueWithRetry = vi.fn().mockReturnValue({ retries: 1 });
    const failJob = vi.fn();
    const store = {
      getBoothState: () => 'BUSY',
      getBoothStateDetailed: () => ({ state: 'BUSY', updated_at: new Date(NOW - 60_000).toISOString() }),
      getInFlightJobs: () => [{ id: 'job-live' }],
      setBoothTimeout,
      setBoothIdle,
      updateJobStatus: vi.fn(),
      requeueWithRetry,
      failJob,
    } as unknown as LocalStore;

    const queue = new QueueService(store, { SESSION_TIMEOUT_MS: 300_000, NEXT_GUEST_COUNTDOWN_MS: 7_000, SESSION_MAX_RETRIES: 2 });
    queue.recover();

    // No reset call is made — the booth stays BUSY.
    expect(setBoothTimeout).not.toHaveBeenCalled();
    expect(setBoothIdle).not.toHaveBeenCalled();
    // The single in-flight row is the survivor — it is not swept.
    expect(requeueWithRetry).not.toHaveBeenCalled();
    expect(failJob).not.toHaveBeenCalled();

    // The re-armed busyTimer fires at exactly 240_000ms, not 300_000ms and
    // not immediately.
    vi.advanceTimersByTime(239_999);
    expect(setBoothTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(setBoothTimeout).toHaveBeenCalledTimes(1);
  });

  it('sweeps only the older in-flight row, leaving the most recently dispatched one alone', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const requeueWithRetry = vi.fn().mockReturnValue({ retries: 1 });
    const store = {
      getBoothState: () => 'BUSY',
      getBoothStateDetailed: () => ({ state: 'BUSY', updated_at: new Date(NOW - 60_000).toISOString() }),
      // dispatched_at DESC — job-live (most recent) first, job-old (earlier) second.
      getInFlightJobs: () => [{ id: 'job-live' }, { id: 'job-old' }],
      setBoothTimeout: vi.fn(),
      setBoothIdle: vi.fn(),
      updateJobStatus: vi.fn(),
      requeueWithRetry,
      failJob: vi.fn(),
    } as unknown as LocalStore;

    const queue = new QueueService(store, { SESSION_TIMEOUT_MS: 300_000, NEXT_GUEST_COUNTDOWN_MS: 7_000, SESSION_MAX_RETRIES: 2 });
    queue.recover();

    expect(requeueWithRetry).toHaveBeenCalledTimes(1);
    expect(requeueWithRetry).toHaveBeenCalledWith('job-old');
  });

  it('resets the booth when age is 60s but there are zero in-flight rows — nothing to protect', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const setBoothTimeout = vi.fn();
    const store = {
      getBoothState: () => 'BUSY',
      getBoothStateDetailed: () => ({ state: 'BUSY', updated_at: new Date(NOW - 60_000).toISOString() }),
      getInFlightJobs: () => [],
      setBoothTimeout,
      setBoothIdle: vi.fn(),
      requeueWithRetry: vi.fn(),
      failJob: vi.fn(),
    } as unknown as LocalStore;

    const queue = new QueueService(store, { SESSION_TIMEOUT_MS: 300_000, NEXT_GUEST_COUNTDOWN_MS: 7_000, SESSION_MAX_RETRIES: 2 });
    queue.recover();

    expect(setBoothTimeout).toHaveBeenCalledTimes(1);
  });

  it('ANNOUNCING resets to IDLE without a timeout warning, and still sweeps any in-flight orphan row', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const setBoothTimeout = vi.fn();
    const setBoothIdle = vi.fn();
    const requeueWithRetry = vi.fn().mockReturnValue({ retries: 1 });
    const store = {
      getBoothState: () => 'ANNOUNCING',
      getBoothStateDetailed: () => ({ state: 'ANNOUNCING', updated_at: new Date(NOW - 3_000).toISOString() }),
      getInFlightJobs: () => [{ id: 'orphan-job' }],
      setBoothTimeout,
      setBoothIdle,
      requeueWithRetry,
      failJob: vi.fn(),
    } as unknown as LocalStore;

    const queue = new QueueService(store, { SESSION_TIMEOUT_MS: 300_000, NEXT_GUEST_COUNTDOWN_MS: 7_000, SESSION_MAX_RETRIES: 2 });
    queue.recover();

    expect(setBoothIdle).toHaveBeenCalledTimes(1);
    expect(setBoothTimeout).not.toHaveBeenCalled();
    expect(requeueWithRetry).toHaveBeenCalledWith('orphan-job');
  });

  it('treats an unparsable updated_at on a BUSY booth as unknown, therefore dead — resets and sweeps', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const setBoothTimeout = vi.fn();
    const requeueWithRetry = vi.fn().mockReturnValue({ retries: 1 });
    const store = {
      getBoothState: () => 'BUSY',
      getBoothStateDetailed: () => ({ state: 'BUSY', updated_at: 'not-a-real-timestamp' }),
      getInFlightJobs: () => [{ id: 'job-corrupt-age' }],
      setBoothTimeout,
      setBoothIdle: vi.fn(),
      requeueWithRetry,
      failJob: vi.fn(),
    } as unknown as LocalStore;

    const queue = new QueueService(store, { SESSION_TIMEOUT_MS: 300_000, NEXT_GUEST_COUNTDOWN_MS: 7_000, SESSION_MAX_RETRIES: 2 });
    queue.recover();

    expect(setBoothTimeout).toHaveBeenCalledTimes(1);
    expect(requeueWithRetry).toHaveBeenCalledWith('job-corrupt-age');
  });
});

describe('QueueService config injection (D-13)', () => {
  afterEach(() => vi.useRealTimers());

  it('announces for the injected countdown and times out at the injected SESSION_TIMEOUT_MS, with no environment variable involved', () => {
    vi.useFakeTimers();

    // Environment variables set to wildly different values than the injected
    // config — if the service reads process.env anywhere, these timings
    // would not match and the test would fail.
    const prevTimeout = process.env.SESSION_TIMEOUT_MS;
    const prevCountdown = process.env.NEXT_GUEST_COUNTDOWN_MS;
    process.env.SESSION_TIMEOUT_MS = '999999';
    process.env.NEXT_GUEST_COUNTDOWN_MS = '999999';

    try {
      let booth = 'IDLE';
      const job = { id: 'job-x' };
      const timeoutEvents: string[] = [];
      const store = {
        getBoothState: () => booth,
        getNextQueuedJob: () => (booth === 'IDLE' ? job : undefined),
        setBoothState: (state: string) => { booth = state; },
        setBoothBusy: () => { booth = 'BUSY'; },
        setBoothIdle: () => { booth = 'IDLE'; },
        setBoothTimeout: () => { timeoutEvents.push('timeout'); booth = 'IDLE'; },
        updateJobStatus: () => {},
        getQueuePosition: () => 1,
        getQueueLength: () => 1,
        getQueuedGuestSummaries: () => [{ jobId: job.id, name: 'Guest', position: 1 }],
        // The injected 20_000ms timeout now routes through handleStall()
        // (plan 02-02, task 1), which needs these two store primitives even
        // though this test only asserts on the injected-config timing.
        requeueWithRetry: () => ({ retries: 1 }),
        failJob: () => {},
      } as unknown as LocalStore;

      const queue = new QueueService(store, {
        SESSION_TIMEOUT_MS: 20_000,
        NEXT_GUEST_COUNTDOWN_MS: 5_000,
        SESSION_MAX_RETRIES: 2,
      });
      const dispatched: string[] = [];
      queue.bindSendCommand(command => dispatched.push(command.jobId));

      queue.start();
      vi.advanceTimersByTime(250);
      expect(booth).toBe('ANNOUNCING');

      // Announces for exactly the injected 5_000ms countdown, not the
      // env-configured 999999ms and not the old 7_000ms default.
      vi.advanceTimersByTime(4_999);
      expect(dispatched).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(dispatched).toEqual(['job-x']);
      expect(booth).toBe('BUSY');

      // Times out at exactly the injected 20_000ms, not the env-configured
      // 999999ms and not the old 300_000ms default.
      vi.advanceTimersByTime(19_999);
      expect(timeoutEvents).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(timeoutEvents).toEqual(['timeout']);

      queue.stop();
    } finally {
      if (prevTimeout === undefined) delete process.env.SESSION_TIMEOUT_MS;
      else process.env.SESSION_TIMEOUT_MS = prevTimeout;
      if (prevCountdown === undefined) delete process.env.NEXT_GUEST_COUNTDOWN_MS;
      else process.env.NEXT_GUEST_COUNTDOWN_MS = prevCountdown;
    }
  });
});
