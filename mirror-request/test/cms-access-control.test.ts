import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { LocalStore } from '../src/state/localStore';
import { createCmsIpGate } from '../src/cms/cmsIpGate';
import { createCmsRouter } from '../src/cms/cmsRouter';
import { createRequireSession, hashPassword, verifyPassword, type SessionStore } from '../src/cms/cmsAuth';
import { BOOTH_LINK } from './helpers/cmsBoothLink';
import { serveUploadedAsset } from '../src/cms/uploadHandler';
import { jsonWithRawBody } from '../src/ingestion/webhookAuth';
import { clientIp, isWhitelisted } from '../src/security/ipAllowlist';

// ---------------------------------------------------------------------------
// Plan 08-01 Task 3 — CMS-04's two layers proved INDEPENDENTLY live, and
// CMS-05's serving route proved unable to emit anything but four image types
// from one directory.
//
// "Both layers are configured" is not the claim under test here; a single
// layer doing all the work while the other is dead would satisfy that. What
// these cases prove is that each layer refuses on its own.
// ---------------------------------------------------------------------------

const WHITELISTED_IP = '10.0.0.5';
const BLOCKED_IP = '1.2.3.4';
const TEST_PASSWORD = 'operator-pass-01';
const CMS_CFG = {
  CMS_USERNAME: 'operator',
  CMS_PASSWORD_HASH: hashPassword(TEST_PASSWORD),
  CMS_SESSION_COOKIE_NAME: 'cms_session',
};

/**
 * UI-02's Agent link, offline. These suites never reach `/cms/agent`; the stub
 * exists so `createCmsRouter`'s third argument is explicit rather than
 * accidentally `undefined` (plan 08-04).
 */
const OFFLINE_AGENT = { isAgentOnline: () => false, sendEvent: () => false };

const tmpDirs: string[] = [];
const openStores: LocalStore[] = [];

function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function makeStore(): LocalStore {
  const store = new LocalStore(path.join(makeTmpDir('gsd-cms-acl-'), 'test.sqlite'));
  openStores.push(store);
  return store;
}

function withFakeIp(app: express.Express, ip: string): express.Express {
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', { value: ip, configurable: true });
    next();
  });
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

// ---------------------------------------------------------------------------
// CMS-04 / D-13 — the two layers, each proved live on its own
// ---------------------------------------------------------------------------

