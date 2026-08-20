import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { Writable } from 'stream'
import winston from 'winston'
import type { Config } from '../src/config'
import type { Logger } from '../src/logging/logger'
import { createLogger } from '../src/logging/logger'
import { LiveConfig, SAFE_AGENT_CONFIG_FIELDS, READ_ONLY_AGENT_CONFIG_FIELDS } from '../src/liveConfig'
import { createServiceMessageHandler, requestConfig } from '../src/agentMessages'
import { DslrBoothClient } from '../src/dslrbooth/client'

// ---------------------------------------------------------------------------
// Plan 08-04 — the Agent's half of UI-02.
//
// This repository's harness is deliberately minimal (Phase 3 left one file and
// four cases); these are added beside it, not on top of a restructuring.
//
// The point of the port case below is Pitfall 4: `DslrBoothClient` captured its
// port and password as `readonly` constructor parameters, so a plan that
// shipped only message plumbing would look complete and change nothing. A test
// that asserts a holder's getter would have passed against that broken build —
// so this one drives a real HTTP request at a real stub server and reads which
// port it arrived on.
// ---------------------------------------------------------------------------

const BOOT_CONFIG: Config = {
  extensionServiceWsUrl: 'ws://service.test:3002/agent',
  extensionServiceWsToken: 'boot-token',
  dslrBoothApiPort: 1500,
  dslrBoothPassword: 'boot-password',
  triggerServerPort: 3001,
  logLevel: 'info',
  logDir: 'logs',
  autoOpenDisplay: true,
}

function makeLogger(): Logger & { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> } {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    level: 'info',
    transports: [],
  } as unknown as Logger & { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> }
}

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.restoreAllMocks()
  while (closers.length) await closers.pop()?.()
})

