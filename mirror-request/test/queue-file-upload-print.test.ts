import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueService, queueLogger } from '../src/queue/queueService';
import type { LocalStore } from '../src/state/localStore';

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

/** The five uploads of one real session, in the order the booth emitted them. */
const REAL_SESSION_UPLOADS = [
  { param1: 'C:\\dslrBooth\\Test_event\\Singles\\20260812_131525_230.jpg', param2: 'https://fotoshare.co/i/1t1vcs3', param3: 'original', param4: 'Test event' },
  { param1: 'C:\\dslrBooth\\Test_event\\Prints\\20260812_131547_837_1x.jpg', param2: 'https://fotoshare.co/i/4kmtdhm', param3: 'print', param4: 'Test event' },
  { param1: 'C:\\dslrBooth\\Test_event\\Singles\\20260812_131532_316.jpg', param2: 'https://fotoshare.co/i/4eexxer', param3: 'original', param4: 'Test event' },
  { param1: 'C:\\dslrBooth\\Test_event\\Singles\\20260812_131538_830.jpg', param2: 'https://fotoshare.co/i/483fqdw', param3: 'original', param4: 'Test event' },
  { param1: 'C:\\dslrBooth\\Test_event\\Singles\\20260812_131545_279.jpg', param2: 'https://fotoshare.co/i/2yx6f9k', param3: 'original', param4: 'Test event' },
];

const PRINT_URL = 'https://fotoshare.co/i/4kmtdhm';

function buildStore(currentJobId: string | undefined = JOB) {
  let booth = 'BUSY';
  let boundJobId: string | undefined = currentJobId;
  return {
    getBoothState: () => booth,
    getNextQueuedJob: () => undefined,
    setBoothBusy: (jobId?: string | null) => { booth = 'BUSY'; boundJobId = jobId ?? undefined; },
    setBoothIdle: () => { booth = 'IDLE'; boundJobId = undefined; },
    setBoothTimeout: () => { booth = 'IDLE'; boundJobId = undefined; },
    getBoothCurrentJobId: () => boundJobId,
    setBoothCurrentJob: (jobId: string | null) => { boundJobId = jobId ?? undefined; },
    updateJobStatus: vi.fn(),
    getQueuedGuestSummaries: () => [],
    getQueueLength: () => 0,
    completeJob: vi.fn(() => true),
    getQueuePosition: () => undefined,
    getJobRegistration: () => undefined,
  } as unknown as LocalStore;
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
    const { service, sendPhotoLink } = buildService(buildStore());

    service.onAgentEvent('file_upload', JOB, REAL_SESSION_UPLOADS[1]);

    // Before the fix this was called with '' and the notification service
    // logged "no photo URL" — the exact production symptom.
    expect(sendPhotoLink).toHaveBeenCalledWith(JOB, PRINT_URL);
    service.stop();
  });

  it('a whole real session produces exactly ONE notification, and it is the print composite', () => {
    const { service, sendPhotoLink } = buildService(buildStore());

    for (const upload of REAL_SESSION_UPLOADS) {
      service.onAgentEvent('file_upload', JOB, upload);
    }

    expect(sendPhotoLink).toHaveBeenCalledTimes(1);
    expect(sendPhotoLink).toHaveBeenCalledWith(JOB, PRINT_URL);
    service.stop();
  });

  it('ignores every original frame, so the sweeper cannot race them against the print', () => {
    const { service, sendPhotoLink } = buildService(buildStore());

    for (const upload of REAL_SESSION_UPLOADS.filter((u) => u.param3 === 'original')) {
      service.onAgentEvent('file_upload', JOB, upload);
    }

    expect(sendPhotoLink).not.toHaveBeenCalled();
    service.stop();
  });

  it('a print upload arriving AFTER session_end is still delivered', () => {
    // Measured on the real booth: session_end fired at 06:16:01.819 and a
    // further file_upload arrived at 06:16:04.959. Ordering is not guaranteed.
    const { service, sendPhotoLink } = buildService(buildStore());

    service.onAgentEvent('session_end');
    service.onAgentEvent('file_upload', JOB, REAL_SESSION_UPLOADS[1]);

    expect(sendPhotoLink).toHaveBeenCalledWith(JOB, PRINT_URL);
    service.stop();
  });

  it('warns at session_end when the session produced no print upload', () => {
    const { service } = buildService(buildStore());
    const warnSpy = vi.spyOn(queueLogger, 'warn');

    for (const upload of REAL_SESSION_UPLOADS.filter((u) => u.param3 === 'original')) {
      service.onAgentEvent('file_upload', JOB, upload);
    }
    service.onAgentEvent('session_end');

    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('No print upload seen') && m.includes(JOB))).toBe(true);
    service.stop();
  });

  it('does NOT warn at session_end when a print did arrive', () => {
    const { service } = buildService(buildStore());
    const warnSpy = vi.spyOn(queueLogger, 'warn');

    service.onAgentEvent('file_upload', JOB, REAL_SESSION_UPLOADS[1]);
    service.onAgentEvent('session_end');

    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('No print upload seen'))).toBe(false);
    service.stop();
  });

  it('a print upload with no URL in either field warns instead of enqueuing an empty one', () => {
    const { service, sendPhotoLink } = buildService(buildStore());
    const warnSpy = vi.spyOn(queueLogger, 'warn');

    service.onAgentEvent('file_upload', JOB, { param1: 'x.jpg', param3: 'print', param4: 'Test event' });

    expect(sendPhotoLink).not.toHaveBeenCalled();
    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('carried no URL'))).toBe(true);
    service.stop();
  });

  it('still prefers an explicit photoUrl, so a future Agent that sends one keeps working', () => {
    const { service, sendPhotoLink } = buildService(buildStore());

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
    const { service, sendPhotoLink } = buildService(buildStore());

    service.onAgentEvent('file_upload', JOB, { photoUrl: 'http://example.com/x.jpg' });

    expect(sendPhotoLink).toHaveBeenCalledWith(JOB, 'http://example.com/x.jpg');
    service.stop();
  });
});
