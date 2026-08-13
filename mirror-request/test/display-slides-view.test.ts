import { afterEach, describe, expect, it } from 'vitest';
import http from 'http';
import express from 'express';
import request from 'supertest';
import { WebSocket } from 'ws';
import Database from 'better-sqlite3';
import { renderSlidesPage } from '../src/display/slidesPage';
import { renderDisplayPage } from '../src/display/displayPage';
import { DisplayServer } from '../src/display/displayServer';
import { LocalStore, DEFAULT_EVENT_CONFIG } from '../src/state/localStore';
import { clientIp, isWhitelisted } from '../src/security/ipAllowlist';
import type { QueueService } from '../src/queue/queueService';
import type { AgentServer } from '../src/agent/agentServer';
import type { DisplaySnapshot } from '../src/types';

/**
 * D9-01/D9-02/D9-03/D9-04/D9-05, end to end: the two new `event` columns
 * reach the wire, and `/display-screen?view=slides` renders from them — while
 * the bare route and every unknown `view` value render exactly what they
 * rendered before this phase.
 *
 * The `/display-screen` harness below reproduces app.ts's exact two-handler
 * chain (IP gate, then the view branch) rather than importing `createApp()`
 * wholesale, matching the established idiom in
 * test/display-access-control.test.ts.
 */

let storeCounter = 0;
function uniqueStorePath(): string {
  storeCounter += 1;
  return `./data/test-display-slides-${process.pid}-${Date.now()}-${storeCounter}.sqlite`;
}
const openStores: LocalStore[] = [];
function makeStore(): LocalStore {
  const store = new LocalStore(uniqueStorePath());
  openStores.push(store);
  return store;
}
const openServers: http.Server[] = [];

afterEach(async () => {
  while (openServers.length) {
    const server = openServers.pop();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  while (openStores.length) {
    try {
      openStores.pop()?.close();
    } catch {
      /* already closed */
    }
  }
});

/** The exact shape of app.ts's `/display-screen` two-handler chain: the IP
 * gate, then the view branch, in that order. */
function buildDisplayScreenApp(whitelist: string[], fakeIp: string): express.Express {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', { value: fakeIp, configurable: true });
    next();
  });
  app.get(
    '/display-screen',
    (req, res, next) => {
      const ip = clientIp(req);
      if (!isWhitelisted(ip, whitelist)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      next();
    },
    (req, res) => {
      const view = req.query.view;
      if (typeof view === 'string' && view === 'slides') {
        res.type('html').send(renderSlidesPage());
        return;
      }
      res.type('html').send(renderDisplayPage());
    },
  );
  return app;
}

/** Starts a real DisplayServer and returns the snapshot a freshly-connected
 * client actually receives — the same path a TV takes. */
