import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueService } from '../src/queue/queueService';
import type { LocalStore } from '../src/state/localStore';
import { createPendingPrintRegistry } from './helpers/pendingPrintRegistry';
import { NO_PHOTO_SWEEP_STUB } from './helpers/noPhotoSweep';

/**
 * D11-10: this file is REWRITTEN, not extended. The old fixture pinned the
 * broken assumption this phase exists to remove — "retake = capture events
 * repeated inside the same session" — a shape 07-EVIDENCE-dslrbooth-triggers.md
 * proved was never real: a retake is a brand-new dslrBooth session
 * (session_end → session_start), and every attempt, kept or discarded,
 * produces its own composite and its own file_upload param3=print.
 *
 * The fixture below is sequence D (07-EVIDENCE §D, "Retake, auto-print TẮT"),
 * transcribed VERBATIM from the evidence file — every timestamp, every param
 * value, every URL. Only the countdown lines (dropped everywhere in this
 * suite) and the wall-clock origin are not literal; every inter-event GAP
 * below is the exact millisecond delta between two consecutive evidence
 * timestamps, so the fake-timer advances below replay the real recorded
 * rhythm of the retake, not an invented one.
 *
 * D11-05 door 3 (operator release) and door "no attempt open"/"composite
 * mismatch" (sequence E, the gallery reprint) are NOT this file's job — they
 * are exercised in 11-02's / 11-03's own test files, per this plan's own
 * scope: "Sequence C, sequence E, the operator door, the wide suite rewrite
 * and the docs are expansion, in later waves."
 */

// 07-EVIDENCE §D — the print composite URLs, verbatim. Attempt 1's is the
// one that must NEVER reach the guest; attempt 2's is the one that must.
const REJECTED_ATTEMPT_1_URL = 'https://fotoshare.co/i/5g719qt';
const KEPT_ATTEMPT_2_URL = 'https://fotoshare.co/i/2z2d7s2';

// §D's 1-shot ("PrintOnly") layout composite paths — param2, not param5.
const ATTEMPT_1_COMPOSITE = 'C:\\dslrBooth\\Test_event\\Prints\\20260818_101511_776.jpg';
const ATTEMPT_2_COMPOSITE = 'C:\\dslrBooth\\Test_event\\Prints\\20260818_101548_163.jpg';

const JOB_A = 'job-A';
const JOB_B = 'job-B';

// §D's own inter-event gaps, in ms, transcribed from the evidence timestamps
// (countdown lines dropped, exactly as every other file in this suite drops
// them). Each key names the two consecutive events the gap sits between.
const GAP = {
  sessionStart1_to_captureStart: 10_219,   // 03:14:58.283 -> 03:15:08.502
  captureStart_to_fileDownload: 225,        // -> 03:15:08.727
  fileDownload_to_processingStart1: 3_050,  // -> 03:15:11.777
  processingStart1_to_sharingScreen: 637,   // -> 03:15:12.414
  sharingScreen_to_uploadPrint1: 4_550,     // -> 03:15:16.964
  uploadPrint1_to_uploadOriginal1: 641,     // -> 03:15:17.605
  uploadOriginal1_to_sessionEnd1: 6_850,    // -> 03:15:24.455 (retake begins)
  sessionEnd1_to_sessionStart2: 12_341,     // -> 03:15:36.796 (12.3s, measured)
  sessionStart2_to_captureStart2: 7_859,    // -> 03:15:44.655
  captureStart2_to_fileDownload2: 362,      // -> 03:15:45.017
  fileDownload2_to_processingStart2: 3_146, // -> 03:15:48.163
  processingStart2_to_sharingScreen2: 616,  // -> 03:15:48.779
  sharingScreen2_to_uploadPrint2: 3_632,    // -> 03:15:52.411
  uploadPrint2_to_uploadOriginal2: 509,     // -> 03:15:52.920
  uploadOriginal2_to_printing: 5_124,       // -> 03:15:58.044
  printing_to_sessionEnd2: 4_756,           // -> 03:16:02.800 (trailing)
} as const;

