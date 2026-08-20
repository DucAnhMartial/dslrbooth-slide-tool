---
phase: 01-foundation-ingestion
plan: 05
subsystem: api
tags: [winston, logging, pii-masking, vitest, supertest, hardening, ops-docs]

# Dependency graph
requires:
  - phase: 01-foundation-ingestion (plan 01-01)
    provides: "webhookAuth.ts HMAC verification, MirrorReceiverOptions, buildCanonicalString() isolation point"
  - phase: 01-foundation-ingestion (plan 01-04)
    provides: "Complete /on-register handler (HMAC + IP allow-list + timestamp/replay + time-windowed dedup ladder), stable log call sites to audit"
provides:
  - "debugRawPayload(label, payload) in logger.ts — the single sanctioned, D-16-gated route from a raw Mirror Request payload to any log sink"
  - "Audited /on-register log surface: every logger.* call in mirrorReceiver.ts is a plain string naming only id/ip/status/reason, proven by mask(msg) === msg over a real request carrying an email and phone"
  - "test/logging-mask.test.ts (10 cases) — the phase's only automated proof of D-15/D-16"
  - "mirror-request/docs/OPS-RUNBOOK.md — published webhook signing contract, retention posture, and production env-var requirements for an operator/sender-author who never reads .planning/"
  - "Phase 1 closed: all four Task 3 checkpoint questions resolved by a human (canonical string, D-02 reading, production readiness, D-14 retention)"
affects: []

# Actuals (#2632)
actuals:
  tokens: 3335
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "debugRawPayload() mirrors the existing NODE_ENV!=='production' console-transport gate (logger.ts:58-60), extended with a second AND'd condition (DEBUG set) — no new gating primitive introduced"
    - "Raw-payload debug echo is additive and placed immediately after the existing saveRawPayload() call, strictly on the new-registration path — never reachable from the duplicate/403/400 branches"
    - "Test ids are sanitized (digit runs broken up) before being used in log-surface assertions, because a raw randomUUID() can coincidentally contain a 7+-digit run that the pre-existing PHONE_RE would treat as a phone number — a latent false-positive in mask() that this plan was explicitly told not to touch (task 1: 'do not change the existing regexes')"
    - "Integration contracts that this repository cannot verify unilaterally (the HMAC signing format) get published as an ops runbook inside the shipped repo, not left as an internal .planning/ assumption — a future sender author has somewhere real to look"

key-files:
  created:
    - mirror-request/docs/OPS-RUNBOOK.md
  modified:
    - mirror-request/src/logging/logger.ts
    - mirror-request/src/ingestion/mirrorReceiver.ts
    - mirror-request/test/logging-mask.test.ts

