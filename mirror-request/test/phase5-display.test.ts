import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import http from 'http';
import express from 'express';
import { LocalStore, DEFAULT_EVENT_CONFIG } from '../src/state/localStore';
import type { QueueService } from '../src/queue/queueService';
import type { AgentServer } from '../src/agent/agentServer';
import { DisplayServer } from '../src/display/displayServer';

// D-16/WINDOWS ledger item 4: every store in this file is opened through the
// constructor(dbPath?) seam, never the getStore() singleton, and closed when
// its describe block is done. Each path is unique so parallel vitest workers
// never share one file.
let storeCounter = 0;
function uniqueStorePath(): string {
  storeCounter += 1;
  return `./data/test-phase5-display-${process.pid}-${Date.now()}-${storeCounter}.sqlite`;
}

function seedQueuedJob(store: LocalStore, id: string, name: string): void {
  store.upsertRegistration({ id, name, email: '', phone: '', mode: 'standard', registered_at: new Date().toISOString() });
  store.enqueueJob({ id, queued_at: Date.now() });
}

function makeMockAgent(): Partial<AgentServer> {
  return { isAgentOnline: () => true };
}

function makeMockQueueService(store: LocalStore): Partial<QueueService> {
  return {
    getQueuePosition: () => undefined,
    getQueueLength: () => store.getQueueLength(),
    getAnnouncement: () => null,
  };
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

function connectAndGetFirstMessage(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('message', (data) => {
      resolve(JSON.parse(data.toString()));
      ws.close();
    });
    ws.once('error', reject);
  });
}

/** Attaches the message listener synchronously, before any I/O can complete,
 * so no message sent immediately on connection can be missed by a listener
 * registered "too late" — the collection window starts at call time. */
function collectMessages(ws: WebSocket, durationMs: number): Promise<any[]> {
  return new Promise((resolve) => {
    const messages: any[] = [];
    const handler = (data: WebSocket.RawData): void => {
      messages.push(JSON.parse(data.toString()));
    };
    ws.on('message', handler);
    setTimeout(() => {
      ws.off('message', handler);
      resolve(messages);
    }, durationMs);
  });
}

