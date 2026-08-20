import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Logger } from '../src/logging/logger'
import { createConfigStore, type SecretEncryptor } from '../src/electron/configStore'
import { createIpcHandlers, maybeAutoStartOnLaunch } from '../src/electron/ipcHandlers'

// ---------------------------------------------------------------------------
// Plan 10-03, Task 3 — the tray, the close button, the login item, and the
// renderer's posture pinned.
//
// Same rationale as test/electron-main-security.test.ts (plan 10-02), which
// this file extends rather than duplicates: `main.ts` and `tray.ts` both
// import `electron`, which is not a real module outside an Electron process,
// so on this headless Linux build machine they are read as TEXT and never
// executed. The tray/close-to-tray behaviour itself is confirmed for real on
// Windows at the phase gate in plan 10-04.
//
// Weighted toward positives, for the same reason the 10-02 file gives: a file
// that merely lacks a dangerous call today can acquire it tomorrow with no
// test noticing, whereas a required call that someone deletes fails loudly.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.join(__dirname, '..')
const ELECTRON_SRC_DIR = path.join(REPO_ROOT, 'src', 'electron')
const RENDERER_SRC_DIR = path.join(REPO_ROOT, 'src', 'renderer')

function readElectronSource(fileName: string): string {
  return fs.readFileSync(path.join(ELECTRON_SRC_DIR, fileName), 'utf8')
}

const mainSource = readElectronSource('main.ts')
const traySource = readElectronSource('tray.ts')
const rendererJs = fs.readFileSync(path.join(RENDERER_SRC_DIR, 'index.js'), 'utf8')
const rendererHtml = fs.readFileSync(path.join(RENDERER_SRC_DIR, 'index.html'), 'utf8')

function makeLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    level: 'info',
    transports: [],
  } as unknown as Logger
}

function makeFakeEncryptor(): SecretEncryptor {
  return {
    isAvailable: () => true,
    encrypt: (plaintext: string) => `wrapped:${Buffer.from(plaintext, 'utf8').toString('base64')}`,
    decrypt: (ciphertext: string) =>
      Buffer.from(ciphertext.replace(/^wrapped:/, ''), 'base64').toString('utf8'),
  }
}

function tempConfigPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-10-03-posture-'))
  return path.join(dir, 'config.json')
}

function makeStore(filePath = tempConfigPath()) {
  return createConfigStore({ filePath, encryptor: makeFakeEncryptor(), logger: makeLogger() })
}

/** A complete configuration, so `buildConfig()` succeeds without a real service or booth. */
const COMPLETE_CONFIG_PATCH = {
  extensionServiceWsUrl: 'ws://service.test:3002/agent',
  extensionServiceWsToken: 'a-token',
  dslrBoothApiPort: 1500,
  dslrBoothPassword: 'a-password',
  triggerServerPort: 3001,
}

/**
 * Builds a handler map whose only exercised member here is `preferences:*`.
 * The agent side is stubbed: this file pins the shell's posture, not the
 * relay's lifecycle — test/electron-ipc.test.ts already drives that end to end.
 */
function makeHandlers(
  store: ReturnType<typeof makeStore>,
  loginItemAdapter?: { setOpenAtLogin: (value: boolean) => void },
) {
  return createIpcHandlers({
    store,
    logger: makeLogger(),
    getAgent: () => null,
    setAgent: () => {},
    createAgent: (() => {
      throw new Error('not exercised in this file')
    }) as never,
    pushStatus: () => {},
    loginItemAdapter,
  })
}

describe('the two operator preferences (T-10-22)', () => {
  it('both default on for a fresh store', async () => {
    const handlers = makeHandlers(makeStore())
    await expect(handlers['preferences:get']()).resolves.toEqual({
      startWithWindows: true,
      startRelayOnLaunch: true,
    })
  })

  it('round-trips through their own channels and survives a fresh store on the same file', async () => {
    const filePath = tempConfigPath()
    const handlers = makeHandlers(makeStore(filePath))

    await expect(handlers['preferences:set']({ startRelayOnLaunch: false })).resolves.toEqual({ ok: true })
    await expect(handlers['preferences:get']()).resolves.toEqual({
      startWithWindows: true,
      startRelayOnLaunch: false,
    })

    // Persisted, not merely held in memory.
    const reopened = makeHandlers(makeStore(filePath))
    await expect(reopened['preferences:get']()).resolves.toEqual({
      startWithWindows: true,
      startRelayOnLaunch: false,
    })
  })

  it('refuses a non-preference key by name and a non-boolean value', async () => {
    const handlers = makeHandlers(makeStore())

    const unknownKey = await handlers['preferences:set']({ triggerServerPort: 3001 })
    expect(unknownKey.ok).toBe(false)
    expect(JSON.stringify(unknownKey)).toContain('triggerServerPort')

    const wrongType = await handlers['preferences:set']({ startWithWindows: 'yes' })
    expect(wrongType.ok).toBe(false)
  })

  it('a configuration save leaves the preferences untouched', async () => {
    const filePath = tempConfigPath()
    const handlers = makeHandlers(makeStore(filePath))

    await handlers['preferences:set']({ startRelayOnLaunch: false })
    await handlers['config:set'](COMPLETE_CONFIG_PATCH)

    await expect(handlers['preferences:get']()).resolves.toEqual({
      startWithWindows: true,
      startRelayOnLaunch: false,
    })
  })
})

