import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { QueueService, queueLogger } from '../src/queue/queueService';
import type { LocalStore } from '../src/state/localStore';
import { createPendingPrintRegistry, type PendingPrintRow } from './helpers/pendingPrintRegistry';
import { NO_PHOTO_SWEEP_STUB } from './helpers/noPhotoSweep';

/**
 * Task 3 (11-04): no silent branch on the retake/print path (D11-09, SC-5,
 * T-11-17 in this plan's own threat register). Two halves:
 *
 *   - BEHAVIOURAL: one minimal fixture per ignore branch, the logger
 *     captured, asserting the exact count (never zero, never two), the
 *     exact text, that the job id is carried where the branch has one to
 *     carry, and that no line leaks a fotoshare identifier or the upload
 *     URL field.
 *   - STRUCTURAL: reads queueService.ts's own source (comments stripped,
 *     the same technique test/queue-send-site-invariant.test.ts already
 *     established) and asserts every early `return` inside the four
 *     methods that make up the retake/print event surface
 *     (sessionAckedFromEvent, sessionEnded, onPrintComposite, onFileUpload)
 *     is preceded by a `queueLogger.` call in its own enclosing branch — a
 *     property a behavioural sample alone cannot prove, because a future
 *     edit could add a silent branch no existing fixture happens to reach.
 *
 * Two of the nine branches below (`printing ignored: no attempt open` /
 * `printing ignored: composite X is not this attempt's Y`) do NOT carry a
 * job id — this is not an omission, it is D11-03's own LOCKED literal
 * wording (11-CONTEXT.md), verbatim. `session_end received with no job
 * bound...` cannot carry one either, structurally — there is no job to
 * name. Every other branch below does carry one, and this file's own
 * `carries the job id` assertions are scoped to those.
 */

const SOURCE_PATH = path.join(__dirname, '..', 'src', 'queue', 'queueService.ts');

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

const JOB = 'job-ignored';
const OTHER_JOB = 'job-other';
const FOTOSHARE_URL = 'https://fotoshare.co/i/leaktest1';

const CONFIG = {
  SESSION_TIMEOUT_MS: 300_000,
  NEXT_GUEST_COUNTDOWN_MS: 5_000,
  SESSION_MAX_RETRIES: 2,
  BOOTH_RELEASE_TIMEOUT_MS: 120_000,
  RETAKE_GRACE_MS: 20_000,
};

function buildStore(opts: {
  currentJobId?: string;
  attemptOpen?: boolean;
  attemptNo?: number;
  jobStatus?: Record<string, string>;
  pendingSeed?: PendingPrintRow[];
} = {}) {
  let booth: string = opts.currentJobId ? 'BUSY' : 'IDLE';
  let currentJobId: string | undefined = opts.currentJobId;
  let attemptOpen = opts.attemptOpen ?? false;
  let attemptNo = opts.attemptNo ?? 0;
  const jobStatus: Record<string, string> = opts.jobStatus ?? {};
  const jobAcknowledgedAt: Record<string, number> = {};
  const pendingPrint = createPendingPrintRegistry(opts.pendingSeed ?? []);

  const store = {
    getBoothState: () => booth,
    getNextQueuedJob: () => undefined,
    setBoothState: (s: string) => { booth = s; currentJobId = undefined; attemptOpen = false; attemptNo = 0; },
    setBoothBusy: (id?: string | null) => { booth = 'BUSY'; currentJobId = id ?? undefined; attemptOpen = false; attemptNo = 0; },
    setBoothIdle: () => { booth = 'IDLE'; currentJobId = undefined; attemptOpen = false; attemptNo = 0; },
    setBoothTimeout: () => { booth = 'IDLE'; currentJobId = undefined; attemptOpen = false; attemptNo = 0; },
    getBoothCurrentJobId: () => currentJobId,
    setBoothCurrentJob: (id: string | null) => { currentJobId = id ?? undefined; },
    getBoothAttempt: () => ({ attemptOpen, attemptNo }),
    openBoothAttempt: () => { attemptOpen = true; attemptNo += 1; return { attemptOpen, attemptNo }; },
    closeBoothAttempt: () => { attemptOpen = false; },
    getJob: (id: string) => (id in jobStatus ? { id, status: jobStatus[id], acknowledged_at: jobAcknowledgedAt[id] } : undefined),
    updateJobStatus: (id: string, status: string, tsField?: string, tsValue?: number) => {
      jobStatus[id] = status;
      if (tsField === 'acknowledged_at' && tsValue !== undefined) jobAcknowledgedAt[id] = tsValue;
    },
    completeJob: vi.fn((id: string) => {
      if (jobStatus[id] !== 'in_progress') return false;
      jobStatus[id] = 'completed';
      return true;
    }),
    closeJobNoPhoto: vi.fn((id: string) => {
      if (jobStatus[id] !== 'in_progress') return false;
      jobStatus[id] = 'no_photo';
      return true;
    }),
    getQueuedGuestSummaries: () => [],
    getQueueLength: () => 0,
    getQueuePosition: () => undefined,
    getJobRegistration: () => undefined,
    getActiveEventId: () => undefined,
    ...pendingPrint.registry,
    requeueWithRetry: vi.fn(),
    requeueNoRetry: vi.fn(),
    failJob: vi.fn(),
    ...NO_PHOTO_SWEEP_STUB,
  } as unknown as LocalStore;

  return { store, jobStatus, pendingPrintRows: pendingPrint.rows };
}

