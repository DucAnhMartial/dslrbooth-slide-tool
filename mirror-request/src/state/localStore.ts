import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { getConfig } from '../config';
import logger from '../logging/logger';
import type { Registration, QueueJob, BoothState, NotificationRecord } from '../types';

const CONFIG = getConfig();

export class LocalStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolved = path.resolve(dbPath ?? CONFIG.LOCAL_STORE_PATH);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    this.db = new Database(resolved);
    this.db.pragma('journal_mode = WAL');
    this.bootstrap();
    this.migrate();
  }

  bootstrap(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS registration (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT NOT NULL,
        mode TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        raw_payload TEXT,
        received_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS queue_job (
        id TEXT PRIMARY KEY,
        registration_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        queued_at INTEGER NOT NULL,
        dispatched_at INTEGER,
        acknowledged_at INTEGER,
        session_started_at INTEGER,
        session_ended_at INTEGER,
        completed_at INTEGER,
        ack_error_message TEXT,
        stall_reason TEXT,
        retries INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS processed_id (
        reg_id TEXT PRIMARY KEY,
        processed_at TEXT NOT NULL DEFAULT 'now'
      );
      CREATE TABLE IF NOT EXISTS db_poll_cursor (
        poll_key TEXT PRIMARY KEY,
        last_value TEXT NOT NULL,
        updated_at TEXT DEFAULT 'now'
      );
      CREATE TABLE IF NOT EXISTS notification_record (
      jobId TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      lastError TEXT,
      photoUrl TEXT,
      dueAt INTEGER,
      updatedAt TEXT NOT NULL DEFAULT 'now'
    );
    CREATE TABLE IF NOT EXISTS booth_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state TEXT NOT NULL DEFAULT 'IDLE',
        updated_at TEXT NOT NULL DEFAULT 'now'
      );
      CREATE TABLE IF NOT EXISTS webhook_replay (
        webhook_id TEXT PRIMARY KEY,
        received_at INTEGER NOT NULL
      );
    `);
  }

  migrate(): void {
    // Additive-only migrations. This database file carries live operational
    // data that D-14 says only the operator may delete, so migrations here
    // must never drop or recreate a table — only add columns and backfill.
    const columns = this.db.prepare('PRAGMA table_info(registration)').all() as Array<{ name: string }>;
    const hasReceivedAt = columns.some((c) => c.name === 'received_at');
    if (!hasReceivedAt) {
      this.db.exec('ALTER TABLE registration ADD COLUMN received_at INTEGER');
      this.db.prepare('UPDATE registration SET received_at = ? WHERE received_at IS NULL').run(Date.now());
    }

    // notification_record: D-13. photoUrl was never a persisted column
    // before this phase — it only ever existed on the wire inside one
    // file_upload WebSocket event and was never written to queue_job or
    // registration, so a pre-existing non-terminal row has nothing to
    // recover a photo URL from. Marking it terminal here is the only honest
    // option; fabricating a placeholder URL would POST a bogus image to the
    // slideshow. The backfill runs only when a column was actually added
    // this call, so an already-migrated database is never rescanned (and
    // never re-fails a legitimately in-flight row) on every boot. No blanket
    // dueAt backfill is added: the status write above already makes every
    // matching row terminal, and terminal rows are never selected by the
    // sweeper's getDueNotifications() query.
    const notifColumns = this.db.prepare('PRAGMA table_info(notification_record)').all() as Array<{ name: string }>;
    const hasPhotoUrl = notifColumns.some((c) => c.name === 'photoUrl');
    const hasDueAt = notifColumns.some((c) => c.name === 'dueAt');
    let notifColumnAdded = false;
    if (!hasPhotoUrl) {
      this.db.exec('ALTER TABLE notification_record ADD COLUMN photoUrl TEXT');
      notifColumnAdded = true;
    }
    if (!hasDueAt) {
      this.db.exec('ALTER TABLE notification_record ADD COLUMN dueAt INTEGER');
      notifColumnAdded = true;
    }
    if (notifColumnAdded) {
      this.db.prepare(
        `UPDATE notification_record
         SET status = 'failed', lastError = 'photoUrl unavailable — record predates persisted-queue migration'
         WHERE photoUrl IS NULL AND status NOT IN ('delivered','failed')`
      ).run();
    }

    // booth_state.current_job_id — D-06's server-held attribution source of
    // truth for which job currently owns the booth. No backfill: NULL means
    // "no job owns the booth", which is the correct value for every
    // pre-existing row. Re-running this on an already-migrated database is a
    // no-op, proven against a real temp-file database in
    // local-store-persistence.test.ts, the same way the pending_print table
    // is proven in plan 07-03.
    const boothColumns = this.db.prepare('PRAGMA table_info(booth_state)').all() as Array<{ name: string }>;
    const hasCurrentJobId = boothColumns.some((c) => c.name === 'current_job_id');
    if (!hasCurrentJobId) {
      this.db.exec('ALTER TABLE booth_state ADD COLUMN current_job_id TEXT');
    }
  }

  // registrations
  upsertRegistration(r: Registration & { raw_payload?: string; received_at?: number }): Registration {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO registration (id, name, email, phone, mode, registered_at, raw_payload, received_at)
       VALUES (@id, @name, @email, @phone, @mode, @registered_at, @raw_payload, @received_at)`
    );
    stmt.run({
      id: r.id, name: r.name, email: r.email, phone: r.phone,
      mode: r.mode, registered_at: r.registered_at,
      raw_payload: r.raw_payload ?? null,
      received_at: r.received_at ?? Date.now(),
    });
    return r;
  }

  getRegistration(id: string): Registration | undefined {
    return this.db.prepare('SELECT * FROM registration WHERE id = ?').get(id) as Registration | undefined;
  }

  saveRawPayload(id: string, json: string): void {
    this.db.prepare('UPDATE registration SET raw_payload = ? WHERE id = ?').run(json, id);
  }

  // dedup: same id, or same non-empty email/phone, seen inside the window
  findDuplicateRegistration(args: { id: string; email: string; phone: string; windowStartMs: number }): { id: string } | undefined {
    const byId = this.db
      .prepare('SELECT id FROM registration WHERE id = ? AND received_at >= ?')
      .get(args.id, args.windowStartMs) as { id: string } | undefined;
    if (byId) return byId;

    return this.db
      .prepare(
        `SELECT id FROM registration
         WHERE received_at >= ?
           AND ((? <> '' AND email = ?)
             OR (? <> '' AND phone = ?))
         ORDER BY received_at ASC LIMIT 1`
      )
      .get(args.windowStartMs, args.email, args.email, args.phone, args.phone) as { id: string } | undefined;
  }

  // queue
  //
  // Logs the FIFO position at the single choke point both ingestion paths
  // (the webhook receiver and the DB poller) already call, so one log line
  // covers both (M2 success criterion 1, QUE-01). D-11: this adds no new
  // deduplication mechanism — the `INSERT OR IGNORE` below, unchanged, plus
  // Phase 1's `processed_id` table remain the only guard; the `changes === 0`
  // branch only observes that guarantee.
  enqueueJob(j: { id: string; queued_at: number }): void {
    const result = this.db.prepare(
      `INSERT OR IGNORE INTO queue_job (id, registration_id, status, queued_at) VALUES (@id, @id, 'queued', @queued_at)`
    ).run({ id: j.id, queued_at: j.queued_at });

    if (result.changes === 0) {
      logger.info(`Job ${j.id} is already queued and was not re-queued`);
      return;
    }

    const pos = this.getQueuePosition(j.id) ?? 0;
    const len = this.getQueueLength();
    logger.info(`Queued job ${j.id} at position ${pos} of ${len}`);
  }

  updateJobStatus(id: string, status: QueueJob['status'], tsField: keyof QueueJob, tsValue: number): void {
    const map: Record<string, string> = {
      dispatched_at: 'dispatched_at', acknowledged_at: 'acknowledged_at',
      session_started_at: 'session_started_at', session_ended_at: 'session_ended_at',
      completed_at: 'completed_at',
    };
    const field = map[tsField];
    this.db.prepare(`UPDATE queue_job SET status = ?, ${field} = ? WHERE id = ?`).run(status, tsValue, id);
  }

  getQueuedJobs(): QueueJob[] {
    return this.db.prepare("SELECT * FROM queue_job WHERE status = 'queued' ORDER BY queued_at ASC").all() as QueueJob[];
  }

  getJob(id: string): QueueJob | undefined {
    return this.db.prepare('SELECT * FROM queue_job WHERE id = ?').get(id) as QueueJob | undefined;
  }

  getNextQueuedJob(): QueueJob | undefined {
    return this.db.prepare("SELECT * FROM queue_job WHERE status = 'queued' ORDER BY queued_at ASC LIMIT 1").get() as QueueJob | undefined;
  }

  getQueuedGuestSummaries(limit = 5): Array<{ jobId: string; name: string; position: number }> {
    const rows = this.db.prepare(`
      SELECT q.id AS jobId, r.name AS name
      FROM queue_job q
      JOIN registration r ON r.id = q.registration_id
      WHERE q.status = 'queued'
      ORDER BY q.queued_at ASC
      LIMIT ?
    `).all(limit) as Array<{ jobId: string; name: string }>;
    return rows.map((row, index) => ({ ...row, position: index + 1 }));
  }

  // Replaces the removed completeInProgressJob(), which selected the job to
  // complete by ORDER BY acknowledged_at DESC LIMIT 1 with no jobId
  // parameter at all — the exact mechanism behind WINDOWS item 8: with a
  // queue behind the booth, guest A's second session_end completed guest B.
  // completeJob() is scoped by jobId the way failJob() above is, and reports
  // whether it matched the way claimNotification() below does.
  //
  // The trailing `AND status = 'in_progress'` is not a defensive extra — it
  // is what makes the double delivery of processing_start then printing
  // idempotent without an application-level flag: the second UPDATE matches
  // zero rows and this returns false. No completion path may ever again
  // select a row by ordering or with LIMIT — doing so would re-arm the exact
  // defect this method exists to remove.
  completeJob(jobId: string, completedAt: number): boolean {
    const result = this.db.prepare(
      "UPDATE queue_job SET status = 'completed', session_ended_at = ?, completed_at = ? WHERE id = ? AND status = 'in_progress'"
    ).run(completedAt, completedAt, jobId);
    return result.changes === 1;
  }

  getInFlightJobs(): QueueJob[] {
    return this.db.prepare(
      "SELECT * FROM queue_job WHERE status IN ('dispatched','in_progress') ORDER BY dispatched_at DESC"
    ).all() as QueueJob[];
  }

  // queued_at is deliberately absent from the SET list below — this omission
  // IS D-06's guarantee that a requeued guest keeps their original place in
  // line (getNextQueuedJob() orders by queued_at ASC).
  requeueWithRetry(jobId: string): { retries: number } {
    this.db.prepare(
      "UPDATE queue_job SET status = 'queued', retries = retries + 1 WHERE id = ?"
    ).run(jobId);
    const row = this.db.prepare('SELECT retries FROM queue_job WHERE id = ?').get(jobId) as { retries: number } | undefined;
    return { retries: row?.retries ?? 0 };
  }

  // A deliberate sibling of requeueWithRetry() above, not a variant of it.
  // queued_at is absent from the SET list for the same reason it is absent
  // there — that omission IS D-06's guarantee that a requeued guest keeps
  // their original place in line, since getNextQueuedJob() orders by
  // queued_at ASC. retries is also deliberately absent: a system-side fault
  // (the Agent itself dying) must never spend the guest's retry budget
  // (D-01, D-12) — that budget exists to bound a bad *job*, not to punish a
  // guest for the booth's own failure. Do not add a retry count return, a
  // row read-back, or a parameter; the two methods staying trivially
  // different at the call site is what keeps the D-01 contrast visible in
  // the code.
  requeueNoRetry(jobId: string): void {
    this.db.prepare("UPDATE queue_job SET status = 'queued' WHERE id = ?").run(jobId);
  }

  failJob(jobId: string, stallReason: string): void {
    this.db.prepare(
      "UPDATE queue_job SET status = 'failed', stall_reason = ? WHERE id = ?"
    ).run(stallReason, jobId);
  }

  // idempotency
  isProcessed(regId: string): boolean {
    return this.db.prepare('SELECT 1 FROM processed_id WHERE reg_id = ?').get(regId) !== undefined;
  }

  markProcessed(regId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO processed_id (reg_id) VALUES (?)').run(regId);
  }

  // webhook replay protection
  hasSeenWebhookId(webhookId: string): boolean {
    return this.db.prepare('SELECT 1 FROM webhook_replay WHERE webhook_id = ?').get(webhookId) !== undefined;
  }

  recordWebhookId(webhookId: string, receivedAt: number): void {
    this.db.prepare('INSERT OR IGNORE INTO webhook_replay (webhook_id, received_at) VALUES (?, ?)').run(webhookId, receivedAt);
  }

  countWebhookIds(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM webhook_replay').get() as { n: number };
    return Number(row.n);
  }

  // cursor
  getCursor(pollKey: string): string | undefined {
    const row = this.db.prepare('SELECT last_value FROM db_poll_cursor WHERE poll_key = ?').get(pollKey) as { last_value: string } | undefined;
    return row?.last_value;
  }

  setCursor(pollKey: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO db_poll_cursor (poll_key, last_value, updated_at) VALUES (?, ?, ?)').run(pollKey, value, new Date().toISOString());
  }

  // booth state machine
  getBoothState(): BoothState {
    const row = this.db.prepare("SELECT state FROM booth_state WHERE id = 1").get() as { state: string } | undefined;
    return (row?.state ?? 'IDLE') as BoothState;
  }

  // INSERT OR REPLACE deletes the row and inserts a new one, so any column
  // left out of the column list silently reverts to its default. Every
  // writer below names current_job_id explicitly rather than relying on
  // that side effect.
  setBoothState(state: BoothState): void {
    // Its only production caller is beginAnnouncement()'s 'ANNOUNCING'
    // write, when no job owns the booth yet — current_job_id stays NULL.
    this.db.prepare("INSERT OR REPLACE INTO booth_state (id, state, updated_at, current_job_id) VALUES (1, ?, ?, NULL)").run(state, new Date().toISOString());
  }

  setBoothBusy(jobId: string | null = null): void {
    this.db.prepare("INSERT OR REPLACE INTO booth_state (id, state, updated_at, current_job_id) VALUES (1, 'BUSY', ?, ?)").run(new Date().toISOString(), jobId);
  }

  // The explicit NULL here IS D-06's "cleared when the booth is released"
  // guarantee, the same discipline requeueNoRetry() applies to retries: it
  // must not be replaced by an application-level clear that a later edit
  // could delete. current_job_id's absence from the booth once it is IDLE is
  // enforced by this write itself, not by a caller remembering to clear it.
  setBoothIdle(): void {
    this.db.prepare("INSERT OR REPLACE INTO booth_state (id, state, updated_at, current_job_id) VALUES (1, 'IDLE', ?, NULL)").run(new Date().toISOString());
  }

  setBoothTimeout(reason: string): void {
    this.db.prepare("INSERT OR REPLACE INTO booth_state (id, state, updated_at, current_job_id) VALUES (1, 'IDLE', ?, NULL)").run(new Date().toISOString());
    logger.warn(`Booth timeout reset: ${reason}`);
  }

  // D-06: the server-held attribution source of truth. A NULL column and a
  // missing row are deliberately indistinguishable to the caller — both mean
  // "no job owns the booth right now".
  getBoothCurrentJobId(): string | undefined {
    const row = this.db.prepare('SELECT current_job_id FROM booth_state WHERE id = 1').get() as
      | { current_job_id: string | null }
      | undefined;
    return row?.current_job_id ?? undefined;
  }

  // Re-affirms the booth->job binding at ack (D-06), independent of
  // setBoothBusy()'s own write at dispatch time.
  setBoothCurrentJob(jobId: string | null): void {
    this.db.prepare('UPDATE booth_state SET current_job_id = ?, updated_at = ? WHERE id = 1').run(jobId, new Date().toISOString());
  }

  getBoothStateDetailed(): { state: BoothState; updated_at: string } {
    const row = this.db.prepare("SELECT state, updated_at FROM booth_state WHERE id = 1").get() as { state: string; updated_at: string } | undefined;
    if (!row) return { state: 'IDLE', updated_at: new Date().toISOString() };
    return { state: row.state as BoothState, updated_at: row.updated_at };
  }

  getQueuePosition(jobId: string): number | undefined {
    const job = this.getJob(jobId);
    if (!job || job.status !== 'queued') return undefined;
    const queued = this.getQueuedJobs();
    const idx = queued.findIndex((j) => j.id === jobId);
    return idx >= 0 ? idx + 1 : undefined;
  }

  getQueueLength(): number {
    return this.getQueuedJobs().length;
  }

  // D-02's poisoned-sample exclusion, expressed structurally. The
  // `status = 'completed'` restriction in the WHERE clause below IS the
  // exclusion — it is not one filter among several. A stalled, requeued or
  // failed job cannot reach that status: completeJob() above is the
  // only writer of 'completed', and it only ever fires against a row that is
  // currently 'in_progress'. Every other terminal path (failJob,
  // requeueWithRetry, requeueNoRetry) writes 'failed' or 'queued' instead.
  //
  // Do NOT add a separate stall-reason or retries filter in application code
  // alongside this. Such a filter would be strictly weaker than the WHERE
  // clause: the query cannot run without its WHERE, whereas a later edit can
  // delete an `if`. Same omission-as-guarantee pattern as
  // getDueNotifications() below and requeueWithRetry() above.
  //
  // The duration pair is `completed_at - acknowledged_at`, NOT anything
  // involving session_started_at — that column is declared but never written
  // anywhere in this codebase, so a query built on it would return zero
  // samples forever, silently, and every test would still pass
  // (D-01 as CORRECTED).
  getRecentSessionDurationsMs(limit: number): number[] {
    const rows = this.db.prepare(`
      SELECT completed_at - acknowledged_at AS duration_ms
      FROM queue_job
      WHERE status = 'completed'
        AND acknowledged_at IS NOT NULL
        AND completed_at IS NOT NULL
      ORDER BY completed_at DESC
      LIMIT ?
    `).all(limit) as Array<{ duration_ms: number }>;
    return rows.map((row) => Number(row.duration_ms));
  }

  getJobRegistration(jobId: string): { job: QueueJob; registration: Registration } | undefined {
    const jobRow = this.db.prepare('SELECT * FROM queue_job WHERE id = ?').get(jobId) as
      | (QueueJob & { registration_id?: string })
      | undefined;
    if (!jobRow?.registration_id) return undefined;

    const registration = this.db.prepare('SELECT * FROM registration WHERE id = ?').get(jobRow.registration_id) as Registration | undefined;
    if (!registration) return undefined;

    const job = { ...jobRow, registration } as QueueJob;
    return { job, registration };
  }

  // notifications
  //
  // photoUrl/dueAt use COALESCE(excluded.<col>, notification_record.<col>)
  // on conflict, unlike status/attempts/lastError's bare excluded.<col>. The
  // sweeper calls this method on every delivery attempt to record a status
  // change without re-supplying the photo URL, so a bare excluded.photoUrl
  // would overwrite the persisted URL with NULL on the very first retry —
  // silently reintroducing the data loss this phase exists to remove.
  saveNotification(n: Partial<NotificationRecord> & { jobId: string }): void {
    this.db.prepare(`
      INSERT INTO notification_record (jobId, status, attempts, lastError, photoUrl, dueAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(jobId) DO UPDATE SET
        status = excluded.status,
        attempts = excluded.attempts,
        lastError = excluded.lastError,
        photoUrl = COALESCE(excluded.photoUrl, notification_record.photoUrl),
        dueAt = COALESCE(excluded.dueAt, notification_record.dueAt),
        updatedAt = excluded.updatedAt
    `).run(
      n.jobId,
      n.status ?? 'pending',
      n.attempts ?? 0,
      n.errorMessage ?? n.lastError ?? null,
      n.photoUrl ?? null,
      n.dueAt ?? null,
      new Date().toISOString(),
    );
  }

  getNotification(jobId: string): NotificationRecord | undefined {
    const row = this.db.prepare('SELECT * FROM notification_record WHERE jobId = ?').get(jobId) as {
      jobId: string; status: string; attempts: number; lastError?: string; photoUrl?: string; dueAt?: number; updatedAt: string;
    } | undefined;
    return row
      ? {
          jobId: row.jobId,
          channel: 'webhook',
          recipient: '',
          status: row.status,
          attempts: row.attempts,
          lastError: row.lastError,
          photoUrl: row.photoUrl ?? undefined,
          dueAt: row.dueAt ?? undefined,
        }
      : undefined;
  }

  // D-05 expressed structurally: the trailing WHERE on the conflict branch
  // means a repeat file_upload for a job whose notification already reached
  // a terminal state ('delivered' or 'failed') cannot re-arm it for another
  // delivery. Removing that WHERE would let a duplicate/replayed file_upload
  // event send an already-delivered guest's photo a second time.
  enqueueNotification(n: { jobId: string; photoUrl: string; dueAt: number }): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO notification_record (jobId, photoUrl, status, attempts, dueAt, updatedAt)
      VALUES (?, ?, 'pending', 0, ?, ?)
      ON CONFLICT(jobId) DO UPDATE SET
        photoUrl = excluded.photoUrl,
        status = 'pending',
        attempts = 0,
        dueAt = excluded.dueAt,
        updatedAt = excluded.updatedAt
      WHERE notification_record.status NOT IN ('delivered','failed')
    `).run(n.jobId, n.photoUrl, n.dueAt, now);
  }

  // D-05: 'delivered' and 'failed' are deliberately absent from this
  // predicate — no application-level `if (alreadySent)` exists anywhere to
  // be deleted by a later edit. 'sending' is deliberately present: a claim
  // writes a lease deadline into dueAt, so a row whose owning process died
  // mid-flight becomes due again on its own and is picked up by this same
  // query — that is what makes D-04's "restart-proof by construction" hold
  // for in-flight rows too, and is why this phase adds no boot-time recovery
  // pass of its own.
  getDueNotifications(now: number): Array<{ jobId: string; photoUrl: string; attempts: number }> {
    return this.db.prepare(`
      SELECT jobId, photoUrl, attempts FROM notification_record
      WHERE status IN ('pending','retrying','sending') AND dueAt <= ? AND photoUrl IS NOT NULL
      ORDER BY dueAt ASC
    `).all(now) as Array<{ jobId: string; photoUrl: string; attempts: number }>;
  }

  // Same structural guard as getDueNotifications() above: only a row still
  // in a non-terminal state and past its due time can be claimed.
  claimNotification(jobId: string, now: number, leaseUntil: number): boolean {
    const result = this.db.prepare(`
      UPDATE notification_record
      SET status = 'sending', dueAt = ?, updatedAt = ?
      WHERE jobId = ? AND status IN ('pending','retrying','sending') AND dueAt <= ?
    `).run(leaseUntil, new Date().toISOString(), jobId, now);
    return result.changes === 1;
  }

  close(): void {
    this.db.close();
  }
}

let store: LocalStore | null = null;
export function getStore(): LocalStore {
  if (!store) store = new LocalStore();
  return store;
}
