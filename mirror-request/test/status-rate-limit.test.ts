import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import express from 'express';
import request from 'supertest';
import { LocalStore } from '../src/state/localStore';
import { createStatusRouter, type StatusQueue, type StatusAgent } from '../src/status/statusRoute';
import {
  createRateLimitState,
  checkRateLimit,
  pruneExpired,
  createStatusRateLimiter,
  RATE_LIMITED_STATUS,
  RATE_LIMITED_BODY,
} from '../src/security/rateLimiter';

const OPTS = { windowMs: 60_000, max: 30 };

describe('checkRateLimit — pure fixed-window decision (D-10)', () => {
  it('allows requests 1..max and refuses request max+1, read from opts.max rather than a hard-coded literal', () => {
    const state = createRateLimitState();
    let last: { limited: boolean; count: number } = { limited: true, count: -1 };

    for (let i = 1; i <= OPTS.max; i++) {
      last = checkRateLimit('client-a', 0, state, OPTS);
      expect(last.limited).toBe(false);
      expect(last.count).toBe(i);
    }

    const overLimit = checkRateLimit('client-a', 0, state, OPTS);
    expect(overLimit.limited).toBe(true);
    expect(overLimit.count).toBe(OPTS.max + 1);
  });

  it('resets exactly at the window boundary — allowed again at now - windowStart === windowMs', () => {
    const state = createRateLimitState();
    for (let i = 0; i < OPTS.max; i++) checkRateLimit('client-b', 0, state, OPTS);
    // The map is now saturated: the next request at time 0 would be refused.
    const stillInWindow = checkRateLimit('client-b', 0, state, OPTS);
    expect(stillInWindow.limited).toBe(true);

    const atBoundary = checkRateLimit('client-b', OPTS.windowMs, state, OPTS);
    expect(atBoundary.limited).toBe(false);
    expect(atBoundary.count).toBe(1);
  });

  it('is still refused one millisecond before the boundary', () => {
    const state = createRateLimitState();
    for (let i = 0; i < OPTS.max; i++) checkRateLimit('client-c', 0, state, OPTS);

    const justBefore = checkRateLimit('client-c', OPTS.windowMs - 1, state, OPTS);
    expect(justBefore.limited).toBe(true);
  });

  it('gives two distinct keys two fully independent budgets', () => {
    const state = createRateLimitState();
    for (let i = 0; i < OPTS.max; i++) {
      expect(checkRateLimit('key-1', 0, state, OPTS).limited).toBe(false);
    }
    // key-1 is now saturated, but key-2 has never been seen.
    expect(checkRateLimit('key-1', 0, state, OPTS).limited).toBe(true);
    expect(checkRateLimit('key-2', 0, state, OPTS).limited).toBe(false);
  });

  it('reads Date.now nowhere in its own source — proven by inspecting toString(), not by grep', () => {
    expect(checkRateLimit.toString()).not.toContain('Date.now');
  });
});

describe('pruneExpired — bounded state under key-rotation pressure (T-06-06)', () => {
  it('removes only closed windows, and returns the count removed, when the map is under maxKeys', () => {
    const state = createRateLimitState();
    checkRateLimit('closed-1', 0, state, OPTS); // window closes by time 100
    checkRateLimit('closed-2', 10, state, OPTS); // window closes by time 100
    checkRateLimit('open-1', 90, state, OPTS); // still open at time 100

    const removed = pruneExpired(state, 50 + OPTS.windowMs, OPTS.windowMs, 10_000);

    // Recompute expectation directly: at time 50 + windowMs, closed-1's
    // window (start 0) and closed-2's window (start 10) have both closed
    // (50+windowMs - 0 >= windowMs, 50+windowMs - 10 >= windowMs), while
    // open-1's window (start 90) has NOT (50+windowMs - 90 < windowMs).
    expect(removed).toBe(2);
    expect(state.entries.has('closed-1')).toBe(false);
    expect(state.entries.has('closed-2')).toBe(false);
    expect(state.entries.has('open-1')).toBe(true);
  });

  it('evicts oldest-windowStart entries first, bringing the map to exactly maxKeys when it is over', () => {
    const state = createRateLimitState();
    // All windows opened at the same instant, so none are "closed" relative
    // to `now` below — every eviction here must come from the capacity pass.
    for (let i = 0; i < 5; i++) {
      checkRateLimit(`k${i}`, i, state, OPTS); // windowStart = i, ascending
    }

    const removed = pruneExpired(state, 5, OPTS.windowMs, 3);

    expect(removed).toBe(2);
    expect(state.entries.size).toBe(3);
    // k0 and k1 have the oldest windowStart (0 and 1) — they go first.
    expect(state.entries.has('k0')).toBe(false);
    expect(state.entries.has('k1')).toBe(false);
    expect(state.entries.has('k2')).toBe(true);
    expect(state.entries.has('k3')).toBe(true);
    expect(state.entries.has('k4')).toBe(true);
  });
});

