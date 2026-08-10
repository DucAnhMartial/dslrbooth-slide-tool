import { getStore, LocalStore } from '../state/localStore';
import type { AgentServer } from '../agent/agentServer';
import { getConfig } from '../config';
import type { EnvConfig } from '../types';
import { labelLogger } from '../logging/logger';

// Exported so tests can spy on the exact instance this module logs through.
export const queueLogger = labelLogger('queue');

export class QueueService {
  private store: LocalStore;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private busyTimer: NodeJS.Timeout | null = null;
  private announcementTimer: NodeJS.Timeout | null = null;
  private announcingJobId: string | null = null;
  private announcementEndsAt: number | null = null;

  private sessionTimeoutMs: number;
  private countdownMs: number;
  private sessionMaxRetries: number;

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

  constructor(
    store: LocalStore = getStore(),
    config: Pick<EnvConfig, 'SESSION_TIMEOUT_MS' | 'NEXT_GUEST_COUNTDOWN_MS' | 'SESSION_MAX_RETRIES'> = getConfig(),
  ) {
    this.store = store;
    this.sessionTimeoutMs = config.SESSION_TIMEOUT_MS;
    const configuredMs = config.NEXT_GUEST_COUNTDOWN_MS;
    this.countdownMs = Math.min(10_000, Math.max(5_000, Number.isFinite(configuredMs) ? configuredMs : 7_000));
    this.sessionMaxRetries = config.SESSION_MAX_RETRIES;
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

  /**
   * Startup reconciliation (D-01..D-02, RESEARCH.md Pattern 1). Must be
   * called once, before the first tick() runs, or tick()'s `booth !== 'IDLE'`
   * guard blocks the queue forever whenever the booth was left BUSY across a
   * restart. In this task a BUSY booth is always treated as dead — task 2
   * adds the age check that lets a genuinely live session survive.
   */
  recover(): void {
    const { state } = this.store.getBoothStateDetailed();
    const inFlight = this.store.getInFlightJobs();

    if (state === 'BUSY') {
      this.store.setBoothTimeout('restart recovery: booth was BUSY at startup');
    }

    for (const job of inFlight) {
      this.handleStall(job.id, 'restart_recovery_timeout');
    }

    queueLogger.info(`Recovery complete: booth was ${state}, swept ${inFlight.length} in-flight job(s)`);
  }

  /**
   * The single definition of the D-05/D-06/D-07 bounded retry policy, shared
   * by the restart-recovery sweep above and the live busyTimer timeout path
   * (plan 02-02). `reason` is always one of the fixed, server-authored
   * stall_reason strings — never guest-supplied text.
   */
  private handleStall(jobId: string, reason: string): void {
    const { retries } = this.store.requeueWithRetry(jobId);
    if (retries > this.sessionMaxRetries) {
      this.store.failJob(jobId, reason);
      queueLogger.warn(`Job ${jobId} failed after ${retries} attempts: ${reason}`);
    } else {
      queueLogger.warn(`Job ${jobId} requeued (attempt ${retries + 1}/${this.sessionMaxRetries + 1}): ${reason}`);
    }
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
    if (completedJobId) queueLogger.info(`Completed job ${completedJobId} after session_end`);
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
      queueLogger.debug(`Agent nak for job ${jobId}: ${errorMessage ?? 'no error message'}`);
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
    const countdownMs = this.countdownMs;
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
    queueLogger.info(`Announcing next guest for job ${job.id} (${countdownMs}ms)`);
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
    queueLogger.info(`Dispatched job ${job.id} → Agent`);
  }

  private startBusyTimer(jobId: string, timeoutMs: number = this.sessionTimeoutMs): void {
    this.clearBusyTimer();
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
