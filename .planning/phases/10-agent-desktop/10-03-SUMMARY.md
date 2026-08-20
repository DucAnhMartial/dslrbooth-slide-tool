---
phase: 10-agent-desktop
plan: 03
subsystem: infra
tags: [electron, env-import, log-tail, tray, login-item, security-posture, vitest]

# Dependency graph
requires:
  - phase: 10-agent-desktop
    provides: "10-02's Electron shell — configStore, ipcHandlers, main/preload, the renderer form and the two posture test files this plan extends rather than duplicates"
  - phase: 10-agent-desktop
    provides: "10-01's createAgent() factory and parseConfigValues() validator — the .env import and the launch decision both go through them, never a second parser"
provides:
  - "src/electron/envImport.ts — findLegacyEnvFile()/parseLegacyEnvFile()/mapEnvVarsToConfigValues(): discovers the booth PC's existing .env and maps it onto a patch run through the same applyPatch a form save uses"
  - "src/electron/logTail.ts — createLogTail(): bounded, masked tail over the file the existing DailyRotateFile transport already writes, with SECRET_MASK applied before a line ever leaves the main process"
  - "src/electron/tray.ts — installCloseToTray()/createAppTray()/tooltipFor()/updateTrayTooltip(): close hides, only the tray's Quit sets the quitting flag before app.quit()"
  - "configStore preferences section — startWithWindows and startRelayOnLaunch under their own key with their own channels, both defaulting on, deliberately outside CONFIG_FIELDS"
  - "ipcHandlers.maybeAutoStartOnLaunch() — the pure launch decision main.ts and the table-driven test both drive"
  - "build/icon.png (256x256) and src/renderer/tray.png (32x32) with scripts/make-icon.py that regenerates them"
  - "test/electron-env-import.test.ts, test/electron-logtail.test.ts, test/electron-shell-posture.test.ts"
affects: [10-04-packaging-and-human-gate]

# Actuals (#2632)
actuals:
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Injected seams over Electron-only capability continued from 10-02: FsLike in envImport.ts and ClockLike in logTail.ts, and a LoginItemAdapter interface whose only implementation is one line in main.ts — so all three modules are driven directly by vitest on a headless Linux machine"
    - "Preferences kept OUT of CONFIG_FIELDS with their own channels, so config:set's refusal of unknown keys stays byte-for-byte the property 10-02 pinned instead of being widened to accommodate two new settings"
    - "Masking applied at the tail's own boundary (SECRET_MASK) rather than trusting callers — a log line carrying a token never reaches the renderer in the first place"
    - "Source-text assertion for Electron-only files, extending 10-02's electron-main-security.test.ts style rather than duplicating it, since main.ts and tray.ts cannot be loaded outside an Electron process"

verification:
  automated:
    - claim: "Whole suite green, well above the inherited 120"
      ref: "npm test — 12 files / 205 tests passed (was 9 files / 120 at 10-02 close)"
      status: pass
    - claim: "Task 3's own verify command"
      ref: "npm run build && npx vitest run test/electron-shell-posture.test.ts test/electron-main-security.test.ts — 56 passed"
      status: pass
    - claim: "Typecheck, build and the Windows binary all still green (D10-01 reversibility)"
      ref: "npm run typecheck (0), npm run build (0), npm run build:exe (43.5MB dslrbooth-agent.exe)"
      status: pass
    - claim: "The renderer's silence gate is 0, as the plan's own command specifies"
      ref: "grep -vE '^\\s*(//|\\*)' src/renderer/index.js | grep -cE 'localStorage|sessionStorage|document.title|innerHTML|console\\.' -> 0"
      status: pass
    - claim: "The kiosk display path is untouched (D10-04)"
      ref: "git diff --stat src/display/launcher.ts — empty; renderer references no openDisplayWindow, display/launcher or '/display' route"
      status: pass
    - claim: "The tray icon reaches the build output, and the app icon is a real 256px-square PNG"
      ref: "dist/renderer/tray.png present after build; build/icon.png PNG signature verified, 256x256"
      status: pass
    - claim: "Sibling repositories untouched (D10-03)"
      ref: "git -C mirror-request status --porcelain and git -C web-slide status --porcelain both empty; src/liveConfig.ts unchanged"
      status: pass
  human_judgment: false

# Metrics
completed: 2026-08-13
status: complete
---

# Phase 10 Plan 03: The Operator's Surface Summary

Turns 10-02's bare shell into something a booth operator actually uses at an event: it imports the
`.env` that machine already has, shows what the relay is doing and what it just logged, and stops
dying when somebody clicks the close button.

## Accomplishments

**Task 1 — first run on a booth PC that already works** (`bb3e35d`). `envImport.ts` discovers an
existing `.env`, parses it, and maps it onto a patch that runs through the *same* `applyPatch` a
settings-form save uses — one validator, now three callers. The form reports refusals per field
instead of failing silently.

**Task 2 — what the operator can see** (`d7ea943`). A status panel bound to the pushed snapshot, and
a **bounded, masked** log tail over the exact file the existing `DailyRotateFile` transport already
writes. Bounded so a long event cannot grow the window without limit; masked at the tail's own
boundary via `SECRET_MASK`, so a line carrying the WS token or the dslrBooth password never leaves
the main process rather than being filtered later by a caller who might forget.

