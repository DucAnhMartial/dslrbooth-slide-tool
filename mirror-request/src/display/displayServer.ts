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

/**
 * D-09's hero window: how long after a capture the guest who just shot owns
 * the whole screen. CONTEXT leaves the value to Claude's discretion within a
 * 10-15 second range and defaults it to a constructor-injectable constant
 * rather than a CMS field — long enough for a guest to turn around and see
 * their own face, short enough that the room screen is back to being useful
 * to everyone else before the next guest is called.
 *
 * Module constant + `opts` override, matching PENDING_PRINT_EXPIRY_MS in
 * queueService.ts and pollIntervalMs directly below: never read from
 * getConfig() inside a method body, because a timing value read at call time
 * cannot be injected by a test.
 */
const DEFAULT_HERO_MOMENT_MS = 12_000;

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
  private heroMomentDurationMs: number;
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
    opts: { displayWhitelist?: string[]; pollIntervalMs?: number; heroMomentDurationMs?: number } = {},
  ) {
    this.queue = queue;
    this.agent = agent;
    this.store = store;
    this.displayWhitelist = opts.displayWhitelist ?? getConfig().DISPLAY_IP_WHITELIST;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.heroMomentDurationMs = opts.heroMomentDurationMs ?? DEFAULT_HERO_MOMENT_MS;
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

    // D-09/D-10. `justCaptured` is COMPUTED here, on every evaluation, from a
    // durable timestamp — never a field that something sets and a
    // `setTimeout` clears. That is not a style preference; both alternatives
    // fail silently (RESEARCH Pitfall 1):
    //
    //   - a callback-cleared field is lost with the process, so a restart
    //     inside the window pins a departed guest's face on the wall for the
    //     rest of the event, with nothing left to clear it;
    //   - and because `maybeBroadcast()` below sends on a serialised diff, a
    //     value that re-serialises every tick (a remaining-ms countdown, say)
    //     would flood every TV in the venue at 4 Hz.
    //
    // Reading `capturedAt` off disk and comparing it to an injected TTL has
    // neither failure: a restart mid-window either still shows the hero or
    // correctly shows nothing, and the projection is byte-identical on every
    // tick until it flips to null — exactly two broadcasts per capture. This
    // is the same shape `countdownSeconds`/`announcementEndsAt` above already
    // use, for the same reason.
    //
    // `getMostRecentEventPhoto()` and `listEventPhotos()` are purpose-built
    // narrow projections, in keeping with this method's header note: no
    // `event_photo` row reaches the wire.
    const eventConfig = this.store.getActiveEventConfig();
    const activeEventId = this.store.getActiveEventId();
    const recentPhoto = activeEventId ? this.store.getMostRecentEventPhoto(activeEventId) : undefined;
    const justCaptured =
      recentPhoto && Date.now() - recentPhoto.capturedAt < this.heroMomentDurationMs
        ? { photoUrl: recentPhoto.photoUrl, name: recentPhoto.guestName }
        : null;

    // T-08-11: bounded HERE, at render-feed assembly, because D-11 forbids any
    // automatic expiry at the table level. History grows for the whole event;
    // what reaches a browser does not.
    const photos = activeEventId
      ? this.store
          .listEventPhotos(activeEventId, { limit: Math.max(0, eventConfig.photoCount), offset: 0 })
          .map((photo) => ({ photoUrl: photo.photoUrl, name: photo.guestName }))
      : [];

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
      eventConfig,
      justCaptured,
      photos,
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
