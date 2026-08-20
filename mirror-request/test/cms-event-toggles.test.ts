import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import http from 'http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { LocalStore, DEFAULT_EVENT_CONFIG } from '../src/state/localStore';
import { createCmsIpGate } from '../src/cms/cmsIpGate';
import { createSessionStore, createRequireSession } from '../src/cms/cmsAuth';
import { createCmsEventRoutes } from '../src/cms/cmsEventRoutes';
import { SCREEN_URL_PATH, SLIDES_SCREEN_URL_PATH } from '../src/cms/cmsEventPages';
import { DisplayServer } from '../src/display/displayServer';
import type { QueueService } from '../src/queue/queueService';
import type { AgentServer } from '../src/agent/agentServer';
import type { DisplaySnapshot } from '../src/types';

// ---------------------------------------------------------------------------
// Plan 09-02 Task 1 — D9-04, D9-06: the two per-event toggles become controls
// an operator can actually use, and the CMS event-list page presents both
// screen addresses as two labeled types.
//
// The claim under test is SC-3 stated literally: an operator ticks or
// unticks either toggle in the existing form, saves, and the value reaches
// every connected screen with no reload. A test that stopped at the 200
// response would prove only half of that — the round trip is CMS to
// database to wire, so the wire-reaching case below drives a real
// DisplayServer and a real WebSocket client, exactly like
// cms-active-event-switch.test.ts's awaitSnapshot() proves the D-12 switch.
// ---------------------------------------------------------------------------

const WHITELISTED_IP = '10.0.0.5';
const SAVE_ERROR = 'Không lưu được cấu hình — vui lòng thử lại. Nếu vẫn lỗi, liên hệ kỹ thuật.';

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
  const store = new LocalStore(path.join(makeTmpDir('gsd-cms-toggles-'), 'test.sqlite'));
  openStores.push(store);
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
    createCmsEventRoutes(store, { uploadDir: makeTmpDir('gsd-cms-toggles-uploads-'), maxBytes: 5_242_880 }),
  );
  return { app, cookie: `cms_session=${token}`, store };
}

