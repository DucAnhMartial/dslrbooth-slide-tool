import { WebSocket, WebSocketServer } from 'ws';
import type { WebSocket as WSType } from 'ws';
import http from 'http';
import { getStore } from '../state/localStore';
import type { QueueService } from '../queue/queueService';
import type { AgentServer } from '../agent/agentServer';
import type { DisplaySnapshot } from '../types';

const store = getStore();

export class DisplayServer {
  private clients: Set<WSType> = new Set();
  private queue: QueueService;
  private agent: AgentServer;
  private broadcastTimer: NodeJS.Timeout | null = null;
  private wss: WebSocketServer | null = null;

  constructor(queue: QueueService, agent: AgentServer) {
    this.queue = queue;
    this.agent = agent;
  }

  start(httpServer: http.Server): void {
    const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    this.wss = wss;

    httpServer.on('upgrade', (req, socket, head) => {
      const pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;
      if (pathname !== '/display') return;
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });

    wss.on('connection', (ws: WSType) => {
      this.clients.add(ws);
      this.broadcastSnapshot();

      ws.on('close', () => this.clients.delete(ws));
      ws.on('error', () => this.clients.delete(ws));
    });

    this.broadcastTimer = setInterval(() => this.broadcastSnapshot(), 250);
  }

  stop(): void {
    if (this.broadcastTimer) clearInterval(this.broadcastTimer);
    this.broadcastTimer = null;
    for (const client of this.clients) client.close(1001, 'server shutdown');
    this.clients.clear();
    this.wss?.close();
    this.wss = null;
  }

  broadcastSnapshot(): void {
    const job = store.getNextQueuedJob();
    const upNext = store.getQueuedGuestSummaries();
    const announcement = this.queue.getAnnouncement();
    const announcedGuest = announcement ? upNext.find((guest) => guest.jobId === announcement.jobId) : undefined;
    const snapshot: DisplaySnapshot = {
      currentJob: job ?? null,
      queuePosition: job ? this.queue.getQueuePosition(job.id) ?? 0 : 0,
      queueLength: this.queue.getQueueLength(),
      boothState: store.getBoothState(),
      agentOnline: this.agent.isAgentOnline(),
      guestName: announcedGuest?.name ?? upNext[0]?.name ?? null,
      countdownSeconds: announcement?.remainingSeconds ?? null,
      announcementEndsAt: announcement?.endsAt ?? null,
      upNext,
    };
    const msg = JSON.stringify({ type: 'snapshot', data: snapshot });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }
}
