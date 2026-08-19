export type BoothState = 'IDLE' | 'ANNOUNCING' | 'BUSY' | 'TIMEOUT_RESET';

export interface Registration {
  id: string;
  name: string;
  email: string;
  phone: string;
  mode: string;
  qr_token?: string;
  registered_at: string;
}

export interface QueueJob {
  id: string;
  registration: Registration;
  // status holds one of: queued, dispatched, in_progress, completed, failed,
  // no_photo. The last is Phase 7 D-09's terminal outcome for a session that
  // ended with no print composite ever seen — distinct from 'completed' (a
  // session that produced a photo) and from 'failed' (a job that exhausted
  // the retry budget). The authoritative list is KNOWN_JOB_STATUSES in
  // src/status/guestStatus.ts, which is what the guest-facing mapping is
  // compile-checked against; keep this comment in step with it.
  status: string;
  queued_at: number;
  dispatched_at?: number;
  acknowledged_at?: number;
  session_started_at?: number;
  session_ended_at?: number;
  completed_at?: number;
  ack_error_message?: string;
  stall_reason?: string;
  retries: number;
}

export interface AgentMessage {
  type: 'command' | 'ack' | 'event';
  action?: string;
  jobId?: string;
  mode?: string;
  ok?: boolean;
  errorMessage?: string;
  eventType?: 'session_start' | 'session_end' | 'file_upload';
  payload?: Record<string, unknown>;
  timestamp: number;
}

export interface AgentConnection {
  ws: WebSocket;
  id: string;
  connectedAt: number;
  lastHeartbeat: number;
  online: boolean;
}

export interface DBPollCursor {
  table: string;
  lastPolledId: string;
  lastPolledAt: string;
}

export interface NotificationRecord {
  jobId: string;
  channel: 'email' | 'sms' | 'webhook';
  recipient: string;
  status: string;
  attempts: number;
  lastAttemptAt?: string;
  errorMessage?: string;
  deliveredAt?: string;
  lastError?: string;
  photoUrl?: string;
  dueAt?: number;
}

/**
 * Phase 8 CMS-01: the room screen's per-event presentation contract, and the
 * ONLY shape of event data that ever reaches the display wire.
 *
 * This is a purpose-built projection, never a raw `event` row — the same
 * discipline `DisplaySnapshot`'s own header comment below pins for
 * `queue_job`. `event` carries operator-facing columns (`created_at`,
 * `updated_at`) that have no business on a TV, and future columns added for
 * the CMS must not silently ride out to every screen because someone widened
 * a `SELECT *`.
 *
 * Every field except the four asset/id nullables is non-null by construction:
 * `LocalStore.getActiveEventConfig()` coalesces each unset column onto
 * `DEFAULT_EVENT_CONFIG`, which is what makes UI-01 ("the idle screen renders
 * correctly before any event exists") hold with zero rows in `event` and with
 * a brand-new, entirely uncustomized event alike.
 *
 * `id` is null when no event is active — the screen is running on shipped
 * defaults. It is NOT an error state and must never render as one.
 */
export interface EventConfig {
  id: string | null;
  name: string;
  logoUrl: string | null;
  backgroundUrl: string | null;
  colorDominant: string;
  colorSecondary: string;
  colorAccent: string;
  colorText: string;
  colorTextMuted: string;
  fontChoice: string;
  idleHeading: string;
  idleSub: string;
  qrImageUrl: string | null;
  qrCtaText: string;
  photoCount: number;
  photoDurationMs: number;
  layoutStyle: string;
  // D9-04 (phase 9): two per-event display toggles, both defaulting ON so an
  // operator who never opens the form sees no change on either view. They
  // are EVENT configuration, not view configuration — both the default
  // screen and the slides-only screen (`?view=slides`) honour them.
  // showGuestName gates the guest's name drawn beside a photo; heroEnabled
  // gates D-09's just-captured takeover (off means the capture still joins
  // the slideshow rotation, it simply does not take over the screen).
  showGuestName: boolean;
  guestNameTemplate: string;
  captionPosition: CaptionPosition;
  photoFit: PhotoFit;
  /** Slides-only operator CSS. It is applied as style text, never HTML. */
  customCss: string;
  /**
   * CMS-10: how strongly the event background image is dimmed behind the
   * content, 0-100. Zero shows the artwork untouched.
   *
   * Configurable rather than constant because the correct value belongs to the
   * customer's own image: both room screens hard-coded a heavy dim so that
   * white type stayed legible over a bright photograph, which made a
   * deliberately dark, low-contrast backdrop nearly invisible. The operator
   * can see their screen; this software cannot.
   */
  backgroundOverlay: number;
  heroEnabled: boolean;
}

