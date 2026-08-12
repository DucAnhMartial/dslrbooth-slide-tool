import { labelLogger } from '../logging/logger';

const log = labelLogger('agent-config');

/**
 * The safe-field allow-list — D-16, enforced in CODE rather than in prose.
 *
 * There is exactly one of these constants on this side of the wire, and
 * exactly one on the Agent's (`dslrbooth-agent/src/liveConfig.ts`). Two
 * hand-maintained inline lists drift, and the drift direction that matters is
 * a forbidden field quietly becoming applicable — so the two arrays are
 * asserted equal by `test/agent-config-message.test.ts` and a divergence
 * surfaces as a red test rather than as an applied field.
 *
 * Neither side depends on the other behaving: the service projects to these
 * four keys before it sends, AND the Agent applies only these four when it
 * receives. Either check alone would be a single point of failure.
 */
export const SAFE_AGENT_CONFIG_FIELDS = [
  'logLevel',
  'autoOpenDisplay',
  'dslrBoothApiPort',
  'dslrBoothPassword',
] as const;

export type SafeAgentConfigField = (typeof SAFE_AGENT_CONFIG_FIELDS)[number];

/**
 * The other half of the Agent's 8-field `Config` interface — never accepted
 * from the wire, never sent over it, shown in the CMS as read-only.
 *
 * The first three are D-16's named-forbidden set, and the reason is not
 * stylistic: `extensionServiceWsUrl` and `extensionServiceWsToken` create the
 * very WebSocket a configuration change travels over, and `triggerServerPort`
 * is the local HTTP port dslrBooth itself posts to. A wrong value means the
 * Agent can never reconnect and somebody must physically visit the booth,
 * mid-event.
 *
 * `logDir` is the fourth by decision, not by oversight. D-16 classified 7 of
 * the Agent's 8 fields and left this one unnamed; 08-RESEARCH flagged the gap
 * as Assumption A1 and recommended the restrictive default, and plan 08-04
 * adopted it: it is filesystem-path configuration, closer in kind to the
 * bootstrap fields than to the operational-tuning ones, no `logDir` control
 * appears anywhere in 08-UI-SPEC's Agent surface, and an unwritable path
 * would silently blackhole every future Agent log — a failure that hides the
 * evidence of itself.
 */
export const READ_ONLY_AGENT_CONFIG_FIELDS = [
  'extensionServiceWsUrl',
  'extensionServiceWsToken',
  'triggerServerPort',
  'logDir',
] as const;

export type ReadOnlyAgentConfigField = (typeof READ_ONLY_AGENT_CONFIG_FIELDS)[number];

/**
 * What a booth that has never been configured from the CMS is told.
 *
 * These mirror `dslrbooth-agent/src/config.ts`'s own env defaults, so seeding
 * this row changes nothing about how a fresh Agent behaves — it only gives the
 * CMS something to render and the operator something to edit.
 *
 * `dslrBoothPassword` is deliberately ABSENT rather than empty. An empty
 * string is a value, and applying it would overwrite the password the booth
 * was installed with, taking dslrBooth offline on the first CMS visit. A
 * missing key is applied by nobody.
 */
export const DEFAULT_AGENT_CONFIG: Record<string, unknown> = {
  logLevel: 'info',
  autoOpenDisplay: true,
  dslrBoothApiPort: 1500,
};

export function isSafeAgentConfigField(key: string): key is SafeAgentConfigField {
  return (SAFE_AGENT_CONFIG_FIELDS as readonly string[]).includes(key);
}

/**
 * Projects a stored configuration onto the allow-list.
 *
 * Keys that are absent stay absent — this never invents a value it was not
 * given. Keys that are present but not allow-listed are dropped with ONE
 * warning naming the key, so a polluted row is visible in the log rather than
 * silently trimmed: a stored `triggerServerPort` means something wrote a field
 * it should not have, and that is worth reading about before the day it
 * matters.
 *
 * Only the KEY is ever logged, never the value — `dslrBoothPassword` takes the
 * same never-echoed path the Agent bearer token takes (T-08-22).
 */
export function pickSafeAgentConfig(input: Record<string, unknown> | undefined): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  if (!input) return projected;

  for (const [key, value] of Object.entries(input)) {
    if (!isSafeAgentConfigField(key)) {
      log.warn(`Dropped non-editable field "${key}" from the stored Agent configuration`);
      continue;
    }
    projected[key] = value;
  }
  return projected;
}

/**
 * The narrowest view of `LocalStore` the config-request answer needs — the
 * same router-as-factory discipline `CmsEventStore` applies. Note what is
 * absent: no `restorePreviousAgentConfig`. Answering a pull must never be able
 * to rotate the operator's one step back out from under them.
 */
export interface AgentConfigSource {
  getAgentConfig(): Record<string, unknown> | undefined;
  saveAgentConfig(next: Record<string, unknown>): void;
}

/**
 * What the service answers a `config_request` with.
 *
 * Takes the store and NOTHING ELSE. The inbound message is not a parameter
 * here, and it is not a parameter of `registerConfigRequestHandler`'s callback
 * either — configuration flows one way by construction, so a compromised Agent
 * cannot rewrite the service's source of truth even if this function forgot to
 * be careful (T-08-19).
 *
 * An empty row is seeded rather than answered empty: a booth asking for its
 * configuration before an operator has ever opened the CMS should be told what
 * it already believes, not told nothing.
 */
export function readAgentConfigForAgent(store: AgentConfigSource): Record<string, unknown> {
  const stored = store.getAgentConfig();
  if (!stored) {
    const seeded = { ...DEFAULT_AGENT_CONFIG };
    store.saveAgentConfig(seeded);
    log.info('Seeded agent_config with the shipped defaults on first Agent request');
    return seeded;
  }
  return pickSafeAgentConfig(stored);
}
