import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import http from 'http';
import express from 'express';
import { getStore } from '../src/state/localStore';
import type { QueueService } from '../src/queue/queueService';
import type { AgentServer } from '../src/agent/agentServer';
import { DisplayServer } from '../src/display/displayServer';

describe('Phase 5: Display feed', () => {
  let server: http.Server;
  let app: express.Express;
  let wsUrl: string;
  let mockQueue: Partial<QueueService>;
  let mockAgent: Partial<AgentServer>;
  let display: DisplayServer;

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    mockQueue = {
      getQueuePosition: () => 1,
      getQueueLength: () => 2,
      getAnnouncement: () => null,
    } as Partial<QueueService>;
    mockAgent = {
      isAgentOnline: () => true,
    } as Partial<AgentServer>;
    display = new DisplayServer(mockQueue as QueueService, mockAgent as AgentServer);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const addr = server.address();
    if (addr && typeof addr === 'object') {
      wsUrl = `ws://127.0.0.1:${addr.port}/display`;
    }
    display.start(server);
  });

  afterAll(async () => {
    display.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('client receives snapshot on connect', async () => {
    const msg = await new Promise<any>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        ws.close();
        resolve(null);
      }, 2000);
      ws.on('open', () => console.log('ws open'));
      ws.on('message', (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(data.toString()));
        ws.close();
      });
      ws.on('error', (e) => {
        clearTimeout(timer);
        console.error('ws error', e);
        resolve(null);
      });
    });
    expect(msg).toBeTruthy();
    expect(msg.type).toBe('snapshot');
    expect(msg.data.queueLength).toBe(2);
    expect(msg.data.boothState).toBeDefined();
    expect(msg.data.upNext).toBeInstanceOf(Array);
  });

  it('serves a display page with guest countdown UI', async () => {
    const { renderDisplayPage } = await import('../src/display/displayPage');
    const html = renderDisplayPage();
    expect(html).toContain('Xin mời khách tiếp theo');
    expect(html).toContain('countdownSeconds');
    expect(html).toContain("'/display'");
  });
});
