import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import http from 'http'
import net from 'net'
import os from 'os'
import path from 'path'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Logger } from '../src/logging/logger'
import { createLogger } from '../src/logging/logger'
import { createAgent } from '../src/agent'
import { SAFE_AGENT_CONFIG_FIELDS, READ_ONLY_AGENT_CONFIG_FIELDS } from '../src/liveConfig'
import { createConfigStore, type SecretEncryptor } from '../src/electron/configStore'
import { createIpcHandlers } from '../src/electron/ipcHandlers'

// ---------------------------------------------------------------------------
// Plan 10-02, Task 2 — the credential contract at rest, and the four
// CMS-safe fields taking effect on a running relay (D10-02, D10-03).
//
// This file is the local half only, on the same harness shapes as
// test/electron-ipc.test.ts (Task 1) and test/config-reload.test.ts (the
// wire half, whose 24 cases this file does not restate). The dslrBooth-port
// case below mirrors the reasoning in the 08-04 case in config-reload.test.ts:
// a holder-getter assertion alone would pass against a build that persisted
// the port but never wired it to the live DslrBoothClient, so this drives a
// real HTTP request at a real stub server and reads which port it arrived on.
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

function makeSpyLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return {
    info: () => {},
    warn: vi.fn(),
    error: () => {},
    debug: () => {},
    level: 'info',
    transports: [],
  } as unknown as Logger & { warn: ReturnType<typeof vi.fn> }
}

/**
 * Base64-codes rather than prefixing the plaintext verbatim, so a case that
 * asserts "the file's bytes contain neither plaintext secret" is actually
 * testing something — a `enc:${plaintext}` fake (fine for Task 1's
 * snapshot-only assertions) would fail that specific check by construction.
 */
function makeFakeEncryptor(available = true, opts: { poisonDecrypt?: boolean } = {}): SecretEncryptor {
  return {
    isAvailable: () => available,
    encrypt: (plaintext: string) => `wrapped:${Buffer.from(plaintext, 'utf8').toString('base64')}`,
    decrypt: (ciphertext: string) => {
      if (opts.poisonDecrypt) throw new Error('cannot decrypt: different account')
      if (!ciphertext.startsWith('wrapped:')) throw new Error('bad ciphertext')
      return Buffer.from(ciphertext.slice('wrapped:'.length), 'base64').toString('utf8')
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-agent-config-ipc-'))
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
  send(msg: unknown): void
  waitForConnection(timeoutMs?: number): Promise<void>
  waitForMessage(predicate: (msg: any) => boolean, timeoutMs?: number): Promise<any>
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
  let activeSocket: WebSocket | null = null
  const received: unknown[] = []
  const connectionWaiters: Array<() => void> = []
  const messageWaiters: Array<{ predicate: (m: unknown) => boolean; resolve: (m: unknown) => void }> = []

  wss.on('connection', (socket: WebSocket) => {
    connections += 1
    activeSocket = socket
    while (connectionWaiters.length) connectionWaiters.shift()?.()
    socket.on('message', (data) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(data.toString())
      } catch {
        return
      }
      received.push(parsed)
      for (const waiter of [...messageWaiters]) {
        if (waiter.predicate(parsed)) {
          messageWaiters.splice(messageWaiters.indexOf(waiter), 1)
          waiter.resolve(parsed)
        }
      }
    })
  })

  closers.push(() => new Promise<void>((resolve) => wss.close(() => resolve())))

  return {
    url: `ws://127.0.0.1:${address.port}`,
    connectionCount: () => connections,
    send: (msg: unknown) => { activeSocket?.send(JSON.stringify(msg)) },
    waitForConnection: (timeoutMs = 2000) =>
      connections > 0
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('timed out waiting for a connection')), timeoutMs)
            connectionWaiters.push(() => { clearTimeout(timer); resolve() })
          }),
    waitForMessage: (predicate, timeoutMs = 2000) => {
      const existing = received.find(predicate)
      if (existing) return Promise.resolve(existing)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for a matching message')), timeoutMs)
        messageWaiters.push({ predicate, resolve: (m) => { clearTimeout(timer); resolve(m) } })
      })
    },
  }
}