describe('the login item is written through exactly one adapter (T-10-22)', () => {
  it('setting start-with-Windows calls the adapter once with the new value and persists it', async () => {
    const filePath = tempConfigPath()
    const setOpenAtLogin = vi.fn()
    const handlers = makeHandlers(makeStore(filePath), { setOpenAtLogin })

    await expect(handlers['preferences:set']({ startWithWindows: false })).resolves.toEqual({ ok: true })

    expect(setOpenAtLogin).toHaveBeenCalledTimes(1)
    expect(setOpenAtLogin).toHaveBeenCalledWith(false)
    await expect(handlers['preferences:get']()).resolves.toMatchObject({ startWithWindows: false })
  })

  it('saving only the other preference never touches the login item', async () => {
    const setOpenAtLogin = vi.fn()
    const handlers = makeHandlers(makeStore(), { setOpenAtLogin })

    await handlers['preferences:set']({ startRelayOnLaunch: false })

    expect(setOpenAtLogin).not.toHaveBeenCalled()
  })

  it('a refused patch never reaches the login item', async () => {
    const setOpenAtLogin = vi.fn()
    const handlers = makeHandlers(makeStore(), { setOpenAtLogin })

    await handlers['preferences:set']({ startWithWindows: 'yes' })

    expect(setOpenAtLogin).not.toHaveBeenCalled()
  })

  it('the entry file is the only place that calls Electron\'s login-item API', () => {
    // The adapter interface exists precisely so this one line is the sole
    // call site (10-RESEARCH Don't Hand-Roll). Assert the count, not merely
    // its presence — a second call site elsewhere is the regression.
    //
    // Comment lines are stripped first: ipcHandlers.ts NAMES this API in the
    // doc comment explaining why it injects an adapter instead of calling it,
    // and a gate that a prose mention can trip is not a gate.
    const stripComments = (source: string): string =>
      source
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n')

    const callSites = fs
      .readdirSync(ELECTRON_SRC_DIR)
      .filter((f) => f.endsWith('.ts'))
      .flatMap((f) =>
        (stripComments(readElectronSource(f)).match(/\bapp\.setLoginItemSettings\s*\(/g) ?? []).map(() => f),
      )

    expect(callSites).toEqual(['main.ts'])
  })
})

describe('starting the relay on launch — all four combinations (SC-1)', () => {
  const cases = [
    { complete: true, startRelayOnLaunch: true, expected: true },
    { complete: true, startRelayOnLaunch: false, expected: false },
    { complete: false, startRelayOnLaunch: true, expected: false },
    { complete: false, startRelayOnLaunch: false, expected: false },
  ] as const

  it.each(cases)(
    'complete=$complete startRelayOnLaunch=$startRelayOnLaunch -> started=$expected',
    async ({ complete, startRelayOnLaunch, expected }) => {
      const store = makeStore()
      if (complete) store.applyPatch(COMPLETE_CONFIG_PATCH)
      store.setPreferences({ startRelayOnLaunch })

      const start = vi.fn().mockResolvedValue({ ok: true })
      const result = await maybeAutoStartOnLaunch({ 'agent:start': start } as never, store)

      expect(result.started).toBe(expected)
      expect(start).toHaveBeenCalledTimes(expected ? 1 : 0)
    },
  )

  it('is started in exactly one of the four combinations', async () => {
    const outcomes: boolean[] = []
    for (const { complete, startRelayOnLaunch } of cases) {
      const store = makeStore()
      if (complete) store.applyPatch(COMPLETE_CONFIG_PATCH)
      store.setPreferences({ startRelayOnLaunch })
      const start = vi.fn().mockResolvedValue({ ok: true })
      outcomes.push((await maybeAutoStartOnLaunch({ 'agent:start': start } as never, store)).started)
    }
    expect(outcomes.filter(Boolean)).toHaveLength(1)
  })
})

describe('the configuration patch channel still refuses a preference key (T-10-16)', () => {
  it('refuses startWithWindows by name and writes nothing', async () => {
    const filePath = tempConfigPath()
    const handlers = makeHandlers(makeStore(filePath))
    await handlers['config:set'](COMPLETE_CONFIG_PATCH)
    const before = fs.readFileSync(filePath, 'utf8')

    const result = await handlers['config:set']({ startWithWindows: false })

    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).toContain('startWithWindows')
    expect(fs.readFileSync(filePath, 'utf8')).toBe(before)
  })
})

