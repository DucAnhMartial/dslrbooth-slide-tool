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
 *
 * D11-05/D11-06 (phase 11): the pending-print registry's own expiry sweep and
 * the job's finalize gate (grace door included) are now two INDEPENDENT
 * timers on two different things (11-RESEARCH.md's own words). `RETAKE_GRACE_MS`
 * is deliberately set far longer than this file's own `EXPIRY_MS` in every
 * case except the one dedicated to proving that independence, so the
 * pre-existing registry-only assertions below keep testing the registry's
 * own sweep in isolation, undisturbed by a grace door firing first.
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
  // Deliberately far longer than any advance in this file except the
  // dedicated independence case below (which overrides it explicitly), so an
  // unapproved job's grace door never fires first and masks the registry's
  // own sweep behaviour.
  RETAKE_GRACE_MS: EXPIRY_MS * 20,
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
  let attemptOpen = false;
  let attemptNo = 0;
  const jobStatus: Record<string, string> = { [JOB]: 'queued' };
  const { registry, rows } = createPendingPrintRegistry();
  const store = {
    getBoothState: () => booth,
    getBoothStateDetailed: () => ({ state: booth, updated_at: new Date().toISOString() }),
    getInFlightJobs: () => [],
    getNextQueuedJob: () => (jobStatus[JOB] === 'queued' ? { id: JOB } : undefined),
    setBoothState: (s: string) => { booth = s; currentJobId = undefined; attemptOpen = false; attemptNo = 0; },
    setBoothBusy: (jobId?: string | null) => { booth = 'BUSY'; currentJobId = jobId ?? undefined; attemptOpen = false; attemptNo = 0; },
    setBoothIdle: () => { booth = 'IDLE'; currentJobId = undefined; attemptOpen = false; attemptNo = 0; },
    setBoothTimeout: () => { booth = 'IDLE'; currentJobId = undefined; attemptOpen = false; attemptNo = 0; },
    getBoothCurrentJobId: () => currentJobId,
    setBoothCurrentJob: (jobId: string | null) => { currentJobId = jobId ?? undefined; },
    getBoothAttempt: () => ({ attemptOpen, attemptNo }),
    openBoothAttempt: () => { attemptOpen = true; attemptNo += 1; return { attemptOpen, attemptNo }; },
    closeBoothAttempt: () => { attemptOpen = false; },
    getJob: (id: string) => (id in jobStatus ? { id, status: jobStatus[id] } : undefined),
    updateJobStatus: (id: string, status: string) => { jobStatus[id] = status; },
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
    getQueueLength: () => 0,
    getQueuePosition: () => 1,
    getJobRegistration: (jobId: string) => ({
      job: { id: jobId },
      registration: { id: 'reg-1', name: 'Guest One', email: '', phone: '', mode: 'boomerang', registered_at: '' },
    }),
    requeueWithRetry: vi.fn(),
    requeueNoRetry: vi.fn(),
    failJob: vi.fn(),
    // Phase 8 plan 08-02: a resolved print upload also writes photo history
    // (D-10). Configured as a normal service — active event present — so the
    // "zero warnings on a good session" assertion below stays a statement
    // about the code rather than about a half-configured fixture.
    getActiveEventId: () => 'evt-fixture',
    recordEventPhoto: vi.fn(() => true),
    ...registry,
    ...NO_PHOTO_SWEEP_STUB,
  } as unknown as LocalStore;
  return { store, rows, jobStatus, getBooth: () => booth };
}

function buildService(store: LocalStore, config: typeof CONFIG = CONFIG) {
  const sendPhotoLink = vi.fn(async () => {});
  const service = new QueueService(store, config);
  service.bindSendCommand(() => {});
  service.bindAnnouncement(() => {});
  service.bindNotificationService({ sendPhotoLink });
  return { service, sendPhotoLink };
}

/**
 * Drive the booth through a real session, through the real dispatch path
 * rather than by poking the store: IDLE -> ANNOUNCING -> dispatched -> BUSY,
 * then session_start, then the print composite that opens the pending-print
 * slot (D11-02: it does NOT complete the job any more).
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

describe('pending-print registry expiry — the No print upload seen warning that finally means something (SC-4, D11-05/D11-06 independence)', () => {
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
    service.onAgentEvent('session_end'); // unapproved — opens grace (RETAKE_GRACE_MS is far longer than EXPIRY_MS here)

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
  // D11-02/D11-05: completion now requires the approving printing too, not
  // just the composite and the upload — added here, matching the measured
  // auto-print-OFF ordering (07-EVIDENCE §D: processing_start -> upload ->
  // printing -> session_end).
  it('a full successful session — including the approving printing — produces zero warnings, including after the expiry has elapsed', () => {
    vi.useFakeTimers();
    const { store, rows } = buildStore();
    const { service, sendPhotoLink } = buildService(store);
    const warnSpy = vi.spyOn(queueLogger, 'warn');
    service.start();

    runSessionToComposite(service);
    service.onAgentEvent('file_upload', JOB, PRINT_UPLOAD);
    service.onAgentEvent('printing', JOB, { param1: COMPOSITE }); // D11-05 door 1: finalizes, releases immediately
    service.onAgentEvent('session_end'); // already resolved — immediate-release branch, no grace

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
    const config = { ...CONFIG, BOOTH_RELEASE_TIMEOUT_MS: EXPIRY_MS * 2, SESSION_TIMEOUT_MS: EXPIRY_MS * 2 };
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

  // D11-05/D11-06: the pending-print expiry sweep and the job's own finalize
  // gate (the grace door included) are two independent timers on two
  // different things. This is the case that proves it directly, with a grace
  // window shorter than the registry's own expiry.
  it('a grace expiry that finalizes an unapproved job does not by itself mark the pending-print slot expired — the registry sweep and the finalize gate are independent', () => {
    vi.useFakeTimers();
    const graceMs = 5_000; // deliberately shorter than EXPIRY_MS (307000)
    const config = { ...CONFIG, RETAKE_GRACE_MS: graceMs };
    const { store, rows, jobStatus } = buildStore();
    const { service } = buildService(store, config);
    const warnSpy = vi.spyOn(queueLogger, 'warn');
    service.start();

    runSessionToComposite(service); // opens the slot, status 'awaiting'
    service.onAgentEvent('session_end'); // unapproved — opens grace
    vi.advanceTimersByTime(graceMs);

    // Grace's own door finalized the job — no URL was ever written, so it
    // closes no_photo — but it did NOT mark the pending-print slot
    // 'expired': that is the registry's OWN sweep's job.
    expect(jobStatus[JOB]).toBe('no_photo');
    expect(rows.get(JOB)?.status).toBe('resolved');
    expect(rows.get(JOB)?.approvedBy).toBe('grace');
    expect(noPrintWarns(warnSpy)).toHaveLength(0); // the registry's own window has not elapsed yet

    // The registry's own (much longer) expiry window elapses afterward. Its
    // sweep predicate only matches 'awaiting' rows, and this one is already
    // 'resolved' — so it warns ZERO times, proving the two timers really are
    // independent rather than merely both eventually firing on the same row.
    vi.advanceTimersByTime(EXPIRY_MS);
    expect(noPrintWarns(warnSpy)).toHaveLength(0);

    service.stop();
  });
});
