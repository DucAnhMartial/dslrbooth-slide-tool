import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { LocalStore } from '../src/state/localStore';
import { QueueService } from '../src/queue/queueService';

// `booth_state` is a single global row (`CHECK (id = 1)`), shared across every
// test file that uses the `getStore()` singleton under parallel Vitest
// workers (02-VALIDATION.md, binding). This file never calls `getStore()` —
// every test below either drives a real `LocalStore` on its own per-file
// temp database (`constructor(dbPath?)`, following db-poller.test.ts's
// pattern) or a hand-built mocked store.

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
