import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { LocalStore } from '../src/state/localStore';

describe('LocalStore dedup window', () => {
  let dir: string;
  let dbPath: string;
  let store: LocalStore | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-dedup-'));
    dbPath = path.join(dir, 'test.sqlite');
    store = undefined;
  });

  afterEach(() => {
    if (store) {
      store.close();
      store = undefined;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a store opened on a brand-new file has a registration.received_at column', () => {
    store = new LocalStore(dbPath);
    const columns = new Database(dbPath).prepare('PRAGMA table_info(registration)').all() as Array<{ name: string }>;
    expect(columns.some((c) => c.name === 'received_at')).toBe(true);
  });

  it('a store opened on a pre-phase-schema file gains received_at on open and preserves existing rows', () => {
    // Create a database with the pre-phase schema (no received_at column).
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE registration (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT NOT NULL,
        mode TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        raw_payload TEXT
      );
    `);
    raw.prepare(
      `INSERT INTO registration (id, name, email, phone, mode, registered_at, raw_payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('pre-1', 'Old Guest', 'old@example.com', '', 'standard', '2026-01-01T00:00:00.000Z', '{}');
    raw.close();

    store = new LocalStore(dbPath);
    const columns = new Database(dbPath).prepare('PRAGMA table_info(registration)').all() as Array<{ name: string }>;
    expect(columns.some((c) => c.name === 'received_at')).toBe(true);

    const row = store.getRegistration('pre-1');
    expect(row).toBeDefined();
    expect(row?.name).toBe('Old Guest');
  });

  it('upsertRegistration with no explicit received_at stores the current server time', () => {
    store = new LocalStore(dbPath);
    const before = Date.now();
    store.upsertRegistration({
      id: 'r1', name: 'Guest', email: '', phone: '', mode: 'standard',
      registered_at: '2026-01-01T00:00:00.000Z',
    });
    const after = Date.now();
    const row = store.getRegistration('r1') as unknown as { received_at: number };
    expect(row.received_at).toBeGreaterThanOrEqual(before);
    expect(row.received_at).toBeLessThanOrEqual(after);
  });

  it('findDuplicateRegistration by id returns the row inside the window and undefined once outside it', () => {
    store = new LocalStore(dbPath);
    const now = Date.now();
    store.upsertRegistration({
      id: 'r1', name: 'Guest', email: '', phone: '', mode: 'standard',
      registered_at: '2026-01-01T00:00:00.000Z', received_at: now,
    });

    expect(store.findDuplicateRegistration({ id: 'r1', email: '', phone: '', windowStartMs: now - 1000 })).toEqual({ id: 'r1' });
    expect(store.findDuplicateRegistration({ id: 'r1', email: '', phone: '', windowStartMs: now + 1000 })).toBeUndefined();
  });

  it('findDuplicateRegistration falls back to matching email and returns the earlier registration', () => {
    store = new LocalStore(dbPath);
    const now = Date.now();
    store.upsertRegistration({
      id: 'r1', name: 'Guest', email: 'a@b.co', phone: '', mode: 'standard',
      registered_at: '2026-01-01T00:00:00.000Z', received_at: now,
    });

    const found = store.findDuplicateRegistration({ id: 'r2', email: 'a@b.co', phone: '', windowStartMs: now - 1000 });
    expect(found).toEqual({ id: 'r1' });
  });

  it('two registrations with empty email and empty phone never collide', () => {
    store = new LocalStore(dbPath);
    const now = Date.now();
    store.upsertRegistration({
      id: 'r1', name: 'Guest 1', email: '', phone: '', mode: 'standard',
      registered_at: '2026-01-01T00:00:00.000Z', received_at: now,
    });

    const found = store.findDuplicateRegistration({ id: 'r3', email: '', phone: '', windowStartMs: now - 1000 });
    expect(found).toBeUndefined();
  });

  it('when two rows both match on contact details, the earliest one inside the window is returned', () => {
    store = new LocalStore(dbPath);
    const now = Date.now();
    store.upsertRegistration({
      id: 'r1', name: 'Guest 1', email: 'shared@example.com', phone: '', mode: 'standard',
      registered_at: '2026-01-01T00:00:00.000Z', received_at: now,
    });
    store.upsertRegistration({
      id: 'r2', name: 'Guest 2', email: 'shared@example.com', phone: '', mode: 'standard',
      registered_at: '2026-01-01T00:00:01.000Z', received_at: now + 100,
    });

    const found = store.findDuplicateRegistration({ id: 'r3', email: 'shared@example.com', phone: '', windowStartMs: now - 1000 });
    expect(found).toEqual({ id: 'r1' });
  });
});
