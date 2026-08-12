import { getStore, LocalStore } from '../state/localStore';
import type { AgentServer } from '../agent/agentServer';
import { getConfig } from '../config';
import type { EnvConfig } from '../types';
import { labelLogger } from '../logging/logger';

// Exported so tests can spy on the exact instance this module logs through.
export const queueLogger = labelLogger('queue');

/**
 * D-07/D-11: how long a pending-print slot stays open before the sweep marks
 * it expired and writes the `No print upload seen` warning.
 *
 * The floor is DERIVED, not chosen: `SESSION_TIMEOUT_MS` (300000,
 * `src/config.ts:103`) + `NEXT_GUEST_COUNTDOWN_MS` (7000, `src/config.ts:104`)
 * = 307000 ms. Below that a legitimately late print could expire before the
 * next guest could even physically be dispatched, and the service would drop a
 * real guest's photo. 600000 ms sits at roughly 1.95x that derived floor —
 * enough headroom that a future increase to either input does not silently
 * make the window unsafe, while still bounded enough that the warning arrives
 * within the same event rather than the next day.
 *
 * D-12: deliberately a module constant and a constructor seam, NOT a key in
 * `src/config.ts`. There is no environment variable and no runtime toggle for
 * it, and no test may reach it by mutating `process.env`; the constructor's
 * optional `PENDING_PRINT_EXPIRY_MS` is the only injection point, following
 * Phase 2's config-injection pattern for every other timing value here.
 */
export const PENDING_PRINT_EXPIRY_MS = 600_000;

/** `SESSION_TIMEOUT_MS` + `NEXT_GUEST_COUNTDOWN_MS`, the derived floor above. */
export const PENDING_PRINT_EXPIRY_FLOOR_MS = 307_000;

