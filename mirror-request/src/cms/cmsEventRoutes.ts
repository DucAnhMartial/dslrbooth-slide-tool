import { Router, Request, Response } from 'express';
import { labelLogger } from '../logging/logger';
import { renderCmsDashboardPage } from './cmsPages';
import type { EventSummary } from '../state/localStore';

const log = labelLogger('cms');

/**
 * The narrowest view of LocalStore these routes need — the same
 * router-as-factory discipline `statusRoute.ts` applies with `StatusQueue` /
 * `StatusAgent`. `LocalStore` satisfies this structurally, so `index.ts`
 * passes it unchanged, while a test can drive these routes against a fake.
 *
 * Note what is absent: no queue method, no booth-state method, no
 * registration method. D-01 puts the FIFO queue and the Agent routing built
 * in Phases 1-7 outside this phase's blast radius, and this interface is
 * where that boundary is enforced rather than merely intended — a CMS route
 * cannot reach the queue because it was never handed a way to.
 */
export interface CmsEventStore {
  createEvent(input: { name: string }): EventSummary;
  listEvents(): EventSummary[];
  getEventConfig(id: string): unknown;
  getActiveEventId(): string | undefined;
  setActiveEvent(eventId: string | null): void;
}

const MAX_EVENT_NAME_LENGTH = 80;

/**
 * The session-gated half of the CMS. Mounted by `createCmsRouter` AFTER
 * `requireSession()`, so nothing here re-checks authentication — the
 * ordering in the parent router is the control.
 *
 * Field validation beyond the name is plan 08-03's surface; this plan's
 * routes are the tracer's minimum: list, create, activate.
 */
export function createCmsEventRoutes(store: CmsEventStore): ReturnType<typeof Router> {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    res.type('html').send(
      renderCmsDashboardPage({
        events: store.listEvents(),
        activeEventId: store.getActiveEventId(),
      }),
    );
  });

  router.post('/api/events', (req: Request, res: Response) => {
    const raw = (req.body ?? {}) as { name?: unknown };
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name || name.length > MAX_EVENT_NAME_LENGTH) {
      res.status(400).json({ error: 'Invalid event' });
      return;
    }

    const created = store.createEvent({ name });
    // Template string, never an object — the winston masking formatters only
    // run mask() on strings. Event names are operator-authored, but they are
    // free text and may carry a guest's or a couple's name, so they take the
    // same masked path every guest-data line in this service takes.
    log.info(`Created event ${created.id} ("${created.name}")`);
    res.status(201).json(created);
  });

  router.post('/api/events/:id/activate', (req: Request, res: Response) => {
    const id = req.params.id;
    if (!store.getEventConfig(id)) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    // D-01: replaces the pointer; never appends, never touches the queue.
    // D-02's "N guests still waiting" confirmation is a CMS-side prompt
    // (plan 08-03) — the server deliberately does not refuse the switch.
    store.setActiveEvent(id);
    log.info(`Activated event ${id}`);
    res.status(200).json({ activeEventId: id });
  });

  return router;
}