describe('QueueService — every ignore branch on the retake/print path logs exactly once, never zero, never two (D11-09, SC-5)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('processing_start with no usable composite anywhere in the payload: exactly one warn, naming the job id', () => {
    const { store } = buildStore({ currentJobId: JOB, attemptOpen: true, attemptNo: 1, jobStatus: { [JOB]: 'in_progress' } });
    const service = new QueueService(store, CONFIG);
    const warnSpy = vi.spyOn(queueLogger, 'warn');

    service.onAgentEvent('processing_start', JOB, {});

    const lines = warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('carried no usable composite path'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`processing_start for job ${JOB} carried no usable composite path`);
    expect(lines[0]).toContain(JOB);
    expect(lines[0]).not.toContain('fotoshare');

    service.stop();
  });

  it('processing_start arriving with no job bound to the booth at all: exactly one warn, naming the job id', () => {
    const { store } = buildStore({ currentJobId: undefined });
    const service = new QueueService(store, CONFIG);
    const warnSpy = vi.spyOn(queueLogger, 'warn');

    service.onAgentEvent('processing_start', JOB, { param2: 'C:\\dslrBooth\\Test_event\\Prints\\x.jpg' });

    const lines = warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('arrived with no job bound to the booth'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`processing_start for job ${JOB} arrived with no job bound to the booth`);
    expect(lines[0]).toContain(JOB);

    service.stop();
  });

  it('a jobId mismatch on the print path: exactly one warn naming BOTH ids, throttled to once per episode — a stuck Agent does not produce one line per event', () => {
    const { store } = buildStore({ currentJobId: JOB, attemptOpen: true, attemptNo: 1, jobStatus: { [JOB]: 'in_progress' } });
    const service = new QueueService(store, CONFIG);
    const warnSpy = vi.spyOn(queueLogger, 'warn');

    const mismatchPayload = { param2: 'C:\\dslrBooth\\Test_event\\Prints\\x.jpg' };
    service.onAgentEvent('processing_start', OTHER_JOB, mismatchPayload);
    service.onAgentEvent('processing_start', OTHER_JOB, mismatchPayload);
    service.onAgentEvent('processing_start', OTHER_JOB, mismatchPayload);

    const mismatchLines = warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('does not match'));
    expect(mismatchLines).toHaveLength(1); // three events, ONE line — the throttle
    expect(mismatchLines[0]).toBe(
      `processing_start jobId ${OTHER_JOB} does not match booth_state.current_job_id ${JOB}`,
    );
    expect(mismatchLines[0]).toContain(JOB);
    expect(mismatchLines[0]).toContain(OTHER_JOB);

    // A matching event resets the throttle — the next mismatch warns again.
    service.onAgentEvent('processing_start', JOB, mismatchPayload);
    service.onAgentEvent('processing_start', OTHER_JOB, mismatchPayload);
    const afterReset = warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('does not match'));
    expect(afterReset).toHaveLength(2);

    service.stop();
  });

  it('printing with no attempt open at all: exactly one info line, the LOCKED D11-03 literal wording (no job id — the wording is fixed, not an omission)', () => {
    const { store } = buildStore({ currentJobId: JOB, attemptOpen: false, attemptNo: 0, jobStatus: { [JOB]: 'dispatched' } });
    const service = new QueueService(store, CONFIG);
    const infoSpy = vi.spyOn(queueLogger, 'info');

    service.onAgentEvent('printing', JOB, { param1: 'C:\\dslrBooth\\Test_event\\Prints\\x.jpg', param2: '1', param3: 'DS-RX1' });

    const lines = infoSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('no attempt open'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('printing ignored: no attempt open');
    expect(lines[0]).not.toContain('fotoshare');

    service.stop();
  });

  it('printing whose composite does not match this attempt\'s: exactly one info line naming both paths', () => {
    const HELD = 'C:\\dslrBooth\\Test_event\\Prints\\20260818_110000_000.jpg';
    const REPRINT = 'C:\\dslrBooth\\Test_event\\Prints\\20260818_090000_000.jpg';
    const { store } = buildStore({
      currentJobId: JOB,
      attemptOpen: true,
      attemptNo: 1,
      jobStatus: { [JOB]: 'in_progress' },
      pendingSeed: [{ jobId: JOB, compositePath: HELD, status: 'awaiting', openedAt: Date.now(), expiresAt: Date.now() + 600_000, attemptNo: 1 }],
    });
    const service = new QueueService(store, CONFIG);
    const infoSpy = vi.spyOn(queueLogger, 'info');

    service.onAgentEvent('printing', JOB, { param1: REPRINT, param2: '1', param3: 'DS-RX1' });

    const lines = infoSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("is not this attempt's"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`printing ignored: composite ${REPRINT} is not this attempt's ${HELD}`);
    expect(lines[0]).not.toContain('fotoshare');

    service.stop();
  });

  it('session_end with no job bound to the booth: exactly one info line (no job id — there is none to name)', () => {
    const { store } = buildStore({ currentJobId: undefined });
    const service = new QueueService(store, CONFIG);
    const infoSpy = vi.spyOn(queueLogger, 'info');

    service.onAgentEvent('session_end');

    const lines = infoSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('no job bound to the booth'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('session_end received with no job bound to the booth; ignored');

    service.stop();
  });

  it('a print upload carrying no URL at all: exactly one warn, naming the job id, never the upload URL field itself (there is none)', () => {
    const { store } = buildStore({ currentJobId: JOB, attemptOpen: true, attemptNo: 1, jobStatus: { [JOB]: 'in_progress' } });
    const service = new QueueService(store, CONFIG);
    const warnSpy = vi.spyOn(queueLogger, 'warn');

    service.onAgentEvent('file_upload', JOB, { param3: 'print' });

    const lines = warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('carried no URL'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`Print upload for ${JOB} carried no URL in photoUrl or param2`);
    expect(lines[0]).toContain(JOB);
    expect(lines[0]).not.toContain('fotoshare');
    expect(lines[0]).not.toContain('param2='); // the field NAME is fine in the message; the field's URL VALUE is what must never appear

    service.stop();
  });

  it('a print upload for a job with no pending-print slot ever opened (D-04): exactly one warn, naming the job id, never the URL', () => {
    const { store } = buildStore({ currentJobId: JOB, attemptOpen: true, attemptNo: 1, jobStatus: { [JOB]: 'in_progress' } });
    const service = new QueueService(store, CONFIG);
    const warnSpy = vi.spyOn(queueLogger, 'warn');

    service.onAgentEvent('file_upload', JOB, { param3: 'print', param2: FOTOSHARE_URL });

    const lines = warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('no session was awaiting a print'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`Print upload for ${JOB} dropped: no session was awaiting a print for it`);
    expect(lines[0]).toContain(JOB);
    expect(lines[0]).not.toContain(FOTOSHARE_URL);
    expect(lines[0]).not.toContain('fotoshare');

    service.stop();
  });

  it('a print upload for a slot already finalized WITH a photo already sent (D11-04): exactly one info line — the flagship silent branch this phase closed — naming the job id, never the URL', () => {
    const { store } = buildStore({
      currentJobId: JOB,
      attemptOpen: true,
      attemptNo: 1,
      jobStatus: { [JOB]: 'completed' },
      pendingSeed: [{
        jobId: JOB,
        compositePath: 'C:\\dslrBooth\\Test_event\\Prints\\x.jpg',
        status: 'resolved',
        openedAt: Date.now() - 10_000,
        expiresAt: Date.now() + 600_000,
        attemptNo: 1,
        photoUrl: FOTOSHARE_URL,
        approvedBy: 'printing',
        approvedAt: Date.now() - 5_000,
      }],
    });
    const service = new QueueService(store, CONFIG);
    const sendPhotoLink = vi.fn(async () => {});
    service.bindNotificationService({ sendPhotoLink });
    const infoSpy = vi.spyOn(queueLogger, 'info');

    // A resend of the URL that was already delivered.
    service.onAgentEvent('file_upload', JOB, { param3: 'print', param2: FOTOSHARE_URL });

    const lines = infoSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('already finalized with a photo already sent'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`Print upload for ${JOB} ignored: this attempt was already finalized with a photo already sent`);
    expect(lines[0]).toContain(JOB);
    expect(lines[0]).not.toContain(FOTOSHARE_URL);
    expect(lines[0]).not.toContain('fotoshare');
    expect(sendPhotoLink).not.toHaveBeenCalled(); // no second delivery, matching the no-op

    service.stop();
  });
});

