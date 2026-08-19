import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { getConfig } from '../config';
import logger from '../logging/logger';
import type { Registration, QueueJob, BoothState, NotificationRecord, EventConfig } from '../types';

const CONFIG = getConfig();

/**
 * UI-01's guarantee, expressed as data: what the room screen renders when no
 * event is active, and what every field of a brand-new, entirely
 * uncustomized event falls back to. "The idle screen renders correctly before
 * any request exists" is not a special first-boot case here — it is the
 * ordinary read path with every column NULL.
 *
 * Values are the 08-UI-SPEC contract: the Room Screen default theme, the
 * Room Screen default copy table, and the single shipped layout
 * (`stage_sidebar` — Open Question 2 ships exactly one layout this phase,
 * with the field present so later layouts need no migration).
 *
 * The two operational status colours (#a33127 destructive, #34d399 success)
 * are deliberately ABSENT from this object. They are fixed, non-themeable,
 * and live in the room-screen stylesheet, because an event's branding must
 * never be able to hide an Agent fault behind a colour that reads as normal.
 *
 * `id: null` means "no event is active" — a legitimate steady state, not an
 * error.
 */
export const DEFAULT_EVENT_CONFIG: EventConfig = Object.freeze({
  id: null,
  name: 'Photo Booth',
  logoUrl: null,
  backgroundUrl: null,
  colorDominant: '#0a0a0f',
  colorSecondary: '#13131a',
  colorAccent: '#6c8fff',
  colorText: '#f5f5f7',
  colorTextMuted: '#9a9aa8',
  fontChoice: 'system-ui',
  idleHeading: 'Sẵn sàng chụp ảnh cùng bạn',
  idleSub: 'Quét mã QR bên dưới để đăng ký',
  qrImageUrl: null,
  qrCtaText: 'Quét mã QR bên dưới để đăng ký',
  photoCount: 12,
  photoDurationMs: 6000,
  layoutStyle: 'stage_sidebar',
  // D9-04: both default ON — see the field comments on EventConfig itself.
  showGuestName: true,
  guestNameTemplate: '{guest_name}',
  captionPosition: 'bottom-left',
  photoFit: 'contain',
  customCss: '',
  heroEnabled: true,
  /* CMS-10: how strongly the event background is dimmed, 0-100.
     72 is what both room screens hard-coded before this was configurable, so
     an existing event looks identical until someone changes it. It is a
     SETTING rather than a constant because the right value is a property of
     the customer's artwork, not of this software: a dark, low-contrast
     backdrop wants 0 and a bright wedding portrait behind white type still
     wants most of 72. The operator can see their own screen; this code
     cannot. */
  backgroundOverlay: 72,
});

/** The raw `event` row shape. Never leaves this module — see toEventConfig(). */
interface EventRow {
  id: string;
  name: string;
  logo_url: string | null;
  background_url: string | null;
  color_dominant: string | null;
  color_secondary: string | null;
  color_accent: string | null;
  color_text: string | null;
  color_text_muted: string | null;
  font_choice: string | null;
  idle_heading: string | null;
  idle_sub: string | null;
  qr_image_url: string | null;
  qr_cta_text: string | null;
  photo_count: number | null;
  photo_duration_ms: number | null;
  layout_style: string | null;
  // D9-04/D9-05: NOT NULL DEFAULT 1 at the schema level (unlike every other
  // presentation column above), so `number | null` here is defence-in-depth
  // against a hand-edited row, not an expected state — see toEventConfig().
  show_guest_name: number | null;
  guest_name_template: string | null;
  caption_position: string | null;
  photo_fit: string | null;
  custom_css: string | null;
  background_overlay: number | null;
  hero_enabled: number | null;
  created_at: number;
  updated_at: number;
}

/**
 * The single row -> wire projection for event configuration, and the only
 * place a NULL column becomes a shipped default.
 *
 * Its narrowness is the point (the same discipline `buildSnapshot()`'s header
 * comment pins for `queue_job`): `created_at`/`updated_at` are operator
 * bookkeeping and are dropped here rather than filtered out downstream, so a
 * future column added to `event` for the CMS cannot ride out to every TV just
 * because someone widened a SELECT.
 */
function toEventConfig(row: EventRow): EventConfig {
  return {
    id: row.id,
    name: row.name,
    logoUrl: row.logo_url,
    backgroundUrl: row.background_url,
    colorDominant: row.color_dominant ?? DEFAULT_EVENT_CONFIG.colorDominant,
    colorSecondary: row.color_secondary ?? DEFAULT_EVENT_CONFIG.colorSecondary,
    colorAccent: row.color_accent ?? DEFAULT_EVENT_CONFIG.colorAccent,
    colorText: row.color_text ?? DEFAULT_EVENT_CONFIG.colorText,
    colorTextMuted: row.color_text_muted ?? DEFAULT_EVENT_CONFIG.colorTextMuted,
    fontChoice: row.font_choice ?? DEFAULT_EVENT_CONFIG.fontChoice,
    idleHeading: row.idle_heading ?? DEFAULT_EVENT_CONFIG.idleHeading,
    idleSub: row.idle_sub ?? DEFAULT_EVENT_CONFIG.idleSub,
    qrImageUrl: row.qr_image_url,
    qrCtaText: row.qr_cta_text ?? DEFAULT_EVENT_CONFIG.qrCtaText,
    photoCount: row.photo_count ?? DEFAULT_EVENT_CONFIG.photoCount,
    photoDurationMs: row.photo_duration_ms ?? DEFAULT_EVENT_CONFIG.photoDurationMs,
    layoutStyle: row.layout_style ?? DEFAULT_EVENT_CONFIG.layoutStyle,
    // D9-04: NULL (a hand-edited row only — the column is NOT NULL) takes the
    // shipped default; any other value is compared against 0 rather than
    // tested for truthiness, so a stray non-zero-non-one value still reads as
    // ON rather than silently falling through to a default it did not ask for.
    showGuestName: row.show_guest_name === null ? DEFAULT_EVENT_CONFIG.showGuestName : row.show_guest_name !== 0,
    guestNameTemplate: row.guest_name_template ?? DEFAULT_EVENT_CONFIG.guestNameTemplate,
    captionPosition: row.caption_position === 'top-left' || row.caption_position === 'top-center' || row.caption_position === 'top-right' || row.caption_position === 'middle-left' || row.caption_position === 'middle-center' || row.caption_position === 'middle-right' || row.caption_position === 'bottom-left' || row.caption_position === 'bottom-center' || row.caption_position === 'bottom-right'
      ? row.caption_position as EventConfig['captionPosition']
      : DEFAULT_EVENT_CONFIG.captionPosition,
    photoFit: row.photo_fit === 'cover' || row.photo_fit === 'contain' || row.photo_fit === 'contain_blur'
      ? row.photo_fit
      : DEFAULT_EVENT_CONFIG.photoFit,
    customCss: row.custom_css ?? DEFAULT_EVENT_CONFIG.customCss,
    // Clamped on the way OUT as well as on the way in: a hand-edited database
    // or a rolled-back deploy must not be able to put an out-of-range number
    // into a CSS opacity on every TV.
    backgroundOverlay:
      row.background_overlay === null || row.background_overlay === undefined
        ? DEFAULT_EVENT_CONFIG.backgroundOverlay
        : Math.min(100, Math.max(0, Math.round(row.background_overlay))),
    heroEnabled: row.hero_enabled === null ? DEFAULT_EVENT_CONFIG.heroEnabled : row.hero_enabled !== 0,
  };
}

/**
 * Every `event` column the CMS may write, and the complete SET-clause
 * vocabulary of updateEvent(). `id`, `created_at` and `updated_at` are absent
 * deliberately: an event's identity and its bookkeeping are the store's, not
 * the operator's.
 */
const EVENT_UPDATABLE_COLUMNS = [
  'name',
  'logo_url',
  'background_url',
  'color_dominant',
  'color_secondary',
  'color_accent',
  'color_text',
  'color_text_muted',
  'font_choice',
  'idle_heading',
  'idle_sub',
  'qr_image_url',
  'qr_cta_text',
  'photo_count',
  'photo_duration_ms',
  'layout_style',
  // D9-04: plan 09-02's CMS save writes these. The validator for both must
  // never yield null — the columns are NOT NULL DEFAULT 1, unlike every
  // other column in this list, which are nullable-on-purpose (see the
  // `event` table's own header comment above).
  'show_guest_name',
  'guest_name_template',
  'caption_position',
  'photo_fit',
  'custom_css',
  'background_overlay',
  'hero_enabled',
] as const;

export type EventUpdatableColumn = (typeof EVENT_UPDATABLE_COLUMNS)[number];

/** A partial patch over the writable event columns. */
export type EventUpdatePatch = Partial<Record<EventUpdatableColumn, string | number | null>>;

