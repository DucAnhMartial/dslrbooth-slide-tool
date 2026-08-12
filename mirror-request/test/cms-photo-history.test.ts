import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalStore } from '../src/state/localStore';
import { createCmsIpGate } from '../src/cms/cmsIpGate';
import { createSessionStore, createRequireSession, hashPassword } from '../src/cms/cmsAuth';
import { createCmsRouter } from '../src/cms/cmsRouter';
import { createCmsPhotoRoutes, cmsPhotoLogger } from '../src/cms/cmsPhotoRoutes';
import {
  PHOTOS_PER_PAGE,
  PHOTO_HISTORY_EMPTY_HEADING,
  PHOTO_HISTORY_EMPTY_BODY,
  CLEAR_HISTORY_ACTION,
  CLEAR_HISTORY_CONFIRM,
  THUMB_MISSING_LABEL,
} from '../src/cms/cmsPhotoPages';
import { QueueService } from '../src/queue/queueService';
import { mask } from '../src/logging/logger';

// ---------------------------------------------------------------------------
// Plan 08-05 — the CMS photo-history surface (CMS-03, CMS-04, D-10, D-11).
//
// What `web-slide` had was a 50-entry in-memory array that vanished on every
// restart. The claim under test here is the opposite of that in three parts:
// the history is DURABLE (it is rows in SQLite, so a restart changes nothing),
// it is PER EVENT (one wedding never shows another's guests), and it is
// BOUNDED at the render (50 a page, however large the table grows).
//
// The durability case deliberately closes and reopens a real temp-file store
// rather than mocking the seam: an in-memory implementation would pass every
// other case in this file and fail only that one.
// ---------------------------------------------------------------------------

const WHITELISTED_IP = '10.0.0.5';
const BLOCKED_IP = '203.0.113.9';
const PHOTO_URL = 'https://fotoshare.co/i/1t1vcs3';

/** Hashed here rather than pasted, so the plaintext the login case posts and
 * the digest the router verifies cannot drift apart. */
const TEST_PASSWORD = 'operator-pass-05';
const CMS_CFG = {
  CMS_USERNAME: 'test-operator',
  CMS_PASSWORD_HASH: hashPassword(TEST_PASSWORD),
  CMS_SESSION_COOKIE_NAME: 'cms_session',
};

const OFFLINE_AGENT = { isAgentOnline: () => false, sendEvent: () => false };

const tmpDirs: string[] = [];
const openStores: LocalStore[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cms-photos-'));
  tmpDirs.push(dir);
  return dir;
}

function makeStore(file?: string): LocalStore {
  const store = new LocalStore(file ?? path.join(makeTmpDir(), 'test.sqlite'));
  openStores.push(store);
  return store;
}

interface Harness {
  app: express.Express;
  cookie: string;
  store: LocalStore;
}

/**
 * The production chain minus the login form: the IP gate, the body parsers and
 * `requireSession()` in the order `createCmsRouter` mounts them, with a session
 * minted directly so each case starts authenticated. The REAL router is driven
 * separately by the access-control case below, which is what proves this page
 * is actually mounted behind both layers rather than merely mountable.
 */
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
    createCmsPhotoRoutes(store),
  );
  return { app, cookie: `cms_session=${token}`, store };
}

/**
 * Drives ONE photo in the way production does: a registration, a queued job, an
 * open pending-print slot, then the Agent's `file_upload` event through
 * `QueueService.onAgentEvent`. Inserting into `event_photo` directly would test
 * this page against a row shape nothing in the system actually writes.
 */
