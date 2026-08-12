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
  };
}

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
      -- 08-05). No auto-expiry, no row cap, no scheduled cleanup, no
      -- delete-on-event-switch. This is the same discipline pending_print's
      -- header above states for expired rows, and for a related reason: these
      -- rows are a guest-facing record, and the operator — not a timer — owns
      -- when a wedding's photos stop existing.
      CREATE TABLE IF NOT EXISTS event_photo (
        jobId       TEXT PRIMARY KEY,
        event_id    TEXT NOT NULL,
        guest_name  TEXT NOT NULL,
        photo_url   TEXT NOT NULL,
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
  // that side effect.
  setBoothState(state: BoothState): void {
    // Its only production caller is beginAnnouncement()'s 'ANNOUNCING'
    // write, when no job owns the booth yet — current_job_id stays NULL.
    this.db.prepare("INSERT OR REPLACE INTO booth_state (id, state, updated_at, current_job_id) VALUES (1, ?, ?, NULL)").run(state, new Date().toISOString());
  }

  setBoothBusy(jobId: string | null = null): void {
    this.db.prepare("INSERT OR REPLACE INTO booth_state (id, state, updated_at, current_job_id) VALUES (1, 'BUSY', ?, ?)").run(new Date().toISOString(), jobId);
  }

  // The explicit NULL here IS D-06's "cleared when the booth is released"
  // guarantee, the same discipline requeueNoRetry() applies to retries: it
  // must not be replaced by an application-level clear that a later edit
  // could delete. current_job_id's absence from the booth once it is IDLE is
  // enforced by this write itself, not by a caller remembering to clear it.
  setBoothIdle(): void {
    this.db.prepare("INSERT OR REPLACE INTO booth_state (id, state, updated_at, current_job_id) VALUES (1, 'IDLE', ?, NULL)").run(new Date().toISOString());
  }

  setBoothTimeout(reason: string): void {
    this.db.prepare("INSERT OR REPLACE INTO booth_state (id, state, updated_at, current_job_id) VALUES (1, 'IDLE', ?, NULL)").run(new Date().toISOString());
    logger.warn(`Booth timeout reset: ${reason}`);
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

  getQueueLength(): number {
    return this.getQueuedJobs().length;
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
  getPendingPrint(jobId: string): { jobId: string; compositePath: string; status: string; openedAt: number; expiresAt: number } | undefined {
    const row = this.db.prepare('SELECT jobId, composite_path, status, opened_at, expires_at FROM pending_print WHERE jobId = ?').get(jobId) as
      | { jobId: string; composite_path: string | null; status: string; opened_at: number; expires_at: number }
      | undefined;
    return row
      ? {
          jobId: row.jobId,
          compositePath: row.composite_path ?? '',
          status: row.status,
          openedAt: row.opened_at,
          expiresAt: row.expires_at,
        }
      : undefined;
  }

  // Same omission-as-guarantee discipline as getDueNotifications() above:
  // 'resolved' is deliberately ABSENT from this predicate, and that absence IS
  // the guarantee that a repeated or replayed print upload cannot enqueue a
  // second notification for the same job (T-07-12). There is no
  // application-level `if (alreadySent)` anywhere for a later edit to delete —
  // the second UPDATE simply matches zero rows and this returns false.
  //
  // 'expired' is deliberately PRESENT for the opposite reason: D-11 says a
  // print that arrives after its slot expired is still delivered to the guest,
  // so an expired row must remain resolvable. Getting the photo late beats not
  // getting it.
  resolvePendingPrint(jobId: string, resolvedAt: number): boolean {
    const result = this.db.prepare(`
      UPDATE pending_print
      SET status = 'resolved', resolved_at = ?, updated_at = ?
      WHERE jobId = ? AND status IN ('awaiting','expired')
    `).run(resolvedAt, new Date().toISOString(), jobId);
    return result.changes === 1;
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
    const row = this.db.prepare(
      `SELECT photo_url, guest_name, captured_at FROM event_photo
       WHERE event_id = ? ORDER BY captured_at DESC LIMIT 1`
    ).get(eventId) as { photo_url: string; guest_name: string; captured_at: number } | undefined;
    if (!row) return undefined;
    return { photoUrl: row.photo_url, guestName: row.guest_name, capturedAt: row.captured_at };
  }

  /** Newest first, for the CMS photo-history page (paginated at 50/page). */
  listEventPhotos(
    eventId: string,
    opts: { limit: number; offset: number },
  ): Array<{ jobId: string; photoUrl: string; guestName: string; capturedAt: number }> {
    const rows = this.db.prepare(
      `SELECT jobId, photo_url, guest_name, captured_at FROM event_photo
       WHERE event_id = ? ORDER BY captured_at DESC LIMIT ? OFFSET ?`
    ).all(eventId, opts.limit, opts.offset) as Array<{
      jobId: string; photo_url: string; guest_name: string; captured_at: number;
    }>;
    return rows.map((row) => ({
      jobId: row.jobId,
      photoUrl: row.photo_url,
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

  // ---------------------------------------------------------------------
  // Phase 8 — Agent configuration with one step of history (D-18)
  // ---------------------------------------------------------------------

  getAgentConfig(): Record<string, unknown> | undefined {
    const row = this.db.prepare('SELECT current_json FROM agent_config WHERE id = 1').get() as
      | { current_json: string }
      | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.current_json) as Record<string, unknown>;
    } catch {
      // A corrupt blob must not take the CMS down; the operator re-saves.
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
    this.db.prepare(
      `UPDATE agent_config SET current_json = ?, previous_json = NULL, updated_at = ? WHERE id = 1`
    ).run(restored, new Date().toISOString());

    try {
      return JSON.parse(restored) as Record<string, unknown>;
    } catch {
      logger.warn('agent_config.previous_json is not valid JSON — restored value is unusable');
      return undefined;
    }
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
