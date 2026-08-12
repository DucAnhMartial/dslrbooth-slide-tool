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

const CONFIG = { SESSION_TIMEOUT_MS: 300_000, NEXT_GUEST_COUNTDOWN_MS: 5_000, SESSION_MAX_RETRIES: 2 };

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
  let booth = 'BUSY';
  let currentJobId: string | undefined = boundJobId ?? undefined;
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
    getJob: () => undefined,
    updateJobStatus,
    getQueuedGuestSummaries: () => [],
    getQueueLength: () => 0,
    completeJob,
    getQueuePosition: () => undefined,
    // tick() sweeps the pending-print registry on every interval and
    // onPrintComposite() opens a slot, so the mocked store must satisfy
    // that part of the real LocalStore surface too. The shared helper is
    // used rather than four inline stubs so the three-status semantics
    // cannot drift away from the SQL they stand in for (07-03).
    ...createPendingPrintRegistry().registry,
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
  return { store, updateJobStatus, completeJob, getBooth: () => booth };
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

  it('processing_start carries the composite path from param5, and printing carries it from param1', () => {
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

describe('QueueService.onAgentEvent — the five real handlers are unchanged by the logging line', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('session_end still releases the booth (D-02: it no longer completes anything)', () => {
    const { store, completeJob, getBooth } = buildStore();
    const service = new QueueService(store, CONFIG);

    service.onAgentEvent('session_end');

    expect(getBooth()).toBe('IDLE');
    expect(completeJob).not.toHaveBeenCalled();
    service.stop();
  });

  it('processing_start still completes the in-flight job', () => {
    const { store, completeJob } = buildStore();
    const service = new QueueService(store, CONFIG);

    service.onAgentEvent('processing_start', 'job-x', { param5: 'C:\\dslrBooth\\Test_event\\Prints\\composite.jpg' });

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

  it('file_upload still reaches the notification service', async () => {
    const { store } = buildStore();
    const service = new QueueService(store, CONFIG);
    const sendPhotoLink = vi.fn().mockResolvedValue(undefined);
    service.bindNotificationService({ sendPhotoLink });

    // The composite anchor first, because since 07-03 delivery is gated on a
    // pending-print slot being open for the job (D-04/D-07) — a print upload
    // no session was awaiting reaches nobody. Driving the real anchor rather
    // than seeding the registry keeps this case a proof of the whole handler
    // path, which is what it is here to assert.
    service.onAgentEvent('processing_start', 'job-x', { param5: 'C:\\dslrBooth\\Prints\\composite.jpg' });
    service.onAgentEvent('file_upload', 'job-x', { photoUrl: 'http://example.com/x.jpg' });
    await Promise.resolve(); // let the fire-and-forget async sendNotification settle

    expect(sendPhotoLink).toHaveBeenCalledWith('job-x', 'http://example.com/x.jpg');
    service.stop();
  });
});
