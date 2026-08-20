// Phase 6: Ingestion Cutover — the single declaration every VIEW DDL,
// verification query and regression test derives from. Following the same
// one-declaration discipline plan 05-02 used for `KNOWN_JOB_STATUSES`: there
// is exactly one place the six-column projection, the name-fallback chain and
// the dedup logic are written, and everything else (the committed .sql, the
// live VIEW, the harness, the drift test) is generated or asserted from it.
//
// D-01: `registered_at` is sourced from `event_manager_attendance.created_at`
// (reached by the INNER JOIN below), never `ticketing_order.created_at`,
// which ties across two tickets sharing one order.
// D-02: nothing here compensates inside `dbPoller.ts` — the projection meets
// the shipped consumer contract exactly as it is (`dbPoller.ts:101`'s six
// columns, in this order).
// D-03 (correction): the bare INNER JOIN on `event_manager_attendance` is not
// 1:1 with `ticketing_ticket` — the upstream unique constraint is
// `(ticket, session)`, not `ticket` alone. The `ROW_NUMBER()` window function
// below explicitly de-duplicates to exactly one row per ticket.
// D-04/D-05: the name fallback chain never yields an empty value, and
// `name_source` records which rung supplied it (surfaced only in the sibling
// `registrations_name_audit` VIEW, never in the six-column ingestion VIEW).
// D-08: `mode` is the literal 'print', chosen by us — `ets_web` has no
// concept of a photobooth capture mode.
// Pitfall 1 (06-RESEARCH.md): `registered_at` MUST be a `DATE_FORMAT` string,
// never a bare `DATETIME`/`TIMESTAMP` column — `mysql2` would hand
// `dbPoller.ts` a JS `Date`, which `better-sqlite3` rejects with a
// `TypeError`. `%f` contractually zero-pads to 6 digits; `CAST(... AS CHAR)`
// does not have that guarantee (RESEARCH Open Question 2), so it is
// deliberately not used here.

/**
 * The six-column ingestion projection plus two columns (`name_source`,
 * `rn`) that exist only to serve the audit VIEW and the dedup window
 * function — never part of the six-column ingestion VIEW's own SELECT list.
 *
 * `t.status = 'valid' AND o.status = 'completed'` is the validity filter
 * (D-03's first half, unchanged from CONTEXT): a cancelled ticket or a
 * non-completed order is structurally incapable of reaching this SELECT at
 * all, because the filter is applied before the window function ever runs.
 */
export const REGISTRATIONS_INNER_SELECT = `SELECT
    t.ticket_code AS id,
    COALESCE(
      NULLIF(TRIM(CONCAT(COALESCE(p.first_name,''), ' ', COALESCE(p.last_name,''))), ''),
      NULLIF(p.display_name, ''),
      NULLIF(c.display_name, ''),
      NULLIF(c.username, ''),
      CONCAT('Khách • ', COALESCE(RIGHT(t.ticket_code, 4), ''))
    ) AS name,
    CASE
      WHEN NULLIF(TRIM(CONCAT(COALESCE(p.first_name,''), ' ', COALESCE(p.last_name,''))), '') IS NOT NULL THEN 'personalinfo_name'
      WHEN NULLIF(p.display_name, '') IS NOT NULL THEN 'personalinfo_display_name'
      WHEN NULLIF(c.display_name, '') IS NOT NULL THEN 'customer_display_name'
      WHEN NULLIF(c.username, '') IS NOT NULL THEN 'customer_username'
      ELSE 'synthetic'
    END AS name_source,
    COALESCE(NULLIF(p.email,''), c.email) AS email,
    COALESCE(p.phone, '') AS phone,
    'print' AS mode,
    DATE_FORMAT(a.created_at, '%Y-%m-%d %H:%i:%s.%f') AS registered_at,
    ROW_NUMBER() OVER (
      PARTITION BY t.id ORDER BY a.created_at ASC, a.id ASC
    ) AS rn
FROM ets_web.ticketing_ticket t
INNER JOIN ets_web.event_manager_attendance a ON a.ticket_id = t.id
INNER JOIN ets_web.ticketing_orderdetail od ON od.id = t.order_detail_id
INNER JOIN ets_web.ticketing_order o ON o.id = od.order_id
INNER JOIN ets_web.ticketing_customer c ON c.id = o.customer_id
LEFT JOIN ets_web.account_personalinfo p ON p.id = t.ticket_holder_id
WHERE t.status = 'valid' AND o.status = 'completed'`;

/** The six columns `dbPoller.ts:101` selects, in exactly that order. */
export const REGISTRATIONS_VIEW_COLUMNS = ['id', 'name', 'email', 'phone', 'mode', 'registered_at'] as const;