describe('CMS-04: the IP layer and the session layer refuse independently (D-13)', () => {
  /**
   * Composes the two middlewares in the SAME order index.ts does, but with a
   * spied session store, so the assertion can be about ordering rather than
   * about outcome. Both middlewares are the real production factories.
   */
  function buildSpiedChain(fakeIp: string, whitelist: string[]) {
    const isValid = vi.fn<(token: string) => boolean>(() => false);
    const sessions: SessionStore = {
      create: () => 'unused',
      isValid,
      destroy: () => {},
      size: () => 0,
    };
    const app = withFakeIp(express(), fakeIp);
    app.use(
      '/cms',
      createCmsIpGate(whitelist),
      createRequireSession(sessions, 'cms_session'),
      (_req, res) => res.status(200).json({ reached: true }),
    );
    return { app, isValid };
  }

  it('refuses a non-whitelisted IP BEFORE the session layer is consulted at all (T-08-02)', async () => {
    const { app, isValid } = buildSpiedChain(BLOCKED_IP, [WHITELISTED_IP]);

    const res = await request(app).get('/cms/').set('Cookie', 'cms_session=anything');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
    // The load-bearing assertion: layer two never ran. If the two middlewares
    // were ever swapped, this is 1 and the network layer has become
    // decorative.
    expect(isValid).toHaveBeenCalledTimes(0);
  });

  it('consults the session layer for a whitelisted IP — proving layer two is reached, not skipped', async () => {
    const { app, isValid } = buildSpiedChain(WHITELISTED_IP, [WHITELISTED_IP]);

    const res = await request(app).get('/cms/').set('Cookie', 'cms_session=anything');

    expect(res.status).toBe(401);
    expect(isValid).toHaveBeenCalledTimes(1);
  });

  it('refuses a whitelisted IP with no cookie, and with a forged token, identically (layer two is live)', async () => {
    const app = withFakeIp(express(), WHITELISTED_IP);
    app.use('/cms', createCmsIpGate([WHITELISTED_IP]), createCmsRouter(makeStore(), CMS_CFG, OFFLINE_AGENT, BOOTH_LINK));

    const noCookie = await request(app).get('/cms/');
    const forged = await request(app).get('/cms/').set('Cookie', 'cms_session=deadbeefdeadbeef');

    expect(noCookie.status).toBe(401);
    expect({ status: forged.status, body: forged.body }).toEqual({
      status: noCookie.status,
      body: noCookie.body,
    });
  });

  it('an empty CMS whitelist is a dev escape hatch that leaves layer two enforcing on its own', async () => {
    // isWhitelisted() allows everything when the list is empty. That must not
    // silently disable the password layer too — the two are independent, and
    // config.ts's production fail-fast is what stops this state shipping.
    const app = withFakeIp(express(), BLOCKED_IP);
    app.use('/cms', createCmsIpGate([]), createCmsRouter(makeStore(), CMS_CFG, OFFLINE_AGENT, BOOTH_LINK));

    expect((await request(app).get('/cms/login')).status).toBe(200);
    expect((await request(app).get('/cms/')).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// CMS-05 / D-15 — the serving route
// ---------------------------------------------------------------------------

describe('CMS-05: uploaded assets can only be served as one of four image types (D-15)', () => {
  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('the rest of a png, not parsed by the serving route'),
  ]);
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jfif body')]);
  const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const HTML = Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>');

  function buildUploadApp(files: Record<string, Buffer>): { app: express.Express; dir: string } {
    const dir = makeTmpDir('gsd-cms-uploads-');
    for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), bytes);
    const app = express();
    app.get('/uploads/:filename', serveUploadedAsset(dir));
    return { app, dir };
  }

  it('serves a stored PNG with a fixed image/png and the exact bytes', async () => {
    const { app } = buildUploadApp({ 'asset-1.png': PNG });

    const res = await request(app).get('/uploads/asset-1.png').buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(res.body as Buffer, PNG)).toBe(0);
  });

  it('derives the type from CONTENT, not the extension — an SVG named .png is refused', async () => {
    // The CMS-05 mechanism in one case: if the extension decided the type,
    // this would be served as image/png; if a *sidecar* decided it, a wrong
    // sidecar would too. Only the bytes decide.
    const { app } = buildUploadApp({ 'malicious.png': SVG, 'real.jpeg': JPEG });

    const disguised = await request(app).get('/uploads/malicious.png');
    expect(disguised.status).toBe(404);
    expect(disguised.headers['content-type']).not.toContain('svg');
    expect(disguised.headers['content-type']).not.toContain('image');
    expect(disguised.text).not.toContain('<script>');

    // ...and a genuine JPEG still works, so the rule is "not an image type",
    // not "everything is refused".
    const real = await request(app).get('/uploads/real.jpeg');
    expect(real.status).toBe(200);
    expect(real.headers['content-type']).toBe('image/jpeg');
  });

  it('refuses an .svg and an .html payload with the generic 404, never text/html or image/svg+xml', async () => {
    const { app } = buildUploadApp({ 'logo.svg': SVG, 'page.html': HTML });

    for (const name of ['logo.svg', 'page.html']) {
      const res = await request(app).get(`/uploads/${name}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'not found' });
      expect(res.headers['content-type']).not.toContain('svg');
      expect(res.headers['content-type']).not.toContain('text/html');
      expect(res.headers['content-type']).not.toContain('javascript');
    }
  });

  it('serves a PNG stored under a name with no extension at all', async () => {
    const { app } = buildUploadApp({ 'a1b2c3d4e5': PNG });
    const res = await request(app).get('/uploads/a1b2c3d4e5');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
  });

  it('answers traversal-shaped names exactly as it answers a plain missing file, reading nothing outside the directory', async () => {
    const { app, dir } = buildUploadApp({ 'present.png': PNG });
    // A real file one level above the upload directory — the thing a
    // traversal would be trying to reach.
    const secretPath = path.join(path.dirname(dir), 'secret.txt');
    fs.writeFileSync(secretPath, 'TOP-SECRET-CONTENT');

    const missing = await request(app).get('/uploads/definitely-missing.png');
    const traversals = [
      await request(app).get('/uploads/..%2f..%2fetc%2fpasswd'),
      await request(app).get('/uploads/%2e%2e%2fsecret.txt'),
      await request(app).get(`/uploads/..%2f${path.basename(secretPath)}`),
    ];

    for (const res of traversals) {
      expect({ status: res.status, body: res.body }).toEqual({
        status: missing.status,
        body: missing.body,
      });
      expect(res.text).not.toContain('TOP-SECRET-CONTENT');
      expect(res.text).not.toContain('root:');
    }
    fs.rmSync(secretPath, { force: true });
  });

  it('refuses to leave the upload directory even when the target IS a valid image', async () => {
    // Without this case the traversal assertions above pass for the wrong
    // reason: /etc/passwd and a .txt file are refused by the magic-byte
    // allow-list, not by the directory guard, so deleting path.basename()
    // entirely would leave the suite green. (Found by mutation, not by
    // reading — see 08-01-SUMMARY.md.) A PNG one level up is the case that
    // can only be refused by the containment check.
    const { app, dir } = buildUploadApp({ 'present.png': PNG });
    const outsidePng = path.join(path.dirname(dir), 'outside-brand.png');
    fs.writeFileSync(outsidePng, PNG);

    try {
      const res = await request(app).get(`/uploads/..%2f${path.basename(outsidePng)}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'not found' });
      expect(res.headers['content-type']).not.toContain('image');
    } finally {
      fs.rmSync(outsidePng, { force: true });
    }
  });

  it('MEASURED: an unencoded ../ never arrives as a traversal — the client normalizes it away', async () => {
    // Recorded because it is the one case whose 404 does NOT match the
    // generic body, and the reason is benign rather than a defect: Node's
    // HTTP client resolves `/uploads/../package.json` to `/package.json`
    // before the request leaves, so it reaches no route of ours at all and
    // gets Express's own default 404. Measured, not assumed — see
    // 08-01-SUMMARY.md. The security property still holds: nothing outside
    // the upload directory is read or returned.
    const { app } = buildUploadApp({ 'present.png': PNG });
    const res = await request(app).get('/uploads/../package.json');

    expect(res.status).toBe(404);
    expect(res.text).not.toContain('extension-service');
    expect(res.text).not.toContain('dependencies');
  });

  it('refuses a directory and a dot-only name', async () => {
    const { app, dir } = buildUploadApp({ 'present.png': PNG });
    fs.mkdirSync(path.join(dir, 'subdir'));

    expect((await request(app).get('/uploads/subdir')).status).toBe(404);
    expect((await request(app).get('/uploads/.')).status).toBe(404);
  });

  it('is gated by the union of the display and CMS allow-lists, so a TV and the operator both reach it', async () => {
    // The exact composition index.ts uses. A TV is on DISPLAY_IP_WHITELIST
    // and has no session; the operator is on CMS_IP_WHITELIST.
    const displayList = ['10.0.0.20'];
    const cmsList = ['10.0.0.30'];
    const dir = makeTmpDir('gsd-cms-union-');
    fs.writeFileSync(path.join(dir, 'brand.png'), PNG);

    function appForIp(ip: string): express.Express {
      const app = withFakeIp(express(), ip);
      app.get(
        '/uploads/:filename',
        (req, res, next) => {
          if (!isWhitelisted(clientIp(req), [...displayList, ...cmsList])) {
            return res.status(403).json({ error: 'Forbidden' });
          }
          next();
        },
        serveUploadedAsset(dir),
      );
      return app;
    }

    expect((await request(appForIp('10.0.0.20')).get('/uploads/brand.png')).status).toBe(200);
    expect((await request(appForIp('10.0.0.30')).get('/uploads/brand.png')).status).toBe(200);
    const stranger = await request(appForIp('1.2.3.4')).get('/uploads/brand.png');
    expect(stranger.status).toBe(403);
    expect(stranger.body).toEqual({ error: 'Forbidden' });
  });
});

