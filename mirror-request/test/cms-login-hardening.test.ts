import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalStore } from '../src/state/localStore';
import { createCmsRouter } from '../src/cms/cmsRouter';
import { createSessionStore, hashPassword, MAX_SESSIONS } from '../src/cms/cmsAuth';

// ---------------------------------------------------------------------------
// Phase 8 code review, WR-01 and WR-02 — the login route's two unbounded
// quantities.
//
// WR-01: POST /cms/login ran safeEqual()/verifyPassword() for every attempt
// with no counter, backoff or lockout. SCRYPT_PARAMS is deliberately N=2^14
// rather than OWASP's 2^17 (a measured constraint — 2^17 exceeds scryptSync's
// 32MB maxmem default and THROWS), which makes each guess cheaper than a
// hardened login would allow. D-13's IP allow-list is the first line, but a
// whitelist entry is commonly a whole venue subnet, and inside it an attacker
// had unlimited online guesses against the single operator credential.
//
// WR-02: the session Map grew by one entry per successful login and was
// pruned only by an explicit /logout.
//
// D-14 SAYS NO AUTO-TIMEOUT, AND THAT STAYS TRUE. An event runs for hours and
// ejecting the operator to a login screen mid-event is operationally worse
// than a lingering session on an IP-allow-listed LAN. So the fix is a SIZE
// CAP and nothing else — no TTL, no inactivity sweep. The last case in the
// WR-02 block pins that: a session minted long ago is still valid after the
// clock moves, and it fails the moment anyone "improves" this into an expiry.
// ---------------------------------------------------------------------------

const WHITELISTED_IP = '10.0.0.5';
const TEST_PASSWORD = 'operator-pass-01';
const LOGIN_MAX = 5;
const LOGIN_WINDOW_MS = 900_000;

const CMS_CFG = {
  CMS_USERNAME: 'operator',
  CMS_PASSWORD_HASH: hashPassword(TEST_PASSWORD),
  CMS_SESSION_COOKIE_NAME: 'cms_session',
  CMS_LOGIN_RATE_LIMIT_WINDOW_MS: LOGIN_WINDOW_MS,
  CMS_LOGIN_RATE_LIMIT_MAX: LOGIN_MAX,
  CMS_LOGIN_RATE_LIMIT_MAX_KEYS: 100,
};
const OFFLINE_AGENT = { isAgentOnline: () => false, sendEvent: () => false };

const tmpDirs: string[] = [];
const openStores: LocalStore[] = [];

function makeStore(): LocalStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cms-login-'));
  tmpDirs.push(dir);
  const store = new LocalStore(path.join(dir, 'test.sqlite'));
  openStores.push(store);
  return store;
}

/** A router with an injected clock, mirroring rateLimiter.ts's own idiom. */
function makeApp(clock: { now: number }): express.Express {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', { value: WHITELISTED_IP, configurable: true });
    next();
  });
  app.use('/cms', createCmsRouter(makeStore(), CMS_CFG, OFFLINE_AGENT, { now: () => clock.now }));
  return app;
}

function attempt(app: express.Express, password: string) {
  return request(app).post('/cms/login').type('form').send({ username: 'operator', password });
}

