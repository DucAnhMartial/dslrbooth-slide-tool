import type { AgentHandle, AgentStatus } from '../agent'
import type { Config, ConfigFieldErrors } from '../config'
import type { Logger } from '../logging/logger'
import type { ConfigStore, ConfigSnapshot, ApplyPatchResult } from './configStore'

/**
 * The IPC surface (plan 10-02, Task 1; live-editing wired in Task 2).
 *
 * No import of `electron` — same reason as `configStore.ts`: this returns a
 * plain map of channel name to plain async function, and `main.ts` is the
 * only file that ever calls `ipcMain.handle()` with it. Nothing here reaches
 * for a window, a menu or a tray; that is the entry file's business.
 */
export const IPC_CHANNELS = [
  'config:get',
  'config:set',
  'agent:start',
  'agent:stop',
  'agent:status',
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
  'agent:start': 'start',
  'agent:stop': 'stop',
  'agent:status': 'getStatus',
}

/** The push channel `main.ts` sends `AgentStatus` snapshots on. Not in `IPC_CHANNELS` — it is main→renderer, never invoked. */
export const STATUS_PUSH_CHANNEL = 'agent:status-push'

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

export interface IpcHandlersOptions {
  store: ConfigStore
  logger: Logger
  getAgent: () => AgentHandle | null
  setAgent: (agent: AgentHandle | null) => void
  createAgent: (config: Config, logger: Logger) => AgentHandle
  /** Called with every status change, including the idle snapshot on stop. */
  pushStatus: (status: AgentStatus) => void
}

export interface IpcHandlerMap {
  'config:get': () => Promise<ConfigSnapshot>
  'config:set': (patch: Record<string, unknown>) => Promise<ApplyPatchResult>
  'agent:start': () => Promise<StartResult>
  'agent:stop': () => Promise<{ ok: true }>
  'agent:status': () => Promise<AgentStatus>
}

export function createIpcHandlers(options: IpcHandlersOptions): IpcHandlerMap {
  const { store, logger, getAgent, setAgent, createAgent, pushStatus } = options

  return {
    'config:get': async () => store.getSnapshot(),

    'config:set': async (patch: Record<string, unknown>) => store.applyPatch(patch),

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
