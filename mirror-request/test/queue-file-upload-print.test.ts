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
 * session emits five uploads spread over eleven seconds, and last-writer-wins
 * would let the notification sweeper's timing decide which photo the guest
 * gets.
 *
 * D11-04 (phase 11): THIS FILE'S SUBJECT HAS CHANGED. It used to prove that a
 * `file_upload param3=print` sends the guest their photo. It does not, any
 * more — 07-EVIDENCE §D measured that every attempt, kept or discarded,
 * produces its own `print` upload, so sending directly from here would
 * deliver a REJECTED attempt's photo whenever the guest retakes. This file
 * now proves the opposite half of that split: an upload RECORDS the URL for
 * its job's pending-print slot and NEVER DELIVERS IT ITSELF. Delivery happens
 * only when one of D11-05's three finalize doors opens afterward — an
 * approving `printing`, a grace-timer expiry, or an operator release. Every
 * guarantee this file proved before phase 11 — the param2 fallback, the
 * print-only filter, the no-slot drop, attribution by the pending-print
 * registry rather than by booth binding — survives unchanged; only the
 * consequence of a successful match changed, from "sent" to "written and
 * waiting for a door".
 */

const CONFIG = {
  SESSION_TIMEOUT_MS: 300_000,
  NEXT_GUEST_COUNTDOWN_MS: 5_000,
  SESSION_MAX_RETRIES: 2,
  BOOTH_RELEASE_TIMEOUT_MS: 120_000,
  RETAKE_GRACE_MS: 20_000,
};

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
 * arrives: the print composite opened the slot at `processing_start`, seconds
 * earlier — with an attempt already open (D11-01), which every case here
 * assumes unless it says otherwise. `'none'` is D-04 (no session was ever
 * awaiting a print for this job) and `'expired'` is the pending-print
 * registry's OWN, now fully independent, expiry sweep (D11-05) — the two
 * cases the registry exists to keep apart.
 */
type PendingSeed = PendingPrintStatus | 'none';

