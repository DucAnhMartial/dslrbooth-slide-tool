---
phase: 8
slug: cms-event-display
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-08-12
updated: 2026-08-12
---

# Phase 8 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest ^2.1.4 (mirror-request); vitest (dslrbooth-agent, minimal harness — 1 file / 4 tests from Phase 3) |
| **Config file** | mirror-request/vitest.config.ts (sets LOCAL_STORE_PATH to a test DB; plan 08-01 Task 1 adds the four new CMS keys to its `env` block — without that, `loadConfig()` throws and the entire suite fails) |
| **Quick run command** | `npx vitest run <changed test file>` (in mirror-request/) |
| **Full suite command** | `npm test` (in mirror-request/); `npm test` (in dslrbooth-agent/ when Agent-side tasks change it) |
| **Estimated runtime** | ~12 seconds (mirror-request full suite at 43 files / 448 tests baseline) |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run <the plan's named test file(s)>`
- **After every plan wave:** Run `npm test` (full suite) + `npm run typecheck` + `npm run build`
- **Before `/gsd-verify-work`:** Full suite must be green in BOTH repos touched
- **Max feedback latency:** ~60 seconds

---

## Per-Task Verification Map

*Backfilled by plan-phase 2026-08-12 from the six PLAN files. No REQ-ID column mapping exists in
this project — rows map to phase requirements UI-01, UI-02, CMS-01..CMS-05 and CONTEXT decisions
D-01..D-18. Every row's automated command is the task's own `<verify><automated>`.*

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 08-01-T1 | 08-01 | 1 | CMS-02, CMS-04 (D-01, D-12, D-13, D-14) | T-08-01, T-08-02, T-08-04, T-08-05, T-08-06 | IP gate mounted before session gate; scrypt N=2^14 + timingSafeEqual; HttpOnly + SameSite=Lax, no Secure (no TLS) | integration (supertest + live WS) | `cd mirror-request && npx vitest run test/cms-event-tracer.test.ts` | ❌ new | ⬜ pending |
| 08-01-T2 | 08-01 | 1 | CMS-03 (D-10, D-11, D-18) | — | Additive-only migration; no automatic delete path for photo history | unit (real temp-file SQLite) | `cd mirror-request && npx vitest run test/local-store-persistence.test.ts` | ⚠️ extend existing | ⬜ pending |
| 08-01-T3 | 08-01 | 1 | CMS-04, CMS-05 (D-13, D-15) | T-08-02, T-08-03, T-08-06, T-08-07 | Two gate layers independently observable; path.basename + fixed Content-Type allow-list; offline password hashing | integration (supertest) | `cd mirror-request && npx vitest run test/cms-access-control.test.ts` | ❌ new | ⬜ pending |
| 08-02-T1 | 08-02 | 2 | CMS-01 (D-04, D-09, D-10) | T-08-08, T-08-09 | Guest names logged only as masked template strings; snapshot carries a projection, never a raw row | unit (mocked-store service harness) | `cd mirror-request && npx vitest run test/queue-event-photo.test.ts test/display-hero-moment.test.ts` | ❌ new | ⬜ pending |
| 08-02-T2 | 08-02 | 2 | UI-01, CMS-01 (D-07, D-12) | T-08-11, T-08-12 | Operational status colors fixed and non-themeable; render-time bounds on slideshow and sidebar | integration (supertest + live WS) | `cd mirror-request && npx vitest run test/display-idle-default.test.ts test/display-room-screen.test.ts` | ❌ new | ⬜ pending |
| 08-02-T3 | 08-02 | 2 | UI-01, CMS-01 | T-08-SC | Fonts self-hosted and committed; zero CDN or external font link at render time | integration (supertest) | `cd mirror-request && npx vitest run test/display-room-screen.test.ts -t "font"` | ❌ new | ⬜ pending |
| 08-03-T1 | 08-03 | 2 | CMS-01, CMS-05 (D-15) | T-08-13, T-08-14, T-08-15, T-08-16 | Magic-byte sniff over four signatures; server-minted filename; size cap before write; auth required | unit + integration (fixture-driven) | `cd mirror-request && npx vitest run test/cms-upload-validation.test.ts` | ❌ new | ⬜ pending |
| 08-03-T2 | 08-03 | 2 | CMS-01 | T-08-17 | Server-side length caps and enumerated-value validation on every configurable field | integration (supertest) | `cd mirror-request && npx vitest run test/cms-event-config.test.ts` | ❌ new | ⬜ pending |
| 08-03-T3 | 08-03 | 2 | CMS-02 (D-02, D-03, D-11, D-12) | T-08-18 | Active-event switch writes only the pointer; queue_job and booth_state proven byte-identical | integration (supertest + live WS) | `cd mirror-request && npx vitest run test/cms-active-event-switch.test.ts` | ❌ new | ⬜ pending |
| 08-04-T1 | 08-04 | 3 | UI-02 (D-16, D-17) | T-08-19, T-08-23 | config_request is a request only — inbound fields ignored; bearer-token upgrade path untouched | unit (both repos, mocked ws) | `cd mirror-request && npx vitest run test/agent-config-message.test.ts && cd ../dslrbooth-agent && npx vitest run test/config-reload.test.ts` | ❌ new (both repos) | ⬜ pending |
| 08-04-T2 | 08-04 | 3 | UI-02 (D-16) | T-08-20, T-08-21, T-08-24 | Safe-field allow-list enforced independently on each side; four forbidden fields ignored and warned per side | unit (both repos) | `cd dslrbooth-agent && npx vitest run test/config-reload.test.ts && cd ../mirror-request && npx vitest run test/agent-config-message.test.ts` | ❌ new (both repos) | ⬜ pending |
| 08-04-T3 | 08-04 | 3 | UI-02, CMS-03, CMS-04 (D-18) | T-08-22 | dslrBooth password never echoed into HTML or logs; save rejects non-safe fields server-side | integration (supertest) | `cd mirror-request && npx vitest run test/cms-agent-config.test.ts` | ❌ new | ⬜ pending |
| 08-05-T1 | 08-05 | 4 | CMS-01, CMS-03, CMS-04 (D-10) | T-08-25, T-08-27, T-08-28, T-08-29 | Reads through store projection; per-event scoping; PII masked; both gate layers enforced | integration (supertest + temp-file store) | `cd mirror-request && npx vitest run test/cms-photo-history.test.ts` | ❌ new | ⬜ pending |
| 08-05-T2 | 08-05 | 4 | CMS-01 (D-11) | T-08-26 | Deletion only behind typed confirmation and both auth layers; no timer, cap, or scheduled cleanup anywhere | integration (supertest) | `cd mirror-request && npx vitest run test/cms-photo-history.test.ts -t "clear"` | ❌ new | ⬜ pending |
| 08-06-T1 | 08-06 | 5 | UI-01, UI-02, CMS-01..CMS-05 | T-08-34 | Whole replacement path proven before the physical cutover is requested; queue/booth schemas proven untouched | integration (end-to-end against shipped wiring) | `cd mirror-request && npx vitest run test/phase8-cutover-readiness.test.ts` | ❌ new | ⬜ pending |
| 08-06-T2 | 08-06 | 5 | CMS-04, CMS-05 (D-04, D-05, D-06, D-08) | T-08-31, T-08-32, T-08-33 | No real credential in .env.example; every quoted log string grep-verified against src/; no-TLS posture documented | doc verification (grep gates) | `cd mirror-request && grep -c "^## 12\." docs/OPS-RUNBOOK.md && grep -c "CMS_IP_WHITELIST" .env.example docs/OPS-RUNBOOK.md && grep -ci "retired" ../web-slide/README.md` | ⚠️ extend existing | ⬜ pending |
| 08-06-T3 | 08-06 | 5 | UI-01, CMS-02 (D-05, D-06) | T-08-30 | Retired web-slide's supervision identified and stopped so it cannot auto-restart | manual (blocking checkpoint:human-verify) | MANUAL — see Manual-Only Verifications below | n/a | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] None expected — vitest infrastructure exists in both repos. The dslrbooth-agent harness
  is minimal (1 file / 4 tests) but functional; Agent-side tasks add test files, not
  infrastructure.

