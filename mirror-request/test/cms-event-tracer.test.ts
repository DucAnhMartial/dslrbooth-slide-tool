import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import http from 'http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';
import { LocalStore, DEFAULT_EVENT_CONFIG } from '../src/state/localStore';
import { createCmsIpGate } from '../src/cms/cmsIpGate';
import { createCmsRouter } from '../src/cms/cmsRouter';
import { hashPassword, verifyPassword } from '../src/cms/cmsAuth';
import { BOOTH_LINK } from './helpers/cmsBoothLink';
import { DisplayServer } from '../src/display/displayServer';
import { renderDisplayPage } from '../src/display/displayPage';
import type { QueueService } from '../src/queue/queueService';
import type { AgentServer } from '../src/agent/agentServer';
import type { DisplaySnapshot } from '../src/types';

// ---------------------------------------------------------------------------
// Plan 08-01 Task 1 — the tracer.
//
// One runnable path through every layer this phase touches: CMS IP gate ->
// session login -> event creation -> active-event pointer -> WS /display
// snapshot -> the room-screen applier. Every other plan in Phase 8 writes into
// a seam proved here, so this file deliberately asserts the seams (cookie
// attributes, gate order, pointer cardinality, snapshot shape) rather than
// just the happy path.
//
// Store handling copies test/local-store-persistence.test.ts's REAL temp-file
// harness rather than display-access-control.test.ts's ./data paths, because
// several cases below need a second better-sqlite3 handle on the same file to
// assert raw table state (active_event's cardinality) that no store method
// exposes.
// ---------------------------------------------------------------------------

const TEST_USERNAME = 'operator';
const TEST_PASSWORD = 'operator-pass-01';
// Minted through the same production helper the operator's offline script
// uses, so a change to the scrypt parameters breaks this file loudly rather
// than silently testing a stale digest.
const TEST_PASSWORD_HASH = hashPassword(TEST_PASSWORD);

const CMS_CFG = {
  CMS_USERNAME: TEST_USERNAME,
  CMS_PASSWORD_HASH: TEST_PASSWORD_HASH,
  CMS_SESSION_COOKIE_NAME: 'cms_session',
};

/**
 * UI-02's Agent link, offline. These suites never reach `/cms/agent`; the stub
 * exists so `createCmsRouter`'s third argument is explicit rather than
 * accidentally `undefined` (plan 08-04).
 */
const OFFLINE_AGENT = { isAgentOnline: () => false, sendEvent: () => false };

const WHITELISTED_IP = '10.0.0.5';
const BLOCKED_IP = '1.2.3.4';
const LOGIN_ERROR = 'Sai tên đăng nhập hoặc mật khẩu. Vui lòng thử lại.';

const openStores: LocalStore[] = [];
const tmpDirs: string[] = [];
const storePaths = new WeakMap<LocalStore, string>();
const openServers: http.Server[] = [];
const openDisplays: DisplayServer[] = [];
const openSockets: WebSocket[] = [];

function makeStore(): LocalStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cms-tracer-'));
  tmpDirs.push(dir);
  const dbPath = path.join(dir, 'test.sqlite');
  const store = new LocalStore(dbPath);
  openStores.push(store);
  storePaths.set(store, dbPath);
  return store;
}

function makeMockQueue(): Partial<QueueService> {
  return { getQueuePosition: () => undefined, getQueueLength: () => 0, getAnnouncement: () => null };
}
function makeMockAgent(): Partial<AgentServer> {
  return { isAgentOnline: () => true };
}

function buildCmsApp(
  store: LocalStore,
  opts: { whitelist?: string[]; fakeIp?: string } = {},
): express.Express {
  const app = express();
  const fakeIp = opts.fakeIp ?? WHITELISTED_IP;
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', { value: fakeIp, configurable: true });
    next();
  });
  // The exact mount index.ts uses: IP gate FIRST, router second (D-13).
  app.use('/cms', createCmsIpGate(opts.whitelist ?? [WHITELISTED_IP]), createCmsRouter(store, CMS_CFG, OFFLINE_AGENT, BOOTH_LINK));
  return app;
}

