import { describe, expect, it } from 'vitest'
import { loadConfig, parseConfigValues, type Config, type ConfigValues } from '../src/config'
import { LiveConfig, LOG_LEVELS } from '../src/liveConfig'
import type { Logger } from '../src/logging/logger'

// ---------------------------------------------------------------------------
// Plan 10-01, Task 2 — one config validator, two callers.
//
// `parseConfigValues()` is the single place that decides whether a set of
// configuration values is usable (SC-4, ASVS V5). `loadConfig()` is the
// `.env` reader built on top of it. The property worth pinning is that the
// two rule sets — this validator's and `LiveConfig.assign()`'s — agree, not
// that either one alone is internally consistent.
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

const FULL_VALUES: ConfigValues = {
  extensionServiceWsUrl: 'wss://service.test:3002/agent',
  extensionServiceWsToken: 'a-token',
  dslrBoothApiPort: 1600,
  dslrBoothPassword: 'a-password',
  triggerServerPort: 3005,
  logLevel: 'debug',
  logDir: 'custom-logs',
  autoOpenDisplay: false,
}

const FULL_ENV = {
  EXTENSION_SERVICE_WS_URL: 'wss://service.test:3002/agent',
  EXTENSION_SERVICE_WS_TOKEN: 'a-token',
  DSLRBOOTH_API_PORT: '1600',
  DSLRBOOTH_PASSWORD: 'a-password',
  TRIGGER_SERVER_PORT: '3005',
  LOG_LEVEL: 'debug',
  LOG_DIR: 'custom-logs',
  AUTO_OPEN_DISPLAY: 'false',
}

const REQUIRED_ONLY_ENV = {
  EXTENSION_SERVICE_WS_URL: 'ws://service.test:3002/agent',
  EXTENSION_SERVICE_WS_TOKEN: 'a-token',
  DSLRBOOTH_PASSWORD: 'a-password',
}

describe('parseConfigValues() — the single validator', () => {
  it('reports one field error per required field when all three are missing, not one at a time', () => {
    const result = parseConfigValues({})

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(Object.keys(result.errors).sort()).toEqual(
      ['dslrBoothPassword', 'extensionServiceWsToken', 'extensionServiceWsUrl'].sort(),
    )
  })

  it('reports an empty string the same as a missing value for the three required fields', () => {
    const result = parseConfigValues({
      extensionServiceWsUrl: '',
      extensionServiceWsToken: '',
      dslrBoothPassword: '',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.errors.extensionServiceWsUrl).toBeTruthy()
    expect(result.errors.extensionServiceWsToken).toBeTruthy()
    expect(result.errors.dslrBoothPassword).toBeTruthy()
  })

  it('refuses a service URL that is not ws:// or wss://, naming what was expected', () => {
    const result = parseConfigValues({
      ...FULL_VALUES,
      extensionServiceWsUrl: 'http://service.test:3002/agent',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.errors.extensionServiceWsUrl).toContain('ws://')
    expect(result.errors.extensionServiceWsUrl).toContain('wss://')
  })

  it('accepts both ws:// and wss:// service URLs', () => {
    expect(parseConfigValues({ ...FULL_VALUES, extensionServiceWsUrl: 'ws://service.test/agent' }).ok).toBe(true)
    expect(parseConfigValues({ ...FULL_VALUES, extensionServiceWsUrl: 'wss://service.test/agent' }).ok).toBe(true)
  })

  it.each([0, 65536, 1.5])('refuses dslrBoothApiPort %s, and LiveConfig.apply() refuses it too', (badPort) => {
    const result = parseConfigValues({ ...FULL_VALUES, dslrBoothApiPort: badPort })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.errors.dslrBoothApiPort).toBeTruthy()

    const logger = makeLogger()
    const bootConfig: Config = { ...FULL_VALUES, dslrBoothApiPort: 1500, triggerServerPort: 3001 }
    const live = new LiveConfig(bootConfig, logger)
    live.apply({ dslrBoothApiPort: badPort })
    expect(live.dslrBoothApiPort).toBe(1500) // unchanged — the bad value was refused
  })

  it.each([0, 65536, 1.5])('refuses triggerServerPort %s', (badPort) => {
    const result = parseConfigValues({ ...FULL_VALUES, triggerServerPort: badPort })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.errors.triggerServerPort).toBeTruthy()
  })

  it('refuses a logLevel outside the exported LOG_LEVELS constant', () => {
    const result = parseConfigValues({ ...FULL_VALUES, logLevel: 'not-a-level' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.errors.logLevel).toBeTruthy()
  })

  it('accepts exactly the log levels LOG_LEVELS exports, not a hardcoded list', () => {
    for (const level of LOG_LEVELS) {
      const result = parseConfigValues({ ...FULL_VALUES, logLevel: level })
      expect(result.ok).toBe(true)
    }
  })

  it('applies the shipped defaults for absent optional fields', () => {
    const result = parseConfigValues({
      extensionServiceWsUrl: 'ws://service.test/agent',
      extensionServiceWsToken: 'token',
      dslrBoothPassword: 'password',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected success')
    expect(result.config.dslrBoothApiPort).toBe(1500)
    expect(result.config.triggerServerPort).toBe(3001)
    expect(result.config.logLevel).toBe('info')
    expect(result.config.logDir).toBe('logs')
    expect(result.config.autoOpenDisplay).toBe(true)
  })

  it('never touches process.env', () => {
    const before = { ...process.env }
    parseConfigValues(FULL_VALUES)
    expect({ ...process.env }).toEqual(before)
  })
})

describe('loadConfig(env) — the environment reader built on parseConfigValues', () => {
  it('produces all eight Config fields from a fully-populated environment', () => {
    const config = loadConfig(FULL_ENV)

    expect(config).toEqual({
      extensionServiceWsUrl: 'wss://service.test:3002/agent',
      extensionServiceWsToken: 'a-token',
      dslrBoothApiPort: 1600,
      dslrBoothPassword: 'a-password',
      triggerServerPort: 3005,
      logLevel: 'debug',
      logDir: 'custom-logs',
      autoOpenDisplay: false,
    })
  })

  it('produces the five defaults when only the three required variables are set', () => {
    const config = loadConfig(REQUIRED_ONLY_ENV)

    expect(config.dslrBoothApiPort).toBe(1500)
    expect(config.triggerServerPort).toBe(3001)
    expect(config.logLevel).toBe('info')
    expect(config.logDir).toBe('logs')
    expect(config.autoOpenDisplay).toBe(true)
  })

  it('throws a message naming every failing field when the environment is broken', () => {
    expect(() => loadConfig({})).toThrowError(
      /extensionServiceWsUrl.*extensionServiceWsToken.*dslrBoothPassword|dslrBoothPassword.*extensionServiceWsToken.*extensionServiceWsUrl/,
    )
  })

  it('reads from the passed environment object, not the real process.env', () => {
    const before = { ...process.env }
    const config = loadConfig(FULL_ENV)

    expect(config.extensionServiceWsUrl).toBe(FULL_ENV.EXTENSION_SERVICE_WS_URL)
    expect({ ...process.env }).toEqual(before)
  })

  it('never touches process.env even when reading nothing but defaults', () => {
    const before = { ...process.env }
    loadConfig(REQUIRED_ONLY_ENV)
    expect({ ...process.env }).toEqual(before)
  })
})
