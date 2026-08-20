---
phase: 06-ingestion-cutover
plan: 05
subsystem: database
tags: [mysql, mysql-view, cutover, ddl, cursor-seed, service-lifecycle]

# Dependency graph
requires:
  - phase: 06-ingestion-cutover
    provides: "docs/migrations/06-cutover.sql (plan 06-04) — the exact 8-section script the human ran; seedRegistrationsCursor()/main() (plan 06-04) — D-06's cursor seed, invoked from dist/ this plan"
provides:
  - "photobooth.registrations and photobooth.registrations_name_audit are live VIEWs over ets_web, read successfully by the service account, structurally and privilege-refused on write"
  - "db_poll_cursor 'registrations' seeded to 2026-08-12 01:53:57.234379, strictly past every historical registered_at — the state plan 06-06's live-registration proof will run against"
  - "the section-3 non-ASCII paste-encoding incident and its runbook lesson ('pipe the file, never paste it'), owed to 06-06 Task 1's OPS-RUNBOOK §10"
affects: [06-06]

actuals:
  tokens: 21000
  tasks: 2
  commits: 1

tech-stack:
  added: []
  patterns:
    - "Non-ASCII DDL literals must be applied by piping the file into mysql (`mysql < file.sql`), never by interactive terminal paste — a terminal/SSH re-encoding step corrupted a UTF-8 literal invisibly to the server, caught only by a HEX() check on the stored VIEW_DEFINITION, not by eyeballing the echoed output."
    - "A verification harness written for two source modes ('inline' vs a live VIEW) must gate every one of its control queries by source, not just the ones its author remembered to gate — an ungated ets_web-direct control query crashed the harness's one job (proving the service account, which by design cannot read ets_web directly, can read the VIEW)."

key-files:
  created: []
  modified:
    - mirror-request/docs/migrations/06-cutover.sql
    - mirror-request/src/ops/verifyRegistrationsView.ts

key-decisions:
  - "Task 1's blocking checkpoint:decision was resolved by explicit human decision, not self-approved — option i-ran-it: the human ran the destructive DDL themselves in an admin MySQL session rather than hand database-admin credentials to an agent, matching this project's unbroken precedent (every phase gate since Phase 1 has been answered by a human)."
  - "Task 2 was narrowed from 'apply + verify' to 'verify only' — the DDL was already applied by the human at the Task 1 checkpoint before this executor was ever dispatched. Running any part of section 2's DROP or re-running section 3's CREATE would have been either destructive-redundant or a re-run of already-completed, irreversible history. Verification proceeded exactly as planned, through the service account's own credentials."
  - "Task 3 started the service in non-production mode (NODE_ENV unset), not production — the OPS-RUNBOOK §4 readiness check fails today (WEBHOOK_HMAC_SECRET, PROXY_IP_WHITELIST, DISPLAY_IP_WHITELIST all unset in .env), and inventing values for three production security controls is outside this plan's scope and this executor's authority. Recorded honestly rather than worked around."
  - "The service was left stopped after Task 3's proof, matching this project's unbroken precedent (02-04, 04-04) of returning the service to a stopped state after a verification run, given production secrets remain unset and the Phase 3 Agent-auth cutover is still undeployed."

requirements-completed: []