export type CaptionPosition =
  | 'top-left' | 'top-center' | 'top-right'
  | 'middle-left' | 'middle-center' | 'middle-right'
  | 'bottom-left' | 'bottom-center' | 'bottom-right';

export type PhotoFit = 'contain' | 'cover' | 'contain_blur';

export interface DisplaySnapshot {
  // D-15: no `currentJob: QueueJob` field exists here, deliberately. The
  // guarantee that no operator column (registration_id, stall_reason,
  // retries, ack_error_message, ...) can reach the display wire lives in
  // this type's SHAPE — in what it does not have — not in a null check or
  // a delete-the-sensitive-fields step that a later edit could remove. Do
  // not add a raw QueueJob (or any subset of its fields) back onto this
  // type; add a purpose-built projection field instead.
  queuePosition: number;
  queueLength: number;
  boothState: BoothState;
  agentOnline: boolean;
  guestName: string | null;
  countdownSeconds: number | null;
  announcementEndsAt: number | null;
  upNext: Array<{ jobId: string; name: string; position: number }>;
  // CMS-01/D-12: the active event's presentation config. Every screen opens
  // the same URL and renders whatever event is active, so this rides the
  // existing snapshot rather than a per-screen URL or a second feed. It is
  // never null — see EventConfig above.
  eventConfig: EventConfig;
  // D-09's hero moment: the guest who JUST finished shooting, distinct from
  // `guestName` above (the guest being ANNOUNCED). At one instant those are
  // two different people — one walking away from the booth, one walking
  // towards it — and collapsing them onto one field is the D-09 failure mode.
  //
  // A two-key projection, never an `event_photo` row: the same D-15 shape
  // discipline the header note above pins for `queue_job`.
  //
  // It is DERIVED inside buildSnapshot() on every evaluation from the newest
  // capture's stored `captured_at` versus an injected TTL — it is not a field
  // that anything sets or clears. See displayServer.ts for why that is the
  // only implementation that survives a restart mid-hero-moment.
  justCaptured: { photoUrl: string; name: string } | null;
  // D-10: the slideshow's source, newest first, capped at
  // `eventConfig.photoCount` at build time so the rendered DOM stays bounded
  // however large the durable history grows (T-08-11). Same narrow projection
  // rule as `justCaptured`.
  photos: Array<{ photoUrl: string; name: string }>;
}

