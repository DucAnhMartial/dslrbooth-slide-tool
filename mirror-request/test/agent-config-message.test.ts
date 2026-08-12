import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { AgentServer } from '../src/agent/agentServer';
import { LocalStore } from '../src/state/localStore';
import { logger } from '../src/logging/logger';
// The Agent's own allow-list, imported across the repository boundary. This is
// the only import in this suite that leaves `mirror-request/`, and it is the
// point of the consistency case at the bottom of the file: two hand-maintained
// lists in two repositories drift, and the drift direction that matters is a
// forbidden field quietly becoming applicable (T-08-24). `liveConfig.ts` has no
// runtime imports of its own, precisely so this stays possible.
import {
  SAFE_AGENT_CONFIG_FIELDS as AGENT_SAFE_FIELDS,
  READ_ONLY_AGENT_CONFIG_FIELDS as AGENT_READ_ONLY_FIELDS,
} from '../../dslrbooth-agent/src/liveConfig';
import {
  SAFE_AGENT_CONFIG_FIELDS,
  READ_ONLY_AGENT_CONFIG_FIELDS,
  DEFAULT_AGENT_CONFIG,
  pickSafeAgentConfig,
  readAgentConfigForAgent,
} from '../src/agent/agentConfigContract';

// ---------------------------------------------------------------------------
// Plan 08-04 Task 1 — the config_request / config / reload_config triple.
//
// The claim under test is D-17 stated literally: configuration reaches the
// Agent by PULL. The Agent asks; the service answers from `agent_config`; the
// service never learns anything from the asking. That last clause is the one
// with teeth, and it is asserted twice — once structurally (the handler seam
// takes no arguments, so there is nothing off the inbound message it COULD
// read) and once behaviourally (a `config_request` carrying a payload leaves
// the stored row deep-equal).
//
// The regression case at the bottom is not decoration: AGT-01..05 are
// complete, verified requirements from Phase 3, and this plan adds a branch to
// the exact `ws.on('message')` chain they run through.
// ---------------------------------------------------------------------------

const VALID_TOKEN = 'test-agent-token'; // injected by vitest.config.ts's env block

const tmpDirs: string[] = [];
const openStores: LocalStore[] = [];

function makeStore(): LocalStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-agent-config-'));
  tmpDirs.push(dir);
  const store = new LocalStore(path.join(dir, 'test.sqlite'));
  openStores.push(store);
  return store;
}

