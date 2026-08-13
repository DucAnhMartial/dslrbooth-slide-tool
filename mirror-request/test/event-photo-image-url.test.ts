import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { LocalStore } from '../src/state/localStore';

// ---------------------------------------------------------------------------
// `event_photo` gains a second URL, and the two are not interchangeable.
//
//   photo_url  — dslrBooth's SHARE PAGE. What the guest is sent. Unchanged,
//                still NOT NULL, still what notificationService delivers
//                (NOT-01/NOT-02 depend on it).
//   image_url  — the FILE the share page advertises. What goes in an <img src>
//                on the wall. Nullable, because it is resolved from a third
//                party that can be slow, down, or changed.
//
// The display projections must prefer image_url and fall back to photo_url,
// so a row whose resolution has not landed (or never will) behaves exactly as
// it does today rather than disappearing from the slideshow.
//
// The migration is additive and conditional, following the four ALTER TABLE
// migrations already in this file and D9-05's precedent. It is proved here
// against a deliberately reconstructed PRE-CHANGE table WITH ROWS IN IT,
// because a populated production database is the only case that matters.
// ---------------------------------------------------------------------------

const SHARE = 'https://fotoshare.co/i/3knbmax';
const DIRECT = 'https://cdn-bz-op.fotoshare.co/b/833cf/x/20260813_135523_092_1x.jpg';

const tmpDirs: string[] = [];
const openStores: LocalStore[] = [];

function makeStore(): { store: LocalStore; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-photo-imgurl-'));
  tmpDirs.push(dir);
  const dbPath = path.join(dir, 'test.sqlite');
  const store = new LocalStore(dbPath);
  openStores.push(store);
  return { store, dbPath };
}

function seed(store: LocalStore, jobId = 'JOB1', capturedAt = 1_000): void {
  store.createEvent({ name: 'E' });
  const eventId = store.listEvents()[0].id;
  store.setActiveEvent(eventId);
  store.recordEventPhoto({ jobId, eventId, guestName: 'Nguyen Duc Anh', photoUrl: SHARE, capturedAt });
}

afterEach(() => {
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

describe('event_photo.image_url — the file behind the share page', () => {
  it('a freshly recorded photo has no image_url yet, and still shows via the share URL', () => {
    const { store } = makeStore();
    seed(store);
    const eventId = store.listEvents()[0].id;

    // The row exists the instant the upload lands. Resolution is a separate,
    // later, failable step — a photo must never wait on a third party to be
    // written down.
    expect(store.getMostRecentEventPhoto(eventId)?.photoUrl).toBe(SHARE);
  });

  it('once resolved, the display projections hand out the DIRECT url', () => {
    const { store } = makeStore();
    seed(store);
    const eventId = store.listEvents()[0].id;

    expect(store.setEventPhotoImageUrl('JOB1', DIRECT)).toBe(true);

    expect(store.getMostRecentEventPhoto(eventId)?.photoUrl).toBe(DIRECT);
    expect(store.listEventPhotos(eventId, { limit: 10, offset: 0 })[0].photoUrl).toBe(DIRECT);
  });

  it('the share URL is preserved for the guest, not overwritten by the resolution', () => {
    const { store, dbPath } = makeStore();
    seed(store);
    store.setEventPhotoImageUrl('JOB1', DIRECT);

    const raw = new Database(dbPath, { readonly: true });
    const row = raw.prepare('SELECT photo_url, image_url FROM event_photo WHERE jobId = ?').get('JOB1') as {
      photo_url: string;
      image_url: string | null;
    };
    raw.close();

    // The whole point of two columns. Overwriting photo_url would send the
    // guest a raw CDN file instead of the page they can view and download
    // from — a silent downgrade of NOT-01/NOT-02.
    expect(row.photo_url).toBe(SHARE);
    expect(row.image_url).toBe(DIRECT);
  });

  it('setting an image_url for a jobId that does not exist reports false and writes nothing', () => {
    const { store } = makeStore();
    seed(store);

    expect(store.setEventPhotoImageUrl('NOPE', DIRECT)).toBe(false);
  });

  it('migrates a populated PRE-CHANGE table without touching its rows', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-photo-migrate-'));
    tmpDirs.push(dir);
    const dbPath = path.join(dir, 'test.sqlite');

    // The exact shape this table had before this change, with a row in it.
    const seedDb = new Database(dbPath);
    seedDb.exec(`
      CREATE TABLE event_photo (
        jobId       TEXT PRIMARY KEY,
        event_id    TEXT NOT NULL,
        guest_name  TEXT NOT NULL,
        photo_url   TEXT NOT NULL,
        captured_at INTEGER NOT NULL
      );
    `);
    seedDb.prepare(
      'INSERT INTO event_photo (jobId, event_id, guest_name, photo_url, captured_at) VALUES (?,?,?,?,?)'
    ).run('OLD1', 'evt', 'Người Cũ', SHARE, 500);
    seedDb.close();

    const store = new LocalStore(dbPath);
    openStores.push(store);

    const raw = new Database(dbPath, { readonly: true });
    const row = raw.prepare('SELECT * FROM event_photo WHERE jobId = ?').get('OLD1') as Record<string, unknown>;
    raw.close();

    expect(row.photo_url).toBe(SHARE);
    expect(row.guest_name).toBe('Người Cũ');
    expect(row.captured_at).toBe(500);
    expect(row.image_url).toBeNull();
  });

  it('is idempotent — opening the same database twice does not throw', () => {
    const { dbPath } = makeStore();
    const again = new LocalStore(dbPath);
    openStores.push(again);
    expect(() => new LocalStore(dbPath)).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Non-vacuity: the fallback must be a real fallback, not "always share URL"
  // and not "always direct URL".
  // -------------------------------------------------------------------------

  it('two photos, one resolved and one not, each hand out their own best url', () => {
    const { store } = makeStore();
    seed(store, 'JOB1', 1_000);
    const eventId = store.listEvents()[0].id;
    store.recordEventPhoto({
      jobId: 'JOB2', eventId, guestName: 'B', photoUrl: 'https://fotoshare.co/i/other', capturedAt: 2_000,
    });
    store.setEventPhotoImageUrl('JOB2', DIRECT);

    const listed = store.listEventPhotos(eventId, { limit: 10, offset: 0 });
    const byJob = Object.fromEntries(listed.map((p) => [p.jobId, p.photoUrl]));

    expect(byJob.JOB2).toBe(DIRECT);
    expect(byJob.JOB1).toBe(SHARE);
  });
});
