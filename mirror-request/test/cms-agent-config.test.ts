import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalStore } from '../src/state/localStore';
import { createCmsIpGate } from '../src/cms/cmsIpGate';
import { createSessionStore, createRequireSession } from '../src/cms/cmsAuth';
import { createCmsAgentRoutes, type CmsAgentLink } from '../src/cms/cmsAgentRoutes';
import { createCmsRouter } from '../src/cms/cmsRouter';
import {
  AGENT_TEST_SUCCESS,
  AGENT_TEST_FAILURE,
  AGENT_SAVE_SUCCESS,
  AGENT_OFFLINE_NOTICE,
  AGENT_NO_PREVIOUS,
  AGENT_MANUAL_EDIT_NOTE,
  AGENT_PASSWORD_SET,
} from '../src/cms/cmsAgentPages';
import {
  SAFE_AGENT_CONFIG_FIELDS,
  READ_ONLY_AGENT_CONFIG_FIELDS,
} from '../src/agent/agentConfigContract';
import { BOOTH_LINK } from './helpers/cmsBoothLink';

// ---------------------------------------------------------------------------
// Plan 08-04 Task 3 — the CMS Agent-configuration surface.
//
// Two properties carry this file. The first is D-16 as a SERVER control: the
// four bootstrap-ish fields are refused on the way in, not merely omitted from
// the form, because a form is one devtools edit away from absent. The second is
// D-18's one step back, which exists because of a specific 8pm failure — a save
// that broke the booth mid-event with nobody able to remember the previous port
// number.
// ---------------------------------------------------------------------------

const WHITELISTED_IP = '10.0.0.5';
const CMS_CFG = {
  CMS_USERNAME: 'test-operator',
  CMS_PASSWORD_HASH:
    '787573058ca13b1fccd1066f920d3277:9f4c0257894e8a206c18c88bd9dfa13179f31ff28797230aa8b66acca9a5efec3e95bf87ae1b8876b014d43cb8d2457d7f9c85f0b2448fa25126d8e4af43e5ac',
  CMS_SESSION_COOKIE_NAME: 'cms_session',
};

const tmpDirs: string[] = [];
const openStores: LocalStore[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cms-agent-'));
  tmpDirs.push(dir);
  return dir;
}

function makeStore(file?: string): LocalStore {
  const store = new LocalStore(file ?? path.join(makeTmpDir(), 'test.sqlite'));
  openStores.push(store);
  return store;
}

/** A stand-in for the live Agent link, with a recorder for what was sent. */
function makeAgent(online: boolean): CmsAgentLink & { sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    isAgentOnline: () => online,
    sendEvent: (payload) => {
      sent.push(payload as Record<string, unknown>);
      return online;
    },
  };
}

interface Harness {
  app: express.Express;
  cookie: string;
  store: LocalStore;
  agent: ReturnType<typeof makeAgent>;
}

function build(opts: { online?: boolean; store?: LocalStore } = {}): Harness {
  const store = opts.store ?? makeStore();
  const agent = makeAgent(opts.online ?? true);
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', { value: WHITELISTED_IP, configurable: true });
    next();
  });
  const sessions = createSessionStore();
  const token = sessions.create('operator');
  app.use(
    '/cms',
    createCmsIpGate([WHITELISTED_IP]),
    express.urlencoded({ extended: false }),
    express.json(),
    createRequireSession(sessions, 'cms_session'),
    createCmsAgentRoutes(store, agent),
  );
  return { app, cookie: `cms_session=${token}`, store, agent };
}

/** The HTML tag that carries `name="<field>"`, so attributes can be asserted. */
function controlFor(html: string, name: string): string {
  const idx = html.indexOf(`name="${name}"`);
  expect(idx, `no control named ${name}`).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<', idx);
  const end = html.indexOf('>', idx);
  return html.slice(start, end + 1);
}

