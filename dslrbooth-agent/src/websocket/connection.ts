import WebSocket from 'ws'
import { Logger } from '../logging/logger'

export type MessageHandler = (msg: { type: string; [key: string]: unknown }) => void

interface ConnectionConfig {
  url: string
  token?: string
  reconnectBaseDelayMs: number
  reconnectMaxDelayMs: number
  heartbeatIntervalMs: number
}

type StatusCallback = (status: 'connected' | 'disconnected') => void

export class WsConnection {
  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay: number
  private shouldReconnect = true
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private stableConnectionTimer: ReturnType<typeof setTimeout> | null = null

  private readonly handlers: MessageHandler[] = []
  private readonly statusCallbacks: StatusCallback[] = []

  constructor(
    private readonly config: ConnectionConfig,
    private readonly logger: Logger,
  ) {
    this.reconnectDelay = config.reconnectBaseDelayMs
  }

  onMessage(handler: MessageHandler): this {
    this.handlers.push(handler)
    return this
  }

  onStatusChange(cb: StatusCallback): this {
    this.statusCallbacks.push(cb)
    return this
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return
    }

    this.logger.info(`Connecting to Extension Service: ${this.config.url}`)
    this.shouldReconnect = true

    try {
      const wsUrl = this.config.token
  ? `${this.config.url.replace(/\/$/, '')}?token=${encodeURIComponent(this.config.token)}`
  : this.config.url
      this.ws = new WebSocket(wsUrl, {
        handshakeTimeout: 10000,
        // The service does not use WebSocket compression. Disabling it on both
        // ends prevents intermediaries or stale deployments from producing
        // frames with RSV1 set without a negotiated extension.
        perMessageDeflate: false,
      })
    } catch (err) {
      this.logger.error(`WebSocket constructor error: ${(err as Error).message}`)
      this.scheduleReconnect()
      return
    }

    this.ws.on('open', () => {
      this.logger.info('WebSocket connected to Extension Service')
      this.notifyStatus('connected')
      this.startHeartbeat()
      this.startStableConnectionTimer()
    })

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString())
        this.logger.debug(`Received WS message: ${JSON.stringify(msg).slice(0, 200)}`)
        for (const handler of this.handlers) {
          handler(msg)
        }
      } catch (err) {
        this.logger.error(`Failed to parse WS message: ${(err as Error).message}`)
      }
    })

    this.ws.on('error', (err) => {
      this.logger.error(`WebSocket error: ${err.message}`)
    })

    this.ws.on('close', (code: number, reason: Buffer) => {
      const reasonStr = reason.toString() || 'no reason'
      this.logger.warn(`WebSocket closed: code=${code}, reason=${reasonStr}`)
      this.stopHeartbeat()
      this.stopStableConnectionTimer()
      this.notifyStatus('disconnected')
      this.ws = null
      if (this.shouldReconnect) {
        this.scheduleReconnect()
      }
    })
  }

  send(msg: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn('Cannot send: WebSocket not open')
      return false
    }
    try {
      this.ws.send(JSON.stringify(msg))
      this.logger.debug(`Sent WS message: ${JSON.stringify(msg).slice(0, 200)}`)
      return true
    } catch (err) {
      this.logger.error(`Send failed: ${(err as Error).message}`)
      return false
    }
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  disconnect(): void {
    this.shouldReconnect = false
    this.stopHeartbeat()
    this.stopStableConnectionTimer()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.removeAllListeners()
      try { this.ws.close(1000, 'shutdown') } catch {}
      this.ws = null
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return
    const delay = Math.min(this.reconnectDelay, this.config.reconnectMaxDelayMs)
    this.logger.info(`Reconnecting in ${delay}ms`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.config.reconnectMaxDelayMs)
      this.connect()
    }, delay)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'heartbeat', timestamp: Date.now() })
    }, this.config.heartbeatIntervalMs)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private startStableConnectionTimer(): void {
    this.stopStableConnectionTimer()
    const stableAfterMs = Math.max(this.config.heartbeatIntervalMs * 2, 30_000)
    this.stableConnectionTimer = setTimeout(() => {
      this.reconnectDelay = this.config.reconnectBaseDelayMs
      this.stableConnectionTimer = null
    }, stableAfterMs)
  }

  private stopStableConnectionTimer(): void {
    if (this.stableConnectionTimer) {
      clearTimeout(this.stableConnectionTimer)
      this.stableConnectionTimer = null
    }
  }

  private notifyStatus(status: 'connected' | 'disconnected'): void {
    for (const cb of this.statusCallbacks) {
      try { cb(status) } catch {}
    }
  }
}
