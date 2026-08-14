import { getStore, LocalStore } from '../state/localStore';
import type { AgentServer } from '../agent/agentServer';
import { getConfig } from '../config';
import type { EnvConfig } from '../types';
import { labelLogger } from '../logging/logger';
import { resolveDirectImageUrl } from '../display/imageUrlResolver';

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

/**
 * D-03/D-09: how long an unbound `in_progress` job must sit before the tick
 * sweep closes it as `no_photo`.
 *
 * THE FLOOR IS DERIVED, NOT CHOSEN. It is clamped at runtime to
 * `pendingPrintExpiryMs + countdownMs` — computed from this instance's own
 * values rather than from the module constants, so injecting a larger
 * pending-print window cannot silently make this one unsafe. With the shipped
 * defaults that floor is 600000 + 7000 = 607000 ms. It must exceed the
 * pending-print expiry window because a job whose composite is still
 * legitimately in flight has to stay closeable by the completion path; the
 * `no pending_print row` predicate already excludes those rows structurally,
 * and this clamp is the second, independent guarantee of the same thing.
 *
 * 900000 ms (15 min) sits at roughly 1.48x that floor. The asymmetry of the
 * two failure directions is what sets it: closing LATE costs an operator a
 * delayed diagnostic line, while closing EARLY writes a terminal, persisted,
 * guest-visible outcome onto a session that was still alive. Being generous
 * here is close to free; being tight is not.
 *
 * D-12: a module constant and a constructor seam, NOT a key in
 * `src/config.ts`. No environment variable, no runtime toggle, and no test may
 * reach it by mutating `process.env`.
 */
