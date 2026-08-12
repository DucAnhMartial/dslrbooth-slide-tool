import 'dotenv/config';
import express from 'express';
import path from 'path';
import { getConfig } from './config';
import { getStore } from './state/localStore';
import { labelLogger } from './logging/logger';
import { registerLogLevelSignalHandler } from './ops/logLevelControl';
import { createMirrorReceiver } from './ingestion/mirrorReceiver';
import { jsonWithRawBody } from './ingestion/webhookAuth';
import { DBPoller } from './ingestion/dbPoller';
import { createViewHealthProbe } from './ops/viewHealthProbe';
import { createQueueService } from './queue/queueService';
import { AgentServer } from './agent/agentServer';
import { readAgentConfigForAgent } from './agent/agentConfigContract';
import { createNotificationService } from './notifications/notificationService';
import { mask } from './logging/logger';
import { DisplayServer } from './display/displayServer';
import { renderDisplayPage } from './display/displayPage';
import { createStatusRouter } from './status/statusRoute';
import { createCmsIpGate } from './cms/cmsIpGate';
import { createCmsRouter } from './cms/cmsRouter';
import { serveUploadedAsset } from './cms/uploadHandler';
import { clientIp, isWhitelisted } from './security/ipAllowlist';

const config = getConfig();
const log = labelLogger('server');
// SC-5's "without a redeploy" half (07-02-PLAN.md): registered once, at
// startup, before the express app is built. SIGHUP reloads LOG_LEVEL from
// .env in place — see src/ops/logLevelControl.ts for why SIGHUP and not
// SIGUSR2.
registerLogLevelSignalHandler();

const app = express();

// D-15/T-08-07: the asset-upload body parser, mounted BEFORE the global one
// below and scoped to exactly one path.
//
// Order is the whole mechanism. `jsonWithRawBody()` carries no explicit
// `limit`, so body-parser's 100kb default applies to every route it handles.
// A 5MB image arrives base64-encoded inside JSON (~4/3 inflation, plus the
// envelope), so it must meet a parser with a larger limit FIRST. body-parser
// marks a request once it has parsed a body and every later parser skips it,
// which is what makes this work and what leaves the global 100kb default
// fully in force for every other route — including /on-register, where a
// generous limit would be a denial-of-service surface rather than a feature.
//
// MEASURED, not assumed: test/cms-access-control.test.ts posts a ~4MB body to
// this path and asserts the response is not a 413. If that case ever goes
// red, this mount has moved below the global parser.
app.use(
  '/cms/api/assets',
  express.json({ limit: Math.ceil(config.CMS_UPLOAD_MAX_BYTES * (4 / 3)) + 65_536 }),
);
app.use(jsonWithRawBody());

