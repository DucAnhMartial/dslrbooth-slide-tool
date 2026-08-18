import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueService, queueLogger } from '../src/queue/queueService';
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

/**
 * Task 1 (11-04): 07-EVIDENCE §C — "Retake, auto-print BẬT" — transcribed
 * verbatim, including the empty 12s session (❶) that precedes the first
 * real capture. This is the OPERATIONAL PRECONDITION's own cost, measured on
 * a real booth, not a hypothetical: see DEPLOYMENT.md §7 (booth agent setup)
 * / §9 (pre-open checklist) — "auto-print TẮT trên mọi booth" exists BECAUSE
 * of exactly this failure.
 */
const SEQ_C_DISCARDED_COMPOSITE = 'C:\\dslrBooth\\Test_event\\Prints\\20260818_100510_104.jpg';
const SEQ_C_DISCARDED_ORIGINAL_URL = 'https://fotoshare.co/i/4gfw7cy';
// ẢNH BỊ LOẠI — the photo the guest rejected. Under auto-print ON this is the
// ONLY one that ever reaches the guest, which is the whole documented failure.
const SEQ_C_DISCARDED_PRINT_URL = 'https://fotoshare.co/i/332q1vz';
const SEQ_C_KEPT_COMPOSITE = 'C:\\dslrBooth\\Test_event\\Prints\\20260818_100529_768.jpg';
const SEQ_C_KEPT_ORIGINAL_URL = 'https://fotoshare.co/i/35qz6vs';
// ẢNH ĐÚNG — the photo the guest actually wanted. Never delivered under
// auto-print ON.
const SEQ_C_KEPT_PRINT_URL = 'https://fotoshare.co/i/2yrxhff';

const JOB_C = 'job-C';

// 07-EVIDENCE §C's own inter-event gaps, in ms, transcribed the same way
// GAP above is: every value is the exact millisecond delta between two
// consecutive evidence timestamps.
const SEQ_C_GAP = {
  emptySessionStart_to_emptySessionEnd: 11_830,   // 03:04:42.600 -> 03:04:54.430 (❶, 12s, no capture)
  emptySessionEnd_to_sessionStart1: 2_611,         // -> 03:04:57.041 (LẦN CHỤP 1, bị loại)
  sessionStart1_to_captureStart1: 8_882,           // -> 03:05:05.923
  captureStart1_to_fileDownload1: 368,             // -> 03:05:06.291
  fileDownload1_to_processingStart1: 3_814,        // -> 03:05:10.105
  processingStart1_to_sharingScreen1: 643,         // -> 03:05:10.748
  sharingScreen1_to_printing1: 1_311,              // -> 03:05:12.059 (auto-print ON: printing before any upload)
  printing1_to_uploadOriginal1: 4_443,             // -> 03:05:16.502
  uploadOriginal1_to_sessionEnd1: 224,             // -> 03:05:16.726 (stray, booth already released)
  sessionEnd1_to_uploadPrint1: 510,                // -> 03:05:17.236 (discarded print URL, delivered late)
  uploadPrint1_to_sessionStart2: 2_802,            // -> 03:05:20.038 (LẦN CHỤP 2, được lấy — job already terminal)
  sessionStart2_to_captureStart2: 6_567,           // -> 03:05:26.605
  captureStart2_to_fileDownload2: 536,             // -> 03:05:27.141
  fileDownload2_to_processingStart2: 2_628,        // -> 03:05:29.769
  processingStart2_to_sharingScreen2: 384,         // -> 03:05:30.153
  sharingScreen2_to_printing2: 758,                // -> 03:05:30.911
  printing2_to_sessionEnd2: 2_690,                 // -> 03:05:33.601
  sessionEnd2_to_uploadOriginal2: 834,             // -> 03:05:34.435
  uploadOriginal2_to_uploadPrint2: 856,            // -> 03:05:35.291 (ẢNH ĐÚNG, never reaches the guest)
} as const;

/**
 * 07-EVIDENCE §E — "In lại ảnh cũ từ thư viện, 18 phút sau" — the gallery
 * reprint. No session_start, no processing_start, no file_upload; param1 is
 * the composite from a DIFFERENT session 18 minutes earlier — sequence C's
 * own kept composite (SEQ_C_KEPT_COMPOSITE above), reused verbatim because
 * that is literally what the operator reprinted.
 */
