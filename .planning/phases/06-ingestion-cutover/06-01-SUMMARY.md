---
phase: 06-ingestion-cutover
plan: 01
subsystem: database
tags: [mysql, mysql2, view, better-sqlite3, vitest, sql, ingestion]

# Dependency graph
requires:
  - phase: 01-foundation-ingestion
    provides: "DBPoller (dbPoller.ts) and LocalStore (localStore.ts) — the untouched, shipped consumer contract this plan's projection must satisfy exactly"
provides:
  - "REGISTRATIONS_INNER_SELECT / REGISTRATIONS_VIEW_COLUMNS / NAME_SOURCE_VALUES / createRegistrationsViewDdl / createNameAuditViewDdl / buildInlineProjectionSql / DEDUP_CONTROL_SQL / ORDER_TIE_CONTROL_SQL — the single SQL declaration every later Phase 6 artefact derives from"
  - "verifyRegistrationsView() / main() — a read-only end-to-end harness (live MySQL -> mysql2 -> LocalStore -> SQLite), runnable against inline SQL (pre-cutover) or the live VIEW (post-cutover, plan 06-05)"
  - "docs/migrations/06-registrations-view.sql — the committed, generated DDL text plan 06-05 will run against production"
  - "A standing regression pinning the mysql2 -> better-sqlite3 registered_at bind hazard, and a drift guard locking the committed .sql to the module"
affects: [06-02, 06-03, 06-04, 06-05, 06-06]

actuals:
  tokens: 9169
  tasks: 3
  commits: 3

tech-stack:
  added: []
  patterns:
    - "One-declaration discipline for SQL projections (mirrors plan 05-02's KNOWN_JOB_STATUSES): REGISTRATIONS_INNER_SELECT is the sole source every VIEW DDL, control query, and regression test derives from — a change in one place propagates everywhere instead of three places drifting independently."
    - "Mutation-based non-vacuousness proof for a TDD task that cannot go RED because the behaviour under test already matches the untouched production code (plan 05-02 precedent) — used here because dbPoller.ts and better-sqlite3's own bind-type rejection are both out of scope to modify (D-02)."

key-files:
  created:
    - mirror-request/src/ops/registrationsViewSql.ts
    - mirror-request/src/ops/verifyRegistrationsView.ts
    - mirror-request/docs/migrations/06-registrations-view.sql
    - mirror-request/test/registrations-view-sql.test.ts
  modified:
    - mirror-request/test/db-poller.test.ts

key-decisions:
  - "registered_at is projected via DATE_FORMAT(a.created_at, '%Y-%m-%d %H:%i:%s.%f'), never CAST(...AS CHAR) — RESEARCH could not verify CAST's zero-padding, and DATE_FORMAT's %f is contractually fixed at 6 digits."
  - "Dedup is an explicit ROW_NUMBER() OVER (PARTITION BY t.id ORDER BY a.created_at ASC, a.id ASC), correcting CONTEXT D-03's bare-INNER-JOIN premise — the upstream unique constraint is (ticket, session), not ticket alone."
  - "name_source is projected only in a sibling registrations_name_audit VIEW, never in the six-column photobooth.registrations VIEW — keeps D-05's audit trail without widening the ingestion contract CONTEXT's discretion clause pins at exactly six columns."
  - "email prefers the ticket holder's own account_personalinfo.email over the purchaser's ticketing_customer.email (Claude's Discretion — CONTEXT places no constraint on email, and nothing downstream consumes it today)."
  - "Task 2's bind-hazard tests could not go RED (no production code changes in this task; dbPoller.ts stays byte-identical per D-02, and better-sqlite3's Date-rejection is pre-existing driver behaviour). Non-vacuousness was proven instead by two temporary in-memory mutations, each reverted before the commit."

patterns-established:
  - "SQL projection modules that emit both a runnable pre-cutover inline query and a post-cutover VIEW DDL from one shared inner-SELECT string, so the pre/post-cutover behaviour cannot diverge."

requirements-completed: [ING-02, ING-03]

