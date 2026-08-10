import { Router, Request, Response } from 'express';
import { LocalStore } from '../state/localStore';
import logger from '../logging/logger';
import { checkWebhookAuth } from './webhookAuth';

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

  /**
   * The single source of the peer address, used by both `isWhitelisted` and
   * the handler's logged `ip`, so the value that is checked and the value
   * that is logged can never diverge.
   *
   * No Express application-level `trust proxy` setting is enabled anywhere
   * in this service (see `src/index.ts`). Without it, `req.ip` resolves to
   * the direct TCP peer — the reverse proxy itself — which is exactly what
   * `PROXY_IP_WHITELIST` is meant to match. Enabling `trust proxy` unscoped
   * would make Express read `X-Forwarded-For` for `req.ip`, letting any
   * client forge that header and impersonate an allow-listed address,
   * defeating AUTH-02 (T-01-10). If the deployment topology ever gains
   * another hop, scope `trust proxy` to that specific hop's address —
   * never to `true` or a blanket value — and re-verify this reasoning.
   */
  function clientIp(req: Request): string {
    return (req.ip || req.socket.remoteAddress || '').split(',')[0].trim();
  }

  function isWhitelisted(req: Request): boolean {
    // Development escape hatch only: an empty whitelist allows every
    // request. 01-01 task 2's production-strict loadConfig() validation
    // rejects both an empty PROXY_IP_WHITELIST and the bare ['127.0.0.1']
    // default when NODE_ENV=production, making this branch unreachable
    // in production.
    if (whitelist.length === 0) return true;
    const ip = clientIp(req);
    return whitelist.some((allowed) => {
      if (allowed.endsWith('.*')) {
        const prefix = allowed.slice(0, -2);
        return ip.startsWith(prefix);
      }
      return ip === allowed;
    });
  }

  router.post('/on-register', (req: Request, res: Response) => {
    const ip = clientIp(req) || 'unknown';

    if (!isWhitelisted(req)) {
      logger.warn(`Blocked /on-register from non-whitelisted IP: ${ip}`);
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (options.hmacSecret) {
      const authenticated = checkWebhookAuth(req, store, {
        secret: options.hmacSecret,
        skewMs: options.timestampSkewMs,
      });

      if (!authenticated) {
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
