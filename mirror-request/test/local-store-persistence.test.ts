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

  // D-09's sixth status at the SQL layer (07-04-PLAN.md Task 2). Proven against
  // a real temp-file database rather than a mock because all three guarantees
  // this block exists to pin are properties of the SQL itself: the terminal
  // predicate lives in a WHERE clause, the no-retry promise lives in what the
  // SET list OMITS, and the wait-estimate exclusion lives in a different
  // query's WHERE clause entirely.
  //
  // No migration accompanies this status. queue_job.status is `TEXT NOT NULL
  // DEFAULT 'queued'` with no CHECK constraint and no enum, so a new value
  // needs no schema change, and no existing row is a candidate for it — there
  // is nothing to backfill.
  describe('D-09 closeJobNoPhoto() — a session that produced nothing, recorded as exactly that', () => {
    it('closes an in_progress job as no_photo and stamps both session_ended_at and completed_at', () => {
      store = new LocalStore(dbPath);
      const now = Date.now();
      store.enqueueJob({ id: 'job-N1', queued_at: now - 2000 });
      store.updateJobStatus('job-N1', 'in_progress', 'acknowledged_at', now - 1000);

      const closed = store.closeJobNoPhoto('job-N1', now);

      expect(closed).toBe(true);
      const job = store.getJob('job-N1');
      expect(job?.status).toBe('no_photo');
      expect(job?.session_ended_at).toBe(now);
      // completed_at IS set deliberately: the session's duration must stay
      // available to plan 07-05's summary line even though the session
      // produced no photo.
      expect(job?.completed_at).toBe(now);
    });

    it('charges no retry and writes no stall_reason — the two omissions that ARE the guarantee (D-03)', () => {
      store = new LocalStore(dbPath);
      const now = Date.now();
      store.enqueueJob({ id: 'job-N2', queued_at: now - 2000 });
      store.updateJobStatus('job-N2', 'in_progress', 'acknowledged_at', now - 1000);

      store.closeJobNoPhoto('job-N2', now);

      const job = store.getJob('job-N2');
      // Phase 3 D-01/D-13: a system-side fault never spends the guest's retry
      // budget. A guest whose session produced nothing is not called back to a
      // camera they have already walked away from.
      expect(job?.retries).toBe(0);
      // This is not a stall, and OPS-RUNBOOK §6's stall_reason vocabulary is a
      // closed server-authored list this outcome must not join.
      expect(job?.stall_reason ?? null).toBeNull();
    });

    it('cannot close a job that is already completed — the terminal predicate holds', () => {
      store = new LocalStore(dbPath);
      const now = Date.now();
      store.enqueueJob({ id: 'job-N3', queued_at: now - 2000 });
      store.updateJobStatus('job-N3', 'in_progress', 'acknowledged_at', now - 1000);
      store.completeJob('job-N3', now);

      const closed = store.closeJobNoPhoto('job-N3', now + 5000);

      // T-07-16: the writer must not be able to overwrite a completed job's
      // outcome. A guest who got their photo is never retold they got nothing.
      expect(closed).toBe(false);
      expect(store.getJob('job-N3')?.status).toBe('completed');
      expect(store.getJob('job-N3')?.completed_at).toBe(now);
    });

    it('cannot close a job that already failed — the same predicate in the other terminal direction', () => {
      store = new LocalStore(dbPath);
      const now = Date.now();
      store.enqueueJob({ id: 'job-N4', queued_at: now - 2000 });
      store.updateJobStatus('job-N4', 'in_progress', 'acknowledged_at', now - 1000);
      store.failJob('job-N4', 'session_ack_timeout');

      const closed = store.closeJobNoPhoto('job-N4', now);

      expect(closed).toBe(false);
      expect(store.getJob('job-N4')?.status).toBe('failed');
      expect(store.getJob('job-N4')?.stall_reason).toBe('session_ack_timeout');
    });

    it('a second closeJobNoPhoto on an already-closed row matches zero rows and changes nothing', () => {
      store = new LocalStore(dbPath);
      const now = Date.now();
      store.enqueueJob({ id: 'job-N5', queued_at: now - 2000 });
      store.updateJobStatus('job-N5', 'in_progress', 'acknowledged_at', now - 1000);

      expect(store.closeJobNoPhoto('job-N5', now)).toBe(true);
      expect(store.closeJobNoPhoto('job-N5', now + 9000)).toBe(false);
      expect(store.getJob('job-N5')?.completed_at).toBe(now);
    });

    it('the no_photo status survives a close/reopen cycle of the real database file', () => {
      store = new LocalStore(dbPath);
      const now = Date.now();
      store.enqueueJob({ id: 'job-N6', queued_at: now - 2000 });
      store.updateJobStatus('job-N6', 'in_progress', 'acknowledged_at', now - 1000);
      store.closeJobNoPhoto('job-N6', now);
      store.close();

      store = new LocalStore(dbPath);
      // The outcome is a persisted fact rather than an inference (T-07-17), so
      // it stays diagnosable after a restart and after a log rotation.
      expect(store.getJob('job-N6')?.status).toBe('no_photo');
    });

    // D-09's SECOND stated reason for choosing a status over a reason column,
    // measured rather than argued. Both rows below carry a valid
    // acknowledged_at/completed_at pair, so the ONLY thing that can exclude the
    // no-photo row from the sample is the query's own `WHERE status =
    // 'completed'` — not an application-level filter a later edit could delete.
    it('excludes a no_photo row from the wait-estimate sample even with a valid duration pair', () => {
      store = new LocalStore(dbPath);
      const now = Date.now();

      store.enqueueJob({ id: 'job-W1', queued_at: now - 60_000 });
      store.updateJobStatus('job-W1', 'in_progress', 'acknowledged_at', now - 50_000);
      store.completeJob('job-W1', now - 20_000); // duration 30_000

      store.enqueueJob({ id: 'job-W2', queued_at: now - 60_000 });
      store.updateJobStatus('job-W2', 'in_progress', 'acknowledged_at', now - 50_000);
      store.closeJobNoPhoto('job-W2', now - 20_000); // an IDENTICAL duration pair

      const samples = store.getRecentSessionDurationsMs(10);

      expect(samples).toHaveLength(1);
      expect(samples[0]).toBe(30_000);
    });
  });

  // The candidate query behind the no-photo sweep (07-04, Option C — a
  // deviation from the plan's session_end version, see the method's comment).
  // Proven against a real database because all four predicates live in the SQL
  // and one of them is a NOT IN subquery against another table.
  describe('D-03/D-09 getJobsAwaitingNoPhotoClose() — attribution from the row, not from an unattributable event', () => {
    const COMPOSITE = 'C:\\dslrBooth\\Test_event\\Prints\\20260812_143526_970.jpg';
    const CUTOFF = 900_000;

    /** An in_progress job acknowledged `ageMs` ago. */
    function seedInProgress(id: string, now: number, ageMs: number) {
      store!.enqueueJob({ id, queued_at: now - ageMs - 1_000 });
      store!.updateJobStatus(id, 'in_progress', 'acknowledged_at', now - ageMs);
    }

    it('returns an unbound in_progress job whose session is older than the cutoff', () => {
      store = new LocalStore(dbPath);
      const now = Date.now();
      seedInProgress('job-S1', now, CUTOFF + 60_000);

      expect(store.getJobsAwaitingNoPhotoClose(now - CUTOFF, undefined)).toEqual(['job-S1']);
    });

    it('excludes the job the booth is currently serving — this is what protects a live guest', () => {
      store = new LocalStore(dbPath);
      const now = Date.now();
      seedInProgress('job-S2', now, CUTOFF + 60_000);

      // Same row, same age, only the booth binding differs.
      expect(store.getJobsAwaitingNoPhotoClose(now - CUTOFF, 'job-S2')).toEqual([]);
    });

    it('excludes a job whose session has not yet aged past the cutoff', () => {
      store = new LocalStore(dbPath);
      const now = Date.now();
      seedInProgress('job-S3', now, CUTOFF - 60_000);

      expect(store.getJobsAwaitingNoPhotoClose(now - CUTOFF, undefined)).toEqual([]);
    });

    it('excludes a job carrying an open pending_print row — its composite may still be in flight', () => {
      store = new LocalStore(dbPath);
      const now = Date.now();
      seedInProgress('job-S4', now, CUTOFF + 60_000);
      store.openPendingPrint({
        jobId: 'job-S4', compositePath: COMPOSITE, openedAt: now, expiresAt: now + 600_000,
      });

      expect(store.getJobsAwaitingNoPhotoClose(now - CUTOFF, undefined)).toEqual([]);
    });

    it('excludes a job whose pending_print row already EXPIRED — a composite was produced, so it is not a no-photo session', () => {
      store = new LocalStore(dbPath);
      const now = Date.now();
      seedInProgress('job-S5', now, CUTOFF + 60_000);
      store.openPendingPrint({
        jobId: 'job-S5', compositePath: COMPOSITE, openedAt: now - 700_000, expiresAt: now - 100_000,
      });
      store.expirePendingPrints(now); // marks it 'expired'; the row is NOT deleted
      expect(store.getPendingPrint('job-S5')?.status).toBe('expired');

      // "A composite was produced but its upload never arrived" is a different
      // outcome from "no composite was ever produced", and it already has its
      // own warning. Marked-not-deleted is what keeps the two distinguishable.
      expect(store.getJobsAwaitingNoPhotoClose(now - CUTOFF, undefined)).toEqual([]);
    });

    it('excludes every terminal status, so a swept close cannot be repeated', () => {
      store = new LocalStore(dbPath);
      const now = Date.now();
      seedInProgress('job-S6', now, CUTOFF + 60_000);
      seedInProgress('job-S7', now, CUTOFF + 60_000);
      seedInProgress('job-S8', now, CUTOFF + 60_000);
      store.completeJob('job-S6', now);
      store.failJob('job-S7', 'session_ack_timeout');
      store.closeJobNoPhoto('job-S8', now);

      expect(store.getJobsAwaitingNoPhotoClose(now - CUTOFF, undefined)).toEqual([]);
    });

    it('excludes a queued or dispatched job — only an acknowledged session can have produced nothing', () => {
      store = new LocalStore(dbPath);
      const now = Date.now();
      store.enqueueJob({ id: 'job-S9', queued_at: now - 3_600_000 });
      store.enqueueJob({ id: 'job-S10', queued_at: now - 3_600_000 });
      store.updateJobStatus('job-S10', 'dispatched', 'dispatched_at', now - 3_600_000);

      expect(store.getJobsAwaitingNoPhotoClose(now - CUTOFF, undefined)).toEqual([]);
    });

    it('returns several candidates oldest-first and leaves the bound one out', () => {
      store = new LocalStore(dbPath);
      const now = Date.now();
      seedInProgress('job-old', now, CUTOFF + 300_000);
      seedInProgress('job-newer', now, CUTOFF + 60_000);
      seedInProgress('job-live', now, CUTOFF + 120_000);

      expect(store.getJobsAwaitingNoPhotoClose(now - CUTOFF, 'job-live'))
        .toEqual(['job-old', 'job-newer']);
    });
  });

  // D-07/D-08's pending-print registry (07-03-PLAN.md Task 1), proven against
  // a real temp-file database rather than a mock, because the two things this
  // block exists to pin — that the table's migration is idempotent, and that a
  // slot survives a restart — are properties of SQLite, not of the accessor
  // signatures. Every guarantee named here lives in a WHERE clause or an ON
  // CONFLICT, matching the register of the 'persisted-queue SQL contract'
  // block above.
  //
  // The three-status vocabulary is load-bearing and expired rows are never
  // deleted: "a row exists but expired" (D-11's late-but-legitimate print) and
  // "no row was ever opened" (D-04's out-of-session photo) are different
  // answers to a caller, and deleting expired rows would collapse them into
  // one.
  describe('D-07/D-08 pending_print registry — the durable slot for a photo that has not arrived yet', () => {
    const COMPOSITE = 'C:\\dslrBooth\\Test_event\\Prints\\20260812_143526_970.jpg';

    it('openPendingPrint on a fresh database returns true and the row reads back as awaiting', () => {
      store = new LocalStore(dbPath);
      const now = Date.now();

      const opened = store.openPendingPrint({
        jobId: 'job-P1', compositePath: COMPOSITE, openedAt: now, expiresAt: now + 600_000,
      });

      expect(opened).toBe(true);
      const row = store.getPendingPrint('job-P1');
      expect(row).toBeDefined();
      expect(row?.jobId).toBe('job-P1');
      expect(row?.compositePath).toBe(COMPOSITE);
      expect(row?.status).toBe('awaiting');
      expect(row?.openedAt).toBe(now);
      expect(row?.expiresAt).toBe(now + 600_000);
    });

    it('getPendingPrint returns undefined for a jobId no slot was ever opened for — D-04 must stay distinguishable', () => {
      store = new LocalStore(dbPath);
      expect(store.getPendingPrint('job-never-opened')).toBeUndefined();
    });

    // RESEARCH.md Pitfall 2: processing_start and printing both carry the same
    // composite, so the completion path fires twice for one session. The ON
    // CONFLICT DO NOTHING is what absorbs that — it must never become an
    // upsert, or the second fire would silently extend the first slot's
    // deadline.
    it('a second openPendingPrint for the same jobId returns false and overwrites neither composite_path nor expires_at', () => {
      store = new LocalStore(dbPath);
      const now = Date.now();
      store.openPendingPrint({ jobId: 'job-P2', compositePath: COMPOSITE, openedAt: now, expiresAt: now + 600_000 });

      const second = store.openPendingPrint({
        jobId: 'job-P2', compositePath: 'C:\\other\\path.jpg', openedAt: now + 5_000, expiresAt: now + 999_999,
      });

      expect(second).toBe(false);
      const row = store.getPendingPrint('job-P2');
      expect(row?.compositePath).toBe(COMPOSITE);
      expect(row?.expiresAt).toBe(now + 600_000);
      expect(row?.openedAt).toBe(now);
      expect(row?.status).toBe('awaiting');
    });

    it('markPendingPrintFinalized moves an awaiting row to resolved once, and a second call matches zero rows', () => {
      store = new LocalStore(dbPath);
      const now = Date.now();
      store.openPendingPrint({ jobId: 'job-P3', compositePath: COMPOSITE, openedAt: now, expiresAt: now + 600_000 });

      const first = store.markPendingPrintFinalized('job-P3', 'printing', now + 1_000);
      expect(first.matched).toBe(true);
      expect(store.getPendingPrint('job-P3')?.status).toBe('resolved');
      expect(store.getPendingPrint('job-P3')?.approvedBy).toBe('printing');

      // D11-05: the absence of 'resolved' from the predicate IS the guarantee
      // that a second door firing for the same job cannot enqueue a second
      // notification — the same T-07-12 discipline the old resolve accessor
      // pinned, now extended with the approval columns.
      const second = store.markPendingPrintFinalized('job-P3', 'grace', now + 2_000);
      expect(second.matched).toBe(false);
      expect(store.getPendingPrint('job-P3')?.status).toBe('resolved');
      // The second door did NOT overwrite who actually approved it.
      expect(store.getPendingPrint('job-P3')?.approvedBy).toBe('printing');
    });

    it('markPendingPrintFinalized moves an EXPIRED row to resolved — D-11s late arrival is still resolvable', () => {
      store = new LocalStore(dbPath);
      const now = Date.now();
      store.openPendingPrint({ jobId: 'job-P4', compositePath: COMPOSITE, openedAt: now - 10, expiresAt: now - 1 });
      store.expirePendingPrints(now);
      expect(store.getPendingPrint('job-P4')?.status).toBe('expired');

      const result = store.markPendingPrintFinalized('job-P4', 'grace', now + 1_000);
      expect(result.matched).toBe(true);
      expect(store.getPendingPrint('job-P4')?.status).toBe('resolved');
    });

    it('markPendingPrintFinalized returns the held photoUrl/attemptNo, read before the write, and undefined for the fields that were never set', () => {
      store = new LocalStore(dbPath);
      const now = Date.now();
      store.openPendingPrint({ jobId: 'job-P4b', compositePath: COMPOSITE, openedAt: now, expiresAt: now + 600_000 });
      store.setPendingPrintPhotoUrl('job-P4b', 'https://fotoshare.co/i/held');

      const result = store.markPendingPrintFinalized('job-P4b', 'printing', now + 1_000);
      expect(result).toEqual({ matched: true, photoUrl: 'https://fotoshare.co/i/held', attemptNo: undefined });
    });

    it('markPendingPrintFinalized on a jobId with NO row still finalizes — the empty-session case (Q3) never strands the guest', () => {
      store = new LocalStore(dbPath);
      const now = Date.now();

      const first = store.markPendingPrintFinalized('job-no-row', 'grace', now);
      expect(first).toEqual({ matched: true, photoUrl: undefined, attemptNo: undefined });
      expect(store.getPendingPrint('job-no-row')?.status).toBe('resolved');
      expect(store.getPendingPrint('job-no-row')?.approvedBy).toBe('grace');

      // Idempotent here too: a second door firing for the same never-opened
      // job is a no-op, exactly like the "a slot existed" case above.
      const second = store.markPendingPrintFinalized('job-no-row', 'operator', now + 1_000);
      expect(second.matched).toBe(false);
    });

    it('expirePendingPrints returns only awaiting rows already past expires_at, and returns each of them exactly once', () => {
      store = new LocalStore(dbPath);
      const now = Date.now();
      store.openPendingPrint({ jobId: 'job-due', compositePath: COMPOSITE, openedAt: now - 10, expiresAt: now });
      store.openPendingPrint({ jobId: 'job-not-due', compositePath: COMPOSITE, openedAt: now, expiresAt: now + 600_000 });
      store.openPendingPrint({ jobId: 'job-already-resolved', compositePath: COMPOSITE, openedAt: now - 10, expiresAt: now });
      store.markPendingPrintFinalized('job-already-resolved', 'printing', now);

      const first = store.expirePendingPrints(now);

      expect(first.map((r) => r.jobId)).toEqual(['job-due']);
      expect(first[0].compositePath).toBe(COMPOSITE);
      expect(store.getPendingPrint('job-due')?.status).toBe('expired');
      expect(store.getPendingPrint('job-not-due')?.status).toBe('awaiting');
      expect(store.getPendingPrint('job-already-resolved')?.status).toBe('resolved');

      // The select and the mark share one transaction, so a row can never be
      // handed to the caller without also being marked — otherwise the
      // no-print warning would fire on every sweep, forever.
      const second = store.expirePendingPrints(now);
      expect(second).toEqual([]);
    });

    it('an expired row is marked, never deleted — the evidence that separates D-11 from D-04 survives', () => {
      store = new LocalStore(dbPath);
      const now = Date.now();
      store.openPendingPrint({ jobId: 'job-P5', compositePath: COMPOSITE, openedAt: now - 10, expiresAt: now - 1 });
      store.expirePendingPrints(now);

      const row = store.getPendingPrint('job-P5');
      expect(row).toBeDefined();
      expect(row?.status).toBe('expired');
      expect(row?.compositePath).toBe(COMPOSITE);
    });

    it('a slot written before close() is still present, unexpired, with the same status and expires_at after reopening the same file (D-08)', () => {
      store = new LocalStore(dbPath);
      const now = Date.now();
      store.openPendingPrint({ jobId: 'job-P6', compositePath: COMPOSITE, openedAt: now, expiresAt: now + 600_000 });
      store.close();

      store = new LocalStore(dbPath);
      const row = store.getPendingPrint('job-P6');
      expect(row?.status).toBe('awaiting');
      expect(row?.expiresAt).toBe(now + 600_000);
      expect(row?.compositePath).toBe(COMPOSITE);
      // Still unexpired: a mid-session restart no longer loses the fact that a
      // photo is owed.
      expect(store.expirePendingPrints(now + 1_000)).toEqual([]);
    });

    it('the pending_print migration is idempotent: constructing LocalStore twice against the same file neither throws nor loses rows', () => {
      store = new LocalStore(dbPath);
      const now = Date.now();
      store.openPendingPrint({ jobId: 'job-P7', compositePath: COMPOSITE, openedAt: now, expiresAt: now + 600_000 });
      store.close();

      expect(() => {
        store = new LocalStore(dbPath);
      }).not.toThrow();

      const row = store!.getPendingPrint('job-P7');
      expect(row?.status).toBe('awaiting');
      expect(row?.openedAt).toBe(now);
      expect(row?.expiresAt).toBe(now + 600_000);
      expect(row?.compositePath).toBe(COMPOSITE);
      store!.close();
      store = undefined;

      // Throwaway raw introspection handle — the same pattern this file
      // already uses for notification_record and booth_state.
      const introspect = new Database(dbPath);
      const columns = introspect.prepare('PRAGMA table_info(pending_print)').all() as Array<{ name: string }>;
      introspect.close();

      const columnNames = columns.map((c) => c.name);
      expect(columnNames).toHaveLength(11);
      for (const expected of [
        'jobId', 'composite_path', 'status', 'opened_at', 'expires_at', 'resolved_at', 'updated_at',
        'photo_url', 'attempt_no', 'approved_by', 'approved_at',
      ]) {
        expect(columnNames).toContain(expected);
      }
    });
  });

  // =========================================================================
  // Phase 11 (D11-01/D11-02/D11-04/D11-05) — the retake migration and its
  // accessors, proven against a real database rather than the mocked
  // registry test/helpers/pendingPrintRegistry.ts stands in for elsewhere.
  //
  // The migration cases below deliberately build the PRE-Phase-11 shape of
  // booth_state/pending_print with a raw better-sqlite3 handle FIRST, the
  // same idiom this file already uses for notification_record above
  // (createOldShapeTable) — bootstrap() gives a brand-new temp database the
  // new columns directly, so constructing a store against a freshly-created
  // file would never exercise the "at least one column was actually added"
  // migration gate at all. This is the only version of this test that can
  // catch a booth-state writer silently reverting a real pre-existing row.
  // =========================================================================
  describe('D11-01/D11-04/D11-05 pending-print/booth-state migration and accessors', () => {
    const COMPOSITE_11 = 'C:\\dslrBooth\\Test_event\\Prints\\20260818_101511_776.jpg';

    function createPreP11Tables(row: {
      boothState: string;
      boothCurrentJobId: string | null;
      pendingJobId: string;
      pendingCompositePath: string;
      pendingStatus: string;
      pendingOpenedAt: number;
      pendingExpiresAt: number;
    }) {
      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE booth_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          state TEXT NOT NULL DEFAULT 'IDLE',
          updated_at TEXT NOT NULL DEFAULT 'now',
          current_job_id TEXT
        );
        CREATE TABLE pending_print (
          jobId          TEXT PRIMARY KEY,
          composite_path TEXT,
          status         TEXT NOT NULL DEFAULT 'awaiting',
          opened_at      INTEGER NOT NULL,
          expires_at     INTEGER NOT NULL,
          resolved_at    INTEGER,
          updated_at     TEXT NOT NULL DEFAULT 'now'
        );
      `);
      raw.prepare(
        'INSERT INTO booth_state (id, state, updated_at, current_job_id) VALUES (1, ?, ?, ?)'
      ).run(row.boothState, new Date().toISOString(), row.boothCurrentJobId);
      raw.prepare(
        `INSERT INTO pending_print (jobId, composite_path, status, opened_at, expires_at, resolved_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`
      ).run(row.pendingJobId, row.pendingCompositePath, row.pendingStatus, row.pendingOpenedAt, row.pendingExpiresAt, new Date().toISOString());
      raw.close();
    }

    it('opening a LocalStore on a temp file that already carries pre-Phase-11 booth_state and pending_print rows adds the six columns and preserves every existing value', () => {
      const now = Date.now();
      createPreP11Tables({
        boothState: 'BUSY',
        boothCurrentJobId: 'job-pre11',
        pendingJobId: 'job-pre11',
        pendingCompositePath: COMPOSITE_11,
        pendingStatus: 'awaiting',
        pendingOpenedAt: now - 1_000,
        pendingExpiresAt: now + 600_000,
      });

      store = new LocalStore(dbPath);

      const boothColumns = (
        new Database(dbPath, { readonly: true }).prepare('PRAGMA table_info(booth_state)').all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(boothColumns).toEqual(['id', 'state', 'updated_at', 'current_job_id', 'attempt_open', 'attempt_no']);

      const pendingColumns = (
        new Database(dbPath, { readonly: true }).prepare('PRAGMA table_info(pending_print)').all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(pendingColumns).toEqual([
        'jobId', 'composite_path', 'status', 'opened_at', 'expires_at', 'resolved_at', 'updated_at',
        'photo_url', 'attempt_no', 'approved_by', 'approved_at',
      ]);

      // Every pre-existing value survives, byte-for-byte.
      expect(store.getBoothState()).toBe('BUSY');
      expect(store.getBoothCurrentJobId()).toBe('job-pre11');
      const pending = store.getPendingPrint('job-pre11');
      expect(pending?.compositePath).toBe(COMPOSITE_11);
      expect(pending?.status).toBe('awaiting');
      expect(pending?.openedAt).toBe(now - 1_000);
      expect(pending?.expiresAt).toBe(now + 600_000);
      // And the new columns read back as the correct "not yet known" default.
      expect(pending?.photoUrl).toBeUndefined();
      expect(pending?.attemptNo).toBeUndefined();
      expect(pending?.approvedBy).toBeUndefined();
      expect(pending?.approvedAt).toBeUndefined();
    });

    it('running the migration twice against the same pre-Phase-11 file adds nothing the second time and throws nothing', () => {
      createPreP11Tables({
        boothState: 'IDLE',
        boothCurrentJobId: null,
        pendingJobId: 'job-pre11-idem',
        pendingCompositePath: COMPOSITE_11,
        pendingStatus: 'awaiting',
        pendingOpenedAt: Date.now(),
        pendingExpiresAt: Date.now() + 600_000,
      });

      store = new LocalStore(dbPath);
      store.close();

      expect(() => {
        store = new LocalStore(dbPath);
      }).not.toThrow();

      const boothColumns = (
        new Database(dbPath, { readonly: true }).prepare('PRAGMA table_info(booth_state)').all() as Array<{ name: string }>
      ).map((c) => c.name);
      const pendingColumns = (
        new Database(dbPath, { readonly: true }).prepare('PRAGMA table_info(pending_print)').all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(boothColumns).toEqual(['id', 'state', 'updated_at', 'current_job_id', 'attempt_open', 'attempt_no']);
      expect(pendingColumns).toHaveLength(11);

      // The pre-existing row is still there, unharmed by the no-op re-migration.
      const pending = store!.getPendingPrint('job-pre11-idem');
      expect(pending?.compositePath).toBe(COMPOSITE_11);
    });

    it('every pre-existing booth_state row reads back with the open flag and the counter at 0 after migration', () => {
      createPreP11Tables({
        boothState: 'BUSY',
        boothCurrentJobId: 'job-attempt-default',
        pendingJobId: 'job-attempt-default',
        pendingCompositePath: COMPOSITE_11,
        pendingStatus: 'awaiting',
        pendingOpenedAt: Date.now(),
        pendingExpiresAt: Date.now() + 600_000,
      });

      store = new LocalStore(dbPath);
      expect(store.getBoothAttempt()).toEqual({ attemptOpen: false, attemptNo: 0 });
    });

    it('each of the four booth-state replace-writers leaves attempt_open/attempt_no at 0 after an attempt was open — the INSERT OR REPLACE column-omission hazard cannot revert them silently because it cannot revert what is already explicit', () => {
      store = new LocalStore(dbPath);

      store.setBoothBusy('job-writer-1');
      store.openBoothAttempt();
      expect(store.getBoothAttempt()).toEqual({ attemptOpen: true, attemptNo: 1 });
      store.setBoothState('ANNOUNCING');
      expect(store.getBoothAttempt()).toEqual({ attemptOpen: false, attemptNo: 0 });

      store.setBoothBusy('job-writer-2');
      store.openBoothAttempt();
      expect(store.getBoothAttempt().attemptOpen).toBe(true);
      store.setBoothBusy('job-writer-3');
      expect(store.getBoothAttempt()).toEqual({ attemptOpen: false, attemptNo: 0 });

      store.setBoothBusy('job-writer-4');
      store.openBoothAttempt();
      expect(store.getBoothAttempt().attemptOpen).toBe(true);
      store.setBoothIdle();
      expect(store.getBoothAttempt()).toEqual({ attemptOpen: false, attemptNo: 0 });

      store.setBoothBusy('job-writer-5');
      store.openBoothAttempt();
      expect(store.getBoothAttempt().attemptOpen).toBe(true);
      store.setBoothTimeout('test-reset');
      expect(store.getBoothAttempt()).toEqual({ attemptOpen: false, attemptNo: 0 });
    });

    it('openBoothAttempt() increments attempt_no across repeated retakes; closeBoothAttempt() clears only the open flag', () => {
      store = new LocalStore(dbPath);
      store.setBoothBusy('job-attempts');

      expect(store.openBoothAttempt()).toEqual({ attemptOpen: true, attemptNo: 1 });
      store.closeBoothAttempt();
      expect(store.getBoothAttempt()).toEqual({ attemptOpen: false, attemptNo: 1 });

      expect(store.openBoothAttempt()).toEqual({ attemptOpen: true, attemptNo: 2 });
      store.closeBoothAttempt();
      expect(store.getBoothAttempt()).toEqual({ attemptOpen: false, attemptNo: 2 });
    });

    it('openOrOverwritePendingPrint with the SAME composite path leaves the stored row byte-identical and reports "unchanged"', () => {
      store = new LocalStore(dbPath);
      const now = Date.now();
      store.openOrOverwritePendingPrint({
        jobId: 'job-ov-1', compositePath: COMPOSITE_11, attemptNo: 1, openedAt: now, expiresAt: now + 600_000,
      });
      store.setPendingPrintPhotoUrl('job-ov-1', 'https://fotoshare.co/i/attempt1');
      const before = store.getPendingPrint('job-ov-1');

      const outcome = store.openOrOverwritePendingPrint({
        jobId: 'job-ov-1', compositePath: COMPOSITE_11, attemptNo: 1, openedAt: now + 999, expiresAt: now + 999_999,
      });

      expect(outcome).toBe('unchanged');
      expect(store.getPendingPrint('job-ov-1')).toEqual(before);
    });

    it('openOrOverwritePendingPrint with a DIFFERENT composite path replaces the composite, attempt number and deadline, and clears the prior photoUrl — reports "overwritten"', () => {
      store = new LocalStore(dbPath);
      const now = Date.now();
      const attempt2Composite = 'C:\\dslrBooth\\Test_event\\Prints\\20260818_101548_163.jpg';
      store.openOrOverwritePendingPrint({
        jobId: 'job-ov-2', compositePath: COMPOSITE_11, attemptNo: 1, openedAt: now, expiresAt: now + 600_000,
      });
      store.setPendingPrintPhotoUrl('job-ov-2', 'https://fotoshare.co/i/rejected-attempt-1');

      const outcome = store.openOrOverwritePendingPrint({
        jobId: 'job-ov-2', compositePath: attempt2Composite, attemptNo: 2, openedAt: now + 20_000, expiresAt: now + 620_000,
      });

      expect(outcome).toBe('overwritten');
      const row = store.getPendingPrint('job-ov-2');
      expect(row?.compositePath).toBe(attempt2Composite);
      expect(row?.attemptNo).toBe(2);
      expect(row?.expiresAt).toBe(now + 620_000);
      // The discarded attempt's URL must never survive to be sent later.
      expect(row?.photoUrl).toBeUndefined();
    });

    it('openOrOverwritePendingPrint on a jobId with no prior row opens it and reports "opened"', () => {
      store = new LocalStore(dbPath);
      const now = Date.now();
      const outcome = store.openOrOverwritePendingPrint({
        jobId: 'job-ov-3', compositePath: COMPOSITE_11, attemptNo: 1, openedAt: now, expiresAt: now + 600_000,
      });
      expect(outcome).toBe('opened');
      expect(store.getPendingPrint('job-ov-3')?.status).toBe('awaiting');
    });

    it('setPendingPrintPhotoUrl writes against an awaiting/expired slot, and — D-11s late-arrival case — exactly once against a resolved slot with no URL yet, never twice', () => {
      store = new LocalStore(dbPath);
      const now = Date.now();

      // Ordinary path.
      store.openPendingPrint({ jobId: 'job-url-1', compositePath: COMPOSITE_11, openedAt: now, expiresAt: now + 600_000 });
      expect(store.setPendingPrintPhotoUrl('job-url-1', 'https://fotoshare.co/i/ordinary')).toBe(true);
      expect(store.getPendingPrint('job-url-1')?.status).toBe('awaiting');

      // Finalized with NO url (grace/operator closed it no_photo) — the late
      // write matches exactly once.
      store.openPendingPrint({ jobId: 'job-url-2', compositePath: COMPOSITE_11, openedAt: now, expiresAt: now + 600_000 });
      store.markPendingPrintFinalized('job-url-2', 'grace', now + 1_000);
      expect(store.getPendingPrint('job-url-2')?.photoUrl).toBeUndefined();

      const firstLateWrite = store.setPendingPrintPhotoUrl('job-url-2', 'https://fotoshare.co/i/late');
      expect(firstLateWrite).toBe(true);
      expect(store.getPendingPrint('job-url-2')?.status).toBe('resolved'); // untouched
      expect(store.getPendingPrint('job-url-2')?.photoUrl).toBe('https://fotoshare.co/i/late');

      const secondLateWrite = store.setPendingPrintPhotoUrl('job-url-2', 'https://fotoshare.co/i/late-replay');
      expect(secondLateWrite).toBe(false);
      expect(store.getPendingPrint('job-url-2')?.photoUrl).toBe('https://fotoshare.co/i/late');
    });

    it('setPendingPrintPhotoUrl never matches a resolved slot that already has a URL — the double-delivery no-op', () => {
      store = new LocalStore(dbPath);
      const now = Date.now();
      store.openPendingPrint({ jobId: 'job-url-3', compositePath: COMPOSITE_11, openedAt: now, expiresAt: now + 600_000 });
      store.setPendingPrintPhotoUrl('job-url-3', 'https://fotoshare.co/i/first');
      store.markPendingPrintFinalized('job-url-3', 'printing', now + 1_000);

      const replay = store.setPendingPrintPhotoUrl('job-url-3', 'https://fotoshare.co/i/replayed');
      expect(replay).toBe(false);
      expect(store.getPendingPrint('job-url-3')?.photoUrl).toBe('https://fotoshare.co/i/first');
    });
  });

  // =========================================================================
  // Phase 8 — the four new tables (CMS-03, D-10, D-11, D-18)
  //
  // Proved against the REAL temp-file database this file already opens, never
  // a mock: an idempotency claim about SQLite DDL that is only ever exercised
  // against a fake proves something about the fake.
  // =========================================================================

  describe('Phase 8 tables — event, active_event, event_photo, agent_config (CMS-03)', () => {
    const PHASE_8_TABLES = ['event', 'active_event', 'event_photo', 'agent_config'];

    function tableNames(path: string): string[] {
      const introspect = new Database(path, { readonly: true });
      const rows = introspect
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      introspect.close();
      return rows.map((r) => r.name);
    }

    it('opening the same file three times creates the four tables once and throws on none of the opens', () => {
      store = new LocalStore(dbPath);
      const afterFirst = tableNames(dbPath);
      store.close();

      expect(() => {
        store = new LocalStore(dbPath);
      }).not.toThrow();
      store!.close();

      expect(() => {
        store = new LocalStore(dbPath);
      }).not.toThrow();

      const afterThird = tableNames(dbPath);

      // Same set, same cardinality — a CREATE that ran twice, or a table that
      // was dropped and recreated, would show up as drift here.
      expect(afterThird).toEqual(afterFirst);
      for (const table of PHASE_8_TABLES) {
        expect(afterThird.filter((n) => n === table)).toHaveLength(1);
      }
    });

    it('leaves every pre-Phase-8 table byte-identical in shape (D-01 boundary)', () => {
      store = new LocalStore(dbPath);
      store.close();
      store = undefined;

      // The pre-Phase-8 baseline, pinned as literals. Phase 8 was
      // additive-only: if any migration ever adds, drops, or renames a
      // column on one of these five, this case fails and names the table.
      // booth_state/pending_print's arrays were updated for Phase 11
      // (D11-01/D11-04/D11-05, both additive — see the migration idempotency
      // block below for the same two tables proven against a real database).
      const baseline: Record<string, string[]> = {
        registration: ['id', 'name', 'email', 'phone', 'mode', 'registered_at', 'raw_payload', 'received_at'],
        queue_job: [
          'id', 'registration_id', 'status', 'queued_at', 'dispatched_at', 'acknowledged_at',
          'session_started_at', 'session_ended_at', 'completed_at', 'ack_error_message',
          'stall_reason', 'retries',
        ],
        booth_state: ['id', 'state', 'updated_at', 'current_job_id', 'attempt_open', 'attempt_no'],
        notification_record: ['jobId', 'status', 'attempts', 'lastError', 'photoUrl', 'dueAt', 'updatedAt'],
        pending_print: [
          'jobId', 'composite_path', 'status', 'opened_at', 'expires_at', 'resolved_at', 'updated_at',
          'photo_url', 'attempt_no', 'approved_by', 'approved_at',
        ],
      };

      const introspect = new Database(dbPath, { readonly: true });
      for (const [table, expected] of Object.entries(baseline)) {
        const columns = (
          introspect.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
        ).map((c) => c.name);
        expect(columns, `${table} changed shape since this baseline was last updated`).toEqual(expected);
      }
      introspect.close();
    });

    it('refuses a second active_event row — the CHECK (id = 1) constraint throws (D-01)', () => {
      store = new LocalStore(dbPath);
      store.setActiveEvent('some-event');
      store.close();
      store = undefined;

      const raw = new Database(dbPath);
      expect(() =>
        raw.prepare('INSERT INTO active_event (id, event_id, updated_at) VALUES (2, ?, ?)').run('other', 'now'),
      ).toThrow();
      const count = raw.prepare('SELECT COUNT(*) AS n FROM active_event').get() as { n: number };
      raw.close();
      expect(count.n).toBe(1);
    });

    it('rows written to event, event_photo and agent_config survive a close and reopen (CMS-03)', () => {
      store = new LocalStore(dbPath);
      const created = store.createEvent({ name: 'Tiệc cưới B' });
      store.setActiveEvent(created.id);
      store.recordEventPhoto({
        jobId: 'job-1',
        eventId: created.id,
        guestName: 'Nguyễn Văn A',
        photoUrl: 'https://example.test/a.jpg',
        capturedAt: 1_700_000_000_000,
      });
      store.saveAgentConfig({ logLevel: 'debug', autoOpenDisplay: true });
      store.close();

      store = new LocalStore(dbPath);
      expect(store.getEventConfig(created.id)?.name).toBe('Tiệc cưới B');
      expect(store.getActiveEventId()).toBe(created.id);
      expect(store.getMostRecentEventPhoto(created.id)).toEqual({
        photoUrl: 'https://example.test/a.jpg',
        guestName: 'Nguyễn Văn A',
        capturedAt: 1_700_000_000_000,
      });
      expect(store.getAgentConfig()).toEqual({ logLevel: 'debug', autoOpenDisplay: true });
    });

    it('recordEventPhoto is idempotent on jobId — one print composite per session, one row (D-10)', () => {
      store = new LocalStore(dbPath);
      const event = store.createEvent({ name: 'Sự kiện ảnh' });

      expect(
        store.recordEventPhoto({
          jobId: 'job-dup', eventId: event.id, guestName: 'Khách A',
          photoUrl: 'https://example.test/first.jpg', capturedAt: 1000,
        }),
      ).toBe(true);
      // A replayed file_upload must not overwrite the original capture.
      expect(
        store.recordEventPhoto({
          jobId: 'job-dup', eventId: event.id, guestName: 'Khách A',
          photoUrl: 'https://example.test/second.jpg', capturedAt: 2000,
        }),
      ).toBe(false);

      expect(store.countEventPhotos(event.id)).toBe(1);
      expect(store.getMostRecentEventPhoto(event.id)?.photoUrl).toBe('https://example.test/first.jpg');
    });

    it('getMostRecentEventPhoto returns the newest row for that event only, and undefined when it has none', () => {
      store = new LocalStore(dbPath);
      const eventA = store.createEvent({ name: 'A' });
      const eventB = store.createEvent({ name: 'B' });

      store.recordEventPhoto({ jobId: 'a1', eventId: eventA.id, guestName: 'A1', photoUrl: 'a1.jpg', capturedAt: 100 });
      store.recordEventPhoto({ jobId: 'a2', eventId: eventA.id, guestName: 'A2', photoUrl: 'a2.jpg', capturedAt: 300 });
      store.recordEventPhoto({ jobId: 'a3', eventId: eventA.id, guestName: 'A3', photoUrl: 'a3.jpg', capturedAt: 200 });
      // Newer than every eventA row, and must NOT be returned for eventA.
      store.recordEventPhoto({ jobId: 'b1', eventId: eventB.id, guestName: 'B1', photoUrl: 'b1.jpg', capturedAt: 900 });

      expect(store.getMostRecentEventPhoto(eventA.id)?.photoUrl).toBe('a2.jpg');
      expect(store.getMostRecentEventPhoto(eventB.id)?.photoUrl).toBe('b1.jpg');
      expect(store.getMostRecentEventPhoto('no-such-event')).toBeUndefined();

      // The projection is narrow by construction — no event_id, no jobId.
      expect(Object.keys(store.getMostRecentEventPhoto(eventA.id)!).sort()).toEqual([
        'capturedAt', 'guestName', 'photoUrl',
      ]);
    });

    it('listEventPhotos returns newest-first and honours both limit and offset', () => {
      store = new LocalStore(dbPath);
      const event = store.createEvent({ name: 'Phân trang' });
      for (let i = 1; i <= 5; i += 1) {
        store.recordEventPhoto({
          jobId: `p${i}`, eventId: event.id, guestName: `Khách ${i}`,
          photoUrl: `p${i}.jpg`, capturedAt: i * 100,
        });
      }

      expect(store.listEventPhotos(event.id, { limit: 2, offset: 0 }).map((p) => p.photoUrl))
        .toEqual(['p5.jpg', 'p4.jpg']);
      expect(store.listEventPhotos(event.id, { limit: 2, offset: 2 }).map((p) => p.photoUrl))
        .toEqual(['p3.jpg', 'p2.jpg']);
      expect(store.listEventPhotos(event.id, { limit: 50, offset: 4 }).map((p) => p.photoUrl))
        .toEqual(['p1.jpg']);
      expect(store.countEventPhotos(event.id)).toBe(5);
    });

    it('deleteEventPhotos removes only that event rows and returns the deleted count (D-11)', () => {
      store = new LocalStore(dbPath);
      const eventA = store.createEvent({ name: 'A' });
      const eventB = store.createEvent({ name: 'B' });
      store.recordEventPhoto({ jobId: 'a1', eventId: eventA.id, guestName: 'A1', photoUrl: 'a1.jpg', capturedAt: 1 });
      store.recordEventPhoto({ jobId: 'a2', eventId: eventA.id, guestName: 'A2', photoUrl: 'a2.jpg', capturedAt: 2 });
      store.recordEventPhoto({ jobId: 'b1', eventId: eventB.id, guestName: 'B1', photoUrl: 'b1.jpg', capturedAt: 3 });

      expect(store.deleteEventPhotos(eventA.id)).toBe(2);
      expect(store.countEventPhotos(eventA.id)).toBe(0);
      // D-11: deletion is per-event and explicit. B is untouched.
      expect(store.countEventPhotos(eventB.id)).toBe(1);
      expect(store.getMostRecentEventPhoto(eventB.id)?.photoUrl).toBe('b1.jpg');
      // Deleting again is a no-op, not an error.
      expect(store.deleteEventPhotos(eventA.id)).toBe(0);
    });

    it('saveAgentConfig rotates current into previous, and restore steps back exactly once (D-18)', () => {
      store = new LocalStore(dbPath);

      store.saveAgentConfig({ logLevel: 'info' });
      expect(store.getAgentConfig()).toEqual({ logLevel: 'info' });
      // Nothing to step back to yet.
      expect(store.restorePreviousAgentConfig()).toBeUndefined();
      expect(store.getAgentConfig()).toEqual({ logLevel: 'info' });

      store.saveAgentConfig({ logLevel: 'debug' });
      expect(store.getAgentConfig()).toEqual({ logLevel: 'debug' });

      expect(store.restorePreviousAgentConfig()).toEqual({ logLevel: 'info' });
      expect(store.getAgentConfig()).toEqual({ logLevel: 'info' });

      // D-18 is ONE step back, not a history. A second restore must not
      // silently rotate again and hand back the 'debug' config the operator
      // just rejected.
      expect(store.restorePreviousAgentConfig()).toBeUndefined();
      expect(store.getAgentConfig()).toEqual({ logLevel: 'info' });
    });

    it('agent_config is a single row — a second insert is refused by CHECK (id = 1)', () => {
      store = new LocalStore(dbPath);
      store.saveAgentConfig({ logLevel: 'info' });
      store.saveAgentConfig({ logLevel: 'warn' });
      store.close();
      store = undefined;

      const raw = new Database(dbPath);
      const count = raw.prepare('SELECT COUNT(*) AS n FROM agent_config').get() as { n: number };
      expect(count.n).toBe(1);
      expect(() =>
        raw.prepare('INSERT INTO agent_config (id, current_json) VALUES (2, ?)').run('{}'),
      ).toThrow();
      raw.close();
    });
  });
});
