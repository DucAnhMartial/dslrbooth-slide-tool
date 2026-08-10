import dotenv from 'dotenv';
import type { EnvConfig } from './types.js';

dotenv.config();

export function loadConfig(): EnvConfig {
  const errors: string[] = [];
  const get = (key: string): string | undefined => process.env[key];

  const toNum = (key: string, fallback: number): number => {
    const val = get(key);
    if (val === undefined) return fallback;
    const n = Number.parseInt(val, 10);
    if (Number.isNaN(n)) {
      errors.push(`${key} must be a number, got "${val}"`);
      return fallback;
    }
    return n;
  };

  const toBool = (key: string, fallback: boolean): boolean => {
    const val = get(key);
    if (val === undefined) return fallback;
    return val === 'true' || val === '1';
  };

  const toCSV = (key: string, fallback: string[]): string[] => {
    const val = get(key);
    if (!val) return fallback;
    return val.split(',').map(s => s.trim()).filter(Boolean);
  };

  const required = (key: string, placeholder: string): string => {
    const val = get(key);
    if (!val || val === placeholder) {
      errors.push(`${key} must be configured (not placeholder)`);
    }
    return val ?? '';
  };

  required('AGENT_WS_TOKEN', 'replace-with-agent-token');
  required('DB_PASSWORD', 'replace-with-readonly-password');
  // Delivery is handled by the optional photo webhook. SMTP/Twilio settings
  // remain in the config type for backwards compatibility but are not needed.

  // D-09: "Production requires both controls [HMAC + IP allow-list]; other
  // environments may configure them." Chosen mechanism: NODE_ENV === 'production'
  // drives *mandatory configuration* (fail-fast at startup); runtime enforcement
  // is driven by whether each control is configured (see mirrorReceiver.ts). No
  // separate ENFORCE_WEBHOOK_AUTH-style toggle is added — an explicit toggle
  // would create a supported way to *disable* webhook authentication in
  // production, which is exactly what D-09 forbids. NODE_ENV is already the
  // strictness signal this codebase uses (see the console-transport gate in
  // logging/logger.ts). (RESEARCH.md Open Question 3 / Assumption A3)
  const nodeEnv = get('NODE_ENV') ?? 'development';
  const isProduction = nodeEnv === 'production';
  const webhookSecret = get('WEBHOOK_HMAC_SECRET') ?? '';
  const ipWhitelist = toCSV('PROXY_IP_WHITELIST', ['127.0.0.1']);

  if (isProduction && !webhookSecret) {
    errors.push('WEBHOOK_HMAC_SECRET must be configured in production (D-09)');
  }
  if (isProduction && (ipWhitelist.length === 0 || (ipWhitelist.length === 1 && ipWhitelist[0] === '127.0.0.1'))) {
    errors.push('PROXY_IP_WHITELIST must be configured in production with the real reverse-proxy IPs (D-09)');
  }

  if (errors.length > 0) {
    throw new Error(`Configuration errors:\n  - ${errors.join('\n  - ')}`);
  }

  return {
    PORT: toNum('PORT', 3002),
    HOST: get('HOST') ?? '0.0.0.0',
    AGENT_WS_TOKEN: get('AGENT_WS_TOKEN') ?? '',
    PROXY_IP_WHITELIST: ipWhitelist,
    DB_HOST: get('DB_HOST') ?? 'localhost',
    // MySQL default port. Was previously 5432 (a Postgres-era leftover) —
    // the poller reads MySQL, not Postgres (RESEARCH.md Pitfall 4).
    DB_PORT: toNum('DB_PORT', 3306),
    DB_NAME: get('DB_NAME') ?? 'photobooth',
    DB_USER: get('DB_USER') ?? 'extension_service_ro',
    DB_PASSWORD: get('DB_PASSWORD') ?? '',
    DB_POLL_INTERVAL_MS: toNum('DB_POLL_INTERVAL_MS', 3000),
    DB_POLL_BATCH_SIZE:  toNum('DB_POLL_BATCH_SIZE', 50),
    SMTP_HOST: get('SMTP_HOST') ?? 'smtp.example.com',
    SMTP_PORT: toNum('SMTP_PORT', 587),
    SMTP_SECURE: toBool('SMTP_SECURE', false),
    SMTP_USER: get('SMTP_USER') ?? 'no-reply@example.com',
    SMTP_PASS: get('SMTP_PASS') ?? '',
    EMAIL_FROM: get('EMAIL_FROM') ?? 'Photo Booth <no-reply@example.com>',
    TWILIO_ACCOUNT_SID: get('TWILIO_ACCOUNT_SID') ?? '',
    TWILIO_AUTH_TOKEN: get('TWILIO_AUTH_TOKEN') ?? '',
    TWILIO_FROM_NUMBER: get('TWILIO_FROM_NUMBER') ?? '+15550000000',
    SESSION_TIMEOUT_MS:       toNum('SESSION_TIMEOUT_MS',  300_000),
    NEXT_GUEST_COUNTDOWN_MS:  toNum('NEXT_GUEST_COUNTDOWN_MS', 7000),
    SESSION_MAX_RETRIES:      toNum('SESSION_MAX_RETRIES', 2),
    HEARTBEAT_TIMEOUT_MS:     toNum('HEARTBEAT_TIMEOUT_MS',  30_000),
    // D-15: default flipped from 3 to 2. D-08 changes the number's meaning
    // from "total attempts" to "retries after the first attempt" — holding
    // this at 3 would silently turn today's 3 real attempts into 4. Together
    // with the semantic flip, behaviour is unchanged (still 3 total
    // attempts), and the value now matches SESSION_MAX_RETRIES's meaning.
    NOTIFY_MAX_RETRIES:       toNum('NOTIFY_MAX_RETRIES',       2),
    NOTIFY_RETRY_BASE_DELAY_MS: toNum('NOTIFY_RETRY_BASE_DELAY_MS', 1000),
    NOTIFY_FETCH_TIMEOUT_MS: toNum('NOTIFY_FETCH_TIMEOUT_MS', 10_000),
    NOTIFY_SWEEP_INTERVAL_MS: toNum('NOTIFY_SWEEP_INTERVAL_MS', 3_000),
    NOTIFY_CLAIM_LEASE_MS: toNum('NOTIFY_CLAIM_LEASE_MS', 60_000),
    NOTIFY_WEBHOOK_URL: get('NOTIFY_WEBHOOK_URL') ?? '',
    LOCAL_STORE_PATH: get('LOCAL_STORE_PATH') ?? './data/extension-service.sqlite',
    LOG_LEVEL: get('LOG_LEVEL') ?? 'info',
    WEBHOOK_HMAC_SECRET: webhookSecret,
    WEBHOOK_TIMESTAMP_SKEW_MS: toNum('WEBHOOK_TIMESTAMP_SKEW_MS', 300_000),
    REGISTRATION_DEDUP_WINDOW_MS: toNum('REGISTRATION_DEDUP_WINDOW_MS', 300_000),
  };
}

let cached: EnvConfig | null = null;
export function getConfig(): EnvConfig {
  if (!cached) {
    cached = loadConfig();
  }
  return cached;
}