describe('createStatusRateLimiter — Express middleware factory, bounded memory under rotation', () => {
  function fakeReqRes(ip: string): {
    req: { ip: string; socket: { remoteAddress?: string } };
    res: { statusCode?: number; body?: unknown; status: (n: number) => any; json: (b: unknown) => any };
    calledNext: { value: boolean };
  } {
    const res: any = {};
    res.status = (n: number) => {
      res.statusCode = n;
      return res;
    };
    res.json = (b: unknown) => {
      res.body = b;
      return res;
    };
    const calledNext = { value: false };
    return { req: { ip, socket: {} }, res, calledNext };
  }

  it('pushes maxKeys * 2 distinct keys through the middleware and keeps state.entries.size <= maxKeys', () => {
    const maxKeys = 50;
    const state = createRateLimitState();
    const limiter = createStatusRateLimiter({
      windowMs: 60_000,
      max: 30,
      maxKeys,
      state,
      now: () => 0,
    });

    for (let i = 0; i < maxKeys * 2; i++) {
      const { req, res, calledNext } = fakeReqRes(`10.0.0.${i}`);
      limiter(req as any, res as any, () => {
        calledNext.value = true;
      });
      expect(state.entries.size).toBeLessThanOrEqual(maxKeys);
    }
  });

  it('falls back to a shared "unknown" bucket rather than throwing when the derived address is empty', () => {
    const state = createRateLimitState();
    const limiter = createStatusRateLimiter({ windowMs: 60_000, max: 30, maxKeys: 10, state, now: () => 0 });
    const { req, res, calledNext } = fakeReqRes('');
    expect(() =>
      limiter(req as any, res as any, () => {
        calledNext.value = true;
      }),
    ).not.toThrow();
    expect(state.entries.has('unknown')).toBe(true);
    expect(calledNext.value).toBe(true);
  });

  it('responds with the fixed RATE_LIMITED_STATUS/RATE_LIMITED_BODY shape and does not call next() once limited', () => {
    const state = createRateLimitState();
    const max = 2;
    const limiter = createStatusRateLimiter({ windowMs: 60_000, max, maxKeys: 10, state, now: () => 0 });

    let lastRes: any;
    let lastCalledNext = { value: false };
    for (let i = 0; i < max + 1; i++) {
      const { req, res, calledNext } = fakeReqRes('10.0.0.1');
      lastRes = res;
      lastCalledNext = calledNext;
      limiter(req as any, res as any, () => {
        calledNext.value = true;
      });
    }

    expect(lastRes.statusCode).toBe(RATE_LIMITED_STATUS);
    expect(lastRes.body).toEqual(RATE_LIMITED_BODY);
    expect(lastCalledNext.value).toBe(false);
  });
});