describe('Phase 5: Display feed', () => {
  let server: http.Server;
  let app: express.Express;
  let wsUrl: string;
  let mockQueue: Partial<QueueService>;
  let mockAgent: Partial<AgentServer>;
  let display: DisplayServer;
  let store: LocalStore;

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    store = new LocalStore(uniqueStorePath());
    mockQueue = {
      getQueuePosition: () => 1,
      getQueueLength: () => 2,
      getAnnouncement: () => null,
    } as Partial<QueueService>;
    mockAgent = {
      isAgentOnline: () => true,
    } as Partial<AgentServer>;
    display = new DisplayServer(mockQueue as QueueService, mockAgent as AgentServer, store, {
      displayWhitelist: [],
    });
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
    store.close();
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

describe('DisplayServer — injected store (D-16, WINDOWS ledger item 4)', () => {
  it('two instances on two different databases report two different queues', async () => {
    const storeA = new LocalStore(uniqueStorePath());
    const storeB = new LocalStore(uniqueStorePath());
    seedQueuedJob(storeA, 'a-job-1', 'Guest A1');
    seedQueuedJob(storeA, 'a-job-2', 'Guest A2');
    seedQueuedJob(storeB, 'b-job-1', 'Guest B1');
    seedQueuedJob(storeB, 'b-job-2', 'Guest B2');
    seedQueuedJob(storeB, 'b-job-3', 'Guest B3');
    seedQueuedJob(storeB, 'b-job-4', 'Guest B4');
    seedQueuedJob(storeB, 'b-job-5', 'Guest B5');

    const serverA = http.createServer();
    const serverB = http.createServer();
    // getQueueLength() is deliberately pinned to the SAME constant on both
    // mock queues — if this test passed only because the two mocks return
    // different numbers, it would prove nothing about store injection. The
    // dimension under test is upNext, which buildSnapshot() reads DIRECTLY
    // off `this.store`, not via the queue.
    const displayA = new DisplayServer({ getQueuePosition: () => undefined, getQueueLength: () => 0, getAnnouncement: () => null } as Partial<QueueService> as QueueService, makeMockAgent() as AgentServer, storeA, { displayWhitelist: [], pollIntervalMs: 10_000 });
    const displayB = new DisplayServer({ getQueuePosition: () => undefined, getQueueLength: () => 0, getAnnouncement: () => null } as Partial<QueueService> as QueueService, makeMockAgent() as AgentServer, storeB, { displayWhitelist: [], pollIntervalMs: 10_000 });
    displayA.start(serverA);
    displayB.start(serverB);
    const portA = await listen(serverA);
    const portB = await listen(serverB);

    const msgA = await connectAndGetFirstMessage(`ws://127.0.0.1:${portA}/display`);
    const msgB = await connectAndGetFirstMessage(`ws://127.0.0.1:${portB}/display`);

    expect(msgA.data.upNext.length).toBe(2);
    expect(msgB.data.upNext.length).toBe(5);
    expect(msgA.data.upNext.length).not.toBe(msgB.data.upNext.length);

    displayA.stop();
    displayB.stop();
    await closeServer(serverA);
    await closeServer(serverB);
    storeA.close();
    storeB.close();
  });
});

describe('DisplayServer — no PII-capable field can reach the wire (D-15)', () => {
  it('the snapshot key set is exactly the expected eight keys, and the serialised payload names none of the forbidden fields', async () => {
    const store = new LocalStore(uniqueStorePath());
    seedQueuedJob(store, 'pii-job-1', 'Nguyễn Văn A');
    const server = http.createServer();
    const display = new DisplayServer(makeMockQueueService(store) as QueueService, makeMockAgent() as AgentServer, store, {
      displayWhitelist: [],
      pollIntervalMs: 10_000,
    });
    display.start(server);
    const port = await listen(server);

    const msg = await connectAndGetFirstMessage(`ws://127.0.0.1:${port}/display`);

    expect(Object.keys(msg.data).sort()).toEqual([
      'agentOnline',
      'announcementEndsAt',
      'boothState',
      'countdownSeconds',
      // Phase 8 CMS-01: the ninth key. This list is a deliberate tripwire —
      // adding a snapshot field must be a conscious act, not something that
      // rides out to every TV unnoticed. eventConfig is admitted here because
      // it is a purpose-built projection (types.ts EventConfig), not a raw
      // `event` row; the forbidden-substring loop below still guards the
      // operator columns D-15 is about.
      'eventConfig',
      'guestName',
      'queueLength',
      'queuePosition',
      'upNext',
    ]);
    const serialised = JSON.stringify(msg.data);
    for (const forbidden of ['stall_reason', 'ack_error_message', 'retries', 'registration_id', 'email', 'phone', 'qr_token']) {
      expect(serialised).not.toContain(forbidden);
    }
    // eventConfig carries no operator bookkeeping either — created_at and
    // updated_at exist on the `event` row and are dropped by the projection.
    expect(serialised).not.toContain('created_at');
    expect(serialised).not.toContain('updated_at');

    display.stop();
    await closeServer(server);
    store.close();
  });

  it('the broadcast path never reaches a raw-row lookup: a store whose getNextQueuedJob throws still broadcasts successfully', async () => {
    const trapStore = {
      getQueuedGuestSummaries: () => [{ jobId: 'trap-job', name: 'Trap Guest', position: 1 }],
      getBoothState: () => 'IDLE',
      getNextQueuedJob: () => {
        throw new Error('D-15 violation: getNextQueuedJob() must never be called from the broadcast path');
      },
      getJob: () => {
        throw new Error('D-15 violation: getJob() must never be called from the broadcast path');
      },
      // Phase 8: the broadcast path reads the active event through this
      // projection. Supplying it here keeps the trap intact rather than
      // weakening it — the two raw-row getters above still throw, so this
      // case still fails loudly if buildSnapshot() ever reaches for one.
      getActiveEventConfig: () => ({ ...DEFAULT_EVENT_CONFIG }),
      // A raw-row event getter is a trap for the same reason getJob is: the
      // snapshot must never be built from an `event` row directly.
      getEventConfig: () => {
        throw new Error('D-15 violation: getEventConfig() must never be called from the broadcast path');
      },
    } as unknown as LocalStore;

    const server = http.createServer();
    const display = new DisplayServer(
      { getQueuePosition: () => undefined, getQueueLength: () => 1, getAnnouncement: () => null } as Partial<QueueService> as QueueService,
      makeMockAgent() as AgentServer,
      trapStore,
      { displayWhitelist: [], pollIntervalMs: 10_000 },
    );
    display.start(server);
    const port = await listen(server);

    const msg = await connectAndGetFirstMessage(`ws://127.0.0.1:${port}/display`);
    expect(msg.type).toBe('snapshot');
    expect(msg.data.guestName).toBe('Trap Guest');

    display.stop();
    await closeServer(server);
  });
});

describe('DisplayServer — change-driven broadcast (D-13)', () => {
  it('a connected client receives exactly 1 message over 600ms while nothing changes', async () => {
    const store = new LocalStore(uniqueStorePath()); // empty: nothing queued, state frozen
    const server = http.createServer();
    const display = new DisplayServer(makeMockQueueService(store) as QueueService, makeMockAgent() as AgentServer, store, {
      displayWhitelist: [],
      pollIntervalMs: 50,
    });
    display.start(server);
    const port = await listen(server);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/display`);
    // At the shipped 250ms interval, the OLD unconditional broadcast would
    // have sent 1 (on-connect) + floor(600/250) = 3 identical snapshots
    // over this window; at the 50ms interval injected here it would have
    // sent 1 + 12 = 13. The change-driven broadcast sends exactly 1: the
    // on-connect snapshot, and nothing else, because nothing changed.
    const messages = await collectMessages(ws, 600);

    expect(messages.length).toBe(1);

    ws.close();
    display.stop();
    await closeServer(server);
    store.close();
  });

  it('exactly one tick per second while a countdown runs: at least 2 messages over ~2200ms, and no two consecutive payloads are byte-identical', async () => {
    const store = new LocalStore(uniqueStorePath());
    seedQueuedJob(store, 'countdown-job', 'Countdown Guest');
    const endsAt = Date.now() + 3000;
    const mockQueue: Partial<QueueService> = {
      getQueuePosition: () => undefined,
      getQueueLength: () => store.getQueueLength(),
      getAnnouncement: () => ({
        jobId: 'countdown-job',
        endsAt,
        remainingSeconds: Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)),
      }),
    };
    const server = http.createServer();
    const display = new DisplayServer(mockQueue as QueueService, makeMockAgent() as AgentServer, store, {
      displayWhitelist: [],
      pollIntervalMs: 100,
    });
    display.start(server);
    const port = await listen(server);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/display`);
    const messages = await collectMessages(ws, 2200);

    expect(messages.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < messages.length; i++) {
      expect(JSON.stringify(messages[i])).not.toBe(JSON.stringify(messages[i - 1]));
    }

    ws.close();
    display.stop();
    await closeServer(server);
    store.close();
  });
});

describe('DisplayServer — given-name projection for up-next, full name on the hero (D-14)', () => {
  it('the hero keeps the full name; the matching up-next entry is projected to the given name; a single-token name survives unchanged', async () => {
    const store = new LocalStore(uniqueStorePath());
    seedQueuedJob(store, 'hero-job', 'Nguyễn Văn A');
    seedQueuedJob(store, 'single-job', 'Madonna');

    const endsAt = Date.now() + 5000;
    const mockQueue: Partial<QueueService> = {
      getQueuePosition: () => undefined,
      getQueueLength: () => store.getQueueLength(),
      getAnnouncement: () => ({ jobId: 'hero-job', endsAt, remainingSeconds: 5 }),
    };
    const server = http.createServer();
    const display = new DisplayServer(mockQueue as QueueService, makeMockAgent() as AgentServer, store, {
      displayWhitelist: [],
      pollIntervalMs: 10_000,
    });
    display.start(server);
    const port = await listen(server);

    const msg = await connectAndGetFirstMessage(`ws://127.0.0.1:${port}/display`);

    expect(msg.data.guestName).toBe('Nguyễn Văn A');
    const heroEntry = msg.data.upNext.find((g: { jobId: string }) => g.jobId === 'hero-job');
    const singleEntry = msg.data.upNext.find((g: { jobId: string }) => g.jobId === 'single-job');
    expect(heroEntry.name).toBe('A');
    expect(singleEntry.name).toBe('Madonna');

    display.stop();
    await closeServer(server);
    store.close();
  });
});
