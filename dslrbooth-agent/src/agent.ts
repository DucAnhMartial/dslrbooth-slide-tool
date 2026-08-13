import { DslrBoothClient } from './dslrbooth/client'
import { WsConnection } from './websocket/connection'
import { createTriggerServer } from './triggers/server'
import { closeDisplayWindow, openDisplayWindow } from './display/launcher'
import { LiveConfig } from './liveConfig'
import { createServiceMessageHandler, requestConfig } from './agentMessages'
import { createCommandHandler, type CommandMessage } from './commands'
import type { Config } from './config'
import type { Logger } from './logging/logger'

/**
 * The relay's explicit lifecycle (plan 10-01, D10-01, 10-RESEARCH Pattern 1).
 *
 * `createAgent()` builds every collaborator but binds nothing and dials
 * nothing: the trigger port and the WebSocket connection only come into
 * existence inside `start()`. This is the whole reason a desktop shell can
 * host this core safely — a naive port of `index.ts`'s wiring order into a
 * factory would bind `:3001` the instant the shell booted, before an
 * operator had configured or clicked anything (10-RESEARCH Pitfall 4).
 *
 * `start()`/`stop()` are idempotent and safe to call in any order, including
 * before the other has ever run, because plan 10-02's IPC layer and a
 * confused operator clicking a button twice are both real callers.
 */
export interface AgentHandle {
  readonly live: LiveConfig
  start(): Promise<void>
  stop(): Promise<void>
  isRunning(): boolean
  /** The most recent `start()` failure, or null once a start has succeeded. */
  getLastError(): string | null
}

export function createAgent(config: Config, logger: Logger): AgentHandle {
  const dslrBooth = new DslrBoothClient(config.dslrBoothApiPort, config.dslrBoothPassword)

  // The four remotely-tunable values (UI-02, D-16), seeded from boot config so
  // an Agent that never hears from the CMS behaves exactly as it did before
  // this phase. Updated in memory only (D-17).
  const live = new LiveConfig(config, logger, {
    onCredentialsChange: (port, password) => dslrBooth.updateCredentials(port, password),
  })

  const ws = new WsConnection(
    {
      url: config.extensionServiceWsUrl,
      token: config.extensionServiceWsToken,
      reconnectBaseDelayMs: 2000,
      reconnectMaxDelayMs: 30000,
      heartbeatIntervalMs: 15000,
    },
    logger,
  )

  // Held as a mutable reference, null while stopped. Display patches and the
  // event-forwarding callback read THROUGH this variable rather than closing
  // over a captured value, so a patch arriving while stopped is dropped
  // instead of thrown, and a patch arriving after a restart reaches the NEW
  // server rather than a stale reference to the old one.
  let triggerServer: ReturnType<typeof createTriggerServer> | null = null
  let activeJobId: string | undefined
  let running = false
  let lastError: string | null = null
  let starting: Promise<void> | null = null

  // `config`, `reload_config` and `announcement` — everything that does not
  // touch the dslrBooth Local API. See src/agentMessages.ts.
  const handleServiceMessage = createServiceMessageHandler({
    live,
    logger,
    send: (payload) => { ws.send(payload) },
    updateDisplay: (patch) => { triggerServer?.updateDisplay(patch) },
    openDisplay: () => openDisplayWindow(config.triggerServerPort, logger),
  })

  // The `command` branch — the dslrBooth Local API call site (AGT-02, AGT-03).
  // See src/commands.ts.
  const handleCommand = createCommandHandler({
    dslrBooth,
    logger,
    send: (payload) => { ws.send(payload) },
    updateDisplay: (patch) => { triggerServer?.updateDisplay(patch) },
    closeDisplay: () => closeDisplayWindow(logger),
    setActiveJobId: (jobId) => { activeJobId = jobId },
  })

  // Registered once, at construction time. Registering a callback opens
  // nothing — the config-request round trip on connect must survive every
  // later restart, so it cannot be re-registered inside start().
  ws.onStatusChange((status) => {
    logger.info(`WebSocket status: ${status}`)
    if (status === 'connected') requestConfig((payload) => { ws.send(payload) })
  })

  ws.onMessage(async (msg) => {
    if (handleServiceMessage(msg)) return
    await handleCommand(msg as CommandMessage)
  })

  async function performStart(): Promise<void> {
    let startFailure: string | null = null

    const server = createTriggerServer(
      {
        port: config.triggerServerPort,
        onEvent: (eventType, params) => {
          if (eventType === 'session_end') {
            triggerServer?.updateDisplay({ phase: 'idle', guestName: null, endsAt: null })
          }
          const photoUrl = params.photoUrl ?? params.photo_url ?? params.url
          ws.send({
            type: 'event',
            event: eventType,
            jobId: activeJobId,
            payload: { ...params, ...(photoUrl ? { photoUrl } : {}) },
            timestamp: Date.now(),
          })
        },
        onError: (err) => { startFailure = err.message },
      },
      logger,
    )
    triggerServer = server

    // Node emits EADDRINUSE asynchronously but within the same tick sequence
    // as the listen() call (well before any real I/O could occur) — a single
    // full turn of the event loop is enough for a bind failure to have
    // reached `onError` above. See 10-RESEARCH Pitfall 4 / key_links.
    await new Promise<void>((resolve) => { setImmediate(resolve) })

    if (startFailure) {
      lastError = startFailure
      await server.close()
      triggerServer = null
      running = false
      return
    }

    // Trigger server first, so a bind failure is known before a socket is
    // opened (T-10-02).
    lastError = null
    running = true
    ws.connect()
  }

  return {
    live,
    isRunning: () => running,
    getLastError: () => lastError,
    start(): Promise<void> {
      if (running) return Promise.resolve()
      if (starting) return starting
      starting = performStart().finally(() => { starting = null })
      return starting
    },
    async stop(): Promise<void> {
      if (starting) await starting
      if (!running && !triggerServer) return
      running = false
      ws.disconnect()
      await closeDisplayWindow(logger)
      if (triggerServer) {
        await triggerServer.close()
        triggerServer = null
      }
    },
  }
}