export interface EnvConfig {
  PORT: number;
  HOST: string;
  AGENT_WS_TOKEN: string;
  PROXY_IP_WHITELIST: string[];
  // D-09: the room's big screen is gated by its own separate allow-list, not
  // by PROXY_IP_WHITELIST — the two surfaces (webhook ingestion vs. the
  // display) sit behind different network topologies and must be
  // independently configurable. Default is an empty array (dev escape
  // hatch); production fails fast when it is left unset (config.ts).
  DISPLAY_IP_WHITELIST: string[];
  // D-13 (phase 8): the CMS's own, INDEPENDENT allow-list. Deliberately not a
  // reuse of DISPLAY_IP_WHITELIST's value (RESEARCH Pitfall 2): the two lists
  // describe different audiences on different network paths — the operator's
  // laptop versus the room's TVs. Sharing one value would either lock the
  // operator out or expose the CMS to every address that can reach a TV.
  // Only the isWhitelisted() *function* is shared. Production fails fast when
  // unset, exactly as DISPLAY_IP_WHITELIST does.
  CMS_IP_WHITELIST: string[];
  // D-14 (phase 8): the single operator account. CMS_PASSWORD_HASH holds a
  // salted scrypt digest (salt:hash hex), NEVER a plaintext password — mint it
  // offline with `npm run cms:hash-password`. No code path in this service
  // receives, prints, or logs a plaintext CMS password.
  CMS_USERNAME: string;
  CMS_PASSWORD_HASH: string;
  CMS_SESSION_COOKIE_NAME: string;
  // D-15: where uploaded branding assets are written and served from — one
  // directory, deliberately outside the code tree. CMS_UPLOAD_MAX_BYTES caps
  // a single asset; the route-scoped body parser in index.ts is sized from it
  // with base64 headroom, so the global 100kb default stays in force for
  // every other route including /on-register.
  CMS_UPLOAD_DIR: string;
  CMS_UPLOAD_MAX_BYTES: number;
  DB_HOST: string;
  DB_PORT: number;
  DB_NAME: string;
  DB_USER: string;
  DB_PASSWORD: string;
  DB_POLL_INTERVAL_MS: number;
  DB_POLL_BATCH_SIZE: number;
  SMTP_HOST: string;
  SMTP_PORT: number;
  SMTP_SECURE: boolean;
  SMTP_USER: string;
  SMTP_PASS: string;
  EMAIL_FROM: string;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_FROM_NUMBER: string;
  SESSION_TIMEOUT_MS: number;
  NEXT_GUEST_COUNTDOWN_MS: number;
  // D-02 (phase 7): the booth-release fallback deadline — a guest who walks
  // away without exiting dslrBooth's sharing screen (so no session_end ever
  // arrives) returns the booth to service after this many ms once the job
  // completes. Deliberately NOT SESSION_TIMEOUT_MS: that timer stalls a job
  // that never got acknowledged and charges a retry through handleStall();
  // this one releases an already-completed job and must never charge one.
  BOOTH_RELEASE_TIMEOUT_MS: number;
  // D11-06 (phase 11): how long an unapproved attempt's session_end holds the
  // booth open before the grace door (finalizePendingPrint(jobId, 'grace'))
  // fires. A REAL environment key — unlike PENDING_PRINT_EXPIRY_MS/
  // NO_PHOTO_CLOSE_DELAY_MS (D-12 module constants, deliberately NOT here) —
  // because D11-06 explicitly wants operator-tunable-without-rebuild. Read
  // once at startup; SIGHUP reloads only LOG_LEVEL, so changing this needs a
  // process restart, not a rebuild.
  RETAKE_GRACE_MS: number;
  // D-04: both the minimum sample count and the cold-start duration are
  // configuration, not literals. No literal for either may appear outside
  // config.ts — an estimator that hardcodes its own fallback cannot be tuned
  // for a venue whose sessions are systematically longer or shorter.
  WAIT_ESTIMATE_SAMPLE_SIZE: number;
  WAIT_ESTIMATE_MIN_SAMPLES: number;
  WAIT_ESTIMATE_DEFAULT_MS: number;
  SESSION_MAX_RETRIES: number;
  HEARTBEAT_TIMEOUT_MS: number;
  NOTIFY_MAX_RETRIES: number;
  NOTIFY_RETRY_BASE_DELAY_MS: number;
  NOTIFY_FETCH_TIMEOUT_MS: number;
  NOTIFY_SWEEP_INTERVAL_MS: number;
  NOTIFY_CLAIM_LEASE_MS: number;
  // D-09 (phase 6): the VIEW health probe's own cadence. Deliberately has no
  // enable/disable toggle, matching config.ts:46-54's reasoning for
  // PROXY_IP_WHITELIST — a toggle would create a supported way to switch off
  // the only signal that ingestion is dead.
  VIEW_PROBE_INTERVAL_MS: number;
  // D-10 (phase 6): the /status/:jobId rate limiter's window/threshold/memory
  // cap. `registrations.id` is a CSPRNG-minted 40-bit value (ets_web's
  // short_code.py), not a secret with unlimited entropy — this limiter is
  // the compensating control that makes the capability-URL design sound at
  // that width. No production fail-fast check, deliberately: unlike
  // DISPLAY_IP_WHITELIST these have site-independent defaults that are
  // correct out of the box (rateLimiter.ts has the full arithmetic).
  STATUS_RATE_LIMIT_WINDOW_MS: number;
  STATUS_RATE_LIMIT_MAX: number;
  STATUS_RATE_LIMIT_MAX_KEYS: number;
  // Phase 8 code review, WR-01: the same control applied to POST /cms/login,
  // whose credential is a single scrypt hash at N=2^14 (a measured ceiling,
  // not a preference — see SCRYPT_PARAMS in cmsAuth.ts). D-13's IP allow-list
  // is the first line, but an allow-list entry is commonly a whole venue
  // subnet, and inside one an attacker had unlimited online guesses.
  CMS_LOGIN_RATE_LIMIT_WINDOW_MS: number;
  CMS_LOGIN_RATE_LIMIT_MAX: number;
  CMS_LOGIN_RATE_LIMIT_MAX_KEYS: number;
  NOTIFY_WEBHOOK_URL: string;
  LOCAL_STORE_PATH: string;
  LOG_LEVEL: string;
  WEBHOOK_HMAC_SECRET: string;
  WEBHOOK_TIMESTAMP_SKEW_MS: number;
  REGISTRATION_DEDUP_WINDOW_MS: number;
}
