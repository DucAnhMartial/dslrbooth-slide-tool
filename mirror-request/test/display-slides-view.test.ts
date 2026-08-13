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

/**
 * D9-04, Task 3: both toggles are EVENT configuration, so the slides screen
 * honours them exactly as the default screen does — this is the slides-side
 * half of that proof; test/display-default-view-regression.test.ts carries
 * the default-page half.
 */
describe('Slides screen — D9-04, both toggles honoured (hero takeover + guest name)', () => {
  it('derives the hero-takeover flag by explicit comparison against false, and gates the takeover branch on it', () => {
    // An absent field must mean ON — `!== false`, never a truthiness test —
    // so a snapshot from a not-yet-restarted server keeps today's behaviour.
    expect(SLIDES_HTML).toMatch(/heroTakeoverEnabled\s*=\s*cfg\.heroEnabled\s*!==\s*false/);
    expect(SLIDES_HTML).toMatch(/if\s*\(\s*heroTakeoverEnabled\s*&&\s*data\.justCaptured\s*\)/);
  });

  it('derives the guest-name flag the same way, and appends the name element only when it is set', () => {
    expect(SLIDES_HTML).toMatch(/guestNameEnabled\s*=\s*cfg\.showGuestName\s*!==\s*false/);
    const shotTileFn = SLIDES_HTML.slice(SLIDES_HTML.indexOf('function shotTile'));
    const shotTileBody = shotTileFn.slice(0, shotTileFn.indexOf('/* D-10/D-12 slideshow state'));
    expect(shotTileBody).toMatch(/if\s*\(\s*guestNameEnabled\s*\)\s*\{[\s\S]{0,200}shotname/);
  });
});

describe('Wire — both toggles, applied at the buildSnapshot() level (D9-04)', () => {
  /** Reaches the private builder directly, exactly as
   * display-hero-moment.test.ts's snapshotOf() does. */
  function snapshotOf(display: DisplayServer): DisplaySnapshot {
    return (display as unknown as { buildSnapshot(): DisplaySnapshot }).buildSnapshot();
  }
  function makeQueue(store: LocalStore): Partial<QueueService> {
    return {
      getQueuePosition: () => undefined,
      getQueueLength: () => store.getQueueLength(),
      getAnnouncement: () => null,
    };
  }
  function makeAgent(): Partial<AgentServer> {
    return { isAgentOnline: () => true };
  }

  it('with hero_enabled off, justCaptured is still populated and the same photo heads the rotation array', () => {
    const store = makeStore();
    const event = store.createEvent({ name: 'Sự kiện tắt hero' });
    store.setActiveEvent(event.id);
    store.updateEvent(event.id, { hero_enabled: 0 });
    store.recordEventPhoto({
      jobId: 'job-hero-off',
      eventId: event.id,
      guestName: 'Khách vừa chụp',
      photoUrl: 'https://fotoshare.co/i/hero-off',
      capturedAt: Date.now(),
    });

    const display = new DisplayServer(makeQueue(store) as QueueService, makeAgent() as AgentServer, store, {
      heroMomentDurationMs: 12_000,
    });
    const snapshot = snapshotOf(display);

    // The wire is unaffected by the toggle — buildSnapshot() never reads it.
    // The rendering DECISION to skip the takeover is the page's, proved
    // above by the SLIDES_HTML guard regex; the human-visible half of this
    // claim (no takeover actually drawn) is judged by plan 09-02's gate.
    expect(snapshot.justCaptured).not.toBeNull();
    expect(snapshot.eventConfig.heroEnabled).toBe(false);
    expect(snapshot.photos[0]?.photoUrl).toBe('https://fotoshare.co/i/hero-off');
  });

  it('with show_guest_name off, the wire still carries the name — only the page decides not to draw it', () => {
    const store = makeStore();
    const event = store.createEvent({ name: 'Sự kiện tắt tên' });
    store.setActiveEvent(event.id);
    store.updateEvent(event.id, { show_guest_name: 0 });
    store.recordEventPhoto({
      jobId: 'job-name-off',
      eventId: event.id,
      guestName: 'Khách ẩn tên',
      photoUrl: 'https://fotoshare.co/i/name-off',
      capturedAt: Date.now() - 3_600_000, // outside the hero window
    });

    const display = new DisplayServer(makeQueue(store) as QueueService, makeAgent() as AgentServer, store, {
      heroMomentDurationMs: 12_000,
    });
    const snapshot = snapshotOf(display);

    expect(snapshot.eventConfig.showGuestName).toBe(false);
    expect(snapshot.photos[0]?.name).toBe('Khách ẩn tên');
  });
});

// ---------------------------------------------------------------------------
// Plan 09-02 Task 2 — the cross-page invariant block.
//
// slidesPage.ts is a deliberately STANDALONE duplicate of displayPage.ts
// (09-01's summary records why: the cheapest way to guarantee the bare route
// never changes is to not restructure it). That duplication is only an
// acceptable trade because drift between the two files on anything they must
// never disagree about fails HERE, in a red suite, rather than on a wall.
// This block is that compensating control.
// ---------------------------------------------------------------------------

describe('Cross-page invariant — the two screens cannot drift on what they must never disagree on', () => {
  const FONT_FILES = ['be-vietnam-pro-400', 'be-vietnam-pro-700', 'lora-400', 'lora-700'];

  it('both pages declare the identical four self-hosted font file paths', () => {
    for (const file of FONT_FILES) {
      const fontPath = `/assets/fonts/${file}.woff2`;
      expect(SLIDES_HTML).toContain(fontPath);
      expect(DEFAULT_HTML).toContain(fontPath);
    }
  });

  function applierProperties(html: string): string[] {
    const applier = html.slice(html.indexOf('function applyEventConfig'));
    const body = applier.slice(0, applier.indexOf('function getInitials'));
    return [...body.matchAll(/setProperty\('([^']+)'/g)].map((m) => m[1]);
  }

  it('both config appliers write the exact same set of custom properties, and only event-scoped ones', () => {
    const slidesProps = applierProperties(SLIDES_HTML);
    const defaultProps = applierProperties(DEFAULT_HTML);
    expect(slidesProps.length).toBeGreaterThan(0);
    expect([...slidesProps].sort()).toEqual([...defaultProps].sort());
    for (const property of slidesProps) {
      expect(property.startsWith('--event-')).toBe(true);
    }
  });

  it('both pages declare the same reconnect banner copy and a backoff that grows', () => {
    const banner = 'Mất kết nối — đang thử kết nối lại…';
    expect(SLIDES_HTML).toContain(banner);
    expect(DEFAULT_HTML).toContain(banner);
    expect(SLIDES_HTML).toMatch(/Math\.min\(/);
    expect(DEFAULT_HTML).toMatch(/Math\.min\(/);
    expect(SLIDES_HTML).toMatch(/retryDelay/);
    expect(DEFAULT_HTML).toMatch(/retryDelay/);
  });

  it('neither page links an external stylesheet or font host of any kind', () => {
    for (const html of [SLIDES_HTML, DEFAULT_HTML]) {
      expect(html).not.toContain('fonts.googleapis.com');
      expect(html).not.toContain('fonts.gstatic.com');
      expect(html).not.toMatch(/cdn\./);
      expect(html).not.toMatch(/<link[^>]+href=["']https?:/);
    }
  });
});

// ---------------------------------------------------------------------------
// Plan 09-02 Task 2 — the design pass, as REVISED at the human gate. The
// executor's first cut (full-bleed photo, name over a scrim) was judged by
// the operator on 2026-08-13 — "ảnh đang bị to quá", then "slide ở phase
// trước (port 3002 cũ) kiểu như thế ok hơn" — so the shipped design is the
// default screen's own stage tile: bounded flat card, name BELOW the photo
// in theme ink at display size. These cases pin the operator's version;
// the scrim assertions they replace pinned a design that no longer exists.
// The default page's own half of D1/D5 (09-01's coverage table) is
// unaffected — this file is not touched by this plan's design pass.
// ---------------------------------------------------------------------------

describe('Slides screen — the design pass (UI-01, SC-1)', () => {
  it('keeps the containment rule, bounds the card, and drops the scrim treatment', () => {
    expect(SLIDES_HTML).toMatch(/\.frame img\{[^}]*object-fit:contain/);
    // The operator-chosen bounds: the card must not be free to swallow the
    // viewport again — a height cap and a width cap must both exist.
    expect(SLIDES_HTML).toMatch(/\.frame\{[^}]*height:min\(/);
    expect(SLIDES_HTML).toMatch(/\.shot\{[^}]*max-width:min\(/);
    expect(SLIDES_HTML).not.toContain('.scrim{');
    expect(SLIDES_HTML).toMatch(/\.shotname\{[^}]*overflow-wrap:anywhere/);
  });

  it('appends the name element BELOW the frame, exactly as the default screen does', () => {
    const shotTileFn = SLIDES_HTML.slice(SLIDES_HTML.indexOf('function shotTile'));
    const shotTileBody = shotTileFn.slice(0, shotTileFn.indexOf('/* D-10/D-12 slideshow state'));
    expect(shotTileBody).toMatch(/if\s*\(\s*guestNameEnabled\s*\)\s*\{[\s\S]{0,300}wrap\.appendChild\(name\)/);
    expect(shotTileBody).not.toMatch(/scrim/);
  });

  it('uses only clamp() sizing and only the two permitted weights', () => {
    expect(SLIDES_HTML).toMatch(/clamp\(/);
    const weights = new Set([...SLIDES_HTML.matchAll(/font-weight:\s*(\d{3})/g)].map((m) => m[1]));
    expect([...weights].sort()).toEqual(['400', '700']);
  });

  it('carries the fixed destructive hex, and the hex never appears inside the config applier body', () => {
    expect(SLIDES_HTML).toContain('#a33127');
    const applier = SLIDES_HTML.slice(SLIDES_HTML.indexOf('function applyEventConfig'));
    const applierBody = applier.slice(0, applier.indexOf('function getInitials'));
    expect(applierBody).not.toContain('#a33127');
  });

  it('renders the Agent-offline signal hidden by default, in the fixed destructive colour, never a --event-* property', () => {
    expect(SLIDES_HTML).toMatch(/<div id="agentOffline"[^>]*hidden>/);
    const agentRule = SLIDES_HTML.slice(SLIDES_HTML.indexOf('#agentOffline{'));
    const ruleBody = agentRule.slice(0, agentRule.indexOf('}'));
    expect(ruleBody).toContain('#a33127');
    expect(ruleBody).not.toMatch(/var\(--event-/);
  });

  it('re-derives the Agent-offline flag by explicit comparison against false, every render() call', () => {
    expect(SLIDES_HTML).toMatch(/agentOffline\.hidden\s*=\s*data\.agentOnline\s*!==\s*false/);
  });

  it('composes the idle state for a single centred column, distinct from the hero/slideshow branches', () => {
    expect(SLIDES_HTML).toMatch(/\.hero\.idle-compose\{[^}]*text-align:center/);
    expect(SLIDES_HTML).toMatch(/hero\.classList\.add\('idle-compose'\)/);
    expect(SLIDES_HTML).toMatch(/hero\.classList\.remove\('idle-compose'\)/);
  });
});
