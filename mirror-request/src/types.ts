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
  // status holds one of: queued, dispatched, in_progress, completed, failed
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
}

export interface DisplaySnapshot {
  currentJob: QueueJob | null;
  queuePosition: number;
  queueLength: number;
  boothState: BoothState;
  agentOnline: boolean;
  guestName: string | null;
  countdownSeconds: number | null;
  announcementEndsAt: number | null;
  upNext: Array<{ jobId: string; name: string; position: number }>;
}

export interface EnvConfig {
  PORT: number;
  HOST: string;
  AGENT_WS_TOKEN: string;
  PROXY_IP_WHITELIST: string[];
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
  SESSION_MAX_RETRIES: number;
  HEARTBEAT_TIMEOUT_MS: number;
  NOTIFY_MAX_RETRIES: number;
  NOTIFY_RETRY_BASE_DELAY_MS: number;
  NOTIFY_WEBHOOK_URL: string;
  LOCAL_STORE_PATH: string;
  LOG_LEVEL: string;
  WEBHOOK_HMAC_SECRET: string;
  WEBHOOK_TIMESTAMP_SKEW_MS: number;
  REGISTRATION_DEDUP_WINDOW_MS: number;
}