function buildStore(currentJobId: string | undefined = JOB, pending: PendingSeed = 'awaiting') {
  let booth = 'BUSY';
  let boundJobId: string | undefined = currentJobId;
  let attemptOpen = true;
  let attemptNo = 1;
  const now = Date.now();
  const { registry, rows } = createPendingPrintRegistry(
    pending === 'none'
      ? []
      : [{ jobId: JOB, compositePath: COMPOSITE, status: pending, openedAt: now, expiresAt: now + 600_000, attemptNo: 1 }],
  );
  const updateJobStatus = vi.fn();
  const completeJob = vi.fn(() => true);
  const closeJobNoPhotoJob = vi.fn(() => true);
  const failJob = vi.fn();
  const store = {
    getBoothState: () => booth,
    getBoothStateDetailed: () => ({ state: booth, updated_at: new Date().toISOString() }),
    getInFlightJobs: () => [],
    getNextQueuedJob: () => undefined,
    setBoothBusy: (jobId?: string | null) => { booth = 'BUSY'; boundJobId = jobId ?? undefined; attemptOpen = false; attemptNo = 0; },
    setBoothIdle: () => { booth = 'IDLE'; boundJobId = undefined; attemptOpen = false; attemptNo = 0; },
    setBoothTimeout: () => { booth = 'IDLE'; boundJobId = undefined; attemptOpen = false; attemptNo = 0; },
    getBoothCurrentJobId: () => boundJobId,
    setBoothCurrentJob: (jobId: string | null) => { boundJobId = jobId ?? undefined; },
    getBoothAttempt: () => ({ attemptOpen, attemptNo }),
    openBoothAttempt: () => { attemptOpen = true; attemptNo += 1; return { attemptOpen, attemptNo }; },
    closeBoothAttempt: () => { attemptOpen = false; },
    updateJobStatus,
    getQueuedGuestSummaries: () => [],
    getQueueLength: () => 0,
    completeJob,
    closeJobNoPhoto: closeJobNoPhotoJob,
    failJob,
    // 07-04: session_end reads the bound job, and every tick sweeps for
    // no-photo candidates. This fixture tracks no job status of its own, so
    // the job reads as in_progress and is never a sweep candidate.
    getJob: (id: string) => ({ id, status: 'in_progress' }),
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
  return { store, rows, updateJobStatus, completeJob, closeJobNoPhoto: closeJobNoPhotoJob, failJob };
}

function buildService(store: LocalStore) {
  const sendPhotoLink = vi.fn(async () => {});
  const service = new QueueService(store, CONFIG);
  service.bindNotificationService({ sendPhotoLink });
  service.bindAnnouncement(() => {});
  return { service, sendPhotoLink };
}

/** Reaches D11-05's finalize gate directly — a stand-in for whichever of the
 * three doors production would use, without needing fake-timer choreography
 * for the grace door or 11-03's not-yet-built CMS route for the operator
 * door. finalizePendingPrint() itself does not depend on booth binding, only
 * on the jobId — the same registry-independence D-07 already established for
 * onFileUpload().
 */
function finalizeDirectly(service: QueueService, jobId: string, door: 'printing' | 'grace' | 'operator') {
  return (service as unknown as { finalizePendingPrint: (jobId: string, door: string) => boolean })
    .finalizePendingPrint(jobId, door);
}

describe("dslrBooth file_upload -> pending-print slot, never a direct notification (D11-04)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('takes the photo URL from param2, because dslrBooth never sends photoUrl — writes it into the slot without sending; an approving printing then delivers it', () => {
    const { service, sendPhotoLink } = buildService(buildStore().store);

    service.onAgentEvent('file_upload', JOB, REAL_SESSION_UPLOADS[1]);

    // Before the fix this was called with '' and the notification service
    // logged "no photo URL" — the exact production symptom. Now it is not
    // called at all yet — D11-04 defers sending to the finalize gate.
    expect(sendPhotoLink).not.toHaveBeenCalled();

    service.onAgentEvent('printing', JOB, { param1: COMPOSITE });
    expect(sendPhotoLink).toHaveBeenCalledWith(JOB, PRINT_URL);
    service.stop();
  });

  it('a whole real session produces exactly ONE notification, and it is the print composite — sent only once the approving printing arrives', () => {
    const { service, sendPhotoLink } = buildService(buildStore().store);

    for (const upload of REAL_SESSION_UPLOADS) {
      service.onAgentEvent('file_upload', JOB, upload);
    }
    expect(sendPhotoLink).not.toHaveBeenCalled();

    service.onAgentEvent('printing', JOB, { param1: COMPOSITE });

    expect(sendPhotoLink).toHaveBeenCalledTimes(1);
    expect(sendPhotoLink).toHaveBeenCalledWith(JOB, PRINT_URL);
    service.stop();
  });

  it('ignores every original frame, so the sweeper cannot race them against the print, and none of them is ever written to the slot', () => {
    const { store, rows } = buildStore();
    const { service, sendPhotoLink } = buildService(store);

    for (const upload of REAL_SESSION_UPLOADS.filter((u) => u.param3 === 'original')) {
      service.onAgentEvent('file_upload', JOB, upload);
    }

    expect(sendPhotoLink).not.toHaveBeenCalled();
    expect(rows.get(JOB)?.photoUrl).toBeUndefined();
    service.stop();
  });

  it('a print upload arriving AFTER an unapproved session_end (grace open) still writes the URL, and grace expiry (door 2) is what finally delivers it', () => {
    // Measured on the real booth: session_end fired at 06:16:01.819 and a
    // further file_upload arrived at 06:16:04.959. Ordering is not
    // guaranteed. D-07/D11-06: the booth stays bound during grace (it is not
    // released the way an approved job's session_end is), and the registry
    // — not booth binding — is still what answers "who is owed this photo".
    const { service, sendPhotoLink } = buildService(buildStore().store);

    service.onAgentEvent('session_end'); // unapproved — opens grace, keeps the booth bound
    service.onAgentEvent('file_upload', JOB, REAL_SESSION_UPLOADS[1]);
    expect(sendPhotoLink).not.toHaveBeenCalled();

    // Grace's own expiry (door 2) is what would finalize this in production;
    // invoked directly here since this file drives events without fake
    // timers — see finalizeDirectly()'s own comment.
    finalizeDirectly(service, JOB, 'grace');
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

  it('session_end produces no print-related warn when a print did arrive (written, not yet sent)', () => {
    const { service } = buildService(buildStore().store);
    const warnSpy = vi.spyOn(queueLogger, 'warn');

    service.onAgentEvent('file_upload', JOB, REAL_SESSION_UPLOADS[1]);
    service.onAgentEvent('session_end');

    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('No print upload seen'))).toBe(false);
    service.stop();
  });

  it('a print upload with no URL in either field warns instead of writing an empty one', () => {
    const { service, sendPhotoLink } = buildService(buildStore().store);
    const warnSpy = vi.spyOn(queueLogger, 'warn');

    service.onAgentEvent('file_upload', JOB, { param1: 'x.jpg', param3: 'print', param4: 'Test event' });

    expect(sendPhotoLink).not.toHaveBeenCalled();
    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('carried no URL'))).toBe(true);
    service.stop();
  });

  it('still prefers an explicit photoUrl over param2, so a future Agent that sends one keeps working — written to the slot, not sent directly', () => {
    const { store, rows } = buildStore();
    const { service, sendPhotoLink } = buildService(store);

    service.onAgentEvent('file_upload', JOB, {
      photoUrl: 'https://example.com/explicit.jpg',
      param2: 'https://fotoshare.co/i/ignored',
      param3: 'print',
    });

    expect(sendPhotoLink).not.toHaveBeenCalled();
    expect(rows.get(JOB)?.photoUrl).toBe('https://example.com/explicit.jpg');
    service.stop();
  });

  it('a payload with no param3 at all is still accepted and written to the slot, preserving every pre-existing caller', () => {
    // Phase 2-4 tests and any non-dslrBooth source send { photoUrl } with no
    // param3. Narrowing to "print only" must not silently break them.
    const { store, rows } = buildStore();
    const { service, sendPhotoLink } = buildService(store);

    service.onAgentEvent('file_upload', JOB, { photoUrl: 'http://example.com/x.jpg' });

    expect(sendPhotoLink).not.toHaveBeenCalled();
    expect(rows.get(JOB)?.photoUrl).toBe('http://example.com/x.jpg');
    service.stop();
  });

  it('an upload arriving for a job already finalized WITH a URL already sent is a logged no-op (post-finalize replay)', () => {
    const { store, rows } = buildStore(JOB, 'resolved');
    rows.get(JOB)!.photoUrl = PRINT_URL;
    rows.get(JOB)!.approvedBy = 'printing';
    const { service, sendPhotoLink } = buildService(store);
    const infoSpy = vi.spyOn(queueLogger, 'info');

    service.onAgentEvent('file_upload', JOB, REAL_SESSION_UPLOADS[1]);

    expect(sendPhotoLink).not.toHaveBeenCalled();
    expect(rows.get(JOB)?.status).toBe('resolved');
    const messages = infoSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes(JOB) && m.includes('already finalized'))).toBe(true);
    service.stop();
  });

  it('an upload arriving for a job finalized WITHOUT a URL yet is delivered late, with a warn (D-11 late-arrival, carried forward)', () => {
    const { store, rows } = buildStore(JOB, 'resolved'); // resolved, no photoUrl seeded — the no_photo-then-late-upload shape
    const { service, sendPhotoLink } = buildService(store);
    const warnSpy = vi.spyOn(queueLogger, 'warn');

    service.onAgentEvent('file_upload', JOB, REAL_SESSION_UPLOADS[1]);

    expect(sendPhotoLink).toHaveBeenCalledTimes(1);
    expect(sendPhotoLink).toHaveBeenCalledWith(JOB, PRINT_URL);
    expect(rows.get(JOB)?.status).toBe('resolved');
    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes(JOB) && /already closed/i.test(m))).toBe(true);
    service.stop();
  });
});

