import { app, BrowserWindow, Menu, ipcMain, Tray } from 'electron'
import path from 'path'
import fs from 'fs'
import { createAgent, type AgentHandle, type AgentStatus } from '../agent'
import { createLogger } from '../logging/logger'
import { createConfigStore } from './configStore'
import { createSafeStorageEncryptor } from './safeStorageEncryptor'
import { findLegacyEnvFile } from './envImport'
import { createLogTail } from './logTail'
import { createAppTray, installCloseToTray, updateTrayTooltip } from './tray'
import {
  createIpcHandlers,
  maybeAutoStartOnLaunch,
  IPC_CHANNELS,
  STATUS_PUSH_CHANNEL,
  LOG_LINE_PUSH_CHANNEL,
  type IpcChannel,
  type LoginItemAdapter,
} from './ipcHandlers'

/**
 * The Electron main entry (10-RESEARCH Pattern 2; D10-01, D10-02).
 *
 * Hosts the plan-10-01 factory; does not rewrite it. Everything below is a
 * shell around `createAgent()` — connection logic, trigger handling and the
 * `LiveConfig` boundary all stay exactly where plan 10-01 left them.
 *
 * `npm run electron:dev` builds and launches this on a real desktop. It
 * cannot run on this Linux build machine — there is no display server here —
 * which is why every automated check for this file drives its logic through
 * `configStore.ts`/`ipcHandlers.ts` directly (electron-free) or reads this
 * file as text (`test/electron-main-security.test.ts`), never by executing it.
 */

