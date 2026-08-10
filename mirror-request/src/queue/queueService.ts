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
  /**
   * D-02..D-04: whether the Agent transport is connected right now. Defaults
   * to online so every pre-Phase-3 QueueService test — which never binds
   * this read — keeps its existing meaning unchanged.
   */
  private isAgentOnlineCb: () => boolean = () => true;
  /**
   * D-03: set on the first skipped dispatch of an outage, cleared the moment
   * the booth is allowed to leave IDLE again, so a long outage logs once.
   */
  private agentOfflineDispatchSkipLogged = false;
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
   * Startup reconciliation (D-01..D-04, RESEARCH.md Pattern 1). Must be
   * called once, before the first tick() runs, or tick()'s `booth !== 'IDLE'`
   * guard blocks the queue forever whenever the booth was left BUSY across a
   * restart.
   *
   * BUSY is read against wall-clock age rather than trusted blindly (D-01):
   * age under SESSION_TIMEOUT_MS with at least one in-flight row means the
   * session may still be live, so the booth stays BUSY and the most recently
   * dispatched in-flight row is re-armed with only the remaining time (D-03)
   * — a wrongly-reset booth self-heals on the next dispatch, while a
   * wrongly-BUSY booth is the deadlock this phase removes, so an unparsable
   * or future-dated timestamp falls through to the safer dead-session
   * branch. ANNOUNCING resets to IDLE quietly — the countdown is only
   * 5-10s and the announced job stays 'queued' for the next tick to
   * re-announce (D-04). Every in-flight row except the one surviving job is
   * swept through the retry policy, in every booth state — orphans from an
   * earlier incident have no link back to the current booth_state
   * (RESEARCH.md Pitfall 1), and the single-booth invariant guarantees at
   * most one row can ever be genuinely in flight.
   */
  recover(): void {
    const { state, updated_at } = this.store.getBoothStateDetailed();
    const inFlight = this.store.getInFlightJobs();

    let survivorId: string | null = null;

    if (state === 'BUSY') {
      const ageMs = Date.now() - Date.parse(updated_at);
      const isPossiblyLive = Number.isFinite(ageMs) && ageMs >= 0 && ageMs < this.sessionTimeoutMs && inFlight.length > 0;

      if (isPossiblyLive) {
        const survivor = inFlight[0]; // dispatched_at DESC — most recently dispatched
        survivorId = survivor.id;
        const remainingMs = this.sessionTimeoutMs - ageMs;
        this.startBusyTimer(survivorId, remainingMs);
        queueLogger.info(`Booth possibly live: keeping job ${survivorId} BUSY with ${Math.ceil(remainingMs / 1000)}s remaining`);
      } else {
        this.store.setBoothTimeout('restart recovery: booth was BUSY at startup');
      }
    } else if (state === 'ANNOUNCING') {
      this.store.setBoothIdle();
    }

    let sweptCount = 0;
    for (const job of inFlight) {
      if (job.id === survivorId) continue;
      this.handleStall(job.id, 'restart_recovery_timeout');
      sweptCount++;
    }

    queueLogger.info(`Recovery complete: booth was ${state}, swept ${sweptCount} in-flight job(s)`);
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
  bindIsAgentOnline(cb: () => boolean): void {
    this.isAgentOnlineCb = cb;
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
      this.store.setBoothIdle();
      this.clearBusyTimer();
      this.handleStall(jobId, 'agent_nak');
      this.tick();
    }
  }

  /**
   * D-12/D-13: the Agent transport reports a real disconnect (clean close or
   * heartbeat eviction) through this seam, bound once in createQueueService()
   * to plan 03-02's registerDisconnectHandler(). Both halves of D-13's mutual
   * exclusion with the live busyTimer live in the first two statements here,
   * and neither is optional:
   *   - the `!== 'BUSY'` guard handles the order where busyTimer already won:
   *     it has already set the booth IDLE and resolved the job through
   *     handleStall(), so this path must add nothing.
   *   - clearBusyTimer() handles the opposite order: it cancels the
   *     still-pending timer so it cannot also resolve the same job later.
   * Node's single-threaded event loop makes those two sufficient — a timer
   * callback and a socket close callback are separate macrotasks that can
   * never interleave, only run in some order, and a timer that has not yet
   * begun executing is unconditionally cancellable. No lock or flag needed.
   *
   * handleStall() is deliberately never called from this path: it is the
   * single, always-retry-charging definition of Phase 2's D-05/D-06/D-07
   * policy, and a system-side fault (D-01) must not spend the guest's
   * budget. getInFlightJobs() is reused rather than tracking "the current
   * job" in a new field — it is Phase 2's existing single source of truth
   * for that question, and the loop also covers the orphan case the
   * single-booth invariant makes rare but not impossible.
   */
  onAgentDisconnected(): void {
    if (this.store.getBoothState() !== 'BUSY') return;
    this.clearBusyTimer();
    this.store.setBoothIdle();
    for (const job of this.store.getInFlightJobs()) {
      this.store.requeueNoRetry(job.id);
      queueLogger.warn(`Job ${job.id} requeued after Agent disconnect (no retry charged)`);
    }
    this.tick();
  }

  onAgentEvent(eventType: string, jobId?: string, payload?: Record<string, unknown>): void {
    if (eventType === 'session_end') {
      this.sessionEnded();
    } else if (eventType === 'session_start' && jobId) {
      this.sessionAcked(jobId);
    } else if (eventType === 'file_upload' && jobId && payload) {
      this.sendNotification(jobId, String(payload.photoUrl ?? ''));
    } else {
      queueLogger.debug(`Unhandled Agent event: ${eventType}${jobId ? ` (job ${jobId})` : ''}`);
    }
  }

  private tick(): void {
    const booth = this.store.getBoothState();
    if (booth !== 'IDLE') return;
    if (this.announcingJobId) return;
    const job = this.store.getNextQueuedJob();
    if (!job) return;
    if (!this.isAgentOnlineCb()) {
      if (!this.agentOfflineDispatchSkipLogged) {
        queueLogger.warn(`Skipping dispatch: Agent not connected (job ${job.id} stays queued)`);
        this.agentOfflineDispatchSkipLogged = true;
      }
      return;
    }
    this.agentOfflineDispatchSkipLogged = false;
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
    if (!this.isAgentOnlineCb()) {
      queueLogger.warn(`Skipping dispatch: Agent disconnected during announcement (job ${job.id} stays queued)`);
      this.agentOfflineDispatchSkipLogged = true;
      this.store.setBoothIdle();
      this.tick();
      return;
    }
    const now = Date.now();
    const registration = this.store.getJobRegistration(job.id)?.registration;
    this.store.updateJobStatus(job.id, 'dispatched', 'dispatched_at', now);
    this.store.setBoothBusy();
    this.startBusyTimer(job.id);
    this.sendCommandCb?.({ type: 'command', action: 'start_session', jobId: job.id, mode: registration?.mode });
    queueLogger.info(`Dispatched job ${job.id} → Agent`);
  }

  private startBusyTimer(jobId: string, timeoutMs: number = this.sessionTimeoutMs): void {
    this.clearBusyTimer();
    this.busyTimer = setTimeout(() => {
      this.busyTimer = null;
      this.store.setBoothTimeout('session_ack timeout');
      this.handleStall(jobId, 'session_ack_timeout');
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
    qs.bindIsAgentOnline(() => agentServer.isAgentOnline());
    agentServer.registerDisconnectHandler(() => qs.onAgentDisconnected());
  }
  if (notificationService) {
    qs.bindNotificationService(notificationService);
  }

  return qs;
}
