import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { LocalStore } from '../src/state/localStore';
import { QueueService } from '../src/queue/queueService';
import { createStatusRouter } from '../src/status/statusRoute';

// A unique database file directly under ./data/ so it matches the
// `data/*.sqlite` .gitignore rule (that glob does not cross a directory
// separator, so a mkdtemp subdirectory would NOT be ignored). The store is
// constructed explicitly and closed in afterAll; getStore() is never called,
// so this file cannot join WINDOWS.md ledger item 4's shared-test-DB race
// across parallel vitest workers.
const DB_PATH = `./data/test-status-api-${process.pid}-${Date.now()}.sqlite`;
const DB_PATH_404 = `./data/test-status-404-${process.pid}-${Date.now()}.sqlite`;

/**
 * D-08's single generic 404, asserted in exactly one place. Every 404 case in
 * this file goes through this helper — the same shape `expectForbidden` gives
 * Phase 1's generic 403 (test/on-register-auth.test.ts:73-77) — so a future
 * `reason`, `code`, `hint` or `detail` field cannot be added to one branch
 * without every other branch's assertion failing at the same moment.
 *
 * The exact-keys form is the load-bearing part. A status-code-only assertion
 * would pass while the body grew an enumeration oracle.
 */
function expectGenericNotFound(res: request.Response): void {
  expect(res.status).toBe(404);
  expect(Object.keys(res.body)).toEqual(['error']);
  expect(res.body.error).toBe('job not found');
}

const SESSION_MS = 240_000;
const GUEST_NAME = 'Nguyễn Văn A';

// Operator vocabulary from Phases 2-4. D-11: none of these may cross the
// boundary into a guest-facing response body, at any depth.
const OPERATOR_WORDS = [
  'dispatched',
  'in_progress',
  'stall_reason',
  'retries',
  'ack_error_message',
  'TIMEOUT_RESET',
  'ANNOUNCING',
  'BUSY',
];