async function firstSnapshot(store: LocalStore): Promise<DisplaySnapshot> {
  const server = http.createServer();
  openServers.push(server);
  const display = new DisplayServer(
    {
      getQueuePosition: () => undefined,
      getQueueLength: () => store.getQueueLength(),
      getAnnouncement: () => null,
    } as Partial<QueueService> as QueueService,
    { isAgentOnline: () => true } as Partial<AgentServer> as AgentServer,
    store,
    { displayWhitelist: [], pollIntervalMs: 10_000 },
  );
  display.start(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('missing server address');
      resolve(addr.port);
    });
  });

  const snapshot = await new Promise<DisplaySnapshot>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/display`);
    ws.once('message', (data) => {
      resolve(JSON.parse(data.toString()).data as DisplaySnapshot);
      ws.close();
    });
    ws.once('error', reject);
  });
  display.stop();
  return snapshot;
}

const SLIDES_HTML = renderSlidesPage();
const DEFAULT_HTML = renderDisplayPage();

describe('GET /display-screen?view=slides — serves the slides variant, byte for byte', () => {
  it('returns 200 HTML identical to renderSlidesPage()', async () => {
    const app = buildDisplayScreenApp(['198.51.100.5'], '198.51.100.5');
    const res = await request(app).get('/display-screen?view=slides');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('html');
    expect(res.text).toBe(SLIDES_HTML);
  });

  it('the bare route still returns renderDisplayPage() byte for byte (D9-02)', async () => {
    const app = buildDisplayScreenApp(['198.51.100.5'], '198.51.100.5');
    const res = await request(app).get('/display-screen');
    expect(res.status).toBe(200);
    expect(res.text).toBe(DEFAULT_HTML);
  });
});

describe('GET /display-screen — every unknown view value falls back to the default page (D9-03, SC-5)', () => {
  const cases = [
    ['?view=queue', '/display-screen?view=queue'],
    ['?view= (empty)', '/display-screen?view='],
    ['?view=SLIDES (wrong case)', '/display-screen?view=SLIDES'],
    ['?view=slides%20 (trailing space)', '/display-screen?view=slides%20'],
    ['?view=__proto__', '/display-screen?view=__proto__'],
    ['?view=slides&view=queue (repeated param, becomes an array)', '/display-screen?view=slides&view=queue'],
  ] as const;

  it.each(cases)('%s renders the default page byte-for-byte, never the slides page and never an error', async (_label, path) => {
    const app = buildDisplayScreenApp(['198.51.100.5'], '198.51.100.5');
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
    expect(res.text).toBe(DEFAULT_HTML);
    expect(res.text).not.toBe(SLIDES_HTML);
  });
});

describe('GET /display-screen — the allow-list gate applies identically to both variants (T-09-01)', () => {
  function expectForbidden(res: request.Response): void {
    expect(res.status).toBe(403);
    expect(Object.keys(res.body)).toEqual(['error']);
    expect(res.body.error).toBe('Forbidden');
  }

  it('a non-whitelisted peer gets the identical generic 403 for the bare URL and for ?view=slides', async () => {
    const app = buildDisplayScreenApp(['203.0.113.9'], '198.51.100.5');
    const bare = await request(app).get('/display-screen');
    const slides = await request(app).get('/display-screen?view=slides');
    expectForbidden(bare);
    expectForbidden(slides);
    expect(bare.status).toBe(slides.status);
    expect(bare.body).toEqual(slides.body);
  });
});

describe('Slides screen — carries no queue region and no queue metadata of any kind (SC-1, T-09-07)', () => {
  it('renders no aside, no queue list, no sidebar heading, no queue-count copy, no queue-shaped snapshot reference', () => {
    expect(SLIDES_HTML).not.toMatch(/<aside/);
    expect(SLIDES_HTML).not.toContain('id="queue"');
    expect(SLIDES_HTML).not.toContain('queueMeta');
    expect(SLIDES_HTML).not.toContain('Thứ tự tiếp theo');
    expect(SLIDES_HTML).not.toMatch(/upNext|queueLength/);
  });
});

describe('Slides screen — full-bleed photo surface, no per-screen identity, argument-free render', () => {
  it('renderSlidesPage() takes zero arguments and is byte-stable across calls', () => {
    expect(renderSlidesPage.length).toBe(0);
    expect(renderSlidesPage()).toBe(SLIDES_HTML);
    expect(renderSlidesPage()).toBe(renderSlidesPage());
  });

  it('carries data-view="slides" on the body and no layout_style token', () => {
    expect(SLIDES_HTML).toContain('data-view="slides"');
  });
});

describe('Slides screen — the same self-hosted fonts and no CDN (T-08-SC)', () => {
  const FILES = ['be-vietnam-pro-400', 'be-vietnam-pro-700', 'lora-400', 'lora-700'];

  it('declares exactly four @font-face rules, all four woff2 paths, no CDN link, weights 400/700 only', () => {
    const faces = SLIDES_HTML.match(/@font-face/g) ?? [];
    expect(faces).toHaveLength(4);
    for (const file of FILES) expect(SLIDES_HTML).toContain(`/assets/fonts/${file}.woff2`);
    expect(SLIDES_HTML).not.toMatch(/<link[^>]+href=["']https?:/);
    const weights = new Set([...SLIDES_HTML.matchAll(/font-weight:\s*(\d{3})/g)].map((m) => m[1]));
    expect([...weights].sort()).toEqual(['400', '700']);
  });
});

describe('Slides screen — D-07, a dropped feed never blanks the wall', () => {
  it('never clears the stage on close — the banner is additive to the rendered content', () => {
    const closeHandler = SLIDES_HTML.slice(SLIDES_HTML.indexOf('onclose'), SLIDES_HTML.indexOf('onclose') + 400);
    expect(closeHandler).not.toMatch(/hero\.innerHTML\s*=/);
    expect(closeHandler).not.toMatch(/renderIdle|clearStage/);
  });

  it('declares the reconnect banner copy and a backoff that grows', () => {
    expect(SLIDES_HTML).toContain('Mất kết nối — đang thử kết nối lại…');
    expect(SLIDES_HTML).toMatch(/Math\.min\(/);
    expect(SLIDES_HTML).toMatch(/retryDelay|backoff/i);
  });
});

describe('Slides screen — UI-01, the idle backstop renders in the first bytes', () => {
  it('the server-rendered idle strings equal the shipped defaults and sit inside the stage element', () => {
    const stageStart = SLIDES_HTML.indexOf('class="stage"');
    expect(stageStart).toBeGreaterThan(-1);
    expect(SLIDES_HTML).toContain(`>${DEFAULT_EVENT_CONFIG.idleHeading}<`);
    expect(SLIDES_HTML).toContain(`>${DEFAULT_EVENT_CONFIG.qrCtaText}<`);
    expect(SLIDES_HTML.indexOf(DEFAULT_EVENT_CONFIG.idleHeading)).toBeGreaterThan(stageStart);
    expect(SLIDES_HTML.indexOf(DEFAULT_EVENT_CONFIG.qrCtaText)).toBeGreaterThan(stageStart);
  });

  it('carries no spinner and no error copy in the pre-snapshot markup', () => {
    expect(SLIDES_HTML).not.toMatch(/Đang tải|Lỗi|Không thể tải/);
  });
});

describe('Wire — the two new toggles reach a live WS client (D9-04)', () => {
  it('a freshly created, uncustomized active event reads both toggles ON', async () => {
    const store = makeStore();
    const event = store.createEvent({ name: 'Sự kiện chưa tuỳ chỉnh' });
    store.setActiveEvent(event.id);

    const snapshot = await firstSnapshot(store);
    expect(snapshot.eventConfig.showGuestName).toBe(true);
    expect(snapshot.eventConfig.heroEnabled).toBe(true);
    expect(typeof snapshot.eventConfig.showGuestName).toBe('boolean');
    expect(typeof snapshot.eventConfig.heroEnabled).toBe('boolean');
  });

  it('a brand-new LocalStore on a fresh file has both event columns defaulting to 1', () => {
    const store = makeStore();
    const raw = (store as unknown as { db: { prepare: (sql: string) => { all: () => Array<{ name: string; dflt_value: string }> } } }).db
      .prepare("PRAGMA table_info('event')")
      .all();
    const showGuestName = raw.find((c) => c.name === 'show_guest_name');
    const heroEnabled = raw.find((c) => c.name === 'hero_enabled');
    expect(showGuestName?.dflt_value).toBe('1');
    expect(heroEnabled?.dflt_value).toBe('1');
  });

  it('DEFAULT_EVENT_CONFIG carries both toggles as true', () => {
    expect(DEFAULT_EVENT_CONFIG.showGuestName).toBe(true);
    expect(DEFAULT_EVENT_CONFIG.heroEnabled).toBe(true);
  });

  it('getEventConfig/getActiveEventConfig project both as true for a never-customized event', () => {
    const store = makeStore();
    const event = store.createEvent({ name: 'Sự kiện mặc định' });
    store.setActiveEvent(event.id);

    const byId = store.getEventConfig(event.id);
    expect(byId?.showGuestName).toBe(true);
    expect(byId?.heroEnabled).toBe(true);

    const active = store.getActiveEventConfig();
    expect(active.showGuestName).toBe(true);
    expect(active.heroEnabled).toBe(true);
  });

  it('a column holding 0 projects to false; a column somehow holding NULL projects to the shipped default', () => {
    const store = makeStore();
    const event = store.createEvent({ name: 'Sự kiện đã chỉnh' });
    store.updateEvent(event.id, { show_guest_name: 0, hero_enabled: 0 });
    const off = store.getEventConfig(event.id);
    expect(off?.showGuestName).toBe(false);
    expect(off?.heroEnabled).toBe(false);

    // A genuine NULL is unreachable through this store's own write path —
    // updateEvent()'s SET clause and the column's own NOT NULL constraint
    // both refuse it, which is exactly what makes toEventConfig()'s
    // null-coalescing defence-in-depth rather than a reachable state. Proved
    // directly against a table built with both columns left NULLABLE — the
    // shape a hand-edited or pre-constraint row could carry — rather than
    // asserted against this store's own schema.
    const rawPath = uniqueStorePath();
    const raw = new Database(rawPath);
    raw.exec(`
      CREATE TABLE event (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, logo_url TEXT, background_url TEXT,
        color_dominant TEXT, color_secondary TEXT, color_accent TEXT, color_text TEXT,
        color_text_muted TEXT, font_choice TEXT NOT NULL DEFAULT 'system-ui',
        idle_heading TEXT, idle_sub TEXT, qr_image_url TEXT, qr_cta_text TEXT,
        photo_count INTEGER, photo_duration_ms INTEGER,
        layout_style TEXT NOT NULL DEFAULT 'stage_sidebar',
        show_guest_name INTEGER, hero_enabled INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
    `);
    const now = Date.now();
    raw
      .prepare(
        `INSERT INTO event (id, name, show_guest_name, hero_enabled, created_at, updated_at)
         VALUES (?, ?, NULL, NULL, ?, ?)`,
      )
      .run('evt-null-toggle', 'Sự kiện NULL', now, now);
    raw.close();

    // Reopening through LocalStore: migrate() sees both columns already
    // present via PRAGMA table_info and skips the ALTER, so they stay
    // nullable and the seeded row's NULLs survive untouched.
    const reopened = new LocalStore(rawPath);
    openStores.push(reopened);
    const nulled = reopened.getEventConfig('evt-null-toggle');
    expect(nulled?.showGuestName).toBe(true);
    expect(nulled?.heroEnabled).toBe(true);
  });
});
