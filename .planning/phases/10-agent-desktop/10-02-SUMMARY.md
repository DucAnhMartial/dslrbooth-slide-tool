---
phase: 10-agent-desktop
plan: 02
subsystem: infra
tags: [electron, ipc, safe-storage, config-store, security-posture, vitest]

# Dependency graph
requires:
  - phase: 10-agent-desktop
    provides: "10-01's createAgent() factory, parseConfigValues() validator, getStatus()/onStatus() snapshot — this plan hosts them in an Electron main process without touching the factory itself"
provides:
  - "src/electron/configStore.ts — versioned user-data JSON config store: redacted config:get snapshot, patch applier over the eight configuration fields, secrets wrapped via an injected encryptor with an honest unwrapped fallback"
  - "src/electron/ipcHandlers.ts — the channel-name constant, the plain-function handler map (config:get/set, agent:start/stop/status), and config:set's live/bootstrap split through the imported SAFE_AGENT_CONFIG_FIELDS allow-list"
  - "src/electron/main.ts, preload.ts, safeStorageEncryptor.ts — single-instance-locked, isolated, sandboxed Electron entry with no application menu, navigation refused, and the one file that imports electron's safeStorage"
  - "src/renderer/{index.html,index.js,styles.css} — plain settings form, status panel, Start/Stop, copied verbatim into the build output"
  - "test/electron-ipc.test.ts, test/electron-config-ipc.test.ts, test/electron-main-security.test.ts — the three test files proving the tracer, the credential contract, and the renderer's security posture"
affects: [10-03-settings-form, 10-04-packaging-and-human-gate]

# Actuals (#2632)
actuals:
  tokens: 23245
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: ["electron@43 (devDependency)"]
  patterns:
    - "Electron-free core modules (configStore.ts, ipcHandlers.ts) with every Electron-only capability arriving as an injected interface (SecretEncryptor), so vitest can load and drive them directly on a headless build machine"
    - "One safe/bootstrap partition, one boundary: config:set imports SAFE_AGENT_CONFIG_FIELDS from liveConfig.ts and routes the safe half through the identical LiveConfig.apply() the wire uses, never a second implementation of D-16's rule"
    - "Security posture pinned by source-text assertions (test/electron-main-security.test.ts) rather than execution, following this repo's existing display-page-no-queue.test.ts precedent for logic that cannot run without a display server"
    - "Every save re-derives a secret's wrapped state from encryptor.isAvailable() at that moment — no separate upgrade code path for a file recorded unwrapped becoming wrapped later"

key-files:
  created:
    - dslrbooth-agent/src/electron/configStore.ts
    - dslrbooth-agent/src/electron/ipcHandlers.ts
    - dslrbooth-agent/src/electron/main.ts
    - dslrbooth-agent/src/electron/preload.ts
    - dslrbooth-agent/src/electron/safeStorageEncryptor.ts
    - dslrbooth-agent/src/renderer/index.html
    - dslrbooth-agent/src/renderer/index.js
    - dslrbooth-agent/src/renderer/styles.css
    - dslrbooth-agent/scripts/copy-assets.js
    - dslrbooth-agent/test/electron-ipc.test.ts
    - dslrbooth-agent/test/electron-config-ipc.test.ts
    - dslrbooth-agent/test/electron-main-security.test.ts
  modified:
    - dslrbooth-agent/package.json
    - dslrbooth-agent/package-lock.json

key-decisions:
  - "wrapSecret(plaintext, warnOnUnavailable) takes an explicit second argument rather than a module-level dedupe flag, so 'one warning per save even though a save wraps two secrets' is provable by passing true on the first call and false on the second — inherited as a mid-edit at session start (TS2554, both call sites still one-argument) and completed as Rule 3 (blocking: typecheck failed)."
  - "test/electron-config-ipc.test.ts's fake encryptor base64-codes (wrapped:<base64>) rather than prefixing the plaintext (enc:<plaintext>, Task 1's fake) — the latter would make 'the file's bytes contain neither plaintext secret' pass vacuously, since the plaintext is still a literal substring of the ciphertext."
  - "The dslrBoothApiPort live-apply case drives a real HTTP request at a second dslrBooth stub after patching, mirroring config-reload.test.ts's 08-04 reasoning verbatim: a live.dslrBoothApiPort getter assertion alone would pass against a build that persisted the port but never wired the live half."
  - "The 'no application menu' security assertion was strengthened from a plain substring match to a line-start regex (`^\\s*Menu\\.setApplicationMenu\\(null\\)`) after mutation-testing the test file itself: commenting out the call left the original substring check green, because the string is still literally present in the comment."
  - "The allow-list identity case mutates the exported SAFE_AGENT_CONFIG_FIELDS array in place (push/pop in a try/finally) rather than asserting on ipcHandlers.ts's source text, because the property under test — does the local path consult the array ITSELF, not a copy — is only provable by an effect the mutation causes."

