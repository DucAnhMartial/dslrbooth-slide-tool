import { LOG_LEVELS } from './liveConfig'

export interface Config {
  extensionServiceWsUrl: string
  extensionServiceWsToken: string
  dslrBoothApiPort: number
  dslrBoothPassword: string
  triggerServerPort: number
  logLevel: string
  logDir: string
  autoOpenDisplay: boolean
}

/** The shipped defaults for every optional field — unchanged since before this plan. */
const DEFAULTS = {
  dslrBoothApiPort: 1500,
  triggerServerPort: 3001,
  logLevel: 'info',
  logDir: 'logs',
  autoOpenDisplay: true,
} as const

export type ConfigFieldErrors = Partial<Record<keyof Config, string>>

export type ParseConfigResult =
  | { ok: true; config: Config }
  | { ok: false; errors: ConfigFieldErrors }

/**
 * A plain record of already-typed values — the shape both `loadConfig()` (the
 * `.env` reader) and the settings form in plan 10-02 can produce, string
 * coercion already done by the caller.
 */
export interface ConfigValues {
  extensionServiceWsUrl?: string
  extensionServiceWsToken?: string
  dslrBoothApiPort?: number
  dslrBoothPassword?: string
  triggerServerPort?: number
  logLevel?: string
  logDir?: string
  autoOpenDisplay?: boolean
}

function isValidPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
}

/**
 * The single place that decides whether a set of configuration values is
 * usable (SC-4, ASVS V5). Takes a partial record of already-typed values and
 * returns either the complete `Config` or a map of every failing field —
 * never a partially-built config, and never throws.
 *
 * The rules agree, field for field, with `LiveConfig.assign()`: the same port
 * bound (1-65535), the same empty-password refusal, and the same log-level
 * set — read from `LOG_LEVELS`, the exported constant, rather than retyped
 * here.
 */
export function parseConfigValues(values: ConfigValues): ParseConfigResult {
  const errors: ConfigFieldErrors = {}

  if (!values.extensionServiceWsUrl) {
    errors.extensionServiceWsUrl = 'Missing required value: extensionServiceWsUrl'
  } else if (!/^wss?:\/\//.test(values.extensionServiceWsUrl)) {
    errors.extensionServiceWsUrl = 'extensionServiceWsUrl must start with ws:// or wss://'
  }

  if (!values.extensionServiceWsToken) {
    errors.extensionServiceWsToken = 'Missing required value: extensionServiceWsToken'
  }

  if (!values.dslrBoothPassword) {
    errors.dslrBoothPassword = 'Missing required value: dslrBoothPassword'
  }

  const dslrBoothApiPort = values.dslrBoothApiPort ?? DEFAULTS.dslrBoothApiPort
  if (!isValidPort(dslrBoothApiPort)) {
    errors.dslrBoothApiPort = 'dslrBoothApiPort must be an integer between 1 and 65535'
  }

  const triggerServerPort = values.triggerServerPort ?? DEFAULTS.triggerServerPort
  if (!isValidPort(triggerServerPort)) {
    errors.triggerServerPort = 'triggerServerPort must be an integer between 1 and 65535'
  }

  const logLevel = values.logLevel ?? DEFAULTS.logLevel
  if (!(LOG_LEVELS as readonly string[]).includes(logLevel)) {
    errors.logLevel = `logLevel must be one of ${LOG_LEVELS.join(', ')}`
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    config: {
      extensionServiceWsUrl: values.extensionServiceWsUrl as string,
      extensionServiceWsToken: values.extensionServiceWsToken as string,
      dslrBoothApiPort,
      dslrBoothPassword: values.dslrBoothPassword as string,
      triggerServerPort,
      logLevel,
      logDir: values.logDir || DEFAULTS.logDir,
      autoOpenDisplay: values.autoOpenDisplay ?? DEFAULTS.autoOpenDisplay,
    },
  }
}

/**
 * The environment reader on top of `parseConfigValues`. Reads the variables,
 * applies the same defaults it applied before this plan, coerces the two
 * ports from strings once, and delegates every rule to the validator. Keeps
 * its throwing contract — `index.ts` catches, prints and exits — but the
 * message now names every failing field instead of only the first missing
 * one.
 *
 * Takes an optional environment object, defaulting to the process
 * environment, so it is testable without mutating global state. Reads only —
 * never writes a file and never touches `process.env`.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const values: ConfigValues = {
    extensionServiceWsUrl: env.EXTENSION_SERVICE_WS_URL || undefined,
    extensionServiceWsToken: env.EXTENSION_SERVICE_WS_TOKEN || undefined,
    dslrBoothApiPort: env.DSLRBOOTH_API_PORT ? parseInt(env.DSLRBOOTH_API_PORT, 10) : undefined,
    dslrBoothPassword: env.DSLRBOOTH_PASSWORD || undefined,
    triggerServerPort: env.TRIGGER_SERVER_PORT ? parseInt(env.TRIGGER_SERVER_PORT, 10) : undefined,
    logLevel: env.LOG_LEVEL || undefined,
    logDir: env.LOG_DIR || undefined,
    autoOpenDisplay: env.AUTO_OPEN_DISPLAY === undefined
      ? undefined
      : !['false', '0', 'no'].includes(env.AUTO_OPEN_DISPLAY.toLowerCase()),
  }

  const result = parseConfigValues(values)
  if (!result.ok) {
    const fields = Object.keys(result.errors).join(', ')
    throw new Error(`Invalid configuration: ${fields}`)
  }
  return result.config
}
