import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import http from 'http';
import { WebSocket } from 'ws';
import { renderDisplayPage } from '../src/display/displayPage';
import { DisplayServer } from '../src/display/displayServer';
import { LocalStore, DEFAULT_EVENT_CONFIG } from '../src/state/localStore';
import type { QueueService } from '../src/queue/queueService';
import type { AgentServer } from '../src/agent/agentServer';

/**
 * UI-01, and it is a phase success criterion rather than a nicety: the room
 * screen must be RIGHT the moment a TV is pointed at it — before any guest has
 * registered, before any webhook has fired, before an operator has created a
 * single event.
 *
 * The failure this pins is not a crash. It is the screen that renders blank,
 * or renders a spinner, or renders an error, because nothing has happened yet.
 * "Nobody yet" and "broken" must never look alike to a guest walking past.
 *
 * Every case here therefore runs against a store with literally zero rows in
 * every table.
 */

let storeCounter = 0;
function uniqueStorePath(): string {
  storeCounter += 1;
  return `./data/test-display-idle-${process.pid}-${Date.now()}-${storeCounter}.sqlite`;
}
const openStores: LocalStore[] = [];
function makeStore(): LocalStore {
  const store = new LocalStore(uniqueStorePath());
  openStores.push(store);
  return store;
}

afterEach(() => {
  while (openStores.length) {
    try {
      openStores.pop()?.close();
    } catch {
      /* already closed */
    }
  }
});

/** index.ts's /display-screen handler, minus the IP gate that
 * display-access-control.test.ts already owns. */
function buildApp(): express.Express {
  const app = express();
  app.get('/display-screen', (_req, res) => res.type('html').send(renderDisplayPage()));
  return app;
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('missing server address');
      resolve(addr.port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function firstMessage(url: string): Promise<{ type: string; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('message', (data) => {
      resolve(JSON.parse(data.toString()));
      ws.close();
    });
    ws.once('error', reject);
  });
}

describe('UI-01 — the room screen is correct on a completely empty database', () => {
  it('serves 200 HTML carrying the idle heading and the QR CTA before any guest exists', async () => {
    const res = await request(buildApp()).get('/display-screen');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    // The shipped defaults, present in the FIRST bytes the browser receives —
    // not fetched, not filled in by the first snapshot. This is what makes the
    // pre-snapshot window (UI-SPEC's "loading / initial WS connect" backstop)
    // show the standby state rather than blank or unstyled markup.
    expect(res.text).toContain('Sẵn sàng chụp ảnh cùng bạn');
    expect(res.text).toContain('Quét mã QR bên dưới để đăng ký');
  });

  it('carries no spinner, no error copy, and no empty stage in the pre-snapshot markup', async () => {
    const res = await request(buildApp()).get('/display-screen');

    // "Nobody yet" must not be dressed as a fault or as work-in-progress.
    expect(res.text).not.toMatch(/Đang tải|Lỗi|Không thể tải/);
    // The idle copy is inside the stage element, not appended after it — a
    // page whose stage is empty until a snapshot lands is the UI-01 failure.
    const stageStart = res.text.indexOf('class="stage"');
    expect(stageStart).toBeGreaterThan(-1);
    expect(res.text.indexOf('Sẵn sàng chụp ảnh cùng bạn')).toBeGreaterThan(stageStart);
  });

  it('builds a complete snapshot from an empty store, with the shipped defaults and no error state', async () => {
    const store = makeStore();
    const server = http.createServer();
    const display = new DisplayServer(
      {
        getQueuePosition: () => undefined,
        getQueueLength: () => 0,
        getAnnouncement: () => null,
      } as Partial<QueueService> as QueueService,
      { isAgentOnline: () => false } as Partial<AgentServer> as AgentServer,
      store,
      { displayWhitelist: [], pollIntervalMs: 10_000 },
    );
    display.start(server);
    const port = await listen(server);

    const msg = await firstMessage(`ws://127.0.0.1:${port}/display`);

    // Zero rows in every table, and every field is still a usable value.
    expect(msg.data.queueLength).toBe(0);
    expect(msg.data.upNext).toEqual([]);
    expect(msg.data.guestName).toBeNull();
    expect(msg.data.justCaptured).toBeNull();
    expect(msg.data.photos).toEqual([]);
    expect(msg.data.boothState).toBe('IDLE');
    // eventConfig is never null — no event exists, so the screen runs on the
    // shipped defaults, and `id: null` is a steady state and not an error.
    expect(msg.data.eventConfig).toMatchObject({
      id: null,
      idleHeading: DEFAULT_EVENT_CONFIG.idleHeading,
      idleSub: DEFAULT_EVENT_CONFIG.idleSub,
      photoCount: DEFAULT_EVENT_CONFIG.photoCount,
      photoDurationMs: DEFAULT_EVENT_CONFIG.photoDurationMs,
      layoutStyle: 'stage_sidebar',
      // D999.1-08: the no-event display feed retains all caption defaults.
      guestNameTemplate: DEFAULT_EVENT_CONFIG.guestNameTemplate,
      captionPosition: DEFAULT_EVENT_CONFIG.captionPosition,
      photoFit: DEFAULT_EVENT_CONFIG.photoFit,
    });

    display.stop();
    await closeServer(server);
  });

  it('renders the same page for every screen, with no per-screen identity in it (D-12)', () => {
    const html = renderDisplayPage();
    // Two calls, byte-identical: no token, slug, screen id or query parameter
    // is minted per render. Re-pointing a TV is a CMS action, not a URL edit.
    expect(renderDisplayPage()).toBe(html);
    expect(html).not.toMatch(/screenId|screen_token|eventSlug/);
  });
});
