import { QueueManager } from '../queue/queueManager';
import { getStore } from '../state/localStore';
import logger from '../logging/logger';

export interface DBPollCursor {
  poll_key: string;
  last_value: string;
  updated_at: string;
}

export class DBPoller {
  private intervalMs: number;
  private batchSize: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(intervalMs: number, batchSize: number, private queue: QueueManager) {
    this.intervalMs = intervalMs;
    this.batchSize = batchSize;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.poll();                       // run immediately
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    logger.info(`DB poller started: every ${this.intervalMs}ms, batch ${this.batchSize}`);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private async poll(): Promise<void> {
    if (!this.running) return;
    try {
      const store = getStore();
      const cursor = store.getCursor('registrations');
      const lastId = cursor?.last_value ?? '00000000-00000000-00000000-00000000';
      // Read-only query - never writes to the real backend DB.
      // Replace the body with your actual SELECT when wiring up the real DB connection.
      const rows: Array<{ id: string; name: string; email: string; phone: string; mode: string; registered_at: string }> = [];
      if (rows.length === 0) return;

      for (const row of rows) {
        if (store.isProcessed(row.id)) continue;              // idempotency guard
        store.upsertRegistration(row);
        store.markProcessed(row.id);
        this.queue.enqueue({
          id: row.id,
          registration: {
            ...row,
            phone: row.phone ?? '',
            registered_at: row.registered_at ?? new Date().toISOString(),
          },
          status: 'queued',
          queued_at: Date.now(),
          retries: 0,
        });
        logger.info(`DB poller ingested registration ${mask(JSON.stringify(row))}`);
      }

      const lastRow = rows.at(-1);
      if (lastRow) {
        store.setCursor('registrations', lastRow.id);
      }
    } catch (err) {
      logger.error('DB poller cycle failed', err as Error);
    }
  }
}
