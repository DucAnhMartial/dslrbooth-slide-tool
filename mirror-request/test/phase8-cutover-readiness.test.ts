import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';

// ---------------------------------------------------------------------------
// Every process-scoped path and allow-list this probe needs, set BEFORE the
// module graph below is imported.
//
// `src/state/localStore.ts` calls `getConfig()` at module scope (line 9) and
// `getConfig()` caches, so an override applied in `beforeAll` would arrive
// after the value it means to change has already been read. `vi.hoisted` runs
// above the import block, which is the only place early enough.
//
// The store path uses the repository's `data/test-` convention on purpose:
// `test/global-teardown.ts` deletes exactly that prefix, so this probe leaves
// nothing behind even if it fails half-way and never reaches `afterAll`.
//
// The two allow-lists are set NON-EMPTY deliberately. `isWhitelisted()` treats
// an empty list as "allow everything" (the documented development escape
// hatch), and vitest.config.ts ships `CMS_IP_WHITELIST=''`. Probing the gates
// under that default would assert nothing at all.
// ---------------------------------------------------------------------------
const PATHS = vi.hoisted(() => {
  const stamp = `${process.pid}-${Date.now()}`;
  const storePath = `./data/test-phase8-cutover-${stamp}.sqlite`;
  const uploadDir = `./data/test-phase8-cutover-uploads-${stamp}`;
  process.env.LOCAL_STORE_PATH = storePath;
  process.env.CMS_UPLOAD_DIR = uploadDir;
  process.env.CMS_IP_WHITELIST = '127.0.0.1,::1,::ffff:127.0.0.1';
  process.env.DISPLAY_IP_WHITELIST = '127.0.0.1,::1,::ffff:127.0.0.1';
  return { storePath, uploadDir };
});

import { createApp } from '../src/app';
import { getConfig } from '../src/config';
import { getStore, type LocalStore } from '../src/state/localStore';
import { AgentServer } from '../src/agent/agentServer';
import { DisplayServer } from '../src/display/displayServer';
import { createQueueService, type QueueService } from '../src/queue/queueService';
import { createNotificationService } from '../src/notifications/notificationService';
import { SAFE_AGENT_CONFIG_FIELDS } from '../src/agent/agentConfigContract';
import { STORED_ASSET_URL_RE } from '../src/cms/uploadHandler';
import type { DisplaySnapshot, EnvConfig } from '../src/types';

// ---------------------------------------------------------------------------
// Plan 08-06 Task 1 — the cutover readiness probe.
//
// This file exists to answer one question before a human is asked to walk to
// each TV, retype a URL, and turn `web-slide` off: does the replacement path
// actually work, end to end, in the service as it is shipped?
//
// That last clause is the whole point and the reason this file looks different
// from every other suite in this repository. Phase 8's other suites each build
// their own express app — `buildCmsApp()` in cms-event-tracer.test.ts and its
// siblings — in the same mount order `src/app.ts` uses. That proves the
// modules work. It cannot prove the SERVICE works, because a mistake made in
// the real wiring (the CMS IP gate mounted after the router, the scoped upload
// parser mounted below the global one, the display route missing its
// allow-list) would leave every one of those suites green.
//
// So this probe imports `createApp()` — the function `src/index.ts` calls —
// and declares no route of its own. Grep this file for `app.get`, `app.use` or
// `Router`: there are none. Every request below travels the mounts production
// travels.
//
// It is a WALK, not a set of independent cases: the cases run in file order
// and share one service, one database and one already-connected screen,
// because the sequence is the claim. The idle screen has to be correct BEFORE
// an event exists; the screen has to be connected BEFORE the event is
// activated, or "no reload needed" is not what was measured.
//
// What this probe does NOT prove, stated here rather than left to be assumed:
//   - that a browser executes the page's client-side script (there is no jsdom
//     in this project and adding one would break the zero-new-packages rule);
//   - that the screen is legible on a real TV at real viewing distance (UI-01,
//     the human gate this plan ends with);
//   - that `index.ts`'s listen callback starts the poller, the sweeper and the
//     queue tick — this probe starts the HTTP, WS and Agent surfaces the way
//     that callback does, and deliberately leaves the timers stopped so the
//     walk below is the only thing moving.
// ---------------------------------------------------------------------------

