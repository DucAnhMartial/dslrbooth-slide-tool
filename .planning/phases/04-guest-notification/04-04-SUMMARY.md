---
phase: 04-guest-notification
plan: 04
subsystem: notifications
tags: [ops-runbook, documentation, boundary-verification, phase-gate]
requires:
  - phase: 04-guest-notification
    provides: "Persisted retry queue, failure posture, and storage-contract regression proof from plans 04-01/04-02/04-03"
provides:
  - "OPS-RUNBOOK.md §8 — the guest notification delivery contract (payload, delivery model, status/failure vocabulary, lookup SELECT, re-arm UPDATE, retry-budget arithmetic, migration note)"
  - "OPS-RUNBOOK.md §3 extended with NOTIFY_WEBHOOK_URL and the three NOTIFY_* timing variables"
  - "Verified phase boundary: queue seam, display feed, web-slide, and dependency set all confirmed untouched against baseline 9b20d9e"
affects: [04-guest-notification]
requirements: [NOT-01, NOT-02]
actuals:
  tokens: 9200
  tasks: 2
  commits: 2
tech-stack:
  added: []
  patterns:
    - "Runbook prose as the only enforcement of an unvalidated cross-service payload contract — quoted verbatim against source before committing, not re-derived from planning text"
key-files:
  created: []
  modified:
    - mirror-request/docs/OPS-RUNBOOK.md
    - mirror-request/src/notifications/notificationService.ts
key-decisions:
  - "Task 2 check 5 (grep -icE 'phone|email' src/notifications/notificationService.ts must return 0) initially failed against a source comment stating 'No email, no phone (D-02, D-03)' — the comment named the excluded fields while documenting their absence. Per the plan's own acceptance criteria ('move that discussion into OPS-RUNBOOK.md §8 rather than weakening this gate'), reworded the comment to make the same point without naming phone/email, since the full discussion already lives in §8. Rule 1 auto-fix, not a deviation from the plan's intent — the plan explicitly anticipated this exact situation."
duration: ~25min (all 3 tasks, including checkpoint resolution)
completed: 2026-08-10
status: complete
---

# Phase 4 Plan 4: Phase Gate — Runbook Contract, Boundary Proof, and the Live-Data Migration Decision Summary

**Published OPS-RUNBOOK.md §8 (the third integration contract this service owns, beside §1's webhook signing and §7's Agent auth), verified all seven phase-boundary checks against baseline `9b20d9e`, and reached the plan's blocking phase-gate checkpoint — the live-data migration and production-reachability decision — which requires an explicit human answer and is PAUSED pending it.**

## Performance
- **Duration:** ~20 min for Tasks 1-2
- **Tasks:** 2/3 completed (Task 3 is the blocking checkpoint, not executable by this agent)
- **Files modified:** 2 (1 documentation, 1 one-line source comment fix)

## Accomplishments

