import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalStore } from '../src/state/localStore';
import { createCmsIpGate } from '../src/cms/cmsIpGate';
import { createSessionStore, createRequireSession } from '../src/cms/cmsAuth';
import { createCmsPhotoRoutes, cmsPhotoLogger } from '../src/cms/cmsPhotoRoutes';
import {
  DELETE_PHOTO_ACTION,
  DELETE_PHOTO_CONFIRM,
  CLEAR_HISTORY_ACTION,
} from '../src/cms/cmsPhotoPages';

// ---------------------------------------------------------------------------
// CMS-05 — deleting ONE photo from history.
//
// Asked for after a real event: a capture failed, its row carried a null
// image_url, and the slide screen showed a broken tile. The only tool the
// operator had was "Xóa lịch sử ảnh", which erases the entire wedding — so the
// broken tile stayed up, and the row was eventually removed by hand with a
// direct SQL DELETE against the production database. That is the gap this
// closes.
//
// This is NOT a relaxation of D-11. That decision says photo history is "kept
// per event, deleted only by hand" and forbids AUTOMATIC removal: no expiry,
// no row cap, no scheduled cleanup, no delete-on-event-switch. One operator
// deleting one row after a confirmation is the same hand-driven act the
// clear-all path already is, scoped smaller. The cases below pin that reading
// by asserting the automation-shaped behaviours still do not exist.
// ---------------------------------------------------------------------------

const WHITELISTED_IP = '10.0.0.5';
const PHOTO_URL = 'https://fotoshare.co/i/1t1vcs3';

const tmpDirs: string[] = [];
const openStores: LocalStore[] = [];

function makeStore(): LocalStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cms-del1-'));
  tmpDirs.push(dir);
  const store = new LocalStore(path.join(dir, 'test.sqlite'));
  openStores.push(store);
  return store;
}

function build(store: LocalStore) {
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
  return { app, cookie: `cms_session=${token}` };
}

