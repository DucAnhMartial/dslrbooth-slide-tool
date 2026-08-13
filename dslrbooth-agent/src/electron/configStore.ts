import fs from 'fs'
import path from 'path'
import { parseConfigValues, type ConfigValues, type ConfigFieldErrors, type ParseConfigResult } from '../config'
import { parseLegacyEnvFile } from './envImport'
import type { Logger } from '../logging/logger'

/**
 * The versioned user-data JSON configuration store (D10-02, plan 10-02 Task 1).
 *
 * Discretion recorded here rather than left to be discovered (10-CONTEXT.md
 * "Claude's discretion" / 10-RESEARCH Pitfall 5): configuration lives in the
 * Electron user-data directory for EVERY packaging format, including the
 * portable one, matching the installed build exactly. `app.getPath('userData')`
 * resolves the same way regardless of target; the one-line redirect that would
 * make a portable build carry its own settings via
 * `process.env.PORTABLE_EXECUTABLE_DIR` is a deliberate non-choice, not an
 * oversight — consistency between install paths was judged worth more than
 * USB-portability nobody asked for.
 *
 * This module has NO import of `electron` on purpose: vitest must be able to
 * load it directly, so every Electron-only capability (the platform key
 * store) arrives as an injected `SecretEncryptor`, not a direct dependency.
 */

/** The eight fields the local settings form may write — the whole of `Config`. */
export const CONFIG_FIELDS = [
  'extensionServiceWsUrl',
  'extensionServiceWsToken',
  'dslrBoothApiPort',
  'dslrBoothPassword',
  'triggerServerPort',
  'logLevel',
  'logDir',
  'autoOpenDisplay',
] as const

export type ConfigField = (typeof CONFIG_FIELDS)[number]

/** The two fields that carry a secret value, at rest and on the wire. */
const SECRET_FIELDS = ['extensionServiceWsToken', 'dslrBoothPassword'] as const
type SecretField = (typeof SECRET_FIELDS)[number]

function isSecretField(key: string): key is SecretField {
  return (SECRET_FIELDS as readonly string[]).includes(key)
}

/** The shipped defaults — the same ones `config.ts` applies for the `.env` path. */
const DEFAULTS = {
  dslrBoothApiPort: 1500,
  triggerServerPort: 3001,
  logLevel: 'info',
  logDir: 'logs',
  autoOpenDisplay: true,
} as const

/**
 * Platform capability, injected. `safeStorageEncryptor.ts` is the only
 * implementation that ships (it wraps Electron's own `safeStorage`); this
 * interface is what keeps this file importable outside Electron.
 */
export interface SecretEncryptor {
  isAvailable(): boolean
  /** Returns a string safe to embed in JSON (the implementation may base64-encode). */
  encrypt(plaintext: string): string
  /** Throws if the ciphertext cannot be decrypted (T-10-10: a restored profile, a different account). */
  decrypt(ciphertext: string): string
}

/**
 * The redacted snapshot the renderer receives — the heart of R4 / T-10-08.
 * The six non-secret values plus two presence booleans, and NOTHING else:
 * there is no field here a stored secret could ride along in.
 */
export interface ConfigSnapshot {
  extensionServiceWsUrl: string
  dslrBoothApiPort: number
  triggerServerPort: number
  logLevel: string
  logDir: string
  autoOpenDisplay: boolean
  hasExtensionServiceWsToken: boolean
  hasDslrBoothPassword: boolean
  /** Whether this is the very first run — no config file exists yet. */
  isFirstRun: boolean
  /** The discovered legacy `.env` path (D10-02 migration note), or null when none was found. */
  legacyEnvPath: string | null
}

export type PatchFieldErrors = Record<string, string>

export type ApplyPatchResult =
  | { ok: true }
  | { ok: false; errors: PatchFieldErrors }

export type ImportLegacyResult =
  | { ok: true; snapshot: ConfigSnapshot; importedFields: string[] }
  | { ok: false; errors: PatchFieldErrors }

interface StoredSecret {
  /** Ciphertext (base64) when `wrapped`, plaintext otherwise. */
  value: string
  wrapped: boolean
}

interface ConfigFileV1 {
  version: 1
  extensionServiceWsUrl: string
  dslrBoothApiPort: number
  triggerServerPort: number
  logLevel: string
  logDir: string
  autoOpenDisplay: boolean
  secrets: {
    extensionServiceWsToken: StoredSecret | null
    dslrBoothPassword: StoredSecret | null
  }
}