coverage:
  - id: D1
    description: "The service's DB credentials (extension_service_ro) can read photobooth.registrations and photobooth.registrations_name_audit and cannot write to either — proved by a deliberate INSERT that is refused by privilege (ERROR 1142), independently of the VIEW's own structural non-updatability (ERROR 1471, proved by the admin account)."
    requirement: "M6-5"
    verification:
      - kind: integration
        ref: "live INSERT attempt as extension_service_ro against photobooth.registrations, 2026-08-12"
        status: pass
    human_judgment: false
  - id: D2
    description: "photobooth.registrations is a VIEW returning the six columns dbPoller.ts:101 selects, readable by the service account, registered_at rendering as a 26-character fixed-width string — verified through the service account, not the admin account that ran the DDL."
    requirement: "M6-1"
    verification:
      - kind: integration
        ref: "src/ops/verifyRegistrationsView.ts --source=view, run with extension_service_ro credentials — ALL 9 CHECKS PASSED"
        status: pass
    human_judgment: false
  - id: D3
    description: "At the moment the service starts, the 'registrations' cursor is the seeded cutover timestamp, so none of the nine historical valid rows is dispatched."
    requirement: "M6-4"
    verification:
      - kind: integration
        ref: "queue_job count measured before service start (1) and again ~2m38s after start (1, unchanged); db_poll_cursor unchanged from the seeded value across the same window; no 'DB poller ingested' or 'DB poller cycle failed' log line appeared"
        status: pass
    human_judgment: false
  - id: D4
    description: "SHOW GRANTS for the service account, diffed against the plan 06-04 baseline, shows no write privilege added anywhere."
    requirement: "M6-5"
    verification:
      - kind: integration
        ref: "SHOW GRANTS FOR CURRENT_USER() as extension_service_ro, 2026-08-12 — byte-identical to the 06-04 baseline (GRANT USAGE ON *.*, GRANT SELECT ON photobooth.*)"
        status: pass
    human_judgment: false

duration: 45min
completed: 2026-08-12
status: complete
---

# Phase 6 Plan 05: Live Cutover — Human-Applied DDL, Service-Account Verification, Cursor Seed Summary

**The cutover to a live MySQL VIEW was applied by the human operator at Task 1's blocking checkpoint, not by this executor — this plan's own work is Task 2's full re-verification through the service account (all 9 checks pass, both write-refusal errors quoted, one real harness bug found and fixed) and Task 3's proof that the seeded cursor kept all 9 historical registrations from being dispatched when the service started for the first time against live data.**

## Performance

- **Duration:** ~45 min
- **Tasks:** 2/3 (Task 1's checkpoint pre-resolved by the human before this executor was dispatched; Task 2 and Task 3 executed here)
- **Files modified:** 2
- **Commits:** 1 task commit (Task 3 produced no source-file change — see below)

## Task 1: Checkpoint Resolution (pre-resolved, recorded here)

**Not self-approved.** `workflow._auto_chain_active` is `false`, `workflow.auto_advance` is unset — this project's precedent (Phase 1 Task 3, plan 02-04 Task 3, plan 03-01 Task 1, plan 03-05 Task 2, plan 04-04 Task 3, plan 05-01 Task 1, plan 05-05 Task 3, and this phase's own 06-01 tracer gate) held again.

**Chosen option: `i-ran-it`** — "The human applies it; the executor verifies only." The human ran the destructive DDL themselves, in an admin MySQL session, rather than delegate database-admin credentials to an agent. Sections 1, 5 and 6 (read-only, and the deliberate write-refusal check) were re-run afterward by this executor through the service account's own credentials — the account that actually matters, since it is the account `dbPoller.ts` uses.

## Task 2: Verify the Applied Cutover Through the Service Account

**Narrowed from the plan's literal "apply + verify" wording to "verify only"** — the DDL was already applied by the human at the Task 1 checkpoint before this executor was dispatched. `photobooth.registrations` and `photobooth.registrations_name_audit` were already `VIEW`s when this task began. This is a deviation from the plan text, not from its intent: the plan's `<action>` block itself instructs, for the `i-ran-it` branch, "execute only the read-only sections (1, 5, 6) and reconcile what they report against what the human said they ran" — which is exactly what this task did.

### The encoding incident (found by the human, verified and recorded by this executor)

The interactive terminal paste of the two `CREATE OR REPLACE VIEW` statements (from `06-cutover.sql` into a `mysql>` prompt) double-encoded the one non-ASCII literal in the DDL — D-04's last-resort label `'Khách • '` — storing `'KhÃ¡ch â€¢ '` on the server instead. Confirmed by measurement, not assumed from the mangled terminal echo:

