import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueService, queueLogger } from '../src/queue/queueService';
import type { LocalStore } from '../src/state/localStore';
import { createPendingPrintRegistry, type PendingPrintRow } from './helpers/pendingPrintRegistry';
import { NO_PHOTO_SWEEP_STUB } from './helpers/noPhotoSweep';

/**
 * Task 2 (11-04): D11-05's finalize gate, `finalizePendingPrint(jobId, door)`,
 * is the ONE place a guest's photo is sent — an approving `printing` (door 1),
 * a grace-timer expiry (door 2) and the CMS operator release (door 3, built
 * in 11-03) are three independent triggers into the SAME idempotent
 * predicate, `LocalStore.markPendingPrintFinalized()`'s `WHERE status IN
 * ('awaiting','expired')`.
 *
 * This file proves the GATE ITSELF is safe against every ordering of those
 * three triggers — not merely that no current call site happens to race.
 * Every ordering case therefore calls the private `finalizePendingPrint`
 * method directly for at least the SECOND call, exactly the technique
 * test/queue-dual-completion.test.ts's own `approved_by=operator` case
 * already established for reaching a door before its own real call site
 * existed: "the CMS route... is 11-03's own scope; the gate itself is
 * already real and callable today." In production the surrounding call
 * sites already make a genuine two-door race structurally rare (a grace
 * timer is cleared by finalize before it could ever fire again, an operator
 * release's own outer guard refuses once the booth has moved on) — this
 * file is deliberately testing UNDER that plumbing, so the guarantee holds
 * even if a future bug, a restart, or some other path called the gate
 * twice.
 *
 * Every case asserts three things, not one: the observable outcome (job
 * status / photo delivery), the recorded door (`pending_print.approved_by`,
 * unchanged by a second call), and the notification call count — a case
 * that checked only the outcome would pass against a gate that finalized
 * twice and happened to write the same status.
 */

const JOB = 'job-idempotency';
const COMPOSITE = 'C:\\dslrBooth\\Test_event\\Prints\\20260818_110000_000.jpg';
const PHOTO_URL = 'https://fotoshare.co/i/idem001';

const CONFIG = {
  SESSION_TIMEOUT_MS: 300_000,
  NEXT_GUEST_COUNTDOWN_MS: 5_000,
  SESSION_MAX_RETRIES: 2,
  BOOTH_RELEASE_TIMEOUT_MS: 120_000,
  RETAKE_GRACE_MS: 20_000,
};

type FinalizeDoor = 'printing' | 'grace' | 'operator';

function seededRow(photoUrl: string | undefined, jobId: string = JOB): PendingPrintRow {
  return {
    jobId,
    compositePath: COMPOSITE,
    status: 'awaiting',
    openedAt: Date.now() - 1_000,
    expiresAt: Date.now() + 600_000,
    attemptNo: 1,
    photoUrl,
  };
}

function buildStore(seed: PendingPrintRow[] = [], jobId: string = JOB) {
  let booth: string = 'BUSY';
  let currentJobId: string | undefined = jobId;
  let attemptOpen = true;
  let attemptNo = 1;
  const jobStatus: Record<string, string> = { [jobId]: 'in_progress' };
  const jobAcknowledgedAt: Record<string, number> = { [jobId]: Date.now() };
  const pendingPrint = createPendingPrintRegistry(seed);

  const requeueWithRetry = vi.fn();
  const failJob = vi.fn();

  const completeJob = vi.fn((id: string) => {
    if (jobStatus[id] !== 'in_progress') return false;
    jobStatus[id] = 'completed';
    return true;
  });
  const closeJobNoPhoto = vi.fn((id: string) => {
    if (jobStatus[id] !== 'in_progress') return false;
    jobStatus[id] = 'no_photo';
    return true;
  });

  const store = {
    getBoothState: () => booth,
    getNextQueuedJob: () => undefined,
    setBoothState: (s: string) => { booth = s; currentJobId = undefined; attemptOpen = false; attemptNo = 0; },
    setBoothBusy: (id?: string | null) => { booth = 'BUSY'; currentJobId = id ?? undefined; attemptOpen = false; attemptNo = 0; },
    setBoothIdle: () => { booth = 'IDLE'; currentJobId = undefined; attemptOpen = false; attemptNo = 0; },
    setBoothTimeout: () => { booth = 'IDLE'; currentJobId = undefined; attemptOpen = false; attemptNo = 0; },
    getBoothCurrentJobId: () => currentJobId,
    setBoothCurrentJob: (id: string | null) => { currentJobId = id ?? undefined; },
    getBoothAttempt: () => ({ attemptOpen, attemptNo }),
    openBoothAttempt: () => { attemptOpen = true; attemptNo += 1; return { attemptOpen, attemptNo }; },
    closeBoothAttempt: () => { attemptOpen = false; },
    getJob: (id: string) => (id in jobStatus ? { id, status: jobStatus[id], acknowledged_at: jobAcknowledgedAt[id] } : undefined),
    updateJobStatus: (id: string, status: string, tsField?: string, tsValue?: number) => {
      jobStatus[id] = status;
      if (tsField === 'acknowledged_at' && tsValue !== undefined) jobAcknowledgedAt[id] = tsValue;
    },
    completeJob,
    closeJobNoPhoto,
    getQueuedGuestSummaries: () => [],
    getQueueLength: () => 0,
    getQueuePosition: () => undefined,
    getJobRegistration: () => undefined,
    getActiveEventId: () => undefined,
    ...pendingPrint.registry,
    requeueWithRetry,
    requeueNoRetry: vi.fn(),
    failJob,
    ...NO_PHOTO_SWEEP_STUB,
  } as unknown as LocalStore;

  return { store, jobStatus, pendingPrintRows: pendingPrint.rows, requeueWithRetry, failJob, getBooth: () => booth };
}

