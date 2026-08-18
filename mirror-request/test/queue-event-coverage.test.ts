import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueService, queueLogger } from '../src/queue/queueService';
import type { LocalStore } from '../src/state/localStore';
import { createPendingPrintRegistry } from './helpers/pendingPrintRegistry';
import { NO_PHOTO_SWEEP_STUB } from './helpers/noPhotoSweep';
import { REAL_SESSION_UPLOADS, REAL_PRINT_UPLOAD, ALL_FOTOSHARE_URLS } from './helpers/realSessionUploads';

// AGT-04 / D-12 / D-13. THE CONTRACT CHANGED IN 07-05, and this header changed
// with it.
//
// Until this plan, five of the ten named event types kept a real handler and
// the other five — plus anything unnamed — fell into a single `debug`
// "Unhandled Agent event" line. Of the ten types AGT-04 lists, an operator
// running at the default `info` level could see exactly two, and the retake
// sequence this whole phase was built to survive was invisible in production.
//
// Now EVERY event produces exactly one `info` line, emitted unconditionally as
// the first statement of onAgentEvent() — above the branch chain, so no early
// return inside a handler can swallow it (D-12). The `debug` catch-all is gone
// entirely; a test asserting on `queueLogger.debug` for event dispatch would be
// asserting on removed behaviour.
//
// D11-07 (phase 11): the composite extraction AGT-04 pins is no longer a
// hardcoded `param5`. 07-EVIDENCE conclusion 12 measured the composite's
// position is layout-dependent — param5 on the 4-shot layout (§A), param2 on
// the 1-shot layout (§C/§D) — so `extractCompositePath()` scans for the last
// param whose value points into `\Prints\`, falling back to the
// highest-indexed non-empty param if none matches. This file now pins all
// three shapes, not just the one hardcoded index.
//
// D11-02/D11-04 (phase 11): the two obsolete cases the research breakage
// table names ("processing_start still completes the in-flight job",
// "file_upload still reaches the notification service") are INVERTED below —
// both assumptions are now categorically false. Completion and delivery both
// moved to the one finalize gate (D11-05), reached only through an approving
// `printing`, a grace expiry, or an operator release.
//
// Two things the assertions here deliberately do NOT do:
//   - They never count total `queueLogger.info` calls. The real handlers emit
//     their own info lines ("Completed job ...", "Released booth ...") and 07-05
//     Task 2 adds a summary line, so a total-call count would be a tripwire on
//     unrelated work. Every count filters on the dispatch line's leading token.
//   - They never hard-code the fotoshare URL they search for. It is read from
//     the shared real-session fixture, so an assertion cannot keep passing
//     against a URL the service no longer emits.
//
// LOG_LEVEL=error in the test environment means a real transport never emits
// info, so the spy on queueLogger intercepts the call before Winston's level
// filter applies (see test/db-poller.test.ts's header for the analogous mocking
// caveat with require()). Never getStore(), never DisplayServer — mocked
// LocalStore only, per 03-VALIDATION.md.

const CONFIG = {
  SESSION_TIMEOUT_MS: 300_000,
  NEXT_GUEST_COUNTDOWN_MS: 5_000,
  SESSION_MAX_RETRIES: 2,
  BOOTH_RELEASE_TIMEOUT_MS: 120_000,
  RETAKE_GRACE_MS: 20_000,
};

/** The leading token every per-event dispatch line carries (D-12). */
const EVENT_LINE = 'Agent event ';

const ALL_TEN = [
  'countdown_start',
  'countdown',
  'capture_start',
  'session_start',
  'file_download',
  'processing_start',
  'file_upload',
  'sharing_screen',
  'printing',
  'session_end',
];

/** Only the dispatch lines, in emission order. */
function eventLines(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((call) => String(call[0])).filter((m) => m.startsWith(EVENT_LINE));
}

