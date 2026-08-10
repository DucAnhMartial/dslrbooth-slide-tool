// Entry point: wires together all components
import dotenv from 'dotenv'
dotenv.config()

import { loadConfig } from './config'
import { createLogger, Logger } from './logging/logger'
import { DslrBoothClient } from './dslrbooth/client'
import { WsConnection } from './websocket/connection'
import { createTriggerServer } from './triggers/server'
import { closeDisplayWindow, openDisplayWindow } from './display/launcher'

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

  ws.onStatusChange((status) => {
    wsConnected = status === 'connected'
    logger.info(`WebSocket status: ${status}`)
  })

  // 5. Message handler: Extension Service → Agent (commands)
  ws.onMessage(async (msg) => {
    if (msg.type === 'announcement') {
      const data = (msg.data ?? {}) as Record<string, unknown>
      triggerServer?.updateDisplay({
        phase: 'announcing',
        guestName: typeof data.guestName === 'string' ? data.guestName : 'Khách tiếp theo',
        endsAt: typeof data.endsAt === 'number' ? data.endsAt : null,
        queueLength: typeof data.queueLength === 'number' ? data.queueLength : 0,
        upNext: Array.isArray(data.upNext) ? data.upNext as Array<{ jobId: string; name: string; position: number }> : [],
      })
      logger.info(`Next guest announcement received: ${typeof data.guestName === 'string' ? data.guestName : 'unknown'}`)
      if (config.autoOpenDisplay) openDisplayWindow(config.triggerServerPort, logger)
      return
    }
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
