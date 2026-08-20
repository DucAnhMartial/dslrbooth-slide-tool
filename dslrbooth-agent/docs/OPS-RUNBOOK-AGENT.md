# dslrBooth Agent — Operations Runbook

**A deviation, stated up front:** the service-side operations runbook
(`mirror-request/docs/OPS-RUNBOOK.md`) is the place a document like this
would normally live, and this phase deliberately does not touch that
repository (D10-03; `mirror-request/` is out of scope for Phase 10). This
runbook therefore lives here, in the Agent's own repository, instead. A
cross-reference from the service runbook's §7 (the Agent WebSocket auth
contract) back to this document is deliberately **deferred** to a phase
that is allowed to edit that file — an undocumented split between two
runbooks is worse than a documented one, which is what this paragraph is.

This document is written for the person standing at the booth PC with the
built artifact on a USB stick, not for someone reading source code.

---

## 1. Which artifact, and where it came from

`scripts/build-win.sh`, run on the Linux machine that holds this
repository, produces three files in `dslrbooth-agent/release/`:

| File pattern | What it is |
|---|---|
| `dslrbooth-agent-Setup-<version>-<arch>.exe` | The installer (NSIS). Preferred for a booth PC that is meant to keep running this application long-term — it registers an uninstall entry and creates Start Menu shortcuts. |
| `dslrbooth-agent-Portable-<version>-<arch>.exe` | The portable executable. No installer, no uninstall entry, no Start Menu shortcut — just a single `.exe` you can run in place or from a USB stick. See §5 for what "portable" does and does not mean here. |
| `dslrbooth-agent-<version>-<arch>.zip` | A zip of the same unpacked application the installer would have placed on disk. Useful for manual inspection or an air-gapped transfer; not the recommended day-to-day artifact. |

The build script also writes `release/.builder-image-digest`, the resolved
digest of the `electronuserland/builder:wine` Docker image the artifacts
were packaged inside. **Quote that digest here when you actually build:**

```
Builder image digest (from release/.builder-image-digest, the build that produced
version 1.0.0's artifacts on 2026-08-13):
electronuserland/builder@sha256:41ae540902461b6cbc988987db79547fcc10cda04d2a6c6367504f59d4b37c64
```

A later build against a different image digest is meant to be visible here,
not silent — update this line (or note the discrepancy) the next time this
document is read alongside a fresh build.

Every artifact is **unsigned** — see §2 for what that means on first
launch. Because there is no certificate, this digest is the only
provenance the artifact carries at all: transfer it to the booth PC over a
channel you already trust (a USB stick you control, a direct copy — not an
inbox you don't), and note here (or verbally, at install time) which
channel was used.

---

## 2. Every artifact is unsigned — what Windows shows, and the exact click path

There is no code-signing certificate in this phase's scope (10-RESEARCH's
"What a Linux Build Honestly Cannot Do" #1). `electron-builder.json` — this
runbook's sibling in the repository — carries no signing key of any kind,
on purpose and permanently for this phase, not as something left
unfinished.

The consequence, **expected and not yet reproduced on a real Windows
machine by anyone as of this writing** (see §7's verified-versus-awaiting
list):

1. Running the installer or the portable executable should show a blue
   **"Windows protected your PC"** SmartScreen interstitial, because the
   file has no recognized publisher.
2. The click path past it: **More info** → a **Run anyway** button appears
   → click it.
3. This is expected on *every* first run of *every* unsigned build,
   forever, unless a code-signing certificate is added in a later phase —
   it does not go away by "getting more downloads" the way a signed
   binary's SmartScreen reputation might.

If instead the file does **nothing at all** when double-clicked — no
dialog, no window, nothing — do not assume it is broken. Go to §3: that
silence is a different, more serious condition with a different fix.

---

## 3. Smart App Control — there is no per-application override

Windows 11's **Smart App Control** (an opt-in evaluation-mode feature on
some clean installs) is stricter than the SmartScreen warning in §2. If it
is **ON**, an unsigned, unrecognized executable **cannot be run at all** —
there is no "Run anyway" button, no per-application exception, nothing to
click past.

