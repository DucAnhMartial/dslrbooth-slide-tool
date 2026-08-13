import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import http from 'http'
import net from 'net'
import os from 'os'
import path from 'path'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Logger } from '../src/logging/logger'
import { createAgent } from '../src/agent'
import { createConfigStore, type SecretEncryptor } from '../src/electron/configStore'
import { createIpcHandlers } from '../src/electron/ipcHandlers'

// ---------------------------------------------------------------------------
// Plan 10-02, Task 1 — the tracer.
//
// This is the whole thin slice the phase depends on: an empty user-data
// directory, a settings form's Save, a Start, a live relay — driven through
// exactly the functions the window's controls call, nothing mocked except
// the platform key store (the one Electron capability this Linux machine
// cannot exercise), a real WebSocketServer and a real dslrBooth stub, per
// the harness shapes established in test/agent-lifecycle.test.ts and
// test/config-reload.test.ts.
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

/** No wrapping at all — deterministic, so the store's own JSON is legible in assertions. */
function makeFakeEncryptor(available = true): SecretEncryptor {
  return {
    isAvailable: () => available,
    encrypt: (plaintext: string) => `enc:${plaintext}`,
    decrypt: (ciphertext: string) => {
      if (!ciphertext.startsWith('enc:')) throw new Error('bad ciphertext')
      return ciphertext.slice(4)
    },
  }
}

const closers: Array<() => Promise<void>> = []
let tmpDir: string | null = null

afterEach(async () => {
  vi.restoreAllMocks()
  while (closers.length) await closers.pop()?.()
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = null
  }
})

function makeConfigPath(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-agent-config-'))
  // A path that does not exist yet, one directory down — proves the store
  // creates its own directory rather than requiring userData to pre-exist.
  return path.join(tmpDir, 'nested', 'config.json')
}

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

async function getEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Missing ephemeral port address'))
        return
      }
      const port = address.port
      probe.close(() => resolve(port))
    })
  })
}

interface ServiceStub {
  url: string
  connectionCount(): number
  waitForConnection(timeoutMs?: number): Promise<void>
}

async function startServiceStub(): Promise<ServiceStub> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', () => resolve())
    wss.once('error', reject)
  })
  const address = wss.address()
  if (!address || typeof address === 'string') throw new Error('Missing service stub address')

  let connections = 0
  const connectionWaiters: Array<() => void> = []
  wss.on('connection', (_socket: WebSocket) => {
    connections += 1
    while (connectionWaiters.length) connectionWaiters.shift()?.()
  })
  closers.push(() => new Promise<void>((resolve) => wss.close(() => resolve())))

  return {
    url: `ws://127.0.0.1:${address.port}`,
    connectionCount: () => connections,
    waitForConnection: (timeoutMs = 2000) =>
      connections > 0
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('timed out waiting for a connection')), timeoutMs)
            connectionWaiters.push(() => { clearTimeout(timer); resolve() })
          }),
  }
}

function buildHandlers(configPath: string, encryptor: SecretEncryptor) {
  const logger = makeLogger()
  const store = createConfigStore({ filePath: configPath, encryptor, logger })
  let agent: ReturnType<typeof createAgent> | null = null
  const pushedStatuses: unknown[] = []
  const handlers = createIpcHandlers({
    store,
    logger,
    getAgent: () => agent,
    setAgent: (next) => { agent = next },
    createAgent,
    pushStatus: (status) => { pushedStatuses.push(status) },
  })
  closers.push(async () => { await agent?.stop() })
  return { handlers, store, pushedStatuses, getAgent: () => agent }
}