patterns-established:
  - "Pattern: any future Electron-hosted config or IPC surface should stay electron-free with injected platform interfaces, matching configStore.ts/ipcHandlers.ts, so it stays directly testable on a headless CI machine."
  - "Pattern: a security-posture assertion against source text must use a start-of-line/word-boundary match, never a bare substring — a bare substring is satisfied by a comment and does not fail when the real behavior regresses."

requirements-completed: [UI-02, SC-1, SC-2, SC-4]

coverage:
  - id: D1
    description: "An empty install can be configured (settings form, Save) and the relay started/stopped/restarted through exactly the functions the window's controls call — the tracer slice, Task 1"
    requirement: "SC-1"
    verification:
      - kind: unit
        ref: "dslrbooth-agent/test/electron-ipc.test.ts — all 11 cases (first-run defaults, redacted snapshot, secret blank/replace, validator refusal, unknown-key refusal, start/stop/restart against a real WebSocketServer + dslrBooth stub, unusable-config and occupied-port start, status-push parity)"
        status: pass
    human_judgment: false
  - id: D2
    description: "No code path returns a stored secret to any caller but the config builder; the config:get snapshot carries only non-secret values plus two presence booleans"
    requirement: "UI-02"
    verification:
      - kind: unit
        ref: "dslrbooth-agent/test/electron-ipc.test.ts — 'the snapshot key set is exactly the six non-secret fields plus the two presence flags, and contains no secret'"
        status: pass
    human_judgment: false
  - id: D3
    description: "Secrets are wrapped via the platform key store when available, honestly recorded unwrapped with a once-per-save warning when not, upgraded in place on the next save, and a corrupted wrapped value degrades to 'retype this field' rather than a crash"
    verification:
      - kind: unit
        ref: "dslrbooth-agent/test/electron-config-ipc.test.ts — the four 'secrets at rest' cases (wrapped/no-plaintext, unwrapped/one-warning, unwrapped-to-wrapped upgrade, per-field undecryptable-secret degradation)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Editing a CMS-safe field on a running relay applies through the identical LiveConfig.apply() the wire uses (port change proven against a live HTTP stub, log level against every transport, auto-open flag against the live getter); a bootstrap field persists and reports restart-required without touching the live holder; a mixed patch does both; editing while stopped reports no restart requirement"
    requirement: "SC-4"
    verification:
      - kind: unit
        ref: "dslrbooth-agent/test/electron-config-ipc.test.ts — the 'live half' describe block (6 cases: port-via-real-request, logLevel-via-transports, autoOpenDisplay-via-getter, bootstrap-persists-and-restart-required, mixed-patch, stopped-edit)"
        status: pass
    human_judgment: false
  - id: D5
    description: "The local path consults SAFE_AGENT_CONFIG_FIELDS itself, not a copy, and both exported allow-lists are byte-identical in content and order to their pre-phase state (D10-03)"
    verification:
      - kind: unit
        ref: "dslrbooth-agent/test/electron-config-ipc.test.ts — 'the local path consults SAFE_AGENT_CONFIG_FIELDS itself' (mutation-proof) and 'both exported allow-lists still hold exactly their pre-phase members, in order'"
        status: pass
    human_judgment: false
  - id: D6
    description: "The renderer's security posture — context isolation on, node integration off, sandbox on, single-instance lock taken and acted on, no application menu, navigation and new-window requests refused, no local network listener anywhere under src/electron/, the preload's exposed surface exactly matching the channel constant plus two subscription helpers, and a same-origin-only CSP with no remote origin referenced — is a property the suite enforces"
    verification:
      - kind: unit
        ref: "dslrbooth-agent/test/electron-main-security.test.ts — all 25 cases"
        status: pass
    human_judgment: false
  - id: D7
    description: "Both build paths coexist at every commit: npm run build/typecheck exit 0, build:exe produces a non-empty Windows binary, and mirror-request/ is untouched (D10-01, D10-03 regression pin)"
    verification:
      - kind: unit
        ref: "npm run typecheck && npm run build (exit 0), npm run build:exe (43MB dslrbooth-agent.exe), git -C mirror-request status --short (empty)"
        status: pass
    human_judgment: false

# Metrics
duration: ~35min (this continuation — Tasks 2 and 3; Task 1 was committed in a prior session)
completed: 2026-08-13
status: complete
---

# Phase 10 Plan 02: Agent Desktop Electron Shell Summary

**Electron main process hosting the plan-10-01 factory behind a versioned user-data JSON config store and a narrow IPC surface, with secrets wrapped by `safeStorage`, CMS-safe fields taking effect on a running relay through the exact `LiveConfig.apply()` the wire uses, and the renderer's security posture pinned by a 25-case source-text test suite.**