/** vitest.config.ts's fixture account. The plaintext is published there. */
const CMS_USERNAME = 'test-operator';
const CMS_PASSWORD = 'test-cms-password';
const AGENT_TOKEN = 'test-agent-token';

/** A real 1x1 PNG. The first eight bytes are what `sniffImageKind()` reads. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const EVENT_NAME = 'Tiệc cưới Minh & Ánh';
const GUEST_NAME = 'Nguyễn Thị Hồng Ánh';
const JOB_ID = 'cutover-probe-job-1';
/** From test/helpers/realSessionUploads.ts — a real captured print URL. */
const PRINT_URL = 'https://fotoshare.co/i/4kmtdhm';

// ---------------------------------------------------------------------------
// The D-01 boundary assertion's fixtures.
//
// These two strings are the pre-Phase-8 table definitions, taken verbatim from
// the commit immediately before this phase's first commit:
//
//     git show 697380b:src/state/localStore.ts
//
// (`697380b` is `aa51fcf^` — `aa51fcf` is 08-01's first commit.) SQLite stores
// a CREATE statement in `sqlite_master.sql` exactly as it was written, minus
// the `IF NOT EXISTS` clause, whitespace and all — which is what makes a
// character-for-character comparison meaningful here rather than merely
// suggestive. A reformatted definition is still a changed definition and this
// assertion will say so.
//
// Phase 8 is additive to Phases 1-7 by decision (D-01). The queue and the
// booth state machine are the two structures that claim is really about, and
// this is the measurement of it.
// ---------------------------------------------------------------------------
const PRE_PHASE_8_QUEUE_JOB_SQL = `CREATE TABLE queue_job (
        id TEXT PRIMARY KEY,
        registration_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        queued_at INTEGER NOT NULL,
        dispatched_at INTEGER,
        acknowledged_at INTEGER,
        session_started_at INTEGER,
        session_ended_at INTEGER,
        completed_at INTEGER,
        ack_error_message TEXT,
        stall_reason TEXT,
        retries INTEGER NOT NULL DEFAULT 0
      )`;

// `current_job_id` is NOT a Phase 8 column. It is added by an `ALTER TABLE` in
// `migrate()` that predates this phase — the same four ALTERs exist verbatim at
// 697380b and at HEAD (`git show 697380b:src/state/localStore.ts | grep 'ALTER
// TABLE'`), and this one is Phase 7's D-06 server-held attribution column.
//
// It is spelled out here because the first draft of this assertion pinned only
// the CREATE text and went red, which is the useful half of the story: a
// runtime schema is the CREATE plus every migration that has ever run, and
// pinning the source alone would have failed on a Phase 7 column while claiming
// to be measuring Phase 8. What is asserted is the whole runtime definition,
// which is the thing that would actually change if this phase had touched the
// booth state machine.
//
// `attempt_open`/`attempt_no` are NOT Phase 8 columns either, and are not
// Phase 7's — they are Phase 11's own D11-01 attempt spine, added by two more
// `ALTER TABLE ... ADD COLUMN` statements in the same `migrate()` method
// (`src/state/localStore.ts`, measured directly against a fresh database this
// session: `SELECT sql FROM sqlite_master WHERE name='booth_state'`). D-01's
// claim was always scoped to Phase 8 specifically ("Phase 8 is additive to
// Phases 1-7"), not to every phase for all time — a later, DELIBERATE phase
// legitimately extending booth_state does not retroactively make Phase 8's own
// claim false. What would make it false is an UNEXPECTED column appearing here
// that this file does not already know about and name, which is exactly what
// the character-for-character comparison below still catches.
const CURRENT_BOOTH_STATE_SQL = `CREATE TABLE booth_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state TEXT NOT NULL DEFAULT 'IDLE',
        updated_at TEXT NOT NULL DEFAULT 'now'
      , current_job_id TEXT, attempt_open INTEGER NOT NULL DEFAULT 0, attempt_no INTEGER NOT NULL DEFAULT 0)`;

// --- the one service under test -------------------------------------------