function seed(
  store: LocalStore,
  eventId: string,
  jobId: string,
  guestName: string,
  capturedAt = 1_760_000_000_000,
): void {
  store.recordEventPhoto({ jobId, eventId, guestName, photoUrl: `${PHOTO_URL}-${jobId}`, capturedAt });
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

describe('the store deletes exactly one row (CMS-05)', () => {
  it('removes the named row and leaves every other photo of the same event alone', () => {
    const store = makeStore();
    const event = store.createEvent({ name: 'Đám cưới A' });
    seed(store, event.id, 'job-keep-1', 'Khách một');
    seed(store, event.id, 'job-drop', 'Khách hai');
    seed(store, event.id, 'job-keep-2', 'Khách ba');

    expect(store.deleteEventPhoto('job-drop')).toBe(true);

    expect(store.countEventPhotos(event.id)).toBe(2);
    const remaining = store.listEventPhotos(event.id, { limit: 50, offset: 0 }).map((p) => p.jobId);
    expect(remaining.sort()).toEqual(['job-keep-1', 'job-keep-2']);
  });

  it('never reaches into another event', () => {
    const store = makeStore();
    const a = store.createEvent({ name: 'Đám cưới A' });
    const b = store.createEvent({ name: 'Đám cưới B' });
    seed(store, a.id, 'job-a', 'Khách A');
    seed(store, b.id, 'job-b', 'Khách B');

    store.deleteEventPhoto('job-a');

    expect(store.countEventPhotos(a.id)).toBe(0);
    expect(store.countEventPhotos(b.id)).toBe(1);
  });

  it('answers false for a job id that is already gone, rather than throwing', () => {
    // Two operators closing the same broken capture is not a fault.
    const store = makeStore();
    const event = store.createEvent({ name: 'Đám cưới A' });
    seed(store, event.id, 'job-x', 'Khách X');

    expect(store.deleteEventPhoto('job-x')).toBe(true);
    expect(store.deleteEventPhoto('job-x')).toBe(false);
    expect(store.deleteEventPhoto('never-existed')).toBe(false);
  });

  it('getEventPhoto reports the row own event id, so a caller cannot be told a different one', () => {
    const store = makeStore();
    const a = store.createEvent({ name: 'Đám cưới A' });
    seed(store, a.id, 'job-a', 'Khách A', 1_760_000_123_000);

    const photo = store.getEventPhoto('job-a');
    expect(photo).toMatchObject({ jobId: 'job-a', eventId: a.id, guestName: 'Khách A', capturedAt: 1_760_000_123_000 });
    expect(store.getEventPhoto('missing')).toBeUndefined();
  });

  it('prefers image_url over photo_url, exactly as the history list does', () => {
    const store = makeStore();
    const event = store.createEvent({ name: 'Đám cưới A' });
    seed(store, event.id, 'job-a', 'Khách A');
    store.setEventPhotoImageUrl('job-a', 'https://cdn.example/real-file.jpg');

    // Confirming against a different rendering of the row than the table
    // showed is how you delete the wrong photograph.
    expect(store.getEventPhoto('job-a')?.photoUrl).toBe('https://cdn.example/real-file.jpg');
    expect(store.listEventPhotos(event.id, { limit: 1, offset: 0 })[0].photoUrl).toBe(
      'https://cdn.example/real-file.jpg',
    );
  });
});

describe('the confirmation page (CMS-05)', () => {
  it('shows the photo, the guest and the time before anything is deleted', async () => {
    const store = makeStore();
    const event = store.createEvent({ name: 'Đám cưới A' });
    seed(store, event.id, 'job-a', 'Nguyễn Văn A');
    const { app, cookie } = build(store);

    const res = await request(app).get('/cms/photos/delete?job=job-a').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.text).toContain(DELETE_PHOTO_CONFIRM);
    expect(res.text).toContain('Nguyễn Văn A');
    expect(res.text).toContain('Đám cưới A');
    // Still there — a GET must never delete.
    expect(store.countEventPhotos(event.id)).toBe(1);
  });

  it('does not ask the operator to retype the event name', async () => {
    // Proportionality: that control guards erasing a whole wedding. Demanding
    // it for one photo teaches typing event names without reading them.
    const store = makeStore();
    const event = store.createEvent({ name: 'Đám cưới A' });
    seed(store, event.id, 'job-a', 'Khách A');
    const { app, cookie } = build(store);

    const res = await request(app).get('/cms/photos/delete?job=job-a').set('Cookie', cookie);

    expect(res.text).not.toContain('confirmName');
  });

  it('is a distinct action from clearing the whole history, in wording', () => {
    // Two buttons that read alike is how an operator loses a wedding.
    expect(DELETE_PHOTO_ACTION).not.toBe(CLEAR_HISTORY_ACTION);
    expect(DELETE_PHOTO_ACTION.toLowerCase()).not.toContain('lịch sử');
  });

  it('404s an unknown job id instead of rendering an empty confirmation', async () => {
    const store = makeStore();
    store.createEvent({ name: 'Đám cưới A' });
    const { app, cookie } = build(store);

    const res = await request(app).get('/cms/photos/delete?job=nope').set('Cookie', cookie);
    expect(res.status).toBe(404);
  });

  it('404s a missing job parameter', async () => {
    const store = makeStore();
    const { app, cookie } = build(store);
    expect((await request(app).get('/cms/photos/delete').set('Cookie', cookie)).status).toBe(404);
  });
});

