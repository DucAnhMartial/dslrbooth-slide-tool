---
phase: 06-ingestion-cutover
verified: 2026-08-12T04:35:00Z
status: human_needed
score: 7/7 must-haves verified (ROADMAP's literal Success Criteria)
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "Deploy Phase 3's Agent-auth cutover, connect a real Agent, and re-run D-07's proof through the queue → Agent → booth → slideshow legs (a fresh registration or a deliberately-dispatched existing job)."
    expected: "The guest is dispatched, the booth runs a session, and the photo reaches the slideshow — closing the fuller chain 06-CONTEXT.md's D-07 named as 'the claim Phase 6 actually makes,' beyond ROADMAP criterion 1's literal 'reaches the booth queue' wording (which is already proven, see truth 1 below)."
    why_human: "No Agent process exists anywhere on this host right now (confirmed: `ps aux` shows no dslrbooth-agent process), and the Phase 3 header-Bearer-auth cutover, while committed to the Agent repo (`e376696`), has never been run against this live service. This is a deployment/ops action outside any single phase's code, not something a repository check can complete."
  - test: "Mark queue_job `3X818VEJ` (WINDOWS.md item 7) `status = 'failed'` by hand per OPS-RUNBOOK §6/§10, after taking a backup, before any Agent is ever connected to this live VIEW."
    expected: "`3X818VEJ` no longer sits in `queued` state; the next Agent connection cannot dispatch a real photo session for a synthetic test guest."
    why_human: "Independently confirmed live (2026-08-12, this verification): `queue_job.id='3X818VEJ'` still has `status='queued', retries=0, stall_reason=null` — the cleanup has genuinely not been performed. `ets_web` has no application path to cancel it (order is `completed`, not `PENDING`; confirmed live via `ticketing/models.py:167`'s gate), so this is an operator action only, correctly flagged as WINDOWS.md item 7 (open)."
  - test: "Confirm WINDOWS.md item 4 (Phase 1 test-DB coupling) remains an accepted, explicitly-deferred open item and not a Phase 6 regression."
    expected: "Item 4 stays open by the human's own prior choice; it is unrelated to Phase 6's own work (all of Phase 6's files pass `npm test` cleanly, 34/34 files, 315/315 tests, in one shared run)."
    why_human: "This is a standing ledger item carried from Phase 1, not something Phase 6 can resolve; confirming it is not silently regressed vs. silently ignored is a project-level decision, not a code check."
---

# Phase 6: Ingestion Cutover Verification Report

**Phase Goal:** Real guests reach the booth — the empty `photobooth.registrations` table becomes a read-only VIEW over `ets_web`'s real ticket chain, with zero changes to web-ticket's code, structurally excluding cancelled/unpaid tickets, immune to a `registered_at` tie at a poll-batch boundary, safe from dispatching historical rows on cutover, backed by read-only DB credentials, monitored by a non-blocking VIEW health probe, and with `/status/:jobId` rate-limited against its 40-bit id.

**Verified:** 2026-08-12T04:35:00Z
**Status:** human_needed
**Re-verification:** No — initial verification (no prior `06-VERIFICATION.md` existed)

## Verification method

Every claim below was re-derived from live systems in this session, not read off `06-06-SUMMARY.md` or `06-VALIDATION.md` prose — those documents were used only to know what to check, and several of their own claims were independently re-measured and matched exactly (see per-truth evidence). The live Extension Service was started once (`node dist/index.js`, non-production mode — `NODE_ENV` unset, confirmed `WEBHOOK_HMAC_SECRET`/`PROXY_IP_WHITELIST`/`DISPLAY_IP_WHITELIST` all unset) to prove criterion 7 live end-to-end, then stopped (confirmed: no process on port 3002, `ps aux` clean). No writes were made to `ets_web` or `photobooth` beyond the one designed write-refusal `INSERT` (which failed as required, `ERROR 1142`) and a harmless throttled-request burst against `/status/:jobId`. The full test suite (`npm test`) was run exactly once (34 files / 315 tests, all green) — no per-truth `grep` filtering of a repeated full run.

## Goal Achievement

### Observable Truths (ROADMAP.md's seven literal Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A registration completed on the landing page appears in the booth queue with the guest's real name, zero web-ticket code changes | ✓ VERIFIED | `git diff 9699374 HEAD -- src/ingestion/dbPoller.ts` = 0 lines (byte-identical). `git status` in `/opt/web-ticket/qrcode/ets_web` = clean working tree (no changes anywhere from this project). Live `queue_job` row: `{id:'3X818VEJ', registration_id:'3X818VEJ', status:'queued', retries:0}`, matching `registration` row `{name:'Phase6 Cutover', ...}` — read directly from `data/extension-service.sqlite`, not from the SUMMARY. The literal wording ("appears in the booth queue") is fully met. **The fuller original D-07 chain (queue → Agent → booth → slideshow) is NOT proven** — see Human Verification item 1. |
| 2 | Cancelled tickets and non-completed orders structurally excluded, not filtered by application logic | ✓ VERIFIED | Independently re-derived (not copied from VALIDATION.md): ran the exact JOIN/WHERE from `docs/migrations/06-registrations-view.sql` directly against live `ets_web` as the `ets_web` account. `leak rows (should be 0): 0` — zero cancelled/pending tickets carry an `event_manager_attendance` row. The 10-row result set (ids + `registered_at` to the microsecond) is byte-identical to what the live `photobooth.registrations` VIEW returns via the service account. Ticket/order status vocab confirmed live: `valid=10, cancelled=16, temporary=2`; `completed=8, cancelled=8, pending=1`. |
| 3 | No registration lost to a `registered_at` tie at a poll-batch boundary | ✓ VERIFIED | Live query as the service account: `total=10, distinct_id=10, distinct_registered_at=10`. The known order-level tie pair (`A523ZC1W`/`WHD4Q2C0`, both `2026-07-27 10:38:24` at the order level) resolves to distinct `event_manager_attendance.created_at` microsecond values (`.318053` vs `.366242`) — confirmed by direct `ets_web` query, matching D-01's design. |
| 4 | Enabling ingestion does not dispatch pre-existing historical rows | ✓ VERIFIED | Direct enumeration of `data/extension-service.sqlite`'s `registration` table: contains only pre-Phase-6 test fixtures (`registration-20260806-*`, `clean-test-*`, `job-webhook-001`) plus exactly one real ets_web-sourced row, `3X818VEJ` — none of the 8 other historical ets_web ticket codes (`QFAP2ABS`, `HZ845N34`, `4Z1WTM62`, `MT82S4MD`, `A523ZC1W`, `WHD4Q2C0`, `9R1XX5RH`, `FC8PX5JQ`, `XACX2T63`) is present. `db_poll_cursor` for key `registrations` = `2026-08-12 02:33:44.479782`, which is `3X818VEJ`'s own `registered_at` (the cursor advances to the last-ingested row) — consistent with a pre-cutover seed past all 9 historical rows (latest historical `registered_at` = `2026-08-07 15:38:49`). |
| 5 | Service DB credentials read `ets_web` and cannot write to it | ✓ VERIFIED | Connected live as `extension_service_ro@%` (credentials read via `dotenv`, never printed). `SHOW GRANTS FOR CURRENT_USER()` → `GRANT USAGE ON *.*` + `GRANT SELECT ON photobooth.*` only. `SHOW DATABASES` → `information_schema, performance_schema, photobooth` only (no direct `ets_web` grant — the VIEW is `SQL SECURITY DEFINER`, running as `ets_web@127.0.0.1`, confirmed via `information_schema.VIEWS.DEFINER/SECURITY_TYPE`). Deliberate `INSERT INTO photobooth.registrations (...)` run live as this account → **`ERROR 1142 (42000): INSERT command denied`**, re-confirmed in this session (a fresh, independent execution — not the same statement string that ran during cutover). |
| 6 | A broken VIEW is detected before an event, not during one | ✓ VERIFIED | This is a behavior-dependent (state-transition) truth: presence + wiring is not sufficient on its own. Wiring confirmed via source: `src/index.ts:68,73` constructs and starts `ViewHealthProbe` inside the `app.listen()` callback, never awaited — cannot block startup. Behavior confirmed by running the **single named test** `test/view-health-probe.test.ts > 'ER_VIEW_INVALID: dispatches exactly one alert and logs exactly one error'` in isolation (`npx vitest run test/view-health-probe.test.ts -t "ER_VIEW_INVALID..."` → 1 passed, 24 skipped) — this exercises the exact transition (a broken-VIEW error code → one `error` log + one alert dispatch) the criterion asserts. A second isolated run of `'no branch throws out of start()'` also passed. A live broken-VIEW was deliberately **not** induced against the real `photobooth.registrations` (would require DDL against a resource this project owns but risk collateral outage during a live event window); the mocked-pool test is the accepted mechanism per `06-VALIDATION.md`'s own Nyquist reasoning, and it passed on direct re-run, not on report. |
| 7 | `/status/:jobId` is rate-limited, id carries 40 bits | ✓ VERIFIED — live, first-party | Built (`npm run build`, `npm run typecheck` — both exit 0) and started the service live (non-production mode), then issued 35 sequential `GET /status/FAKEID99` requests from this host: **requests 1-30 → 404 (`{"error":"job not found"}`), requests 31-35 → 429 (`{"error":"too many requests"}`)** — matching `STATUS_RATE_LIMIT_MAX=30` default exactly. Immediately followed with `GET /status/3X818VEJ` (a real, live job id) while still inside the throttle window → **429 with the byte-identical body** `{"error":"too many requests"}` — directly proving the non-distinguishability guarantee, not just reading the unit tests that assert it. Service stopped afterward (confirmed no process, port 3002 free); no state mutated by this check (`db_poll_cursor`, `registration` count, `queue_job` counts unchanged before/after). |

**Score:** 7/7 truths verified (0 present-but-behavior-unverified).

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `docs/migrations/06-registrations-view.sql` | The VIEW DDL, WHERE-clause exclusion + ROW_NUMBER dedup | ✓ VERIFIED | Read directly; `WHERE t.status='valid' AND o.status='completed'`, `INNER JOIN event_manager_attendance`, `ROW_NUMBER() OVER (PARTITION BY t.id ...) ... WHERE d.rn=1`. Behaviorally cross-validated against live data (see truth 2/3). |
| `docs/migrations/06-cutover.sql`, `docs/migrations/06-rollback-registrations-table.sql` | Applied cutover script + rollback artefact | ✓ VERIFIED (existence + content); cutover already applied (live VIEW exists and serves real data) |
| `src/ops/viewHealthProbe.ts` | Non-blocking VIEW health probe, D-09's two-branch error handling | ✓ VERIFIED — exists, substantive (286 lines), wired in `src/index.ts`, behaviorally proven (see truth 6) |
| `src/security/rateLimiter.ts` | Bounded fixed-window rate limiter, no new dependency | ✓ VERIFIED — exists, substantive (175 lines), wired ahead of `store.getJob()` in `statusRoute.ts:93`, behaviorally proven live (see truth 7). `package.json`/`package-lock.json` diff = 0 lines confirms no new dependency. |
| `src/ops/seedRegistrationsCursor.ts` | Cursor seeded in VIEW's lexical format from MySQL's own clock | ✓ VERIFIED — exists; live cursor value (`2026-08-12 02:33:44.479782`) is in the exact `YYYY-MM-DD HH:MM:SS.ffffff` lexical form the doc requires, not ISO-8601 |
| `mirror-request/docs/OPS-RUNBOOK.md` §10 | Published contract: grant, cursor seeding, health probe, tie detector, name fallback, rate limiting, accepted risks, standing operator action | ✓ VERIFIED — present, matches source (spot-checked the 429 body, the alert payload shape, the `cancel_order()` gate line number, the `unique_attendance` constraint fields — all confirmed against live source, see below) |
| `src/ingestion/dbPoller.ts` | Untouched (D-02) | ✓ VERIFIED — `git diff 9699374 HEAD` = 0 lines |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| Landing page registration | `photobooth.registrations` VIEW | `ets_web`'s own public API + DB trigger chain | ✓ WIRED | Confirmed live: `3X818VEJ` traced ticket → attendance → VIEW row, byte-identical between the service account's read and an independent same-logic query as the `ets_web` account |
| `photobooth.registrations` VIEW | `dbPoller.ts` | Unmodified `SELECT id,name,email,phone,mode,registered_at FROM registrations WHERE registered_at > ? ORDER BY registered_at ASC LIMIT ?` | ✓ WIRED | Cursor advanced correctly after ingesting `3X818VEJ`; no historical rows leaked into local store |
| `viewHealthProbe.ts` | `app.listen()` | Constructed + started inside the listen callback, `start()` never `await`ed | ✓ WIRED | Direct source read of `src/index.ts:68-83` |
| `rateLimiter.ts` | `statusRoute.ts`'s `/status/:jobId` | Mounted as the first Express handler on the route | ✓ WIRED | Direct source read (`statusRoute.ts:93`) + live 429 behavior confirmed before any store lookup could distinguish a real id |

### Requirements Coverage

| Requirement | Description | Status | Evidence |
|---|---|---|---|
| ING-02 | Read backend DB read-only (SELECT) periodically to catch missed registrations | ✓ SATISFIED | `dbPoller.ts` (Phase 1, untouched) now has a real, non-empty, correctly-behaving source to poll — proven live end-to-end via `3X818VEJ` |
| ING-03 | Polling cursor stored in local state, never written back to the real DB | ✓ SATISFIED | `db_poll_cursor` table in SQLite holds the cursor; the one designed write attempt against the real backend was refused (`ERROR 1142`); `CLAUDE.md`'s hard rule holds |

No orphaned requirements found for this phase (`REQUIREMENTS.md`'s traceability table lists only ING-02/ING-03 against Phase 6, matching the plan frontmatter).

### Anti-Patterns Found

Scanned every file changed in the phase (`git diff 9699374 HEAD --name-only`, 22 files) for `TBD|FIXME|XXX|TODO|HACK|PLACEHOLDER` and stub patterns. Six matches for the literal string "placeholder," all in legitimate prose/config-validation contexts (e.g., `config.ts:33-36`'s `required(key, placeholder)` helper, OPS-RUNBOOK prose about a placeholder secret value) — none is a debt marker or a stub. **Zero blockers.**

### CLAUDE.md Hard Rules — Checked, Not Assumed

- "NEVER write (INSERT/UPDATE/DELETE) to the real backend DB" — ✓ held. Only write anywhere is the designed refusal-check `INSERT`, confirmed refused live in this session (`ERROR 1142`) as an independent, fresh execution.
- "NEVER call dslrBooth Local API directly" — not touched by this phase (no dslrBooth-facing code in the 22 changed files).
- "All business logic lives HERE. Agent is a dumb relay only." — not touched by this phase.
- Phase's own scope fence — zero changes under `/opt/web-ticket/` (git status clean) and `dbPoller.ts` byte-identical to baseline `9699374` — both independently confirmed above.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Rate limiter throttles the 31st request | 35× `curl GET /status/FAKEID99` against a live, freshly-started service | 1-30 → 404, 31-35 → 429 | ✓ PASS |
| Throttled response is byte-identical for a real id | `curl GET /status/3X818VEJ` while still throttled | `429 {"error":"too many requests"}`, identical to the fake-id throttled body | ✓ PASS |
| VIEW health probe branches correctly on `ER_VIEW_INVALID` | `npx vitest run test/view-health-probe.test.ts -t "ER_VIEW_INVALID..."` (single named test) | 1 passed | ✓ PASS |
| `npm run build` / `npm run typecheck` clean | `npm run build && npm run typecheck` | both exit 0 | ✓ PASS |
| Full suite green at claimed baseline | `npm test` (run once) | 34 files / 315 tests, all passed | ✓ PASS |
| Write refusal against the real backend | Live `INSERT` as the service account (the one designed exception to "reads only") | `ERROR 1142 (42000)` | ✓ PASS |
| Cross-database dependency-column census | `DESCRIBE` on all 6 source tables the VIEW joins, as `ets_web` account | 23/23 dependency columns present, 0 missing | ✓ PASS |
| `ets_web` cancellation gate unchanged | Read `ticketing/models.py:155-169` live | `cancel_order()` still gates on `locked.status != OrderStatus.PENDING` at line 167 | ✓ PASS |
| `unique_attendance` constraint unchanged | Read `event_manager/models.py:723-724` live | `UniqueConstraint(fields=["ticket","session"], name="unique_attendance")` present | ✓ PASS |

### Probe Execution

No `scripts/*/tests/probe-*.sh` convention exists in this project; this phase's "probes" are the Manual-Only rows in `06-VALIDATION.md`, all re-executed above as live behavioral spot-checks rather than as shell-script probes. N/A for this section.

### Human Verification Required

1. **Deploy Phase 3's Agent-auth cutover and complete D-07's fuller chain.** See frontmatter `human_verification[0]`. Not blocking Phase 6's own declared scope (ING-02/ING-03), but the phase's own CONTEXT.md D-07 named this as "the claim Phase 6 actually makes," and it remains open. `06-06-SUMMARY.md` and `docs/OPS-RUNBOOK.md` §10 both name it explicitly rather than closing it silently — this verification concurs with that framing after independently confirming no Agent process exists anywhere on this host and the Bearer-header auth change, while committed to `dslrbooth-agent` (`e376696`), has never been run live against this service.
2. **Mark `queue_job` row `3X818VEJ` `failed` by hand before any Agent connects.** See frontmatter `human_verification[1]`. Independently re-confirmed live, this session: still `status='queued', retries=0`. This is `WINDOWS.md` item 7, correctly recorded `open`.
3. **Confirm `WINDOWS.md` item 4's disposition remains intentional.** See frontmatter `human_verification[2]`. Not a Phase 6 defect — carried from Phase 1 by explicit prior human choice — but flagged here because `open_count: 2` in the ledger will block `/gsd-ship` until both items are resolved or waived.

### Gaps Summary

No FAILED truths, no MISSING/STUB artifacts, no NOT_WIRED key links, and no blocking anti-patterns were found — every one of the seven ROADMAP Success Criteria, taken at its literal wording, was independently re-derived from a live system in this session and holds. The reason this report is `human_needed` rather than `passed` is not a defect in Phase 6's own delivered code or DDL; it is two genuinely open, correctly-flagged items that only a human can close: (1) the fuller D-07 chain through a connected Agent, which depends on the still-undeployed Phase 3 Agent-auth cutover — a prerequisite outside this phase's own scope, and (2) a live, unresolved operational hazard (`3X818VEJ` sitting in the real queue with no upstream cancellation path) that must be manually resolved before any Agent is connected to this VIEW, or a synthetic test guest will be dispatched for a real photo session with nobody present.

This verification independently confirms — rather than merely repeats — the phase's own self-assessment (`06-VALIDATION.md`'s "human_needed, not passed" and `STATE.md`'s matching language): every load-bearing number and behavior quoted from those documents (grant text, INSERT refusal error code, VIEW row counts, cursor value, queue_job state, rate-limit threshold and body, cancel_order() gate line, unique_attendance constraint fields, dependency column count) was re-measured directly against the live database, the live filesystem, or a freshly-started live service in this session, and matched exactly in every case checked.

---

*Verified: 2026-08-12T04:35:00Z*
*Verifier: Claude (gsd-verifier)*
