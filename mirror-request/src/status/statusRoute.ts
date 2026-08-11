import { Router, Request, Response } from 'express';
import { LocalStore } from '../state/localStore';
import type { EnvConfig } from '../types';
import { estimateWaitMs } from './estimateWaitMs';
import { toGuestStatus, toPhotoDelivery, type GuestStatusResponse } from './guestStatus';

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
    const job = store.getJob(jobId);

    // D-08: one generic 404, identical whether the job never existed, was
    // purged, or belongs to someone else. Any branch that let a caller tell
    // those apart would be an enumeration oracle. Carried forward from
    // index.ts unchanged — do not add a second failure shape here.
    if (!job) return res.status(404).json({ error: 'job not found' });

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
    res.json(body);
  });

  return router;
}
