import type { LocalStore } from '../state/localStore';
import type { DBPollerDbConfig } from '../ingestion/dbPoller';
import { getConfig } from '../config';
import { labelLogger } from '../logging/logger';
import { NAME_AUDIT_CURSOR_KEY, nameSourceWarnings, type NameAuditRow } from './nameSourceAudit';

// D-09: a broken VIEW never blocks the service. This module deliberately
// departs from config.ts's production fail-fast posture (config.ts:65-77) —
// every failure path here logs and returns, never throws past its own
// boundary, and never calls process.exit. Refusing to start converts an
// ingestion outage into a total outage for the queue, booth, display and
// guest notifications of everyone already queued; see 06-CONTEXT.md D-09.

const config = getConfig();

// Exported so tests can spy on the exact instance, matching
// notificationService.ts's notifyLogger convention.
export const opsLogger = labelLogger('ops');

/**
 * MySQL error codes that mean the VIEW itself is broken — an upstream
 * ets_web schema change invalidated it, or its DEFINER account no longer
 * exists — as distinct from the database being merely unreachable
 * (Phase 1's D-05 case, which must never page anyone).
 */
export const VIEW_BROKEN_ERROR_CODES = ['ER_VIEW_INVALID', 'ER_NO_SUCH_USER'] as const;

interface AlertPayload {
  source: 'extension-service';
  severity: 'error';
  message: string;
  timestamp: string;
}

export interface ViewHealthProbeOptions {
  intervalMs?: number;
  dbConfig?: DBPollerDbConfig;
  webhookUrl?: string;
  fetchTimeoutMs?: number;
  store: LocalStore;
  alert?: (payload: AlertPayload) => Promise<void>;
}

export class ViewHealthProbe {
  private intervalMs: number;
  private dbConfig: DBPollerDbConfig;
  private webhookUrl: string;
  private fetchTimeoutMs: number;
  private store: LocalStore;
  private alertFn: (payload: AlertPayload) => Promise<void>;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private pool: any;

  constructor(opts: ViewHealthProbeOptions) {
    this.intervalMs = opts.intervalMs ?? config.VIEW_PROBE_INTERVAL_MS;
    this.dbConfig = opts.dbConfig ?? {
      host: config.DB_HOST,
      port: config.DB_PORT,
      database: config.DB_NAME,
      user: config.DB_USER,
      password: config.DB_PASSWORD,
    };
    this.webhookUrl = opts.webhookUrl ?? config.NOTIFY_WEBHOOK_URL;
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? config.NOTIFY_FETCH_TIMEOUT_MS;
    this.store = opts.store;
    this.alertFn = opts.alert ?? ((payload) => this.defaultAlert(payload));
    this.pool = null;
  }

  /**
   * Mirrors dbPoller.ts:34-78's lifecycle shape exactly: guard on `running`,
   * create the pool inside a try/catch that degrades to a single warn if
   * mysql2 is unavailable, then run once and schedule the interval on BOTH
   * the resolve and the reject path — never `await`ed, so this method
   * returns void synchronously and never blocks app.listen()'s callback.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    try {
      // Lazy require, same as dbPoller.ts:44 — the probe owns its own pool
      // (connectionLimit: 1) rather than reusing DBPoller's, because
      // DBPoller.pool is private and D-02 forbids modifying dbPoller.ts to
      // add an accessor. This is a named departure from RESEARCH's
      // recommendation, not an oversight (see 06-02-PLAN.md's
      // <departures_from_research>).
      const mysql = require('mysql2/promise');
      this.pool = mysql.createPool({
        host: this.dbConfig.host,
        port: this.dbConfig.port,
        database: this.dbConfig.database,
        user: this.dbConfig.user,
        password: this.dbConfig.password,
        waitForConnections: true,
        connectionLimit: 1,
      });
    } catch (err) {
      opsLogger.warn('View health probe: mysql2 not available, skipping. Install mysql2 to enable the VIEW health probe.');
      this.running = false;
      return;
    }

    this.runOnce()
      .then(() => {
        this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        opsLogger.warn(`View health probe initial cycle failed, will retry every ${this.intervalMs}ms: ${message}`);
        this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
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

  /**
   * One query that both proves the VIEW resolves and detects the ordering
   * residual plan 06-01 recorded as a backstop (COUNT(*) vs.
   * COUNT(DISTINCT registered_at)). Never rejects out of this method —
   * including when the injected `alert` itself throws — matching
   * dbPoller.ts:134-144's warn-and-retry catch discipline.
   */
  async runOnce(): Promise<void> {
    if (!this.pool) return;
    try {
      const conn = await this.pool.getConnection();
      let rows;
      try {
        [rows] = await conn.query(
          'SELECT COUNT(*) AS total, COUNT(DISTINCT registered_at) AS distinct_registered_at FROM registrations'
        );
      } finally {
        conn.release();
      }

      const row = (rows as Array<{ total: number; distinct_registered_at: number }>)[0];
      const total = Number(row.total);
      const distinct = Number(row.distinct_registered_at);

      if (total !== distinct) {
        const difference = total - distinct;
        opsLogger.error(
          `Registrations VIEW ordering check failed: total=${total}, distinct_registered_at=${distinct}, difference=${difference}`
        );
        await this.dispatchAlert(
          `photobooth.registrations ordering check failed: total=${total}, distinct_registered_at=${distinct}`
        );
      }
      // Healthy, equal-count cycle: log nothing, matching
      // notificationService.ts's "no log noise on the success path"
      // convention.

      // D-05: the audit runs only after a healthy cycle, in its own
      // try/catch (inside runNameAudit()) so an audit failure can never
      // affect the health verdict above.
      await this.runNameAudit();
    } catch (err: any) {
      // Never logs `err` itself, `this.dbConfig`, or a connection string —
      // only `err.message` — so credentials never reach the log file,
      // matching dbPoller.ts:134-144's discipline (T-01-18 lineage).
      const code = err?.code as string | undefined;
      const isViewBroken = Boolean(code) && (VIEW_BROKEN_ERROR_CODES as readonly string[]).includes(code as string);
      if (isViewBroken) {
        const message = err instanceof Error ? err.message : String(err);
        opsLogger.error(`Registrations VIEW is broken: ${message}`);
        await this.dispatchAlert(`photobooth.registrations VIEW is broken: ${message}`);
      } else {
        // Connection-class codes (ECONNREFUSED, PROTOCOL_CONNECTION_LOST,
        // ETIMEDOUT, ER_ACCESS_DENIED_ERROR) and any unrecognised code both
        // take this branch — a page firing on an unknown code would train
        // the operator to ignore alerts (Phase 1's D-05 lineage).
        opsLogger.warn(`View health probe: DB unreachable (${code ?? 'unknown'}), will retry`);
      }
    }
  }

