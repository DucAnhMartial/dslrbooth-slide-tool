import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { QueueService, queueLogger } from '../src/queue/queueService';
import type { LocalStore } from '../src/state/localStore';
import { createPendingPrintRegistry } from './helpers/pendingPrintRegistry';
import { NO_PHOTO_SWEEP_STUB } from './helpers/noPhotoSweep';

/**
 * 11-06 (gap closure): the live booth run on 2026-08-18, 11:22-ish, replayed.
 *
 * `dslrbooth-agent/src/commands.ts` called `deps.setActiveJobId(jobId)` only
 * AFTER `await deps.dslrBooth.startSession(mode)` resolved, so the FIRST
 * `session_start` of every dispatched session reached the server with
 * `jobId: undefined`. `onAgentEvent`'s old guard (`eventType === 'session_start'
 * && jobId`) silently dropped it — no log line, `attempt_no` never reached 1,
 * and the retake that followed was never recognised as a retake. The grace
 * window then finalised the guest on the composite `processing_start` had
 * already opened for attempt 0 — attempt 1's photo, the one the guest
 * rejected — instead of attempt 2's.
 *
 * Only three lines of this incident's own timeline are LITERALLY measured
 * (the Agent's own log, quoted verbatim in 11-06-PLAN.md's <evidence>):
 *
 *     11:22:53.887  Command received: start_session (mode=print, jobId=THQQSRCE)
 *     11:22:53.907  Trigger received: session_start {"param1":"PrintOnly"}
 *     11:22:53.935  dslrBooth API success
 *
 * i.e. the 20ms gap (dispatch -> the racing session_start) and the 28ms gap
 * (dispatch -> dslrBooth API success, which is also when the Agent's ack and
 * its — too late — activeJobId stamp both fire). LITERAL_GAP below carries
 * only those two numbers, transcribed exactly. No fuller raw log for this
 * specific incident exists anywhere in .planning (unlike 07-EVIDENCE's
 * sequences C/D/E, which have complete millisecond-by-millisecond logs) — the
 * production DB row (attempt_no=0, approved_by='grace', photo_url=attempt 1's
 * URL) and the SESSION_SUMMARY line (attempts= missing, i.e. never reached 1)
 * are the only other measured facts. CONSTRUCTED_GAP's values are therefore
 * NOT transcribed from a log — they are representative gaps in the same
 * rhythm 07-EVIDENCE §D measured for a structurally identical retake, kept
 * deliberately smaller than RETAKE_GRACE_MS so the grace timer this test
 * proves was cancelled is still genuinely counting down, not merely never
 * started. Every place a CONSTRUCTED value is used is marked as such.
 */

// The real production job id and the real fotoshare URLs from the incident's
// own evidence — attempt 1's is the URL production wrongly delivered via
// grace; attempt 2's is the one the guest actually asked for and never got.
const JOB_ID = 'THQQSRCE';
const REJECTED_ATTEMPT_1_URL = 'https://fotoshare.co/i/291k1w7';
const KEPT_ATTEMPT_2_URL = 'https://fotoshare.co/i/4dqmm1m';

const JOB_B = 'job-B-queued';

// LITERAL: transcribed exactly from the Agent's own log line deltas quoted
// in 11-06-PLAN.md's <evidence>.
const LITERAL_GAP = {
  dispatch_to_racingSessionStart: 20,   // 11:22:53.887 -> .907
  dispatch_to_dslrBoothApiSuccess: 48,  // 11:22:53.887 -> .935 (ack + late activeJobId stamp)
} as const;

// CONSTRUCTED: representative, not measured for this incident. Modeled on
// 07-EVIDENCE §D's own retake rhythm (a structurally identical shot -> print
// -> retake -> shot -> print session), scaled down for test speed. The one
// load-bearing choice is sessionEnd_to_retakeSessionStart, kept comfortably
// under RETAKE_GRACE_MS (20_000 default) so the grace-timer-cancellation
// assertion below is proving something real.
const CONSTRUCTED_GAP = {
  ack_to_captureStart: 9_500,
  captureStart_to_fileDownload: 300,
  fileDownload_to_processingStart: 3_000,
  processingStart_to_sharingScreen: 600,
  sharingScreen_to_uploadPrint: 4_500,
  uploadPrint_to_uploadOriginal: 600,
  uploadOriginal_to_sessionEnd: 6_500,
  sessionEnd_to_retakeSessionStart: 12_000, // < RETAKE_GRACE_MS (20_000)
  retakeSessionStart_to_captureStart2: 7_800,
  captureStart2_to_fileDownload2: 350,
  fileDownload2_to_processingStart2: 3_100,
  processingStart2_to_sharingScreen2: 600,
  sharingScreen2_to_uploadPrint2: 3_600,
  uploadPrint2_to_uploadOriginal2: 500,
  uploadOriginal2_to_printing: 5_100,
} as const;

