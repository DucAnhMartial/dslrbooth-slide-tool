import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { AgentServer } from '../src/agent/agentServer';
import logger from '../src/logging/logger';

// This file intentionally does not import DisplayServer: displayServer.ts
// runs getStore() at module load time, which would create the shared
// test-database singleton as a side effect of the import statement alone.
// This suite needs no store at all (03-VALIDATION.md isolation constraint).

const VALID_TOKEN = 'test-agent-token'; // injected by vitest.config.ts's env block

describe('Agent heartbeat watchdog (AGT-05)', () => {
  let httpServer: http.Server | undefined;
  let agentServer: AgentServer | undefined;
  let port: number;
  let openSockets: WebSocket[] = [];
  let intervalsToClear: NodeJS.Timeout[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const iv of intervalsToClear) clearInterval(iv);
    intervalsToClear = [];
    for (const ws of openSockets) {
      try { ws.terminate(); } catch { /* already closed */ }
    }
    openSockets = [];
    agentServer?.stop();
    if (httpServer?.listening) {
      await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
    }
    agentServer = undefined;
    httpServer = undefined;
  });

  async function startServer(server: AgentServer): Promise<void> {
    httpServer = http.createServer();
    agentServer = server;
    agentServer.start(httpServer);
    await new Promise<void>((resolve) => httpServer?.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    port = address.port;
  }

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

  function waitCloseCode(ws: WebSocket): Promise<number> {
    return new Promise((resolve) => {
      ws.once('close', (code) => resolve(code));
    });
  }

  async function pollUntil(predicate: () => boolean, ceilingMs: number, stepMs = 10): Promise<boolean> {
    const deadline = Date.now() + ceilingMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
    return predicate();
  }

  it('marks a silent Agent offline within the injected timeout and closes with code 4002', async () => {
    await startServer(new AgentServer({ heartbeatIntervalMs: 20, heartbeatTimeoutMs: 60 }));

    const client = await connect();
    const closePromise = waitCloseCode(client);

    const wentOffline = await pollUntil(() => agentServer?.isAgentOnline() === false, 1000);
    expect(wentOffline).toBe(true);
    expect(agentServer?.getAgentStatus().online).toBe(false);

    const closeCode = await closePromise;
    expect(closeCode).toBe(4002);
  });

  it('a heartbeat eviction invokes the disconnect handler exactly once, not twice for the close that follows', async () => {
    let count = 0;
    await startServer(new AgentServer({ heartbeatIntervalMs: 20, heartbeatTimeoutMs: 60 }));
    agentServer?.registerDisconnectHandler(() => { count += 1; });

    await connect();

    await pollUntil(() => agentServer?.isAgentOnline() === false, 1000);
    // Give the socket's own 'close' event, which follows the eviction
    // asynchronously, time to have been delivered as well.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(count).toBe(1);
  });

  it('stays online while heartbeats arrive well inside the injected timeout', async () => {
    await startServer(new AgentServer({ heartbeatIntervalMs: 25, heartbeatTimeoutMs: 500 }));

    const client = await connect();
    const hbInterval = setInterval(() => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }));
      }
    }, 25);
    intervalsToClear.push(hbInterval);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(agentServer?.isAgentOnline()).toBe(true);

    clearInterval(hbInterval);
  });

  it('with no arguments, still starts, accepts a connection and reports online (production defaults unchanged)', async () => {
    await startServer(new AgentServer());

    await connect();
    expect(agentServer?.isAgentOnline()).toBe(true);
  });

  it('never logs the credential in the timeout warning', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    const infoSpy = vi.spyOn(logger, 'info');
    const errorSpy = vi.spyOn(logger, 'error');
    const debugSpy = vi.spyOn(logger, 'debug');

    await startServer(new AgentServer({ heartbeatIntervalMs: 20, heartbeatTimeoutMs: 60 }));
    await connect();

    await pollUntil(() => agentServer?.isAgentOnline() === false, 1000);

    const allMessages = [...warnSpy.mock.calls, ...infoSpy.mock.calls, ...errorSpy.mock.calls, ...debugSpy.mock.calls]
      .map((call) => String(call[0]))
      .join('\n');
    expect(allMessages).not.toContain(VALID_TOKEN);

    const timeoutWarning = warnSpy.mock.calls.map((call) => String(call[0])).find((msg) => msg.startsWith('Agent heartbeat timeout'));
    expect(timeoutWarning).toBeDefined();
    expect(timeoutWarning).toMatch(/^Agent heartbeat timeout \(\d+ms > 60ms\)$/);
  });
});
