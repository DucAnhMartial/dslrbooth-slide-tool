import { afterEach, describe, expect, it, vi } from 'vitest'
import http from 'http'
import net from 'net'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Config } from '../src/config'
import type { Logger } from '../src/logging/logger'
import { createAgent, type AgentOptions, type AgentStatus } from '../src/agent'
import { probeTcp } from '../src/health/reachability'

// ---------------------------------------------------------------------------
// Plan 10-01, Task 3 — a status the window can draw.
//
// Same harness shapes as test/agent-lifecycle.test.ts: a real dslrBooth stub
// and a real WebSocketServer, because the properties under test (does the
// snapshot actually flip on a real socket event, does the probe actually
// open and close a real TCP connection without an HTTP request) can only be
// pinned by asking the OS, not a mock.
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

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
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

/** Picks a free TCP port by binding a throwaway listener and releasing it. */
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
  kickActiveConnection(): void
}

/** A stand-in for the Extension Service's WebSocket endpoint — a REAL WebSocketServer. */
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
  const connectionWaiters: Array<() => void> = []

  wss.on('connection', (socket: WebSocket) => {
    connections += 1
    activeSocket = socket
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
    kickActiveConnection: () => { activeSocket?.close(1001, 'test-kick') },
  }
}

interface Harness {
  agent: ReturnType<typeof createAgent>
  config: Config
  boothStub: { port: number; urls: string[] }
  service: ServiceStub
  triggerPort: number
}

async function setup(configOverrides: Partial<Config> = {}, options: AgentOptions = {}): Promise<Harness> {
  const boothStub = await startBoothStub()
  const service = await startServiceStub()
  const triggerPort = await getEphemeralPort()
  const config: Config = {
    extensionServiceWsUrl: service.url,
    extensionServiceWsToken: 'boot-token',
    dslrBoothApiPort: boothStub.port,
    dslrBoothPassword: 'boot-password',
    triggerServerPort: triggerPort,
    logLevel: 'info',
    logDir: 'logs',
    autoOpenDisplay: true,
    ...configOverrides,
  }
  const agent = createAgent(config, makeLogger(), options)
  closers.push(() => agent.stop())
  return { agent, config, boothStub, service, triggerPort }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000, intervalMs = 10): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

describe('getStatus() — the snapshot a window can draw (Task 3, SC-3 groundwork)', () => {
  it('reports not running, disconnected, a null port and unknown reachability before start()', async () => {
    const { agent } = await setup()

    const status = agent.getStatus()

    expect(status.running).toBe(false)
    expect(status.socketState).toBe('disconnected')
    expect(status.triggerPort).toBeNull()
    expect(status.dslrBoothReachable).toBe('unknown')
  })

  it('reports running, connected and the bound trigger port once started', async () => {
    const { agent, service, triggerPort } = await setup()

    await agent.start()
    await service.waitForConnection()
    await waitFor(() => agent.getStatus().socketState === 'connected')

    const status = agent.getStatus()
    expect(status.running).toBe(true)
    expect(status.socketState).toBe('connected')
    expect(status.triggerPort).toBe(triggerPort)
    expect(status.startedAt).toEqual(expect.any(Number))
    expect(status.lastError).toBeNull()
  })

  it('records the timestamp of the last forwarded trigger event', async () => {
    const { agent, service, triggerPort } = await setup()
    await agent.start()
    await service.waitForConnection()

    expect(agent.getStatus().lastEventAt).toBeNull()

    await fetch(`http://127.0.0.1:${triggerPort}/dslrbooth-event?event_type=capture_started`)

    expect(agent.getStatus().lastEventAt).toEqual(expect.any(Number))
  })
})

describe('onStatus() — subscribers see every status change', () => {
  it('is called on connect and on disconnect, and the returned unsubscribe stops further calls', async () => {
    const { agent, service } = await setup()
    const seen: AgentStatus[] = []
    const unsubscribe = agent.onStatus((status) => { seen.push(status) })

    await agent.start()
    await service.waitForConnection()
    await waitFor(() => seen.some((s) => s.socketState === 'connected'))

    service.kickActiveConnection()
    await waitFor(() => seen.some((s) => s.socketState === 'disconnected'))

    const countAfterDisconnect = seen.length
    unsubscribe()
    await agent.stop()

    expect(seen.length).toBe(countAfterDisconnect)
  })

  it('a throwing subscriber does not stop other subscribers from being called', async () => {
    const { agent, service } = await setup()
    const seen: AgentStatus[] = []
    agent.onStatus(() => { throw new Error('a subscriber that misbehaves') })
    agent.onStatus((status) => { seen.push(status) })

    await agent.start()
    await service.waitForConnection()
    await waitFor(() => seen.length > 0)

    expect(seen.length).toBeGreaterThan(0)
  })
})