### Task 1 — OPS-RUNBOOK §8
Added `## 8. Guest notification delivery` to `mirror-request/docs/OPS-RUNBOOK.md`, covering, in the order the plan specified:
- The exact five-key payload (`jobId`, `guestName`, `photoUrl`, `timestamp`, `mode`) with a real example body, stating plainly that `web-slide/server.js` performs no lookup and falls back silently (`'Khách hàng'`, `null`, `''`) — confirmed by reading `web-slide/server.js:59-90` directly, not inferred — so a field rename on either side produces a blank display and no error anywhere.
- Why no `phone`/`email` is sent (D-02, D-03) and why the webhook is unsigned (no PII in the body, unlike §1's inbound contract).
- The delivery model: enqueue-only `sendPhotoLink()`, no in-memory retry loop, the sweeper's due-time query as the sole recovery mechanism (D-04).
- The five-value status table (`pending`, `retrying`, `sending`, `delivered`, `failed`) with terminality and transitions.
- The `lastError` failure vocabulary (`timeout`, `Webhook returned HTTP <status>`, pass-through `Error.message`, `registration not found`, the migration marker), quoted verbatim from `classifyError()` and `attemptDelivery()`, and the exhaustion log line quoted verbatim.
- A failed-delivery lookup `SELECT` joining `notification_record` → `queue_job` → `registration`.
- A manual re-arm `UPDATE`, preceded by a backup warning matching §6's shape, with the explicit note that the code will not re-arm a terminal row on its own (`ON CONFLICT ... WHERE status NOT IN ('delivered','failed')`).
- The retry-budget arithmetic: `NOTIFY_MAX_RETRIES` now counts retries after the first attempt (D-08/D-15); default `2` yields 3 total attempts, unchanged in count from before this phase but changed in meaning — anyone who set the variable explicitly should re-read it.
- The one-way migration note: pre-existing non-terminal rows have no `photoUrl` (D-13) and are marked `failed` on first boot after deploy, honestly rather than silently.

Also extended `## 3.` with a new "Guest notification variables added in Phase 4" table: `NOTIFY_WEBHOOK_URL` (silent-skip-when-unset warning), `NOTIFY_MAX_RETRIES` (semantic-change warning), `NOTIFY_FETCH_TIMEOUT_MS`, `NOTIFY_SWEEP_INTERVAL_MS`, `NOTIFY_CLAIM_LEASE_MS`.

Every quoted string was grepped against `src/notifications/notificationService.ts` / `src/state/localStore.ts` before committing (see Verification below) — none was re-derived from the plan or the prior summaries without a source check.

### Task 2 — Boundary and regression verification
All seven checks run from `mirror-request/` against baseline `9b20d9e` (Phase 3's closing commit):

1. **Queue seam (D-06):** `git diff --name-only 9b20d9e..HEAD -- src/queue/` → empty. ✅
2. **Display feed (D-12):** `git diff --name-only 9b20d9e..HEAD -- src/display/` → empty. ✅
3. **Receiver (D-11):** `ls -la --time-style=+%F ../web-slide/server.js` → `2026-08-07`, predates this phase's work (2026-08-10). ✅
4. **No new dependency:** `git diff --name-only 9b20d9e..HEAD -- package.json package-lock.json` → empty. ✅
5. **No PII in the outbound payload (D-02):** `grep -icE 'phone|email' src/notifications/notificationService.ts` → **initially `1`** (a source comment naming the excluded fields while documenting their absence), **fixed to `0`** by rewording the comment to reference OPS-RUNBOOK.md §8 instead of naming the fields directly — see Deviations below. ✅ after fix.
6. **Full phase file set:** `git diff --name-only 9b20d9e..HEAD` lists exactly the 13 declared paths (`docs/OPS-RUNBOOK.md`, `src/config.ts`, `src/index.ts`, `src/notifications/notificationService.ts`, `src/state/localStore.ts`, `src/types.ts`, and the 7 `test/` files) — no additional entry. ✅
7. **Suite, types, build:** `npm test` → 27 files / 182 tests green (matches the 04-01/04-02/04-03 running total; pre-phase baseline was 23 files / 155 tests). `npm run typecheck` and `npm run build` both clean. `git status --porcelain` clean (after commits).

## Task Commits

1. **Task 1** — `04b1543` `docs(04-04): publish OPS-RUNBOOK §8, the guest notification delivery contract`
2. **Task 2 (fix required to pass check 5)** — `419763f` `fix(04-04): remove literal PII-field-name comment from notificationService.ts`

## Files Created/Modified

- `mirror-request/docs/OPS-RUNBOOK.md` — new `## 8. Guest notification delivery` section; `## 3.` extended with the Phase 4 environment variable table.
- `mirror-request/src/notifications/notificationService.ts` — one comment reworded (no behavior change) to stop naming `phone`/`email` literally, moving that discussion into the now-published §8.

## Deviations from Plan

### 1. [Rule 1 — bug in the check, source comment tripped the D-02 grep gate] Task 2 check 5 required a source-code fix

**Found during:** Task 2, check 5.
**Issue:** `grep -icE 'phone|email' src/notifications/notificationService.ts` returned `1`, not the required `0`. The single match was the comment `// body (D-01). No email, no phone (D-02, D-03).` above the payload construction — documenting the *absence* of PII, not an actual leak, but naming the excluded field names literally.
**Fix:** Reworded the comment to `// body (D-01). No contact details are sent (D-02, D-03) — see OPS-RUNBOOK.md §8 for the full payload contract and rationale.` The plan's own acceptance criteria for this exact check anticipated this situation verbatim: *"If a comment in `notificationService.ts` legitimately needs to discuss the excluded contact fields, move that discussion into `OPS-RUNBOOK.md` §8 rather than weakening this gate."* §8 already carries the full discussion (published in Task 1), so the fix was a pure move, not new content.
**Files modified:** `mirror-request/src/notifications/notificationService.ts`
**Commit:** `419763f`
**Verification:** `grep -icE 'phone|email' src/notifications/notificationService.ts` now returns `0`; `npm test` 27/182 green; `npm run typecheck`/`npm run build` clean; check 6 (13-file diff) unaffected since this file was already in the declared set.

No other deviations. Task 1 executed exactly as planned.

## Verification

- `cd mirror-request && grep -c '^## 8\.' docs/OPS-RUNBOOK.md` → `1`.
- `cd mirror-request && git show --name-only --format= 04b1543` → `docs/OPS-RUNBOOK.md` only.
- Every quoted string in §8 confirmed verbatim against source before committing: the five payload keys (`guestName: registration.name` etc. in `notificationService.ts`), the five `lastError` reasons (`'timeout'`, `Webhook returned HTTP ${response.status}`, `registration not found`, the migration marker), the exhaustion log line, the `status IN ('pending','retrying','sending')` predicate, the `nextAttempt < 1 + this.maxRetries` boundary, and the `ON CONFLICT ... WHERE notification_record.status NOT IN ('delivered','failed')` clause — all matched by targeted grep against `src/notifications/notificationService.ts` and `src/state/localStore.ts`.
- All seven Task 2 boundary checks recorded above, with actual command output, not just a pass/fail claim.
- `cd mirror-request && npm test` — 27 files / 182 tests green, unchanged from 04-03's baseline (doc-only + one-comment change, no behavior change).
- `cd mirror-request && npm run typecheck && npm run build` — both clean.
- `cd mirror-request && git status --porcelain` — clean (two commits landed everything).
- Stale `mirror-request/.planning/` tree: **left untouched by this agent.** `git status --short .planning/` inside `mirror-request/` shows `.planning/STATE.md` as modified, but this modification predates this agent's work (confirmed by `git diff` before any command in this session was run — the diff shows an unrelated frontmatter block and session-note addition this agent never wrote). Per the repository-topology instructions, this stale, obsolete tree was not read for planning purposes and was not staged or committed by this agent's `git add` calls (only `docs/OPS-RUNBOOK.md` and `src/notifications/notificationService.ts` were staged, individually, across the two commits).

## Self-Check: PASSED

- FOUND: `mirror-request/docs/OPS-RUNBOOK.md` (modified, `## 8.` present).
- FOUND: `mirror-request/src/notifications/notificationService.ts` (modified).
- FOUND: commit `04b1543` in `git log --oneline --all`.
- FOUND: commit `419763f` in `git log --oneline --all`.

## Task 3 — Phase gate checkpoint: RESOLVED (approved)

Task 3 (`type="checkpoint:human-verify" gate="blocking"`) was answered by explicit human decision, not self-approved — consistent with this project's unbroken precedent (Phase 1 Task 3, plan 02-04 Task 3, plan 03-01 Task 1, plan 03-05 Task 2). `workflow._auto_chain_active` was `false` and `auto_advance` unset throughout.

**1. §8 approved as written.** No changes requested.

**2. Migration accepted, with real (not estimated) numbers.** The human took the backup and ran the read-only count before deciding:
- Backup: `data/backups/extension-service.sqlite.<timestamp>.bak`, 57344 bytes, non-empty and verified.
- `SELECT status, COUNT(*) FROM notification_record GROUP BY status;` → **exactly one row, `status = 'delivered'`. Total rows in the table: 1.** There are no `pending`, `retrying`, `sending`, or `failed` rows for the backfill to touch — the blast radius of this migration on the current production database is zero non-terminal rows; the migration's `WHERE ... status NOT IN ('delivered','failed')` clause has nothing to act on.

**Backfill-predicate concern raised at resolution time, checked against source, and resolved as unfounded:** the human asked whether the backfill's `WHERE` clause excludes terminal states, since a predicate of bare `WHERE photoUrl IS NULL` would incorrectly flip the one `delivered` row to `failed`. Confirmed directly from `src/state/localStore.ts` (lines 113-118):
```sql
UPDATE notification_record
SET status = 'failed', lastError = 'photoUrl unavailable — record predates persisted-queue migration'
WHERE photoUrl IS NULL AND status NOT IN ('delivered','failed')
```
The predicate **does** exclude `'delivered'` and `'failed'` explicitly — this is the same terminal-state guard 04-03's regression suite already pins (`test/local-store-persistence.test.ts`'s migration describe block, case "a pre-existing `delivered` row is left completely untouched by the backfill"). The single production row, being `status = 'delivered'`, is excluded by the `status NOT IN (...)` clause regardless of whether `photoUrl IS NULL` also holds for it. **Not an open question — confirmed safe, no code change needed.**

**3. Production reachability — explicitly NOT verified.** `.env*` is sandbox-denied in this environment, so `NOTIFY_WEBHOOK_URL` could not be checked. This remains the operator's pre-deploy responsibility exactly as §8 states; recorded here as an honest gap, not a false confirmation.

**4. End-to-end run — explicitly declined, not an oversight.** The service is stopped and the Phase 3 Agent-auth cutover has not yet been deployed (see Carry-Forward Items below), so a real end-to-end photo run is not meaningfully possible until that deploy happens. Recorded as a deliberate, accepted gap.

**No commit for Task 3.** This task is a pure verification/decision gate — it produced no code or documentation change of its own (the backfill-predicate question was answered by reading existing, already-committed source, not by editing it). Nothing to stage or commit.

## Phase 4: CLOSED

Both requirements (NOT-01, NOT-02) were already `[x]` in REQUIREMENTS.md before this plan (marked complete by 04-01/04-02) and are not re-marked here. All four plans (04-01 tracer, 04-02, 04-03, 04-04) executed; the phase gate's runbook contract, boundary proof, and live-data migration decision are all resolved. Phase 4 is closed.

## Carry-Forward Items for Phase 5

1. **`.planning/WINDOWS.md` has 2 open ledger entries** — item 4 (shared test DB via the `getStore()` singleton across parallel vitest workers) and item 5 (connection-id log masking, Phase 3, diagnostics-only). `/gsd-ship` blocks while `open_count > 0`. Neither was in scope for Phase 4 to fix.
2. **The Phase 3 Agent-auth cutover has not been deployed to production.** Per OPS-RUNBOOK §7, server and Agent must ship in the same maintenance window — a new server against an old Agent rejects every connection outright. This is why Task 3's end-to-end run was declined (see above): there is no live Agent link to run it against yet. Whoever deploys next must ship both components together, per §7's deploy-ordering section.
