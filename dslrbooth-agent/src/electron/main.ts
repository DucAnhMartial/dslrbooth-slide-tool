import { app, BrowserWindow, Menu, ipcMain } from 'electron'
import path from 'path'
import fs from 'fs'
import { createAgent, type AgentHandle, type AgentStatus } from '../agent'
import { createLogger } from '../logging/logger'
import { createConfigStore } from './configStore'
import { createSafeStorageEncryptor } from './safeStorageEncryptor'
import { findLegacyEnvFile } from './envImport'
import { createIpcHandlers, IPC_CHANNELS, STATUS_PUSH_CHANNEL, type IpcChannel } from './ipcHandlers'

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
      },
    })

    for (const channel of IPC_CHANNELS as readonly IpcChannel[]) {
      ipcMain.handle(channel, (_event, ...args: unknown[]) => {
        const handler = handlers[channel] as (...a: unknown[]) => Promise<unknown>
        return handler(...args)
      })
    }

    mainWindow.on('closed', () => {
      mainWindow = null
    })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}
