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
import { createSessionStore, createRequireSession } from '../src/cms/cmsAuth';
import { createCmsEventRoutes } from '../src/cms/cmsEventRoutes';
import { SCREEN_URL_PATH } from '../src/cms/cmsEventPages';
import { DisplayServer } from '../src/display/displayServer';
import type { QueueService } from '../src/queue/queueService';
import type { AgentServer } from '../src/agent/agentServer';
import type { DisplaySnapshot } from '../src/types';

// ---------------------------------------------------------------------------
// Plan 08-03 Task 3 — D-02, D-03, D-11 and D-12 at the active-event switch.
//
// D-02 was written from a real incident: ticket 3X818VEJ sat queued with
// nobody to shoot it and had to be fixed by hand in the database. A CMS that
// blocked the switch until the queue drained would have hard-locked that room
// mid-event. So the switch is WARNED, not blocked — and the warning has to be
// enforced somewhere the browser cannot skip, which is why the confirmation is
// asserted against the SERVER below and not against a dialog.
//
// The other half of D-02 is the promise that the queue is untouched. That is
// not asserted by reading a store method (a method that lied would agree with
// itself); it is asserted by dumping `queue_job` and `booth_state` through a
// SECOND, independent better-sqlite3 handle before and after the switch and
// requiring deep equality.
// ---------------------------------------------------------------------------

const WHITELISTED_IP = '10.0.0.5';

const tmpDirs: string[] = [];
const openStores: LocalStore[] = [];
const storePaths = new WeakMap<LocalStore, string>();
const openServers: http.Server[] = [];
const openDisplays: DisplayServer[] = [];
const openSockets: WebSocket[] = [];

function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function makeStore(): LocalStore {
  const dbPath = path.join(makeTmpDir('gsd-cms-switch-'), 'test.sqlite');
  const store = new LocalStore(dbPath);
  openStores.push(store);
  storePaths.set(store, dbPath);
  return store;
}

interface Harness {
  app: express.Express;
  cookie: string;
  store: LocalStore;
}

function build(store: LocalStore = makeStore()): Harness {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', { value: WHITELISTED_IP, configurable: true });
    next();
  });
  const sessions = createSessionStore();
  const token = sessions.create('operator');
  app.use(
    '/cms',
    createCmsIpGate([WHITELISTED_IP]),
    express.urlencoded({ extended: false }),
    express.json(),
    createRequireSession(sessions, 'cms_session'),
    createCmsEventRoutes(store, { uploadDir: makeTmpDir('gsd-cms-switch-uploads-'), maxBytes: 5_242_880 }),
  );
  return { app, cookie: `cms_session=${token}`, store };
}

