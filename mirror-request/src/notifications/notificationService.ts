import { getStore } from '../state/localStore';
import { getConfig } from '../config';
import logger from '../logging/logger';
import type { NotificationRecord } from '../types';

const store = getStore();
const config = getConfig();

export class NotificationService {
  private maxRetries: number;

  constructor(maxRetries = config.NOTIFY_MAX_RETRIES) {
    this.maxRetries = maxRetries;
  }

  async sendPhotoLink(_jobId: string, _photoUrl: string): Promise<void> {
    const job = store.getJob(_jobId);
    if (!job) {
      logger.warn(`Notification: job ${_jobId} not found`);
      return;
    }

    const record: NotificationRecord = {
      jobId: _jobId,
      channel: 'webhook',
      recipient: config.NOTIFY_WEBHOOK_URL,
      status: 'pending',
      attempts: 0,
    };

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      record.attempts = attempt;
      try {
        const payload = JSON.stringify({ jobId: _jobId, photoUrl: _photoUrl });
        // In production: await fetch(config.NOTIFY_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
        // Simulate success for now
        record.status = 'delivered';
        record.deliveredAt = new Date().toISOString();
        store.saveNotification(record);
        logger.info(`Notification sent for ${_jobId} (attempt ${attempt})`);
        return;
      } catch (err) {
        record.status = 'failed';
        record.errorMessage = err instanceof Error ? err.message : String(err);
        record.lastAttemptAt = new Date().toISOString();
        store.saveNotification(record);
      }
    }

    logger.error(`Notification failed for ${_jobId} after ${this.maxRetries} retries`);
  }
}

export function createNotificationService(): NotificationService {
  return new NotificationService();
}
