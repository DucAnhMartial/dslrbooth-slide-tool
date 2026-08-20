import type { Config } from './config'
import type { Logger } from './logging/logger'

/**
 * The Agent's half of D-16's safe-field boundary.
 *
 * This module has NO runtime imports on purpose — only `import type`, which is
 * erased at build time. That keeps it importable from the service repository's
 * test suite (`mirror-request/test/agent-config-message.test.ts` asserts the
 * two allow-lists are equal), so the two lists cannot silently drift apart
 * without a red test on one side or the other (T-08-24).
 */
export const SAFE_AGENT_CONFIG_FIELDS = [
  'logLevel',
  'autoOpenDisplay',
  'dslrBoothApiPort',
  'dslrBoothPassword',
] as const

export type SafeAgentConfigField = (typeof SAFE_AGENT_CONFIG_FIELDS)[number]

/**
 * The four the Agent will never accept from the wire.
 *
 * `extensionServiceWsUrl` and `extensionServiceWsToken` create the very socket
 * a configuration change arrives on, and `triggerServerPort` is the local port
 * dslrBooth posts its own events to — a wrong value for any of the three costs
 * a physical visit to the booth, mid-event. `logDir` joins them by decision
 * (08-RESEARCH Assumption A1, adopted by plan 08-04): an unwritable log path
 * silently blackholes the evidence of every later fault.
 *
 * They are listed here rather than merely absent from the allow-list so the
 * warning below can say WHICH kind of key it dropped, and so a test can assert
 * the two sets do not overlap.
 */
export const READ_ONLY_AGENT_CONFIG_FIELDS = [
  'extensionServiceWsUrl',
  'extensionServiceWsToken',
  'triggerServerPort',
  'logDir',
] as const

export type ReadOnlyAgentConfigField = (typeof READ_ONLY_AGENT_CONFIG_FIELDS)[number]

/** Winston's npm levels — the only values `logLevel` may take. */
export const LOG_LEVELS = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'] as const

export interface SafeAgentConfig {
  logLevel: string
  autoOpenDisplay: boolean
  dslrBoothApiPort: number
  dslrBoothPassword: string
}

export interface LiveConfigHooks {
  /**
   * Called only when the port or the password actually changed. The Agent
   * decides nothing here — it hands the new pair to whoever holds the
   * credentials (`DslrBoothClient`) and that is the end of its involvement.
   */
  onCredentialsChange?(port: number, password: string): void
}

export function isSafeAgentConfigField(key: string): key is SafeAgentConfigField {
  return (SAFE_AGENT_CONFIG_FIELDS as readonly string[]).includes(key)
}

function isReadOnlyAgentConfigField(key: string): boolean {
  return (READ_ONLY_AGENT_CONFIG_FIELDS as readonly string[]).includes(key)
}

/**
 * The four remotely-tunable values, held in memory, read by their consumers at
 * call time rather than captured at construction.
 *
 * "At call time" is the whole design. The failure this class exists to prevent
 * (08-RESEARCH Pitfall 4) is a consumer that copied a value once at startup and
 * therefore ignores every later update — silently, with no error anywhere,
 * leaving UI-02 looking implemented and doing nothing.
 *
 * Nothing here writes `process.env` and nothing here writes a file: D-17 makes
 * the service the single source of truth, and an Agent that rewrote its own
 * `.env` would be a second one.
 */
export class LiveConfig {
  private values: SafeAgentConfig

  constructor(
    boot: Config,
    private readonly logger: Logger,
    private readonly hooks: LiveConfigHooks = {},
  ) {
    this.values = {
      logLevel: boot.logLevel,
      autoOpenDisplay: boot.autoOpenDisplay,
      dslrBoothApiPort: boot.dslrBoothApiPort,
      dslrBoothPassword: boot.dslrBoothPassword,
    }
  }

