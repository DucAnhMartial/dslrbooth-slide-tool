import { getStore } from '../state/localStore';
import logger from '../logging/logger';

export interface DBPollerDbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export class DBPoller {
  private intervalMs: number;
  private batchSize: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private pool: any;
  private store: ReturnType<typeof getStore>;
  private dbConfig: DBPollerDbConfig;

  constructor(
    intervalMs: number,
    batchSize: number,
    store: ReturnType<typeof getStore>,
    dbConfig: DBPollerDbConfig
  ) {
    this.intervalMs = intervalMs;
    this.batchSize = batchSize;
    this.store = store;
    this.dbConfig = dbConfig;
    this.pool = null;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    if (!this.dbConfig.user) {
      logger.warn('DB poller skipped: DB_USER not configured');
      return;
    }

    try {
      const mysql = require('mysql2/promise');
      this.pool = mysql.createPool({
        host: this.dbConfig.host,
        port: this.dbConfig.port,
        database: this.dbConfig.database,
        user: this.dbConfig.user,
        password: this.dbConfig.password,
        waitForConnections: true,
        connectionLimit: 2,
      });
    } catch (err) {
      logger.error('DB poller: mysql2 not available, skipping. Install mysql2 to enable DB polling.');
      this.running = false;
      return;
    }

    this.doPoll()
      .then(() => {
        logger.info(`DB poller connected: ${this.dbConfig.host}:${this.dbConfig.port}/${this.dbConfig.database}`);
        this.timer = setInterval(() => this.doPoll(), this.intervalMs);
      })
      .catch((err: Error) => {
        logger.error('DB poller: initial connect failed', err);
        this.running = false;
      });
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.pool?.end) {
      this.pool.end().catch(() => {});
    }
  }

  private async doPoll(): Promise<void> {
    if (!this.running || !this.pool) return;
    let conn;
    try {
      conn = await this.pool.getConnection();
      const cursor = this.store.getCursor('registrations');
      const lastAt = cursor ?? '1970-01-01T00:00:00.000Z';

      const [rows] = await conn.query(
        'SELECT id, name, email, phone, mode, registered_at FROM registrations WHERE registered_at > ? ORDER BY registered_at ASC LIMIT ?',
        [lastAt, this.batchSize]
      );

      const records = rows as Array<{ id: string; name: string; email: string; phone: string; mode: string; registered_at: string }>;
      if (records.length === 0) return;

      for (const row of records) {
        if (this.store.isProcessed(row.id)) continue;
        this.store.upsertRegistration({
          id: row.id,
          name: row.name,
          email: row.email,
          phone: row.phone ?? '',
          mode: row.mode,
          registered_at: row.registered_at ?? new Date().toISOString(),
        });
        this.store.markProcessed(row.id);
        this.store.enqueueJob({ id: row.id, queued_at: Date.now() });
        logger.info(`DB poller ingested ${row.id}`);
      }

      const lastRow = records.at(-1);
      if (lastRow) {
        this.store.setCursor('registrations', lastRow.registered_at);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`DB poller cycle failed: ${message}`);
    } finally {
      conn?.release();
    }
  }
}