/** The operator-facing summary the CMS event list renders. */
export interface EventSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export class LocalStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolved = path.resolve(dbPath ?? CONFIG.LOCAL_STORE_PATH);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    this.db = new Database(resolved);
    this.db.pragma('journal_mode = WAL');
    this.bootstrap();
    this.migrate();
    // After migrate(), never before — see createIndexes()'s header.
    this.createIndexes();
  }

  bootstrap(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS registration (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT NOT NULL,
        mode TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        raw_payload TEXT,
        received_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS queue_job (
        id TEXT PRIMARY KEY,
        registration_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        queued_at INTEGER NOT NULL,
        dispatched_at INTEGER,
        acknowledged_at INTEGER,
        session_started_at INTEGER,
        session_ended_at INTEGER,
        completed_at INTEGER,
        ack_error_message TEXT,
        stall_reason TEXT,
        retries INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS processed_id (
        reg_id TEXT PRIMARY KEY,
        processed_at TEXT NOT NULL DEFAULT 'now'
      );
      CREATE TABLE IF NOT EXISTS db_poll_cursor (
        poll_key TEXT PRIMARY KEY,
        last_value TEXT NOT NULL,
        updated_at TEXT DEFAULT 'now'
      );
      CREATE TABLE IF NOT EXISTS notification_record (
      jobId TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      lastError TEXT,
      photoUrl TEXT,
      dueAt INTEGER,
      updatedAt TEXT NOT NULL DEFAULT 'now'
    );
    CREATE TABLE IF NOT EXISTS booth_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state TEXT NOT NULL DEFAULT 'IDLE',
        updated_at TEXT NOT NULL DEFAULT 'now'
      );
      CREATE TABLE IF NOT EXISTS webhook_replay (
        webhook_id TEXT PRIMARY KEY,
        received_at INTEGER NOT NULL
      );
      -- D-07/D-08's pending-print registry: the durable slot for a photo that
      -- has not arrived yet. A brand-new table, so it belongs here under
      -- CREATE TABLE IF NOT EXISTS — this file's idempotency mechanism for new
      -- tables — rather than in migrate(), which is for new columns on
      -- existing ones.
      --
      -- The naming register is booth_state's, not notification_record's: a
      -- camelCase jobId alongside snake_case timestamp columns, matching
      -- booth_state's (state, updated_at) above.
      --
      -- The status vocabulary is exactly three words: 'awaiting', 'resolved',
      -- 'expired'. An expired row is MARKED, NEVER DELETED, and no cleanup or
      -- DELETE path may be added anywhere. That row is the only evidence that
      -- distinguishes D-11's late-but-legitimate print (a slot was opened for
      -- this job and expired — deliver it anyway, and warn) from D-04's
      -- out-of-session photo (no slot was ever opened — drop it, and warn).
      -- Deleting expired rows would collapse those two cases into one and make
      -- it impossible to honour both decisions.
      CREATE TABLE IF NOT EXISTS pending_print (
        jobId          TEXT PRIMARY KEY,
        composite_path TEXT,
        status         TEXT NOT NULL DEFAULT 'awaiting',
        opened_at      INTEGER NOT NULL,
        expires_at     INTEGER NOT NULL,
        resolved_at    INTEGER,
        updated_at     TEXT NOT NULL DEFAULT 'now'
      );
      -- Phase 8 / CMS-01: the library of saved event configurations. D-01
      -- rules that "one server, several events" means MANY saved rows here
      -- with exactly ONE active at a time (see active_event below) — NOT
      -- concurrent live events. Nothing in this table joins to queue_job or
      -- booth_state: the global FIFO queue built in Phases 1-7 is untouched
      -- by this phase, and no existing table gains, loses, or changes a
      -- column for it.
      --
      -- Every presentation column except name is NULLABLE on purpose. NULL
      -- means "this event never customized this field", and reads coalesce it
      -- onto DEFAULT_EVENT_CONFIG at projection time rather than at write
      -- time. That is what lets a shipped default be corrected later and
      -- immediately apply to every uncustomized event, instead of being
      -- frozen into rows written before the correction. font_choice and
      -- layout_style are the two exceptions: they carry SQL-level defaults
      -- because they are enumerated values the CMS form always submits.
      CREATE TABLE IF NOT EXISTS event (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL,
        logo_url          TEXT,
        background_url    TEXT,
        color_dominant    TEXT,
        color_secondary   TEXT,
        color_accent      TEXT,
        color_text        TEXT,
        color_text_muted  TEXT,
        font_choice       TEXT NOT NULL DEFAULT 'system-ui',
        idle_heading      TEXT,
        idle_sub          TEXT,
        qr_image_url      TEXT,
        qr_cta_text       TEXT,
        photo_count       INTEGER,
        photo_duration_ms INTEGER,
        layout_style      TEXT NOT NULL DEFAULT 'stage_sidebar',
        -- D9-04/D9-05 (phase 9): the two per-event display toggles, and the
        -- first columns on this table that are NOT NULL-on-purpose rather
        -- than nullable-on-purpose. A toggle has exactly two states, so
        -- there is no "unset" reading to coalesce at projection time the way
        -- the nullable columns above do — DEFAULT 1 (ON) at the schema level
        -- IS the "never customized" reading. See migrate() below for how
        -- these two land on a database that predates this phase: Phase 8
        -- shipped zero ALTER TABLE on this table, so this is the first.
        show_guest_name   INTEGER NOT NULL DEFAULT 1,
        hero_enabled      INTEGER NOT NULL DEFAULT 1,
        guest_name_template TEXT NOT NULL DEFAULT '{guest_name}',
        caption_position    TEXT NOT NULL DEFAULT 'bottom-left',
        photo_fit           TEXT NOT NULL DEFAULT 'contain',
        custom_css          TEXT NOT NULL DEFAULT '',
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      );
      -- D-01's single-active-event pointer, in booth_state's CHECK (id = 1)
      -- single-row idiom. The cardinality constraint is the decision: with a
      -- plain table an "activate" that INSERTed instead of UPSERTing would
      -- accumulate rows and leave "which event is live?" ambiguous, which is
      -- exactly the concurrent-events design D-01 rejects. CHECK (id = 1)
      -- makes that mistake throw at the database rather than surface later as
      -- two TVs disagreeing.
      --
      -- event_id is deliberately NOT a foreign key: a deleted event must
      -- leave a dangling pointer that getActiveEventConfig() resolves to the
      -- shipped defaults (UI-01), never a failed read that blanks the screen.
      CREATE TABLE IF NOT EXISTS active_event (
        id         INTEGER PRIMARY KEY CHECK (id = 1),
        event_id   TEXT,
        updated_at TEXT NOT NULL DEFAULT 'now'
      );
      -- D-10: the per-event photo history. Keyed by jobId because
      -- onFileUpload()'s own comment establishes that exactly one print
      -- composite exists per session — the natural key is already unique, so
      -- a surrogate id would only create a second way to say the same thing
      -- and a way for a replayed upload to land twice.
      --
      -- photo_url is a URL, not bytes: D-10 stores a reference and never
      -- downloads the image, so this table stays small and the photo's real
      -- home stays wherever the delivery webhook put it.
      --
      -- NO AUTOMATIC DELETE PATH MAY BE ADDED HERE. D-11 is explicit: photo
      -- history is kept per event and removed ONLY by a hand-confirmed CMS
      -- action (deleteEventPhotos, wired to a typed confirmation in plan
      -- 08-05; joined later by deleteEventPhoto, the same act scoped to one
      -- row — see CMS-05). No auto-expiry, no row cap, no scheduled cleanup,
      -- no delete-on-event-switch. This is the same discipline pending_print's
      -- header above states for expired rows, and for a related reason: these
      -- rows are a guest-facing record, and the operator — not a timer — owns
      -- when a wedding's photos stop existing.
      -- TWO URLs, and they are not interchangeable.
      --
      -- photo_url is dslrBooth's SHARE PAGE (param2, e.g.
      -- https://fotoshare.co/i/3knbmax) — a text/html page the guest opens to
      -- view and download. It is what notificationService delivers, and
      -- NOT-01/NOT-02 depend on it staying exactly that.
      --
      -- image_url is the FILE that page advertises in its og:image
      -- (e.g. https://cdn-bz-op.fotoshare.co/.../..._1x.jpg, image/jpeg) —
      -- what goes in an <img src> on the wall. Measured 2026-08-13: putting
      -- the share page in an <img> draws a broken image on every television,
      -- because a page is not a picture.
      --
      -- NULLABLE on purpose. It is resolved from a third party that can be
      -- slow, down, or re-templated, and the row is written the instant the
      -- upload lands rather than waiting on that. A null here means "not
      -- resolved (yet, or ever)", and every display projection falls back to
      -- photo_url — which is precisely today's behaviour, including its
      -- broken-image G4 placeholder.
      CREATE TABLE IF NOT EXISTS event_photo (
        jobId       TEXT PRIMARY KEY,
        event_id    TEXT NOT NULL,
        guest_name  TEXT NOT NULL,
        photo_url   TEXT NOT NULL,
        image_url   TEXT,
        captured_at INTEGER NOT NULL
      );
      -- D-18: the Agent's remotely-editable configuration, plus ONE step of
      -- history. Single row, booth_state's CHECK (id = 1) idiom again.
      --
      -- Two JSON blobs rather than a column per field, deliberately: the safe
      -- field set is the Agent's contract (D-16), not this service's, and
      -- pinning it into columns here would mean a schema migration every time
      -- the Agent gains a tunable. The server validates the allow-list on the
      -- way in (plan 08-04); this table just holds what was agreed.
      --
      -- previous_json is one step, not a log. It is cleared by a restore, so
      -- "restore previous" can never walk backwards through a history that
      -- D-18 says does not exist.
      CREATE TABLE IF NOT EXISTS agent_config (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        current_json  TEXT NOT NULL,
        previous_json TEXT,
        updated_at    TEXT NOT NULL DEFAULT 'now'
      );
    `);
  }

  /**
   * Indexes, created AFTER migrate() rather than inside bootstrap() — the
   * ordering is load-bearing, not stylistic. `idx_notification_status_due`
   * indexes `notification_record.dueAt`, and on a database written before
   * plan 07-xx that column does not exist until migrate()'s ALTER TABLE has
   * run. Creating the index in bootstrap() would therefore crash at startup
   * on exactly the databases migrate() exists to rescue. Any index added
   * here may safely reference a migrated column; one added to bootstrap()
   * may not.
   *
   * `CREATE INDEX IF NOT EXISTS` is idempotent, so this runs on every boot as
   * a no-op, matching bootstrap()'s own idiom. Adding an index is additive
   * and reversible, so this respects D-14's never-destroy rule: no DROP, no
   * table recreate, no data touched.
   *
   * Each of the three exists because a query on the 4 Hz display path or the
   * 3-second notification sweep would otherwise scan a table that grows for
   * the whole event and is never trimmed — D-11 forbids automatic expiry on
   * `event_photo`, so it only ever gets longer.
   */
  createIndexes(): void {
    this.db.exec(`
      -- listEventPhotos()/getMostRecentEventPhoto(): WHERE event_id = ?
      -- ORDER BY captured_at DESC, evaluated on every buildSnapshot(). DESC is
      -- declared in the index so SQLite can walk it in the query's own
      -- direction and skip the sort step entirely, not merely the scan.
      CREATE INDEX IF NOT EXISTS idx_event_photo_event_captured
        ON event_photo (event_id, captured_at DESC);

      -- getQueuedGuestSummaries()/getNextQueuedJob()/getQueuedJobs():
      -- WHERE status = 'queued' ORDER BY queued_at ASC. Leading column is the
      -- equality predicate, trailing column is the sort — the order that lets
      -- one index serve both halves.
      CREATE INDEX IF NOT EXISTS idx_queue_job_status_queued_at
        ON queue_job (status, queued_at);

      -- getDueNotifications(): WHERE status IN (...) AND dueAt <= ?
      -- ORDER BY dueAt ASC, run every NOTIFY_SWEEP_INTERVAL_MS. Terminal rows
      -- ('delivered'/'failed') accumulate for the whole event and are exactly
      -- the rows this predicate must keep stepping over without an index.
      CREATE INDEX IF NOT EXISTS idx_notification_status_due
        ON notification_record (status, dueAt);
    `);
  }

  migrate(): void {
    // Additive-only migrations. This database file carries live operational
    // data that D-14 says only the operator may delete, so migrations here
    // must never drop or recreate a table — only add columns and backfill.
    const columns = this.db.prepare('PRAGMA table_info(registration)').all() as Array<{ name: string }>;
    const hasReceivedAt = columns.some((c) => c.name === 'received_at');
    if (!hasReceivedAt) {
      this.db.exec('ALTER TABLE registration ADD COLUMN received_at INTEGER');
      this.db.prepare('UPDATE registration SET received_at = ? WHERE received_at IS NULL').run(Date.now());
    }

    // notification_record: D-13. photoUrl was never a persisted column
    // before this phase — it only ever existed on the wire inside one
    // file_upload WebSocket event and was never written to queue_job or
    // registration, so a pre-existing non-terminal row has nothing to
    // recover a photo URL from. Marking it terminal here is the only honest
    // option; fabricating a placeholder URL would POST a bogus image to the
    // slideshow. The backfill runs only when a column was actually added
    // this call, so an already-migrated database is never rescanned (and
    // never re-fails a legitimately in-flight row) on every boot. No blanket
    // dueAt backfill is added: the status write above already makes every
    // matching row terminal, and terminal rows are never selected by the
    // sweeper's getDueNotifications() query.
    const notifColumns = this.db.prepare('PRAGMA table_info(notification_record)').all() as Array<{ name: string }>;
    const hasPhotoUrl = notifColumns.some((c) => c.name === 'photoUrl');
    const hasDueAt = notifColumns.some((c) => c.name === 'dueAt');
    let notifColumnAdded = false;
    if (!hasPhotoUrl) {
      this.db.exec('ALTER TABLE notification_record ADD COLUMN photoUrl TEXT');
      notifColumnAdded = true;
    }
    if (!hasDueAt) {
      this.db.exec('ALTER TABLE notification_record ADD COLUMN dueAt INTEGER');
      notifColumnAdded = true;
    }
    if (notifColumnAdded) {
      this.db.prepare(
        `UPDATE notification_record
         SET status = 'failed', lastError = 'photoUrl unavailable — record predates persisted-queue migration'
         WHERE photoUrl IS NULL AND status NOT IN ('delivered','failed')`
      ).run();
    }

    // booth_state.current_job_id — D-06's server-held attribution source of
    // truth for which job currently owns the booth. No backfill: NULL means
    // "no job owns the booth", which is the correct value for every
    // pre-existing row. Re-running this on an already-migrated database is a
    // no-op, proven against a real temp-file database in
    // local-store-persistence.test.ts, the same way the pending_print table
    // is proven in plan 07-03.
    const boothColumns = this.db.prepare('PRAGMA table_info(booth_state)').all() as Array<{ name: string }>;
    const hasCurrentJobId = boothColumns.some((c) => c.name === 'current_job_id');
    if (!hasCurrentJobId) {
      this.db.exec('ALTER TABLE booth_state ADD COLUMN current_job_id TEXT');
    }

    // booth_state.attempt_open / attempt_no — D11-01 (phase 11). The
    // persisted "is a capture attempt currently open" flag and its counter,
    // same row and same restart-survival mechanism as current_job_id above.
    // NOT NULL DEFAULT 0 is safe for the same reason as event.show_guest_name
    // below: every pre-existing row reads back as "no open attempt, zero
    // attempts", which is correct for a database with no attempt in progress
    // at deploy time. Every REPLACE-style booth_state writer below must name
    // both columns explicitly — see the writers' own comments.
    const hasAttemptOpen = boothColumns.some((c) => c.name === 'attempt_open');
    if (!hasAttemptOpen) {
      this.db.exec('ALTER TABLE booth_state ADD COLUMN attempt_open INTEGER NOT NULL DEFAULT 0');
    }
    const hasAttemptNo = boothColumns.some((c) => c.name === 'attempt_no');
    if (!hasAttemptNo) {
      this.db.exec('ALTER TABLE booth_state ADD COLUMN attempt_no INTEGER NOT NULL DEFAULT 0');
    }

    // pending_print.{photo_url, attempt_no, approved_by, approved_at} —
    // D11-04/D11-05 (phase 11). photo_url is written by the rewritten
    // onFileUpload() independently of status; attempt_no ties the slot's
    // composite to the attempt that wrote it (D11-03's stem comparison reads
    // this rather than re-deriving it); approved_by/approved_at are written
    // only at finalize (D11-05's audit trail — 'printing' | 'grace' |
    // 'operator'). All four are nullable with no backfill: NULL is the
    // correct "not yet known" reading for every pre-existing row, and the
    // existing three-word `status` vocabulary ('awaiting'/'resolved'/
    // 'expired') is unchanged by this migration.
    const pendingPrintColumns = this.db.prepare('PRAGMA table_info(pending_print)').all() as Array<{ name: string }>;
    if (!pendingPrintColumns.some((c) => c.name === 'photo_url')) {
      this.db.exec('ALTER TABLE pending_print ADD COLUMN photo_url TEXT');
    }
    if (!pendingPrintColumns.some((c) => c.name === 'attempt_no')) {
      this.db.exec('ALTER TABLE pending_print ADD COLUMN attempt_no INTEGER');
    }
    if (!pendingPrintColumns.some((c) => c.name === 'approved_by')) {
      this.db.exec('ALTER TABLE pending_print ADD COLUMN approved_by TEXT');
    }
    if (!pendingPrintColumns.some((c) => c.name === 'approved_at')) {
      this.db.exec('ALTER TABLE pending_print ADD COLUMN approved_at INTEGER');
    }

    // event.show_guest_name / event.hero_enabled — D9-04/D9-05. Phase 8
    // shipped `event` with zero ALTER TABLE, and that fact was used as
    // deployment-safety evidence during the Phase 8 cutover; this is the
    // first one against a table that may already hold live, populated rows
    // on a running production database. Both columns are additive, NOT NULL,
    // and DEFAULT 1 — SQLite accepts a NOT NULL ADD COLUMN precisely because
    // a DEFAULT is supplied, so every pre-existing row reads back as ON
    // (today's behaviour) with no backfill statement required. No DROP, no
    // table recreate: this is the same `PRAGMA table_info` + conditional
    // `ALTER TABLE ADD COLUMN` idiom as the three migrations above, applied
    // to a second existing table for the first time.
    const eventColumns = this.db.prepare("PRAGMA table_info('event')").all() as Array<{ name: string }>;
    const hasShowGuestName = eventColumns.some((c) => c.name === 'show_guest_name');
    const hasHeroEnabled = eventColumns.some((c) => c.name === 'hero_enabled');
    if (!hasShowGuestName) {
      this.db.exec('ALTER TABLE event ADD COLUMN show_guest_name INTEGER NOT NULL DEFAULT 1');
    }
    if (!hasHeroEnabled) {
      this.db.exec('ALTER TABLE event ADD COLUMN hero_enabled INTEGER NOT NULL DEFAULT 1');
    }
    // event.background_overlay — CMS-10. Same additive idiom, and the DEFAULT
    // is the value both screens previously hard-coded, so every existing row
    // reads back as exactly what it rendered a moment before this ran.
    if (!eventColumns.some((c) => c.name === 'background_overlay')) {
      this.db.exec('ALTER TABLE event ADD COLUMN background_overlay INTEGER NOT NULL DEFAULT 72');
    }
    if (!eventColumns.some((c) => c.name === 'guest_name_template')) {
      this.db.exec("ALTER TABLE event ADD COLUMN guest_name_template TEXT NOT NULL DEFAULT '{guest_name}'");
    }
    if (!eventColumns.some((c) => c.name === 'caption_position')) {
      this.db.exec("ALTER TABLE event ADD COLUMN caption_position TEXT NOT NULL DEFAULT 'bottom-left'");
    }
    if (!eventColumns.some((c) => c.name === 'photo_fit')) {
      this.db.exec("ALTER TABLE event ADD COLUMN photo_fit TEXT NOT NULL DEFAULT 'contain'");
    }
    if (!eventColumns.some((c) => c.name === 'custom_css')) {
      this.db.exec("ALTER TABLE event ADD COLUMN custom_css TEXT NOT NULL DEFAULT ''");
    }

    // event_photo.image_url — the file behind dslrBooth's share page. See the
    // CREATE TABLE above for why one URL could not serve both the guest's
    // notification and the wall's <img src>. NULLABLE with no default, so an
    // existing row keeps its share URL and resolves to null here, which every
    // display projection reads as "fall back to photo_url" — i.e. exactly the
    // behaviour that database had a moment before this ran.
    const photoColumns = this.db.prepare("PRAGMA table_info('event_photo')").all() as Array<{ name: string }>;
    if (!photoColumns.some((c) => c.name === 'image_url')) {
      this.db.exec('ALTER TABLE event_photo ADD COLUMN image_url TEXT');
    }
  }

  // registrations
  upsertRegistration(r: Registration & { raw_payload?: string; received_at?: number }): Registration {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO registration (id, name, email, phone, mode, registered_at, raw_payload, received_at)
       VALUES (@id, @name, @email, @phone, @mode, @registered_at, @raw_payload, @received_at)`
    );
    stmt.run({
      id: r.id, name: r.name, email: r.email, phone: r.phone,
      mode: r.mode, registered_at: r.registered_at,
      raw_payload: r.raw_payload ?? null,
      received_at: r.received_at ?? Date.now(),
    });
    return r;
  }

  getRegistration(id: string): Registration | undefined {
    return this.db.prepare('SELECT * FROM registration WHERE id = ?').get(id) as Registration | undefined;
  }

  saveRawPayload(id: string, json: string): void {
    this.db.prepare('UPDATE registration SET raw_payload = ? WHERE id = ?').run(json, id);
  }

  // dedup: same id, or same non-empty email/phone, seen inside the window
  findDuplicateRegistration(args: { id: string; email: string; phone: string; windowStartMs: number }): { id: string } | undefined {
    const byId = this.db
      .prepare('SELECT id FROM registration WHERE id = ? AND received_at >= ?')
      .get(args.id, args.windowStartMs) as { id: string } | undefined;
    if (byId) return byId;

    return this.db
      .prepare(
        `SELECT id FROM registration
         WHERE received_at >= ?
           AND ((? <> '' AND email = ?)
             OR (? <> '' AND phone = ?))
         ORDER BY received_at ASC LIMIT 1`
      )
      .get(args.windowStartMs, args.email, args.email, args.phone, args.phone) as { id: string } | undefined;
  }

  // queue
  //
  // Logs the FIFO position at the single choke point both ingestion paths
  // (the webhook receiver and the DB poller) already call, so one log line
  // covers both (M2 success criterion 1, QUE-01). D-11: this adds no new
  // deduplication mechanism — the `INSERT OR IGNORE` below, unchanged, plus
  // Phase 1's `processed_id` table remain the only guard; the `changes === 0`
  // branch only observes that guarantee.
  enqueueJob(j: { id: string; queued_at: number }): void {
    const result = this.db.prepare(
      `INSERT OR IGNORE INTO queue_job (id, registration_id, status, queued_at) VALUES (@id, @id, 'queued', @queued_at)`
    ).run({ id: j.id, queued_at: j.queued_at });

    if (result.changes === 0) {
      logger.info(`Job ${j.id} is already queued and was not re-queued`);
      return;
    }

    const pos = this.getQueuePosition(j.id) ?? 0;
    const len = this.getQueueLength();
    logger.info(`Queued job ${j.id} at position ${pos} of ${len}`);
  }

  updateJobStatus(id: string, status: QueueJob['status'], tsField: keyof QueueJob, tsValue: number): void {
    const map: Record<string, string> = {
      dispatched_at: 'dispatched_at', acknowledged_at: 'acknowledged_at',
      session_started_at: 'session_started_at', session_ended_at: 'session_ended_at',
      completed_at: 'completed_at',
    };
    const field = map[tsField];
    this.db.prepare(`UPDATE queue_job SET status = ?, ${field} = ? WHERE id = ?`).run(status, tsValue, id);
  }

  getQueuedJobs(): QueueJob[] {
    return this.db.prepare("SELECT * FROM queue_job WHERE status = 'queued' ORDER BY queued_at ASC").all() as QueueJob[];
  }

  getJob(id: string): QueueJob | undefined {
    return this.db.prepare('SELECT * FROM queue_job WHERE id = ?').get(id) as QueueJob | undefined;
  }

  getNextQueuedJob(): QueueJob | undefined {
    return this.db.prepare("SELECT * FROM queue_job WHERE status = 'queued' ORDER BY queued_at ASC LIMIT 1").get() as QueueJob | undefined;
  }

  getQueuedGuestSummaries(limit = 5): Array<{ jobId: string; name: string; position: number }> {
    const rows = this.db.prepare(`
      SELECT q.id AS jobId, r.name AS name
      FROM queue_job q
      JOIN registration r ON r.id = q.registration_id
      WHERE q.status = 'queued'
      ORDER BY q.queued_at ASC
      LIMIT ?
    `).all(limit) as Array<{ jobId: string; name: string }>;
    return rows.map((row, index) => ({ ...row, position: index + 1 }));
  }

  // Replaces the removed completeInProgressJob(), which selected the job to
  // complete by ORDER BY acknowledged_at DESC LIMIT 1 with no jobId
  // parameter at all — the exact mechanism behind WINDOWS item 8: with a
  // queue behind the booth, guest A's second session_end completed guest B.
  // completeJob() is scoped by jobId the way failJob() above is, and reports
  // whether it matched the way claimNotification() below does.
  //
  // The trailing `AND status = 'in_progress'` is not a defensive extra — it
  // is what makes the double delivery of processing_start then printing
  // idempotent without an application-level flag: the second UPDATE matches
  // zero rows and this returns false. No completion path may ever again
  // select a row by ordering or with LIMIT — doing so would re-arm the exact
  // defect this method exists to remove.
  completeJob(jobId: string, completedAt: number): boolean {
    const result = this.db.prepare(
      "UPDATE queue_job SET status = 'completed', session_ended_at = ?, completed_at = ? WHERE id = ? AND status = 'in_progress'"
    ).run(completedAt, completedAt, jobId);
    return result.changes === 1;
  }

  // D-09/D-03: the session ended with no print composite ever seen, so no
  // photo was ever produced. Shaped identically to completeJob() above and
  // guarded by the same `AND status = 'in_progress'` predicate, which is what
  // stops this writer from overwriting the outcome of a job that already
  // completed or already failed (T-07-16).
  //
  // CALLED FROM THE TICK SWEEP, NEVER FROM session_end. This is a deviation
  // from 07-04-PLAN.md Task 2, decided by the human after the plan's version
  // was built and measured — see getJobsAwaitingNoPhotoClose() below for the
  // full reasoning. In one sentence: dslrBooth's session_end carries an empty
  // `{}` payload and fires repeatedly for one session, so closing on it let a
  // stray duplicate from the previous guest write this terminal status onto
  // the NEXT guest's live job.
  //
  // THREE COLUMNS ARE DELIBERATELY ABSENT FROM THE SET LIST, AND EACH OMISSION
  // IS A GUARANTEE. Do not add any of them:
  //
  //   retries — a system-side fault never spends the guest's retry budget
  //   (Phase 3 D-01/D-13, the same reasoning as requeueNoRetry() below). The
  //   guest has already walked away from the booth; charging a retry would
  //   call them back to a camera for a session that produced nothing.
  //
  //   stall_reason — this is not a stall. OPS-RUNBOOK §6 holds a closed,
  //   server-authored stall_reason vocabulary, and an outcome that is nobody's
  //   fault must not join it. Because this path and D-02's release fallback
  //   both write none, an empty stall_reason on a terminal job is now
  //   meaningful rather than a gap.
  //
  //   status = 'completed' — the status written is 'no_photo' precisely so
  //   that getRecentSessionDurationsMs()'s `WHERE status = 'completed'`
  //   excludes this row from the guests' wait estimate BY CONSTRUCTION rather
  //   than by an application filter a later edit could delete. That exclusion
  //   is D-09's second reason for choosing a status over a reason column and
  //   is measured, not assumed, in local-store-persistence.test.ts.
  //
  // completed_at IS set, deliberately: the session's duration must stay
  // available to the summary line plan 07-05 emits, even though the session
  // produced no photo.
  //
  // No migration accompanies this value. `status` is TEXT NOT NULL DEFAULT
  // 'queued' with no CHECK constraint, so a new member of the vocabulary needs
  // no schema change and no backfill — no pre-existing row is a candidate for
  // it.
  closeJobNoPhoto(jobId: string, endedAt: number): boolean {
    const result = this.db.prepare(
      "UPDATE queue_job SET status = 'no_photo', session_ended_at = ?, completed_at = ? WHERE id = ? AND status = 'in_progress'"
    ).run(endedAt, endedAt, jobId);
    return result.changes === 1;
  }

  // The candidate query for the no-photo sweep (07-04, Option C). Every
  // predicate below is an ATTRIBUTION rule derived from the row's own
  // structure, and that is the entire point of this design.
  //
  // WHY THIS IS A SWEEP AND NOT A session_end HANDLER. 07-04-PLAN.md Task 2
  // said to close the bound job as no-photo directly inside sessionEnded().
  // That was built and measured, and it regressed the SC-2 tracer: dslrBooth's
  // session_end carries an empty `{}` payload
  // (07-EVIDENCE-dslrbooth-triggers.md:41-42 states outright that attributing
  // it to a job is impossible) and fires on every exit from the sharing screen
  // — three times in 20 seconds for one session in the measured trace. So a
  // stray duplicate from guest A, arriving after guest B had been dispatched
  // and acknowledged, closed GUEST B's live job as no_photo. This query
  // replaces that guess with facts the row itself carries.
  //
  // The four predicates, each load-bearing:
  //
  //   status = 'in_progress' — the job never reached the print composite.
  //   completeJob() is the only writer of 'completed' and fires at that
  //   anchor, so a job that produced a photo is already excluded here.
  //
  //   id <> current_job_id — the booth is not serving this job right now.
  //   This is what protects a guest who IS mid-session: while they hold the
  //   booth they can never be a candidate, no matter what stray events
  //   arrive. Passed in by the caller rather than joined, because
  //   booth_state is a single-row table the service already reads.
  //
  //   no pending_print row — deliberately ANY row, not merely an 'awaiting'
  //   one. The existence of a row proves a print composite WAS produced for
  //   this job, which makes it by definition not a no-photo session; an
  //   'expired' row means the composite existed but its upload never arrived,
  //   which is a different outcome with a different warning (D-11, and the
  //   reason expired rows are marked rather than deleted). Stricter than
  //   necessary today, because a job with a slot is already 'completed', and
  //   deliberately so: the guarantee should not depend on that coupling
  //   holding in a future phase.
  //
  //   acknowledged_at <= cutoff — the grace period. See
  //   NO_PHOTO_CLOSE_DELAY_MS in queueService.ts for the derivation of the
  //   floor; it must exceed the pending-print expiry window or this sweep
  //   could close a job whose composite is still legitimately in flight.
  //
  // acknowledged_at is used as the age anchor because it is the only
  // timestamp an in_progress row actually carries: session_started_at is
  // declared in the schema but written by nothing in this codebase (the same
  // trap getRecentSessionDurationsMs() documents above), and session_ended_at
  // is not written until a job closes.
  getJobsAwaitingNoPhotoClose(cutoff: number, currentJobId?: string): string[] {
    const rows = this.db.prepare(`
      SELECT id
      FROM queue_job
      WHERE status = 'in_progress'
        AND acknowledged_at IS NOT NULL
        AND acknowledged_at <= ?
        AND (? IS NULL OR id <> ?)
        AND id NOT IN (SELECT jobId FROM pending_print)
      ORDER BY acknowledged_at ASC
    `).all(cutoff, currentJobId ?? null, currentJobId ?? null) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  getInFlightJobs(): QueueJob[] {
    return this.db.prepare(
      "SELECT * FROM queue_job WHERE status IN ('dispatched','in_progress') ORDER BY dispatched_at DESC"
    ).all() as QueueJob[];
  }

  // queued_at is deliberately absent from the SET list below — this omission
  // IS D-06's guarantee that a requeued guest keeps their original place in
  // line (getNextQueuedJob() orders by queued_at ASC).
  requeueWithRetry(jobId: string): { retries: number } {
    this.db.prepare(
      "UPDATE queue_job SET status = 'queued', retries = retries + 1 WHERE id = ?"
    ).run(jobId);
    const row = this.db.prepare('SELECT retries FROM queue_job WHERE id = ?').get(jobId) as { retries: number } | undefined;
    return { retries: row?.retries ?? 0 };
  }

  // A deliberate sibling of requeueWithRetry() above, not a variant of it.
  // queued_at is absent from the SET list for the same reason it is absent
  // there — that omission IS D-06's guarantee that a requeued guest keeps
  // their original place in line, since getNextQueuedJob() orders by
  // queued_at ASC. retries is also deliberately absent: a system-side fault
  // (the Agent itself dying) must never spend the guest's retry budget
  // (D-01, D-12) — that budget exists to bound a bad *job*, not to punish a
  // guest for the booth's own failure. Do not add a retry count return, a
  // row read-back, or a parameter; the two methods staying trivially
  // different at the call site is what keeps the D-01 contrast visible in
  // the code.
  requeueNoRetry(jobId: string): void {
    this.db.prepare("UPDATE queue_job SET status = 'queued' WHERE id = ?").run(jobId);
  }

  failJob(jobId: string, stallReason: string): void {
    this.db.prepare(
      "UPDATE queue_job SET status = 'failed', stall_reason = ? WHERE id = ?"
    ).run(stallReason, jobId);
  }

  /**
   * Records WHY the Agent refused a `start_session`.
   *
   * `ack_error_message` has existed since Phase 2 and nothing ever wrote to
   * it: `onAgentAck` received the Agent's reason, logged it at DEBUG — a level
   * this service does not run at — and dropped it. Four jobs failed with
   * `stall_reason = 'agent_nak'` and no recoverable explanation for any of
   * them, which is how this was found.
   *
   * Written on every nak, not only the one that exhausts the retries: the
   * first refusal is usually the informative one, and by the last attempt the
   * booth may be failing for a different reason than it started with.
   *
   * OPERATOR-ONLY. `status/guestStatus.ts` names this column among the words
   * that may never cross the guest boundary, and nothing here changes that —
   * this only makes the value exist for the people already allowed to read it.
   */
  recordAckError(jobId: string, message: string): void {
    this.db.prepare('UPDATE queue_job SET ack_error_message = ? WHERE id = ?').run(message, jobId);
  }

  // idempotency
  isProcessed(regId: string): boolean {
    return this.db.prepare('SELECT 1 FROM processed_id WHERE reg_id = ?').get(regId) !== undefined;
  }

  markProcessed(regId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO processed_id (reg_id) VALUES (?)').run(regId);
  }

  // webhook replay protection
  hasSeenWebhookId(webhookId: string): boolean {
    return this.db.prepare('SELECT 1 FROM webhook_replay WHERE webhook_id = ?').get(webhookId) !== undefined;
  }

  recordWebhookId(webhookId: string, receivedAt: number): void {
    this.db.prepare('INSERT OR IGNORE INTO webhook_replay (webhook_id, received_at) VALUES (?, ?)').run(webhookId, receivedAt);
  }

  countWebhookIds(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM webhook_replay').get() as { n: number };
    return Number(row.n);
  }

  // cursor
  getCursor(pollKey: string): string | undefined {
    const row = this.db.prepare('SELECT last_value FROM db_poll_cursor WHERE poll_key = ?').get(pollKey) as { last_value: string } | undefined;
    return row?.last_value;
  }

  setCursor(pollKey: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO db_poll_cursor (poll_key, last_value, updated_at) VALUES (?, ?, ?)').run(pollKey, value, new Date().toISOString());
  }

  // booth state machine
  getBoothState(): BoothState {
    const row = this.db.prepare("SELECT state FROM booth_state WHERE id = 1").get() as { state: string } | undefined;
    return (row?.state ?? 'IDLE') as BoothState;
  }

  // INSERT OR REPLACE deletes the row and inserts a new one, so any column
  // left out of the column list silently reverts to its default. Every
  // writer below names current_job_id explicitly rather than relying on
  // that side effect — and, since D11-01 (phase 11), names attempt_open and
  // attempt_no too, writing 0 for both in every one of these four: a booth
  // being announced, dispatched, released or timed out has no open attempt
  // and no attempt history. setBoothCurrentJob() below is the one exception
  // — it is an UPDATE, not an INSERT OR REPLACE, and must NOT touch them.
  setBoothState(state: BoothState): void {
    // Its only production caller is beginAnnouncement()'s 'ANNOUNCING'
    // write, when no job owns the booth yet — current_job_id stays NULL.
    this.db.prepare("INSERT OR REPLACE INTO booth_state (id, state, updated_at, current_job_id, attempt_open, attempt_no) VALUES (1, ?, ?, NULL, 0, 0)").run(state, new Date().toISOString());
  }

  setBoothBusy(jobId: string | null = null): void {
    this.db.prepare("INSERT OR REPLACE INTO booth_state (id, state, updated_at, current_job_id, attempt_open, attempt_no) VALUES (1, 'BUSY', ?, ?, 0, 0)").run(new Date().toISOString(), jobId);
  }

  // The explicit NULL here IS D-06's "cleared when the booth is released"
  // guarantee, the same discipline requeueNoRetry() applies to retries: it
  // must not be replaced by an application-level clear that a later edit
  // could delete. current_job_id's absence from the booth once it is IDLE is
  // enforced by this write itself, not by a caller remembering to clear it.
  // attempt_open/attempt_no reset to 0 for the same reason: whoever holds the
  // booth next starts their own attempt count at zero.
  setBoothIdle(): void {
    this.db.prepare("INSERT OR REPLACE INTO booth_state (id, state, updated_at, current_job_id, attempt_open, attempt_no) VALUES (1, 'IDLE', ?, NULL, 0, 0)").run(new Date().toISOString());
  }

  setBoothTimeout(reason: string): void {
    this.db.prepare("INSERT OR REPLACE INTO booth_state (id, state, updated_at, current_job_id, attempt_open, attempt_no) VALUES (1, 'IDLE', ?, NULL, 0, 0)").run(new Date().toISOString());
    logger.warn(`Booth timeout reset: ${reason}`);
  }

  // D11-01 (phase 11): the persisted attempt flag and counter, read together
  // so a caller never has to reconcile two separate queries. Both live in
  // booth_state, id = 1, the same single-row table current_job_id already
  // uses.
  getBoothAttempt(): { attemptOpen: boolean; attemptNo: number } {
    const row = this.db.prepare('SELECT attempt_open, attempt_no FROM booth_state WHERE id = 1').get() as
      | { attempt_open: number; attempt_no: number }
      | undefined;
    return { attemptOpen: Boolean(row?.attempt_open ?? 0), attemptNo: row?.attempt_no ?? 0 };
  }

  // Opens a new attempt AND increments the counter in the same write — this
  // is what makes attempt_no double as both "an attempt is open" (indirectly,
  // via attempt_open) and "how many attempts has this job had" (D11-09's
  // SESSION_SUMMARY attempts= field). Called once after the ordinary
  // session_start ack (attempt 1) and once per retake (sessionAckedFromEvent,
  // D11-01/D11-06).
  openBoothAttempt(): { attemptOpen: boolean; attemptNo: number } {
    this.db.prepare('UPDATE booth_state SET attempt_open = 1, attempt_no = attempt_no + 1 WHERE id = 1').run();
    return this.getBoothAttempt();
  }

  // Closes the open attempt WITHOUT touching attempt_no or current_job_id —
  // an unapproved session_end (D11-06) must leave the job bound to the booth
  // so a retake's session_start still finds it, and must leave the attempt
  // count intact so the eventual SESSION_SUMMARY still reports it.
  closeBoothAttempt(): void {
    this.db.prepare('UPDATE booth_state SET attempt_open = 0 WHERE id = 1').run();
  }

  // D-06: the server-held attribution source of truth. A NULL column and a
  // missing row are deliberately indistinguishable to the caller — both mean
  // "no job owns the booth right now".
  getBoothCurrentJobId(): string | undefined {
    const row = this.db.prepare('SELECT current_job_id FROM booth_state WHERE id = 1').get() as
      | { current_job_id: string | null }
      | undefined;
    return row?.current_job_id ?? undefined;
  }

  // Re-affirms the booth->job binding at ack (D-06), independent of
  // setBoothBusy()'s own write at dispatch time.
  setBoothCurrentJob(jobId: string | null): void {
    this.db.prepare('UPDATE booth_state SET current_job_id = ?, updated_at = ? WHERE id = 1').run(jobId, new Date().toISOString());
  }

  getBoothStateDetailed(): { state: BoothState; updated_at: string } {
    const row = this.db.prepare("SELECT state, updated_at FROM booth_state WHERE id = 1").get() as { state: string; updated_at: string } | undefined;
    if (!row) return { state: 'IDLE', updated_at: new Date().toISOString() };
    return { state: row.state as BoothState, updated_at: row.updated_at };
  }

  getQueuePosition(jobId: string): number | undefined {
    const job = this.getJob(jobId);
    if (!job || job.status !== 'queued') return undefined;
    const queued = this.getQueuedJobs();
    const idx = queued.findIndex((j) => j.id === jobId);
    return idx >= 0 ? idx + 1 : undefined;
  }

  /**
   * COUNT(*), not `getQueuedJobs().length`.
   *
   * This is called from DisplayServer.buildSnapshot(), which runs four times a
   * second for the whole event. The previous implementation answered "how
   * many" by selecting every queued row — all twelve columns of each — and
   * taking the length of the resulting array. Measured 2026-08-16 against the
   * COUNT(*) below, at queue depths a real event reaches:
   *
   *      depth      old        new     ratio
   *         10   0.193ms    0.017ms      11x
   *        100   0.964ms    0.022ms      43x
   *        400   3.416ms    0.041ms      84x
   *       1000   8.308ms    0.092ms      91x
   *
   * For scale: building the ENTIRE rest of the snapshot against a 10,000-photo
   * history costs 2.6ms. At a 400-deep queue this one count cost more than
   * everything else in the tick combined, and it grew with the queue while
   * every other read stayed flat.
   *
   * Found by a full-journey load test, not by inspection — it is invisible
   * until real people are actually waiting in line. Uses
   * idx_queue_job_status_queued_at's leading column, so the count never scans
   * past a non-queued row either.
   */
  getQueueLength(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM queue_job WHERE status = 'queued'")
      .get() as { n: number };
    return row.n;
  }

  /**
   * The longest-running job the booth currently owns, or undefined when the
   * booth owns nothing.
   *
   * Exists for the health report, and for one specific failure mode that has
   * no other observable signature: an Agent that is connected and
   * authenticated but is not acting on commands — a version skew in the
   * protocol, a booth whose dslrBooth has died behind a still-live relay.
   * From the outside that is indistinguishable from a guest taking their time.
   * `isAgentOnline()` says true, the room screen renders normally, and nothing
   * is logged until startBusyTimer() gives up SESSION_TIMEOUT_MS later — five
   * minutes per guest, with the whole queue stopped behind it.
   *
   * Observed for real: a client that answered every heartbeat but ignored an
   * action name it did not recognise held the queue for the full timeout while
   * every surface reported health.
   *
   * A narrow projection, never a raw row — three scalar columns, no guest
   * name, and nothing that could reach a display or a health payload by
   * accident.
   */
  getOldestInFlightJob(): { id: string; status: string; dispatchedAt: number } | undefined {
    const row = this.db
      .prepare(
        `SELECT id, status, dispatched_at AS dispatchedAt FROM queue_job
         WHERE status IN ('dispatched','in_progress') AND dispatched_at IS NOT NULL
         ORDER BY dispatched_at ASC LIMIT 1`,
      )
      .get() as { id: string; status: string; dispatchedAt: number } | undefined;
    return row;
  }

  /**
   * Row counts per status, for the two tables an operator needs a number from
   * when something has gone quiet. Both return a plain object keyed by the
   * status values actually present — never a fixed shape — so a status added
   * later cannot silently vanish from the health report by being absent from
   * a hard-coded key list.
   *
   * These are COUNT(*) aggregates by design: no row, and therefore no guest
   * name, email or phone, is read. That keeps them safe to expose on an
   * operational endpoint, which is the same structural guarantee
   * DisplayServer.buildSnapshot() relies on (see its header note) — the
   * absence of a raw-row read IS the guarantee.
   */
  countQueueJobsByStatus(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM queue_job GROUP BY status')
      .all() as Array<{ status: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  countNotificationsByStatus(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM notification_record GROUP BY status')
      .all() as Array<{ status: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  // D-02's poisoned-sample exclusion, expressed structurally. The
  // `status = 'completed'` restriction in the WHERE clause below IS the
  // exclusion — it is not one filter among several. A stalled, requeued or
  // failed job cannot reach that status: completeJob() above is the
  // only writer of 'completed', and it only ever fires against a row that is
  // currently 'in_progress'. Every other terminal path (failJob,
  // requeueWithRetry, requeueNoRetry) writes 'failed' or 'queued' instead.
  //
  // Do NOT add a separate stall-reason or retries filter in application code
  // alongside this. Such a filter would be strictly weaker than the WHERE
  // clause: the query cannot run without its WHERE, whereas a later edit can
  // delete an `if`. Same omission-as-guarantee pattern as
  // getDueNotifications() below and requeueWithRetry() above.
  //
  // The duration pair is `completed_at - acknowledged_at`, NOT anything
  // involving session_started_at — that column is declared but never written
  // anywhere in this codebase, so a query built on it would return zero
  // samples forever, silently, and every test would still pass
  // (D-01 as CORRECTED).
  getRecentSessionDurationsMs(limit: number): number[] {
    const rows = this.db.prepare(`
      SELECT completed_at - acknowledged_at AS duration_ms
      FROM queue_job
      WHERE status = 'completed'
        AND acknowledged_at IS NOT NULL
        AND completed_at IS NOT NULL
      ORDER BY completed_at DESC
      LIMIT ?
    `).all(limit) as Array<{ duration_ms: number }>;
    return rows.map((row) => Number(row.duration_ms));
  }

  getJobRegistration(jobId: string): { job: QueueJob; registration: Registration } | undefined {
    const jobRow = this.db.prepare('SELECT * FROM queue_job WHERE id = ?').get(jobId) as
      | (QueueJob & { registration_id?: string })
      | undefined;
    if (!jobRow?.registration_id) return undefined;

    const registration = this.db.prepare('SELECT * FROM registration WHERE id = ?').get(jobRow.registration_id) as Registration | undefined;
    if (!registration) return undefined;

    const job = { ...jobRow, registration } as QueueJob;
    return { job, registration };
  }

  // notifications
  //
  // photoUrl/dueAt use COALESCE(excluded.<col>, notification_record.<col>)
  // on conflict, unlike status/attempts/lastError's bare excluded.<col>. The
  // sweeper calls this method on every delivery attempt to record a status
  // change without re-supplying the photo URL, so a bare excluded.photoUrl
  // would overwrite the persisted URL with NULL on the very first retry —
  // silently reintroducing the data loss this phase exists to remove.
  saveNotification(n: Partial<NotificationRecord> & { jobId: string }): void {
    this.db.prepare(`
      INSERT INTO notification_record (jobId, status, attempts, lastError, photoUrl, dueAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(jobId) DO UPDATE SET
        status = excluded.status,
        attempts = excluded.attempts,
        lastError = excluded.lastError,
        photoUrl = COALESCE(excluded.photoUrl, notification_record.photoUrl),
        dueAt = COALESCE(excluded.dueAt, notification_record.dueAt),
        updatedAt = excluded.updatedAt
    `).run(
      n.jobId,
      n.status ?? 'pending',
      n.attempts ?? 0,
      n.errorMessage ?? n.lastError ?? null,
      n.photoUrl ?? null,
      n.dueAt ?? null,
      new Date().toISOString(),
    );
  }

  getNotification(jobId: string): NotificationRecord | undefined {
    const row = this.db.prepare('SELECT * FROM notification_record WHERE jobId = ?').get(jobId) as {
      jobId: string; status: string; attempts: number; lastError?: string; photoUrl?: string; dueAt?: number; updatedAt: string;
    } | undefined;
    return row
      ? {
          jobId: row.jobId,
          channel: 'webhook',
          recipient: '',
          status: row.status,
          attempts: row.attempts,
          lastError: row.lastError,
          photoUrl: row.photoUrl ?? undefined,
          dueAt: row.dueAt ?? undefined,
        }
      : undefined;
  }

  // D-05 expressed structurally: the trailing WHERE on the conflict branch
  // means a repeat file_upload for a job whose notification already reached
  // a terminal state ('delivered' or 'failed') cannot re-arm it for another
  // delivery. Removing that WHERE would let a duplicate/replayed file_upload
  // event send an already-delivered guest's photo a second time.
  enqueueNotification(n: { jobId: string; photoUrl: string; dueAt: number }): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO notification_record (jobId, photoUrl, status, attempts, dueAt, updatedAt)
      VALUES (?, ?, 'pending', 0, ?, ?)
      ON CONFLICT(jobId) DO UPDATE SET
        photoUrl = excluded.photoUrl,
        status = 'pending',
        attempts = 0,
        dueAt = excluded.dueAt,
        updatedAt = excluded.updatedAt
      WHERE notification_record.status NOT IN ('delivered','failed')
    `).run(n.jobId, n.photoUrl, n.dueAt, now);
  }

  // D-05: 'delivered' and 'failed' are deliberately absent from this
  // predicate — no application-level `if (alreadySent)` exists anywhere to
  // be deleted by a later edit. 'sending' is deliberately present: a claim
  // writes a lease deadline into dueAt, so a row whose owning process died
  // mid-flight becomes due again on its own and is picked up by this same
  // query — that is what makes D-04's "restart-proof by construction" hold
  // for in-flight rows too, and is why this phase adds no boot-time recovery
  // pass of its own.
  getDueNotifications(now: number): Array<{ jobId: string; photoUrl: string; attempts: number }> {
    return this.db.prepare(`
      SELECT jobId, photoUrl, attempts FROM notification_record
      WHERE status IN ('pending','retrying','sending') AND dueAt <= ? AND photoUrl IS NOT NULL
      ORDER BY dueAt ASC
    `).all(now) as Array<{ jobId: string; photoUrl: string; attempts: number }>;
  }

  // Same structural guard as getDueNotifications() above: only a row still
  // in a non-terminal state and past its due time can be claimed.
  claimNotification(jobId: string, now: number, leaseUntil: number): boolean {
    const result = this.db.prepare(`
      UPDATE notification_record
      SET status = 'sending', dueAt = ?, updatedAt = ?
      WHERE jobId = ? AND status IN ('pending','retrying','sending') AND dueAt <= ?
    `).run(leaseUntil, new Date().toISOString(), jobId, now);
    return result.changes === 1;
  }

  // pending-print registry (D-07/D-08)
  //
  // The slot is opened at the print composite — the completion anchor — and
  // resolved by the later `file_upload` that carries the guest's URL. It is
  // durable, unlike the in-memory Set it replaces, because a restart
  // mid-session is a documented event in this project's history: the fact
  // that a photo is owed must survive one.
  //
  // ON CONFLICT(jobId) DO NOTHING, not an upsert. dslrBooth delivers the
  // composite twice per session (processing_start then printing, both naming
  // the same file), so the completion path fires twice — RESEARCH.md's
  // Pitfall 2. This clause IS the idempotency guarantee that exactly one slot
  // is opened; turning it into an upsert would let the second fire silently
  // extend the first slot's deadline and reset its composite path.
  openPendingPrint(entry: { jobId: string; compositePath: string; openedAt: number; expiresAt: number }): boolean {
    const result = this.db.prepare(`
      INSERT INTO pending_print (jobId, composite_path, status, opened_at, expires_at, resolved_at, updated_at)
      VALUES (?, ?, 'awaiting', ?, ?, NULL, ?)
      ON CONFLICT(jobId) DO NOTHING
    `).run(entry.jobId, entry.compositePath, entry.openedAt, entry.expiresAt, new Date().toISOString());
    return result.changes === 1;
  }

  // Deliberately unfiltered by status. The caller needs all three answers —
  // 'awaiting', 'expired', and "no row at all" — because that three-way
  // distinction is exactly what keeps D-04 and D-11 apart at the resolution
  // site. Do NOT add a `WHERE status = 'awaiting'` or an expiry predicate
  // here: filtering expired rows out would make a late-but-legitimate print
  // indistinguishable from a photo produced with no session awaiting one, and
  // the service would drop a real guest's photo.
  getPendingPrint(jobId: string): {
    jobId: string; compositePath: string; status: string; openedAt: number; expiresAt: number;
    photoUrl: string | undefined; attemptNo: number | undefined;
    approvedBy: string | undefined; approvedAt: number | undefined;
  } | undefined {
    const row = this.db.prepare(
      'SELECT jobId, composite_path, status, opened_at, expires_at, photo_url, attempt_no, approved_by, approved_at FROM pending_print WHERE jobId = ?'
    ).get(jobId) as
      | {
          jobId: string; composite_path: string | null; status: string; opened_at: number; expires_at: number;
          photo_url: string | null; attempt_no: number | null; approved_by: string | null; approved_at: number | null;
        }
      | undefined;
    return row
      ? {
          jobId: row.jobId,
          compositePath: row.composite_path ?? '',
          status: row.status,
          openedAt: row.opened_at,
          expiresAt: row.expires_at,
          photoUrl: row.photo_url ?? undefined,
          attemptNo: row.attempt_no ?? undefined,
          approvedBy: row.approved_by ?? undefined,
          approvedAt: row.approved_at ?? undefined,
        }
      : undefined;
  }

  // D11-02 (phase 11): the retake-aware sibling of openPendingPrint() above,
  // NOT a change to that method's semantics — its ON CONFLICT DO NOTHING stays
  // load-bearing for the double-fire case (same composite path re-arriving).
  // This one is called from processing_start instead, and tells apart the two
  // situations a second processing_start can mean:
  //   - a genuinely new attempt (the composite path differs) → overwrite the
  //     slot with the new attempt's composite/attempt_no/deadline, and clear
  //     the discarded attempt's photo_url/approval so a later grace expiry
  //     can never send a rejected attempt's URL (the "never send a discarded
  //     attempt's URL" prohibition);
  //   - the double-fire of the SAME attempt's processing_start/printing pair
  //     (composite path unchanged) → do nothing, matching openPendingPrint's
  //     DO-NOTHING guarantee.
  // Read-then-branch in application code, deliberately, over a single ON
  // CONFLICT ... WHERE clause: the three-way outcome report below (opened vs.
  // overwritten vs. unchanged) is what lets the caller log exactly which one
  // happened, and a caller cannot distinguish "no prior row" from "prior row,
  // no change" from a bare INSERT ... ON CONFLICT changes count alone.
  openOrOverwritePendingPrint(entry: {
    jobId: string; compositePath: string; attemptNo: number; openedAt: number; expiresAt: number;
  }): 'opened' | 'overwritten' | 'unchanged' {
    const existing = this.db.prepare(
      'SELECT composite_path FROM pending_print WHERE jobId = ?'
    ).get(entry.jobId) as { composite_path: string | null } | undefined;
    const now = new Date().toISOString();

    if (existing === undefined) {
      this.db.prepare(`
        INSERT INTO pending_print (jobId, composite_path, attempt_no, status, opened_at, expires_at, resolved_at, updated_at)
        VALUES (?, ?, ?, 'awaiting', ?, ?, NULL, ?)
      `).run(entry.jobId, entry.compositePath, entry.attemptNo, entry.openedAt, entry.expiresAt, now);
      return 'opened';
    }

    if (existing.composite_path === entry.compositePath) {
      return 'unchanged';
    }

    this.db.prepare(`
      UPDATE pending_print
      SET composite_path = ?, attempt_no = ?, opened_at = ?, expires_at = ?, updated_at = ?,
          photo_url = NULL, approved_by = NULL, approved_at = NULL
      WHERE jobId = ?
    `).run(entry.compositePath, entry.attemptNo, entry.openedAt, entry.expiresAt, now, entry.jobId);
    return 'overwritten';
  }

  // D11-04 (phase 11): writes the print URL into the slot WITHOUT changing
  // `status` — sending happens only at finalize (D11-05).
  //
  // The predicate has TWO disjuncts, not one, and the second is what makes
  // D-11's late-arrival guarantee a single idempotent SQL predicate rather
  // than an application-level "have I already delivered this late upload"
  // flag: 'awaiting'/'expired' is the ordinary pre-finalize path (status
  // untouched); 'resolved' with photo_url still NULL is the finalized-with-
  // no-URL case (grace/operator door closed the job before any upload
  // arrived) — a late print here must still be deliverable exactly once, and
  // writing photo_url is what its caller (onFileUpload) uses to tell "wrote
  // it, deliver late" apart from "already had one, no-op": a SECOND late
  // upload for the same job finds photo_url no longer NULL and the whole
  // predicate fails, so this returns false and nothing sends twice.
  setPendingPrintPhotoUrl(jobId: string, photoUrl: string): boolean {
    const result = this.db.prepare(`
      UPDATE pending_print
      SET photo_url = ?, updated_at = ?
      WHERE jobId = ? AND (status IN ('awaiting','expired') OR (status = 'resolved' AND photo_url IS NULL))
    `).run(photoUrl, new Date().toISOString(), jobId);
    return result.changes === 1;
  }

  // D11-05 (phase 11): the ONE finalize predicate — replacing the old
  // single-status resolve accessor rather than wrapping it, per D11-05's own
  // text — extended with the two approval columns. Same omission-as-
  // guarantee discipline: 'resolved' is absent from the read/write predicate,
  // so a second call for an already-finalized job matches nothing and returns
  // matched: false, with no application-level "already sent" flag anywhere.
  //
  // Reads the row BEFORE writing, in one transaction, so the caller gets back
  // the URL and attempt number the slot held at the moment of finalize — the
  // booth is about to be released and booth_state.attempt_no reset to 0, so
  // this is the only place those values can still be read.
  //
  // Handles the case where NO slot was ever opened for this job (an unapproved
  // attempt that produced no composite at all, e.g. the empty-session case —
  // Q3 in 11-CONTEXT.md's open questions) by inserting a resolved row
  // directly, so this gate still reaches exactly one durable, idempotent
  // record of the decision and the booth is never stranded waiting for a slot
  // that will never exist.
  markPendingPrintFinalized(
    jobId: string,
    approvedBy: 'printing' | 'grace' | 'operator',
    approvedAt: number,
  ): { matched: boolean; photoUrl: string | undefined; attemptNo: number | undefined } {
    const txn = this.db.transaction(() => {
      const existing = this.db.prepare(
        'SELECT status, photo_url, attempt_no FROM pending_print WHERE jobId = ?'
      ).get(jobId) as { status: string; photo_url: string | null; attempt_no: number | null } | undefined;

      const now = new Date().toISOString();

      if (existing) {
        if (existing.status !== 'awaiting' && existing.status !== 'expired') {
          return { matched: false, photoUrl: undefined, attemptNo: undefined };
        }
        this.db.prepare(`
          UPDATE pending_print
          SET status = 'resolved', resolved_at = ?, updated_at = ?, approved_by = ?, approved_at = ?
          WHERE jobId = ?
        `).run(approvedAt, now, approvedBy, approvedAt, jobId);
        return { matched: true, photoUrl: existing.photo_url ?? undefined, attemptNo: existing.attempt_no ?? undefined };
      }

      this.db.prepare(`
        INSERT INTO pending_print (jobId, composite_path, status, opened_at, expires_at, resolved_at, updated_at, approved_by, approved_at)
        VALUES (?, NULL, 'resolved', ?, ?, ?, ?, ?, ?)
      `).run(jobId, approvedAt, approvedAt, approvedAt, now, approvedBy, approvedAt);
      return { matched: true, photoUrl: undefined, attemptNo: undefined };
    });
    return txn();
  }

  // The select and the mark share ONE transaction, and that is not a
  // performance detail: a row handed to the caller without also being marked
  // would emit the `No print upload seen` warning on every 250 ms sweep,
  // forever (T-07-14). Marking inside the same transaction is what bounds each
  // slot to at most one warning ever, regardless of sweep frequency.
  //
  // Expired rows are marked, never deleted — see the table declaration.
  expirePendingPrints(now: number): Array<{ jobId: string; compositePath: string }> {
    const select = this.db.prepare(
      "SELECT jobId, composite_path FROM pending_print WHERE status = 'awaiting' AND expires_at <= ?"
    );
    const mark = this.db.prepare(
      "UPDATE pending_print SET status = 'expired', updated_at = ? WHERE status = 'awaiting' AND expires_at <= ?"
    );
    const sweep = this.db.transaction((cutoff: number) => {
      const rows = select.all(cutoff) as Array<{ jobId: string; composite_path: string | null }>;
      mark.run(new Date().toISOString(), cutoff);
      return rows.map((row) => ({ jobId: row.jobId, compositePath: row.composite_path ?? '' }));
    });
    return sweep(now);
  }

  // ---------------------------------------------------------------------
  // Phase 8 — events and the single-active-event pointer (D-01, CMS-01/02/03)
  // ---------------------------------------------------------------------

  /**
   * Mints an event id with randomUUID() rather than a timestamp-derived
   * value. Two reasons, both load-bearing: a UUID cannot collide when an
   * operator creates two events in the same millisecond, and it carries no
   * embedded digit run for PHONE_RE to partially asterisk when the id appears
   * in a log line (the collision agentServer.ts already had to fix at its own
   * mint site).
   *
   * Only `name` is accepted here. Everything else is left NULL so it reads
   * back as the shipped default (D-01/UI-SPEC "partial" row: an event can go
   * live with zero customization and still render a correct screen).
   * Customization is plan 08-03's updateEvent path.
   */
  createEvent(input: { name: string }): EventSummary {
    const now = Date.now();
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO event (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`
    ).run(id, input.name, now, now);
    return { id, name: input.name, createdAt: now, updatedAt: now };
  }

  /**
   * Applies one validated patch to an event row (plan 08-03, CMS-01).
   *
   * The column allow-list is a module constant, and a key that is not in it is
   * DROPPED rather than interpolated — the SET clause is assembled from
   * EVENT_UPDATABLE_COLUMNS, never from the caller's key names, so no caller
   * string ever reaches the SQL text. Values always travel as bound
   * parameters.
   *
   * `null` is a meaningful value here and is written as NULL: it means "this
   * event no longer customizes this field", and the read-time coalescing in
   * toEventConfig() then resolves it back to the shipped default. That is what
   * lets an operator clear a logo, or revert an idle heading, without the CMS
   * having to know what the current default happens to be.
   *
   * Validation of the VALUES — length caps, colour syntax, enumerated fonts and
   * layouts, numeric ranges, the /uploads/ URL shape — is the route's job, not
   * this method's. The store enforces the schema; the CMS enforces the policy.
   */
  updateEvent(id: string, patch: EventUpdatePatch): boolean {
    const columns = EVENT_UPDATABLE_COLUMNS.filter((column) =>
      Object.prototype.hasOwnProperty.call(patch, column),
    );
    if (columns.length === 0) return false;

    const assignments = columns.map((column) => `${column} = ?`).join(', ');
    const values = columns.map((column) => patch[column] ?? null);
    const result = this.db
      .prepare(`UPDATE event SET ${assignments}, updated_at = ? WHERE id = ?`)
      .run(...values, Date.now(), id);
    return result.changes === 1;
  }

  /** The full projection for one event, or undefined when it does not exist. */
  getEventConfig(id: string): EventConfig | undefined {
    const row = this.db.prepare('SELECT * FROM event WHERE id = ?').get(id) as EventRow | undefined;
    return row ? toEventConfig(row) : undefined;
  }

  /** Newest first — the order the CMS event list renders. */
  listEvents(): EventSummary[] {
    const rows = this.db
      .prepare('SELECT id, name, created_at, updated_at FROM event ORDER BY created_at DESC')
      .all() as Array<{ id: string; name: string; created_at: number; updated_at: number }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  getActiveEventId(): string | undefined {
    const row = this.db.prepare('SELECT event_id FROM active_event WHERE id = 1').get() as
      | { event_id: string | null }
      | undefined;
    return row?.event_id ?? undefined;
  }

  /**
   * D-01: this REPLACES the pointer, it never appends. The `id = 1` literal
   * plus the table's CHECK constraint mean "exactly one event is active" is
   * enforced by the schema, not by remembering to delete the previous row.
   *
   * Deliberately does NOT touch queue_job or booth_state: D-02 allows
   * switching events while guests are queued, and the queue is explicitly
   * out of this phase's blast radius.
   */
  setActiveEvent(eventId: string | null): void {
    this.db.prepare(
      `INSERT INTO active_event (id, event_id, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET event_id = excluded.event_id, updated_at = excluded.updated_at`
    ).run(eventId, new Date().toISOString());
  }

  /**
   * The room screen's read. Returns the shipped defaults — never null, never
   * a missing key — when there is no pointer, when the pointer is null, or
   * when it dangles at a deleted event. UI-01 has to hold in all three cases,
   * and a screen that renders an error because nobody has created an event
   * yet is the exact failure this phase exists to remove.
   */
  getActiveEventConfig(): EventConfig {
    const activeId = this.getActiveEventId();
    if (!activeId) return { ...DEFAULT_EVENT_CONFIG };
    const config = this.getEventConfig(activeId);
    if (!config) {
      logger.warn(`Active event pointer references a missing event ${activeId} — serving shipped defaults`);
      return { ...DEFAULT_EVENT_CONFIG };
    }
    return config;
  }

  // ---------------------------------------------------------------------
  // Phase 8 — photo history (D-10, D-11)
  // ---------------------------------------------------------------------

  /**
   * Records one capture. Returns false when a row for this jobId already
   * exists.
   *
   * INSERT OR IGNORE, not OR REPLACE: a duplicate here means a replayed
   * file_upload event, and the FIRST write is the real capture. Replacing
   * would let a replay rewrite `captured_at`, which is the timestamp the hero
   * moment is computed from (plan 08-02) — a replayed upload could otherwise
   * re-trigger a guest's hero moment minutes after they left the booth.
   */
  recordEventPhoto(photo: {
    jobId: string;
    eventId: string;
    guestName: string;
    photoUrl: string;
    capturedAt: number;
  }): boolean {
    const result = this.db.prepare(
      `INSERT OR IGNORE INTO event_photo (jobId, event_id, guest_name, photo_url, captured_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(photo.jobId, photo.eventId, photo.guestName, photo.photoUrl, photo.capturedAt);
    return result.changes === 1;
  }

  /**
   * Attaches the resolved direct image URL to a photo already on record.
   *
   * A SEPARATE step from `recordEventPhoto()` on purpose: the row is written
   * the instant the upload lands, and resolving the share page is a network
   * call to a third party that may be slow, may fail, and may never succeed.
   * Making the insert wait on it would trade a guaranteed history row for a
   * prettier screen — the wrong way round. `photo_url` is never touched here;
   * the guest's link must survive whatever happens to the wall's.
   *
   * Returns false when no such photo exists, which is the honest answer for a
   * resolution that finished after its event was deleted.
   */
  setEventPhotoImageUrl(jobId: string, imageUrl: string): boolean {
    const result = this.db
      .prepare('UPDATE event_photo SET image_url = ? WHERE jobId = ?')
      .run(imageUrl, jobId);
    return result.changes === 1;
  }

  /**
   * The newest capture for one event, as a NARROW projection — no jobId, no
   * event_id, no raw row. `buildSnapshot()` calls this for the hero moment
   * (plan 08-02), and the same reasoning that keeps `getNextQueuedJob()` out
   * of the broadcast path applies: a getter that returned the whole row would
   * make it trivially easy for a future snapshot field to read an internal
   * column straight off it.
   */
  getMostRecentEventPhoto(
    eventId: string,
  ): { photoUrl: string; guestName: string; capturedAt: number } | undefined {
    // image_url FIRST, photo_url as the fallback. This projection feeds an
    // <img src> on the wall, so it wants the file; an unresolved row keeps
    // today's behaviour rather than vanishing from the screen.
    const row = this.db.prepare(
      `SELECT photo_url, image_url, guest_name, captured_at FROM event_photo
       WHERE event_id = ? ORDER BY captured_at DESC LIMIT 1`
    ).get(eventId) as
      | { photo_url: string; image_url: string | null; guest_name: string; captured_at: number }
      | undefined;
    if (!row) return undefined;
    return {
      photoUrl: row.image_url ?? row.photo_url,
      guestName: row.guest_name,
      capturedAt: row.captured_at,
    };
  }

  /** Newest first, for the CMS photo-history page (paginated at 50/page). */
  listEventPhotos(
    eventId: string,
    opts: { limit: number; offset: number },
  ): Array<{ jobId: string; photoUrl: string; guestName: string; capturedAt: number }> {
    // Same image_url-then-photo_url preference as getMostRecentEventPhoto:
    // this list feeds both the slideshow and the CMS thumbnails, and both
    // want the file rather than the page.
    const rows = this.db.prepare(
      `SELECT jobId, photo_url, image_url, guest_name, captured_at FROM event_photo
       WHERE event_id = ? ORDER BY captured_at DESC LIMIT ? OFFSET ?`
    ).all(eventId, opts.limit, opts.offset) as Array<{
      jobId: string; photo_url: string; image_url: string | null; guest_name: string; captured_at: number;
    }>;
    return rows.map((row) => ({
      jobId: row.jobId,
      photoUrl: row.image_url ?? row.photo_url,
      guestName: row.guest_name,
      capturedAt: row.captured_at,
    }));
  }

  countEventPhotos(eventId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM event_photo WHERE event_id = ?')
      .get(eventId) as { n: number };
    return row.n;
  }

  /**
   * The ONLY delete path for photo history, and it exists solely so an
   * operator can invoke it deliberately (D-11). Scoped to one event id —
   * never a global purge — and returns the count so the CMS can report what
   * it actually removed rather than claiming success blindly.
   *
   * Nothing in this service calls this on a timer, a row cap, an event
   * switch, or a schedule. If a future change adds such a caller, it is
   * reversing a locked decision, not tidying up.
   */
  deleteEventPhotos(eventId: string): number {
    return this.db.prepare('DELETE FROM event_photo WHERE event_id = ?').run(eventId).changes;
  }

  /**
   * Reads one photo row by job id, for the delete confirmation page.
   *
   * Same `image_url`-then-`photo_url` preference `listEventPhotos` uses, so
   * the thumbnail the operator confirms against is byte-for-byte the one the
   * history table just showed them — confirming against a different rendering
   * of the same row is how you delete the wrong photograph.
   *
   * Returns the event id too: the caller must not take it from the query
   * string. A jobId is the primary key, so the row itself is the authority on
   * which event it belongs to.
   */
  getEventPhoto(
    jobId: string,
  ): { jobId: string; eventId: string; photoUrl: string; guestName: string; capturedAt: number } | undefined {
    const row = this.db
      .prepare(
        `SELECT jobId, event_id, photo_url, image_url, guest_name, captured_at
         FROM event_photo WHERE jobId = ?`,
      )
      .get(jobId) as
      | { jobId: string; event_id: string; photo_url: string; image_url: string | null; guest_name: string; captured_at: number }
      | undefined;
    if (!row) return undefined;
    return {
      jobId: row.jobId,
      eventId: row.event_id,
      photoUrl: row.image_url ?? row.photo_url,
      guestName: row.guest_name,
      capturedAt: row.captured_at,
    };
  }

  /**
   * Deletes ONE photo row, by primary key (CMS-05).
   *
   * A second hand-driven deletion path, and deliberately not a relaxation of
   * D-11. D-11 says photo history is "kept per event, deleted only by hand"
   * and forbids automation: no expiry, no row cap, no scheduled cleanup, no
   * delete-on-event-switch. This is as hand-driven as `deleteEventPhotos` —
   * one operator, one confirmed click, one row — and it exists because the
   * alternative an operator actually had was clearing an entire wedding's
   * history to remove a single failed capture.
   *
   * Returns whether a row went away, so the caller reports what happened
   * instead of assuming. A jobId that is already gone is `false`, not an
   * error: two operators closing the same broken capture is not a fault.
   */
  deleteEventPhoto(jobId: string): boolean {
    return this.db.prepare('DELETE FROM event_photo WHERE jobId = ?').run(jobId).changes > 0;
  }

  /**
   * Deletes one event, its photo history, and — when it was the live one —
   * the active pointer, as a single transaction (plan 08-03, D-11).
   *
   * This is the ONLY caller of deleteEventPhotos() that is not the operator
   * asking to clear a history directly, and it exists because the UI-SPEC's
   * destructive confirmation promises exactly this: "Toàn bộ cấu hình và lịch
   * sử ảnh sẽ mất." Deleting the row while leaving orphaned photo rows behind
   * would make that sentence false, and D-11's "deleted only by hand" is about
   * timers and row caps, not about an explicit typed confirmation.
   *
   * The pointer is cleared rather than left dangling. getActiveEventConfig()
   * survives a dangling pointer by design (it warns and serves the shipped
   * defaults), but leaving one would mean every subsequent read logs a warning
   * about a decision the operator made deliberately.
   *
   * queue_job and booth_state are not named anywhere in here. Deleting an
   * event is not a reason to touch a guest who is still waiting to be
   * photographed.
   */
  deleteEvent(id: string): { deleted: boolean; photosDeleted: number; wasActive: boolean } {
    const run = this.db.transaction((eventId: string) => {
      const wasActive = this.getActiveEventId() === eventId;
      const photosDeleted = this.deleteEventPhotos(eventId);
      const deleted = this.db.prepare('DELETE FROM event WHERE id = ?').run(eventId).changes === 1;
      if (deleted && wasActive) this.setActiveEvent(null);
      return { deleted, photosDeleted, wasActive };
    });
    return run(id);
  }

  // ---------------------------------------------------------------------
  // Phase 8 — Agent configuration with one step of history (D-18)
  // ---------------------------------------------------------------------

  /**
   * Whether the row EXISTS, regardless of whether its blob parses.
   *
   * `getAgentConfig()` answers `undefined` for two different worlds — "never
   * configured" and "configured, but the blob is corrupt" — and a caller that
   * responds to the first by WRITING must not take that action in the second.
   * Seeding over a corrupt row rotates the corrupt blob into `previous_json`
   * and destroys D-18's one step back at the exact moment it would be reached
   * for (Phase 8 code review, WR-07). This is the seam that keeps the two
   * apart.
   */
  hasAgentConfigRow(): boolean {
    const row = this.db.prepare('SELECT 1 AS present FROM agent_config WHERE id = 1').get() as
      | { present: number }
      | undefined;
    return row !== undefined;
  }

  getAgentConfig(): Record<string, unknown> | undefined {
    const row = this.db.prepare('SELECT current_json FROM agent_config WHERE id = 1').get() as
      | { current_json: string }
      | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.current_json) as Record<string, unknown>;
    } catch {
      // A corrupt blob must not take the CMS down; the operator re-saves.
      // Callers that would WRITE on `undefined` must consult
      // `hasAgentConfigRow()` first — see its docstring.
      logger.warn('agent_config.current_json is not valid JSON — treating as unset');
      return undefined;
    }
  }

  /**
   * Writes `next` as current and rotates the OLD current into previous.
   *
   * The read and the write share one statement (the UPSERT's excluded/target
   * reference), so there is no window in which previous has been overwritten
   * but current has not — a crash between two separate statements would
   * otherwise leave both slots holding the same value and silently destroy
   * the one step back D-18 promises.
   */
  saveAgentConfig(next: Record<string, unknown>): void {
    this.db.prepare(
      `INSERT INTO agent_config (id, current_json, previous_json, updated_at)
       VALUES (1, ?, NULL, ?)
       ON CONFLICT(id) DO UPDATE SET
         previous_json = agent_config.current_json,
         current_json  = excluded.current_json,
         updated_at    = excluded.updated_at`
    ).run(JSON.stringify(next), new Date().toISOString());
  }

  /**
   * D-18's one-step "restore previous". Returns the restored configuration,
   * or undefined when there is nothing to step back to.
   *
   * previous_json is CLEARED by the restore, which is what makes this one
   * step rather than a two-entry ring. Without that, a second restore would
   * hand back the configuration the operator had just rejected — the same
   * button doing the opposite thing on the second press, with no indication
   * it had.
   */
  restorePreviousAgentConfig(): Record<string, unknown> | undefined {
    const row = this.db.prepare('SELECT previous_json FROM agent_config WHERE id = 1').get() as
      | { previous_json: string | null }
      | undefined;
    if (!row?.previous_json) return undefined;

    const restored = row.previous_json;

    // PARSE BEFORE WRITING. The original order wrote previous_json into
    // current_json and only then discovered it would not parse — so a corrupt
    // previous took the working current down with it and returned undefined,
    // leaving the operator with no configuration and no step back (the same
    // defect as WR-07, reached from the other end).
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(restored) as Record<string, unknown>;
    } catch {
      logger.warn(
        'agent_config.previous_json is not valid JSON — refusing the restore and leaving current intact',
      );
      return undefined;
    }

    this.db.prepare(
      `UPDATE agent_config SET current_json = ?, previous_json = NULL, updated_at = ? WHERE id = 1`
    ).run(restored, new Date().toISOString());

    return parsed;
  }

  close(): void {
    this.db.close();
  }
}

let store: LocalStore | null = null;
export function getStore(): LocalStore {
  if (!store) store = new LocalStore();
  return store;
}