// Bigger than the real measured retake gap (12,341ms) so the grace timer
// this phase adds is genuinely still counting down — not merely never
// started — when the retake's session_start arrives and cancels it.
const RETAKE_GRACE_MS = 15_000;

const CONFIG = {
  SESSION_TIMEOUT_MS: 300_000,
  NEXT_GUEST_COUNTDOWN_MS: 5_000,
  SESSION_MAX_RETRIES: 2,
  BOOTH_RELEASE_TIMEOUT_MS: 120_000,
  RETAKE_GRACE_MS,
};

function buildStore() {
  let booth: string = 'BUSY';
  let currentJobId: string | undefined = JOB_A;
  let attemptOpen = false;
  let attemptNo = 0;
  const jobStatus: Record<string, string> = { [JOB_A]: 'dispatched', [JOB_B]: 'queued' };
  const jobAcknowledgedAt: Record<string, number> = {};
  const pendingPrint = createPendingPrintRegistry();

  const store = {
    getBoothState: () => booth,
    getNextQueuedJob: () => (jobStatus[JOB_B] === 'queued' ? { id: JOB_B } : undefined),
    setBoothState: (s: string) => { booth = s; currentJobId = undefined; attemptOpen = false; attemptNo = 0; },
    setBoothBusy: (jobId?: string | null) => { booth = 'BUSY'; currentJobId = jobId ?? undefined; attemptOpen = false; attemptNo = 0; },
    setBoothIdle: () => { booth = 'IDLE'; currentJobId = undefined; attemptOpen = false; attemptNo = 0; },
    setBoothTimeout: () => { booth = 'IDLE'; currentJobId = undefined; attemptOpen = false; attemptNo = 0; },
    getBoothCurrentJobId: () => currentJobId,
    setBoothCurrentJob: (jobId: string | null) => { currentJobId = jobId ?? undefined; },
    getBoothAttempt: () => ({ attemptOpen, attemptNo }),
    openBoothAttempt: () => { attemptOpen = true; attemptNo += 1; return { attemptOpen, attemptNo }; },
    closeBoothAttempt: () => { attemptOpen = false; },
    getJob: (id: string) => (id in jobStatus ? { id, status: jobStatus[id], acknowledged_at: jobAcknowledgedAt[id] } : undefined),
    updateJobStatus: (id: string, status: string, tsField?: string, tsValue?: number) => {
      jobStatus[id] = status;
      if (tsField === 'acknowledged_at' && tsValue !== undefined) jobAcknowledgedAt[id] = tsValue;
    },
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
    getQueuedGuestSummaries: () => [],
    getQueueLength: () => Object.values(jobStatus).filter((s) => s === 'queued').length,
    getQueuePosition: () => undefined,
    getJobRegistration: () => undefined,
    getActiveEventId: () => undefined,
    ...pendingPrint.registry,
    requeueWithRetry: vi.fn(),
    requeueNoRetry: vi.fn(),
    failJob: vi.fn(),
    ...NO_PHOTO_SWEEP_STUB,
  } as unknown as LocalStore;

  return { store, jobStatus, jobAcknowledgedAt, pendingPrintRows: pendingPrint.rows, getBooth: () => booth };
}