  get logLevel(): string { return this.values.logLevel }
  get autoOpenDisplay(): boolean { return this.values.autoOpenDisplay }
  get dslrBoothApiPort(): number { return this.values.dslrBoothApiPort }
  get dslrBoothPassword(): string { return this.values.dslrBoothPassword }

  snapshot(): SafeAgentConfig {
    return { ...this.values }
  }

  /**
   * Applies an inbound configuration payload, key by key, and returns the keys
   * that were actually applied.
   *
   * An unrecognised key is warned about and DROPPED, never merged in "just in
   * case": an unknown key is a protocol-drift signal, and swallowing it
   * silently is how a forbidden field eventually lands (T-08-24). The warning
   * names the key and never the value — `dslrBoothPassword` takes the same
   * never-echoed path the WS bearer token takes.
   *
   * Values whose type does not match are dropped the same way. This is protocol
   * hygiene at a network boundary, not the Agent deciding something: it refuses
   * to apply nonsense, it does not choose a better value.
   */
  apply(partial: Record<string, unknown> | undefined): SafeAgentConfigField[] {
    const applied: SafeAgentConfigField[] = []
    if (!partial) return applied

    const before = { ...this.values }

    for (const [key, value] of Object.entries(partial)) {
      if (!isSafeAgentConfigField(key)) {
        const why = isReadOnlyAgentConfigField(key)
          ? 'it is read-only and must be edited on the booth machine'
          : 'it is not a known configuration field'
        this.logger.warn(`Ignored config field "${key}" from Extension Service: ${why}`)
        continue
      }
      if (this.assign(key, value)) applied.push(key)
    }

    if (before.logLevel !== this.values.logLevel) {
      this.applyLogLevel(this.values.logLevel)
    }
    if (
      before.dslrBoothApiPort !== this.values.dslrBoothApiPort ||
      before.dslrBoothPassword !== this.values.dslrBoothPassword
    ) {
      this.hooks.onCredentialsChange?.(this.values.dslrBoothApiPort, this.values.dslrBoothPassword)
    }

    if (applied.length > 0) {
      this.logger.info(`Applied Agent configuration from Extension Service: ${applied.join(', ')}`)
    }
    return applied
  }

  private assign(key: SafeAgentConfigField, value: unknown): boolean {
    switch (key) {
      case 'logLevel': {
        if (typeof value !== 'string' || !(LOG_LEVELS as readonly string[]).includes(value)) {
          this.logger.warn(`Ignored config field "logLevel": not one of ${LOG_LEVELS.join(', ')}`)
          return false
        }
        this.values.logLevel = value
        return true
      }
      case 'autoOpenDisplay': {
        if (typeof value !== 'boolean') {
          this.logger.warn('Ignored config field "autoOpenDisplay": expected a boolean')
          return false
        }
        this.values.autoOpenDisplay = value
        return true
      }
      case 'dslrBoothApiPort': {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
          this.logger.warn('Ignored config field "dslrBoothApiPort": expected a port between 1 and 65535')
          return false
        }
        this.values.dslrBoothApiPort = value
        return true
      }
      case 'dslrBoothPassword': {
        // An empty password is refused rather than applied: it is a value, and
        // applying it would take dslrBooth offline until somebody walked to the
        // booth. The value itself is never logged.
        if (typeof value !== 'string' || value.length === 0) {
          this.logger.warn('Ignored config field "dslrBoothPassword": expected a non-empty string')
          return false
        }
        this.values.dslrBoothPassword = value
        return true
      }
    }
  }

  /**
   * `createLogger()` sets an explicit `level` on BOTH the console transport and
   * the daily-rotate file transport, and winston only falls back to the
   * logger's own level for transports that set none. Assigning `logger.level`
   * alone would therefore change nothing observable — the transports would keep
   * filtering at their boot level and the operator would see a saved setting
   * with no effect.
   */
  private applyLogLevel(level: string): void {
    this.logger.level = level
    for (const transport of this.logger.transports ?? []) {
      transport.level = level
    }
    this.logger.info(`Log level set to "${level}" by Extension Service`)
  }
}
