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

  if (errors.length > 0) {
    throw new Error(`Configuration errors:\n  - ${errors.join('\n  - ')}`);
  }

  return {
    PORT: toNum('PORT', 3002),
    HOST: get('HOST') ?? '0.0.0.0',
    AGENT_WS_TOKEN: get('AGENT_WS_TOKEN') ?? '',
    PROXY_IP_WHITELIST: toCSV('PROXY_IP_WHITELIST', ['127.0.0.1']),
    DB_HOST: get('DB_HOST') ?? 'localhost',
    DB_PORT: toNum('DB_PORT', 5432),
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
    HEARTBEAT_TIMEOUT_MS:     toNum('HEARTBEAT_TIMEOUT_MS',  30_000),
    NOTIFY_MAX_RETRIES:       toNum('NOTIFY_MAX_RETRIES',       3),
    NOTIFY_RETRY_BASE_DELAY_MS: toNum('NOTIFY_RETRY_BASE_DELAY_MS', 1000),
    NOTIFY_WEBHOOK_URL: get('NOTIFY_WEBHOOK_URL') ?? '',
    LOCAL_STORE_PATH: get('LOCAL_STORE_PATH') ?? './data/extension-service.sqlite',
    LOG_LEVEL: get('LOG_LEVEL') ?? 'info',
    WEBHOOK_HMAC_SECRET: get('WEBHOOK_HMAC_SECRET') ?? '',
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