const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
  // A second launch on a booth PC would fight the first for the trigger
  // port (T-10-13) — quit immediately rather than let two relays race.
  app.quit()
} else {
  let mainWindow: BrowserWindow | null = null

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    // No application menu: this window's whole purpose is editing
    // credentials, and the default menu carries "Toggle Developer Tools" as
    // a normal keyboard shortcut (T-10-09).
    Menu.setApplicationMenu(null)

    const userDataDir = app.getPath('userData')
    const configPath = path.join(userDataDir, 'config.json')
    // The relative log default in config.ts resolves beside the executable,
    // which for an installed build is a directory the rotating file
    // transport cannot write to (10-RESEARCH Pitfall 5, applied to logging).
    // The user-data directory's own `logs` subdirectory is always writable.
    const logDir = path.join(userDataDir, 'logs')
    fs.mkdirSync(logDir, { recursive: true })

    // A boot logger, used for the config store and every Agent this process
    // constructs; `logLevel`/`logDir` below are placeholders only used until
    // a stored configuration exists — the store itself decides the real
    // values every time `buildConfig()` runs.
    const bootLogger = createLogger({
      extensionServiceWsUrl: '',
      extensionServiceWsToken: '',
      dslrBoothApiPort: 1500,
      dslrBoothPassword: '',
      triggerServerPort: 3001,
      logLevel: 'info',
      logDir,
      autoOpenDisplay: true,
    })

    // D10-02's migration note: a booth PC that already has a working `.env`
    // should not require retyping a token by hand. Beside the executable, the
    // working directory, then the user-data directory — the first one found
    // wins (envImport.ts, no import of electron itself).
    const legacyEnvPath = findLegacyEnvFile([
      path.dirname(app.getPath('exe')),
      process.cwd(),
      userDataDir,
    ])

    const store = createConfigStore({
      filePath: configPath,
      encryptor: createSafeStorageEncryptor(),
      logger: bootLogger,
      legacyEnvPath,
    })

    let agent: AgentHandle | null = null
    let tray: Tray | null = null

    mainWindow = new BrowserWindow({
      width: 900,
      height: 640,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))

    // The renderer loads local files only and has no reason to reach any
    // origin (T-10-09) — refuse navigation and new windows outright.
    mainWindow.webContents.on('will-navigate', (event) => {
      event.preventDefault()
    })
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    // D9-07's failure class: a booth relay must not die because someone
    // clicked the window's close button. Close hides; only the tray's Quit
    // (below) actually ends the process.
    installCloseToTray(mainWindow)

    // The one-line binding to Electron's own login-item API (10-RESEARCH
    // Don't Hand-Roll) — the only place in this codebase that calls it.
    const loginItemAdapter: LoginItemAdapter = {
      setOpenAtLogin(value: boolean): void {
        app.setLoginItemSettings({ openAtLogin: value })
      },
    }

    // The log tail (SC-3, Task 2). Reads the exact file `bootLogger`'s
    // sibling `DailyRotateFile` transport already writes — nothing here
    // re-plumbs the logger (10-CONTEXT's explicit instruction). The
    // directory is resolved from the STORE's current snapshot at every poll,
    // not captured once, for the same "read live, not once" reason
    // `agent.ts`'s reachability probe reads `live.dslrBoothApiPort`.
    const logTail = createLogTail({
      resolveLogDir: () => store.getSnapshot().logDir,
      emit: (line) => {
        mainWindow?.webContents.send(LOG_LINE_PUSH_CHANNEL, line)
      },
      secrets: () => {
        const built = store.buildConfig()
        return built.ok ? [built.config.extensionServiceWsToken, built.config.dslrBoothPassword] : []
      },
    })

    const handlers = createIpcHandlers({
      store,
      logger: bootLogger,
      getAgent: () => agent,
      setAgent: (next) => {
        agent = next
      },
      createAgent,
      pushStatus: (status: AgentStatus) => {
        mainWindow?.webContents.send(STATUS_PUSH_CHANNEL, status)
        // The tray tooltip tracks the relay state (T-10-21's other half — an
        // operator glancing at the tray, window hidden, can still tell).
        if (tray) updateTrayTooltip(tray, status.running)
      },
      getRecentLogLines: () => logTail.getRecentLines(),
      loginItemAdapter,
    })

    // The tail runs only while the relay runs (T-10-20): start it right
    // after a successful `agent:start`, stop it on every `agent:stop`. Both
    // the renderer's Start/Stop buttons (through `ipcMain.handle` below) and
    // any future in-process caller of `handlers['agent:start']`/`['agent:stop']`
    // (Task 3's launch auto-start) go through this same pair, so the tail's
    // lifecycle can never drift from the relay's.
    const rawAgentStart = handlers['agent:start']
    handlers['agent:start'] = async () => {
      const result = await rawAgentStart()
      if (result.ok) logTail.start()
      return result
    }
    const rawAgentStop = handlers['agent:stop']
    handlers['agent:stop'] = async () => {
      const result = await rawAgentStop()
      logTail.stop()
      return result
    }

    for (const channel of IPC_CHANNELS as readonly IpcChannel[]) {
      ipcMain.handle(channel, (_event, ...args: unknown[]) => {
        const handler = handlers[channel] as (...a: unknown[]) => Promise<unknown>
        return handler(...args)
      })
    }

    // The tray icon lives in the RENDERER directory that gets copied into
    // the build output (`scripts/copy-assets.js`), not the packaging
    // resources directory, which electron-builder does not ship inside the
    // installed application — an icon present in development and missing
    // from the installed app is a crash on a booth PC.
    tray = createAppTray({
      iconPath: path.join(__dirname, '..', 'renderer', 'tray.png'),
      getMainWindow: () => mainWindow,
      isRunning: () => agent?.isRunning() ?? false,
    })

    mainWindow.on('closed', () => {
      mainWindow = null
    })

    // SC-1: with a complete configuration and the launch preference on, the
    // relay starts without the operator pressing anything. With an
    // incomplete configuration the window already shows the setup form
    // (nothing here forces that — it is simply what an empty/invalid config
    // renders as); with the preference off, nothing starts.
    void maybeAutoStartOnLaunch(handlers, store)
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}
