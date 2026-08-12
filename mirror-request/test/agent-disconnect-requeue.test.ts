import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalStore } from '../src/state/localStore';
import { QueueService } from '../src/queue/queueService';

// D-12/D-13: a disconnect while the booth is BUSY must return the in-flight
// job to `queued` without charging a retry, and must never double-fire with
// Phase 2's busyTimer in either trigger order. 03-VALIDATION.md binds every
// new test in this phase to either a mocked LocalStore or a per-file temp DB
// via the constructor(dbPath?) seam — never getStore() — because booth_state
// is a single global row with no per-test id to scope an assertion to.

const CONFIG = { SESSION_TIMEOUT_MS: 30_000, NEXT_GUEST_COUNTDOWN_MS: 5_000, SESSION_MAX_RETRIES: 2 };

type MockJob = { id: string; status: string; retries: number; queued_at: number };

function buildStore(jobs: MockJob[]) {
  let booth = 'IDLE';
  const requeueWithRetry = vi.fn((id: string) => {
    const job = jobs.find((j) => j.id === id);
    if (job) {
      job.status = 'queued';
      job.retries += 1;
    }
    return { retries: job?.retries ?? 0 };
  });
  const requeueNoRetry = vi.fn((id: string) => {
    const job = jobs.find((j) => j.id === id);
    if (job) job.status = 'queued';
  });
  const failJob = vi.fn();
  const updateJobStatus = vi.fn((id: string, status: string) => {
    const job = jobs.find((j) => j.id === id);
    if (job) job.status = status;
  });
  const store = {
    getBoothState: () => booth,
    getNextQueuedJob: () => jobs.find((j) => j.status === 'queued'),
    setBoothState: (s: string) => {
      booth = s;
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
    updateJobStatus,
    getQueuedGuestSummaries: () =>
      jobs.filter((j) => j.status === 'queued').map((j, i) => ({ jobId: j.id, name: `Guest ${j.id}`, position: i + 1 })),
    getQueueLength: () => jobs.filter((j) => j.status === 'queued').length,
    completeJob: () => false,
    getBoothCurrentJobId: () => undefined,
    setBoothCurrentJob: () => {},
    getQueuePosition: () => 1,
    getJobRegistration: () => undefined,
    getInFlightJobs: () => jobs.filter((j) => j.status === 'dispatched' || j.status === 'in_progress'),
    requeueWithRetry,
    requeueNoRetry,
    failJob,
  } as unknown as LocalStore;

  return { store, jobs, requeueWithRetry, requeueNoRetry, failJob, updateJobStatus, getBooth: () => booth };
}

describe('LocalStore.requeueNoRetry — real SQL proof (D-01, D-12, Phase 2 D-06)', () => {
  let dir: string;
  let dbPath: string;
  let store: LocalStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-disconnect-requeue-'));
    dbPath = path.join(dir, 'test.sqlite');
    store = new LocalStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a job at retries=2 in status dispatched becomes queued after requeueNoRetry(), with retries unchanged and queued_at byte-identical', () => {
    const id = 'job-real-1';
    store.enqueueJob({ id, queued_at: 5000 });
    store.requeueWithRetry(id); // retries -> 1
    store.requeueWithRetry(id); // retries -> 2
    store.updateJobStatus(id, 'dispatched', 'dispatched_at', Date.now());

    const before = store.getJob(id);
    expect(before?.status).toBe('dispatched');
    expect(before?.retries).toBe(2);
    expect(before?.queued_at).toBe(5000);

    store.requeueNoRetry(id);

    const after = store.getJob(id);
    expect(after?.status).toBe('queued');
    expect(after?.retries).toBe(2);
    expect(after?.queued_at).toBe(5000);
  });
});