describe('the renderer says nothing it should not (T-10-09)', () => {
  // Comment lines are filtered first, exactly as the plan's gate command
  // does, so a header sentence can neither satisfy nor break this.
  const executableRendererJs = rendererJs
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')

  it.each([
    ['localStorage', /localStorage/],
    ['sessionStorage', /sessionStorage/],
    ['document.title', /document\.title/],
    ['innerHTML', /innerHTML/],
    ['console.*', /console\./],
  ])('uses no %s', (_label, pattern) => {
    expect(executableRendererJs).not.toMatch(pattern)
  })

  it('still writes values as text — the positive half of the same rule', () => {
    expect(executableRendererJs).toMatch(/textContent/)
  })
})

describe('the guest kiosk display stays out of this window (D10-04)', () => {
  it('the renderer has no control that opens the kiosk display', () => {
    for (const source of [rendererJs, rendererHtml]) {
      expect(source).not.toMatch(/openDisplayWindow/)
      expect(source).not.toMatch(/display\/launcher/)
      expect(source).not.toMatch(/["'`]\/display["'`]/)
    }
  })

  it('src/display/launcher.ts is unmodified by this phase', () => {
    const diff = execFileSync('git', ['diff', '--stat', 'HEAD', '--', 'src/display/launcher.ts'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
    expect(diff.trim()).toBe('')
  })
})

describe('close hides, only Quit quits (D9-07)', () => {
  it('the entry file installs the close-to-tray handler', () => {
    expect(mainSource).toMatch(/installCloseToTray\(\s*mainWindow\s*\)/)
  })

  it('the close handler prevents the default and hides the window', () => {
    expect(traySource).toMatch(/on\(\s*['"]close['"]/)
    expect(traySource).toMatch(/preventDefault\(\)/)
    expect(traySource).toMatch(/window\.hide\(\)/)
  })

  it('the quitting flag is set BEFORE app.quit(), not after', () => {
    const flagIndex = traySource.indexOf('isQuitting = true')
    const quitIndex = traySource.indexOf('app.quit()')
    expect(flagIndex).toBeGreaterThan(-1)
    expect(quitIndex).toBeGreaterThan(-1)
    expect(flagIndex).toBeLessThan(quitIndex)
  })

  it('the tray menu offers Show and Quit, and activation shows the window', () => {
    expect(traySource).toMatch(/label:\s*['"]Show['"]/)
    expect(traySource).toMatch(/label:\s*['"]Quit['"]/)
    expect(traySource).toMatch(/tray\.on\(\s*['"]click['"]/)
  })

  it('the tooltip reflects the relay state in both directions', () => {
    // `tray.ts` imports electron and cannot be loaded here, so assert on
    // source: the tooltip must branch on the running flag and carry two
    // DISTINCT strings — a single constant tooltip would tell an operator
    // glancing at the tray nothing at all.
    const tooltip = traySource.match(/return running \? (.+) : (.+)$/m)
    expect(tooltip, 'tooltipFor must branch on the running flag').not.toBeNull()
    expect(tooltip![1]).not.toBe(tooltip![2])
    expect(tooltip![1]).toMatch(/running/)
    expect(tooltip![2]).toMatch(/stopped/)
  })

  it('the tray tooltip is refreshed as the relay status changes', () => {
    expect(mainSource).toMatch(/updateTrayTooltip\(\s*tray\s*,\s*status\.running\s*\)/)
  })
})

describe('the icons exist where the entry and the packaging expect them', () => {
  it('the tray icon lives in the renderer directory, not the packaging resources directory', () => {
    expect(fs.existsSync(path.join(RENDERER_SRC_DIR, 'tray.png'))).toBe(true)
    // The entry resolves it beside the COPIED renderer, not from build/.
    expect(mainSource).toMatch(/'renderer'\s*,\s*'tray\.png'/)
    expect(mainSource).not.toMatch(/build[\\/]+icon\.png/)
  })

  it('the tray icon is copied into the build output', () => {
    const copied = path.join(REPO_ROOT, 'dist', 'renderer', 'tray.png')
    expect(
      fs.existsSync(copied),
      'dist/renderer/tray.png is missing — run `npm run build` (copy:assets) before this suite',
    ).toBe(true)
  })

  it('build/icon.png is a real PNG at least 256 pixels square', () => {
    const iconPath = path.join(REPO_ROOT, 'build', 'icon.png')
    const bytes = fs.readFileSync(iconPath)
    // PNG signature, then IHDR width/height as big-endian uint32 at 16 and 20.
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    const width = bytes.readUInt32BE(16)
    const height = bytes.readUInt32BE(20)
    expect(width).toBe(height)
    expect(width).toBeGreaterThanOrEqual(256)
  })
})
