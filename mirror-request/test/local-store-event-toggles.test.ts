import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { LocalStore } from '../src/state/localStore';

/**
 * D9-05: the first ALTER TABLE against `event` since Phase 8 shipped it with
 * zero. This file pins the two things that must hold for that to be safe
 * against a LIVE, POPULATED production database file — idempotency and
 * lossless-ness — against a table built in its PRE-PHASE shape and seeded
 * with rows, never against a fresh one. A migration proved only against an
 * empty table proves nothing about the database this service actually runs
 * against tonight.
 *
 * Every case here uses a REAL temp-file SQLite database
 * (fs.mkdtempSync/better-sqlite3), following local-store-persistence.test.ts's
 * harness exactly — never a mock.
 */

describe('LocalStore — event.show_guest_name / event.hero_enabled migration (D9-04, D9-05)', () => {
  let dir: string;
  let dbPath: string;
  let store: LocalStore | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-event-toggles-'));
    dbPath = path.join(dir, 'test.sqlite');
    store = undefined;
  });

  afterEach(() => {
    if (store) {
      try {
        store.close();
      } catch {
        /* already closed */
      }
      store = undefined;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The `event` table exactly as Phase 8 shipped it — before this phase's
   * two columns existed. Rebuilt with a direct better-sqlite3 handle so the
   * migration path (ALTER TABLE), not the bootstrap path (CREATE TABLE), is
   * what actually runs when a LocalStore next opens this file. */
  function rebuildAsPrePhaseEventTable(): void {
    const raw = new Database(dbPath);
    raw.exec('DROP TABLE event');
    raw.exec(`
      CREATE TABLE event (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL,
        logo_url          TEXT,
        background_url    TEXT,
        color_dominant    TEXT,
        color_secondary   TEXT,
        color_accent      TEXT,
        color_text        TEXT,
        color_text_muted  TEXT,
        font_choice       TEXT NOT NULL DEFAULT 'system-ui',
        idle_heading      TEXT,
        idle_sub          TEXT,
        qr_image_url      TEXT,
        qr_cta_text       TEXT,
        photo_count       INTEGER,
        photo_duration_ms INTEGER,
        layout_style      TEXT NOT NULL DEFAULT 'stage_sidebar',
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      );
    `);
    const now = Date.now();
    // Two fully-customized rows plus one bare row — a live production
    // database is never uniformly blank, and the migration must not treat
    // "customized" and "never touched" differently.
    raw
      .prepare(
        `INSERT INTO event (id, name, color_dominant, color_secondary, color_accent, color_text,
           color_text_muted, idle_heading, idle_sub, photo_count, photo_duration_ms, created_at, updated_at)
         VALUES (@id, @name, @color_dominant, @color_secondary, @color_accent, @color_text,
           @color_text_muted, @idle_heading, @idle_sub, @photo_count, @photo_duration_ms, @created_at, @updated_at)`,
      )
      .run({
        id: 'evt-a',
        name: 'Tiệc cưới Ánh & Dương',
        color_dominant: '#101014',
        color_secondary: '#1a1a22',
        color_accent: '#ff6b81',
        color_text: '#ffffff',
        color_text_muted: '#c4c4cc',
        idle_heading: 'Chào mừng đến với đám cưới',
        idle_sub: 'Quét mã để nhận ảnh',
        photo_count: 20,
        photo_duration_ms: 8000,
        created_at: now,
        updated_at: now,
      });
    raw
      .prepare(
        `INSERT INTO event (id, name, color_dominant, color_secondary, color_accent, color_text,
           color_text_muted, idle_heading, idle_sub, photo_count, photo_duration_ms, created_at, updated_at)
         VALUES (@id, @name, @color_dominant, @color_secondary, @color_accent, @color_text,
           @color_text_muted, @idle_heading, @idle_sub, @photo_count, @photo_duration_ms, @created_at, @updated_at)`,
      )
      .run({
        id: 'evt-b',
        name: 'Sinh nhật Bảo Châu',
        color_dominant: '#0e0e0e',
        color_secondary: '#161616',
        color_accent: '#4ade80',
        color_text: '#fafafa',
        color_text_muted: '#a3a3a3',
        idle_heading: 'Chụp ảnh cùng chúng tôi nhé',
        idle_sub: 'Quét QR để tham gia',
        photo_count: 15,
        photo_duration_ms: 5000,
        created_at: now + 1,
        updated_at: now + 1,
      });
    raw
      .prepare(`INSERT INTO event (id, name, created_at, updated_at) VALUES (@id, @name, @created_at, @updated_at)`)
      .run({ id: 'evt-bare', name: 'Sự kiện chưa tuỳ chỉnh', created_at: now + 2, updated_at: now + 2 });
    raw.close();
  }

  it('a pre-phase event table gains both columns on the next open, with every pre-existing row reading ON', () => {
    // Bootstrap a full database first (so every OTHER table exists), then
    // roll `event` back to its pre-phase shape and re-seed it — this is the
    // only construction that actually exercises the ALTER TABLE branch
    // rather than the CREATE TABLE branch.
    store = new LocalStore(dbPath);
    store.close();
    store = undefined;
    rebuildAsPrePhaseEventTable();

    store = new LocalStore(dbPath);
    const columns = (store as unknown as { db: Database.Database }).db
      .prepare("PRAGMA table_info('event')")
      .all() as Array<{ name: string }>;
    expect(columns.some((c) => c.name === 'show_guest_name')).toBe(true);
    expect(columns.some((c) => c.name === 'hero_enabled')).toBe(true);

    for (const id of ['evt-a', 'evt-b', 'evt-bare']) {
      const cfg = store.getEventConfig(id);
      expect(cfg?.showGuestName).toBe(true);
      expect(cfg?.heroEnabled).toBe(true);
    }
  });

  it('no pre-existing row loses a value across the migration: name, colours, copy, photo count and duration', () => {
    store = new LocalStore(dbPath);
    store.close();
    store = undefined;
    rebuildAsPrePhaseEventTable();

    store = new LocalStore(dbPath);
    const a = store.getEventConfig('evt-a');
    expect(a).toMatchObject({
      name: 'Tiệc cưới Ánh & Dương',
      colorAccent: '#ff6b81',
      idleHeading: 'Chào mừng đến với đám cưới',
      photoCount: 20,
      photoDurationMs: 8000,
    });

    const b = store.getEventConfig('evt-b');
    expect(b).toMatchObject({
      name: 'Sinh nhật Bảo Châu',
      colorAccent: '#4ade80',
      idleHeading: 'Chụp ảnh cùng chúng tôi nhé',
      photoCount: 15,
      photoDurationMs: 5000,
    });

    const bare = store.getEventConfig('evt-bare');
    expect(bare?.name).toBe('Sự kiện chưa tuỳ chỉnh');
    expect(bare?.photoCount).toBe(12); // shipped default — never customized
  });

  it('opening a second time after the migration runs is a clean no-op: no throw, no column change, no row change', () => {
    store = new LocalStore(dbPath);
    store.close();
    store = undefined;
    rebuildAsPrePhaseEventTable();

    store = new LocalStore(dbPath);
    const beforeColumns = (store as unknown as { db: Database.Database }).db
      .prepare("PRAGMA table_info('event')")
      .all();
    const beforeA = store.getEventConfig('evt-a');
    store.close();
    store = undefined;

    // The second open — migrate() runs again on an already-migrated file.
    let secondOpenError: unknown = null;
    let reopened: LocalStore | undefined;
    try {
      reopened = new LocalStore(dbPath);
    } catch (err) {
      secondOpenError = err;
    }
    expect(secondOpenError).toBeNull();
    store = reopened;
    const afterColumns = (reopened as unknown as { db: Database.Database }).db
      .prepare("PRAGMA table_info('event')")
      .all();
    const afterA = reopened?.getEventConfig('evt-a');

    expect(afterColumns).toEqual(beforeColumns);
    expect(afterA).toEqual(beforeA);
  });

  it('both columns survive a close-and-reopen with their written values intact, including a row explicitly set to 0', () => {
    store = new LocalStore(dbPath);
    const event = store.createEvent({ name: 'Sự kiện kiểm tra' });
    store.updateEvent(event.id, { show_guest_name: 0, hero_enabled: 1 });
    store.close();

    store = new LocalStore(dbPath);
    const cfg = store.getEventConfig(event.id);
    expect(cfg?.showGuestName).toBe(false);
    expect(cfg?.heroEnabled).toBe(true);
  });
});
