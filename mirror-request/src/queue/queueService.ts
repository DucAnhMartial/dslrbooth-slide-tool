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
  /**
   * Job ids for which a `print` upload has been accepted, so `sessionEnded()`
   * can warn about a session that produced none. Cleared per job on completion,
   * so this cannot grow without bound.
   */
  private printUploadSeen = new Set<string>();

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
  /**
   * D-06: set the first time onPrintComposite() sees an event jobId that
   * differs from booth_state.current_job_id, cleared the moment a matching
   * event is seen, so a stuck Agent producing a steady stream of stale-id
   * events logs once per episode rather than once per event — the project's
   * only existing log-once shape, copied from agentOfflineDispatchSkipLogged
   * above. No time-windowed rate limiter is built; none exists elsewhere in
   * this codebase.
   */
  private jobIdMismatchWarnLogged = false;
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

  /**
   * D-02: booth-release logic only. Job completion moved to
   * onPrintComposite() — this method no longer completes anything, so a
   * stray duplicate session_end (measured 3x in 52s for one session) has
   * nothing left to damage.
   */
  sessionEnded(): void {
    const currentJobId = this.store.getBoothCurrentJobId();
    if (currentJobId === undefined) {
      // The stray-duplicate path: no job is bound to the booth right now,
      // either because it was already released or because none was ever
      // dispatched. This must have no effect whatsoever, including on a
      // booth that is mid-announcement for the next guest — no setBoothIdle,
      // no clearBusyTimer, no tick.
      queueLogger.info('session_end received with no job bound to the booth; ignored');
      return;
    }

    // The printUploadSeen Set and this warn are rebound from the removed
    // completion id to currentJobId so test/queue-file-upload-print.test.ts's
    // existing assertions keep passing. Plan 07-03 deletes both when the
    // durable pending-print registry lands; do not delete them here.
    if (!this.printUploadSeen.has(currentJobId)) {
      // A session that ends without a print upload leaves the guest with
      // nothing on the slideshow. dslrBooth can emit `file_upload` AFTER
      // `session_end` (measured 2026-08-12: session_end at 06:16:01.819, a
      // further upload at 06:16:04.959), so this is a warning, not a
      // verdict — a late print is still accepted and delivered.
      queueLogger.warn(
        `No print upload seen for ${currentJobId} at session_end; slideshow will stay empty unless one arrives late`,
      );
    }
    this.printUploadSeen.delete(currentJobId);

    this.store.setBoothIdle(); // clears current_job_id in the same write
    this.clearBusyTimer();
    queueLogger.info(`Released booth held by job ${currentJobId}`);
    this.tick();
  }

  /**
   * WINDOWS-8's second, independently-closable half. Task 1 closed the
   * completion path (session_end no longer completes anything); this closes
   * the resurrection path — a stray session_start naming a job that already
   * reached a terminal state must not write it back to in_progress. A job
   * absent from the store (getJob returns undefined) is a different defect
   * class and keeps today's behaviour — it is not blocked.
   */
  sessionAcked(jobId: string): void {
    const job = this.store.getJob(jobId);
    if (job && (job.status === 'completed' || job.status === 'failed')) {
      queueLogger.warn(`session_start ignored for ${jobId}: already ${job.status}`);
      return;
    }
    this.store.updateJobStatus(jobId, 'in_progress', 'acknowledged_at', Date.now());
    this.store.setBoothCurrentJob(jobId);
    this.clearBusyTimer();
    this.startBusyTimer(jobId);
  }

  /**
   * D-01/D-02/D-06: the completion anchor. dslrBooth's print-composite
   * events (`processing_start`, `printing`) both carry the same completed
   * file in the measured evidence, so either one completes the job — the
   * event's own jobId is a cross-check only, never the source of truth,
   * because the Agent stamps a stale activeJobId on every forwarded event
   * and never clears it.
   */
  private onPrintComposite(eventType: string, jobId: string | undefined, payload: Record<string, unknown>): void {
    const currentJobId = this.store.getBoothCurrentJobId();
    if (jobId !== undefined && jobId === currentJobId) {
      // D-06 throttle reset: any event whose jobId matches current_job_id
      // means the Agent is no longer stuck on a stale id, so the next
      // mismatch (a new episode) is allowed to warn again.
      this.jobIdMismatchWarnLogged = false;
    }

    const paramField = eventType === 'processing_start' ? 'param5' : 'param1';
    const rawPath = payload[paramField];
    const compositePath = typeof rawPath === 'string' ? rawPath.trim() : '';
    if (!compositePath) {
      queueLogger.warn(`${eventType} carried no usable composite path in ${paramField}`);
      return;
    }

    if (currentJobId === undefined) {
      // D-04: a composite produced while the service has no dispatched
      // session. Nothing is completed.
      queueLogger.warn(`${eventType} for job ${jobId ?? 'unknown'} arrived with no job bound to the booth`);
      return;
    }

    if (jobId !== undefined && jobId !== currentJobId) {
      // D-06's cross-check: the event's own jobId is never trusted as the
      // source of truth. Throttled — a stuck Agent producing a steady
      // stream of stale-id events logs once per episode, not once per event.
      if (!this.jobIdMismatchWarnLogged) {
        queueLogger.warn(`${eventType} jobId ${jobId} does not match booth_state.current_job_id ${currentJobId}`);
        this.jobIdMismatchWarnLogged = true;
      }
      return;
    }

    const completed = this.store.completeJob(currentJobId, Date.now());
    if (!completed) {
      // The second of the processing_start/printing pair — the job was
      // already closed. No further side effect.
      queueLogger.info(`${eventType} composite for ${currentJobId} arrived after the job was already closed`);
      return;
    }

    queueLogger.info(`Completed job ${currentJobId} via ${eventType} composite ${compositePath}`);
    this.clearBusyTimer(); // the completed job can no longer be stalled and requeued by BTH-02's session timer
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
      this.onFileUpload(jobId, payload);
    } else if (eventType === 'processing_start' && payload) {
      this.onPrintComposite(eventType, jobId, payload);
    } else if (eventType === 'printing' && payload) {
      this.onPrintComposite(eventType, jobId, payload);
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
    this.store.setBoothBusy(job.id);
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

  /**
   * Translate one dslrBooth `file_upload` trigger into at most one guest
   * notification.
   *
   * dslrBooth does NOT send a `photoUrl` field. Its trigger carries positional
   * parameters, measured against a real booth on 2026-08-12:
   *   param1 = local file path   e.g. C:\dslrBooth\Test_event\Singles\...jpg
   *   param2 = the shared URL    e.g. https://fotoshare.co/i/1t1vcs3
   *   param3 = 'original' | 'print'
   *   param4 = event name
   * The Agent forwards every param verbatim (it is a dumb relay per CLAUDE.md),
   * so the source-format knowledge lives here, on the server, where the rest of
   * the business logic is. `photoUrl` is still read first so a future Agent or a
   * different booth vendor that does send it keeps working unchanged.
   *
   * **Only the `print` composite is accepted, and that is a correctness
   * requirement, not a preference.** One session emits several uploads (measured:
   * four `original` frames and one `print`, spread over 11 seconds), and
   * `LocalStore.enqueueNotification()` last-writer-wins until the row reaches
   * `delivered`/`failed`. Accepting every upload would therefore make the guest's
   * photo depend on whether the notification sweeper happened to fire between two
   * uploads — a race deciding what the guest receives. Exactly one `print` exists
   * per session, so filtering on it is deterministic.
   */
  private onFileUpload(jobId: string, payload: Record<string, unknown>): void {
    const kind = typeof payload.param3 === 'string' ? payload.param3 : undefined;
    if (kind !== undefined && kind !== 'print') {
      queueLogger.debug(`Ignoring '${kind}' upload for ${jobId}: only the print composite is delivered`);
      return;
    }
    const photoUrl = String(payload.photoUrl ?? payload.param2 ?? '');
    if (!photoUrl) {
      queueLogger.warn(`Print upload for ${jobId} carried no URL in photoUrl or param2`);
      return;
    }
    this.printUploadSeen.add(jobId);
    void this.sendNotification(jobId, photoUrl);
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