// `null` rather than `undefined` for "the booth holds no job": passing
// `undefined` to an optional parameter re-triggers its default, so an
// `undefined` default would silently hand back a booth bound to 'job-x' and the
// no-current-job case would assert nothing.
function buildStore(boundJobId: string | null = 'job-x') {
  const updateJobStatus = vi.fn();
  const completeJob = vi.fn(() => true);
  const closeJobNoPhotoFn = vi.fn(() => true);
  let booth = 'BUSY';
  let currentJobId: string | undefined = boundJobId ?? undefined;
  // Deliberately false/0 even when a job is bound: this represents "just
  // dispatched, no attempt opened yet" — the real state setBoothBusy() leaves
  // — so a bare session_start in these fixtures takes the NORMAL sessionAcked()
  // path rather than being misread as a retake (which requires attemptNo>=1).
  // Cases needing an attempt already open (printing/file_upload finalize
  // tests) call session_start first to open it legitimately.
  let attemptOpen = false;
  let attemptNo = 0;
  const { registry, rows } = createPendingPrintRegistry();
  const store = {
    getBoothState: () => booth,
    getBoothStateDetailed: () => ({ state: booth, updated_at: new Date().toISOString() }),
    getInFlightJobs: () => [],
    getNextQueuedJob: () => undefined,
    setBoothState: (s: string) => {
      booth = s;
      currentJobId = undefined;
      attemptOpen = false;
      attemptNo = 0;
    },
    setBoothBusy: (jobId?: string | null) => {
      booth = 'BUSY';
      currentJobId = jobId ?? undefined;
      attemptOpen = false;
      attemptNo = 0;
    },
    setBoothIdle: () => {
      booth = 'IDLE';
      currentJobId = undefined;
      attemptOpen = false;
      attemptNo = 0;
    },
    setBoothTimeout: () => {
      booth = 'IDLE';
      currentJobId = undefined;
      attemptOpen = false;
      attemptNo = 0;
    },
    getBoothCurrentJobId: () => currentJobId,
    setBoothCurrentJob: (jobId: string | null) => {
      currentJobId = jobId ?? undefined;
    },
    getBoothAttempt: () => ({ attemptOpen, attemptNo }),
    openBoothAttempt: () => { attemptOpen = true; attemptNo += 1; return { attemptOpen, attemptNo }; },
    closeBoothAttempt: () => { attemptOpen = false; },
    getJob: () => undefined,
    updateJobStatus,
    getQueuedGuestSummaries: () => [],
    getQueueLength: () => 0,
    completeJob,
    closeJobNoPhoto: closeJobNoPhotoFn,
    getQueuePosition: () => undefined,
    // tick() sweeps the pending-print registry on every interval and
    // onPrintComposite() opens a slot, so the mocked store must satisfy
    // that part of the real LocalStore surface too. The shared helper is
    // used rather than four inline stubs so the three-status semantics
    // cannot drift away from the SQL they stand in for (07-03).
    ...registry,
    getJobRegistration: () => undefined,
    // Phase 8 plan 08-02: the photo-history write (D-10) reads these. This
    // fixture deliberately keeps getJobRegistration returning undefined —
    // this file is about the logging line, and the no-registration path is a
    // real one — so the history write correctly declines and warns. That warn
    // carries the jobId and no URL, which is exactly what the D-13
    // no-fotoshare-URL-in-logs assertion below requires of it.
    getActiveEventId: () => 'evt-fixture',
    recordEventPhoto: vi.fn(() => true),
    ...NO_PHOTO_SWEEP_STUB,
  } as unknown as LocalStore;
  return { store, rows, updateJobStatus, completeJob, closeJobNoPhoto: closeJobNoPhotoFn, getBooth: () => booth };
}