// Attempt 1: the 1-shot ("PrintOnly") layout, composite at param2 — matching
// the mode reported in the evidence's own "Command received" line.
const ATTEMPT_1_COMPOSITE = 'C:\\dslrBooth\\Test_event\\Prints\\20260818_112301_500.jpg';
// Attempt 2: the 4-shot layout, composite at param5 (D11-07's scan-and-
// fallback rule) — the plan's own task 3 text names this as the retake's
// layout.
const ATTEMPT_2_COMPOSITE = 'C:\\dslrBooth\\Test_event\\Prints\\20260818_112342_800.jpg';

const RETAKE_GRACE_MS = 20_000;

const CONFIG = {
  SESSION_TIMEOUT_MS: 300_000,
  NEXT_GUEST_COUNTDOWN_MS: 5_000,
  SESSION_MAX_RETRIES: 2,
  BOOTH_RELEASE_TIMEOUT_MS: 120_000,
  RETAKE_GRACE_MS,
};

function buildStore() {
  let booth: string = 'IDLE';
  let currentJobId: string | undefined;
  let attemptOpen = false;
  let attemptNo = 0;
  const jobStatus: Record<string, string> = { [JOB_ID]: 'queued', [JOB_B]: 'queued' };
  const jobAcknowledgedAt: Record<string, number> = {};
  const pendingPrint = createPendingPrintRegistry();

  const store = {
    getBoothState: () => booth,
    getNextQueuedJob: () => {
      if (jobStatus[JOB_ID] === 'queued') return { id: JOB_ID };
      if (jobStatus[JOB_B] === 'queued') return { id: JOB_B };
      return undefined;
    },
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

describe('QueueService — the 2026-08-18 11:22 live race, replayed (11-06)', () => {
  afterEach(() => vi.useRealTimers());

  it('a session_start racing the Agent\'s own activeJobId stamp still opens attempt 1 — and the retake that follows is recognised', () => {
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

    // Task 3 (11-06): the audit. Captured from before the FIRST event of the
    // replay, not just around the racing session_start, so a silent decline
    // anywhere in the whole measured sequence — not merely the one this plan
    // fixes — would show up here. 11-04's own structural test
    // (queue-ignored-branches.test.ts) already proves every early return in
    // sessionAckedFromEvent/onPrintComposite/onFileUpload/sessionEnded is
    // logged; this spy is this file's own behavioural proof that NONE of
    // those branches actually fire anywhere across this specific incident's
    // replay — the whole sequence resolves cleanly start to finish.
    const warnSpy = vi.spyOn(queueLogger, 'warn');

    // --- announcement + dispatch: the real production path, not a seeded
    // store — setBoothBusy(JOB_ID) is what writes booth_state.current_job_id
    // the fallback below reads. ---------------------------------------------
    service.enqueueJob(JOB_ID);
    expect(getBooth()).toBe('ANNOUNCING');
    expect(sendAnnouncement).toHaveBeenCalledTimes(1);
    expect(sendCommand).not.toHaveBeenCalled();

    vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS);
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand.mock.calls[0][0]).toMatchObject({ jobId: JOB_ID, action: 'start_session' });
    expect(store.getBoothCurrentJobId()).toBe(JOB_ID);
    expect(store.getBoothAttempt()).toEqual({ attemptOpen: false, attemptNo: 0 });

    // --- THE RACE (LITERAL, 20ms): the Agent's trigger listener forwards
    // session_start BEFORE dslrBooth.startSession() has resolved, so jobId is
    // undefined — exactly the measured defect. -------------------------------
    vi.advanceTimersByTime(LITERAL_GAP.dispatch_to_racingSessionStart);
    service.onAgentEvent('session_start', undefined, { param1: 'PrintOnly' });

    // THE FIX: attempt_no reaches 1 on this FIRST session_start, not the
    // second — the booth binding (current_job_id, written at dispatch) is the
    // fallback authority when the Agent supplies nothing.
    expect(store.getBoothAttempt()).toEqual({ attemptOpen: true, attemptNo: 1 });
    expect(jobStatus[JOB_ID]).toBe('in_progress');
    const firstAckedAt = jobAcknowledgedAt[JOB_ID];
    expect(firstAckedAt).toBeDefined();

    // --- (LITERAL, +28ms more / +48ms from dispatch): the Agent's ack and
    // its own activeJobId stamp arrive — both correct, both too late to have
    // mattered for THIS session_start, and idempotent against the fix above.
    vi.advanceTimersByTime(LITERAL_GAP.dispatch_to_dslrBoothApiSuccess - LITERAL_GAP.dispatch_to_racingSessionStart);
    service.onAgentAck(JOB_ID, true);
    expect(store.getBoothAttempt()).toEqual({ attemptOpen: true, attemptNo: 1 }); // unchanged
    // onAgentAck's own sessionAcked() call re-stamps acknowledged_at (it has
    // no idempotency guard against an already-open attempt) — this is the
    // reference point the retake's own "survives untouched" assertion below
    // compares against, not the racing session_start's own (now stale) stamp.
    const ackedAt = jobAcknowledgedAt[JOB_ID];
    expect(ackedAt).toBeDefined();

    // --- attempt 1 (CONSTRUCTED gaps): capture, composite, print upload,
    // NOT approved — this is the photo the guest goes on to reject. ---------
    vi.advanceTimersByTime(CONSTRUCTED_GAP.ack_to_captureStart);
    service.onAgentEvent('capture_start', JOB_ID, {});

    vi.advanceTimersByTime(CONSTRUCTED_GAP.captureStart_to_fileDownload);
    service.onAgentEvent('file_download', JOB_ID, { param1: '20260818_112258_100.jpg' });

    vi.advanceTimersByTime(CONSTRUCTED_GAP.fileDownload_to_processingStart);
    service.onAgentEvent('processing_start', JOB_ID, {
      param1: '20260818_112258_100.jpg',
      param2: ATTEMPT_1_COMPOSITE,
    });
    expect(pendingPrintRows.get(JOB_ID)?.compositePath).toBe(ATTEMPT_1_COMPOSITE);
    expect(pendingPrintRows.get(JOB_ID)?.attemptNo).toBe(1);

    vi.advanceTimersByTime(CONSTRUCTED_GAP.processingStart_to_sharingScreen);
    service.onAgentEvent('sharing_screen', JOB_ID, {});

    vi.advanceTimersByTime(CONSTRUCTED_GAP.sharingScreen_to_uploadPrint);
    service.onAgentEvent('file_upload', JOB_ID, { param3: 'print', param2: REJECTED_ATTEMPT_1_URL });
    expect(pendingPrintRows.get(JOB_ID)?.photoUrl).toBe(REJECTED_ATTEMPT_1_URL);

    vi.advanceTimersByTime(CONSTRUCTED_GAP.uploadPrint_to_uploadOriginal);
    service.onAgentEvent('file_upload', JOB_ID, { param3: 'original', param2: 'https://fotoshare.co/i/orig1x' });

    expect(jobStatus[JOB_ID]).toBe('in_progress'); // not yet approved
    expect(sendPhotoLink).not.toHaveBeenCalled();

    // --- session_end #1: the retake begins (D11-06 opens grace, does not
    // release) --------------------------------------------------------------
    vi.advanceTimersByTime(CONSTRUCTED_GAP.uploadOriginal_to_sessionEnd);
    service.onAgentEvent('session_end');
    expect(getBooth()).toBe('BUSY');
    expect(store.getBoothCurrentJobId()).toBe(JOB_ID);
    expect(store.getBoothAttempt().attemptOpen).toBe(false);
    expect(sendAnnouncement).toHaveBeenCalledTimes(1); // still only the original — B still waiting

    // --- the retake's own session_start, well inside the grace window, this
    // time WITH a jobId (by now the Agent's activeJobId stamp is correct) ---
    vi.advanceTimersByTime(CONSTRUCTED_GAP.sessionEnd_to_retakeSessionStart);
    service.onAgentEvent('session_start', JOB_ID, { param1: 'PrintOnly' });

    // attempt_no reaches 2 — the retake IS recognised as a retake, which is
    // only possible because attempt_no genuinely reached 1 above. Job's own
    // acknowledged_at survives untouched (sessionAcked() not re-invoked).
    expect(store.getBoothAttempt()).toEqual({ attemptOpen: true, attemptNo: 2 });
    expect(jobAcknowledgedAt[JOB_ID]).toBe(ackedAt);

    // --- proving the grace timer was genuinely CANCELLED, not merely not yet
    // due: advance well past the ORIGINAL grace deadline (measured from
    // session_end #1) and confirm nothing finalized — if the timer had
    // survived the retake, this is exactly where it would have fired and
    // delivered attempt 1's REJECTED url via the 'grace' door. -------------
    vi.advanceTimersByTime(RETAKE_GRACE_MS + 1_000);
    expect(sendPhotoLink).not.toHaveBeenCalled();
    expect(jobStatus[JOB_ID]).toBe('in_progress');
    expect(store.getBoothCurrentJobId()).toBe(JOB_ID);

    // --- attempt 2 (CONSTRUCTED gaps), 4-shot layout: composite at param5,
    // not param2 — D11-07's scan-and-fallback rule, not a hardcoded index. --
    vi.advanceTimersByTime(CONSTRUCTED_GAP.retakeSessionStart_to_captureStart2);
    service.onAgentEvent('capture_start', JOB_ID, {});

    vi.advanceTimersByTime(CONSTRUCTED_GAP.captureStart2_to_fileDownload2);
    service.onAgentEvent('file_download', JOB_ID, { param1: '20260818_112339_700.jpg' });

    vi.advanceTimersByTime(CONSTRUCTED_GAP.fileDownload2_to_processingStart2);
    service.onAgentEvent('processing_start', JOB_ID, {
      param1: 'a.jpg', param2: 'b.jpg', param3: 'c.jpg', param4: 'd.jpg',
      param5: ATTEMPT_2_COMPOSITE,
    });
    // D11-02: OVERWRITTEN, not appended — attempt 1's URL/approval are gone.
    expect(pendingPrintRows.get(JOB_ID)?.compositePath).toBe(ATTEMPT_2_COMPOSITE);
    expect(pendingPrintRows.get(JOB_ID)?.attemptNo).toBe(2);
    expect(pendingPrintRows.get(JOB_ID)?.photoUrl).toBeUndefined();

    vi.advanceTimersByTime(CONSTRUCTED_GAP.processingStart2_to_sharingScreen2);
    service.onAgentEvent('sharing_screen', JOB_ID, {});

    vi.advanceTimersByTime(CONSTRUCTED_GAP.sharingScreen2_to_uploadPrint2);
    service.onAgentEvent('file_upload', JOB_ID, { param3: 'print', param2: KEPT_ATTEMPT_2_URL });
    expect(pendingPrintRows.get(JOB_ID)?.photoUrl).toBe(KEPT_ATTEMPT_2_URL);

    vi.advanceTimersByTime(CONSTRUCTED_GAP.uploadPrint2_to_uploadOriginal2);
    service.onAgentEvent('file_upload', JOB_ID, { param3: 'original', param2: 'https://fotoshare.co/i/orig2x' });

    // --- printing: the guest presses print on attempt 2's photo -----------
    const infoSpy = vi.spyOn(queueLogger, 'info');
    vi.advanceTimersByTime(CONSTRUCTED_GAP.uploadOriginal2_to_printing);
    service.onAgentEvent('printing', JOB_ID, { param1: ATTEMPT_2_COMPOSITE, param2: '1', param3: 'DS-RX1' });

    // Exactly one notification, carrying attempt 2's URL — never attempt 1's.
    expect(sendPhotoLink).toHaveBeenCalledTimes(1);
    expect(sendPhotoLink).toHaveBeenCalledWith(JOB_ID, KEPT_ATTEMPT_2_URL);
    expect(sendPhotoLink).not.toHaveBeenCalledWith(JOB_ID, REJECTED_ATTEMPT_1_URL);
    expect(jobStatus[JOB_ID]).toBe('completed');
    expect(pendingPrintRows.get(JOB_ID)?.status).toBe('resolved');
    expect(pendingPrintRows.get(JOB_ID)?.approvedBy).toBe('printing');

    // D11-09: SESSION_SUMMARY reads attempts=2 approved_by=printing.
    const summaryLine = infoSpy.mock.calls.map((c) => String(c[0])).find((m) => m.startsWith(`SESSION_SUMMARY job=${JOB_ID}`));
    expect(summaryLine).toBeDefined();
    expect(summaryLine).toContain('attempts=2');
    expect(summaryLine).toContain('approved_by=printing');
    expect(summaryLine).toContain('outcome=completed');

    // Guest B, who waited through the entire race and retake, is only now
    // announced — never before job A's printing finalized it.
    expect(getBooth()).toBe('ANNOUNCING');
    expect(sendAnnouncement).toHaveBeenCalledTimes(2);
    expect(sendAnnouncement.mock.calls[1][0]).toMatchObject({ jobId: JOB_B });

    // Task 3 (11-06): the audit's own assertion — across the ENTIRE replay
    // (dispatch, the race, attempt 1, the retake, attempt 2, printing), not
    // one warn line is a silent-decline branch. The defect this plan closes
    // cost a live session precisely because a decline had NO log line at
    // all; this proves the fixed sequence produces none of those lines
    // either, not merely that the ones it does produce are informational.
    const declineWarnLines = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('ignored') || m.includes('dropped') || m.includes('does not match'));
    expect(declineWarnLines).toEqual([]);

    service.stop();
  });

  it('a session_start with no jobId AND no booth binding still does nothing — the D-06 stray-session_start guard survives the fallback, and says so in one log line', () => {
    const { store, jobStatus } = buildStore();
    const service = new QueueService(store, CONFIG);
    const sendPhotoLink = vi.fn(async () => {});
    service.bindNotificationService({ sendPhotoLink });
    const warnSpy = vi.spyOn(queueLogger, 'warn');

    // Genuinely idle booth, nothing dispatched — a stray dslrBooth session
    // (someone touching the booth's own screen) with no jobId to fall back to.
    expect(store.getBoothCurrentJobId()).toBeUndefined();
    service.onAgentEvent('session_start', undefined, { param1: 'PrintOnly' });

    expect(store.getBoothAttempt()).toEqual({ attemptOpen: false, attemptNo: 0 });
    expect(jobStatus[JOB_ID]).toBe('queued'); // untouched
    expect(sendPhotoLink).not.toHaveBeenCalled();

    const lines = warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('no jobId and no booth binding'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('session_start ignored: no jobId and no booth binding');

    service.stop();
  });
});

