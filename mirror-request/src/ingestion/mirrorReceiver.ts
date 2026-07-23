import { Router, Request, Response, NextFunction } from 'express';
import { QueueManager } from '../queue/queueManager';
import { LocalStore } from '../state/localStore';

export function createMirrorReceiver(queue: QueueManager, store: LocalStore): Router {
  const router = Router();

  router.post('/on-register', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const registration = _req.body as {
        id: string;
        name: string;
        email: string;
        phone: string;
        mode: string;
        qr_token?: string;
        registered_at?: string;
      };

      if (!registration?.id || !registration?.name) {
        return res.status(400).json({ error: 'id and name are required' });
      }

      const alreadyProcessed = store.isProcessed(registration.id);
      if (alreadyProcessed) {
        return res.status(200).json({ duplicate: true, jobId: registration.id });
      }

      const stored = store.upsertRegistration({
        id: registration.id,
        name: registration.name,
        email: registration.email,
        phone: registration.phone,
        mode: registration.mode,
        qr_token: registration.qr_token ?? null,
        registered_at: registration.registered_at ?? new Date().toISOString(),
      });

      queue.enqueue({
        id: stored.id,
        registration: stored,
        status: 'queued',
        queued_at: Date.now(),
        retries: 0,
      });

      res.status(200).json({ accepted: true, jobId: stored.id });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