/** The five values `name_source` can take — a sixth is a compile error. */
export const NAME_SOURCE_VALUES = [
  'personalinfo_name',
  'personalinfo_display_name',
  'customer_display_name',
  'customer_username',
  'synthetic',
] as const;

export type NameSource = (typeof NAME_SOURCE_VALUES)[number];

/**
 * The definer account this VIEW runs as. `SQL SECURITY DEFINER` means the
 * invoking account (the Extension Service's DB user) needs no grant on any
 * `ets_web` table at all — only `GRANT SELECT ON photobooth.registrations`.
 */
export const DEFAULT_VIEW_DEFINER = "'ets_web'@'127.0.0.1'";

/**
 * The six-column ingestion VIEW. Deliberately does NOT project `name_source`
 * — that lives only in `createNameAuditViewDdl()`'s sibling VIEW, keeping
 * `photobooth.registrations` at exactly the six columns CONTEXT's discretion
 * clause requires.
 */
export function createRegistrationsViewDdl(definer: string): string {
  return `CREATE OR REPLACE
  DEFINER = ${definer}
  SQL SECURITY DEFINER
  VIEW photobooth.registrations AS
SELECT d.id, d.name, d.email, d.phone, d.mode, d.registered_at
FROM (
${REGISTRATIONS_INNER_SELECT}
) d
WHERE d.rn = 1;`;
}

/**
 * The three-column audit VIEW (D-05's home): exposes `name_source` so an
 * operator can see how often the synthetic fallback rung fires, without
 * widening the six-column ingestion VIEW's contract.
 */
export function createNameAuditViewDdl(definer: string): string {
  return `CREATE OR REPLACE
  DEFINER = ${definer}
  SQL SECURITY DEFINER
  VIEW photobooth.registrations_name_audit AS
SELECT d.id, d.name_source, d.registered_at
FROM (
${REGISTRATIONS_INNER_SELECT}
) d
WHERE d.rn = 1;`;
}

/**
 * The six-column projection with the inner SELECT inlined and no
 * `CREATE VIEW` wrapper — the pre-cutover form, runnable read-only by an
 * account that can SELECT from `ets_web` while `photobooth.registrations` is
 * still a table. `ORDER BY d.registered_at ASC` mirrors `dbPoller.ts:101`'s
 * own `ORDER BY registered_at ASC`, so the harness can confirm lexical order
 * is chronological by comparing MySQL's returned sequence to a JS sort.
 */
export function buildInlineProjectionSql(): string {
  return `SELECT d.id, d.name, d.email, d.phone, d.mode, d.registered_at
FROM (
${REGISTRATIONS_INNER_SELECT}
) d
WHERE d.rn = 1
ORDER BY d.registered_at ASC;`;
}

/**
 * Counts `COUNT(DISTINCT t.id)` over the same joins and filter, computed
 * independently of the `ROW_NUMBER()` window function above — the dedup
 * claim is measured against this control, not merely asserted by the same
 * mechanism that produces it.
 */
export const DEDUP_CONTROL_SQL = `SELECT COUNT(DISTINCT t.id) AS distinct_ticket_count
FROM ets_web.ticketing_ticket t
INNER JOIN ets_web.event_manager_attendance a ON a.ticket_id = t.id
INNER JOIN ets_web.ticketing_orderdetail od ON od.id = t.order_detail_id
INNER JOIN ets_web.ticketing_order o ON o.id = od.order_id
WHERE t.status = 'valid' AND o.status = 'completed';`;

/**
 * Every `ticketing_order.created_at` shared by two or more tickets under the
 * same filter, together with those tickets' `ticket_code` values — the D-01
 * order-level tie the projection dissolves by sourcing `registered_at` from
 * `event_manager_attendance.created_at` instead.
 */
export const ORDER_TIE_CONTROL_SQL = `SELECT
    o.created_at AS order_created_at,
    GROUP_CONCAT(DISTINCT t.ticket_code ORDER BY t.ticket_code) AS ticket_codes,
    COUNT(DISTINCT t.id) AS ticket_count
FROM ets_web.ticketing_ticket t
INNER JOIN ets_web.event_manager_attendance a ON a.ticket_id = t.id
INNER JOIN ets_web.ticketing_orderdetail od ON od.id = t.order_detail_id
INNER JOIN ets_web.ticketing_order o ON o.id = od.order_id
WHERE t.status = 'valid' AND o.status = 'completed'
GROUP BY o.created_at
HAVING COUNT(DISTINCT t.id) > 1;`;
