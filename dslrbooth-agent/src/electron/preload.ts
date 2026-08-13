import { contextBridge, ipcRenderer } from 'electron'
import { STATUS_PUSH_CHANNEL } from './ipcHandlers'

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
}

contextBridge.exposeInMainWorld('agentDesktop', api)