coverage:
  - id: D1
    description: "The exact six-column registrations projection (id/name/email/phone/mode/registered_at) executes read-only against live ets_web and matches dbPoller.ts's consumer contract exactly."
    requirement: "ING-02"
    verification:
      - kind: integration
        ref: "src/ops/verifyRegistrationsView.ts --source=inline (run manually against live MySQL; not a CI test — no ets_web fixture exists to run it against in CI)"
        status: pass
      - kind: unit
        ref: "test/registrations-view-sql.test.ts — six-column contract + dbPoller.ts substring assertions"
        status: pass
    human_judgment: false
  - id: D2
    description: "registered_at crosses mysql2 -> better-sqlite3 as a bindable string in every case; a native Date bind is caught by the existing warn-and-retry catch rather than crashing or corrupting the cursor."
    requirement: "ING-03"
    verification:
      - kind: unit
        ref: "test/db-poller.test.ts#registered_at bind type across the mysql2 -> better-sqlite3 boundary (RESEARCH Pitfall 1)"
        status: pass
      - kind: integration
        ref: "src/ops/verifyRegistrationsView.ts --source=inline sqlite-bind-proof check (run manually against live MySQL)"
        status: pass
    human_judgment: false
  - id: D3
    description: "The dedup and order-tie-dissolution claims are measured against live data via independent controls (DEDUP_CONTROL_SQL, ORDER_TIE_CONTROL_SQL), not merely asserted by the same mechanism that produces them."
    verification:
      - kind: integration
        ref: "src/ops/verifyRegistrationsView.ts --source=inline dedup + order-tie-dissolution checks (run manually against live MySQL)"
        status: pass
    human_judgment: true
    rationale: "The dedup/tie-dissolution proof is a live-data measurement taken once during this plan's execution, not a repeatable CI assertion (no ets_web fixture exists) — a human should confirm the specific numbers recorded below (9/9 dedup, 2 tie groups dissolved) before this is trusted as the phase's ongoing evidence base."
  - id: D4
    description: "The committed migration DDL cannot silently drift from the SQL module that generated it, and the six-column contract with dbPoller.ts is asserted by the suite."
    verification:
      - kind: unit
        ref: "test/registrations-view-sql.test.ts#registrationsViewSql — committed DDL matches the module (drift guard)"
        status: pass
    human_judgment: false

duration: 55min
completed: 2026-08-11
status: complete
---

# Phase 6 Plan 01: Ingestion Projection Tracer Summary

**Proved, against live `ets_web` data, that the exact six-column SQL projection which will become `photobooth.registrations` binds cleanly through the never-before-executed mysql2 → better-sqlite3 code path, and pinned both defects RESEARCH found (the Date-bind crash, the CONTEXT D-03 dedup gap) as standing regressions.**

## Performance

- **Duration:** 55 min (approx.)
- **Tasks:** 3/3 completed
- **Files modified:** 5 (4 created, 1 modified)
- **Commits:** 3 task commits

## Accomplishments