**One infrastructure precondition, owned by 08-01 Task 1 rather than a Wave 0 plan:** the four new
`required()` config keys must be added to `mirror-request/vitest.config.ts`'s `env` block in the
same commit that adds them to `config.ts`. Splitting those two edits across commits leaves the
whole 448-test suite red at `loadConfig()`.

*Existing infrastructure otherwise covers all phase requirements.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| D-06 hard cutover: web-slide's supervision identified and stopped, TV URLs changed | CMS-02 / D-05, D-06 | Requires the physical TVs and knowledge of web-slide's production process supervision (unknown from source — RESEARCH Open Q2, Assumption A5) | Plan 08-06 Task 3, blocking `checkpoint:human-verify`, steps 1-3: name the supervisor, stop it, confirm the old URL is dead, re-point each TV to the room-screen route, confirm each renders the idle screen |
| Room screen looks right on a real TV (fluid clamp() at TV distance, Vietnamese diacritics at hero size) | UI-01 | Visual judgment at physical viewing distance | Plan 08-06 Task 3, step 4: stand where guests stand; idle heading legible from meters away; "nobody yet" clearly distinct from "broken" |
| A real capture producing a live hero moment on the venue TV | CMS-01 / D-09 | Requires a connected Agent and a real dslrBooth session | Plan 08-06 Task 3, step 5 (optional): run one capture, confirm the guest sees their own photo and name, then watch it join the slideshow |
| CMS save-in-flight disabled+spinner state (UI-SPEC backstop row) | CMS-01 | No explicit UI-state test authored; carried as a backstop truth in plan 08-03 | Verify-time evidence required — a held-out UI-state check or equivalent; abstains to `human_needed` rather than passing silently |
| Room screen initial-connect window never flashes unstyled/blank HTML (UI-SPEC backstop row) | UI-01 | Sub-second window normally invisible; no explicit test authored | Carried as a backstop truth in plan 08-02; verify-time evidence required, never a silent pass |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or a stated manual-only justification (16 of 17 tasks carry an automated command; 08-06-T3 is the single blocking human gate)
- [x] Sampling continuity: no 3 consecutive tasks without automated verify (the only manual task is the last task of the last plan)
- [x] Wave 0 covers all MISSING references (none needed; the one infrastructure precondition is owned inside 08-01 Task 1)
- [x] No watch-mode flags (`vitest run` everywhere, never `vitest` bare)
- [x] Feedback latency < 60s (full mirror-request suite ~12s; per-file runs are sub-second)
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
