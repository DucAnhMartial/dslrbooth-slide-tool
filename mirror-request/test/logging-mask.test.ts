import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID, createHmac } from 'crypto';
import express from 'express';
import request from 'supertest';
import http from 'http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { mask, debugRawPayload, logger, labelLogger } from '../src/logging/logger';
import { createMirrorReceiver } from '../src/ingestion/mirrorReceiver';
import { jsonWithRawBody } from '../src/ingestion/webhookAuth';
import { getStore, LocalStore } from '../src/state/localStore';
import { AgentServer } from '../src/agent/agentServer';
import { QueueService, queueLogger } from '../src/queue/queueService';
import { NotificationService, notifyLogger } from '../src/notifications/notificationService';
import { toGuestStatus } from '../src/status/guestStatus';
import { DisplayServer } from '../src/display/displayServer';
import { clientIp, isWhitelisted } from '../src/security/ipAllowlist';
import { renderDisplayPage } from '../src/display/displayPage';

const VALID_AGENT_TOKEN = 'test-agent-token'; // injected by vitest.config.ts's env block

describe('mask', () => {
  it('replaces an email address with [EMAIL REDACTED] and removes the original', () => {
    const result = mask('contact alice@example.com now');
    expect(result).toContain('[EMAIL REDACTED]');
    expect(result).not.toContain('alice@example.com');
  });

  it('replaces a phone number with asterisks of the same length', () => {
    const result = mask('call 0900000000');
    expect(result).toBe('call **********');
  });

  it('leaves ordinary ingestion log text unchanged (no false positives)', () => {
    const input = 'registration r-1 status=accepted';
    expect(mask(input)).toBe(input);
  });
});

