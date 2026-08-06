import { getStore, LocalStore } from '../state/localStore';
import type { AgentServer } from '../agent/agentServer';

export class QueueService {
  private store: LocalStore;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private busyTimer: NodeJS.Timeout | null = null;
  private announcementTimer: NodeJS.Timeout | null = null;
  private announcingJobId: string | null = null;
  private announcementEndsAt: number | null = null;

  private notificationService: { sendPhotoLink: (jid: string, url: string) => Promise<void> } | null = null;
  private sendCommandCb: ((payload: {
    type: 'command'; action: 'start_session'; jobId: string; mode?: string
  }) => void) | null = null;
  private sendAnnouncementCb: ((payload: {
    jobId: string;
    guestName: string;
    endsAt: number;
    queueLength: number;
    upNext: Array<{ jobId: string; name: string; position: number }>;
  }) => void) | null = null;

  constructor(store: LocalStore = getStore()) {
    this.store = store;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => this.tick(), 250);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    if (this.busyTimer) clearTimeout(this.busyTimer);
    if (this.announcementTimer) clearTimeout(this.announcementTimer);
    this.announcementTimer = null;
    this.announcingJobId = null;
    this.announcementEndsAt = null;
  }

  bindSendCommand(cb: (payload: { type: 'command'; action: 'start_session'; jobId: string; mode?: string }) => void): void {
      this.sendCommandCb = cb;
    }
  bindAnnouncement(cb: NonNullable<QueueService['sendAnnouncementCb']>): void {
    this.sendAnnouncementCb = cb;
  }
    bindNotificationService(ns: { sendPhotoLink: (jid: string, url: string) => Promise<void> } | null): void {
      this.notificationService = ns;
    }

  enqueueJob(_jobId: string): void { if (!this.running) this.tick(); }

  sessionEnded(): void {
    const completedJobId = this.store.completeInProgressJob(Date.now());
    if (completedJobId) logger.info(`Completed job ${completedJobId} after session_end`);
    this.store.setBoothIdle();
    this.clearBusyTimer();
    this.tick();
  }

  sessionAcked(jobId: string): void {
    this.store.updateJobStatus(jobId, 'in_progress', 'acknowledged_at', Date.now());
    this.clearBusyTimer();
    this.startBusyTimer(jobId);
  }

  onAgentAck(jobId: string, ok: boolean, errorMessage?: string): void {
    if (ok) {
      this.sessionAcked(jobId);
    } else {
      logger.debug('Agent nak', jobId, errorMessage);
      this.store.updateJobStatus(jobId, 'queued', 'session_started_at', Date.now());
      this.store.setBoothIdle();
      this.clearBusyTimer();
      this.tick();
    }
  }

  onAgentEvent(eventType: string, jobId?: string, payload?: Record<string, unknown>): void {
    if (eventType === 'session_end') {
      this.sessionEnded();
    } else if (eventType === 'session_start' && jobId) {
      this.sessionAcked(jobId);
    } else if (eventType === 'file_upload' && jobId && payload) {
      this.sendNotification(jobId, String(payload.photoUrl ?? ''));
    }
  }

  private tick(): void {
    const booth = this.store.getBoothState();
    if (booth !== 'IDLE') return;
    if (this.announcingJobId) return;
    const job = this.store.getNextQueuedJob();
    if (!job) return;
    this.beginAnnouncement(job);
  }

  private beginAnnouncement(job: { id: string }): void {
    const configuredMs = parseInt(process.env.NEXT_GUEST_COUNTDOWN_MS || '7000', 10);
    const countdownMs = Math.min(10_000, Math.max(5_000, Number.isFinite(configuredMs) ? configuredMs : 7_000));
    this.announcingJobId = job.id;
    this.announcementEndsAt = Date.now() + countdownMs;
    this.store.setBoothState('ANNOUNCING');
    const upNext = this.store.getQueuedGuestSummaries();
    this.sendAnnouncementCb?.({
      jobId: job.id,
      guestName: upNext.find(guest => guest.jobId === job.id)?.name ?? 'Khách tiếp theo',
      endsAt: this.announcementEndsAt,
      queueLength: this.store.getQueueLength(),
      upNext,
    });
    logger.info(`Announcing next guest for job ${job.id} (${countdownMs}ms)`);
    this.announcementTimer = setTimeout(() => {
      this.announcementTimer = null;
      this.announcingJobId = null;
      this.announcementEndsAt = null;
      this.dispatchJob(job);
    }, countdownMs);
  }

  private dispatchJob(job: { id: string }): void {
    const now = Date.now();
    this.store.updateJobStatus(job.id, 'dispatched', 'dispatched_at', now);
    this.store.setBoothBusy();
    this.startBusyTimer(job.id);
    this.sendCommandCb?.({ type: 'command', action: 'start_session', jobId: job.id });
    logger.info(`Dispatched job ${job.id} → Agent`);
  }

  private startBusyTimer(jobId: string): void {
    this.clearBusyTimer();
    const timeoutMs = parseInt(process.env.SESSION_TIMEOUT_MS || '300000', 10);
    this.busyTimer = setTimeout(() => {
      this.store.setBoothTimeout('session_ack timeout');
      this.store.updateJobStatus(jobId, 'queued', 'acknowledged_at', Date.now());
      this.tick();
    }, timeoutMs);
  }

  private async sendNotification(jobId: string, photoUrl: string): Promise<void> {
  if (this.notificationService) {
    await this.notificationService.sendPhotoLink(jobId, photoUrl);
  }
}

private clearBusyTimer(): void {
    if (this.busyTimer) clearTimeout(this.busyTimer);
    this.busyTimer = null;
  }

  getQueuePosition(jobId: string): number | undefined {
    return this.store.getQueuePosition(jobId);
  }

  getQueueLength(): number {
    return this.store.getQueueLength();
  }

  getAnnouncement(): { jobId: string; endsAt: number; remainingSeconds: number } | null {
    if (!this.announcingJobId || !this.announcementEndsAt) return null;
    return {
      jobId: this.announcingJobId,
      endsAt: this.announcementEndsAt,
      remainingSeconds: Math.max(0, Math.ceil((this.announcementEndsAt - Date.now()) / 1000)),
    };
  }
}

const logger = {
  debug: (...args: unknown[]) => console.debug('[queue]', ...args),
  info:  (...args: unknown[]) => console.info('[queue]', ...args),
};

export function createQueueService(
  agentServer?: AgentServer,
  notificationService?: { sendPhotoLink: (jid: string, url: string) => Promise<void> }
): QueueService {
  const qs = new QueueService();

  if (agentServer) {
    qs.bindSendCommand((cmd) => agentServer.sendCommand({ type: cmd.type, action: cmd.action, jobId: cmd.jobId, mode: cmd.mode }));
    agentServer.registerAckHandler((jobId, ok, err) => qs.onAgentAck(jobId, ok, err));
    agentServer.registerEventHandler((eventType, jobId, payload) => qs.onAgentEvent(eventType, jobId, payload));
    qs.bindAnnouncement((data) => agentServer.sendEvent({ type: 'announcement', data }));
  }
  if (notificationService) {
    qs.bindNotificationService(notificationService);
  }

  return qs;
}
