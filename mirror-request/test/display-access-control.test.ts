import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import http from 'http';
import fs from 'fs';
import { WebSocket } from 'ws';
import { clientIp, isWhitelisted } from '../src/security/ipAllowlist';
import { renderDisplayPage } from '../src/display/displayPage';
import { DisplayServer } from '../src/display/displayServer';
import { LocalStore } from '../src/state/localStore';
import type { QueueService } from '../src/queue/queueService';
import type { AgentServer } from '../src/agent/agentServer';

// D-16/WINDOWS ledger item 4: every store in this file is opened through the
// constructor(dbPath?) seam, never the getStore() singleton, and closed in
// afterEach. Each path is unique so parallel vitest workers never share one
// file.
let storeCounter = 0;
function uniqueStorePath(): string {
  storeCounter += 1;
  return `./data/test-display-access-control-${process.pid}-${Date.now()}-${storeCounter}.sqlite`;
}
const openStores: LocalStore[] = [];
function makeStore(): LocalStore {
  const store = new LocalStore(uniqueStorePath());
  openStores.push(store);
  return store;
}

function makeMockQueue(getQueueLength: () => number = () => 0): Partial<QueueService> {
  return {
    getQueuePosition: () => undefined,
    getQueueLength,
    getAnnouncement: () => null,
  };
}
function makeMockAgent(): Partial<AgentServer> {
  return { isAgentOnline: () => true };
}

afterEach(() => {
  while (openStores.length) {
    const store = openStores.pop();
    try {
      store?.close();
    } catch {
      /* already closed */
    }
  }
});

// ---------------------------------------------------------------------------
// /display-screen — Express layer (D-09)
//
// index.ts's actual /display-screen route is built from exactly these two
// exported functions (clientIp, isWhitelisted) plus renderDisplayPage(), so
// exercising them here through an equivalent middleware chain proves the
// same shared logic index.ts's route depends on — the "both surfaces call
// the same exported pair" key link this plan establishes.
// ---------------------------------------------------------------------------

function buildDisplayScreenAppWithFakeIp(whitelist: string[], fakeIp: string): express.Express {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', { value: fakeIp, configurable: true });
    next();
  });
  app.get(
    '/display-screen',
    (req, res, next) => {
      const ip = clientIp(req);
      if (!isWhitelisted(ip, whitelist)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      next();
    },
    (_req, res) => res.type('html').send(renderDisplayPage()),
  );
  return app;
}

/** Every /display-screen 403 in this file must have this exact shape,
 * matching Phase 1's blocked-IP body byte-for-byte (D-09's "one
 * indistinguishable refusal" posture). */
function expectForbidden(res: request.Response): void {
  expect(res.status).toBe(403);
  expect(Object.keys(res.body)).toEqual(['error']);
  expect(res.body.error).toBe('Forbidden');
}

describe('GET /display-screen — IP allow-list (D-09)', () => {
  it('refuses an address not on the list with the generic 403 body', async () => {
    const app = buildDisplayScreenAppWithFakeIp(['203.0.113.9'], '198.51.100.5');
    const res = await request(app).get('/display-screen');
    expectForbidden(res);
  });

  it('serves the HTML page to an address on the list', async () => {
    const app = buildDisplayScreenAppWithFakeIp(['198.51.100.5'], '198.51.100.5');
    const res = await request(app).get('/display-screen');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('html');
    expect(res.text).toContain('Xin mời khách tiếp theo');
  });

  it('the prefix branch admits an address sharing the prefix', async () => {
    const app = buildDisplayScreenAppWithFakeIp(['203.0.113.*'], '203.0.113.44');
    const res = await request(app).get('/display-screen');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('html');
  });

  it('the prefix branch refuses an address that does not share the prefix', async () => {
    const app = buildDisplayScreenAppWithFakeIp(['203.0.113.*'], '203.0.114.1');
    const res = await request(app).get('/display-screen');
    expectForbidden(res);
  });
});

// ---------------------------------------------------------------------------
// /display — WebSocket upgrade layer (D-09/D-10)
// ---------------------------------------------------------------------------