**Task 3 — the tray, the close button, the login item** (`779b5d8`). Close hides to the tray and
leaves the relay running; only the tray's Quit sets `app.isQuitting` *before* `app.quit()`, so the
same handler that intercepts every other close lets the real one through exactly once. Two
preferences (start with Windows, start the relay on launch), both defaulting on, live under their
own key with their own channels — deliberately **not** added to `CONFIG_FIELDS`, so `config:set`'s
refusal of unknown keys stays exactly the property 10-02 pinned. The login item is written through
an injected adapter whose sole implementation is one line calling Electron's own
`setLoginItemSettings`, which also maintains the companion `StartupApproved` entry a raw registry
write would strand on removal.

`maybeAutoStartOnLaunch()` is a pure function over the store and the built handler map, so main.ts's
single call site and the table-driven test drive the identical decision across all four
complete/incomplete x on/off combinations — SC-1's real content: double-clicking the app starts the
Agent, and a first run is a setup form rather than a crash.

## Task Commits

| Task | Commit | What landed |
|------|--------|-------------|
| 1 | `bb3e35d` | `.env` import in one click; a settings form that explains its refusals |
| 2 | `d7ea943` | status panel; bounded, masked log tail |
| 3 | `779b5d8` | tray, close-to-tray, login item, launch decision, posture test |

## Files Created/Modified

Created: `src/electron/envImport.ts`, `src/electron/logTail.ts`, `src/electron/tray.ts`,
`scripts/make-icon.py`, `src/renderer/tray.png`, `build/icon.png`,
`test/electron-env-import.test.ts` (34 cases), `test/electron-logtail.test.ts` (20 cases),
`test/electron-shell-posture.test.ts` (31 cases).

Modified: `src/electron/{configStore,ipcHandlers,main,preload}.ts`,
`src/renderer/{index.html,index.js,styles.css}`, and two assertions in
`test/electron-{ipc,main-security}.test.ts` kept in step with the widened channel list.
1948 insertions, 82 deletions across 18 files.

## Deviations from Plan

None in scope or behaviour. Two **process** deviations worth recording honestly:

- **Tasks 1 and 2 were executed by an executor subagent that was killed mid-flight** by its host
  Claude Code process exiting. Both had already committed, so nothing was lost — the commit-per-task
  discipline is what made the interruption survivable.
- **Task 3 was finished inline by the orchestrator**, not a subagent. The dead agent had left task 3's
  source complete and typechecking (tray, icons, preferences, launch decision, renderer wiring) but
  **uncommitted and with its required test file missing**. Rather than dispatch a fourth subagent for
  one test file, the orchestrator reviewed the inherited source, wrote
  `test/electron-shell-posture.test.ts`, verified, and committed.

### Auto-fixed Issues

Two **vacuous assertions** were caught and fixed while writing the posture test — both would have
passed against broken code:

- The "login item has exactly one call site" check matched `ipcHandlers.ts`, which merely *names*
  `app.setLoginItemSettings` in the doc comment explaining why it injects an adapter instead of
  calling it. Now strips comment lines and matches the call expression `app.setLoginItemSettings(`.
- The tooltip check asserted only that the strings "running" and "stopped" appear somewhere in
  `tray.ts`, which a single constant tooltip would satisfy. Now extracts both branches of the
  ternary and asserts they differ.

A third error was mine and caught by the suite: the test's "complete configuration" fixture used
`triggerPort` where the field is `triggerServerPort`, so the patch was correctly refused as an
unknown key and four cases failed. Fixed the fixture, not the production rule.

Non-vacuity of the D9-07 ordering case proved by mutation: moving `app.quit()` ahead of the
`isQuitting` assignment turns it red; reverted before committing.

## Issues Encountered

The executor subagent for this plan died three times across the phase from its host process exiting
(see 10-02's summary for the same pattern). Progress was monotonic and nothing committed was ever
lost. The orchestrator also briefly interfered with a live agent by reverting a file it was
mid-edit on, having wrongly concluded the agent was dead; the agent rewrote it and no work was lost.

## User Setup Required

None on this machine. Everything in this plan is proven headless. The tray, the close-to-tray
behaviour, the Windows login item and the auto-start on launch are **confirmed on real Windows at
the phase gate in plan 10-04** — they are asserted here as source posture, which is what a Linux
build machine can honestly claim.

## Next Phase Readiness

Plan 10-04 (packaging + the phase's single blocking human gate) is unblocked. The two icons exist at
the paths the packaging configuration will expect, and `build:exe` still produces the pkg binary the
booth PC runs today, so the swap remains reversible until the operator performs it.

---

## Self-Check: PASSED

- All three task commits present in `git log`: `bb3e35d`, `d7ea943`, `779b5d8`
- All 9 created files present on disk; 205 tests / 12 files green
- `npm run typecheck` 0, `npm run build` 0, `npm run build:exe` 43.5MB
- `src/liveConfig.ts` unchanged; `mirror-request/` and `web-slide/` clean
- `src/display/launcher.ts` unmodified (D10-04)
