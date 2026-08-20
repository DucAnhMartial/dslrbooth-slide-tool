import { contextBridge, ipcRenderer } from 'electron'

/**
 * UAT-04 — why these two strings are LITERALS here and not imported.
 *
 * This file runs as a SANDBOXED preload (`sandbox: true` in main.ts). A
 * sandboxed preload's `require` is a polyfill limited to `electron` and a
 * couple of core modules: a relative `require('./ipcHandlers')` THROWS, the
 * preload dies before its last line, `window.agentDesktop` is never defined,
 * and every button in the renderer becomes silently inert — no error anywhere,
 * because the failure happens before there is anything left to report with.
 *
 * That is exactly what shipped and what the first booth-PC install hit: Save
 * wrote no config, Start bound no port and dialled nothing, and both logs were
 * empty. Importing the constants was correct for keeping the two channel lists
 * from drifting, and `sandbox: true` was correct for the security posture —
 * they were simply fatal together, and no test loaded this file in a real
 * sandboxed renderer to find out.
 *
 * The no-drift guarantee is preserved WITHOUT the import: these literals are
 * asserted equal to `ipcHandlers.ts`'s exports by
 * `test/electron-preload-sandbox.test.ts`, which runs under vitest and may
 * import both freely. That file also asserts the COMPILED preload requires
 * nothing but `electron`, so this class of failure cannot return.
 *
 * Do not replace these with an import.
 */
const STATUS_PUSH_CHANNEL = 'agent:status-push'
const LOG_LINE_PUSH_CHANNEL = 'log:line-push'

/**
 * The preload — the only door between the renderer and the main process
 * (10-RESEARCH Pattern 3). Exposes exactly one namespace, `window.agentDesktop`,
 * built as an explicit literal (not a loop over the channel constant) so this
 * file stays readable as plain text for `test/electron-main-security.test.ts`,
 * which reads it without executing it (this file imports `electron`, which is
 * not a real module outside an Electron process). The five channel-backed
 * functions below are named from `IPC_CHANNEL_FUNCTION_NAMES` in
 * `ipcHandlers.ts` — that map is what the security test imports to compute
 * the expected exposed-function set, so the two lists cannot silently drift.
 *
 * `config:get` never returns a plaintext secret (T-10-08) — this file does
 * not know that; it is a plain pass-through to `ipcRenderer.invoke`, and the
 * redaction lives entirely in `configStore.ts`'s `getSnapshot()`.
 */
const api = {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch: Record<string, unknown>) => ipcRenderer.invoke('config:set', patch),
  importLegacyEnv: () => ipcRenderer.invoke('config:import-legacy'),
  start: () => ipcRenderer.invoke('agent:start'),
  stop: () => ipcRenderer.invoke('agent:stop'),
  getStatus: () => ipcRenderer.invoke('agent:status'),
  getRecentLogLines: () => ipcRenderer.invoke('log:recent'),
  getPreferences: () => ipcRenderer.invoke('preferences:get'),
  setPreferences: (patch: Record<string, unknown>) => ipcRenderer.invoke('preferences:set', patch),

  // The two subscription helpers, for the one push channel `main.ts` sends
  // status snapshots on. `onStatus` also returns an unsubscribe function
  // directly (contextBridge clones functions across the boundary), so
  // `offStatus` exists only for a caller that did not keep it.
  onStatus: (callback: (status: unknown) => void) => {
    const listener = (_event: unknown, status: unknown) => callback(status)
    ipcRenderer.on(STATUS_PUSH_CHANNEL, listener as never)
    return () => ipcRenderer.removeListener(STATUS_PUSH_CHANNEL, listener as never)
  },
  offStatus: () => {
    ipcRenderer.removeAllListeners(STATUS_PUSH_CHANNEL)
  },

  // The matching pair for the log-line push channel — each already-masked
  // line `logTail.ts` emits, pushed one at a time (T-10-19: always as data,
  // never rendered by this file itself; the renderer decides how to place it
  // in the DOM, and does so as text only — see index.js).
  onLogLine: (callback: (line: string) => void) => {
    const listener = (_event: unknown, line: string) => callback(line)
    ipcRenderer.on(LOG_LINE_PUSH_CHANNEL, listener as never)
    return () => ipcRenderer.removeListener(LOG_LINE_PUSH_CHANNEL, listener as never)
  },
  offLogLine: () => {
    ipcRenderer.removeAllListeners(LOG_LINE_PUSH_CHANNEL)
  },
}

contextBridge.exposeInMainWorld('agentDesktop', api)
