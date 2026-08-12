import { Router, Request, Response } from 'express';
import { labelLogger } from '../logging/logger';
import { getConfig } from '../config';
import { renderCmsDashboardPage } from './cmsPages';
import { handleAssetUpload, isStoredAssetUrl } from './uploadHandler';
import type { EventConfig } from '../types';
import type { EventSummary, EventUpdatePatch } from '../state/localStore';

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
  updateEvent(id: string, patch: EventUpdatePatch): boolean;
  listEvents(): EventSummary[];
  getEventConfig(id: string): EventConfig | undefined;
  getActiveEventId(): string | undefined;
  setActiveEvent(eventId: string | null): void;
}

/**
 * Where uploaded assets land, and how big one may be. Both default to the
 * process config — the same `opts ?? getConfig()` seam `DisplayServer`'s
 * constructor uses — so `index.ts` needs no new wiring, while a test can point
 * one router at its own temporary directory instead of the real one.
 */
export interface CmsEventRouteOptions {
  uploadDir?: string;
  maxBytes?: number;
}

const MAX_EVENT_NAME_LENGTH = 80;

/**
 * UI-SPEC's save-failure copy, verbatim. Defined here rather than in the page
 * module because the JSON save route is the first thing that needs it; the
 * page module imports it so the string the API returns and the string the
 * browser renders can never drift into two slightly different apologies.
 */
export const SAVE_ERROR = 'Không lưu được cấu hình — vui lòng thử lại. Nếu vẫn lỗi, liên hệ kỹ thuật.';
export const SAVE_SUCCESS = 'Đã lưu cấu hình sự kiện';

/**
 * The event-update field vocabulary, and the validation that stands between an
 * operator's browser and what every TV in the room renders.
 *
 * Plan 08-03 Task 1 covers the three uploaded-asset URLs; the remaining CMS-01
 * fields join this table in Task 2. Each entry validates a value and returns
 * either the column value to write or `undefined` for "refuse the whole save".
 */
type FieldValidator = (raw: unknown) => string | number | null | undefined;

/**
 * An asset URL must be one this service itself minted. `null` (a cleared logo)
 * is allowed; anything else — an absolute URL, a `data:` URL, a
 * `javascript:` URL, a path with segments — is refused outright rather than
 * sanitised, because the accepted set is small enough to state exactly and
 * these strings become an `<img src>` on every screen in the room.
 */
const assetUrlField: FieldValidator = (raw) => {
  if (raw === null || raw === '') return null;
  if (typeof raw !== 'string') return undefined;
  return isStoredAssetUrl(raw) ? raw : undefined;
};

const FIELD_VALIDATORS: Record<string, FieldValidator> = {
  logo_url: assetUrlField,
  background_url: assetUrlField,
  qr_image_url: assetUrlField,
};

/**
 * Validates one whole save. Refuses the ENTIRE patch when any field is
 * invalid, rather than dropping the bad field and writing the rest: a save
 * that silently discarded one value would leave the operator looking at a form
 * that disagrees with the screen, mid-event, with no error to explain it.
 */
export function validateEventPatch(
  raw: Record<string, unknown>,
): { ok: true; patch: EventUpdatePatch } | { ok: false } {
  const patch: EventUpdatePatch = {};
  for (const [key, value] of Object.entries(raw)) {
    const validator = FIELD_VALIDATORS[key];
    // An unknown key is ignored, never written — the writable column set is
    // this table plus localStore's own allow-list, and neither is derived from
    // the request.
    if (!validator) continue;
    const validated = validator(value);
    if (validated === undefined) return { ok: false };
    (patch as Record<string, string | number | null>)[key] = validated;
  }
  return { ok: true, patch };
}

/**
 * The session-gated half of the CMS. Mounted by `createCmsRouter` AFTER
 * `requireSession()`, so nothing here re-checks authentication — the
 * ordering in the parent router is the control.
 *
 * Field validation beyond the name is plan 08-03's surface; this plan's
 * routes are the tracer's minimum: list, create, activate.
 */
export function createCmsEventRoutes(
  store: CmsEventStore,
  opts: CmsEventRouteOptions = {},
): ReturnType<typeof Router> {
  const router = Router();
  const uploadDir = opts.uploadDir ?? getConfig().CMS_UPLOAD_DIR;
  const maxBytes = opts.maxBytes ?? getConfig().CMS_UPLOAD_MAX_BYTES;

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

  /**
   * D-15's upload endpoint. Everything that makes it safe lives in
   * `handleAssetUpload` — this line's only job is to mount it inside the
   * session-gated half of the router, which is what makes the upload
   * authenticated (T-08-16).
   */
  router.post('/api/assets', handleAssetUpload({ uploadDir, maxBytes }));

  /**
   * The event save. Applies one validated patch, or refuses the whole thing —
   * see validateEventPatch() for why a partial write is worse than an error.
   */
  router.post('/api/events/:id', (req: Request, res: Response) => {
    const id = req.params.id;
    if (!store.getEventConfig(id)) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    const result = validateEventPatch((req.body ?? {}) as Record<string, unknown>);
    if (!result.ok) {
      res.status(400).json({ error: SAVE_ERROR });
      return;
    }

    if (Object.keys(result.patch).length > 0) store.updateEvent(id, result.patch);
    log.info(`Saved configuration for event ${id}`);
    res.status(200).json({ id, saved: true });
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
