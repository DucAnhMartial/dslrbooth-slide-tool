import { app, BrowserWindow, Menu, Tray } from 'electron'

/**
 * The tray, close-to-tray and the quitting flag (plan 10-03 Task 3,
 * 10-RESEARCH Pattern 2).
 *
 * The pattern below is composed from documented Electron primitives
 * (`Tray`, `Menu.buildFromTemplate`, `BrowserWindow`'s `close` event) rather
 * than quoted from one official page — 10-RESEARCH found no single "how to
 * build a tray app" doc page, only the individual API references for each
 * piece. The close-hides / Quit-sets-a-flag-first shape is confirmed for
 * real on a real Windows desktop at the phase gate (plan 10-04); nothing
 * here can be executed on this headless Linux build machine, which is why
 * this file, like `main.ts`, is read as TEXT by
 * `test/electron-shell-posture.test.ts` rather than run.
 *
 * Say plainly why this exists: a booth relay that dies because somebody
 * clicked the window's close button is the D9-07 failure class this project
 * has already paid for once. Close hides the window and leaves the relay
 * running; only the tray's own Quit item sets `app.isQuitting` before
 * asking Electron to exit, so the SAME `close` handler that would otherwise
 * intercept every close (including the real one) lets it through exactly
 * once, on purpose.
 */

export interface AppWithQuitFlag {
  isQuitting?: boolean
}

/** Installs the close-to-tray behaviour on a window: hide instead of quit, unless `app.isQuitting` was set first. */
export function installCloseToTray(window: BrowserWindow): void {
  window.on('close', (event) => {
    if (!(app as unknown as AppWithQuitFlag).isQuitting) {
      event.preventDefault()
      window.hide()
    }
  })
}

export interface TrayDeps {
  iconPath: string
  getMainWindow: () => BrowserWindow | null
  /** Read at construction to seed the tooltip; call `updateTrayTooltip` afterward as the relay's state changes. */
  isRunning: () => boolean
}

function showAndFocus(window: BrowserWindow | null): void {
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

export function tooltipFor(running: boolean): string {
  return running ? 'dslrBooth Agent — relay running' : 'dslrBooth Agent — relay stopped'
}

export function updateTrayTooltip(tray: Tray, running: boolean): void {
  tray.setToolTip(tooltipFor(running))
}

/** Creates the tray icon, its menu (Show, Quit) and wires activation to show-and-focus. */
export function createAppTray(deps: TrayDeps): Tray {
  const tray = new Tray(deps.iconPath)

  const menu = Menu.buildFromTemplate([
    { label: 'Show', click: () => showAndFocus(deps.getMainWindow()) },
    {
      label: 'Quit',
      click: () => {
        // Set BEFORE quit — the close handler installed by
        // `installCloseToTray` checks this flag, and the flag must already
        // be true by the time the resulting `close` event fires.
        ;(app as unknown as AppWithQuitFlag).isQuitting = true
        app.quit()
      },
    },
  ])
  tray.setContextMenu(menu)
  tray.on('click', () => showAndFocus(deps.getMainWindow()))

  updateTrayTooltip(tray, deps.isRunning())
  return tray
}