- `src/ops/registrationsViewSql.ts` is the single SQL declaration every later Phase 6 artefact (the live VIEW in plan 06-05, the health probe in 06-02, this plan's own drift test) derives from — no second copy of the JOIN chain, the name-fallback chain, or the dedup logic exists anywhere.
- `src/ops/verifyRegistrationsView.ts` executed the projection read-only against live `ets_web` and bound every one of the 9 live valid/completed rows through the real `LocalStore.upsertRegistration()` / `enqueueJob()` / `setCursor()` code path — the exact bind sites that have never once executed in this project's history, because `photobooth.registrations` has held 0 rows since Phase 1. All 9 named checks passed; see Measured Numbers below.
- The mysql2 → better-sqlite3 Date-bind hazard (RESEARCH Pitfall 1) is now a standing regression in `test/db-poller.test.ts`, pinned against the real, file-backed `LocalStore` (not a mock).
- The committed `docs/migrations/06-registrations-view.sql` cannot drift from `registrationsViewSql.ts` without the suite going red, and the six-column contract with `dbPoller.ts` is asserted by the suite rather than trusted from memory.
- `dbPoller.ts` and `localStore.ts` remain byte-identical to baseline `9699374` (D-02) — every fix lives entirely in the new SQL module.

## Task Commits

Each task was committed atomically in `mirror-request`:

1. **Task 1: One live ets_web registration reaches SQLite through the exact projection — end to end, read-only** — `ec29500` (feat)
2. **Task 2: Pin the mysql2 -> better-sqlite3 bind hazard in the suite, both sides** — `9b82c03` (test)
3. **Task 3: Lock the committed DDL to the module and the six-column contract to dbPoller** — `2163376` (test)

_Note: Task 2 and Task 3 are `tdd="true"` but produced single `test` commits each — see "TDD Gate Compliance" below for why._

## Files Created/Modified

- `mirror-request/src/ops/registrationsViewSql.ts` — the projection's single SQL declaration (`REGISTRATIONS_INNER_SELECT`), the six-column and audit VIEW DDL builders, the two independent live-data controls, and the pre-cutover inline query builder.
- `mirror-request/src/ops/verifyRegistrationsView.ts` — the read-only end-to-end harness; `main()` supports `--source=inline|view` and `--emit-sql`.
- `mirror-request/docs/migrations/06-registrations-view.sql` — committed, generated (never hand-edited) DDL text for both VIEWs.
- `mirror-request/test/registrations-view-sql.test.ts` — new: the drift guard (committed `.sql` == module output) and the six-column/`dbPoller.ts` contract, 8 tests.
- `mirror-request/test/db-poller.test.ts` — extended with the `registered_at` bind-type describe block, 2 new tests (11 → 13 in this file).

## Measured Numbers (live `ets_web`, 2026-08-11, read-only)

Run: `SOURCE_DB_USER=ets_web SOURCE_DB_PASSWORD=*** npx ts-node src/ops/verifyRegistrationsView.ts --source=inline` — exit 0, 9/9 checks PASSED.

| Check | Result |
|---|---|
| column-key-set | 9 rows, keys exactly `id,name,email,phone,mode,registered_at` |
| registered_at-string-format | all 9 rows string, matching `^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$` (sample `2026-07-27 07:51:19.250214`) |
| dedup | rows=9, distinctIds=9, `DEDUP_CONTROL_SQL`=9 — all three equal |
| non-empty-name | all 9 rows non-empty after trim |
| order-tie-dissolution | 2 tie groups found (see correction below), both dissolve to distinct `registered_at` |
| advisory-cross-ticket-distinctness | rows=9, distinct `registered_at`=9 (empirical, not structural — the `ordering` backstop truth) |
| lexical-order-is-chronological | MySQL's `ORDER BY registered_at ASC` sequence equals a JS lexical sort of the same values |
| name_source-distribution | `customer_username=4, personalinfo_display_name=4, personalinfo_name=1` (0 `synthetic`) |
| sqlite-bind-proof | 9 registrations written, 9 jobs enqueued, cursor read back = `2026-08-07 15:38:49.220951`, no `TypeError` |

**Correction to the planning record (measurement, not a new hazard):** CONTEXT.md's D-01 and STATE.md's Phase 6 row cite only one order-level tie (`A523ZC1W`/`WHD4Q2C0`, both sharing `ticketing_order.created_at = 2026-07-27 10:38:01.701017`). This plan's live query found a **second** tie group that was present in the original discuss-phase data but under-recorded when CONTEXT.md was written: `9R1XX5RH`/`FC8PX5JQ`, both sharing `ticketing_order.created_at = 2026-07-30 09:54:02.824145` (confirmed by a direct `SELECT` against `ticketing_order`/`ticketing_orderdetail`/`ticketing_ticket`, order id 1441). **Real incidence: 2 of the 7 `completed` orders carry a tie, not 1.** Both groups dissolve to distinct `registered_at` values in the projection (`event_manager_attendance.created_at` per ticket, not `ticketing_order.created_at` per order) — D-01's fix is unaffected, but the hazard it addresses is routine within this dataset, not a one-off, which materially strengthens D-01's justification.

**Operational fact worth carrying forward:** the `name_source` distribution — `customer_username=4, personalinfo_display_name=4, personalinfo_name=1` — means 8 of the 9 live rows fall through past the real first/last name, and 4 of those would render on the room's big screen as a raw username (e.g. an `anh.nd3`-style handle) rather than a person's name. D-04's fallback chain is working exactly as designed (nobody is silently dropped, and the synthetic `Khách • ####` label never had to fire on this data), but the distribution indicates the current 9 live rows are test/seed registrations that never populated `account_personalinfo`. A real landing-page registration is expected to populate `first_name`/`last_name` (the registration API's schema requires them per RESEARCH.md); D-05's per-fallback `name_source` audit VIEW is the signal an operator should watch to confirm that expectation keeps holding once real guests register.

