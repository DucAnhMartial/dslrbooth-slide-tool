import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';

// ---------------------------------------------------------------------------
// Phase 8 code review, WR-05 — the raised body-size limit must not be paid
// for on behalf of a peer that has no business being here.
//
// `app.use('/cms/api/assets', express.json({ limit }))` was the FIRST
// middleware registered in `createApp()`, ahead of `createMirrorReceiver`,
// `/display-screen`, the status router and — critically —
// `createCmsIpGate(config.CMS_IP_WHITELIST)`. A request from a non-whitelisted
// address still had its JSON body parsed and buffered, up to ~6.7MB, before
// the IP gate ever ran. The final answer was correctly 403, so D-13's access
// decision was never violated; the memory and CPU were spent regardless.
//
// This is the inverse of the ordering principle app.ts's own comment insists
// on a few lines further down for the IP-gate-then-session pairing: "Route
// order... is load-bearing".
//
// SEPARATE FILE, and that is not tidiness. `clientIp()` deliberately does not
// trust `X-Forwarded-For` (T-05-02), so a blocked peer cannot be faked with a
// header — the only way to make supertest's loopback connection a BLOCKED one
// is a CMS_IP_WHITELIST that excludes it, which is a different process
// environment from the file testing the size boundary. vitest isolates per
// file, which is what makes both possible; `phase8-cutover-readiness.test.ts`
// already relies on the same property.
// ---------------------------------------------------------------------------

const PATHS = vi.hoisted(() => {
  const stamp = `${process.pid}-${Date.now()}`;
  const storePath = `./data/test-cms-upload-iporder-${stamp}.sqlite`;
  const uploadDir = `./data/test-cms-upload-iporder-uploads-${stamp}`;
  process.env.LOCAL_STORE_PATH = storePath;
  process.env.CMS_UPLOAD_DIR = uploadDir;
  // Deliberately EXCLUDES the loopback address supertest connects from, so
  // every request in this file arrives as a blocked peer.
  process.env.CMS_IP_WHITELIST = '10.99.99.99';
  process.env.DISPLAY_IP_WHITELIST = '10.99.99.99';
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

function postAsset(body: string) {
  return request(app)
    .post('/cms/api/assets')
    .set('Content-Type', 'application/json')
    .send(body);
}

describe('WR-05: the IP gate runs before the raised body parser', () => {
  it('refuses an OVERSIZED body from a blocked address with 403, not 400', async () => {
    const res = await postAsset(overLimitBody);

    // The discriminating case, and the reason this file exists. If the parser
    // still ran first, this body would trip its size limit and produce
    // WR-03's 400 before the IP gate was ever consulted — so a 400 here is
    // proof the parse happened on behalf of a peer that should never have
    // been read from. 403 is proof the gate moved in front of it.
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
  });

  it('refuses an ordinary body from a blocked address with the same 403', async () => {
    const res = await postAsset(JSON.stringify({ data: 'small' }));

    // D-13's access decision is unchanged by the reordering — only the point
    // at which it is taken. One shape for both sizes.
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
  });

  it('refuses a blocked peer identically whether the body is huge or tiny', async () => {
    const huge = await postAsset(overLimitBody);
    const tiny = await postAsset(JSON.stringify({ data: 'small' }));

    expect({ status: huge.status, body: huge.body }).toEqual({
      status: tiny.status,
      body: tiny.body,
    });
  });

  // -------------------------------------------------------------------------
  // Non-vacuity. Passes BEFORE the fix. Without it, "403 everything under
  // /cms" would satisfy every case above — including a service that had
  // silently locked its own operator out.
  // -------------------------------------------------------------------------

  it('the block is the ADDRESS, not the route — a whitelisted surface still answers', async () => {
    // /status is not behind CMS_IP_WHITELIST at all (it is a guest-facing
    // capability URL, Phase 5 D-06). Its 404 for an unknown id proves this
    // app is serving normally and that the 403s above are the CMS gate
    // deciding, not a dead app answering everything the same way.
    const res = await request(app).get('/status/no-such-job-id');

    expect(res.status).toBe(404);
  });
});
