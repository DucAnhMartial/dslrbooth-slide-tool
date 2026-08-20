---
phase: 06-ingestion-cutover
plan: 04
subsystem: database
tags: [mysql, mysql2, cursor, migration, rollback, ddl, vitest]

# Dependency graph
requires:
  - phase: 06-ingestion-cutover
    provides: "registrationsViewSql.ts's createRegistrationsViewDdl/createNameAuditViewDdl/DEFAULT_VIEW_DEFINER and docs/migrations/06-registrations-view.sql (plan 06-01) — the single generated source this plan's cutover script embeds verbatim"
provides:
  - "seedRegistrationsCursor(opts)/main() — D-06's one-shot cursor seed, sourced from MySQL's own NOW(6) in the VIEW's lexical format, never the Node clock"
  - "captureRegistrationsRollback()/main() — read-only capture of SHOW CREATE TABLE + SHOW GRANTS into a runnable, committed restore script, refusing to proceed if TABLE_TYPE is not BASE TABLE"
  - "docs/migrations/06-cutover.sql — the exact 8-section ordered cutover a human will run at plan 06-05's blocking checkpoint"
  - "docs/migrations/06-rollback-registrations-table.sql — the committed pre-cutover restore artefact, with the live grant baseline recorded"
affects: [06-05, 06-06]

actuals:
  tokens: 9540
  tasks: 3
  commits: 3

tech-stack:
  added: []
  patterns:
    - "Seed sourced from the remote server's own clock (SELECT DATE_FORMAT(NOW(6), ...) with no FROM clause), never the Node process's clock — the same class of guard as D-01's per-ticket timestamp sourcing, applied to cursor seeding instead of dedup."
    - "Generated-not-retyped DDL embedding, proven by extraction+diff rather than by eye: the two CREATE OR REPLACE VIEW statements in 06-cutover.sql are asserted character-identical to 06-registrations-view.sql's output via a comment-stripped regex extraction, not merely copy-pasted and trusted."

key-files:
  created:
    - mirror-request/src/ops/seedRegistrationsCursor.ts
    - mirror-request/src/ops/captureRegistrationsRollback.ts
    - mirror-request/docs/migrations/06-cutover.sql
    - mirror-request/docs/migrations/06-rollback-registrations-table.sql
  modified:
    - mirror-request/test/local-store-persistence.test.ts

key-decisions:
  - "The cursor seed's format is asserted, not trusted: seedRegistrationsCursor() throws (never falls back to toISOString()) if MySQL's NOW(6) result is not a string matching REGISTERED_AT_LEXICAL_PATTERN — a wrong runtime shape is a hard stop, not a silent downgrade to the exact seed format this module exists to reject."
  - "Re-seeding an already-seeded (non-default) cursor is refused unless --force is passed, naming the existing value — re-seeding a live deployment silently skips every guest between the old value and the new one."
  - "The GRANT statement in 06-cutover.sql section 4 is left commented as a decision point, not auto-run: the live baseline captured in Task 2 (GRANT SELECT ON `photobooth`.* TO `extension_service_ro`@`%`) is already schema-wide and already covers both VIEWs plan 06-05 will create, so running it again would be redundant per Pitfall 4's own rule (\"skip rather than widen by reflex\") — but the statement is left in the script, uncommitted-to, for an environment where the baseline differs."
  - "The write-refusal check's expected error is MySQL 1142 (INSERT command denied), not 1471 (non-insertable view) — the account's GRANT SELECT-only privilege is checked before the VIEW's own structural non-updatability, so 1142 is what will actually fire; 1471 is documented as the second, independent line of defense in case privilege were ever mistakenly widened."

patterns-established:
  - "Diff-proof embedding: when a plan requires generated SQL text to be embedded verbatim into a second file, prove identity by comment-stripped extraction + string equality in a throwaway script, not by visual inspection — the same discipline test/registrations-view-sql.test.ts's drift guard applies as a permanent test, applied here as a one-time authoring-time check since 06-cutover.sql itself is never executed by CI."

