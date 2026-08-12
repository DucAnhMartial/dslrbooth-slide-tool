import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueService, queueLogger } from '../src/queue/queueService';
import type { LocalStore } from '../src/state/localStore';
import { createPendingPrintRegistry, type PendingPrintStatus } from './helpers/pendingPrintRegistry';
import { REAL_SESSION_UPLOADS, PRINT_URL, COMPOSITE } from './helpers/realSessionUploads';

/**
 * Regression cover for a defect found by running a REAL dslrBooth session on
 * 2026-08-12, not by reading code: the guest's photo never reached the
 * slideshow, and the server logged `Notification: no photo URL` five times per
 * session while the URL sat unread in the payload the whole time.
 *
 * dslrBooth does not send a `photoUrl` field. Its `file_upload` trigger carries
 * positional parameters — captured verbatim from that session's Agent log:
 *
 *   param1 = C:\dslrBooth\Test_event\Prints\20260812_131547_837_1x.jpg
 *   param2 = https://fotoshare.co/i/4kmtdhm
 *   param3 = original | print
 *   param4 = Test event
 *
 * The Agent forwards every param verbatim (CLAUDE.md: "Agent is a dumb relay
 * only"), so the fix belongs on this side and these tests live here.
 *
 * The `print` filter is a correctness requirement, not a preference: one
 * session emits five uploads spread over eleven seconds, and
 * `enqueueNotification()` is last-writer-wins until the row reaches
 * `delivered`/`failed`. Accepting all five would let the notification sweeper's
 * timing decide which photo the guest gets.
 */

const CONFIG = { SESSION_TIMEOUT_MS: 300_000, NEXT_GUEST_COUNTDOWN_MS: 5_000, SESSION_MAX_RETRIES: 2 };

const JOB = 'MQNE2885'; // the real ticket_code from the session that exposed this

// The five uploads of one real session, the print URL and the composite path
// all moved to test/helpers/realSessionUploads.ts in 07-05: queue-event-
// coverage.test.ts now asserts D-13 (no info-level line carries one of these
// URLs) against the same values, and a second hand-copied fixture would let
// that assertion drift onto a URL the service never sees. PRINT_URL and
// COMPOSITE are derived from the fixture there rather than retyped.

/**
 * How the registry is seeded before the test runs. `'awaiting'` is the default
 * because it is what a real session looks like by the time any `file_upload`
 * arrives: the print composite opened the slot at the completion anchor,
 * seconds earlier. `'none'` is D-04 (no session was ever awaiting a print for
 * this job) and `'expired'` is D-11 (the slot was opened, and the print is
 * late) — the two cases the registry exists to keep apart.
 */
type PendingSeed = PendingPrintStatus | 'none';