```sql
SELECT HEX(SUBSTRING(VIEW_DEFINITION, LOCATE('Kh', VIEW_DEFINITION), 6))
FROM information_schema.VIEWS WHERE TABLE_SCHEMA='photobooth' AND TABLE_NAME='registrations';
```
→ `4B68C383C2A16368` (`KhÃ¡ch`), not the correct `4B68C3A16368` (`Khách`).

Root cause ruled out at the server: `character_set_client/connection/database/results/server` all `utf8mb4`; a piped round-trip test (`printf ... | mysql`) was byte-exact even without `--default-character-set`. The corruption lived entirely in the interactive paste path. **Fixed** by re-running only the two `CREATE OR REPLACE VIEW` statements via `mysql < docs/migrations/06-registrations-view.sql` (piping, not pasting) — that file carries no `DROP`/`GRANT`, so nothing destructive or data-bearing was at risk. Post-fix `HEX()` check confirmed `4B68C3A16368 20` (`Khách `), correct; all 9 rows, both views, the grant state and the 1142 write-refusal were re-verified unchanged afterward.

**Runbook lesson, owed to 06-06 Task 1's OPS-RUNBOOK §10:** "copy the statements verbatim" defends against transcription error but not against encoding corruption — copy-paste through a terminal is itself a lossy channel for non-ASCII bytes. The correct instruction is **pipe the file into `mysql`** (`mysql < path/to/file.sql`), never "copy the statements," and any DDL with a non-ASCII literal must be verified afterward with a `HEX()` check on the stored definition.

### A real bug found and fixed (Rule 1) — `verifyRegistrationsView.ts`'s `--source=view` mode was unrunnable by the account it exists to verify

