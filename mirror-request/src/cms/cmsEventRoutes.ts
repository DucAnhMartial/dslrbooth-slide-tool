import { Router, Request, Response } from 'express';
import { labelLogger } from '../logging/logger';
import { getConfig } from '../config';
import { handleAssetUpload, isStoredAssetUrl } from './uploadHandler';
import {
  renderCmsEventListPage,
  renderCmsEventCreatePage,
  renderCmsEventFormPage,
  renderCmsActivateConfirmPage,
  renderCmsDeleteConfirmPage,
  FONT_CHOICES,
  LAYOUT_STYLES,
  FIELD_CAPS,
  PHOTO_COUNT_RANGE,
  BACKGROUND_OVERLAY_RANGE,
  PHOTO_DURATION_RANGE,
  SAVE_ERROR,
} from './cmsEventPages';
import type { EventConfig } from '../types';
import type { EventSummary, EventUpdatePatch } from '../state/localStore';

const log = labelLogger('cms');

/**
 * The narrowest view of LocalStore these routes need — the same
 * router-as-factory discipline `statusRoute.ts` applies with `StatusQueue` /
 * `StatusAgent`. `LocalStore` satisfies this structurally, so `index.ts`
 * passes it unchanged, while a test can drive these routes against a fake.
 *
 * Note what is absent: no queue MUTATION, no booth-state method, no
 * registration method. D-01 puts the FIFO queue and the Agent routing built
 * in Phases 1-7 outside this phase's blast radius, and this interface is
 * where that boundary is enforced rather than merely intended — a CMS route
 * cannot enqueue, requeue, complete or fail a job because it was never handed
 * a way to.
 *
 * `getQueueLength()` is the one queue-shaped member, and it is a READ. D-02
 * requires the CMS to tell the operator how many guests are still waiting
 * before it switches the live event, which cannot be done without asking. The
 * boundary this interface enforces is "the CMS never writes to the queue", and
 * a count satisfies it: there is no method here that could change a queue row
 * even by accident.
 */
