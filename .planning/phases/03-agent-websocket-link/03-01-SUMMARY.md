---
phase: 03-agent-websocket-link
plan: 01
subsystem: agent-auth
tags: [websocket, authentication, cross-repo, one-way-contract]
dependency-graph:
  requires: []
  provides:
    - "Authorization: Bearer <token> as the sole Agent auth mechanism, both sides"
    - "AgentServer.isValidBearerToken() — constant-time, length-guarded credential check"
    - "dslrbooth-agent's first automated test harness (vitest)"
  affects:
    - "03-02 (single-agent replacement, heartbeat) builds on the same AgentServer upgrade path"
    - "03-05 (OPS-RUNBOOK.md) quotes this plan's wire form and synchronized-deploy rule verbatim"
tech-stack:
  added:
    - "vitest ^2.1.4 in dslrbooth-agent (devDependency, first test framework in that repo)"
  patterns:
    - "Reject at the raw HTTP 'upgrade' event (socket.write + socket.destroy), not a post-handshake WS close code"
    - "timingSafeEqual with an explicit length guard, reproducing webhookAuth.ts's verifySignature() shape"
key-files:
  created:
    - dslrbooth-agent/vitest.config.ts
    - dslrbooth-agent/test/connection-auth.test.ts
    - mirror-request/test/agent-auth.test.ts
  modified:
    - dslrbooth-agent/package.json
    - dslrbooth-agent/package-lock.json
    - dslrbooth-agent/src/websocket/connection.ts
    - mirror-request/src/agent/agentServer.ts
    - mirror-request/test/agent-websocket.test.ts
decisions:
  - "Task 1's blocking checkpoint (D-05's one-way clean break) was resolved by explicit human confirmation at execution time — the executor detected auto-advance was off (workflow._auto_chain_active=false, auto_advance unset) and this project's own history (Phase 1 Task 3, Phase 2 plan 02-04 Task 3) shows blocking checkpoints get real human resolution even when the underlying decision is already pre-recorded in CONTEXT.md. The gate was not self-approved."
  - "npm 11 rewrote the vitest devDependency specifier to ^2.1.9 (the resolved version) instead of preserving the literal ^2.1.4 given on the install command line; corrected package.json back to ^2.1.4 by hand and re-ran `npm install` to sync package-lock.json, so the specifier matches the sibling repo's convention exactly, as the plan required."
  - "vi.mock('ws') static-import interception worked directly on the first attempt — no createRequire/vi.spyOn fallback was needed. connection.ts's `import WebSocket from 'ws'` is a static import, unlike dbPoller.ts's runtime require()."
  - "agent-websocket.test.ts's repaired case needed one addition beyond the plan's literal instruction (URL + header change): an explicit ws.close() after reading the upgrade response. Under the old behavior an invalid token caused the server to auto-close the socket after handshake, which is what let httpServer.close() in afterEach succeed without hanging. With a valid token the connection now stays open indefinitely (by design — it's the Agent's live connection), so afterEach's httpServer.close() hung waiting for a live socket. Added one explicit ws.close() call to unblock it (Rule 1 — bug in the repaired test, not a plan deviation in the production code)."
metrics:
  duration: "~1.5 hours (interactive: checkpoint pause + resume)"
  completed: 2026-08-10
status: complete
actuals:
  tokens: 4300
  tasks: 3
  commits: 2
---

# Phase 3 Plan 01: Agent WebSocket Auth (tracer) Summary

Replaced the Agent's authentication handshake end to end across both repositories with a
header-only Bearer credential, verified in constant time and rejected with a bare HTTP 401
on the raw socket **before** the WebSocket handshake completes — closing the window where an
unauthenticated peer previously held an open socket for one round trip before being closed
with application code 4001.

## What Was Built

**Task 1 — checkpoint (no code):** The one-way-gate decision to proceed with D-05's clean
break was presented for human confirmation before any file changed. **Resolution: the human
selected `proceed-clean-break` explicitly.** The executor did not self-approve this gate even
though GSD's auto-advance config was off and the decision was already recorded as locked in
`03-CONTEXT.md` — this project's precedent (Phase 1 Task 3, Phase 2 plan 02-04 Task 3) is that
blocking checkpoints get a real human answer at execution time, not an inference from earlier
planning documents.