describe('QueueService.onAgentDisconnected — mutual exclusion with the busyTimer (D-12, D-13, AGT-03 regression)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a disconnect while BUSY sets the booth IDLE and requeues without retry; advancing past the full session timeout afterwards never calls requeueWithRetry', () => {
    vi.useFakeTimers();
    let agentOnline = true;
    const jobs: MockJob[] = [{ id: 'job-a', status: 'queued', retries: 0, queued_at: 1000 }];
    const { store, requeueWithRetry, requeueNoRetry, getBooth } = buildStore(jobs);
    const service = new QueueService(store, CONFIG);
    service.bindIsAgentOnline(() => agentOnline);
    service.bindSendCommand(() => {});
    service.start();

    vi.advanceTimersByTime(250); // announce
    expect(getBooth()).toBe('ANNOUNCING');
    vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS); // dispatch -> BUSY, busyTimer armed
    expect(getBooth()).toBe('BUSY');

    agentOnline = false; // the Agent just died; also keeps the tick() inside
    // onAgentDisconnected() from immediately re-announcing the same job
    service.onAgentDisconnected();

    expect(getBooth()).toBe('IDLE');
    expect(store.getNextQueuedJob()?.id).toBe('job-a');
    expect(requeueWithRetry).not.toHaveBeenCalled();
    expect(requeueNoRetry).toHaveBeenCalledTimes(1);
    expect(requeueNoRetry).toHaveBeenCalledWith('job-a');

    vi.advanceTimersByTime(CONFIG.SESSION_TIMEOUT_MS); // the cancelled busyTimer must not fire
    expect(requeueWithRetry).not.toHaveBeenCalled();

    service.stop();
  });

  it('a disconnect arriving after the busy timer already resolved the job is a complete no-op', () => {
    vi.useFakeTimers();
    let agentOnline = true;
    const jobs: MockJob[] = [{ id: 'job-a', status: 'queued', retries: 0, queued_at: 1000 }];
    const { store, requeueWithRetry, requeueNoRetry, getBooth } = buildStore(jobs);
    const service = new QueueService(store, CONFIG);
    service.bindIsAgentOnline(() => agentOnline);
    service.bindSendCommand(() => {});
    service.start();

    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS); // dispatched, BUSY, busyTimer armed
    expect(getBooth()).toBe('BUSY');

    agentOnline = false; // unreachable, but the disconnect handler hasn't fired yet
    vi.advanceTimersByTime(CONFIG.SESSION_TIMEOUT_MS); // busyTimer wins first
    expect(getBooth()).toBe('IDLE');
    expect(requeueWithRetry).toHaveBeenCalledTimes(1);

    // The disconnect handler now arrives, late — must add nothing.
    service.onAgentDisconnected();

    expect(requeueNoRetry).not.toHaveBeenCalled();
    expect(getBooth()).toBe('IDLE');

    service.stop();
  });

  it('a disconnect while the booth is already IDLE performs no store write at all', () => {
    const jobs: MockJob[] = [];
    const { store, requeueWithRetry, requeueNoRetry } = buildStore(jobs);
    const setBoothIdleSpy = vi.spyOn(store, 'setBoothIdle');
    const service = new QueueService(store, CONFIG);

    service.onAgentDisconnected();

    expect(setBoothIdleSpy).not.toHaveBeenCalled();
    expect(requeueNoRetry).not.toHaveBeenCalled();
    expect(requeueWithRetry).not.toHaveBeenCalled();
  });

  it('two in-flight rows are both requeued without retry, matching Phase 2 sweep semantics for orphans', () => {
    const jobs: MockJob[] = [
      { id: 'job-a', status: 'dispatched', retries: 0, queued_at: 1000 },
      { id: 'job-b', status: 'in_progress', retries: 1, queued_at: 2000 },
    ];
    const { store, requeueNoRetry, requeueWithRetry, getBooth } = buildStore(jobs);
    store.setBoothBusy();
    const service = new QueueService(store, CONFIG);
    service.bindIsAgentOnline(() => false);

    service.onAgentDisconnected();

    expect(getBooth()).toBe('IDLE');
    expect(requeueNoRetry).toHaveBeenCalledTimes(2);
    expect(requeueNoRetry).toHaveBeenCalledWith('job-a');
    expect(requeueNoRetry).toHaveBeenCalledWith('job-b');
    expect(requeueWithRetry).not.toHaveBeenCalled();
    expect(jobs.every((j) => j.status === 'queued')).toBe(true);
  });

  it('AGT-03 regression: a positive ack still moves the job to in_progress with the booth left BUSY, untouched by the disconnect path', () => {
    const ackJobs: MockJob[] = [{ id: 'job-ack', status: 'dispatched', retries: 0, queued_at: 1000 }];
    const ackHarness = buildStore(ackJobs);
    ackHarness.store.setBoothBusy();
    const ackService = new QueueService(ackHarness.store, CONFIG);

    ackService.onAgentAck('job-ack', true);

    expect(ackHarness.updateJobStatus).toHaveBeenCalledWith('job-ack', 'in_progress', 'acknowledged_at', expect.any(Number));
    expect(ackHarness.getBooth()).toBe('BUSY');
    expect(ackHarness.requeueWithRetry).not.toHaveBeenCalled();
    expect(ackHarness.requeueNoRetry).not.toHaveBeenCalled();

    ackService.stop();
  });

  it('AGT-03 contrast: a NAK still charges a retry through handleStall while a disconnect for the same kind of failure charges none — two failures, two different budgets, asserted side by side (D-01)', () => {
    // Two separate harnesses, one per failure mode.
    const nakJobs: MockJob[] = [{ id: 'job-nak', status: 'dispatched', retries: 0, queued_at: 1000 }];
    const nakHarness = buildStore(nakJobs);
    nakHarness.store.setBoothBusy();
    const nakService = new QueueService(nakHarness.store, CONFIG);
    nakService.bindIsAgentOnline(() => false); // isolates the assertion from tick()'s re-announce

    nakService.onAgentAck('job-nak', false, 'camera offline');

    expect(nakHarness.requeueWithRetry).toHaveBeenCalledTimes(1);
    expect(nakHarness.requeueWithRetry).toHaveBeenCalledWith('job-nak');
    expect(nakJobs[0].retries).toBe(1);

    const discJobs: MockJob[] = [{ id: 'job-disc', status: 'dispatched', retries: 0, queued_at: 1000 }];
    const discHarness = buildStore(discJobs);
    discHarness.store.setBoothBusy();
    const discService = new QueueService(discHarness.store, CONFIG);
    discService.bindIsAgentOnline(() => false);

    discService.onAgentDisconnected();

    expect(discHarness.requeueWithRetry).not.toHaveBeenCalled();
    expect(discHarness.requeueNoRetry).toHaveBeenCalledTimes(1);
    expect(discJobs[0].retries).toBe(0);

    nakService.stop();
    discService.stop();
  });
});