function buildStore(currentJobId: string | undefined = JOB, pending: PendingSeed = 'awaiting') {
  let booth = 'BUSY';
  let boundJobId: string | undefined = currentJobId;
  const now = Date.now();
  const { registry, rows } = createPendingPrintRegistry(
    pending === 'none'
      ? []
      : [{ jobId: JOB, compositePath: COMPOSITE, status: pending, openedAt: now, expiresAt: now + 600_000 }],
  );
  const updateJobStatus = vi.fn();
  const completeJob = vi.fn(() => true);
  const failJob = vi.fn();
  const store = {
    getBoothState: () => booth,
    getNextQueuedJob: () => undefined,
    setBoothBusy: (jobId?: string | null) => { booth = 'BUSY'; boundJobId = jobId ?? undefined; },
    setBoothIdle: () => { booth = 'IDLE'; boundJobId = undefined; },
    setBoothTimeout: () => { booth = 'IDLE'; boundJobId = undefined; },
    getBoothCurrentJobId: () => boundJobId,
    setBoothCurrentJob: (jobId: string | null) => { boundJobId = jobId ?? undefined; },
    updateJobStatus,
    getQueuedGuestSummaries: () => [],
    getQueueLength: () => 0,
    completeJob,
    failJob,
    // 07-04: session_end reads the bound job, and every tick sweeps for
    // no-photo candidates. This fixture tracks no job status of its own, so
    // the job reads as in_progress and is never a sweep candidate.
    getJob: (id: string) => ({ id, status: 'in_progress' }),
    closeJobNoPhoto: vi.fn(() => false),
    getJobsAwaitingNoPhotoClose: () => [],
    getQueuePosition: () => undefined,
    // Phase 8 plan 08-02: a resolved print upload now also writes a photo-
    // history row (D-10), which needs the registration join and the active
    // event. This fixture stands for a NORMALLY CONFIGURED service — an
    // active event and a real registration — because that is what keeps the
    // "zero print-related warnings on a good session" assertions below
    // meaningful. A fixture with no active event would warn on every upload
    // and those assertions would be measuring the fixture, not the code.
    getJobRegistration: (id: string) => ({
      job: { id },
      registration: { id: 'reg-1', name: 'Guest One', email: '', phone: '', mode: 'standard', registered_at: '' },
    }),
    getActiveEventId: () => 'evt-fixture',
    recordEventPhoto: vi.fn(() => true),
    ...registry,
  } as unknown as LocalStore;
  return { store, rows, updateJobStatus, completeJob, failJob };
}

function buildService(store: LocalStore) {
  const sendPhotoLink = vi.fn(async () => {});
  const service = new QueueService(store, CONFIG);
  service.bindNotificationService({ sendPhotoLink });
  return { service, sendPhotoLink };
}

