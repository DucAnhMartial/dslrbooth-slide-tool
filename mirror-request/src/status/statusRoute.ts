import { Router, Request, Response } from 'express';
import { LocalStore } from '../state/localStore';
import logger from '../logging/logger';
import type { BoothState, EnvConfig } from '../types';
import { estimateWaitMs, type WaitRange } from './estimateWaitMs';
import { toGuestStatus, toPhotoDelivery, type GuestStatusResponse } from './guestStatus';
import { createStatusRateLimiter } from '../security/rateLimiter';

/**
 * D-08's single generic 404, produced in exactly one place so that every way
 * of missing — never existed, purged, malformed, or an unexpected internal
 * throw — is byte-identical. Two literals here would be two failure shapes
 * waiting to drift apart, and any difference between them is an enumeration
 * oracle: a caller who can tell "no such job" from "job you may not see" can
 * confirm which guests are real.
 *
 * Do not add a `reason`, `code`, `hint` or `detail` field. Do not add a
 * variant for malformed input.
 */
function genericNotFound(res: Response): Response {
  return res.status(404).json({ error: 'job not found' });
}

/**
 * The narrowest possible views of QueueService and AgentServer — only the
 * reads this route performs. Both real classes satisfy these structurally, so
 * `index.ts` passes them unchanged, while a test can construct the route
 * against an ephemeral store without booting a WebSocket server.
 *
 * These are read-only by construction: no method here can alter queue dispatch
 * policy, the Agent link, or notification delivery. Phase 5 reads Phases 2-4's
 * state; it must not change their behaviour (phase_boundary).
 */
export interface StatusQueue {
  getQueuePosition(jobId: string): number | undefined;
  getQueueLength(): number;
  getAnnouncement(): { jobId: string; endsAt: number; remainingSeconds: number } | null;
}

export interface StatusAgent {
  isAgentOnline(): boolean;
}

export type StatusConfig = Pick<
  EnvConfig,
  | 'WAIT_ESTIMATE_SAMPLE_SIZE'
  | 'WAIT_ESTIMATE_MIN_SAMPLES'
  | 'WAIT_ESTIMATE_DEFAULT_MS'
  | 'STATUS_RATE_LIMIT_WINDOW_MS'
  | 'STATUS_RATE_LIMIT_MAX'
  | 'STATUS_RATE_LIMIT_MAX_KEYS'
>;

