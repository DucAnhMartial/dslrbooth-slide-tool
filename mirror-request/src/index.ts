import 'dotenv/config';
import express from 'express';
import { getConfig } from './config';
import { getStore } from './state/localStore';
import { labelLogger } from './logging/logger';
import { createMirrorReceiver } from './ingestion/mirrorReceiver';
import { jsonWithRawBody } from './ingestion/webhookAuth';
import { DBPoller } from './ingestion/dbPoller';
import { createQueueService } from './queue/queueService';
import { AgentServer } from './agent/agentServer';
import { createNotificationService } from './notifications/notificationService';
import { mask } from './logging/logger';
import { DisplayServer } from './display/displayServer';
import { renderDisplayPage } from './display/displayPage';
import { createStatusRouter } from './status/statusRoute';

const config = getConfig();
const log = labelLogger('server');

const app = express();
app.use(jsonWithRawBody());

const store = getStore();
const mirror = createMirrorReceiver(store, config.PROXY_IP_WHITELIST, {
  hmacSecret: config.WEBHOOK_HMAC_SECRET,
  timestampSkewMs: config.WEBHOOK_TIMESTAMP_SKEW_MS,
  dedupWindowMs: config.REGISTRATION_DEDUP_WINDOW_MS,
});
app.use(mirror);
app.get('/display-screen', (_req, res) => res.type('html').send(renderDisplayPage()));

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

const server = app.listen(config.PORT, config.HOST, () => {
  log.info(`Extension Service ready on ${config.HOST}:${config.PORT}`);
  poller.start();
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
  queue.stop();
  notifier.stop();
  agentServer.stop();
  displayServer.stop();
  store.close();
  server.close(() => process.exit(code));
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