describe("dslrBooth file_upload -> guest notification (real trigger shape)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('takes the photo URL from param2, because dslrBooth never sends photoUrl', () => {
    const { service, sendPhotoLink } = buildService(buildStore().store);

    service.onAgentEvent('file_upload', JOB, REAL_SESSION_UPLOADS[1]);

    // Before the fix this was called with '' and the notification service
    // logged "no photo URL" — the exact production symptom.
    expect(sendPhotoLink).toHaveBeenCalledWith(JOB, PRINT_URL);
    service.stop();
  });

  it('a whole real session produces exactly ONE notification, and it is the print composite', () => {
    const { service, sendPhotoLink } = buildService(buildStore().store);

    for (const upload of REAL_SESSION_UPLOADS) {
      service.onAgentEvent('file_upload', JOB, upload);
    }

    expect(sendPhotoLink).toHaveBeenCalledTimes(1);
    expect(sendPhotoLink).toHaveBeenCalledWith(JOB, PRINT_URL);
    service.stop();
  });

  it('ignores every original frame, so the sweeper cannot race them against the print', () => {
    const { service, sendPhotoLink } = buildService(buildStore().store);

    for (const upload of REAL_SESSION_UPLOADS.filter((u) => u.param3 === 'original')) {
      service.onAgentEvent('file_upload', JOB, upload);
    }

    expect(sendPhotoLink).not.toHaveBeenCalled();
    service.stop();
  });

  it('a print upload arriving AFTER session_end is still delivered', () => {
    // Measured on the real booth: session_end fired at 06:16:01.819 and a
    // further file_upload arrived at 06:16:04.959. Ordering is not guaranteed.
    // This is D-07 stated as a test: the booth has already been released and
    // current_job_id is gone, so only the registry can still answer "who is
    // owed this photo".
    const { service, sendPhotoLink } = buildService(buildStore().store);

    service.onAgentEvent('session_end');
    service.onAgentEvent('file_upload', JOB, REAL_SESSION_UPLOADS[1]);

    expect(sendPhotoLink).toHaveBeenCalledWith(JOB, PRINT_URL);
    service.stop();
  });

  // Replaces the previous, opposite assertion ("warns at session_end when the
  // session produced no print upload"). WINDOWS item 9: dslrBooth delivers the
  // composite about a second AFTER session_end on some sessions and 26 seconds
  // BEFORE it on others, so a check at session_end fired on every successful
  // session and told the operator nothing. The warning moves to registry
  // expiry (07-03 Task 3), which is the only place it can be correct.
  it('session_end produces no print-related warn even when no print upload has arrived yet', () => {
    const { service } = buildService(buildStore().store);
    const warnSpy = vi.spyOn(queueLogger, 'warn');

    for (const upload of REAL_SESSION_UPLOADS.filter((u) => u.param3 === 'original')) {
      service.onAgentEvent('file_upload', JOB, upload);
    }
    service.onAgentEvent('session_end');

    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('No print upload seen'))).toBe(false);
    service.stop();
  });

  it('session_end produces no print-related warn when a print did arrive', () => {
    const { service } = buildService(buildStore().store);
    const warnSpy = vi.spyOn(queueLogger, 'warn');

    service.onAgentEvent('file_upload', JOB, REAL_SESSION_UPLOADS[1]);
    service.onAgentEvent('session_end');

    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('No print upload seen'))).toBe(false);
    service.stop();
  });

  it('a print upload with no URL in either field warns instead of enqueuing an empty one', () => {
    const { service, sendPhotoLink } = buildService(buildStore().store);
    const warnSpy = vi.spyOn(queueLogger, 'warn');

    service.onAgentEvent('file_upload', JOB, { param1: 'x.jpg', param3: 'print', param4: 'Test event' });

    expect(sendPhotoLink).not.toHaveBeenCalled();
    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('carried no URL'))).toBe(true);
    service.stop();
  });

  it('still prefers an explicit photoUrl, so a future Agent that sends one keeps working', () => {
    const { service, sendPhotoLink } = buildService(buildStore().store);

    service.onAgentEvent('file_upload', JOB, {
      photoUrl: 'https://example.com/explicit.jpg',
      param2: 'https://fotoshare.co/i/ignored',
      param3: 'print',
    });

    expect(sendPhotoLink).toHaveBeenCalledWith(JOB, 'https://example.com/explicit.jpg');
    service.stop();
  });

  it('a payload with no param3 at all is still accepted, preserving every pre-existing caller', () => {
    // Phase 2-4 tests and any non-dslrBooth source send { photoUrl } with no
    // param3. Narrowing to "print only" must not silently break them.
    const { service, sendPhotoLink } = buildService(buildStore().store);

    service.onAgentEvent('file_upload', JOB, { photoUrl: 'http://example.com/x.jpg' });

    expect(sendPhotoLink).toHaveBeenCalledWith(JOB, 'http://example.com/x.jpg');
    service.stop();
  });
});

/**
 * D-07/D-04/D-11: which job a print upload belongs to is decided by the
 * pending-print registry, not by whichever job happens to own the booth at the
 * moment the upload arrives. The three-way answer — a row that is `awaiting`, a
 * row that is `expired`, and no row at all — is the whole mechanism, so each
 * branch gets its own case here.
 */
