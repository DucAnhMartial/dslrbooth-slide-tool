import { Router, Request, Response } from 'express';
import { labelLogger } from '../logging/logger';
import {
  PHOTOS_PER_PAGE,
  renderCmsPhotoHistoryPage,
  renderCmsClearHistoryConfirmPage,
  renderCmsDeletePhotoConfirmPage,
} from './cmsPhotoPages';
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
  getEventPhoto(
    jobId: string,
  ): { jobId: string; eventId: string; photoUrl: string; guestName: string; capturedAt: number } | undefined;
  deleteEventPhoto(jobId: string): boolean;
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

  /**
   * The confirmation view. A GET, and it changes nothing — the operator has to
   * arrive here, read the count, and type the event's name before anything is
   * destroyed.
   */
  router.get('/photos/clear', (req: Request, res: Response) => {
    const requested = typeof req.query.event === 'string' ? req.query.event : '';
    const event = store.listEvents().find((candidate) => candidate.id === requested);
    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }
    res.type('html').send(
      renderCmsClearHistoryConfirmPage({ event, photoCount: store.countEventPhotos(event.id) }),
    );
  });

  /**
   * D-11's ONLY deletion path for photo history, and the only one that may
   * ever exist.
   *
   * Photo history is kept per event and removed by HAND. There is no expiry,
   * no row cap, no scheduled cleanup and no delete-on-event-switch anywhere in
   * this service, and none may be added — here or elsewhere. These rows are a
   * guest-facing record of a real person's photograph, and the operator, not a
   * timer, owns when a wedding's photos stop existing. Because D-10 stores
   * URLs rather than image bytes, the table does not grow expensively, so
   * there is no operational argument for a cap either. `pending_print`'s
   * header states the same rule for its own rows and for the same reason; a
   * later change that adds a sweep here is reversing a locked decision, not
   * tidying up.
   *
   * The confirmation is enforced HERE and not in a dialog. The operator
   * retypes the event's name and the server compares it, so clearing the wrong
   * wedding's history requires a mistake about its name rather than a
   * mis-click — and a request that skips the page entirely (a second tab, a
   * replayed fetch, a forged cross-site post) has nothing to piggyback on.
   */
  router.post('/api/photos/clear', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { eventId?: unknown; confirmName?: unknown };
    const eventId = typeof body.eventId === 'string' ? body.eventId : '';
    const event = store.listEvents().find((candidate) => candidate.id === eventId);
    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    const typed = body.confirmName;
    if (typeof typed !== 'string' || typed.trim() !== event.name) {
      // Unconfirmed is not an error to apologise for — it is the confirmation
      // view again, with the mismatch stated. Nothing is deleted on this path.
      res
        .status(400)
        .type('html')
        .send(
          renderCmsClearHistoryConfirmPage({
            event,
            photoCount: store.countEventPhotos(event.id),
            error: true,
          }),
        );
      return;
    }

    const deleted = store.deleteEventPhotos(event.id);
    // One line per clear: the event id and the count, and no guest name. A
    // template string so the winston masking formatters run (T-08-25) — the
    // audit trail for an irreversible act, not a record of who was in it.
    cmsPhotoLogger.info(
      `Cleared photo history for event ${event.id} — ${deleted} rows deleted by a confirmed operator action`,
    );
    res.status(200).json({ cleared: true, deleted });
  });

  /**
   * The confirmation view for deleting ONE photo (CMS-05).
   *
   * Why a page and not a one-click button in the table: the history table's
   * rows are 44px tall and thumbnails sit next to each other, so a stray click
   * on a touchscreen at an event would otherwise destroy a guest's photograph
   * with no way back. The confirmation shows the same thumbnail, name and time
   * the row showed, so the operator confirms against the photo rather than
   * against a job id they cannot read.
   *
   * Unlike the clear-everything path there is NO retyped name. That
   * confirmation is proportionate to erasing a whole wedding; demanding it to
   * remove one failed capture would train the operator to type event names
   * without reading, which weakens the control that actually matters.
   */
  router.get('/photos/delete', (req: Request, res: Response) => {
    const jobId = typeof req.query.job === 'string' ? req.query.job : '';
    const photo = jobId ? store.getEventPhoto(jobId) : undefined;
    if (!photo) {
      res.status(404).json({ error: 'Photo not found' });
      return;
    }
    // The row is the authority on which event it belongs to — never the query
    // string, which the operator's browser did not necessarily set.
    const event = store.listEvents().find((candidate) => candidate.id === photo.eventId);
    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }
    res.type('html').send(renderCmsDeletePhotoConfirmPage({ event, photo }));
  });

  /**
   * Deletes one photo row. The second hand-driven deletion path, and not a
   * relaxation of D-11: that decision forbids AUTOMATIC removal — no expiry,
   * no row cap, no scheduled cleanup, no delete-on-event-switch — and requires
   * that a human decides when a guest's photograph stops existing. This is a
   * human deciding, one row at a time.
   *
   * It exists because the only tool an operator had for a single failed
   * capture was clearing the entire event's history.
   */
  router.post('/api/photos/delete', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { jobId?: unknown };
    const jobId = typeof body.jobId === 'string' ? body.jobId : '';
    const photo = jobId ? store.getEventPhoto(jobId) : undefined;
    if (!photo) {
      // Already gone is not a fault: two operators closing the same broken
      // capture, or a double-submitted form, both land here.
      res.status(404).json({ error: 'Photo not found' });
      return;
    }

    const deleted = store.deleteEventPhoto(jobId);
    // One line per deletion, and NO guest name — the same rule the clear-all
    // line follows (T-08-25). A template string so the masking formatters run.
    cmsPhotoLogger.info(
      `Deleted one photo from event ${photo.eventId} — job ${jobId}, by a confirmed operator action`,
    );
    res.status(200).json({ deleted });
  });

  return router;
}