/**
 * D-07/D-04/D11-04/D11-05: which job a print upload belongs to is decided by
 * the pending-print registry, not by whichever job happens to own the booth
 * at the moment the upload arrives. The three-way answer — a row that is
 * `awaiting`, a row that is `expired`, and no row at all — is still the whole
 * attribution mechanism; what changed under D11-04/D11-05 is that resolving
 * to `'resolved'` and actually SENDING are now two different events, and
 * `'expired'` (the pending-print registry's OWN sweep) is now fully
 * independent of the job's finalize state.
 */
describe('print upload resolution against the pending-print registry (D-04, D-07, D11-04/D11-05)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a processing_start opens exactly one registry row carrying the composite path — completes nothing (D11-02)', () => {
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

  it('printing never writes to the pending-print slot — only processing_start opens or overwrites it (D11-02); a composite mismatch is simply ignored', () => {
    const { store, rows } = buildStore(JOB, 'none');
    const { service } = buildService(store);

    service.onAgentEvent('processing_start', JOB, { param5: COMPOSITE });
    const openedAtAfterFirst = rows.get(JOB)?.openedAt;
    const expiresAtAfterFirst = rows.get(JOB)?.expiresAt;

    service.onAgentEvent('printing', JOB, { param1: 'C:\\other\\path.jpg' }); // mismatched composite

    expect(rows.size).toBe(1);
    expect(rows.get(JOB)?.compositePath).toBe(COMPOSITE);
    expect(rows.get(JOB)?.status).toBe('awaiting'); // not finalized — the mismatch was ignored
    expect(rows.get(JOB)?.openedAt).toBe(openedAtAfterFirst);
    expect(rows.get(JOB)?.expiresAt).toBe(expiresAtAfterFirst);
    service.stop();
  });

  it('an awaiting row records the URL without sending; an approving printing then delivers it and moves the row to resolved', () => {
    const { store, rows } = buildStore(JOB, 'awaiting');
    const { service, sendPhotoLink } = buildService(store);

    service.onAgentEvent('file_upload', JOB, REAL_SESSION_UPLOADS[1]);
    expect(sendPhotoLink).not.toHaveBeenCalled();
    expect(rows.get(JOB)?.photoUrl).toBe(PRINT_URL);
    expect(rows.get(JOB)?.status).toBe('awaiting');

    service.onAgentEvent('printing', JOB, { param1: COMPOSITE });

    expect(sendPhotoLink).toHaveBeenCalledTimes(1);
    expect(sendPhotoLink).toHaveBeenCalledWith(JOB, PRINT_URL);
    expect(rows.get(JOB)?.status).toBe('resolved');
    service.stop();
  });

  it('an already-resolved-and-sent row delivers nothing a second time', () => {
    const { store, rows } = buildStore(JOB, 'resolved');
    rows.get(JOB)!.photoUrl = PRINT_URL;
    const { service, sendPhotoLink } = buildService(store);

    service.onAgentEvent('file_upload', JOB, REAL_SESSION_UPLOADS[1]);

    expect(sendPhotoLink).not.toHaveBeenCalled();
    expect(rows.get(JOB)?.status).toBe('resolved');
    service.stop();
  });

  // D11-05: the pending-print registry's own expiry sweep and the job's
  // finalize gate are now fully independent timers on two different things
  // (RESEARCH.md's own words). An 'expired' row still accepts a late write —
  // it is NOT itself the job's terminal state — and, like 'awaiting', does
  // not send until a door opens.
  it('an expired pending-print row still records the URL (write-only) — the registry\'s own expiry and the job\'s finalize gate are independent', () => {
    const { store, updateJobStatus, completeJob, failJob, rows } = buildStore(JOB, 'expired');
    const { service, sendPhotoLink } = buildService(store);

    service.onAgentEvent('file_upload', JOB, REAL_SESSION_UPLOADS[1]);

    expect(sendPhotoLink).not.toHaveBeenCalled();
    expect(rows.get(JOB)?.photoUrl).toBe(PRINT_URL);
    expect(rows.get(JOB)?.status).toBe('expired'); // unchanged by the write
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
