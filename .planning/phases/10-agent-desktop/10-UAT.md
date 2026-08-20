---
status: testing
phase: 10-agent-desktop
source: [10-VERIFICATION.md, 10-04-PLAN.md Task 3]
started: 2026-08-13T18:52:00Z
updated: 2026-08-13T18:52:00Z
---

## Current Test

number: 1
name: Smart App Control is off (or in evaluation) on the booth PC
expected: |
  Settings → Privacy & security → Windows Security → App & browser control →
  Smart App Control reads Off or Evaluation. If it reads On, STOP — an unsigned
  application cannot be run past it, and the fix is a Windows setting, not a
  build change. Report it and the remaining tests are blocked, not failed.
awaiting: user response

## Artifact Under Test

Built on the Linux machine in `electronuserland/builder:wine`, not signed:

- Installer: `dslrbooth-agent/release/dslrbooth-agent-Setup-1.0.0-x64.exe` (~96 MB) — recommended
- Portable: `dslrbooth-agent/release/dslrbooth-agent-Portable-1.0.0-x64.exe` (~96 MB)
- Zip: `dslrbooth-agent/release/dslrbooth-agent-1.0.0-x64.zip` (~135 MB)

There is no code-signing certificate, so the file carries no provenance of its own —
transfer it to the booth PC over a channel you already trust. Full detail in
`dslrbooth-agent/docs/OPS-RUNBOOK-AGENT.md`.

**Rollback at any point:** quit the application from the tray, start the old Agent again.
Nothing changed on the Extension Service side in this phase, so there is nothing to roll
back there. `npm run build:exe` still produces the 43.5MB pkg `dslrbooth-agent.exe` the
booth PC runs today (D10-01).

## Tests

### 1. Smart App Control check
expected: Off or Evaluation. If On, stop and report — remaining tests are blocked.
result: [pending]

### 2. Record how the Agent runs today
expected: You can state whether it is `dslrbooth-agent.exe` started by hand or the `dslrBooth Agent` Windows service. This is your rollback path.
result: [pending]

### 3. Stop the current Agent
expected: The old Agent is stopped and no longer holds port 3001.
result: [pending]

### 4. Install (SC-5)
expected: |
  The installer runs. Windows shows "Windows protected your PC" → More info → Run anyway.
  Report the EXACT wording you see — the runbook's description of this screen comes from
  documentation, not from anyone's eyes.
  If double-clicking does nothing at all with no dialog, that is Smart App Control blocking
  silently — stop and report.
result: PASSED (rebuilt installer, SHA256 2bbbeda7…). Exact SmartScreen wording still not
  captured — the runbook's §2 description remains documentation-derived, not eyewitnessed.

### 5. First run: import the real .env (SC-1)
expected: |
  The window offers to import the existing `.env` and shows the path it found. After import,
  the form shows both secrets as SET without displaying their values anywhere.
result: PASSED implicitly — the relay could not have authenticated without both secrets being
  stored. Whether they arrived by `.env` import or by hand is not yet distinguished; ask before
  closing this item.

