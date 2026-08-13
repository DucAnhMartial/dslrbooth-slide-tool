import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Logger } from '../src/logging/logger'
import { createConfigStore, type SecretEncryptor } from '../src/electron/configStore'
import { createIpcHandlers } from '../src/electron/ipcHandlers'

// ---------------------------------------------------------------------------
// UAT-01 and UAT-03 regression — a refused start must leave a trace.
//
// On the first booth-PC install, pressing Start with no usable configuration
// produced NOTHING an operator could act on: the renderer wrote the reason into
// #status-last-error and then erased it in the same tick with refreshStatus(),
// and `agent:start`'s refusal branch logged nothing at all. No config file, no
// bound port, no dialled socket, an empty app log and a blank window.
//
// Two independent channels are pinned here, because relying on either alone is
// what produced the blackout:
//   1. the handler LOGS the refusal (this file, driving it for real)
//   2. the renderer KEEPS the message on screen after a status refresh
//      (asserted against index.js's source, which cannot be executed here —
//      there is no DOM and no window.agentDesktop on this machine)
// ---------------------------------------------------------------------------

function makeSpyLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return {
    info: () => {},
    warn: vi.fn(),
    error: () => {},
    debug: () => {},
    level: 'info',
    transports: [],
  } as unknown as Logger & { warn: ReturnType<typeof vi.fn> }
}

function makeFakeEncryptor(): SecretEncryptor {
  return {
    isAvailable: () => true,
    encrypt: (plaintext: string) => `wrapped:${Buffer.from(plaintext, 'utf8').toString('base64')}`,
    decrypt: (ciphertext: string) =>
      Buffer.from(ciphertext.replace(/^wrapped:/, ''), 'base64').toString('utf8'),
  }
}

function makeHandlers(logger: Logger) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uat-01-'))
  const store = createConfigStore({
    filePath: path.join(dir, 'config.json'),
    encryptor: makeFakeEncryptor(),
    logger,
  })
  return createIpcHandlers({
    store,
    logger,
    getAgent: () => null,
    setAgent: () => {},
    createAgent: (() => {
      throw new Error('must not be reached: the configuration was refused')
    }) as never,
    pushStatus: () => {},
  })
}

describe('a refused start is logged, not swallowed (UAT-03)', () => {
  it('logs a warning naming the offending fields when the configuration is unusable', async () => {
    const logger = makeSpyLogger()
    const handlers = makeHandlers(logger)

    const result = await handlers['agent:start']()

    expect(result.ok).toBe(false)
    expect(logger.warn).toHaveBeenCalledTimes(1)

    const logged = String(logger.warn.mock.calls[0][0])
    // An empty store is missing exactly the three fields with no default.
    expect(logged).toMatch(/extensionServiceWsUrl/)
    expect(logged).toMatch(/extensionServiceWsToken/)
    expect(logged).toMatch(/dslrBoothPassword/)
  })

  it('never constructs an Agent when the configuration is refused', async () => {
    // createAgent throws if called — the refusal must come first.
    const handlers = makeHandlers(makeSpyLogger())
    await expect(handlers['agent:start']()).resolves.toMatchObject({ ok: false })
  })

  it('returns the same field names it logged, so window and log agree', async () => {
    const logger = makeSpyLogger()
    const handlers = makeHandlers(logger)

    const result = await handlers['agent:start']()
    const logged = String(logger.warn.mock.calls[0][0])

    expect(result.ok).toBe(false)
    if (result.ok === false && 'errors' in result) {
      for (const field of Object.keys(result.errors)) {
        expect(logged).toContain(field)
      }
    }
  })
})

describe('the renderer keeps a start failure on screen (UAT-01)', () => {
  const rendererJs = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'index.js'),
    'utf8',
  )

  it('renderStatus falls back to the held start error instead of blanking it', () => {
    // The exact line that erased the message: it read `status.lastError || '-'`,
    // and a refused start leaves lastError empty because no Agent was built.
    expect(rendererJs).toMatch(
      /status-last-error'\)\.textContent\s*=\s*status\.lastError\s*\|\|\s*pendingStartError\s*\|\|\s*'-'/,
    )
  })

  it('the start handler stores the failure rather than writing it straight to the DOM', () => {
    expect(rendererJs).toMatch(/pendingStartError\s*=\s*formatStartError\(result\)/)
  })

  it('a successful start clears the held error', () => {
    expect(rendererJs).toMatch(/pendingStartError\s*=\s*''/)
  })

  it('saving the configuration clears a stale start error', () => {
    // A start failure caused by the previous configuration must not outlive it.
    const submitHandler = rendererJs.slice(rendererJs.indexOf("byId('settings-form')"))
    expect(submitHandler.slice(0, 900)).toMatch(/pendingStartError\s*=\s*''/)
  })

  it('the failure message is formatted for a human, not JSON.stringify', () => {
    expect(rendererJs).toMatch(/function formatStartError/)
    expect(rendererJs).not.toMatch(/JSON\.stringify\(result\.errors\)/)
  })
})
