import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { logger, setLogLevel } from '../logging/logger';

// D-12 reconciliation (07-02-PLAN.md): this module adds no new configuration
// key. It only makes the existing LOG_LEVEL key re-readable at runtime — the
// "without a redeploy" half of SC-5. Raising the AGT-04 event lines from
// debug to info unconditionally (plan 07-05) is a separate change; this
// module never gates whether a log line is emitted, only the sink threshold
// every line already passes through.

export interface ReloadLogLevelResult {
  previous: string;
  current: string;
  changed: boolean;
  source: 'file' | 'env' | 'none';
}

/**
 * Reloads LOG_LEVEL from a `.env`-shaped file and applies it via
 * setLogLevel(). Uses `dotenv.parse` — NOT `dotenv.config` — because `parse`
 * returns a plain object and never mutates `process.env`. A signal handler
 * must not silently rewrite the process environment out from under code
 * that already read `process.env` at startup (config.ts's `loadConfig()`
 * runs once, at import time, and must not be surprised by a later reload).
 *
 * Only the LOG_LEVEL key is ever read from the parsed file — no other key,
 * and no file content, reaches a log line (T-07-08).
 *
 * Never throws: this is a signal-handler boundary (Phase 1 D-05's "never
 * crash on a boundary, log and continue").
 */
export function reloadLogLevelFromEnvFile(
  envPath: string = path.resolve(process.cwd(), '.env')
): ReloadLogLevelResult {
  let fileLevel: string | undefined;

  try {
    const raw = fs.readFileSync(envPath, 'utf8');
    const parsed = dotenv.parse(raw);
    fileLevel = parsed.LOG_LEVEL;
  } catch {
    // File missing/unreadable — fall through to the process.env fallback
    // below. Never throws past this boundary.
    fileLevel = undefined;
  }

  if (fileLevel !== undefined) {
    const result = setLogLevel(fileLevel);
    return { ...result, source: 'file' };
  }

  const envLevel = process.env.LOG_LEVEL;
  if (envLevel !== undefined) {
    const result = setLogLevel(envLevel);
    return { ...result, source: 'env' };
  }

  const previous = logger.level;
  logger.warn('Log level reload: no LOG_LEVEL found in the env file or process.env — level unchanged');
  return { previous, current: previous, changed: false, source: 'none' };
}

/**
 * Registers a signal handler that reloads LOG_LEVEL from `.env` on receipt
 * of `signal`. Returns an unregister function so callers (and tests) can
 * remove the listener deterministically.
 *
 * Default signal is SIGHUP, deliberately not SIGUSR2: SIGUSR2 is claimed by
 * common Node deployment tooling (PM2's log-file reopening, nodemon's
 * restart-on-signal), so binding the level reload to it would collide with
 * the deployment's own signal use. An unhandled SIGHUP terminates the
 * process by default — registering a handler for it converts that
 * terminate-on-signal default into a safe, in-place reload, and that
 * conversion must happen exactly once, at startup, which is why
 * src/index.ts calls this only once.
 */
export function registerLogLevelSignalHandler(
  signal: NodeJS.Signals = 'SIGHUP',
  envPath?: string
): () => void {
  const handler = (): void => {
    try {
      const result = reloadLogLevelFromEnvFile(envPath);
      // Deliberately warn, not info: the confirmation must stay visible even
      // when the operator has pinned the process above `info`. Note: pinning
      // the level above `warn` silences this confirmation line itself — that
      // is standard logging semantics (a raised threshold silences its own
      // announcement), not a bug in this handler.
      logger.warn(
        `Log level reload (${signal}): ${result.previous} -> ${result.current}` +
          (result.changed ? '' : ' (unchanged)')
      );
    } catch (err) {
      // Never let a signal handler crash the process (T-07-09).
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Log level reload (${signal}) failed: ${message}`);
    }
  };

  process.on(signal, handler);
  return () => process.off(signal, handler);
}