### 6. Start the relay from the window (SC-1, SC-2)
expected: Pressing Start connects. No terminal, no working-directory discipline.
result: PASSED, verified from the service side at 2026-08-13 19:34 UTC — an ESTABLISHED TCP
  connection 192.168.12.100:3002 ← 192.168.70.2:54184, and the service logged
  `Agent connected: agent-1x7x8x6x6x4x9x6x2x1x5x9x7-2`. Bearer auth accepted (contrast the
  earlier `Agent WS rejected` line, which was the orchestrator's deliberate token-less probe).
  This is the first end-to-end confirmation that the desktop app relays at all, and it
  validates the UAT-01..04 fixes in commit f65d327.

### 7. Status panel reads correctly (SC-3)
expected: |
  Within a few seconds: service connection reads connected; dslrBooth reads reachable
  (if dslrBooth is running); log lines appear in the pane. Report what all three say.
result: [pending]

### 8. One real capture end to end (SC-1) — the only test that matters
expected: |
  Dispatch a session as you normally would, let one guest session run to the end — a real
  photo, a real print composite. Confirm on the service side that events arrived exactly as
  they always did.
result: [pending]

### 9. Close to tray, relay survives (SC-3)
expected: |
  Clicking X hides the window to the system tray instead of shutting down. Another trigger
  still relays, or the service still shows the Agent connected a minute later. Reopening from
  the tray icon restores the window.
result: [pending]

### 10. Reboot with start-with-Windows (SC-3, SC-5)
expected: |
  With start-with-Windows ticked, restart the booth PC and log in. The application comes back
  by itself and reconnects without you opening anything. Report whether it did, and whether it
  needed a login first.
result: [pending]

### 11. Optional: settings survive reinstall or the portable build
expected: |
  Uninstall and reinstall, or switch to the portable executable. Settings survive — they live
  under the Windows user profile, not beside the executable.
result: [pending]

## Summary

total: 11
passed: 3
issues: 1
pending: 7
skipped: 0
blocked: 0

## Results so far (2026-08-13, booth PC is UTC+7)

- **Test 1-3 PASSED.** Smart App Control not blocking; the old Agent is confirmed NOT holding
  port 3001 — dslrBooth's own log shows `actively refused (127.0.0.1:3001)`, which means nothing
  was listening at all, not that something else held it.
- **Test 4 PASSED** (install succeeded — exact SmartScreen wording still not captured).
- **Test 6 FAILED — see UAT-01 below.** Pressing Start produced no visible change.

## Gaps

**All four FIXED in commit `f65d327`; installer rebuilt.** Suite 241 → 258 tests / 15 files, both
new gates proved non-vacuous by mutation. Re-transfer the installer and restart at test 4.

New installer SHA256 — the old one is superseded and must not be installed:
```
2bbbeda7235501eb1d65ac06bcc23fb5762775842603c11596755ca01e13f15a
```

### UAT-04 — the preload died under `sandbox: true`, taking every button with it — ROOT CAUSE, FIXED

`preload.ts` imported its two push-channel constants from `./ipcHandlers`, which tsc emitted as
`require("./ipcHandlers")`. A sandboxed preload's `require` is a polyfill limited to `electron` and
a few core modules, so the call threw, the preload died before
`contextBridge.exposeInMainWorld('agentDesktop', api)`, and `window.agentDesktop` was never defined.
Every handler — Save, Start, Stop, Import — then threw inside an async listener as an unhandled
rejection with nothing surfaced anywhere.

This single defect explains every observation: no `config.json`, dslrBooth refused on :3001 (no
trigger port bound), Extension Service log silent (no socket dialled), app log empty (no IPC ever
reached the main process), and a window that responded to nothing.

**Why 205 tests missed it:** `electron-main-security.test.ts` asserted `sandbox: true` was present
AND that the preload shared ipcHandlers' constants so the channel lists could not drift. Both
assertions were correct in isolation and fatal in combination, and no test ever loaded the
*compiled* preload in a sandboxed renderer.

**Fix:** the constants are literals in `preload.ts`, asserted equal to `ipcHandlers`' exports by
`test/electron-preload-sandbox.test.ts`, which also asserts the built artifact requires nothing but
`electron` and that the preload covers every channel `ipcHandlers` serves. Mutation-proved:
restoring the import turns 4 cases red.

### UAT-01 — the renderer wipes Start's own failure message — FIXED

**Severity:** blocking for UAT progress — it hides every other failure, so no further test can be
diagnosed until it is fixed.

`src/renderer/index.js:237-244` writes a failed `start()`'s message into `#status-last-error`, then
immediately calls `refreshStatus()`, whose `renderStatus()` (line 111) overwrites that element with
`status.lastError || '-'`. When `start()` fails on invalid configuration the Agent is never
constructed, so the snapshot's `lastError` is empty and the message is erased in the same tick. The
`onStatus` push subscriber (line 251) clobbers it the same way.

Symptom: pressing Start appears to do nothing at all.

**Why 205 passing tests missed it:** the suite proves `ipcHandlers` RETURNS the field-error map
(test/electron-ipc.test.ts, electron-config-ipc.test.ts) but no test asserts the renderer ever
DISPLAYS it. Correct lower layer, swallowing upper layer.

**Evidence gathered:** Extension Service log completely silent across the Start attempt, and no TCP
connection on :3002 — so `start()` never dialled. dslrBooth refused on :3001 — so `start()` never
bound the trigger port either. Since `start()` binds before dialling, both being absent means it
failed at or before the first step, consistent with a refused configuration.

**Proposed fix:** hold the start failure in a module-scoped value; `renderStatus` renders
`status.lastError || pendingStartError || '-'`; clear it on a successful start or a config change.
Add a regression case asserting the message survives a subsequent `refreshStatus()`.

**Root cause of the underlying start failure: still unknown** — awaiting the app's own log and
whether `config.json` was written. Fix batched with UAT-01 so the installer is rebuilt and
transferred once, not twice.

### UAT-02 — the runbook documents a user-data path that does not exist

**Severity:** ops-blocking at an event, though it breaks nothing at runtime.

`docs/OPS-RUNBOOK-AGENT.md` lines 141 and 166 tell the operator to look in:

```
%APPDATA%\dslrBooth Agent\config.json
%APPDATA%\dslrBooth Agent\logs\app-<YYYY-MM-DD>.log
```

That folder never exists. Electron resolves `app.getPath('userData')` from `app.getName()`, which
reads `name` in the packaged `package.json` — confirmed by extracting `package.json` from the built
`app.asar`: it carries `name: "dslrbooth-agent"` and **no** `productName`. `"dslrBooth Agent"` is
only `electron-builder.json`'s `productName`, which names the installer, the shortcut and the
Programs entry — not the data directory. The real paths are:

```
%APPDATA%\dslrbooth-agent\config.json
%APPDATA%\dslrbooth-agent\logs\app-<YYYY-MM-DD>.log
```

Found the first time a human followed the runbook to read a log: the folder was not there.

**Two candidate fixes, needs a decision:**
1. Correct the runbook to the real path — minimal, zero behaviour change.
2. Add `productName: "dslrBooth Agent"` to `package.json` so the data directory matches the name
   the installer and shortcut already show — nicer for an operator, but it CHANGES the userData
   path, so any config written by the current build would be orphaned. Cheap to do now (no booth PC
   has a working config yet), expensive after the first successful event.

A declined step is a legitimate answer and will be recorded as declined, never as passed.
