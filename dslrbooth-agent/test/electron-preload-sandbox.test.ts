import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { STATUS_PUSH_CHANNEL, LOG_LINE_PUSH_CHANNEL, IPC_CHANNELS } from '../src/electron/ipcHandlers'

// ---------------------------------------------------------------------------
// UAT-04 regression — the preload must survive `sandbox: true`.
//
// What shipped and broke on the first real booth-PC install: `preload.ts`
// imported its two push-channel constants from `./ipcHandlers`, which the
// compiler emits as `require("./ipcHandlers")`. A SANDBOXED preload's
// `require` is a polyfill limited to `electron` and a couple of core modules,
// so that call threw, the preload died before
// `contextBridge.exposeInMainWorld('agentDesktop', api)`, and every button in
// the renderer became inert with no error surfaced anywhere — Save wrote no
// config, Start bound no port and dialled nothing, and both logs were empty.
//
// The two properties that were individually right and jointly fatal:
//   - `sandbox: true` (electron-main-security.test.ts asserts it)
//   - preload sharing ipcHandlers' constants so the channel lists cannot drift
//     (the same file asserts the function names line up)
// Neither test loaded the COMPILED preload, so nothing noticed.
//
// This file keeps both properties and removes the conflict: the constants are
// literals in preload.ts, asserted equal to ipcHandlers' exports here, and the
// compiled artifact is asserted to require nothing but `electron`.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.join(__dirname, '..')
const PRELOAD_SRC = path.join(REPO_ROOT, 'src', 'electron', 'preload.ts')
const PRELOAD_DIST = path.join(REPO_ROOT, 'dist', 'electron', 'preload.js')

const preloadSource = fs.readFileSync(PRELOAD_SRC, 'utf8')

/**
 * Every module specifier the compiled preload ACTUALLY requires, in source
 * order. Comment lines are stripped first: the preload's own header explains
 * this bug and names `require('./ipcHandlers')` in prose, and a gate a comment
 * can trip is not a gate — the first draft of this very test failed that way.
 */
function compiledRequires(): string[] {
  const compiled = fs
    .readFileSync(PRELOAD_DIST, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
  return [...compiled.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1])
}

describe('the compiled preload is sandbox-safe (UAT-04)', () => {
  it('has been built — this suite asserts the artifact, not just the source', () => {
    expect(
      fs.existsSync(PRELOAD_DIST),
      'dist/electron/preload.js is missing — run `npm run build` before this suite',
    ).toBe(true)
  })

  it('requires nothing but electron', () => {
    // The whole bug in one assertion. A sandboxed preload may require
    // `electron` and a small core allowlist; a relative require throws at load
    // time and takes the entire renderer API down with it, silently.
    expect(compiledRequires()).toEqual(['electron'])
  })

  it('requires no relative module at all', () => {
    const relative = compiledRequires().filter((m) => m.startsWith('.'))
    expect(
      relative,
      `preload must not require local modules under sandbox: true — found ${relative.join(', ')}`,
    ).toEqual([])
  })

  it('still reaches its last line: the namespace is exposed', () => {
    // If the require guard above ever regresses, this is what stops working,
    // so assert it explicitly rather than implying it.
    expect(preloadSource).toMatch(/contextBridge\.exposeInMainWorld\(\s*['"]agentDesktop['"]/)
  })
})

describe('the channel constants did not drift when they stopped being imported (UAT-04)', () => {
  /** Reads a `const NAME = '...'` literal out of the preload source. */
  function literalIn(source: string, name: string): string | null {
    const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*['"]([^'"]+)['"]`))
    return match ? match[1] : null
  }

  it('STATUS_PUSH_CHANNEL matches ipcHandlers exactly', () => {
    expect(literalIn(preloadSource, 'STATUS_PUSH_CHANNEL')).toBe(STATUS_PUSH_CHANNEL)
  })

  it('LOG_LINE_PUSH_CHANNEL matches ipcHandlers exactly', () => {
    expect(literalIn(preloadSource, 'LOG_LINE_PUSH_CHANNEL')).toBe(LOG_LINE_PUSH_CHANNEL)
  })

  it('the two push channels are not accidentally the same string', () => {
    expect(STATUS_PUSH_CHANNEL).not.toBe(LOG_LINE_PUSH_CHANNEL)
  })

  it('every invoke channel the preload uses is a real channel ipcHandlers serves', () => {
    // The invoke half of the same no-drift guarantee: a typo'd channel name
    // here is a button that silently resolves to nothing.
    const invoked = [...preloadSource.matchAll(/ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
    expect(invoked.length).toBeGreaterThan(0)
    for (const channel of invoked) {
      expect(IPC_CHANNELS as readonly string[]).toContain(channel)
    }
  })

  it('the preload covers every channel ipcHandlers serves, none forgotten', () => {
    const invoked = new Set(
      [...preloadSource.matchAll(/ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
    )
    expect([...IPC_CHANNELS].filter((c) => !invoked.has(c))).toEqual([])
  })
})
