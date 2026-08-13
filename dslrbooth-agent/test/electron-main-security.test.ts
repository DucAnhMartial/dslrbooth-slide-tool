import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { IPC_CHANNEL_FUNCTION_NAMES } from '../src/electron/ipcHandlers'

// ---------------------------------------------------------------------------
// Plan 10-02, Task 3 — the renderer's boundary, the single-instance rule and
// the build layout, pinned by the suite rather than left as properties the
// current code merely happens to have.
//
// This repository already asserts against source text where behaviour cannot
// be driven on this machine — test/display-page-no-queue.test.ts does exactly
// that for the booth display page. An Electron main process on a Linux build
// machine with no display server is the same situation with the same answer:
// `main.ts` and `preload.ts` both import `electron`, which is not a real
// module outside an Electron process, so this file reads them as TEXT and
// never executes them.
//
// The positives (isolation on, sandbox on, the lock taken, the menu removed,
// navigation refused, the CSP tag present) are asserted alongside the
// absences, and deliberately weighted toward the positives: a file that
// merely lacks a dangerous option today can acquire it tomorrow with no test
// noticing, whereas a file that must keep a required option present fails
// loudly the moment someone deletes it.
// ---------------------------------------------------------------------------

const ELECTRON_SRC_DIR = path.join(__dirname, '..', 'src', 'electron')

function readSource(fileName: string): string {
  return fs.readFileSync(path.join(ELECTRON_SRC_DIR, fileName), 'utf8')
}

const mainSource = readSource('main.ts')
const preloadSource = readSource('preload.ts')
const indexHtml = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'index.html'),
  'utf8',
)

describe('the renderer boundary — web preferences (T-10-09)', () => {
  it('sets the three required web preferences', () => {
    expect(mainSource).toContain('contextIsolation: true')
    expect(mainSource).toContain('nodeIntegration: false')
    expect(mainSource).toContain('sandbox: true')
  })

  // Table-driven so a failure names exactly which weakening option showed up,
  // rather than one assertion covering all of them opaquely.
  it.each([
    'contextIsolation: false',
    'nodeIntegration: true',
    'sandbox: false',
    'webSecurity: false',
    'allowRunningInsecureContent',
    'enableRemoteModule',
    'nodeIntegrationInWorker',
    'nodeIntegrationInSubFrames',
    'webviewTag: true',
    'experimentalFeatures',
  ])('never sets the weakening option %s', (weakening) => {
    expect(mainSource).not.toContain(weakening)
  })
})

describe('the single-instance rule (T-10-13)', () => {
  it('takes the lock first and quits when it is not granted', () => {
    const lockIndex = mainSource.indexOf('requestSingleInstanceLock')
    const quitIndex = mainSource.indexOf('app.quit()')
    expect(lockIndex).toBeGreaterThan(-1)
    expect(quitIndex).toBeGreaterThan(-1)
    // The quit-on-no-lock branch must read before the window/IPC wiring —
    // a lock taken but never acted on would still let a second instance run.
    expect(mainSource.indexOf('gotLock')).toBeLessThan(mainSource.indexOf('BrowserWindow('))
  })

  it('focuses the existing window on a second launch instead of starting a second relay', () => {
    expect(mainSource).toContain("app.on('second-instance'")
    // Whichever of focus/restore/show the entry uses to bring the window
    // forward, it must be present inside the second-instance handler.
    const handlerBody = mainSource.slice(
      mainSource.indexOf("app.on('second-instance'"),
      mainSource.indexOf("app.on('second-instance'") + 400,
    )
    expect(handlerBody).toMatch(/\.focus\(\)/)
  })
})

describe('no application menu on a credential-editing window (T-10-09)', () => {
  it('removes the application menu with an active (uncommented) call', () => {
    // A plain substring match would still pass on a commented-out call, which
    // is exactly the silent regression this test exists to catch — require
    // the call to start a line (ignoring leading whitespace), not follow `//`.
    expect(mainSource).toMatch(/^\s*Menu\.setApplicationMenu\(null\)/m)
  })
})

describe('navigation and new windows are refused (T-10-09)', () => {
  it('refuses in-page navigation', () => {
    expect(mainSource).toContain('will-navigate')
    expect(mainSource).toContain('event.preventDefault()')
  })

  it('refuses new windows', () => {
    expect(mainSource).toContain('setWindowOpenHandler')
    expect(mainSource).toMatch(/action:\s*'deny'/)
  })
})

describe('no local HTTP configuration surface (T-10-12, D10-02)', () => {
  it('no file under src/electron/ creates a network listener of any kind', () => {
    const files = fs.readdirSync(ELECTRON_SRC_DIR).filter((f) => f.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(0)

    const offenders: string[] = []
    for (const file of files) {
      const lines = readSource(file).split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
        if (/createServer|\.listen\(/.test(line)) offenders.push(`${file}: ${trimmed}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('the preload exposes exactly the channel surface and nothing else (T-10-09)', () => {
  it('exposed function names equal the channel constant plus the two subscription helpers', () => {
    const apiBlock = preloadSource.slice(
      preloadSource.indexOf('const api = {'),
      preloadSource.indexOf('contextBridge.exposeInMainWorld'),
    )
    const exposedNames = [...apiBlock.matchAll(/^\s*(\w+):/gm)].map((m) => m[1])

    const expectedNames = [...Object.values(IPC_CHANNEL_FUNCTION_NAMES), 'onStatus', 'offStatus']

    expect(exposedNames.sort()).toEqual([...expectedNames].sort())
  })

  it('exposes exactly one namespace on the window', () => {
    const exposeCalls = [...preloadSource.matchAll(/contextBridge\.exposeInMainWorld\(/g)]
    expect(exposeCalls).toHaveLength(1)
    expect(preloadSource).toContain("contextBridge.exposeInMainWorld('agentDesktop', api)")
  })
})

describe('the renderer page declares a same-origin-only content-security policy (R4)', () => {
  it('has a Content-Security-Policy meta tag scoped to self', () => {
    expect(indexHtml).toMatch(/<meta\s+http-equiv="Content-Security-Policy"/)
    expect(indexHtml).toContain("default-src 'self'")
  })

  it('references no remote origin anywhere on the page', () => {
    expect(indexHtml).not.toMatch(/https?:\/\//)
  })
})

describe('the build produces every file the entry and the packaging config expect', () => {
  const distRoot = path.join(__dirname, '..', 'dist')

  it.each([
    path.join('electron', 'main.js'),
    path.join('electron', 'preload.js'),
    path.join('renderer', 'index.html'),
    path.join('renderer', 'index.js'),
  ])('%s exists after a build', (relativePath) => {
    expect(fs.existsSync(path.join(distRoot, relativePath))).toBe(true)
  })
})