export const NO_PHOTO_CLOSE_DELAY_MS = 900_000;

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
  /**
   * D-14: how many `capture_start` events each in-flight job has produced,
   * keyed by the job the booth is bound to. Read once, at that job's close,
   * and deleted in the same breath.
   *
   * IN MEMORY RATHER THAN IN THE REGISTRY TABLE, deliberately, and the reason
   * is that this count is DIAGNOSTIC, not operational: nothing in this service
   * reads it back, no decision branches on it, and no guest-facing surface
   * shows it. It exists so an operator can see how many shots a session took —
   * which is the first time this project can count a retake at all. Persisting
   * it would add a write on the hottest event in the stream to support a number
   * no code depends on.
   *
   * The cost of that choice is stated rather than hidden: a process that
   * restarts mid-session loses the count, and the summary line then reports
   * `captures=unknown`. That is the correct degradation — an explicit unknown
   * is honest, whereas defaulting to 0 would report "this guest was never
   * photographed" about a guest who was.
   *
   * Bounded by three exits, not two, and the third is the one that was missing
   * (WR-01). logSessionSummary() deletes the entry it reads on each of the two
   * CLOSE paths — `completed` and `no_photo` — but a job that stalls goes
   * through handleStall() to requeueWithRetry() or failJob() and reaches
   * neither. Its count used to survive, and because requeueWithRetry()
   * deliberately preserves the jobId (D-06), the retry attempt then ADDED to
   * the abandoned attempt's total: a one-shot retry reported captures=3.
   *
   * That is diagnostic-only — nothing branches on this number — but it feeds
   * OPS-RUNBOOK §5's `outcome=no_photo` + `captures>0` alert, so a stale count
   * turns a real alert into one an operator learns to distrust. handleStall()
   * now drops the entry on both of its own exits, which is what makes the
   * "bounded" claim true rather than merely intended.
   */
  private captureCounts = new Map<string, number>();
  private pendingPrintExpiryMs: number;
  private noPhotoCloseDelayMs: number;
  private resolveImageUrl: (shareUrl: string) => Promise<string | undefined> =
    (shareUrl) => resolveDirectImageUrl(shareUrl);

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
      & { PENDING_PRINT_EXPIRY_MS?: number; NO_PHOTO_CLOSE_DELAY_MS?: number } = getConfig(),
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
    // Clamped to THIS INSTANCE's pending-print window plus the countdown, not
    // to the module constants: injecting a larger expiry must not be able to
    // leave the no-photo sweep firing inside a window where a composite could
    // still legitimately arrive. The interaction is enforced here rather than
    // assumed to hold.
    const configuredNoPhotoMs = config.NO_PHOTO_CLOSE_DELAY_MS;
    this.noPhotoCloseDelayMs = Math.max(
      this.pendingPrintExpiryMs + this.countdownMs,
      Number.isFinite(configuredNoPhotoMs) ? (configuredNoPhotoMs as number) : NO_PHOTO_CLOSE_DELAY_MS,
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
  /**
   * `reason` is the stable CATEGORY — it is what `failJob` stores in
   * `stall_reason` and what the CMS and other code match on. `detail` is free
   * prose that only ever reaches the log line, so a category can never become
   * unmatchable because someone appended an error message to it.
   */
  private handleStall(jobId: string, reason: string, detail?: string): void {
    // WR-01: the third exit for captureCounts. A stalled job never reaches a
    // close path, so without this its shot count survives to be added onto by
    // the retry attempt (requeueWithRetry preserves the jobId, D-06) or leaks
    // for the life of the process when the job is failed outright.
    this.captureCounts.delete(jobId);
    const { retries } = this.store.requeueWithRetry(jobId);
    if (retries > this.sessionMaxRetries) {
      this.store.failJob(jobId, reason);
      queueLogger.warn(`Job ${jobId} failed after ${retries} attempts: ${reason}${detail ? ` — ${detail}` : ''}`);
    } else {
      queueLogger.warn(`Job ${jobId} requeued (attempt ${retries + 1}/${this.sessionMaxRetries + 1}): ${reason}${detail ? ` — ${detail}` : ''}`);
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
  /**
   * The share-page-to-image-file resolver, injectable for the same reason
   * every timing knob in this service is: a test must be able to drive it
   * without reaching a third-party host over the network, and a suite that
   * depended on fotoshare.co being up would go red whenever someone's wifi
   * did. Defaults to the real one.
   */
  bindImageUrlResolver(fn: (shareUrl: string) => Promise<string | undefined>): void {
    this.resolveImageUrl = fn;
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
  /**
   * CR-01: the event-sourced entry to sessionAcked(), and the only one that
   * needs a cross-check.
   *
   * The two callers are not equally trustworthy and must not share a door.
   * onAgentAck()'s jobId is the id THIS service just dispatched, so it is
   * correct by construction and is the call that legitimately establishes a new
   * binding. A `session_start` event's jobId is Agent-supplied, and
   * onPrintComposite()'s comment states the reason it cannot be trusted: "the
   * Agent stamps a stale activeJobId on every forwarded event and never clears
   * it." D-06 already applies exactly this discipline on the completion anchor;
   * this brings the acknowledgement anchor into line with it.
   *
   * What went wrong without it: the booth rebind below was unconditional, so an
   * event naming any non-terminal job took the booth from whoever held it. The
   * displaced guest stayed `in_progress` but unbound — sweep-eligible (D-09),
   * and with their own composite now failing D-06's check, so they were closed
   * as `no_photo` despite having been photographed. 07-01's guard blocked only
   * the terminal-resurrection half of WINDOWS-8; this closes the other half.
   *
   * An UNBOUND booth still accepts the event. That is the real first
   * `session_start` of a dispatched session, and rejecting it would break every
   * session rather than protect anyone.
   */
  private sessionAckedFromEvent(jobId: string): void {
    const currentJobId = this.store.getBoothCurrentJobId();
    if (currentJobId !== undefined && jobId !== currentJobId) {
      queueLogger.warn(
        `session_start ignored for ${jobId}: booth is bound to ${currentJobId}`,
      );
      return;
    }
    this.sessionAcked(jobId);
  }

  sessionAcked(jobId: string): void {
    const job = this.store.getJob(jobId);
    // 'no_photo' is terminal too (D-09) and belongs in this guard for the same
    // reason 'completed' and 'failed' do: a stray session_start naming a job
    // the sweep already closed would write it back to in_progress, where it
    // would become a fresh candidate for the same sweep on the next tick.
    if (job && (job.status === 'completed' || job.status === 'failed' || job.status === 'no_photo')) {
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

    // D-14, and this is the CLOSE path, not the release path. It sits after the
    // registry slot is opened so the line is emitted once the job's close is
    // fully settled. The double fire cannot reach here twice: the second event
    // returns at the `!completed` branch above.
    //
    // It is deliberately NOT called from sessionEnded(). D-02 separates release
    // from completion: a release can happen minutes after the job closed, or be
    // driven by the fallback timer instead, or — on the stray-duplicate path
    // dslrBooth produces three times in 52 seconds — correspond to no session
    // at all. A summary attached there would report the wrong session or none.
    this.logSessionSummary(currentJobId, 'completed', true);
  }

  onAgentAck(jobId: string, ok: boolean, errorMessage?: string): void {
    if (ok) {
      this.sessionAcked(jobId);
    } else {
      // The Agent's reason used to go to DEBUG — a level this service does not
      // run at — and nowhere else, so four production jobs failed with
      // `stall_reason = 'agent_nak'` and no recoverable explanation for any of
      // them. It now rides handleStall's EXISTING warning rather than adding a
      // second line: "one stall, one warning" is a property this file's tests
      // assert, and two lines for one refusal is how a log becomes something
      // an operator skims past.
      const reason = errorMessage ?? 'no error message';
      // Durably too, because a log rotates and a failed job outlives it.
      this.store.recordAckError(jobId, reason);
      this.store.setBoothIdle();
      this.clearBusyTimer();
      this.handleStall(jobId, 'agent_nak', reason);
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

  /**
   * D-12/D-13: exactly one `info` line for every Agent event, whatever its
   * type and whatever the handler below does with it.
   *
   * NEVER pass an object to the log call. The masking formatters in
   * `logging/logger.ts:16-25` and `:37-45` only run `mask()` when
   * `typeof message === 'string'`, so an object argument would bypass email
   * and phone redaction entirely. Every line here is a template string.
   *
   * The per-event parameter selection is an explicit ALLOW-LIST, not a spread
   * of `payload`, and that shape is the mitigation for T-07-20 rather than a
   * stylistic choice. `param2`/`photoUrl` carry the fotoshare URL, which is a
   * capability URL to the guest's photo: anyone who can read the log can view
   * the photo, rotated logs keep it for fourteen days, and the masking filter
   * recognises emails and phone numbers but has no concept of a URL — nothing
   * downstream will catch a leak, so the prohibition has to hold here. Do not
   * read `param2` or `photoUrl` in this method, and do not "simplify" the
   * allow-list into a payload spread.
   *
   * The composite path IS carried, and that is T-07-22 accepted deliberately:
   * it is booth-local (`C:\dslrBooth\<event>\Prints\<timestamp>.jpg`), the
   * event-folder segment is a business name rather than personal data, and it
   * is what makes the completion anchor diagnosable from the log alone.
   */
  private logAgentEvent(eventType: string, jobId: string | undefined, payload?: Record<string, unknown>): void {
    const attributedJobId = this.store.getBoothCurrentJobId();

    // `none` rather than an empty gap: an operator reading `booth_job=` with
    // nothing after it cannot tell "no job bound" from "the id was dropped".
    let line = `Agent event ${eventType} booth_job=${attributedJobId ?? 'none'}`;

    // Only when the two disagree, and labelled apart from the attributed one.
    // The Agent stamps a stale activeJobId on every forwarded event and never
    // clears it (D-06), so a disagreement is the normal shape of a stray
    // event — printing both ids unlabelled would make the log the thing that
    // confuses rather than the thing that explains.
    if (jobId !== undefined && jobId !== attributedJobId) {
      line += ` event_job=${jobId}`;
    }

    const detail = this.agentEventDetail(eventType, payload);
    if (detail) line += ` ${detail}`;

    queueLogger.info(line);
  }

  /**
   * The allow-list itself, kept as its own method so the prohibition above is
   * enforced in one readable place. Every branch names the single field it
   * reads; the remaining seven AGT-04 types contribute nothing.
   */
  private agentEventDetail(eventType: string, payload?: Record<string, unknown>): string {
    if (!payload) return '';
    const str = (field: string): string | undefined => {
      const raw = payload[field];
      return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
    };
    switch (eventType) {
      // The print composite, from the two events measured to carry the same
      // completed file in different positional params.
      case 'processing_start': {
        const composite = str('param5');
        return composite ? `composite=${composite}` : '';
      }
      case 'printing': {
        const composite = str('param1');
        return composite ? `composite=${composite}` : '';
      }
      // param3 ONLY — 'original' or 'print'. param1 (the local path) and
      // param2 (the fotoshare URL) are both deliberately absent.
      case 'file_upload': {
        const kind = str('param3');
        return kind ? `upload_type=${kind}` : '';
      }
      default:
        return '';
    }
  }

  /**
   * D-14's capture counter. Keyed by the ATTRIBUTED job — the one
   * booth_state.current_job_id says owns the booth — never by the event's own
   * jobId, for the same reason onPrintComposite() never trusts the event's id:
   * the Agent stamps a stale activeJobId on every forwarded event and never
   * clears it.
   *
   * Two guards, and both are needed:
   *   - no bound job at all means no session is running, so there is nothing to
   *     attribute the shot to. A capture with the booth idle is a stranger
   *     pressing start on the booth's own screen (D-04's shape); counting it
   *     would charge the shot to whoever is dispatched next.
   *   - a present-but-disagreeing event jobId is the stale-stamp shape, and it
   *     belongs to some other session. Not counting it undercounts by at most
   *     the strays; counting it would attribute another guest's shots to this
   *     one, which is the worse error of the two.
   */
  private countCapture(jobId: string | undefined): void {
    const attributedJobId = this.store.getBoothCurrentJobId();
    if (attributedJobId === undefined) return;
    if (jobId !== undefined && jobId !== attributedJobId) return;
    this.captureCounts.set(attributedJobId, (this.captureCounts.get(attributedJobId) ?? 0) + 1);
  }

  /**
   * D-14 / SC-3: ONE line per closed job, and the thing that actually
   * discharges ROADMAP criterion 3. An operator greps one job id and gets the
   * whole session, instead of reading fifteen interleaved event lines backwards
   * in the middle of an event.
   *
   * The `key=value` shape and the FIELD ORDER are the contract, not a style —
   * they are what makes the line greppable and diffable, and OPS-RUNBOOK §5
   * publishes the grep. Do not reorder the fields, do not reword them into
   * prose, and do not make any field conditional: an absent field is worse than
   * an explicit `unknown`, because a grep for it then silently matches nothing.
   *
   * `compositeSeen` is passed rather than derived from `outcome`. Today the two
   * are correlated by construction — the completion path always saw one, the
   * no-photo path never did — but they answer different questions ("what did
   * the server decide" versus "what did the booth actually produce"), and a
   * future third close path is where deriving one from the other would quietly
   * start lying.
   *
   * A template string, never an object: the masking formatters only run on
   * strings (see logAgentEvent()). No guest name, email or phone is read here.
   */
  private logSessionSummary(jobId: string, outcome: 'completed' | 'no_photo', compositeSeen: boolean): void {
    const job = this.store.getJob(jobId);
    const acknowledgedAt = job?.acknowledged_at;
    const durationMs = typeof acknowledgedAt === 'number' ? `${Date.now() - acknowledgedAt}` : 'unknown';

    // Read and delete in the same place, so the map cannot outlive the job.
    const captures = this.captureCounts.get(jobId);
    this.captureCounts.delete(jobId);

    queueLogger.info(
      `SESSION_SUMMARY job=${jobId} outcome=${outcome} captures=${captures ?? 'unknown'}`
      + ` print_composite=${compositeSeen ? 'yes' : 'no'} duration_ms=${durationMs}`,
    );
  }

  onAgentEvent(eventType: string, jobId?: string, payload?: Record<string, unknown>): void {
    // FIRST statement, above the branch chain, and that placement is what
    // makes D-12's "one line, unconditionally" true. A line emitted inside
    // each branch would miss every early return the handlers take — the
    // no-usable-path return, the no-job-bound return, the stale-id return —
    // and those returns are exactly the cases an operator needs to see.
    this.logAgentEvent(eventType, jobId, payload);

    if (eventType === 'session_end') {
      this.sessionEnded();
    } else if (eventType === 'session_start' && jobId) {
      this.sessionAckedFromEvent(jobId);
    } else if (eventType === 'file_upload' && jobId && payload) {
      this.onFileUpload(jobId, payload);
    } else if (eventType === 'processing_start' && payload) {
      this.onPrintComposite(eventType, jobId, payload);
    } else if (eventType === 'printing' && payload) {
      this.onPrintComposite(eventType, jobId, payload);
    } else if (eventType === 'capture_start') {
      this.countCapture(jobId);
    } else {
      // Deliberately empty. An unrecognised event type — and every named type
      // that reaches here without the payload its handler needs — has ALREADY
      // been logged by the call above, which runs for every event without
      // exception. The `debug` "Unhandled Agent event" line that used to live
      // here was removed in 07-05, not misplaced: restoring one would
      // double-log every event that lands in this branch.
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

  /**
   * D-03/D-09 (07-04, Option C): close jobs that were left in_progress by a
   * session which produced no print composite.
   *
   * This exists as a sweep rather than as a session_end handler because
   * session_end cannot be attributed to a job — see
   * LocalStore.getJobsAwaitingNoPhotoClose() for the measurement that forced
   * the change and for what each predicate guarantees. Attribution here comes
   * entirely from the row's own structure, so no payload-based or
   * ordering-based discriminator may be reintroduced into this path.
   *
   * Like sweepPendingPrints(), this must never call handleStall(),
   * requeueWithRetry(), requeueNoRetry(), failJob() or setBoothTimeout(): the
   * outcome is nobody's fault, so it charges no retry and writes no
   * stall_reason (D-03, Phase 3 D-01/D-13).
   */
  private sweepNoPhotoJobs(): void {
    const now = Date.now();
    const candidates = this.store.getJobsAwaitingNoPhotoClose(
      now - this.noPhotoCloseDelayMs,
      this.store.getBoothCurrentJobId(),
    );

    for (const jobId of candidates) {
      if (!this.store.closeJobNoPhoto(jobId, now)) continue;
      // Worded apart from sweepPendingPrints()'s expiry warning above. That
      // one means a composite WAS produced but its upload never arrived; this
      // one means none was ever produced. An operator must be able to tell
      // the two apart at a glance.
      queueLogger.warn(
        `Session for job ${jobId} ended with no print composite ever seen; closed as no_photo (no retry charged, guest not re-called)`,
      );
      // D-14's second close path. The plan for 07-05 said to emit this from a
      // no-photo branch inside sessionEnded(); no such branch exists. 07-04
      // shipped the no-photo close as this swept deadline instead, by human
      // decision, after the session_end version was measured to close guest B's
      // live job on guest A's stray duplicate. sessionEnded() is release-only,
      // and D-14 asks for the CLOSE path — which is here.
      //
      // The capture count on this line is what makes Option C's residual
      // visible. Option C narrows the wrongful-close window to fifteen minutes;
      // it does not eliminate it. `outcome=no_photo` together with `captures`
      // greater than zero is a session that photographed a guest and was closed
      // anyway — the signature of that residual firing in production. Without
      // the count on this line it would be indistinguishable from a guest who
      // walked away before the first shot.
      this.logSessionSummary(jobId, 'no_photo', false);
    }
  }

  private tick(): void {
    // FIRST statement, deliberately above the `booth !== 'IDLE'` early return
    // below. A slot can only be open while a session is in progress, so a
    // sweep placed after that guard would never run during the only window
    // that matters and the warning would never fire for a booth that never
    // sees session_end. The placement looks arbitrary and is not.
    this.sweepPendingPrints();

    // SECOND, and also deliberately above the `booth !== 'IDLE'` guard, for a
    // related but distinct reason. A no-photo candidate is by definition NOT
    // the job the booth is serving, so the booth is usually BUSY with the
    // NEXT guest while an abandoned row ages out behind it. Below the guard
    // this sweep would only run while the booth sat idle — that is, never
    // during a busy event, which is precisely when abandoned rows accumulate.
    //
    // It runs after sweepPendingPrints() rather than before so the registry
    // is in its settled state when the candidate query reads it. That
    // ordering is intentional but NOT load-bearing, and the honest reason is
    // worth recording: expired rows are marked and never deleted, and the
    // candidate query excludes a job carrying ANY pending_print row whatever
    // its status, so neither order can change the answer. Do not rely on the
    // ordering for correctness, and do not move sweepPendingPrints().
    this.sweepNoPhotoJobs();

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
        this.recordPhotoHistory(jobId, photoUrl);
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
      this.recordPhotoHistory(jobId, photoUrl);
      void this.sendNotification(jobId, photoUrl);
    }
  }

  /**
   * D-10: the durable photo-history write, called from inside the resolve on
   * BOTH legitimate branches above — the ordinary 'awaiting' resolve and the
   * late-but-legitimate 'expired' one. A real photo arriving late is still a
   * real photo and still belongs on the wall.
   *
   * It is deliberately NOT called on the two no-op branches. `pending ===
   * undefined` (D-04) means no session ever opened a slot for this job, so
   * there is no guest to attribute the photo to; a `false` return from
   * `resolvePendingPrint` means a duplicate or replayed upload, and the first
   * write already recorded the real capture. Writing on either would fabricate
   * history — the mirror image of losing a real capture, and just as silent.
   *
   * ADDITIVE, never a replacement (D-04): every `sendNotification()` call site
   * is exactly where it was, and none of them is gated on this write
   * succeeding. The guest is owed their photo whether or not the CMS has an
   * event set up.
   *
   * The guest name comes from `getJobRegistration()` — the same join
   * `statusRoute.ts` uses, and the one whose header there documents the live
   * bug caused by reading `.registration` off a bare `queue_job` row. It is
   * reused identically rather than re-derived.
   */
  private recordPhotoHistory(jobId: string, photoUrl: string): void {
    try {
      this.writePhotoHistory(jobId, photoUrl);
    } catch (err) {
      // D-04, enforced rather than merely intended. This write sits on the
      // line between the resolve and `sendNotification()`, so an exception
      // escaping it — a locked database, a full disk — would take the guest's
      // photo delivery down with it, turning a cosmetic history gap into the
      // exact failure D-04 exists to prevent. History is the strictly less
      // important of the two; it fails alone.
      queueLogger.warn(
        `Print upload for ${jobId} could not be recorded to photo history: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private writePhotoHistory(jobId: string, photoUrl: string): void {
    const registration = this.store.getJobRegistration(jobId)?.registration;
    const activeEventId = this.store.getActiveEventId();
    if (activeEventId && registration) {
      this.store.recordEventPhoto({
        jobId,
        eventId: activeEventId,
        guestName: registration.name,
        photoUrl,
        capturedAt: Date.now(),
      });

      // The row is now safe. ONLY THEN do we go and ask a third party what
      // the actual picture's address is.
      //
      // `photoUrl` here is dslrBooth's share PAGE, which is what the guest
      // must be sent — but a page in an <img src> draws a broken image on
      // every television, which is exactly what happened on 2026-08-13.
      // `resolveDirectImageUrl` reads the og:image off that page and
      // `setEventPhotoImageUrl` attaches it; the display projections prefer
      // it and fall back to the share URL when it is absent.
      //
      // DELIBERATELY NOT AWAITED. This method is called from the synchronous
      // Agent-event path, and a slow or hanging fotoshare must never delay a
      // capture, hold the booth, or throw into an event handler. The screen
      // re-reads on every tick, so the picture swaps in when the answer
      // arrives — typically well inside the 12s hero window — and if it never
      // arrives the screen behaves exactly as it did before this change.
      void this.resolvePhotoImageUrl(jobId, photoUrl);
      return;
    }
    // T-08-08: a template string, never an object. The winston masking
    // formatters only run when `typeof message === 'string'` (see
    // logging/logger.ts's debugRawPayload warning), so object-form logging
    // here would push an unmasked guest contact detail into the log file.
    queueLogger.warn(
      `Print upload for ${jobId} resolved but no active event — photo not recorded to history`,
    );
  }

  /**
   * Resolves one photo's share page to its image file, in the background.
   *
   * Swallows everything. It is fire-and-forget from a synchronous event
   * handler, so an unhandled rejection here would be an unhandled rejection in
   * the process — and the worst outcome this is allowed to produce is a
   * screen that behaves the way it did yesterday.
   */
  private async resolvePhotoImageUrl(jobId: string, shareUrl: string): Promise<void> {
    try {
      const direct = await this.resolveImageUrl(shareUrl);
      if (!direct) return;
      if (this.store.setEventPhotoImageUrl(jobId, direct)) {
        queueLogger.info(`Resolved display image for ${jobId}`);
      }
    } catch (err) {
      queueLogger.warn(`Image resolution failed for ${jobId}: ${(err as Error).message}`);
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