afterEach(() => {
  while (openStores.length) {
    try { openStores.pop()?.close(); } catch { /* already closed */ }
  }
  while (tmpDirs.length) {
    try { fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('CMS Agent configuration page (UI-02, D-16)', () => {
  it('renders an editable input for each safe field and a read-only one for each forbidden field', async () => {
    const h = build();
    const res = await request(h.app).get('/cms/agent').set('Cookie', h.cookie);

    expect(res.status).toBe(200);
    for (const field of SAFE_AGENT_CONFIG_FIELDS) {
      const control = controlFor(res.text, field);
      expect(control, `${field} must be editable`).not.toMatch(/readonly|disabled/);
    }
    for (const field of READ_ONLY_AGENT_CONFIG_FIELDS) {
      const control = controlFor(res.text, field);
      expect(control, `${field} must not be editable`).toMatch(/readonly|disabled/);
    }
    // D-16 makes the physical trip to the booth a deliberate safety property,
    // so the page states it rather than hiding the fields.
    expect(res.text).toContain(AGENT_MANUAL_EDIT_NOTE);
  });

  it('never renders the stored dslrBooth password back into the page', async () => {
    const h = build();
    h.store.saveAgentConfig({
      logLevel: 'info',
      autoOpenDisplay: true,
      dslrBoothApiPort: 1500,
      dslrBoothPassword: 'the-real-booth-password',
    });

    const res = await request(h.app).get('/cms/agent').set('Cookie', h.cookie);

    expect(res.text).not.toContain('the-real-booth-password');
    expect(controlFor(res.text, 'dslrBoothPassword')).toContain('value=""');
    // The operator still needs to know one is set — otherwise "leave empty to
    // keep it" is indistinguishable from "there is nothing here".
    expect(res.text).toContain(AGENT_PASSWORD_SET);
  });

  it('treats an empty password submission as "leave unchanged"', async () => {
    const h = build();
    h.store.saveAgentConfig({ dslrBoothApiPort: 1500, dslrBoothPassword: 'keep-me' });

    const res = await request(h.app)
      .post('/cms/api/agent')
      .set('Cookie', h.cookie)
      .send({ logLevel: 'warn', autoOpenDisplay: true, dslrBoothApiPort: 1600, dslrBoothPassword: '' });

    expect(res.status).toBe(200);
    expect(h.store.getAgentConfig()).toEqual({
      logLevel: 'warn',
      autoOpenDisplay: true,
      dslrBoothApiPort: 1600,
      dslrBoothPassword: 'keep-me',
    });
  });

  it('saves, rotates the prior value into previous, and sends exactly one bare reload_config', async () => {
    const h = build({ online: true });
    h.store.saveAgentConfig({ logLevel: 'info', autoOpenDisplay: true, dslrBoothApiPort: 1500 });

    const res = await request(h.app)
      .post('/cms/api/agent')
      .set('Cookie', h.cookie)
      .send({ logLevel: 'debug', autoOpenDisplay: false, dslrBoothApiPort: 1600 });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe(AGENT_SAVE_SUCCESS);
    // D-17: a reload command, never a push of the values themselves.
    expect(h.agent.sent).toEqual([{ type: 'reload_config' }]);
    expect(h.agent.sent[0]).not.toHaveProperty('data');
    expect(h.store.getAgentConfig()).toEqual({
      logLevel: 'debug',
      autoOpenDisplay: false,
      dslrBoothApiPort: 1600,
    });
  });

  it('refuses a save carrying any of the four non-editable fields, server-side, leaving the row untouched', async () => {
    for (const forbidden of READ_ONLY_AGENT_CONFIG_FIELDS) {
      const h = build();
      const original = { logLevel: 'info', autoOpenDisplay: true, dslrBoothApiPort: 1500 };
      h.store.saveAgentConfig(original);

      const res = await request(h.app)
        .post('/cms/api/agent')
        .set('Cookie', h.cookie)
        .send({ logLevel: 'debug', [forbidden]: 'anything-at-all' });

      expect(res.status, `${forbidden} must be refused`).toBe(400);
      expect(h.store.getAgentConfig()).toEqual(original);
      // A refused save is not a save: nothing rotated, nothing was told to reload.
      expect(h.agent.sent).toEqual([]);
      expect(h.store.restorePreviousAgentConfig()).toBeUndefined();
    }
  });

  it('refuses a value outside its envelope rather than clamping it', async () => {
    const h = build();
    h.store.saveAgentConfig({ dslrBoothApiPort: 1500 });

    const badPort = await request(h.app)
      .post('/cms/api/agent')
      .set('Cookie', h.cookie)
      .send({ dslrBoothApiPort: 70000 });
    const badLevel = await request(h.app)
      .post('/cms/api/agent')
      .set('Cookie', h.cookie)
      .send({ logLevel: 'chatty' });

    expect(badPort.status).toBe(400);
    expect(badLevel.status).toBe(400);
    expect(h.store.getAgentConfig()).toEqual({ dslrBoothApiPort: 1500 });
  });

  it('still persists when the Agent is offline, and says it will be picked up on reconnect', async () => {
    const h = build({ online: false });

    const res = await request(h.app)
      .post('/cms/api/agent')
      .set('Cookie', h.cookie)
      .send({ dslrBoothApiPort: 1700 });

    // The database is the source of truth and the Agent pulls on connect, so a
    // failed delivery is not a failed save.
    expect(res.status).toBe(200);
    expect(res.body.agentOnline).toBe(false);
    expect(res.body.message).toBe(AGENT_OFFLINE_NOTICE);
    expect(h.store.getAgentConfig()).toEqual({ dslrBoothApiPort: 1700 });
  });

  it('steps back exactly one configuration, and a second restore rotates nothing new in (D-18)', async () => {
    const h = build();
    const first = { logLevel: 'info', autoOpenDisplay: true, dslrBoothApiPort: 1500 };
    const second = { logLevel: 'debug', autoOpenDisplay: false, dslrBoothApiPort: 1600 };
    await request(h.app).post('/cms/api/agent').set('Cookie', h.cookie).send(first);
    await request(h.app).post('/cms/api/agent').set('Cookie', h.cookie).send(second);
    expect(h.store.getAgentConfig()).toEqual(second);

    const restore = await request(h.app).post('/cms/api/agent/restore').set('Cookie', h.cookie);

    expect(restore.status).toBe(200);
    expect(h.store.getAgentConfig()).toEqual(first);
    // A restore is a save as far as the Agent is concerned: one reload, no push.
    expect(h.agent.sent).toEqual([
      { type: 'reload_config' },
      { type: 'reload_config' },
      { type: 'reload_config' },
    ]);

    // One step, not a two-entry ring. Pressing it again must not hand back the
    // configuration the operator has just rejected — the same button doing the
    // opposite thing on the second press, with no indication that it had.
    const again = await request(h.app).post('/cms/api/agent/restore').set('Cookie', h.cookie);

    expect(again.status).toBe(409);
    expect(again.body.error).toBe(AGENT_NO_PREVIOUS);
    expect(h.store.getAgentConfig()).toEqual(first);
    expect(h.agent.sent).toHaveLength(3); // the refusal told nobody to reload
  });

  it('reports the connection test with the two UI-SPEC strings', async () => {
    const online = build({ online: true });
    const offline = build({ online: false });

    const ok = await request(online.app).post('/cms/api/agent/test').set('Cookie', online.cookie);
    const bad = await request(offline.app).post('/cms/api/agent/test').set('Cookie', offline.cookie);

    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ online: true, message: AGENT_TEST_SUCCESS });
    expect(bad.status).toBe(200);
    expect(bad.body).toEqual({ online: false, message: AGENT_TEST_FAILURE });
    // The test is a read of the live link — it must never send anything.
    expect(online.agent.sent).toEqual([]);
    expect(offline.agent.sent).toEqual([]);
  });

  it('renders both connection-test outcomes into the page so the operator can read them', async () => {
    const h = build();
    const res = await request(h.app).get('/cms/agent').set('Cookie', h.cookie);

    expect(res.text).toContain(AGENT_TEST_SUCCESS);
    expect(res.text).toContain(AGENT_TEST_FAILURE);
    expect(res.text).toContain('Kiểm tra kết nối');
  });

  it('carries the shared in-flight hook on every mutating control, and on nothing else', async () => {
    const h = build();
    const res = await request(h.app).get('/cms/agent').set('Cookie', h.cookie);

    const mutating = res.text.match(/data-mutating/g) ?? [];
    // Save, connection test, restore-previous — and log out, which every CMS
    // page carries.
    expect(mutating.length).toBe(4);
    expect(res.text).toContain('cmsBusy');
    expect(res.text).toContain('data-inflight-label');
  });

  it('is unreachable without the IP layer and, separately, without a session', async () => {
    const store = makeStore();
    const agent = makeAgent(true);
    const app = express();
    app.use((req, _res, next) => {
      Object.defineProperty(req, 'ip', { value: '203.0.113.9', configurable: true });
      next();
    });
    app.use('/cms', createCmsIpGate([WHITELISTED_IP]), createCmsRouter(store, CMS_CFG, agent, BOOTH_LINK));

    const refusedByIp = await request(app).get('/cms/agent');
    expect(refusedByIp.status).toBe(403);

    const sessionApp = express();
    sessionApp.use((req, _res, next) => {
      Object.defineProperty(req, 'ip', { value: WHITELISTED_IP, configurable: true });
      next();
    });
    sessionApp.use('/cms', createCmsIpGate([WHITELISTED_IP]), createCmsRouter(makeStore(), CMS_CFG, agent, BOOTH_LINK));

    const refusedBySession = await request(sessionApp).get('/cms/agent');
    expect(refusedBySession.status).not.toBe(200);
  });

  it('survives a service restart — the configuration lives in agent_config, not in memory (CMS-03)', async () => {
    const file = path.join(makeTmpDir(), 'restart.sqlite');
    const h = build({ store: makeStore(file) });
    await request(h.app)
      .post('/cms/api/agent')
      .set('Cookie', h.cookie)
      .send({ logLevel: 'warn', autoOpenDisplay: false, dslrBoothApiPort: 1700, dslrBoothPassword: 'persisted' });
    h.store.close();

    const reopened = makeStore(file);

    expect(reopened.getAgentConfig()).toEqual({
      logLevel: 'warn',
      autoOpenDisplay: false,
      dslrBoothApiPort: 1700,
      dslrBoothPassword: 'persisted',
    });
  });
});
