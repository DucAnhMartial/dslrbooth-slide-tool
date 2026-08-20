---
phase: 6
slug: ingestion-cutover
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: validated
nyquist_compliant: true
wave_0_complete: true
created: 2026-08-11
---

# Phase 6 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Seeded by plan-phase from `06-RESEARCH.md` § Validation Architecture. Task IDs
> in the map below are bound once plans exist; the claims themselves are fixed now.

**This phase's product is mostly DDL living in a database, not code in a repository.**
That makes the Nyquist question — *how do you know it is still true after you ship it* —
answerable differently for each claim rather than uniformly. Several of this phase's most
important claims are provably manual-only, and this document says so rather than
manufacturing a fixture that misrepresents the constraint. Phase 5 honestly returned
`human_needed` rather than overclaiming `passed`; Phase 6 should expect the same shape.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest `^2.1.4` (already installed and green) |
| **Config file** | `mirror-request/vitest.config.ts` |
| **Quick run command** | `cd mirror-request && npx vitest run test/<file>.test.ts` |
| **Full suite command** | `cd mirror-request && npm test` |
| **Estimated runtime** | ~30 seconds (31 files / 258 tests at the Phase 5 close-out) |

**Baseline caution:** 31 files / 258 tests is the figure recorded at Phase 5's close-out.
Confirm the live number at Wave 0 rather than trusting it — this project has been bitten
four times by stale counts taken from `grep` rather than from execution.

**Mocking pattern to reuse:** `mirror-request/test/db-poller.test.ts:2-45` already establishes
the `createRequire` + `vi.spyOn(mysql2Promise, ...)` technique for driving the poller without
a live MySQL. Every new MySQL-touching test in this phase should follow it rather than
inventing a second approach.

---

## Sampling Rate

- **After every task commit:** `npx vitest run` on the specific new or changed test file
- **After every plan wave:** `cd mirror-request && npm test` (full suite), green at or above baseline
- **Before the phase gate:** full suite green **plus** every Manual-Only row below explicitly
  executed with its outcome recorded — not silently skipped
