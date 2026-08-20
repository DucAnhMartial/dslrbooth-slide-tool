---
phase: 3
slug: agent-websocket-link
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-08-10
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Populated from `03-RESEARCH.md` § Validation Architecture at plan-phase time, so the
> plan-checker sees a real contract rather than an unfilled template.

**This is the first phase whose validation spans two repositories.** The server repo has
a mature suite; the Agent repo has **no test infrastructure at all** — no framework, no
`test/` directory, no config. Standing that up is itself Wave 0 work.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework (server)** | Vitest ^2.1.4 (running 2.1.9) — `mirror-request/package.json:42` |
| **Framework (Agent)** | **None installed.** Wave 0 must add Vitest ^2.1.4 for toolchain consistency. |
| **Config file (server)** | `mirror-request/vitest.config.ts` — sets `AGENT_WS_TOKEN: 'test-agent-token'`, `LOG_LEVEL: 'error'`, and a test-only DB path |
| **Config file (Agent)** | Does not exist — Wave 0 creates `dslrbooth-agent/vitest.config.ts` |
| **Quick run (server)** | `cd mirror-request && npx vitest run test/<file>.test.ts` |
| **Quick run (Agent)** | `cd dslrbooth-agent && npx vitest run test/connection-auth.test.ts` (after Wave 0) |
| **Full suite (server)** | `cd mirror-request && npm test` — **measured: 16 files, 113 tests, 4.73 s wall** |
| **Full suite (Agent)** | Does not exist yet |
| **Max feedback latency** | 30 s |

### Isolation constraints — stricter than Phase 2's

Phase 2's rule stands: all test files share one test DB (`vitest.config.ts:12`) through
the `getStore()` singleton while vitest runs files in parallel, so **no test may call
`getStore()`**, assert on a global count, or depend on rows it did not create. Phase 2
achieved zero `getStore()` calls across every new test file; that bar holds.

**Phase 3 adds a second shared resource: the TCP port.** An `AgentServer` binds a real
port and holds process-global connection state, so two test files that each start one
can collide on the port *as well as* the store. Therefore:

- Every test that starts an `AgentServer` MUST bind an **ephemeral port** (`listen(0)`)
  and read the assigned port back, never a fixed number.
- Every such test MUST close its server and all client sockets in `afterEach`, or a
  leaked listener will poison later files in the same worker.
- Prefer a mocked `LocalStore` or a per-file temp DB via `constructor(dbPath?)`.

---

## Sampling Rate

- **After every task commit:** `npx vitest run <file>` for the file(s) touched, in whichever repo was touched
- **After every plan wave:** `cd mirror-request && npm test` (113 tests, ~4.7 s); plus `cd dslrbooth-agent && npm test` once Wave 0 establishes it
- **Before `/gsd-verify-work`:** full suite green in **both** repos
- **Max feedback latency:** 30 s

**Phase-gate addition, specific to this phase.** D-05 is a one-way contract change and
server + Agent must deploy together. The gate therefore includes a **cross-repo smoke
check** before any production cutover — see "Manual-Only Verifications".

---

## Per-Task Verification Map

Task IDs are assigned by the planner; keyed here by requirement and decision.