async function createEvent(h: Harness, name: string): Promise<string> {
  const res = await request(h.app).post('/cms/api/events').set('Cookie', h.cookie).send({ name });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

function makeMockQueue(store: LocalStore): Partial<QueueService> {
  return { getQueuePosition: () => undefined, getQueueLength: () => store.getQueueLength(), getAnnouncement: () => null };
}
function makeMockAgent(): Partial<AgentServer> {
  return { isAgentOnline: () => true };
}

async function startDisplay(store: LocalStore): Promise<{ port: number }> {
  const app = express();
  const server = http.createServer(app);
  openServers.push(server);
  const display = new DisplayServer(makeMockQueue(store) as QueueService, makeMockAgent() as AgentServer, store, {
    displayWhitelist: [],
    pollIntervalMs: 25,
  });
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
// The form renders both toggles, ticked to the stored value
// ---------------------------------------------------------------------------

describe('CMS event form — the two toggles render as checkboxes reflecting the stored value', () => {
  it('renders both checkboxes checked for a never-customized event (both default ON)', async () => {
    const h = build();
    const id = await createEvent(h, 'Sự kiện mặc định');
    const res = await request(h.app).get(`/cms/events/${id}`).set('Cookie', h.cookie);

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/<input id="show_guest_name" name="show_guest_name" type="checkbox" checked>/);
    expect(res.text).toMatch(/<input id="hero_enabled" name="hero_enabled" type="checkbox" checked>/);
  });

  it('renders a checkbox WITHOUT the checked attribute once a toggle is saved false', async () => {
    const h = build();
    const id = await createEvent(h, 'Sự kiện tắt tên');
    await request(h.app).post(`/cms/api/events/${id}`).set('Cookie', h.cookie).send({ show_guest_name: false }).expect(200);

    const res = await request(h.app).get(`/cms/events/${id}`).set('Cookie', h.cookie);
    expect(res.text).toMatch(/<input id="show_guest_name" name="show_guest_name" type="checkbox">/);
    expect(res.text).not.toMatch(/<input id="show_guest_name"[^>]*checked/);
    // The other toggle is untouched.
    expect(res.text).toMatch(/<input id="hero_enabled" name="hero_enabled" type="checkbox" checked>/);
  });

  it('renders both checkboxes checked again once both are saved true after being false', async () => {
    const h = build();
    const id = await createEvent(h, 'Sự kiện bật lại');
    await request(h.app)
      .post(`/cms/api/events/${id}`)
      .set('Cookie', h.cookie)
      .send({ show_guest_name: false, hero_enabled: false })
      .expect(200);
    await request(h.app)
      .post(`/cms/api/events/${id}`)
      .set('Cookie', h.cookie)
      .send({ show_guest_name: true, hero_enabled: true })
      .expect(200);

    const res = await request(h.app).get(`/cms/events/${id}`).set('Cookie', h.cookie);
    expect(res.text).toMatch(/<input id="show_guest_name" name="show_guest_name" type="checkbox" checked>/);
    expect(res.text).toMatch(/<input id="hero_enabled" name="hero_enabled" type="checkbox" checked>/);
  });

  it("asserts the rendered form's script contains a checkbox branch in collect() that reads the checked state", async () => {
    const h = build();
    const id = await createEvent(h, 'Sự kiện kiểm tra script');
    const res = await request(h.app).get(`/cms/events/${id}`).set('Cookie', h.cookie);

    const collectFn = res.text.slice(res.text.indexOf('function collect()'));
    const collectBody = collectFn.slice(0, collectFn.indexOf('return payload;'));
    expect(collectBody).toMatch(/input\.type\s*===\s*'checkbox'/);
    expect(collectBody).toMatch(/payload\[input\.name\]\s*=\s*input\.checked/);
    // The checkbox branch must run before the generic value-reading branch —
    // otherwise the checkbox's constant .value string would still win for
    // some other code path reading the same input.
    expect(collectBody.indexOf("input.type === 'checkbox'")).toBeLessThan(
      collectBody.indexOf("input.type === 'number'"),
    );
  });
});

// ---------------------------------------------------------------------------
// Saving persists the value, both directions
// ---------------------------------------------------------------------------

describe('CMS event save — both toggles persist in both directions', () => {
  it('saving show_guest_name=false persists it and reading it back returns false', async () => {
    const h = build();
    const id = await createEvent(h, 'Sự kiện A');

    const res = await request(h.app).post(`/cms/api/events/${id}`).set('Cookie', h.cookie).send({ show_guest_name: false });
    expect(res.status).toBe(200);
    expect(h.store.getEventConfig(id)!.showGuestName).toBe(false);
  });

  it('saving show_guest_name=true after false persists true', async () => {
    const h = build();
    const id = await createEvent(h, 'Sự kiện B');
    await request(h.app).post(`/cms/api/events/${id}`).set('Cookie', h.cookie).send({ show_guest_name: false }).expect(200);

    const res = await request(h.app).post(`/cms/api/events/${id}`).set('Cookie', h.cookie).send({ show_guest_name: true });
    expect(res.status).toBe(200);
    expect(h.store.getEventConfig(id)!.showGuestName).toBe(true);
  });

  it('saving hero_enabled=false persists it and reading it back returns false', async () => {
    const h = build();
    const id = await createEvent(h, 'Sự kiện C');

    const res = await request(h.app).post(`/cms/api/events/${id}`).set('Cookie', h.cookie).send({ hero_enabled: false });
    expect(res.status).toBe(200);
    expect(h.store.getEventConfig(id)!.heroEnabled).toBe(false);
  });

  it('saving hero_enabled=true after false persists true', async () => {
    const h = build();
    const id = await createEvent(h, 'Sự kiện D');
    await request(h.app).post(`/cms/api/events/${id}`).set('Cookie', h.cookie).send({ hero_enabled: false }).expect(200);

    const res = await request(h.app).post(`/cms/api/events/${id}`).set('Cookie', h.cookie).send({ hero_enabled: true });
    expect(res.status).toBe(200);
    expect(h.store.getEventConfig(id)!.heroEnabled).toBe(true);
  });

  it('saving both toggles false together leaves the rest of the config untouched', async () => {
    const h = build();
    const id = await createEvent(h, 'Sự kiện E');
    const before = h.store.getEventConfig(id)!;

    await request(h.app)
      .post(`/cms/api/events/${id}`)
      .set('Cookie', h.cookie)
      .send({ show_guest_name: false, hero_enabled: false })
      .expect(200);

    const after = h.store.getEventConfig(id)!;
    expect(after.showGuestName).toBe(false);
    expect(after.heroEnabled).toBe(false);
    expect(after.idleHeading).toBe(before.idleHeading);
    expect(after.colorAccent).toBe(before.colorAccent);
  });
});

// ---------------------------------------------------------------------------
// A save carrying anything other than a real boolean is refused WHOLE
// ---------------------------------------------------------------------------

describe('CMS event save — a bad value for either toggle refuses the WHOLE patch', () => {
  const BAD_VALUES: Array<[string, unknown]> = [
    ['a string "true"', 'true'],
    ['a string "false"', 'false'],
    ['the number 1', 1],
    ['the number 0', 0],
    ['null', null],
  ];

  it.each(BAD_VALUES)('refuses show_guest_name = %s with the standard save-error response, writing nothing', async (_label, bad) => {
    const h = build();
    const id = await createEvent(h, 'Sự kiện từ chối 1');
    const before = h.store.getEventConfig(id)!;

    const res = await request(h.app)
      .post(`/cms/api/events/${id}`)
      .set('Cookie', h.cookie)
      .send({ show_guest_name: bad, idle_heading: 'Sẽ không được lưu' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(SAVE_ERROR);
    expect(h.store.getEventConfig(id)).toEqual(before);
  });

  it.each(BAD_VALUES)('refuses hero_enabled = %s with the standard save-error response, writing nothing', async (_label, bad) => {
    const h = build();
    const id = await createEvent(h, 'Sự kiện từ chối 2');
    const before = h.store.getEventConfig(id)!;

    const res = await request(h.app)
      .post(`/cms/api/events/${id}`)
      .set('Cookie', h.cookie)
      .send({ hero_enabled: bad, idle_heading: 'Sẽ không được lưu' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(SAVE_ERROR);
    expect(h.store.getEventConfig(id)).toEqual(before);
  });

  it('a missing-but-present key (undefined via JSON omission of the field value) is simply not written, never a partial-write crash', async () => {
    // JSON has no way to send an explicit `undefined`; the closest reachable
    // shape of "present but no usable value" is the key absent from the body
    // entirely, which validateEventPatch() already treats as "leave alone" —
    // asserted here so a future change to the loop cannot regress it into
    // writing something.
    const h = build();
    const id = await createEvent(h, 'Sự kiện thiếu khoá');
    const before = h.store.getEventConfig(id)!;

    const res = await request(h.app).post(`/cms/api/events/${id}`).set('Cookie', h.cookie).send({ idle_heading: 'Giữ nguyên toggle' });

    expect(res.status).toBe(200);
    const after = h.store.getEventConfig(id)!;
    expect(after.showGuestName).toBe(before.showGuestName);
    expect(after.heroEnabled).toBe(before.heroEnabled);
  });
});

// ---------------------------------------------------------------------------
// The round trip: CMS save -> database -> a live WS /display snapshot
// ---------------------------------------------------------------------------

describe('CMS event save — a toggle reaches a live WS /display snapshot with no reload (SC-3)', () => {
  it('saving show_guest_name=false is carried to the next snapshot for the active event', async () => {
    const h = build();
    const id = await createEvent(h, 'Sự kiện đang phát');
    await request(h.app).post(`/cms/api/events/${id}/activate`).set('Cookie', h.cookie).send({}).expect(200);

    const { port } = await startDisplay(h.store);
    const ws = connectDisplayClient(port);
    await awaitSnapshot(ws, (snap) => snap.eventConfig.id === id);

    await request(h.app).post(`/cms/api/events/${id}`).set('Cookie', h.cookie).send({ show_guest_name: false }).expect(200);

    const after = await awaitSnapshot(ws, (snap) => snap.eventConfig.showGuestName === false);
    expect(after.eventConfig.id).toBe(id);
    expect(after.eventConfig.heroEnabled).toBe(true);
  });

  it('saving hero_enabled=false is carried to the next snapshot for the active event', async () => {
    const h = build();
    const id = await createEvent(h, 'Sự kiện đang phát 2');
    await request(h.app).post(`/cms/api/events/${id}/activate`).set('Cookie', h.cookie).send({}).expect(200);

    const { port } = await startDisplay(h.store);
    const ws = connectDisplayClient(port);
    await awaitSnapshot(ws, (snap) => snap.eventConfig.id === id);

    await request(h.app).post(`/cms/api/events/${id}`).set('Cookie', h.cookie).send({ hero_enabled: false }).expect(200);

    const after = await awaitSnapshot(ws, (snap) => snap.eventConfig.heroEnabled === false);
    expect(after.eventConfig.id).toBe(id);
    expect(after.eventConfig.showGuestName).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D9-06 — the event-list page presents BOTH screen addresses as two labeled
// types, inside the SAME fixed card (D-12: the count does not grow with the
// event list).
// ---------------------------------------------------------------------------

describe('CMS event list — the fixed screen-address card presents two labeled screen types (D9-06)', () => {
  it('labels the bare route "Loại 1 — Thứ tự + slide" and the slides route "Loại 2 — Chỉ slide"', async () => {
    const h = build();
    await createEvent(h, 'Sự kiện F');
    const res = await request(h.app).get('/cms/events').set('Cookie', h.cookie);

    expect(res.status).toBe(200);
    expect(res.text).toContain('Loại 1 — Thứ tự + slide');
    expect(res.text).toContain('Loại 2 — Chỉ slide');
    expect(SLIDES_SCREEN_URL_PATH).toBe('/display-screen?view=slides');
    expect(res.text).toContain(SCREEN_URL_PATH);
    expect(res.text).toContain(SLIDES_SCREEN_URL_PATH);
  });

  it('the slides URL is derived from the same fixed SCREEN_URL_PATH constant, not a second independent literal', () => {
    expect(SLIDES_SCREEN_URL_PATH.startsWith(SCREEN_URL_PATH)).toBe(true);
  });

  it('D-12 holds with the slides URL added: the screen-address occurrence count does not grow with the event list, and the slides URL count is identical between one and two events', async () => {
    const h = build();

    await createEvent(h, 'Sự kiện G1');
    const one = await request(h.app).get('/cms/events').set('Cookie', h.cookie);
    await createEvent(h, 'Sự kiện G2');
    const two = await request(h.app).get('/cms/events').set('Cookie', h.cookie);

    const count = (text: string): number => (text.match(/\/display-screen/g) ?? []).length;
    expect(count(one.text)).toBeGreaterThan(0);
    expect(count(two.text)).toBe(count(one.text));

    // The slides URL itself is fixed content (a <code> element plus its copy
    // button's script literal), so it appears the SAME number of times on
    // both pages — never per-event, which is the load-bearing property.
    const slidesCount = (text: string): number =>
      (text.match(new RegExp(SLIDES_SCREEN_URL_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;
    expect(slidesCount(one.text)).toBeGreaterThan(0);
    expect(slidesCount(two.text)).toBe(slidesCount(one.text));
  });
});

// ---------------------------------------------------------------------------
// Every pre-existing CMS event-configuration assertion still passes.
// Structural sanity: DEFAULT_EVENT_CONFIG still carries both toggles ON, so
// the harness above is exercising the real shipped defaults, not a stub.
// ---------------------------------------------------------------------------

describe('sanity — the shipped defaults this harness relies on', () => {
  it('both toggles default true', () => {
    expect(DEFAULT_EVENT_CONFIG.showGuestName).toBe(true);
    expect(DEFAULT_EVENT_CONFIG.heroEnabled).toBe(true);
  });
});