let config: EnvConfig;
let store: LocalStore;
let queue: QueueService;
let agentServer: AgentServer;
let displayServer: DisplayServer;
let server: http.Server;
let baseUrl: string;

/** Every snapshot the room screen has received, in order. */
const snapshots: DisplaySnapshot[] = [];
let screen: WebSocket;
let agentSocket: WebSocket | undefined;

/** State the walk carries forward between cases. */
let sessionCookie = '';
let eventId = '';
let logoUrl = '';

function readStoreSql(table: string): string {
  const db = new Database(path.resolve(PATHS.storePath), { readonly: true });
  try {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { sql: string } | undefined;
    return row?.sql ?? '';
  } finally {
    db.close();
  }
}

function countRows(table: string): number {
  const db = new Database(path.resolve(PATHS.storePath), { readonly: true });
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

/** Resolves on the first snapshot matching `predicate`, or rejects. */
function awaitSnapshot(
  predicate: (snapshot: DisplaySnapshot) => boolean,
  timeoutMs = 5000,
): Promise<DisplaySnapshot> {
  const already = snapshots.find(predicate);
  if (already) return Promise.resolve(already);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      screen.off('message', onMessage);
      reject(new Error('timed out waiting for a matching /display snapshot'));
    }, timeoutMs);
    function onMessage(raw: unknown): void {
      const parsed = JSON.parse(String(raw)) as { type: string; data: DisplaySnapshot };
      if (parsed.type !== 'snapshot' || !predicate(parsed.data)) return;
      clearTimeout(timer);
      screen.off('message', onMessage);
      resolve(parsed.data);
    }
    screen.on('message', onMessage);
  });
}

