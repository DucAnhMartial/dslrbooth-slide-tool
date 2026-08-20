// Phase 6: Ingestion Cutover — capture the pre-phase state of
// `photobooth.registrations` (currently a BASE TABLE) BEFORE plan 06-05's
// DROP proposes anything. This is Pitfall 4's "capture-before-mutate"
// discipline (06-RESEARCH.md), mirroring this project's existing
// backup-before-mutation convention (data/backups/*.bak).
//
// Issues exactly four statements, all read-only:
//   1. SELECT CURRENT_USER()                                     — the
//      account exactly as the MySQL ACL sees it (RESEARCH Open Question 1;
//      never reconstructed by hand from the env)
//   2. SELECT TABLE_TYPE FROM information_schema.TABLES ...      — confirms
//      the object is still a BASE TABLE before anything is captured
//   3. SHOW CREATE TABLE photobooth.registrations                — the
//      restorable definition
//   4. SHOW GRANTS FOR CURRENT_USER()                             — the
//      pre-cutover grant baseline Pitfall 4 says to diff against
//
// Credentials never reach a command line: this uses mysql2 from Node, not
// the `mysql` CLI, so no password appears in `ps` output or shell history.
// Only err.message is ever logged, matching dbPoller.ts:134-140's rule.
import fs from 'fs';
import path from 'path';
import { getConfig } from '../config';
import { labelLogger } from '../logging/logger';

export const opsLogger = labelLogger('ops');

export const CANONICAL_OUTPUT_PATH = path.resolve(__dirname, '../../docs/migrations/06-rollback-registrations-table.sql');

export interface CaptureRollbackResult {
  currentUser: string;
  tableType: string;
  canonicalPath: string;
  backupPath: string;
  sql: string;
}

/**
 * Formats the ISO timestamp into the filesystem-safe shape this project's
 * existing backups use (data/backups/extension-service.sqlite.<ts>.bak) —
 * colons replaced with '-'.
 */
function backupTimestamp(): string {
  return new Date().toISOString().replace(/:/g, '-');
}

export async function captureRegistrationsRollback(): Promise<CaptureRollbackResult> {
  const config = getConfig();
  const captureStartedAt = new Date().toISOString();

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mysql = require('mysql2/promise');
  const pool = mysql.createPool({
    host: config.DB_HOST,
    port: config.DB_PORT,
    database: config.DB_NAME,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    waitForConnections: true,
    connectionLimit: 1,
  });

  let currentUser: string;
  let tableType: string;
  let createTableSql: string;
  let grantLines: string[];

  try {
    const conn = await pool.getConnection();
    try {
      // 1. SELECT CURRENT_USER()
      const [userRows] = await conn.query('SELECT CURRENT_USER() AS u');
      currentUser = String((userRows as Array<{ u: string }>)[0].u);

      // 2. Confirm still a BASE TABLE before capturing anything.
      const [typeRows] = await conn.query(
        `SELECT TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA='photobooth' AND TABLE_NAME='registrations'`
      );
      const typeRow = (typeRows as Array<{ TABLE_TYPE: string }>)[0];
      if (!typeRow) {
        throw new Error(
          `photobooth.registrations not found in information_schema.TABLES — nothing to capture. ` +
          `This means the cutover has already happened or the object this phase assumes does not exist.`
        );
      }
      tableType = typeRow.TABLE_TYPE;
      if (tableType !== 'BASE TABLE') {
        // Capturing a rollback for the wrong object is worse than capturing
        // none — stop and report rather than proceeding.
        throw new Error(
          `photobooth.registrations has TABLE_TYPE='${tableType}', expected 'BASE TABLE'. ` +
          `Refusing to capture a rollback artefact for an object that is not the pre-cutover table this phase assumes.`
        );
      }

      // 3. SHOW CREATE TABLE
      const [createRows] = await conn.query('SHOW CREATE TABLE photobooth.registrations');
      createTableSql = String((createRows as Array<{ 'Create Table': string }>)[0]['Create Table']);

      // 4. SHOW GRANTS FOR CURRENT_USER()
      const [grantRows] = await conn.query('SHOW GRANTS FOR CURRENT_USER()');
      grantLines = (grantRows as Array<Record<string, string>>).map((row) => {
        const key = Object.keys(row)[0];
        return row[key];
      });
    } finally {
      conn.release();
    }
  } finally {
    await pool.end().catch(() => {});
  }

  const sql = renderRollbackSql({
    captureStartedAt,
    currentUser,
    tableType,
    grantLines,
    createTableSql,
  });

  const canonicalPath = CANONICAL_OUTPUT_PATH;
  const backupPath = path.resolve(
    __dirname,
    `../../data/backups/photobooth-registrations-rollback-${backupTimestamp()}.sql`
  );

  fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
  fs.writeFileSync(canonicalPath, sql);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.writeFileSync(backupPath, sql);

  opsLogger.info(
    `Captured photobooth.registrations rollback: CURRENT_USER()=${currentUser}, TABLE_TYPE=${tableType}. ` +
    `Canonical: ${canonicalPath}. Mirrored to (gitignored): ${backupPath}.`
  );

  return { currentUser, tableType, canonicalPath, backupPath, sql };
}

function renderRollbackSql(args: {
  captureStartedAt: string;
  currentUser: string;
  tableType: string;
  grantLines: string[];
  createTableSql: string;
}): string {
  const { captureStartedAt, currentUser, tableType, grantLines, createTableSql } = args;

  const grantComments = grantLines.map((line) => `-- ${line}`).join('\n');

  return `-- Phase 6: Ingestion Cutover — pre-cutover rollback artefact
-- Generated by src/ops/captureRegistrationsRollback.ts
--
-- Capture timestamp: ${captureStartedAt}
-- CURRENT_USER(): ${currentUser}
-- Observed TABLE_TYPE: ${tableType}
--
-- CANONICAL COPY: this file, committed under docs/migrations/, is the
-- canonical rollback artefact. A byte-identical copy is also written to
-- data/backups/photobooth-registrations-rollback-<timestamp>.sql, mirroring
-- this project's existing backup-before-mutation convention — but that
-- directory is gitignored (.gitignore: "data/backups/"), so an artefact
-- that existed only there would not survive a fresh clone. This file is the
-- one that does.
--
-- Pre-cutover grant baseline (SHOW GRANTS FOR CURRENT_USER()), for plan
-- 06-05 to diff against per 06-RESEARCH.md Pitfall 4 — do not widen
-- privileges beyond what is listed here without a documented reason:
${grantComments}
--
-- RUNNABLE RESTORE — restores photobooth.registrations to exactly its
-- pre-cutover BASE TABLE definition. MySQL has no DDL undo; this is the
-- entire recovery path if plan 06-05's cutover must be reversed.

DROP VIEW IF EXISTS photobooth.registrations;
DROP VIEW IF EXISTS photobooth.registrations_name_audit;
${createTableSql};
`;
}

export async function main(): Promise<void> {
  try {
    const result = await captureRegistrationsRollback();
    // eslint-disable-next-line no-console
    console.log(
      `Captured rollback artefact — CURRENT_USER()=${result.currentUser}, TABLE_TYPE=${result.tableType}\n` +
      `  canonical: ${result.canonicalPath}\n` +
      `  mirrored:  ${result.backupPath}`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