describe('GET /status/:jobId — the limiter mounted ahead of the lookup (D-10, T-06-01/T-06-02)', () => {
  // Per `test/status-api.test.ts`'s own convention: a unique file directly
  // under `./data/` so it matches the `data/*.sqlite` .gitignore rule, and
  // the store is constructed/closed explicitly rather than via getStore(),
  // so this file cannot join WINDOWS.md ledger item 4's shared-test-DB race.
  const DB_PATH = `./data/test-status-rate-limit-${process.pid}-${Date.now()}.sqlite`;
  let store: LocalStore;

  const REAL_JOB_ID = `job-throttle-real-${process.pid}`;
  const FAKE_JOB_ID = `job-throttle-fake-${process.pid}`; // never seeded, on purpose

  const queueStub: StatusQueue = {
    getQueuePosition: (jobId: string) => (jobId === REAL_JOB_ID ? 1 : undefined),
    getQueueLength: () => 1,
    getAnnouncement: () => null,
  };
  const agentStub: StatusAgent = { isAgentOnline: () => true };

  // Built per-case, per the plan's "Building it inside the factory ... is
  // what lets a test create a fresh router per case without leaking counts
  // between them" — every test below calls this rather than sharing one app.
  function buildApp(max: number): express.Express {
    const app = express();
    app.use(
      createStatusRouter(store, queueStub, agentStub, {
        WAIT_ESTIMATE_SAMPLE_SIZE: 20,
        WAIT_ESTIMATE_MIN_SAMPLES: 5,
        WAIT_ESTIMATE_DEFAULT_MS: 180_000,
        STATUS_RATE_LIMIT_WINDOW_MS: 60_000,
        STATUS_RATE_LIMIT_MAX: max,
        STATUS_RATE_LIMIT_MAX_KEYS: 10_000,
      }),
    );
    return app;
  }

  beforeAll(() => {
    store = new LocalStore(DB_PATH);
    store.upsertRegistration({
      id: REAL_JOB_ID,
      name: 'Throttle Test Guest',
      email: `${REAL_JOB_ID}@example.com`,
      phone: '0900000000',
      mode: 'print',
      registered_at: new Date().toISOString(),
    });
    store.enqueueJob({ id: REAL_JOB_ID, queued_at: Date.now() });
  });

  afterAll(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(`${DB_PATH}${suffix}`);
      } catch {
        // Already gone — fine.
      }
    }
  });

  it('throttles the (max+1)th request from one client with the fixed 429 body', async () => {
    const max = 3;
    const app = buildApp(max);

    for (let i = 0; i < max; i++) {
      const allowed = await request(app).get(`/status/${REAL_JOB_ID}`);
      expect(allowed.status).not.toBe(RATE_LIMITED_STATUS);
    }

    const throttled = await request(app).get(`/status/${REAL_JOB_ID}`);
    expect(throttled.status).toBe(RATE_LIMITED_STATUS);
    expect(Object.keys(throttled.body)).toEqual(['error']);
    expect(throttled.body).toEqual(RATE_LIMITED_BODY);
  });

  it('produces the identical throttled response for a real id and a fabricated id — compared to each other, not to a literal', async () => {
    const appReal = buildApp(1);
    await request(appReal).get(`/status/${REAL_JOB_ID}`); // consumes the one allowed request
    const throttledReal = await request(appReal).get(`/status/${REAL_JOB_ID}`);

    const appFake = buildApp(1);
    await request(appFake).get(`/status/${FAKE_JOB_ID}`); // consumes the one allowed request
    const throttledFake = await request(appFake).get(`/status/${FAKE_JOB_ID}`);

    expect({ status: throttledReal.status, body: throttledReal.body }).toEqual({
      status: throttledFake.status,
      body: throttledFake.body,
    });
  });

  it('never reaches the store on a throttled request — a call-count spy on store.getJob, not a timing measurement', async () => {
    const app = buildApp(1);
    const spy = vi.spyOn(store, 'getJob');

    await request(app).get(`/status/${REAL_JOB_ID}`); // allowed — must call store.getJob
    const callsAfterAllowed = spy.mock.calls.length;
    expect(callsAfterAllowed).toBeGreaterThan(0);

    const throttled = await request(app).get(`/status/${REAL_JOB_ID}`); // throttled
    expect(throttled.status).toBe(RATE_LIMITED_STATUS);
    expect(spy.mock.calls.length).toBe(callsAfterAllowed); // zero additional calls

    spy.mockRestore();
  });

  it('under the limit, an existing job still returns its unchanged 8-key body, byte-for-byte', async () => {
    const app = buildApp(1000);
    const res = await request(app).get(`/status/${REAL_JOB_ID}`);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(
      [
        'boothPaused',
        'guestName',
        'jobId',
        'photoDelivery',
        'queueLength',
        'queuePosition',
        'status',
        'waitEstimate',
      ].sort(),
    );
    expect(res.body.jobId).toBe(REAL_JOB_ID);
    expect(res.body.status).toBe('waiting');
  });

  it('under the limit, an unknown id still returns the generic 404, unchanged', async () => {
    const app = buildApp(1000);
    const res = await request(app).get(`/status/${FAKE_JOB_ID}`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'job not found' });
  });

  it('a fresh router carries no rate-limit state from a prior, fully-throttled case', async () => {
    const throttledApp = buildApp(1);
    await request(throttledApp).get(`/status/${REAL_JOB_ID}`);
    const throttled = await request(throttledApp).get(`/status/${REAL_JOB_ID}`);
    expect(throttled.status).toBe(RATE_LIMITED_STATUS);

    // A brand-new createStatusRouter() call builds a brand-new limiter Map
    // (createStatusRateLimiter is constructed inside the factory, not at
    // module scope) — this request must NOT still be throttled just because
    // the previous app instance's budget was exhausted.
    const freshApp = buildApp(1);
    const res = await request(freshApp).get(`/status/${REAL_JOB_ID}`);
    expect(res.status).not.toBe(RATE_LIMITED_STATUS);
  });
});
