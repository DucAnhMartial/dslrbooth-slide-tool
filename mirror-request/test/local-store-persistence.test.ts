import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { LocalStore, getStore } from '../src/state/localStore';
import { seedRegistrationsCursor, REGISTERED_AT_LEXICAL_PATTERN } from '../src/ops/seedRegistrationsCursor';

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

  // D-06's cursor seed (06-04-PLAN.md). These cases drive the lexical-
  // collision proof as plain string comparisons over literal constants —
  // needing neither MySQL nor a clock — plus the seeded value's round trip
  // and idempotency against a real, file-backed LocalStore.
  describe('D-06 registrations cursor seed — lexical format is load-bearing', () => {
    // Same instant T, two shapes: the VIEW's own DATE_FORMAT lexical form
    // (space separator, 6-digit microseconds) vs. the ISO-8601 form anyone
    // would write by reflex (new Date().toISOString()).
    const ISO_SEED_AT_T = '2026-08-11T14:00:00.000Z';
    const VIEW_SEED_AT_T = '2026-08-11 14:00:00.000000';
    // A VIEW-format registered_at one second after T, same calendar day —
    // the row a correctly-seeded cursor must still admit.
    const VIEW_TIMESTAMP_ONE_SECOND_LATER = '2026-08-11 14:00:01.000000';
    const SHIPPED_DEFAULT_CURSOR = '1970-01-01T00:00:00.000Z';

    it('an ISO-8601 seed at T compares as NOT less than a VIEW-format timestamp one second later on the same day — the collision', () => {
      // dbPoller.ts:101 filters `registered_at > ?` (cursor). Restated as
      // that exact comparison: the VIEW-format row is NOT greater than the
      // ISO-shaped seed, so it would be silently filtered out and never
      // ingested — the entire failure mode this plan exists to prevent.
      expect(VIEW_TIMESTAMP_ONE_SECOND_LATER > ISO_SEED_AT_T).toBe(false);
      // Equivalently: the ISO seed is NOT less than the later VIEW value.
      expect(ISO_SEED_AT_T < VIEW_TIMESTAMP_ONE_SECOND_LATER).toBe(false);
    });

    it('a VIEW-format seed at T IS less than a VIEW-format timestamp one second later — the same registration is ingested', () => {
      expect(VIEW_SEED_AT_T < VIEW_TIMESTAMP_ONE_SECOND_LATER).toBe(true);
      expect(VIEW_TIMESTAMP_ONE_SECOND_LATER > VIEW_SEED_AT_T).toBe(true);
    });

    it('a VIEW-format value is greater than the shipped 1970-01-01T00:00:00.000Z default under < and >', () => {
      expect(VIEW_SEED_AT_T > SHIPPED_DEFAULT_CURSOR).toBe(true);
      expect(SHIPPED_DEFAULT_CURSOR < VIEW_SEED_AT_T).toBe(true);
    });

    it('seeds a real LocalStore and getCursor(\'registrations\') returns exactly the seeded string, matching REGISTERED_AT_LEXICAL_PATTERN', () => {
      store = new LocalStore(dbPath);
      store.setCursor('registrations', VIEW_SEED_AT_T);

      const readBack = store.getCursor('registrations');
      expect(readBack).toBe(VIEW_SEED_AT_T);
      expect(readBack).toMatch(REGISTERED_AT_LEXICAL_PATTERN);
    });

    it('seeding twice overwrites rather than appending — exactly one row exists for the registrations poll key', () => {
      store = new LocalStore(dbPath);
      store.setCursor('registrations', VIEW_SEED_AT_T);
      store.setCursor('registrations', VIEW_TIMESTAMP_ONE_SECOND_LATER);

      // Throwaway raw introspection handle — same pattern this file already
      // uses for the notification_record migration's column check above;
      // deliberately not a new LocalStore method.
      const raw = new Database(dbPath);
      const row = raw.prepare('SELECT COUNT(*) AS n FROM db_poll_cursor WHERE poll_key = ?').get('registrations') as { n: number };
      raw.close();

      expect(row.n).toBe(1);
      expect(store.getCursor('registrations')).toBe(VIEW_TIMESTAMP_ONE_SECOND_LATER);
    });

    it('seedRegistrationsCursor contains no call to toISOString on any path that can produce the seed value', () => {
      // Reads the function's own source text rather than trusting a file-
      // level grep count — this project's house rule against
      // comment-matching false positives applies to source scans too.
      expect(seedRegistrationsCursor.toString()).not.toMatch(/toISOString/);
    });
  });

  // SC-2's other half (07-01-PLAN.md <sc2_reconciliation>). The mocked-store
  // proof in test/queue-dual-completion.test.ts shows the RIGHT job id
  // reaches the store under a genuinely queued second guest; this block
  // proves that id is the ONLY row the SQL can touch, against a real
  // temp-file database with two real rows. Each case names the guarantee it
  // pins, matching the register of the 'persisted-queue SQL contract' block
  // above.
  describe('D-06 booth_state.current_job_id and jobId-scoped completeJob() — SC-2 proven at the SQL layer', () => {
    it('the booth_state.current_job_id migration is idempotent: two constructions add the column once and touch no row (D-06)', () => {
      store = new LocalStore(dbPath);
      const jobId = `job-migration-idempotency-${Date.now()}`;
      store.enqueueJob({ id: jobId, queued_at: Date.now() });
      store.close();

      // Throwaway raw introspection handle after the first construction —
      // same pattern this file already uses for notification_record.
      let introspect = new Database(dbPath);
      let columns = introspect.prepare('PRAGMA table_info(booth_state)').all() as Array<{ name: string }>;
      introspect.close();
      expect(columns.map((c) => c.name)).toContain('current_job_id');

      expect(() => {
        store = new LocalStore(dbPath);
      }).not.toThrow();

      introspect = new Database(dbPath);
      columns = introspect.prepare('PRAGMA table_info(booth_state)').all() as Array<{ name: string }>;
      introspect.close();
      expect(columns.map((c) => c.name)).toContain('current_job_id');

      // The migration adds a column and touches no row — the pre-existing
      // job seeded before the second construction is still readable,
      // unchanged in status.
      const job = store!.getJob(jobId);
      expect(job).toBeDefined();
      expect(job?.status).toBe('queued');
    });

    it('the booth binding round-trips through the real column and survives a reopen', () => {
      store = new LocalStore(dbPath);
      store.setBoothBusy('job-A');
      expect(store.getBoothCurrentJobId()).toBe('job-A');

      store.setBoothIdle();
      expect(store.getBoothCurrentJobId()).toBeUndefined();

      store.setBoothCurrentJob('job-B');
      expect(store.getBoothCurrentJobId()).toBe('job-B');
      store.close();

      store = new LocalStore(dbPath);
      expect(store.getBoothCurrentJobId()).toBe('job-B');
    });

    // THE SC-2 SQL-LAYER CASE, the load-bearing one. Guest A's
    // acknowledged_at is deliberately EARLIER than guest B's — exactly the
    // ordering the removed positional selection (`ORDER BY acknowledged_at
    // DESC LIMIT 1`) would have used to pick the WRONG row (guest B, the
    // most recently acknowledged) instead of the one actually named by
    // jobId (guest A).
    it('completeJob(jobId) reaches only the named row, proven against a real database with two in_progress rows (SC-2)', () => {
      store = new LocalStore(dbPath);
      const now = Date.now();
      store.enqueueJob({ id: 'job-A', queued_at: now - 2000 });
      store.enqueueJob({ id: 'job-B', queued_at: now - 1000 });
      // job-A acknowledged FIRST (earlier timestamp) — this is the ordering
      // the removed positional selection would have inverted.
      store.updateJobStatus('job-A', 'in_progress', 'acknowledged_at', now - 500);
      store.updateJobStatus('job-B', 'in_progress', 'acknowledged_at', now);

      const completed = store.completeJob('job-A', now + 1000);

      expect(completed).toBe(true);
      expect(store.getJob('job-A')?.status).toBe('completed');
      expect(store.getJob('job-B')?.status).toBe('in_progress');
    });

    it('a duplicate completeJob call on an already-completed row matches zero rows and leaves the other guest untouched', () => {
      store = new LocalStore(dbPath);
      const now = Date.now();
      store.enqueueJob({ id: 'job-A', queued_at: now - 2000 });
      store.enqueueJob({ id: 'job-B', queued_at: now - 1000 });
      store.updateJobStatus('job-A', 'in_progress', 'acknowledged_at', now - 500);
      store.updateJobStatus('job-B', 'in_progress', 'acknowledged_at', now);

      const first = store.completeJob('job-A', now + 1000);
      expect(first).toBe(true);
      const completedAtAfterFirst = store.getJob('job-A')?.completed_at;

      // The second delivery of the processing_start/printing double-fire —
      // this is the `AND status = 'in_progress'` predicate reporting a
      // zero-row match, absorbing the duplicate without an
      // application-level flag.
      const second = store.completeJob('job-A', now + 5000);

      expect(second).toBe(false);
      expect(store.getJob('job-A')?.completed_at).toBe(completedAtAfterFirst);
      expect(store.getJob('job-B')?.status).toBe('in_progress');
    });

    it('a terminal (failed) row is not reachable by completeJob — the same predicate holds in the other terminal direction', () => {
      store = new LocalStore(dbPath);
      const now = Date.now();
      store.enqueueJob({ id: 'job-C', queued_at: now - 1000 });
      store.updateJobStatus('job-C', 'in_progress', 'acknowledged_at', now);
      store.failJob('job-C', 'session_ack_timeout');

      const result = store.completeJob('job-C', now + 1000);

      expect(result).toBe(false);
      expect(store.getJob('job-C')?.status).toBe('failed');
    });
  });
});