beforeAll(async () => {
  fs.mkdirSync(path.resolve(PATHS.uploadDir), { recursive: true });

  // Constructed exactly as src/index.ts constructs it, through the same
  // factories, in the same order — `createQueueService` reaches for the
  // `getStore()` singleton internally, which is why the store path had to be
  // set before the imports rather than injected here.
  config = getConfig();
  store = getStore();
  agentServer = new AgentServer();
  queue = createQueueService(agentServer, createNotificationService());
  displayServer = new DisplayServer(queue, agentServer);

  server = http.createServer(createApp({ config, store, queue, agentServer }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no server address');
  baseUrl = `http://127.0.0.1:${address.port}`;

  // index.ts starts both of these inside its listen callback.
  agentServer.start(server);
  displayServer.start(server);

  // The TV opens its URL now — before any event exists and long before one is
  // activated. D-12: screens carry no identity and are never re-pointed.
  screen = new WebSocket(`${baseUrl.replace('http', 'ws')}/display`);
  screen.on('message', (raw) => {
    const parsed = JSON.parse(String(raw)) as { type: string; data: DisplaySnapshot };
    if (parsed.type === 'snapshot') snapshots.push(parsed.data);
  });
  await new Promise<void>((resolve, reject) => {
    screen.once('open', () => resolve());
    screen.once('error', reject);
  });
});

afterAll(async () => {
  try { screen?.close(); } catch { /* already closed */ }
  try { agentSocket?.terminate(); } catch { /* already closed */ }
  displayServer?.stop();
  agentServer?.stop();
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  try { store?.close(); } catch { /* already closed */ }
  try { fs.rmSync(path.resolve(PATHS.uploadDir), { recursive: true, force: true }); } catch { /* best effort */ }
});

// ---------------------------------------------------------------------------

describe('Phase 8 cutover readiness — the replacement path, end to end', () => {
  it('serves the room screen on an empty database, with the idle heading, to a whitelisted address (UI-01)', async () => {
    // Empty in the sense that matters: no event to theme the screen and no
    // guest to put on it. If the idle screen needed either, this is where the
    // cutover would break — on the first TV, before a single guest arrives.
    expect(store.listEvents()).toHaveLength(0);
    expect(countRows('event')).toBe(0);
    expect(countRows('registration')).toBe(0);
    expect(countRows('queue_job')).toBe(0);

    const res = await request(baseUrl).get('/display-screen');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('Sẵn sàng chụp ảnh cùng bạn');
    expect(res.text).toContain('Quét mã QR bên dưới để đăng ký');

    // The already-connected screen agrees, over the feed rather than the page.
    const snapshot = await awaitSnapshot(() => true);
    expect(snapshot.eventConfig).toBeTruthy();
    expect(snapshot.eventConfig.id).toBeNull();
    expect(snapshot.eventConfig.fontChoice).toBe('system-ui');
    expect(snapshot.justCaptured).toBeNull();
    expect(snapshot.photos).toEqual([]);
  });

  it('refuses the room screen from a non-whitelisted address (D-09)', async () => {
    // The SAME loopback request against the SAME shipped wiring, differing
    // only in configuration — so a pass here cannot come from the request
    // being different in some other way.
    const walled = http.createServer(
      createApp({
        config: { ...config, DISPLAY_IP_WHITELIST: ['10.99.99.99'], CMS_IP_WHITELIST: ['10.99.99.99'] },
        store,
        queue,
        agentServer,
      }),
    );
    try {
      await new Promise<void>((resolve) => walled.listen(0, '127.0.0.1', resolve));
      const addr = walled.address();
      if (!addr || typeof addr === 'string') throw new Error('no address');
      const url = `http://127.0.0.1:${addr.port}`;

      const screenRes = await request(url).get('/display-screen');
      expect(screenRes.status).toBe(403);
      expect(screenRes.body).toEqual({ error: 'Forbidden' });

      // Layer one of D-13, on the same instance: refused before any session
      // logic runs, and with no login form in the body to hint otherwise.
      const cmsRes = await request(url).get('/cms/login');
      expect(cmsRes.status).toBe(403);
      expect(cmsRes.body).toEqual({ error: 'Forbidden' });
      expect(cmsRes.text).not.toContain('<form');
    } finally {
      await new Promise<void>((resolve) => walled.close(() => resolve()));
    }
  });

  it('refuses the CMS to a whitelisted address with no session, then admits the configured operator (D-13, D-14)', async () => {
    // Layer two, proved independently of layer one: this address passed the IP
    // gate in the previous case's terms and is still refused.
    const noSession = await request(baseUrl).get('/cms/');
    expect(noSession.status).toBe(401);

    const bad = await request(baseUrl)
      .post('/cms/login')
      .type('form')
      .send({ username: CMS_USERNAME, password: 'not-the-password' });
    expect(bad.status).toBe(401);
    expect(bad.headers['set-cookie']).toBeUndefined();

    const ok = await request(baseUrl)
      .post('/cms/login')
      .type('form')
      .send({ username: CMS_USERNAME, password: CMS_PASSWORD });
    expect(ok.status).toBeLessThan(400);

    const raw = ok.headers['set-cookie'];
    const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
    expect(cookies).toHaveLength(1);
    // RESEARCH Pitfall 3, asserted where an operator would look for it: no
    // `Secure`, because nothing in this deployment terminates TLS.
    expect(cookies[0]).toMatch(/HttpOnly/);
    expect(cookies[0]).not.toMatch(/Secure/);
    sessionCookie = cookies[0].split(';')[0];

    const dashboard = await request(baseUrl).get('/cms/').set('Cookie', sessionCookie);
    expect(dashboard.status).toBe(200);
  });

  it('creates an event, uploads a logo, attaches it and activates it — and the connected screen just changes (CMS-01, CMS-02, D-12)', async () => {
    const created = await request(baseUrl)
      .post('/cms/api/events')
      .set('Cookie', sessionCookie)
      .send({ name: EVENT_NAME });
    expect(created.status).toBe(201);
    eventId = created.body.id as string;
    expect(eventId).toBeTruthy();

    const uploaded = await request(baseUrl)
      .post('/cms/api/assets')
      .set('Cookie', sessionCookie)
      .send({ data: PNG_BASE64, filename: '../../etc/passwd', type: 'image/svg+xml' });
    expect(uploaded.status).toBe(201);
    logoUrl = uploaded.body.url as string;
    // The server minted this name; nothing the request asked for survives.
    expect(logoUrl).toMatch(STORED_ASSET_URL_RE);
    expect(logoUrl).not.toContain('passwd');
    expect(logoUrl.endsWith('.png')).toBe(true);

    const saved = await request(baseUrl)
      .post(`/cms/api/events/${eventId}`)
      .set('Cookie', sessionCookie)
      .send({ logo_url: logoUrl });
    expect(saved.status).toBe(200);

    const activated = await request(baseUrl)
      .post(`/cms/api/events/${eventId}/activate`)
      .set('Cookie', sessionCookie)
      .send({});
    expect(activated.status).toBe(200);

    // The screen was connected before any of the above and was never told to
    // reload. This is the assertion the whole cutover rests on.
    const snapshot = await awaitSnapshot((snap) => snap.eventConfig.name === EVENT_NAME);
    expect(snapshot.eventConfig.id).toBe(eventId);
    expect(snapshot.eventConfig.logoUrl).toBe(logoUrl);
  });

  it('serves the uploaded logo with the fixed image content type it sniffed (CMS-05)', async () => {
    const res = await request(baseUrl).get(logoUrl);

    expect(res.status).toBe(200);
    // The type comes from the bytes, never from the request's declared
    // `image/svg+xml` and never from the extension.
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.body).toEqual(Buffer.from(PNG_BASE64, 'base64'));
  });

  it('turns a real print upload into durable history and a hero moment on the wall (CMS-03, D-09, D-10)', async () => {
    // Driven the way production drives it: over the authenticated Agent
    // socket, as a `file_upload` event, against a job with an open
    // pending-print slot. Calling the store directly would prove a row shape
    // rather than a path.
    store.upsertRegistration({
      id: JOB_ID,
      name: GUEST_NAME,
      email: '',
      phone: '',
      mode: 'standard',
      registered_at: new Date().toISOString(),
    });
    store.enqueueJob({ id: JOB_ID, queued_at: Date.now() });
    store.openPendingPrint({
      jobId: JOB_ID,
      compositePath: 'C:\\dslrBooth\\Test_event\\Prints\\20260812_131547_837_1x.jpg',
      openedAt: Date.now() - 60_000,
      expiresAt: Date.now() + 60_000,
    });
    // Legitimate setup, not the thing under test: booth_state's single row is
    // created lazily by its own writers (bootstrap()'s CREATE TABLE seeds no
    // row), and this probe deliberately never calls queue.start() — the only
    // path that would otherwise have seeded it via beginAnnouncement()'s
    // setBoothState('ANNOUNCING'), well before any real Agent event could
    // arrive. A production boot always calls queue.start() first, so this
    // gap is a property of this probe's own "leave the timers stopped" design
    // (see this file's header), not of the production boot sequence.
    store.setBoothIdle();

    agentSocket = new WebSocket(`${baseUrl.replace('http', 'ws')}/agent`, {
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
    });
    await new Promise<void>((resolve, reject) => {
      agentSocket?.once('open', () => resolve());
      agentSocket?.once('error', reject);
    });

    // D11-01/D11-04/D11-05 (phase 11): a `file_upload` alone only WRITES the
    // URL into the pending-print slot; delivery (and the display's
    // `justCaptured` hero moment) now waits for one of the finalize gate's
    // three doors. `session_start` opens the attempt exactly as a real
    // dslrBooth session would, and the approving `printing` — whose composite
    // stem matches the slot `openPendingPrint()` opened above — is what
    // finalizes it, all driven over the same authenticated Agent socket
    // production uses, per this file's own "no direct store manipulation for
    // the thing under test" discipline.
    agentSocket.send(
      JSON.stringify({ type: 'event', event: 'session_start', jobId: JOB_ID, payload: {} }),
    );
    agentSocket.send(
      JSON.stringify({
        type: 'event',
        event: 'file_upload',
        jobId: JOB_ID,
        payload: { param2: PRINT_URL, param3: 'print', param4: 'Test event' },
      }),
    );
    agentSocket.send(
      JSON.stringify({
        type: 'event',
        event: 'printing',
        jobId: JOB_ID,
        payload: { param1: 'C:\\dslrBooth\\Test_event\\Prints\\20260812_131547_837_1x.jpg' },
      }),
    );

    const snapshot = await awaitSnapshot((snap) => snap.justCaptured !== null);
    expect(snapshot.justCaptured).toEqual({ photoUrl: PRINT_URL, name: GUEST_NAME });
    expect(snapshot.photos).toContainEqual({ photoUrl: PRINT_URL, name: GUEST_NAME });

    // Durable, not merely broadcast: the row is on disk, attributed to the
    // active event, readable through a second handle the service does not own.
    const rows = store.listEventPhotos(eventId, { limit: 50, offset: 0 });
    expect(rows).toHaveLength(1);
    expect(rows[0].guestName).toBe(GUEST_NAME);
    expect(rows[0].photoUrl).toBe(PRINT_URL);
    expect(countRows('event_photo')).toBe(1);
  });

  it('answers the Agent\'s config_request with the four allow-listed fields and nothing else (UI-02, D-16, D-17)', async () => {
    const answers: Array<Record<string, unknown>> = [];
    agentSocket?.on('message', (raw) => {
      const parsed = JSON.parse(String(raw)) as Record<string, unknown>;
      if (parsed.type === 'config') answers.push(parsed);
    });

    // A payload rides along deliberately: the service must read none of it.
    agentSocket?.send(
      JSON.stringify({
        type: 'config_request',
        data: { extensionServiceWsToken: 'stolen', triggerServerPort: 9999 },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(answers).toHaveLength(1);
    const payload = answers[0].data as Record<string, unknown>;

    // Every key answered is allow-listed. This is the security property, and
    // it is the one stated as a subset rather than an equality on purpose —
    // see the next assertion for why an equality would have been wrong.
    for (const key of Object.keys(payload)) {
      expect(SAFE_AGENT_CONFIG_FIELDS as readonly string[]).toContain(key);
    }
    expect(payload).not.toHaveProperty('extensionServiceWsUrl');
    expect(payload).not.toHaveProperty('extensionServiceWsToken');
    expect(payload).not.toHaveProperty('triggerServerPort');
    expect(payload).not.toHaveProperty('logDir');

    // On a database no operator has touched, the answer carries THREE fields,
    // not four. `dslrBoothPassword` has no shipped default (08-04 decision 3):
    // it is absent rather than empty, so seeding on the Agent's first request
    // can never overwrite the password the booth was installed with. An
    // equality against all four would have documented a contract this service
    // does not have — and would have gone red on exactly the fresh database a
    // cutover starts from.
    expect(Object.keys(payload).sort()).toEqual(['autoOpenDisplay', 'dslrBoothApiPort', 'logLevel']);

    // ...and once an operator sets one in the CMS, all four travel. This is
    // the "four allow-listed fields" claim, measured where it is true.
    const saved = await request(baseUrl)
      .post('/cms/api/agent')
      .set('Cookie', sessionCookie)
      .send({ dslrBoothPassword: 'booth-local-secret' });
    expect(saved.status).toBe(200);

    answers.length = 0;
    agentSocket?.send(JSON.stringify({ type: 'config_request' }));
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(answers).toHaveLength(1);
    const full = answers[0].data as Record<string, unknown>;
    expect(Object.keys(full).sort()).toEqual([...SAFE_AGENT_CONFIG_FIELDS].sort());
    expect(full.dslrBoothPassword).toBe('booth-local-secret');
  });

  it('leaves queue_job exactly as Phase 7 left it, and booth_state with no column beyond the ones Phase 7 and Phase 11 deliberately added (D-01)', () => {
    // The whole phase's premise in one assertion. Everything above ran against
    // this database — an event created, a logo attached, an event activated, a
    // capture recorded — and `queue_job`, the table Phase 8 could most easily
    // have reached into, has not one byte of difference from commit 697380b.
    // `booth_state` gained exactly the two columns Phase 11's own D11-01
    // migration is documented to add, above — and nothing else. Either table
    // picking up an UNDOCUMENTED column would still fail this assertion.
    expect(readStoreSql('queue_job')).toBe(PRE_PHASE_8_QUEUE_JOB_SQL);
    expect(readStoreSql('booth_state')).toBe(CURRENT_BOOTH_STATE_SQL);
  });
});
