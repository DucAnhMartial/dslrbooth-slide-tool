import { WebSocket, WebSocketServer } from 'ws';
import type { WebSocket as WSType } from 'ws';
import http from 'http';
import { getStore, LocalStore } from '../state/localStore';
import { getConfig } from '../config';
import { clientIp, isWhitelisted } from '../security/ipAllowlist';
import logger from '../logging/logger';
import type { QueueService } from '../queue/queueService';
import type { AgentServer } from '../agent/agentServer';
import type { DisplaySnapshot } from '../types';

const DEFAULT_POLL_INTERVAL_MS = 250;

// Vietnamese naming: the given name is the trailing whitespace-separated
// token (e.g. "Nguyễn Văn A" -> "A"), which is also how a person would
// actually be addressed (D-14). Falls back to the whole string when there
// is no whitespace to split on.
function toGivenName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1] ?? fullName;
}

export class DisplayServer {
  private clients: Set<WSType> = new Set();
  private queue: QueueService;
  private agent: AgentServer;
  private store: LocalStore;
  private displayWhitelist: string[];
  private pollIntervalMs: number;
  private broadcastTimer: NodeJS.Timeout | null = null;
  private wss: WebSocketServer | null = null;
  // The last snapshot message actually sent to clients, serialised. Change
  // detection (D-13) compares against this on every poll tick; a send only
  // happens, and this is only updated, when the serialised form differs.
  private lastSent: string | null = null;

  constructor(
    queue: QueueService,
    agent: AgentServer,
    store: LocalStore = getStore(),
    opts: { displayWhitelist?: string[]; pollIntervalMs?: number } = {},
  ) {
    this.queue = queue;
    this.agent = agent;
    this.store = store;
    this.displayWhitelist = opts.displayWhitelist ?? getConfig().DISPLAY_IP_WHITELIST;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  start(httpServer: http.Server): void {
    const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    this.wss = wss;

    httpServer.on('upgrade', (req, socket, head) => {
      const pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;
      if (pathname !== '/display' || !this.wss) return;

      // D-09/D-10: the peer must be refused BEFORE handleUpgrade is called,
      // never after — an unauthorised peer must not hold an open socket even
      // briefly. No query-string, token, cookie or header check of any kind
      // is added here; D-10 rules that out (a browser cannot avoid pushing a
      // WS query-string credential into logs, history and Referer). Uses
      // 403, not 401 — there is nothing for the caller to supply.
      const ip = clientIp(req);
      if (!isWhitelisted(ip, this.displayWhitelist)) {
        logger.warn(`Blocked /display from non-whitelisted IP: ${ip}`);
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });

    wss.on('connection', (ws: WSType) => {
      this.clients.add(ws);
      // A newly-connected client always gets an immediate snapshot,
      // unconditionally, and that send seeds `lastSent` so the next poll
      // tick's change detection has a correct baseline.
      const msg = JSON.stringify({ type: 'snapshot', data: this.buildSnapshot() });
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
      this.lastSent = msg;

      ws.on('close', () => this.clients.delete(ws));
      ws.on('error', () => this.clients.delete(ws));
    });

    this.broadcastTimer = setInterval(() => this.maybeBroadcast(), this.pollIntervalMs);
  }

  stop(): void {
    if (this.broadcastTimer) clearInterval(this.broadcastTimer);
    this.broadcastTimer = null;
    for (const client of this.clients) client.close(1001, 'server shutdown');
    this.clients.clear();
    this.wss?.close();
    this.wss = null;
  }

  /**
   * D-15's structural guarantee lives HERE, in this method's call list: it
   * never calls `getNextQueuedJob()` or any other method that returns a raw
   * `queue_job` row (`getJob`, `getQueuedJobs`, `getInFlightJobs`, ...). It
   * calls only `getQueuedGuestSummaries()` (a query that already selects
   * just a job id and a guest name) plus a handful of scalar/typed reads.
   * That absence is the guarantee — not a null check, not a
   * delete-the-sensitive-fields step. Reintroducing a raw-row lookup here,
   * even to read a single harmless-looking field off it, would silently
   * reopen the leak this plan closes: any future field added to the
   * snapshot could then read straight off an operator column.
   *
   * Ordering trap (do not "fix" this by projecting first): `guestName` is
   * computed from the UNPROJECTED summaries, before the given-name
   * projection (D-14) is applied to the `upNext` array. Projecting first
   * would silently truncate the hero name to a single token as well.
   */
  private buildSnapshot(): DisplaySnapshot {
    const upNextRaw = this.store.getQueuedGuestSummaries();
    const announcement = this.queue.getAnnouncement();
    const announcedGuest = announcement ? upNextRaw.find((guest) => guest.jobId === announcement.jobId) : undefined;

    // Hero name: full name, computed before projection (see ordering-trap
    // note above).
    const guestName = announcedGuest?.name ?? upNextRaw[0]?.name ?? null;

    // Up-next list: given names only (D-14) — applied at assembly time, not
    // in storage; `getQueuedGuestSummaries()` itself is untouched.
    const upNext = upNextRaw.map((guest) => ({ ...guest, name: toGivenName(guest.name) }));

    return {
      queuePosition: upNextRaw[0]?.position ?? 0,
      queueLength: this.queue.getQueueLength(),
      boothState: this.store.getBoothState(),
      agentOnline: this.agent.isAgentOnline(),
      guestName,
      countdownSeconds: announcement?.remainingSeconds ?? null,
      announcementEndsAt: announcement?.endsAt ?? null,
      upNext,
      // CMS-01/D-12: read fresh on every build, exactly like the queue and
      // booth-state reads above, so activating an event in the CMS reaches
      // every connected screen through maybeBroadcast()'s existing
      // serialized-diff guard — no new broadcast wiring, no per-screen URL,
      // and no page reload. getActiveEventConfig() is a purpose-built
      // projection, never a raw `event` row (see this method's header note).
      eventConfig: this.store.getActiveEventConfig(),
    };
  }

  /**
   * D-13: evaluated on every poll tick, but only sends — and only updates
   * `lastSent` — when the freshly-built snapshot's serialised form differs
   * from what was last sent. No separate 1 Hz countdown timer is needed:
   * `announcement.remainingSeconds` is recomputed from the announcement's
   * end time on every evaluation and changes exactly once per second while
   * a countdown is running, so this single change detector alone produces
   * the 1 Hz tick D-13 asks for, and produces nothing at all while the room
   * is idle and nothing has moved.
   */
  private maybeBroadcast(): void {
    const msg = JSON.stringify({ type: 'snapshot', data: this.buildSnapshot() });
    if (msg === this.lastSent) return;
    this.lastSent = msg;
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }
}
