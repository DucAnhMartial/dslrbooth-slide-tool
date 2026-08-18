import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { getConfig } from '../config';

const config = getConfig();

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /\+?\d{7,}/g;

export function mask(value: string): string {
  return value
    .replace(PHONE_RE, m => '*'.repeat(m.length))
    .replace(EMAIL_RE, '[EMAIL REDACTED]');
}

const formatFile = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.printf(({ level, message, label, stack }) => {
    const masked = typeof message === 'string' ? mask(message) : message;
    const meta = label ? ` [${label}]` : '';
    const s = stack ? `\n${stack}` : '';
    return `${level}${meta}: ${masked}${s}`;
  })
);

/**
 * The rotating operational log — every mode EXCEPT test.
 *
 * Measured 2026-08-16: a single `vitest run` wrote 20 `error` lines into
 * `logs/extension-service-<today>.log`, the same file an operator reads to
 * find out what a booth did during an event. None of the 20 was real — they
 * were synthetic fixtures (`job-a ... boom`, `weird_unmapped_status`) from
 * suites deliberately exercising failure paths. Deciding the running service
 * was healthy that day meant reading the file and hand-filtering fixtures out
 * of it.
 *
 * That is worse than untidy. This log is diagnostic evidence, and evidence
 * that has to be filtered before it can be trusted is evidence people stop
 * consulting — which is exactly the failure this phase's /health endpoint was
 * added to end. A suite that manufactures errors on purpose must not deposit
 * them where real errors are looked for.
 *
 * Suppressed by NODE_ENV rather than by an opt-out flag, matching the console
 * transport's own gate immediately below: no supported way to switch the
 * production log OFF, only a mode in which it was never on. Tests keep the
 * console transport (LOG_LEVEL=error under vitest, so it stays near-silent)
 * and every logger method stays live, because suites spy on `logger.warn` /
 * `logger.error` to assert what was reported — suppressing the transport must
 * not become suppressing the logger. All three properties are pinned by
 * test/logging-test-isolation.test.ts, which is also the only place in the
 * suite that reads a log file or inspects `logger.transports`.
 */
const isTestEnv = process.env.NODE_ENV === 'test';

// Constructed conditionally, not constructed-then-excluded: DailyRotateFile
// opens its stream and creates `logs/` on instantiation, so building one and
// leaving it out of `transports` would still touch the directory it is
// supposed to leave alone.
const fileTransport = isTestEnv
  ? null
  : new DailyRotateFile({
      filename: 'logs/extension-service-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d',
      format: formatFile,
    });

const formatConsole = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ level, message, label, stack }) => {
    const masked = typeof message === 'string' ? mask(message) : message;
    const prefix = label ? `[${label}]` : '';
    const s = stack ? `\n${stack}` : '';
    return `${level} ${prefix}${masked}${s}`;
  })
);

export const logger = winston.createLogger({
  level: config.LOG_LEVEL,
  format: winston.format.combine(
    winston.format.errors({ stack: true }),
    winston.format.splat(),
  ),
  transports: fileTransport ? [fileTransport] : [],
  exitOnError: false,
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({ format: formatConsole }));
}

export function labelLogger(name: string) {
  return logger.child({ label: name });
}

/**
 * Winston's npm levels, in severity order (least to most verbose). The
 * single source of truth for what `setLogLevel()` accepts — the derived
 * `LogLevel` type is built from this array rather than hand-written a
 * second time, the same array-derived-union idiom `guestStatus.ts` uses
 * for `GUEST_STATUSES`/`PHOTO_DELIVERY_STATES`.
 */
export const LOG_LEVELS = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'] as const;

export type LogLevel = typeof LOG_LEVELS[number];

/**
 * Changes the running process's log level in place. Reused by both the
 * SIGHUP reload path (src/ops/logLevelControl.ts) and any future caller —
 * this function owns validation, `reloadLogLevelFromEnvFile` owns where the
 * value comes from.
 *
 * Never throws: a signal handler is a trust boundary (Phase 1 D-05's "never
 * crash on a boundary, log and continue"), and this is the function that
 * boundary ultimately calls into.
 *
 * MEASURED (not merely assumed): winston's `logger.child()` returns an
 * object whose prototype chain reaches the parent `Logger`, so a level
 * assigned on `logger.level` here is visible to every `labelLogger()` child
 * via `isLevelEnabled()` without any extra propagation step — proven by
 * `test/log-level-runtime.test.ts`'s `labelLogger('queue').isLevelEnabled(...)`
 * assertion. Winston also applies `logger.level` as the default level for
 * every transport that does not set its own `level` option, which is the
 * case for both transports in this file — so no `transport.level` fan-out
 * was needed to make the reload observable end-to-end.
 */
export function setLogLevel(next: string): { previous: string; current: string; changed: boolean } {
  const previous = logger.level;

  if (!(LOG_LEVELS as readonly string[]).includes(next)) {
    logger.warn(`Rejected log level "${next}" — accepted values are: ${LOG_LEVELS.join(', ')}`);
    return { previous, current: previous, changed: false };
  }

  if (next === previous) {
    return { previous, current: previous, changed: false };
  }

  logger.level = next;
  return { previous, current: next, changed: true };
}

/**
 * The single sanctioned route from a raw Mirror Request payload to any log
 * sink (D-16). Returns immediately unless `NODE_ENV` is not `'production'`
 * AND `DEBUG` is set, so it can never fire in production and is silent by
 * default everywhere else. D-13's retention of the raw payload happens in
 * SQLite (`registration.raw_payload`), never in logs — this function is for
 * local development visibility only, not storage.
 *
 * Always pass a plain template string, never the payload object: the printf
 * formatters above only run `mask()` when `typeof message === 'string'`, so
 * an object argument would bypass masking entirely.
 */
export function debugRawPayload(label: string, payload: string): void {
  if (!(process.env.NODE_ENV !== 'production' && Boolean(process.env.DEBUG))) {
    return;
  }
  logger.debug(`[raw:${label}] ${payload}`);
}

export default logger;
