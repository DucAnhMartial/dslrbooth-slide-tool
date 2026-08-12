-- =============================================================================
-- Phase 6: Ingestion Cutover — the live cutover script.
--
-- This file is copy-pasteable, numbered, and ordered. Do NOT execute any
-- part of it outside plan 06-05's blocking checkpoint:decision. Every
-- section states what it proves before it runs.
--
-- The two CREATE OR REPLACE VIEW statements in section 3 are copied
-- VERBATIM from docs/migrations/06-registrations-view.sql, which is itself
-- generated (never hand-edited) from src/ops/registrationsViewSql.ts via
--   npx ts-node src/ops/verifyRegistrationsView.ts --emit-sql
-- so the text executed against production cannot differ from the text
-- plan 06-01 proved end-to-end against live data. If registrationsViewSql.ts
-- changes, regenerate 06-registrations-view.sql first, then re-copy its
-- CREATE OR REPLACE statements into section 3 below — do not hand-edit them
-- here.
--
-- Account resolved from plan 06-04 Task 2's live capture
-- (src/ops/captureRegistrationsRollback.ts, docs/migrations/
-- 06-rollback-registrations-table.sql): CURRENT_USER() =
-- 'extension_service_ro'@'%' — matches config.ts's extension_service_ro
-- default exactly (not assumed; measured).
-- =============================================================================


-- =============================================================================
-- SECTION 1: PRE-FLIGHT (read-only). Proves the premise this whole phase
-- rests on — a zero-row BASE TABLE this project owns — before anything
-- destructive runs. A non-zero count means the premise is false and this
-- script must stop here.
-- =============================================================================

SELECT CURRENT_USER();
-- Expect: extension_service_ro@% (or whatever DB_USER actually resolves to
-- at execution time — re-confirm, do not assume this stays the same forever).

