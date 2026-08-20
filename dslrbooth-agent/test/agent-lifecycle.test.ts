import { afterEach, describe, expect, it, vi } from 'vitest'
import http from 'http'
import net from 'net'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Config } from '../src/config'
import type { Logger } from '../src/logging/logger'
import { createAgent } from '../src/agent'

// ---------------------------------------------------------------------------
// Plan 10-01 — the factory, end to end.
//
// This is the central case the whole phase depends on: nothing is bound
// until start() is called. Everything below is exercised against a REAL
// WebSocketServer (the `ws` package, same as production) and a REAL dslrBooth
// stub (the `startBoothStub()` shape from test/config-reload.test.ts), not
// mocks — because the property under test (does binding actually move from
// construction time to start() time) can only be pinned by asking the OS.
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
  messages(): unknown[]
  send(msg: unknown): void
  waitForConnection(timeoutMs?: number): Promise<void>
  waitForMessage(predicate: (msg: any) => boolean, timeoutMs?: number): Promise<any>
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
    messages: () => received,
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

interface Harness {
  agent: ReturnType<typeof createAgent>
  config: Config
  boothStub: { port: number; urls: string[] }
  service: ServiceStub
  triggerPort: number
}

async function setup(overrides: Partial<Config> = {}): Promise<Harness> {
  const boothStub = await startBoothStub()
  const service = await startServiceStub()
  const triggerPort = await getEphemeralPort()
  const config: Config = {
    extensionServiceWsUrl: service.url,
    extensionServiceWsToken: 'test-token',
    dslrBoothApiPort: boothStub.port,
    dslrBoothPassword: 'test-password',
    triggerServerPort: triggerPort,
    logLevel: 'info',
    logDir: 'logs',
    autoOpenDisplay: true,
    ...overrides,
  }
  const agent = createAgent(config, makeLogger())
  closers.push(() => agent.stop())
  return { agent, config, boothStub, service, triggerPort }
}

