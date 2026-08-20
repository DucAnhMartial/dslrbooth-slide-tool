# Phase 10: Agent Desktop App — Research

**Researched:** 2026-08-13
**Domain:** Electron packaging/cross-build on Linux, Node process lifecycle refactor, Electron renderer security
**Confidence:** MEDIUM — R2/R3 are HIGH (verified directly against this repo's code and a live `vitest run`); R1's wine/NSIS mechanics and R4's Electron security defaults are MEDIUM-HIGH (official docs, cross-checked, versions cited); the *operator-facing* Windows behavior (SmartScreen wording, Smart App Control) is MEDIUM (consistent secondary sources, not independently reproduced on a Windows box this session — the phase gate is where that gets proven for real).

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**D10-01: Electron, wrapping the existing core — LOCKED.** The Agent's working core stays what it is: `WsConnection` (Bearer auth, Phase 3), the trigger server on :3001 (dslrBooth posts its events there), the `LiveConfig` holder and `agentMessages` handler (Phase 8 pull config), the `DslrBoothClient`, and the 31 tests that pin them. Electron HOSTS this core (main process), it does not rewrite it. The renderer is the control UI. **Reversibility:** costly but not one-way — the core remains runnable headless (the pkg exe path still exists in package.json until a later phase retires it).

**D10-02: Local GUI writes bootstrap config — a sanctioned refinement of D-17's wording — LOCKED.** D-17 says "the Agent never rewrites its own `.env`". Its threat model — locked with D-16 — is about REMOTE writes: a compromised or misconfigured CMS must never be able to change `extensionServiceWsUrl`/`extensionServiceWsToken`/`triggerServerPort` and lock the operator out of the booth. That stays absolute: the CMS pull path applies ONLY the four safe fields, in memory only, and the allow-lists on both sides are untouched (D10-03). A LOCAL settings form, on the booth PC itself, editing bootstrap values is the same act as walking to the machine and editing `.env` by hand — which is exactly the recovery path D-16 exists to preserve. Any config UI the app serves over HTTP (if the renderer talks to the main process over a local port rather than IPC) must bind 127.0.0.1 only. Prefer Electron IPC, which never touches the network.

**D10-03: The remote-config contract is UNTOUCHED — LOCKED.** `config_request` / `config` / `reload_config`, `SAFE_AGENT_CONFIG_FIELDS` and `READ_ONLY_AGENT_CONFIG_FIELDS` on both sides, applied in memory, never persisted by the remote path. The cross-repo equality test keeps pinning it. Success criterion 4 is a regression pin on this.

**D10-04: The kiosk popup stays retired — LOCKED (D9-07 carried forward).** The desktop app does not revive the Edge-kiosk guest display. `autoOpenDisplay` remains a config field the CMS can flip; the launcher code remains as it is. The desktop window is for the OPERATOR, not for guests.

### Claude's Discretion

- **Config storage location**: Electron-conventional `app.getPath('userData')` JSON vs. a file beside the executable. Lean userData (survives app updates, standard Windows behaviour). MIGRATION: on first run, if a legacy `.env` is found beside the executable or in cwd, offer to import it.
- **Close-vs-quit**: closing the window should minimize to tray while the relay keeps running; Quit lives in the tray menu. Record as a decision if implemented differently.
- **Auto-start with Windows**: offer as a checkbox (`app.setLoginItemSettings` or equivalent), default ON for a booth machine — but verify the researched mechanism works for the chosen packaging format.
- **Log surface**: tail the existing winston file logs into the window; do not re-plumb the logger.
- **Installer vs portable**: see R1. If NSIS-on-Linux proves fragile, portable zip is the accepted fallback (success criterion 5 says so).

### Deferred Ideas (OUT OF SCOPE)

None listed in CONTEXT.md for this phase.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| UI-02 (extended) | The Agent is configurable without editing `.env` on the booth PC | R2 (createAgent factory + userData config), R4 (IPC config surface), D10-02/D10-03 sections below |

Success criteria 1-5 from ROADMAP.md §Phase 10 are the operative acceptance bar; see `## Validation Architecture`.
</phase_requirements>

## Summary

The repo has **zero native Node modules** anywhere in its dependency tree (`ws`, `express`, `winston`, `winston-daily-rotate-file`, `dotenv` are pure JS; `node-windows` — a service-install-only dependency, unused by `src/index.ts` — depends only on `xml` and `yargs`, also pure JS). This is the single biggest fact shaping the whole phase: **no native-module rebuild step is needed anywhere** — not for `electron-rebuild`, not for `pkg`, not for `electron-builder`'s asar packaging. `git grep`/`find` confirmed no `binding.gyp` and no `.node` files anywhere under `node_modules/` `[VERIFIED: dslrbooth-agent/package.json:19-25, dslrbooth-agent/node_modules/node-windows/package.json:14-17, find for binding.gyp/*.node returned empty]`.

`electron-builder` (current stable **26.15.3**, v27 still alpha `[VERIFIED: npm view electron-builder dist-tags, 2026-08-13]`) is the right tool over Electron Forge: same functional coverage, more mature Linux→Windows cross-build path, and its docs explicitly cover the exact "Docker with wine" workflow this machine needs. Building the `nsis` target (the default) on Linux **requires Wine 2.0+** — not because NSIS compilation needs it, but because **`rcedit` (icon/version-resource embedding) bundles a Windows `.exe` and needs Wine to run, and this happens even with signing disabled** (`win.sign: false` — "resedit resource editing still runs") `[CITED: raw.githubusercontent.com/electron-userland/electron-builder/master/website/docs/features/multi-platform-build.md, code-signing-win.md — fetched 2026-08-13]`. Portable and zip targets need the same rcedit pass, so **all three Windows targets need Wine on this Linux box** — none of them is wine-free. There is no code-signing certificate in this phase's scope (none was mentioned in CONTEXT.md and none should be purchased just to unblock a build), so the honest operator experience is a Windows SmartScreen "unknown publisher" interstitial requiring "More info → Run anyway" on first launch — and, if the booth PC has Windows 11's **Smart App Control** turned on, no override is possible at all until SAC is disabled `[CITED via WebSearch, cross-checked against 3+ independent sources, 2026]`.

The core refactor is small and mechanical: `src/index.ts` currently wires everything at module load inside one `main()` — a `createAgent(config, logger)` factory that defers `WsConnection` construction and, critically, defers `createTriggerServer()` (which binds `:3001` immediately inside its constructor today) until an explicit `.start()` call, with a matching `.stop()` that calls the already-correct `ws.disconnect()` (fully clears timers/listeners, confirmed by reading `connection.ts`) and `triggerServer.close()`. Both the CLI/pkg entry and Electron's main process import the same factory — the pkg build path (`build:exe`) and the Electron packaging path do **not** conflict; they consume the same `dist/` output through two different entry files, and `pkg` (archived by Vercel 2024-01-13, last release 5.8.1, confirmed still executing under this machine's Node 24) should be kept exactly as CONTEXT.md's reversibility clause requires — frozen, not maintained forward `[VERIFIED: npm view pkg deprecated/versions, GitHub archive notice via WebSearch]`.

