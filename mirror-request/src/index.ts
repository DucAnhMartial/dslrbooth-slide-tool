import 'dotenv/config';
import { getConfig } from './config';
import { getStore } from './state/localStore';
import { labelLogger } from './logging/logger';
import { registerLogLevelSignalHandler } from './ops/logLevelControl';
import { DBPoller } from './ingestion/dbPoller';
import { createViewHealthProbe } from './ops/viewHealthProbe';
import { createQueueService } from './queue/queueService';
import { AgentServer } from './agent/agentServer';
import { createNotificationService } from './notifications/notificationService';
import { DisplayServer } from './display/displayServer';
import { createApp } from './app';

const config = getConfig();
const log = labelLogger('server');
// SC-5's "without a redeploy" half (07-02-PLAN.md): registered once, at
// startup, before the express app is built. SIGHUP reloads LOG_LEVEL from
// .env in place — see src/ops/logLevelControl.ts for why SIGHUP and not
// SIGUSR2.
registerLogLevelSignalHandler();

const store = getStore();
const agentServer = new AgentServer();
const notifier = createNotificationService();
const queue = createQueueService(agentServer, notifier);
const displayServer = new DisplayServer(queue, agentServer);

// Every route, middleware and mount order this service serves lives in
// src/app.ts (plan 08-06). It was moved out of this file so the readiness
// probe could drive the shipped wiring rather than a hand-assembled copy of
// it — see that file's header for why that mattered before D-06's cutover.
// This call is unconditional, exactly as the inline construction was: there is
// no `require.main` guard and no branch that could leave a started process
// serving nothing.
const app = createApp({ config, store, queue, agentServer });

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