function captureThroughUpload(
  store: LocalStore,
  opts: { jobId: string; guestName: string; photoUrl?: string },
): void {
  store.upsertRegistration({
    id: opts.jobId,
    name: opts.guestName,
    email: '',
    phone: '',
    mode: 'standard',
    registered_at: new Date().toISOString(),
  });
  store.enqueueJob({ id: opts.jobId, queued_at: Date.now() });
  store.openPendingPrint({
    jobId: opts.jobId,
    compositePath: 'C:\\dslrBooth\\Prints\\20260812_143526_970.jpg',
    openedAt: Date.now() - 60_000,
    expiresAt: Date.now() + 60_000,
  });

  const service = new QueueService(store);
  service.bindSendCommand(() => {});
  service.bindNotificationService({ sendPhotoLink: async () => {} });
  // Never started: no dispatch tick, no sweep, no timer outlives the case.
  service.onAgentEvent('file_upload', opts.jobId, {
    param2: opts.photoUrl ?? PHOTO_URL,
    param3: 'print',
    param4: 'Test_event',
  });
}

/** Seeds history in bulk, for the pagination and no-trim cases. */
function seedPhotos(store: LocalStore, eventId: string, count: number, startAt = 1_760_000_000_000): void {
  for (let i = 0; i < count; i += 1) {
    store.recordEventPhoto({
      jobId: `${eventId}-job-${i}`,
      eventId,
      guestName: `Khách số ${i}`,
      photoUrl: `${PHOTO_URL}-${i}`,
      // One minute apart, ascending, so row i is strictly newer than row i-1.
      capturedAt: startAt + i * 60_000,
    });
  }
}

function countRows(html: string): number {
  return (html.match(/class="photo-row"/g) ?? []).length;
}

function makeEvent(store: LocalStore, name: string, activate = false): string {
  const event = store.createEvent({ name });
  if (activate) store.setActiveEvent(event.id);
  return event.id;
}