**Task 2 — `dslrbooth-agent/` (Agent repo), commit `e376696`:**
- `WsConnection.connect()` no longer appends `?token=<credential>` to the connection URL. The
  URL is passed to the `WebSocket` constructor completely unchanged.
- The constructor's options object now carries `headers: { authorization: 'Bearer <token>' }`
  when a credential is configured, and no `headers` key at all when it is not.
- `handshakeTimeout: 10000` and `perMessageDeflate: false` (with its existing deployment-hazard
  comment) survive untouched.
- No change to reconnect/backoff logic — the existing exponential backoff (2s → 30s cap,
  already firing on any rejected handshake via the `'close'` handler) is exactly what a
  permanently-401'd Agent now retries through.
- This repository's first test harness: `vitest ^2.1.4` (2.1.9 resolved, matching the sibling
  repo exactly), `vitest.config.ts`, and `test/connection-auth.test.ts` (4 cases: credential
  present, credential absent, URL passed unchanged, the two surviving options preserved).
- `npm run build` still emits exactly the same `dist/` tree — `test/` never entered the
  TypeScript build (`dist/test` has zero entries).

**Task 3 — `mirror-request/` (server repo), commit `2166049`:**
- New private `AgentServer.isValidBearerToken(authHeader: string): boolean` — checks the
  `Bearer ` prefix, builds UTF-8 buffers for the received and configured credentials, returns
  `false` on a length mismatch **before** calling `timingSafeEqual` (which throws
  `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` on mismatched lengths rather than returning false), and
  wraps the whole body in `try/catch`. Logs nothing; returns nothing but a boolean. The
  rationale lives in a doc-comment block above the method, in `webhookAuth.ts`'s style.
- The `httpServer.on('upgrade', ...)` listener now checks `isValidBearerToken()` before
  `handleUpgrade()` is ever reached. On failure: one generic `logger.warn` line with no
  interpolated detail, then `socket.write('HTTP/1.1 401 Unauthorized\r\nConnection:
  close\r\n\r\n')` followed by `socket.destroy()` — a raw HTTP response on the socket, not a
  WebSocket close code, since `noServer: true` mode has no `verifyClient` hook to use instead.
  The pathname early-return that protects `/display`'s own `'upgrade'` listener on the shared
  `http.Server` is unchanged.
- The old post-handshake check inside the `'connection'` handler is deleted entirely: the
  `searchParams.get('token')` lookup and the `ws.close(4001, 'unauthorized')` call are both
  gone. The handler's signature dropped its now-unused `req` parameter.
- `mirror-request/test/agent-auth.test.ts` (new, 8 cases, all passing): no header, missing
  `Bearer ` prefix, `Basic` scheme, wrong-length credential, same-length wrong credential,
  proof that a rejection doesn't poison the next connection attempt, successful auth +
  `isAgentOnline()`, and a D-08 log-content assertion across `warn`/`info`/`error`/`debug`
  spies over four consecutive rejection cases. Ephemeral port (`listen(0, ...)`), no
  `getStore()` call, no `DisplayServer` import — per 03-VALIDATION.md's isolation constraints.
- `mirror-request/test/agent-websocket.test.ts` — repaired, not deleted. Its "does not
  negotiate permessage-deflate" case now connects to `/agent` with nothing appended to the URL
  and a valid `Authorization: Bearer test-agent-token` header instead of the deleted
  query-string form.

## The Wire Contract (for 03-05's runbook to quote verbatim)

- **Header name:** `Authorization`
- **Scheme prefix:** `Bearer ` (exact, single space, case-sensitive as implemented)
- **Full form:** `Authorization: Bearer <AGENT_WS_TOKEN>`
- **Rejection response:** raw `HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n` written
  directly to the socket at the `upgrade` event, then `socket.destroy()` — never a WebSocket
  close frame, because rejection happens before `handleUpgrade()` runs
- **Query-string form:** deleted from both repositories. `grep -c 'token=' connection.ts` and
  `grep -c 'searchParams' agentServer.ts` (comment-filtered) both confirm zero occurrences.