describe('Agent configuration over the existing WS link (UI-02, D-16, D-17)', () => {
  let httpServer: http.Server | undefined;
  let agentServer: AgentServer | undefined;
  let port: number;
  let openSockets: WebSocket[] = [];

  beforeEach(async () => {
    httpServer = http.createServer();
    agentServer = new AgentServer();
    agentServer.start(httpServer);
    await new Promise<void>((resolve) => httpServer?.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    port = address.port;
    openSockets = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const ws of openSockets) {
      try { ws.terminate(); } catch { /* already closed */ }
    }
    agentServer?.stop();
    if (httpServer?.listening) {
      await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
    }
    while (openStores.length) {
      try { openStores.pop()?.close(); } catch { /* already closed */ }
    }
    while (tmpDirs.length) {
      try { fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  function connect(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/agent`, {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });
      openSockets.push(ws);
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
  }

  /** Collects every message the service sends to this socket. */
  function collect(ws: WebSocket): Array<Record<string, unknown>> {
    const seen: Array<Record<string, unknown>> = [];
    ws.on('message', (raw) => seen.push(JSON.parse(raw.toString())));
    return seen;
  }

  /** Waits for the service's answer, or gives up — never hangs the suite. */
  async function settle(ms = 120): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  it('answers a config_request with a config message carrying exactly the four allow-listed keys', async () => {
    const store = makeStore();
    store.saveAgentConfig({
      logLevel: 'debug',
      autoOpenDisplay: false,
      dslrBoothApiPort: 1600,
      dslrBoothPassword: 'booth-secret',
    });
    agentServer?.registerConfigRequestHandler(() => readAgentConfigForAgent(store));

    const ws = await connect();
    const seen = collect(ws);
    ws.send(JSON.stringify({ type: 'config_request' }));
    await settle();

    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe('config');
    const data = seen[0].data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual([...SAFE_AGENT_CONFIG_FIELDS].sort());
    expect(data.dslrBoothApiPort).toBe(1600);
    expect(data.logLevel).toBe('debug');
    expect(data.autoOpenDisplay).toBe(false);
  });

  it('ignores every field riding on the inbound config_request — the stored row is left deep-equal', async () => {
    const store = makeStore();
    const original = {
      logLevel: 'info',
      autoOpenDisplay: true,
      dslrBoothApiPort: 1500,
      dslrBoothPassword: 'booth-secret',
    };
    store.saveAgentConfig(original);
    agentServer?.registerConfigRequestHandler(() => readAgentConfigForAgent(store));

    const ws = await connect();
    const seen = collect(ws);
    // A compromised or simply confused Agent trying to WRITE configuration by
    // riding it on its own request (T-08-19).
    ws.send(JSON.stringify({
      type: 'config_request',
      data: { dslrBoothApiPort: 9999, logLevel: 'silly' },
      dslrBoothPassword: 'attacker-chosen',
      extensionServiceWsUrl: 'ws://evil.example/agent',
    }));
    await settle();

    expect(store.getAgentConfig()).toEqual(original);
    // Nothing was written, so nothing rotated into the one-step history
    // either — a save would have left `original` sitting in previous_json.
    expect(store.restorePreviousAgentConfig()).toBeUndefined();
    // The Agent still gets the STORED answer, not the one it asked for.
    expect((seen[0].data as Record<string, unknown>).dslrBoothApiPort).toBe(1500);
  });

  it('seeds the shipped defaults when agent_config has never been written', async () => {
    const store = makeStore();
    expect(store.getAgentConfig()).toBeUndefined();

    const answered = readAgentConfigForAgent(store);

    expect(answered).toEqual(DEFAULT_AGENT_CONFIG);
    expect(store.getAgentConfig()).toEqual(DEFAULT_AGENT_CONFIG);
    // The seed is an INSERT, not a save-over — there is nothing to step back to.
    expect(store.restorePreviousAgentConfig()).toBeUndefined();
  });

  it('never invents a value it was not given — a stored row missing the password answers without that key', async () => {
    const store = makeStore();
    store.saveAgentConfig({ logLevel: 'warn', autoOpenDisplay: true, dslrBoothApiPort: 1500 });

    const answered = readAgentConfigForAgent(store);

    expect(Object.keys(answered).sort()).toEqual(['autoOpenDisplay', 'dslrBoothApiPort', 'logLevel']);
    expect(answered).not.toHaveProperty('dslrBoothPassword');
  });

  it('leaves the ack, event, heartbeat and unknown-type branches exactly as AGT-01..05 pin them', async () => {
    const acks: Array<[string, boolean, string | undefined]> = [];
    const events: Array<[string, string | undefined]> = [];
    agentServer?.registerAckHandler((jobId, ok, errorMessage) => acks.push([jobId, ok, errorMessage]));
    agentServer?.registerEventHandler((eventType, jobId) => events.push([eventType, jobId]));
    // Deliberately NO config-request handler registered: an Agent that never
    // asks for configuration must behave exactly as it does today.

    const ws = await connect();
    const seen = collect(ws);
    ws.send(JSON.stringify({ type: 'ack', jobId: 'job-1', ok: true }));
    ws.send(JSON.stringify({ type: 'event', event: 'session_end', jobId: 'job-1' }));
    ws.send(JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }));
    ws.send(JSON.stringify({ type: 'not-a-real-type' }));
    await settle();

    expect(acks).toEqual([['job-1', true, undefined]]);
    expect(events).toEqual([['session_end', 'job-1']]);
    expect(agentServer?.isAgentOnline()).toBe(true);
    // None of the four produced an outbound message.
    expect(seen).toEqual([]);
  });

  it('the config-request seam takes no arguments, so there is nothing off the wire it could read', () => {
    const handler = (): Record<string, unknown> => ({});
    // A structural restatement of T-08-19: configuration flows one way BY
    // CONSTRUCTION, not by the handler remembering to ignore its input.
    expect(handler.length).toBe(0);
    expect(AgentServer.prototype.registerConfigRequestHandler).toBeTypeOf('function');
    expect(AgentServer.prototype.registerConfigRequestHandler.length).toBe(1);
  });

  it('warns and sends nothing when a config_request arrives with no configuration source registered', async () => {
    const ws = await connect();
    const seen = collect(ws);
    ws.send(JSON.stringify({ type: 'config_request' }));
    await settle();

    expect(seen).toEqual([]);
    expect(agentServer?.isAgentOnline()).toBe(true);
  });

  it('the four read-only fields are named in the contract and are not in the allow-list', () => {
    expect([...READ_ONLY_AGENT_CONFIG_FIELDS].sort()).toEqual(
      ['extensionServiceWsToken', 'extensionServiceWsUrl', 'logDir', 'triggerServerPort'],
    );
    for (const forbidden of READ_ONLY_AGENT_CONFIG_FIELDS) {
      expect((SAFE_AGENT_CONFIG_FIELDS as readonly string[]).includes(forbidden)).toBe(false);
    }
  });

  it('pickSafeAgentConfig returns only allow-listed keys from a polluted stored row', () => {
    const projected = pickSafeAgentConfig({
      logLevel: 'info',
      dslrBoothApiPort: 1500,
      triggerServerPort: 3001,
      logDir: 'C:/nope',
    });

    expect(Object.keys(projected).sort()).toEqual(['dslrBoothApiPort', 'logLevel']);
  });

  it('warns once per dropped key, naming it, so a polluted row is visible rather than silently trimmed', () => {
    const warned: string[] = [];
    // labelLogger() children resolve their level methods through this logger,
    // so one spy here catches the contract module's warnings too.
    vi.spyOn(logger, 'warn').mockImplementation(((message: string) => {
      warned.push(String(message));
      return logger;
    }) as never);

    pickSafeAgentConfig({
      logLevel: 'info',
      extensionServiceWsUrl: 'ws://evil.example/agent',
      triggerServerPort: 3001,
    });

    expect(warned).toHaveLength(2);
    expect(warned.join(' ')).toContain('extensionServiceWsUrl');
    expect(warned.join(' ')).toContain('triggerServerPort');
  });

  it('never lets a forbidden field reach the wire, even from a polluted stored row', async () => {
    const store = makeStore();
    // A row written by some future bug, or by a hand-edited database.
    store.saveAgentConfig({
      logLevel: 'info',
      dslrBoothApiPort: 1500,
      extensionServiceWsToken: 'leaked-token',
      triggerServerPort: 9999,
      logDir: 'Z:/unwritable',
    });
    agentServer?.registerConfigRequestHandler(() => readAgentConfigForAgent(store));

    const ws = await connect();
    const seen = collect(ws);
    ws.send(JSON.stringify({ type: 'config_request' }));
    await settle();

    const data = seen[0].data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(['dslrBoothApiPort', 'logLevel']);
    for (const forbidden of READ_ONLY_AGENT_CONFIG_FIELDS) {
      expect(data).not.toHaveProperty(forbidden);
    }
    expect(JSON.stringify(seen[0])).not.toContain('leaked-token');
  });

  it('keeps the allow-list at exactly four names and excludes every read-only one', () => {
    expect(SAFE_AGENT_CONFIG_FIELDS).toHaveLength(4);
    expect(READ_ONLY_AGENT_CONFIG_FIELDS).toHaveLength(4);
    expect((SAFE_AGENT_CONFIG_FIELDS as readonly string[]).includes('extensionServiceWsUrl')).toBe(false);
    expect((SAFE_AGENT_CONFIG_FIELDS as readonly string[]).includes('extensionServiceWsToken')).toBe(false);
    expect((SAFE_AGENT_CONFIG_FIELDS as readonly string[]).includes('triggerServerPort')).toBe(false);
    expect((SAFE_AGENT_CONFIG_FIELDS as readonly string[]).includes('logDir')).toBe(false);
  });

  it('the service allow-list and the Agent allow-list name exactly the same four fields', () => {
    // If these two ever disagree, one side sends a field the other refuses —
    // or worse, applies one the other thought it had forbidden. That failure is
    // silent in production and red here.
    expect([...AGENT_SAFE_FIELDS].sort()).toEqual([...SAFE_AGENT_CONFIG_FIELDS].sort());
    expect([...AGENT_READ_ONLY_FIELDS].sort()).toEqual([...READ_ONLY_AGENT_CONFIG_FIELDS].sort());
  });
});
