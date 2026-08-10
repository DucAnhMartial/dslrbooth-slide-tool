import { WsConnection } from '../websocket/connection'
import { Logger } from '../logging/logger'

export class Heartbeat {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly ws: WsConnection,
    private readonly intervalMs: number,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      if (this.ws.isConnected()) {
        this.ws.send({ type: 'heartbeat', timestamp: Date.now() })
        this.logger.debug('Heartbeat sent')
      }
    }, this.intervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}