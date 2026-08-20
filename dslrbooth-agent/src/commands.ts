import type { Logger } from './logging/logger'
import type { DslrBoothClient } from './dslrbooth/client'
import type { AgentDisplayState } from './triggers/server'

/**
 * The `command` branch: the ONLY place the Agent calls the dslrBooth Local
 * API, moved here verbatim from `index.ts` (plan 10-01) so it can be driven
 * by a test. `index.ts` used to build its whole world inside `main()` and
 * bind servers on import, which made this branch unreachable from vitest —
 * exactly the reason `src/agentMessages.ts` split its own branches out first
 * (plan 08-04). This module is that same move applied to the one branch that
 * module's header explicitly left behind.
 *
 * AGT-02 and AGT-03 pin this branch's behaviour (the ack shapes, the log
 * lines, the close-display-then-call-API order). Nothing about the body
 * changed in this move — only where it lives and how the active jobId is
 * threaded through.
 */

export interface CommandMessage {
  type: string
  [key: string]: unknown
}

export interface CommandDeps {
  dslrBooth: DslrBoothClient
  logger: Logger
  send(msg: unknown): void
  updateDisplay(patch: Partial<AgentDisplayState>): void
  closeDisplay(): Promise<void>
  /**
   * The active jobId lives in the factory (`src/agent.ts`), not here — this
   * handler is a pure message-to-API translator, and the factory is what the
   * trigger-forwarding path also needs to read the same jobId from.
   */
  setActiveJobId(jobId: string | undefined): void
}

/**
 * Consumes `command` messages and returns `false` for everything else — the
 * same shape `createServiceMessageHandler` in `agentMessages.ts` already
 * uses, so the two handlers compose the same way in the factory's message
 * dispatch.
 */
export function createCommandHandler(deps: CommandDeps): (msg: CommandMessage) => Promise<boolean> {
  return async function handle(msg: CommandMessage): Promise<boolean> {
    if (msg.type !== 'command') return false

    const jobId = msg.jobId as string | undefined
    const action = msg.action as string | undefined
    const mode = (msg.mode as string | undefined) || 'print'

    if (action !== 'start_session') {
      deps.logger.warn(`Unknown command action: ${action}`)
      deps.send({ type: 'ack', jobId, ok: false, errorMessage: `Unknown action: ${action}` })
      return true
    }

    deps.logger.info(`Command received: start_session (mode=${mode}, jobId=${jobId || 'unknown'})`)

    await deps.closeDisplay()

    // 11-06: stamp the id BEFORE calling the API that can make dslrBooth
    // fire session_start, not after awaiting it. Measured live, 2026-08-18
    // 11:22:53: dslrBooth's own trigger reached the Agent's trigger
    // listener 20ms after this command was received -- 28ms BEFORE
    // startSession()'s promise resolved. Every session_start forwarded in
    // that window used to carry activeJobId === undefined, and the
    // Extension Service (mirror-request 11-06) had no way to know whose
    // session_start it was. Stamping here closes the window at its source;
    // the server-side fallback is defense in depth, not a substitute.
    deps.setActiveJobId(jobId)
    const result = await deps.dslrBooth.startSession(mode)

    if (result.isSuccessful) {
      deps.updateDisplay({ phase: 'busy', endsAt: null })
      deps.logger.info(`dslrBooth API success: ${result.rawResponse}`)
      deps.send({ type: 'ack', jobId, ok: true, errorMessage: '' })
    } else {
      // A failed start never actually opened a dslrBooth session for this
      // jobId -- leaving activeJobId stamped would misattribute whatever
      // trigger fires next (a stray local session_start, or the operator's
      // own retry) to a job the booth never started.
      deps.setActiveJobId(undefined)
      deps.logger.error(`dslrBooth API failed: ${result.errorMessage}`)
      deps.send({ type: 'ack', jobId, ok: false, errorMessage: result.errorMessage })
    }
    return true
  }
}
