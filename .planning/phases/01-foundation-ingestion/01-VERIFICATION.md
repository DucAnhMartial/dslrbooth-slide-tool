---
phase: 01-foundation-ingestion
verified: 2026-08-10T09:20:00Z
status: passed
score: 6/6 must-haves verified (ROADMAP M1 success criteria) + 6/6 requirement IDs satisfied
behavior_unverified: 0
overrides_applied: 0
re_verification: No — initial verification
---

# Phase 1: Foundation & Ingestion Verification Report

**Phase Goal:** Registrations reaching the central service are cryptographically authenticated,
de-duplicated within a configurable window, and durably persisted in SQLite — with read-only
MySQL polling recovering anything the webhook missed, and no PII or raw payload leaking into
production logs.

**Verified:** 2026-08-10T09:20:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Verdict

**Goal achieved.** All five ROADMAP M1 success criteria and all six Phase 1 requirement IDs
(ING-01, ING-02, ING-03, STO-01, AUTH-02, AUTH-03) are backed by real, currently-passing code —
verified independently in this session (not by re-reading SUMMARY.md claims): a live `npm run
dev` boot, a live `npm test` run (repeated 4x, 69/69 green each time), a live inspection of the
actual SQLite file's schema, and direct reading of every production source file the five plans
touched. One non-blocking WARNING is raised below (pre-existing, already tracked in
`WINDOWS.md`) — it does not affect the phase goal but will independently block `/gsd-ship` while
`WINDOWS.md` `open_count > 0`.

## Goal Achievement — ROADMAP M1 Success Criteria