describe('createAgent() — nothing bound until start() (D10-01, 10-RESEARCH Pitfall 4)', () => {
  it('refuses a connection on the trigger port and dials no socket before start(), then succeeds at both after start()', async () => {
    const { agent, service, triggerPort } = await setup()

    await expect(fetch(`http://127.0.0.1:${triggerPort}/health`)).rejects.toThrow()
    expect(service.connectionCount()).toBe(0)

    await agent.start()
    expect(agent.isRunning()).toBe(true)

    const res = await fetch(`http://127.0.0.1:${triggerPort}/health`)
    expect(res.status).toBe(200)

    await service.waitForConnection()
    expect(service.connectionCount()).toBe(1)
  })

  it('drives a trigger request through a started Agent and forwards exactly one event frame', async () => {
    const { agent, service, triggerPort } = await setup()
    await agent.start()
    await service.waitForConnection()

    await fetch(`http://127.0.0.1:${triggerPort}/dslrbooth-event?event_type=capture_started&photo_url=http%3A%2F%2Fexample.test%2Fphoto.jpg`)

    const event = await service.waitForMessage((m) => m.type === 'event')
    expect(event.event).toBe('capture_started')
    expect(event.payload.photoUrl).toBe('http://example.test/photo.jpg')
    expect(service.messages().filter((m: any) => m.type === 'event')).toHaveLength(1)
  })

  it('a start_session command reaches the dslrBooth stub and produces one ack with the same jobId', async () => {
    const { agent, service, boothStub } = await setup()
    await agent.start()
    await service.waitForConnection()

    service.send({ type: 'command', action: 'start_session', jobId: 'job-1', mode: 'print' })

    const ack = await service.waitForMessage((m) => m.type === 'ack')
    expect(ack.ok).toBe(true)
    expect(ack.jobId).toBe('job-1')
    expect(boothStub.urls).toHaveLength(1)
    expect(boothStub.urls[0]).toContain('/api/start')
    expect(boothStub.urls[0]).toContain('mode=print')
  })

  it('an unknown command action produces one ack with ok:false naming it, and nothing reaches dslrBooth', async () => {
    const { agent, service, boothStub } = await setup()
    await agent.start()
    await service.waitForConnection()

    service.send({ type: 'command', action: 'nonsense', jobId: 'job-2' })

    const ack = await service.waitForMessage((m) => m.type === 'ack')
    expect(ack.ok).toBe(false)
    expect(ack.errorMessage).toContain('nonsense')
    expect(boothStub.urls).toHaveLength(0)
  })

  it('forwards an event carrying the jobId of the most recent successful start_session', async () => {
    const { agent, service, triggerPort } = await setup()
    await agent.start()
    await service.waitForConnection()

    service.send({ type: 'command', action: 'start_session', jobId: 'job-3', mode: 'print' })
    await service.waitForMessage((m) => m.type === 'ack')

    await fetch(`http://127.0.0.1:${triggerPort}/dslrbooth-event?event_type=capture_finished`)

    const event = await service.waitForMessage((m) => m.type === 'event')
    expect(event.jobId).toBe('job-3')
  })

  it('a session_end trigger resets the display state to idle with no guest name and no end time', async () => {
    const { agent, service, triggerPort } = await setup()
    await agent.start()
    await service.waitForConnection()

    // Put the display into a non-idle state first via an announcement, so the
    // reset is observable rather than a no-op against the initial idle state.
    service.send({ type: 'announcement', data: { guestName: 'Lan', endsAt: 999, queueLength: 1 } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const busy = await (await fetch(`http://127.0.0.1:${triggerPort}/display-state`)).json()
    expect(busy.phase).toBe('announcing')

    await fetch(`http://127.0.0.1:${triggerPort}/dslrbooth-event?event_type=session_end`)

    const idle = await (await fetch(`http://127.0.0.1:${triggerPort}/display-state`)).json()
    expect(idle.phase).toBe('idle')
    expect(idle.guestName).toBeNull()
    expect(idle.endsAt).toBeNull()
  })

  it('stop() releases the trigger port so a fresh listener can bind it immediately, and isRunning() is false', async () => {
    const { agent, triggerPort } = await setup()
    await agent.start()

    await agent.stop()
    expect(agent.isRunning()).toBe(false)

    const fresh = net.createServer()
    await new Promise<void>((resolve, reject) => {
      fresh.once('error', reject)
      fresh.listen(triggerPort, '0.0.0.0', () => resolve())
    })
    await new Promise<void>((resolve) => fresh.close(() => resolve()))
  })

  it('start() called twice in a row is a no-op the second time: exactly one connection reaches the stub', async () => {
    const { agent, service } = await setup()

    await agent.start()
    await service.waitForConnection()
    await agent.start()
    // Give any accidental second connect attempt time to arrive.
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(service.connectionCount()).toBe(1)
  })

  it('stop() before any start(), and stop() called twice in a row, both resolve without throwing', async () => {
    const { agent } = await setup()

    await expect(agent.stop()).resolves.toBeUndefined()

    await agent.start()
    await expect(agent.stop()).resolves.toBeUndefined()
    await expect(agent.stop()).resolves.toBeUndefined()
  })

  it('start() against an occupied trigger port does not throw: isRunning() is false and the failure is recorded', async () => {
    const boothStub = await startBoothStub()
    const service = await startServiceStub()
    const triggerPort = await getEphemeralPort()

    const occupied = net.createServer()
    await new Promise<void>((resolve) => occupied.listen(triggerPort, '0.0.0.0', () => resolve()))
    closers.push(() => new Promise<void>((resolve) => occupied.close(() => resolve())))

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

    await expect(agent.start()).resolves.toBeUndefined()

    expect(agent.isRunning()).toBe(false)
    expect(agent.getLastError()).toBeTruthy()
    expect(service.connectionCount()).toBe(0)
  })
})
