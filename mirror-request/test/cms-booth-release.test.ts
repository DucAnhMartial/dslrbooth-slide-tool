import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalStore } from '../src/state/localStore';
import { createCmsIpGate } from '../src/cms/cmsIpGate';
import { createCmsRouter } from '../src/cms/cmsRouter';
import { hashPassword } from '../src/cms/cmsAuth';
import type { CmsBoothLink } from '../src/cms/cmsBoothRoutes';

// ---------------------------------------------------------------------------
// Plan 11-03 Task 3 — D11-08's operator door, proved through the real route
// stack (11-VALIDATION.md row 11-03-T3).
//
// Drives the REAL createCmsRouter chain — the IP gate, the login form, the
// session cookie — the same composition test/cms-agent-config.test.ts and
// test/cms-event-tracer.test.ts use, with a controllable CmsBoothLink stub in
// place of a real QueueService so each case can put the booth in idle, a
// bound job, a wrong-job mismatch, and an already-finished race without a
// real store or a real dslrBooth trigger stream. Both gates below this route
// (the CMS IP allow-list, the session cookie) are the production factories,
// unmodified — this file proves the route inherits them rather than
// re-implementing either.
// ---------------------------------------------------------------------------

const WHITELISTED_IP = '10.0.0.5';
const BLOCKED_IP = '203.0.113.9';
const TEST_USERNAME = 'operator';
const TEST_PASSWORD = 'operator-pass-11';
const CMS_CFG = {
  CMS_USERNAME: TEST_USERNAME,
  CMS_PASSWORD_HASH: hashPassword(TEST_PASSWORD),
  CMS_SESSION_COOKIE_NAME: 'cms_session',
};

const OFFLINE_AGENT = { isAgentOnline: () => false, sendEvent: () => false };
const BOUND_JOB = 'JOB-BOUND-1';

const tmpDirs: string[] = [];
const openStores: LocalStore[] = [];

function makeStore(): LocalStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cms-booth-'));
  tmpDirs.push(dir);
  const store = new LocalStore(path.join(dir, 'test.sqlite'));
  openStores.push(store);
  return store;
}

/**
 * A controllable stand-in for QueueService's CmsBoothLink surface — the same
 * role test/helpers/cmsBoothLink.ts's BOOTH_LINK plays for every OTHER CMS
 * test, except this one drives every branch deliberately rather than always
 * idle-and-refusing.
 *
 * `released` records every jobId releaseForOperator() was called with, in
 * order. The load-bearing assertion for the already-finished case below is
 * that this array has length 1 after one POST, not merely that the response
 * reports the right outcome — a route that first checked, then finalized on
 * a second call, would report the same answer while having reached the
 * write path twice.
 */
function makeBoothLink(
  opts: {
    stall?: { jobId: string; guestName: string; waitingSinceMs: number } | null;
    outcome?: 'released' | 'wrong_job' | 'already_finished';
  } = {},
): CmsBoothLink & { released: string[] } {
  const released: string[] = [];
  return {
    released,
    getBoothStallInfo: () => opts.stall ?? null,
    releaseForOperator: (jobId: string) => {
      released.push(jobId);
      return opts.outcome ?? 'released';
    },
  };
}

interface Harness {
  app: express.Express;
  cookie: string;
  boothLink: ReturnType<typeof makeBoothLink>;
}

function cookiesOf(res: request.Response): string[] {
  const raw = res.headers['set-cookie'];
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

/**
 * The production chain: the IP gate, then the real router (login route,
 * session middleware, the booth routes mounted below it) — the same
 * composition app.ts uses, with `boothLink` standing in for the real
 * QueueService. Logs in for real, exactly the way an operator would.
 */
async function build(boothLink: ReturnType<typeof makeBoothLink> = makeBoothLink()): Promise<Harness> {
  const store = makeStore();
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', { value: WHITELISTED_IP, configurable: true });
    next();
  });
  app.use('/cms', createCmsIpGate([WHITELISTED_IP]), createCmsRouter(store, CMS_CFG, OFFLINE_AGENT, boothLink));

  const res = await request(app)
    .post('/cms/login')
    .type('form')
    .send({ username: TEST_USERNAME, password: TEST_PASSWORD });
  const raw = cookiesOf(res)[0];
  expect(raw, 'login should set a session cookie').toBeTruthy();
  const cookie = raw.split(';')[0];

  return { app, cookie, boothLink };
}

