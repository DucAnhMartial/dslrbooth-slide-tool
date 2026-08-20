import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { findLegacyEnvFile, parseLegacyEnvFile } from '../src/electron/envImport'
import { createConfigStore, type SecretEncryptor } from '../src/electron/configStore'
import type { Logger } from '../src/logging/logger'

// ---------------------------------------------------------------------------
// Plan 10-03, Task 1 — the `.env` importer (D10-02's migration note) and the
// settings form's per-field errors.
//
// Ground-truth note: this task's own read_first instructed reading
// `.env.example` in full before writing anything. The shipped file defines
// SEVEN variables, not six — DSLRBOOTH_PASSWORD, DSLRBOOTH_API_PORT,
// TRIGGER_SERVER_PORT, EXTENSION_SERVICE_WS_URL, EXTENSION_SERVICE_WS_TOKEN,
// LOG_LEVEL, AUTO_OPEN_DISPLAY. Every count below is checked against the
// actual file content, read directly in this test, not against a
// hand-typed guess carried over from the plan text.
// ---------------------------------------------------------------------------

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

function makeEncryptor(): SecretEncryptor {
  return {
    isAvailable: () => true,
    encrypt: (plaintext: string) => `wrapped:${Buffer.from(plaintext, 'utf8').toString('base64')}`,
    decrypt: (ciphertext: string) => Buffer.from(ciphertext.replace(/^wrapped:/, ''), 'base64').toString('utf8'),
  }
}

let tmpDir: string | null = null
function makeTmpDir(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-agent-env-import-'))
  return tmpDir
}

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = null
  }
})

const EXAMPLE_ENV_PATH = path.join(__dirname, '..', '.env.example')

describe('findLegacyEnvFile — first existing candidate wins', () => {
  it('returns null when no candidate directory has a .env file', () => {
    const dir = makeTmpDir()
    const a = path.join(dir, 'a')
    const b = path.join(dir, 'b')
    fs.mkdirSync(a)
    fs.mkdirSync(b)
    expect(findLegacyEnvFile([a, b])).toBeNull()
  })

  it('returns null for an empty candidate list', () => {
    expect(findLegacyEnvFile([])).toBeNull()
  })

  it.each([0, 1, 2])('finds the file when it exists at candidate position %i of three', (position) => {
    const dir = makeTmpDir()
    const dirs = [path.join(dir, 'a'), path.join(dir, 'b'), path.join(dir, 'c')]
    for (const d of dirs) fs.mkdirSync(d)
    const targetFile = path.join(dirs[position], '.env')
    fs.writeFileSync(targetFile, 'FOO=bar\n')
    expect(findLegacyEnvFile(dirs)).toBe(targetFile)
  })

  it('when more than one candidate has a file, the first in order wins', () => {
    const dir = makeTmpDir()
    const dirs = [path.join(dir, 'a'), path.join(dir, 'b')]
    for (const d of dirs) fs.mkdirSync(d)
    fs.writeFileSync(path.join(dirs[0], '.env'), 'FIRST=1\n')
    fs.writeFileSync(path.join(dirs[1], '.env'), 'SECOND=1\n')
    expect(findLegacyEnvFile(dirs)).toBe(path.join(dirs[0], '.env'))
  })
})

describe('parsing the repository\'s own .env.example', () => {
  it('produces every variable the shipped file actually defines (seven, not six)', () => {
    const parsed = parseLegacyEnvFile(EXAMPLE_ENV_PATH)

    expect(parsed.fieldsPresent.slice().sort()).toEqual(
      [
        'autoOpenDisplay',
        'dslrBoothApiPort',
        'dslrBoothPassword',
        'extensionServiceWsToken',
        'extensionServiceWsUrl',
        'logLevel',
        'triggerServerPort',
      ].sort(),
    )
    expect(parsed.values).toMatchObject({
      extensionServiceWsUrl: 'ws://203.0.113.10:3002/agent',
      extensionServiceWsToken: 'change-me-to-a-secure-token',
      dslrBoothApiPort: 1500,
      dslrBoothPassword: 'your-dslrbooth-password',
      triggerServerPort: 3001,
      logLevel: 'info',
      autoOpenDisplay: true,
    })
    // The example file never defines LOG_DIR — the mapping must not invent one.
    expect(parsed.values.logDir).toBeUndefined()
  })
})