/** Reaches the gate directly — see this file's own header for why. */
function callFinalize(service: QueueService, jobId: string, door: FinalizeDoor): boolean {
  return (service as unknown as { finalizePendingPrint: (jobId: string, door: FinalizeDoor) => boolean })
    .finalizePendingPrint(jobId, door);
}

describe('QueueService.finalizePendingPrint — three doors, one gate, idempotent across every ordering (D11-05)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('printing wins, then grace expiry fires: the second is a no-op, the recorded door stays printing, and exactly one notification was sent', () => {
    const { store, jobStatus, pendingPrintRows } = buildStore([seededRow(PHOTO_URL)]);
    const service = new QueueService(store, CONFIG);
    const sendPhotoLink = vi.fn(async () => {});
    service.bindNotificationService({ sendPhotoLink });
    const infoSpy = vi.spyOn(queueLogger, 'info');

    expect(callFinalize(service, JOB, 'printing')).toBe(true);
    expect(callFinalize(service, JOB, 'grace')).toBe(false);

    expect(jobStatus[JOB]).toBe('completed');
    expect(pendingPrintRows.get(JOB)?.approvedBy).toBe('printing');
    expect(sendPhotoLink).toHaveBeenCalledTimes(1);
    expect(store.completeJob).toHaveBeenCalledTimes(1);
    expect(
      infoSpy.mock.calls.some((c) =>
        String(c[0]).includes(`finalizePendingPrint ignored for ${JOB}: already finalized (door=grace)`)),
    ).toBe(true);

    service.stop();
  });

  it('printing wins, then an operator release arrives: same — no-op, the recorded door stays printing, one notification', () => {
    const { store, jobStatus, pendingPrintRows } = buildStore([seededRow(PHOTO_URL)]);
    const service = new QueueService(store, CONFIG);
    const sendPhotoLink = vi.fn(async () => {});
    service.bindNotificationService({ sendPhotoLink });

    expect(callFinalize(service, JOB, 'printing')).toBe(true);

    // The realistic route: releaseForOperator()'s own outer guard already
    // refuses, because door 1 already released the booth (current_job_id is
    // no longer JOB) — idempotency is enforced even ABOVE the gate.
    expect(service.releaseForOperator(JOB)).toBe('wrong_job');
    // The gate itself, reached directly, is equally idempotent underneath
    // that outer guard — not merely lucky that the outer guard caught it.
    expect(callFinalize(service, JOB, 'operator')).toBe(false);

    expect(jobStatus[JOB]).toBe('completed');
    expect(pendingPrintRows.get(JOB)?.approvedBy).toBe('printing');
    expect(sendPhotoLink).toHaveBeenCalledTimes(1);

    service.stop();
  });

  it('grace expiry wins, then a late printing arrives: same — no-op, and the late printing is REPORTED (a warn), never silently dropped', () => {
    const { store, jobStatus, pendingPrintRows } = buildStore([seededRow(PHOTO_URL)]);
    const service = new QueueService(store, CONFIG);
    const sendPhotoLink = vi.fn(async () => {});
    service.bindNotificationService({ sendPhotoLink });
    const warnSpy = vi.spyOn(queueLogger, 'warn');

    expect(callFinalize(service, JOB, 'grace')).toBe(true);

    // The late printing arrives through the REAL event path, not a direct
    // call — this is what proves it is reported, not merely a silent no-op.
    service.onAgentEvent('printing', JOB, { param1: COMPOSITE, param2: '1', param3: 'DS-RX1' });

    expect(jobStatus[JOB]).toBe('completed');
    expect(pendingPrintRows.get(JOB)?.approvedBy).toBe('grace');
    expect(sendPhotoLink).toHaveBeenCalledTimes(1);
    expect(
      warnSpy.mock.calls.some((c) =>
        String(c[0]).includes(`printing for job ${JOB} arrived with no job bound to the booth`)),
    ).toBe(true);

    service.stop();
  });

  it('an operator release wins, then grace expiry fires: same — no-op, and the grace timer firing against an already-finalized job changes nothing', () => {
    const { store, jobStatus, pendingPrintRows } = buildStore([seededRow(PHOTO_URL)]);
    const service = new QueueService(store, CONFIG);
    const sendPhotoLink = vi.fn(async () => {});
    service.bindNotificationService({ sendPhotoLink });

    expect(service.releaseForOperator(JOB)).toBe('released');
    expect(callFinalize(service, JOB, 'grace')).toBe(false);

    expect(jobStatus[JOB]).toBe('completed');
    expect(pendingPrintRows.get(JOB)?.approvedBy).toBe('operator');
    expect(sendPhotoLink).toHaveBeenCalledTimes(1);

    service.stop();
  });

  it('across all six door orderings, the gate finalizes exactly once per job and sends at most one notification', () => {
    const doors: FinalizeDoor[] = ['printing', 'grace', 'operator'];
    for (const first of doors) {
      for (const second of doors) {
        if (first === second) continue;
        const jobId = `job-${first}-${second}`;
        const { store, pendingPrintRows } = buildStore([seededRow(PHOTO_URL, jobId)], jobId);
        const service = new QueueService(store, CONFIG);
        const sendPhotoLink = vi.fn(async () => {});
        service.bindNotificationService({ sendPhotoLink });

        expect(callFinalize(service, jobId, first)).toBe(true);
        expect(callFinalize(service, jobId, second)).toBe(false);

        expect(pendingPrintRows.get(jobId)?.approvedBy).toBe(first);
        expect(sendPhotoLink).toHaveBeenCalledTimes(1);

        service.stop();
      }
    }
  });
});

