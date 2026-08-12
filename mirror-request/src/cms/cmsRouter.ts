import express, { Router, Request, Response } from 'express';
import { labelLogger } from '../logging/logger';
import { clientIp } from '../security/ipAllowlist';
import type { EnvConfig } from '../types';
import {
  createSessionStore,
  createRequireSession,
  verifyPassword,
  safeEqual,
  parseCookies,
  buildSessionCookie,
  buildClearedSessionCookie,
} from './cmsAuth';
import { renderCmsLoginPage } from './cmsPages';
import { createCmsEventRoutes, type CmsEventStore } from './cmsEventRoutes';
import { createCmsAgentRoutes, type CmsAgentStore, type CmsAgentLink } from './cmsAgentRoutes';
import { createCmsPhotoRoutes, type CmsPhotoStore } from './cmsPhotoRoutes';

const log = labelLogger('cms');

export type CmsConfig = Pick<EnvConfig, 'CMS_USERNAME' | 'CMS_PASSWORD_HASH' | 'CMS_SESSION_COOKIE_NAME'>;

/**
 * The single login-failure message, in one place. UI-SPEC's copy table pins
 * the exact string; the fact that unknown-username and wrong-password both
 * render THIS string, with the same status code, is the anti-oracle control
 * (T-08-01) — not a copywriting convenience.
 */
const LOGIN_ERROR = 'Sai tên đăng nhập hoặc mật khẩu. Vui lòng thử lại.';

/**
 * D-13's SECOND layer, in `createStatusRouter`'s router-as-factory shape.
 *
 * Route order inside this router is load-bearing:
 *   1. GET/POST /login and POST /logout  — reachable WITHOUT a session
 *   2. requireSession()                  — everything below needs one
 *   3. createCmsEventRoutes(store)       — the dashboard and mutations
 *   4. createCmsAgentRoutes(store,agent) — UI-02's Agent configuration
 *   5. createCmsPhotoRoutes(store)       — CMS-03's photo history, and the
 *                                          system's only deletion path for it
 * Moving requireSession() above the login routes would lock the operator out
 * of the only page that can create a session.
 *
 * The session store is built INSIDE this factory (mirroring how
 * `statusRoute.ts` builds its rate limiter inside its own): two routers in
 * one process get independent session state, which is what lets a test build
 * a router per case without one case's login leaking into the next.
 *
 * The IP layer is NOT applied here. It is mounted in front of this router in
 * `index.ts`, so that a refused address never reaches any of this code — see
 * `cmsIpGate.ts` for why that separation is the point.
 */
export function createCmsRouter(
  store: CmsEventStore & CmsAgentStore & CmsPhotoStore,
  cfg: CmsConfig,
  agent: CmsAgentLink,
): ReturnType<typeof Router> {
  const router = Router();
  const sessions = createSessionStore();
  const cookieName = cfg.CMS_SESSION_COOKIE_NAME || 'cms_session';

  // Body parsing for the login form and the JSON dashboard calls. Both
  // parsers are no-ops when a body has already been parsed upstream
  // (body-parser skips when `req._body` is set), so mounting them here is
  // safe alongside index.ts's global parser and keeps this router
  // self-contained for tests.
  router.use(express.urlencoded({ extended: false }));
  router.use(express.json());

  router.get('/login', (_req: Request, res: Response) => {
    res.type('html').send(renderCmsLoginPage());
  });

  router.post('/login', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';

    // Both checks always run, and neither short-circuits the other: an early
    // return on a username miss would skip the scrypt work and make an
    // unknown username measurably faster to reject than a wrong password,
    // reintroducing by timing the account oracle the identical copy below
    // closes by content.
    const usernameOk = safeEqual(username, cfg.CMS_USERNAME);
    const passwordOk = verifyPassword(password, cfg.CMS_PASSWORD_HASH);

    if (!usernameOk || !passwordOk) {
      // Never log the presented username or password — only the source
      // address, which the operator needs in order to spot a real intrusion
      // attempt (D-14, T-08-06).
      log.warn(`Failed CMS login attempt from ${clientIp(req)}`);
      res.status(401).type('html').send(renderCmsLoginPage({ error: LOGIN_ERROR }));
      return;
    }

    const token = sessions.create(cfg.CMS_USERNAME);
    res.setHeader('Set-Cookie', buildSessionCookie(cookieName, token));
    log.info(`CMS login succeeded from ${clientIp(req)}`);
    // 303 so the browser re-issues the follow-up as a GET rather than
    // replaying the POST body at the dashboard.
    res.redirect(303, '/cms/');
  });

  router.post('/logout', (req: Request, res: Response) => {
    const token = parseCookies(req.headers.cookie)[cookieName] ?? '';
    sessions.destroy(token);
    res.setHeader('Set-Cookie', buildClearedSessionCookie(cookieName));
    res.redirect(303, '/cms/login');
  });

  router.use(createRequireSession(sessions, cookieName));
  router.use(createCmsEventRoutes(store));
  router.use(createCmsAgentRoutes(store, agent));
  router.use(createCmsPhotoRoutes(store));

  return router;
}
