import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueService, queueLogger } from '../src/queue/queueService';
import type { LocalStore } from '../src/state/localStore';

// AGT-04/D-14: all ten named event types (plus anything the booth invents
// later) must reach onAgentEvent() without throwing. Five keep their real
// behavior (07-01 adds processing_start/printing to the pre-existing
// session_start/session_end/file_upload trio) — the other five, and anything
// unnamed, fall through to a single debug-level log line rather than
// silence. LOG_LEVEL=error in the test environment means a real transport
// never emits debug, so the spy on queueLogger.debug intercepts the call
// before Winston's level filter applies (see test/db-poller.test.ts's header
// for the analogous mocking caveat with require()). Never getStore(), never
// DisplayServer — mocked LocalStore only, per 03-VALIDATION.md.

const CONFIG = { SESSION_TIMEOUT_MS: 300_000, NEXT_GUEST_COUNTDOWN_MS: 5_000, SESSION_MAX_RETRIES: 2 };

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
const HANDLED = ['session_start', 'session_end', 'file_upload', 'processing_start', 'printing'];
const FIVE_UNHANDLED = ALL_TEN.filter((t) => !HANDLED.includes(t));

function buildStore() {
  const completedJobId = 'job-x';
  const updateJobStatus = vi.fn();
  const completeJob = vi.fn(() => true);
  let booth = 'BUSY';
  let currentJobId: string | undefined = completedJobId;
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
    updateJobStatus,
    getQueuedGuestSummaries: () => [],
    getQueueLength: () => 0,
    completeJob,
    getQueuePosition: () => undefined,
    getJobRegistration: () => undefined,
  } as unknown as LocalStore;
  return { store, updateJobStatus, completeJob, getBooth: () => booth };
}

describe('QueueService.onAgentEvent — all ten AGT-04 event types reach a defined outcome (AGT-04, D-14)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('delivering all ten named event types produces exactly five fallback log lines and does not throw', () => {
    const { store } = buildStore();
    const service = new QueueService(store, CONFIG);
    const debugSpy = vi.spyOn(queueLogger, 'debug');

    expect(() => {
      for (const eventType of ALL_TEN) {
        service.onAgentEvent(eventType, 'job-x', { photoUrl: 'http://example.com/x.jpg' });
      }
    }).not.toThrow();

    expect(debugSpy).toHaveBeenCalledTimes(FIVE_UNHANDLED.length);
    service.stop();
  });

  it('each of the five fallback lines names the event type that produced it', () => {
    const { store } = buildStore();
    const service = new QueueService(store, CONFIG);
    const debugSpy = vi.spyOn(queueLogger, 'debug');

    for (const eventType of FIVE_UNHANDLED) {
      service.onAgentEvent(eventType, 'job-x');
    }

    const messages = debugSpy.mock.calls.map((call) => String(call[0]));
    for (const eventType of FIVE_UNHANDLED) {
      expect(messages.some((m) => m.includes(eventType))).toBe(true);
    }
    service.stop();
  });

  it('an event type nobody has named also produces a fallback line rather than being dropped', () => {
    const { store } = buildStore();
    const service = new QueueService(store, CONFIG);
    const debugSpy = vi.spyOn(queueLogger, 'debug');

    expect(() => service.onAgentEvent('future_event_xyz', 'job-x')).not.toThrow();

    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(String(debugSpy.mock.calls[0][0])).toContain('future_event_xyz');
    service.stop();
  });

  it('session_end still releases the booth through the real handler, not the fallback (D-02: it no longer completes anything)', () => {
    const { store, completeJob, getBooth } = buildStore();
    const service = new QueueService(store, CONFIG);
    const debugSpy = vi.spyOn(queueLogger, 'debug');

    service.onAgentEvent('session_end');

    expect(getBooth()).toBe('IDLE');
    expect(completeJob).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
    service.stop();
  });

  it('processing_start still completes the in-flight job through the real handler, not the fallback', () => {
    const { store, completeJob } = buildStore();
    const service = new QueueService(store, CONFIG);
    const debugSpy = vi.spyOn(queueLogger, 'debug');

    service.onAgentEvent('processing_start', 'job-x', { param5: 'C:\\dslrBooth\\Test_event\\Prints\\composite.jpg' });

    expect(completeJob).toHaveBeenCalledWith('job-x', expect.any(Number));
    expect(debugSpy).not.toHaveBeenCalled();
    service.stop();
  });

  it('session_start still writes in_progress through the real handler, not the fallback', () => {
    const { store, updateJobStatus } = buildStore();
    const service = new QueueService(store, CONFIG);
    const debugSpy = vi.spyOn(queueLogger, 'debug');

    service.onAgentEvent('session_start', 'job-x');

    expect(updateJobStatus).toHaveBeenCalledWith('job-x', 'in_progress', 'acknowledged_at', expect.any(Number));
    expect(debugSpy).not.toHaveBeenCalled();
    service.stop();
  });

  it('file_upload still reaches the notification service through the real handler, not the fallback', async () => {
    const { store } = buildStore();
    const service = new QueueService(store, CONFIG);
    const sendPhotoLink = vi.fn().mockResolvedValue(undefined);
    service.bindNotificationService({ sendPhotoLink });
    const debugSpy = vi.spyOn(queueLogger, 'debug');

    service.onAgentEvent('file_upload', 'job-x', { photoUrl: 'http://example.com/x.jpg' });
    await Promise.resolve(); // let the fire-and-forget async sendNotification settle

    expect(sendPhotoLink).toHaveBeenCalledWith('job-x', 'http://example.com/x.jpg');
    expect(debugSpy).not.toHaveBeenCalled();
    service.stop();
  });
});
