import { afterEach, describe, expect, it } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { AgentServer } from '../src/agent/agentServer';
import { DisplayServer } from '../src/display/displayServer';
import type { QueueService } from '../src/queue/queueService';

describe('Agent WebSocket transport', () => {
  let httpServer: http.Server | undefined;
  let agentServer: AgentServer | undefined;

  afterEach(async () => {
    agentServer?.stop();
    if (httpServer?.listening) {
      await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
    }
  });

  it('does not negotiate permessage-deflate', async () => {
    httpServer = http.createServer();
    agentServer = new AgentServer();
    agentServer.start(httpServer);
    const displayServer = new DisplayServer(
      { getQueuePosition: () => undefined, getQueueLength: () => 0, getAnnouncement: () => null } as unknown as QueueService,
      agentServer,
    );
    displayServer.start(httpServer);

    await new Promise<void>((resolve) => httpServer?.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');

    const extensions = await new Promise<string | undefined>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/agent?token=invalid-test-token`, {
        perMessageDeflate: true,
      });
      ws.once('upgrade', (response) => {
        resolve(response.headers['sec-websocket-extensions']);
      });
      ws.once('error', reject);
    });

    expect(extensions).toBeUndefined();
  });
});