const SEQ_E_REPRINTED_COMPOSITE = SEQ_C_KEPT_COMPOSITE;

const JOB_E_GUEST = 'job-E-guest'; // "another guest" whose live attempt must not be disturbed by the reprint
const E_GUEST_OWN_COMPOSITE = 'C:\\dslrBooth\\Test_event\\Prints\\20260818_102310_500.jpg';

// Task 1 (11-04): parameterized, backward-compatible with the bare
// `buildStore()` sequence D already calls — every new field is optional and
// defaults to sequence D's own original shape, so that test's own fixture is
// untouched. The new cases below (sequences C and E, the stem-comparison
// pair) pass their own `currentJobId`/`attemptOpen`/`attemptNo`/`jobStatus`
// rather than forking a second harness.
function buildStore(opts: {
  currentJobId?: string;
  attemptOpen?: boolean;
  attemptNo?: number;
  jobStatus?: Record<string, string>;
} = {}) {
  let booth: string = 'BUSY';
  let currentJobId: string | undefined = opts.currentJobId ?? JOB_A;
  let attemptOpen = opts.attemptOpen ?? false;
  let attemptNo = opts.attemptNo ?? 0;
  const jobStatus: Record<string, string> = opts.jobStatus ?? { [JOB_A]: 'dispatched', [JOB_B]: 'queued' };
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

describe('QueueService — sequence C (07-EVIDENCE §C), replayed verbatim: what breaks when AUTO-PRINT IS LEFT ON', () => {
  afterEach(() => vi.useRealTimers());

  // Named to read as the REASON for the operator-locked precondition
  // (11-CONTEXT.md, operator-confirmed 2026-08-18), not as accepted
  // behaviour. See DEPLOYMENT.md §7 (booth Agent setup) / §9 (pre-open
  // checklist): "auto-print TẮT trên mọi booth" exists BECAUSE of exactly
  // this failure, measured on a real booth.
  it('THIS is what breaks with auto-print ON: printing fires before any upload, the job closes no_photo mid-guest, the booth releases early, and the DISCARDED attempt\'s URL is the only one ever delivered', () => {
    vi.useFakeTimers();
    const { store, jobStatus, getBooth } = buildStore({
      currentJobId: JOB_C,
      attemptOpen: false,
      attemptNo: 0,
      jobStatus: { [JOB_C]: 'dispatched' },
    });
    const service = new QueueService(store, CONFIG);
    const sendPhotoLink = vi.fn(async () => {});
    service.bindNotificationService({ sendPhotoLink });
    service.bindIsAgentOnline(() => true);

    // --- ❶ the empty 12s session: session_start -> session_end, no capture --
    service.onAgentEvent('session_start', JOB_C, { param1: 'PrintOnly' });
    expect(store.getBoothAttempt()).toEqual({ attemptOpen: true, attemptNo: 1 });

    vi.advanceTimersByTime(SEQ_C_GAP.emptySessionStart_to_emptySessionEnd);
    service.onAgentEvent('session_end');
    // Q3: an unapproved attempt's session_end opens grace even with no
    // composite ever produced (no processing_start happened in ❶) — the
    // booth stays bound to JOB_C rather than releasing.
    expect(store.getBoothCurrentJobId()).toBe(JOB_C);
    expect(store.getBoothAttempt().attemptOpen).toBe(false);

    // --- "LẦN CHỤP 1" (bị loại): the retake, well within grace ------------
    vi.advanceTimersByTime(SEQ_C_GAP.emptySessionEnd_to_sessionStart1);
    service.onAgentEvent('session_start', JOB_C, { param1: 'PrintOnly' });
    expect(store.getBoothAttempt()).toEqual({ attemptOpen: true, attemptNo: 2 });

    vi.advanceTimersByTime(SEQ_C_GAP.sessionStart1_to_captureStart1);
    service.onAgentEvent('capture_start', JOB_C, {});

    vi.advanceTimersByTime(SEQ_C_GAP.captureStart1_to_fileDownload1);
    service.onAgentEvent('file_download', JOB_C, { param1: '20260818_100506_286.jpg' });

    vi.advanceTimersByTime(SEQ_C_GAP.fileDownload1_to_processingStart1);
    service.onAgentEvent('processing_start', JOB_C, {
      param1: '20260818_100506_286.jpg',
      param2: SEQ_C_DISCARDED_COMPOSITE,
    });

    vi.advanceTimersByTime(SEQ_C_GAP.processingStart1_to_sharingScreen1);
    service.onAgentEvent('sharing_screen', JOB_C, {});

    // --- printing fires immediately (auto-print ON), BEFORE any upload -----
    vi.advanceTimersByTime(SEQ_C_GAP.sharingScreen1_to_printing1);
    service.onAgentEvent('printing', JOB_C, {
      param1: SEQ_C_DISCARDED_COMPOSITE,
      param2: '1',
      param3: 'DS-RX1',
    });

    // The documented failure: composite matches, attempt is open, D11-03
    // approves it — but the slot holds no URL yet, so it closes WITHOUT a
    // photo, and the booth releases mid-guest.
    expect(jobStatus[JOB_C]).toBe('no_photo');
    expect(store.getBoothCurrentJobId()).toBeUndefined();
    expect(getBooth()).toBe('IDLE');
    expect(sendPhotoLink).not.toHaveBeenCalled();

    // --- the uploads arrive afterward, too late to matter -------------------
    vi.advanceTimersByTime(SEQ_C_GAP.printing1_to_uploadOriginal1);
    service.onAgentEvent('file_upload', JOB_C, { param3: 'original', param2: SEQ_C_DISCARDED_ORIGINAL_URL });

    vi.advanceTimersByTime(SEQ_C_GAP.uploadOriginal1_to_sessionEnd1);
    expect(() => service.onAgentEvent('session_end')).not.toThrow(); // stray, booth already idle

    vi.advanceTimersByTime(SEQ_C_GAP.sessionEnd1_to_uploadPrint1);
    service.onAgentEvent('file_upload', JOB_C, { param3: 'print', param2: SEQ_C_DISCARDED_PRINT_URL });

    // D-11/D11-04's late-arrival guarantee delivers it anyway — but it is the
    // WRONG photo, because the slot never got a chance to hold the right one
    // before finalize already ran.
    expect(sendPhotoLink).toHaveBeenCalledTimes(1);
    expect(sendPhotoLink).toHaveBeenCalledWith(JOB_C, SEQ_C_DISCARDED_PRINT_URL);

    // --- "LẦN CHỤP 2" (được lấy): the guest's real photo — but the job is
    // already terminal, so nothing here can rescue it. This is the fuller
    // cost of auto-print ON: not just a wrong photo, but the RIGHT one
    // becoming unreachable too. ----------------------------------------------
    vi.advanceTimersByTime(SEQ_C_GAP.uploadPrint1_to_sessionStart2);
    service.onAgentEvent('session_start', JOB_C, { param1: 'PrintOnly' });
    expect(jobStatus[JOB_C]).toBe('no_photo'); // session_start ignored: already no_photo

    vi.advanceTimersByTime(SEQ_C_GAP.sessionStart2_to_captureStart2);
    service.onAgentEvent('capture_start', JOB_C, {});

    vi.advanceTimersByTime(SEQ_C_GAP.captureStart2_to_fileDownload2);
    service.onAgentEvent('file_download', JOB_C, { param1: '20260818_100527_138.jpg' });

    vi.advanceTimersByTime(SEQ_C_GAP.fileDownload2_to_processingStart2);
    service.onAgentEvent('processing_start', JOB_C, {
      param1: '20260818_100527_138.jpg',
      param2: SEQ_C_KEPT_COMPOSITE,
    });

    vi.advanceTimersByTime(SEQ_C_GAP.processingStart2_to_sharingScreen2);
    service.onAgentEvent('sharing_screen', JOB_C, {});

    vi.advanceTimersByTime(SEQ_C_GAP.sharingScreen2_to_printing2);
    service.onAgentEvent('printing', JOB_C, { param1: SEQ_C_KEPT_COMPOSITE, param2: '1', param3: 'DS-RX1' });

    vi.advanceTimersByTime(SEQ_C_GAP.printing2_to_sessionEnd2);
    expect(() => service.onAgentEvent('session_end')).not.toThrow();

    vi.advanceTimersByTime(SEQ_C_GAP.sessionEnd2_to_uploadOriginal2);
    service.onAgentEvent('file_upload', JOB_C, { param3: 'original', param2: SEQ_C_KEPT_ORIGINAL_URL });

    vi.advanceTimersByTime(SEQ_C_GAP.uploadOriginal2_to_uploadPrint2);
    service.onAgentEvent('file_upload', JOB_C, { param3: 'print', param2: SEQ_C_KEPT_PRINT_URL });

    // The RIGHT photo (ẢNH ĐÚNG) never reaches the guest. Exactly one
    // notification was ever sent for job-C, and it was the wrong one.
    expect(sendPhotoLink).toHaveBeenCalledTimes(1);
    expect(sendPhotoLink).not.toHaveBeenCalledWith(JOB_C, SEQ_C_KEPT_PRINT_URL);

    service.stop();
  });

  it('a duplicate replay of the discarded print upload (a resend, a retry) does not deliver a second notification — the wrong photo is sent at most once', () => {
    vi.useFakeTimers();
    const { store, jobStatus } = buildStore({
      currentJobId: JOB_C,
      attemptOpen: true,
      attemptNo: 1,
      jobStatus: { [JOB_C]: 'in_progress' },
    });
    const service = new QueueService(store, CONFIG);
    const sendPhotoLink = vi.fn(async () => {});
    service.bindNotificationService({ sendPhotoLink });
    service.bindIsAgentOnline(() => true);

    service.onAgentEvent('processing_start', JOB_C, {
      param1: '20260818_100506_286.jpg',
      param2: SEQ_C_DISCARDED_COMPOSITE,
    });
    // auto-print ON: printing fires before any upload, closing no_photo.
    service.onAgentEvent('printing', JOB_C, { param1: SEQ_C_DISCARDED_COMPOSITE, param2: '1', param3: 'DS-RX1' });
    expect(jobStatus[JOB_C]).toBe('no_photo');

    // First (late) delivery of the discarded print upload.
    service.onAgentEvent('file_upload', JOB_C, { param3: 'print', param2: SEQ_C_DISCARDED_PRINT_URL });
    expect(sendPhotoLink).toHaveBeenCalledTimes(1);

    // A resend of the EXACT SAME upload — dslrBooth retrying, or a network
    // replay — must not deliver a second copy.
    service.onAgentEvent('file_upload', JOB_C, { param3: 'print', param2: SEQ_C_DISCARDED_PRINT_URL });
    expect(sendPhotoLink).toHaveBeenCalledTimes(1);

    service.stop();
  });
});

describe('QueueService — sequence E (07-EVIDENCE §E), the gallery reprint 18 minutes later — D11-03 / SC-2', () => {
  afterEach(() => vi.useRealTimers());

  it('printing on a bound-but-not-yet-acknowledged booth (no attempt open at all) is refused "no attempt open", finalizes nothing, and sends nothing', () => {
    const { store, jobStatus } = buildStore({
      currentJobId: JOB_E_GUEST,
      attemptOpen: false,
      attemptNo: 0,
      jobStatus: { [JOB_E_GUEST]: 'dispatched' },
    });
    const service = new QueueService(store, CONFIG);
    const sendPhotoLink = vi.fn(async () => {});
    service.bindNotificationService({ sendPhotoLink });
    const infoSpy = vi.spyOn(queueLogger, 'info');

    // dslrBooth's own §E payload carries no session identifier at all; the
    // Agent's own stale activeJobId stamp (D-06) is whichever job it most
    // recently dispatched — here, the guest who currently owns the booth.
    service.onAgentEvent('printing', JOB_E_GUEST, {
      param1: SEQ_E_REPRINTED_COMPOSITE,
      param2: '1',
      param3: 'DS-RX1',
    });

    expect(jobStatus[JOB_E_GUEST]).toBe('dispatched'); // untouched — nothing finalized
    expect(sendPhotoLink).not.toHaveBeenCalled();
    expect(
      infoSpy.mock.calls.some((c) => String(c[0]).includes('printing ignored: no attempt open')),
    ).toBe(true);

    service.stop();
  });

  it('printing while another guest\'s attempt IS open is refused for composite mismatch, naming both paths, and that guest is not finalized', () => {
    const { store, jobStatus } = buildStore({
      currentJobId: JOB_E_GUEST,
      attemptOpen: true,
      attemptNo: 1,
      jobStatus: { [JOB_E_GUEST]: 'in_progress' },
    });
    const service = new QueueService(store, CONFIG);
    const sendPhotoLink = vi.fn(async () => {});
    service.bindNotificationService({ sendPhotoLink });
    const infoSpy = vi.spyOn(queueLogger, 'info');

    // The other guest's OWN composite is already open in the slot — this is
    // what makes the mismatch message name a real, concrete "this attempt's"
    // path rather than an empty one.
    service.onAgentEvent('processing_start', JOB_E_GUEST, { param1: 'file.jpg', param2: E_GUEST_OWN_COMPOSITE });

    service.onAgentEvent('printing', JOB_E_GUEST, {
      param1: SEQ_E_REPRINTED_COMPOSITE,
      param2: '1',
      param3: 'DS-RX1',
    });

    expect(jobStatus[JOB_E_GUEST]).toBe('in_progress'); // untouched — not finalized
    expect(sendPhotoLink).not.toHaveBeenCalled();
    const line = infoSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes("is not this attempt's"));
    expect(line).toBeDefined();
    expect(line).toContain(SEQ_E_REPRINTED_COMPOSITE);
    expect(line).toContain(E_GUEST_OWN_COMPOSITE);

    service.stop();
  });

  /**
   * Shared setup for the two trailing-session_end cases below: the other
   * guest's own attempt is open, and §E's own refused reprint has already
   * fired against it (proven separately above) — the two cases here are
   * about what happens NEXT, so they share the identical starting shape
   * rather than each re-deriving it.
   */
  function buildGuestWithRefusedReprint() {
    vi.useFakeTimers();
    const { store } = buildStore({
      currentJobId: JOB_E_GUEST,
      attemptOpen: true,
      attemptNo: 1,
      jobStatus: { [JOB_E_GUEST]: 'in_progress' },
    });
    const service = new QueueService(store, CONFIG);
    const sendPhotoLink = vi.fn(async () => {});
    service.bindNotificationService({ sendPhotoLink });
    service.bindIsAgentOnline(() => true);

    service.onAgentEvent('processing_start', JOB_E_GUEST, { param1: 'file.jpg', param2: E_GUEST_OWN_COMPOSITE });
    service.onAgentEvent('printing', JOB_E_GUEST, {
      param1: SEQ_E_REPRINTED_COMPOSITE,
      param2: '1',
      param3: 'DS-RX1',
    }); // refused above — attempt still open, job still in_progress

    return { store, service, sendPhotoLink };
  }

  it('sequence E\'s trailing session_end, while another guest\'s attempt is open, opens a grace window for THEM rather than releasing the booth', () => {
    const { store, service, sendPhotoLink } = buildGuestWithRefusedReprint();

    // §E's own trailing session_end, 0.415s after its printing
    // (03:23:20.960 - 03:23:20.545) — dslrBooth's own payload, no jobId.
    vi.advanceTimersByTime(415);
    service.onAgentEvent('session_end');

    // D11-06: an unapproved attempt's session_end never releases — it opens
    // grace instead, exactly the flagged assumption this plan pins.
    expect(store.getBoothCurrentJobId()).toBe(JOB_E_GUEST);
    expect(store.getBoothAttempt().attemptOpen).toBe(false);
    expect(sendPhotoLink).not.toHaveBeenCalled();

    service.stop();
  });

  it('that guest\'s own next session_start, inside the grace window §E\'s session_end opened, cancels it and reopens their attempt rather than finalizing them no_photo', () => {
    const { store, service, sendPhotoLink } = buildGuestWithRefusedReprint();

    vi.advanceTimersByTime(415);
    service.onAgentEvent('session_end'); // opens grace, per the case above

    vi.advanceTimersByTime(3_000); // well inside RETAKE_GRACE_MS
    service.onAgentEvent('session_start', JOB_E_GUEST, { param1: 'PrintOnly' });
    expect(store.getBoothAttempt()).toEqual({ attemptOpen: true, attemptNo: 2 });

    // Advancing past the ORIGINAL grace deadline now finalizes nothing — the
    // timer was genuinely cancelled, not merely delayed.
    vi.advanceTimersByTime(CONFIG.RETAKE_GRACE_MS);
    expect(sendPhotoLink).not.toHaveBeenCalled();
    expect(store.getBoothCurrentJobId()).toBe(JOB_E_GUEST);

    service.stop();
  });
});

