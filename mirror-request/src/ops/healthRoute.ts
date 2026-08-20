import { Router, Request, Response } from 'express';
import { clientIp, isWhitelisted } from '../security/ipAllowlist';
import { labelLogger } from '../logging/logger';

const log = labelLogger('health');

/**
 * The service-level health endpoint (`GET /health`).
 *
 * WHY THIS EXISTS AT ALL. Before it, three separate failures were live on the
 * production host at once — the process running with NODE_ENV=staging so its
 * own production fail-fast never fired, six notifications dead at three
 * attempts each against a port nothing listened on, and an internet-facing
 * bind being probed from outside. Every one of them was recoverable in
 * minutes. What made them dangerous was not severity but silence: each one
 * was recorded ONLY as a line in a rotating log file. Nothing polled, nothing
 * alerted, no page displayed a number that was wrong. The room screen looked
 * perfect throughout.
 *
 * So the thing this endpoint owes an operator is not a liveness probe — pm2
 * already knows whether the process is up. It is the answer to "is anything
 * quietly broken right now", in a form a person can read in five seconds and
 * a script can poll. `warnings` is therefore the payload; the counts exist to
 * justify each warning, not the other way round.
 *
 * WHAT IT DELIBERATELY DOES NOT CONTAIN. No guest name, email, phone or photo
 * URL — only COUNT(*) aggregates and enum-ish scalars (see the store methods'
 * own header note). That is what makes it safe to widen access to loopback
 * below. Keep it that way: the moment a single guest-identifying field is
 * added here, the access decision underneath has to be re-argued.
 *
 * ONE EXCEPTION, and it is a real one: the stuck-booth warning names the job
 * id it is complaining about. That id is not guest data, but it IS the lookup
 * key for `GET /status/:jobId`, so it is a capability rather than a mere
 * label. It is included anyway because a warning that says a job is stuck
 * without saying WHICH job cannot be acted on, and because the only readers
 * are loopback and the operator subnet — the same audience the CMS already
 * shows every guest's full record to. Do not extend this to a list of ids.
 *
 * ACCESS. Loopback ∪ CMS_IP_WHITELIST, and NOT the display list. The two
 * additions over a bare CMS gate are deliberate and each has a reason:
 *
 *   - loopback, because a monitoring check that must first be allow-listed
 *     from off-box is a check nobody sets up. `curl localhost:3002/health`
 *     from the machine itself has to work, or this endpoint will go the same
 *     way as the log file it replaces. This is also the surface that was
 *     found broken for /display-screen in the same audit (127.0.0.1 was not
 *     on any list, so the host could not probe itself at all).
 *   - the CMS list rather than the display list, because this is operator
 *     information. A TV in the venue has no business reading it, and the
 *     rooms those two lists describe are not the same room (D-13).
 *
 * No session check on top of the IP gate, unlike /cms. That is a real
 * loosening and it is bounded by the paragraph above: an endpoint carrying no
 * identifying data, reachable only from the operator's own subnet or the
 * host itself, is worth strictly less to an attacker than the login page
 * already sitting on the same list — and requiring a session would make the
 * loopback case (a cron job, a monitoring agent) impossible to use.
 */

export interface HealthDeps {
  store: {
    getBoothState(): string;
    countQueueJobsByStatus(): Record<string, number>;
    countNotificationsByStatus(): Record<string, number>;
    getOldestInFlightJob(): { id: string; status: string; dispatchedAt: number } | undefined;
  };
  agent: { isAgentOnline(): boolean };
  config: {
    CMS_IP_WHITELIST: string[];
    WEBHOOK_HMAC_SECRET: string;
    NOTIFY_WEBHOOK_URL: string;
  };
  nodeEnv?: string;
  /** Injected so a test can assert an exact uptime without waiting. */
  uptimeSeconds?: () => number;
  /** Injected for the same reason — an in-flight age must be assertable. */
  now?: () => number;
  /**
   * How long the booth may hold one job before the report calls it stuck.
   * Defaults to half of SESSION_TIMEOUT_MS's shipped value.
   *
   * Half, deliberately. SESSION_TIMEOUT_MS is when the SERVICE gives up and
   * stalls the job; a warning that fired at the same moment would tell an
   * operator something they were about to be told anyway, too late to act on.
   * Firing at half gives roughly two and a half minutes of warning while
   * staying far above a real session — measured at 30-60 seconds — so an
   * ordinary guest never trips it.
   */
  inFlightWarnMs?: number;
}

const DEFAULT_INFLIGHT_WARN_MS = 150_000;

export interface HealthReport {
  status: 'ok' | 'degraded';
  mode: string;
  webhookAuth: 'enforced' | 'disabled';
  photoDelivery: 'configured' | 'disabled';
  uptimeSeconds: number;
  boothState: string;
  agentOnline: boolean;
  queue: Record<string, number>;
  notifications: Record<string, number>;
  warnings: string[];
}