## Performance

- **Duration:** ~35 min for this continuation (Tasks 2 and 3; Task 1's tracer slice was committed in a prior session)
- **Completed:** 2026-08-13
- **Tasks:** 3 (1 inherited/verified, 2 executed this session)
- **Files modified:** 14 across the whole plan (12 created, 2 modified)

## Accomplishments

- **Task 1 (verified, not redone):** an empty install can be configured through a settings form, saved, and started into a live relay — an Electron main process hosting the 10-01 factory, a user-data JSON config store, a narrow IPC surface, and a plain-HTML renderer, proven end to end against a real `WebSocketServer` and a real dslrBooth stub (`test/electron-ipc.test.ts`, 11 cases).
- **Task 2:** secrets are wrapped at rest via Electron's own `safeStorage` when available and honestly recorded unwrapped with a once-per-save warning when not, upgraded in place on the next save, and degrade per-field to "please retype this value" rather than crashing on a corrupted wrapped value. `config:set` now partitions every patch against the imported `SAFE_AGENT_CONFIG_FIELDS` allow-list: the four CMS-safe fields apply to a running relay through the identical `LiveConfig.apply()` the wire uses (the port change proven against a second live HTTP stub, mirroring the 08-04 reasoning that a getter assertion alone would pass against a broken build); the four bootstrap fields persist and report `restartRequired` without ever reaching the live holder.
- **Task 3:** the renderer's security posture — context isolation, sandbox, no node integration, the single-instance lock, no application menu, navigation and new-window refusal, no local network listener anywhere under `src/electron/`, the preload's exposed surface matching the channel constant exactly, and a same-origin CSP with no remote origin — is now a property the test suite enforces (`test/electron-main-security.test.ts`, 25 cases), reading the Electron-only source files as text since they cannot execute on this headless Linux build machine.
- Both build paths still coexist: `npm test` is green at 120 cases (up from the 82-test baseline this plan started from), `typecheck`/`build` exit 0, `build:exe` still produces a non-empty 43MB Windows binary, and `mirror-request/` is untouched.

## Task Commits

Each task was committed atomically:

1. **Task 1: One path end to end — an empty install, a settings form, Save, Start, a live relay** - `582d045` (feat) — committed in a prior session, independently verified at the start of this continuation.
2. **Task 2: The credential contract at rest and the four safe fields taking effect live** - `2fcd5db` (feat)
3. **Task 3: The posture pinned in tests, and both build paths still green** - `49d1cdc` (test)

_Note: this plan's tasks used `tdd="true"`/single-commit-per-task discipline like plan 10-01, not a separate RED/GREEN/REFACTOR commit sequence per task._

## Files Created/Modified

- `src/electron/configStore.ts` - versioned user-data JSON store; Task 2 completed the inherited `wrapSecret(plaintext, warnOnUnavailable)` two-argument signature and fixed its two call sites (was mid-edit, TypeScript would not compile)
- `src/electron/ipcHandlers.ts` - channel constant + handler map; Task 2 added `config:set`'s live/bootstrap split via `isSafeAgentConfigField` imported from `liveConfig.ts`
- `src/electron/main.ts` - Electron entry: single-instance lock, isolated/sandboxed window, no menu, navigation refused, channel registration, status push (Task 1; read and pinned, not modified, in Task 3)
- `src/electron/preload.ts` - the one-namespace, channel-derived IPC surface (Task 1; read and pinned, not modified, in Task 3)
- `src/electron/safeStorageEncryptor.ts` - the platform key-store adapter over Electron's `safeStorage` (Task 1; exercised by Task 2's at-rest tests)
- `src/renderer/{index.html,index.js,styles.css}` - the settings form and status panel (Task 1; read and pinned, not modified, in Task 3)
- `scripts/copy-assets.js`, `package.json` - build wiring (Task 1)
- `test/electron-ipc.test.ts` - Task 1's tracer test, 11 cases
- `test/electron-config-ipc.test.ts` - Task 2's new test file, 13 cases: at-rest secret wrapping/upgrade/degradation, the live/bootstrap split, allow-list identity and order
- `test/electron-main-security.test.ts` - Task 3's new test file, 25 cases: web preferences, single-instance rule, no menu, navigation refusal, no local listener, preload surface, CSP, build layout

## Decisions Made

