# Phase 3: Agent WebSocket Link - Context

**Gathered:** 2026-08-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Own the link between the central service and the booth machine: authenticating the
Agent, carrying the dispatch command down, receiving acks and events back up, and
detecting when the Agent has died.

Out of this phase: queue ordering and the booth state machine itself (Phase 2, done);
photo delivery to the guest (Phase 4); the guest-facing status API and display feed
(Phase 5).

**This is a hardening pass over working code, not greenfield.**
`mirror-request/src/agent/agentServer.ts` (145 lines) already implements token auth,
a heartbeat watchdog, `sendCommand`/`sendEvent`, and `isAgentOnline`, and is wired
into `src/index.ts`. `test/agent-websocket.test.ts` (45 lines) exists. Planning must
audit that code rather than assume an empty file.

**This phase spans TWO repositories** — the first phase to do so. See
`<canonical_refs>` and the repository note below.

</domain>

<decisions>
## Implementation Decisions

### The governing principle for this phase

- **D-01:** A **system-side fault never consumes the guest's retry budget.** The
  bounded retry policy Phase 2 built (D-05..D-07 there, via `handleStall()`) exists to
  stop *a bad job* from blocking the queue. An Agent that is offline, or that drops
  mid-session, is a fault of the booth — not of the job. Charging it to the job's
  budget means that after a few booth outages a perfectly valid guest gets marked
  `failed`. Only session-side faults (ack timeout, Agent NAK) consume retries.

  This principle governs D-02 and D-10 below; treat it as the tie-breaker for any
  similar case research surfaces.

### Dispatching when the Agent is not connected

Today `dispatchJob()` (`queueService.ts:213-217`) marks the job `dispatched`, sets the
booth BUSY and starts the 5-minute timer, then calls `sendCommandCb` and **discards
its return value**. `AgentServer.sendCommand()` does return `false` and log a warning
when there is no connection — the queue simply ignores it. The result is a command
sent into the void and a full retry cycle burned waiting for something that cannot
arrive. This is very likely what produced the four stranded jobs of 2026-08-06.

- **D-02:** Check Agent connectivity **before** dispatching. If the Agent is not
  connected: do not dispatch, leave the booth `IDLE`, leave the job `queued`, and do
  **not** increment `retries`. The job keeps its place in line (Phase 2 D-06).
- **D-03:** Log the skipped dispatch **once per state change**, not on every 250 ms
  tick. A booth that is off overnight must not produce thousands of identical lines.
- **D-04:** When the Agent reconnects, the normal tick dispatches the head of the
  queue. No separate wake-up path.

### Agent authentication

Today the token travels in the query string (`agentServer.ts:38`), is compared with a
plain `!==`, and is checked only **after** the WebSocket handshake has completed —
`handleUpgrade` runs unconditionally for `/agent`, and an unauthenticated client is
closed with 4001 only once it is already connected.

- **D-05:** Move the token to an `Authorization: Bearer <token>` header. The server
  accepts **only** the header — the query-string path is removed, not deprecated.
  — **Reversibility:** one-way — this is a published integration contract between two
  deployed components.
- **D-06:** Reject unauthorized upgrades at the HTTP upgrade step with `401`, before
  the handshake completes. An unauthenticated client must never reach an open socket.
- **D-07:** Compare the token with a timing-safe comparison, matching what Phase 1
  established for HMAC verification. Guard against the length-mismatch throw that
  Phase 1's research flagged (`timingSafeEqual` Pitfall 2).
- **D-08:** The token is never written to a log line, in any form, at any level —
  including on the rejection path. Phase 1 D-12's rule (generic reason only, never
  secrets or validation detail) applies here unchanged.
- **D-09:** `dslrbooth-agent/src/websocket/connection.ts:53-54` is updated in this same
  phase to send the header instead of the query string.

**Deployment consequence, accepted deliberately.** The user chose a clean break over a
dual-accept migration. Server and Agent must be deployed **together**: a server on the
new build with an Agent on the old one will reject every connection, and the booth
stops serving until both sides are updated. This must be stated plainly in
`mirror-request/docs/OPS-RUNBOOK.md` alongside the existing webhook signing contract,
so whoever deploys knows the ordering matters.

