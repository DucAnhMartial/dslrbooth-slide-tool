import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueService } from '../src/queue/queueService';
import type { LocalStore } from '../src/state/localStore';

// SC-1: no sequence of capture-phase events reaches the completion anchor.
// 07-EVIDENCE-dslrbooth-triggers.md is explicit that the retake sequence
// mid-capture was never measured live, so this covers the guarantee that
// makes a retake irrelevant to completion — structurally, rather than by
// simulating an unmeasured trigger order. Mock shape copied from
// test/queue-event-coverage.test.ts's buildStore(), extended with Task 1's
// current_job_id surface.

const CONFIG = { SESSION_TIMEOUT_MS: 300_000, NEXT_GUEST_COUNTDOWN_MS: 5_000, SESSION_MAX_RETRIES: 2 };

const BOUND_JOB_ID = 'job-x';

function buildStore() {
  const updateJobStatus = vi.fn();
  const completeJob = vi.fn(() => true);
  let booth = 'BUSY';
  let currentJobId: string | undefined = BOUND_JOB_ID;
  const store = {
    getBoothState: () => booth,
    getNextQueuedJob: () => undefined,
    setBoothState: (s: string) => {
      booth = s;
      currentJobId = undefined;
    },
    setBoothBusy: (jobId?: string | null) => {
      booth = 'BUSY';
      currentJobId = jobId ?? undefined;
    },
    setBoothIdle: () => {
      booth = 'IDLE';
      currentJobId = undefined;
    },
    setBoothTimeout: () => {
      booth = 'IDLE';
      currentJobId = undefined;
    },
    getBoothCurrentJobId: () => currentJobId,
    setBoothCurrentJob: (jobId: string | null) => {
      currentJobId = jobId ?? undefined;
    },
    getJob: () => undefined, // unknown to the mocked store — sessionAcked's terminal guard does not block it
    updateJobStatus,
    getQueuedGuestSummaries: () => [],
    getQueueLength: () => 0,
    completeJob,
    getQueuePosition: () => undefined,
    getJobRegistration: () => undefined,
  } as unknown as LocalStore;
  return { store, updateJobStatus, completeJob, getBooth: () => booth };
}

// Every AGT-04 capture-phase event that is NOT a print composite
// (processing_start/printing) or a booth-release (session_end).
const CAPTURE_SEQUENCE = ['capture_start', 'session_start', 'file_download', 'countdown', 'countdown_start', 'sharing_screen'];

describe('QueueService — no sequence of capture-phase events reaches the completion anchor (SC-1)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('the full capture-phase sequence for the job that owns the booth never completes it and never changes current_job_id', () => {
    const { store, completeJob } = buildStore();
    const service = new QueueService(store, CONFIG);

    for (const eventType of CAPTURE_SEQUENCE) {
      service.onAgentEvent(eventType, BOUND_JOB_ID, {});
    }

    expect(completeJob).not.toHaveBeenCalled();
    expect(store.getBoothState()).toBe('BUSY');
    expect(store.getBoothCurrentJobId()).toBe(BOUND_JOB_ID);
    service.stop();
  });

  it('the same sequence delivered twice — the shape a retake would take if it re-emits capture events — still never completes the job', () => {
    const { store, completeJob } = buildStore();
    const service = new QueueService(store, CONFIG);

    for (let round = 0; round < 2; round++) {
      for (const eventType of CAPTURE_SEQUENCE) {
        service.onAgentEvent(eventType, BOUND_JOB_ID, {});
      }
    }

    expect(completeJob).not.toHaveBeenCalled();
    expect(store.getBoothState()).toBe('BUSY');
    expect(store.getBoothCurrentJobId()).toBe(BOUND_JOB_ID);
    service.stop();
  });
});
