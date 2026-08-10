import { WebSocket, WebSocketServer } from 'ws';
import http from 'http';
import { timingSafeEqual } from 'crypto';
import { getConfig } from '../config';
import logger from '../logging/logger';

const HEARTBEAT_INTERVAL = 15_000;

type AgentAckHandler = (jobId: string, ok: boolean, errorMessage?: string) => void;
type AgentEventHandler = (eventType: string, jobId?: string, payload?: Record<string, unknown>) => void;

export class AgentServer {
  private wss: WebSocketServer | null = null;
  private agentConn: { ws: WebSocket; id: string; lastHeartbeat: number; online: boolean } | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private config = getConfig();
  private connSeq = 0;

  private ackHandler: AgentAckHandler = () => {};
  private eventHandler: AgentEventHandler = () => {};

  registerAckHandler(fn: AgentAckHandler): void { this.ackHandler = fn; }
  registerEventHandler(fn: AgentEventHandler): void { this.eventHandler = fn; }

  /**
   * Verifies the `Authorization: Bearer <token>` header against the
   * configured `AGENT_WS_TOKEN`, reproducing the shape of `webhookAuth.ts`'s
   * `verifySignature()` (Phase 1's precedent). `timingSafeEqual` throws
   * `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` on a length mismatch rather than
   * returning false, so the explicit length guard below is required — without
   * it a wrong-length header would surface as an uncaught exception instead
   * of a clean rejection. The whole body is wrapped in try/catch for the same
   * reason a malformed header must never crash the upgrade path. Returns a
   * bare boolean and logs nothing: the presented and configured credentials
   * must never appear in a message, an error, or a thrown value (D-08).
   */
  private isValidBearerToken(authHeader: string): boolean {
    const PREFIX = 'Bearer ';
    if (!authHeader.startsWith(PREFIX)) return false;
    try {
      const received = Buffer.from(authHeader.slice(PREFIX.length), 'utf8');
      const expected = Buffer.from(this.config.AGENT_WS_TOKEN, 'utf8');
      if (received.length !== expected.length) return false;
      return timingSafeEqual(received, expected);
    } catch {
      return false;
    }
  }

  start(httpServer: http.Server): void {
    this.wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
    });

    httpServer.on('upgrade', (req, socket, head) => {
      const pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;
      if (pathname !== '/agent' || !this.wss) return;

      const authHeader = req.headers.authorization ?? '';
      if (!this.isValidBearerToken(authHeader)) {
        logger.warn('Agent WS rejected: invalid or missing Authorization header');
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss?.emit('connection', ws, req);
      });
    });

    this.wss.on('connection', (ws) => {
      const id = `agent-${Date.now()}-${++this.connSeq}`;
      if (this.agentConn) {
        const displacedId = this.agentConn.id;
        logger.warn(`Agent WS replaced: ${displacedId} displaced by ${id}`);
        try { this.agentConn.ws.close(); } catch { /* ignore */ }
      }
      this.agentConn = { ws, id, lastHeartbeat: Date.now(), online: true };
      logger.info(`Agent connected: ${id}`);

      ws.on('message', (raw) => {
        if (this.agentConn) this.agentConn.lastHeartbeat = Date.now();
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          logger.warn('Agent WS: invalid JSON');
          return;
        }
        const type = msg.type as string;
        if (type === 'ack') {
          this.ackHandler(
            String(msg.jobId ?? ''),
            Boolean(msg.ok),
            typeof msg.errorMessage === 'string' ? msg.errorMessage : undefined
          );
        } else if (type === 'event') {
          this.eventHandler(
            String(msg.event ?? ''),
            typeof msg.jobId === 'string' ? msg.jobId : undefined,
            msg.payload as Record<string, unknown> | undefined
          );
        } else if (type === 'heartbeat') {
          // heartbeat acknowledged, timestamp already updated above
        } else {
          logger.warn(`Agent WS: unknown message type "${type}"`);
        }
      });

      ws.on('close', () => {
        if (this.agentConn?.id === id) {
          this.agentConn = null;
          logger.info('Agent disconnected');
        }
      });

      ws.on('error', (err) => {
        logger.warn(`Agent WS error: ${err.message}`);
      });
    });

    this.startHeartbeatWatchdog();
    logger.info('AgentServer started at /agent');
  }

  stop(): void {
    this.stopHeartbeatWatchdog();
    this.agentConn = null;
    this.wss?.close();
    this.wss = null;
  }

  isAgentOnline(): boolean {
    return this.agentConn !== null && this.agentConn.online;
  }

  getAgentStatus(): { online: boolean; lastHeartbeat: number | null } {
    if (!this.agentConn) return { online: false, lastHeartbeat: null };
    return { online: this.agentConn.online, lastHeartbeat: this.agentConn.lastHeartbeat };
  }

  sendCommand(payload: { type: string; action: string; jobId: string; mode?: string }): boolean {
    if (!this.agentConn || this.agentConn.ws.readyState !== WebSocket.OPEN) {
      logger.warn('Agent WS: cannot send command — no connection');
      return false;
    }
    this.agentConn.ws.send(JSON.stringify(payload));
    return true;
  }

  sendEvent(payload: { type: string; data?: unknown }): boolean {
    if (!this.agentConn || this.agentConn.ws.readyState !== WebSocket.OPEN) return false;
    this.agentConn.ws.send(JSON.stringify(payload));
    return true;
  }

  private startHeartbeatWatchdog(): void {
    this.stopHeartbeatWatchdog();
    this.heartbeatTimer = setInterval(() => {
      if (!this.agentConn) return;
      const elapsed = Date.now() - this.agentConn.lastHeartbeat;
      if (elapsed > this.config.HEARTBEAT_TIMEOUT_MS) {
        logger.warn(`Agent heartbeat timeout (${elapsed}ms > ${this.config.HEARTBEAT_TIMEOUT_MS}ms)`);
        this.agentConn.online = false;
        try { this.agentConn.ws.close(4002, 'heartbeat timeout'); } catch { /* ignore */ }
        this.agentConn = null;
      }
    }, HEARTBEAT_INTERVAL);
  }

  private stopHeartbeatWatchdog(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}