### A second Agent connecting

Today a newly connecting Agent silently closes the existing connection, with no log on
either side.

- **D-10:** Keep last-wins. It is what lets a real Agent recover after a flaky network
  drop without waiting for the heartbeat watchdog to notice the stale connection.
- **D-11:** But log it: a `warn` naming both the displaced and the arriving agent id,
  so two Agents misconfigured onto the same server produce a visible, diagnosable
  flap instead of silence.

### The Agent dying mid-session

Today `ws.on('close')` (`agentServer.ts:80-85`) only nulls the connection. If the booth
is BUSY with a dispatched job, nothing tells the queue — Phase 2's 5-minute timer
eventually fires, so it is not a deadlock, but the guest waits five minutes for a booth
already known to be dead.

- **D-12:** A disconnect while the booth is BUSY resets the booth to `IDLE` and returns
  the in-flight job to `queued`, preserving `queued_at`, **without** incrementing
  `retries` (D-01).
- **D-13:** This must not double-fire with Phase 2's `busyTimer`. Whichever path acts
  first must leave the other a no-op — a job must never be requeued twice for one
  failure.

### Event coverage (AGT-04) — flagged for research, not yet decided

AGT-04 names ten event types. `QueueService.onAgentEvent()` (`queueService.ts:171-176`)
currently handles **three**: `session_end`, `session_start`, `file_upload`. The other
seven (`countdown_start`, `countdown`, `capture_start`, `file_download`,
`processing_start`, `sharing_screen`, `printing`) fall through to no handler.

- **D-14:** Research must establish, for each of the ten, whether Phase 3 owes it a
  behavior, a persisted record, or only a log line — and whether any of them are
  consumed by Phase 5's display feed. AGT-04 says "received and processed"; the plan
  must define what "processed" means per event rather than silently treating three as
  sufficient. Unhandled types must at minimum not be silently dropped.

### The agent's Discretion

- The exact wire shape of the `Authorization` header handling on the Node `upgrade`
  event, and how the 401 response is written to the raw socket.
- Whether disconnect-triggered requeue reuses a Phase 2 method or introduces a new one,
  provided D-13's no-double-requeue guarantee holds and is tested.
- Log wording and levels, within D-03's once-per-state-change and D-08's no-token rules.

</decisions>

<specifics>
## Specific Ideas

The guest-facing promise this phase protects is the same one Phase 2 protected —
PROJECT.md's Core Value, *"mỗi khách đăng ký đều được phục vụ đúng thứ tự, không bỏ lỡ
đăng ký nào"*. Phase 2 stopped a dead session from blocking the queue forever. Phase 3
stops the queue from feeding guests into a booth that is not there, and stops the
system from blaming the guest for the booth's absence.

CLAUDE.md's hard rules bind this phase directly: the Agent is a **dumb relay**, all
business logic stays in the central service, and nothing here may call the dslrBooth
Local API directly.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Product scope and requirements

- `.planning/PROJECT.md` — Core Value, MVP scope, single-booth constraint.
- `.planning/REQUIREMENTS.md` — AGT-01..05 and AUTH-01.
- `.planning/ROADMAP.md` §"### Phase 3: Agent WebSocket Link" — the five M3 success criteria.

### Decisions inherited from earlier phases

- `.planning/phases/01-foundation-ingestion/01-CONTEXT.md` — D-12 (auth failures return a
  generic reason, never secrets), D-15 (masked logs). Phase 1's timing-safe HMAC
  comparison is the precedent for D-07.
- `.planning/phases/02-queue-booth-state/02-CONTEXT.md` — D-05..D-07 (the bounded retry
  policy this phase must not corrupt), D-06 (a requeued job keeps its place in line).
- `.planning/phases/02-queue-booth-state/02-VERIFICATION.md` — what Phase 2 actually
  delivered, verified against source.

### Codebase and operations

