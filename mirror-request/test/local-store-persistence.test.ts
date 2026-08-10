import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { LocalStore, getStore } from '../src/state/localStore';

describe('LocalStore persistence — webhook replay + poll cursor', () => {
  let dir: string;
  let dbPath: string;
  let store: LocalStore | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-store-'));
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

  it('hasSeenWebhookId is false on a fresh database, true after recordWebhookId', () => {
    store = new LocalStore(dbPath);
    expect(store.hasSeenWebhookId('wh-1')).toBe(false);
    store.recordWebhookId('wh-1', Date.now());
    expect(store.hasSeenWebhookId('wh-1')).toBe(true);
  });

  it('recordWebhookId called twice with the same id does not throw and leaves countWebhookIds() at 1', () => {
    store = new LocalStore(dbPath);
    const t = Date.now();
    expect(() => store!.recordWebhookId('wh-1', t)).not.toThrow();
    expect(() => store!.recordWebhookId('wh-1', t)).not.toThrow();
    expect(store.countWebhookIds()).toBe(1);
  });

  it('a webhook id recorded before close() is still reported as seen after reopening the same database file', () => {
    store = new LocalStore(dbPath);
    store.recordWebhookId('wh-1', Date.now());
    store.close();

    store = new LocalStore(dbPath);
    expect(store.hasSeenWebhookId('wh-1')).toBe(true);
  });

  it('the poll cursor survives a close/reopen cycle', () => {
    store = new LocalStore(dbPath);
    store.setCursor('registrations', 'cursor-value-1');
    store.close();

    store = new LocalStore(dbPath);
    expect(store.getCursor('registrations')).toBe('cursor-value-1');
  });

  it('getStore() with no argument still resolves the configured LOCAL_STORE_PATH exactly as before', () => {
    // getStore() is a process-wide singleton bound to CONFIG.LOCAL_STORE_PATH
    // (set to ./data/test-extension-service.sqlite by vitest.config.ts's test.env
    // block); this is unrelated to the throwaway `store` created above.
    const singleton = getStore();
    expect(singleton).toBeInstanceOf(LocalStore);
    expect(singleton.hasSeenWebhookId('nonexistent')).toBe(false);
  });

  // notification_record migration — D-13/NOT-02. A pre-existing database's
  // notification_record predates photoUrl/dueAt entirely, so the only way to
  // exercise migrate()'s backfill gate is to build that old-shape table with
  // a raw better-sqlite3 handle first: bootstrap() gives any brand-new temp
  // database the new columns directly, so writing a row through
  // saveNotification() and reopening would never make the "at least one
  // column was actually added" gate fire (the same trap 04-01's
  // notification-sweeper-restart.test.ts already documents and works around).
  // Precedent for the raw-table construction: on-register-dedup.test.ts's
  // received_at migration case.
  describe('notification_record migration', () => {
    function createOldShapeTable(row: { jobId: string; status: string; attempts: number; lastError: string | null }) {
      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE notification_record (
          jobId TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          lastError TEXT,
          updatedAt TEXT NOT NULL DEFAULT 'now'
        );
      `);
      raw.prepare(
        `INSERT INTO notification_record (jobId, status, attempts, lastError, updatedAt)
         VALUES (?, ?, ?, ?, ?)`
      ).run(row.jobId, row.status, row.attempts, row.lastError, new Date().toISOString());
      raw.close();
    }

    it('a pre-migration row with no photoUrl is marked failed with the honest-failure reason on reopen (D-13)', () => {
      const jobId = `job-premigration-honest-${Date.now()}`;
      createOldShapeTable({ jobId, status: 'pending', attempts: 1, lastError: null });

      store = new LocalStore(dbPath);
      const record = store.getNotification(jobId);
      expect(record?.status).toBe('failed');
      expect(record?.lastError).toMatch(/photoUrl unavailable/);
    });

    it('reopening the migrated database a third time changes nothing further (idempotent)', () => {
      const jobId = `job-premigration-idempotent-${Date.now()}`;
      createOldShapeTable({ jobId, status: 'pending', attempts: 1, lastError: null });

      // First open: migrate() adds the columns and runs the backfill once.
      store = new LocalStore(dbPath);
      store.close();

      // Second open: the columns already exist, so the "column actually
      // added" gate does not fire and the backfill does not run again.
      store = new LocalStore(dbPath);
      const afterSecondOpen = store.getNotification(jobId);
      expect(afterSecondOpen?.status).toBe('failed');
      expect(afterSecondOpen?.lastError).toMatch(/photoUrl unavailable/);
      store.close();

      // Third open: strictly a no-op — no exception, record byte-for-byte
      // the same as it was after the second open.
      expect(() => {
        store = new LocalStore(dbPath);
      }).not.toThrow();
      const afterThirdOpen = store!.getNotification(jobId);
      expect(afterThirdOpen?.status).toBe('failed');
      expect(afterThirdOpen?.lastError).toBe(afterSecondOpen?.lastError);
      expect(afterThirdOpen?.attempts).toBe(afterSecondOpen?.attempts);
    });

    it('the migration is additive-only — no original notification_record column is dropped', () => {
      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE notification_record (
          jobId TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          lastError TEXT,
          updatedAt TEXT NOT NULL DEFAULT 'now'
        );
      `);
      raw.close();

      store = new LocalStore(dbPath);
      store.close();
      store = new LocalStore(dbPath);
      store.close();
      store = undefined;

      // Throwaway introspection handle — this is a test-only concern and
      // deliberately does not become a new LocalStore method.
      const introspect = new Database(dbPath);
      const columns = introspect.prepare('PRAGMA table_info(notification_record)').all() as Array<{ name: string }>;
      introspect.close();

      const columnNames = columns.map((c) => c.name);
      for (const expected of ['jobId', 'status', 'attempts', 'lastError', 'updatedAt', 'photoUrl', 'dueAt']) {
        expect(columnNames).toContain(expected);
      }
    });

    it('a pre-existing delivered row is left untouched by the migration backfill', () => {
      const jobId = `job-premigration-delivered-${Date.now()}`;
      createOldShapeTable({ jobId, status: 'delivered', attempts: 3, lastError: null });

      store = new LocalStore(dbPath);
      const record = store.getNotification(jobId);
      expect(record?.status).toBe('delivered');
      expect(record?.lastError).toBeFalsy();
    });
  });

  // Persisted-queue SQL contract — every guarantee in this block lives in a
  // WHERE clause or a COALESCE, not an application-level `if`; each case
  // names the guarantee it pins and is written so it fails if that clause
  // were deleted (D-04, D-05, D-13).
  describe('persisted-queue SQL contract', () => {
    it('enqueueNotification makes a row due once its due time has passed, not before', () => {
      store = new LocalStore(dbPath);
      const jobId = `job-queue-due-${Date.now()}`;
      const now = Date.now();
      store.enqueueNotification({ jobId, photoUrl: 'https://cdn.example/a.jpg', dueAt: now });

      const due = store.getDueNotifications(now);
      const dueRow = due.find((r) => r.jobId === jobId);
      expect(dueRow).toBeDefined();
      expect(dueRow?.photoUrl).toBe('https://cdn.example/a.jpg');

      const notYetDue = store.getDueNotifications(now - 1000);
      expect(notYetDue.some((r) => r.jobId === jobId)).toBe(false);
    });

    it('a repeat enqueueNotification does not re-arm a delivered row (D-05)', () => {
      store = new LocalStore(dbPath);
      const jobId = `job-queue-terminal-delivered-${Date.now()}`;
      const now = Date.now();
      store.enqueueNotification({ jobId, photoUrl: 'https://cdn.example/b.jpg', dueAt: now });
      store.saveNotification({ jobId, status: 'delivered', attempts: 1, photoUrl: 'https://cdn.example/b.jpg', dueAt: now });

      store.enqueueNotification({ jobId, photoUrl: 'https://cdn.example/b-retry.jpg', dueAt: now });

      const record = store.getNotification(jobId);
      expect(record?.status).toBe('delivered');
      expect(store.getDueNotifications(now + 1).some((r) => r.jobId === jobId)).toBe(false);
    });

    it('a repeat enqueueNotification does not re-arm a failed row (D-05)', () => {
      store = new LocalStore(dbPath);
      const jobId = `job-queue-terminal-failed-${Date.now()}`;
      const now = Date.now();
      store.enqueueNotification({ jobId, photoUrl: 'https://cdn.example/c.jpg', dueAt: now });
      store.saveNotification({
        jobId, status: 'failed', attempts: 3, photoUrl: 'https://cdn.example/c.jpg', dueAt: now, lastError: 'exhausted',
      });

      store.enqueueNotification({ jobId, photoUrl: 'https://cdn.example/c-retry.jpg', dueAt: now });

      const record = store.getNotification(jobId);
      expect(record?.status).toBe('failed');
      expect(store.getDueNotifications(now + 1).some((r) => r.jobId === jobId)).toBe(false);
    });

    it('a status-only saveNotification write preserves the persisted photo URL (COALESCE guard)', () => {
      store = new LocalStore(dbPath);
      const jobId = `job-queue-coalesce-${Date.now()}`;
      const now = Date.now();
      store.enqueueNotification({ jobId, photoUrl: 'https://cdn.example/d.jpg', dueAt: now });

      // Supplies no photoUrl — without COALESCE(excluded.photoUrl,
      // notification_record.photoUrl) this would null the column.
      store.saveNotification({ jobId, status: 'retrying', attempts: 1, dueAt: now });

      const record = store.getNotification(jobId);
      expect(record?.photoUrl).toBe('https://cdn.example/d.jpg');
      const due = store.getDueNotifications(now);
      const dueRow = due.find((r) => r.jobId === jobId);
      expect(dueRow?.photoUrl).toBe('https://cdn.example/d.jpg');
    });

    it('claimNotification transitions once per lease and the row self-heals after lease expiry (D-05)', () => {
      store = new LocalStore(dbPath);
      const jobId = `job-queue-claim-${Date.now()}`;
      const now = Date.now();
      const lease = 5000;
      store.enqueueNotification({ jobId, photoUrl: 'https://cdn.example/e.jpg', dueAt: now });

      const firstClaim = store.claimNotification(jobId, now, now + lease);
      expect(firstClaim).toBe(true);

      const secondClaim = store.claimNotification(jobId, now, now + lease);
      expect(secondClaim).toBe(false);

      expect(store.getDueNotifications(now).some((r) => r.jobId === jobId)).toBe(false);
      expect(store.getDueNotifications(now + lease + 1).some((r) => r.jobId === jobId)).toBe(true);
    });

    it('a row with no photo URL is never returned as due', () => {
      store = new LocalStore(dbPath);
      const jobId = `job-queue-nullphoto-${Date.now()}`;
      const now = Date.now();
      store.saveNotification({ jobId, status: 'pending', attempts: 0, dueAt: now });

      expect(store.getDueNotifications(now).some((r) => r.jobId === jobId)).toBe(false);
    });
  });
});