- `wrapSecret`'s second argument (`warnOnUnavailable: boolean`) is passed `true` on the first of the two per-save calls and `false` on the second, so "one warning per save even though a save wraps two secrets" is provable rather than assumed — this was an inherited mid-edit (the call sites had not been updated to the new two-argument signature, so `npm run typecheck` failed with `TS2554` at session start) and was completed as a Rule 3 auto-fix (blocking: the tree did not compile).
- The Task 2 test file's fake encryptor base64-codes (`wrapped:<base64>`) instead of prefixing the plaintext verbatim (`enc:<plaintext>`, Task 1's fake) — the prefix form would make "the file's bytes contain neither plaintext secret" pass vacuously, since the plaintext remains a literal substring of that "ciphertext".
- The dslrBoothApiPort live-apply case drives a real HTTP request at a second dslrBooth stub after the patch, rather than asserting on `agent.live.dslrBoothApiPort` alone — mirroring `config-reload.test.ts`'s 08-04 case, which exists precisely because a getter-only assertion would pass against a build that persisted the new port but never wired it to the live `DslrBoothClient`.
- The allow-list identity case (`the local path consults SAFE_AGENT_CONFIG_FIELDS itself`) mutates the exported array in place inside a `try`/`finally` (push a field, assert the live/bootstrap decision flips, pop it back) rather than asserting on `ipcHandlers.ts`'s source text — the property under test (does the local path read the array itself, not a copy) is only observable through an effect the mutation causes.
- Task 3's "no application menu" assertion was strengthened from a plain substring match (`toContain('Menu.setApplicationMenu(null)')`) to a line-start regex (`/^\s*Menu\.setApplicationMenu\(null\)/m`) after mutation-testing the test file itself during authoring: commenting out the call in `main.ts` left the substring check green, because the exact string remained present inside the comment. The regex form was verified to catch the same mutation before committing.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Completed the inherited `wrapSecret` two-argument signature**
- **Found during:** Task 2 startup (before any new work) — `npm run typecheck` failed with `TS2554: Expected 2 arguments, but got 1` at `configStore.ts:287-288`.
- **Issue:** A prior, interrupted executor had changed `wrapSecret`'s signature to accept `warnOnUnavailable: boolean` but had not updated its two call sites in `applyPatch()`.
- **Fix:** Passed `true` on the first call (`extensionServiceWsToken`) and `false` on the second (`dslrBoothPassword`), matching the header comment's stated intent that one save logs exactly one warning.
- **Files modified:** `src/electron/configStore.ts`
- **Verification:** `npm run typecheck` exits 0; `test/electron-config-ipc.test.ts`'s "logs exactly one warning" case passes.
- **Committed in:** `2fcd5db` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Necessary to make the inherited tree compile; no scope creep — the fix matches the design already documented in the file's own header comment.

## Issues Encountered

- The Task 3 security-posture test's initial "no application menu" assertion (a plain substring match) was caught as vacuous during its own authoring — mutation-testing the test file (temporarily commenting out the real call in `main.ts`) showed the test still passed, because the substring is present inside the comment too. Fixed to a line-start regex before committing; re-verified the mutation now fails the test, then reverted the mutation. No production code was affected; this was a test-quality issue in the file being written, caught and fixed within the same task.

## User Setup Required

None — no external service configuration required. This plan is fully Linux-provable; the phase's blocking human gate (install/run on the real booth PC) remains scoped to plan 10-04.

## Next Phase Readiness

- `configStore.ts`'s patch applier, `ipcHandlers.ts`'s `config:set` live/bootstrap split, and the renderer's IPC surface are all available for plan 10-03's per-field settings-form polish, `.env` import and log pane — no further extraction needed.
- `SAFE_AGENT_CONFIG_FIELDS`/`READ_ONLY_AGENT_CONFIG_FIELDS` in `src/liveConfig.ts` remain byte-identical to their pre-phase contents (`git diff --stat src/liveConfig.ts` empty across every commit in this plan), so `mirror-request`'s cross-repo equality test stays untouched.
- Full verification at the end of this plan: `npm test` — 9 files, 120 tests, all passing (up from the 8-file/95-test count after Task 1 alone, and the 82-test baseline before this plan); `npm run typecheck` and `npm run build` both exit 0; `npm run build:exe` produces a non-empty `dslrbooth-agent.exe` (43MB, gitignored); `git -C mirror-request status --short` empty.
- No blockers for plan 10-03 (settings-form polish) to begin. Plan 10-04's packaging work (electron-builder, NSIS/portable) and the phase's single blocking human gate remain exactly where the phase context placed them.

---
*Phase: 10-agent-desktop*
*Completed: 2026-08-13*

## Self-Check: PASSED

All 12 files referenced above (`src/electron/configStore.ts`, `src/electron/ipcHandlers.ts`, `src/electron/main.ts`, `src/electron/preload.ts`, `src/electron/safeStorageEncryptor.ts`, `src/renderer/index.html`, `src/renderer/index.js`, `src/renderer/styles.css`, `scripts/copy-assets.js`, `test/electron-ipc.test.ts`, `test/electron-config-ipc.test.ts`, `test/electron-main-security.test.ts`) confirmed present on disk. All 3 commit hashes (`582d045`, `2fcd5db`, `49d1cdc`) confirmed present in `git log`.
