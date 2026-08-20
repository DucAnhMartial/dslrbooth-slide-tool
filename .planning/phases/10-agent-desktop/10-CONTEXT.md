# Phase 10 — Agent Desktop App: Context

**Gathered:** 2026-08-13, direct conversation with the operator (no formal
discuss-phase; the request and the shape were negotiated in-conversation,
including an explicit AskUserQuestion where the operator chose Electron over
the cheaper alternatives with costs stated).

## What the operator asked for, in their words

> "hiện tại ở agent tôi vẫn phải chạy bằng command để khởi chạy, điều này thật
> ko tự nhiên. Tôi nghĩ nên chuyển sang dạng desktop thì hay hơn, cho phép cấu
> hình và khởi chạy ở đó"

Offered three shapes with costs — local web control panel (recommended, ~1
plan), **Electron real desktop app (~150-200MB, new build chain, ~3-4 plans)**,
Windows service + CMS (no new GUI) — the operator chose **Electron**.

## Locked decisions

### D10-01: Electron, wrapping the existing core — LOCKED
The Agent's working core stays what it is: `WsConnection` (Bearer auth, Phase
3), the trigger server on :3001 (dslrBooth posts its events there), the
`LiveConfig` holder and `agentMessages` handler (Phase 8 pull config), the
`DslrBoothClient`, and the 31 tests that pin them. Electron HOSTS this core
(main process), it does not rewrite it. The renderer is the control UI.
**Reversibility:** costly but not one-way — the core remains runnable headless
(the pkg exe path still exists in package.json until a later phase retires it).

### D10-02: Local GUI writes bootstrap config — a sanctioned refinement of D-17's wording — LOCKED
D-17 says "the Agent never rewrites its own `.env`". Its threat model —
locked with D-16 — is about REMOTE writes: a compromised or misconfigured CMS
must never be able to change `extensionServiceWsUrl`/`extensionServiceWsToken`/
`triggerServerPort` and lock the operator out of the booth. That stays
absolute: the CMS pull path applies ONLY the four safe fields, in memory only,
and the allow-lists on both sides are untouched (D10-03).

A LOCAL settings form, on the booth PC itself, editing bootstrap values is the
same act as walking to the machine and editing `.env` by hand — which is
exactly the recovery path D-16 exists to preserve. The operator explicitly
asked for "cho phép cấu hình" in the app; this was surfaced to them as a
boundary question before Electron was chosen, with the 127.0.0.1-only
constraint stated. Any config UI the app serves over HTTP (if the renderer
talks to the main process over a local port rather than IPC) must bind
127.0.0.1 only. Prefer Electron IPC, which never touches the network.

### D10-03: The remote-config contract is UNTOUCHED — LOCKED
`config_request` / `config` / `reload_config`, `SAFE_AGENT_CONFIG_FIELDS` and
`READ_ONLY_AGENT_CONFIG_FIELDS` on both sides, applied in memory, never
persisted by the remote path. The cross-repo equality test keeps pinning it.
Success criterion 4 is a regression pin on this.

### D10-04: The kiosk popup stays retired — LOCKED (D9-07 carried forward)
The desktop app does not revive the Edge-kiosk guest display. `autoOpenDisplay`
remains a config field the CMS can flip; the launcher code remains as it is.
The desktop window is for the OPERATOR, not for guests.

## Claude's discretion (resolve during research/planning, record choices)

- **Config storage location**: Electron-conventional `app.getPath('userData')`
  JSON vs. a file beside the executable. Lean userData (survives app updates,
  standard Windows behaviour). MIGRATION: on first run, if a legacy `.env` is
  found beside the executable or in cwd, offer to import it — the booth PC
  already has a working `.env` and retyping a token by hand on a booth PC is
  exactly the friction this phase exists to remove.
- **Close-vs-quit**: closing the window should minimize to tray while the
  relay keeps running (a booth relay dying because someone closed a window is
  the D9-07 failure class); Quit lives in the tray menu. Record as a decision
  if implemented differently.
- **Auto-start with Windows**: offer as a checkbox (app.setLoginItemSettings
  or equivalent), default ON for a booth machine — but verify the researched
  mechanism works for the chosen packaging format.
- **Log surface**: tail the existing winston file logs into the window;
  do not re-plumb the logger.
- **Installer vs portable**: see research question R1. If NSIS-on-Linux proves
  fragile, portable zip is the accepted fallback (success criterion 5 says so).

## Research questions (this phase genuinely needs research — R1 is the risk)

- **R1 — Cross-compiling Electron for Windows from this Linux machine.**
  electron-builder targets: NSIS installer vs portable vs zip; which need wine;
  what breaks without code signing; icon embedding. The build MUST be
  producible on this machine (that is where the repo and CI-of-one live).
  Deliverable: the exact electron-builder config and the honest list of what
  a Linux build cannot do (e.g. signing) — stated, not discovered later.
- **R2 — Hosting the existing core in Electron's main process.** The core is
  plain Node (ws, express, winston, dotenv). Confirm none of it needs native
  modules that complicate electron rebuild (better-sqlite3 is NOT in the
  Agent's dependency tree — verify and state so). How the main process
  starts/stops the core cleanly (the WsConnection has reconnect timers; the
  trigger server holds a port).
- **R3 — pkg coexistence.** package.json currently builds a pkg exe
  (`build:exe`). Do the two build paths coexist, or does Electron's packaging
  conflict? Keep `build:exe` working this phase (D10-01 reversibility).
- **R4 — Renderer security posture.** contextIsolation on, nodeIntegration
  off, preload with a narrow IPC surface — the renderer displays operator
  data and edits credentials; it must not be a webview with Node powers.
  The token and dslrBooth password cross IPC — they must never reach a
  renderer console.log or the window title.

## Constraints carried forward (all still bind)

- The Agent is a **dumb relay**: no business logic, never calls the dslrBooth
  Local API on its own initiative. The desktop shell adds UI, not decisions.
- `mirror-request/` is NOT touched this phase (the service knows nothing about
  how the Agent is hosted).
- Tests: the 31 existing Agent tests keep passing unchanged. New shell logic
  (config store, import-from-.env, IPC contract) gets its own tests where
  testable without a display server; what is only provable by running the app
  on Windows goes into the blocking human gate, honestly listed.
- The phase ends with a **blocking human gate**: install/run on the real booth
  PC, first-run setup, connect to the real service, a real capture flowing
  through, tray behaviour. Nothing simulates that.
- Commit style unchanged; `--no-verify` never; planning artifacts never
  git-added. Work happens in `dslrbooth-agent/` only.

## Deployment note

The service at :3002 is LIVE production. The Agent on the booth PC currently
runs the pkg exe (SHA `863cfb71…`). Nothing in this phase may require a
service-side deploy, and the booth can keep running the pkg exe until the
human gate swaps it.