export interface CmsEventStore {
  createEvent(input: { name: string }): EventSummary;
  updateEvent(id: string, patch: EventUpdatePatch): boolean;
  deleteEvent(id: string): { deleted: boolean; photosDeleted: number; wasActive: boolean };
  listEvents(): EventSummary[];
  getEventConfig(id: string): EventConfig | undefined;
  getActiveEventId(): string | undefined;
  setActiveEvent(eventId: string | null): void;
  countEventPhotos(eventId: string): number;
  getQueueLength(): number;
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

/**
 * The event-update field vocabulary, and the validation that stands between an
 * operator's browser and what every TV in the room renders (T-08-17).
 *
 * Each entry validates one value and returns either the column value to write
 * or `undefined`, which refuses the whole save. Every cap and every envelope
 * lives in `cmsEventPages.ts` beside the input attribute that advertises it,
 * so the form and the check below cannot state different limits.
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

/**
 * A capped free-text field. Emptying it writes NULL, which read-time coalescing
 * resolves back to the shipped default — that is what makes "clear this" mean
 * "go back to the default" rather than "render nothing on the wall".
 */
function textField(cap: number): FieldValidator {
  return (raw) => {
    if (raw === null || raw === '') return null;
    if (typeof raw !== 'string') return undefined;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    // The cap is applied to what will be STORED and rendered, after trimming,
    // so trailing whitespace cannot be used to smuggle a longer string past a
    // check that ran on the raw value.
    return trimmed.length <= cap ? trimmed : undefined;
  };
}

/** The event name is the one text field that may not be emptied. */
const nameField: FieldValidator = (raw) => {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= FIELD_CAPS.name ? trimmed : undefined;
};

/**
 * Exactly six hex digits after a `#`, and nothing else.
 *
 * These values are written into CSS custom properties on the room screen, so
 * the accepted grammar is deliberately narrower than CSS's own: `red` and
 * `rgb(0,0,0)` are perfectly valid CSS and are refused here anyway, because a
 * permissive colour parser at this boundary is a CSS-injection surface and a
 * six-digit hex is all the colour picker in the form can produce.
 */
const colorField: FieldValidator = (raw) => {
  if (raw === null || raw === '') return null;
  if (typeof raw !== 'string') return undefined;
  return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw.toLowerCase() : undefined;
};

/** An enumerated value, refused rather than coerced when unknown. */
function enumField(values: readonly string[]): FieldValidator {
  return (raw) => (typeof raw === 'string' && values.includes(raw) ? raw : undefined);
}

/**
 * D9-04: a real JSON boolean, mapped to 1 or 0 — nothing else. The form's
 * `collect()` always submits a genuine boolean for a checkbox input, so a
 * string (`"true"`), a number, or `null` is refused rather than coerced: a
 * permissive parser at this boundary would let a hand-built request write a
 * value the column's domain does not have (T-09-08).
 *
 * This validator must NEVER return `null`. `show_guest_name` and
 * `hero_enabled` are both `INTEGER NOT NULL`, and `updateEvent()` maps
 * `patch[column] ?? null` — a null-yielding validator here would turn a
 * legitimate save into a database constraint error mid-event (T-09-09).
 * Refusing the whole patch (returning `undefined`) is what
 * `validateEventPatch()` treats as "write nothing"; only `1` or `0` reach the
 * database.
 */
const boolField: FieldValidator = (raw) => (typeof raw === 'boolean' ? (raw ? 1 : 0) : undefined);

/**
 * A bounded integer. Out of range is REFUSED, never clamped: a silent clamp
 * leaves the operator's form and the room screen disagreeing about what was
 * saved, and the operator finds out from the wall rather than from the CMS.
 *
 * `null` is not accepted — these two fields always have a value, the form
 * always submits one, and "no photo count" is not a state the screen can
 * render.
 */
function intField(range: { min: number; max: number }): FieldValidator {
  return (raw) => {
    if (typeof raw !== 'number' || !Number.isInteger(raw)) return undefined;
    return raw >= range.min && raw <= range.max ? raw : undefined;
  };
}

const FIELD_VALIDATORS: Record<string, FieldValidator> = {
  name: nameField,
  logo_url: assetUrlField,
  background_url: assetUrlField,
  qr_image_url: assetUrlField,
  color_dominant: colorField,
  color_secondary: colorField,
  color_accent: colorField,
  color_text: colorField,
  color_text_muted: colorField,
  font_choice: enumField(FONT_CHOICES),
  layout_style: enumField(LAYOUT_STYLES),
  idle_heading: textField(FIELD_CAPS.idle_heading),
  idle_sub: textField(FIELD_CAPS.idle_sub),
  qr_cta_text: textField(FIELD_CAPS.qr_cta_text),
  photo_count: intField(PHOTO_COUNT_RANGE),
  photo_duration_ms: intField(PHOTO_DURATION_RANGE),
  background_overlay: intField(BACKGROUND_OVERLAY_RANGE),
  show_guest_name: boolField,
  hero_enabled: boolField,
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
 * Page routes render HTML; every mutation is a JSON POST under /api/. The
 * split is deliberate: the pages are progressive-enhancement shells and the
 * mutations are the contract the tests drive.
 */
export function createCmsEventRoutes(
  store: CmsEventStore,
  opts: CmsEventRouteOptions = {},
): ReturnType<typeof Router> {
  const router = Router();
  const uploadDir = opts.uploadDir ?? getConfig().CMS_UPLOAD_DIR;
  const maxBytes = opts.maxBytes ?? getConfig().CMS_UPLOAD_MAX_BYTES;

  function renderList(res: Response): void {
    res.type('html').send(
      renderCmsEventListPage({
        events: store.listEvents(),
        activeEventId: store.getActiveEventId(),
      }),
    );
  }

  // `/` and `/events` are the same page. The operator lands on the event
  // library after login rather than on a separate dashboard, because the
  // library IS the dashboard — every CMS action starts by choosing an event.
  router.get('/', (_req: Request, res: Response) => renderList(res));
  router.get('/events', (_req: Request, res: Response) => renderList(res));

  // Before '/events/:id', or 'new' would be read as an event id.
  router.get('/events/new', (_req: Request, res: Response) => {
    res.type('html').send(renderCmsEventCreatePage());
  });

  router.get('/events/:id', (req: Request, res: Response) => {
    const event = store.getEventConfig(req.params.id);
    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }
    const notice =
      req.query.saved !== undefined ? 'saved' : req.query.error !== undefined ? 'error' : undefined;
    res.type('html').send(renderCmsEventFormPage({ event, notice }));
  });

  router.post('/api/events', (req: Request, res: Response) => {
    const raw = (req.body ?? {}) as { name?: unknown };
    const name = nameField(raw.name);
    if (typeof name !== 'string') {
      res.status(400).json({ error: SAVE_ERROR });
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

  /**
   * D-02's confirmation view. Reads the LIVE queue length so the operator is
   * told how many guests are still waiting before the screens change under
   * them — the compensating control that replaces a block (T-08-18).
   */
  router.get('/events/:id/activate', (req: Request, res: Response) => {
    const event = store.listEvents().find((candidate) => candidate.id === req.params.id);
    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }
    res.type('html').send(
      renderCmsActivateConfirmPage({
        event,
        queueLength: store.getQueueLength(),
        alreadyActive: store.getActiveEventId() === event.id,
      }),
    );
  });

  router.get('/events/:id/delete', (req: Request, res: Response) => {
    const event = store.listEvents().find((candidate) => candidate.id === req.params.id);
    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }
    res.type('html').send(
      renderCmsDeleteConfirmPage({
        event,
        photoCount: store.countEventPhotos(event.id),
        isActive: store.getActiveEventId() === event.id,
      }),
    );
  });

  router.post('/api/events/:id/activate', (req: Request, res: Response) => {
    const id = req.params.id;
    if (!store.getEventConfig(id)) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    /**
     * D-02, enforced HERE and not in a dialog.
     *
     * With guests still queued the switch needs an explicit confirmation, and
     * the confirmation has to be carried in the request — a browser dialog is
     * a suggestion, and the mid-event operator this protects is exactly the
     * person most likely to be driving a second tab, a bookmarked URL, or a
     * page restored from history.
     *
     * What it is NOT is a block. The refusal below is conditional on the
     * caller not having confirmed, never on the queue being non-empty:
     * `confirmed: true` always proceeds. Blocking until the queue drained was
     * rejected on measured evidence — a ticket once sat queued with nobody to
     * shoot it, and a CMS that refuses to switch until that clears is a CMS
     * that is unusable exactly when the room is busiest.
     */
    const waitingGuests = store.getQueueLength();
    const confirmed = ((req.body ?? {}) as { confirmed?: unknown }).confirmed === true;
    if (waitingGuests > 0 && !confirmed) {
      log.info(`Active-event switch to ${id} needs confirmation — ${waitingGuests} guests still waiting`);
      res.status(409).json({ error: 'Confirmation required', waitingGuests });
      return;
    }

    // D-01: replaces the pointer; never appends. Nothing below this line reads
    // or writes queue_job or booth_state — the waiting guests are still served.
    store.setActiveEvent(id);
    // One masked line per switch is the audit trail T-08-18 accepts in place
    // of a block.
    log.info(`Activated event ${id} with ${waitingGuests} guests still waiting`);
    res.status(200).json({ activeEventId: id });
  });

  /**
   * D-11's one deletion path, behind the UI-SPEC's typed confirmation.
   *
   * The operator retypes the event's name, exactly, and the SERVER compares
   * it. Typing the name rather than clicking "yes" is what makes deleting the
   * wrong event require a mistake about the name rather than a mis-click, and
   * checking it here rather than in the page is what makes it a control.
   */
  router.post('/api/events/:id/delete', (req: Request, res: Response) => {
    const id = req.params.id;
    const event = store.listEvents().find((candidate) => candidate.id === id);
    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    const typed = ((req.body ?? {}) as { confirmName?: unknown }).confirmName;
    if (typeof typed !== 'string' || typed.trim() !== event.name) {
      res.status(400).json({ error: 'Confirmation does not match' });
      return;
    }

    const result = store.deleteEvent(id);
    log.info(
      `Deleted event ${id} and ${result.photosDeleted} photo history rows` +
        (result.wasActive ? ' — it was the active event, screens return to the shipped defaults' : ''),
    );
    res.status(200).json({ deleted: result.deleted, photosDeleted: result.photosDeleted });
  });

  return router;
}