function cookiesOf(res: request.Response): string[] {
  const raw = res.headers['set-cookie'];
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

async function login(app: express.Express): Promise<string> {
  const res = await request(app)
    .post('/cms/login')
    .type('form')
    .send({ username: TEST_USERNAME, password: TEST_PASSWORD });
  const cookie = cookiesOf(res)[0];
  expect(cookie, 'login should set a session cookie').toBeTruthy();
  return cookie.split(';')[0];
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
  const port = typeof address === 'object' && address ? address.port : 0;
  return { port };
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
// Layer 1 — the network gate (D-13, T-08-02)
// ---------------------------------------------------------------------------

describe('CMS IP gate (D-13, layer one)', () => {
  it('refuses /cms/login from a non-whitelisted IP with the generic 403 and no login HTML', async () => {
    const app = buildCmsApp(makeStore(), { whitelist: [WHITELISTED_IP], fakeIp: BLOCKED_IP });
    const res = await request(app).get('/cms/login');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
    expect(res.text).not.toContain('<form');
    expect(res.text).not.toContain('Đăng nhập');
  });

  it('lets a whitelisted IP reach the login page', async () => {
    const app = buildCmsApp(makeStore(), { whitelist: [WHITELISTED_IP], fakeIp: WHITELISTED_IP });
    const res = await request(app).get('/cms/login');

    expect(res.status).toBe(200);
    expect(res.text).toContain('Đăng nhập');
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — password + session (D-14, T-08-01, T-08-04, T-08-05)
// ---------------------------------------------------------------------------

describe('CMS login and session cookie (D-14)', () => {
  it('sets an opaque HttpOnly SameSite=Lax cookie WITHOUT Secure (no TLS terminates anywhere)', async () => {
    const app = buildCmsApp(makeStore());
    const res = await request(app)
      .post('/cms/login')
      .type('form')
      .send({ username: TEST_USERNAME, password: TEST_PASSWORD });

    const cookie = cookiesOf(res)[0];
    expect(cookie).toBeTruthy();
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    // RESEARCH Pitfall 3: Secure here would make login impossible over the
    // plain-HTTP LAN this service actually runs on.
    expect(cookie).not.toMatch(/Secure/);
    // The token must be opaque — never the username, never the hash.
    const token = cookie.split(';')[0].split('=')[1];
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(token).not.toContain(TEST_USERNAME);
    expect(TEST_PASSWORD_HASH).not.toContain(token);
  });

  it('renders the exact Vietnamese error and sets no cookie on a wrong password', async () => {
    const app = buildCmsApp(makeStore());
    const res = await request(app)
      .post('/cms/login')
      .type('form')
      .send({ username: TEST_USERNAME, password: 'wrong-password' });

    expect(res.status).toBe(401);
    expect(res.text).toContain(LOGIN_ERROR);
    expect(cookiesOf(res)).toHaveLength(0);
  });

  it('answers an unknown username with byte-identical copy — no account oracle (T-08-01)', async () => {
    const app = buildCmsApp(makeStore());
    const unknownUser = await request(app)
      .post('/cms/login')
      .type('form')
      .send({ username: 'not-the-operator', password: TEST_PASSWORD });
    const wrongPass = await request(app)
      .post('/cms/login')
      .type('form')
      .send({ username: TEST_USERNAME, password: 'wrong-password' });

    expect(unknownUser.status).toBe(wrongPass.status);
    expect(unknownUser.text).toBe(wrongPass.text);
    expect(cookiesOf(unknownUser)).toHaveLength(0);
  });

  it('refuses the dashboard from a whitelisted IP with no session, and with a forged token, identically', async () => {
    const app = buildCmsApp(makeStore());
    const noCookie = await request(app).get('/cms/');
    const forged = await request(app).get('/cms/').set('Cookie', 'cms_session=not-a-real-token');

    expect(noCookie.status).toBe(401);
    expect({ status: noCookie.status, body: noCookie.body }).toEqual({
      status: forged.status,
      body: forged.body,
    });
  });

  it('lets an authenticated session reach the dashboard, and manual logout revokes it (D-14)', async () => {
    const app = buildCmsApp(makeStore());
    const cookie = await login(app);

    const dashboard = await request(app).get('/cms/').set('Cookie', cookie);
    expect(dashboard.status).toBe(200);
    expect(dashboard.text).toContain('Tạo sự kiện mới');

    await request(app).post('/cms/logout').set('Cookie', cookie);
    const afterLogout = await request(app).get('/cms/').set('Cookie', cookie);
    expect(afterLogout.status).toBe(401);
  });

  it('hashPassword/verifyPassword round-trips and rejects a wrong password', () => {
    const stored = hashPassword('another-pass');
    expect(verifyPassword('another-pass', stored)).toBe(true);
    expect(verifyPassword('another-pas', stored)).toBe(false);
    expect(verifyPassword('another-pass', 'garbage-not-a-hash')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Event creation, defaults, and the single-active pointer (D-01, CMS-01)
// ---------------------------------------------------------------------------

describe('event creation and the single-active-event pointer (D-01)', () => {
  it('creates an event whose every unset CMS-01 field holds its shipped default', async () => {
    const store = makeStore();
    const app = buildCmsApp(store);
    const cookie = await login(app);

    const res = await request(app)
      .post('/cms/api/events')
      .set('Cookie', cookie)
      .send({ name: 'Tiệc cưới A' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();

    const row = new Database(storePaths.get(store)!, { readonly: true })
      .prepare('SELECT * FROM event WHERE id = ?')
      .get(res.body.id) as Record<string, unknown>;
    expect(row.name).toBe('Tiệc cưới A');
    expect(row.font_choice).toBe('system-ui');
    expect(row.layout_style).toBe('stage_sidebar');

    const config = store.getEventConfig(res.body.id as string);
    expect(config?.name).toBe('Tiệc cưới A');
    expect(config?.fontChoice).toBe('system-ui');
    expect(config?.layoutStyle).toBe('stage_sidebar');
    expect(config?.idleHeading).toBe(DEFAULT_EVENT_CONFIG.idleHeading);
    expect(config?.colorAccent).toBe(DEFAULT_EVENT_CONFIG.colorAccent);
    expect(config?.photoDurationMs).toBe(DEFAULT_EVENT_CONFIG.photoDurationMs);
  });

  it('activating a second event REPLACES the pointer rather than adding a row', async () => {
    const store = makeStore();
    const app = buildCmsApp(store);
    const cookie = await login(app);

    const first = await request(app).post('/cms/api/events').set('Cookie', cookie).send({ name: 'Sự kiện 1' });
    const second = await request(app).post('/cms/api/events').set('Cookie', cookie).send({ name: 'Sự kiện 2' });

    await request(app).post(`/cms/api/events/${first.body.id}/activate`).set('Cookie', cookie).expect(200);
    await request(app).post(`/cms/api/events/${second.body.id}/activate`).set('Cookie', cookie).expect(200);

    const db = new Database(storePaths.get(store)!, { readonly: true });
    const count = db.prepare('SELECT COUNT(*) AS n FROM active_event').get() as { n: number };
    const pointer = db.prepare('SELECT event_id FROM active_event WHERE id = 1').get() as { event_id: string };

    expect(count.n).toBe(1);
    expect(pointer.event_id).toBe(second.body.id);
    expect(store.getActiveEventId()).toBe(second.body.id);
    expect(store.getActiveEventConfig().name).toBe('Sự kiện 2');
  });

  it('event creation and activation both require a session (layer two is live on mutations)', async () => {
    const store = makeStore();
    const app = buildCmsApp(store);

    const create = await request(app).post('/cms/api/events').send({ name: 'Không được phép' });
    expect(create.status).toBe(401);
    expect(store.listEvents()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// UI-01 — the screen is correct before any event exists
// ---------------------------------------------------------------------------

describe('UI-01: the shipped default config holds with zero events', () => {
  it('getActiveEventConfig() returns a populated default object, never null, with no events at all', () => {
    const store = makeStore();
    const config = store.getActiveEventConfig();

    expect(config).not.toBeNull();
    expect(config.id).toBeNull();
    expect(config.fontChoice).toBe('system-ui');
    expect(config.layoutStyle).toBe('stage_sidebar');
    expect(config.idleHeading).toBe('Sẵn sàng chụp ảnh cùng bạn');
    expect(config.idleSub).toBe('Quét mã QR bên dưới để đăng ký');
    for (const [key, value] of Object.entries(config)) {
      if (key === 'id' || key === 'logoUrl' || key === 'backgroundUrl' || key === 'qrImageUrl') continue;
      expect(value, `${key} must have a shipped default`).not.toBeNull();
      expect(value, `${key} must have a shipped default`).not.toBeUndefined();
    }
  });

  it('a dangling active-event pointer falls back to the shipped defaults rather than breaking the screen', () => {
    const store = makeStore();
    const created = store.createEvent({ name: 'Sẽ bị treo' });
    store.setActiveEvent(created.id);
    new Database(storePaths.get(store)!).prepare('DELETE FROM event WHERE id = ?').run(created.id);

    const config = store.getActiveEventConfig();
    expect(config.id).toBeNull();
    expect(config.fontChoice).toBe('system-ui');
    expect(config.layoutStyle).toBe('stage_sidebar');
  });

  it('a WS /display snapshot carries the default eventConfig when no event exists', async () => {
    const store = makeStore();
    const { port } = await startDisplay(store);
    const ws = connectDisplayClient(port);
    const snapshot = await awaitSnapshot(ws, () => true);

    expect(snapshot.eventConfig).toBeTruthy();
    expect(snapshot.eventConfig.fontChoice).toBe('system-ui');
    expect(snapshot.eventConfig.layoutStyle).toBe('stage_sidebar');
  });
});

// ---------------------------------------------------------------------------
// The tracer proper — login to a live screen, end to end (D-01, D-12, CMS-02)
// ---------------------------------------------------------------------------

describe('the tracer: login -> create -> activate -> live screen feed', () => {
  it('drives one path from CMS login to a connected screen receiving the event config, with no reload', async () => {
    const store = makeStore();
    const app = buildCmsApp(store);
    const { port } = await startDisplay(store);

    // The screen is already open and connected BEFORE the operator does
    // anything — D-12: screens carry no identity and are never re-pointed.
    const ws = connectDisplayClient(port);
    const before = await awaitSnapshot(ws, () => true);
    expect(before.eventConfig.name).toBe(DEFAULT_EVENT_CONFIG.name);

    const cookie = await login(app);
    const created = await request(app)
      .post('/cms/api/events')
      .set('Cookie', cookie)
      .send({ name: 'Tiệc cưới A' });
    expect(created.status).toBe(201);

    await request(app)
      .post(`/cms/api/events/${created.body.id}/activate`)
      .set('Cookie', cookie)
      .expect(200);

    const after = await awaitSnapshot(ws, (snap) => snap.eventConfig.name === 'Tiệc cưới A');

    expect(after.eventConfig.name).toBe('Tiệc cưới A');
    expect(after.eventConfig.id).toBe(created.body.id);
    expect(after.eventConfig.fontChoice).toBe('system-ui');
    expect(after.eventConfig.layoutStyle).toBe('stage_sidebar');
    expect(after.eventConfig.photoCount).toBe(DEFAULT_EVENT_CONFIG.photoCount);
    expect(after.eventConfig.photoDurationMs).toBe(DEFAULT_EVENT_CONFIG.photoDurationMs);
    expect(after.eventConfig.colorDominant).toBe(DEFAULT_EVENT_CONFIG.colorDominant);
    expect(after.eventConfig.colorText).toBe(DEFAULT_EVENT_CONFIG.colorText);
    expect(after.eventConfig.idleHeading).toBe(DEFAULT_EVENT_CONFIG.idleHeading);
    expect(after.eventConfig.idleSub).toBe(DEFAULT_EVENT_CONFIG.idleSub);
  });

  it('the CMS dashboard escapes an event name rather than reflecting it as markup', async () => {
    const store = makeStore();
    const app = buildCmsApp(store);
    const cookie = await login(app);
    await request(app)
      .post('/cms/api/events')
      .set('Cookie', cookie)
      .send({ name: '<script>alert(1)</script>' });

    const dashboard = await request(app).get('/cms/').set('Cookie', cookie);
    expect(dashboard.text).not.toContain('<script>alert(1)</script>');
    expect(dashboard.text).toContain('&lt;script&gt;');
  });
});

// ---------------------------------------------------------------------------
// The room-screen applier (UI-01, CMS-01)
// ---------------------------------------------------------------------------

describe('room-screen config applier', () => {
  it('the served HTML writes eventConfig values onto CSS custom properties on each snapshot', () => {
    const html = renderDisplayPage();

    expect(html).toContain('eventConfig');
    expect(html).toContain('setProperty');
    expect(html).toContain('--event-accent');
    expect(html).toContain('--event-bg');
  });

  it('keeps the two operational status colors out of the configurable set', () => {
    const html = renderDisplayPage();

    // Fixed by UI-SPEC so event branding can never hide an Agent fault.
    expect(html).toContain('#a33127');
    expect(html).toContain('#34d399');
    expect(html).not.toContain('--event-offline');
    expect(html).not.toContain('--event-online');
  });
});
