import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { getConfig } from '../config';
import logger, { mask } from '../logging/logger';
import type { Registration, QueueJob, BoothState, DBPollCursor, NotificationRecord } from '../types';

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
        id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL,
        phone TEXT NOT NULL, mode TEXT NOT NULL, registered_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS queue_job (
        id TEXT PRIMARY KEY, registration_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
        queued_at INTEGER NOT NULL, dispatched_at INTEGER, acknowledged_at INTEGER,
        session_started_at INTEGER, session_ended_at INTEGER, completed_at INTEGER,
        ack_error_message TEXT, retries INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS processed_id (
        reg_id TEXT PRIMARY KEY, processed_at TEXT NOT NULL DEFAULT 'now'
      );
      CREATE TABLE IF NOT EXISTS db_poll_cursor (
        poll_key TEXT PRIMARY KEY, last_value TEXT NOT NULL, updated_at TEXT DEFAULT 'now'
      );
    `);
  }

  migrate(): void { /* phase 2+ migrations go here */ }

  // registrations
  upsertRegistration(r: Registration): Registration {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO registration (id, name, email, phone, mode, registered_at)
       VALUES (@id, @name, @email, @phone, @mode, @registered_at)`
    );
    stmt.run({ ...r });
    return r;
  }
  getRegistration(id: string): Registration | undefined {
    const row = this.db.prepare('SELECT * FROM registration WHERE id = ?').get(id) as Registration | undefined;
    return row;
  }

  // queue
  enqueueJob(j: Partial<QueueJob> & { id: string; queued_at: number }): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO queue_job (id, registration_id, status, queued_at)
       VALUES (@id, @id, 'queued', @queued_at)`
    ).run({ id: j.id, queued_at: j.queued_at });
  }
  updateJobStatus(id: string, status: QueueJob['status'], tsField: keyof QueueJob, tsValue: number): void {
    const map: Record<string, string> = {
      dispatched_at: 'dispatched_at', acknowledged_at: 'acknowledged_at',
      session_started_at: 'session_started_at', session_ended_at: 'session_ended_at', completed_at: 'completed_at',
    };
    const field = map[tsField];
    this.db.prepare(`UPDATE queue_job SET status = ?, ${field} = ? WHERE id = ?`).run(status, tsValue, id);
  }
  getQueuedJobs(): QueueJob[] { return []; } /* filled by queue manager at runtime */
  getJob(id: string): QueueJob | undefined { return undefined; }

  // idempotency
  isProcessed(regId: string): boolean {
    return this.db.prepare('SELECT 1 FROM processed_id WHERE reg_id = ?').get(regId) !== undefined;
  }
  markProcessed(regId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO processed_id (reg_id) VALUES (?)').run(regId);
  }

  // cursor
  getCursor(pollKey: string): string | undefined { return undefined; }
  setCursor(pollKey: string, value: string): void { /* no-op */ }

  // booth state
  getBoothState(): BoothState { return 'IDLE'; }
  setBoothState(state: BoothState): void { /* no-op */ }

  // notifications
  saveNotification(n: Partial<NotificationRecord> & { jobId: string }): void { /* no-op */ }
  getNotification(jobId: string): NotificationRecord | undefined { return undefined; }

  close(): void { this.db.close(); }
}

let store: LocalStore | null = null;
export function getStore(): LocalStore {
  if (!store) store = new LocalStore();
  return store;
}