describe('config store — first run and the redacted snapshot (T-10-08)', () => {
  it('a store pointed at a path that does not exist reports first run with shipped defaults and both presence flags false', () => {
    const configPath = makeConfigPath()
    const store = createConfigStore({ filePath: configPath, encryptor: makeFakeEncryptor(), logger: makeLogger() })

    expect(store.isFirstRun()).toBe(true)
    const snapshot = store.getSnapshot()
    expect(snapshot.hasExtensionServiceWsToken).toBe(false)
    expect(snapshot.hasDslrBoothPassword).toBe(false)
    expect(snapshot.dslrBoothApiPort).toBe(1500)
    expect(snapshot.triggerServerPort).toBe(3001)
    expect(snapshot.logLevel).toBe('info')
    expect(snapshot.autoOpenDisplay).toBe(true)
  })

  it('the snapshot key set is exactly the six non-secret fields plus the two presence flags plus the two import-migration fields (10-03), and contains no secret', () => {
    const configPath = makeConfigPath()
    const store = createConfigStore({ filePath: configPath, encryptor: makeFakeEncryptor(), logger: makeLogger() })
    store.applyPatch({
      extensionServiceWsUrl: 'ws://service.test:3002/agent',
      extensionServiceWsToken: 'super-secret-token',
      dslrBoothPassword: 'super-secret-password',
    })

    const snapshot = store.getSnapshot()
    expect(Object.keys(snapshot).sort()).toEqual([
      'autoOpenDisplay',
      'dslrBoothApiPort',
      'hasDslrBoothPassword',
      'hasExtensionServiceWsToken',
      'isFirstRun',
      'legacyEnvPath',
      'logDir',
      'logLevel',
      'triggerServerPort',
      'extensionServiceWsUrl',
    ].sort())
    expect(JSON.stringify(snapshot)).not.toContain('super-secret-token')
    expect(JSON.stringify(snapshot)).not.toContain('super-secret-password')
  })

  it('saving a complete configuration writes one JSON file; a store built fresh on that path reports not-first-run with the saved values', () => {
    const configPath = makeConfigPath()
    const store = createConfigStore({ filePath: configPath, encryptor: makeFakeEncryptor(), logger: makeLogger() })

    const result = store.applyPatch({
      extensionServiceWsUrl: 'ws://service.test:3002/agent',
      extensionServiceWsToken: 'boot-token',
      dslrBoothApiPort: 1500,
      dslrBoothPassword: 'boot-password',
      triggerServerPort: 3001,
      logLevel: 'info',
      logDir: 'logs',
      autoOpenDisplay: true,
    })
    expect(result.ok).toBe(true)
    expect(fs.existsSync(configPath)).toBe(true)

    const fresh = createConfigStore({ filePath: configPath, encryptor: makeFakeEncryptor(), logger: makeLogger() })
    expect(fresh.isFirstRun()).toBe(false)
    expect(fresh.getSnapshot().extensionServiceWsUrl).toBe('ws://service.test:3002/agent')
    expect(fresh.getSnapshot().hasExtensionServiceWsToken).toBe(true)
    expect(fresh.getSnapshot().hasDslrBoothPassword).toBe(true)
  })

  it('saving with both secret fields blank leaves the stored secrets unchanged; a non-empty value replaces the old one', () => {
    const configPath = makeConfigPath()
    const store = createConfigStore({ filePath: configPath, encryptor: makeFakeEncryptor(), logger: makeLogger() })
    store.applyPatch({
      extensionServiceWsUrl: 'ws://service.test:3002/agent',
      extensionServiceWsToken: 'first-token',
      dslrBoothPassword: 'first-password',
    })

    // Blank secrets: both must survive.
    store.applyPatch({ extensionServiceWsUrl: 'ws://service.test:3002/agent', extensionServiceWsToken: '', dslrBoothPassword: '' })
    expect(store.buildConfig()).toMatchObject({ ok: true, config: { extensionServiceWsToken: 'first-token', dslrBoothPassword: 'first-password' } })

    // A non-empty value replaces it.
    store.applyPatch({ dslrBoothPassword: 'rotated-password' })
    expect(store.buildConfig()).toMatchObject({ ok: true, config: { extensionServiceWsToken: 'first-token', dslrBoothPassword: 'rotated-password' } })
  })

  it('saving a value the shared validator refuses returns a field-error map and writes nothing at all', () => {
    const configPath = makeConfigPath()
    const store = createConfigStore({ filePath: configPath, encryptor: makeFakeEncryptor(), logger: makeLogger() })
    store.applyPatch({
      extensionServiceWsUrl: 'ws://service.test:3002/agent',
      extensionServiceWsToken: 'boot-token',
      dslrBoothPassword: 'boot-password',
    })
    const before = fs.readFileSync(configPath, 'utf8')

    const result = store.applyPatch({ dslrBoothApiPort: 99999 })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors).toHaveProperty('dslrBoothApiPort')
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before)
  })

  it('saving a key outside the eight configuration fields is refused by name and writes nothing', () => {
    const configPath = makeConfigPath()
    const store = createConfigStore({ filePath: configPath, encryptor: makeFakeEncryptor(), logger: makeLogger() })

    const result = store.applyPatch({ somethingNobodyShipped: true })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.somethingNobodyShipped).toContain('somethingNobodyShipped')
    expect(fs.existsSync(configPath)).toBe(false)
  })
})