describe('GET /status/:jobId — a queued guest sees their name, position and a real wait range', () => {
  let store: LocalStore;
  let app: express.Express;
  const queuedJobId = `job-status-queued-${process.pid}`;

  function seedRegistration(id: string, name: string): void {
    store.upsertRegistration({
      id,
      name,
      email: `${id}@example.com`,
      phone: '0900000000',
      mode: 'print',
      registered_at: new Date().toISOString(),
    });
  }

  // Drives a job through the real production write path — enqueue, acknowledge,
  // complete — rather than INSERTing a row shaped like the result. That is what
  // makes the resulting `completed_at - acknowledged_at` pair real evidence
  // about the query under test instead of evidence about the fixture.
  function seedCompletedJob(id: string, acknowledgedAt: number, durationMs: number): void {
    seedRegistration(id, `Completed ${id}`);
    store.enqueueJob({ id, queued_at: acknowledgedAt - 1000 });
    store.updateJobStatus(id, 'in_progress', 'acknowledged_at', acknowledgedAt);
    const completedId = store.completeInProgressJob(acknowledgedAt + durationMs);
    if (completedId !== id) {
      throw new Error(`fixture broken: completeInProgressJob() completed ${completedId}, expected ${id}`);
    }
  }

  beforeAll(() => {
    store = new LocalStore(DB_PATH);

    // Five real completed sessions, each exactly SESSION_MS long, so the
    // median of the sample is SESSION_MS and the sample size sits exactly at
    // WAIT_ESTIMATE_MIN_SAMPLES (5) — the side of D-04's boundary where the
    // computed median wins over the configured default.
    const base = 1_700_000_000_000;
    for (let i = 0; i < 5; i += 1) {
      seedCompletedJob(`job-status-done-${i}`, base + i * 1_000_000, SESSION_MS);
    }

    // A session still running: acknowledged, never completed. Its elapsed time
    // is not a session duration and must not enter the sample (D-02).
    seedRegistration('job-status-running', 'Running Guest');
    store.enqueueJob({ id: 'job-status-running', queued_at: base + 6_000_000 });
    store.updateJobStatus('job-status-running', 'in_progress', 'acknowledged_at', base + 6_000_000);

    // A job that exhausted Phase 2's retry budget. It measures the fault, not
    // the booth, and must not enter the sample (D-02).
    seedRegistration('job-status-failed', 'Failed Guest');
    store.enqueueJob({ id: 'job-status-failed', queued_at: base + 7_000_000 });
    store.updateJobStatus('job-status-failed', 'in_progress', 'acknowledged_at', base + 7_000_000);
    store.failJob('job-status-failed', 'session_ack_timeout');

    // The guest under test: the only queued job, so their position is 1.
    seedRegistration(queuedJobId, GUEST_NAME);
    store.enqueueJob({ id: queuedJobId, queued_at: base + 8_000_000 });

    // A session is running right now, which is what puts one guest ahead of
    // the position-1 guest who is not themselves in the queued set.
    store.setBoothBusy();

    // A real QueueService over the same ephemeral store, never start()ed — no
    // timers, no dispatch, no Agent. Phase 5 reads Phase 2's state only.
    const queue = new QueueService(store, {
      SESSION_TIMEOUT_MS: 300_000,
      NEXT_GUEST_COUNTDOWN_MS: 7_000,
      SESSION_MAX_RETRIES: 2,
    });
    const agent = { isAgentOnline: () => true };

    app = express();
    app.use(
      createStatusRouter(store, queue, agent, {
        WAIT_ESTIMATE_SAMPLE_SIZE: 20,
        WAIT_ESTIMATE_MIN_SAMPLES: 5,
        WAIT_ESTIMATE_DEFAULT_MS: 180_000,
        // D-10: generous on purpose — this file exercises Phase 5's
        // wait-estimate/404 behaviour, not the limiter (that is
        // status-rate-limit.test.ts's job), so the threshold must stay well
        // above anything this file's fixtures issue.
        STATUS_RATE_LIMIT_WINDOW_MS: 60_000,
        STATUS_RATE_LIMIT_MAX: 1000,
        STATUS_RATE_LIMIT_MAX_KEYS: 10_000,
      }),
    );
  });

  afterAll(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${DB_PATH}${suffix}`, { force: true });
    }
  });

  // D-02 stated as a measurement rather than as a claim: the store holds five
  // completed jobs, one in_progress job and one failed job, and exactly the
  // five completed ones reach the sample. If the WHERE clause ever loosened,
  // this count changes before any estimate does.
  it('the duration sample contains only the five completed sessions — not the running or failed ones', () => {
    const durations = store.getRecentSessionDurationsMs(20);
    expect(durations).toHaveLength(5);
    expect(durations).toEqual([SESSION_MS, SESSION_MS, SESSION_MS, SESSION_MS, SESSION_MS]);
  });

  it('returns exactly the eight guest-facing keys — nothing missing, nothing extra', async () => {
    const res = await request(app).get(`/status/${queuedJobId}`);

    expect(res.status).toBe(200);
    // Exact-keys form, not toMatchObject: a field silently disappearing AND a
    // PII field silently appearing must both fail here. A 2xx proves nothing.
    expect(Object.keys(res.body).sort()).toEqual([
      'boothPaused',
      'guestName',
      'jobId',
      'photoDelivery',
      'queueLength',
      'queuePosition',
      'status',
      'waitEstimate',
    ]);
  });

  it('carries the guest real registered name — the field that is null in production today', async () => {
    const res = await request(app).get(`/status/${queuedJobId}`);

    expect(res.body.guestName).toBe(GUEST_NAME);
    expect(res.body.jobId).toBe(queuedJobId);
    expect(res.body.queuePosition).toBe(1);
    expect(res.body.queueLength).toBe(1);
    expect(res.body.status).toBe('waiting');
    expect(res.body.boothPaused).toBe(false);
    expect(res.body.photoDelivery).toBe('pending');
  });

  // Arithmetic written out: median 240000 ms, guestsAhead (1 - 1) + 1 = 1
  // because the booth is BUSY, so point = 240000 * 1 = 240000 ms;
  // 240000 / 60000 = 4.0 exactly; Math.ceil(4.0) = 4, so high is 4 and NOT 5 —
  // the round-up rule must not push a whole minute to the next one. low = 3.
  it('reports a whole-minute range of 3-4 minutes for one 240000 ms session ahead', async () => {
    const res = await request(app).get(`/status/${queuedJobId}`);

    expect(res.body.waitEstimate).toEqual({ lowMinutes: 3, highMinutes: 4 });
  });

  it('leaks no operator vocabulary anywhere in the serialized body', async () => {
    const res = await request(app).get(`/status/${queuedJobId}`);
    const serialized = JSON.stringify(res.body);

    for (const word of OPERATOR_WORDS) {
      expect(serialized).not.toContain(word);
    }
  });
});

const EIGHT_KEYS = [
  'boothPaused',
  'guestName',
  'jobId',
  'photoDelivery',
  'queueLength',
  'queuePosition',
  'status',
  'waitEstimate',
];

// The suppressed contract: the same body minus waitEstimate entirely. D-05's
// guarantee lives in the KEY'S ABSENCE, so this list is one shorter rather
// than the eight-key list with a null in it.
const SEVEN_KEYS = EIGHT_KEYS.filter((k) => k !== 'waitEstimate');

const DB_PATH_SUPPRESS = `./data/test-status-suppress-${process.pid}-${Date.now()}.sqlite`;

describe('GET /status/:jobId — every miss collapses into one indistinguishable 404 (D-08)', () => {
  let store: LocalStore;
  let app: express.Express;

  const ownJobId = `job-404-own-${process.pid}`;
  const foreignJobId = `job-404-foreign-${process.pid}`;
  const purgedJobId = `job-404-purged-${process.pid}`;
  const neverExistedId = `job-404-never-existed-${process.pid}`;

  // Four-plus distinct malformed shapes, written as the literal request path so
  // the encoding under test is the one actually sent on the wire.
  const MALFORMED_PATHS: Array<[string, string]> = [
    ['path traversal', `/status/${encodeURIComponent('../../etc/passwd')}`],
    ['SQL injection payload', `/status/${encodeURIComponent("' OR '1'='1")}`],
    ['1000-character id', `/status/${'a'.repeat(1000)}`],
    ['percent-encoded slash', '/status/abc%2Fdef'],
    ['single space', '/status/%20'],
    ['percent-encoded null byte', '/status/job%00id'],
  ];

  function seedRegistration(id: string, name: string): void {
    store.upsertRegistration({
      id,
      name,
      email: `${id}@example.com`,
      phone: '0900000000',
      mode: 'print',
      registered_at: new Date().toISOString(),
    });
  }

  beforeAll(() => {
    store = new LocalStore(DB_PATH_404);

    const base = 1_700_000_000_000;
    seedRegistration(ownJobId, 'Own Guest');
    store.enqueueJob({ id: ownJobId, queued_at: base });

    seedRegistration(foreignJobId, 'Foreign Guest');
    store.enqueueJob({ id: foreignJobId, queued_at: base + 1000 });

    // A job that really existed and was then removed from queue_job, so the
    // "purged" case is a genuine purge rather than a second never-existed id.
    // LocalStore exposes no delete, so the row is removed over an independent
    // connection to the same ephemeral test file. This is the throwaway test
    // SQLite, never the real backend database.
    seedRegistration(purgedJobId, 'Purged Guest');
    store.enqueueJob({ id: purgedJobId, queued_at: base + 2000 });

    const queue = new QueueService(store, {
      SESSION_TIMEOUT_MS: 300_000,
      NEXT_GUEST_COUNTDOWN_MS: 7_000,
      SESSION_MAX_RETRIES: 2,
    });
    const agent = { isAgentOnline: () => true };

    app = express();
    app.use(
      createStatusRouter(store, queue, agent, {
        WAIT_ESTIMATE_SAMPLE_SIZE: 20,
        WAIT_ESTIMATE_MIN_SAMPLES: 5,
        WAIT_ESTIMATE_DEFAULT_MS: 180_000,
        // D-10: generous on purpose — this file exercises Phase 5's
        // wait-estimate/404 behaviour, not the limiter (that is
        // status-rate-limit.test.ts's job), so the threshold must stay well
        // above anything this file's fixtures issue.
        STATUS_RATE_LIMIT_WINDOW_MS: 60_000,
        STATUS_RATE_LIMIT_MAX: 1000,
        STATUS_RATE_LIMIT_MAX_KEYS: 10_000,
      }),
    );

    const side = new Database(DB_PATH_404);
    side.prepare('DELETE FROM queue_job WHERE id = ?').run(purgedJobId);
    side.close();

    // The purge is verified rather than assumed: if this row were still
    // present, the "purged" case below would silently degrade into a second
    // copy of the happy path and prove nothing.
    if (store.getJob(purgedJobId) !== undefined) {
      throw new Error('fixture broken: purged job is still present in queue_job');
    }
  });

  afterAll(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${DB_PATH_404}${suffix}`, { force: true });
    }
  });

  it('returns the generic 404 for an id that never existed', async () => {
    expectGenericNotFound(await request(app).get(`/status/${neverExistedId}`));
  });

  it('returns the generic 404 for an id that existed and was purged', async () => {
    expectGenericNotFound(await request(app).get(`/status/${purgedJobId}`));
  });

  // The core D-08 assertion: not merely "both are 404", but "both are the same
  // answer". A caller who can tell a purged id from a never-existed one has an
  // oracle that confirms which guests were real.
  it('answers the purged and never-existed ids byte-identically', async () => {
    const purged = await request(app).get(`/status/${purgedJobId}`);
    const never = await request(app).get(`/status/${neverExistedId}`);

    expect(purged.status).toEqual(never.status);
    expect(purged.body).toEqual(never.body);
    expect(JSON.stringify(purged.body)).toEqual(JSON.stringify(never.body));
  });

  it.each(MALFORMED_PATHS)(
    'returns the generic 404 — never 400, 422 or 500 — for a malformed id (%s)',
    async (_label, path) => {
      expectGenericNotFound(await request(app).get(path));
    },
  );

  it('answers every malformed id identically to a well-formed-but-absent id', async () => {
    const absent = await request(app).get(`/status/${neverExistedId}`);

    for (const [label, path] of MALFORMED_PATHS) {
      const res = await request(app).get(path);
      expect(res.status, label).toEqual(absent.status);
      expect(res.body, label).toEqual(absent.body);
    }
  });

  // D-06 + D-08 read together. D-08 forbids distinguishing FAILURE cases from
  // one another; it does not turn a valid id into a failure. Under the
  // capability-URL model, holding the id IS the authorisation, so a real id
  // must succeed no matter who is asking — there is no "other guest" concept
  // for the route to enforce.
  it('returns 200 with the full eight-key body for a valid id belonging to another guest', async () => {
    const res = await request(app).get(`/status/${foreignJobId}`);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(EIGHT_KEYS);
    expect(res.body.jobId).toBe(foreignJobId);
    expect(res.body.guestName).toBe('Foreign Guest');
    expect(res.body.status).toBe('waiting');
  });

  it('still returns 200 for the requesting guest own id', async () => {
    const res = await request(app).get(`/status/${ownJobId}`);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(EIGHT_KEYS);
  });

  // Without a catch-all, an unexpected throw becomes Express's default 500 —
  // and a 500 on some ids while others 404 is exactly the oracle D-08 exists
  // to close, rebuilt by accident.
  it('collapses an unexpected internal throw into the same generic 404, not a 500', async () => {
    const throwingQueue = {
      getQueuePosition(): number | undefined {
        throw new Error('simulated internal failure');
      },
      getQueueLength: () => 0,
      getAnnouncement: () => null,
    };

    const throwingApp = express();
    throwingApp.use(
      createStatusRouter(store, throwingQueue, { isAgentOnline: () => true }, {
        WAIT_ESTIMATE_SAMPLE_SIZE: 20,
        WAIT_ESTIMATE_MIN_SAMPLES: 5,
        WAIT_ESTIMATE_DEFAULT_MS: 180_000,
        // D-10: generous on purpose — this file exercises Phase 5's
        // wait-estimate/404 behaviour, not the limiter (that is
        // status-rate-limit.test.ts's job), so the threshold must stay well
        // above anything this file's fixtures issue.
        STATUS_RATE_LIMIT_WINDOW_MS: 60_000,
        STATUS_RATE_LIMIT_MAX: 1000,
        STATUS_RATE_LIMIT_MAX_KEYS: 10_000,
      }),
    );

    const res = await request(throwingApp).get(`/status/${ownJobId}`);

    expectGenericNotFound(res);
    expect(res.status).not.toBe(500);
  });

  it('never answers with 400, 410, 422 or 500 on any path exercised here', async () => {
    const paths = [
      `/status/${neverExistedId}`,
      `/status/${purgedJobId}`,
      `/status/${ownJobId}`,
      `/status/${foreignJobId}`,
      ...MALFORMED_PATHS.map(([, path]) => path),
    ];

    let checked = 0;
    for (const path of paths) {
      const res = await request(app).get(path);
      expect([400, 410, 422, 500], `path ${path} returned ${res.status}`)
        .not.toContain(res.status);
      expect([200, 404]).toContain(res.status);
      checked += 1;
    }

    expect(checked).toBe(10);
  });
});

