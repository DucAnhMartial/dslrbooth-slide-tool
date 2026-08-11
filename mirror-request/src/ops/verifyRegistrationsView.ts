// Phase 6: Ingestion Cutover — Task 1's read-only, end-to-end proof.
//
// Runs the exact projection that will become `photobooth.registrations`
// against the live `ets_web` schema (read-only — no statement other than
// SELECT is ever issued), then binds every returned row through the real
// `LocalStore.upsertRegistration()` / `enqueueJob()` / `setCursor()` code
// path — the mysql2 -> better-sqlite3 boundary that has never executed in
// this project's history, because `photobooth.registrations` has held 0 rows
// since Phase 1.
//
// `main()` is guarded by `require.main === module` so `tsc`/`npm run
// typecheck` still typechecks and builds this file (there is no `scripts/`
// directory in the tsconfig `include`), while still being directly runnable
// via `npx ts-node src/ops/verifyRegistrationsView.ts`.
import fs from 'fs';
import path from 'path';
import {
  REGISTRATIONS_VIEW_COLUMNS,
  REGISTRATIONS_INNER_SELECT,
  DEDUP_CONTROL_SQL,
  ORDER_TIE_CONTROL_SQL,
  buildInlineProjectionSql,
  createRegistrationsViewDdl,
  createNameAuditViewDdl,
  DEFAULT_VIEW_DEFINER,
} from './registrationsViewSql';
import { LocalStore } from '../state/localStore';

type ProjectedRow = {
  id: string;
  name: string;
  email: string;
  phone: string;
  mode: string;
  registered_at: string;
};

export interface VerifyOptions {
  source?: 'inline' | 'view';
  host?: string;
  port?: number;
  user?: string;
  password?: string;
}

export interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

export interface VerifyResult {
  passed: boolean;
  rowCount: number;
  checks: CheckResult[];
}

function readConnectionSettings(opts: VerifyOptions): { host: string; port: number; user: string; password: string } {
  const host = opts.host ?? process.env.SOURCE_DB_HOST ?? '127.0.0.1';
  const port = opts.port ?? Number(process.env.SOURCE_DB_PORT ?? 3306);
  const user = opts.user ?? process.env.SOURCE_DB_USER ?? process.env.DB_USER ?? '';
  const password = opts.password ?? process.env.SOURCE_DB_PASSWORD ?? process.env.DB_PASSWORD ?? '';
  if (!user) {
    // Never log the value we don't have — nothing to log here but the fact
    // itself, matching dbPoller.ts:134-140's rule of logging err.message
    // only, never a connection object or credential.
    throw new Error('SOURCE_DB_USER (or DB_USER) must be set to run this harness');
  }
  return { host, port, user, password };
}

/**
 * Read-only end-to-end harness: live MySQL -> mysql2 -> LocalStore -> SQLite.
 * Every check is named, measured and printed; a failed check does not stop
 * the remaining checks from running, so the full picture is always visible.
 */