describe('the delete endpoint (CMS-05)', () => {
  it('deletes the row and reports that it did', async () => {
    const store = makeStore();
    const event = store.createEvent({ name: 'Đám cưới A' });
    seed(store, event.id, 'job-a', 'Khách A');
    seed(store, event.id, 'job-b', 'Khách B');
    const { app, cookie } = build(store);

    const res = await request(app)
      .post('/cms/api/photos/delete')
      .set('Cookie', cookie)
      .send({ jobId: 'job-a' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });
    expect(store.countEventPhotos(event.id)).toBe(1);
    expect(store.getEventPhoto('job-a')).toBeUndefined();
    expect(store.getEventPhoto('job-b')).toBeDefined();
  });

  it('404s an unknown job id and deletes nothing', async () => {
    const store = makeStore();
    const event = store.createEvent({ name: 'Đám cưới A' });
    seed(store, event.id, 'job-a', 'Khách A');
    const { app, cookie } = build(store);

    const res = await request(app)
      .post('/cms/api/photos/delete')
      .set('Cookie', cookie)
      .send({ jobId: 'nope' });

    expect(res.status).toBe(404);
    expect(store.countEventPhotos(event.id)).toBe(1);
  });

  it('refuses a non-string job id without touching the table', async () => {
    const store = makeStore();
    const event = store.createEvent({ name: 'Đám cưới A' });
    seed(store, event.id, 'job-a', 'Khách A');
    const { app, cookie } = build(store);

    for (const jobId of [null, 42, { toString: () => 'job-a' }, ['job-a']]) {
      const res = await request(app).post('/cms/api/photos/delete').set('Cookie', cookie).send({ jobId });
      expect(res.status).toBe(404);
    }
    expect(store.countEventPhotos(event.id)).toBe(1);
  });

  it('logs the deletion with the job and event id, and NO guest name', async () => {
    // Same rule the clear-all line follows (T-08-25): an audit trail for an
    // irreversible act, not a record of who was in the photograph.
    const store = makeStore();
    const event = store.createEvent({ name: 'Đám cưới A' });
    seed(store, event.id, 'job-a', 'Nguyễn Văn A');
    const { app, cookie } = build(store);
    const info = vi.spyOn(cmsPhotoLogger, 'info').mockImplementation(() => undefined as never);

    await request(app).post('/cms/api/photos/delete').set('Cookie', cookie).send({ jobId: 'job-a' });

    expect(info).toHaveBeenCalledTimes(1);
    const line = String(info.mock.calls[0][0]);
    expect(line).toContain('job-a');
    expect(line).toContain(event.id);
    expect(line).not.toContain('Nguyễn Văn A');
  });

  it('is refused to a peer outside the IP allow-list, before any session check', async () => {
    const store = makeStore();
    const event = store.createEvent({ name: 'Đám cưới A' });
    seed(store, event.id, 'job-a', 'Khách A');

    const app = express();
    app.use((req, _res, next) => {
      Object.defineProperty(req, 'ip', { value: '203.0.113.9', configurable: true });
      next();
    });
    const sessions = createSessionStore();
    app.use(
      '/cms',
      createCmsIpGate([WHITELISTED_IP]),
      express.json(),
      createRequireSession(sessions, 'cms_session'),
      createCmsPhotoRoutes(store),
    );

    const res = await request(app).post('/cms/api/photos/delete').send({ jobId: 'job-a' });

    expect(res.status).toBe(403);
    expect(store.countEventPhotos(event.id)).toBe(1);
  });

  it('is refused without a session', async () => {
    const store = makeStore();
    const event = store.createEvent({ name: 'Đám cưới A' });
    seed(store, event.id, 'job-a', 'Khách A');
    const { app } = build(store);

    const res = await request(app).post('/cms/api/photos/delete').send({ jobId: 'job-a' });

    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(store.countEventPhotos(event.id)).toBe(1);
  });
});

describe('D-11 still holds: nothing deletes on its own (CMS-05)', () => {
  it('recording new photos never evicts an older one', () => {
    // No row cap. The clear-all path's header states this rule; adding a
    // second manual path must not smuggle in a sweep.
    const store = makeStore();
    const event = store.createEvent({ name: 'Đám cưới A' });
    for (let i = 0; i < 60; i += 1) {
      seed(store, event.id, `job-${i}`, `Khách ${i}`, 1_760_000_000_000 + i * 60_000);
    }
    expect(store.countEventPhotos(event.id)).toBe(60);
  });

  it('switching the active event deletes nothing', () => {
    const store = makeStore();
    const a = store.createEvent({ name: 'Đám cưới A' });
    const b = store.createEvent({ name: 'Đám cưới B' });
    seed(store, a.id, 'job-a', 'Khách A');
    store.setActiveEvent(a.id);
    store.setActiveEvent(b.id);
    expect(store.countEventPhotos(a.id)).toBe(1);
  });

  it('a GET of the confirmation page is not a deletion', async () => {
    const store = makeStore();
    const event = store.createEvent({ name: 'Đám cưới A' });
    seed(store, event.id, 'job-a', 'Khách A');
    const { app, cookie } = build(store);

    await request(app).get('/cms/photos/delete?job=job-a').set('Cookie', cookie);
    await request(app).get('/cms/photos/delete?job=job-a').set('Cookie', cookie);

    expect(store.countEventPhotos(event.id)).toBe(1);
  });
});
