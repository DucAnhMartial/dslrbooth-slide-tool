// Phase 6: Ingestion Cutover — D-06's whole implementation.
//
// dbPoller.ts:98 defaults the 'registrations' cursor to
// '1970-01-01T00:00:00.000Z' when unseeded, and DBPoller is constructed
// unconditionally at index.ts:52 with no enable/disable flag — so the moment
// photobooth.registrations starts returning rows, an unseeded poller queues
// every historical row at once. This script seeds the cursor to "now" (per
// MySQL's own clock, in the VIEW's own lexical format) BEFORE the process
// starts, so none of the historical rows is ever dispatched.
//
// THE LOAD-BEARING DETAIL: the seed value must be produced by MySQL's own
// DATE_FORMAT(NOW(6), ...) expression, matching registrationsViewSql.ts's
// projection of `registered_at` exactly. A seed produced by the Node
// process's clock via `new Date().toISOString()` LOOKS equivalent but is
// not: dbPoller.ts:101 compares strings, and
//   '2026-08-11 14:00:01.000000' > '2026-08-11T14:00:00.000Z'   ->  FALSE
// (space 0x20 sorts before 'T' 0x54), so an ISO-shaped seed would silently
// swallow every registration for the rest of that calendar day. See
// 06-04-PLAN.md's <the_cursor_format_finding> and 06-RESEARCH.md Pitfall 1's
// sibling hazard. Do not add a `new Date().toISOString()` fallback anywhere
// in this file — that is the exact mistake this module exists to prevent,
// and it is asserted absent by a source-scan test
// (test/local-store-persistence.test.ts).
import type { LocalStore } from '../state/localStore';
import type { DBPollerDbConfig } from '../ingestion/dbPoller';
import { getConfig } from '../config';
import { labelLogger } from '../logging/logger';

export const opsLogger = labelLogger('ops');

/**
 * The script issues exactly one MySQL statement, and it is a SELECT with no
 * FROM clause — it touches no table, so it works before the VIEW exists and
 * needs no ets_web access. Changing this to select from any table, or to
 * fall back to a Node-clock value on any code path, breaks the single-
 * statement guarantee this comment documents.
 */
export const MYSQL_NOW_LEXICAL_SQL = `SELECT DATE_FORMAT(NOW(6), '%Y-%m-%d %H:%i:%s.%f') AS now_lexical`;

/** The exact lexical shape registrationsViewSql.ts's `registered_at` emits. */
export const REGISTERED_AT_LEXICAL_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;

/** dbPoller.ts:98's shipped default — correct today only by luck of its leading '1'. */
const SHIPPED_DEFAULT_CURSOR = '1970-01-01T00:00:00.000Z';

export interface SeedRegistrationsCursorOptions {
  store: LocalStore;
  dbConfig: DBPollerDbConfig;
  /** Overwrite an already-seeded (non-default) cursor. Defaults to false. */
  force?: boolean;
}

export interface SeedRegistrationsCursorResult {
  /** The cursor value now in effect: the newly seeded value, or the untouched previous value if skipped. */
  cursor: string;
  previous: string | undefined;
  skipped: boolean;
}

/**
 * D-06's one-shot cursor seed. Connects to MySQL with the service's own
 * DB_* settings, reads the server's own clock in the VIEW's lexical format,
 * refuses to clobber an already-seeded cursor unless `force` is set, then
 * writes and round-trips the value through `store.setCursor()` /
 * `store.getCursor()` — the same public LocalStore method dbPoller.ts and
 * every other write path use, so no new schema or bind site is introduced.
 */
export async function seedRegistrationsCursor(
  opts: SeedRegistrationsCursorOptions
): Promise<SeedRegistrationsCursorResult> {
  const { store, dbConfig, force = false } = opts;

  const previous = store.getCursor('registrations');
  opsLogger.info(`Current 'registrations' cursor: ${previous ?? '(unset)'}`);

  if (previous !== undefined && previous !== SHIPPED_DEFAULT_CURSOR && !force) {
    opsLogger.warn(
      `Seed refused: 'registrations' cursor is already ${previous}, not the shipped default. ` +
      `Re-seeding a live deployment silently skips every guest between the old value and the new one. ` +
      `Pass --force to overwrite anyway.`
    );
    return { cursor: previous, previous, skipped: true };
  }

  // Lazy require, matching dbPoller.ts:44 and viewHealthProbe.ts:89 — this
  // script owns its own short-lived pool and closes it in the finally below;
  // it never touches DBPoller's or ViewHealthProbe's pool.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mysql = require('mysql2/promise');
  const pool = mysql.createPool({
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    user: dbConfig.user,
    password: dbConfig.password,
    waitForConnections: true,
    connectionLimit: 1,
  });

  let seeded: string;
  try {
    const conn = await pool.getConnection();
    let rows;
    try {
      [rows] = await conn.query(MYSQL_NOW_LEXICAL_SQL);
    } finally {
      conn.release();
    }

    const value = (rows as Array<{ now_lexical: unknown }>)[0]?.now_lexical;
    if (typeof value !== 'string' || !REGISTERED_AT_LEXICAL_PATTERN.test(value)) {
      // Never falls back to `new Date().toISOString()` here — an unexpected
      // runtime shape from mysql2 is a hard stop, not a silent downgrade to
      // the exact seed format this module exists to reject.
      throw new Error(
        `MySQL NOW(6) did not return a string in the VIEW's lexical format — ` +
        `runtime type ${typeof value}, value ${JSON.stringify(value)}`
      );
    }
    seeded = value;
  } finally {
    // Closes the MySQL connection in a finally. Logs err.message only on
    // any caught error above — never the connection object or the password.
    await pool.end().catch(() => {});
  }

  store.setCursor('registrations', seeded);
  const readBack = store.getCursor('registrations');
  if (readBack !== seeded) {
    throw new Error(`Cursor round-trip failed: wrote ${seeded}, read back ${readBack ?? '(none)'}`);
  }

  const comparisonOk = seeded > SHIPPED_DEFAULT_CURSOR;
  opsLogger.info(
    `Seeded 'registrations' cursor to ${seeded} — ` +
    `${comparisonOk ? 'strictly greater than' : 'NOT greater than (!!)'} the shipped default ${SHIPPED_DEFAULT_CURSOR}`
  );

  return { cursor: seeded, previous, skipped: false };
}

export async function main(): Promise<void> {
  const config = getConfig();
  const force = process.argv.includes('--force');

  // Lazy import so this file's own top-level imports stay side-effect-free
  // for the test suite (getStore() opens/creates the real LOCAL_STORE_PATH).
  const { getStore } = await import('../state/localStore.js');
  const store = getStore();

  const dbConfig: DBPollerDbConfig = {
    host: config.DB_HOST,
    port: config.DB_PORT,
    database: config.DB_NAME,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
  };

  try {
    const result = await seedRegistrationsCursor({ store, dbConfig, force });
    if (result.skipped) {
      process.exitCode = 1;
    }
  } catch (err) {
    // Never log err itself (may embed connection state) — only its message,
    // matching dbPoller.ts:134-140's rule.
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
