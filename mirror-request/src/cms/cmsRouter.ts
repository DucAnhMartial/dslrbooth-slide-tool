import express, { Router, Request, Response, NextFunction } from 'express';
import { labelLogger } from '../logging/logger';
import { clientIp } from '../security/ipAllowlist';
import {
  createRateLimitState,
  checkRateLimit,
  pruneExpired,
  RATE_LIMITED_STATUS,
} from '../security/rateLimiter';
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

/**
 * The three rate-limit keys are OPTIONAL, with the defaults below applied in
 * the factory. Making them required would have been the tidier type and would
 * have broken every existing suite that hands this factory a three-key
 * literal — for want of a value, not for any defect. Production always passes
 * the full `EnvConfig`, so the defaults are a test-ergonomics affordance and
 * never the shipped configuration.
 */
export type CmsConfig = Pick<
  EnvConfig,
  'CMS_USERNAME' | 'CMS_PASSWORD_HASH' | 'CMS_SESSION_COOKIE_NAME'
> &
  Partial<
    Pick<
      EnvConfig,
      | 'CMS_LOGIN_RATE_LIMIT_WINDOW_MS'
      | 'CMS_LOGIN_RATE_LIMIT_MAX'
      | 'CMS_LOGIN_RATE_LIMIT_MAX_KEYS'
    >
  >;

const DEFAULT_LOGIN_RATE_LIMIT = {
  windowMs: 900_000,
  max: 10,
  maxKeys: 1_000,
} as const;

/**
 * The message a locked-out operator sees. Distinct from LOGIN_ERROR on
 * purpose, and that is NOT an oracle: it is reached without the credential
 * being examined at all, so it cannot vary with whether the guess was right.
 * The anti-oracle test asserts exactly that — a correct password and a wrong
 * one produce byte-identical responses while throttled.
 *
 * Telling the operator to wait is the whole point. A generic "wrong password"
 * here would send them hunting for a credential problem they do not have.
 */
const LOGIN_THROTTLED = 'Quá nhiều lần thử đăng nhập. Vui lòng đợi ít phút rồi thử lại.';

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
/**
 * CMS-09: where to send an operator after they log back in.
 *
 * `requireSession` bounces an expired document navigation to
 * `/cms/login?next=<where they were going>`, and the login form carries it
 * through as a hidden input so they land back on the page they wanted rather
 * than the dashboard.
 *
 * ALLOW-LISTED RATHER THAN SANITISED. The value arrives in a query string and
 * ends up in a Location header, which is an open-redirect the moment it is
 * trusted: `//evil.example` and `https://evil.example` are both valid targets
 * for a browser and neither is this service. So the rule is positive — it must
 * start with `/cms/` and must not start with `//` — and anything else falls
 * back to the dashboard rather than being repaired. A login link that quietly
 * goes somewhere else is a phishing primitive handed out by the login page
 * itself.
 */
export function safeNextTarget(raw: unknown): string {
  const fallback = '/cms/';
  if (typeof raw !== 'string' || raw === '') return fallback;
  // Reject protocol-relative and absolute URLs outright, plus any attempt to
  // smuggle a scheme past the prefix check.
  if (raw.startsWith('//') || raw.includes('://') || raw.includes('\\')) return fallback;
  if (!raw.startsWith('/cms/')) return fallback;
  // A newline in a Location header splits the response.
  if (/[\r\n]/.test(raw)) return fallback;
  return raw;
}

export function createCmsRouter(
  store: CmsEventStore & CmsAgentStore & CmsPhotoStore,
  cfg: CmsConfig,
  agent: CmsAgentLink,
  opts: { now?: () => number } = {},
): ReturnType<typeof Router> {
  const router = Router();
  const sessions = createSessionStore();
  const cookieName = cfg.CMS_SESSION_COOKIE_NAME || 'cms_session';

  // WR-01's limiter, built INSIDE the factory for the same reason the session
  // store is (and the same reason statusRoute.ts builds its own inside its
  // factory): two routers in one process — which is exactly what a test suite
  // makes — must not share throttle state, or one case's lockout leaks into
  // the next.
  //
  // `now` is injected rather than read from Date.now() internally, matching
  // rateLimiter.ts's own rule, so a test can close a 15-minute window without
  // waiting 15 minutes or installing fake timers.
  const loginLimit = {
    windowMs: cfg.CMS_LOGIN_RATE_LIMIT_WINDOW_MS ?? DEFAULT_LOGIN_RATE_LIMIT.windowMs,
    max: cfg.CMS_LOGIN_RATE_LIMIT_MAX ?? DEFAULT_LOGIN_RATE_LIMIT.max,
    maxKeys: cfg.CMS_LOGIN_RATE_LIMIT_MAX_KEYS ?? DEFAULT_LOGIN_RATE_LIMIT.maxKeys,
  };
  const loginLimitState = createRateLimitState();
  const now = opts.now ?? Date.now;

  // Body parsing for the login form and the JSON dashboard calls. Both
  // parsers are no-ops when a body has already been parsed upstream
  // (body-parser skips when `req._body` is set), so mounting them here is
  // safe alongside index.ts's global parser and keeps this router
  // self-contained for tests.
  router.use(express.urlencoded({ extended: false }));
  router.use(express.json());

  router.get('/login', (req: Request, res: Response) => {
    // Validated on the way IN as well as on the way out, so a hostile ?next=
    // never reaches the rendered form as a hidden field either (CMS-09).
    const wanted = safeNextTarget(req.query.next);
    res.type('html').send(renderCmsLoginPage({ next: wanted === '/cms/' ? undefined : wanted }));
  });

  /**
   * WR-01's throttle, mounted as the FIRST handler on this route rather than
   * inlined into the body below. That placement is the guarantee, not a
   * style choice — it is the same rule statusRoute.ts states for its own
   * limiter, and it buys two things here:
   *
   *  1. A throttled request never reaches `verifyPassword`, so the scrypt
   *     work an attacker is trying to make this service do is never done.
   *     A check placed after verification would bound the guess RATE while
   *     still paying for every guess.
   *  2. The refusal cannot vary with the credential, because the credential
   *     has not been looked at. That is asserted directly: a correct password
   *     and a wrong one produce byte-identical responses while throttled.
   *
   * Counting every attempt rather than only the failures is deliberate. A
   * success-exempt counter lets an attacker who has already guessed the
   * password refresh their own budget, and with a single operator account the
   * legitimate rate is a few logins a day — nowhere near ten per quarter hour.
   */
  router.post('/login', (req: Request, res: Response, next: NextFunction) => {
    const key = clientIp(req) || 'unknown';
    const currentTime = now();
    const { limited } = checkRateLimit(key, currentTime, loginLimitState, loginLimit);

    // Pruned after the decision so the bound holds at the end of every
    // request, including the last of a burst — rateLimiter.ts's reasoning,
    // reused rather than re-derived.
    if (loginLimitState.entries.size > loginLimit.maxKeys) {
      pruneExpired(loginLimitState, currentTime, loginLimit.windowMs, loginLimit.maxKeys);
    }

    if (limited) {
      log.warn(`CMS login throttled for ${key}`);
      res.status(RATE_LIMITED_STATUS).type('html').send(renderCmsLoginPage({ error: LOGIN_THROTTLED }));
      return;
    }
    next();
  }, (req: Request, res: Response) => {
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
    res.redirect(303, safeNextTarget(req.body?.next));
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
