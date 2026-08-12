import 'dotenv/config';
import express from 'express';
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
import { createNotificationService } from './notifications/notificationService';
import { mask } from './logging/logger';
import { DisplayServer } from './display/displayServer';
import { renderDisplayPage } from './display/displayPage';
import { createStatusRouter } from './status/statusRoute';
import { clientIp, isWhitelisted } from './security/ipAllowlist';

const config = getConfig();
const log = labelLogger('server');
// SC-5's "without a redeploy" half (07-02-PLAN.md): registered once, at
// startup, before the express app is built. SIGHUP reloads LOG_LEVEL from
// .env in place — see src/ops/logLevelControl.ts for why SIGHUP and not
// SIGUSR2.
registerLogLevelSignalHandler();

const app = express();
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

const agentServer = new AgentServer();
const notifier = createNotificationService();
const queue = createQueueService(agentServer, notifier);
const displayServer = new DisplayServer(queue, agentServer);

app.use(createStatusRouter(store, queue, agentServer, config));

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