requirements-completed: [ING-03, ING-02]

coverage:
  - id: D1
    description: "The registrations cursor is seeded to a value in the VIEW's own lexical format, read from MySQL's own clock (never the Node host's), so none of the 9 historical rows is dispatched at cutover and the ISO-vs-space format collision cannot silently swallow same-day registrations."
    requirement: "ING-03"
    verification:
      - kind: unit
        ref: "test/local-store-persistence.test.ts#D-06 registrations cursor seed — lexical format is load-bearing (6 tests: the ISO-vs-space collision asserted directly on two literal constants, the correct-format sibling case, the >1970 default comparison, the real-LocalStore round trip, single-row idempotency, and the toISOString-absence source scan)"
        status: pass
    human_judgment: false
  - id: D2
    description: "The pre-cutover CREATE TABLE definition and grant baseline for photobooth.registrations are captured to a version-controlled file before any DROP is proposed, refusing to proceed if the object is not still a BASE TABLE."
    verification:
      - kind: integration
        ref: "src/ops/captureRegistrationsRollback.ts (run manually against live MySQL, read-only; not a CI test — no photobooth fixture exists to run it against in CI)"
        status: pass
    human_judgment: true
    rationale: "The capture is a live-data measurement taken once during this plan's execution (CURRENT_USER, TABLE_TYPE, the exact CREATE TABLE text, the exact grant baseline) rather than a repeatable CI assertion — a human should confirm the resolved account name and captured grants below before plan 06-05 relies on them."
  - id: D3
    description: "The cutover script a human will run is generated from the same module the tracer proved (character-identical CREATE VIEW statements, verified by extraction+diff), includes a pre-flight zero-row/BASE-TABLE guard, and includes a deliberate write-refusal check answering ROADMAP success criterion 5."
    verification:
      - kind: unit
        ref: "test/registrations-view-sql.test.ts (unchanged — confirms the emitted DDL 06-cutover.sql embeds has not drifted from the module)"
        status: pass
      - kind: other
        ref: "one-time extraction+diff script (this session) confirming the two CREATE OR REPLACE VIEW statements in docs/migrations/06-cutover.sql are character-identical to docs/migrations/06-registrations-view.sql's generated output"
        status: pass
    human_judgment: true
    rationale: "docs/migrations/06-cutover.sql is never executed by this plan or by CI — it is the script a human runs at plan 06-05's blocking checkpoint:decision. Its correctness rests on this plan's authoring-time proofs plus a human's review before execution, not an automated gate."

duration: 20min
completed: 2026-08-11
status: complete
---

# Phase 6 Plan 04: Cutover Preparation — Cursor Seed, Rollback Capture, Cutover Script Summary

**A D-06 cursor seed that reads MySQL's own clock in the VIEW's lexical format (never `toISOString()`), a live-captured rollback artefact for the pre-cutover `BASE TABLE`, and an 8-section `docs/migrations/06-cutover.sql` whose two `CREATE VIEW` statements are proven character-identical to plan 06-01's generated DDL — everything plan 06-05's blocking checkpoint needs, with nothing executed against MySQL beyond `SELECT`/`SHOW`.**

## Performance

- **Duration:** ~20 min
- **Tasks:** 3/3 completed
- **Files modified:** 5 (4 created, 1 modified)
- **Commits:** 3 task commits

## Accomplishments