describe('QueueService — D11-03 composite comparison is by STEM, not exact string (07-EVIDENCE conclusion 15)', () => {
  afterEach(() => vi.useRealTimers());

  const JOB_STEM = 'job-stem-compare';
  // 07-EVIDENCE conclusion 15 (Extension Service log, 2026-08-14, job
  // 9ZB3QK9G, 4-shot layout, auto-print ON): processing_start reported the
  // composite ending _1x, printing reported the SAME timestamp stem two
  // seconds later ending _2x — dslrBooth's own copy-count variant, not a
  // different photo. The date is redacted in the source evidence itself
  // (********); kept exactly as recorded rather than invented.
  const COPY_SUFFIX_COMPOSITE_1X = 'C:\\dslrBooth\\Test_event\\Prints\\********_094130_744_1x.jpg';
  const COPY_SUFFIX_COMPOSITE_2X = 'C:\\dslrBooth\\Test_event\\Prints\\********_094130_744_2x.jpg';
  const COPY_SUFFIX_PRINT_URL = 'https://fotoshare.co/i/9zb3qk9g';

  it('a printing composite differing only by the _1x/_2x copy-count suffix still approves (same stem)', () => {
    const { store, jobStatus } = buildStore({
      currentJobId: JOB_STEM,
      attemptOpen: true,
      attemptNo: 1,
      jobStatus: { [JOB_STEM]: 'in_progress' },
    });
    const service = new QueueService(store, CONFIG);
    const sendPhotoLink = vi.fn(async () => {});
    service.bindNotificationService({ sendPhotoLink });
    service.bindIsAgentOnline(() => true);

    // 4-shot layout: composite in param5, per D11-07.
    service.onAgentEvent('processing_start', JOB_STEM, {
      param1: 'a.jpg', param2: 'b.jpg', param3: 'c.jpg', param4: 'd.jpg',
      param5: COPY_SUFFIX_COMPOSITE_1X,
    });
    service.onAgentEvent('file_upload', JOB_STEM, { param3: 'print', param2: COPY_SUFFIX_PRINT_URL });

    service.onAgentEvent('printing', JOB_STEM, { param1: COPY_SUFFIX_COMPOSITE_2X, param2: '1', param3: 'DS-RX1' });

    expect(jobStatus[JOB_STEM]).toBe('completed');
    expect(sendPhotoLink).toHaveBeenCalledTimes(1);
    expect(sendPhotoLink).toHaveBeenCalledWith(JOB_STEM, COPY_SUFFIX_PRINT_URL);

    service.stop();
  });

  it('a printing composite with a genuinely DIFFERENT timestamp stem is still refused — the stem rule is not "compare loosely"', () => {
    const { store, jobStatus } = buildStore({
      currentJobId: JOB_STEM,
      attemptOpen: true,
      attemptNo: 1,
      jobStatus: { [JOB_STEM]: 'in_progress' },
    });
    const service = new QueueService(store, CONFIG);
    const sendPhotoLink = vi.fn(async () => {});
    service.bindNotificationService({ sendPhotoLink });

    service.onAgentEvent('processing_start', JOB_STEM, { param5: COPY_SUFFIX_COMPOSITE_1X });

    const DIFFERENT_STEM_COMPOSITE = 'C:\\dslrBooth\\Test_event\\Prints\\20260818_120000_000.jpg';
    service.onAgentEvent('printing', JOB_STEM, { param1: DIFFERENT_STEM_COMPOSITE, param2: '1', param3: 'DS-RX1' });

    expect(jobStatus[JOB_STEM]).toBe('in_progress'); // untouched — not finalized
    expect(sendPhotoLink).not.toHaveBeenCalled();

    service.stop();
  });

  it('a double-digit copy suffix (_10x) strips the same way a single-digit one does — the regex is not a single-digit assumption', () => {
    const { store, jobStatus } = buildStore({
      currentJobId: JOB_STEM,
      attemptOpen: true,
      attemptNo: 1,
      jobStatus: { [JOB_STEM]: 'in_progress' },
    });
    const service = new QueueService(store, CONFIG);
    const sendPhotoLink = vi.fn(async () => {});
    service.bindNotificationService({ sendPhotoLink });

    const TEN_COPIES_COMPOSITE = 'C:\\dslrBooth\\Test_event\\Prints\\********_094130_744_10x.jpg';
    service.onAgentEvent('processing_start', JOB_STEM, { param5: COPY_SUFFIX_COMPOSITE_1X });
    service.onAgentEvent('file_upload', JOB_STEM, { param3: 'print', param2: COPY_SUFFIX_PRINT_URL });
    service.onAgentEvent('printing', JOB_STEM, { param1: TEN_COPIES_COMPOSITE, param2: '1', param3: 'DS-RX1' });

    expect(jobStatus[JOB_STEM]).toBe('completed');
    expect(sendPhotoLink).toHaveBeenCalledTimes(1);

    service.stop();
  });
});