describe('QueueService.onAgentEvent — one info line per event, unconditionally (AGT-04, D-12)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('delivering all ten named event types produces exactly ten info lines, one per event, and does not throw', () => {
    const { store } = buildStore();
    const service = new QueueService(store, CONFIG);
    const infoSpy = vi.spyOn(queueLogger, 'info');

    expect(() => {
      for (const eventType of ALL_TEN) {
        service.onAgentEvent(eventType, 'job-x', { param3: 'print' });
      }
    }).not.toThrow();

    expect(eventLines(infoSpy)).toHaveLength(ALL_TEN.length);
    service.stop();
  });

  it('each of the ten lines names the event type that produced it', () => {
    const { store } = buildStore();
    const service = new QueueService(store, CONFIG);
    const infoSpy = vi.spyOn(queueLogger, 'info');

    for (const eventType of ALL_TEN) {
      service.onAgentEvent(eventType, 'job-x', { param3: 'print' });
    }

    const lines = eventLines(infoSpy);
    for (const eventType of ALL_TEN) {
      expect(lines.some((m) => m.includes(eventType))).toBe(true);
    }
    service.stop();
  });

  it('an event type nobody has named also produces exactly one info line rather than being dropped', () => {
    const { store } = buildStore();
    const service = new QueueService(store, CONFIG);
    const infoSpy = vi.spyOn(queueLogger, 'info');

    expect(() => service.onAgentEvent('future_event_xyz', 'job-x')).not.toThrow();

    const lines = eventLines(infoSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('future_event_xyz');
    service.stop();
  });

  it('no event type produces a debug line any more — the catch-all this replaced is gone', () => {
    const { store } = buildStore();
    const service = new QueueService(store, CONFIG);
    const debugSpy = vi.spyOn(queueLogger, 'debug');

    for (const eventType of [...ALL_TEN, 'future_event_xyz']) {
      service.onAgentEvent(eventType, 'job-x', { param3: 'print' });
    }

    // onFileUpload() still debug-logs an ignored `original` frame; nothing here
    // sends one, so the dispatch path must be silent at debug.
    expect(debugSpy).not.toHaveBeenCalled();
    service.stop();
  });

  it('the line names the attributed job from booth_state.current_job_id', () => {
    const { store } = buildStore('job-bound');
    const service = new QueueService(store, CONFIG);
    const infoSpy = vi.spyOn(queueLogger, 'info');

    service.onAgentEvent('countdown', 'job-bound');

    expect(eventLines(infoSpy)[0]).toContain('job-bound');
    service.stop();
  });

  it('the line names an explicit token, not an empty gap, when the booth has no current job', () => {
    const { store } = buildStore(null);
    const service = new QueueService(store, CONFIG);
    const infoSpy = vi.spyOn(queueLogger, 'info');

    service.onAgentEvent('countdown', undefined);

    const line = eventLines(infoSpy)[0];
    expect(line).toContain('booth_job=none');
    service.stop();
  });

  it("names BOTH ids, distinguishably, when the event's own jobId differs from the attributed one", () => {
    // The Agent stamps a stale activeJobId on every forwarded event and never
    // clears it, so the two ids disagreeing is the normal shape of a stray
    // event — an operator has to be able to tell which is which.
    const { store } = buildStore('job-a');
    const service = new QueueService(store, CONFIG);
    const infoSpy = vi.spyOn(queueLogger, 'info');

    service.onAgentEvent('sharing_screen', 'job-b');

    const lines = eventLines(infoSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('booth_job=job-a');
    expect(lines[0]).toContain('event_job=job-b');
    service.stop();
  });

  it('omits the event jobId when it agrees with the attributed one, so the ordinary line stays short', () => {
    const { store } = buildStore('job-x');
    const service = new QueueService(store, CONFIG);
    const infoSpy = vi.spyOn(queueLogger, 'info');

    service.onAgentEvent('sharing_screen', 'job-x');

    expect(eventLines(infoSpy)[0]).not.toContain('event_job=');
    service.stop();
  });

  it('processing_start carries the composite path from the shared extractor, and printing carries it from param1', () => {
    const { store } = buildStore();
    const service = new QueueService(store, CONFIG);
    const infoSpy = vi.spyOn(queueLogger, 'info');

    service.onAgentEvent('processing_start', 'job-x', {
      param1: 'C:\\dslrBooth\\Test_event\\Singles\\frame1.jpg',
      param5: 'C:\\dslrBooth\\Test_event\\Prints\\composite.jpg',
    });
    service.onAgentEvent('printing', 'job-x', { param1: 'C:\\dslrBooth\\Test_event\\Prints\\composite.jpg' });

    const lines = eventLines(infoSpy);
    const processingLine = lines.find((m) => m.includes('processing_start'))!;
    const printingLine = lines.find((m) => m.includes('printing'))!;
    expect(processingLine).toContain('Prints\\composite.jpg');
    // param5 is the composite; param1 on processing_start is a single frame and
    // is NOT the lifecycle parameter for that event.
    expect(processingLine).not.toContain('Singles\\frame1.jpg');
    expect(printingLine).toContain('Prints\\composite.jpg');
    service.stop();
  });

  it('file_upload carries only its param3 type, never its path or its URL', () => {
    const { store } = buildStore();
    const service = new QueueService(store, CONFIG);
    const infoSpy = vi.spyOn(queueLogger, 'info');

    service.onAgentEvent('file_upload', 'job-x', REAL_PRINT_UPLOAD);

    const line = eventLines(infoSpy).find((m) => m.includes('file_upload'))!;
    expect(line).toContain('print');
    expect(line).not.toContain(REAL_PRINT_UPLOAD.param2);
    expect(line).not.toContain(REAL_PRINT_UPLOAD.param1);
    service.stop();
  });

  // T-07-20. The fotoshare URL is a capability URL to a real guest's photo:
  // anyone who can read the log can view the photo, and rotated logs keep it for
  // fourteen days. The masking formatters in logging/logger.ts recognise emails
  // and phone numbers and have no concept of a URL, so nothing downstream will
  // catch this — the prohibition has to hold at the call site, which is why the
  // per-event parameter selection is an explicit allow-list rather than a spread
  // of the payload.
  it('D-13: a full real-session replay emits no info or warn line containing any fotoshare URL', () => {
    const { store } = buildStore();
    const service = new QueueService(store, CONFIG);
    const infoSpy = vi.spyOn(queueLogger, 'info');
    const warnSpy = vi.spyOn(queueLogger, 'warn');

    // The real session's whole lifecycle, in the order the booth emitted it.
    service.onAgentEvent('capture_start', 'job-x', {});
    service.onAgentEvent('file_download', 'job-x', { param1: '20260812_143524_363.jpg' });
    service.onAgentEvent('processing_start', 'job-x', { param5: REAL_PRINT_UPLOAD.param1 });
    service.onAgentEvent('sharing_screen', 'job-x', {});
    service.onAgentEvent('printing', 'job-x', { param1: REAL_PRINT_UPLOAD.param1 });
    for (const upload of REAL_SESSION_UPLOADS) {
      service.onAgentEvent('file_upload', 'job-x', upload);
    }
    service.onAgentEvent('session_end');

    const emitted = [...infoSpy.mock.calls, ...warnSpy.mock.calls].map((c) => String(c[0]));
    expect(emitted.length).toBeGreaterThan(0);
    for (const url of ALL_FOTOSHARE_URLS) {
      expect(emitted.some((m) => m.includes(url))).toBe(false);
    }
    service.stop();
  });
});

