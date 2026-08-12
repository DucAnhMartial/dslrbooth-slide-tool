import { Router, Request, Response } from 'express';
import { labelLogger } from '../logging/logger';
import { PHOTOS_PER_PAGE, renderCmsPhotoHistoryPage } from './cmsPhotoPages';
import type { EventSummary } from '../state/localStore';

/**
 * Exported so a test can spy on exactly the lines this surface emits, the way
 * `queueLogger` is exported for the upload path. The label is shared with the
 * rest of the CMS: an operator greps `[cms]`, not a per-file label.
 */
export const cmsPhotoLogger = labelLogger('cms');

/**
 * The narrowest view of `LocalStore` this surface needs.
 *
 * Note what is absent: `recordEventPhoto` is not here, and neither is any
 * queue, booth or registration method. The CMS reads photo history and — on one
 * confirmed operator action — clears it. It cannot write a photo row, and it
 * cannot reach a guest who is still waiting to be photographed (D-01).
 *
 * Reads go through `listEventPhotos` / `countEventPhotos` rather than raw row
 * access, which is what keeps internal columns off this page (T-08-29) — the
 * same no-raw-rows discipline the display snapshot already follows.
 */
export interface CmsPhotoStore {
  listEvents(): EventSummary[];
  getActiveEventId(): string | undefined;
  listEventPhotos(
    eventId: string,
    opts: { limit: number; offset: number },
  ): Array<{ jobId: string; photoUrl: string; guestName: string; capturedAt: number }>;
  countEventPhotos(eventId: string): number;
  deleteEventPhotos(eventId: string): number;
}

/**
 * Parses `?page=`, and refuses to trust it.
 *
 * Anything that is not a whole number at or above 1 is page one. The clamp is
 * not politeness: the offset derived from this value is bound straight into
 * SQLite, so an unparsed `1e999` or a negative would otherwise reach the query
 * as `NaN`/`-Infinity` — a 500 handed to anyone who can type in the URL bar.
 */
export function parsePageParam(raw: unknown): number {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d+$/.test(text)) return 1;
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return 1;
  return parsed;
}

/**
 * The CMS photo-history surface (CMS-03, CMS-04, D-10, D-11).
 *
 * Mounted by `createCmsRouter` AFTER `requireSession()`, so nothing here
 * re-checks authentication — the ordering in the parent router is the control,
 * exactly as it is for the event and Agent routes. The IP layer sits in front
 * of that router in `index.ts`, so a refused address never reaches this code.
 */
export function createCmsPhotoRoutes(store: CmsPhotoStore): ReturnType<typeof Router> {
  const router = Router();

  /**
   * Resolves which event's history is being asked for: the explicit `?event=`,
   * otherwise whichever event is live. Falling back to the active event is what
   * makes the bare `/cms/photos` link usable mid-event, when the operator's
   * question is about the wedding happening in front of them.
   */
  function resolveEvent(req: Request): { event?: EventSummary; missing: boolean } {
    const events = store.listEvents();
    const requested = typeof req.query.event === 'string' ? req.query.event : undefined;
    const targetId = requested ?? store.getActiveEventId();
    if (!targetId) return { missing: false };
    const event = events.find((candidate) => candidate.id === targetId);
    // An id that was ASKED for and does not exist is a stale bookmark and is
    // reported as such; a dangling ACTIVE pointer is not the operator's fault
    // and simply resolves to no selection.
    return { event, missing: event === undefined && requested !== undefined };
  }

  router.get('/photos', (req: Request, res: Response) => {
    const events = store.listEvents();
    const { event, missing } = resolveEvent(req);

    if (missing) {
      // A template string, never an object — the winston masking formatters
      // only run on strings (T-08-25). No guest name is in scope here anyway;
      // the discipline is the point, not this particular line.
      cmsPhotoLogger.warn(
        `Photo history requested for event ${String(req.query.event)}, which no longer exists`,
      );
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    if (!event) {
      res.type('html').send(
        renderCmsPhotoHistoryPage({ events, rows: [], total: 0, page: 1, totalPages: 0 }),
      );
      return;
    }

    const total = store.countEventPhotos(event.id);
    const totalPages = Math.ceil(total / PHOTOS_PER_PAGE);
    const page = parsePageParam(req.query.page);

    // A page past the end is never queried at all. Computing its offset and
    // asking anyway would push an arbitrarily large integer into the bind
    // parameter for no rows in return.
    const rows =
      page > totalPages
        ? []
        : store.listEventPhotos(event.id, {
            limit: PHOTOS_PER_PAGE,
            offset: (page - 1) * PHOTOS_PER_PAGE,
          });

    res.type('html').send(
      renderCmsPhotoHistoryPage({ events, event, rows, total, page, totalPages }),
    );
  });

  return router;
}