describe('probeTcp() — the loopback reachability probe (src/health/reachability.ts)', () => {
  it('resolves true for a port with a listener and false for a closed port, within its own timeout', async () => {
    const listener = net.createServer()
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('missing listener address')
    closers.push(() => new Promise<void>((resolve) => listener.close(() => resolve())))

    await expect(probeTcp(address.port, 500)).resolves.toBe(true)

    const closedPort = await getEphemeralPort()
    await expect(probeTcp(closedPort, 500)).resolves.toBe(false)
  })
})

describe('The reachability probe stays inside the dumb-relay rule', () => {
  it('reports reachable against the real dslrBooth stub with zero HTTP requests reaching it', async () => {
    const { agent, boothStub } = await setup({}, { reachabilityIntervalMs: 50 })

    await agent.start()
    await waitFor(() => agent.getStatus().dslrBoothReachable === 'reachable')

    expect(boothStub.urls).toHaveLength(0)
  })

  it('reads the port from the LIVE config holder at each probe tick, not a captured boot value', async () => {
    const seenPorts: number[] = []
    const { agent } = await setup({}, {
      reachabilityIntervalMs: 20,
      reachabilityProbe: async (port) => { seenPorts.push(port); return true },
    })

    await agent.start()
    await waitFor(() => seenPorts.length > 0)
    const bootPort = seenPorts[0]
    const changedPort = bootPort + 1

    agent.live.apply({ dslrBoothApiPort: changedPort })
    await waitFor(() => seenPorts.includes(changedPort))

    expect(seenPorts).toContain(changedPort)
  })

  it('the probe runs only while running and leaves no timer behind after stop() (vi.getTimerCount())', async () => {
    const { agent, service } = await setup({}, {
      reachabilityIntervalMs: 20,
      reachabilityProbe: async () => true,
    })

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const before = vi.getTimerCount()

      await agent.start()
      await service.waitForConnection()
      expect(vi.getTimerCount()).toBeGreaterThan(before)

      await agent.stop()
      expect(vi.getTimerCount()).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Credentials never ride along in the status snapshot (T-10-04)', () => {
  it('JSON.stringify(getStatus()) contains neither the boot WS token nor the boot dslrBooth password', async () => {
    const { agent, service } = await setup()
    await agent.start()
    await service.waitForConnection()

    const serialized = JSON.stringify(agent.getStatus())

    expect(serialized).not.toContain('boot-token')
    expect(serialized).not.toContain('boot-password')
  })
})

describe('lastError — set on a failed start(), cleared on the next successful one', () => {
  it('records a start failure and clears it once the port frees up and start() succeeds', async () => {
    const boothStub = await startBoothStub()
    const service = await startServiceStub()
    const triggerPort = await getEphemeralPort()

    const occupied = net.createServer()
    await new Promise<void>((resolve) => occupied.listen(triggerPort, '0.0.0.0', () => resolve()))

    const config: Config = {
      extensionServiceWsUrl: service.url,
      extensionServiceWsToken: 'test-token',
      dslrBoothApiPort: boothStub.port,
      dslrBoothPassword: 'test-password',
      triggerServerPort: triggerPort,
      logLevel: 'info',
      logDir: 'logs',
      autoOpenDisplay: true,
    }
    const agent = createAgent(config, makeLogger())
    closers.push(() => agent.stop())

    await agent.start()
    expect(agent.getStatus().lastError).toBeTruthy()
    expect(agent.getStatus().running).toBe(false)

    await new Promise<void>((resolve) => occupied.close(() => resolve()))

    await agent.start()
    expect(agent.isRunning()).toBe(true)
    expect(agent.getStatus().lastError).toBeNull()
  })
})