- `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/CONVENTIONS.md`
- `mirror-request/CLAUDE.md` — hard rules; rule 2 and 3 bind this phase directly.
- `mirror-request/docs/OPS-RUNBOOK.md` — §1 carries the webhook signing contract; the
  new Agent auth contract and its synchronized-deploy requirement belong beside it.

</canonical_refs>

<code_context>
## Existing Code Insights

### Repository topology — READ THIS FIRST

This phase is the first to span two repositories, and the workspace has three separate
`.planning` trees, only one of which is authoritative.

- `/opt/mirror_request_dslrobooth` — workspace root. **NOT a git repository.**
- `/opt/mirror_request_dslrobooth/.planning/` — **THE AUTHORITATIVE planning tree.**
- `/opt/mirror_request_dslrobooth/mirror-request/` — the server repo.
- `/opt/mirror_request_dslrobooth/mirror-request/.planning/` — **STALE, obsolete tree.** Do not read.
- `/opt/mirror_request_dslrobooth/dslrbooth-agent/` — the Agent repo. **Brought under
  version control on 2026-08-10 specifically for this phase** (baseline commit
  `e3007d5`); its 43MB `dslrbooth-agent.exe` build artifact was gitignored at the same
  time. Before that commit it had no repo at all, so Agent changes could not have been
  committed or reverted.
- `/opt/mirror_request_dslrobooth/dslrbooth-agent/.planning/` — **a THIRD planning tree,
  belonging to the Agent's own earlier project. Do not read it either.**

Commits must be made from inside whichever repo owns the file. `.planning/` is outside
both repos and cannot be committed at all.

### Reusable Assets

- `mirror-request/src/agent/agentServer.ts` — the whole phase exists here in draft:
  upgrade handling (23-35), token check (37-43), single-agent replacement (44-49),
  message dispatch (51-78), close/error (80-89), heartbeat watchdog (127-143).
- `mirror-request/src/queue/queueService.ts` — `bindSendCommand()`, `onAgentAck()`,
  `onAgentEvent()`, and Phase 2's `handleStall()` policy the disconnect path must
  cooperate with, not bypass.
- `mirror-request/src/config.ts` — `AGENT_WS_TOKEN` and `HEARTBEAT_TIMEOUT_MS` already
  typed and defaulted.
- `dslrbooth-agent/src/websocket/connection.ts` — the client side of the contract; line
  53-54 builds the `?token=` URL that D-05/D-09 replace.

### Established Patterns

- Phase 1 and 2 both removed direct `process.env` reads in favour of typed config;
  `agentServer.ts` already takes config, so no change needed there.
- Failure posture is warn-and-continue, never crash the process.
- Phase 2 consolidated every stall path into one `handleStall()` policy — the new
  disconnect path must respect that consolidation rather than open a fourth route.

### Test-suite caveat (inherited, still open)

`.planning/WINDOWS.md` ledger item 4 remains open. The suite does **not** touch the
production database — `vitest.config.ts:12` points it at
`./data/test-extension-service.sqlite`. The real problem is that all test files share
that one test DB through the `getStore()` singleton while vitest runs files in parallel
workers. Phase 2 avoided it locally: zero `getStore()` calls in any new test.

**Phase 3 is more exposed than Phase 2 was.** A WebSocket server binds a port and holds
process-global connection state; two test files that both start an `AgentServer` can
collide on both the port and the singleton. Planning must decide the isolation approach
(ephemeral port per file, injected store, or per-file temp DB) rather than inheriting
the problem.

</code_context>

<deferred>
## Deferred Ideas

- Removing the query-string auth path was **not** deferred — the user chose a clean
  break, so it is deleted in this phase (D-05).
- Guest-facing status API and the display feed that consumes Agent online/offline
  state — Phase 5.
- Photo delivery triggered by `file_upload` — Phase 4. Phase 3 only ensures the event
  arrives and is routed.
- Multi-booth support and per-booth Agent routing — out of scope per PROJECT.md.
- Giving each test file its own database — still open ledger item 4; Phase 3 must at
  minimum not make it worse, and may fix it if planning judges it cheap.

</deferred>

---

*Phase: 03-agent-websocket-link*
*Context gathered: 2026-08-10*
