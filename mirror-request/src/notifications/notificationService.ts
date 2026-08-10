import { getStore, type LocalStore } from '../state/localStore';
import { getConfig } from '../config';
import { labelLogger } from '../logging/logger';

const config = getConfig();

// Exported so tests can spy on the exact instance this module logs through,
// matching queueService.ts's queueLogger convention.
export const notifyLogger = labelLogger('notify');

export class NotificationService {
  private maxRetries: number;
  private store: LocalStore;
  private webhookUrl: string;
  private fetchTimeoutMs: number;
  private sweepIntervalMs: number;
  private claimLeaseMs: number;
  private baseDelayMs: number;
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    maxRetries = config.NOTIFY_MAX_RETRIES,
    storeOrWebhook: LocalStore | string = getStore(),
    webhookUrl = config.NOTIFY_WEBHOOK_URL,
    opts: {
      fetchTimeoutMs?: number;
      sweepIntervalMs?: number;
      claimLeaseMs?: number;
      baseDelayMs?: number;
    } = {},
  ) {
    this.maxRetries = maxRetries;
    this.store = typeof storeOrWebhook === 'string' ? getStore() : storeOrWebhook;
    this.webhookUrl = typeof storeOrWebhook === 'string' ? storeOrWebhook : webhookUrl;
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? config.NOTIFY_FETCH_TIMEOUT_MS;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? config.NOTIFY_SWEEP_INTERVAL_MS;
    this.baseDelayMs = opts.baseDelayMs ?? config.NOTIFY_RETRY_BASE_DELAY_MS;
    // Clamp the effective claim lease to at least twice the effective fetch
    // timeout so a misconfiguration can never expire a lease under a live
    // in-flight request.
    const requestedLeaseMs = opts.claimLeaseMs ?? config.NOTIFY_CLAIM_LEASE_MS;
    this.claimLeaseMs = Math.max(requestedLeaseMs, this.fetchTimeoutMs * 2);
  }

  async sendPhotoLink(jobId: string, photoUrl: string): Promise<void> {
    const recordWithRegistration = this.store.getJobRegistration(jobId);
    if (!recordWithRegistration) {
      notifyLogger.warn(`Notification: job ${jobId} not found`);
      return;
    }
    if (!photoUrl) {
      notifyLogger.warn(`Notification: no photo URL for ${jobId}`);
      return;
    }
    if (!this.webhookUrl) {
      notifyLogger.warn(`Notification: NOTIFY_WEBHOOK_URL is not configured; skipping ${jobId}`);
      return;
    }

    // D-06: this method only enqueues — it performs no network I/O of its
    // own. Nothing about the outcome depends on this stack frame staying
    // alive, which is what makes queueService.ts's un-awaited call site
    // correct as written; do not modify queueService.ts in this plan.
    this.store.enqueueNotification({ jobId, photoUrl, dueAt: Date.now() });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.sweepIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sweep(): Promise<void> {
    // Defence in depth against interval re-entrancy — this flag is
    // explicitly NOT the mechanism that makes D-05 hold; the claim
    // predicate in LocalStore.claimNotification() is.
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const now = Date.now();
      const due = this.store.getDueNotifications(now);
      for (const row of due) {
        const claimed = this.store.claimNotification(row.jobId, now, now + this.claimLeaseMs);
        if (!claimed) {
          // Expected structural no-op under a single-process sweeper
          // (RESEARCH.md Pitfall 2) — not an anomaly, so no log line.
          continue;
        }
        await this.attemptDelivery(row);
      }
    } finally {
      this.sweeping = false;
    }
  }

  private async attemptDelivery(row: { jobId: string; photoUrl: string; attempts: number }): Promise<void> {
    const nextAttempt = row.attempts + 1;
    const recordWithRegistration = this.store.getJobRegistration(row.jobId);
    if (!recordWithRegistration) {
      // A row whose guest no longer exists can never succeed — retrying it
      // forever would be dishonest.
      this.store.saveNotification({
        jobId: row.jobId,
        status: 'failed',
        attempts: nextAttempt,
        lastError: 'registration not found',
      });
      return;
    }

    const { registration } = recordWithRegistration;
    try {
      // Exactly the five keys the slideshow needs: the receiver performs no
      // lookup of any kind, so everything it will display must be in this
      // body (D-01). No email, no phone (D-02, D-03).
      const payload = {
        jobId: row.jobId,
        guestName: registration.name,
        photoUrl: row.photoUrl,
        timestamp: new Date().toISOString(),
        mode: registration.mode,
      };
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}`);
      this.store.saveNotification({ jobId: row.jobId, status: 'delivered', attempts: nextAttempt });
      notifyLogger.info(`Notification sent for ${row.jobId} (attempt ${nextAttempt})`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // D-08 (corrected under D-15): strictly `<`, not `<=`. With the
      // shipped default maxRetries=2: attempt 1 fails and 1 < 3 retries;
      // attempt 2 fails and 2 < 3 retries; attempt 3 fails and 3 < 3 is
      // false, so it goes terminal — exactly 3 total delivery attempts.
      // `<=` here would yield 4: exhaustion must happen ON the attempt
      // where nextAttempt == 1 + maxRetries, not one attempt later.
      if (nextAttempt < 1 + this.maxRetries) {
        this.store.saveNotification({
          jobId: row.jobId,
          status: 'retrying',
          attempts: nextAttempt,
          lastError: reason,
          dueAt: Date.now() + this.baseDelayMs * 2 ** (nextAttempt - 1),
        });
      } else {
        this.store.saveNotification({
          jobId: row.jobId,
          status: 'failed',
          attempts: nextAttempt,
          lastError: reason,
        });
      }
    }
  }
}

export function createNotificationService(): NotificationService {
  return new NotificationService();
}