## Decisions Made

- **Tracer feedback gate resolved by explicit human confirmation, not self-approved.** Per this project's unbroken precedent (Phase 1 Task 3, plan 02-04 Task 3, plan 03-01 Task 1, plan 03-05 Task 2, plan 04-04 Task 3, plan 05-01 Task 1, plan 05-05 Task 3), the executor halted after committing Task 1 (a `type="tracer"` task, `workflow.auto_advance` unset / `_auto_chain_active: false` in `.planning/config.json`) and returned a `checkpoint:human-verify` presenting the already-run automation's 9/9 measured PASS results. The coordinator relayed the human's explicit confirmation — "VERIFIED — the human confirmed the tracer's proven slice. Proceed to Task 2 and Task 3." — before Tasks 2 and 3 (which build regression coverage on top of the tracer) were executed. No self-approval occurred.
- `DATE_FORMAT(..., '%Y-%m-%d %H:%i:%s.%f')` over `CAST(... AS CHAR)` for `registered_at` — RESEARCH's Open Question 2 (`CAST`'s zero-padding on a `datetime(6)` column) was never independently tested; `DATE_FORMAT`'s `%f` is contractually fixed-width.
- `ROW_NUMBER() OVER (PARTITION BY t.id ORDER BY a.created_at ASC, a.id ASC)` as the dedup mechanism, keeping `rn = 1` — corrects CONTEXT D-03, whose bare-INNER-JOIN premise research overturned (upstream unique constraint is `(ticket, session)`, not `ticket`).
- `name_source` lives only in the sibling `registrations_name_audit` VIEW, never in the six-column `photobooth.registrations` VIEW — satisfies D-05 without widening the ingestion contract past the six columns CONTEXT's discretion clause pins.
- `email` prefers `account_personalinfo.email` (the ticket holder / attendee) over `ticketing_customer.email` (the purchaser) — Claude's Discretion; nothing downstream consumes `email` today.

## Deviations from Plan

### Auto-fixed Issues

None — no bugs, missing functionality, or blocking issues required a Rule 1/2/3 auto-fix. The plan's SQL skeleton, table/column names, and join chain all matched the live schema exactly on first execution; every measurement (dedup, tie dissolution, string bind, key set) passed without needing to adjust the SQL.

### Findings Reported (not deviations — additional measurements)

1. **A second order-level tie group beyond the one CONTEXT.md documented.** See "Measured Numbers" above — `9R1XX5RH`/`FC8PX5JQ` sharing `2026-07-30 09:54:02.824145`, in addition to the already-known `A523ZC1W`/`WHD4Q2C0`. This corrects the planning record's under-count (1 → 2 tie groups, 2 of 7 completed orders) rather than introducing a new hazard; D-01's fix already covers it.
2. **The `name_source` distribution is an operational signal, not just a passing check.** 8/9 live rows fall through past first/last name; 4/9 resolve to a raw username. Recorded above as the fact an operator should watch via the `registrations_name_audit` VIEW once real guests register.

**Total deviations:** 0 auto-fixed.
**Impact on plan:** None — plan executed exactly as written; both findings above are measurements that strengthen the existing D-01/D-04/D-05 justifications, not changes to the implementation.

## TDD Gate Compliance