key-decisions:
  - "debugRawPayload() takes a payload string, never an object, and its doc comment states this explicitly — the printf formatters in logger.ts only run mask() for typeof message === 'string', so this is the one invariant that keeps the gate meaningful (RESEARCH.md Pitfall 6)"
  - "Audited every logger.* call in mirrorReceiver.ts against D-15 and found no PII interpolation already present — no log line needed rewriting, only the new debugRawPayload() call was additive"
  - "Test payload email/phone are derived per-call from a unique id rather than a shared literal (e.g. alice@example.com), because the three /on-register log surface cases share the LocalStore singleton and run inside the same 5-minute dedupWindowMs — a shared literal would trip 01-04's contact-detail dedup fallback and silently turn a 'new registration' assertion into a 'duplicate' one (same class of issue documented in 01-04-SUMMARY.md's Deviations)"
  - "Test ids strip consecutive digit runs from randomUUID() output before use, to avoid a pre-existing PHONE_RE false-positive on id-carrying log lines discovered while writing this plan's own tests — documented here and in Deviations below, not fixed in mask()/PHONE_RE per task 1's explicit instruction not to touch the existing regexes"
  - "TASK 3 RESOLUTION 1 (HMAC canonical string): NO CODE CHANGE. Mirror Request has no signer implemented yet (confirmed by grepping the wider workspace for createHmac/hmac/X-Webhook-Signature — nothing found outside this service). The human adopted this service's already-implemented format — `HMAC-SHA256_hex(secret, timestamp.webhookId.rawBodyUtf8)`, timestamp in epoch milliseconds — as the authoritative published contract, now documented in mirror-request/docs/OPS-RUNBOOK.md for whoever builds the sender."
  - "TASK 3 RESOLUTION 2 (D-02 identity fallback): NO CODE CHANGE. The human confirmed the 'id-match-absent' reading already implemented in plan 01-04 is correct — id stays hard-required (400 if missing), email/phone fallback only catches a resubmission arriving with a freshly-minted id. The 'id-field-absent' alternative was explicitly rejected as a future, separate decision if ever wanted."
  - "TASK 3 RESOLUTION 3 (production readiness): confirmed by the human — real WEBHOOK_HMAC_SECRET and PROXY_IP_WHITELIST will be set in the production .env/PM2 environment before the next deploy. The existing fail-fast-on-boot validation in config.ts stays exactly as implemented; no dry-run was executed since it would require real production secrets this executor does not have and should not invent."
  - "TASK 3 RESOLUTION 4 (D-14 manual retention): acknowledged by the human — registration (incl. email/phone/raw_payload), webhook_replay, processed_id and queue_job all grow unbounded by design; pruning is an explicit operator responsibility. Documented in mirror-request/docs/OPS-RUNBOOK.md §2, per the human's explicit request for an ops-runbook home."

requirements-completed: [AUTH-03, ING-01]

coverage:
  - id: D1
    description: "debugRawPayload() emits nothing when NODE_ENV is production (even with DEBUG set), nothing when DEBUG is unset (whatever NODE_ENV is), and exactly one logger.debug call with a string message when NODE_ENV is not production AND DEBUG is set"
    requirement: "AUTH-03"
    verification:
      - kind: unit
        ref: "test/logging-mask.test.ts#debugRawPayload gating (D-16) (3 cases)"
        status: pass
    human_judgment: false
  - id: D2
    description: "mask() correctly redacts an email to [EMAIL REDACTED] and a phone number to asterisks of the same length, and leaves ordinary ingestion log text unchanged"
    requirement: "AUTH-03"
    verification:
      - kind: unit
        ref: "test/logging-mask.test.ts#mask (3 cases)"
        status: pass
    human_judgment: false
  - id: D3
    description: "A real signed /on-register request carrying an email and phone number produces only log messages that mask() leaves unchanged (i.e. none of them contained PII to begin with); under NODE_ENV=production no message contains the payload JSON even with DEBUG set, yet raw_payload is still stored; under NODE_ENV=test+DEBUG=1 exactly one debug message contains the payload JSON"
    requirement: "ING-01"
    verification:
      - kind: integration
        ref: "test/logging-mask.test.ts#/on-register log surface (4 cases, supertest against the real Express router)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Full existing Vitest suite does not regress alongside the new test cases; typecheck and build stay clean"
    verification:
      - kind: integration
        ref: "npm test (11 files, 69 tests, all pass — verified across multiple full-suite runs) and npm run typecheck / npm run build (both exit 0)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Task 3 (checkpoint:human-verify): confirm the HMAC canonical string against Mirror Request's real signer, confirm the D-02 identity-fallback reading, confirm production allow-list strictness, and acknowledge D-14 manual retention"
    requirement: "AUTH-03"
    verification:
      - kind: manual_procedural
        ref: "Human confirmed all four points explicitly; resolutions recorded above (key-decisions) and in mirror-request/docs/OPS-RUNBOOK.md. See 'Checkpoint Resolution' section below for full detail."
        status: pass
    human_judgment: true

duration: 15min
completed: 2026-08-10
status: complete
---

# Phase 1 Plan 5: PII-Safe Logging + Phase-Closing Checkpoint Summary