## Mocking / Test-Infrastructure Findings

- **`vi.mock('ws')` interception worked directly** on the Agent side — no `createRequire` +
  `vi.spyOn` fallback was needed. `connection.ts` uses a static `import WebSocket from 'ws'`
  (unlike `dbPoller.ts`'s runtime `require('mysql2/promise')`), so vitest's static-import
  interception applied as expected and was confirmed by running the suite before assuming it.
- Both new server-side test files needed their sockets/servers closed explicitly and per-case,
  confirmed against the shared-DB / shared-port isolation constraints in `03-VALIDATION.md`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - blocking] npm 11 saved the wrong version specifier for the new devDependency**
- **Found during:** Task 2, step 1
- **Issue:** `npm install --save-dev vitest@^2.1.4` recorded `"vitest": "^2.1.9"` in
  `dslrbooth-agent/package.json` (npm 11 appears to save the resolved version's caret range
  rather than the literal specifier typed on the command line), instead of matching the
  sibling repo's `^2.1.4` convention as the plan explicitly required.
- **Fix:** Edited `package.json` back to `"vitest": "^2.1.4"` by hand, then re-ran
  `npm install` (no args) so `package-lock.json`'s root-level requirement mirrors the corrected
  specifier. The resolved/installed version (2.1.9) is unchanged.
- **Files modified:** `dslrbooth-agent/package.json`, `dslrbooth-agent/package-lock.json`
- **Commit:** `e376696`

**2. [Rule 1 - bug] Repaired `agent-websocket.test.ts` case hung the `afterEach` hook**
- **Found during:** Task 3, step 6 verification
- **Issue:** The plan's literal instruction (change the URL and add a valid `Authorization`
  header) was correct but incomplete: under the *old* behavior, an *invalid* token caused the
  server to close the socket right after handshake, which incidentally let
  `httpServer.close()` in `afterEach` succeed. With a *valid* token the Agent connection now
  stays open by design (it's a live Agent link), so the socket never closed and
  `httpServer.close()` hung past the 10s hook timeout.
- **Fix:** Added one explicit `ws.close()` call in the test's `'upgrade'` handler, right after
  reading `sec-websocket-extensions` and before resolving the promise.
- **Files modified:** `mirror-request/test/agent-websocket.test.ts`
- **Commit:** `2166049`

No other deviations. Both fixes are scoped strictly to files this plan already owned.

### Auth Gates

None. No CLI authentication was required for this plan.

## Known Stubs

None. Both changes are complete, production-shaped implementations on their single path, with
no placeholder values or unwired data.

## Threat Flags

None beyond what the plan's own `<threat_model>` already registered (T-03-01 through T-03-07,
T-03-SC) — no new surface was introduced outside that register.

## Self-Check: PASSED

- FOUND: `/opt/mirror_request_dslrobooth/dslrbooth-agent/vitest.config.ts`
- FOUND: `/opt/mirror_request_dslrobooth/dslrbooth-agent/test/connection-auth.test.ts`
- FOUND: `/opt/mirror_request_dslrobooth/mirror-request/test/agent-auth.test.ts`
- FOUND: commit `e376696` (dslrbooth-agent)
- FOUND: commit `2166049` (mirror-request)
- Both working trees clean after their respective commits (`git status --short` empty in
  both repos)
- `cd mirror-request && npm test` — 17 files, 121 tests, all passing
- `cd dslrbooth-agent && npm test` — 1 file, 4 tests, all passing
- `cd mirror-request && npm run typecheck` — clean
- `cd dslrbooth-agent && npx tsc --noEmit -p tsconfig.json` — clean
- `cd dslrbooth-agent && npm run build` — clean, `dist/websocket/connection.js` present,
  `dist/test` has zero entries
- All four `<acceptance_criteria>` grep gates for Task 3 verified to match exactly: 0
  `searchParams`, 0 `4001`, 1 `AGENT_WS_TOKEN`, 2 `timingSafeEqual` (comment-line filtered)
- Neither obsolete `.planning/` tree (`mirror-request/.planning/`,
  `dslrbooth-agent/.planning/`) was read or written during this plan