function buildHandlers(configPath: string, encryptor: SecretEncryptor, logger: Logger = makeLogger()) {
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

describe('secrets at rest — wrapped when available, honest when not (T-10-10)', () => {
  it('with a wrapping encryptor, saving writes the two secrets wrapped and the file bytes contain neither plaintext', () => {
    const configPath = makeConfigPath()
    const store = createConfigStore({ filePath: configPath, encryptor: makeFakeEncryptor(true), logger: makeLogger() })

    store.applyPatch({
      extensionServiceWsUrl: 'ws://service.test:3002/agent',
      extensionServiceWsToken: 'a-plaintext-extension-token',
      dslrBoothPassword: 'a-plaintext-dslrbooth-password',
    })

    const raw = fs.readFileSync(configPath, 'utf8')
    const doc = JSON.parse(raw)
    expect(doc.secrets.extensionServiceWsToken.wrapped).toBe(true)
    expect(doc.secrets.dslrBoothPassword.wrapped).toBe(true)
    expect(raw).not.toContain('a-plaintext-extension-token')
    expect(raw).not.toContain('a-plaintext-dslrbooth-password')
  })

  it('with a non-wrapping encryptor, saving writes the two secrets unwrapped and logs exactly one warning naming the situation', () => {
    const configPath = makeConfigPath()
    const logger = makeSpyLogger()
    const store = createConfigStore({ filePath: configPath, encryptor: makeFakeEncryptor(false), logger })

    store.applyPatch({
      extensionServiceWsUrl: 'ws://service.test:3002/agent',
      extensionServiceWsToken: 'a-plaintext-extension-token',
      dslrBoothPassword: 'a-plaintext-dslrbooth-password',
    })

    const doc = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    expect(doc.secrets.extensionServiceWsToken.wrapped).toBe(false)
    expect(doc.secrets.dslrBoothPassword.wrapped).toBe(false)
    // One save wraps two secrets — one warning is the whole truth, not two.
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(String(logger.warn.mock.calls[0][0])).toMatch(/key store unavailable/i)
  })

  it('a file recorded unwrapped, loaded where wrapping becomes available, is rewritten wrapped on the next save with the flag flipped', () => {
    const configPath = makeConfigPath()
    const store1 = createConfigStore({ filePath: configPath, encryptor: makeFakeEncryptor(false), logger: makeLogger() })
    store1.applyPatch({
      extensionServiceWsUrl: 'ws://service.test:3002/agent',
      extensionServiceWsToken: 'a-plaintext-extension-token',
      dslrBoothPassword: 'a-plaintext-dslrbooth-password',
    })
    const before = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    expect(before.secrets.extensionServiceWsToken.wrapped).toBe(false)

    const store2 = createConfigStore({ filePath: configPath, encryptor: makeFakeEncryptor(true), logger: makeLogger() })
    // An empty patch: nothing changes except that every save re-derives
    // `wrapped` from `encryptor.isAvailable()` at that moment — there is no
    // separate "upgrade" code path (configStore.ts's own header comment).
    const result = store2.applyPatch({})
    expect(result.ok).toBe(true)

    const raw = fs.readFileSync(configPath, 'utf8')
    const after = JSON.parse(raw)
    expect(after.secrets.extensionServiceWsToken.wrapped).toBe(true)
    expect(after.secrets.dslrBoothPassword.wrapped).toBe(true)
    expect(raw).not.toContain('a-plaintext-extension-token')
    expect(raw).not.toContain('a-plaintext-dslrbooth-password')
  })

  it('a file whose wrapped secret cannot be decrypted loads with that secret absent and its presence flag false, without crashing', () => {
    const configPath = makeConfigPath()
    const workingEncryptor = makeFakeEncryptor(true)
    const store = createConfigStore({ filePath: configPath, encryptor: workingEncryptor, logger: makeLogger() })
    store.applyPatch({
      extensionServiceWsUrl: 'ws://service.test:3002/agent',
      extensionServiceWsToken: 'a-plaintext-extension-token',
      dslrBoothPassword: 'a-plaintext-dslrbooth-password',
    })
    const doc = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    const corruptedTokenCiphertext = doc.secrets.extensionServiceWsToken.value

    // Only the token's stored ciphertext fails to unwrap — a restored profile
    // or a different Windows account, per safeStorage's account-bound
    // semantics — so the password (unaffected) proves this is per-field, not
    // a whole-file failure.
    const selectivelyBrokenEncryptor: SecretEncryptor = {
      isAvailable: () => true,
      encrypt: workingEncryptor.encrypt,
      decrypt: (ciphertext) => {
        if (ciphertext === corruptedTokenCiphertext) throw new Error('cannot decrypt: different account')
        return workingEncryptor.decrypt(ciphertext)
      },
    }
    const reloaded = createConfigStore({ filePath: configPath, encryptor: selectivelyBrokenEncryptor, logger: makeLogger() })

    const snapshot = reloaded.getSnapshot()
    expect(snapshot.hasExtensionServiceWsToken).toBe(false)
    expect(snapshot.hasDslrBoothPassword).toBe(true)
  })
})

describe('the live half — CMS-safe fields take effect on the running relay, bootstrap fields need a restart (D10-02)', () => {
  it('patching dslrBoothApiPort while running takes effect on the very next dslrBooth request', async () => {
    const configPath = makeConfigPath()
    const boothStubOld = await startBoothStub()
    const boothStubNew = await startBoothStub()
    const service = await startServiceStub()
    const triggerPort = await getEphemeralPort()
    const { handlers, store } = buildHandlers(configPath, makeFakeEncryptor())
    store.applyPatch({
      extensionServiceWsUrl: service.url,
      extensionServiceWsToken: 'test-token',
      dslrBoothApiPort: boothStubOld.port,
      dslrBoothPassword: 'test-password',
      triggerServerPort: triggerPort,
    })

    await handlers['agent:start']()
    await service.waitForConnection()

    const setResult = await handlers['config:set']({ dslrBoothApiPort: boothStubNew.port })
    expect(setResult).toEqual({ ok: true, restartRequired: false })

    service.send({ type: 'command', action: 'start_session', jobId: 'job-live-port', mode: 'print' })
    const ack = await service.waitForMessage((m: any) => m.type === 'ack')
    expect(ack.ok).toBe(true)

    expect(boothStubOld.urls).toHaveLength(0)
    expect(boothStubNew.urls).toHaveLength(1)
  })

  it('patching logLevel while running changes every transport level immediately', async () => {
    const configPath = makeConfigPath()
    const boothStub = await startBoothStub()
    const service = await startServiceStub()
    const triggerPort = await getEphemeralPort()
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-agent-logs-'))
    const logger = createLogger({
      extensionServiceWsUrl: service.url,
      extensionServiceWsToken: 'test-token',
      dslrBoothApiPort: boothStub.port,
      dslrBoothPassword: 'test-password',
      triggerServerPort: triggerPort,
      logLevel: 'info',
      logDir,
      autoOpenDisplay: true,
    })
    closers.push(async () => { logger.close() })
    const { handlers, store } = buildHandlers(configPath, makeFakeEncryptor(), logger)
    store.applyPatch({
      extensionServiceWsUrl: service.url,
      extensionServiceWsToken: 'test-token',
      dslrBoothApiPort: boothStub.port,
      dslrBoothPassword: 'test-password',
      triggerServerPort: triggerPort,
    })

    await handlers['agent:start']()
    await service.waitForConnection()
    expect(logger.transports.length).toBeGreaterThan(1)
    expect(logger.transports.every((t) => t.level === 'info')).toBe(true)

    const setResult = await handlers['config:set']({ logLevel: 'debug' })

    expect(setResult).toEqual({ ok: true, restartRequired: false })
    expect(logger.level).toBe('debug')
    expect(logger.transports.every((t) => t.level === 'debug')).toBe(true)
  })

  it('patching autoOpenDisplay while running is read live through the LiveConfig holder', async () => {
    const configPath = makeConfigPath()
    const boothStub = await startBoothStub()
    const service = await startServiceStub()
    const triggerPort = await getEphemeralPort()
    const { handlers, store, getAgent } = buildHandlers(configPath, makeFakeEncryptor())
    store.applyPatch({
      extensionServiceWsUrl: service.url,
      extensionServiceWsToken: 'test-token',
      dslrBoothApiPort: boothStub.port,
      dslrBoothPassword: 'test-password',
      triggerServerPort: triggerPort,
    })

    await handlers['agent:start']()
    await service.waitForConnection()
    expect(getAgent()!.live.autoOpenDisplay).toBe(true)

    const setResult = await handlers['config:set']({ autoOpenDisplay: false })

    expect(setResult).toEqual({ ok: true, restartRequired: false })
    expect(getAgent()!.live.autoOpenDisplay).toBe(false)
  })

  it('patching a bootstrap field while running reports restart-required and leaves the live holder unchanged', async () => {
    const configPath = makeConfigPath()
    const boothStub = await startBoothStub()
    const service = await startServiceStub()
    const triggerPort = await getEphemeralPort()
    const { handlers, store, getAgent } = buildHandlers(configPath, makeFakeEncryptor())
    store.applyPatch({
      extensionServiceWsUrl: service.url,
      extensionServiceWsToken: 'test-token',
      dslrBoothApiPort: boothStub.port,
      dslrBoothPassword: 'test-password',
      triggerServerPort: triggerPort,
    })

    await handlers['agent:start']()
    await service.waitForConnection()
    const before = getAgent()!.live.snapshot()

    const result = await handlers['config:set']({ logDir: 'a-different-log-dir' })

    expect(result).toEqual({ ok: true, restartRequired: true })
    expect(getAgent()!.live.snapshot()).toEqual(before)
    expect(store.getSnapshot().logDir).toBe('a-different-log-dir')
  })

  it('a patch mixing safe and bootstrap fields applies the safe half live, persists both halves, and reports restart-required', async () => {
    const configPath = makeConfigPath()
    const boothStubOld = await startBoothStub()
    const boothStubNew = await startBoothStub()
    const service = await startServiceStub()
    const triggerPort = await getEphemeralPort()
    const { handlers, store, getAgent } = buildHandlers(configPath, makeFakeEncryptor())
    store.applyPatch({
      extensionServiceWsUrl: service.url,
      extensionServiceWsToken: 'test-token',
      dslrBoothApiPort: boothStubOld.port,
      dslrBoothPassword: 'test-password',
      triggerServerPort: triggerPort,
    })

    await handlers['agent:start']()
    await service.waitForConnection()

    const result = await handlers['config:set']({
      dslrBoothApiPort: boothStubNew.port,
      logDir: 'mixed-log-dir',
    })

    expect(result).toEqual({ ok: true, restartRequired: true })
    expect(getAgent()!.live.dslrBoothApiPort).toBe(boothStubNew.port)
    expect(store.getSnapshot().logDir).toBe('mixed-log-dir')
    expect(store.getSnapshot().dslrBoothApiPort).toBe(boothStubNew.port)
  })

  it('editing while stopped persists the change and reports no restart requirement', async () => {
    const configPath = makeConfigPath()
    const { handlers, store } = buildHandlers(configPath, makeFakeEncryptor())
    store.applyPatch({
      extensionServiceWsUrl: 'ws://service.test:3002/agent',
      extensionServiceWsToken: 'test-token',
      dslrBoothPassword: 'test-password',
    })

    const result = await handlers['config:set']({ triggerServerPort: 4001 })

    expect(result).toEqual({ ok: true, restartRequired: false })
    expect(store.getSnapshot().triggerServerPort).toBe(4001)
  })
})

describe('the safe-field allow-list is imported, not copied (D10-03, T-10-15)', () => {
  it("the local path consults SAFE_AGENT_CONFIG_FIELDS itself — mutating the exported array changes what the local path accepts as safe", async () => {
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

    // `logDir` is a bootstrap field today — a patch to it alone, while
    // running, reports restart-required (proven above). If the local path
    // consulted a COPY of the allow-list, this mutation would change
    // nothing observable here. Because it imports the array itself, the
    // mutation flips the very next decision.
    const mutable = SAFE_AGENT_CONFIG_FIELDS as unknown as string[]
    mutable.push('logDir')
    try {
      const result = await handlers['config:set']({ logDir: 'mutated-safe-field' })
      expect(result).toEqual({ ok: true, restartRequired: false })
    } finally {
      mutable.pop()
    }
  })

  it('both exported allow-lists still hold exactly their pre-phase members, in order', () => {
    expect([...SAFE_AGENT_CONFIG_FIELDS]).toEqual([
      'logLevel',
      'autoOpenDisplay',
      'dslrBoothApiPort',
      'dslrBoothPassword',
    ])
    expect([...READ_ONLY_AGENT_CONFIG_FIELDS]).toEqual([
      'extensionServiceWsUrl',
      'extensionServiceWsToken',
      'triggerServerPort',
      'logDir',
    ])
  })
})

describe('nothing on the local path writes to the process environment', () => {
  it('a config:set call, running or stopped, never touches process.env', async () => {
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

    const before = { ...process.env }
    await handlers['config:set']({ logLevel: 'debug', logDir: 'env-test-dir' })

    expect({ ...process.env }).toEqual(before)
  })
})
