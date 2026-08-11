import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
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