- `src/ops/seedRegistrationsCursor.ts`'s `seedRegistrationsCursor()` is D-06's whole implementation: it issues exactly one MySQL statement (`SELECT DATE_FORMAT(NOW(6), '%Y-%m-%d %H:%i:%s.%f') AS now_lexical` — no `FROM` clause), asserts the returned value is a string matching `REGISTERED_AT_LEXICAL_PATTERN`, refuses to overwrite an already-seeded non-default cursor without `--force`, and writes/round-trips through `LocalStore.setCursor()`/`getCursor()` — the exact same public method `dbPoller.ts` and every other write path already use. No `new Date().toISOString()` call exists anywhere on the path that can produce the seed value, asserted in the suite by reading the function's own `toString()` output.
- The ISO-vs-space lexical collision — `'2026-08-11 14:00:01.000000' > '2026-08-11T14:00:00.000Z'` is `FALSE` — is independently re-verified live with `node -e` before implementation (see Measured Numbers) and pinned as a named, self-explaining test alongside its correct-format sibling.
- `src/ops/captureRegistrationsRollback.ts` issues exactly four read-only statements (`SELECT CURRENT_USER()`, an `information_schema.TABLES` `TABLE_TYPE` check, `SHOW CREATE TABLE`, `SHOW GRANTS FOR CURRENT_USER()`), refuses to proceed if `TABLE_TYPE` is not `BASE TABLE`, and writes the committed canonical artefact plus a gitignored mirror under `data/backups/`, matching this project's existing backup-before-mutation convention.
- `docs/migrations/06-cutover.sql`'s two `CREATE OR REPLACE VIEW` statements are copied from `docs/migrations/06-registrations-view.sql` (itself regenerated this session via `npx ts-node src/ops/verifyRegistrationsView.ts --emit-sql`, confirmed byte-unchanged) and proven character-identical by a comment-stripped extraction+diff, not merely eyeballed.
- The GRANT step (section 4) is annotated with the live-measured finding that it is already redundant on this server (existing `GRANT SELECT ON photobooth.* TO extension_service_ro` is schema-wide) and left commented, following Pitfall 4's own rule to skip rather than widen privileges by reflex — while remaining present, uncommented-to, for an environment where the baseline differs.
- The write-refusal check (section 6) states the correct expected error for THIS grant shape — MySQL 1142 (`INSERT command denied`), fired on privilege before the VIEW's own non-insertable structure is ever reached — with 1471 documented as the second, independent line of defense.
- `dbPoller.ts` and `localStore.ts` remain byte-identical to baseline `9699374` (D-02); `git diff --name-only 3b509cb..HEAD` lists exactly the 5 files this plan's frontmatter declared, no more, no fewer; no new dependency.

## Task Commits

Each task was committed atomically in `mirror-request`:

1. **Task 1: The cursor seed, in the VIEW's own lexical format, from the server's own clock** — `b991258` (feat)
2. **Task 2: Capture the pre-phase state — CREATE TABLE and grants — into version control** — `38f4b94` (feat)
3. **Task 3: Generate the exact cutover script a human will run** — `4fa9e58` (feat)

