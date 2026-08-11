import { Router, Request, Response } from 'express';
import { LocalStore } from '../state/localStore';
import logger from '../logging/logger';
import type { EnvConfig } from '../types';
import { estimateWaitMs } from './estimateWaitMs';
import { toGuestStatus, toPhotoDelivery, type GuestStatusResponse } from './guestStatus';

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
  'WAIT_ESTIMATE_SAMPLE_SIZE' | 'WAIT_ESTIMATE_MIN_SAMPLES' | 'WAIT_ESTIMATE_DEFAULT_MS'
>;

export function createStatusRouter(
  store: LocalStore,
  queue: StatusQueue,
  agent: StatusAgent,
  cfg: StatusConfig,
): ReturnType<typeof Router> {
  const router = Router();

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
   */
  router.get('/status/:jobId', (req: Request, res: Response) => {
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

    const photoDelivery = toPhotoDelivery(store.getNotification(jobId)?.status);

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

    const body: GuestStatusResponse = {
      jobId,
      queuePosition,
      queueLength,
      guestName,
      status,
      photoDelivery,
      boothPaused,
    };

    // D-05 made structural: waitEstimate is ATTACHED only when the booth can
    // actually serve this guest. In every other case the key is absent from
    // the object entirely rather than present and null — an absent key cannot
    // be misread as a zero-minute promise.
    if (status === 'waiting' && !boothPaused) {
      // status === 'waiting' implies job.status === 'queued', and
      // getQueuePosition() returns a position for exactly the queued set, so
      // queuePosition is non-null on this branch.
      const ahead = Math.max(0, (queuePosition ?? 1) - 1);
      // The +1 covers the session currently running or about to be dispatched.
      // That guest is NOT in the queued set that getQueuePosition() and
      // getQueueLength() count, so without this the estimate would omit the
      // one session the guest is most certainly waiting on.
      const inFlight = boothState === 'BUSY' || boothState === 'ANNOUNCING' ? 1 : 0;

      body.waitEstimate = estimateWaitMs(
        store.getRecentSessionDurationsMs(cfg.WAIT_ESTIMATE_SAMPLE_SIZE),
        ahead + inFlight,
        {
          minSamples: cfg.WAIT_ESTIMATE_MIN_SAMPLES,
          defaultMs: cfg.WAIT_ESTIMATE_DEFAULT_MS,
        },
      );
    }

    // No booth-state string, agent-online boolean, stall reason, retry count
    // or ack error appears anywhere in `body` — see the GuestStatusResponse
    // contract, which has no field capable of carrying one.
    return res.json(body);
  }

  return router;
}
