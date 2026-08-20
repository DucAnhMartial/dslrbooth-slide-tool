import { Router, Request, Response } from 'express';
import { labelLogger } from '../logging/logger';
import {
  renderCmsBoothPage,
  BOOTH_RELEASE_SUCCESS,
  BOOTH_RELEASE_INVALID,
  BOOTH_RELEASE_WRONG_JOB,
  BOOTH_RELEASE_ALREADY_FINISHED,
} from './cmsBoothPages';

const log = labelLogger('cms');

/**
 * D11-08's narrow interface — the first CMS interface in this codebase that
 * can reach a queue MUTATION. `cmsEventRoutes.ts`'s own header states what
 * every existing CMS interface deliberately excludes (no queue mutation, no
 * booth-state method); this one is narrower still, on purpose: one read, one
 * write, both on `QueueService`, and no store handle at all. Anything
 * reachable across this interface is reachable by an authenticated operator;
 * anything absent is structurally unreachable — a CMS route cannot write
 * `booth_state` or `pending_print` directly because it was never handed a
 * way to.
 */
export interface CmsBoothLink {
  /**
   * The current stall — the guest at the booth and how long they have been
   * there — or nothing at all when there is no guest to show (IDLE, or the
   * booth is bound but the guest has not yet started their own session).
   */
  getBoothStallInfo(): { jobId: string; guestName: string; waitingSinceMs: number } | null;
  /**
   * Finalizes `jobId` through the operator door (D11-05 door 3) if — and
   * only if — it is still the job that owns the booth. `'wrong_job'` and
   * `'already_finished'` are both races between the page render and the
   * click; neither mutates anything.
   */
  releaseForOperator(jobId: string): 'released' | 'wrong_job' | 'already_finished';
}

/**
 * The CMS booth-release surface (D11-08, BTH-01, BTH-02).
 *
 * Mounted by `createCmsRouter` after `requireSession()`, exactly like
 * `createCmsAgentRoutes` beside it — nothing here re-checks authentication or
 * the CMS IP allow-list, and nothing here adds a CSRF token: the session
 * cookie's `SameSite=Lax` attribute is the recorded CSRF control for every
 * mutating CMS route (`cmsAuth.ts`), and this route inherits it rather than
 * growing a second mechanism for one route.
 */
export function createCmsBoothRoutes(link: CmsBoothLink): ReturnType<typeof Router> {
  const router = Router();

  router.get('/booth', (_req: Request, res: Response) => {
    res.type('html').send(renderCmsBoothPage(link.getBoothStallInfo()));
  });

  /**
   * All-or-nothing, following `validateAgentConfigSubmission`'s rule: exactly
   * one expected field (`jobId`, a non-empty string), and any additional key
   * refuses the WHOLE request rather than being silently dropped — silently
   * ignoring an unexpected field is how an allow-list rots.
   */
  router.post('/api/booth/release', (req: Request, res: Response) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const keys = Object.keys(raw);
    const jobId = raw.jobId;

    if (keys.length !== 1 || keys[0] !== 'jobId' || typeof jobId !== 'string' || jobId.trim() === '') {
      log.warn('Refused booth release: body did not carry exactly one non-empty jobId field');
      res.status(400).json({ error: BOOTH_RELEASE_INVALID });
      return;
    }

    const outcome = link.releaseForOperator(jobId);

    if (outcome === 'wrong_job') {
      res.status(409).json({ error: BOOTH_RELEASE_WRONG_JOB });
      return;
    }

    if (outcome === 'already_finished') {
      res.status(409).json({ error: BOOTH_RELEASE_ALREADY_FINISHED });
      return;
    }

    res.status(200).json({ released: true, message: BOOTH_RELEASE_SUCCESS });
  });

  return router;
}