describe('print upload resolution against the pending-print registry (D-04, D-07, D-11)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('completing a job at the print composite opens exactly one registry row carrying the composite path', () => {
    const { store, rows } = buildStore(JOB, 'none');
    const { service } = buildService(store);

    service.onAgentEvent('processing_start', JOB, { param5: COMPOSITE });

    expect(rows.size).toBe(1);
    const row = rows.get(JOB);
    expect(row?.status).toBe('awaiting');
    expect(row?.compositePath).toBe(COMPOSITE);
    expect(row?.expiresAt).toBeGreaterThan(row!.openedAt);
    service.stop();
  });

  it('the processing_start/printing double fire opens one slot, not two, and does not extend the first', () => {
    const { store, rows } = buildStore(JOB, 'none');
    const { service } = buildService(store);

    service.onAgentEvent('processing_start', JOB, { param5: COMPOSITE });
    const openedAtAfterFirst = rows.get(JOB)?.openedAt;
    const expiresAtAfterFirst = rows.get(JOB)?.expiresAt;

    service.onAgentEvent('printing', JOB, { param1: 'C:\\other\\path.jpg' });

    expect(rows.size).toBe(1);
    expect(rows.get(JOB)?.compositePath).toBe(COMPOSITE);
    expect(rows.get(JOB)?.openedAt).toBe(openedAtAfterFirst);
    expect(rows.get(JOB)?.expiresAt).toBe(expiresAtAfterFirst);
    service.stop();
  });

  it('an awaiting row delivers the photo and moves to resolved', () => {
    const { store, rows } = buildStore(JOB, 'awaiting');
    const { service, sendPhotoLink } = buildService(store);

    service.onAgentEvent('file_upload', JOB, REAL_SESSION_UPLOADS[1]);

    expect(sendPhotoLink).toHaveBeenCalledTimes(1);
    expect(sendPhotoLink).toHaveBeenCalledWith(JOB, PRINT_URL);
    expect(rows.get(JOB)?.status).toBe('resolved');
    service.stop();
  });

  it('an already-resolved row delivers nothing a second time', () => {
    const { store, rows } = buildStore(JOB, 'resolved');
    const { service, sendPhotoLink } = buildService(store);

    service.onAgentEvent('file_upload', JOB, REAL_SESSION_UPLOADS[1]);

    expect(sendPhotoLink).not.toHaveBeenCalled();
    expect(rows.get(JOB)?.status).toBe('resolved');
    service.stop();
  });

  // D-11: getting the photo late beats not getting it. The job's own status is
  // NOT touched — a terminal row is never re-armed, and that guarantee lives in
  // Phase 4's SQL, not in a condition here.
  it('an expired row still delivers the photo, warns exactly once, and calls no job-status writer', () => {
    const { store, updateJobStatus, completeJob, failJob } = buildStore(JOB, 'expired');
    const { service, sendPhotoLink } = buildService(store);
    const warnSpy = vi.spyOn(queueLogger, 'warn');

    service.onAgentEvent('file_upload', JOB, REAL_SESSION_UPLOADS[1]);

    expect(sendPhotoLink).toHaveBeenCalledTimes(1);
    expect(sendPhotoLink).toHaveBeenCalledWith(JOB, PRINT_URL);
    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    const lateWarns = messages.filter((m) => m.includes(JOB) && /late/i.test(m));
    expect(lateWarns).toHaveLength(1);
    expect(updateJobStatus).not.toHaveBeenCalled();
    expect(completeJob).not.toHaveBeenCalled();
    expect(failJob).not.toHaveBeenCalled();
    service.stop();
  });

  // D-04: a photo produced with no session awaiting it reaches nobody. This is
  // the case that would otherwise send a stranger's photo to the last real
  // guest's email and phone number, because the Agent never clears activeJobId.
  it('no registry row at all delivers nothing and warns exactly once', () => {
    const { store } = buildStore(JOB, 'none');
    const { service, sendPhotoLink } = buildService(store);
    const warnSpy = vi.spyOn(queueLogger, 'warn');

    service.onAgentEvent('file_upload', JOB, REAL_SESSION_UPLOADS[1]);

    expect(sendPhotoLink).not.toHaveBeenCalled();
    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    const dropWarns = messages.filter((m) => m.includes(JOB) && /no session was awaiting a print/i.test(m));
    expect(dropWarns).toHaveLength(1);
    service.stop();
  });

  it('an original frame is still ignored before the registry is ever consulted', () => {
    const { store } = buildStore(JOB, 'none');
    const { service, sendPhotoLink } = buildService(store);
    const warnSpy = vi.spyOn(queueLogger, 'warn');

    service.onAgentEvent('file_upload', JOB, REAL_SESSION_UPLOADS[0]);

    expect(sendPhotoLink).not.toHaveBeenCalled();
    // The D-04 drop warn is for print composites only — an `original` frame is
    // expected to have no slot and must stay silent at warn level.
    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => /no session was awaiting a print/i.test(m))).toBe(false);
    service.stop();
  });
});