/**
 * D11-07: `extractCompositePath()` is the ONE shared implementation of "which
 * param is the composite", called from both `agentEventDetail()` (the log
 * line, asserted here) and `onPrintComposite()` (the slot it opens, asserted
 * here too — one extractor serves both, so a fixture that only checked one
 * side could not tell a drift between them apart from a genuine fix). Pinned
 * on all three shapes 07-EVIDENCE measured or implies: the 4-shot layout
 * (composite at param5, conclusion 12 / §A), the 1-shot layout (composite at
 * param2, §C/§D), and the no-`\Prints\`-match fallback (highest-indexed
 * non-empty param).
 */
describe('QueueService — D11-07: processing_start composite extraction, pinned on both measured layouts plus the fallback', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('the measured 4-shot layout (07-EVIDENCE §A): the composite is param5, the LAST param pointing into \\Prints\\, even with four preceding Singles frames', () => {
    const { store, rows } = buildStore();
    const service = new QueueService(store, CONFIG);
    const infoSpy = vi.spyOn(queueLogger, 'info');
    const composite = 'C:\\dslrBooth\\Test_event\\Prints\\20260812_143526_970.jpg';

    // Verbatim from 07-EVIDENCE-dslrbooth-triggers.md §A, 2026-08-12 07:35:26.970.
    service.onAgentEvent('processing_start', 'job-x', {
      param1: 'C:\\dslrBooth\\Test_event\\Singles\\20260812_143505_029.jpg',
      param2: 'C:\\dslrBooth\\Test_event\\Singles\\20260812_143511_466.jpg',
      param3: 'C:\\dslrBooth\\Test_event\\Singles\\20260812_143517_880.jpg',
      param4: 'C:\\dslrBooth\\Test_event\\Singles\\20260812_143524_363.jpg',
      param5: composite,
    });

    const line = eventLines(infoSpy).find((m) => m.includes('processing_start'))!;
    expect(line).toContain(`composite=${composite}`);
    expect(rows.get('job-x')?.compositePath).toBe(composite);
    service.stop();
  });

  it('the measured 1-shot layout (07-EVIDENCE §C/§D): the composite is param2, not a hardcoded param5', () => {
    const { store, rows } = buildStore();
    const service = new QueueService(store, CONFIG);
    const infoSpy = vi.spyOn(queueLogger, 'info');
    const composite = 'C:\\dslrBooth\\Test_event\\Prints\\20260818_101511_776.jpg';

    // Verbatim from 07-EVIDENCE-dslrbooth-triggers.md §D, 2026-08-18 03:15:11.777.
    service.onAgentEvent('processing_start', 'job-x', {
      param1: '20260818_101508_719.jpg',
      param2: composite,
    });

    const line = eventLines(infoSpy).find((m) => m.includes('processing_start'))!;
    expect(line).toContain(`composite=${composite}`);
    expect(rows.get('job-x')?.compositePath).toBe(composite);
    service.stop();
  });

  it('no param points into a \\Prints\\ directory: the highest-indexed non-empty param is taken, never a hardcoded index', () => {
    const { store, rows } = buildStore();
    const service = new QueueService(store, CONFIG);
    const infoSpy = vi.spyOn(queueLogger, 'info');

    service.onAgentEvent('processing_start', 'job-x', {
      param1: 'C:\\dslrBooth\\Test_event\\Singles\\frame1.jpg',
      param2: 'C:\\dslrBooth\\Test_event\\Singles\\frame2.jpg',
      param3: 'C:\\dslrBooth\\Test_event\\Singles\\frame3.jpg',
    });

    const line = eventLines(infoSpy).find((m) => m.includes('processing_start'))!;
    expect(line).toContain('composite=C:\\dslrBooth\\Test_event\\Singles\\frame3.jpg');
    expect(rows.get('job-x')?.compositePath).toBe('C:\\dslrBooth\\Test_event\\Singles\\frame3.jpg');
    service.stop();
  });
});