**Primary recommendation:** electron-builder 26.x, targets `["nsis", "portable", "zip"]` all built via the `electronuserland/builder:wine` Docker image (avoids fighting local Wine setup on this machine), `win.sign: false` documented as a known gap, a `createAgent()` factory extracted from `src/index.ts` shared by both entry points, IPC-only renderer (no local HTTP surface at all — satisfies D10-02's "prefer IPC" clause outright), and `safeStorage` (DPAPI-backed on Windows) wrapping the two secrets in the userData JSON at rest.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| WS relay to Extension Service, trigger HTTP server, dslrBooth Local API calls | Electron **main process** (Node) | — | This is the existing "core" (D10-01) — plain Node, no DOM access needed or wanted |
| Bootstrap config storage (URL/token/ports/password) | Electron main process (`userData` JSON via `safeStorage`) | — | Must never be reachable from the renderer's JS context directly; main is the only tier with `safeStorage`/filesystem access |
| Settings form, connection status, log tail, tray | **Renderer** (BrowserWindow, contextIsolated) | Electron main (IPC endpoints) | Pure presentation; every credential read/write crosses IPC to main, never touches network or DOM storage |
| Remote CMS config pull (`config_request`/`config`/`reload_config`) | Electron main process | — | Untouched contract (D10-03) — lives inside the same core the main process hosts, no renderer involvement at all |
| OS integration: tray, login item, single-instance lock | Electron main process | — | `app`/`Tray`/`BrowserWindow` APIs are main-process-only in Electron |
| Booth-side Edge kiosk display (guest-facing) | Electron main process (spawns `msedge.exe` exactly as today) | — | D10-04: untouched, still `child_process.spawn`, no relationship to the operator's Electron window |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `electron` | 43.4.0 (current stable) | Desktop shell runtime | Official Electron project; current major as of 2026-08-13 `[VERIFIED: npm view electron version]` |
| `electron-builder` | ^26.15.3 (NOT `next`/v27-alpha) | Packaging: asar, NSIS/portable/zip, icon/resource embedding | Most mature Linux→Windows cross-build docs and Docker image of the two candidates; see Alternatives below `[VERIFIED: npm view electron-builder dist-tags]` |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `electron-builder`'s bundled `@electron/get`/rcedit | (transitive) | Downloads Electron binary, embeds icon/version resource into the Windows exe | Automatic — no separate install; this is what needs Wine |
| (none — reuse `winston`) | existing `^3.19.0` | Log tail source for the renderer | D10 discretion explicitly says "do not re-plumb the logger" — read the existing daily-rotate file, don't add `electron-log` |
| (none — reuse `app.setLoginItemSettings`) | Electron built-in | Auto-start-with-Windows checkbox | Pure registry `Run` key write, no signing dependency, no extra package needed (see R2/R4 below) |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| electron-builder | Electron Forge (`@electron-forge/cli` 7.11.2) | Forge is the Electron-team-maintained option and gets first-party features (ASAR integrity, fuses) sooner, but its Windows-from-Linux story leans on the same underlying `@electron/windows-sign`/rcedit/Wine mechanics with less battle-tested docs for exactly this cross-build case; electron-builder's docs literally document the `electronuserland/builder:wine` Docker recipe this phase needs `[CITED: electronforge.io, electron.build — both fetched 2026-08-13]` |
| `app.setLoginItemSettings` | `auto-launch` npm package (v5.x, confirmed OK on package-legitimacy check, pure JS, no native binary) | `auto-launch` wraps the same registry-Run-key mechanism via `node-windows`-style helper scripts; Electron's own API does the identical job with zero extra dependency — no reason to add it |
| `safeStorage` | Plaintext JSON in `userData` | Simpler, but leaves the WS token and dslrBooth password sitting in cleartext on the booth PC filesystem; `safeStorage` is a one-call wrap backed by Windows DPAPI, essentially free |

**Installation:**
```bash
npm install --save-dev electron@43 electron-builder@26
```
(No `--save` runtime dependency needed beyond what's already there — Electron itself is a devDependency; the app's own code only ever needs the `electron` package's typed API surface, not a runtime require outside the main entry.)

**Version verification:** confirmed live against the npm registry on 2026-08-13 — `electron-builder` `latest` dist-tag is `26.15.3`, `next` is `27.0.0-alpha.6` (do not pin to this; the public docs site (`electron.build`) currently documents the **v27 (alpha)** config surface by default — e.g. `win.sign` replacing `win.signtoolOptions`, `electronGet` replacing `electronDownload` — which will NOT match a `^26.x` install. This is flagged explicitly as Pitfall 1 below.) `electron` `latest` is `43.4.0`. `pkg` is frozen at `5.8.1`, no newer version exists, package is `deprecated`/archived.

## Package Legitimacy Audit

| Package | Registry | Age (last publish) | Downloads/wk | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `electron` | npm | 2026-08-11 (patch release) | 5,963,206 | github.com/electron/electron | **SUS** (heuristic: "too-new" — misfires on a canonical, extremely-high-velocity official package) | **Approved with override note** — this is the literal Electron project, official org, ~6M weekly downloads; "too-new" fired because Electron ships patch releases every few days, not because this is a suspicious package. Planner should still record a `checkpoint:human-verify` per protocol, but it can be a one-line "yes, this is really electron/electron" check, not a deep audit. |
| `electron-builder` | npm | 2026-06-09 | 3,551,244 | github.com/electron-userland/electron-builder | OK | Approved |
| `electron-log` | npm | 2026-05-14 | 1,195,879 | github.com/megahertz/electron-log | OK | **Not used this phase** (see Alternatives — reusing winston instead); listed here only because it was checked as a candidate |
| `auto-launch` | npm | 2023-05-18 | 46,219 | github.com/4ver/node-auto-launch (fork of the original) | OK | **Not used this phase** — `app.setLoginItemSettings` covers the need with zero new dependency |
| `electron-updater` | npm | 2026-06-05 | 2,322,372 | github.com/electron-userland/electron-builder | OK | **Not used this phase** — auto-update is out of scope (not asked for in CONTEXT.md); note for a future phase only |

**Packages removed due to `[SLOP]` verdict:** none.
**Packages flagged as suspicious `[SUS]`:** `electron` — see override note above; add a lightweight `checkpoint:human-verify` before the planner's first `npm install electron@43`, not because the package is doubted, but because the protocol requires the gate and it costs nothing to confirm.

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────────────────────── Electron App Process Tree ───────────────────────────────┐
│                                                                                            │
│  ┌─────────────────────────────── MAIN PROCESS (Node) ─────────────────────────────────┐ │
│  │                                                                                       │ │
│  │   app.whenReady() ──► single-instance lock check ──► load config (userData JSON,     │ │
│  │                        (2nd launch: focus window,      or .env-import wizard on       │ │
│  │                         do not start a 2nd relay)       first run)                    │ │
│  │                                        │                                              │ │
│  │                                        ▼                                              │ │
│  │                              createAgent(config, logger)   ◄── SAME factory the       │ │
│  │                                        │                       CLI/pkg entry uses     │ │
│  │                     ┌──────────────────┼──────────────────┐                          │ │
│  │                     ▼                  ▼                  ▼                          │ │
│  │              WsConnection       createTriggerServer   DslrBoothClient                 │ │
│  │              (:3002 relay,      (:3001, dslrBooth      (127.0.0.1:1500,               │ │
│  │               reconnect loop)    posts events here)     Local API calls)              │ │
│  │                     │                  │                  │                           │ │
│  │                     │        onEvent → forward to WS      │                           │ │
│  │                     │                                     │                           │ │
│  │              status/log events flow UP via callbacks ─────┘                           │ │
│  │                     │                                                                  │ │
│  │                     ▼                                                                  │ │
│  │         IPC layer (ipcMain.handle / webContents.send) ◄── ONLY door to the renderer   │ │
│  │              - getConfig() → redacted snapshot                                        │ │
│  │              - setConfig(partial) → validate, safeStorage.encrypt, persist            │ │
│  │              - start()/stop()/restart() → agent.start()/agent.stop()                  │ │
│  │              - onStatus(cb) push: connected/disconnected, dslrBooth reachable          │ │
│  │              - onLogLine(cb) push: tail of today's winston file                        │ │
│  │                     │                                                                  │ │
│  └─────────────────────┼──────────────────────────────────────────────────────────────────┘
│                        │  contextBridge (contextIsolation:true, nodeIntegration:false)     │
│                        ▼                                                                   │
│  ┌────────────────────────── RENDERER PROCESS (Chromium, sandboxed) ───────────────────┐  │
│  │  preload.js: window.agentAPI = { getConfig, setConfig, start, stop,                  │  │
│  │                                    onStatus, onLogLine }                              │  │
│  │  Settings form / status panel / log pane — NO direct fs/net/Node access               │  │
│  └────────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                            │
│  Tray icon: click → show/focus window · context menu → Show/Quit                          │
│  Window close (X) → event.preventDefault() + hide() (D10 discretion: minimize to tray)    │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### Recommended Project Structure
```
dslrbooth-agent/
├── src/
│   ├── agent.ts              # NEW: createAgent(config, logger) factory (R2)
│   ├── index.ts               # CLI/pkg entry: loadConfig() from .env, createAgent().start()
│   ├── config.ts              # UNCHANGED — still the .env-based Config for CLI/pkg path
│   ├── electron/
│   │   ├── main.ts            # Electron main entry (package.json "main" for `electron .`)
│   │   ├── preload.ts          # contextBridge surface
│   │   ├── electronConfig.ts   # userData JSON load/save + safeStorage wrap + .env import
│   │   ├── ipc.ts              # ipcMain.handle registrations
│   │   ├── tray.ts             # Tray + close-to-tray + single-instance
│   │   └── logTail.ts          # tails today's winston daily-rotate file
│   ├── websocket/connection.ts # UNCHANGED (D10-01)
│   ├── triggers/server.ts      # UNCHANGED (D10-01)
│   ├── liveConfig.ts           # UNCHANGED (D10-01, D10-03)
│   ├── agentMessages.ts        # UNCHANGED (D10-01, D10-03)
│   ├── dslrbooth/client.ts     # UNCHANGED
│   ├── display/launcher.ts     # UNCHANGED (D10-04)
│   └── logging/logger.ts       # UNCHANGED
├── renderer/                   # NEW: settings form / status UI (framework choice = planner's call;
│                                #      plain HTML+TS is sufficient for this surface's size)
├── build/                      # NEW: icon.png / icon.svg for electron-builder
├── dist/                       # tsc output — UNCHANGED location, now also read by Electron main
├── service/install-service.js  # UNCHANGED
└── package.json                # "main" field changes to point at the Electron entry (see Pitfall 3)
```

### Pattern 1: `createAgent()` factory — deferred start, explicit stop

**What:** Extract the body of `src/index.ts`'s `main()` (config already loaded, logger already created) into a function that constructs but does **not** start anything, returning `{ start(), stop() }`.

**When to use:** Any place two different entry points (CLI/pkg vs. Electron main) need to run the identical core with different config-loading and different lifecycle triggers (process signals vs. IPC button clicks).

**Why this is a real refactor, not cosmetic:** `createTriggerServer()` calls `app.listen(config.port, ...)` **inside its own body, synchronously on call** (`src/triggers/server.ts:76`) — there is no separate `.listen()` step today. If `createAgent()` naively constructed the trigger server at factory-build time (matching today's `index.ts` shape), the port would already be bound the moment Electron's main process boots, before the operator ever clicks "Start" — defeating success criterion 2 ("first run with no configuration opens a setup form... the connection can be started, stopped and restarted from the window"). The port bind must move inside `start()`.

**Example (sketch, not final code — planner's job to finalize):**
```typescript
// src/agent.ts
import { DslrBoothClient } from './dslrbooth/client'
import { WsConnection } from './websocket/connection'
import { createTriggerServer } from './triggers/server'
import { LiveConfig } from './liveConfig'
import { createServiceMessageHandler, requestConfig } from './agentMessages'
import { closeDisplayWindow, openDisplayWindow } from './display/launcher'
import type { Config } from './config'
import type { Logger } from './logging/logger'

export interface AgentHandle {
  start(): void
  stop(): Promise<void>
  live: LiveConfig
  ws: WsConnection
  isRunning(): boolean
}

export function createAgent(config: Config, logger: Logger): AgentHandle {
  const dslrBooth = new DslrBoothClient(config.dslrBoothApiPort, config.dslrBoothPassword)
  const live = new LiveConfig(config, logger, {
    onCredentialsChange: (port, password) => dslrBooth.updateCredentials(port, password),
  })
  const ws = new WsConnection(
    {
      url: config.extensionServiceWsUrl,
      token: config.extensionServiceWsToken,
      reconnectBaseDelayMs: 2000,
      reconnectMaxDelayMs: 30000,
      heartbeatIntervalMs: 15000,
    },
    logger,
  )

  let triggerServer: ReturnType<typeof createTriggerServer> | null = null
  let activeJobId: string | undefined
  let running = false

  const handleServiceMessage = createServiceMessageHandler({
    live, logger,
    send: (payload) => { ws.send(payload) },
    updateDisplay: (patch) => { triggerServer?.updateDisplay(patch) },
    openDisplay: () => openDisplayWindow(config.triggerServerPort, logger),
  })

  ws.onStatusChange((status) => {
    logger.info(`WebSocket status: ${status}`)
    if (status === 'connected') requestConfig((payload) => { ws.send(payload) })
  })

  ws.onMessage(async (msg) => {
    if (handleServiceMessage(msg)) return
    if (msg.type !== 'command') return
    // ... identical command-branch body from today's index.ts (AGT-02/03), moved verbatim
  })

  return {
    live,
    ws,
    isRunning: () => running,
    start() {
      if (running) return
      triggerServer = createTriggerServer(
        {
          port: config.triggerServerPort,
          onEvent: (eventType, params) => {
            if (eventType === 'session_end') {
              triggerServer?.updateDisplay({ phase: 'idle', guestName: null, endsAt: null })
            }
            const photoUrl = params.photoUrl ?? params.photo_url ?? params.url
            ws.send({ type: 'event', event: eventType, jobId: activeJobId, payload: { ...params, ...(photoUrl ? { photoUrl } : {}) }, timestamp: Date.now() })
          },
        },
        logger,
      )
      ws.connect()
      running = true
    },
    async stop() {
      if (!running) return
      ws.disconnect()               // already tears down reconnect/heartbeat/stable timers — see connection.ts:122-135
      await closeDisplayWindow(logger)
      await triggerServer?.close()  // server.close() + closeAllConnections() — see server.ts:82-85
      triggerServer = null
      running = false
    },
  }
}
```

`src/index.ts` (CLI/pkg entry) shrinks to: `loadConfig()` from `.env` → `createLogger()` → `createAgent(config, logger)` → `.start()` → SIGTERM/SIGINT calls `.stop()` then `process.exit(0)`. This is a **behavior-preserving refactor** — the 31 existing tests exercise `WsConnection`, `LiveConfig`, `agentMessages`, and `createTriggerServer` directly (not through `index.ts`, confirmed by reading all three test files), so none of them need to change.

### Pattern 2: Electron main — config load, IPC surface, tray, single instance

**What:** `src/electron/main.ts` is the new `package.json` `"main"` entry. It never touches `.env`/`dotenv` directly — `loadConfig()` (the `.env`-based one in `src/config.ts`) stays exactly as-is for the CLI/pkg path; Electron gets its own config loader (`electronConfig.ts`) that reads/writes `app.getPath('userData')/config.json`, with `safeStorage` wrapping the two secrets.

**Example — single instance + tray + close-to-tray (standard Electron pattern, cross-checked against multiple independent sources, 2026):**
```typescript
// src/electron/main.ts
import { app, BrowserWindow, Tray, Menu } from 'electron'

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  let mainWindow: BrowserWindow | null = null
  let tray: Tray | null = null

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    mainWindow = new BrowserWindow({
      width: 900, height: 640,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    mainWindow.loadFile(path.join(__dirname, '../../renderer/index.html'))

    mainWindow.on('close', (e) => {
      if (!(app as any).isQuitting) {
        e.preventDefault()
        mainWindow?.hide()   // D10 discretion: close minimizes to tray, relay keeps running
      }
    })

    tray = new Tray(path.join(__dirname, '../../build/icon.png'))
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show', click: () => mainWindow?.show() },
      { label: 'Quit', click: () => { (app as any).isQuitting = true; app.quit() } },
    ]))
  })

  app.on('window-all-closed', (e: Event) => { e.preventDefault() }) // stay resident (tray owns lifetime)
}
```
`[Pattern cross-checked against multiple independent tutorials — Medium/hatchjs/codespeedy, 2026 — and Electron's own `app`/`Tray`/`BrowserWindow` API docs for method signatures; CITED not VERIFIED because no single official "how to build a tray app" doc page exists — this is composed from documented primitives.]`

### Pattern 3: Preload + IPC — narrow surface, no secret ever logged or persisted in renderer memory

**What:** `contextBridge.exposeInMainWorld` exposing exactly six functions; `ipcMain.handle` validating every inbound payload the same way `LiveConfig.apply()` already validates remote config (type checks, no silent coercion).

**Example (current recommended pattern, official docs, 2026):**
```typescript
// src/electron/preload.ts
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('agentAPI', {
  getConfig: () => ipcRenderer.invoke('config:get'),        // returns REDACTED snapshot only
  setConfig: (partial: Record<string, unknown>) => ipcRenderer.invoke('config:set', partial),
  start: () => ipcRenderer.invoke('agent:start'),
  stop: () => ipcRenderer.invoke('agent:stop'),
  onStatus: (cb: (s: unknown) => void) => ipcRenderer.on('agent:status', (_e, s) => cb(s)),
  onLogLine: (cb: (line: string) => void) => ipcRenderer.on('agent:logline', (_e, line) => cb(line)),
})
```
`[CITED: electronjs.org/docs/latest/tutorial/ipc — fetched 2026-08-13; contextBridge.exposeInMainWorld + ipcRenderer.invoke/ipcMain.handle for request/response, webContents.send + ipcRenderer.on for main→renderer push, matches this doc's current examples verbatim in shape]`

**The credential-safety contract (this is the answer to R4's hardest question):** `config:get` **never returns the plaintext `dslrBoothPassword` or `extensionServiceWsToken`**. It returns `{ dslrBoothPassword: hasValue ? '••••••••' : '', ...}` — a presence flag, not the value. The renderer's password `<input>` starts empty/placeholder; if the operator leaves it untouched, `config:set` must NOT overwrite the stored secret with the empty string (mirrors `LiveConfig.assign()`'s existing "empty password refused" rule, `liveConfig.ts:183-193`, `[VERIFIED: liveConfig.ts:183-193 — quoted: "An empty password is refused rather than applied... The value itself is never logged."]`). Only an explicit non-empty new value in `config:set`'s payload replaces the stored secret. This means the real secret value is only ever held in the renderer's JS heap for the single tick between the operator typing it and the `ipcRenderer.invoke('config:set', ...)` call resolving — never fetched back for display, never logged by any `console.log` in the renderer bundle (which should also be reviewed/grepped in code review, not just designed-around).

### Anti-Patterns to Avoid

- **Returning the live config object (with plaintext secrets) from `config:get` "to populate the form for editing."** This is the single most likely mistake — it puts the token/password into renderer JS memory for the whole session, inspectable via DevTools' Sources/Console/Memory panel, and one careless `console.log(config)` away from a leak. Use the redacted-snapshot + write-only pattern above.
- **`nodeIntegration: true` "just for this one screen" to make file access easier for the log tail.** Log tailing is a main-process job (`fs.watch` + IPC push); there is no renderer feature in this phase that needs raw Node access.
- **Skipping `contextIsolation` because the app is "just local, not a browser."** Electron's own security docs treat this as unconditional regardless of whether remote content is loaded, because it is what makes `contextBridge` (the only sanctioned communication channel) meaningfully sandboxed. `[CITED: electronjs.org/docs/latest/tutorial/security]`
- **Leaving the default Electron application menu in place in production.** It includes "Toggle Developer Tools" as a normal menu item/keyboard shortcut — on an app whose whole renderer purpose is editing credentials, leaving DevTools one click away for anyone standing at the booth is worth a deliberate decision (`Menu.setApplicationMenu(null)` or a custom menu without that item), not an oversight.
- **Putting the WS token or dslrBooth password in the BrowserWindow title, a URL query string, or any `window.localStorage`/`sessionStorage` key.** All three are trivially readable from DevTools' Application panel even with contextIsolation on, because they live in the renderer's own storage, not behind the IPC boundary.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Encrypting secrets at rest in the userData JSON | A custom XOR/AES wrapper with a hardcoded or derived key | `safeStorage.encryptString`/`decryptString` (Electron built-in, DPAPI-backed on Windows) | `[CITED: electronjs.org/docs/latest/api/safe-storage]` — "Typically, only a user with the same logon credential as the user who encrypted the data can typically decrypt the data." Zero key-management burden, one function call. |
| Windows icon/version-resource embedding | Hand-writing a `.rc` file and invoking `windres`/manual PE editing | electron-builder's bundled rcedit (needs Wine, see R1) | This is exactly the kind of low-level PE-format work a build tool exists to hide; hand-rolling it on Linux without Wine is strictly harder than installing Wine |
| Auto-start-with-Windows | Writing directly to the `HKCU\...\Run` registry key via a manual `regedit`/`reg add` shell-out | `app.setLoginItemSettings({ openAtLogin: true })` | `[CITED: electronjs.org/docs/latest/api/app]` — same registry key, but Electron's API also handles the `StartupApproved\Run` companion key and removal cleanly |
| Single-instance coordination | A lock file + PID check + manual IPC-over-socket | `app.requestSingleInstanceLock()` | `[CITED: electronjs.org/docs/latest/api/app]` — this exists specifically because naive lock-file approaches race and leak on crash |

**Key insight:** every "Don't Hand-Roll" item above has an official, one-call Electron or electron-builder API. The temptation on this phase is specifically to hand-roll the credential storage (because it "feels" custom to this app) — resist that; `safeStorage` is the standard answer and it is genuinely simpler than any bespoke alternative.

## Common Pitfalls

### Pitfall 1: Reading the electron-builder docs site and copying v27-alpha config syntax into a `^26.x` install
**What goes wrong:** `electron.build`'s live docs (fetched during this research) document the **v27 alpha** config surface by default — e.g. `win.sign: { type: "signtool", ... }` (replacing v26's `win.signtoolOptions`), `electronGet` (replacing v26's `electronDownload`). `npm view electron-builder version` (the `latest` tag) is **26.15.3**; v27 is only on the `next` dist-tag as `27.0.0-alpha.6`.
**Why it happens:** the documentation site tracks the `master` branch, not the last stable release, and doesn't visually distinguish "this is the not-yet-released syntax" from "this is what you get if you `npm install electron-builder` today" without reading the small `:::note[Upgrading from v26]` callouts.
**How to avoid:** pin `"electron-builder": "^26"` explicitly in `package.json`, and when consulting docs for exact config key names, cross-check against the callout boxes noting v26→v27 renames (several were found: `win.signtoolOptions`/`win.azureSignOptions` → `win.sign`; `electronDownload` → `electronGet`; `disableDefaultIgnoredFiles` removed).
**Warning signs:** a config key from the docs produces a schema-validation error at build time ("unknown configuration key") — that's the v26/v27 mismatch, not a typo.

### Pitfall 2: Building the NSIS/portable/zip target on this Linux machine without Wine installed at all
**What goes wrong:** the build fails outright (not silently) partway through, at the icon/resource-embedding step, because rcedit's bundled Windows executable cannot execute without Wine.
**Why it happens:** rcedit runs **regardless of the target type** (nsis, portable, zip all produce a real Windows `.exe` that needs its icon/version info set) and **regardless of `win.sign` being `false`** — signing and resource-editing are two separate steps; disabling one does not disable the other `[CITED: electron.build code-signing-win.md — "false or null | Disable signing (resedit resource editing still runs) | all"]`.
<br>**How to avoid:** install Wine 2.0+ on this machine, or (recommended, simpler) run the build inside the `electronuserland/builder:wine` Docker image, which ships Wine preconfigured — `docker run --rm -v $PWD:/project -v ${PWD##*/}-node-modules:/project/node_modules electronuserland/builder:wine` then `yarn && yarn dist` inside `[CITED: electron.build multi-platform-build.md, fetched 2026-08-13]`.
**Warning signs:** build log shows an rcedit-related error mentioning `wine`, `winecfg`, or "image not found" — this is a known, frequently-reported class of GitHub issue against electron-builder, not a config mistake in this repo.

### Pitfall 3: The pkg build path and the Electron entry both racing for `package.json`'s `main` field
**What goes wrong:** `pkg dist/index.js --targets node18-win-x64` (the existing `build:exe` script) explicitly names `dist/index.js` on its own command line — it does **not** read `package.json`'s `main` field. But plain `electron .` (and electron-builder's default packaging) **does** read `main` to find the app's entry point. If `main` still points at `dist/index.js` (today's CLI entry, which calls `process.exit()` on error and has no `app`/`BrowserWindow` code at all), `electron .` will load the wrong file and crash immediately with "app is not defined" or similar.
**Why it happens:** the two build tools were never designed to coexist in one `package.json` without an explicit choice about which entry `main` points to.
**How to avoid:** change `"main"` to the Electron entry (e.g. `"dist/electron/main.js"`). This is safe for `pkg` because `build:exe` never reads `main` — verified directly by re-reading the existing script (`"build:exe": "npm run build && pkg dist/index.js --targets node18-win-x64 --output dslrbooth-agent.exe"` `[VERIFIED: dslrbooth-agent/package.json:8]`).
**Warning signs:** `electron .` opens no window and exits with a stack trace referencing `process.exit` or a config-loading error meant for the CLI path.

### Pitfall 4: Constructing `WsConnection`/`createTriggerServer` at `createAgent()`-build time instead of inside `.start()`
**What goes wrong:** the trigger server binds `:3001` (and, if `ws.connect()` also moved to construction time, the socket starts dialing) the instant Electron's main process boots — before the operator has configured anything or clicked "Start". On first run with no config, this either crashes (bad URL/token) or silently starts relaying against defaults nobody chose, defeating success criterion 2.
**Why it happens:** `createTriggerServer()`'s existing signature calls `app.listen()` synchronously inside itself (`triggers/server.ts:76`) — there is no separate "construct then listen" step in the current code, so a naive port of `index.ts`'s wiring order into a factory reproduces the immediate-start behavior by default.
**How to avoid:** the sketch in Pattern 1 above defers `createTriggerServer()` and `ws.connect()` until `.start()` is explicitly called.
**Warning signs:** `:3001` is already bound (visible via `netstat`/Task Manager) before the operator has touched the settings form.

### Pitfall 5: Assuming a portable build carries its own config on a USB stick automatically
**What goes wrong:** `app.getPath('userData')` resolves to `%APPDATA%\<productName>` on Windows **for every packaging format**, including `portable` — the portable target does not automatically redirect userData beside the executable. If the operator expects to carry the whole app + its settings on a USB drive between booths, plain `app.getPath('userData')` silently leaves config behind on whichever machine's `%APPDATA%` it was last run on.
**Why it happens:** "portable" in electron-builder's terminology means "doesn't need an installer," not "fully self-contained with its own data directory" — that distinction is easy to miss and CONTEXT.md doesn't say which behavior the operator wants (this is a genuinely open question — see Open Questions).
**How to avoid:** if true portability is wanted, check `process.env.PORTABLE_EXECUTABLE_DIR` (set by electron-builder's portable launcher, `[CITED: electron.build nsis.md — "PORTABLE_EXECUTABLE_DIR - directory where the portable executable is located"]`) and call `app.setPath('userData', path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data'))` before anything else reads config.
**Warning signs:** operator reports "my settings disappeared" after moving the portable exe to a different booth PC.

### Pitfall 6: Treating "no code signing" as only a SmartScreen inconvenience
**What goes wrong:** on a fresh Windows 11 installation with **Smart App Control** enabled (an opt-in evaluation-mode feature on clean installs), there is **no "Run anyway" override at all** for an unsigned, unrecognized executable — the app cannot be launched until Smart App Control is turned off, which as of late 2025 required (and per a December 2025 Microsoft announcement, will soon not require) a full Windows reinstall to re-enable afterward.
**Why it happens:** Smart App Control is stricter than SmartScreen by design — it has no per-app exception mechanism.
**How to avoid:** this cannot be fixed from the Linux build side at all (it needs either a real code-signing certificate, which is out of scope this phase, or a one-time Windows setting change on the booth PC). Document it plainly in the phase gate checklist so the human doing the install isn't surprised.
**Warning signs:** the installer/portable exe "does nothing" when double-clicked, with no visible dialog at all — this is the SAC silent-block signature, distinct from SmartScreen's visible "Windows protected your PC" dialog.

## Code Examples

### `WsConnection.disconnect()` — already the correct "close cleanly" contract
```typescript
// Source: dslrbooth-agent/src/websocket/connection.ts:122-135 (read this session)
disconnect(): void {
  this.shouldReconnect = false
  this.stopHeartbeat()
  this.stopStableConnectionTimer()
  if (this.reconnectTimer) {
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }
  if (this.ws) {
    this.ws.removeAllListeners()
    try { this.ws.close(1000, 'shutdown') } catch {}
    this.ws = null
  }
}
```
No changes needed here for R2 — this already clears every timer (`reconnectTimer`, `heartbeatTimer` via `stopHeartbeat()`, `stableConnectionTimer` via `stopStableConnectionTimer()`) and removes all listeners before closing. Calling `.connect()` again afterward works because `connect()`'s guard (`this.ws && (CONNECTING || OPEN)`) is false once `disconnect()` has run.

### `createTriggerServer().close()` — already the correct port-release contract
```typescript
// Source: dslrbooth-agent/src/triggers/server.ts:82-85 (read this session)
close: () => new Promise<void>((resolve) => {
  server.close(() => resolve())
  server.closeAllConnections?.()
}),
```
Also correct as-is. The only change R2 requires is **when** `createTriggerServer()` is called (inside `.start()`, not at factory-construction time — see Pitfall 4), not how it shuts down.

### Package legitimacy check output (this session)
```json
// gsd-tools query package-legitimacy check --ecosystem npm electron electron-builder electron-log auto-launch electron-updater
{"name":"electron-builder","verdict":"OK","signals":{"weeklyDownloads":3551244,"repoUrl":"git+https://github.com/electron-userland/electron-builder.git"}}
```
Full output in the audit table above.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| `pkg` for single-executable Node distribution | Node's own `--experimental-sea-config` (Single Executable Applications) or community forks (`@yao-pkg/pkg`) | `pkg` archived by Vercel 2024-01-13 `[VERIFIED via WebSearch, cross-checked]` | Irrelevant to THIS phase's decision (D10-01 explicitly keeps `pkg` as the frozen reversibility fallback), but the planner should not treat `pkg` as a thing to invest further tooling into — no upstream fixes are coming |
| `win.signtoolOptions`/`win.azureSignOptions` (electron-builder v26) | Unified `win.sign` discriminated union (v27) | v27 alpha, not yet stable as of 2026-08-13 | Not applicable this phase (staying on v26); relevant only if the project later upgrades electron-builder |
| Electron `remote` module for renderer→main calls | `ipcMain.handle`/`ipcRenderer.invoke` + `contextBridge` | `remote` module removed as a built-in years ago | Already the assumed baseline in this research — no legacy code in this repo uses `remote` |

**Deprecated/outdated:** `pkg` (archived, frozen fallback only); electron-builder's synchronous `win.signtoolOptions` config style (superseded by `win.sign` in the not-yet-stable v27) — irrelevant since this phase isn't signing anything and is pinning to v26.

## What a Linux Build Honestly Cannot Do

1. **Cannot code-sign.** No certificate is in scope this phase. Every artifact produced will be unsigned. `win.sign: false` must be explicit in config so a future contributor doesn't assume signing "just isn't configured yet."
2. **Cannot produce a build that passes Windows 11 Smart App Control on a booth PC that has it enabled.** There is no client-side workaround; it is a Windows setting, not a build setting. This must be a checked item in the human phase-gate runbook, not discovered during install.
3. **Cannot verify the SmartScreen/"Run anyway" flow, tray behavior, `setLoginItemSettings` actually registering, or the app surviving a real Windows reboot** — all of this needs a real Windows machine, which this Linux build environment is not. This is exactly what CONTEXT.md's "blocking human gate" section already anticipates.
4. **Cannot test-run the packaged `.exe`/installer at all on this machine** — no Wine-hosted GUI testing is in scope here (Wine is used only to let `rcedit` set the icon during the build, not to smoke-test the resulting Windows binary). The Wine-in-Docker approach produces an artifact; it does not validate that artifact runs correctly on real Windows.
5. **Cannot build the 32-bit (`ia32`) Windows target on Electron 44+ at all** — Electron 44 removed `ia32`/`armv7l` support outright; if `ia32` support is ever wanted, `electronVersion` must be pinned `<= 43.x` `[CITED: electron.build multi-platform-build.md, "Electron 44 removed 32-bit Windows/Linux"]`. Not a blocker for this phase (the booth PC is presumably x64; if not, this is worth a decision checkpoint), but stated here so it isn't discovered mid-build.
6. **Cannot auto-generate a properly reputationed SmartScreen experience over time** the way a real (even OV-grade) certificate does — reputation only accrues to signed binaries.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The booth PC is a standard consumer/Pro Windows 10 or 11 install with Smart App Control either off (default on upgraded systems) or not yet evaluated — not a locked-down enterprise image with additional AppLocker/WDAC policy | Pitfalls 6, "What a Linux build cannot do" #2 | If the booth PC has enterprise application-control policy (AppLocker/WDAC) in addition to or instead of Smart App Control, the unsigned exe may be blocked by IT policy with a different, non-overridable error message; the human phase gate needs to check the actual machine, not assume consumer defaults |
| A2 | Plain HTML/TS (no framework) is sufficient for the renderer's settings form + status panel — no React/Vue is needed for a screen this small | Recommended Project Structure | If the operator wants a richer UI (live-updating queue-style status, animations) a framework may reduce iteration cost; this is explicitly left as the planner's/CONTEXT's discretion, not re-litigated here |
| A3 | The operator does not need auto-update (`electron-updater`) this phase — CONTEXT.md never mentions it and it multiplies the code-signing problem (electron-updater's Windows differential-update signature verification is considerably harder to run unsigned) | Standard Stack, Don't Hand-Roll | If a future phase wants auto-update, it will force the code-signing question that this phase is explicitly allowed to defer |
| A4 | "Close-to-tray" (D10 discretion) is what the operator wants by default, matching the D9-07 failure class CONTEXT.md cites (a booth relay dying because someone closed a window) | Pattern 2 | If the operator actually wants a normal "X closes the app" desktop experience for this particular app, the tray behavior would surprise them; CONTEXT.md phrases this as a recommendation ("should"), not a locked decision, so it is recorded here as an assumption to confirm during discuss/plan |

**If this table is empty:** N/A — see rows above.

## Open Questions

1. **Does the operator want the "portable" fallback to be genuinely portable (config travels with the exe on a USB stick), or is "portable" purely about avoiding an installer (config still lives in `%APPDATA%` on whichever machine it's run on)?**
   - What we know: electron-builder's `portable` target only means "no installer needed"; userData still defaults to `%APPDATA%` unless the app code explicitly redirects it using `PORTABLE_EXECUTABLE_DIR`.
   - What's unclear: CONTEXT.md doesn't specify this, and it materially changes whether Pitfall 5's fix is required.
   - Recommendation: default to the simpler behavior (config in `%APPDATA%`, matching the installed NSIS build's behavior exactly) unless the operator says otherwise during planning — consistency between install paths is worth more than USB-portability nobody asked for.

2. **Is there a single physical booth PC, or could this app run on more than one machine (making single-instance-per-machine, not single-instance-globally, the correct lock scope)?**
   - What we know: CONTEXT.md's whole framing ("the booth PC") suggests one machine.
   - What's unclear: whether "double-clicking one installed application" (success criterion 1) could ever happen on two different physical machines simultaneously — irrelevant to `requestSingleInstanceLock()` either way (it's inherently per-machine), but worth confirming there's no multi-booth ambition hiding in this phase.
   - Recommendation: proceed with the assumption of one booth PC; `requestSingleInstanceLock()` is correct regardless.

3. **Should the renderer framework be plain HTML/TS or something richer?**
   - What we know: the surface is small (settings form, status panel, log pane, tray) — see Assumption A2.
   - What's unclear: whether a future phase (not this one) wants to grow this UI meaningfully.
   - Recommendation: plain HTML/TS + a small number of vanilla-JS modules is sufficient and keeps `asar` package size down; this can change later without touching the main-process/IPC contract designed here.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Build (tsc, vitest, electron-builder CLI) | ✓ | v24.15.0 | — |
| `pkg` CLI | `build:exe` (reversibility path) | ✓ (already in `node_modules`, `npx pkg --version` confirmed runs) | 5.8.1 | — |
| Wine | electron-builder Windows targets (rcedit) | ✗ (not checked/installed on this machine as of research time — no `wine` binary probed as present) | — | Use `electronuserland/builder:wine` Docker image instead of installing Wine directly on the host (avoids polluting this machine's package set for a one-purpose tool) |
| Docker | Recommended Wine-build path | not probed this session | — | If Docker is also unavailable, fall back to installing Wine 2.0+ directly (`apt-get install wine` on Debian/Ubuntu-family, per electron-builder docs) |
| A real Windows machine (booth PC or VM) | Success criterion 5, the entire blocking human gate | N/A — by design, this machine is Linux | — | None — this is the explicit, accepted gap this whole phase's R1 exists to make honest, not solve |

**Missing dependencies with no fallback:**
- A real Windows machine for the phase-gate verification — by design, cannot be substituted; this is what the human gate is for.

**Missing dependencies with fallback:**
- Wine — install directly, or use the Docker image (recommended: avoids version drift between "what's on this machine" and "what electron-builder's own CI tests against").

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 2.1.9 `[VERIFIED: npx vitest run output, this session]` |
| Config file | `dslrbooth-agent/vitest.config.ts` |
| Quick run command | `npm test` (= `vitest run`) — currently 3 files / 31 tests, 1.10s |
| Full suite command | same — the suite is small enough that "quick" and "full" are identical |

### Phase Requirements → Test Map

| Req / Success Criterion | Behavior | Test Type | Automated Command | File Exists? |
|--------------------------|----------|-----------|--------------------|--------------|
| SC-1: double-click starts the Agent, no terminal | Packaged app launches and the main process boots `createAgent()` | manual-only (needs a real Windows install) | — | ❌ human gate, not automatable from Linux |
| SC-2: first run with no config opens a setup form; start/stop/restart from window | `createAgent().start()`/`.stop()` are idempotent and don't throw with a fresh config; IPC handlers call them correctly | unit | `vitest run test/agent-lifecycle.test.ts` (NEW — Wave 0 gap) | ❌ Wave 0 |
| SC-3: connection state / dslrBooth reachability / log lines visible; tray minimize; optional auto-start | `ws.onStatusChange` callback fires and reaches the IPC push path; log-tail reads the correct file; `setLoginItemSettings` called with correct args | unit (status/log-tail logic), manual (visual tray/minimize/auto-start-on-reboot) | `vitest run test/electron-ipc.test.ts` (NEW — Wave 0 gap) for the logic half | Logic: ❌ Wave 0. Visual/OS integration: ❌ human gate |
| SC-4: four CMS fields still pull & apply in memory; local GUI edits take effect without reinstall | `LiveConfig.apply()` unchanged (31 existing tests already pin this); NEW test that the local-edit IPC path calls the identical `live.apply()` | unit | `vitest run test/config-reload.test.ts` (existing, 24 tests) + `vitest run test/electron-config-ipc.test.ts` (NEW — Wave 0 gap) | Existing: ✅. New: ❌ Wave 0 |
| SC-5: a Linux-built artifact installs and runs on the Windows booth PC (or portable fallback does) | The build produces a valid NSIS/portable artifact; that artifact actually installs and runs on real Windows | manual-only | — | ❌ human gate, exclusively — nothing in this environment can substitute for a real Windows machine |

### Sampling Rate
- **Per task commit:** `npm test` (already ~1s, no reason not to run every commit)
- **Per wave merge:** same command — suite is too small to need a separate "full" tier
- **Phase gate:** green `npm test` is necessary but nowhere near sufficient — SC-1, SC-3 (visual/OS half), and SC-5 are **only** provable on a real Windows booth PC, per CONTEXT.md's explicit "blocking human gate" section. The planner must not treat a green test suite as phase completion.

### Wave 0 Gaps
- [ ] `test/agent-lifecycle.test.ts` — covers SC-2: `createAgent(config, logger).start()` binds the trigger port and connects; `.stop()` releases the port and disconnects cleanly; calling `.start()` twice or `.stop()` before `.start()` doesn't throw
- [ ] `test/electron-config-ipc.test.ts` — covers SC-4's local-edit half: a `config:set` IPC handler (tested as a plain function, not through a real Electron process) applies through the same `LiveConfig.apply()` path already pinned by the 24 existing `config-reload.test.ts` cases, and never round-trips the plaintext secret back out through `config:get`
- [ ] `test/electron-ipc.test.ts` — covers SC-3's logic half: a status-change callback reaches whatever push mechanism is chosen (can be tested with a fake `webContents.send`-shaped stub, no real BrowserWindow needed)
- [ ] Framework install: none needed — Vitest is already the project's test runner; Electron main-process logic (factory functions, IPC handler functions) can be unit tested exactly like `agentMessages.ts` is today, without spinning up a real Electron process (`electron` itself is not required at `vitest run` time if IPC handlers are written as plain exported functions that `ipcMain.handle` wraps, mirroring how `agentMessages.ts` deliberately separates testable logic from `index.ts`'s untestable module-load wiring — same pattern, applied to Electron main)

*Everything genuinely requiring a live BrowserWindow, tray, real Windows registry, or physical Windows install is explicitly listed above as manual-only — consistent with CONTEXT.md's own instruction: "what is only provable by running the app on Windows goes into the blocking human gate, honestly listed."*

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | No | No user-facing login for this local desktop app; physical access to the booth PC is the trust boundary (unchanged from today's `.env`-on-disk model) |
| V3 Session Management | No | N/A — no session concept in this surface |
| V4 Access Control | Partial | D10-02 locks this to IPC-only (no local HTTP server at all is the strongest form of "127.0.0.1-only" — there's no network listener to misconfigure). If a fallback local HTTP surface is ever needed, it must bind `127.0.0.1` explicitly, matching the existing `triggers/server.ts` pattern of binding `'0.0.0.0'` **only** for the dslrBooth-facing trigger port (which is a deliberate, pre-existing, unrelated exception — do not copy that bind address for any new operator-facing surface) |
| V5 Input Validation | Yes | The IPC `config:set` handler must validate every field with the same rigor `LiveConfig.assign()` already applies to remote config (type checks, port range 1-65535, non-empty password) — reuse the same validation code path, don't write a second copy that can drift |
| V6 Cryptography | Yes | `safeStorage.encryptString`/`decryptString` (Electron built-in, DPAPI-backed on Windows) for the two secrets at rest in `userData/config.json` — never hand-roll |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|-----------------------|
| Renderer XSS reaching Node/filesystem via a compromised or malformed local HTML/JS asset | Elevation of Privilege | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` (Electron defaults since v12/v5/v20 respectively — this app should not override any of them) `[CITED: electronjs.org/docs/latest/tutorial/security]` |
| Credential exfiltration via renderer DevTools (Console/Sources/Application panels) | Information Disclosure | Redacted `config:get` snapshot, write-only secret fields, no `console.log` of config objects, no secrets in `localStorage`/window title/URL — see Pattern 3 and Anti-Patterns above |
| A second process instance racing the first for `:3001` (the trigger port dslrBooth posts to) | Denial of Service | `app.requestSingleInstanceLock()` + `second-instance` handler focusing the existing window instead of booting a second `createAgent()` |
| Plaintext secrets at rest surviving a stolen/cloned booth PC drive | Information Disclosure | `safeStorage` (DPAPI-backed — tied to the Windows user account that encrypted it, so a raw file copy to another machine/account doesn't decrypt) |
| Unsigned installer tampered with in transit (e.g., a USB stick swap between build machine and booth PC) | Tampering | Out of scope for this phase (no signing = no tamper-evidence at the OS level); mitigate operationally — build and transfer over a channel the operator already trusts (this is a real, accepted residual risk of the "no code signing" decision, not something the app can fix) |

## Sources

### Primary (HIGH confidence — official docs, quoted or directly read)
- `dslrbooth-agent/package.json`, `src/index.ts`, `src/websocket/connection.ts`, `src/liveConfig.ts`, `src/agentMessages.ts`, `src/triggers/server.ts`, `src/config.ts`, `src/logging/logger.ts`, `src/dslrbooth/client.ts`, `src/display/launcher.ts`, `service/install-service.js`, `test/*.test.ts` (all read directly this session, plus `npx vitest run` executed live: 3 files, 31 tests, all passing)
- `npm view electron version` → `43.4.0`; `npm view electron-builder dist-tags --json` → `latest: 26.15.3`, `next: 27.0.0-alpha.6`; `npm view pkg version/deprecated` → `5.8.1`, archived; `npx pkg --version` → runs successfully under this machine's Node 24
- `gsd-tools query package-legitimacy check` — live registry check for `electron`, `electron-builder`, `electron-log`, `auto-launch`, `electron-updater`

### Secondary (MEDIUM confidence — official docs fetched/quoted this session, some via a summarizing fetch tool)
- `raw.githubusercontent.com/electron-userland/electron-builder/master/website/docs/features/multi-platform-build.md` — Wine 2.0+ requirement, Docker `electronuserland/builder:wine` image, "Electron 44 removed 32-bit Windows/Linux" warning (fetched via `curl`, verbatim markdown, 2026-08-13)
- `raw.githubusercontent.com/electron-userland/electron-builder/master/website/docs/features/code-signing/code-signing-win.md` — "Disable signing (resedit resource editing still runs)", OV vs EV SmartScreen reputation behavior (fetched via `curl`, verbatim markdown, 2026-08-13)
- `raw.githubusercontent.com/electron-userland/electron-builder/master/website/docs/nsis.md` — Portable target env vars (`PORTABLE_EXECUTABLE_DIR`), NSIS target options (fetched via `curl`, verbatim markdown, 2026-08-13)
- `raw.githubusercontent.com/electron-userland/electron-builder/master/website/docs/file-patterns.md`, `features/icons-and-images.md` — files globs, icon format requirements (fetched via `curl`, verbatim markdown, 2026-08-13)
- `electronjs.org/docs/latest/api/app`, `electronjs.org/docs/latest/api/safe-storage`, `electronjs.org/docs/latest/tutorial/ipc`, `electronjs.org/docs/latest/tutorial/security` — fetched via WebFetch (AI-summarized, not raw markdown — see caveat below)

### Tertiary (LOW confidence — WebSearch aggregation only, marked for validation at the phase gate)
- SmartScreen "Windows protected your PC" / "More info → Run anyway" flow for fully unsigned executables — consistent across multiple independent sources (minitool.com, thewindowsclub.com, advancedinstaller.com, Microsoft Learn Q&A threads) but not independently reproduced this session
- Windows 11 Smart App Control's no-override-for-unsigned-apps behavior and its Dec-2025 "disable without reinstall" fix-in-progress — from WebSearch aggregation (ninjaone.com, xda-developers.com, windowslatest.com), not from a primary Microsoft doc page fetched directly this session
- Electron Forge vs. electron-builder comparative framing — WebSearch aggregation (npmcompare.com, electronforge.io's own "why" page, stackshare.io)

**Caveat on WebFetch-sourced claims:** this session observed WebFetch's summarizing model produce at least one incorrect claim (initially reporting electron-builder's NSIS docs as saying "Wine is not explicitly required," contradicted moments later by the raw markdown fetched via `curl` from the same repository, which states Wine 2.0+ IS required). Anywhere a WebFetch-derived claim mattered for a load-bearing R1 decision, it was re-verified against the raw GitHub markdown via `curl` before being included here. The `electronjs.org` API-doc claims (app.md, safe-storage.md, ipc.md, security.md) were not independently re-fetched via raw source (Electron's docs are a Docusaurus site without a simple raw-markdown mirror checked this session) — they match this agent's training knowledge of stable, long-unchanged Electron API behavior (contextIsolation/nodeIntegration/sandbox defaults, `setLoginItemSettings`, `requestSingleInstanceLock`, `safeStorage`), which is why they're tagged CITED (MEDIUM) rather than VERIFIED (HIGH).

## Metadata

**Confidence breakdown:**
- Standard stack (electron-builder vs. forge, versions): HIGH — versions directly queried from npm registry this session; tool choice is a well-documented, low-ambiguity comparison
- R1 (Wine/NSIS/signing mechanics): MEDIUM-HIGH — core mechanics (Wine requirement, rcedit-runs-regardless-of-signing) confirmed via raw official-repo markdown fetched this session; the Windows-side operator experience (SmartScreen wording, Smart App Control specifics) is MEDIUM, consistent-but-unverified-on-real-Windows
- R2 (core hosting/lifecycle): HIGH — verified by directly reading `connection.ts`, `server.ts`, `index.ts` this session and running the existing test suite live
- R3 (pkg coexistence): HIGH — verified by reading the exact `build:exe` script, confirming it hard-codes its entry path (not `main`), and running `npx pkg --version` successfully under this machine's installed Node 24
- R4 (renderer security defaults, IPC pattern): MEDIUM-HIGH — Electron version and default security posture (contextIsolation/nodeIntegration/sandbox) are extremely stable, long-documented behavior; the specific credential-safety IPC design (redacted snapshot, write-only secret fields) is this research's own synthesis applying those defaults to this app's specific risk (not itself a quoted claim from any doc)
- Pitfalls: HIGH — every pitfall traces to either a direct repo-code read or a directly-fetched official-docs quote, not speculation
- Validation Architecture: HIGH for the test-framework facts (live `vitest run` output); MEDIUM for which SC items are genuinely human-gate-only (a judgment call, but one CONTEXT.md itself explicitly instructs: "what is only provable by running the app on Windows goes into the blocking human gate")

**Research date:** 2026-08-13
**Valid until:** ~30 days for the repo-code findings (R2/R3 — stable unless the core is touched by another phase first); ~14 days for the electron-builder/Electron version numbers specifically (both projects release frequently — re-check `npm view electron-builder dist-tags` and `npm view electron version` immediately before the planner locks a `package.json` version range, not just before this research)