describe('QueueService.finalizePendingPrint — the no-URL close and the late-arrival guarantee survive the move of the send site (D-11/D11-04)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a job finalized with NO URL held closes without a photo, charges no retry, writes no stall reason, and sends nothing', () => {
    const { store, jobStatus, requeueWithRetry, failJob, pendingPrintRows } = buildStore([seededRow(undefined)]);
    const service = new QueueService(store, CONFIG);
    const sendPhotoLink = vi.fn(async () => {});
    service.bindNotificationService({ sendPhotoLink });

    expect(callFinalize(service, JOB, 'grace')).toBe(true);

    expect(jobStatus[JOB]).toBe('no_photo');
    expect(store.closeJobNoPhoto).toHaveBeenCalledTimes(1);
    expect(store.completeJob).not.toHaveBeenCalled();
    // "charges no retry, writes no stall reason": this codebase's only two
    // writers of stall_reason/a retry count are requeueWithRetry and
    // failJob — neither is ever called by the finalize gate.
    expect(requeueWithRetry).not.toHaveBeenCalled();
    expect(failJob).not.toHaveBeenCalled();
    expect(sendPhotoLink).not.toHaveBeenCalled();
    expect(pendingPrintRows.get(JOB)?.approvedBy).toBe('grace');

    service.stop();
  });

  it('a print upload arriving after that no-photo close is delivered late with a WARNING, exactly once — a second copy of the same upload is not delivered again (an INFO, not silent)', () => {
    const { store, jobStatus } = buildStore([seededRow(undefined)]);
    const service = new QueueService(store, CONFIG);
    const sendPhotoLink = vi.fn(async () => {});
    service.bindNotificationService({ sendPhotoLink });
    const warnSpy = vi.spyOn(queueLogger, 'warn');
    const infoSpy = vi.spyOn(queueLogger, 'info');

    expect(callFinalize(service, JOB, 'grace')).toBe(true);
    expect(jobStatus[JOB]).toBe('no_photo');

    service.onAgentEvent('file_upload', JOB, { param3: 'print', param2: PHOTO_URL });
    expect(sendPhotoLink).toHaveBeenCalledTimes(1);
    expect(sendPhotoLink).toHaveBeenCalledWith(JOB, PHOTO_URL);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('delivering late'))).toBe(true);

    // A resend of the exact same upload — dslrBooth retrying, or a network
    // replay — must not deliver a second copy.
    infoSpy.mockClear();
    service.onAgentEvent('file_upload', JOB, { param3: 'print', param2: PHOTO_URL });
    expect(sendPhotoLink).toHaveBeenCalledTimes(1);
    expect(
      infoSpy.mock.calls.some((c) => String(c[0]).includes('already finalized with a photo already sent')),
    ).toBe(true);

    service.stop();
  });

  it('a print upload arriving after a finalize that already sent is a no-op that LOGS (an INFO), not a silent drop', () => {
    const { store, jobStatus } = buildStore([seededRow(PHOTO_URL)]);
    const service = new QueueService(store, CONFIG);
    const sendPhotoLink = vi.fn(async () => {});
    service.bindNotificationService({ sendPhotoLink });
    const infoSpy = vi.spyOn(queueLogger, 'info');

    expect(callFinalize(service, JOB, 'printing')).toBe(true);
    expect(jobStatus[JOB]).toBe('completed');
    expect(sendPhotoLink).toHaveBeenCalledTimes(1);

    // A replay/duplicate of the SAME print upload arriving afterward.
    service.onAgentEvent('file_upload', JOB, { param3: 'print', param2: PHOTO_URL });

    expect(sendPhotoLink).toHaveBeenCalledTimes(1); // never a second delivery
    expect(
      infoSpy.mock.calls.some((c) => String(c[0]).includes('already finalized with a photo already sent')),
    ).toBe(true);

    service.stop();
  });
});
