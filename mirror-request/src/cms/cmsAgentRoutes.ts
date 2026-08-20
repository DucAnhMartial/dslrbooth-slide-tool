import { Router, Request, Response } from 'express';
import { labelLogger, LOG_LEVELS } from '../logging/logger';
import {
  SAFE_AGENT_CONFIG_FIELDS,
  isSafeAgentConfigField,
  pickSafeAgentConfig,
  DEFAULT_AGENT_CONFIG,
} from '../agent/agentConfigContract';
import {
  renderCmsAgentConfigPage,
  AGENT_SAVE_SUCCESS,
  AGENT_SAVE_ERROR,
  AGENT_OFFLINE_NOTICE,
  AGENT_NO_PREVIOUS,
  AGENT_RESTORE_SUCCESS,
  AGENT_TEST_SUCCESS,
  AGENT_TEST_FAILURE,
} from './cmsAgentPages';

const log = labelLogger('cms');

/**
 * The narrowest view of `LocalStore` this page needs — three methods, all of
 * them about `agent_config`. Note what is absent: nothing here can touch an
 * event, a queue row or booth state.
 */
export interface CmsAgentStore {
  getAgentConfig(): Record<string, unknown> | undefined;
  saveAgentConfig(next: Record<string, unknown>): void;
  restorePreviousAgentConfig(): Record<string, unknown> | undefined;
}

/**
 * The two primitives the save and the connection test need from the live Agent
 * link. `AgentServer` satisfies this structurally, so `index.ts` passes it
 * unchanged while a test can drive these routes against an Agent that is
 * offline on purpose.
 *
 * `sendEvent` and NOT `sendCommand`: this page never dispatches work to the
 * booth. It tells the Agent that something changed and lets the Agent ask.
 */
export interface CmsAgentLink {
  isAgentOnline(): boolean;
  sendEvent(payload: { type: string; data?: unknown }): boolean;
}

type Validated = { ok: true; patch: Record<string, unknown> } | { ok: false };

/**
 * Validates one whole submission, and refuses the WHOLE thing when any part of
 * it is wrong — the same all-or-nothing rule `validateEventPatch` applies, for
 * the same reason: a save that silently dropped one value leaves the operator
 * looking at a form that disagrees with the booth, with no error to explain it.
 *
 * The first check is the one that matters. Any key outside the allow-list is a
 * refusal, not an omission (T-08-20): the form does not render controls for the
 * four non-editable fields, but a form is one devtools edit away from absent,
 * so the SERVER is where "these four are not remotely editable" is actually
 * true.
 */
export function validateAgentConfigSubmission(raw: Record<string, unknown>): Validated {
  const patch: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (!isSafeAgentConfigField(key)) {
      log.warn(`Refused Agent configuration save carrying non-editable field "${key}"`);
      return { ok: false };
    }

    if (key === 'logLevel') {
      if (typeof value !== 'string' || !(LOG_LEVELS as readonly string[]).includes(value)) return { ok: false };
      patch.logLevel = value;
      continue;
    }

    if (key === 'autoOpenDisplay') {
      // The page posts a real boolean; `express.urlencoded` would deliver a
      // string, and both are accepted so this endpoint behaves the same from a
      // form post as from the page's fetch.
      if (typeof value === 'boolean') patch.autoOpenDisplay = value;
      else if (value === 'true' || value === 'false') patch.autoOpenDisplay = value === 'true';
      else return { ok: false };
      continue;
    }

    if (key === 'dslrBoothApiPort') {
      const port = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      // Out of range is REFUSED, never clamped: a clamp leaves the CMS and the
      // booth disagreeing, and the operator finds out from a dead booth.
      if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return { ok: false };
      patch.dslrBoothApiPort = port;
      continue;
    }

    if (key === 'dslrBoothPassword') {
      if (typeof value !== 'string') return { ok: false };
      // Empty means "leave unchanged", so it never enters the patch. It is not
      // an error, and it is not a way to clear the password either — clearing
      // it would take dslrBooth offline until somebody walked to the booth.
      if (value !== '') patch.dslrBoothPassword = value;
      continue;
    }

    // EXHAUSTIVENESS. `isSafeAgentConfigField` has already narrowed `key` to
    // `SafeAgentConfigField`, and the four branches above consume all four
    // members — so `key` is `never` here and this assignment compiles only
    // while that stays true. Add a fifth field to SAFE_AGENT_CONFIG_FIELDS
    // without adding its validation branch and `npm run typecheck` fails at
    // this line, which is the whole point: the alternative was the field
    // sailing through the allow-list, finding no branch, and being SILENTLY
    // dropped from the patch while this function still answered `ok: true` —
    // contradicting its own "refuse the whole thing" contract, and doing it
    // invisibly (Phase 8 code review, WR-06). The runtime refusal below is
    // the belt to that compile-time braces: unreachable today, correct if a
    // future `any` ever erodes the narrowing.
    const unhandled: never = key;
    log.warn(`Refused Agent configuration save carrying unvalidated field "${String(unhandled)}"`);
    return { ok: false };
  }

  return { ok: true, patch };
}

