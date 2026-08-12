import { afterEach, describe, expect, it } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { renderDisplayPage } from '../src/display/displayPage';
import { DisplayServer } from '../src/display/displayServer';
import { LocalStore } from '../src/state/localStore';
import type { QueueService } from '../src/queue/queueService';
import type { AgentServer } from '../src/agent/agentServer';
import type { DisplaySnapshot } from '../src/types';

/**
 * The Room Screen's UI-SPEC contract, in the two places it can actually be
 * checked without a DOM: the SERVED HTML (structure, copy, colour and overflow
 * rules — no browser needed to read them, and no jsdom dependency added to
 * read them with) and the SNAPSHOT reaching a live WS client (the data every
 * state renders from).
 *
 * What this file deliberately does not claim: that the pixels are legible from
 * across a room. That is UI-01's manual judgement and is deferred to the phase
 * gate in plan 08-06. What it does claim is that every state the UI-SPEC names
 * has markup and data behind it, and that the operational signals cannot be
 * themed away.
 */

let storeCounter = 0;
function uniqueStorePath(): string {
  storeCounter += 1;
  return `./data/test-display-room-${process.pid}-${Date.now()}-${storeCounter}.sqlite`;
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

function makeQueue(store: LocalStore): Partial<QueueService> {
  return {
    getQueuePosition: () => undefined,
    getQueueLength: () => store.getQueueLength(),
    getAnnouncement: () => null,
  };
}

/** Starts a real DisplayServer and returns the snapshot a freshly-connected
 * client actually receives — the same path a TV takes. */
async function firstSnapshot(store: LocalStore): Promise<DisplaySnapshot> {
  const server = http.createServer();
  openServers.push(server);
  const display = new DisplayServer(
    makeQueue(store) as QueueService,
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

function seedActiveEvent(store: LocalStore): string {
  const event = store.createEvent({ name: 'Tiệc cưới Ánh & Dương' });
  store.setActiveEvent(event.id);
  return event.id;
}

function seedPhotos(store: LocalStore, eventId: string, count: number, baseAt = Date.now() - 3_600_000): void {
  for (let i = 0; i < count; i += 1) {
    store.recordEventPhoto({
      jobId: `job-photo-${i}`,
      eventId,
      guestName: `Khách số ${i}`,
      photoUrl: `https://fotoshare.co/i/photo-${i}`,
      capturedAt: baseAt + i * 1_000,
    });
  }
}

function seedGuest(store: LocalStore, id: string, name: string): void {
  store.upsertRegistration({
    id,
    name,
    email: '',
    phone: '',
    mode: 'standard',
    registered_at: new Date().toISOString(),
  });
  store.enqueueJob({ id, queued_at: Date.now() });
}

const HTML = renderDisplayPage();

describe('Room Screen — layout and the one shipped layout_style', () => {
  it('declares the stage+sidebar grid and a single-column collapse breakpoint', () => {
    expect(HTML).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    // The documented collapse: below the breakpoint the sidebar stops being a
    // second column. Both halves are asserted so a media query that exists but
    // does nothing cannot pass.
    expect(HTML).toMatch(/@media\s*\(max-width:\s*\d+px\)/);
    expect(HTML).toMatch(/grid-template-columns:\s*1fr/);
  });

  it('handles exactly the one shipped layout_style value and nothing else', () => {
    // UI-SPEC Open Question 2 (answered): the field exists so later layouts
    // need no schema migration, but only stage_sidebar ships. A second branch
    // here would be a test matrix for a layout that does not exist.
    expect(HTML).toContain('stage_sidebar');
    expect(HTML).not.toMatch(/photo_grid|full_bleed|split_screen/);
  });

  it('uses the fluid outer margin the incumbents prove, not a fixed pixel token', () => {
    expect(HTML).toContain('4.5vw');
  });
});

describe('Room Screen — the states the UI-SPEC names', () => {
  it('carries a branch for every stage state: idle, announcing, capturing, hero and slideshow', () => {
    expect(HTML).toContain('Sẵn sàng chụp ảnh cùng bạn'); // idle (UI-01)
    expect(HTML).toContain('Xin mời'); // announcing
    expect(HTML).toContain('Đang chụp ảnh'); // capturing
    expect(HTML).toContain('justCaptured'); // hero (D-09)
    expect(HTML).toContain('photos'); // slideshow (D-10)
  });

  it('carries the countdown instruction copy the UI-SPEC fixes', () => {
    expect(HTML).toContain('Chuẩn bị trước máy ảnh — phiên chụp sắp bắt đầu.');
  });
});

describe('Room Screen — D-07, a dropped feed never blanks the wall', () => {
  it('declares the reconnect banner copy and a backoff that grows', () => {
    expect(HTML).toContain('Mất kết nối — đang thử kết nối lại…');
    // The retry delay must GROW. The incumbent's single fixed
    // setTimeout(connect, 1500) is what this replaces, so a page still
    // carrying only that literal has not implemented D-07's backoff.
    expect(HTML).toMatch(/Math\.min\(/);
    expect(HTML).toMatch(/retryDelay|backoff/i);
  });

  it('never clears the stage on close — the banner is additive to the rendered content', () => {
    // The close handler must not reset the stage. Any of these inside the
    // onclose path would wipe a guest's own photo off the wall during a
    // three-second service restart, which is exactly what D-07 forbids.
    const closeHandler = HTML.slice(HTML.indexOf('onclose'), HTML.indexOf('onclose') + 400);
    expect(closeHandler).not.toMatch(/hero\.innerHTML\s*=/);
    expect(closeHandler).not.toMatch(/renderIdle|clearStage/);
  });
});

describe('Room Screen — operational colours are fixed, never themeable (T-08-12)', () => {
  it('renders both Agent states in their fixed colours', () => {
    expect(HTML).toContain('● Agent mất kết nối');
    expect(HTML).toContain('● Agent đang kết nối');
    expect(HTML).toContain('#a33127');
    expect(HTML).toContain('#34d399');
  });

  it('excludes the two operational hexes from every custom property the config applier writes', () => {
    // The applier is an explicit allow-list of setProperty() calls. Whatever
    // it writes is what an event can recolour; the two operational roles must
    // not be reachable from it, so branding can never make a fault look
    // normal.
    const applier = HTML.slice(HTML.indexOf('function applyEventConfig'));
    const applierBody = applier.slice(0, applier.indexOf('function render'));
    const written = [...applierBody.matchAll(/setProperty\('([^']+)'/g)].map((m) => m[1]);

    expect(written.length).toBeGreaterThan(0);
    expect(written).not.toContain('--status-offline');
    expect(written).not.toContain('--status-online');
    for (const property of written) {
      expect(property.startsWith('--event-')).toBe(true);
    }
    // And the fixed values are not inside the applier at all.
    expect(applierBody).not.toContain('#a33127');
    expect(applierBody).not.toContain('#34d399');
  });
});

describe('Room Screen — overflow and long Vietnamese names', () => {
  it('shrinks the hero name to fit and truncates sidebar rows instead', () => {
    expect(HTML).toContain('overflow-wrap:anywhere');
    expect(HTML).toContain('text-overflow:ellipsis');
    // The full name stays reachable on a truncated row.
    expect(HTML).toMatch(/\.title\s*=|title=/);
  });

  it('caps the sidebar list height and scrolls rather than growing the page', () => {
    expect(HTML).toContain('overflow-y:auto');
    expect(HTML).toMatch(/max-height:/);
  });

  it('keeps a long diacritic-heavy name intact on the wire for the hero to size', async () => {
    const store = makeStore();
    const longName = 'Nguyễn Hoàng Thị Phương Quỳnh Diễm Kiều Trang';
    expect(longName.length).toBeGreaterThan(40);
    seedGuest(store, 'job-long', longName);

    const snapshot = await firstSnapshot(store);
    // Not truncated server-side: shrinking is the screen's job, and a name cut
    // in the projection could never be recovered by CSS.
    expect(snapshot.guestName).toBe(longName);
  });
});

describe('Room Screen — slideshow, zero / one / many (D-10, D-12)', () => {
  it('sends no photos for an event that has seen no captures, so the stage stays idle', async () => {
    const store = makeStore();
    seedActiveEvent(store);
    const snapshot = await firstSnapshot(store);
    expect(snapshot.photos).toEqual([]);
  });

  it('sends exactly one photo for one capture, which the page renders without rotation', async () => {
    const store = makeStore();
    const eventId = seedActiveEvent(store);
    seedPhotos(store, eventId, 1);

    const snapshot = await firstSnapshot(store);
    expect(snapshot.photos).toHaveLength(1);
    // The single-slide rule is a guard in the page, not an accident of timing.
    // Both halves are asserted separately because they are separate mistakes:
    // one photo must not start a rotation interval...
    expect(HTML).toMatch(/if\s*\(\s*slides\.length\s*>\s*1\s*\)\s*\{[\s\S]{0,120}setInterval/);
    // ...and must not draw rotation dots that promise a rotation never coming.
    expect(HTML).toMatch(/if\s*\(\s*pipCount\s*>\s*1\s*\)/);
  });

  it('caps the wire at eventConfig.photoCount however large history grows (T-08-11)', async () => {
    const store = makeStore();
    const eventId = seedActiveEvent(store);
    seedPhotos(store, eventId, 30);

    const snapshot = await firstSnapshot(store);
    expect(store.countEventPhotos(eventId)).toBe(30);
    // History is durable and uncapped (D-11 forbids automatic deletion); what
    // reaches a browser is bounded at render-feed assembly instead.
    expect(snapshot.photos).toHaveLength(snapshot.eventConfig.photoCount);
    expect(snapshot.photos.length).toBeLessThan(30);
  });

  it('sends photos newest first, as narrow two-key projections', async () => {
    const store = makeStore();
    const eventId = seedActiveEvent(store);
    seedPhotos(store, eventId, 3);

    const snapshot = await firstSnapshot(store);
    expect(snapshot.photos[0].name).toBe('Khách số 2');
    // No jobId, no event_id, no captured_at — the D-15 shape rule applied to
    // the new field.
    expect(Object.keys(snapshot.photos[0]).sort()).toEqual(['name', 'photoUrl']);
  });

  it('drives rotation from the snapshot on every update, so a CMS change needs no reload (D-12)', async () => {
    const store = makeStore();
    const eventId = seedActiveEvent(store);
    seedPhotos(store, eventId, 4);

    const snapshot = await firstSnapshot(store);
    expect(snapshot.eventConfig.photoDurationMs).toBe(6000);
    // Read from the snapshot's config inside the render path, never captured
    // once at load: an operator changing the per-photo duration mid-event must
    // reach every TV on the next snapshot.
    expect(HTML).toContain('photoDurationMs');
    expect(HTML).toContain('photoCount');
  });
});

describe('Room Screen — media fallbacks, never a broken-image glyph', () => {
  it('declares an image error handler and the neutral placeholder with a visible Vietnamese label', () => {
    expect(HTML).toMatch(/onerror|'error'/);
    expect(HTML).toContain('Không tải được ảnh');
  });

  it('keeps the incumbent initials-avatar fallback for a name-only tile', () => {
    expect(HTML).toContain('getInitials');
  });
});

describe('Room Screen — up-next sidebar, zero / one / many', () => {
  it('carries the proven empty-queue copy', () => {
    expect(HTML).toContain('Chưa có khách trong hàng chờ');
  });

  it('sends an empty upNext for an empty queue', async () => {
    const empty = makeStore();
    const snapshot = await firstSnapshot(empty);
    expect(snapshot.upNext).toEqual([]);
    expect(snapshot.queueLength).toBe(0);
  });

  it('bounds the sidebar list on the wire while reporting the true queue length', async () => {
    const busy = makeStore();
    for (let i = 0; i < 12; i += 1) seedGuest(busy, `job-${i}`, `Trần Văn Khách ${i}`);

    const snapshot = await firstSnapshot(busy);
    // Phase 5's getQueuedGuestSummaries() already caps the list at 5, so the
    // "many guests" overflow case is bounded TWICE and independently: here on
    // the wire, and again by the sidebar's own max-height + overflow-y in the
    // page. Neither is load-bearing alone.
    expect(snapshot.upNext).toHaveLength(5);
    // The count is NOT capped — a guest twelfth in line must still see twelve.
    expect(snapshot.queueLength).toBe(12);
    // D-14 still holds on the new page: sidebar rows carry given names only.
    expect(snapshot.upNext[0].name).toBe('0');
  });
});

describe('Room Screen — no network dependency at render time (T-08-SC)', () => {
  it('links no external stylesheet, font host or CDN of any kind', () => {
    expect(HTML).not.toContain('fonts.googleapis.com');
    expect(HTML).not.toContain('fonts.gstatic.com');
    expect(HTML).not.toMatch(/cdn\./);
    // No external <link rel=stylesheet> at all: a venue with no internet must
    // render identically to one with it.
    expect(HTML).not.toMatch(/<link[^>]+href=["']https?:/);
  });
});

describe('Room Screen — typography stays inside the UI-SPEC envelope', () => {
  it('uses fluid clamp() sizing and only the two permitted weights', () => {
    expect(HTML).toMatch(/clamp\(/);
    const weights = new Set([...HTML.matchAll(/font-weight:\s*(\d{3})/g)].map((m) => m[1]));
    // UI-SPEC: 400 and 700 only on the Room Screen. The incumbent's 500/600
    // usages are collapsed onto these, not carried forward.
    expect([...weights].sort()).toEqual(['400', '700']);
  });
});