async function createEvent(h: Harness, name: string): Promise<string> {
  const res = await request(h.app).post('/cms/api/events').set('Cookie', h.cookie).send({ name });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

/** Reads through a SECOND handle so the assertion does not trust the store. */
function dumpTables(store: LocalStore): { queue: unknown[]; booth: unknown[] } {
  const db = new Database(storePaths.get(store)!, { readonly: true });
  try {
    return {
      queue: db.prepare('SELECT * FROM queue_job ORDER BY id').all(),
      booth: db.prepare('SELECT * FROM booth_state ORDER BY id').all(),
    };
  } finally {
    db.close();
  }
}

function seedQueue(store: LocalStore, count: number): void {
  for (let i = 0; i < count; i += 1) {
    store.upsertRegistration({
      id: `reg-${i}`,
      name: `Khách ${i}`,
      email: `guest${i}@example.com`,
      phone: '',
      mode: 'standard',
      registered_at: new Date().toISOString(),
    });
    store.enqueueJob({ id: `reg-${i}`, queued_at: Date.now() + i });
  }
  expect(store.getQueueLength()).toBe(count);
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
// D-02 — the warning, and the fact that it is a warning
// ---------------------------------------------------------------------------

describe('D-02: switching the live event states how many guests are waiting', () => {
  it('names the live queue length in the confirmation view', async () => {
    const h = build();
    seedQueue(h.store, 3);
    const id = await createEvent(h, 'Tiệc cưới B');

    const res = await request(h.app).get(`/cms/events/${id}/activate`).set('Cookie', h.cookie);

    expect(res.status).toBe(200);
    expect(res.text).toContain('3');
    expect(res.text).toMatch(/3 khách đang chờ/);
  });

  it('reports zero waiting guests without inventing a warning', async () => {
    const h = build();
    const id = await createEvent(h, 'Tiệc cưới B');

    const res = await request(h.app).get(`/cms/events/${id}/activate`).set('Cookie', h.cookie);
    expect(res.text).toContain('Hiện không có khách nào đang chờ');
  });

  it('ALLOWS the switch with guests queued once the confirmation is carried', async () => {
    const h = build();
    seedQueue(h.store, 3);
    const first = await createEvent(h, 'Sự kiện 1');
    const second = await createEvent(h, 'Sự kiện 2');
    await request(h.app).post(`/cms/api/events/${first}/activate`).set('Cookie', h.cookie).send({ confirmed: true }).expect(200);

    const res = await request(h.app)
      .post(`/cms/api/events/${second}/activate`)
      .set('Cookie', h.cookie)
      .send({ confirmed: true });

    // Blocking here is the behaviour D-02 rejected on measured evidence.
    expect(res.status).toBe(200);
    expect(res.body.activeEventId).toBe(second);
    expect(h.store.getActiveEventId()).toBe(second);
  });

  it('enforces the confirmation on the SERVER — an unconfirmed switch with guests waiting is refused', async () => {
    const h = build();
    seedQueue(h.store, 2);
    const first = await createEvent(h, 'Sự kiện 1');
    const second = await createEvent(h, 'Sự kiện 2');
    await request(h.app).post(`/cms/api/events/${first}/activate`).set('Cookie', h.cookie).send({ confirmed: true }).expect(200);

    const res = await request(h.app).post(`/cms/api/events/${second}/activate`).set('Cookie', h.cookie).send({});

    // A dialog the browser can skip is not the decision D-02 asks for.
    expect(res.status).toBe(409);
    expect(res.body.waitingGuests).toBe(2);
    expect(h.store.getActiveEventId()).toBe(first);
  });

  it('needs no confirmation when nobody is waiting — the prompt exists for the queue, not for ceremony', async () => {
    const h = build();
    const id = await createEvent(h, 'Sự kiện 1');

    const res = await request(h.app).post(`/cms/api/events/${id}/activate`).set('Cookie', h.cookie).send({});
    expect(res.status).toBe(200);
    expect(h.store.getActiveEventId()).toBe(id);
  });
});

// ---------------------------------------------------------------------------
// D-01/D-02 — the queue is not this route's business
// ---------------------------------------------------------------------------

describe('the switch writes ONLY the active-event pointer', () => {
  it('leaves queue_job and booth_state byte-identical across the switch', async () => {
    const h = build();
    seedQueue(h.store, 3);
    h.store.setBoothBusy('reg-0');
    const first = await createEvent(h, 'Sự kiện 1');
    const second = await createEvent(h, 'Sự kiện 2');
    await request(h.app).post(`/cms/api/events/${first}/activate`).set('Cookie', h.cookie).send({ confirmed: true }).expect(200);

    const before = dumpTables(h.store);
    await request(h.app)
      .post(`/cms/api/events/${second}/activate`)
      .set('Cookie', h.cookie)
      .send({ confirmed: true })
      .expect(200);
    const after = dumpTables(h.store);

    expect(after.queue).toEqual(before.queue);
    expect(after.booth).toEqual(before.booth);
    // ...and the queue is still SERVING those guests, not merely unchanged.
    expect(h.store.getQueueLength()).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// CMS-02 / D-12 — every screen, at once, with no reload and no URL change
// ---------------------------------------------------------------------------

describe('CMS-02: one switch updates every connected screen', () => {
  it('a live WS /display client receives the second event configuration', async () => {
    const h = build();
    const { port } = await startDisplay(h.store);
    const first = await createEvent(h, 'Sự kiện 1');
    const second = await createEvent(h, 'Sự kiện 2');
    await request(h.app).post(`/cms/api/events/${second}/activate`).set('Cookie', h.cookie).send({}).expect(200);
    await request(h.app)
      .post(`/cms/api/events/${second}`)
      .set('Cookie', h.cookie)
      .send({ color_accent: '#ff8800' })
      .expect(200);

    const ws = connectDisplayClient(port);
    await awaitSnapshot(ws, (snap) => snap.eventConfig.name === 'Sự kiện 2');

    await request(h.app)
      .post(`/cms/api/events/${first}/activate`)
      .set('Cookie', h.cookie)
      .send({ confirmed: true })
      .expect(200);

    const after = await awaitSnapshot(ws, (snap) => snap.eventConfig.name === 'Sự kiện 1');
    expect(after.eventConfig.id).toBe(first);
    expect(after.eventConfig.colorAccent).toBe(DEFAULT_EVENT_CONFIG.colorAccent);
  });

  it('surfaces ONE copyable screen URL, the same fixed path for every event (D-12)', async () => {
    const h = build();
    expect(SCREEN_URL_PATH).toBe('/display-screen');

    await createEvent(h, 'Sự kiện 1');
    const one = await request(h.app).get('/cms/events').set('Cookie', h.cookie);
    await createEvent(h, 'Sự kiện 2');
    const two = await request(h.app).get('/cms/events').set('Cookie', h.cookie);

    const count = (text: string): number => (text.match(/\/display-screen/g) ?? []).length;
    expect(count(one.text)).toBeGreaterThan(0);
    // The load-bearing property (D-12): the screen URL does not vary with, or
    // multiply per, the number of events. A per-event slug would show up here
    // as a count that grows with the list.
    expect(count(two.text)).toBe(count(one.text));
    expect(two.text).toContain('Sao chép');
  });
});

// ---------------------------------------------------------------------------
// D-03 — manual activation only
// ---------------------------------------------------------------------------

describe('D-03: nothing in the CMS can schedule an activation', () => {
  it('renders no date, time or datetime input anywhere in the CMS pages', async () => {
    const h = build();
    const id = await createEvent(h, 'Sự kiện 1');

    for (const url of ['/cms/events', '/cms/events/new', `/cms/events/${id}`, `/cms/events/${id}/activate`]) {
      const res = await request(h.app).get(url).set('Cookie', h.cookie);
      expect(res.text, `${url} must offer no scheduling control`).not.toContain('type="datetime-local"');
      expect(res.text, `${url} must offer no scheduling control`).not.toContain('type="date"');
      expect(res.text, `${url} must offer no scheduling control`).not.toContain('type="time"');
    }
  });

  it('has no scheduling identifier anywhere in src/cms — checked against the source, not the markup', () => {
    // The acceptance criterion is a grep; encoding it as a test means a future
    // edit that reintroduces a scheduler is caught by the suite rather than by
    // someone remembering to re-run a shell command.
    const dir = path.join(__dirname, '..', 'src', 'cms');
    const offenders: string[] = [];
    for (const file of fs.readdirSync(dir)) {
      const source = fs.readFileSync(path.join(dir, file), 'utf8');
      source.split('\n').forEach((line, index) => {
        if (line.trim().startsWith('//')) return;
        if (/start_at|end_at|setInterval|node-cron|toZonedTime/.test(line)) {
          offenders.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// D-11 — deletion is explicit, typed, and scoped
// ---------------------------------------------------------------------------

describe('deleting an event removes exactly what the confirmation promises', () => {
  function seedPhotos(store: LocalStore, eventId: string, count: number, prefix: string): void {
    for (let i = 0; i < count; i += 1) {
      store.recordEventPhoto({
        jobId: `${prefix}-${i}`,
        eventId,
        guestName: `Khách ${i}`,
        photoUrl: `https://photos.example/${prefix}-${i}.jpg`,
        capturedAt: Date.now() + i,
      });
    }
    expect(store.countEventPhotos(eventId)).toBe(count);
  }

  it('requires the typed event name and refuses anything else', async () => {
    const h = build();
    const id = await createEvent(h, 'Tiệc cưới B');

    for (const wrong of ['', 'tiệc cưới b', 'XOA', 'Tiệc cưới A']) {
      const res = await request(h.app)
        .post(`/cms/api/events/${id}/delete`)
        .set('Cookie', h.cookie)
        .send({ confirmName: wrong });
      expect(res.status, `"${wrong}" must not delete the event`).toBe(400);
    }
    expect(h.store.getEventConfig(id)).toBeTruthy();
  });

  it('removes the event and ITS photo history, leaving another event untouched (D-11)', async () => {
    const h = build();
    const doomed = await createEvent(h, 'Sự kiện cũ');
    const keeper = await createEvent(h, 'Sự kiện mới');
    seedPhotos(h.store, doomed, 3, 'doomed');
    seedPhotos(h.store, keeper, 2, 'keeper');

    const res = await request(h.app)
      .post(`/cms/api/events/${doomed}/delete`)
      .set('Cookie', h.cookie)
      .send({ confirmName: 'Sự kiện cũ' });

    expect(res.status).toBe(200);
    expect(h.store.getEventConfig(doomed)).toBeUndefined();
    expect(h.store.countEventPhotos(doomed)).toBe(0);
    // Scoped, never a global purge.
    expect(h.store.countEventPhotos(keeper)).toBe(2);
    expect(h.store.getEventConfig(keeper)).toBeTruthy();
  });

  it('clears the pointer when the ACTIVE event is deleted, and screens fall back to the defaults', async () => {
    const h = build();
    const id = await createEvent(h, 'Sự kiện đang phát');
    await request(h.app).post(`/cms/api/events/${id}/activate`).set('Cookie', h.cookie).send({}).expect(200);

    await request(h.app)
      .post(`/cms/api/events/${id}/delete`)
      .set('Cookie', h.cookie)
      .send({ confirmName: 'Sự kiện đang phát' })
      .expect(200);

    expect(h.store.getActiveEventId()).toBeUndefined();
    const config = h.store.getActiveEventConfig();
    expect(config.id).toBeNull();
    expect(config.name).toBe(DEFAULT_EVENT_CONFIG.name);
    expect(config.fontChoice).toBe('system-ui');
  });

  it('never touches the queue when an event is deleted', async () => {
    const h = build();
    seedQueue(h.store, 2);
    const id = await createEvent(h, 'Sự kiện cũ');
    const before = dumpTables(h.store);

    await request(h.app)
      .post(`/cms/api/events/${id}/delete`)
      .set('Cookie', h.cookie)
      .send({ confirmName: 'Sự kiện cũ' })
      .expect(200);

    expect(dumpTables(h.store)).toEqual(before);
  });

  it('renders the UI-SPEC destructive confirmation copy on the delete page', async () => {
    const h = build();
    const id = await createEvent(h, 'Tiệc cưới B');

    const res = await request(h.app).get(`/cms/events/${id}/delete`).set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Toàn bộ cấu hình và lịch sử ảnh sẽ mất. Không thể hoàn tác.');
    expect(res.text).toContain('Xóa sự kiện');
  });
});