export async function verifyRegistrationsView(opts: VerifyOptions = {}): Promise<VerifyResult> {
  const { host, port, user, password } = readConnectionSettings(opts);
  const source = opts.source ?? 'inline';

  const checks: CheckResult[] = [];
  const record = (name: string, passed: boolean, detail: string): void => {
    checks.push({ name, passed, detail });
    // Never logs the connection object, host, or credentials — only the
    // check's own measured outcome, matching dbPoller.ts:134-140's rule.
    // eslint-disable-next-line no-console
    console.log(`[${passed ? 'PASS' : 'FAIL'}] ${name}: ${detail}`);
  };

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mysql = require('mysql2/promise');
  const pool = mysql.createPool({
    host,
    port,
    user,
    password,
    waitForConnections: true,
    connectionLimit: 2,
  });

  let rows: ProjectedRow[] = [];

  try {
    const conn = await pool.getConnection();
    try {
      const projectionSql =
        source === 'inline'
          ? buildInlineProjectionSql()
          : 'SELECT id, name, email, phone, mode, registered_at FROM photobooth.registrations ORDER BY registered_at ASC;';

      const [result] = await conn.query(projectionSql);
      rows = result as ProjectedRow[];

      // Check 1: own-property key set equals REGISTRATIONS_VIEW_COLUMNS.
      const expectedKeys = [...REGISTRATIONS_VIEW_COLUMNS].slice().sort();
      const keySetOk = rows.every((row) => {
        const keys = Object.keys(row).sort();
        return keys.length === expectedKeys.length && keys.every((k, i) => k === expectedKeys[i]);
      });
      record('column-key-set', keySetOk, `${rows.length} rows, expected keys [${REGISTRATIONS_VIEW_COLUMNS.join(',')}]`);

      // Check 2: registered_at is a string matching the fixed-width format.
      const tsPattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;
      const tsTypesOk = rows.every((row) => typeof row.registered_at === 'string');
      const tsFormatOk = rows.every((row) => tsPattern.test(row.registered_at));
      record(
        'registered_at-string-format',
        tsTypesOk && tsFormatOk,
        `sample=${rows[0]?.registered_at ?? '(no rows)'} type=${typeof rows[0]?.registered_at} allTypesString=${tsTypesOk} allFormatMatch=${tsFormatOk}`
      );

      // Check 3: dedup — rows.length === distinct ids, and (inline only)
      // equals the independently-computed DEDUP_CONTROL_SQL count.
      const distinctIds = new Set(rows.map((r) => r.id)).size;
      let dedupOk = rows.length === distinctIds;
      let dedupDetail = `rows=${rows.length} distinctIds=${distinctIds}`;
      if (source === 'inline') {
        const [controlRows] = await conn.query(DEDUP_CONTROL_SQL);
        const controlCount = Number((controlRows as Array<{ distinct_ticket_count: number }>)[0].distinct_ticket_count);
        dedupOk = dedupOk && controlCount === rows.length;
        dedupDetail += ` DEDUP_CONTROL_SQL=${controlCount}`;
      }
      record('dedup', dedupOk, dedupDetail);

      // Check 4: every name is non-empty after trim.
      const namesOk = rows.every((row) => String(row.name).trim().length > 0);
      record('non-empty-name', namesOk, `${rows.length} rows checked, all non-empty=${namesOk}`);

      // Check 5: order-tie dissolution — every group of tickets sharing one
      // ticketing_order.created_at gets distinct projected registered_at.
      const [tieRows] = await conn.query(ORDER_TIE_CONTROL_SQL);
      const tieGroups = tieRows as Array<{ order_created_at: unknown; ticket_codes: string; ticket_count: number }>;
      if (tieGroups.length === 0) {
        record('order-tie-dissolution', true, 'no order-level ties present in current data');
      } else {
        const byId = new Map(rows.map((r) => [r.id, r.registered_at]));
        let allDistinct = true;
        const groupDetails: string[] = [];
        for (const group of tieGroups) {
          const codes = group.ticket_codes.split(',');
          const values = codes.map((code) => byId.get(code)).filter((v): v is string => v !== undefined);
          const distinct = values.length === codes.length && new Set(values).size === values.length;
          if (!distinct) allDistinct = false;
          groupDetails.push(`order_created_at=${String(group.order_created_at)} tickets=[${codes.join(',')}] registered_at=[${values.join(',')}]`);
        }
        record('order-tie-dissolution', allDistinct, groupDetails.join(' | '));
      }

      // Check 6: advisory cross-ticket distinctness. Not a pass/fail gate —
      // event_manager_attendance.created_at carries no UNIQUE constraint, so
      // total distinctness across ALL tickets is empirical, not structural
      // (06-PLAN.md's `ordering` backstop truth).
      const distinctTimestamps = new Set(rows.map((r) => r.registered_at)).size;
      record(
        'advisory-cross-ticket-distinctness',
        true,
        `rows=${rows.length} distinct registered_at=${distinctTimestamps} (advisory, empirical — not a structural guarantee)`
      );

      // Check 7: MySQL's own ORDER BY registered_at ASC sequence equals a JS
      // lexical sort of the same values, confirming lexical comparison is
      // chronologically equivalent (what makes dbPoller.ts:101's `> ?` filter
      // correct).
      const mysqlOrder = rows.map((r) => r.registered_at);
      const lexicallySorted = [...mysqlOrder].sort();
      const orderOk = JSON.stringify(mysqlOrder) === JSON.stringify(lexicallySorted);
      record('lexical-order-is-chronological', orderOk, `MySQL ORDER BY sequence matches JS lexical sort: ${orderOk}`);

      // Check 8 (name_source distribution) — informational, not pass/fail.
      // Printed so the SUMMARY can record the measured distribution across
      // the 9 valid rows (CONTEXT: 4/9 expected to have no first/last name).
      const nameSourceSql =
        source === 'inline'
          ? `SELECT name_source, COUNT(*) AS n FROM (${REGISTRATIONS_INNER_SELECT}) d WHERE d.rn = 1 GROUP BY name_source;`
          : 'SELECT name_source, COUNT(*) AS n FROM photobooth.registrations_name_audit GROUP BY name_source;';
      const [nameSourceRows] = await conn.query(nameSourceSql);
      const distribution = (nameSourceRows as Array<{ name_source: string; n: number }>)
        .map((r) => `${r.name_source}=${r.n}`)
        .join(', ');
      record('name_source-distribution', true, distribution || '(no rows)');

      // Check 9: the bind proof. Opens a real LocalStore on a throwaway
      // path, binds every fetched row through the exact code path
      // dbPoller.ts:117-124/132 uses, then reads back and asserts. The
      // SQLite file is removed in a finally. No statement other than SELECT
      // is ever issued to MySQL anywhere in this function.
      const storePath = path.resolve(`./data/test-view-verify-${process.pid}-${Date.now()}.sqlite`);
      const store = new LocalStore(storePath);
      try {
        let registrationsWritten = 0;
        let jobsEnqueued = 0;
        for (const row of rows) {
          store.upsertRegistration({
            id: row.id,
            name: row.name,
            email: row.email,
            phone: row.phone ?? '',
            mode: row.mode,
            registered_at: row.registered_at ?? new Date().toISOString(),
          });
          registrationsWritten += 1;
          store.enqueueJob({ id: row.id, queued_at: Date.now() });
          jobsEnqueued += 1;
        }
        const lastRow = rows.at(-1);
        if (lastRow) {
          store.setCursor('registrations', lastRow.registered_at);
        }
        const cursorReadBack = store.getCursor('registrations');
        const allNamesStoredNonEmpty = rows.every((row) => {
          const stored = store.getRegistration(row.id);
          return stored !== undefined && stored.name.trim().length > 0;
        });
        const bindOk =
          registrationsWritten === rows.length &&
          jobsEnqueued === rows.length &&
          cursorReadBack === lastRow?.registered_at &&
          allNamesStoredNonEmpty;
        record(
          'sqlite-bind-proof',
          bindOk,
          `registrationsWritten=${registrationsWritten} jobsEnqueued=${jobsEnqueued} cursor=${cursorReadBack ?? '(none)'} allNamesNonEmpty=${allNamesStoredNonEmpty}`
        );
      } finally {
        store.close();
        for (const suffix of ['', '-wal', '-shm']) {
          fs.rmSync(`${storePath}${suffix}`, { force: true });
        }
      }
    } finally {
      conn.release();
    }
  } finally {
    await pool.end();
  }

  const passed = checks.every((c) => c.passed);
  return { passed, rowCount: rows.length, checks };
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--emit-sql')) {
    const header = `-- Phase 6: Ingestion Cutover
-- Generated by src/ops/verifyRegistrationsView.ts --emit-sql
-- from src/ops/registrationsViewSql.ts. Do not hand-edit this file — a
-- drift test (test/registrations-view-sql.test.ts) asserts it stays equal
-- to the module's emitted text. Regenerate instead:
--   npx ts-node src/ops/verifyRegistrationsView.ts --emit-sql

`;
    const sql = `${header}${createRegistrationsViewDdl(DEFAULT_VIEW_DEFINER)}\n\n${createNameAuditViewDdl(DEFAULT_VIEW_DEFINER)}\n`;
    const outPath = path.resolve(__dirname, '../../docs/migrations/06-registrations-view.sql');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, sql);
    // eslint-disable-next-line no-console
    console.log(`Wrote ${outPath}`);
    return;
  }

  const sourceArg = args.find((a) => a.startsWith('--source='));
  const source = (sourceArg ? sourceArg.split('=')[1] : 'inline') as 'inline' | 'view';

  const result = await verifyRegistrationsView({ source });
  // eslint-disable-next-line no-console
  console.log(`\n${result.passed ? 'ALL CHECKS PASSED' : 'ONE OR MORE CHECKS FAILED'} — ${result.rowCount} rows, ${result.checks.length} checks`);
  if (!result.passed) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    // Never log err (which may embed a connection object) — only its
    // message, matching dbPoller.ts:134-140's rule.
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(message);
    process.exitCode = 1;
  });
}
