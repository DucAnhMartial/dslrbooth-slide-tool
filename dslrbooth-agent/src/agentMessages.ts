import type { Logger } from './logging/logger'
import type { AgentDisplayState } from './triggers/server'
import type { LiveConfig } from './liveConfig'

/**
 * The service → Agent messages that do not touch the dslrBooth Local API:
 * `config`, `reload_config`, and the existing `announcement`.
 *
 * This module exists so those branches can be driven by a test. `index.ts`
 * builds its whole world inside `main()` and starts servers on import, so the
 * chain that used to live inline there was unreachable from vitest — and the
 * two properties plan 08-04 has to prove (a `reload_config` produces exactly
 * one `config_request`, and the auto-open flag is read through the LIVE holder
 * rather than the boot config) are behavioural, not structural. They cannot be
 * asserted by inspecting a constant.
 *
 * The `command` branch deliberately stays in `index.ts`: it is the dslrBooth
 * Local API call site, AGT-02/AGT-03 pin its behaviour, and moving working
 * code across a file boundary is risk with no test to pay for it. This handler
 * returns `false` for anything it does not consume, and `index.ts` continues
 * exactly as before from there.
 */

export interface ServiceMessage {
  type: string
  [key: string]: unknown
}

export interface ServiceMessageDeps {
  live: LiveConfig
  logger: Logger
  send(msg: unknown): void
  updateDisplay(patch: Partial<AgentDisplayState>): void
  openDisplay(): void
}

/**
 * The one message the Agent ever sends about configuration, in one place.
 *
 * It carries nothing but its type — no snapshot of the current values, no
 * credentials. The service ignores inbound fields on this message by
 * construction, so anything added here would be data travelling off the booth
 * for no reader; the dslrBooth password in particular has no business on the
 * wire in that direction.
 */
export function requestConfig(send: (msg: unknown) => void): void {
  send({ type: 'config_request' })
}

export function createServiceMessageHandler(deps: ServiceMessageDeps): (msg: ServiceMessage) => boolean {
  return function handle(msg: ServiceMessage): boolean {
    if (msg.type === 'config') {
      deps.live.apply(msg.data as Record<string, unknown> | undefined)
      return true
    }

    if (msg.type === 'reload_config') {
      // D-17's literal round trip. The service tells the Agent that something
      // changed; the Agent asks. A direct push would have to arrive on a socket
      // that may be mid-reconnect and would have nowhere reliable to land,
      // whereas a pull the Agent initiates always has a live socket to answer
      // on.
      requestConfig(deps.send)
      return true
    }

    if (msg.type === 'announcement') {
      const data = (msg.data ?? {}) as Record<string, unknown>
      deps.updateDisplay({
        phase: 'announcing',
        guestName: typeof data.guestName === 'string' ? data.guestName : 'Khách tiếp theo',
        endsAt: typeof data.endsAt === 'number' ? data.endsAt : null,
        queueLength: typeof data.queueLength === 'number' ? data.queueLength : 0,
        upNext: Array.isArray(data.upNext) ? (data.upNext as Array<{ jobId: string; name: string; position: number }>) : [],
      })
      deps.logger.info(`Next guest announcement received: ${typeof data.guestName === 'string' ? data.guestName : 'unknown'}`)
      // Read through the LIVE holder, not the boot config: this is the flag
      // UI-02 lets an operator flip from the CMS, and reading it from the
      // captured startup value is how that flip would silently do nothing.
      if (deps.live.autoOpenDisplay) deps.openDisplay()
      return true
    }

    return false
  }
}
