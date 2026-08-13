import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalStore } from '../src/state/localStore';
import { createCmsIpGate } from '../src/cms/cmsIpGate';
import { createCmsRouter } from '../src/cms/cmsRouter';
import { parseCookies, hashPassword } from '../src/cms/cmsAuth';

// ---------------------------------------------------------------------------
// Phase 8 code review, CR-01 — a malformed `Cookie` header must not become a
// 500.
//
// `parseCookies()` decoded every value with `decodeURIComponent` and no
// `try/catch`. `decodeURIComponent('%')` throws `URIError`, and both call
// sites are on the request path: `createRequireSession` guards every
// session-gated CMS route, and `POST /cms/logout` is mounted BEFORE the
// session guard so it needs no session at all. Neither `app.ts` nor
// `index.ts` registers an Express error handler, so the throw reached the
// default `finalhandler` — a 500, and with `NODE_ENV` unset (config.ts
// defaults it to 'development') a 500 carrying a stack trace and absolute
// filesystem paths.
//
// What that costs is stated in cmsAuth.ts's own docstring: "one generic
// refusal for every way of failing the session check… any difference between
// them tells an attacker which half of the guess was right". A 500 for a
// malformed cookie and a 401 for a forged one is exactly that difference.
//
// The bug is NOT an authentication bypass — the IP gate sits in front of the
// whole router (app.ts:149) and Express turns the throw into a refusal, not
// an admission. It is an oracle plus an information leak.
//
// The four cases below fail on the pre-fix parser. The two after them pass
// before AND after, and are the point: they stop the fix from being
// "return {} and never decode anything", which would silence the crash by
// breaking every real login.
// ---------------------------------------------------------------------------

const WHITELISTED_IP = '10.0.0.5';
const TEST_PASSWORD = 'operator-pass-01';
const CMS_CFG = {
  CMS_USERNAME: 'operator',
  CMS_PASSWORD_HASH: hashPassword(TEST_PASSWORD),
  CMS_SESSION_COOKIE_NAME: 'cms_session',
};
const OFFLINE_AGENT = { isAgentOnline: () => false, sendEvent: () => false };

const tmpDirs: string[] = [];
const openStores: LocalStore[] = [];

function makeStore(): LocalStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cms-cookie-'));
  tmpDirs.push(dir);
  const store = new LocalStore(path.join(dir, 'test.sqlite'));
  openStores.push(store);
  return store;
}

function makeApp(): express.Express {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', { value: WHITELISTED_IP, configurable: true });
    next();
  });
  app.use(
    '/cms',
    createCmsIpGate([WHITELISTED_IP]),
    createCmsRouter(makeStore(), CMS_CFG, OFFLINE_AGENT),
  );
  return app;
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
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('CR-01: a malformed Cookie header is refused, not crashed on', () => {
  it('parseCookies does not throw on any percent-sequence a client can send', () => {
    // Three shapes of malformed input: a bare percent, a truncated multi-byte
    // sequence, and a percent followed by non-hex. All three throw URIError
    // from decodeURIComponent.
    for (const header of ['cms_session=%', 'cms_session=%E0%A4%A', 'cms_session=abc%zz']) {
      expect(() => parseCookies(header)).not.toThrow();
    }
  });

  it('drops only the undecodable pair — a good cookie beside a bad one survives', () => {
    // The blast radius matters. Discarding the whole header would mean one
    // malformed unrelated cookie logs the operator out, which is a second
    // failure wearing the first one's clothes.
    expect(parseCookies('theme=dark; cms_session=%; lang=vi')).toEqual({
      theme: 'dark',
      lang: 'vi',
    });
  });

  it('a malformed session cookie gets the SAME 401 body as no cookie at all', async () => {
    const app = makeApp();

    const noCookie = await request(app).get('/cms/');
    const malformed = await request(app).get('/cms/').set('Cookie', 'cms_session=%');

    expect(noCookie.status).toBe(401);
    // The anti-oracle property, asserted as equality rather than as two
    // separate status checks — that is what makes it a property and not a
    // coincidence of two hand-written expectations.
    expect({ status: malformed.status, body: malformed.body }).toEqual({
      status: noCookie.status,
      body: noCookie.body,
    });
  });

  it('POST /cms/logout survives a malformed cookie — it runs before the session guard', async () => {
    const app = makeApp();

    const res = await request(app).post('/cms/logout').set('Cookie', 'cms_session=%');

    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/cms/login');
  });

  // -------------------------------------------------------------------------
  // Non-vacuity. Both of these pass BEFORE the fix. They exist so the fix
  // cannot be "stop decoding" or "always return {}".
  // -------------------------------------------------------------------------

  it('still percent-decodes a well-formed value', () => {
    expect(parseCookies('cms_session=a%20b')).toEqual({ cms_session: 'a b' });
  });

  it('a real login still authenticates end to end', async () => {
    const app = makeApp();

    const login = await request(app)
      .post('/cms/login')
      .type('form')
      .send({ username: 'operator', password: TEST_PASSWORD });
    expect(login.status).toBe(303);

    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const dashboard = await request(app).get('/cms/').set('Cookie', cookie);

    expect(dashboard.status).toBe(200);
  });
});