| Requirement / Decision | Behavior | Test Type | Automated Command | File Exists |
|---|---|---|---|---|
| AUTH-01 / D-05..D-08 | Missing, malformed or wrong `Authorization` header → **401 before handshake**; timing-safe compare; token never appears in any log line | unit (real `http.Server` on ephemeral port, real `ws` client, `'unexpected-response'` event) | `npx vitest run test/agent-auth.test.ts` | ❌ Wave 0 |
| AUTH-01 / D-06 | Valid `Authorization: Bearer <token>` → upgrade accepted | unit (same harness) | `npx vitest run test/agent-auth.test.ts` | ❌ Wave 0 |
| — (existing test) | `agent-websocket.test.ts` currently connects with an invalid **query-string** token and waits for `'upgrade'` — that event can never fire once D-06 lands. **Must be fixed, not merely extended.** | unit | `npx vitest run test/agent-websocket.test.ts` | ✅ exists — **breaks without repair** |
| AGT-01 / D-10 / D-11 | Second Agent displaces the first (last-wins); a `warn` names both agent ids | unit (two sequential real `ws` clients, one `AgentServer`) | `npx vitest run test/agent-replacement.test.ts` | ❌ Wave 0 |
| **AGT-02 (fifth gap)** | Dispatch payload includes `mode`, sourced from the job's registration — today it is omitted entirely and every session silently defaults to `'print'` | unit (mocked store returning a known `mode`; assert the exact object passed to `sendCommandCb`) | `npx vitest run test/queue-dispatch-mode.test.ts` | ❌ Wave 0 |
| AGT-02 / QUE-03 (regression) | `{type, action, jobId}` shape still correct after the `mode` fix | unit | `npx vitest run test/queue-countdown.test.ts` (extend) | ✅ exists — extend |
| D-02 / D-03 / D-04 | Agent offline → booth stays IDLE, job stays `queued`, **no retry increment**, log fires once per state change not every 250 ms tick; Agent back → normal tick dispatches | unit (mocked store + fake timers, connectivity flag toggled mid-test) | `npx vitest run test/queue-dispatch-connectivity.test.ts` | ❌ Wave 0 |
| D-02 (race) | Agent disconnects mid-`ANNOUNCING` countdown → `dispatchJob()`'s own guard reverts to IDLE with no retry charge | unit (flip connectivity between `beginAnnouncement()` and countdown elapse) | `npx vitest run test/queue-dispatch-connectivity.test.ts` | ❌ Wave 0 (same file) |
| D-12 / D-13 | Disconnect while BUSY → booth IDLE, requeue **without** incrementing `retries`, `queued_at` preserved; cannot double-fire with `busyTimer` in either trigger order | unit (mocked store + fake timers, both orders simulated) | `npx vitest run test/agent-disconnect-requeue.test.ts` | ❌ Wave 0 |
| AGT-04 / D-14 | All ten event types reach `onAgentEvent()` without throwing; the seven previously-unhandled types produce a log line rather than silence | unit (`vi.spyOn` on the logger method — required because `LOG_LEVEL=error` means real transports never emit `debug`) | `npx vitest run test/queue-event-coverage.test.ts` | ❌ Wave 0 |
| AGT-05 | No heartbeat for 30 s → `isAgentOnline()` false | unit (real client + real server; consider making the heartbeat interval an injectable constructor parameter, mirroring `startBusyTimer(jobId, timeoutMs?)`) | `npx vitest run test/agent-heartbeat-timeout.test.ts` | ❌ Wave 0 — **zero coverage today** |
| D-09 (Agent repo) | `WsConnection.connect()` sends the `Authorization` header and never a `?token=` query string | unit (spy the `ws` constructor; note `connection.ts` uses a static `import`, unlike `dbPoller.ts`'s lazy `require`, so plain `vi.mock('ws')` should work — **confirm before assuming**) | `cd dslrbooth-agent && npx vitest run test/connection-auth.test.ts` | ❌ Wave 0 — **and the framework itself does not exist** |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

**Server repo (`mirror-request/`):**
- [ ] `test/agent-auth.test.ts` — AUTH-01 / D-05..D-08
- [ ] `test/agent-websocket.test.ts` — **repair the existing file** so it stops depending on query-string auth and the `'upgrade'` event
- [ ] `test/agent-replacement.test.ts` — AGT-01 / D-10 / D-11
- [ ] `test/queue-dispatch-mode.test.ts` — the fifth gap (AGT-02's missing `mode`)
- [ ] `test/queue-dispatch-connectivity.test.ts` — D-02 / D-03 / D-04 incl. the mid-ANNOUNCING race
- [ ] `test/agent-disconnect-requeue.test.ts` — D-12 / D-13 incl. the no-double-fire race
- [ ] `test/queue-event-coverage.test.ts` — AGT-04 / D-14
- [ ] `test/agent-heartbeat-timeout.test.ts` — AGT-05

**Agent repo (`dslrbooth-agent/`) — infrastructure, not just tests:**
- [ ] `package.json` — add `vitest` devDependency and a `test` script
- [ ] `vitest.config.ts` — new file; no in-repo pattern to copy, mirror the server's shape
- [ ] `test/connection-auth.test.ts` — D-09

**Documentation (required by D-05, not a test):**
- [ ] `mirror-request/docs/OPS-RUNBOOK.md` — the auth contract change, the synchronized-deploy requirement, and the rollback rule

**Known mocking caveat:** `vi.mock()` does not intercept runtime `require()` in this
codebase; `test/db-poller.test.ts`'s header documents the `createRequire` + `vi.spyOn`
workaround. Spying on an exported logger object's method intercepts before Winston's
level filter — which is why `LOG_LEVEL=error` does not prevent asserting on `debug`.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|---|---|---|---|
| Updated Agent binary authenticates against updated server | D-05, D-09 | Two deployed artifacts; no automated cross-repo integration harness exists | Build the Agent (`npm run build:exe`), point it at a **non-production** instance of the updated server, confirm it connects and receives a `start_session` |
| Synchronized cutover does not strand the booth | D-05 | Requires a real maintenance window | Deploy server and Agent in the same window; confirm the Agent reconnects and `isAgentOnline()` reports true before accepting live guests |
| Rollback safety | D-05 | Destructive to verify live | Documented rule only: roll back **both** or neither — a rolled-back server against a new Agent reproduces the identical outage in reverse |

**No staging environment reference exists** in `OPS-RUNBOOK.md` or `config.ts`. The
runbook should say so explicitly rather than imply one, matching this project's
established habit of documenting absences honestly.

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references — **including the Agent repo's framework install**
- [ ] No watch-mode flags
- [ ] Feedback latency < 30 s
- [ ] Every `AgentServer` test binds an ephemeral port and closes it in `afterEach`
- [ ] Zero `getStore()` calls in any new test
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
