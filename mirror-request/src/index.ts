import 'dotenv/config';
import express from 'express';
import { getConfig } from './config';
import { getStore } from './state/localStore';
import { labelLogger } from './logging/logger';
import { createMirrorReceiver } from './ingestion/mirrorReceiver';
import { DBPoller } from './ingestion/dbPoller';
import { createQueueService } from './queue/queueService';
import { AgentServer } from './agent/agentServer';
import { createNotificationService } from './notifications/notificationService';
import { mask } from './logging/logger';
import { DisplayServer } from './display/displayServer';
import { renderDisplayPage } from './display/displayPage';

const config = getConfig();
const log = labelLogger('server');

const app = express();
app.use(express.json());

const store = getStore();
const mirror = createMirrorReceiver(store, config.PROXY_IP_WHITELIST);
app.use(mirror);
app.get('/display-screen', (_req, res) => res.type('html').send(renderDisplayPage()));

const agentServer = new AgentServer();
const notifier = createNotificationService();
const queue = createQueueService(agentServer, notifier);
const displayServer = new DisplayServer(queue, agentServer);

app.get('/status/:jobId', (req, res) => {
  const job = store.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });

  const position = queue.getQueuePosition(req.params.jobId);
  const snapshot = {
    jobId: req.params.jobId,
    queuePosition: position ?? null,
    queueLength: queue.getQueueLength(),
    boothState: store.getBoothState(),
    agentOnline: agentServer.isAgentOnline(),
    guestName: job.registration?.name ?? null,
  };
  res.json(snapshot);
});

const poller = new DBPoller(
  config.DB_POLL_INTERVAL_MS,
  config.DB_POLL_BATCH_SIZE,
  store,
);

const server = app.listen(config.PORT, config.HOST, () => {
  log.info(`Extension Service ready on ${config.HOST}:${config.PORT}`);
  poller.start();
  queue.start();
  agentServer.start(server);
  displayServer.start(server);
});

function shutdown(code: number): void {
  log.info('Shutting down');
  poller.stop();
  queue.stop();
  agentServer.stop();
  displayServer.stop();
  store.close();
  server.close(() => process.exit(code));
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