describe('QueueService — sequence D (07-EVIDENCE §D), replayed verbatim', () => {
  afterEach(() => vi.useRealTimers());

  it('sequence D — retake then print: guest A gets attempt 2 URL and guest B waits', () => {
    vi.useFakeTimers();
    const { store, jobStatus, jobAcknowledgedAt, pendingPrintRows, getBooth } = buildStore();
    const service = new QueueService(store, CONFIG);

    const sendCommand = vi.fn();
    const sendAnnouncement = vi.fn();
    const sendPhotoLink = vi.fn(async () => {});
    service.bindSendCommand(sendCommand);
    service.bindAnnouncement(sendAnnouncement);
    service.bindNotificationService({ sendPhotoLink });
    service.bindIsAgentOnline(() => true);

    // --- Attempt 1 (the one that gets rejected) -----------------------

    service.onAgentEvent('session_start', JOB_A, { param1: 'PrintOnly' });
    expect(jobStatus[JOB_A]).toBe('in_progress');
    expect(store.getBoothAttempt()).toEqual({ attemptOpen: true, attemptNo: 1 });
    const firstAckedAt = jobAcknowledgedAt[JOB_A];
    expect(firstAckedAt).toBeDefined();

    vi.advanceTimersByTime(GAP.sessionStart1_to_captureStart);
    service.onAgentEvent('capture_start', JOB_A, {});

    vi.advanceTimersByTime(GAP.captureStart_to_fileDownload);
    service.onAgentEvent('file_download', JOB_A, { param1: '20260818_101508_719.jpg' });

    vi.advanceTimersByTime(GAP.fileDownload_to_processingStart1);
    service.onAgentEvent('processing_start', JOB_A, {
      param1: '20260818_101508_719.jpg',
      param2: ATTEMPT_1_COMPOSITE,
    });
    expect(pendingPrintRows.get(JOB_A)?.compositePath).toBe(ATTEMPT_1_COMPOSITE);
    expect(pendingPrintRows.get(JOB_A)?.attemptNo).toBe(1);

    vi.advanceTimersByTime(GAP.processingStart1_to_sharingScreen);
    service.onAgentEvent('sharing_screen', JOB_A, {});

    vi.advanceTimersByTime(GAP.sharingScreen_to_uploadPrint1);
    service.onAgentEvent('file_upload', JOB_A, { param3: 'print', param2: REJECTED_ATTEMPT_1_URL });
    expect(pendingPrintRows.get(JOB_A)?.photoUrl).toBe(REJECTED_ATTEMPT_1_URL);

    vi.advanceTimersByTime(GAP.uploadPrint1_to_uploadOriginal1);
    service.onAgentEvent('file_upload', JOB_A, { param3: 'original', param2: 'https://fotoshare.co/i/2fh3brs' });

    // Job A is still in_progress, nothing has been sent yet, and the slot
    // holds attempt 1's composite and attempt 1's (soon-to-be-rejected) URL.
    expect(jobStatus[JOB_A]).toBe('in_progress');
    expect(sendPhotoLink).not.toHaveBeenCalled();
    expect(pendingPrintRows.get(JOB_A)?.status).toBe('awaiting');

    // --- session_end #1: the retake begins ------------------------------

    vi.advanceTimersByTime(GAP.uploadOriginal1_to_sessionEnd1);
    service.onAgentEvent('session_end');

    // D11-06: booth stays BUSY, still bound to job A — B is neither
    // announced nor dispatched.
    expect(getBooth()).toBe('BUSY');
    expect(store.getBoothCurrentJobId()).toBe(JOB_A);
    expect(store.getBoothAttempt().attemptOpen).toBe(false);
    expect(sendAnnouncement).not.toHaveBeenCalled();
    expect(sendCommand).not.toHaveBeenCalled();

    // --- session_start #2, 12.3s later: the retake ----------------------

    vi.advanceTimersByTime(GAP.sessionEnd1_to_sessionStart2);
    service.onAgentEvent('session_start', JOB_A, { param1: 'PrintOnly' });

    // The grace timer was cancelled, attempt_no is now 2, and the job's
    // acknowledged_at survived the retake untouched (sessionAcked() was NOT
    // re-invoked for a retake).
    expect(store.getBoothAttempt()).toEqual({ attemptOpen: true, attemptNo: 2 });
    expect(jobAcknowledgedAt[JOB_A]).toBe(firstAckedAt);

    vi.advanceTimersByTime(GAP.sessionStart2_to_captureStart2);
    service.onAgentEvent('capture_start', JOB_A, {});

    vi.advanceTimersByTime(GAP.captureStart2_to_fileDownload2);
    service.onAgentEvent('file_download', JOB_A, { param1: '20260818_101545_000.jpg' });

    vi.advanceTimersByTime(GAP.fileDownload2_to_processingStart2);
    service.onAgentEvent('processing_start', JOB_A, {
      param1: '20260818_101545_000.jpg',
      param2: ATTEMPT_2_COMPOSITE,
    });

    // D11-02: OVERWRITTEN, not appended — the slot now holds attempt 2's
    // composite, attempt 2's number, and attempt 1's URL/approval are gone.
    expect(pendingPrintRows.get(JOB_A)?.compositePath).toBe(ATTEMPT_2_COMPOSITE);
    expect(pendingPrintRows.get(JOB_A)?.attemptNo).toBe(2);
    expect(pendingPrintRows.get(JOB_A)?.photoUrl).toBeUndefined();

    vi.advanceTimersByTime(GAP.processingStart2_to_sharingScreen2);
    service.onAgentEvent('sharing_screen', JOB_A, {});

    vi.advanceTimersByTime(GAP.sharingScreen2_to_uploadPrint2);
    service.onAgentEvent('file_upload', JOB_A, { param3: 'print', param2: KEPT_ATTEMPT_2_URL });
    expect(pendingPrintRows.get(JOB_A)?.photoUrl).toBe(KEPT_ATTEMPT_2_URL);

    vi.advanceTimersByTime(GAP.uploadPrint2_to_uploadOriginal2);
    service.onAgentEvent('file_upload', JOB_A, { param3: 'original', param2: 'https://fotoshare.co/i/25tk3yq' });

    // --- printing: the guest presses print on attempt 2's photo --------

    vi.advanceTimersByTime(GAP.uploadOriginal2_to_printing);
    service.onAgentEvent('printing', JOB_A, {
      param1: ATTEMPT_2_COMPOSITE,
      param2: '1',
      param3: 'DS-RX1',
    });

    // Exactly one notification, carrying attempt 2's URL — never attempt 1's.
    expect(sendPhotoLink).toHaveBeenCalledTimes(1);
    expect(sendPhotoLink).toHaveBeenCalledWith(JOB_A, KEPT_ATTEMPT_2_URL);
    expect(sendPhotoLink).not.toHaveBeenCalledWith(JOB_A, REJECTED_ATTEMPT_1_URL);
    expect(jobStatus[JOB_A]).toBe('completed');
    expect(pendingPrintRows.get(JOB_A)?.status).toBe('resolved');
    expect(pendingPrintRows.get(JOB_A)?.approvedBy).toBe('printing');
    // The booth was released as part of finalize, then immediately began
    // announcing guest B — never left sitting IDLE waiting for a fresh tick.
    expect(getBooth()).toBe('ANNOUNCING');
    expect(sendAnnouncement).toHaveBeenCalledTimes(1);
    expect(sendAnnouncement.mock.calls[0][0]).toMatchObject({ jobId: JOB_B });

    // A second printing replay after the first changes nothing — the booth
    // has already moved past job A, so this can't reach the finalize gate a
    // second time.
    service.onAgentEvent('printing', JOB_A, { param1: ATTEMPT_2_COMPOSITE, param2: '1', param3: 'DS-RX1' });
    expect(sendPhotoLink).toHaveBeenCalledTimes(1);

    // --- trailing session_end: no second notification, no grace, no error --

    vi.advanceTimersByTime(GAP.printing_to_sessionEnd2);
    expect(() => service.onAgentEvent('session_end')).not.toThrow();
    expect(sendPhotoLink).toHaveBeenCalledTimes(1);

    // --- and guest B, who waited the entire time, is eventually served ----

    vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS);
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand.mock.calls[0][0]).toMatchObject({ jobId: JOB_B, action: 'start_session' });

    service.stop();
  });
});
