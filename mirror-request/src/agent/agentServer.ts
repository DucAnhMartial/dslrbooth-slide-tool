import { WebSocket, WebSocketServer } from 'ws';
import http from 'http';
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

  private ackHandler: AgentAckHandler = () => {};
  private eventHandler: AgentEventHandler = () => {};

  registerAckHandler(fn: AgentAckHandler): void { this.ackHandler = fn; }
  registerEventHandler(fn: AgentEventHandler): void { this.eventHandler = fn; }

  start(httpServer: http.Server): void {
    this.wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
    });

    httpServer.on('upgrade', (req, socket, head) => {
      const pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;
      if (pathname !== '/agent' || !this.wss) return;
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss?.emit('connection', ws, req);
      });
    });

    this.wss.on('connection', (ws, req) => {
      const token = new URL(req.url ?? '', `http://${req.headers.host}`).searchParams.get('token') ?? '';
      if (token !== this.config.AGENT_WS_TOKEN) {
        logger.warn('Agent WS rejected: invalid token');
        ws.close(4001, 'unauthorized');
        return;
      }
      if (this.agentConn) {
        try { this.agentConn.ws.close(); } catch { /* ignore */ }
      }
      const id = `agent-${Date.now()}`;
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