/** A stand-in for the dslrBooth Local API that records what reached it. */
async function startBoothStub(): Promise<{ port: number; urls: string[] }> {
  const urls: string[] = []
  const server = http.createServer((req, res) => {
    urls.push(req.url ?? '')
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ IsSuccessful: true, ErrorMessage: '' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing stub address')
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return { port: address.port, urls }
}

describe('LiveConfig — the Agent applies what it is given, in memory only (D-17)', () => {
  it('applies a new dslrBoothApiPort so the very next startSession() call lands on it', async () => {
    const stub = await startBoothStub()
    const logger = makeLogger()
    // Constructed with the boot port, exactly as index.ts does at startup.
    const client = new DslrBoothClient(BOOT_CONFIG.dslrBoothApiPort, BOOT_CONFIG.dslrBoothPassword)
    const live = new LiveConfig(BOOT_CONFIG, logger, {
      onCredentialsChange: (port, password) => client.updateCredentials(port, password),
    })

    live.apply({ dslrBoothApiPort: stub.port })
    const result = await client.startSession('print')

    // It arrived at the stub at all — which is only possible on the NEW port.
    expect(stub.urls).toHaveLength(1)
    expect(stub.urls[0]).toContain('/api/start')
    expect(stub.urls[0]).toContain('mode=print')
    expect(result.isSuccessful).toBe(true)
    expect(live.dslrBoothApiPort).toBe(stub.port)
  })

  it('never writes to process.env and never writes a file in response to a config message', () => {
    const logger = makeLogger()
    const live = new LiveConfig(BOOT_CONFIG, logger)
    const writeFileSync = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined)
    const appendFileSync = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => undefined)
    const writeFile = vi.spyOn(fs, 'writeFile').mockImplementation(((_p: unknown, _d: unknown, cb: unknown) => {
      if (typeof cb === 'function') (cb as () => void)()
    }) as unknown as typeof fs.writeFile)

    const before = { ...process.env }
    live.apply({
      logLevel: 'debug',
      autoOpenDisplay: false,
      dslrBoothApiPort: 1600,
      dslrBoothPassword: 'rotated-password',
    })

    // The service is the single source of truth; the Agent holds a copy for
    // exactly as long as this process lives, and `.env` on the booth PC is
    // never rewritten (D-17's rejected alternative).
    expect({ ...process.env }).toEqual(before)
    expect(writeFileSync).not.toHaveBeenCalled()
    expect(appendFileSync).not.toHaveBeenCalled()
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('snapshot() reports the boot values before anything is applied', () => {
    const live = new LiveConfig(BOOT_CONFIG, makeLogger())

    expect(live.snapshot()).toEqual({
      logLevel: 'info',
      autoOpenDisplay: true,
      dslrBoothApiPort: 1500,
      dslrBoothPassword: 'boot-password',
    })
  })

  it('names its four safe fields and its four read-only ones, and they do not overlap', () => {
    expect([...SAFE_AGENT_CONFIG_FIELDS].sort()).toEqual(
      ['autoOpenDisplay', 'dslrBoothApiPort', 'dslrBoothPassword', 'logLevel'],
    )
    expect([...READ_ONLY_AGENT_CONFIG_FIELDS].sort()).toEqual(
      ['extensionServiceWsToken', 'extensionServiceWsUrl', 'logDir', 'triggerServerPort'],
    )
    for (const forbidden of READ_ONLY_AGENT_CONFIG_FIELDS) {
      expect((SAFE_AGENT_CONFIG_FIELDS as readonly string[]).includes(forbidden)).toBe(false)
    }
  })
})

describe('The four safe fields actually take effect (D-16)', () => {
  it('pushes a new log level onto EVERY transport, not just the logger', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-agent-logs-'))
    const logger = createLogger({ ...BOOT_CONFIG, logDir: dir })
    // Closed, but the directory is deliberately left behind: the daily-rotate
    // transport finishes its writes asynchronously after close(), and deleting
    // the file out from under it surfaces as an unhandled ENOENT that would
    // make this suite flaky for a reason that has nothing to do with the
    // behaviour under test. It is one small file under the OS temp directory.
    closers.push(async () => { logger.close() })
    // createLogger() sets an explicit level on both the console transport and
    // the rotating-file one, so a logger-level-only change is invisible.
    expect(logger.transports.length).toBeGreaterThan(1)
    expect(logger.transports.every((t) => t.level === 'info')).toBe(true)

    new LiveConfig(BOOT_CONFIG, logger).apply({ logLevel: 'debug' })

    expect(logger.level).toBe('debug')
    expect(logger.transports.every((t) => t.level === 'debug')).toBe(true)
  })

  it('emits a debug line that was suppressed before the level was applied', () => {
    const written: string[] = []
    const sink = (): Writable =>
      new Writable({
        write(chunk, _enc, cb) { written.push(chunk.toString()); cb() },
      })
    const format = winston.format.printf(({ level, message }) => `${level}: ${message}`)
    const logger = winston.createLogger({
      transports: [
        new winston.transports.Stream({ stream: sink(), level: 'info', format }),
        new winston.transports.Stream({ stream: sink(), level: 'info', format }),
      ],
    }) as unknown as Logger

    logger.debug('before-the-change')
    expect(written.join('')).not.toContain('before-the-change')

    new LiveConfig(BOOT_CONFIG, logger).apply({ logLevel: 'debug' })
    logger.debug('after-the-change')

    expect(written.join('')).toContain('after-the-change')
  })

  it('applies dslrBoothApiPort and dslrBoothPassword together — both reach the next API call', async () => {
    const stub = await startBoothStub()
    const client = new DslrBoothClient(BOOT_CONFIG.dslrBoothApiPort, BOOT_CONFIG.dslrBoothPassword)
    const live = new LiveConfig(BOOT_CONFIG, makeLogger(), {
      onCredentialsChange: (port, password) => client.updateCredentials(port, password),
    })

    live.apply({ dslrBoothApiPort: stub.port, dslrBoothPassword: 'rotated-password' })
    await client.startSession('print')

    expect(stub.urls[0]).toContain('password=rotated-password')
    expect(stub.urls[0]).not.toContain('boot-password')
  })

  it('refuses an empty dslrBoothPassword rather than taking the booth offline', () => {
    const logger = makeLogger()
    const live = new LiveConfig(BOOT_CONFIG, logger)

    live.apply({ dslrBoothPassword: '' })

    expect(live.dslrBoothPassword).toBe('boot-password')
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('never puts the password itself into a log line', () => {
    const logger = makeLogger()
    const live = new LiveConfig(BOOT_CONFIG, logger)

    live.apply({ dslrBoothPassword: 'super-secret-value', logDir: 'C:/nope' })

    const everythingLogged = [...logger.info.mock.calls, ...logger.warn.mock.calls]
      .flat()
      .join(' ')
    expect(everythingLogged).not.toContain('super-secret-value')
    expect(everythingLogged).toContain('dslrBoothPassword')
  })
})

describe('The four read-only fields are structurally unreachable from the wire (D-16, T-08-20)', () => {
  // One case per non-editable field. Four fields, four ignored keys, four
  // warnings, zero applications — written out rather than looped, so a failure
  // names the field that stopped being protected.

  it('ignores extensionServiceWsUrl and warns once, naming it', () => {
    const logger = makeLogger()
    const live = new LiveConfig(BOOT_CONFIG, logger)
    const before = live.snapshot()

    live.apply({ extensionServiceWsUrl: 'ws://evil.example/agent' })

    // The holder never gains the key, and the boot config it was seeded from
    // is untouched — the socket this message arrived on still points where it
    // did before.
    expect(live.snapshot()).toEqual(before)
    expect(live.snapshot()).not.toHaveProperty('extensionServiceWsUrl')
    expect(BOOT_CONFIG.extensionServiceWsUrl).toBe('ws://service.test:3002/agent')
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(String(logger.warn.mock.calls[0][0])).toContain('extensionServiceWsUrl')
  })

  it('ignores extensionServiceWsToken and warns once, naming it', () => {
    const logger = makeLogger()
    const live = new LiveConfig(BOOT_CONFIG, logger)
    const before = live.snapshot()

    live.apply({ extensionServiceWsToken: 'attacker-chosen-token' })

    expect(live.snapshot()).toEqual(before)
    expect(BOOT_CONFIG.extensionServiceWsToken).toBe('boot-token')
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(String(logger.warn.mock.calls[0][0])).toContain('extensionServiceWsToken')
  })

  it('ignores triggerServerPort and warns once, naming it', () => {
    const logger = makeLogger()
    const live = new LiveConfig(BOOT_CONFIG, logger)
    const before = live.snapshot()

    live.apply({ triggerServerPort: 9999 })

    expect(live.snapshot()).toEqual(before)
    expect(BOOT_CONFIG.triggerServerPort).toBe(3001)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(String(logger.warn.mock.calls[0][0])).toContain('triggerServerPort')
  })

  it('ignores logDir and warns once, naming it (RESEARCH A1, adopted)', () => {
    const logger = makeLogger()
    const live = new LiveConfig(BOOT_CONFIG, logger)
    const before = live.snapshot()

    live.apply({ logDir: 'Z:/unwritable' })

    expect(live.snapshot()).toEqual(before)
    expect(BOOT_CONFIG.logDir).toBe('logs')
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(String(logger.warn.mock.calls[0][0])).toContain('logDir')
  })

  it('applies the allow-listed key and ignores the forbidden one in the SAME payload', () => {
    const logger = makeLogger()
    const live = new LiveConfig(BOOT_CONFIG, logger)

    const applied = live.apply({ dslrBoothApiPort: 1600, triggerServerPort: 9999 })

    expect(applied).toEqual(['dslrBoothApiPort'])
    expect(live.dslrBoothApiPort).toBe(1600)
    expect(live.snapshot()).not.toHaveProperty('triggerServerPort')
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('warns and drops an unrecognised key rather than merging it "just in case"', () => {
    const logger = makeLogger()
    const live = new LiveConfig(BOOT_CONFIG, logger)

    const applied = live.apply({ somethingNobodyShipped: true })

    expect(applied).toEqual([])
    expect(live.snapshot()).not.toHaveProperty('somethingNobodyShipped')
    expect(String(logger.warn.mock.calls[0][0])).toContain('somethingNobodyShipped')
  })

  it('keeps the allow-list at exactly four names and excludes every read-only one', () => {
    expect(SAFE_AGENT_CONFIG_FIELDS).toHaveLength(4)
    expect(READ_ONLY_AGENT_CONFIG_FIELDS).toHaveLength(4)
    expect((SAFE_AGENT_CONFIG_FIELDS as readonly string[]).includes('extensionServiceWsUrl')).toBe(false)
    expect((SAFE_AGENT_CONFIG_FIELDS as readonly string[]).includes('extensionServiceWsToken')).toBe(false)
    expect((SAFE_AGENT_CONFIG_FIELDS as readonly string[]).includes('triggerServerPort')).toBe(false)
    expect((SAFE_AGENT_CONFIG_FIELDS as readonly string[]).includes('logDir')).toBe(false)
  })
})

describe('Service → Agent message handling (D-17 round trip)', () => {
  function build(overrides: Partial<Config> = {}) {
    const logger = makeLogger()
    const live = new LiveConfig({ ...BOOT_CONFIG, ...overrides }, logger)
    const sent: unknown[] = []
    const displayed: Array<Record<string, unknown>> = []
    const opened: number[] = []
    const handle = createServiceMessageHandler({
      live,
      logger,
      send: (msg) => { sent.push(msg) },
      updateDisplay: (patch) => { displayed.push(patch as Record<string, unknown>) },
      openDisplay: () => { opened.push(Date.now()) },
    })
    return { handle, live, logger, sent, displayed, opened }
  }

  it('answers reload_config with exactly one config_request and nothing else', () => {
    const h = build()

    const consumed = h.handle({ type: 'reload_config' })

    expect(consumed).toBe(true)
    expect(h.sent).toEqual([{ type: 'config_request' }])
  })

  it('sends a bare config_request — no snapshot, no credentials riding back to the service', () => {
    const sent: unknown[] = []
    requestConfig((msg) => { sent.push(msg) })

    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual({ type: 'config_request' })
    expect(Object.keys(sent[0] as object)).toEqual(['type'])
  })

  it('applies a config message and reports it consumed, without answering', () => {
    const h = build()

    const consumed = h.handle({ type: 'config', data: { dslrBoothApiPort: 1600 } })

    expect(consumed).toBe(true)
    expect(h.live.dslrBoothApiPort).toBe(1600)
    expect(h.sent).toEqual([])
  })

  it('tolerates a config message with no data at all', () => {
    const h = build()

    expect(h.handle({ type: 'config' })).toBe(true)
    expect(h.live.snapshot()).toEqual({
      logLevel: 'info',
      autoOpenDisplay: true,
      dslrBoothApiPort: 1500,
      dslrBoothPassword: 'boot-password',
    })
  })

  it('leaves the command message for the existing handler chain — AGT-02/03 are untouched', () => {
    const h = build()

    expect(h.handle({ type: 'command', action: 'start_session', jobId: 'job-1' })).toBe(false)
    expect(h.handle({ type: 'something-new' })).toBe(false)
    expect(h.sent).toEqual([])
  })

  it('still handles the announcement branch: display update plus auto-open', () => {
    const h = build()

    const consumed = h.handle({
      type: 'announcement',
      data: { guestName: 'Lan', endsAt: 123, queueLength: 2, upNext: [] },
    })

    expect(consumed).toBe(true)
    expect(h.displayed).toEqual([
      { phase: 'announcing', guestName: 'Lan', endsAt: 123, queueLength: 2, upNext: [] },
    ])
    expect(h.opened).toHaveLength(1)
  })

  it('reads autoOpenDisplay through the LIVE holder — flipping it changes the display-open count', () => {
    const h = build()
    const announce = { type: 'announcement', data: { guestName: 'Lan' } }

    h.handle(announce)
    expect(h.opened).toHaveLength(1)

    // The operator turns auto-open off from the CMS, mid-event.
    h.live.apply({ autoOpenDisplay: false })
    h.handle(announce)
    h.handle(announce)
    expect(h.opened).toHaveLength(1) // still 1 — nothing opened
    // The display is still told what to show; only the window-opening stops.
    expect(h.displayed).toHaveLength(3)

    // And back on again.
    h.live.apply({ autoOpenDisplay: true })
    h.handle(announce)
    expect(h.opened).toHaveLength(2)
  })

  it('applies a whole config message end to end, ignoring the forbidden keys riding on it', () => {
    const h = build()

    h.handle({
      type: 'config',
      data: {
        logLevel: 'warn',
        autoOpenDisplay: false,
        dslrBoothApiPort: 1600,
        dslrBoothPassword: 'from-the-cms',
        triggerServerPort: 9999,
        logDir: 'Z:/unwritable',
      },
    })

    expect(h.live.snapshot()).toEqual({
      logLevel: 'warn',
      autoOpenDisplay: false,
      dslrBoothApiPort: 1600,
      dslrBoothPassword: 'from-the-cms',
    })
    expect(h.logger.warn).toHaveBeenCalledTimes(2)
  })
})