// ---------------------------------------------------------------------------
// T-08-07 — the route-scoped upload body limit
// ---------------------------------------------------------------------------

describe('the upload body parser is larger than the global default, and only on its own path (T-08-07)', () => {
  /** The exact mount order index.ts uses: scoped parser, THEN the global one. */
  function buildParserApp(maxBytes: number): express.Express {
    const app = express();
    app.use('/cms/api/assets', express.json({ limit: Math.ceil(maxBytes * (4 / 3)) + 65_536 }));
    app.use(jsonWithRawBody());
    app.post('/cms/api/assets', (req, res) => res.status(200).json({ length: (req.body as { data: string }).data.length }));
    app.post('/on-register', (_req, res) => res.status(200).json({ ok: true }));
    return app;
  }

  it('accepts a ~4MB base64-shaped body on the upload path — the scoped limit really is in force', async () => {
    const app = buildParserApp(5_242_880);
    const body = { data: 'A'.repeat(4_000_000) };

    const res = await request(app).post('/cms/api/assets').send(body);

    // Not merely "not 500" — the plan requires proof it is not a 413, which
    // is what a mount below the global 100kb parser would produce.
    expect(res.status).not.toBe(413);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(4_000_000);
  });

  it('leaves the global 100kb default in force everywhere else, including /on-register', async () => {
    const app = buildParserApp(5_242_880);
    const body = { data: 'A'.repeat(4_000_000) };

    const res = await request(app).post('/on-register').send(body);

    // The scoped limit must not have leaked into the global parser — a 5MB
    // body on the ingestion route is a denial-of-service surface, not a
    // feature.
    expect(res.status).toBe(413);
  });
});