describe('QueueService — D11-07 composite extraction never warns "no usable composite path" on any measured layout (D11-07, AGT-04, SC-5)', () => {
  it('the 4-shot layout (param5) and the 1-shot layout (param2, sequences C and D) all extract successfully across the whole replay', () => {
    const JOB_LAYOUT = 'job-layout-check';
    const { store } = buildStore({
      currentJobId: JOB_LAYOUT,
      attemptOpen: true,
      attemptNo: 1,
      jobStatus: { [JOB_LAYOUT]: 'in_progress' },
    });
    const service = new QueueService(store, CONFIG);
    const warnSpy = vi.spyOn(queueLogger, 'warn');

    // 4-shot layout, param5 (07-EVIDENCE §A / conclusion 12).
    service.onAgentEvent('processing_start', JOB_LAYOUT, {
      param1: 'a.jpg', param2: 'b.jpg', param3: 'c.jpg', param4: 'd.jpg',
      param5: 'C:\\dslrBooth\\Test_event\\Prints\\20260812_143526_970.jpg',
    });
    // 1-shot layout, param2 — sequence D's own two composites.
    service.onAgentEvent('processing_start', JOB_LAYOUT, {
      param1: '20260818_101508_719.jpg', param2: ATTEMPT_1_COMPOSITE,
    });
    service.onAgentEvent('processing_start', JOB_LAYOUT, {
      param1: '20260818_101545_000.jpg', param2: ATTEMPT_2_COMPOSITE,
    });
    // 1-shot layout — sequence C's own two composites.
    service.onAgentEvent('processing_start', JOB_LAYOUT, {
      param1: '20260818_100506_286.jpg', param2: SEQ_C_DISCARDED_COMPOSITE,
    });
    service.onAgentEvent('processing_start', JOB_LAYOUT, {
      param1: '20260818_100527_138.jpg', param2: SEQ_C_KEPT_COMPOSITE,
    });

    // Assert the absence across the WHOLE replay, not a single event — the
    // point is that neither layout produces this warning anywhere.
    const lines = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((m) => m.includes('no usable composite path'))).toBe(false);

    service.stop();
  });

  it('printing\'s own composite extraction (always param1, never the \\Prints\\ scan) never produces the warning either, across every layout\'s printing event', () => {
    const JOB_LAYOUT = 'job-layout-check-printing';
    const { store } = buildStore({
      currentJobId: JOB_LAYOUT,
      attemptOpen: true,
      attemptNo: 1,
      jobStatus: { [JOB_LAYOUT]: 'in_progress' },
    });
    const service = new QueueService(store, CONFIG);
    const warnSpy = vi.spyOn(queueLogger, 'warn');

    service.onAgentEvent('processing_start', JOB_LAYOUT, { param2: ATTEMPT_1_COMPOSITE });
    // A printing event, whatever it approves or refuses, must never itself
    // trip the "no usable composite path" branch — its own extraction is a
    // plain param1 read, unaffected by D11-07's \Prints\ scan-and-fallback.
    service.onAgentEvent('printing', JOB_LAYOUT, { param1: ATTEMPT_1_COMPOSITE, param2: '1', param3: 'DS-RX1' });

    const lines = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((m) => m.includes('no usable composite path'))).toBe(false);

    service.stop();
  });
});
