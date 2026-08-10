import { getStore, type LocalStore } from '../state/localStore';
import { getConfig } from '../config';
import logger from '../logging/logger';
import type { NotificationRecord } from '../types';

const config = getConfig();

export class NotificationService {
  private maxRetries: number;
  private store: LocalStore;
  private webhookUrl: string;

  constructor(
    maxRetries = config.NOTIFY_MAX_RETRIES,
    storeOrWebhook: LocalStore | string = getStore(),
    webhookUrl = config.NOTIFY_WEBHOOK_URL,
  ) {
    this.maxRetries = maxRetries;
    this.store = typeof storeOrWebhook === 'string' ? getStore() : storeOrWebhook;
    this.webhookUrl = typeof storeOrWebhook === 'string' ? storeOrWebhook : webhookUrl;
  }

  async sendPhotoLink(jobId: string, photoUrl: string): Promise<void> {
    const recordWithRegistration = this.store.getJobRegistration(jobId);
    if (!recordWithRegistration) {
      logger.warn(`Notification: job ${jobId} not found`);
      return;
    }
    if (!photoUrl) {
      logger.warn(`Notification: no photo URL for ${jobId}`);
      return;
    }
    if (!this.webhookUrl) {
      logger.warn(`Notification: NOTIFY_WEBHOOK_URL is not configured; skipping ${jobId}`);
      return;
    }

    const { registration } = recordWithRegistration;

    const record: NotificationRecord = {
      jobId,
      channel: 'webhook',
      recipient: this.webhookUrl,
      status: 'pending',
      attempts: 0,
    };

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      record.attempts = attempt;
      try {
        const payload = {
          jobId,
          guestName: registration.name,
          photoUrl,
          timestamp: new Date().toISOString(),
          mode: registration.mode,
        };
        const response = await fetch(this.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}`);
        record.status = 'delivered';
        record.deliveredAt = new Date().toISOString();
        this.store.saveNotification(record);
        logger.info(`Notification sent for ${jobId} (attempt ${attempt})`);
        return;
      } catch (err) {
        record.status = 'failed';
        record.errorMessage = err instanceof Error ? err.message : String(err);
        record.lastAttemptAt = new Date().toISOString();
        this.store.saveNotification(record);
        if (attempt < this.maxRetries) {
          await new Promise(resolve => setTimeout(resolve, config.NOTIFY_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)));
        }
      }
    }

    logger.error(`Notification failed for ${jobId} after ${this.maxRetries} retries`);
  }
}

export function createNotificationService(): NotificationService {
  return new NotificationService();
}
