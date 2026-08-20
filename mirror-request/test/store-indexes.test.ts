import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { LocalStore } from '../src/state/localStore';

// ---------------------------------------------------------------------------
// The three indexes added after the 2026-08-16 audit found thirteen tables and
// zero indexes.
//
// "The index exists" is not the claim worth testing — a CREATE INDEX statement
// that SQLite's planner never chooses costs write throughput and buys nothing,
// and it would still make an existence assertion pass. Every case below
// therefore asks the planner, through EXPLAIN QUERY PLAN, whether it actually
// uses the index for the real query text taken from localStore.ts. If someone
// later reorders a WHERE clause or flips a sort direction so the index stops
// being usable, these go red; an existence check would not.
//
// The last case is the one that protects a deployment rather than a
// benchmark: it proves indexes are created AFTER migrate(), by opening a
// database whose notification_record predates the dueAt column.
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];
const openStores: LocalStore[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-indexes-'));
  tmpDirs.push(dir);
  return dir;
}

function makeStore(dbPath?: string): LocalStore {
  const store = new LocalStore(dbPath ?? path.join(makeTmpDir(), 'store.sqlite'));
  openStores.push(store);
  return store;
}

/** The private handle, reached the way the store's own tests reach it. */
function db(store: LocalStore): Database.Database {
  return (store as unknown as { db: Database.Database }).db;
}

function plan(store: LocalStore, sql: string, ...params: unknown[]): string {
  const rows = db(store)
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...(params as never[])) as Array<{ detail: string }>;
  return rows.map((r) => r.detail).join(' | ');
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
    fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
  }
});

describe('SQLite indexes on the hot paths', () => {
  it('creates all three indexes on a fresh database', () => {
    const store = makeStore();
    const names = (
      db(store).prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>
    ).map((r) => r.name);

    expect(names).toContain('idx_event_photo_event_captured');
    expect(names).toContain('idx_queue_job_status_queued_at');
    expect(names).toContain('idx_notification_status_due');
  });

  it('opening the same database twice is a no-op, not an error', () => {
    const dbPath = path.join(makeTmpDir(), 'reopen.sqlite');
    makeStore(dbPath).close();
    // CREATE INDEX without IF NOT EXISTS would throw here, on every boot after
    // the first — i.e. on every real restart of a service that has run once.
    expect(() => makeStore(dbPath)).not.toThrow();
  });

  it('the planner uses the event_photo index for the display feed query', () => {
    const store = makeStore();
    // The exact shape of listEventPhotos(): equality on event_id, descending
    // sort on captured_at. The index declares captured_at DESC so the sort
    // step disappears too — assert on both halves.
    const detail = plan(
      store,
      'SELECT jobId FROM event_photo WHERE event_id = ? ORDER BY captured_at DESC LIMIT ? OFFSET ?',
      'evt',
      5,
      0,
    );
    expect(detail).toContain('idx_event_photo_event_captured');
    expect(detail).not.toContain('SCAN event_photo');
    expect(detail).not.toContain('USE TEMP B-TREE FOR ORDER BY');
  });

  it('the planner uses the queue_job index for the up-next query', () => {
    const store = makeStore();
    const detail = plan(store, "SELECT id FROM queue_job WHERE status = 'queued' ORDER BY queued_at ASC LIMIT 5");
    expect(detail).toContain('idx_queue_job_status_queued_at');
    expect(detail).not.toContain('SCAN queue_job');
    expect(detail).not.toContain('USE TEMP B-TREE FOR ORDER BY');
  });

  it('the planner uses the notification index for the sweeper query', () => {
    const store = makeStore();
    const detail = plan(
      store,
      `SELECT jobId FROM notification_record
       WHERE status IN ('pending','retrying','sending') AND dueAt <= ? AND photoUrl IS NOT NULL
       ORDER BY dueAt ASC`,
      1,
    );
    expect(detail).toContain('idx_notification_status_due');
    expect(detail).not.toContain('SCAN notification_record');
  });

  it('opens a database whose notification_record predates the dueAt column', () => {
    // The ordering hazard, made concrete. This is the shape of a database
    // written before the persisted-queue migration: notification_record
    // exists, but without photoUrl or dueAt. If createIndexes() ran inside
    // bootstrap() — before migrate()'s ALTER TABLE — the index on dueAt would
    // reference a column that does not exist yet and the constructor would
    // throw, taking down startup on exactly the databases migrate() exists to
    // rescue.
    const dbPath = path.join(makeTmpDir(), 'legacy.sqlite');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE notification_record (
        jobId TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        lastError TEXT,
        updatedAt TEXT NOT NULL DEFAULT 'now'
      );
    `);
    legacy.prepare("INSERT INTO notification_record (jobId, status) VALUES ('legacy-1', 'pending')").run();
    legacy.close();

    let store!: LocalStore;
    expect(() => {
      store = makeStore(dbPath);
    }).not.toThrow();

    const names = (
      db(store).prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(names).toContain('idx_notification_status_due');

    // And the pre-existing row survived: an index is additive, and D-14 says
    // operational data is the operator's to delete, not a migration's.
    const kept = db(store).prepare("SELECT jobId FROM notification_record WHERE jobId = 'legacy-1'").get();
    expect(kept).toBeTruthy();
  });
});