describe('GET /status/:jobId — the estimate is suppressed rather than fabricated (D-05)', () => {
  let store: LocalStore;
  let queue: QueueService;

  const queuedJobId = `job-sup-queued-${process.pid}`;
  const inProgressJobId = `job-sup-in-progress-${process.pid}`;
  const completedJobId = `job-sup-completed-${process.pid}`;
  const failedJobId = `job-sup-failed-${process.pid}`;

  function seedRegistration(id: string, name: string): void {
    store.upsertRegistration({
      id,
      name,
      email: `${id}@example.com`,
      phone: '0900000000',
      mode: 'print',
      registered_at: new Date().toISOString(),
    });
  }

  // Built per-test so the Agent verdict is an injected stub, never a poke at
  // AgentServer's heartbeat internals: Phase 5 reads Phase 3's verdict, it does
  // not reach into the watchdog that produces it.
  function appWith(agentOnline: boolean): express.Express {
    const app = express();
    app.use(
      createStatusRouter(store, queue, { isAgentOnline: () => agentOnline }, {
        WAIT_ESTIMATE_SAMPLE_SIZE: 20,
        WAIT_ESTIMATE_MIN_SAMPLES: 5,
        WAIT_ESTIMATE_DEFAULT_MS: 180_000,
        // D-10: generous on purpose — this file exercises Phase 5's
        // wait-estimate/404 behaviour, not the limiter (that is
        // status-rate-limit.test.ts's job), so the threshold must stay well
        // above anything this file's fixtures issue.
        STATUS_RATE_LIMIT_WINDOW_MS: 60_000,
        STATUS_RATE_LIMIT_MAX: 1000,
        STATUS_RATE_LIMIT_MAX_KEYS: 10_000,
      }),
    );
    return app;
  }

  function expectSuppressed(body: Record<string, unknown>): void {
    expect(Object.keys(body).sort()).toEqual(SEVEN_KEYS);
    // Asserted separately and deliberately: `in` is what distinguishes an
    // ABSENT key from a key present with the value undefined or null. A
    // toEqual on the key list alone would pass for `waitEstimate: null`,
    // which is exactly the shape D-05 forbids — a client would render it as
    // "0 phút", a promise of no wait at all.
    expect('waitEstimate' in body).toBe(false);
  }

  beforeAll(() => {
    store = new LocalStore(DB_PATH_SUPPRESS);

    const base = 1_700_000_000_000;

    // Completed first, while it is the only in_progress row, so
    // completeInProgressJob() cannot pick up a different job.
    seedRegistration(completedJobId, 'Completed Guest');
    store.enqueueJob({ id: completedJobId, queued_at: base });
    store.updateJobStatus(completedJobId, 'in_progress', 'acknowledged_at', base + 1000);
    store.completeInProgressJob(base + 241_000);

    seedRegistration(failedJobId, 'Failed Guest');
    store.enqueueJob({ id: failedJobId, queued_at: base + 2000 });
    store.updateJobStatus(failedJobId, 'in_progress', 'acknowledged_at', base + 3000);
    store.failJob(failedJobId, 'session_ack_timeout');

    seedRegistration(inProgressJobId, 'In Session Guest');
    store.enqueueJob({ id: inProgressJobId, queued_at: base + 4000 });
    store.updateJobStatus(inProgressJobId, 'in_progress', 'acknowledged_at', base + 5000);

    seedRegistration(queuedJobId, 'Waiting Guest');
    store.enqueueJob({ id: queuedJobId, queued_at: base + 6000 });

    queue = new QueueService(store, {
      SESSION_TIMEOUT_MS: 300_000,
      NEXT_GUEST_COUNTDOWN_MS: 7_000,
      SESSION_MAX_RETRIES: 2,
    });

    // The fixture really is in the states it claims to be in — otherwise a
    // "suppressed" assertion could be passing for the wrong reason.
    expect(store.getJob(queuedJobId)?.status).toBe('queued');
    expect(store.getJob(inProgressJobId)?.status).toBe('in_progress');
    expect(store.getJob(completedJobId)?.status).toBe('completed');
    expect(store.getJob(failedJobId)?.status).toBe('failed');
  });

  beforeEach(() => {
    store.setBoothIdle();
  });

  afterAll(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${DB_PATH_SUPPRESS}${suffix}`, { force: true });
    }
  });

  // M3 success criterion 5 — "No heartbeat 30s → Agent offline in status API" —
  // surviving the field rename from `agentOnline` to `boothPaused`. The status
  // API still reflects an offline Agent; it now says so in guest vocabulary.
  it('emits no waitEstimate key at all and reports the booth paused when the Agent is offline', async () => {
    const res = await request(appWith(false)).get(`/status/${queuedJobId}`);

    expect(res.status).toBe(200);
    expectSuppressed(res.body);
    expect(res.body.boothPaused).toBe(true);
    expect(res.body.status).toBe('waiting');
  });

  // D-05's second trigger. NOTE: this state is currently unreachable in
  // production — LocalStore.setBoothTimeout() writes 'IDLE', not
  // 'TIMEOUT_RESET' — so the row is driven here through setBoothState()
  // directly. The branch is implemented and pinned anyway, per D-05's wording;
  // fixing setBoothTimeout() is a change to Phase 2's booth state machine and
  // is out of Phase 5's bounds.
  it('emits no waitEstimate key when the booth is persisted in the reset state', async () => {
    store.setBoothState('TIMEOUT_RESET');

    const res = await request(appWith(true)).get(`/status/${queuedJobId}`);

    expect(res.status).toBe(200);
    expectSuppressed(res.body);
    expect(res.body.boothPaused).toBe(true);
  });

  it('still returns the full eight-key body when the Agent is online and the booth is normal', async () => {
    const res = await request(appWith(true)).get(`/status/${queuedJobId}`);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(EIGHT_KEYS);
    expect('waitEstimate' in res.body).toBe(true);
    expect(res.body.boothPaused).toBe(false);
    expect(res.body.status).toBe('waiting');
  });

  // Only a guest who is actually waiting gets a wait estimate. A guest already
  // in the booth, finished, or sent to staff has nothing left to wait for, and
  // a number on their screen would be meaningless rather than merely wrong.
  it.each([
    ['in_progress', () => inProgressJobId, 'in_session'],
    ['completed', () => completedJobId, 'finished_photo_pending'],
    ['failed', () => failedJobId, 'see_staff'],
  ])(
    'emits no waitEstimate and a null queuePosition for a %s job even with the booth healthy',
    async (_label, jobIdOf, expectedStatus) => {
      const res = await request(appWith(true)).get(`/status/${jobIdOf()}`);

      expect(res.status).toBe(200);
      expectSuppressed(res.body);
      expect(res.body.queuePosition).toBeNull();
      expect(res.body.boothPaused).toBe(false);
      expect(res.body.status).toBe(expectedStatus);
    },
  );

  // D-12's headline consequence, asserted where a guest would actually meet it:
  // a job that exhausted the retry budget hands back no position and no
  // estimate, so there is nothing on screen inviting the guest to keep polling.
  it('never hands a failed job a queue position or an estimate to keep polling', async () => {
    const res = await request(appWith(true)).get(`/status/${failedJobId}`);

    expect(res.body.status).toBe('see_staff');
    expect(res.body.queuePosition).toBeNull();
    expect('waitEstimate' in res.body).toBe(false);
  });

  it('leaks no operator vocabulary in any suppressed response', async () => {
    const cases: Array<[string, express.Express, string]> = [
      ['agent offline', appWith(false), queuedJobId],
      ['booth reset', appWith(true), queuedJobId],
      ['in_progress', appWith(true), inProgressJobId],
      ['completed', appWith(true), completedJobId],
      ['failed', appWith(true), failedJobId],
    ];

    let checked = 0;
    for (const [label, theApp, jobId] of cases) {
      if (label === 'booth reset') store.setBoothState('TIMEOUT_RESET');
      else store.setBoothIdle();

      const res = await request(theApp).get(`/status/${jobId}`);
      const serialized = JSON.stringify(res.body);

      for (const word of OPERATOR_WORDS) {
        expect(serialized, `${label} leaked "${word}"`).not.toContain(word);
      }
      checked += 1;
    }

    expect(checked).toBe(5);
  });
});