_Note: Task 1 carries `tdd="true"`. It genuinely went RED-equivalent at the point of authoring: the six new test cases exercise behavior (`seedRegistrationsCursor`'s toString(), `REGISTERED_AT_LEXICAL_PATTERN`, the round trip) that did not exist before this task's implementation landed — but the module and its tests were written and committed together in one commit rather than as a separate RED/GREEN pair, since the string-comparison assertions needed neither a mock nor a live MySQL connection to prove and there was no meaningful intermediate "RED" state to commit. Non-vacuousness is structural: the collision assertions compare two hardcoded literal constants directly (no code path to mutate), and the toString() scan would fail immediately if `toISOString` were reintroduced._

## Files Created/Modified

- `mirror-request/src/ops/seedRegistrationsCursor.ts` — `seedRegistrationsCursor()`, `main()`, `MYSQL_NOW_LEXICAL_SQL`, `REGISTERED_AT_LEXICAL_PATTERN` (Task 1, new file).
- `mirror-request/src/ops/captureRegistrationsRollback.ts` — `captureRegistrationsRollback()`, `main()`, `CANONICAL_OUTPUT_PATH` (Task 2, new file).
- `mirror-request/docs/migrations/06-rollback-registrations-table.sql` — committed, live-captured restore script (Task 2, generated).
- `mirror-request/docs/migrations/06-cutover.sql` — committed, 8-section ordered cutover script (Task 3, new file).
- `mirror-request/test/local-store-persistence.test.ts` — new `describe('D-06 registrations cursor seed — lexical format is load-bearing')` block, 6 tests (Task 1).

## Measured Numbers

- **The collision, re-verified live before implementation** (`node -e`, this session): `'2026-08-11 14:00:01.000000' > '2026-08-11T14:00:00.000Z'` → `false`; `'2026-08-11 14:00:01.000000' < '2026-08-11T14:00:00.000Z'` → `true`. Confirms the plan's premise exactly: an ISO-shaped seed sorts *above* a same-day VIEW-format timestamp, so the row would never satisfy `registered_at > cursor` and would be silently skipped for the rest of that calendar day.
- **Resolved `CURRENT_USER()`** (live, plan 06-04 Task 2): `extension_service_ro@%` — matches `config.ts`'s `extension_service_ro` default exactly (measured, not assumed).
- **Observed `TABLE_TYPE`**: `BASE TABLE`.
- **Observed row count**: not separately queried by Task 2 (Task 2's `<verify>` doesn't call for it), but Task 3's pre-flight section embeds `SELECT COUNT(*) FROM photobooth.registrations` to be re-checked at execution time; 06-01/06-02/STATE.md's independent prior measurement (2026-08-11, same day) recorded 0 rows.
- **Existing grants, captured verbatim**:
  ```
  GRANT USAGE ON *.* TO `extension_service_ro`@`%`
  GRANT SELECT ON `photobooth`.* TO `extension_service_ro`@`%`
  ```
  The second grant is schema-wide (`photobooth`.*) and **already covers** both `photobooth.registrations` and `photobooth.registrations_name_audit` the moment plan 06-05's `CREATE VIEW` statements run — no new `GRANT` is needed on this server. Recorded as an annotated, commented-out statement in `06-cutover.sql` section 4 rather than deleted, in case a different environment's baseline differs.
- **CREATE VIEW statement identity**: extraction+diff (comment-stripped regex match on `CREATE OR REPLACE...WHERE d.rn = 1;`) confirms both statements in `06-cutover.sql` are character-identical (1627 and 1619 characters respectively) to `06-registrations-view.sql`'s generated output.
- `cd mirror-request && npm test`: **33 files / 299 tests** green (baseline at plan start, confirmed live: 33/293). +6 tests, all in `test/local-store-persistence.test.ts` — counted by `grep -c '  it('` against both `git show 3b509cb:test/local-store-persistence.test.ts` (15) and the file on disk after this plan (21), and cross-checked against vitest's own reported count for the file (21), not by eyeballing the diff.
- `npm run typecheck` / `npm run build`: both exit 0, checked after every task.
- `git diff --quiet 9699374 -- src/ingestion/dbPoller.ts src/state/localStore.ts`: exits 0 (D-02 holds).
- `git diff --name-only 3b509cb..HEAD`: exactly the 5 files this plan's frontmatter declared.
- No new entry in `package.json` `dependencies` or `devDependencies`.
- No password appears in any committed file — confirmed by grepping the committed `.sql`/`.ts` files for the live `DB_PASSWORD` value's exact string; not found.
- `/opt/web-ticket/qrcode/` unmodified: `git -C /opt/web-ticket status` fails as expected (not a git repo); no writes attempted there.
- `mirror-request/.planning/` (the stale, git-tracked tree) untouched: `find` for files newer than the branch ref returned none.
- No `INSERT`/`UPDATE`/`DELETE`/DDL statement was **executed** against any database at any point in this plan — every live MySQL call across all three tasks was `SELECT`, `SHOW CREATE TABLE`, `SHOW GRANTS`, or `information_schema` reads. `docs/migrations/06-cutover.sql` itself was **generated and written to disk only**; it was never run.

## Decisions Made

- The seed's runtime-type/format assertion is a hard `throw`, never a silent fallback to `toISOString()` — the exact anti-pattern the plan's `<the_cursor_format_finding>` names.
- `--force` gates re-seeding a non-default cursor, printing what is already there — protects a live deployment from an accidental re-run silently skipping guests.
- The GRANT step is left as a commented, annotated statement rather than deleted — Pitfall 4's "skip rather than widen by reflex" rule is satisfied by the measured live baseline, but the statement itself stays available for an environment whose baseline differs.
- The write-refusal check's stated expected error is 1142 (privilege denial), not 1471 (structural non-updatability) — because privilege is checked first under this account's actual GRANT shape; 1471 is documented as the second-line defense in case that ever changes.

## Deviations from Plan

### Auto-fixed Issues

None — no bugs, missing functionality, or blocking issues required a Rule 1/2/3 auto-fix. The plan's script skeletons, SQL text, and file layout all matched what the live database returned on first execution.

**Total deviations:** 0 auto-fixed.
**Impact on plan:** None — plan executed exactly as written.

## Known Stubs

None. All three artifacts (`seedRegistrationsCursor.ts`, `captureRegistrationsRollback.ts`, `06-cutover.sql`) are real, runnable, read-only-until-invoked implementations — no hardcoded empty values, no placeholder text, no unwired data source.

## Flagged Assumption Carried Forward (ING-03 `unclassified`)

Per `06-04-PLAN.md`'s `<flagged_assumptions>`: the spec-less edge probe's fourth item — ING-03, category `unclassified`, probe text "unclassified — review manually" — is **not resolved by this plan** and is **not silently dropped**. It stays `unresolved`, carried forward for a human to confirm at the phase gate (plan 06-06), per the plan's own instruction. The reviewable content behind it (a cursor whose *format* is valid but incomparable with the source's) is the exact hazard this plan's `<the_cursor_format_finding>` closes with the `DATE_FORMAT(NOW(6), ...)` seed and its named collision test — but the probe row itself is a human confirmation item, not something this plan is authorized to check off.

