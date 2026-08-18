import { describe, expect, it, vi } from 'vitest'
import type { Logger } from '../src/logging/logger'
import type { DslrBoothClient, ApiResult } from '../src/dslrbooth/client'
import { createCommandHandler, type CommandDeps } from '../src/commands'

/**
 * 11-06 (gap closure): the OTHER half of the live booth defect (2026-08-18
 * 11:22:53). mirror-request's own 11-06 fix makes the server tolerate a
 * session_start with no jobId by falling back to its own booth binding —
 * but the Agent's own bug is the thing that PRODUCED the race in the first
 * place, and the server-side fallback is documented as defense in depth,
 * not a substitute for fixing it here.
 *
 * Measured (Agent log, verbatim, quoted in mirror-request's own 11-06-PLAN.md):
 *
 *     11:22:53.887  Command received: start_session (mode=print, jobId=THQQSRCE)
 *     11:22:53.907  Trigger received: session_start {"param1":"PrintOnly"}
 *     11:22:53.935  dslrBooth API success
 *
 * `deps.setActiveJobId(jobId)` used to run only after `await
 * deps.dslrBooth.startSession(mode)` resolved — 28ms after dslrBooth had
 * already fired session_start, so every session_start forwarded during
 * that live window read `activeJobId === undefined`
 * (src/agent.ts:196, `onEvent`'s `jobId: activeJobId` line).
 */

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    level: 'info',
    transports: [],
  } as unknown as Logger
}

const JOB_ID = 'THQQSRCE'

describe('createCommandHandler — activeJobId is stamped BEFORE dslrBooth can fire session_start (11-06)', () => {
  it('setActiveJobId(jobId) has already run by the time dslrBooth.startSession() is called — proven by the API stub reading the live value back, not by call-order inference', () => {
    let activeJobId: string | undefined
    let jobIdSeenInsideStartSession: string | undefined | 'NOT_YET_CALLED' = 'NOT_YET_CALLED'

    const dslrBooth = {
      startSession: vi.fn(async (_mode: string): Promise<ApiResult> => {
        // The whole point of the test: read the SAME mutable slot
        // setActiveJobId writes into, at the exact moment startSession is
        // invoked — not after awaiting it. If the id were stamped after the
        // await (the old, buggy order), this read would still see
        // 'NOT_YET_CALLED' having been overwritten to undefined, never the
        // real jobId, because the stamp would not happen until this promise
        // already resolved.
        jobIdSeenInsideStartSession = activeJobId
        return { isSuccessful: true, errorMessage: '', rawResponse: '{"IsSuccessful":true}' }
      }),
    } as unknown as DslrBoothClient

    const deps: CommandDeps = {
      dslrBooth,
      logger: makeLogger(),
      send: vi.fn(),
      updateDisplay: vi.fn(),
      closeDisplay: vi.fn(async () => {}),
      setActiveJobId: (jobId) => { activeJobId = jobId },
    }

    const handle = createCommandHandler(deps)

    return handle({ type: 'command', action: 'start_session', mode: 'print', jobId: JOB_ID }).then(() => {
      expect(dslrBooth.startSession).toHaveBeenCalledTimes(1)
      // THE assertion: startSession's own stub saw the real jobId already
      // stamped, at the moment it was called — not 'NOT_YET_CALLED', and not
      // undefined.
      expect(jobIdSeenInsideStartSession).toBe(JOB_ID)
      expect(activeJobId).toBe(JOB_ID) // still stamped after success
      expect(deps.send).toHaveBeenCalledWith({ type: 'ack', jobId: JOB_ID, ok: true, errorMessage: '' })
    })
  })

  it('a failed dslrBooth API call clears activeJobId — a booth that never actually started a session must not leave a stale id for the next trigger to misattribute', async () => {
    const setActiveJobId = vi.fn<(jobId: string | undefined) => void>()
    const dslrBooth = {
      startSession: vi.fn(async (_mode: string): Promise<ApiResult> => ({
        isSuccessful: false,
        errorMessage: 'Connection failed: ECONNREFUSED',
        rawResponse: '',
      })),
    } as unknown as DslrBoothClient

    const deps: CommandDeps = {
      dslrBooth,
      logger: makeLogger(),
      send: vi.fn(),
      updateDisplay: vi.fn(),
      closeDisplay: vi.fn(async () => {}),
      setActiveJobId,
    }

    const handle = createCommandHandler(deps)
    await handle({ type: 'command', action: 'start_session', mode: 'print', jobId: JOB_ID })

    // Called exactly twice: the pre-call stamp, then the failure-branch
    // clear — in that order, and the clear is the LAST word.
    expect(setActiveJobId.mock.calls.map((c) => c[0])).toEqual([JOB_ID, undefined])
    expect(deps.updateDisplay).not.toHaveBeenCalled()
    expect(deps.send).toHaveBeenCalledWith({
      type: 'ack', jobId: JOB_ID, ok: false, errorMessage: 'Connection failed: ECONNREFUSED',
    })
  })

  it('a successful call leaves activeJobId stamped (never cleared on the success path)', async () => {
    const setActiveJobId = vi.fn<(jobId: string | undefined) => void>()
    const dslrBooth = {
      startSession: vi.fn(async (_mode: string): Promise<ApiResult> => ({
        isSuccessful: true, errorMessage: '', rawResponse: '{"IsSuccessful":true}',
      })),
    } as unknown as DslrBoothClient

    const deps: CommandDeps = {
      dslrBooth,
      logger: makeLogger(),
      send: vi.fn(),
      updateDisplay: vi.fn(),
      closeDisplay: vi.fn(async () => {}),
      setActiveJobId,
    }

    const handle = createCommandHandler(deps)
    await handle({ type: 'command', action: 'start_session', mode: 'print', jobId: JOB_ID })

    // Called exactly once — the pre-call stamp — and never cleared.
    expect(setActiveJobId.mock.calls.map((c) => c[0])).toEqual([JOB_ID])
  })
})
