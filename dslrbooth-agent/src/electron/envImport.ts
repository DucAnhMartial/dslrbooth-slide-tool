import fs from 'fs'
import path from 'path'
import { parse as parseDotenv } from 'dotenv'
import type { ConfigValues } from '../config'

/**
 * The `.env` importer for the first-run migration (D10-02's migration note,
 * plan 10-03 Task 1).
 *
 * No import of Electron on purpose: vitest must load this directly. Uses
 * `dotenv`'s PURE parser (`dotenv.parse`) only — never `dotenv.config()` or
 * `dotenv.configDotenv()`, which write into `process.env`. A settings-form
 * import that mutated the environment of the process it runs in would be a
 * second source of truth for values the store already owns (10-RESEARCH's
 * Don't Hand-Roll rule applies to text parsing as much as to ciphers, and
 * this is the one place it would be easy to reach for the wrong half of the
 * same package).
 */

export interface FsLike {
  existsSync(candidatePath: string): boolean
  readFileSync(candidatePath: string, encoding: 'utf8'): string
}

/**
 * The first existing `.env` file among the given candidate directories, in
 * order, or null when none exists. Which directories to search (beside the
 * executable, the working directory, the user-data directory — 10-CONTEXT's
 * migration note) is the caller's business; this function only decides "the
 * first one that exists wins".
 */
export function findLegacyEnvFile(candidateDirs: string[], fsLike: FsLike = fs): string | null {
  for (const dir of candidateDirs) {
    const candidate = path.join(dir, '.env')
    if (fsLike.existsSync(candidate)) return candidate
  }
  return null
}

const AUTO_OPEN_FALSE_VALUES = ['false', '0', 'no']

/**
 * The exact variable-to-field mapping `config.ts`'s `loadConfig()` already
 * uses, restated here rather than imported: `loadConfig()`'s contract is to
 * throw a single generic message naming every failing field jointly, which
 * is the wrong shape for a settings form that must mark each field
 * separately. `parseConfigValues()` — the shared validator both callers
 * actually agree on — is what `parseLegacyEnvFile` below calls instead.
 */
export function mapEnvVarsToConfigValues(vars: Record<string, string>): ConfigValues {
  return {
    extensionServiceWsUrl: vars.EXTENSION_SERVICE_WS_URL || undefined,
    extensionServiceWsToken: vars.EXTENSION_SERVICE_WS_TOKEN || undefined,
    dslrBoothApiPort: vars.DSLRBOOTH_API_PORT ? parseInt(vars.DSLRBOOTH_API_PORT, 10) : undefined,
    dslrBoothPassword: vars.DSLRBOOTH_PASSWORD || undefined,
    triggerServerPort: vars.TRIGGER_SERVER_PORT ? parseInt(vars.TRIGGER_SERVER_PORT, 10) : undefined,
    logLevel: vars.LOG_LEVEL || undefined,
    logDir: vars.LOG_DIR || undefined,
    autoOpenDisplay:
      vars.AUTO_OPEN_DISPLAY === undefined
        ? undefined
        : !AUTO_OPEN_FALSE_VALUES.includes(vars.AUTO_OPEN_DISPLAY.toLowerCase()),
  }
}

export interface ParsedLegacyEnv {
  values: ConfigValues
  /** The config field names actually present in the file — not every field `Config` has. */
  fieldsPresent: string[]
}

/**
 * Reads and parses a legacy `.env` file. `dotenv.parse` itself is what skips
 * a line it cannot make sense of rather than aborting — nothing here
 * re-validates line syntax; this function only maps the parser's own output
 * onto `ConfigValues` and records which fields the file actually set.
 */
export function parseLegacyEnvFile(filePath: string, fsLike: FsLike = fs): ParsedLegacyEnv {
  const raw = fsLike.readFileSync(filePath, 'utf8')
  const vars = parseDotenv(raw)
  const values = mapEnvVarsToConfigValues(vars)
  const fieldsPresent = Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key)
  return { values, fieldsPresent }
}
