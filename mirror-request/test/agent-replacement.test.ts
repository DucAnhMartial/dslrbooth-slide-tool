import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { AgentServer } from '../src/agent/agentServer';
import logger from '../src/logging/logger';

// This file intentionally does not import DisplayServer: displayServer.ts
// runs getStore() at module load time, which would create the shared
// test-database singleton as a side effect of the import statement alone.
// This suite needs no store at all (03-VALIDATION.md isolation constraint).

const VALID_TOKEN = 'test-agent-token'; // injected by vitest.config.ts's env block

describe('Agent WS replacement (AGT-01, D-10, D-11)', () => {
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

  function waitClose(ws: WebSocket): Promise<void> {
    return new Promise((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) return resolve();
      ws.once('close', () => resolve());
    });
  }

  it('a second Agent displaces the first (last-wins) and isAgentOnline stays true', async () => {
    const clientA = await connect();
    const clientB = await connect();
    await waitClose(clientA);

    expect(agentServer?.isAgentOnline()).toBe(true);
    expect(clientB.readyState).toBe(WebSocket.OPEN);
    expect(clientA.readyState).not.toBe(WebSocket.OPEN);
  });

  it('the displacement emits exactly one warning naming two different connection ids', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');

    const clientA = await connect();
    const clientB = await connect();
    await waitClose(clientA);

    const replacedCalls = warnSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((msg) => /^Agent WS replaced: .+ displaced by .+$/.test(msg));

    expect(replacedCalls).toHaveLength(1);

    const match = replacedCalls[0].match(/^Agent WS replaced: (.+) displaced by (.+)$/);
    expect(match).not.toBeNull();
    const [, displacedId, arrivingId] = match as RegExpMatchArray;
    expect(displacedId).not.toBe(arrivingId);

    clientB.terminate();
  });

  it('two connections accepted in immediate succession never receive the same connection id', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');

    const clientA = await connect();
    const clientB = await connect();
    await waitClose(clientA);

    const replacedCalls = warnSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((msg) => msg.startsWith('Agent WS replaced:'));
    expect(replacedCalls).toHaveLength(1);
    const match = replacedCalls[0].match(/^Agent WS replaced: (.+) displaced by (.+)$/);
    const [, displacedId, arrivingId] = match as RegExpMatchArray;
    expect(displacedId).not.toBe(arrivingId);

    clientB.terminate();
  });

  it('a single client connecting on its own produces no displacement warning', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');

    const client = await connect();

    const replacedCalls = warnSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((msg) => msg.startsWith('Agent WS replaced:'));
    expect(replacedCalls).toHaveLength(0);

    client.terminate();
  });

  it('no captured log message contains the credential', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    const infoSpy = vi.spyOn(logger, 'info');
    const errorSpy = vi.spyOn(logger, 'error');
    const debugSpy = vi.spyOn(logger, 'debug');

    const clientA = await connect();
    const clientB = await connect();
    await waitClose(clientA);

    const allMessages = [...warnSpy.mock.calls, ...infoSpy.mock.calls, ...errorSpy.mock.calls, ...debugSpy.mock.calls]
      .map((call) => String(call[0]))
      .join('\n');

    expect(allMessages).not.toContain(VALID_TOKEN);

    clientB.terminate();
  });
});