Tasks 2 and 3 carry `tdd="true"` but each produced a single `test` commit, not a RED/GREEN pair:

- **Task 2** (`9b82c03`): the two new assertions in `test/db-poller.test.ts` could not go RED because this task changes no production code (`dbPoller.ts` stays byte-identical per D-02) and the behaviour under test — better-sqlite3 throwing `TypeError` on a `Date` bind parameter — is pre-existing driver behaviour, independently confirmed via a standalone `node -e` script before the assertions were written. Both new tests passed on first run. Non-vacuousness was proven by two temporary in-memory mutations (fixture swap between the Date case and the string case), each observed to fail the expected assertion, then reverted before the commit — recorded in the commit message.
- **Task 3** (`2163376`): same situation — `test/registrations-view-sql.test.ts` asserts properties of `registrationsViewSql.ts`, which Task 1 already implemented correctly; there is no separate implementation step for Task 3 to drive RED→GREEN. The drift guard's non-vacuousness is proven directly in the test file itself (two in-memory mutations — a different DEFINER, a dropped outer-projection column — that must NOT equal the committed file, asserted every run, not just once during authoring).

This matches the plan's own anticipated fallback ("if it cannot go RED, prove the test non-vacuous by mutation and say which mutation killed which assertion — plan 05-02 set that precedent") and was confirmed as the correct path by the coordinator before Tasks 2/3 were executed.

## Issues Encountered

None.

## User Setup Required

None — no external service configuration required. (The MySQL account used for this plan's live measurements, `ets_web`, is the pre-existing Django DB user; no new credentials were created or required.)

## Verification

- `cd mirror-request && npm test`: **32 files / 268 tests** green (baseline at plan start: 31 files / 258 tests — confirmed live, not carried forward from the stale figure — measured directly before Task 1 began). +1 file / +8 tests from Task 3, +2 tests in an existing file from Task 2.
- `cd mirror-request && npm run typecheck` and `npm run build`: both exit 0.
- `git diff --quiet 9699374 -- src/ingestion/dbPoller.ts`: exits 0 — byte-identical to baseline (D-02).
- `git diff --quiet 9699374 -- src/state/localStore.ts`: exits 0 — byte-identical to baseline.
- `git diff --name-only 9699374..HEAD`: lists exactly the 5 files this plan's `files_modified` frontmatter declared, no more, no fewer.
- No new entry in `package.json` `dependencies` or `devDependencies` (`mysql2` was already present, `^3.23.2`).
- `/opt/web-ticket/qrcode/` unmodified: not a git repo (`git -C /opt/web-ticket status` fails as expected); `find /opt/web-ticket/qrcode/ets_web -newer <this repo's latest commit ref>` returned no files.
- No statement other than `SELECT`/`SHOW` was issued against MySQL at any point in this plan's execution — confirmed by design (the harness only ever calls `conn.query()` with the SELECT-only SQL strings exported from `registrationsViewSql.ts`) and by the absence of any INSERT/UPDATE/DELETE/DDL string anywhere in the new source files.

## Next Phase Readiness

Plan 06-01's artefacts are ready for the rest of Phase 6:
- Plan 06-02 (health probe) and 06-04 (cursor) can both import `registrationsViewSql.ts`'s exports directly rather than re-deriving the projection.
- Plan 06-05 (the live DDL cutover, behind a blocking `checkpoint:decision`) will run `docs/migrations/06-registrations-view.sql` verbatim — already committed, already proven to match the module that generated it.
- No blockers. The one open item this plan intentionally leaves for later plans: the `ordering` truth (cross-ticket `registered_at` totality) is empirical, not structural — plan 06-02's health probe is where `COUNT(*)` vs `COUNT(DISTINCT registered_at)` becomes a live, alerting check, per the plan's own `verification: backstop` disposition.

## Self-Check: PASSED

All 5 created/modified files confirmed present on disk; all 3 task commit hashes (`ec29500`, `9b82c03`, `2163376`) confirmed present in `git log --oneline --all`.

---
*Phase: 06-ingestion-cutover*
*Completed: 2026-08-11*
