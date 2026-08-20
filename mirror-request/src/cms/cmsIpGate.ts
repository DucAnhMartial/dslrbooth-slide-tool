import { Request, Response, NextFunction, RequestHandler } from 'express';
import { clientIp, isWhitelisted } from '../security/ipAllowlist';
import { labelLogger } from '../logging/logger';

const log = labelLogger('cms');

/**
 * D-13's FIRST layer: the network allow-list, in front of the CMS router and
 * therefore in front of every session check inside it.
 *
 * The order this middleware is mounted in (`index.ts`) is the decision, not a
 * detail. Mounted before `createCmsRouter`, a non-whitelisted peer is refused
 * without the session layer ever being consulted — the two controls are
 * independent, and `test/cms-access-control.test.ts` proves that
 * independence by spying on the session lookup and asserting it was never
 * called. Reversing the two would leave a router that still "requires login"
 * and looks fine in every happy-path test, while having silently deleted the
 * network half of D-13.
 *
 * `clientIp()` and `isWhitelisted()` are IMPORTED, not reimplemented: D-13
 * says reuse the existing machinery, and a second copy of the allow-list
 * algorithm is a second thing to get wrong. What is NOT shared is the list
 * itself — `CMS_IP_WHITELIST` is an independent key (RESEARCH Pitfall 2).
 *
 * The refusal body is byte-identical to the one `/display-screen` already
 * returns, keeping this service's "one indistinguishable refusal" posture.
 */
export function createCmsIpGate(whitelist: string[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = clientIp(req);
    if (!isWhitelisted(ip, whitelist)) {
      // Template string, never an object: the winston masking formatters only
      // run mask() when typeof message === 'string'.
      log.warn(`Blocked /cms from non-whitelisted IP: ${ip}`);
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
  };
}