afterEach(() => {
  vi.useRealTimers();
  while (openStores.length) {
    try {
      openStores.pop()?.close();
    } catch {
      /* already closed */
    }
  }
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('WR-01: POST /cms/login is rate limited per source address', () => {
  it('refuses further attempts once the window budget is spent', async () => {
    const clock = { now: 1_000_000 };
    const app = makeApp(clock);

    for (let i = 0; i < LOGIN_MAX; i += 1) {
      expect((await attempt(app, 'wrong')).status).toBe(401);
    }

    expect((await attempt(app, 'wrong')).status).toBe(429);
  });

  it('a CORRECT password is refused while throttled — the limiter runs before verification', async () => {
    const clock = { now: 1_000_000 };
    const app = makeApp(clock);
    for (let i = 0; i < LOGIN_MAX; i += 1) await attempt(app, 'wrong');

    const withRightPassword = await attempt(app, TEST_PASSWORD);

    // This is the assertion with teeth. A limiter checked AFTER
    // verifyPassword() would let the right credential through and would still
    // pass the case above — and would leave the expensive scrypt work
    // reachable by an unlimited attacker, which is the cost the limiter
    // exists to bound.
    expect(withRightPassword.status).toBe(429);
    expect(withRightPassword.headers['set-cookie']).toBeUndefined();
  });

  it('the throttled refusal does not distinguish a right guess from a wrong one', async () => {
    const clock = { now: 1_000_000 };
    const app = makeApp(clock);
    for (let i = 0; i < LOGIN_MAX; i += 1) await attempt(app, 'wrong');

    const right = await attempt(app, TEST_PASSWORD);
    const wrong = await attempt(app, 'still-wrong');

    expect({ status: right.status, text: right.text }).toEqual({
      status: wrong.status,
      text: wrong.text,
    });
  });

  it('the budget refreshes once the window closes', async () => {
    const clock = { now: 1_000_000 };
    const app = makeApp(clock);
    for (let i = 0; i < LOGIN_MAX; i += 1) await attempt(app, 'wrong');
    expect((await attempt(app, 'wrong')).status).toBe(429);

    clock.now += LOGIN_WINDOW_MS;

    // A lockout an operator cannot wait out is an outage, not a control.
    expect((await attempt(app, TEST_PASSWORD)).status).toBe(303);
  });

  // -------------------------------------------------------------------------
  // Non-vacuity. Both pass BEFORE the fix — they stop it being "refuse
  // everything", which would satisfy every case above.
  // -------------------------------------------------------------------------

  it('an ordinary typo does not lock the operator out', async () => {
    const clock = { now: 1_000_000 };
    const app = makeApp(clock);

    expect((await attempt(app, 'typo')).status).toBe(401);
    expect((await attempt(app, TEST_PASSWORD)).status).toBe(303);
  });

  it('a first-attempt correct login still mints a session cookie', async () => {
    const clock = { now: 1_000_000 };
    const app = makeApp(clock);

    const res = await attempt(app, TEST_PASSWORD);

    expect(res.status).toBe(303);
    expect(res.headers['set-cookie'][0]).toContain('cms_session=');
  });
});

describe('WR-02: the session store is bounded WITHOUT gaining an expiry (D-14)', () => {
  it('evicts the oldest session once the cap is reached', () => {
    const sessions = createSessionStore();
    const first = sessions.create('operator');
    for (let i = 0; i < MAX_SESSIONS - 1; i += 1) sessions.create('operator');
    expect(sessions.size()).toBe(MAX_SESSIONS);

    const newest = sessions.create('operator');

    expect(sessions.size()).toBe(MAX_SESSIONS);
    expect(sessions.isValid(first)).toBe(false);
    expect(sessions.isValid(newest)).toBe(true);
  });

  it('stays at the cap however many logins follow', () => {
    const sessions = createSessionStore();
    for (let i = 0; i < MAX_SESSIONS * 3; i += 1) sessions.create('operator');

    expect(sessions.size()).toBe(MAX_SESSIONS);
  });

  // -------------------------------------------------------------------------
  // Non-vacuity, and one locked-decision guard.
  // -------------------------------------------------------------------------

  it('evicts nothing at all below the cap', () => {
    const sessions = createSessionStore();
    const tokens = Array.from({ length: MAX_SESSIONS }, () => sessions.create('operator'));

    // Every one of them still works. A cap that evicted eagerly would bound
    // memory just as well and would quietly log the operator out.
    expect(tokens.every((t) => sessions.isValid(t))).toBe(true);
  });

  it('D-14: a session does NOT expire with time — only the cap removes one', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T00:00:00Z'));
    const sessions = createSessionStore();
    const token = sessions.create('operator');

    // Three days later, mid-event, the operator must not meet a login screen.
    vi.setSystemTime(new Date('2026-08-16T00:00:00Z'));

    expect(sessions.isValid(token)).toBe(true);
  });
});
