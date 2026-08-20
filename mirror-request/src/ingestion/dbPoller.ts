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
      // This is the one failure the poller genuinely cannot retry out of, so
      // it is also the one branch besides stop() allowed to clear `running`
      // (D-05). It still only warns, matching the DB_USER-not-configured
      // branch immediately above: two adjacent "polling is disabled"
      // branches must not report at different severities.
      logger.warn('DB poller: mysql2 not available, skipping. Install mysql2 to enable DB polling.');
      this.running = false;
      return;
    }

    this.doPoll()
      .then(() => {
        logger.info(`DB poller connected: ${this.dbConfig.host}:${this.dbConfig.port}/${this.dbConfig.database}`);
        this.timer = setInterval(() => this.doPoll(), this.intervalMs);
      })
      .catch((err: Error) => {
        // D-05: a first-cycle failure retries on the next cycle; it must not
        // stop the service or permanently disable polling. The interval is
        // scheduled unconditionally and `running` is left untouched here.
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`DB poller initial cycle failed, will retry every ${this.intervalMs}ms: ${message}`);
        this.timer = setInterval(() => this.doPoll(), this.intervalMs);
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
        if (!row.id || !row.name) {
          logger.warn(`DB poller skipped malformed source row: id=${row.id ?? '(missing)'} name=${row.name ? 'present' : '(missing)'}`);
          continue;
        }
        if (this.store.isProcessed(row.id)) {
          logger.info(`DB poller reconciled ${row.id}: already ingested via mirror webhook, skipping`);
          continue;
        }
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
      // D-05: warn and retry on the next scheduled cycle; never crash the
      // process. Only err.message is logged — never the caught error object,
      // this.dbConfig, or a connection string — so credentials never reach
      // the log file (T-01-18).
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`DB poller cycle failed: ${message}`);
    } finally {
      conn?.release();
    }
  }
}