describe('the IPC handler map — an empty config directory to a live socket (SC-1, SC-2)', () => {
  it('start builds the Agent through the factory, binds the trigger port and connects; status reports running and connected', async () => {
    const configPath = makeConfigPath()
    const boothStub = await startBoothStub()
    const service = await startServiceStub()
    const triggerPort = await getEphemeralPort()
    const { handlers, store } = buildHandlers(configPath, makeFakeEncryptor())

    const saved = store.applyPatch({
      extensionServiceWsUrl: service.url,
      extensionServiceWsToken: 'test-token',
      dslrBoothApiPort: boothStub.port,
      dslrBoothPassword: 'test-password',
      triggerServerPort: triggerPort,
    })
    expect(saved.ok).toBe(true)

    const startResult = await handlers['agent:start']()
    expect(startResult).toEqual({ ok: true })

    await service.waitForConnection()
    const health = await fetch(`http://127.0.0.1:${triggerPort}/health`)
    expect(health.status).toBe(200)

    const status = await handlers['agent:status']()
    expect(status.running).toBe(true)
    expect(status.socketState).toBe('connected')
    expect(status.triggerPort).toBe(triggerPort)
  })

  it('stop releases the trigger port and reports not running; starting again afterwards works', async () => {
    const configPath = makeConfigPath()
    const boothStub = await startBoothStub()
    const service = await startServiceStub()
    const triggerPort = await getEphemeralPort()
    const { handlers, store } = buildHandlers(configPath, makeFakeEncryptor())
    store.applyPatch({
      extensionServiceWsUrl: service.url,
      extensionServiceWsToken: 'test-token',
      dslrBoothApiPort: boothStub.port,
      dslrBoothPassword: 'test-password',
      triggerServerPort: triggerPort,
    })

    await handlers['agent:start']()
    await service.waitForConnection()

    const stopResult = await handlers['agent:stop']()
    expect(stopResult).toEqual({ ok: true })
    const stoppedStatus = await handlers['agent:status']()
    expect(stoppedStatus.running).toBe(false)

    // A fresh listener can bind the released port immediately.
    const fresh = net.createServer()
    await new Promise<void>((resolve, reject) => {
      fresh.once('error', reject)
      fresh.listen(triggerPort, '0.0.0.0', () => resolve())
    })
    await new Promise<void>((resolve) => fresh.close(() => resolve()))

    const secondService = await startServiceStub()
    store.applyPatch({ extensionServiceWsUrl: secondService.url })
    const restart = await handlers['agent:start']()
    expect(restart).toEqual({ ok: true })
    await secondService.waitForConnection()
    expect((await handlers['agent:status']()).running).toBe(true)

    // Explicit, rather than relying on `closers`' LIFO order: `secondService`
    // was started (and its own closer pushed) after the agent was — closing
    // it first, with the agent's socket still open, would hang `wss.close()`
    // waiting for a client that never disconnects.
    await handlers['agent:stop']()
  })

  it('start on an unusable configuration returns field errors instead of throwing, and the relay stays stopped', async () => {
    const configPath = makeConfigPath()
    const { handlers } = buildHandlers(configPath, makeFakeEncryptor())

    const result = await handlers['agent:start']()

    expect(result.ok).toBe(false)
    if (!result.ok && 'errors' in result) {
      expect(result.errors).toHaveProperty('extensionServiceWsUrl')
    } else {
      throw new Error('expected a field-error result')
    }
    expect((await handlers['agent:status']()).running).toBe(false)
  })

  it('start against an occupied trigger port returns the recorded failure text instead of throwing', async () => {
    const configPath = makeConfigPath()
    const boothStub = await startBoothStub()
    const service = await startServiceStub()
    const triggerPort = await getEphemeralPort()
    const { handlers, store } = buildHandlers(configPath, makeFakeEncryptor())
    store.applyPatch({
      extensionServiceWsUrl: service.url,
      extensionServiceWsToken: 'test-token',
      dslrBoothApiPort: boothStub.port,
      dslrBoothPassword: 'test-password',
      triggerServerPort: triggerPort,
    })

    const occupied = net.createServer()
    await new Promise<void>((resolve) => occupied.listen(triggerPort, '0.0.0.0', () => resolve()))
    closers.push(() => new Promise<void>((resolve) => occupied.close(() => resolve())))

    const result = await handlers['agent:start']()

    expect(result.ok).toBe(false)
    if (!result.ok && 'error' in result) {
      expect(typeof result.error).toBe('string')
      expect(result.error.length).toBeGreaterThan(0)
    } else {
      throw new Error('expected a runtime-error result')
    }
    expect((await handlers['agent:status']()).running).toBe(false)
    expect(service.connectionCount()).toBe(0)
  })

  it('every status change pushed by the factory reaches the injected push function with the same snapshot the status handler returns', async () => {
    const configPath = makeConfigPath()
    const boothStub = await startBoothStub()
    const service = await startServiceStub()
    const triggerPort = await getEphemeralPort()
    const { handlers, store, pushedStatuses } = buildHandlers(configPath, makeFakeEncryptor())
    store.applyPatch({
      extensionServiceWsUrl: service.url,
      extensionServiceWsToken: 'test-token',
      dslrBoothApiPort: boothStub.port,
      dslrBoothPassword: 'test-password',
      triggerServerPort: triggerPort,
    })

    await handlers['agent:start']()
    await service.waitForConnection()
    // Give the connected status change a turn to propagate.
    await new Promise((resolve) => setTimeout(resolve, 20))

    const finalStatus = await handlers['agent:status']()
    expect(pushedStatuses.length).toBeGreaterThan(0)
    expect(pushedStatuses[pushedStatuses.length - 1]).toEqual(finalStatus)
  })
})
