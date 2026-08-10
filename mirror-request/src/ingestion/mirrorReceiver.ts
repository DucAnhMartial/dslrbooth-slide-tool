import { Router, Request, Response } from 'express';
import { LocalStore } from '../state/localStore';
import logger from '../logging/logger';
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  WEBHOOK_ID_HEADER,
  getRawBody,
  verifySignature,
} from './webhookAuth';

export interface MirrorReceiverOptions {
  hmacSecret: string;
  timestampSkewMs: number;
  dedupWindowMs: number;
  onEnqueue?: (jobId: string) => void;
}

export function createMirrorReceiver(store: LocalStore, whitelist: string[], options: MirrorReceiverOptions): ReturnType<typeof Router> {
  const router = Router();

  if (!options.hmacSecret) {
    logger.warn('Webhook signature verification disabled: no HMAC secret configured');
  }

  function isWhitelisted(req: Request): boolean {
    if (whitelist.length === 0) return true;
    const ip = (req.ip || req.connection.remoteAddress || '').split(',')[0].trim();
    return whitelist.some((allowed) => {
      if (allowed.endsWith('.*')) {
        const prefix = allowed.slice(0, -2);
        return ip.startsWith(prefix);
      }
      return ip === allowed;
    });
  }

  router.post('/on-register', (req: Request, res: Response) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';

    if (!isWhitelisted(req)) {
      logger.warn(`Blocked /on-register from non-whitelisted IP: ${ip}`);
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (options.hmacSecret) {
      const signature = req.headers[SIGNATURE_HEADER];
      const timestamp = req.headers[TIMESTAMP_HEADER];
      const webhookId = req.headers[WEBHOOK_ID_HEADER];
      const rawBody = getRawBody(req);

      const headersPresent =
        typeof signature === 'string' && typeof timestamp === 'string' && typeof webhookId === 'string';

      if (
        !rawBody ||
        !headersPresent ||
        !verifySignature(rawBody, timestamp as string, webhookId as string, signature as string, options.hmacSecret)
      ) {
        logger.warn(`Blocked /on-register: webhook authentication failed from ${ip}`);
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    const { id, name, email, phone, mode, qr_token, registered_at } = req.body ?? {};

    if (!id || !name) {
      return res.status(400).json({ error: 'id and name are required' });
    }

    if (store.isProcessed(id)) {
      return res.status(200).json({ duplicate: true, jobId: id });
    }

    const registration = {
      id,
      name,
      email: email ?? '',
      phone: phone ?? '',
      mode: mode ?? 'standard',
      qr_token: qr_token ?? null,
      registered_at: registered_at ?? new Date().toISOString(),
    };

    store.upsertRegistration(registration);
    store.saveRawPayload(id, JSON.stringify(req.body));
    store.markProcessed(id);
    store.enqueueJob({ id, queued_at: Date.now() });
    options.onEnqueue?.(id);

    logger.info(`Ingested registration ${id} from ${ip}`);
    return res.status(200).json({ accepted: true, jobId: id });
  });

  return router;
}