afterEach(() => {
  while (openStores.length) {
    try {
      openStores.pop()?.close();
    } catch {
      /* already closed */
    }
  }
  while (tmpDirs.length) {
    try {
      fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

// ---------------------------------------------------------------------------
// Both existing gates, refusing independently (T-11-10) — no new mechanism
// ---------------------------------------------------------------------------

describe('POST /cms/api/booth/release — both existing gates, unmodified', () => {
  it('refuses an unauthenticated POST with 401', async () => {
    const store = makeStore();
    const app = express();
    app.use((req, _res, next) => {
      Object.defineProperty(req, 'ip', { value: WHITELISTED_IP, configurable: true });
      next();
    });
    app.use('/cms', createCmsIpGate([WHITELISTED_IP]), createCmsRouter(store, CMS_CFG, OFFLINE_AGENT, makeBoothLink()));

    const res = await request(app).post('/cms/api/booth/release').send({ jobId: BOUND_JOB });
    expect(res.status).toBe(401);
  });

  it('refuses a POST from an address outside the CMS allow-list with 403, independently of the session layer', async () => {
    const store = makeStore();
    const app = express();
    app.use((req, _res, next) => {
      Object.defineProperty(req, 'ip', { value: BLOCKED_IP, configurable: true });
      next();
    });
    app.use('/cms', createCmsIpGate([WHITELISTED_IP]), createCmsRouter(store, CMS_CFG, OFFLINE_AGENT, makeBoothLink()));

    // No cookie at all — if the IP gate were not mounted first, this would
    // still be refused (by the session layer instead), and the case would
    // prove nothing about ORDER. The 403 rather than 401 is the load-bearing
    // assertion.
    const res = await request(app).post('/cms/api/booth/release').send({ jobId: BOUND_JOB });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// The all-or-nothing body (T-11-12)
// ---------------------------------------------------------------------------

describe('POST /cms/api/booth/release — the body is validated all-or-nothing', () => {
  it('succeeds for exactly the expected field and finalizes through the operator door', async () => {
    const boothLink = makeBoothLink({ outcome: 'released' });
    const h = await build(boothLink);

    const res = await request(h.app).post('/cms/api/booth/release').set('Cookie', h.cookie).send({ jobId: BOUND_JOB });

    expect(res.status).toBe(200);
    expect(res.body.released).toBe(true);
    // The route reached exactly the one write CmsBoothLink exposes, with the
    // exact jobId the body carried. The operator door itself is
    // QueueService's own gate (plan 11-03 Task 1); this asserts only the
    // interface boundary the route owns.
    expect(boothLink.released).toEqual([BOUND_JOB]);
  });

  it('refuses a body carrying an extra field, wholesale, with 400', async () => {
    const boothLink = makeBoothLink({ outcome: 'released' });
    const h = await build(boothLink);

    const res = await request(h.app)
      .post('/cms/api/booth/release')
      .set('Cookie', h.cookie)
      .send({ jobId: BOUND_JOB, extra: 'anything' });

    expect(res.status).toBe(400);
    // Refused WHOLE: the unexpected field did not get silently dropped
    // while the rest of the request was honoured.
    expect(boothLink.released).toEqual([]);
  });

  it('refuses a missing jobId field with 400', async () => {
    const boothLink = makeBoothLink();
    const h = await build(boothLink);

    const res = await request(h.app).post('/cms/api/booth/release').set('Cookie', h.cookie).send({});

    expect(res.status).toBe(400);
    expect(boothLink.released).toEqual([]);
  });

  it('refuses an empty jobId field with 400', async () => {
    const boothLink = makeBoothLink();
    const h = await build(boothLink);

    const res = await request(h.app).post('/cms/api/booth/release').set('Cookie', h.cookie).send({ jobId: '' });

    expect(res.status).toBe(400);
    expect(boothLink.released).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The two races (D11-05, D11-08) — reported, never double-finalized
// ---------------------------------------------------------------------------

describe('POST /cms/api/booth/release — races are reported, never double-finalized', () => {
  it('refuses a job id that is not the one currently bound, with 409', async () => {
    const boothLink = makeBoothLink({ outcome: 'wrong_job' });
    const h = await build(boothLink);

    const res = await request(h.app)
      .post('/cms/api/booth/release')
      .set('Cookie', h.cookie)
      .send({ jobId: 'SOME-OTHER-JOB' });

    expect(res.status).toBe(409);
    expect(res.body.released).toBeUndefined();
    expect(res.body.error).toBeTruthy();
    expect(boothLink.released).toEqual(['SOME-OTHER-JOB']);
  });

  it('reports already-finished, rather than double-finalizing, for a job that finalized between render and click', async () => {
    const boothLink = makeBoothLink({ outcome: 'already_finished' });
    const h = await build(boothLink);

    const res = await request(h.app).post('/cms/api/booth/release').set('Cookie', h.cookie).send({ jobId: BOUND_JOB });

    expect(res.status).toBe(409);
    expect(res.body.released).toBeUndefined();
    expect(res.body.error).toBeTruthy();
    // The load-bearing half: the route reached the operator door's write
    // EXACTLY ONCE for this POST. The reported answer alone would pass
    // against a route that double-finalized and simply relayed the second
    // call's result — this rules that out.
    expect(boothLink.released).toEqual([BOUND_JOB]);
  });
});

// ---------------------------------------------------------------------------
// GET /cms/booth — the control is a property of the data, not the template
// ---------------------------------------------------------------------------

describe('GET /cms/booth', () => {
  it('renders no control at all while the booth is idle', async () => {
    const h = await build(makeBoothLink({ stall: null }));

    const res = await request(h.app).get('/cms/booth').set('Cookie', h.cookie);

    expect(res.status).toBe(200);
    expect(res.text).not.toContain(BOUND_JOB);
    expect(res.text).not.toContain('releaseForm');
  });

  it('renders the guest and elapsed seconds while the booth is busy', async () => {
    const h = await build(makeBoothLink({ stall: { jobId: BOUND_JOB, guestName: 'Ánh', waitingSinceMs: 12_000 } }));

    const res = await request(h.app).get('/cms/booth').set('Cookie', h.cookie);

    expect(res.status).toBe(200);
    expect(res.text).toContain('Ánh');
    expect(res.text).toContain('12 giây');
    expect(res.text).toContain(BOUND_JOB);
  });

  it('renders the guest and elapsed seconds while the booth is inside a grace window', async () => {
    // getBoothStallInfo()'s own header (Task 1) explains why the interface
    // makes no distinction between "busy with an open attempt" and "inside
    // grace" — the discriminator the CMS needs is "is there a guest to
    // end", not which of the two in-flight states produced that answer. A
    // longer elapsed time here stands in for a stall that has run past the
    // grace window's opening.
    const h = await build(makeBoothLink({ stall: { jobId: BOUND_JOB, guestName: 'Long', waitingSinceMs: 45_000 } }));

    const res = await request(h.app).get('/cms/booth').set('Cookie', h.cookie);

    expect(res.status).toBe(200);
    expect(res.text).toContain('Long');
    expect(res.text).toContain('45 giây');
  });

  it('never renders a guest email or phone number', async () => {
    const h = await build(makeBoothLink({ stall: { jobId: BOUND_JOB, guestName: 'Ánh', waitingSinceMs: 3_000 } }));

    const res = await request(h.app).get('/cms/booth').set('Cookie', h.cookie);

    expect(res.text).not.toMatch(/\S+@\S+\.\S+/);
    expect(res.text).not.toMatch(/\d{9,}/);
  });
});
