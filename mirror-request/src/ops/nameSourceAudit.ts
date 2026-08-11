import type { NameSource } from './registrationsViewSql';

// D-05's warn, off the ingestion path (dbPoller.ts is closed to edits — D-02).
// Kept pure and free of logging, LocalStore and mysql2, so it is testable
// with a literal array — the same discipline estimateWaitMs.ts follows. The
// caller (ViewHealthProbe.runNameAudit()) owns the SQL, the cursor
// persistence and the log line.

/** The poll key ViewHealthProbe persists the audit high-water mark under,
 * via the existing `db_poll_cursor` table (LocalStore.getCursor/setCursor) —
 * no new schema. */
export const NAME_AUDIT_CURSOR_KEY = 'name_audit';

export interface NameAuditRow {
  id: string;
  name_source: NameSource;
  registered_at: string;
}

export interface NameSourceWarning {
  ticketCode: string;
  nameSource: NameSource;
  registeredAt: string;
}

/**
 * One warning per row whose `name_source` differs from the first rung
 * (`personalinfo_name`) — every fall-through past `first_name`/`last_name`,
 * per D-05. Never logs, never touches the guest's resolved `name` — the
 * caller's SELECT does not even fetch that column.
 */
export function nameSourceWarnings(rows: readonly NameAuditRow[]): NameSourceWarning[] {
  return rows
    .filter((row) => row.name_source !== 'personalinfo_name')
    .map((row) => ({
      ticketCode: row.id,
      nameSource: row.name_source,
      registeredAt: row.registered_at,
    }));
}
