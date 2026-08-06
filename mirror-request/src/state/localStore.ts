import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { getConfig } from '../config';
import logger from '../logging/logger';
import type { Registration, QueueJob, BoothState, NotificationRecord } from '../types';

const CONFIG = getConfig();

export class LocalStore {
  private db: Database.Database;

  constructor() {
    const resolved = path.resolve(CONFIG.LOCAL_STORE_PATH);
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
        raw_payload TEXT
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
      updatedAt TEXT NOT NULL DEFAULT 'now'
    );
    CREATE TABLE IF NOT EXISTS booth_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state TEXT NOT NULL DEFAULT 'IDLE',
        updated_at TEXT NOT NULL DEFAULT 'now'
      );
    `);
  }

  migrate(): void {
    // Phase 2+ migrations go here
  }

  // registrations
  upsertRegistration(r: Registration & { raw_payload?: string }): Registration {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO registration (id, name, email, phone, mode, registered_at, raw_payload)
       VALUES (@id, @name, @email, @phone, @mode, @registered_at, @raw_payload)`
    );
    stmt.run({
      id: r.id, name: r.name, email: r.email, phone: r.phone,
      mode: r.mode, registered_at: r.registered_at,
      raw_payload: r.raw_payload ?? null,
    });
    return r;
  }

  getRegistration(id: string): Registration | undefined {
    return this.db.prepare('SELECT * FROM registration WHERE id = ?').get(id) as Registration | undefined;
  }

  saveRawPayload(id: string, json: string): void {
    this.db.prepare('UPDATE registration SET raw_payload = ? WHERE id = ?').run(json, id);
  }

  // queue
  enqueueJob(j: { id: string; queued_at: number }): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO queue_job (id, registration_id, status, queued_at) VALUES (@id, @id, 'queued', @queued_at)`
    ).run({ id: j.id, queued_at: j.queued_at });
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

  completeInProgressJob(endedAt: number): string | undefined {
    const job = this.db.prepare(
      "SELECT id FROM queue_job WHERE status = 'in_progress' ORDER BY acknowledged_at DESC LIMIT 1"
    ).get() as { id: string } | undefined;
    if (!job) return undefined;
    this.db.prepare(
      "UPDATE queue_job SET status = 'completed', session_ended_at = ?, completed_at = ? WHERE id = ?"
    ).run(endedAt, endedAt, job.id);
    return job.id;
  }

  // idempotency
  isProcessed(regId: string): boolean {
    return this.db.prepare('SELECT 1 FROM processed_id WHERE reg_id = ?').get(regId) !== undefined;
  }

  markProcessed(regId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO processed_id (reg_id) VALUES (?)').run(regId);
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

  setBoothState(state: BoothState): void {
    this.db.prepare("INSERT OR REPLACE INTO booth_state (id, state, updated_at) VALUES (1, ?, ?)").run(state, new Date().toISOString());
  }

  setBoothBusy(): void {
    this.db.prepare("INSERT OR REPLACE INTO booth_state (id, state, updated_at) VALUES (1, 'BUSY', ?)").run(new Date().toISOString());
  }

  setBoothIdle(): void {
    this.db.prepare("INSERT OR REPLACE INTO booth_state (id, state, updated_at) VALUES (1, 'IDLE', ?)").run(new Date().toISOString());
  }

  setBoothTimeout(reason: string): void {
    this.db.prepare("INSERT OR REPLACE INTO booth_state (id, state, updated_at) VALUES (1, 'IDLE', ?)").run(new Date().toISOString());
    logger.warn(`Booth timeout reset: ${reason}`);
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

  // notifications (stubs, implemented in Phase 4)
  saveNotification(_n: Partial<NotificationRecord> & { jobId: string }): void {
    // no-op until Phase 4
  }

  getNotification(_jobId: string): NotificationRecord | undefined {
    return undefined;
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