  /**
   * D-05: every fall-through past first_name/last_name produces exactly one
   * operator-visible warn naming the ticket code and the rung, exactly once
   * per guest, surviving restart — the high-water mark is persisted through
   * `store.setCursor(NAME_AUDIT_CURSOR_KEY, ...)`, the same `db_poll_cursor`
   * table `dbPoller.ts` uses under a different poll key. Never touches the
   * health verdict: any failure here is caught and only warned about.
   */
  private async runNameAudit(): Promise<void> {
    try {
      // Initialising from the 'registrations' ingestion cursor (D-06's
      // seed-to-now lineage) is what keeps pre-cutover rows out of the log;
      // '1970-01-01T00:00:00.000Z' mirrors dbPoller.ts:98's own default.
      const cursor =
        this.store.getCursor(NAME_AUDIT_CURSOR_KEY) ??
        this.store.getCursor('registrations') ??
        '1970-01-01T00:00:00.000Z';

      const conn = await this.pool.getConnection();
      let rows;
      try {
        [rows] = await conn.query(
          'SELECT id, name_source, registered_at FROM registrations_name_audit WHERE registered_at > ? ORDER BY registered_at ASC LIMIT 200',
          [cursor]
        );
      } finally {
        conn.release();
      }

      const records = rows as NameAuditRow[];
      if (records.length === 0) return;

      for (const warning of nameSourceWarnings(records)) {
        // The message carries a ticket code and a rung name and nothing
        // else — never the resolved `name`, which this SELECT does not
        // even fetch, and never an email or phone.
        opsLogger.warn(`Guest name for ticket ${warning.ticketCode} came from ${warning.nameSource}, not first_name/last_name`);
      }

      // Advance on ALL returned rows, not only the warned ones, so a
      // first-rung (personalinfo_name) row is never re-examined on the next
      // cycle either.
      const lastRow = records.at(-1);
      if (lastRow) {
        this.store.setCursor(NAME_AUDIT_CURSOR_KEY, lastRow.registered_at);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      opsLogger.warn(`Name-source audit cycle failed: ${message}`);
    }
  }

  private async dispatchAlert(message: string): Promise<void> {
    if (!this.webhookUrl) {
      opsLogger.warn('View health probe: NOTIFY_WEBHOOK_URL is not configured; skipping alert');
      return;
    }
    try {
      await this.alertFn({
        source: 'extension-service',
        severity: 'error',
        message,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      // An alert dispatch failure must not escape runOnce() — the probe
      // already did its job by detecting the break; a down webhook receiver
      // is a second, independent problem.
      const errMessage = err instanceof Error ? err.message : String(err);
      opsLogger.warn(`View health probe: alert dispatch failed: ${errMessage}`);
    }
  }

  /**
   * Reuses notificationService.ts:149-155's exact fetch shape and config
   * keys (NOTIFY_WEBHOOK_URL, NOTIFY_FETCH_TIMEOUT_MS) rather than inventing
   * a second webhook URL or a full AlertService class — RESEARCH.md's
   * explicit "Don't Hand-Roll" guidance for this fire-and-forget alert.
   * The payload carries no guest field and deliberately no `photoUrl` key,
   * so the shared receiver cannot mistake an alert for a photo payload.
   */
  private async defaultAlert(payload: AlertPayload): Promise<void> {
    const response = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.fetchTimeoutMs),
    });
    if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}`);
  }
}

export function createViewHealthProbe(
  store: LocalStore,
  opts: Partial<Omit<ViewHealthProbeOptions, 'store'>> = {}
): ViewHealthProbe {
  return new ViewHealthProbe({ store, ...opts });
}
