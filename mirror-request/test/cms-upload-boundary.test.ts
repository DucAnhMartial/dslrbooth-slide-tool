import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';

// ---------------------------------------------------------------------------
// Phase 8 code review, WR-03 — an oversized upload body must get the
// endpoint's ONE refusal shape.
//
// A request whose ENCODED body exceeds the scoped `express.json({ limit })`
// never reaches `handleAssetUpload`. body-parser rejects it first with a 413
// and Express's DEFAULT error page: a different status, a different
// Content-Type (`text/html`) and a different body shape from every other
// refusal on this endpoint — whose own comment promises "one refusal for
// every way an upload can fail... Distinct messages here would tell a caller
// which of its guesses was closer". With NODE_ENV not exactly 'production'
// that default page also carries a stack trace and absolute filesystem paths.
//
// Same root cause as CR-01: nothing in this app registered a JSON-aware error
// handler, so every parser-level throw fell through to Express's HTML page.
//
// Driven through the shipped `createApp()`, not a hand-assembled app. A suite
// that rebuilds the mount order it BELIEVES app.ts uses cannot catch a
// mistake in app.ts — and this defect is about that order.
//
// WR-05's other half needs a BLOCKED peer, which cannot be faked by a header
// (clientIp deliberately does not trust X-Forwarded-For, T-05-02) and so
// needs a different CMS_IP_WHITELIST than this file's. It lives in
// test/cms-upload-ip-order.test.ts.
// ---------------------------------------------------------------------------

const PATHS = vi.hoisted(() => {
  const stamp = `${process.pid}-${Date.now()}`;
  const storePath = `./data/test-cms-upload-boundary-${stamp}.sqlite`;
  const uploadDir = `./data/test-cms-upload-boundary-uploads-${stamp}`;
  process.env.LOCAL_STORE_PATH = storePath;
  process.env.CMS_UPLOAD_DIR = uploadDir;
  // Allows the loopback address supertest connects from, so these cases probe
  // the SIZE boundary rather than the address one.
  process.env.CMS_IP_WHITELIST = '127.0.0.1,::1,::ffff:127.0.0.1';
  process.env.DISPLAY_IP_WHITELIST = '127.0.0.1,::1,::ffff:127.0.0.1';
  return { storePath, uploadDir };
});

import { createApp } from '../src/app';
import { getConfig } from '../src/config';
import { getStore, type LocalStore } from '../src/state/localStore';
import { AgentServer } from '../src/agent/agentServer';
import { createQueueService, type QueueService } from '../src/queue/queueService';

let app: ReturnType<typeof createApp>;
let store: LocalStore;
let queue: QueueService;
let agentServer: AgentServer;
let overLimitBody: string;

beforeAll(() => {
  const config = getConfig();
  store = getStore();
  agentServer = new AgentServer();
  queue = createQueueService(agentServer);
  app = createApp({ config, store, queue, agentServer });

  // Computed from the same expression app.ts uses rather than hard-coded — a
  // literal here would drift silently the day CMS_UPLOAD_MAX_BYTES changes,
  // and the case would go on passing while testing nothing.
  const limit = Math.ceil(config.CMS_UPLOAD_MAX_BYTES * (4 / 3)) + 65_536;
  overLimitBody = JSON.stringify({ data: 'A'.repeat(limit + 1_024) });
});

afterAll(() => {
  agentServer?.stop();
  try {
    store?.close();
  } catch {
    /* already closed */
  }
  try {
    fs.rmSync(path.resolve(PATHS.uploadDir), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/**
 * The upload route is behind `requireSession` (D-15: uploading requires
 * login), so every case below authenticates first. The credentials are the
 * suite-wide fixtures pinned in vitest.config.ts.
 */
let cookie: string;

beforeAll(async () => {
  const login = await request(app)
    .post('/cms/login')
    .type('form')
    .send({ username: 'test-operator', password: 'test-cms-password' });
  expect(login.status).toBe(303);
  cookie = login.headers['set-cookie'][0].split(';')[0];
});

function postAsset(body: string, withSession = true) {
  const req = request(app).post('/cms/api/assets').set('Content-Type', 'application/json');
  if (withSession) req.set('Cookie', cookie);
  return req.send(body);
}

describe("WR-03: an oversized upload body gets the endpoint's one refusal shape", () => {
  it('answers 400 {"error":"Invalid upload"} as JSON, not a 413 HTML error page', async () => {
    const res = await postAsset(overLimitBody);

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: 'Invalid upload' });
  });

  it('leaks no filesystem path or stack frame, whatever NODE_ENV happens to be', async () => {
    const res = await postAsset(overLimitBody);

    // Asserted against the response TEXT, not the parsed body: an HTML error
    // page would not parse into `body` at all, so a body-only assertion would
    // pass vacuously on exactly the response this case exists to forbid.
    expect(res.text).not.toMatch(/node_modules/);
    expect(res.text).not.toMatch(/PayloadTooLargeError/);
    expect(res.text).not.toMatch(/at .+:\d+:\d+/);
  });

  it('is indistinguishable from the refusals raised inside the handler', async () => {
    const tooBig = await postAsset(overLimitBody);
    const notAnImage = await postAsset(JSON.stringify({ data: 'not-an-image' }));

    // The invariant stated in uploadHandler.ts, asserted as equality. Two
    // shapes are two failure modes free to drift apart, and the difference
    // between them tells a caller which guess was closer.
    expect({ status: tooBig.status, body: tooBig.body }).toEqual({
      status: notAnImage.status,
      body: notAnImage.body,
    });
  });

  // -------------------------------------------------------------------------
  // Non-vacuity. Both pass BEFORE the fix — they stop it being "refuse every
  // asset upload", which would satisfy all three cases above.
  // -------------------------------------------------------------------------

  it('a body UNDER the limit still reaches the handler', async () => {
    const res = await postAsset(JSON.stringify({ data: 'not-an-image' }));

    // Refused on content, by handleAssetUpload — proof the route is live and
    // the parser is still admitting ordinary bodies.
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid upload' });
  });

  it('a real png under the limit is accepted and stored', async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('the rest of a png, not parsed by the upload handler'),
    ]);
    const res = await postAsset(
      JSON.stringify({ data: `data:image/png;base64,${png.toString('base64')}` }),
    );

    // The one case that proves the size ceiling did not become a floor.
    // 201 Created, which is what the route already answered before this
    // change — asserted on its real value rather than an assumed 200.
    expect(res.status).toBe(201);
  });

  it('an UNAUTHENTICATED oversized body is answered by the parser, not the session gate', async () => {
    const res = await postAsset(overLimitBody, false);

    // Recorded rather than discovered later. The scoped parser is mounted at
    // app level and therefore runs BEFORE the CMS router's requireSession, so
    // an oversized body is refused before anyone asks about a session: 400
    // here, where an ordinary unauthenticated body gets 401.
    //
    // That is a deliberate boundary, not an oversight. The two refusals
    // belong to different families — uploadHandler.ts's "one refusal for
    // every way an UPLOAD can fail" and cmsAuth.ts's "one generic refusal for
    // every way of failing the session check" — and this response tells a
    // caller only that their body exceeded a published limit, which they
    // already knew when they sent it. The caller is also already inside
    // CMS_IP_WHITELIST by this point (WR-05), so it is not an anonymous
    // internet peer learning anything.
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid upload' });

    const ordinary = await postAsset(JSON.stringify({ data: 'small' }), false);
    expect(ordinary.status).toBe(401);
  });
});