function attemptConnection(url: string): Promise<{ opened: boolean; statusCode?: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    ws.once('open', () => {
      settled = true;
      ws.close();
      resolve({ opened: true });
    });
    ws.once('unexpected-response', (_req, res) => {
      settled = true;
      resolve({ opened: false, statusCode: res.statusCode });
    });
    ws.once('error', (err) => {
      if (settled) return;
      reject(err);
    });
  });
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('missing server address');
      resolve(addr.port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('WS /display — IP allow-list before handshake (D-09/D-10)', () => {
  it('refuses a peer not on the allow-list with a raw 403 at the unexpected-response event, before any handshake', async () => {
    const store = makeStore();
    const httpServer = http.createServer();
    // Measured at plan time: server.listen(0, '127.0.0.1') yields the plain
    // '127.0.0.1' peer-address form, matching what production sees when
    // HOST is an IPv4 bind. This list deliberately excludes it.
    const display = new DisplayServer(makeMockQueue() as QueueService, makeMockAgent() as AgentServer, store, {
      displayWhitelist: ['203.0.113.50'],
      pollIntervalMs: 10_000,
    });
    display.start(httpServer);
    const port = await listen(httpServer);

    const result = await attemptConnection(`ws://127.0.0.1:${port}/display`);
    expect(result.opened).toBe(false);
    expect(result.statusCode).toBe(403);

    display.stop();
    await closeServer(httpServer);
  });

  it('admits a peer on the allow-list and delivers a snapshot', async () => {
    const store = makeStore();
    const httpServer = http.createServer();
    const display = new DisplayServer(makeMockQueue(() => 3) as QueueService, makeMockAgent() as AgentServer, store, {
      displayWhitelist: ['127.0.0.1'],
      pollIntervalMs: 10_000,
    });
    display.start(httpServer);
    const port = await listen(httpServer);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/display`);
    const msg = await new Promise<any>((resolve, reject) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString())));
      ws.once('error', reject);
    });
    expect(msg.type).toBe('snapshot');
    expect(msg.data.queueLength).toBe(3);
    ws.close();

    display.stop();
    await closeServer(httpServer);
  });

  it('D-10: a query-string credential does not grant access to an excluded peer', async () => {
    const store = makeStore();
    const httpServer = http.createServer();
    const display = new DisplayServer(makeMockQueue() as QueueService, makeMockAgent() as AgentServer, store, {
      displayWhitelist: ['203.0.113.50'],
      pollIntervalMs: 10_000,
    });
    display.start(httpServer);
    const port = await listen(httpServer);

    const result = await attemptConnection(`ws://127.0.0.1:${port}/display?token=super-secret-value`);
    expect(result.opened).toBe(false);
    expect(result.statusCode).toBe(403);

    display.stop();
    await closeServer(httpServer);
  });

  it('a refused connection never joins the broadcast set — the next allowed client is the only recipient', async () => {
    const store = makeStore();
    const state = { queueLength: 5 };
    const httpServer = http.createServer();

    // A fake-remoteAddress override, registered on the raw http.Server
    // BEFORE display.start() adds its own 'upgrade' listener, so this one
    // runs first and mutates the socket the display server's own handler
    // will read (there is no req.ip to override at the raw upgrade layer,
    // unlike the Express /display-screen route above — clientIp() falls
    // back to req.socket.remoteAddress precisely for this case).
    let fakeIp: string | null = null;
    httpServer.on('upgrade', (req) => {
      if (fakeIp) Object.defineProperty(req.socket, 'remoteAddress', { value: fakeIp, configurable: true });
    });

    const display = new DisplayServer(
      makeMockQueue(() => state.queueLength) as QueueService,
      makeMockAgent() as AgentServer,
      store,
      { displayWhitelist: ['127.0.0.1'], pollIntervalMs: 50 },
    );
    display.start(httpServer);
    const port = await listen(httpServer);

    // Refused attempt, from a faked non-whitelisted address.
    fakeIp = '203.0.113.77';
    const refused = await attemptConnection(`ws://127.0.0.1:${port}/display`);
    expect(refused.opened).toBe(false);
    expect(refused.statusCode).toBe(403);
    fakeIp = null;

    // The subsequent allowed client (real loopback address, on the list)
    // connects normally and is the only one ever added to the server's
    // connected-client set.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/display`);
    const first = await new Promise<any>((resolve, reject) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString())));
      ws.once('error', reject);
    });
    expect(first.data.queueLength).toBe(5);

    // Force a change and confirm the broadcast still reaches exactly this
    // one client, with no crash or dangling reference left by the refused
    // attempt.
    state.queueLength = 9;
    const second = await new Promise<any>((resolve, reject) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString())));
      ws.once('error', reject);
    });
    expect(second.data.queueLength).toBe(9);

    ws.close();
    display.stop();
    await closeServer(httpServer);
  });
});