describe('debugRawPayload gating (D-16)', () => {
  let originalNodeEnv: string | undefined;
  let originalDebug: string | undefined;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    originalDebug = process.env.DEBUG;
    debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => logger);
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalDebug === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = originalDebug;
    debugSpy.mockRestore();
  });

  it('emits nothing when NODE_ENV is production, even with DEBUG set', () => {
    process.env.NODE_ENV = 'production';
    process.env.DEBUG = '1';

    debugRawPayload('on-register', '{"email":"a@b.co"}');

    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('emits nothing when DEBUG is unset, whatever NODE_ENV is', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.DEBUG;

    debugRawPayload('on-register', '{"email":"a@b.co"}');

    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('emits exactly one logger.debug call with a string message when NODE_ENV is not production and DEBUG is set', () => {
    process.env.NODE_ENV = 'test';
    process.env.DEBUG = '1';

    debugRawPayload('on-register', '{"email":"a@b.co"}');

    expect(debugSpy).toHaveBeenCalledTimes(1);
    const [message] = debugSpy.mock.calls[0];
    expect(typeof message).toBe('string');
  });
});

describe('/on-register log surface', () => {
  const SECRET = 'test-webhook-secret';

  // A raw randomUUID() occasionally contains a run of 7+ consecutive digits
  // by chance, which PHONE_RE (`\+?\d{7,}`, pre-existing, out of scope to
  // change per task 1's explicit "do not change the existing regexes")
  // would then mask inside an id-carrying log line like "Ingested
  // registration <id> from <ip>" — a false positive on the id itself, not a
  // real PII leak. Breaking up any digit run keeps this test deterministic
  // without touching mask()'s regexes.
  function safeId(): string {
    return randomUUID().replace(/(\d)(?=\d)/g, '$1x');
  }

  function buildApp(): express.Express {
    const app = express();
    app.use(jsonWithRawBody());
    app.use(
      createMirrorReceiver(getStore(), [], {
        hmacSecret: SECRET,
        timestampSkewMs: 300_000,
        dedupWindowMs: 300_000,
      })
    );
    return app;
  }

  function sign(timestamp: string, webhookId: string, bodyString: string): string {
    const canonical = `${timestamp}.${webhookId}.${bodyString}`;
    return createHmac('sha256', SECRET).update(canonical).digest('hex');
  }

  function sendSignedRegistration(bodyString: string): request.Test {
    const app = buildApp();
    const timestamp = String(Date.now());
    const webhookId = randomUUID();
    const signature = sign(timestamp, webhookId, bodyString);
    return request(app)
      .post('/on-register')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Signature', signature)
      .set('X-Webhook-Timestamp', timestamp)
      .set('X-Webhook-Id', webhookId)
      .send(bodyString);
  }

  // email/phone are derived per-call from `id` and a random suffix (never a
  // shared literal like alice@example.com/0900000000) so the three cases
  // below never collide inside plan 01-04's contact-detail dedup fallback —
  // they share the LocalStore singleton and all run inside the same 5-minute
  // dedupWindowMs. Both still match EMAIL_RE/PHONE_RE, which is all mask()
  // masking cares about.
  function payloadWithPii(id: string): string {
    const phone = `09${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`;
    return JSON.stringify({
      id,
      name: 'Alice',
      email: `${id}@example.com`,
      phone,
      mode: 'standard',
    });
  }

  let originalNodeEnv: string | undefined;
  let originalDebug: string | undefined;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    originalDebug = process.env.DEBUG;
    infoSpy = vi.spyOn(logger, 'info');
    warnSpy = vi.spyOn(logger, 'warn');
    debugSpy = vi.spyOn(logger, 'debug');
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalDebug === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = originalDebug;
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    debugSpy.mockRestore();
  });

  function collectMessages(): unknown[] {
    return [...infoSpy.mock.calls, ...warnSpy.mock.calls, ...debugSpy.mock.calls].map(call => call[0]);
  }

  it('produces log messages that are all plain strings and all unchanged by mask()', async () => {
    const id = safeId();
    const bodyString = payloadWithPii(id);

    const res = await sendSignedRegistration(bodyString);

    expect(res.status).toBe(200);
    const messages = collectMessages();
    expect(messages.length).toBeGreaterThan(0);
    for (const msg of messages) {
      expect(typeof msg).toBe('string');
      expect(mask(msg as string)).toBe(msg);
    }
  });

  it('under NODE_ENV=production produces no message containing the payload JSON, yet raw_payload is still stored', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DEBUG = '1'; // D-16: even with DEBUG set, production must stay silent

    const id = safeId();
    const bodyString = payloadWithPii(id);

    const res = await sendSignedRegistration(bodyString);

    expect(res.status).toBe(200);
    const messages = collectMessages();
    for (const msg of messages) {
      expect(typeof msg === 'string' && msg.includes(bodyString)).toBe(false);
    }
    expect(getStore().getRegistration(id)?.raw_payload).toBeTruthy();
  });

  it('under NODE_ENV=test with DEBUG=1 produces exactly one message containing the payload JSON', async () => {
    process.env.NODE_ENV = 'test';
    process.env.DEBUG = '1';

    const id = safeId();
    const bodyString = payloadWithPii(id);

    const res = await sendSignedRegistration(bodyString);

    expect(res.status).toBe(200);
    const messages = collectMessages();
    const matching = messages.filter(msg => typeof msg === 'string' && msg.includes(bodyString));
    expect(matching.length).toBe(1);
    expect(getStore().getRegistration(id)?.raw_payload).toBeTruthy();
  });

  it('raw_payload is populated for a new registration under the default (non-production) test environment', async () => {
    const id = safeId();
    const bodyString = payloadWithPii(id);

    const res = await sendSignedRegistration(bodyString);

    expect(res.status).toBe(200);
    expect(getStore().getRegistration(id)?.raw_payload).toBe(bodyString);
  });
});