export function createStatusRouter(
  store: LocalStore,
  queue: StatusQueue,
  agent: StatusAgent,
  cfg: StatusConfig,
): ReturnType<typeof Router> {
  const router = Router();

  // D-10: built inside the factory, not at module scope, so each router
  // constructed by a fresh createStatusRouter() call gets independent
  // limiter state — this is what lets a test build a router per case
  // without one case's throttling leaking into the next.
  const rateLimiter = createStatusRateLimiter({
    windowMs: cfg.STATUS_RATE_LIMIT_WINDOW_MS,
    max: cfg.STATUS_RATE_LIMIT_MAX,
    maxKeys: cfg.STATUS_RATE_LIMIT_MAX_KEYS,
  });

  /**
   * D-06: this is a capability URL. The jobId IS the credential — the guest
   * receives it by scanning their own QR code. No login, no PIN, no IP
   * allow-list: a guest's phone is on a different network path than the room
   * LAN, so an allow-list would lock out every legitimate guest.
   *
   * See 05-01-SUMMARY.md — the unguessability this depends on is inherited
   * from the upstream backend, which mints the id, and is NOT verified. That
   * is an accepted dev-environment risk with a pre-production gate, not a
   * closed question.
   *
   * D-10: `rateLimiter` is mounted as the FIRST handler, ahead of
   * `store.getJob(jobId)` below. This is the guarantee, not an incidental
   * ordering: a refused (429) request must never reach the store, or a real
   * id does more work before refusal than a fabricated one — and that extra
   * work is exactly the timing side-channel that would let an attacker
   * confirm an id is real without ever seeing its contents. Moving this
   * middleware after the handler, or inlining its check into the handler
   * body after the lookup, reintroduces that side-channel. See
   * rateLimiter.ts's header comment for the other half of this guarantee.
   */
  router.get('/status/:jobId', rateLimiter, (req: Request, res: Response) => {
    const jobId = req.params.jobId;

    // D-08: the collapse below is the guarantee. Every unexpected throw becomes
    // the SAME generic 404 the miss path returns, because an error that turned
    // into a 500 on some ids while others 404'd would rebuild the enumeration
    // oracle this decision exists to close — by accident, through a code path
    // nobody meant to be security-relevant. Replacing this catch with a 500,
    // or with a 500-for-real-errors/404-for-misses split, reintroduces it.
    //
    // No format validation, length cap or regex guard is applied to :jobId
    // either, for the same reason: better-sqlite3 binds the value as a
    // parameter so there is no injection surface, and any rejection firing
    // before the lookup would tell a caller that their id is SHAPED wrong —
    // a second oracle stacked on top of the one D-08 closes.
    try {
      const job = store.getJob(jobId);

      // Identical whether the job never existed, was purged, or belongs to
      // someone else. Carried forward from index.ts unchanged.
      if (!job) return genericNotFound(res);

      return respond(job, jobId, res);
    } catch (err) {
      logger.error(`Status lookup failed, returning the generic 404: ${(err as Error).message}`);
      // If the failure happened after the body started going out there is
      // nothing left to collapse into — sending again would throw.
      if (res.headersSent) return res;
      return genericNotFound(res);
    }
  });

  function respond(job: { status: string }, jobId: string, res: Response): Response {
    const queuePosition = queue.getQueuePosition(jobId) ?? null;
    const queueLength = queue.getQueueLength();

    // The live-bug fix. index.ts read `job.registration?.name` off the bare
    // `SELECT * FROM queue_job` row returned by getJob() — a row that has no
    // `registration` property at runtime, though TypeScript believed it did —
    // so guestName was null on every real response since the route shipped.
    // getJobRegistration() is the only method that actually performs the join.
    const guestName = store.getJobRegistration(jobId)?.registration.name ?? null;

    // ONE rule, evaluated once, exactly as the canServe comment below requires
    // of this file. The job's status is passed in rather than handled by a
    // second `if` beside this line: two places that could each decide
    // photoDelivery would be two rules free to drift apart. The precedence
    // (a delivered notification outranks the job's outcome word) lives inside
    // toPhotoDelivery and is commented there, because D-11 depends on it.
    const photoDelivery = toPhotoDelivery(store.getNotification(jobId)?.status, job.status);

    const boothState = store.getBoothState();
    // D-05: when nothing can be dispatched, say so and suppress the estimate.
    // NOTE: the TIMEOUT_RESET arm is currently unreachable in practice —
    // LocalStore.setBoothTimeout() writes 'IDLE', not 'TIMEOUT_RESET'. Fixing
    // that is a change to Phase 2's booth state machine and is out of Phase
    // 5's bounds; the arm is written now so it becomes correct for free if
    // Phase 2 ever starts persisting the state its own type already declares.
    const boothPaused = !agent.isAgentOnline() || boothState === 'TIMEOUT_RESET';

    const announced = queue.getAnnouncement()?.jobId === jobId;
    const status = toGuestStatus({ jobStatus: job.status, announced, photoDelivery });

    /**
     * D-05's guarantee lives in the KEY'S ABSENCE, and this is the one place
     * that decides it. An estimate computed while nothing can be dispatched is
     * a promise the system knows it cannot keep — so when the booth cannot
     * serve, the honest answer is to say nothing, not to say a number.
     *
     * Returning `null` instead of omitting the key would be worse than useless:
     * a client rendering `waitEstimate` would show "0 phút" — "no wait at all"
     * — to precisely the guest whose wait is indefinite. That is why this is a
     * conditional SPREAD of a partial object rather than an assignment of
     * undefined or a post-hoc `delete`: those leave the key's existence as a
     * property of serialisation rather than of the code, and a future change of
     * serialiser would silently start emitting it.
     *
     * There is exactly ONE rule and one evaluation of it — `status` is the
     * waiting word and `boothPaused` is false. Two code paths that could each
     * suppress would be two rules free to drift apart.
     */
    const canServe = status === 'waiting' && !boothPaused;

    const body: GuestStatusResponse = {
      jobId,
      queuePosition,
      queueLength,
      guestName,
      status,
      photoDelivery,
      boothPaused,
      ...(canServe ? { waitEstimate: computeEstimate(queuePosition, boothState) } : {}),
    };

    // No booth-state string, agent-online boolean, stall reason, retry count
    // or ack error appears anywhere in `body` — see the GuestStatusResponse
    // contract, which has no field capable of carrying one.
    return res.json(body);
  }

  // Reached only on the canServe branch above, which is what makes the
  // non-null assumption about queuePosition sound: `status === 'waiting'`
  // implies `job.status === 'queued'`, and getQueuePosition() returns a
  // position for exactly the queued set.
  function computeEstimate(queuePosition: number | null, boothState: BoothState): WaitRange {
    const ahead = Math.max(0, (queuePosition ?? 1) - 1);
    // The +1 covers the session currently running or about to be dispatched.
    // That guest is NOT in the queued set that getQueuePosition() and
    // getQueueLength() count, so without this the estimate would omit the one
    // session the guest is most certainly waiting on.
    const inFlight = boothState === 'BUSY' || boothState === 'ANNOUNCING' ? 1 : 0;

    return estimateWaitMs(
      store.getRecentSessionDurationsMs(cfg.WAIT_ESTIMATE_SAMPLE_SIZE),
      ahead + inFlight,
      {
        minSamples: cfg.WAIT_ESTIMATE_MIN_SAMPLES,
        defaultMs: cfg.WAIT_ESTIMATE_DEFAULT_MS,
      },
    );
  }

  return router;
}