afterEach(() => {
  vi.restoreAllMocks();
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
// CMS-03 / D-10 — a real capture, durable and per event
// ---------------------------------------------------------------------------

describe('CMS photo history — a real capture reaches the operator (CMS-03, D-10)', () => {
  it('lists a photo driven in through onFileUpload(), with the guest name, the thumbnail and the capture time', async () => {
    const h = build();
    const eventId = makeEvent(h.store, 'Tiệc cưới A', true);
    captureThroughUpload(h.store, { jobId: 'job-1', guestName: 'Nguyễn Thị Hồng Ánh' });

    const res = await request(h.app).get(`/cms/photos?event=${eventId}`).set('Cookie', h.cookie);

    expect(res.status).toBe(200);
    expect(countRows(res.text)).toBe(1);
    expect(res.text).toContain('Nguyễn Thị Hồng Ánh');
    expect(res.text).toContain(PHOTO_URL);
    // The capture time is rendered, not merely stored — an operator scanning
    // history for "the couple at about eight" needs the clock, not a row id.
    expect(res.text).toMatch(/\d{2}:\d{2}/);
    expect(res.text).toMatch(/\d{2}\/\d{2}\/\d{4}/);
  });

  it('still lists the row after the store is closed and reopened against the same file (survives a restart)', async () => {
    const file = path.join(makeTmpDir(), 'restart.sqlite');
    const first = build(makeStore(file));
    const eventId = makeEvent(first.store, 'Tiệc cưới A', true);
    captureThroughUpload(first.store, { jobId: 'job-restart', guestName: 'Đặng Vũ Khánh Ly' });
    expect(countRows((await request(first.app).get(`/cms/photos?event=${eventId}`).set('Cookie', first.cookie)).text)).toBe(1);

    first.store.close();
    const second = build(makeStore(file));

    const res = await request(second.app).get(`/cms/photos?event=${eventId}`).set('Cookie', second.cookie);

    // The whole point of D-10: the row is a URL in SQLite, so the restart the
    // incumbent's in-memory array could not survive is a non-event here.
    expect(res.status).toBe(200);
    expect(countRows(res.text)).toBe(1);
    expect(res.text).toContain('Đặng Vũ Khánh Ly');
  });

  it("lists only the requested event's rows when two events both hold photos", async () => {
    const h = build();
    const weddingA = makeEvent(h.store, 'Tiệc cưới A');
    const weddingB = makeEvent(h.store, 'Tiệc cưới B');
    seedPhotos(h.store, weddingA, 3);
    seedPhotos(h.store, weddingB, 5);

    const a = await request(h.app).get(`/cms/photos?event=${weddingA}`).set('Cookie', h.cookie);
    const b = await request(h.app).get(`/cms/photos?event=${weddingB}`).set('Cookie', h.cookie);

    expect(countRows(a.text)).toBe(3);
    expect(countRows(b.text)).toBe(5);
    // A guest of one wedding must not be visible under the other, which is the
    // isolation a shared unfiltered read would silently break.
    expect(a.text).not.toContain(`${weddingB}-job-0`);
    expect(a.text).not.toContain(`${PHOTO_URL}-4`);
  });

  it('renders the UI-SPEC empty copy and no table at all when the event has no photos', async () => {
    const h = build();
    const eventId = makeEvent(h.store, 'Tiệc cưới chưa chụp', true);

    const res = await request(h.app).get(`/cms/photos?event=${eventId}`).set('Cookie', h.cookie);

    expect(res.status).toBe(200);
    expect(res.text).toContain(PHOTO_HISTORY_EMPTY_HEADING);
    expect(res.text).toContain(PHOTO_HISTORY_EMPTY_BODY);
    expect(PHOTO_HISTORY_EMPTY_HEADING).toBe('Chưa có ảnh nào');
    expect(PHOTO_HISTORY_EMPTY_BODY).toBe('Ảnh sẽ xuất hiện tại đây ngay khi khách đầu tiên chụp xong.');
    // "never a blank table" in its strongest form: there is no table.
    expect(res.text).not.toContain('<table');
  });
});

// ---------------------------------------------------------------------------
// G2 — 50 a page, newest first, no unbounded DOM list
// ---------------------------------------------------------------------------

describe('CMS photo history — pagination is bounded at 50 a page, newest first (G2)', () => {
  it('splits 120 rows into 50, 50 and 20, renders the page count, and leads with the newest capture', async () => {
    const h = build();
    const eventId = makeEvent(h.store, 'Tiệc cưới đông khách');
    seedPhotos(h.store, eventId, 120);

    const one = await request(h.app).get(`/cms/photos?event=${eventId}`).set('Cookie', h.cookie);
    const two = await request(h.app).get(`/cms/photos?event=${eventId}&page=2`).set('Cookie', h.cookie);
    const three = await request(h.app).get(`/cms/photos?event=${eventId}&page=3`).set('Cookie', h.cookie);

    expect(PHOTOS_PER_PAGE).toBe(50);
    expect(countRows(one.text)).toBe(50);
    expect(countRows(two.text)).toBe(50);
    expect(countRows(three.text)).toBe(20);
    // The operator has to be able to tell where they are and how much is left.
    expect(one.text).toContain('Trang 1 / 3');
    expect(three.text).toContain('Trang 3 / 3');

    // Newest first: row 119 is the most recent capture and must lead page one,
    // and must not appear on page two at all.
    const firstRowIndex = one.text.indexOf(`${PHOTO_URL}-119`);
    const secondRowIndex = one.text.indexOf(`${PHOTO_URL}-118`);
    expect(firstRowIndex).toBeGreaterThan(-1);
    expect(firstRowIndex).toBeLessThan(secondRowIndex);
    expect(two.text).not.toContain(`"${PHOTO_URL}-119"`);
    // Page two starts where page one stopped.
    expect(two.text).toContain(`${PHOTO_URL}-69`);
    expect(three.text).toContain(`${PHOTO_URL}-0`);
  });

  it('renders an empty result rather than an error for a page beyond the end', async () => {
    const h = build();
    const eventId = makeEvent(h.store, 'Tiệc cưới đông khách');
    seedPhotos(h.store, eventId, 120);

    const res = await request(h.app).get(`/cms/photos?event=${eventId}&page=9`).set('Cookie', h.cookie);

    expect(res.status).toBe(200);
    expect(countRows(res.text)).toBe(0);
    // Still navigable: the operator who typed a page number too far must be
    // able to get back without editing the URL.
    expect(res.text).toContain('Trang 1');
  });

  it('treats a nonsense page parameter as page one rather than failing or querying with NaN', async () => {
    const h = build();
    const eventId = makeEvent(h.store, 'Tiệc cưới đông khách');
    seedPhotos(h.store, eventId, 60);

    for (const page of ['abc', '-4', '0', '1e999', '']) {
      const res = await request(h.app)
        .get(`/cms/photos?event=${eventId}&page=${encodeURIComponent(page)}`)
        .set('Cookie', h.cookie);
      expect(res.status).toBe(200);
      expect(countRows(res.text)).toBe(50);
    }
  });
});

// ---------------------------------------------------------------------------
// CMS-04 — both layers, proved independently
// ---------------------------------------------------------------------------

describe('CMS photo history — unreachable without BOTH the IP layer and a session (CMS-04)', () => {
  function appForIp(ip: string, store: LocalStore): express.Express {
    const app = express();
    app.use((req, _res, next) => {
      Object.defineProperty(req, 'ip', { value: ip, configurable: true });
      next();
    });
    // The REAL router, mounted exactly as index.ts mounts it. This is also what
    // proves the photo routes are wired into the CMS at all.
    app.use('/cms', createCmsIpGate([WHITELISTED_IP]), createCmsRouter(store, CMS_CFG, OFFLINE_AGENT));
    return app;
  }

  it('refuses a non-whitelisted IP with 403 on both the page and the clear action', async () => {
    const store = makeStore();
    const eventId = makeEvent(store, 'Tiệc cưới A', true);
    const app = appForIp(BLOCKED_IP, store);

    const page = await request(app).get(`/cms/photos?event=${eventId}`);
    const clear = await request(app).post('/cms/api/photos/clear').send({ eventId, confirmName: 'Tiệc cưới A' });

    expect(page.status).toBe(403);
    expect(page.body).toEqual({ error: 'Forbidden' });
    expect(clear.status).toBe(403);
  });

  it('refuses a whitelisted IP with no session, separately from the IP layer', async () => {
    const store = makeStore();
    const eventId = makeEvent(store, 'Tiệc cưới A', true);
    seedPhotos(store, eventId, 2);
    const app = appForIp(WHITELISTED_IP, store);

    const page = await request(app).get(`/cms/photos?event=${eventId}`);
    const clear = await request(app).post('/cms/api/photos/clear').send({ eventId, confirmName: 'Tiệc cưới A' });

    expect(page.status).toBe(401);
    expect(clear.status).toBe(401);
    // Refused means refused: nothing was deleted on the way to the 401.
    expect(store.countEventPhotos(eventId)).toBe(2);
  });

  it('serves the page to a whitelisted operator WITH a session — the refusals above are not vacuous', async () => {
    const store = makeStore();
    const eventId = makeEvent(store, 'Tiệc cưới A', true);
    const app = appForIp(WHITELISTED_IP, store);

    const login = await request(app)
      .post('/cms/login')
      .type('form')
      .send({ username: CMS_CFG.CMS_USERNAME, password: TEST_PASSWORD });
    const cookie = (login.headers['set-cookie'] as unknown as string[])[0].split(';')[0];

    const res = await request(app).get(`/cms/photos?event=${eventId}`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain(PHOTO_HISTORY_EMPTY_HEADING);
  });
});

// ---------------------------------------------------------------------------
// Presentation rules carried over from plan 08-03
// ---------------------------------------------------------------------------

describe('CMS photo history — long names truncate with the full name in title', () => {
  it('renders a long guest name once, ellipsised, carrying the whole name in a title attribute', async () => {
    const h = build();
    const eventId = makeEvent(h.store, 'Tiệc cưới A', true);
    const longName = 'Nguyễn Trần Hoàng Thị Mỹ Duyên Phương Anh Khánh Linh Ngọc';
    captureThroughUpload(h.store, { jobId: 'job-long', guestName: longName });

    const res = await request(h.app).get(`/cms/photos?event=${eventId}`).set('Cookie', h.cookie);

    expect(res.text).toContain(`title="${longName}"`);
    // The ellipsis is CSS, not a truncated string: the row shows what fits and
    // the hover shows the rest, exactly as the event list does.
    expect(res.text).toContain('text-overflow:ellipsis');
  });
});

// ---------------------------------------------------------------------------
// AUTH-03 / T-08-25 — guest names never leave this surface unmasked
// ---------------------------------------------------------------------------

describe('CMS photo history — every log line is a masked template string (AUTH-03, T-08-25)', () => {
  it('records only string arguments, and nothing phone-shaped survives the masking formatter', async () => {
    const info = vi.spyOn(cmsPhotoLogger, 'info');
    const warn = vi.spyOn(cmsPhotoLogger, 'warn');
    const h = build();
    const eventId = makeEvent(h.store, 'Tiệc cưới A', true);
    // A guest whose NAME carries a phone-shaped substring — the exact shape the
    // winston formatter masks, and only if the message reached it as a string.
    const guestName = 'Khách VIP 0912345678';
    captureThroughUpload(h.store, { jobId: 'job-mask', guestName });

    // Rendering the history, and a stale bookmark pointing at an event that no
    // longer exists — the one read on this surface that does log.
    await request(h.app).get(`/cms/photos?event=${eventId}`).set('Cookie', h.cookie);
    const missing = await request(h.app).get('/cms/photos?event=gone-1').set('Cookie', h.cookie);
    expect(missing.status).toBe(404);

    const calls = [...info.mock.calls, ...warn.mock.calls];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      // T-08-25: a plain string, and ONE argument. winston only runs mask() when
      // `typeof message === 'string'`, so an object-form line would carry a
      // guest name into the log file untouched.
      expect(typeof call[0]).toBe('string');
      expect(call).toHaveLength(1);
      const line = String(call[0]);
      expect(line).not.toContain(guestName);
      // And whatever it does carry survives masking unchanged — i.e. there is
      // nothing phone- or email-shaped in it to begin with.
      expect(mask(line)).toBe(line);
    }
  });
});

// ---------------------------------------------------------------------------
// D-11 — deletion is a deliberate act, and the ONLY one in the system
// ---------------------------------------------------------------------------

describe('CMS photo history — clearing is a confirmed operator action and nothing else (D-11)', () => {
  it('renders the confirmation view and deletes NOTHING when the clear action arrives unconfirmed', async () => {
    const h = build();
    const eventId = makeEvent(h.store, 'Tiệc cưới A', true);
    seedPhotos(h.store, eventId, 3);

    const noField = await request(h.app).post('/cms/api/photos/clear').set('Cookie', h.cookie).send({ eventId });
    const wrongName = await request(h.app)
      .post('/cms/api/photos/clear')
      .set('Cookie', h.cookie)
      .send({ eventId, confirmName: 'Tiệc cưới B' });

    for (const res of [noField, wrongName]) {
      expect(res.status).toBe(400);
      // The confirmation VIEW comes back, carrying the UI-SPEC question, so the
      // operator is asked rather than told "no".
      expect(res.text).toContain(CLEAR_HISTORY_CONFIRM);
      expect(CLEAR_HISTORY_CONFIRM).toBe('Xóa toàn bộ lịch sử ảnh của sự kiện này? Không thể hoàn tác.');
      expect(CLEAR_HISTORY_ACTION).toBe('Xóa lịch sử ảnh');
    }
    // The load-bearing assertion: every row is still there.
    expect(h.store.countEventPhotos(eventId)).toBe(3);
  });

  it('clears exactly the confirmed event, reports the count, and leaves a second event untouched', async () => {
    const h = build();
    const weddingA = makeEvent(h.store, 'Tiệc cưới A', true);
    const weddingB = makeEvent(h.store, 'Tiệc cưới B');
    seedPhotos(h.store, weddingA, 4);
    seedPhotos(h.store, weddingB, 6);

    const res = await request(h.app)
      .post('/cms/api/photos/clear')
      .set('Cookie', h.cookie)
      .send({ eventId: weddingA, confirmName: 'Tiệc cưới A' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cleared: true, deleted: 4 });
    expect(h.store.countEventPhotos(weddingA)).toBe(0);
    // One wedding's operator error must never cost another wedding its photos.
    expect(h.store.countEventPhotos(weddingB)).toBe(6);
  });

  it('clears an already-empty history successfully, reporting zero rather than failing', async () => {
    const h = build();
    const eventId = makeEvent(h.store, 'Tiệc cưới chưa chụp', true);

    const res = await request(h.app)
      .post('/cms/api/photos/clear')
      .set('Cookie', h.cookie)
      .send({ eventId, confirmName: 'Tiệc cưới chưa chụp' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cleared: true, deleted: 0 });
  });

  it('answers an unknown event with a 404 and clears nothing', async () => {
    const h = build();
    const eventId = makeEvent(h.store, 'Tiệc cưới A', true);
    seedPhotos(h.store, eventId, 2);

    const res = await request(h.app)
      .post('/cms/api/photos/clear')
      .set('Cookie', h.cookie)
      .send({ eventId: 'no-such-event', confirmName: 'no-such-event' });

    expect(res.status).toBe(404);
    // The route's OWN refusal, not Express's default 404 — without this the
    // case would pass against a service that has no clear route at all.
    expect(res.body).toEqual({ error: 'Event not found' });
    expect(h.store.countEventPhotos(eventId)).toBe(2);
  });

  it('serves a confirmation page whose destructive control carries the shared in-flight contract', async () => {
    const h = build();
    const eventId = makeEvent(h.store, 'Tiệc cưới A', true);
    seedPhotos(h.store, eventId, 7);

    const res = await request(h.app).get(`/cms/photos/clear?event=${eventId}`).set('Cookie', h.cookie);

    expect(res.status).toBe(200);
    expect(res.text).toContain(CLEAR_HISTORY_CONFIRM);
    // The operator is told what they are about to destroy, in numbers.
    expect(res.text).toContain('7');
    // UI-SPEC G1: the destructive submit and the logout form, and nothing else.
    expect((res.text.match(/data-mutating/g) ?? []).length).toBe(2);
    expect(res.text).toContain('data-inflight-label');
    expect(res.text).toContain('cmsBusy');
    // A typed confirmation, checked by the server — see the route's comment.
    expect(res.text).toContain('confirmName');
  });

  it('logs exactly one line per clear, carrying the event id and the count and no guest name', async () => {
    const info = vi.spyOn(cmsPhotoLogger, 'info');
    const h = build();
    const eventId = makeEvent(h.store, 'Tiệc cưới A', true);
    const guestName = 'Khách VIP 0912345678';
    captureThroughUpload(h.store, { jobId: 'job-clear-log', guestName });

    await request(h.app)
      .post('/cms/api/photos/clear')
      .set('Cookie', h.cookie)
      .send({ eventId, confirmName: 'Tiệc cưới A' });

    const lines = info.mock.calls.filter((call) => String(call[0]).includes(eventId));
    expect(lines).toHaveLength(1);
    const line = String(lines[0][0]);
    expect(typeof lines[0][0]).toBe('string');
    expect(line).toContain('1');
    expect(line).not.toContain(guestName);
    expect(line).not.toContain('0912345678');
  });

  it('has no timer, no schedule and no self-pruning identifier anywhere in the photo surface (D-11)', () => {
    // D-11 stated as a property of the SOURCE, not of one run: photo history is
    // removed by hand and by nothing else. A future edit that reintroduces a
    // retention sweep would delete real guests' photographs silently, and would
    // pass every behavioural case in this file — so the check is here.
    const forbidden = /setInterval|setTimeout|node-cron|autoDelete|pruneOldest|cleanupOld|retention/;
    for (const file of ['src/cms/cmsPhotoRoutes.ts', 'src/cms/cmsPhotoPages.ts']) {
      const source = fs
        .readFileSync(path.join(process.cwd(), file), 'utf8')
        .split('\n')
        .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//') && !line.trim().startsWith('/*'))
        .join('\n');
      expect(source).not.toMatch(forbidden);
    }
  });

  it('never trims history as a side effect of reading it — 500 rows survive being listed', async () => {
    const h = build();
    const eventId = makeEvent(h.store, 'Tiệc cưới rất dài', true);
    seedPhotos(h.store, eventId, 500);

    for (const pageNumber of [1, 2, 5, 10]) {
      const res = await request(h.app)
        .get(`/cms/photos?event=${eventId}&page=${pageNumber}`)
        .set('Cookie', h.cookie);
      expect(res.status).toBe(200);
      expect(countRows(res.text)).toBe(50);
    }

    // The incumbent capped at 50 entries and dropped the rest. This table has no
    // cap at all, and reading it is not a write.
    expect(h.store.countEventPhotos(eventId)).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// G4 — a missing image is a designed state, never a broken glyph
// ---------------------------------------------------------------------------

describe('CMS photo history — a thumbnail that cannot load falls back to the G4 placeholder', () => {
  it('ships the placeholder tile, its warning icon and its visible Vietnamese label with every row', async () => {
    const h = build();
    const eventId = makeEvent(h.store, 'Tiệc cưới A', true);
    seedPhotos(h.store, eventId, 1);

    const res = await request(h.app).get(`/cms/photos?event=${eventId}`).set('Cookie', h.cookie);

    expect(res.text).toContain('thumb-missing');
    expect(res.text).toContain(THUMB_MISSING_LABEL);
    expect(THUMB_MISSING_LABEL).toBe('Ảnh không tải được');

    // The icon ships WITH its label, and is hidden from assistive technology
    // because the label beside it is the accessible name (UI-SPEC: no icon-only
    // control, ever).
    const tile = res.text.slice(res.text.indexOf('thumb-missing'), res.text.indexOf(THUMB_MISSING_LABEL) + 40);
    expect(tile).toContain('<svg');
    expect(tile).toContain('aria-hidden="true"');
    expect(tile).toContain(THUMB_MISSING_LABEL);

    // And the swap really is wired: an error on the image, or an image that
    // finished loading with no pixels, reveals the tile. Without this the
    // markup above would be decoration and the browser's broken-image glyph
    // would still be what the operator sees.
    expect(res.text).toContain('cmsPhotoMissing');
    expect(res.text).toContain("addEventListener('error'");
    expect(res.text).toContain('naturalWidth');
  });

  it('renders the placeholder server-side for a URL no browser should be asked to load, and KEEPS the row', async () => {
    const h = build();
    const eventId = makeEvent(h.store, 'Tiệc cưới A', true);
    h.store.recordEventPhoto({
      jobId: 'job-hostile',
      eventId,
      guestName: 'Trần Bảo Long',
      photoUrl: 'javascript:alert(1)',
      capturedAt: Date.now(),
    });

    const res = await request(h.app).get(`/cms/photos?event=${eventId}`).set('Cookie', h.cookie);

    // Never emitted as an <img src>, at all.
    expect(res.text).not.toContain('javascript:alert(1)');
    expect(res.text).not.toContain('src="javascript:');
    // The row survives: a photo whose URL cannot be rendered is a display
    // state, and this surface has exactly one way to delete a row (D-11).
    expect(countRows(res.text)).toBe(1);
    expect(res.text).toContain('Trần Bảo Long');
    expect(res.text).toContain(THUMB_MISSING_LABEL);
    expect(h.store.countEventPhotos(eventId)).toBe(1);
  });

  it('still renders an ordinary https thumbnail as an image — the refusal above is not a blanket one', async () => {
    const h = build();
    const eventId = makeEvent(h.store, 'Tiệc cưới A', true);
    seedPhotos(h.store, eventId, 1);

    const res = await request(h.app).get(`/cms/photos?event=${eventId}`).set('Cookie', h.cookie);

    expect(res.text).toContain(`src="${PHOTO_URL}-0"`);
  });
});