describe('QueueService.onAgentEvent — the five real handlers are unchanged by the logging line', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('session_end releases the booth immediately once the attempt is already approved (D-02/D11-06); an unapproved one opens grace instead, releasing nothing and completing nothing', () => {
    const { store, rows, completeJob, getBooth } = buildStore();
    const service = new QueueService(store, CONFIG);

    // Unapproved: no pending-print row at all yet. D11-06's grace branch —
    // the booth stays bound, nothing completes, nothing releases.
    service.onAgentEvent('session_end');
    expect(getBooth()).toBe('BUSY');
    expect(completeJob).not.toHaveBeenCalled();

    // Approved: the pending-print row is already 'resolved', exactly as an
    // approving printing's own finalize would have left it — session_end's
    // immediate-release branch, D11-05's own text ("0 giây chờ" — the release
    // already happened at finalize; this session_end finds nothing left to do
    // but release, which it does unconditionally on this branch).
    rows.set('job-x', {
      jobId: 'job-x', compositePath: 'x.jpg', status: 'resolved',
      openedAt: Date.now(), expiresAt: Date.now() + 1_000, approvedBy: 'printing', approvedAt: Date.now(),
    });
    service.onAgentEvent('session_end');

    expect(getBooth()).toBe('IDLE');
    expect(completeJob).not.toHaveBeenCalled(); // completion already happened at printing, not here
    service.stop();
  });

  // D11-02 (phase 11): INVERTED. `processing_start` alone used to complete the
  // in-flight job — that assumption is exactly what this phase retires. It now
  // only opens the pending-print slot; an approving `printing` is what
  // completes it, through the one finalize gate (D11-05).
  it('processing_start opens the pending-print slot but completes nothing; an approving printing is what completes it', () => {
    const { store, rows, completeJob } = buildStore();
    const service = new QueueService(store, CONFIG);
    const composite = 'C:\\dslrBooth\\Test_event\\Prints\\composite.jpg';

    service.onAgentEvent('session_start', 'job-x'); // opens the attempt legitimately
    service.onAgentEvent('processing_start', 'job-x', { param5: composite });

    expect(completeJob).not.toHaveBeenCalled();
    expect(rows.get('job-x')?.compositePath).toBe(composite);
    expect(rows.get('job-x')?.status).toBe('awaiting');

    service.onAgentEvent('file_upload', 'job-x', { param3: 'print', param2: 'https://fotoshare.co/i/xyz' });
    service.onAgentEvent('printing', 'job-x', { param1: composite });
    expect(completeJob).toHaveBeenCalledWith('job-x', expect.any(Number));
    service.stop();
  });

  it('session_start still writes in_progress', () => {
    const { store, updateJobStatus } = buildStore();
    const service = new QueueService(store, CONFIG);

    service.onAgentEvent('session_start', 'job-x');

    expect(updateJobStatus).toHaveBeenCalledWith('job-x', 'in_progress', 'acknowledged_at', expect.any(Number));
    service.stop();
  });

  // D11-04 (phase 11): INVERTED. `file_upload` used to reach the notification
  // service directly — that is exactly the send-on-upload assumption D11-04
  // retires (07-EVIDENCE conclusion 8: every attempt, kept or discarded,
  // produces its own print upload). It now only WRITES the URL into the
  // pending-print slot; an approving printing is what delivers it.
  it('file_upload writes the URL into the pending-print slot but sends nothing directly; an approving printing is what delivers it', async () => {
    const { store, rows } = buildStore();
    const service = new QueueService(store, CONFIG);
    const sendPhotoLink = vi.fn().mockResolvedValue(undefined);
    service.bindNotificationService({ sendPhotoLink });
    const composite = 'C:\\dslrBooth\\Prints\\composite.jpg';

    service.onAgentEvent('session_start', 'job-x'); // opens the attempt legitimately
    // The composite anchor first — delivery is still gated on a pending-print
    // slot being open for the job (D-04/D-07).
    service.onAgentEvent('processing_start', 'job-x', { param5: composite });
    service.onAgentEvent('file_upload', 'job-x', { photoUrl: 'http://example.com/x.jpg' });
    await Promise.resolve(); // let any fire-and-forget async settle

    expect(sendPhotoLink).not.toHaveBeenCalled();
    expect(rows.get('job-x')?.photoUrl).toBe('http://example.com/x.jpg');

    service.onAgentEvent('printing', 'job-x', { param1: composite });
    await Promise.resolve();
    expect(sendPhotoLink).toHaveBeenCalledWith('job-x', 'http://example.com/x.jpg');
    service.stop();
  });
});