describe('the parser tolerates the shapes a real .env has, and skips what it cannot parse', () => {
  it.each([
    ['a full-line comment is ignored', '# a comment\nEXTENSION_SERVICE_WS_URL=ws://x\n', { extensionServiceWsUrl: 'ws://x' }],
    ['blank lines are ignored', '\n\nEXTENSION_SERVICE_WS_URL=ws://x\n\n', { extensionServiceWsUrl: 'ws://x' }],
    ['CRLF line endings are tolerated', 'EXTENSION_SERVICE_WS_URL=ws://x\r\nLOG_LEVEL=debug\r\n', { extensionServiceWsUrl: 'ws://x', logLevel: 'debug' }],
    ["a single-quoted value has its quotes stripped", "EXTENSION_SERVICE_WS_URL='ws://x'\n", { extensionServiceWsUrl: 'ws://x' }],
    ['a double-quoted value has its quotes stripped', 'EXTENSION_SERVICE_WS_URL="ws://x"\n', { extensionServiceWsUrl: 'ws://x' }],
    [
      'a line the parser cannot make sense of is skipped, not aborting the import',
      '!!!not a valid line!!!\nEXTENSION_SERVICE_WS_URL=ws://x\n',
      { extensionServiceWsUrl: 'ws://x' },
    ],
  ])('%s', (_name, content, expected) => {
    const dir = makeTmpDir()
    const file = path.join(dir, '.env')
    fs.writeFileSync(file, content)
    const parsed = parseLegacyEnvFile(file)
    expect(parsed.values).toMatchObject(expected)
  })
})

function configPathIn(dir: string): string {
  return path.join(dir, 'nested', 'config.json')
}

describe('importing a legacy .env through the store (T-10-16)', () => {
  it('a complete file is imported: persisted config equals the parsed values, the field list names every field the file set, and the result carries neither secret', () => {
    const dir = makeTmpDir()
    const envFile = path.join(dir, '.env')
    fs.writeFileSync(
      envFile,
      [
        'EXTENSION_SERVICE_WS_URL=ws://svc.test:3002/agent',
        'EXTENSION_SERVICE_WS_TOKEN=a-plaintext-token',
        'DSLRBOOTH_API_PORT=1600',
        'DSLRBOOTH_PASSWORD=a-plaintext-password',
        'TRIGGER_SERVER_PORT=4001',
        'LOG_LEVEL=debug',
        'LOG_DIR=custom-logs',
        'AUTO_OPEN_DISPLAY=false',
      ].join('\n') + '\n',
    )

    const store = createConfigStore({
      filePath: configPathIn(dir),
      encryptor: makeEncryptor(),
      logger: makeLogger(),
      legacyEnvPath: envFile,
    })

    const result = store.importLegacy()
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')

    expect(result.importedFields.slice().sort()).toEqual(
      [
        'autoOpenDisplay',
        'dslrBoothApiPort',
        'dslrBoothPassword',
        'extensionServiceWsToken',
        'extensionServiceWsUrl',
        'logDir',
        'logLevel',
        'triggerServerPort',
      ].sort(),
    )

    expect(result.snapshot).toMatchObject({
      extensionServiceWsUrl: 'ws://svc.test:3002/agent',
      dslrBoothApiPort: 1600,
      triggerServerPort: 4001,
      logLevel: 'debug',
      logDir: 'custom-logs',
      autoOpenDisplay: false,
      hasExtensionServiceWsToken: true,
      hasDslrBoothPassword: true,
    })

    // T-10-16: neither secret value crosses back out of the main process,
    // under any key, anywhere in the returned result.
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('a-plaintext-token')
    expect(serialized).not.toContain('a-plaintext-password')
    // (Mutation check performed during authoring: returning `parsed.values`
    // instead of `getSnapshot()` from `importLegacy()` makes this assertion
    // fail red, since the plaintext strings become literal substrings of
    // `serialized`. Reverted before this commit.)

    // The store's own persisted view agrees with what was imported.
    const store2 = createConfigStore({ filePath: configPathIn(dir), encryptor: makeEncryptor(), logger: makeLogger() })
    const built = store2.buildConfig()
    expect(built.ok).toBe(true)
    if (built.ok) {
      expect(built.config.extensionServiceWsToken).toBe('a-plaintext-token')
      expect(built.config.dslrBoothPassword).toBe('a-plaintext-password')
    }
  })

  it('a file missing a required variable reports field errors and persists nothing', () => {
    const dir = makeTmpDir()
    const envFile = path.join(dir, '.env')
    // Missing DSLRBOOTH_PASSWORD (required by parseConfigValues).
    fs.writeFileSync(
      envFile,
      ['EXTENSION_SERVICE_WS_URL=ws://svc.test:3002/agent', 'EXTENSION_SERVICE_WS_TOKEN=a-plaintext-token'].join('\n') + '\n',
    )

    const storeFilePath = configPathIn(dir)
    const store = createConfigStore({
      filePath: storeFilePath,
      encryptor: makeEncryptor(),
      logger: makeLogger(),
      legacyEnvPath: envFile,
    })

    const result = store.importLegacy()
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.errors.dslrBoothPassword).toBeDefined()
    expect(fs.existsSync(storeFilePath)).toBe(false)
  })

  it('reports a plain error, not a crash, when no legacy file was discovered', () => {
    const dir = makeTmpDir()
    const store = createConfigStore({
      filePath: configPathIn(dir),
      encryptor: makeEncryptor(),
      logger: makeLogger(),
      legacyEnvPath: null,
    })
    const result = store.importLegacy()
    expect(result.ok).toBe(false)
  })

  it('does not read or write the process environment', () => {
    const dir = makeTmpDir()
    const envFile = path.join(dir, '.env')
    fs.writeFileSync(
      envFile,
      [
        'EXTENSION_SERVICE_WS_URL=ws://svc.test:3002/agent',
        'EXTENSION_SERVICE_WS_TOKEN=a-plaintext-token',
        'DSLRBOOTH_PASSWORD=a-plaintext-password',
      ].join('\n') + '\n',
    )
    const store = createConfigStore({
      filePath: configPathIn(dir),
      encryptor: makeEncryptor(),
      logger: makeLogger(),
      legacyEnvPath: envFile,
    })
    const before = { ...process.env }
    store.importLegacy()
    expect({ ...process.env }).toEqual(before)
  })
})

