// Entry point: wires together all components
import dotenv from 'dotenv'
dotenv.config()

import { loadConfig } from './config'
import { createLogger, Logger } from './logging/logger'
import { DslrBoothClient } from './dslrbooth/client'
import { WsConnection } from './websocket/connection'
import { createTriggerServer } from './triggers/server'
import { closeDisplayWindow, openDisplayWindow } from './display/launcher'
import { LiveConfig } from './liveConfig'
import { createServiceMessageHandler, requestConfig } from './agentMessages'

async function main() {
  // 1. Load config
  let config
  try {
    config = loadConfig()
  } catch (err) {
    console.error(`Config error: ${(err as Error).message}`)
    process.exit(1)
  }

  // 2. Logger
  const logger = createLogger(config)
  logger.info('=== dslrBooth Agent starting ===')
  logger.info(`Config: WS=${config.extensionServiceWsUrl}, API port=${config.dslrBoothApiPort}, Trigger port=${config.triggerServerPort}`)

  // 3. dslrBooth client
  const dslrBooth = new DslrBoothClient(config.dslrBoothApiPort, config.dslrBoothPassword)

  // 3b. The four remotely-tunable values (UI-02, D-16). Seeded from `.env` so
  // an Agent that never hears from the CMS behaves exactly as it did before
  // this phase, and updated in memory only — this process never rewrites its
  // own `.env` and never restarts itself (D-17).
  const live = new LiveConfig(config, logger, {
    onCredentialsChange: (port, password) => dslrBooth.updateCredentials(port, password),
  })

  // 4. WebSocket connection
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

  let wsConnected = false
  let triggerServer: ReturnType<typeof createTriggerServer> | null = null
  let activeJobId: string | undefined

  // `config`, `reload_config` and `announcement` — everything that does not
  // touch the dslrBooth Local API. See src/agentMessages.ts for why these live
  // in their own module and the command branch below does not.
  const handleServiceMessage = createServiceMessageHandler({
    live,
    logger,
    send: (payload) => { ws.send(payload) },
    updateDisplay: (patch) => { triggerServer?.updateDisplay(patch) },
    openDisplay: () => openDisplayWindow(config.triggerServerPort, logger),
  })

  ws.onStatusChange((status) => {
    wsConnected = status === 'connected'
    logger.info(`WebSocket status: ${status}`)
    // D-17: the Agent PULLS. It asks for its configuration as soon as it has a
    // live socket to be answered on, and again whenever the service tells it
    // something changed. A service built before this phase answers with a
    // warning and nothing else, which leaves the boot values in place.
    if (status === 'connected') requestConfig((payload) => { ws.send(payload) })
  })

  // 5. Message handler: Extension Service → Agent (commands)
  ws.onMessage(async (msg) => {
    if (handleServiceMessage(msg)) return
    if (msg.type !== 'command') return

    const jobId = msg.jobId as string | undefined
    const action = msg.action as string | undefined
    const mode = (msg.mode as string | undefined) || 'print'

    if (action !== 'start_session') {
      logger.warn(`Unknown command action: ${action}`)
      ws.send({ type: 'ack', jobId, ok: false, errorMessage: `Unknown action: ${action}` })
      return
    }

    logger.info(`Command received: start_session (mode=${mode}, jobId=${jobId || 'unknown'})`)

    await closeDisplayWindow(logger)
    const result = await dslrBooth.startSession(mode)

    if (result.isSuccessful) {
      activeJobId = jobId
      triggerServer?.updateDisplay({ phase: 'busy', endsAt: null })
      logger.info(`dslrBooth API success: ${result.rawResponse}`)
      ws.send({ type: 'ack', jobId, ok: true, errorMessage: '' })
    } else {
      logger.error(`dslrBooth API failed: ${result.errorMessage}`)
      ws.send({ type: 'ack', jobId, ok: false, errorMessage: result.errorMessage })
    }
  })

  // 6. Trigger server: dslrBooth → Agent (local HTTP)
  triggerServer = createTriggerServer(
    {
      port: config.triggerServerPort,
      onEvent: (eventType, params) => {
        if (eventType === 'session_end') {
          triggerServer?.updateDisplay({ phase: 'idle', guestName: null, endsAt: null })
        }
        // Forward ALL events to Extension Service
        const photoUrl = params.photoUrl ?? params.photo_url ?? params.url
        ws.send({
          type: 'event',
          event: eventType,
          jobId: activeJobId,
          payload: { ...params, ...(photoUrl ? { photoUrl } : {}) },
          timestamp: Date.now(),
        })
      },
    },
    logger,
  )

  // 7. Connect WS and start trigger server
  ws.connect()

  // 8. Graceful shutdown
  let shuttingDown = false
  async function shutdown(signal: string) {
    if (shuttingDown) return
    shuttingDown = true
    logger.info(`Received ${signal}, shutting down...`)
    const forceExitTimer = setTimeout(() => {
      logger.warn('Graceful shutdown timed out; forcing exit')
      process.exit(0)
    }, 3000)
    forceExitTimer.unref()
    try {
      ws.disconnect()
      await closeDisplayWindow(logger)
      await triggerServer?.close()
      logger.info('Shutdown complete')
    } finally {
      process.exit(0)
    }
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('uncaughtException', (err) => {
    logger.error(`Uncaught exception: ${err.message}\n${err.stack}`)
  })
  process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled rejection: ${reason}`)
  })
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