/**
 * The structural half. A behavioural sample can only prove that the current
 * fixtures do not observe a silent branch — it cannot prove a FUTURE edit
 * will not add one that no existing fixture happens to reach. This reads
 * the source directly, following test/queue-send-site-invariant.test.ts's
 * own precedent (comments stripped, so a comment merely mentioning
 * `queueLogger` cannot satisfy the check).
 */
describe('QueueService source invariant — no early return on the retake/print path stands without a logger call in its own branch (D11-09, T-11-17)', () => {
  const rawSource = fs.readFileSync(SOURCE_PATH, 'utf8');
  const source = stripComments(rawSource);

  /**
   * Extracts one method's full body (from its signature's opening `{` to
   * the matching closing `}`), by brace-depth counting — exact, unlike a
   * regex which cannot express "the matching brace" for arbitrary nesting.
   */
  function extractMethodBody(signature: RegExp, label: string): string {
    const match = signature.exec(source);
    if (!match) {
      throw new Error(`${label}: method signature not found in stripped source — has it been renamed?`);
    }
    const openBraceIndex = source.indexOf('{', match.index + match[0].length - 1);
    let depth = 0;
    for (let i = openBraceIndex; i < source.length; i++) {
      const ch = source[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return source.slice(openBraceIndex, i + 1);
      }
    }
    throw new Error(`${label}: unbalanced braces while extracting method body`);
  }

  /**
   * Walks backward from a `return` statement's offset, tracking brace
   * balance, to find the text of its NEAREST enclosing `{...}` block — the
   * branch that return statement actually belongs to, not the whole method.
   */
  function enclosingBranchText(body: string, returnIndex: number): string {
    let depth = 0;
    for (let i = returnIndex; i >= 0; i--) {
      const ch = body[i];
      if (ch === '}') depth++;
      else if (ch === '{') {
        if (depth === 0) return body.slice(i, returnIndex);
        depth--;
      }
    }
    return body.slice(0, returnIndex);
  }

  const METHODS: Array<{ label: string; signature: RegExp }> = [
    { label: 'sessionEnded()', signature: /\bsessionEnded\(\): void \{/ },
    { label: 'sessionAckedFromEvent()', signature: /private sessionAckedFromEvent\(jobId: string\): void \{/ },
    { label: 'onPrintComposite()', signature: /private onPrintComposite\(eventType: string, jobId: string \| undefined, payload: Record<string, unknown>\): void \{/ },
    { label: 'onFileUpload()', signature: /private onFileUpload\(jobId: string, payload: Record<string, unknown>\): void \{/ },
  ];

  it('every early return inside sessionEnded, sessionAckedFromEvent, onPrintComposite and onFileUpload is preceded by a queueLogger call in its own branch', () => {
    let totalReturnsChecked = 0;

    for (const { label, signature } of METHODS) {
      const body = extractMethodBody(signature, label);
      const returnMatches = [...body.matchAll(/\breturn\b[^;{}]*;/g)];
      expect(returnMatches.length, `${label}: expected at least one early return to check`).toBeGreaterThan(0);

      for (const m of returnMatches) {
        const idx = m.index ?? 0;
        const branch = enclosingBranchText(body, idx);
        expect(
          branch.includes('queueLogger.'),
          `${label}: the "${m[0].trim()}" statement is not preceded by a queueLogger call ` +
          `anywhere in its own enclosing branch. A return with no log line is exactly the ` +
          `silent-branch defect this phase (D11-09, T-11-17) was raised to remove — the real ` +
          `photo that was swallowed in production went through a branch with no else and no log.`,
        ).toBe(true);
        totalReturnsChecked++;
      }
    }

    expect(totalReturnsChecked).toBeGreaterThanOrEqual(9); // the nine behavioural branches above, at minimum
  });
});