**One gated, tested route (`debugRawPayload()`) from a raw Mirror Request payload to a log sink, an audited `/on-register` log surface proven PII-free by `mask(msg) === msg` over a real signed request, a published ops runbook carrying the webhook signing contract and retention posture, and all four Task 3 checkpoint questions resolved by a human — Phase 1 is closed.**

## Performance

- **Duration:** ~15 min (Tasks 1-2: ~9 min; Task 3 + close-out: ~6 min)
- **Started:** 2026-08-10T08:46:02Z (following the pre-existing `e54e22e` fix)
- **Completed:** 2026-08-10T09:10:00Z (approx.)
- **Tasks:** 3/3
- **Files modified:** 4 (2 modified, 2 created — `test/logging-mask.test.ts` and `docs/OPS-RUNBOOK.md`)

## Accomplishments

- Added `debugRawPayload(label, payload)` to `src/logging/logger.ts`: returns immediately unless `NODE_ENV !== 'production' && Boolean(process.env.DEBUG)`, then calls `logger.debug(`[raw:${label}] ${payload}`)` — a plain template string, never the payload object, so it can never bypass the transport-level `mask()` that the printf formatters already apply to every string message. Doc comment states it is the only sanctioned route from a raw payload to a log sink and that D-13's retention lives in SQLite, not logs.
- Audited every `logger.*` call site in `src/ingestion/mirrorReceiver.ts`: all five existing calls already pass plain interpolated strings naming only `id`, `ip`, and a status/reason word — none interpolate `name`, `email`, `phone`, or the parsed body. No rewrite was needed.
- Wired `debugRawPayload('on-register', JSON.stringify(req.body))` immediately after the existing `store.saveRawPayload(...)` call, on the new-registration path only — never on the duplicate, 403, or 400 paths.
- New `test/logging-mask.test.ts` (10 cases): 3 for `mask()` itself, 3 for `debugRawPayload()`'s three gate combinations, and 4 for the `/on-register` HTTP-level log surface (drives a real signed request with an email and phone number through `supertest`, spies on `logger.info`/`warn`/`debug`, and asserts `mask(msg) === msg` for every captured message; repeats under `NODE_ENV=production` with `DEBUG=1` asserting no message contains the payload JSON while `raw_payload` is still stored; repeats under `NODE_ENV=test` + `DEBUG=1` asserting exactly one message does).
- Ran a live `npm run dev` smoke test: the service booted, logged `Extension Service ready on 0.0.0.0:3002`, and the real `data/extension-service.sqlite` gained all seven expected tables (`registration`, `queue_job`, `processed_id`, `db_poll_cursor`, `booth_state`, `notification_record`, `webhook_replay`) on that boot.
- Created `mirror-request/docs/OPS-RUNBOOK.md`: the published webhook signing contract (exact canonical string, digest/encoding, timestamp unit, headers, freshness/replay rules), the unbounded-growth retention posture (which tables, what an operator is expected to prune, and that logs are masked but the DB is not), and the production env vars that must be set or the service refuses to boot — written for an operator or sender-author who has never read `.planning/`.
- Resolved Task 3's checkpoint with the human: all four points confirmed, no code changes required to `webhookAuth.ts` or the D-02 validation logic — both were already correct as built by 01-01/01-04.
- Marked `AUTH-03` and `ING-01` complete in `REQUIREMENTS.md`; corrected the pre-existing traceability-table bookkeeping error (the grouped `AUTH-01..03, ING-01..03 | 1` row incorrectly implied AUTH-01 belongs to Phase 1 — split into `AUTH-01 | 3` and `AUTH-02..03, ING-01..03 | 1 | Complete`, consistent with ROADMAP.md's own documented correction).
- Full suite (11 files, 69 tests) verified green across multiple runs, both before and after the Task 3 documentation commit; `npm run typecheck` and `npm run build` both exit 0.

## Task Commits

1. **Task 1: One gated route from a raw payload to a log sink** — `c65e4a8` (feat, tdd)
2. **Task 2: Audit every /on-register log line for PII, and route raw-payload debugging through the gate** — `22cdb94` (feat, tdd)
3. **Task 3: Confirm the three Phase 1 integration assumptions and the retention posture** — `5cf3ec1` (docs — ops runbook + checkpoint resolution, no `webhookAuth.ts`/`mirrorReceiver.ts` code change needed)

_Note: as in plans 01-01 through 01-04, each `tdd="true"` task's behavior was implemented and verified together with its tests in a single commit per task, not as separate RED/GREEN commits._

## Files Created/Modified

- `mirror-request/src/logging/logger.ts` — new `debugRawPayload()` export, no changes to `mask()`, the existing regexes, or the transports
- `mirror-request/src/ingestion/mirrorReceiver.ts` — one additive `debugRawPayload(...)` call on the new-registration path; no log message content changed
- `mirror-request/test/logging-mask.test.ts` — NEW: 10 cases across three `describe` blocks (`mask`, `debugRawPayload gating (D-16)`, `/on-register log surface`)
- `mirror-request/docs/OPS-RUNBOOK.md` — NEW: webhook signing contract, retention posture, production env-var requirements

## Checkpoint Resolution (Task 3)

The human answered all four checkpoint questions:

1. **HMAC canonical string** — confirmed as-is, no code change. Mirror Request has no signer built yet (workspace-wide grep for `createHmac`/`hmac`/`X-Webhook-Signature` outside this service found nothing), so this service's already-implemented format (`timestamp.webhookId.rawBody`, HMAC-SHA256, hex, timestamp in epoch ms) becomes the authoritative contract. Published in `docs/OPS-RUNBOOK.md` §1.
2. **D-02 identity fallback** — confirmed as-is, no code change. "Absent" means an id *match* is absent, not the id *field* — exactly what plan 01-04 built. The alternative (relaxing `id` to optional) was explicitly rejected as a future, separate decision.
3. **Production readiness** — confirmed by the human that `WEBHOOK_HMAC_SECRET` and `PROXY_IP_WHITELIST` will carry real values before the next deploy; the existing fail-fast-on-boot validation stays unchanged. The dry-run verification command was intentionally not executed by this executor (it requires real production secrets not available or appropriate to invent in this session).
4. **D-14 manual retention** — acknowledged. Documented in `docs/OPS-RUNBOOK.md` §2 at the human's explicit request for an ops-runbook home.

## Decisions Made

- No architectural or behavioral change was needed to satisfy D-15 for the receiver's existing log lines — the audit found them already compliant. All of this plan's D-15/D-16 work was additive (`debugRawPayload()` + one call site) or test-only.
- Test payload contact details are derived per-call from a unique id rather than a shared literal, to avoid tripping 01-04's dedup fallback across the three `/on-register log surface` cases (they share the process-wide `LocalStore` singleton and all run inside the default 5-minute dedup window).
- Test ids strip consecutive digit runs from `randomUUID()` output before use in log-surface assertions (see Deviations) rather than touching `mask()`'s `PHONE_RE`, per task 1's explicit instruction not to change the existing regexes.
- Task 3 required no source-code change at all — both open questions (HMAC format, D-02 reading) resolved in favor of what was already implemented in 01-01/01-04. The only new artifact is documentation (`docs/OPS-RUNBOOK.md`), placed inside the git repo per the human's explicit instruction so it ships with the code rather than being stranded in `.planning/`.
- The pre-existing traceability-table bookkeeping error in `REQUIREMENTS.md` (grouping `AUTH-01..03` under Phase 1, when AUTH-01 is Phase 3's Agent-WS-token requirement — already flagged as a known error in `ROADMAP.md`'s Phase 1 note) was corrected while marking AUTH-02/AUTH-03/ING-01..03 complete, splitting the row so the table is now accurate rather than perpetuating the documented error.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug, scoped to this plan's own new tests] Shared literal contact details in test payloads collided with 01-04's dedup fallback**
- **Found during:** Task 2, first `npx vitest run test/logging-mask.test.ts` after writing the `/on-register log surface` describe block using a hardcoded `alice@example.com` / `0900000000` payload (as the plan's action step literally illustrates)
- **Issue:** All three cases in that block share the process-wide `LocalStore` singleton and run inside the default 5-minute `dedupWindowMs`. The second and third calls, sharing the same literal email/phone as the first, were classified as duplicates by `findDuplicateRegistration()` — `{duplicate:true, jobId:<first test's id>}` — so `upsertRegistration`/`saveRawPayload`/`debugRawPayload` never ran for those calls, and the `raw_payload`/debug-echo assertions failed.
- **Fix:** `payloadWithPii(id)` now derives `email` from the already-unique `id` (`` `${id}@example.com` ``) and generates a random 10-digit `phone` per call, so no two calls across the file share contact details, while both values still match `EMAIL_RE`/`PHONE_RE` for the masking assertions.
- **Files modified:** `mirror-request/test/logging-mask.test.ts`
- **Verification:** `npx vitest run test/logging-mask.test.ts` — 10/10 pass, repeated across 5 consecutive runs.
- **Committed in:** `22cdb94` (Task 2 commit)

**2. [Rule 1 - Bug, test-only, mask() left untouched per plan instruction] `randomUUID()` ids occasionally trip the pre-existing `PHONE_RE` false-positive**
- **Found during:** Task 2, same test run — `mask(msg) === msg` failed once because the log line `"Ingested registration 30ff68a4-...-a682994475cc from ..."` contained a 9-digit run (`682994475`) inside the UUID, which `PHONE_RE` (`\+?\d{7,}`) matched and replaced with asterisks, changing the message.
- **Issue:** This is a latent, pre-existing property of `PHONE_RE` — any string containing 7+ consecutive digits gets treated as a phone number, including digit runs that occur by chance inside a UUID-shaped id. It is not caused by this plan's new code and task 1 explicitly instructed "do not change the existing regexes," so it was not fixed in `mask()`.
- **Fix (test-only):** Added a `safeId()` helper in the new describe block that breaks up any digit run in a `randomUUID()` output (`.replace(/(\d)(?=\d)/g, '$1x')`) before using it as the payload `id`, so the log-surface tests are deterministic without touching production masking logic.
- **Files modified:** `mirror-request/test/logging-mask.test.ts`
- **Verification:** `npx vitest run test/logging-mask.test.ts` — 10/10 pass, repeated across 5 consecutive runs (no further flakes observed).
- **Committed in:** `22cdb94` (Task 2 commit)
- **Not fixed (deliberately out of scope):** `PHONE_RE`'s false-positive on digit runs inside real (non-test) UUIDs remains live in production code. If Mirror Request's real `id` values are UUID-shaped (or otherwise likely to contain long digit runs), the `"Ingested registration <id> from <ip>"` log line will occasionally have its `id` partially asterisk-masked, which is cosmetically confusing (though not a security issue — it under-shows information, it doesn't leak any). Logged to `.planning/WINDOWS.md` for visibility; a future phase could scope `PHONE_RE` to require a leading delimiter/prefix or a maximum length, or use a smarter phone-number heuristic.

---

**Total deviations:** 2 auto-fixed (both confined to this plan's own new test file, both documented above and consistent with the SCOPE BOUNDARY / "only auto-fix issues directly caused by the current task's changes" rule — deviation 2's root cause is pre-existing and explicitly deferred, not fixed).
**Impact on plan:** None on shipped behavior — both deviations are test-file-only changes. Deviation 2 surfaces a genuine (if minor) pre-existing quirk worth a human's attention at some point, logged rather than silently fixed given the plan's explicit "do not change the existing regexes" instruction for task 1.

## Issues Encountered

**Acceptance-criteria grep for `debugRawPayload` is not literally satisfiable at value 1 (documented, not a defect — same class of gap as 01-04's `dedupWindowMs` grep).** Task 2's acceptance criteria state `grep -c 'debugRawPayload' mirror-request/src/ingestion/mirrorReceiver.ts` should output `1`. Referencing an imported function necessarily requires both an `import { debugRawPayload } from '../logging/logger'` line and a call site — two matching lines, not one — the literal count is unavoidably `2`. The behavioral intent (a single call site, wired correctly, additive and gated) is fully satisfied; the literal grep count cannot reach `1` without either omitting the import (breaks compilation) or omitting the call (breaks the task). All other acceptance-criteria greps for this plan pass exactly as specified.

**Could not add a pointer near `WEBHOOK_HMAC_SECRET` in `.env.example`.** This sandbox environment denies all `Read`/`Bash` access to any `.env*`-matching file path, including `.env.example` (which contains no secrets, only variable names/placeholders). The human's request was "the ops runbook ... is a reasonable home, and `.env.example` near `WEBHOOK_HMAC_SECRET` deserves at least a pointer" — the primary request (the runbook) is fully satisfied; the secondary `.env.example` pointer could not be added in this session due to a tooling/permissions restriction, not a decision to skip it. **Follow-up for the human or a future session with `.env` file access:** add a one-line comment above `WEBHOOK_HMAC_SECRET=` in `mirror-request/.env.example` pointing to `docs/OPS-RUNBOOK.md`.

## Known Stubs

None.

## Threat Flags

None — the new surface (`debugRawPayload()`, its single call site in `mirrorReceiver.ts`, `docs/OPS-RUNBOOK.md`) matches the plan's `<threat_model>` register (T-01-28 through T-01-32, T-01-SC) exactly; no new unplanned surface was introduced. T-01-31 (unbounded retention) and T-01-32 (signature format mismatch) are both explicitly addressed by Task 3's human-confirmed resolution and now documented in the ops runbook.

## User Setup Required

None remaining for this plan — Task 3's checkpoint (the "user setup" this plan surfaced) has been fully answered by the human. See "Checkpoint Resolution" above. One small follow-up item (the `.env.example` pointer, see "Issues Encountered") is deferred to whoever next has `.env*` file access.

## Next Phase Readiness

- **Phase 1 (Foundation & Ingestion) is complete.** All six Phase 1 requirements (`ING-01`, `ING-02`, `ING-03`, `STO-01`, `AUTH-02`, `AUTH-03`) are marked complete in `REQUIREMENTS.md`. `ROADMAP.md`'s Phase 1 entry shows 5/5 plans executed.
- The webhook signing contract is now a published, discoverable artifact (`mirror-request/docs/OPS-RUNBOOK.md`) — whoever builds the Mirror Request sender has an authoritative reference that doesn't require reading `.planning/`.
- The pre-existing `PHONE_RE` false-positive on digit runs inside UUID-shaped ids (see Deviations #2) is logged to `.planning/WINDOWS.md` as a minor, non-blocking cosmetic issue for a future phase to consider.
- The `.env.example` pointer follow-up (see Issues Encountered) is a one-line documentation addition, not a blocker for Phase 2.

---
*Phase: 01-foundation-ingestion*
*Completed: 2026-08-10*

## Self-Check: PASSED

All created/modified files found on disk (`src/logging/logger.ts`, `src/ingestion/mirrorReceiver.ts`, `test/logging-mask.test.ts`, `docs/OPS-RUNBOOK.md`). All three task commits (`c65e4a8`, `22cdb94`, `5cf3ec1`) found in `git log`. `npm test` (11 files, 69 tests), `npm run typecheck`, and `npm run build` all verified passing at the time of writing. `REQUIREMENTS.md` confirmed to show `AUTH-03` and `ING-01` as `[x]`. SUMMARY.md itself confirmed present at its expected path (`.planning/phases/01-foundation-ingestion/01-05-SUMMARY.md`).