| # | Success Criterion | Status | Evidence |
|---|---|---|---|
| 1 | `npm run dev` starts the server without errors | ✓ VERIFIED | Ran live: `cd mirror-request && npm run dev` → `Extension Service ready on 0.0.0.0:3002`, `AgentServer started at /agent`, `DB poller connected: localhost:3306/photobooth`, clean shutdown on SIGTERM. `npm run build` and `npm run typecheck` both exit 0 with zero errors (the `getJobRegistration()` duplicate-method blocker documented in `WINDOWS.md` #1 is fixed — verified absent in current `localStore.ts`, which defines the method exactly once at line 255). |
| 2 | POST /on-register returns 200 and logs the payload (masked) | ✓ VERIFIED (with a documented, human-approved refinement) | `mirrorReceiver.ts:56-134` returns `200 {accepted:true,jobId}` on success; the ingestion log line (`Ingested registration ${id} from ${ip}`, line 133) names only id/IP/status, never raw payload fields — per locked decisions D-15/D-16, the raw payload is *never* logged in production (only stored to SQLite, `raw_payload` column) and is echoed to a **masked** debug log only when `NODE_ENV!=='production' && DEBUG` is set (`debugRawPayload()`, routes through the same `mask()`-applying Winston formatters). This intentionally supersedes the more literal ROADMAP wording ("logs the payload (masked)") with the authoritative Phase Goal text itself ("no PII or raw payload leaking into production logs") — confirmed by the human at the 01-05 Task 3 checkpoint and published in `docs/OPS-RUNBOOK.md`. `test/logging-mask.test.ts` (10 cases) proves `mask(msg)===msg` for every captured `/on-register` log message and that `raw_payload` is still populated in a production run with no payload JSON in any log line. |
| 3 | SQLite file created with schema (queue, booth_state, db_cursor, job_history) | ✓ VERIFIED | Live-inspected `data/extension-service.sqlite` after the dev boot above: tables `registration`, `queue_job` (queue + job history via status/timestamp columns), `processed_id`, `db_poll_cursor` (cursor), `booth_state`, `notification_record`, `webhook_replay` all present. WAL mode confirmed (`localStore.ts:17`). |
| 4 | DB polling runs every N seconds via SELECT, updates the cursor locally | ✓ VERIFIED | `dbPoller.ts:100-103` issues exactly one query, string-literal `SELECT id, name, email, phone, mode, registered_at FROM registrations WHERE registered_at > ? ORDER BY registered_at ASC LIMIT ?` — no `INSERT`/`UPDATE`/`DELETE`/`DDL` anywhere in the file (`grep -ciE '\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b' dbPoller.ts` → 0). Cursor is written only to local `db_poll_cursor` via `store.setCursor()` (`localStore.ts:210-212`), never back to the source. Interval defaults to `DB_POLL_INTERVAL_MS=3000` (`config.ts:83`). `test/db-poller.test.ts` (11 cases) proves this with a mocked `mysql2/promise` pool, including the explicit SELECT-only assertion (`mirror-request/CLAUDE.md` hard-rule guard). |
| 5 | /on-register rejects non-whitelisted IPs with 403 | ✓ VERIFIED | `mirrorReceiver.ts:39-54,59-62`: `isWhitelisted()` sources the peer address from `clientIp()` (`req.ip \|\| req.socket.remoteAddress`, never a forwarding header); no `trust proxy` setting exists anywhere in `src` (`grep -rniv '^\s*[/*]' --include=*.ts src \| grep -ci "trust proxy"` → 0, confirmed live). `test/on-register-auth.test.ts` "IP allow-list" block (5 cases) proves a loopback request carrying a forged `X-Forwarded-For: 203.0.113.9` is still rejected 403 when the real peer is not allow-listed. |

**Score:** 5/5 ROADMAP success criteria verified.

## Requirements Coverage

| Requirement | Description | Status | Evidence |
|---|---|---|---|
| ING-01 | POST /on-register accepts registration, returns 200, persists | ✓ SATISFIED | `mirrorReceiver.ts` full handler; `test/on-register-auth.test.ts`, `test/on-register-dedup.test.ts` |
| ING-02 | Read-only periodic SELECT polling to catch missed registrations | ✓ SATISFIED | `dbPoller.ts`; SELECT-only enforced by grep gate + test |
| ING-03 | Poll cursor lives in local state only, never written back | ✓ SATISFIED | `localStore.ts` `getCursor`/`setCursor` against local `db_poll_cursor` table only; `test/local-store-persistence.test.ts` proves survival across close/reopen |
| STO-01 | SQLite persists queue/booth/cursor/job-history/processed-ids across restart | ✓ SATISFIED | Live schema inspection above; WAL mode; `test/local-store-persistence.test.ts` |
| AUTH-02 | /on-register rejects non-whitelisted IPs with 403 | ✓ SATISFIED | See success criterion 5 above |
| AUTH-03 (ingestion-side scope only, per D-15/D-16 and the phase's own documented boundary) | PII masked in logs | ✓ SATISFIED | `mask()` in `logger.ts`; `test/logging-mask.test.ts`; raw payload never logged in production, only stored |
| AUTH-01 | Agent WS token auth | Correctly NOT in scope | `REQUIREMENTS.md` traceability row corrected during 01-05 to `AUTH-01 \| 3 \| Pending`; still `[ ]` unchecked. No Phase 1 gap — this is Phase 3 work, as ROADMAP.md's Phase 1 note explicitly states. |

No orphaned requirements found — every Phase 1 ID declared across the five plans' `requirements:` frontmatter is accounted for above.

## Hard Rule Verification: Read-Only Backend DB (CLAUDE.md rule 1)

`grep -v '^\s*[/*]' src/ingestion/dbPoller.ts | grep -ciE '\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b'` → **0**. `dbPoller.ts` is the only file in `src/` that imports/uses `mysql2` (`grep -rln "mysql2" src` → only `dbPoller.ts`). The one query issued (`doPoll()`, line 100-103) is a parameterized `SELECT`. Verified both statically and via `test/db-poller.test.ts`'s dedicated SELECT-only assertion. **No violation found.**

## Dedup Ladder Verification (D-01/D-02/D-03)

Code at `mirrorReceiver.ts:76-134` matches the documented reading exactly: `id`/`name` remain
hard-required (400 if missing, unchanged from before this phase); permanent `isProcessed(id)`
idempotency is checked first; then `findDuplicateRegistration()` checks (a) same `id` inside the
window, (b) same non-empty `email` or `phone` inside the window, in that order, with
`? <> ''` guards in the SQL (`localStore.ts:118-126`) so two blank-contact registrations never
collide. A duplicate returns before any persistence call, preserving the original `raw_payload`
(RESEARCH.md Pitfall 7). This matches the human-confirmed 01-05 Task 3 checkpoint resolution.
`test/on-register-dedup.test.ts` (14 cases, both store-level and HTTP-level) directly exercises
every branch, including same-id, email-fallback, phone-fallback, outside-window-is-new,
raw_payload-preserved, onEnqueue-fires-once, and blank-contact-non-collision.

## Test Integrity Assessment (WINDOWS.md ledger item 4)

Ran `npm test` independently four times in this session (not reusing SUMMARY.md's claimed
numbers): **69/69 tests passed, 11/11 files, all four runs**, no flakes observed. The specific
flaky assertion documented in WINDOWS.md #3 (`countWebhookIds()` snapshot-then-delta race) is
confirmed fixed (commit `e54e22e` — assertion now checks a specific webhook id's replay state,
not a global count).

The underlying architectural coupling remains, however: the suite exercises the real local-state
DB (`getStore()` singleton over one fixed `LOCAL_STORE_PATH`) rather than the `constructor(dbPath?)`
seam added in 01-02, so all test files that use `getStore()` share mutable state — this is
WINDOWS.md ledger item **4, still open**. Given four consecutive clean runs and the one
concrete flake already fixed, this does **not** undermine confidence that the 69 passing tests
currently prove what they claim. It **is** a legitimate latent risk for future phases that add
more `getStore()`-based tests, and it is already correctly tracked as an open item rather than
silently absorbed.

## Anti-Pattern Scan

No `TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER` markers found in any Phase 1 source file
(`src/ingestion/*.ts`, `src/state/localStore.ts`, `src/logging/logger.ts`, `src/config.ts`,
`src/index.ts`). No `console.log` in `src/ingestion` or `src/logging`. No new production
dependency was added (`supertest`/`@types/supertest` are `devDependencies` only).

## Findings

### WARNING — WINDOWS.md open ledger item (non-blocking for phase goal, blocking for ship gate)

`.planning/WINDOWS.md` currently shows `open_count: 1` (ledger id 4 — the test-suite singleton-DB
coupling described above). This does not affect whether Phase 1's goal is achieved in the
codebase, but `/gsd-ship` will block while `open_count > 0` under `workflow.windows_enforce`.
This is a human decision point: waive it (it's a documented, non-regressing test-architecture
concern, not a defect in shipped behavior) or assign a follow-up plan to point the suite at a
per-file temp DB before shipping.

No other gaps found. No must-have truth failed. No artifact was missing, stub, or unwired. No key
link was broken.

## Human Verification Required

None. The one blocking human checkpoint this phase contained (01-05 Task 3 — HMAC canonical
string, D-02 reading, production readiness, D-14 retention) was already resolved by the human
during execution; the resolution is corroborated by the existence and content of
`mirror-request/docs/OPS-RUNBOOK.md`, which documents exactly the four points the checkpoint
asked about.

---

_Verified: 2026-08-10T09:20:00Z_
_Verifier: Claude (gsd-verifier)_