export function buildHealthReport(deps: HealthDeps): HealthReport {
  const mode = deps.nodeEnv ?? process.env.NODE_ENV ?? 'development';
  const queue = deps.store.countQueueJobsByStatus();
  const notifications = deps.store.countNotificationsByStatus();
  const warnings: string[] = [];

  // The exact condition that was live and unreported. Phrased as the
  // consequence ("signature verification is off"), not the cause
  // ("NODE_ENV is staging"), because the consequence is what an operator
  // has to weigh and the cause is one line further down the same object.
  if (mode !== 'production') {
    warnings.push(
      `Service is running in "${mode}" mode, not production: webhook signature verification and the ` +
        `production configuration fail-fast are both inactive.`,
    );
  }
  if (!deps.config.WEBHOOK_HMAC_SECRET) {
    warnings.push('WEBHOOK_HMAC_SECRET is not configured: /on-register accepts unsigned requests.');
  }

  // A permanently failed notification is the one failure in this service
  // that is invisible from every screen: the queue advances, the booth frees,
  // the wall updates, and the guest's photo simply never leaves. It is
  // surfaced as a warning at any count above zero, with no threshold — a
  // threshold here would just be a smaller silence.
  const failed = notifications.failed ?? 0;
  if (failed > 0) {
    warnings.push(`${failed} photo notification(s) have permanently failed after exhausting their retries.`);
  }

  // A job the booth has held far too long.
  //
  // This replaces a `queue.stalled` check that could never fire: there is no
  // 'stalled' job status in this codebase. A stall routes through
  // handleStall() to requeueWithRetry() ('queued') or failJob() ('failed'),
  // and the six statuses that exist are queued / dispatched / in_progress /
  // completed / failed / no_photo. The old branch read plausibly and was dead
  // code — worse, it occupied the place where the real check belonged.
  //
  // Age, not count, because the condition worth reporting is not "a job is
  // in flight" (that is a booth doing its job) but "a job has been in flight
  // longer than any real session lasts". That is the only externally visible
  // difference between a guest posing and an Agent that is connected,
  // authenticated, answering heartbeats, and silently not acting.
  const inFlight = deps.store.getOldestInFlightJob();
  const nowMs = (deps.now ?? Date.now)();
  const warnAfterMs = deps.inFlightWarnMs ?? DEFAULT_INFLIGHT_WARN_MS;
  if (inFlight && nowMs - inFlight.dispatchedAt > warnAfterMs) {
    const heldSec = Math.round((nowMs - inFlight.dispatchedAt) / 1000);
    warnings.push(
      `The booth has held job ${inFlight.id} in "${inFlight.status}" for ${heldSec}s — ` +
        `far longer than a session takes. The queue is not advancing behind it.`,
    );
  }

  return {
    // 'degraded', never 'error': every warning above describes a service that
    // is still serving. A monitor should page on this differently from a
    // process that is down, and pm2 already covers the second case.
    status: warnings.length === 0 ? 'ok' : 'degraded',
    mode,
    webhookAuth: deps.config.WEBHOOK_HMAC_SECRET ? 'enforced' : 'disabled',
    // Not a warning. An empty NOTIFY_WEBHOOK_URL is the configured state
    // after web-slide's retirement, and reporting a deliberate choice as a
    // fault is how a health page teaches people to ignore it.
    photoDelivery: deps.config.NOTIFY_WEBHOOK_URL ? 'configured' : 'disabled',
    uptimeSeconds: Math.floor((deps.uptimeSeconds ?? (() => process.uptime()))()),
    boothState: deps.store.getBoothState(),
    agentOnline: deps.agent.isAgentOnline(),
    queue,
    notifications,
    warnings,
  };
}

const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

export function createHealthRouter(deps: HealthDeps): ReturnType<typeof Router> {
  const router = Router();
  // Union built once at construction, not per request. Concatenation rather
  // than mutation of the config array — this must not widen the list the CMS
  // gate itself reads.
  const allowed = [...LOOPBACK, ...deps.config.CMS_IP_WHITELIST];

  router.get('/health', (req: Request, res: Response) => {
    const ip = clientIp(req);
    // isWhitelisted() treats an empty list as "allow everything" (its
    // development escape hatch). `allowed` can never be empty here — LOOPBACK
    // is a non-empty literal — so that branch is unreachable on this route
    // and an unset CMS_IP_WHITELIST narrows access to loopback rather than
    // opening it to the world.
    if (!isWhitelisted(ip, allowed)) {
      log.warn(`Blocked /health from non-whitelisted IP: ${ip}`);
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    // 200 even when degraded: the report IS the answer, and a non-2xx would
    // make every naive uptime checker treat a stale notification as an
    // outage. Consumers branch on `status`.
    res.json(buildHealthReport(deps));
  });

  return router;
}