// ---------------------------------------------------------------------------
// D-14 / T-08-06 — the offline password-hash helper
// ---------------------------------------------------------------------------

describe('the offline password-hash helper (D-14)', () => {
  /**
   * Piped on STDIN, not passed as an argument. Phase 8's code review (WR-04)
   * found the argv form exposed the master password to the shell's history
   * file and to `ps` / `/proc/<pid>/cmdline`; the helper now refuses a
   * positional argument outright, so this harness had to change with it.
   */
  function runHelper(password: string): string {
    return execFileSync('npx', ['ts-node', '-T', 'scripts/hashCmsPassword.ts'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      input: `${password}\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  }

  it('prints a CMS_PASSWORD_HASH line whose digest verifyPassword accepts, with a fresh salt each run', () => {
    const first = runHelper('test-pass-123');
    const second = runHelper('test-pass-123');

    expect(first).toMatch(/^CMS_PASSWORD_HASH=[0-9a-f]+:[0-9a-f]+$/);
    const firstHash = first.split('=')[1];
    const secondHash = second.split('=')[1];

    expect(verifyPassword('test-pass-123', firstHash)).toBe(true);
    expect(verifyPassword('test-pass-123', secondHash)).toBe(true);
    expect(verifyPassword('wrong-pass', firstHash)).toBe(false);

    // A fresh 16-byte salt per run — two installations sharing a password
    // must not share a digest.
    expect(firstHash).not.toBe(secondHash);
    // The plaintext must appear nowhere in the output.
    expect(first).not.toContain('test-pass-123');
  }, 60_000);

  it('REFUSES a password passed as a command-line argument (WR-04)', () => {
    // The regression guard for the fix itself. If a future edit restores argv
    // support "for convenience", this fails — and the exposure it reopens is
    // exactly the one an operator cannot see: the password sitting in their
    // shell history long after the command finished.
    expect(() =>
      execFileSync('npx', ['ts-node', '-T', 'scripts/hashCmsPassword.ts', 'oops-in-argv'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ).toThrow();
  }, 60_000);
});