/**
 * Task 3 (11-06): the structural half of the audit. A behavioural sample
 * (above) can only prove the fixtures written so far do not observe a silent
 * decline — it cannot prove the new branch itself is structurally incapable
 * of one. This reads onAgentEvent()'s own `session_start` branch directly
 * from source (comments stripped, the same technique
 * test/queue-ignored-branches.test.ts already established for
 * sessionAckedFromEvent/onPrintComposite/onFileUpload/sessionEnded — that
 * file's own METHODS list does not cover onAgentEvent, since 11-04 predates
 * this branch, so this is that same guarantee extended to the one new
 * branch 11-06 adds).
 */
describe('QueueService source invariant — the new session_start fallback branch is not silent (11-06, D11-09)', () => {
  it('onAgentEvent()\'s own session_start branch names a queueLogger call before its no-op path — the fallback introduced by this plan cannot decline without logging why', () => {
    const sourcePath = path.join(__dirname, '..', 'src', 'queue', 'queueService.ts');
    const stripped = fs.readFileSync(sourcePath, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    const branchStart = stripped.indexOf("else if (eventType === 'session_start')");
    const branchEnd = stripped.indexOf("else if (eventType === 'file_upload'", branchStart);
    expect(branchStart).toBeGreaterThan(-1);
    expect(branchEnd).toBeGreaterThan(branchStart);
    const branchText = stripped.slice(branchStart, branchEnd);

    // The branch's own no-op path (the `if (effectiveJobId === undefined)`
    // arm) must contain a queueLogger call — this is what makes the D-06
    // stray-session_start guard's silence a LOGGED silence, not a bare one.
    expect(branchText).toContain('queueLogger.');
    expect(branchText).toContain('effectiveJobId === undefined');
  });
});