/**
 * The CMS Agent-configuration surface (UI-02, D-16, D-17, D-18).
 *
 * Mounted by `createCmsRouter` after `requireSession()`, so nothing here
 * re-checks authentication — the ordering in the parent router is the control,
 * exactly as it is for the event routes.
 */
export function createCmsAgentRoutes(store: CmsAgentStore, agent: CmsAgentLink): ReturnType<typeof Router> {
  const router = Router();

  /**
   * One reload command per successful mutation, carrying nothing.
   *
   * D-17's literal wording is "the service sends a reload command and the Agent
   * re-requests". Pushing the values here instead would look simpler and change
   * the failure semantics: a push arriving while the Agent is mid-reconnect has
   * nowhere reliable to land, whereas a pull the Agent initiates always has a
   * live socket to answer on. Returns whether it was delivered — which is a
   * report, not a verdict on the save.
   */
  function askAgentToReload(): boolean {
    return agent.sendEvent({ type: 'reload_config' });
  }

  router.get('/agent', (_req: Request, res: Response) => {
    const stored = pickSafeAgentConfig(store.getAgentConfig() ?? DEFAULT_AGENT_CONFIG);
    res.type('html').send(
      renderCmsAgentConfigPage({
        logLevel: typeof stored.logLevel === 'string' ? stored.logLevel : 'info',
        autoOpenDisplay: stored.autoOpenDisplay !== false,
        dslrBoothApiPort: typeof stored.dslrBoothApiPort === 'number' ? stored.dslrBoothApiPort : null,
        // The value never leaves the database; only the fact that there is one.
        passwordSet: typeof stored.dslrBoothPassword === 'string' && stored.dslrBoothPassword.length > 0,
        agentOnline: agent.isAgentOnline(),
      }),
    );
  });

  router.post('/api/agent', (req: Request, res: Response) => {
    const result = validateAgentConfigSubmission((req.body ?? {}) as Record<string, unknown>);
    if (!result.ok) {
      res.status(400).json({ error: AGENT_SAVE_ERROR });
      return;
    }

    // Merge over what is stored, so a field the operator did not submit — and
    // an intentionally-empty password — survives the save untouched.
    const current = pickSafeAgentConfig(store.getAgentConfig());
    const next = { ...current, ...result.patch };
    store.saveAgentConfig(next);

    const delivered = askAgentToReload();
    // Field NAMES only. `dslrBoothPassword`'s value is treated exactly like the
    // Agent bearer token: it never appears in a log line (T-08-22).
    log.info(
      `Saved Agent configuration (${Object.keys(result.patch).join(', ') || 'no changes'})` +
        (delivered ? ' and asked the Agent to reload' : ' — Agent offline, it will pull on reconnect'),
    );
    res.status(200).json({
      saved: true,
      agentOnline: delivered,
      message: delivered ? AGENT_SAVE_SUCCESS : AGENT_OFFLINE_NOTICE,
    });
  });

  /**
   * D-18's one step back, and only one.
   *
   * `restorePreviousAgentConfig()` clears the previous slot as it restores
   * (plan 08-01), which is what makes this one step rather than a two-entry
   * ring: pressing it twice must not hand back the configuration the operator
   * has just rejected — the same button doing the opposite thing on the second
   * press, with no indication that it had. The second press is refused, plainly.
   */
  router.post('/api/agent/restore', (_req: Request, res: Response) => {
    const restored = store.restorePreviousAgentConfig();
    if (!restored) {
      res.status(409).json({ error: AGENT_NO_PREVIOUS });
      return;
    }

    const delivered = askAgentToReload();
    log.info(
      'Restored the previous Agent configuration' +
        (delivered ? ' and asked the Agent to reload' : ' — Agent offline, it will pull on reconnect'),
    );
    res.status(200).json({
      restored: true,
      agentOnline: delivered,
      message: delivered ? AGENT_RESTORE_SUCCESS : AGENT_OFFLINE_NOTICE,
    });
  });

  /**
   * The connection test is a READ of the live link — it sends nothing. There is
   * no probe to run: the Agent's own heartbeat already answers this question,
   * and inventing a second liveness mechanism here would give the operator two
   * answers that can disagree.
   */
  router.post('/api/agent/test', (_req: Request, res: Response) => {
    const online = agent.isAgentOnline();
    res.status(200).json({ online, message: online ? AGENT_TEST_SUCCESS : AGENT_TEST_FAILURE });
  });

  return router;
}

/** Re-exported so a caller has one import for the field vocabulary. */
export { SAFE_AGENT_CONFIG_FIELDS };