- **Max feedback latency:** ~30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement / Claim | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|---------------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 06-02 T1 | 06-02 | 2 | M6-3 / D-09 — probe distinguishes broken VIEW from unreachable DB | T-06-03 | `ER_VIEW_INVALID` alerts; connection-class codes warn only (Phase 1 D-05), so a transient outage never pages anyone | unit (mocked `mysql2` pool) | `npx vitest run test/view-health-probe.test.ts` | ✅ | ✅ green (25 tests, `test/view-health-probe.test.ts`) |
| 06-02 T1 | 06-02 | 2 | M6-3 / D-09 — probe never blocks startup, never throws past its boundary | T-06-03 | Either failure class returns normally; `app.listen()`'s callback still completes | unit | `npx vitest run test/view-health-probe.test.ts` | ✅ | ✅ green (25 tests, `test/view-health-probe.test.ts`) |
| 06-03 T1-2 | 06-03 | 3 | M6-7 / D-10 — `/status/:jobId` rate limited | T-06-01 | The N+1th request in the window is throttled | integration (supertest, per `test/status-api.test.ts`) | `npx vitest run test/status-rate-limit.test.ts` | ✅ | ✅ green (16 tests, `test/status-rate-limit.test.ts`) |
| 06-03 T2 | 06-03 | 3 | M6-7 / D-10 — throttled response does not confirm an id exists | T-06-02 | Response byte-identical for real and fake ids, **and** the limiter gates ahead of `store.getJob()` so no latency side-channel appears | integration | `npx vitest run test/status-rate-limit.test.ts` | ✅ | ✅ green (16 tests, `test/status-rate-limit.test.ts`) |
| 06-04 T1 | 06-04 | 2 | D-06 — cursor seeded to "now" before first boot | — | `getCursor('registrations')` returns ≥ the cutover timestamp, never the `1970-01-01` default | unit, direct `LocalStore` — no MySQL | `npx vitest run test/local-store-persistence.test.ts` | ✅ | ✅ green (6 new tests; also confirmed live in plan 06-05: seeded `2026-08-12 01:53:57.234379` > `MAX(registered_at) = 2026-08-07 15:38:49.220951`) |
| 06-01 T2 | 06-01 | 1 | **RESEARCH Pitfall 1** — `registered_at` crosses the mysql2 → better-sqlite3 boundary as a bindable type | — | A `DATETIME` value from the VIEW binds successfully into both `upsertRegistration()` and `setCursor()`; a `Date` object would throw `TypeError` inside `dbPoller`'s warn-and-retry catch and fail silently forever | unit (mocked pool returning the VIEW's actual column type) | `npx vitest run test/db-poller.test.ts` | ✅ | ✅ green (2 new tests in `test/db-poller.test.ts`; also proved live in plan 06-01's `sqlite-bind-proof` check: 9 registrations written, 9 jobs enqueued, no `TypeError`) |
| 06-01 T1 / 06-05 T2 | 06-01, 06-05 | 1, 4 | D-03 — VIEW returns exactly one row per ticket | T-06-05 | Row count equals `COUNT(DISTINCT ticket.id)`, not `COUNT(*)` of the raw JOIN | operational SELECT, read-only, repeatable | see Manual-Only | n/a | ✅ green (06-01 inline: rows=distinctIds=`DEDUP_CONTROL_SQL`=9; 06-05 through the live VIEW as the service account: `COUNT(*)=COUNT(DISTINCT id)=9`) |
| 06-05 T2 | 06-05 | 4 | M6-4 — service credentials read `ets_web` and cannot write to it | T-06-04 | `SHOW GRANTS` shows SELECT only; an attempted write is refused | operational | see Manual-Only | n/a | ✅ green (`SHOW GRANTS` = `GRANT USAGE ON *.*`, `GRANT SELECT ON photobooth.*` only; deliberate `INSERT` refused twice independently — `ERROR 1142` as the service account, `ERROR 1471` as the admin account) |
| 06-06 T3 | 06-06 | 5 | M6-1 / D-07 — a real landing-page registration reaches the booth queue | — | End-to-end, not a replay | **manual-only by design** | — | n/a | ✅ green — proven live 2026-08-12, ticket `3X818VEJ` (synthetic, RFC 2606 identity): landing page → `ets_web` → VIEW → poller → **queue**, confirmed hop-by-hop (see `06-06-SUMMARY.md`). Agent/booth/slideshow legs beyond the queue are **declined-with-named-blocker** — no Agent connected (Phase 3 Agent-auth cutover undeployed); log line `Skipping dispatch: Agent not connected (job 3X818VEJ stays queued)`; job stayed queued at zero cost (`retries=0`). Not silently closed. |
| 06-01 T1, T3 | 06-01 | 1 | M6-2 — cancelled / unpaid structurally excluded | T-06-05 | Source-code proof: no `ets_web` path cancels a VALID+attended ticket | manual (source read, already performed) | — | n/a | ✅ green (live-measured 2026-08-11: `event_manager_attendance` rows exist for 9/9 valid tickets, 0/18 cancelled+temporary) |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

**The sixth row is the one that would otherwise be missed.** It exists only because research
found it; it is not derivable from any CONTEXT decision. `photobooth.registrations` has held
zero rows since Phase 1, so the mysql2 → better-sqlite3 bind path has never once executed in
this project's history. It executes for the first time on the first real guest.

---

## Wave 0 Requirements

- [ ] `test/view-health-probe.test.ts` — D-09's two-failure-mode branching, mocked `mysql2` pool per `db-poller.test.ts`
- [ ] `test/status-rate-limit.test.ts` — D-10's throttling and its non-distinguishing response
- [ ] Extend `test/local-store-persistence.test.ts` — D-06's seeded cursor value landing correctly in SQLite
- [ ] Extend `test/db-poller.test.ts` — the `registered_at` bind-type crossing (RESEARCH Pitfall 1)
- [ ] No framework install needed — vitest is configured and green

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions | Outcome |
|----------|-------------|------------|-------------------|---------|
| A real registration reaches the booth queue with the guest's own name | M6-1, D-07 | The claim *is* the full chain — landing page → `ets_web` → VIEW → poller → queue → Agent → booth → slideshow. A fixture can only prove the second half, which is the half already covered. | During cutover, register on the live landing page. Observe the guest appear in the queue with their real name, be dispatched, and reach the slideshow. Record the ticket code and the timestamps. | **Executed live, 2026-08-12.** Ticket `3X818VEJ` ("Phase6 Cutover", a deliberately synthetic RFC 2606 identity) registered via `POST /api/v1/public/register/pubstomp/E3tWSX9D` → HTTP 200. Confirmed hop-by-hop through `ets_web`, the VIEW (9→10 rows), the poller (`DB poller ingested 3X818VEJ`), the local store, and the queue (`status=queued, retries=0`), under the guest's own captured name via D-04's **top** fallback rung (`personalinfo_name`). **Declined-with-named-blocker** for the Agent/booth/slideshow legs: no Agent connected (Phase 3 Agent-auth cutover undeployed) — `Skipping dispatch: Agent not connected (job 3X818VEJ stays queued)`, zero cost to the job. Full hop-by-hop record: `06-06-SUMMARY.md`. **Standing operator action required:** this test job cannot be cancelled upstream (`ets_web`'s `cancel_order()` requires `PENDING`; this order is `completed`) and must be marked `failed` by hand before an Agent ever connects — see OPS-RUNBOOK §10. |
| The VIEW returns exactly one row per ticket | D-03 | No fixture can stand in for `ets_web`, and the multi-session case that would duplicate a guest cannot be constructed without writing to `ets_web` — which the human's constraint forbids absolutely. | Read-only, safe to repeat: compare `SELECT COUNT(*) FROM photobooth.registrations` against `COUNT(DISTINCT t.id)` computed directly over the same `ets_web` filter. Run at cutover and on a schedule beside the health probe. | **Confirmed-as-recorded, and re-measured.** Plan 06-05's live result (`COUNT(*)=COUNT(DISTINCT id)=9`) stood; independently re-queried live during this plan's checkpoint resolution after the D-07 registration landed: `COUNT(*)=COUNT(DISTINCT id)=COUNT(DISTINCT registered_at)=10`. Dedup holds with the tenth row added. |
| Service DB credentials read `ets_web` and cannot write to it | M6-4 | Grants are server state, not repository state. | `SHOW GRANTS FOR '<service user>'@'<host>'` — assert `SELECT` appears and no write privilege does. Then attempt one write against `ets_web` and confirm it is refused. | **Confirmed-as-recorded.** Plan 06-05's `SHOW GRANTS` (`GRANT USAGE ON *.*`, `GRANT SELECT ON photobooth.*` only) and the deliberate refused `INSERT` (`ERROR 1142` / `ERROR 1471`) stand unchanged — no grant activity occurred anywhere in this plan; the D-07 registration went through the public API, not through any elevated database credential. |
| Name fallback chain produces the right rung for each input shape | D-04, D-05 | The chain's logic is testable as a pure SQL expression, but only against a dataset that must not live in anything named `ets_web` — a same-named throwaway schema would be indistinguishable from a constraint violation in an audit. | Run the fallback expression read-only over the live `ets_web` rows and confirm each of the 9 currently-valid tickets resolves to the expected rung. Confirm the `warn` log fires for the 4 rows with no `first_name`/`last_name`. | **Confirmed-as-recorded, and extended.** The original 9 rows' distribution (`customer_username=4, personalinfo_display_name=4, personalinfo_name=1`) stood unchanged; the D-07 registration is only the **second** row ever to reach `personalinfo_name` — the top rung — proving that rung against a live guest for the first time (live distribution is now `customer_username=4, personalinfo_display_name=4, personalinfo_name=2`). |
| Cancelled / unpaid registrations are structurally excluded | M6-2 | This is a source-code proof about a codebase this project cannot modify or watch. The health probe detects schema breakage, **not** business-logic regressions upstream. | Already performed by research: `ticketing/models.py:155-259` and `ticketing/admin.py:794-836` both gate cancellation on `PENDING`. Re-verify only if `ets_web` receives a deploy before this phase executes. | **Confirmed-as-recorded, with a shelf-life caveat.** `ets_web`'s `apps/ticketing/api.py` was independently confirmed to have been mid-edit by an unrelated party during the D-07 proof (mtime `2026-08-12 02:01:24`, minutes before the proof ran) — `ets_web` is under active, out-of-band development. This source-code proof should be treated as time-boxed and re-verified if a deploy lands before a real event, not as a permanent guarantee. |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or a Wave 0 dependency
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 60s
- [x] Every Manual-Only row executed and its outcome recorded — a skipped row is a `human_needed`, never a silent pass. All five rows above are recorded; none is a silent pass. Four are fully green; the fifth (D-07) is green for its literal claim (reaches the booth queue) with the Agent/booth/slideshow legs explicitly declined-with-named-blocker, not silently closed.
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** 2026-08-12 — resolved via the Task 3 checkpoint. OPS-RUNBOOK §10 and the §3/§7 extensions approved as written. The ING-03 `unclassified` edge-probe row's recorded reading (the cursor-format hazard, closed by D-06's `DATE_FORMAT(NOW(6), ...)` seed) confirmed. `WINDOWS.md` item 6 needed no action — already `fixed` (closed by 06-03's rate limiter; `fixed_count: 4`, `open_count: 1`, confirmed by direct read of `WINDOWS.md`).

**Overall phase verification: `human_needed`, not a blanket `passed`.** Six of the seven ROADMAP criteria (2-7) are proven fully by measurement. Criterion 1, as literally written ("reaches the booth queue"), is proven live. D-07's fuller original framing — the complete landing-page-to-slideshow chain — is **not** fully proven: the queue → Agent → booth → slideshow legs remain unverified, blocked on the still-undeployed Phase 3 Agent-auth cutover, a prerequisite outside this plan's own scope. This is named explicitly rather than closed silently, per this project's Phase 5 precedent.