**The silent-block signature, distinct from SmartScreen's visible dialog:**
double-clicking the installer or the portable `.exe` does **nothing
visible** — no dialog appears, no window opens, no error. That silence,
specifically in place of the dialog §2 describes, is the sign Smart App
Control is on.

**The only remedies**, and neither is something this build can fix:

- Turn Smart App Control off on that specific Windows installation
  (`Settings → Privacy & security → Windows Security → App & browser
  control → Smart App Control`). This is a Windows setting, not a build
  setting, and it is a decision to make deliberately — not something to
  toggle mid-event.
- Obtain a real code-signing certificate. Out of this phase's scope
  entirely.

**Check this before doing anything else on the booth PC** — before
stopping the current Agent, before installing, before anything in §4. If
Smart App Control is on, none of the rest of this runbook is actionable
until that is resolved.

---

## 4. Installing on a booth PC that is already running an Agent

The new application binds the same trigger port (`3001` by default) the
currently-running Agent already holds. Do these in order:

1. **Stop the current Agent.** Whether it is the `dslrbooth-agent.exe`
   process running directly or the `dslrBooth Agent` Windows service
   (`npm run service:uninstall` was never run against it, or it was —
   check `services.msc` for a service by that name), stop it now. If you
   skip this step, the new application's port bind will fail with a
   readable error rather than crash — but it will not relay anything
   until the old one is stopped. This is Plan 10-01's error-seam behavior
   (`triggers/server.ts`'s `onError` callback), carried through
   unchanged.
2. **Install.** Run the chosen artifact from §1. Click past the warning
   from §2 (or stop at §3 if that's what you see instead).
3. **First run.** The window should offer to import the `.env` already on
   this machine (checked, in order, beside the installed executable, in
   the current working directory, and in this application's own user-data
   directory — see §5). Click **Import** if offered; the form should then
   show both secrets as set, without ever displaying their values.
4. **Start.** Click the **Start** button in the status panel.

---

## 5. Where configuration and logs live — for every packaging format

Configuration is a JSON file at:

```
%APPDATA%\dslrbooth-agent\config.json
```

**Note the folder name.** It is `dslrbooth-agent`, the `name` field in
`package.json` — *not* `dslrBooth Agent`, which is `electron-builder.json`'s
`productName` and names only the installer, the Start-menu entry and the
desktop shortcut. Electron derives the user-data folder from
`app.getName()`, which reads `name`. This document said `dslrBooth Agent`
until the first booth-PC install, where the operator opened a folder that
does not exist and concluded, reasonably, that the application had written
no logs at all (UAT-02). Paste the path into the Run box (`Win+R`) rather
than typing it.

This is Electron's conventional `app.getPath('userData')`, and it is the
**same path for every packaging format** — the installer, the portable
executable, and running the unpacked zip's contents directly.

**"Portable" means "no installer needed," not "carries its settings with
it."** If you move the portable `.exe` to a different Windows machine (or
a different Windows user account on the same machine), it does **not**
bring `config.json` with it — the new machine starts with an empty
configuration and the same first-run import offer described in §4. This
matches the installed build's behavior exactly, which is the deliberate
choice recorded in 10-RESEARCH's Open Question 1: consistency between
install paths was judged worth more than USB-portability nobody asked for.

Secrets inside `config.json` (the Extension Service WebSocket token, the
dslrBooth password) are wrapped via Windows' own credential store
(Electron's `safeStorage`, DPAPI-backed) whenever it is available, and
degrade to a plainly-recorded-unwrapped value with a logged warning only
if it is not — never silently.

Logs live at:

```
%APPDATA%\dslrbooth-agent\logs\app-<YYYY-MM-DD>.log
```

(Same folder-name caveat as §5 above: `dslrbooth-agent`, not
`dslrBooth Agent`.)

— the same daily-rotating file the CLI/service build has always written
(`winston-daily-rotate-file`, 14-day retention), just relocated under the
application's user-data directory instead of a `logs/` folder beside the
executable, because an installed application cannot reliably write beside
its own executable on Windows. The window's log pane tails this exact
file — nothing about the logger itself was re-plumbed for this phase.

---

## 6. Tray, auto-start and start-with-Windows

- **Closing the window (the X button) minimizes to the system tray.** The
  relay keeps running. This is deliberate — the D9-07 failure class this
  project already treats as unacceptable is a booth relay dying because
  someone closed a window.
- **Quit lives in the tray icon's context menu** (right-click, or the
  platform-equivalent activation → **Quit**). The tray menu also offers
  **Show**, which restores and focuses the window. Quit is the only path
  that actually ends the process; the window's own close button never
  does.
- **"Start the relay automatically when the app launches"** and **"Start
  with Windows"** are two independent checkboxes in the preferences panel,
  **both on by default**. The first controls whether `agent:start` fires
  automatically on app launch (only when the stored configuration is
  complete — an incomplete configuration always shows the setup form
  first, regardless of this checkbox). The second calls Electron's
  `app.setLoginItemSettings` — the one-line, single-call-site binding
  this codebase uses rather than a hand-rolled registry write, which also
  correctly maintains the companion `StartupApproved` entry Windows checks
  so the login item does not get silently stranded if it's ever removed.

---

## 7. What was verified on this Linux machine, and what is awaiting the gate

This is a Linux build machine with no display server. Everything below the
line was proven the way a Linux machine honestly can; everything above
awaits a human on the real booth PC (10-04's blocking gate, Task 3).

**Verified here, by the automated suite and this session's own commands:**

- The packaging configuration's invariants (output directory does not
  collide with the compiler's, the file set includes the compiled output
  and the copied renderer and excludes the environment file/log
  directory/service-only dependency/map-and-declaration debris, no signing
  key anywhere, the three Windows targets configured, artifact names carry
  no spaces, the icon is a real ≥256px PNG) — `test/packaging-config.test.ts`.
- `npm test`, `npm run typecheck` and `npm run build` all exit clean at
  this commit.
- `npm run build:exe` still produces the pkg executable the booth PC runs
  today, at this commit (D10-01's reversibility clause).
- The renderer's security posture (context isolation, sandbox, no node
  integration, navigation refused, the preload surface) — pinned in plan
  10-02/10-03's own test files, unchanged by this plan.

**Awaiting the phase gate, on real Windows, by a human (10-RESEARCH's
"What a Linux Build Honestly Cannot Do" #2, #3, #4):**

- The SmartScreen "Windows protected your PC" dialog actually appearing,
  and the exact wording it shows (§2's description is aggregated from
  secondary sources, not reproduced on a Windows box).
- Smart App Control's silent-block signature actually looking the way §3
  describes.
- The `.env` import offer actually finding and importing a real file.
- A real capture flowing end to end through a real dslrBooth session.
- The window closing to tray with the relay still running, confirmed by a
  real trigger or a real connection check.
- The start-with-Windows login item actually surviving a real reboot.
- Settings actually surviving an uninstall/reinstall or a switch to the
  portable executable, as §5 claims they should.

---

## 8. Rollback

The booth PC's existing Agent — the `dslrbooth-agent.exe` produced by
`npm run build:exe` — is the rollback target, and it stays reversible
through this whole phase (D10-01): `build:exe` is still exercised by
`npm test`'s surrounding verification at every commit in this plan, so
"the old path still works" is not an assumption made once and then left
unchecked.

To put the booth back on it:

1. Quit the new application from its tray icon (§6).
2. Start the old `dslrbooth-agent.exe` the way this booth normally starts
   it (double-click, or `npm run service:install` if it runs as the
   Windows service).

Nothing on the Extension Service side changed in this phase (D10-03's
remote-config contract is untouched, and `git -C mirror-request status
--short` stays empty across every commit here), so there is nothing to
roll back on that side — the rollback is entirely local to the booth PC.

---

## 9. Build commands (for the build machine, not the booth PC)

These are unchanged from — and still exactly right for — the Linux machine
that holds this repository. Nothing here runs on the booth PC.

```bash
cd dslrbooth-agent
npm install
npm run build          # tsc + copy the renderer into dist/
npm test                # the full suite
npm run typecheck
npm run build:exe       # the pkg fallback binary (D10-01)
bash scripts/build-win.sh   # the installer, portable exe and zip (this document's §1)
```
