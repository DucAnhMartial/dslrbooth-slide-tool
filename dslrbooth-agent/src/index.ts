// Entry point: the CLI/pkg shell around the factory in src/agent.ts.
//
// Everything that used to be wired inline in main() — the dslrBooth client,
// the LiveConfig holder, the WebSocket connection, the trigger server, the
// command handler — now lives in createAgent() (plan 10-01, D10-01). This
// file is what `build:exe` compiles and what the booth PC runs today; it
// must keep working at every commit in this phase.
import dotenv from 'dotenv'
dotenv.config()

import { loadConfig } from './config'
import { createLogger } from './logging/logger'
import { createAgent } from './agent'

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

  // 3. Build and start the relay
  const agent = createAgent(config, logger)
  await agent.start()

  // 4. Graceful shutdown
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
      await agent.stop()
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
