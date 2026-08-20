import { beforeEach, describe, expect, it, vi } from 'vitest'

// `connection.ts` uses a static `import WebSocket from 'ws'` (line 1), so
// vitest's static-import interception applies directly here — unlike
// `mirror-request/src/ingestion/dbPoller.ts`'s runtime `require()`, which
// needs the `createRequire` + `vi.spyOn` workaround documented at the top of
// `mirror-request/test/db-poller.test.ts`. Confirmed working: the mocked
// constructor below records every call via `.mock.calls`.
vi.mock('ws', () => {
  const ctor = vi.fn(() => ({
    readyState: 0,
    on: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
    removeAllListeners: vi.fn(),
  }))
  Object.assign(ctor, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })
  return { default: ctor, WebSocket: ctor }
})

import WebSocket from 'ws'
import { WsConnection } from '../src/websocket/connection'
import type { Logger } from '../src/logging/logger'

const stubLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger

const MockedWebSocket = WebSocket as unknown as ReturnType<typeof vi.fn>

const baseConfig = {
  url: 'ws://example.test:4000/agent',
  reconnectBaseDelayMs: 2000,
  reconnectMaxDelayMs: 30000,
  heartbeatIntervalMs: 15000,
}

describe('WsConnection auth header (D-09)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sends the Authorization header with the Bearer prefix when a token is configured', () => {
    const conn = new WsConnection({ ...baseConfig, token: 'my-secret-token' }, stubLogger)
    conn.connect()

    expect(MockedWebSocket.mock.calls).toHaveLength(1)
    const [, options] = MockedWebSocket.mock.calls[0]
    expect(options.headers).toEqual({ authorization: 'Bearer my-secret-token' })
  })

  it('passes the configured URL unchanged, with nothing appended', () => {
    const conn = new WsConnection({ ...baseConfig, token: 'my-secret-token' }, stubLogger)
    conn.connect()

    const [url] = MockedWebSocket.mock.calls[0]
    expect(url).toBe(baseConfig.url)
  })

  it('omits headers entirely when no token is configured, and still passes the URL unchanged', () => {
    const conn = new WsConnection({ ...baseConfig }, stubLogger)
    conn.connect()

    const [url, options] = MockedWebSocket.mock.calls[0]
    expect(url).toBe(baseConfig.url)
    expect(options.headers).toBeUndefined()
  })

  it('preserves handshakeTimeout and perMessageDeflate on the options object', () => {
    const conn = new WsConnection({ ...baseConfig, token: 'my-secret-token' }, stubLogger)
    conn.connect()

    const [, options] = MockedWebSocket.mock.calls[0]
    expect(options.handshakeTimeout).toBe(10000)
    expect(options.perMessageDeflate).toBe(false)
  })
})