Check 5 (`order-tie-dissolution`) unconditionally ran `ORDER_TIE_CONTROL_SQL`, which queries `ets_web.ticketing_ticket` and its joins **directly**, regardless of the `--source` flag. But under `SQL SECURITY DEFINER`, the service account deliberately holds **no** grant on any `ets_web` table — that is the whole point of the DEFINER design. Running `--source=view` (Task 2's own required check) crashed immediately: `ER_TABLEACCESS_DENIED_ERROR: SELECT command denied to user 'extension_service_ro'@'localhost' for table 'ticketing_ticket'`.

**Fix:** gated check 5 by `source === 'inline'`, the same way check 3's `DEDUP_CONTROL_SQL` already was — under `--source=view` it now records a named skip ("service account has no ets_web grant by design; dissolution was already proven inline in plan 06-01") instead of crashing. This is a Rule 1 bug fix directly caused by, and blocking, this task's own required verification path — not an out-of-scope discovery.

### Measured results (all through `extension_service_ro`, the service account — not the admin account that ran sections 2-4)

- `information_schema.TABLES`: `TABLE_TYPE = 'VIEW'` for both `photobooth.registrations` and `photobooth.registrations_name_audit`.
- `src/ops/verifyRegistrationsView.ts --source=view`: **ALL 9 CHECKS PASSED**, 9 rows — column-key-set, registered_at string format, dedup (9==9), non-empty-name, order-tie-dissolution (skipped, gated), advisory cross-ticket distinctness (9 distinct/9), lexical-order-is-chronological, name_source-distribution, sqlite-bind-proof (9 written, 9 enqueued, cursor round-tripped, all names non-empty).
- `SELECT COUNT(*), COUNT(DISTINCT id), COUNT(DISTINCT registered_at) FROM photobooth.registrations` → **9 / 9 / 9**. D-03's dedup holds; the `ordering` backstop's residual is currently zero.
- First row (`registered_at` ASC): `QFAP2ABS | anh.nd3 | print | 2026-07-27 07:51:19.250214`. Last row: `XACX2T63 | NetNamTest | print | 2026-08-07 15:38:49.220951`. `registered_at` confirmed rendering as the fixed-width space-separated string.
- `SELECT name_source, COUNT(*) FROM photobooth.registrations_name_audit GROUP BY name_source` → `customer_username=4, personalinfo_display_name=4, personalinfo_name=1`. Total 9, matching the ingestion VIEW exactly. `synthetic=0` — D-04's last-resort label has never had to fire on live data.
- `SHOW GRANTS FOR CURRENT_USER()` → `GRANT USAGE ON *.*`, `GRANT SELECT ON photobooth.*` — **byte-identical to the plan 06-04 baseline**. Nothing was added: section 4's `GRANT` was run anyway by the human (branch taken: issued, not skipped) despite the script correctly advising it was redundant on this server; confirmed harmless and idempotent by this identical diff.
- Write-refusal, both lines of defence proven independently:
  - **Service account** (`extension_service_ro`): `ERROR 1142 (42000): INSERT command denied to user 'extension_service_ro'@'localhost' for table 'registrations'` — the privilege refusal, fires before structure is reached. This is the positive proof for ROADMAP success criterion 4/5, and needed the service account specifically.
  - **Admin account** (run by the human, 2026-08-11/12): `ERROR 1471 (HY000): The target table registrations of the INSERT is not insertable-into` — the structural refusal (JOIN + window function make the VIEW non-updatable). A different, also-true proof.
- **Section 7's fallback was not needed.** RESEARCH.md could not confirm whether a DEFINER account scoped to `ets_web` could back a VIEW living in `photobooth`; now confirmed empirically that it can — `extension_service_ro` reads both views correctly through `DEFINER = 'ets_web'@'127.0.0.1'` with `SQL SECURITY DEFINER`, holding no `ets_web` grant of its own.

`docs/migrations/06-cutover.sql` was annotated in place with the observed result of every numbered section (pre-flight, DROP, the two CREATE VIEWs plus the encoding incident, GRANT, post-checks, write-refusal, the now-closed fallback question, and rollback's non-invocation) — no statement text was altered.

## Task 3: Seed the Cursor, Start the Service, Confirm No Historical Dispatch

**Precondition confirmed:** the service was genuinely stopped before this task began — no `node dist/index.js` process, empty `pm2 list`, port 3002 not listening. (An earlier `pgrep -f 'dist/index.js'` check returned a false positive — the harness's own wrapping shell command happened to contain that literal search string in its own command-line text, and `pgrep -f` matched itself; the follow-up `ps aux`/`pm2 list`/port checks confirmed the service was genuinely not running.)

- `npm run build` — exit 0.
- OPS-RUNBOOK §4 production-readiness check (`NODE_ENV=production node -e "require('./dist/config').loadConfig()"`) — **exit 1, as predicted going into this task.** All three required production variables are unset in `.env`: `WEBHOOK_HMAC_SECRET`, `PROXY_IP_WHITELIST`, `DISPLAY_IP_WHITELIST`. This is an honest, recorded gap, not a Rule 1-3 auto-fix — inventing values for three production security controls (an HMAC secret, a reverse-proxy IP allow-list, a display-machine IP allow-list) is outside this plan's authority and its `files_modified` scope. **The service was started in the only mode actually available: `NODE_ENV` unset (development).** `NODE_ENV` was not set to anything that would hide this gap.
- `MAX(registered_at)` from the live VIEW (service account): `2026-08-07 15:38:49.220951`.
- Cursor seed run (`node dist/ops/seedRegistrationsCursor.js`, service `.env` credentials via `dotenv/config`, no CLI-embedded secret): previous cursor `(unset)` → seeded `2026-08-12 01:53:57.234379`. Matches `^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}$`. Read back via `getCursor('registrations')`: identical to the written value. Explicit string comparison: `'2026-08-12 01:53:57.234379' > '2026-08-07 15:38:49.220951'` → **true**.
- `queue_job` count immediately before service start: **1**. Service started (`node dist/index.js`, background, `NODE_ENV` unset).
- Log line, quoted verbatim: `DB poller connected: localhost:3306/photobooth`. Also present: `Extension Service ready on 0.0.0.0:3002`, `Recovery complete: booth was IDLE, swept 0 in-flight job(s)`, `AgentServer started at /agent`, and one `warn` (`Webhook signature verification disabled: no HMAC secret configured` — expected, non-production mode).
- Observation window: **2026-08-12T01:54:24Z to 2026-08-12T01:57:06Z** (~2m42s, exceeding the required 2-minute window), confirmed by two independent measurements (a direct query at ~2m22s and a separately-scheduled background check at ~2m38s, both agreeing).
- **No `DB poller cycle failed` line appeared. No `DB poller ingested` line appeared for any of the 9 historical ticket codes** (`QFAP2ABS`, `HZ845N34`, `4Z1WTM62`, `MT82S4MD`, `A523ZC1W`, `WHD4Q2C0`, `9R1XX5RH`, `FC8PX5JQ`, `XACX2T63`).
- `queue_job` count at end of window: **1 — unchanged.** `db_poll_cursor` also unchanged from the seeded value across the same window (no historical row ever crossed the `> cursor` filter). This before/after pair, not the absence of a log line, is the evidence for criterion 4.
- D-09's health probe (`VIEW_PROBE_INTERVAL_MS` default 60000ms — at least 2 cycles ran in the window): **logged nothing and dispatched no alert** — exactly the designed behavior of a healthy cycle (`total === distinct_registered_at`, 9 === 9), per `viewHealthProbe.ts`'s explicit "healthy cycle: log nothing" comment. This is silence-by-design, not an unobserved gap.
- **The Phase 3 Agent-auth cutover has never been deployed and no Agent was connected during this window** — the booth held `IDLE` throughout and dispatched nothing to any Agent. This is sufficient for, and exactly matches, Task 3's purpose (proving no historical row is dispatched); it proves nothing about the booth leg, and this SUMMARY makes no claim that it does.
- **Service left stopped** after the proof completed — matching this project's precedent (02-04, 04-04) of returning the service to a stopped state after a verification run, given production secrets remain unset and the Agent-auth cutover is undeployed. Final state confirmed: no process, port 3002 not listening, graceful shutdown log line (`Shutting down`) observed.
- **No source file was changed by Task 3** — it is build + operational verification only. `git status --short` in `mirror-request/` is clean after this task (the `dist/`, `logs/`, and `data/*.sqlite*` artifacts it touched are all gitignored).

## Task Commits

Each task was committed atomically in `mirror-request` (Task 1's DDL apply happened outside this executor's session, in the human's admin MySQL client — there is no git commit for it, matching every prior plan's precedent that live DDL against MySQL is server state, not repository state):

1. **Task 2: Verify the applied cutover through the service account** — `8307013` (fix) — annotates `docs/migrations/06-cutover.sql` with every section's observed result; fixes the `--source=view` order-tie-dissolution crash in `verifyRegistrationsView.ts`.
2. **Task 3: Seed the cursor, start the service, confirm no historical dispatch** — no commit (no source file changed; build artifacts and SQLite state are gitignored).

## Files Created/Modified

- `mirror-request/docs/migrations/06-cutover.sql` — annotated in place with the observed result of every numbered section; no statement text altered (Task 2).
- `mirror-request/src/ops/verifyRegistrationsView.ts` — check 5 (`order-tie-dissolution`) gated by `source === 'inline'`, matching check 3's existing gating; `--source=view` now records a named skip instead of crashing (Task 2).

## Measured Numbers

- `photobooth.registrations` / `photobooth.registrations_name_audit`: both `TABLE_TYPE = 'VIEW'`.
- `verifyRegistrationsView.ts --source=view`: **ALL 9 CHECKS PASSED**, 9 rows.
- `SELECT COUNT(*), COUNT(DISTINCT id), COUNT(DISTINCT registered_at)`: **9 / 9 / 9**.
- `registrations_name_audit` distribution: `customer_username=4, personalinfo_display_name=4, personalinfo_name=1` (total 9, `synthetic=0`).
- `SHOW GRANTS FOR CURRENT_USER()` (service account): `GRANT USAGE ON *.*`, `GRANT SELECT ON photobooth.*` — identical to the 06-04 baseline.
- Write-refusal: `ERROR 1142` (service account, privilege) and `ERROR 1471` (admin account, structure) — both independently confirmed.
- Cursor seed: `2026-08-12 01:53:57.234379`, strictly `>` `MAX(registered_at) = 2026-08-07 15:38:49.220951`.
- `queue_job` count: **1 before, 1 after** the ~2m42s observation window.
- `cd mirror-request && npm test`: **34 files / 315 tests** green (unchanged from baseline — Task 2's fix touched only ops-harness code with no dedicated test file exercising the fixed branch, and no test asserted the old, broken behavior). `npm run typecheck` clean. `npm run build` clean.
- `git diff --quiet 9699374 -- src/ingestion/dbPoller.ts`: exits 0 (D-02 holds).
- `git status --short` in `mirror-request/`: clean after both tasks.
- No new npm dependency.
- No password appears in any committed file or in this SUMMARY — the service account credentials were passed to every script via `dotenv/config` (reading `.env` in-process) or a throwaway inline `node -e` script reading `process.env`, never as a literal on a command line or in a log.

## Decisions Made

- Task 1: `i-ran-it` — the human applies the DDL, the executor verifies only. Not self-approved.
- Task 2: narrowed from "apply + verify" to "verify only," since the DDL was already applied at the Task 1 checkpoint — documented as a deviation from the plan's literal wording, not from its intent (the plan's own `i-ran-it` branch anticipates exactly this).
- Task 2: the section-4 GRANT was run anyway by the human despite being measured-redundant; confirmed harmless via an identical post-cutover grant diff.
- Task 2: fixed `verifyRegistrationsView.ts`'s `--source=view` crash (Rule 1) by gating check 5 the same way check 3 already was.
- Task 3: started the service in non-production mode (`NODE_ENV` unset) rather than fabricate production secrets or silently set `NODE_ENV` to something that would hide the readiness-check failure.
- Task 3: left the service stopped after the proof, per this project's unbroken precedent.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `verifyRegistrationsView.ts`'s `--source=view` mode crashed on its own required check**
- **Found during:** Task 2, running the plan's own mandated `verifyRegistrationsView.ts --source=view` command against the live VIEW as the service account.
- **Issue:** Check 5 (`order-tie-dissolution`) unconditionally queried `ORDER_TIE_CONTROL_SQL`, which reads `ets_web` tables directly, regardless of the `source` flag. The service account has zero `ets_web` grant by design (`SQL SECURITY DEFINER`), so `--source=view` failed with `ER_TABLEACCESS_DENIED_ERROR` before any of the 9 checks could complete.
- **Fix:** gated check 5 by `source === 'inline'`, matching check 3's existing `DEDUP_CONTROL_SQL` gate; `--source=view` now records a named, honest skip instead of crashing.
- **Files modified:** `mirror-request/src/ops/verifyRegistrationsView.ts`
- **Commit:** `8307013`

**2. [Deviation, not a bug — recorded per instruction] Task 2's scope narrowed from "apply + verify" to "verify only"**
- **Found during:** Task 2 start.
- **Reason:** the DDL had already been applied by the human operator at the Task 1 checkpoint, before this executor was dispatched (see `<STOP_READ_THIS_FIRST>` in this plan's dispatch prompt). `photobooth.registrations` was already a VIEW.
- **Action taken:** verification only, exactly as the plan's own `i-ran-it` action branch specifies ("execute only the read-only sections (1, 5, 6) and reconcile what they report against what the human said they ran").
- **Files modified:** none beyond the annotation and the bug fix above.

**Total deviations:** 1 auto-fixed bug, 1 scope-narrowing deviation (both documented, neither hidden).
**Impact on plan:** None on the outcome — every acceptance criterion Task 2 and Task 3 specify is met, with real measured numbers, not assumed ones.

## Known Stubs

None. Every artifact touched in this plan (`06-cutover.sql`'s annotations, `verifyRegistrationsView.ts`'s fix) is real and load-bearing — no placeholder text, no hardcoded empty value, no unwired data source.

## Threat Flags

None. This plan touched no new surface beyond what `06-CONTEXT.md`'s and `06-05-PLAN.md`'s threat models already named — the DDL apply (T-06-14), the grant/write-refusal proof (T-06-04), and the cursor seed (T-06-13) were all executed and verified as those entries anticipated.

## Issues Encountered

- The false-positive `pgrep -f 'dist/index.js'` self-match, described above under Task 3 — resolved by cross-checking with `ps aux`, `pm2 list`, and a port check, all of which agreed the service was genuinely stopped before seeding began.
- The `npx ts-node src/ops/seedRegistrationsCursor.ts` invocation failed with `ERR_MODULE_NOT_FOUND` on the script's own dynamic `import('../state/localStore.js')` inside `main()` — a ts-node/CommonJS module-resolution quirk unrelated to this plan's code. Worked around by running the already-built `dist/ops/seedRegistrationsCursor.js` directly via `node -r dotenv/config` instead (the same artifact `npm run build`, already run earlier in this task, produces) — no source change, no workaround baked into a committed file.

## User Setup Required

**Before a real production deploy** (not required for this plan, but carried forward honestly): `WEBHOOK_HMAC_SECRET`, `PROXY_IP_WHITELIST`, and `DISPLAY_IP_WHITELIST` must all be set to real values in `.env` — OPS-RUNBOOK §4's readiness check fails today, and the service was run in this plan's Task 3 in non-production mode specifically because of this gap. This is the same class of pre-existing, explicitly-tracked gap OPS-RUNBOOK §9 already carries for `NOTIFY_WEBHOOK_URL` reachability and the undeployed Phase 3 Agent-auth cutover — never silently closed, and not newly introduced by this plan.

## Next Phase Readiness

- **For plan 06-06 (the phase gate, D-07's live end-to-end proof):** the VIEW is live and proven readable/write-refused through the service account; the cursor is seeded past every historical row; the encoding incident and its runbook lesson are fully recorded above, ready for OPS-RUNBOOK §10 to carry forward as instructed. Section 7's DEFINER-fallback question is now closed by measurement, not left open.
- **Still open, carried forward honestly, not this plan's to close:** production secrets (`WEBHOOK_HMAC_SECRET`, `PROXY_IP_WHITELIST`, `DISPLAY_IP_WHITELIST`) remain unset; the Phase 3 Agent-auth cutover remains undeployed, so no live Agent has ever connected against this VIEW; D-07's real end-to-end proof (a genuine landing-page registration observed flowing through to the booth) has not yet been attempted — it is plan 06-06's job, not this one's.
- No blockers to 06-06 proceeding.

## Self-Check: PASSED

`mirror-request/docs/migrations/06-cutover.sql` and `mirror-request/src/ops/verifyRegistrationsView.ts` confirmed present on disk with the expected annotations/fix. Commit `8307013` confirmed present in `git log --oneline --all`. `photobooth.registrations`/`photobooth.registrations_name_audit` re-confirmed live as VIEWs via a fresh `information_schema.TABLES` query at write time. Service process confirmed stopped (no `node dist/index.js` process, port 3002 not listening) at write time.

---
*Phase: 06-ingestion-cutover*
*Completed: 2026-08-12*