const store = getStore();
const mirror = createMirrorReceiver(store, config.PROXY_IP_WHITELIST, {
  hmacSecret: config.WEBHOOK_HMAC_SECRET,
  timestampSkewMs: config.WEBHOOK_TIMESTAMP_SKEW_MS,
  dedupWindowMs: config.REGISTRATION_DEDUP_WINDOW_MS,
});
app.use(mirror);
// D-09: gated by the same allow-list machinery the WS /display upgrade
// handler uses (src/display/displayServer.ts), so the two surfaces can
// never diverge on what counts as an allowed peer. A blocked peer gets the
// identical generic 403 body Phase 1's blocked-IP response already uses
// (D-08's "one indistinguishable refusal" posture, extended to this surface).
app.get('/display-screen', (req, res, next) => {
  const ip = clientIp(req);
  if (!isWhitelisted(ip, config.DISPLAY_IP_WHITELIST)) {
    log.warn(`Blocked /display-screen from non-whitelisted IP: ${ip}`);
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}, (_req, res) => res.type('html').send(renderDisplayPage()));

// The three curated Room Screen fonts (UI-SPEC Open Question 1, human-answered):
// self-hosted, weights 400 and 700 only, served from this host so a venue with
// no internet — or a compromised third-party font CDN — both fail closed
// (T-08-SC). There is no <link> to fonts.googleapis.com anywhere.
//
// This is the ONE place plain static-file middleware is correct, and the
// contrast with /uploads below is the reason: these four files are immutable,
// trusted, and committed to this repository at build time. /uploads serves
// request-supplied bytes, which is exactly why it sniffs magic bytes against a
// hard-coded allow-list instead of using express.static.
//
// Ungated deliberately: a font carries no event data and no guest data, and a
// TV that could not fetch it would render the whole screen in a fallback face.
app.use(
  '/assets/fonts',
  express.static(path.join(__dirname, '..', 'assets', 'fonts'), {
    // Immutable by construction — the filename changes when the font does.
    maxAge: '30d',
    // No directory listing, and no fallthrough to a directory index.
    index: false,
    redirect: false,
    dotfiles: 'deny',
  }),
);

const agentServer = new AgentServer();
const notifier = createNotificationService();
const queue = createQueueService(agentServer, notifier);
const displayServer = new DisplayServer(queue, agentServer);

// UI-02 / D-17: the Agent PULLS its configuration. This is the whole of the
// service's side of that round trip — the Agent asks on connect (and again
// whenever a CMS save sends it a `reload_config`), and this callback answers
// from `agent_config`, projected onto D-16's allow-list. It takes no argument
// because there is nothing about the request worth reading: configuration
// travels one way.
agentServer.registerConfigRequestHandler(() => readAgentConfigForAgent(store));

app.use(createStatusRouter(store, queue, agentServer, config));

// D-13's two layers, in the ONE order that makes them two layers: the IP
// allow-list gate is mounted BEFORE the router, so a non-whitelisted peer is
// refused without any session logic running at all. Swapping these two
// arguments leaves a CMS that still demands a password and still passes every
// happy-path test, while having silently deleted the network control — see
// src/cms/cmsIpGate.ts, and test/cms-access-control.test.ts for the case that
// proves the layers refuse independently.
//
// config.CMS_IP_WHITELIST, never config.DISPLAY_IP_WHITELIST: the operator's
// laptop and the room's TVs are different audiences on different network
// paths (RESEARCH Pitfall 2).
app.use('/cms', createCmsIpGate(config.CMS_IP_WHITELIST), createCmsRouter(store, config));

// D-15: uploaded branding assets. Gated by the UNION of the two allow-lists,
// not by either alone — the room's TV has to fetch the event's logo and
// background to render at all, and the operator has to preview what they just
// uploaded. Both address sets are already trusted for their own surfaces, and
// neither is a superset of the other.
//
// No session check here, deliberately: a TV has no session and cannot get
// one (D-12 gives screens no identity). The network layer is the whole
// control on this route, which is why the route can only ever emit one of
// four image types from one directory — see src/cms/uploadHandler.ts.
app.get(
  '/uploads/:filename',
  (req, res, next) => {
    const ip = clientIp(req);
    if (!isWhitelisted(ip, [...config.DISPLAY_IP_WHITELIST, ...config.CMS_IP_WHITELIST])) {
      log.warn(`Blocked /uploads from non-whitelisted IP: ${ip}`);
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  },
  serveUploadedAsset(config.CMS_UPLOAD_DIR),
);

const poller = new DBPoller(
  config.DB_POLL_INTERVAL_MS,
  config.DB_POLL_BATCH_SIZE,
  store,
  {
    host: config.DB_HOST,
    port: config.DB_PORT,
    database: config.DB_NAME,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
  },
);
// D-09: a broken registrations VIEW never blocks startup or the process —
// probe.start() runs its first cycle detached, inside the app.listen
// callback below, same as poller.start().
const probe = createViewHealthProbe(store);

const server = app.listen(config.PORT, config.HOST, () => {
  log.info(`Extension Service ready on ${config.HOST}:${config.PORT}`);
  log.info(
    `Log level started at "${config.LOG_LEVEL}" — send SIGHUP to reload LOG_LEVEL from .env without a restart`
  );
  poller.start();
  probe.start();
  try {
    queue.recover();
  } catch (err) {
    log.warn(err instanceof Error ? err.message : String(err));
  }
  queue.start();
  notifier.start();
  agentServer.start(server);
  displayServer.start(server);
});

function shutdown(code: number): void {
  log.info('Shutting down');
  poller.stop();
  probe.stop();
  queue.stop();
  notifier.stop();
  agentServer.stop();
  displayServer.stop();
  store.close();
  server.close(() => process.exit(code));
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