describe('the config snapshot reports the discovered legacy path (or none)', () => {
  it('carries the injected legacyEnvPath and isFirstRun through to the snapshot', () => {
    const dir = makeTmpDir()
    const envFile = path.join(dir, '.env')
    fs.writeFileSync(envFile, 'EXTENSION_SERVICE_WS_URL=ws://x\n')
    const store = createConfigStore({
      filePath: configPathIn(dir),
      encryptor: makeEncryptor(),
      logger: makeLogger(),
      legacyEnvPath: envFile,
    })
    const snapshot = store.getSnapshot()
    expect(snapshot.legacyEnvPath).toBe(envFile)
    expect(snapshot.isFirstRun).toBe(true)
  })

  it('reports null when no legacy path was discovered', () => {
    const dir = makeTmpDir()
    const store = createConfigStore({ filePath: configPathIn(dir), encryptor: makeEncryptor(), logger: makeLogger() })
    expect(store.getSnapshot().legacyEnvPath).toBeNull()
  })
})

describe('the settings form renders one error slot per field and documents the secret placeholders', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8')
  const CONFIG_FIELDS = [
    'extensionServiceWsUrl',
    'extensionServiceWsToken',
    'dslrBoothApiPort',
    'dslrBoothPassword',
    'triggerServerPort',
    'logLevel',
    'logDir',
    'autoOpenDisplay',
  ]

  it.each(CONFIG_FIELDS)('has an error slot for %s', (field) => {
    expect(indexHtml).toContain(`id="error-${field}"`)
  })

  it('the two secret inputs are password type with the leave-blank-to-keep placeholder', () => {
    for (const field of ['extensionServiceWsToken', 'dslrBoothPassword']) {
      const inputMatch = indexHtml.match(new RegExp(`<input[^>]*id="${field}"[^>]*>`))
      expect(inputMatch).not.toBeNull()
      expect(inputMatch![0]).toContain('type="password"')
      expect(inputMatch![0]).toContain('placeholder="Leave blank to keep the stored value"')
    }
  })

  it('offers the import as an action with the discovered path shown, not as something already done', () => {
    expect(indexHtml).toMatch(/<section id="import-panel"[^>]*hidden/)
    expect(indexHtml).toContain('id="import-button"')
    expect(indexHtml).toContain('id="legacy-path"')
  })

  it('shows each secret\'s presence separately from its placeholder', () => {
    expect(indexHtml).toContain('id="hint-extensionServiceWsToken"')
    expect(indexHtml).toContain('id="hint-dslrBoothPassword"')
  })

  it('the restart-required notice carries a reachable restart control on the same screen', () => {
    expect(indexHtml).toMatch(/id="restart-required-notice"[^>]*hidden/)
    expect(indexHtml).toContain('id="restart-button"')
  })
})

describe('the renderer script wires the import offer without ever assigning markup', () => {
  const indexJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.js'), 'utf8')

  it('does not assign innerHTML anywhere', () => {
    expect(indexJs).not.toMatch(/\.innerHTML\s*=/)
  })

  it('calls importLegacyEnv from the import button handler', () => {
    expect(indexJs).toContain("window.agentDesktop.importLegacyEnv()")
  })

  it('a failed save returns before repopulating the form, preserving what the operator typed', () => {
    const submitStart = indexJs.indexOf("addEventListener('submit'")
    const submitEnd = indexJs.indexOf("byId('restart-button')")
    const submitHandler = indexJs.slice(submitStart, submitEnd)
    const failureBranch = submitHandler.slice(
      submitHandler.indexOf('if (!result'),
      submitHandler.indexOf('if (result.restartRequired)'),
    )
    expect(failureBranch).toContain('return')
    expect(failureBranch).not.toContain('loadConfigIntoForm')
  })
})