describe('Connection id survives masking (WINDOWS ledger item 5)', () => {
  // Real AgentServer instances over a real loopback http.Server + WS client,
  // matching test/agent-replacement.test.ts's own pattern — the id is minted
  // deep inside AgentServer's private 'connection' handler, so the only way
  // to observe a real id without reaching into private state is to read it
  // back off the log messages AgentServer itself produces.
  let httpServer: http.Server | undefined;
  let agentServer: AgentServer | undefined;
  let port: number;
  let openSockets: WebSocket[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
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

  async function startServer(): Promise<AgentServer> {
    httpServer = http.createServer();
    const server = new AgentServer();
    agentServer = server;
    server.start(httpServer);
    await new Promise<void>((resolve) => httpServer?.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    port = address.port;
    return server;
  }

  function connect(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/agent`, {
        headers: { authorization: `Bearer ${VALID_AGENT_TOKEN}` },
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

  function extractConnectedId(messages: unknown[]): string {
    const match = messages
      .map((m) => String(m))
      .map((m) => m.match(/^Agent connected: (.+)$/))
      .find((m): m is RegExpMatchArray => m !== null);
    if (!match) throw new Error('No "Agent connected" message captured');
    return match[1];
  }

  it('the exact log-line templates agentServer.ts builds from a connection id survive masking unchanged', async () => {
    await startServer();
    const infoSpy = vi.spyOn(logger, 'info');
    const warnSpy = vi.spyOn(logger, 'warn');

    const clientA = await connect();
    const clientB = await connect(); // displaces clientA -> "Agent WS replaced: ... displaced by ..."
    await waitClose(clientA);

    const connectedMsgs = infoSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith('Agent connected:'));
    const replacedMsgs = warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith('Agent WS replaced:'));

    expect(connectedMsgs.length).toBeGreaterThan(0);
    expect(replacedMsgs.length).toBe(1);
    for (const msg of [...connectedMsgs, ...replacedMsgs]) {
      expect(mask(msg)).toBe(msg);
    }

    clientB.terminate();
  });

  it('a generated connection id contains no run of two adjacent digits', async () => {
    await startServer();
    const infoSpy = vi.spyOn(logger, 'info');

    const client = await connect();
    const id = extractConnectedId(infoSpy.mock.calls.map((c) => c[0]));

    // Strictly stronger than "no run of seven": if no two digits are ever
    // adjacent, PHONE_RE's `\+?\d{7,}` threshold can never be reached no
    // matter how large the timestamp or the sequence number grows.
    expect(id).not.toMatch(/\d\d/);

    client.terminate();
  });

  it('two ids generated in the same process are different from each other', async () => {
    await startServer();
    const infoSpy = vi.spyOn(logger, 'info');

    const clientA = await connect();
    const clientB = await connect();
    await waitClose(clientA);

    const connectedIds = infoSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.startsWith('Agent connected:'))
      .map((m) => m.replace('Agent connected: ', ''));

    expect(connectedIds.length).toBeGreaterThanOrEqual(2);
    expect(connectedIds[0]).not.toBe(connectedIds[1]);

    clientB.terminate();
  });

  it('two ids generated in two different simulated process lifetimes are different from each other', async () => {
    // Simulates a restart: a fresh AgentServer instance has connSeq reset to
    // its initial value (0), the same as a real process restart would. This
    // is the second half of ledger item 5 — ids used to repeat across
    // restarts once the timestamp was masked away, because the sequence
    // number alone ("agent-*-1") is identical on every first connection.
    const serverA = await startServer();
    const infoSpyA = vi.spyOn(logger, 'info');
    const clientA1 = await connect();
    const idA = extractConnectedId(infoSpyA.mock.calls.map((c) => c[0]));
    clientA1.terminate();
    infoSpyA.mockRestore();
    serverA.stop();
    if (httpServer?.listening) {
      await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
    }

    const serverB = await startServer();
    const infoSpyB = vi.spyOn(logger, 'info');
    const clientB1 = await connect();
    const idB = extractConnectedId(infoSpyB.mock.calls.map((c) => c[0]));

    expect(idA).not.toBe(idB);

    clientB1.terminate();
  });

  it('control case: an unreformatted id built from a 13-digit timestamp is NOT left unchanged by mask() — proving the fix is load-bearing', () => {
    // Built locally, never via production code: this is what agentServer.ts
    // used to produce before the digit-run-breaking transform was applied.
    const unreformatted = `agent-${Date.now()}-1`;
    expect(mask(unreformatted)).not.toBe(unreformatted);
  });
});

describe('Standing regression: every non-ingestion log line survives masking unchanged (AUTH-03, D-17)', () => {
  // D-16/WINDOWS ledger item 4: every store here is opened through the
  // constructor(dbPath?) seam, never the getStore() singleton, and closed in
  // afterEach. The path is unique per test run so parallel vitest workers
  // never share one file (same convention as test/display-access-control.test.ts).
  let storeCounter = 0;
  function uniqueStorePath(): string {
    storeCounter += 1;
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-authregress-')), `t${storeCounter}.sqlite`);
  }

  const EMAIL = 'auth03-regression@example.com';
  const PHONE = '0912345678'; // 10 digits — genuinely matches PHONE_RE's \d{7,}

  // A plain Date.now()-based job id would itself embed a 13-digit run and
  // get masked by PHONE_RE — the exact same test-fixture false positive
  // documented at this file's safeId() helper above (line ~87), not a
  // production defect. Real job ids are backend-minted UUIDs (F-04), which
  // only occasionally collide with PHONE_RE by chance; breaking up digit
  // runs here keeps this fixture deterministic without touching mask().
  function safeJobId(label: string): string {
    return `job-flow-${label}-${randomUUID().replace(/(\d)(?=\d)/g, '$1x')}`;
  }

  function registerAndEnqueue(s: LocalStore, id: string): void {
    s.upsertRegistration({
      id,
      name: 'Nguyễn Văn A',
      email: EMAIL,
      phone: PHONE,
      mode: 'print',
      registered_at: new Date().toISOString(),
    });
    // LocalStore.enqueueJob() ties registration_id to the job's own id — the
    // storage layer's "Queued job X at position Y of Z" line (localStore.ts,
    // base logger) fires here.
    s.enqueueJob({ id, queued_at: Date.now() });
  }

  // Spies on every level of a given logger-like object (base logger and the
  // two labelled child loggers are each distinct winston Logger instances —
  // spying on the base logger alone would silently miss anything logged
  // through logger.child(), which is exactly the trap this test exists to
  // catch: index.ts and localStore.ts log through the base logger, so their
  // messages alone would satisfy a bare length>0 check even if the queue/
  // notify child-logger surfaces were silently missed).
  function spyAllLevels(target: { info: unknown; warn: unknown; error: unknown; debug: unknown }) {
    return {
      info: vi.spyOn(target as never, 'info'),
      warn: vi.spyOn(target as never, 'warn'),
      error: vi.spyOn(target as never, 'error'),
      debug: vi.spyOn(target as never, 'debug'),
    };
  }
  function collectFrom(spies: ReturnType<typeof spyAllLevels>): unknown[] {
    return [...spies.info.mock.calls, ...spies.warn.mock.calls, ...spies.error.mock.calls, ...spies.debug.mock.calls].map(
      (call) => call[0],
    );
  }

  it('every message collected across a realistic queue/notify/display/status flow is a plain string that mask() leaves unchanged, and none carries the fixture email or phone', async () => {
    const store = new LocalStore(uniqueStorePath());
    // Mirrors index.ts's own `const log = labelLogger('server')` — index.ts
    // itself cannot be imported (it runs a real server as a side effect of
    // import), so its /display-screen route is reproduced verbatim below
    // using the same exported clientIp/isWhitelisted/renderDisplayPage
    // functions plus this identically-constructed child logger, the same
    // technique test/display-access-control.test.ts already established for
    // the access-control half of this same route.
    const serverLogger = labelLogger('server');

    const baseSpies = spyAllLevels(logger);
    const queueSpies = spyAllLevels(queueLogger);
    const notifySpies = spyAllLevels(notifyLogger);
    const serverSpies = spyAllLevels(serverLogger);

    try {
      // --- Queue surface: enqueue -> dispatch -> ack -> complete ------------
      const CONFIG = { SESSION_TIMEOUT_MS: 1000, NEXT_GUEST_COUNTDOWN_MS: 5000, SESSION_MAX_RETRIES: 1 };
      const qs = new QueueService(store, CONFIG);
      qs.bindIsAgentOnline(() => true);
      qs.bindSendCommand(() => {});

      vi.useFakeTimers();
      try {
        qs.start();

        const job1 = safeJobId('1');
        registerAndEnqueue(store, job1);
        vi.advanceTimersByTime(250); // periodic tick picks up job1 -> announce
        vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS); // -> dispatch, "Dispatched job ... -> Agent"
        qs.onAgentAck(job1, true); // acknowledge
        qs.sessionEnded(); // complete -> booth IDLE again, "Completed job ... after session_end"

        // --- Queue surface, second half: stall to exhaustion -----------------
        // SESSION_MAX_RETRIES=1: the first stall requeues (retry line), the
        // second exceeds the budget and fails the job (failure line) — both
        // are the "retry and failure lines" the plan's <behavior> asks for.
        const job2 = safeJobId('2');
        registerAndEnqueue(store, job2);
        vi.advanceTimersByTime(250); // tick picks up job2 -> announce
        vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS); // -> dispatch, busyTimer armed
        vi.advanceTimersByTime(CONFIG.SESSION_TIMEOUT_MS); // stall #1 -> requeue (retries=1), immediate re-announce
        vi.advanceTimersByTime(CONFIG.NEXT_GUEST_COUNTDOWN_MS); // -> re-dispatch, busyTimer armed
        vi.advanceTimersByTime(CONFIG.SESSION_TIMEOUT_MS); // stall #2 -> retries=2 > 1 -> failJob, failure line

        qs.stop();
      } finally {
        vi.useRealTimers();
      }

      // --- Notification surface: enqueue + immediate exhaustion (maxRetries=0) ---
      const notifyReceiver = http.createServer((req, res) => {
        req.resume();
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unavailable' }));
      });
      await new Promise<void>((resolve) => notifyReceiver.listen(0, '127.0.0.1', () => resolve()));
      const notifyAddress = notifyReceiver.address();
      if (!notifyAddress || typeof notifyAddress === 'string') throw new Error('missing server address');
      const webhookUrl = `http://127.0.0.1:${notifyAddress.port}/webhook`;

      const notifyJob = safeJobId('3');
      registerAndEnqueue(store, notifyJob);
      const notificationService = new NotificationService(0, store, webhookUrl, { fetchTimeoutMs: 2000 });
      await notificationService.sendPhotoLink(notifyJob, 'https://cdn.example/photo.jpg');
      await notificationService.sweep(); // maxRetries=0 -> terminal on first attempt -> exhaustion error line

      await new Promise<void>((resolve) => notifyReceiver.close(() => resolve()));

      // --- Phase 5 surface 1: blocked /display-screen (peer address logged) ---
      const displayScreenApp = express();
      displayScreenApp.get(
        '/display-screen',
        (req, res, next) => {
          const ip = clientIp(req);
          if (!isWhitelisted(ip, ['203.0.113.9'])) {
            serverLogger.warn(`Blocked /display-screen from non-whitelisted IP: ${ip}`);
            return res.status(403).json({ error: 'Forbidden' });
          }
          next();
        },
        (_req, res) => res.type('html').send(renderDisplayPage()),
      );
      const displayScreenRes = await request(displayScreenApp).get('/display-screen');
      expect(displayScreenRes.status).toBe(403);

      // --- Phase 5 surface 2: blocked WS /display upgrade (peer address logged) ---
      const mockQueue: Pick<QueueService, 'getQueuePosition' | 'getQueueLength' | 'getAnnouncement'> = {
        getQueuePosition: () => undefined,
        getQueueLength: () => 0,
        getAnnouncement: () => null,
      };
      const mockAgent: Pick<AgentServer, 'isAgentOnline'> = { isAgentOnline: () => true };
      const displayHttpServer = http.createServer();
      const display = new DisplayServer(mockQueue as QueueService, mockAgent as AgentServer, store, {
        displayWhitelist: ['203.0.113.50'],
        pollIntervalMs: 10_000,
      });
      display.start(displayHttpServer);
      await new Promise<void>((resolve) => displayHttpServer.listen(0, '127.0.0.1', () => resolve()));
      const displayAddress = displayHttpServer.address();
      if (!displayAddress || typeof displayAddress === 'string') throw new Error('missing server address');

      const wsResult = await new Promise<{ opened: boolean; statusCode?: number }>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${displayAddress.port}/display`);
        ws.once('unexpected-response', (_req, res) => resolve({ opened: false, statusCode: res.statusCode }));
        ws.once('open', () => resolve({ opened: true }));
        ws.once('error', reject);
      });
      expect(wsResult.opened).toBe(false);
      expect(wsResult.statusCode).toBe(403);

      display.stop();
      await new Promise<void>((resolve) => displayHttpServer.close(() => resolve()));

      // --- Phase 5 surface 3: unmapped guest status (guestStatus.ts, base logger) ---
      const unmapped = toGuestStatus({ jobStatus: 'weird_unmapped_status', announced: false, photoDelivery: 'pending' });
      expect(unmapped).toBe('see_staff');

      // --- Assertions -------------------------------------------------------
      const messages = [
        ...collectFrom(baseSpies),
        ...collectFrom(queueSpies),
        ...collectFrom(notifySpies),
        ...collectFrom(serverSpies),
      ];

      // A future refactor that silences a whole surface must not make this
      // test vacuously pass.
      expect(messages.length).toBeGreaterThan(0);

      // A bare length>0 check would pass even if the labelled child-logger
      // surfaces (queue, notify) were never reached at all, since index.ts/
      // localStore.ts/displayServer.ts/guestStatus.ts all log through the
      // base logger alone. Assert each labelled surface actually produced a
      // message, so a spy that captures nothing fails loudly.
      const stringMessages = messages.filter((m): m is string => typeof m === 'string');
      expect(stringMessages.some((m) => /requeued|Dispatched/.test(m))).toBe(true); // queue
      expect(stringMessages.some((m) => /Notification/.test(m))).toBe(true); // notify

      for (const msg of messages) {
        expect(typeof msg).toBe('string'); // an object argument would bypass masking entirely
        expect(mask(msg as string)).toBe(msg);
      }
      for (const msg of stringMessages) {
        expect(msg).not.toContain(EMAIL);
        expect(msg).not.toContain(PHONE);
      }
    } finally {
      baseSpies.info.mockRestore();
      baseSpies.warn.mockRestore();
      baseSpies.error.mockRestore();
      baseSpies.debug.mockRestore();
      queueSpies.info.mockRestore();
      queueSpies.warn.mockRestore();
      queueSpies.error.mockRestore();
      queueSpies.debug.mockRestore();
      notifySpies.info.mockRestore();
      notifySpies.warn.mockRestore();
      notifySpies.error.mockRestore();
      notifySpies.debug.mockRestore();
      serverSpies.info.mockRestore();
      serverSpies.warn.mockRestore();
      serverSpies.error.mockRestore();
      serverSpies.debug.mockRestore();
      store.close();
    }
  });
});
