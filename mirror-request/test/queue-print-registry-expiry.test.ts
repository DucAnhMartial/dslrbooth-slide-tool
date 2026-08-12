import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueService, queueLogger } from '../src/queue/queueService';
import type { LocalStore } from '../src/state/localStore';
import { createPendingPrintRegistry } from './helpers/pendingPrintRegistry';
import { NO_PHOTO_SWEEP_STUB } from './helpers/noPhotoSweep';

/**
 * SC-4 / WINDOWS item 9, in both directions.
 *
 * Today's code warns `No print upload seen` at `session_end`, and that check
 * cannot be right at that moment: dslrBooth's print upload has no fixed
 * ordering relative to `session_end` — measured 26 seconds BEFORE it on one
 * session in the evidence file, and about one second AFTER it on job
 * `BZWCWFN6`. The result is a warning on every successful session, which
 * trained the operator to ignore the one line that was supposed to mean
 * something.
 *
 * The warning moves to pending-print registry expiry, which is the only anchor
 * that can be correct: it fires when a print genuinely never arrived, after a
 * settle window, and it is silent otherwise. The literal token
 * `No print upload seen` is deliberately unchanged from today's message so an
 * operator's existing greps and the runbook keep working — what changes is
 * WHEN it fires, not what it says.
 *
 * Timing values reach the service through the constructor only (Phase 2's
 * config-injection pattern). `PENDING_PRINT_EXPIRY_MS` is not an environment
 * key and has no runtime toggle (D-12), and no case here touches
 * `process.env`.
 */

/**
 * The smallest injectable expiry: the service clamps to the derived floor
 * `SESSION_TIMEOUT_MS` + `NEXT_GUEST_COUNTDOWN_MS` = 300000 + 7000, below
 * which a legitimately late print could expire before the next guest could
 * physically be dispatched. Asking for less than this on purpose would be
 * asking the service to drop real photos.
 */
const EXPIRY_MS = 307_000;

const CONFIG = {
  SESSION_TIMEOUT_MS: 300_000,
  NEXT_GUEST_COUNTDOWN_MS: 7_000,
  SESSION_MAX_RETRIES: 2,
  BOOTH_RELEASE_TIMEOUT_MS: 120_000,
  PENDING_PRINT_EXPIRY_MS: EXPIRY_MS,
};

const JOB = 'job-1';
/** The composite path measured on the real booth, 2026-08-12 07:35:26. */
const COMPOSITE = 'C:\\dslrBooth\\Test_event\\Prints\\20260812_143526_970.jpg';
const PRINT_UPLOAD = {
  param1: 'C:\\dslrBooth\\Test_event\\Prints\\20260812_143526_970.jpg',
  param2: 'https://fotoshare.co/i/4kmtdhm',
  param3: 'print',
  param4: 'Test event',
};

const NO_PRINT_TOKEN = 'No print upload seen';

function buildStore() {
  let booth = 'IDLE';
  let currentJobId: string | undefined;
  const jobStatus: Record<string, string> = { [JOB]: 'queued' };
  const { registry, rows } = createPendingPrintRegistry();
  const store = {
    getBoothState: () => booth,
    getNextQueuedJob: () => (jobStatus[JOB] === 'queued' ? { id: JOB } : undefined),
    setBoothState: (s: string) => { booth = s; currentJobId = undefined; },
    setBoothBusy: (jobId?: string | null) => { booth = 'BUSY'; currentJobId = jobId ?? undefined; },
    setBoothIdle: () => { booth = 'IDLE'; currentJobId = undefined; },
    setBoothTimeout: () => { booth = 'IDLE'; currentJobId = undefined; },
    getBoothCurrentJobId: () => currentJobId,
    setBoothCurrentJob: (jobId: string | null) => { currentJobId = jobId ?? undefined; },
    getJob: (id: string) => (id in jobStatus ? { id, status: jobStatus[id] } : undefined),
    updateJobStatus: (id: string, status: string) => { jobStatus[id] = status; },
    completeJob: (jobId: string) => {
      if (jobStatus[jobId] !== 'in_progress') return false;
      jobStatus[jobId] = 'completed';
      return true;
    },
    getQueuedGuestSummaries: () => [],
    getQueueLength: () => 0,
    getQueuePosition: () => 1,
    getJobRegistration: (jobId: string) => ({
      job: { id: jobId },
      registration: { id: 'reg-1', name: 'Guest One', email: '', phone: '', mode: 'boomerang', registered_at: '' },
    }),
    requeueWithRetry: vi.fn(),
    requeueNoRetry: vi.fn(),
    failJob: vi.fn(),
    ...registry,
    ...NO_PHOTO_SWEEP_STUB,
  } as unknown as LocalStore;
  return { store, rows, jobStatus, getBooth: () => booth };
}

function buildService(store: LocalStore, config: typeof CONFIG = CONFIG) {
  const sendPhotoLink = vi.fn(async () => {});
  const service = new QueueService(store, config);
  service.bindSendCommand(() => {});
  service.bindNotificationService({ sendPhotoLink });
  return { service, sendPhotoLink };
}

/**
 * Drive the booth through a real session, through the real dispatch path
 * rather than by poking the store: IDLE -> ANNOUNCING -> dispatched -> BUSY,
 * then session_start, then the print composite that both completes the job and
 * opens its pending-print slot.
 */
function runSessionToComposite(service: QueueService): void {
  vi.advanceTimersByTime(250); // one tick: IDLE with a queued guest -> ANNOUNCING
  vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS); // countdown elapses -> dispatch
  service.onAgentEvent('session_start', JOB);
  service.onAgentEvent('processing_start', JOB, { param5: COMPOSITE });
}