export interface ConfigStore {
  isFirstRun(): boolean
  getSnapshot(): ConfigSnapshot
  /** Builds a full `Config` through `parseConfigValues` — the shared validator, not a second copy. */
  buildConfig(): ParseConfigResult
  applyPatch(patch: Record<string, unknown>): ApplyPatchResult
  /**
   * Parses the discovered legacy `.env` file (if any), maps it, validates it
   * through the same `applyPatch` path a settings-form save uses, and
   * persists it on success. Runs entirely in the main process; the result
   * never carries a secret value under any key (T-10-16).
   */
  importLegacy(): ImportLegacyResult
}

export interface ConfigStoreOptions {
  filePath: string
  encryptor: SecretEncryptor
  logger: Logger
  /**
   * The discovered legacy `.env` path (D10-02 migration note), or null/absent
   * when none was found. Computed by the caller via
   * `envImport.findLegacyEnvFile` — this store does not search the
   * filesystem for it, it only carries the answer.
   */
  legacyEnvPath?: string | null
}

function isConfigField(key: string): key is ConfigField {
  return (CONFIG_FIELDS as readonly string[]).includes(key)
}

function emptyDoc(): ConfigFileV1 {
  return {
    version: 1,
    extensionServiceWsUrl: '',
    dslrBoothApiPort: DEFAULTS.dslrBoothApiPort,
    triggerServerPort: DEFAULTS.triggerServerPort,
    logLevel: DEFAULTS.logLevel,
    logDir: DEFAULTS.logDir,
    autoOpenDisplay: DEFAULTS.autoOpenDisplay,
    secrets: { extensionServiceWsToken: null, dslrBoothPassword: null },
  }
}

/**
 * Decrypts a stored secret, distinguishing "never set" from "set but
 * unreadable" from "set and readable" — `present` is false in the first two
 * cases, so a corrupted wrapped value degrades to "please retype this field"
 * rather than a crash (T-10-10).
 */
function loadSecret(
  stored: StoredSecret | null,
  encryptor: SecretEncryptor,
  fieldName: string,
  logger: Logger,
): { value: string | undefined; present: boolean } {
  if (!stored) return { value: undefined, present: false }
  if (!stored.wrapped) return { value: stored.value, present: true }
  try {
    return { value: encryptor.decrypt(stored.value), present: true }
  } catch {
    // Names the situation, never the value — the same rule LiveConfig already
    // follows for a live password (T-10-14).
    logger.warn(`Could not decrypt stored ${fieldName}; treating it as unset. Retype it in the settings form.`)
    return { value: undefined, present: false }
  }
}