Count check, restated from the plan: 4 probe items surfaced → 3 authored into `must_haves` (plan 06-01) + 1 surfaced here as a flagged assumption = 4. Nothing dropped.

## Issues Encountered

None.

## User Setup Required

None — no external service configuration required. This plan reused the existing `mirror-request/.env` `DB_*` credentials read-only; no new environment variable or dashboard step is introduced.

## Next Phase Readiness

- **For plan 06-05 (the live DDL cutover, blocking `checkpoint:decision`):** `docs/migrations/06-cutover.sql` is complete, committed, and ready to paste — all 8 sections in order, the DROP pointing at the committed rollback artefact by name, both `CREATE VIEW` statements proven character-identical to the module plan 06-01 verified end-to-end, the GRANT step correctly annotated as already-redundant-on-this-server, and the write-refusal check naming the exact expected MySQL error for this account's actual grant shape.
- **The cursor seed is ready to run, but is NOT wired into the process's own startup path** — by design (D-06's constraint: `DBPoller` is constructed unconditionally at `index.ts:52` with no enable flag, so seeding must happen as a discrete pre-flight step run by a human or deploy script *before* the process (re)starts against a live VIEW, not from inside `index.ts`). Plan 06-05 or the deploy runbook should invoke `npx ts-node src/ops/seedRegistrationsCursor.ts` (or the built `dist/` equivalent) as an explicit step immediately after the cutover DDL succeeds and before the service is (re)started.
- **The rollback artefact is stale the moment the VIEW is created** — `docs/migrations/06-rollback-registrations-table.sql` captures the table's state as of this plan's execution (2026-08-11); if any schema drift occurs on `photobooth.registrations` between now and plan 06-05's actual cutover, Task 2's capture script should be re-run immediately before the DROP, not trusted from this plan's timestamp.
- No blockers.

## Self-Check: PASSED

All 4 created files and 1 modified file confirmed present on disk with expected content; all 3 task commit hashes (`b991258`, `38f4b94`, `4fa9e58`) confirmed present in `git log --oneline --all`.

---
*Phase: 06-ingestion-cutover*
*Completed: 2026-08-11*