function noPrintWarns(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes(NO_PRINT_TOKEN));
}

describe('pending-print registry expiry — the No print upload seen warning that finally means something (SC-4)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a session whose print never arrives warns exactly once, only after the expiry has elapsed, naming the job', () => {
    vi.useFakeTimers();
    const { store, rows } = buildStore();
    const { service } = buildService(store);
    const warnSpy = vi.spyOn(queueLogger, 'warn');
    service.start();

    runSessionToComposite(service);
    service.onAgentEvent('session_end');

    // The moment the old code warned. It must be silent here — this is the
    // half of SC-4 that WINDOWS item 9 recorded as a false positive.
    expect(noPrintWarns(warnSpy)).toHaveLength(0);

    // Still inside the settle window: a print arriving now would be on time,
    // so the service must not have given up on it yet.
    vi.advanceTimersByTime(EXPIRY_MS - 10_000);
    expect(noPrintWarns(warnSpy)).toHaveLength(0);
    expect(rows.get(JOB)?.status).toBe('awaiting');

    vi.advanceTimersByTime(20_000);
    const warns = noPrintWarns(warnSpy);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain(JOB);
    expect(warns[0]).toContain(COMPOSITE);
    expect(rows.get(JOB)?.status).toBe('expired');

    service.stop();
  });

  it('the same job produces no second warning on any later sweep', () => {
    vi.useFakeTimers();
    const { store } = buildStore();
    const { service } = buildService(store);
    const warnSpy = vi.spyOn(queueLogger, 'warn');
    service.start();

    runSessionToComposite(service);
    service.onAgentEvent('session_end');
    vi.advanceTimersByTime(EXPIRY_MS + 1_000);
    expect(noPrintWarns(warnSpy)).toHaveLength(1);

    // Ten further expiry periods — roughly 51 minutes and over 12,000 sweeps.
    // The row was marked in the same transaction that returned it, so it can
    // never be handed back to the warning site again.
    vi.advanceTimersByTime(EXPIRY_MS * 10);
    expect(noPrintWarns(warnSpy)).toHaveLength(1);

    service.stop();
  });

  // THE SC-4 CASE. Today's code warns here, on every single successful
  // session. This assertion is the one that fails against the old binding.
  it('a full successful session produces zero warnings, including after the expiry has elapsed', () => {
    vi.useFakeTimers();
    const { store, rows } = buildStore();
    const { service, sendPhotoLink } = buildService(store);
    const warnSpy = vi.spyOn(queueLogger, 'warn');
    service.start();

    runSessionToComposite(service);
    service.onAgentEvent('file_upload', JOB, PRINT_UPLOAD);
    service.onAgentEvent('session_end');

    expect(sendPhotoLink).toHaveBeenCalledWith(JOB, PRINT_UPLOAD.param2);
    expect(rows.get(JOB)?.status).toBe('resolved');

    vi.advanceTimersByTime(EXPIRY_MS * 3);

    expect(noPrintWarns(warnSpy)).toHaveLength(0);
    // Nothing else warned either — a clean session is a silent session.
    expect(warnSpy).not.toHaveBeenCalled();

    service.stop();
  });

  // The sweep is the FIRST statement of tick(), above its `booth !== 'IDLE'`
  // early return. Placing it after that guard would mean the sweep never runs
  // while a session is in progress — which is precisely the only window in
  // which a slot can be open — so the warning would never fire for a booth
  // that never sees session_end.
  it('the sweep runs while the booth is still BUSY, not only when it is IDLE', () => {
    vi.useFakeTimers();
    // A release fallback longer than the expiry, so the booth is genuinely
    // still BUSY at the moment the sweep has to fire.
    const config = { ...CONFIG, BOOTH_RELEASE_TIMEOUT_MS: EXPIRY_MS * 2 };
    const { store, rows } = buildStore();
    const { service } = buildService(store, config);
    const warnSpy = vi.spyOn(queueLogger, 'warn');
    service.start();

    runSessionToComposite(service);
    // No session_end at all: the guest is still standing at the sharing screen.
    expect(store.getBoothState()).toBe('BUSY');

    vi.advanceTimersByTime(EXPIRY_MS + 1_000);

    expect(store.getBoothState()).toBe('BUSY');
    expect(noPrintWarns(warnSpy)).toHaveLength(1);
    expect(rows.get(JOB)?.status).toBe('expired');

    service.stop();
  });

  it('a sweep that finds nothing writes nothing and logs nothing', () => {
    vi.useFakeTimers();
    const { store, rows } = buildStore();
    const { service } = buildService(store);
    const warnSpy = vi.spyOn(queueLogger, 'warn');
    const infoSpy = vi.spyOn(queueLogger, 'info');
    const expireSpy = vi.spyOn(store, 'expirePendingPrints');
    service.start();

    // No session at all, so no slot is ever opened. The interval still runs.
    vi.advanceTimersByTime(EXPIRY_MS);

    expect(expireSpy).toHaveBeenCalled();
    expect(expireSpy.mock.results.every((r) => Array.isArray(r.value) && r.value.length === 0)).toBe(true);
    expect(rows.size).toBe(0);
    expect(noPrintWarns(warnSpy)).toHaveLength(0);
    expect(infoSpy.mock.calls.map((c) => String(c[0])).some((m) => m.includes('pending-print'))).toBe(false);

    service.stop();
  });
});