export function createConfigStore(options: ConfigStoreOptions): ConfigStore {
  const { filePath, encryptor, logger, legacyEnvPath = null } = options

  function readFile(): { doc: ConfigFileV1; firstRun: boolean } {
    if (!fs.existsSync(filePath)) {
      return { doc: emptyDoc(), firstRun: true }
    }
    const raw = fs.readFileSync(filePath, 'utf8')
    return { doc: JSON.parse(raw) as ConfigFileV1, firstRun: false }
  }

  function writeFile(doc: ConfigFileV1): void {
    const dir = path.dirname(filePath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(doc, null, 2), { mode: 0o600 })
  }

  /**
   * Wraps a plaintext secret for storage. When the platform key store is
   * unavailable this writes the value in the clear rather than downgrading
   * silently (T-10-10): the file records `wrapped: false` and the log names
   * the situation, once per save. A file recorded unwrapped, saved again once
   * wrapping becomes available, is upgraded on that save — there is no
   * separate "upgrade" code path, because every save re-derives `wrapped`
   * from `encryptor.isAvailable()` at that moment.
   */
  function wrapSecret(plaintext: string, warnOnUnavailable: boolean): StoredSecret {
    if (encryptor.isAvailable()) {
      return { value: encryptor.encrypt(plaintext), wrapped: true }
    }
    // `warnOnUnavailable` lets the caller log this exactly once per save
    // even though a save wraps two secrets — availability cannot change
    // between the two calls that make up one save, so one warning is the
    // whole truth, not a second copy of it.
    if (warnOnUnavailable) {
      logger.warn('Platform key store unavailable; storing configuration secrets unencrypted on disk.')
    }
    return { value: plaintext, wrapped: false }
  }

  function currentValues(): { doc: ConfigFileV1; values: ConfigValues; presence: Record<SecretField, boolean> } {
    const { doc } = readFile()
    const token = loadSecret(doc.secrets.extensionServiceWsToken, encryptor, 'extensionServiceWsToken', logger)
    const password = loadSecret(doc.secrets.dslrBoothPassword, encryptor, 'dslrBoothPassword', logger)
    const values: ConfigValues = {
      extensionServiceWsUrl: doc.extensionServiceWsUrl || undefined,
      extensionServiceWsToken: token.value,
      dslrBoothApiPort: doc.dslrBoothApiPort,
      dslrBoothPassword: password.value,
      triggerServerPort: doc.triggerServerPort,
      logLevel: doc.logLevel,
      logDir: doc.logDir,
      autoOpenDisplay: doc.autoOpenDisplay,
    }
    return {
      doc,
      values,
      presence: { extensionServiceWsToken: token.present, dslrBoothPassword: password.present },
    }
  }

  function isFirstRun(): boolean {
    return readFile().firstRun
  }

  function getSnapshot(): ConfigSnapshot {
    const { doc, presence } = currentValues()
    return {
      extensionServiceWsUrl: doc.extensionServiceWsUrl,
      dslrBoothApiPort: doc.dslrBoothApiPort,
      triggerServerPort: doc.triggerServerPort,
      logLevel: doc.logLevel,
      logDir: doc.logDir,
      autoOpenDisplay: doc.autoOpenDisplay,
      hasExtensionServiceWsToken: presence.extensionServiceWsToken,
      hasDslrBoothPassword: presence.dslrBoothPassword,
      isFirstRun: isFirstRun(),
      legacyEnvPath,
    }
  }

  function buildConfig(): ParseConfigResult {
    const { values } = currentValues()
    return parseConfigValues(values)
  }

  function applyPatch(patch: Record<string, unknown>): ApplyPatchResult {
    // Refused by name, before anything else, so a mistyped or forbidden key
    // is reported as itself rather than silently dropped or coerced.
    const unknown: PatchFieldErrors = {}
    for (const key of Object.keys(patch)) {
      if (!isConfigField(key)) unknown[key] = `Unknown configuration field: ${key}`
    }
    if (Object.keys(unknown).length > 0) return { ok: false, errors: unknown }

    const { values } = currentValues()
    const merged: ConfigValues = { ...values }
    for (const [key, value] of Object.entries(patch)) {
      const field = key as ConfigField
      if (isSecretField(field)) {
        // Absent or empty leaves the stored secret in place — the same
        // refusal-of-emptiness rule LiveConfig.assign() already applies to
        // the password arriving over the wire.
        if (typeof value === 'string' && value.length > 0) {
          ;(merged as Record<string, unknown>)[field] = value
        }
        continue
      }
      ;(merged as Record<string, unknown>)[field] = value
    }

    const result = parseConfigValues(merged)
    if (!result.ok) return { ok: false, errors: result.errors as ConfigFieldErrors }

    const nextDoc: ConfigFileV1 = {
      version: 1,
      extensionServiceWsUrl: result.config.extensionServiceWsUrl,
      dslrBoothApiPort: result.config.dslrBoothApiPort,
      triggerServerPort: result.config.triggerServerPort,
      logLevel: result.config.logLevel,
      logDir: result.config.logDir,
      autoOpenDisplay: result.config.autoOpenDisplay,
      secrets: {
        // `warnOnUnavailable` fires on the first of the two calls only — one
        // save wraps two secrets, and availability cannot change between
        // them, so one warning is the whole truth (T-10-14).
        extensionServiceWsToken: wrapSecret(result.config.extensionServiceWsToken, true),
        dslrBoothPassword: wrapSecret(result.config.dslrBoothPassword, false),
      },
    }
    writeFile(nextDoc)
    return { ok: true }
  }

  /**
   * Parses the discovered legacy file, maps it onto a patch and runs it
   * through the exact same `applyPatch` a settings-form save uses — not a
   * second validation/persistence path. Returns the redacted snapshot plus
   * the list of imported field NAMES only; the parsed values themselves
   * (which may include a plaintext secret) never leave this function (T-10-16).
   */
  function importLegacy(): ImportLegacyResult {
    if (!legacyEnvPath) {
      return { ok: false, errors: { _: 'No legacy configuration file was found.' } }
    }
    const parsed = parseLegacyEnvFile(legacyEnvPath)
    const patch: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(parsed.values)) {
      if (value !== undefined) patch[key] = value
    }
    const result = applyPatch(patch)
    if (!result.ok) return result
    return { ok: true, snapshot: getSnapshot(), importedFields: parsed.fieldsPresent }
  }

  return {
    isFirstRun,
    getSnapshot,
    buildConfig,
    applyPatch,
    importLegacy,
  }
}
