import type { AgentHandle, AgentStatus } from '../agent'
import type { Config, ConfigFieldErrors } from '../config'
import type { Logger } from '../logging/logger'
import { isSafeAgentConfigField } from '../liveConfig'
import type { ConfigStore, ConfigSnapshot, PatchFieldErrors, ImportLegacyResult } from './configStore'

/**
 * The IPC surface (plan 10-02).
 *
 * No import of `electron` — same reason as `configStore.ts`: this returns a
 * plain map of channel name to plain async function, and `main.ts` is the
 * only file that ever calls `ipcMain.handle()` with it. Nothing here reaches
 * for a window, a menu or a tray; that is the entry file's business.
 *
 * `config:set`'s two halves (D10-02, D10-03, Task 2): the four CMS-safe
 * fields, imported from `liveConfig.ts` rather than restated, apply to a
 * running relay through the identical `LiveConfig.apply()` the wire uses —
 * so a port change reaches the dslrBooth client through the hook that
 * already exists, and nothing is reimplemented. The other four are exactly
 * the four the wire may never write (`READ_ONLY_AGENT_CONFIG_FIELDS`):
 * persisted, and reported as needing a restart, because the running Agent
 * captured them at its own construction time and has no live path for them.
 */
export const IPC_CHANNELS = [
  'config:get',
  'config:set',
  'config:import-legacy',
  'agent:start',
  'agent:stop',
  'agent:status',
  'log:recent',
] as const

export type IpcChannel = (typeof IPC_CHANNELS)[number]

/**
 * The preload's exposed function name for each channel, exported so
 * `preload.ts` and its test derive the same names from the same place — the
 * two lists cannot drift apart the way two independently-typed literals could.
 */
export const IPC_CHANNEL_FUNCTION_NAMES: Record<IpcChannel, string> = {
  'config:get': 'getConfig',
  'config:set': 'setConfig',
  'config:import-legacy': 'importLegacyEnv',
  'agent:start': 'start',
  'agent:stop': 'stop',
  'agent:status': 'getStatus',
  'log:recent': 'getRecentLogLines',
}

/** The push channel `main.ts` sends `AgentStatus` snapshots on. Not in `IPC_CHANNELS` — it is main→renderer, never invoked. */
export const STATUS_PUSH_CHANNEL = 'agent:status-push'

/** The push channel `main.ts` sends each masked log line on. Not in `IPC_CHANNELS` — it is main→renderer, never invoked. */
export const LOG_LINE_PUSH_CHANNEL = 'log:line-push'

const IDLE_STATUS: AgentStatus = {
  running: false,
  socketState: 'disconnected',
  triggerPort: null,
  dslrBoothReachable: 'unknown',
  lastEventAt: null,
  startedAt: null,
  lastError: null,
}

export type StartResult =
  | { ok: true }
  | { ok: false; errors: ConfigFieldErrors }
  | { ok: false; error: string }

export type ConfigSetResult =
  | { ok: true; restartRequired: boolean }
  | { ok: false; errors: PatchFieldErrors }

export interface IpcHandlersOptions {
  store: ConfigStore
  logger: Logger
  getAgent: () => AgentHandle | null
  setAgent: (agent: AgentHandle | null) => void
  createAgent: (config: Config, logger: Logger) => AgentHandle
  /** Called with every status change, including the idle snapshot on stop. */
  pushStatus: (status: AgentStatus) => void
  /** The log tail's retained buffer, newest last. Defaults to an empty list when not supplied. */
  getRecentLogLines?: () => string[]
}

export interface IpcHandlerMap {
  'config:get': () => Promise<ConfigSnapshot>
  'config:set': (patch: Record<string, unknown>) => Promise<ConfigSetResult>
  'config:import-legacy': () => Promise<ImportLegacyResult>
  'agent:start': () => Promise<StartResult>
  'agent:stop': () => Promise<{ ok: true }>
  'agent:status': () => Promise<AgentStatus>
  'log:recent': () => Promise<string[]>
}

export function createIpcHandlers(options: IpcHandlersOptions): IpcHandlerMap {
  const { store, logger, getAgent, setAgent, createAgent, pushStatus, getRecentLogLines } = options

  return {
    'config:get': async () => store.getSnapshot(),

    'config:import-legacy': async (): Promise<ImportLegacyResult> => store.importLegacy(),

    'log:recent': async () => (getRecentLogLines ? getRecentLogLines() : []),

    'config:set': async (patch: Record<string, unknown>): Promise<ConfigSetResult> => {
      const result = store.applyPatch(patch)
      if (!result.ok) return result

      const patchedKeys = Object.keys(patch)
      const safeKeysInPatch = patchedKeys.filter((key) => isSafeAgentConfigField(key))
      const bootstrapKeysInPatch = patchedKeys.filter((key) => !isSafeAgentConfigField(key))

      const agent = getAgent()
      let restartRequired = false

      if (agent && agent.isRunning()) {
        if (safeKeysInPatch.length > 0) {
          const built = store.buildConfig()
          if (built.ok) {
            const liveSubset: Record<string, unknown> = {}
            for (const key of safeKeysInPatch) {
              liveSubset[key] = (built.config as unknown as Record<string, unknown>)[key]
            }
            // The identical LiveConfig.apply() the wire uses (D10-02) — the
            // port change reaches DslrBoothClient through the existing
            // onCredentialsChange hook, the log level reaches every
            // transport through the existing applier, nothing reimplemented.
            agent.live.apply(liveSubset)
            pushStatus(agent.getStatus())
          }
        }
        if (bootstrapKeysInPatch.length > 0) restartRequired = true
      }

      return { ok: true, restartRequired }
    },

    'agent:start': async (): Promise<StartResult> => {
      const existing = getAgent()
      if (existing && existing.isRunning()) return { ok: true }

      const result = store.buildConfig()
      if (!result.ok) return { ok: false, errors: result.errors }

      const agent = createAgent(result.config, logger)
      agent.onStatus((status) => pushStatus(status))
      setAgent(agent)

      await agent.start()
      pushStatus(agent.getStatus())

      if (!agent.isRunning()) {
        return { ok: false, error: agent.getLastError() ?? 'The relay did not start, for an unrecorded reason.' }
      }
      return { ok: true }
    },

    'agent:stop': async () => {
      const agent = getAgent()
      if (agent) {
        await agent.stop()
        setAgent(null)
      }
      pushStatus(IDLE_STATUS)
      return { ok: true }
    },

    'agent:status': async () => {
      const agent = getAgent()
      return agent ? agent.getStatus() : IDLE_STATUS
    },
  }
}