SELECT VERSION();
-- Window functions (used by the VIEW's ROW_NUMBER() dedup, section 3) need
-- MySQL 8.0+. Observed 2026-08-11: 8.0.46-0ubuntu0.22.04.3.

SELECT TABLE_TYPE FROM information_schema.TABLES
WHERE TABLE_SCHEMA='photobooth' AND TABLE_NAME='registrations';
-- Expect: BASE TABLE. If this is already VIEW, the cutover has already run —
-- stop and investigate before proceeding, do not re-run section 2's DROP.

SELECT COUNT(*) FROM photobooth.registrations;
-- Expect: 0. Measured 2026-08-11 via plan 06-04 Task 2's live capture: 0
-- rows. A non-zero count means data has appeared in the table since that
-- measurement and this script's DROP would destroy it — stop here.

SHOW GRANTS FOR 'extension_service_ro'@'%';
-- Pitfall 4 (06-RESEARCH.md): MySQL privileges are recorded per
-- schema-qualified object name, not per object TYPE — a pre-existing grant
-- on photobooth.registrations (or, as measured here, on photobooth.* as a
-- whole) survives DROP TABLE + CREATE VIEW of the same name unchanged.
-- MEASURED 2026-08-11 (plan 06-04 Task 2, captured verbatim in
-- docs/migrations/06-rollback-registrations-table.sql):
--   GRANT USAGE ON *.* TO `extension_service_ro`@`%`
--   GRANT SELECT ON `photobooth`.* TO `extension_service_ro`@`%`
-- The second grant is schema-wide (`photobooth`.*) and therefore ALREADY
-- covers both photobooth.registrations and photobooth.registrations_name_audit
-- once they exist as VIEWs — re-run this SHOW GRANTS at execution time to
-- confirm the baseline has not changed, then read section 4's note before
-- deciding whether the GRANT statement there is needed at all.
--
-- OBSERVED RESULT (recorded by plan 06-05, executed by the human operator in
-- an admin session, 2026-08-11/12): CURRENT_USER() = 'extension_service_ro'@'%',
-- matching the baseline. VERSION() = 8.0.46-0ubuntu0.22.04.3. TABLE_TYPE =
-- BASE TABLE, COUNT(*) = 0 — premise held, section 2 proceeded. SHOW GRANTS
-- unchanged from the plan 06-04 baseline quoted above.


-- =============================================================================
-- SECTION 2: DESTRUCTIVE STEP. MySQL has no DDL undo — this is the point of
-- no return. Before running this line, docs/migrations/
-- 06-rollback-registrations-table.sql (captured live, plan 06-04 Task 2)
-- must already be committed and reviewed — it is the entire recovery path
-- if anything below goes wrong.
-- =============================================================================

DROP TABLE photobooth.registrations;

-- OBSERVED RESULT: OK. Executed by the human operator in an admin MySQL
-- session, 2026-08-11/12. The zero-row BASE TABLE is gone; this step is now
-- irreversible history, not a pending action — do not re-run it.


-- =============================================================================
-- SECTION 3: CREATE BOTH VIEWS. Copied verbatim from
-- docs/migrations/06-registrations-view.sql (generated from
-- src/ops/registrationsViewSql.ts) — this is character-for-character the
-- same text plan 06-01 proved end-to-end against live ets_web data. Do not
-- hand-edit the two statements below.
-- =============================================================================

CREATE OR REPLACE
  DEFINER = 'ets_web'@'127.0.0.1'
  SQL SECURITY DEFINER
  VIEW photobooth.registrations AS
SELECT d.id, d.name, d.email, d.phone, d.mode, d.registered_at
FROM (
SELECT
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
WHERE t.status = 'valid' AND o.status = 'completed'
) d
WHERE d.rn = 1;

CREATE OR REPLACE
  DEFINER = 'ets_web'@'127.0.0.1'
  SQL SECURITY DEFINER
  VIEW photobooth.registrations_name_audit AS
SELECT d.id, d.name_source, d.registered_at
FROM (
SELECT
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
WHERE t.status = 'valid' AND o.status = 'completed'
) d
WHERE d.rn = 1;

-- OBSERVED RESULT: both CREATE OR REPLACE VIEW statements returned OK when
-- run by the human operator, 2026-08-11/12. INCIDENT, caught and fixed
-- before this section was trusted: the interactive terminal paste
-- double-encoded the one non-ASCII literal above ('Khách • ') to
-- 'KhÃ¡ch â€¢ ' (confirmed via
-- HEX(SUBSTRING(VIEW_DEFINITION, LOCATE('Kh', VIEW_DEFINITION), 6)) = hex
-- 4B68C383C2A16368, not the correct 4B68C3A16368). Root cause was the
-- interactive copy-paste channel, not the server (utf8mb4 confirmed on
-- every connection/session variable; a piped round-trip test on this same
-- server was byte-exact even without --default-character-set). Fixed by
-- re-running only the two CREATE OR REPLACE VIEW statements via
-- `mysql < docs/migrations/06-registrations-view.sql` (piping, not paste) —
-- that file holds no DROP/GRANT, so nothing destructive or data-bearing was
-- at risk. Post-fix HEX check confirmed 4B68C3A16368 20 = 'Khách ', correct.
-- Runbook lesson (for OPS-RUNBOOK §10, 06-06 Task 1): "copy verbatim" does
-- not defend against this — pasting through a terminal is itself a lossy
-- channel for non-ASCII bytes. Any DDL with a non-ASCII literal must be
-- applied via `mysql < file.sql`, never interactive paste, and verified
-- afterward with a HEX() check on the stored VIEW_DEFINITION.


-- =============================================================================
-- SECTION 4: GRANT. Read this comment BEFORE running the statement below.
--
-- Pitfall 4's rule, restated: run section 1's SHOW GRANTS first. If the
-- existing grants already cover both new VIEWs, SKIP this statement rather
-- than widening privileges by reflex.
--
-- MEASURED 2026-08-11 (plan 06-04 Task 2): the existing grant is
--   GRANT SELECT ON `photobooth`.* TO `extension_service_ro`@`%`
-- This is schema-wide — it already covers photobooth.registrations and
-- photobooth.registrations_name_audit the moment section 3 creates them, with
-- no further grant needed. On THIS server, as measured, the statement below
-- is redundant. It is left in the script (not deleted) because a different
-- environment (a fresh photobooth database, or an account whose grant was
-- narrowed to the old table object specifically rather than the schema) may
-- genuinely need it — re-run section 1's SHOW GRANTS at execution time and
-- only run the statement below if that live check shows it is actually
-- missing.
--
-- Scoped to `photobooth.*` (one statement) rather than two separate
-- per-object GRANTs, because this schema holds only the two VIEWs this
-- project owns — a schema-wide grant here does not widen the account's
-- reach beyond what it already has. Under SQL SECURITY DEFINER (section 3),
-- `extension_service_ro` needs NO grant on any `ets_web` table at all — the
-- VIEW runs as its DEFINER ('ets_web'@'127.0.0.1'), not as the invoking
-- account.
-- =============================================================================

-- GRANT SELECT ON photobooth.* TO 'extension_service_ro'@'%';
-- FLUSH PRIVILEGES;

-- OBSERVED RESULT: this statement was run anyway (branch taken: issued, not
-- skipped) by the human operator, 2026-08-11/12, despite the comment above
-- correctly advising it was redundant on this server. Confirmed harmless and
-- idempotent: SHOW GRANTS FOR CURRENT_USER(), re-measured post-cutover
-- (plan 06-05, via the service account), is byte-identical to the plan
-- 06-04 baseline quoted above — GRANT USAGE ON *.* and GRANT SELECT ON
-- photobooth.* only, nothing added. The script's advice to skip it was
-- correct; running it anyway changed nothing.


-- =============================================================================
-- SECTION 5: POST-CHECKS (read-only). Run these AS THE SERVICE ACCOUNT
-- (extension_service_ro), not as the admin who ran sections 2-4 — only the
-- service account's result answers the question that matters: can the
-- process that actually polls this VIEW read it correctly?
-- =============================================================================

SELECT COUNT(*) AS total, COUNT(DISTINCT id) AS distinct_ids, COUNT(DISTINCT registered_at) AS distinct_ts
FROM photobooth.registrations;
-- Expect: total = distinct_ids (D-03's dedup holds — no ticket appears
-- twice). distinct_ts may legitimately be < total; that gap is the
-- `ordering` backstop (06-01/06-02) the VIEW health probe watches on an
-- ongoing basis, not a cutover blocker by itself.

SELECT id, name, email, phone, mode, registered_at
FROM photobooth.registrations
ORDER BY registered_at ASC LIMIT 3;
-- Expect: registered_at renders as the fixed-width lexical string
-- 'YYYY-MM-DD HH:MM:SS.ffffff' (6-digit microseconds, space separator — NOT
-- a native DATETIME/Date object; see Pitfall 1 / the_cursor_format_finding
-- in 06-04-PLAN.md). `mode` is the literal 'print'. `name` is never empty.

SELECT COUNT(*) FROM photobooth.registrations_name_audit;
-- Expect: equals SECTION 5's first check's `total` — the audit VIEW carries
-- exactly one row per ingestion-VIEW row (D-05's home).

-- OBSERVED RESULT (plan 06-05, re-run as the service account
-- 'extension_service_ro', not the admin who ran sections 2-4):
--   total=9, distinct_ids=9, distinct_ts=9 — D-03's dedup holds and the
--   `ordering` backstop's residual is currently zero.
--   First row (registered_at ASC): QFAP2ABS | anh.nd3 | print |
--     2026-07-27 07:51:19.250214
--   Last row (registered_at DESC LIMIT 1): XACX2T63 | NetNamTest | print |
--     2026-08-07 15:38:49.220951
--   registered_at renders as the fixed-width space-separated string, not a
--   native DATETIME — confirmed via src/ops/verifyRegistrationsView.ts
--   --source=view's 'registered_at-string-format' check (PASS, all 9 rows).
--   registrations_name_audit COUNT(*) = 9, matching total exactly.
--   name_source distribution: customer_username=4,
--   personalinfo_display_name=4, personalinfo_name=1 (synthetic=0 — D-04's
--   last-resort label has never had to fire on live data).
--   The full 9-check harness (src/ops/verifyRegistrationsView.ts
--   --source=view) was run against these same live rows through the service
--   account and returned ALL CHECKS PASSED.


-- =============================================================================
-- SECTION 6: WRITE-REFUSAL CHECK. Run AS THE SERVICE ACCOUNT. EXPECTED
-- OUTCOME: AN ERROR. This is the positive proof for ROADMAP success
-- criterion 5 — the ingestion credentials cannot write. A SUCCESSFUL INSERT
-- HERE IS A BLOCKING FINDING: it means CLAUDE.md's "NEVER write to the real
-- backend DB" guarantee does not hold at the database layer, and the
-- cutover must not proceed until the grant is corrected.
-- =============================================================================

INSERT INTO photobooth.registrations (id, name, email, phone, mode, registered_at)
VALUES ('write-refusal-check', 'test', 'test@example.com', '0000000000', 'print', NOW());
-- EXPECTED: ERROR 1142 (42000): INSERT command denied to user
-- 'extension_service_ro'@'%' for table 'registrations' — the account holds
-- only GRANT SELECT ON photobooth.* (section 1/4), so this is refused on
-- privilege before the VIEW's own structure is even reached. Even if write
-- privilege were ever mistakenly granted, the VIEW itself provides a second,
-- independent refusal: MySQL error 1471, "The target table registrations of
-- the INSERT is not insertable-into" — the VIEW's derived subquery contains
-- a JOIN and a window function, so MySQL's own updatable-view rules make it
-- structurally non-insertable regardless of privilege.
-- IF THIS INSERT SUCCEEDS: STOP. Do not proceed to guest traffic. Revoke
-- write access and re-run section 1's SHOW GRANTS before continuing.

-- OBSERVED RESULT: refused, on both lines of defence, proven independently
-- (plan 06-05):
--   As the SERVICE ACCOUNT ('extension_service_ro'): ERROR 1142 (42000):
--     INSERT command denied to user 'extension_service_ro'@'localhost' for
--     table 'registrations' — the privilege refusal, fires before structure
--     is reached. This is the positive proof for ROADMAP success criterion 4
--     and needed the service account specifically.
--   As the ADMIN account (run by the human operator, 2026-08-11/12):
--     ERROR 1471 (HY000): The target table registrations of the INSERT is
--     not insertable-into — the structural refusal (the VIEW's derived
--     subquery carries a JOIN and a window function). A different, also
--     true, proof.
--   No write of any kind succeeded through any account.


-- =============================================================================
-- SECTION 7: FALLBACK — only if section 5's post-checks fail with MySQL
-- error 1356 (ER_VIEW_INVALID) or 1449 (ER_NO_SUCH_USER). These are the same
-- two codes src/ops/viewHealthProbe.ts's VIEW_BROKEN_ERROR_CODES branches
-- on. RESEARCH.md could not execute DDL to empirically confirm whether a
-- DEFINER account with no `photobooth` privileges of its own (here,
-- 'ets_web'@'127.0.0.1', whose privileges are scoped to the `ets_web`
-- schema it owns) can successfully back a VIEW that lives in a DIFFERENT
-- schema (`photobooth`). This is a documented fallback to try, NOT a guess
-- to apply blindly — if it becomes necessary, confirm the substituted
-- administrative account can itself SELECT from every ets_web table the
-- VIEW's FROM/JOIN list touches (ticketing_ticket, event_manager_attendance,
-- ticketing_orderdetail, ticketing_order, ticketing_customer,
-- account_personalinfo) before trusting its output.
--
-- OBSERVED RESULT: NOT NEEDED. Section 5's post-checks and the full
-- src/ops/verifyRegistrationsView.ts --source=view harness both passed on
-- the first attempt (after the section-3 encoding fix) under the default
-- 'ets_web'@'127.0.0.1' definer. RESEARCH.md's open question — whether a
-- DEFINER account scoped to ets_web can back a VIEW living in the
-- photobooth schema — is now confirmed empirically CLOSED: it can.
-- 'extension_service_ro' reads both views correctly through
-- DEFINER = 'ets_web'@'127.0.0.1' with SQL SECURITY DEFINER, holding no
-- ets_web grant of its own.
-- =============================================================================

-- CREATE OR REPLACE
--   DEFINER = '<administrative-account>'@'<host>'   -- substitute the real
--                                                     -- admin account used
--                                                     -- to run this script
--   SQL SECURITY DEFINER
--   VIEW photobooth.registrations AS
-- SELECT d.id, d.name, d.email, d.phone, d.mode, d.registered_at
-- FROM ( /* ... identical inner SELECT from section 3 ... */ ) d
-- WHERE d.rn = 1;
--
-- CREATE OR REPLACE
--   DEFINER = '<administrative-account>'@'<host>'
--   SQL SECURITY DEFINER
--   VIEW photobooth.registrations_name_audit AS
-- SELECT d.id, d.name_source, d.registered_at
-- FROM ( /* ... identical inner SELECT from section 3 ... */ ) d
-- WHERE d.rn = 1;


-- =============================================================================
-- SECTION 8: ROLLBACK. Full script: docs/migrations/
-- 06-rollback-registrations-table.sql (captured live, plan 06-04 Task 2).
-- Restated inline here for convenience — MySQL has no DDL undo, so this is
-- the entire recovery path.
--
-- OBSERVED RESULT: not invoked. Nothing about the cutover required rollback
-- — the only defect encountered (the section 3 encoding incident) was fixed
-- by re-running the two CREATE OR REPLACE VIEW statements, not by rolling
-- back to the BASE TABLE. This script remains the recovery path if ever
-- needed later.
-- =============================================================================

-- DROP VIEW IF EXISTS photobooth.registrations;
-- DROP VIEW IF EXISTS photobooth.registrations_name_audit;
-- CREATE TABLE `registrations` (
--   `id` varchar(255) NOT NULL,
--   `name` varchar(255) NOT NULL,
--   `email` varchar(255) DEFAULT NULL,
--   `phone` varchar(50) DEFAULT NULL,
--   `mode` varchar(50) DEFAULT 'standard',
--   `registered_at` datetime NOT NULL,
--   `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
--   PRIMARY KEY (`id`)
-- ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