export class QueueService {
  private store: LocalStore;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private busyTimer: NodeJS.Timeout | null = null;
  /**
   * D-02: a deliberate sibling of busyTimer, not a variant of it — the same
   * discipline localStore.ts's requeueNoRetry() applies to SQL writers,
   * applied here to timers. Routing a completed job's release timeout
   * through handleStall() would requeue an already-photographed guest and
   * call them back to the camera, so this timer must NEVER be collapsed
   * into busyTimer or call handleStall()/requeueWithRetry()/
   * requeueNoRetry()/failJob()/setBoothTimeout(), and must never write a
   * stall_reason — stall_reason is a closed, server-authored vocabulary
   * (OPS-RUNBOOK §6) that must not gain a value here.
   */
  private releaseTimer: NodeJS.Timeout | null = null;
  private announcementTimer: NodeJS.Timeout | null = null;
  private announcingJobId: string | null = null;
  private announcementEndsAt: number | null = null;
  private sessionTimeoutMs: number;
  private countdownMs: number;
  private sessionMaxRetries: number;
  private boothReleaseTimeoutMs: number;

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
  private pendingPrintExpiryMs: number;
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
    // PENDING_PRINT_EXPIRY_MS is intersected in rather than Pick'ed from
    // EnvConfig on purpose (D-12): it is not an environment key and has no
    // runtime toggle, so it must not appear in EnvConfig or config.ts. The
    // optional property is the test-injection seam, matching Phase 2's
    // constructor-injection pattern for every other timing value here — never
    // read from getConfig() inside a method body.
    config: Pick<EnvConfig, 'SESSION_TIMEOUT_MS' | 'NEXT_GUEST_COUNTDOWN_MS' | 'SESSION_MAX_RETRIES' | 'BOOTH_RELEASE_TIMEOUT_MS'>
      & { PENDING_PRINT_EXPIRY_MS?: number } = getConfig(),
  ) {
    this.store = store;
    this.sessionTimeoutMs = config.SESSION_TIMEOUT_MS;
    const configuredMs = config.NEXT_GUEST_COUNTDOWN_MS;
    this.countdownMs = Math.min(10_000, Math.max(5_000, Number.isFinite(configuredMs) ? configuredMs : 7_000));
    this.sessionMaxRetries = config.SESSION_MAX_RETRIES;
    const configuredReleaseMs = config.BOOTH_RELEASE_TIMEOUT_MS;
    this.boothReleaseTimeoutMs = Number.isFinite(configuredReleaseMs) && configuredReleaseMs >= 30_000
      ? configuredReleaseMs
      : 120_000;
    // Clamped to the derived floor for the same reason boothReleaseTimeoutMs
    // is clamped to 30s: a value below SESSION_TIMEOUT_MS +
    // NEXT_GUEST_COUNTDOWN_MS would expire a slot before the next guest could
    // physically be dispatched, and a legitimately late print would be dropped.
    const configuredExpiryMs = config.PENDING_PRINT_EXPIRY_MS;
    this.pendingPrintExpiryMs = Math.max(
      PENDING_PRINT_EXPIRY_FLOOR_MS,
      Number.isFinite(configuredExpiryMs) ? (configuredExpiryMs as number) : PENDING_PRINT_EXPIRY_MS,
    );
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
    this.clearReleaseTimer();
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

    // No print check happens here, and none may be added back. dslrBooth's
    // print upload has no fixed ordering relative to session_end — measured 26
    // seconds BEFORE it on one session and about one second AFTER it on job
    // BZWCWFN6 — so any check at this moment fires on successful sessions and
    // is silent on some genuinely failed ones. That was WINDOWS item 9. The
    // `No print upload seen` warning now lives on pending-print registry
    // expiry (sweepPendingPrints), which is the only anchor that can be right.

    this.store.setBoothIdle(); // clears current_job_id in the same write
    this.clearBusyTimer();
    this.clearReleaseTimer(); // this session_end IS the release the fallback exists to guard against missing
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
    this.startReleaseTimer(currentJobId); // D-02: falls back to releasing the booth if session_end never arrives

    // D-07: the pending-print slot is opened HERE, at the composite anchor —
    // before the upload exists — rather than when the upload arrives. That
    // ordering is the whole mechanism: by the time a `file_upload` shows up the
    // booth may already have been released and rebound to the next guest, so
    // the only record of who is owed this photo has to have been written
    // earlier, and durably.
    const now = Date.now();
    const opened = this.store.openPendingPrint({
      jobId: currentJobId,
      compositePath,
      openedAt: now,
      expiresAt: now + this.pendingPrintExpiryMs,
    });
    if (!opened) {
      // The processing_start/printing double fire. Not an error — the first
      // event already opened the slot, and ON CONFLICT DO NOTHING kept its
      // deadline and composite path intact.
      queueLogger.info(`Pending-print slot for ${currentJobId} was already open; ${eventType} did not reopen it`);
    }
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
    this.clearReleaseTimer();
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

  /**
   * SC-4 / WINDOWS item 9. Marks every pending-print slot whose deadline has
   * passed and writes one warning per slot — the only anchor at which
   * `No print upload seen` can be correct.
   *
   * The literal token `No print upload seen` is carried over unchanged from
   * the message this replaces, so an operator's existing greps and the runbook
   * keep working. What changed is when it fires: at `session_end` it fired on
   * every successful session, because dslrBooth delivers the composite about a
   * second after `session_end` on some sessions and 26 seconds before it on
   * others.
   *
   * At most one warning per slot, ever, regardless of sweep frequency:
   * expirePendingPrints() marks the rows `expired` inside the same transaction
   * that returns them, so a row cannot be handed to this method twice.
   */
  private sweepPendingPrints(): void {
    for (const row of this.store.expirePendingPrints(Date.now())) {
      queueLogger.warn(
        `No print upload seen for ${row.jobId} within the pending-print window; the composite ${row.compositePath} was produced but no upload arrived, so the slideshow will stay empty`,
      );
    }
  }

  private tick(): void {
    // FIRST statement, deliberately above the `booth !== 'IDLE'` early return
    // below. A slot can only be open while a session is in progress, so a
    // sweep placed after that guard would never run during the only window
    // that matters and the warning would never fire for a booth that never
    // sees session_end. The placement looks arbitrary and is not.
    this.sweepPendingPrints();

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
   * D-02's release-fallback timer. A deliberate sibling of startBusyTimer()
   * above, shaped identically, but its callback does only three things: null
   * the field, release the booth (setBoothIdle(), which also clears
   * current_job_id), and tick() — plus one warn naming the job whose booth
   * was released by the fallback. It must NEVER call handleStall(),
   * requeueWithRetry(), requeueNoRetry(), failJob() or setBoothTimeout() —
   * the job is already terminal, and routing its release through the same
   * path as a genuine stall would requeue an already-photographed guest and
   * call them back to the camera.
   */
  private startReleaseTimer(jobId: string): void {
    this.clearReleaseTimer();
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null;
      this.store.setBoothIdle();
      queueLogger.warn(`Booth released for job ${jobId} by the fallback timer — no session_end arrived within ${this.boothReleaseTimeoutMs}ms`);
      this.tick();
    }, this.boothReleaseTimeoutMs);
  }

  private clearReleaseTimer(): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
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

    // D-07: the lookup key is the pending-print registry, NOT
    // booth_state.current_job_id. The print upload's ordering relative to
    // session_end is not fixed — measured 26 seconds BEFORE it on one session
    // and about one second AFTER it on job BZWCWFN6 — so resolving against
    // whichever job owns the booth at the moment the upload arrives would
    // attribute a real guest's photo to the next guest in exactly the second
    // ordering, or drop it if the booth were idle. The registry is the only
    // thing that still remembers who is owed this photo once the booth has
    // moved on.
    //
    // Three answers, and all three are load-bearing:
    const pending = this.store.getPendingPrint(jobId);

    if (pending === undefined) {
      // D-04: no slot was ever opened for this job, so no session was awaiting
      // a print for it. Deliver nothing. Without this, a stranger pressing
      // start on the booth's own screen would have their photo sent to the
      // last real guest's email and phone number, because the Agent stamps a
      // stale activeJobId on every event and never clears it.
      queueLogger.warn(`Print upload for ${jobId} dropped: no session was awaiting a print for it`);
      return;
    }

    if (pending.status === 'expired') {
      // D-11: the slot expired but the photo is real. Getting it late beats
      // not getting it, so deliver anyway. The job's own status is
      // deliberately NOT touched here — a terminal row is never re-armed, and
      // that guarantee is enforced by Phase 4's SQL, not by a condition on
      // this path. The warn exists because a recurring one means the deadline
      // is set too tight.
      const lateByMs = Date.now() - pending.expiresAt;
      queueLogger.warn(
        `Print upload for ${jobId} arrived ${Math.round(lateByMs / 1000)}s after its pending-print slot expired; delivering late and leaving the job status unchanged`,
      );
      if (this.store.resolvePendingPrint(jobId, Date.now())) {
        void this.sendNotification(jobId, photoUrl);
      }
      return;
    }

    // 'awaiting' — the ordinary path. Resolving BEFORE delivering is
    // deliberate and follows Phase 4's durable-work-item-before-the-network-
    // call precedent: the resolve is what makes a duplicate or replayed upload
    // a no-op, so it has to land first. A false return means another delivery
    // already claimed this slot.
    if (this.store.resolvePendingPrint(jobId, Date.now())) {
      void this.sendNotification(jobId, photoUrl);
    }
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
