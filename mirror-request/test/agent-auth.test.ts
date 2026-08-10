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

describe('Agent WS authentication (AUTH-01, D-05..D-08)', () => {
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

  /**
   * Attempts a connection and races the client's 'unexpected-response' event
   * (fired on any non-101 upgrade response, e.g. our raw 401) against 'open'
   * (fired only on a completed handshake). Resolves the moment 'open' fires,
   * BEFORE closing the socket — closing first and resolving second would let
   * the server's own 'close' handler null out `agentConn` before the caller
   * gets a chance to assert `isAgentOnline()`. Every socket opened here is
   * tracked and terminated in `afterEach`, never left dangling.
   */
  function attemptConnection(headers?: Record<string, string>): Promise<{ opened: boolean; statusCode?: number }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/agent`, headers ? { headers } : undefined);
      openSockets.push(ws);
      let settled = false;
      ws.once('open', () => {
        settled = true;
        resolve({ opened: true });
      });
      ws.once('unexpected-response', (_req, res) => {
        settled = true;
        resolve({ opened: false, statusCode: res.statusCode });
      });
      ws.once('error', (err) => {
        // A rejected upgrade produces a follow-on ECONNRESET-style error after
        // 'unexpected-response' already resolved the promise; only a genuine
        // connection failure before either event fired should reject.
        if (settled) return;
        reject(err);
      });
    });
  }

  it('rejects a connection with no Authorization header with status 401 and never opens', async () => {
    const result = await attemptConnection();
    expect(result.statusCode).toBe(401);
    expect(result.opened).toBe(false);
  });

  it('rejects a header missing the Bearer prefix with status 401', async () => {
    const result = await attemptConnection({ authorization: VALID_TOKEN });
    expect(result.statusCode).toBe(401);
    expect(result.opened).toBe(false);
  });

  it('rejects a Basic-scheme header with status 401', async () => {
    const result = await attemptConnection({ authorization: 'Basic dGVzdDp0ZXN0' });
    expect(result.statusCode).toBe(401);
    expect(result.opened).toBe(false);
  });

  it('rejects a wrong credential of a different length with 401, without throwing', async () => {
    const result = await attemptConnection({ authorization: 'Bearer wrong' });
    expect(result.statusCode).toBe(401);
    expect(result.opened).toBe(false);
  });

  it('rejects a wrong credential of the same length as the valid one with 401', async () => {
    const sameLengthWrong = VALID_TOKEN.slice(0, -1) + (VALID_TOKEN.endsWith('x') ? 'y' : 'x');
    expect(sameLengthWrong.length).toBe(VALID_TOKEN.length);
    const result = await attemptConnection({ authorization: `Bearer ${sameLengthWrong}` });
    expect(result.statusCode).toBe(401);
    expect(result.opened).toBe(false);
  });

  it('the case after a rejection still connects — proving the comparison returned rather than threw', async () => {
    const rejected = await attemptConnection({ authorization: 'Bearer wrong-length-mismatch' });
    expect(rejected.statusCode).toBe(401);

    const accepted = await attemptConnection({ authorization: `Bearer ${VALID_TOKEN}` });
    expect(accepted.opened).toBe(true);
  });

  it('accepts the correct Bearer credential, opens, and reports isAgentOnline() true', async () => {
    const result = await attemptConnection({ authorization: `Bearer ${VALID_TOKEN}` });
    expect(result.opened).toBe(true);
    expect(agentServer?.isAgentOnline()).toBe(true);
  });

  it('never logs the presented or configured credential, at any level, across every rejection case', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    const infoSpy = vi.spyOn(logger, 'info');
    const errorSpy = vi.spyOn(logger, 'error');
    const debugSpy = vi.spyOn(logger, 'debug');

    await attemptConnection();
    await attemptConnection({ authorization: 'not-bearer-scheme' });
    await attemptConnection({ authorization: 'Bearer wrong' });
    await attemptConnection({ authorization: `Bearer ${VALID_TOKEN.slice(0, -1)}x` });

    const allMessages = [...warnSpy.mock.calls, ...infoSpy.mock.calls, ...errorSpy.mock.calls, ...debugSpy.mock.calls]
      .map((call) => String(call[0]))
      .join('\n');

    expect(allMessages).not.toContain(VALID_TOKEN);
    expect(allMessages).not.toContain('wrong');
  });
});
