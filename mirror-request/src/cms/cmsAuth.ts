import { Request, Response, NextFunction, RequestHandler } from 'express';
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';

/**
 * D-14's password and session layer — the second of the CMS's two gates.
 *
 * There is no in-repo password-hashing precedent, so this file is new code;
 * but the two security-critical primitives it needs (a KDF and a constant-time
 * comparison) are Node builtins, not hand-rolled, and the comparison idiom is
 * copied from `agentServer.ts:46-57` rather than reinvented. Zero new npm
 * dependencies (RESEARCH: scrypt replaces bcrypt/argon2, which both need a
 * native or WASM binding for a single-account login).
 */

/**
 * N = 2^14, NOT OWASP's 2^17.
 *
 * This is a measured constraint, not a preference: crypto.scryptSync's default
 * `maxmem` is 32MB, and N=131072 (2^17) with r=8 exceeds it and THROWS
 * "Invalid scrypt params: memory limit exceeded" (RESEARCH verified this by
 * direct execution). Raising N here without also raising `maxmem` does not
 * harden the login — it breaks it outright, and it breaks it at verify time,
 * on the operator's laptop, mid-event.
 *
 * 2^14 is a defensible target for this specific credential: a single account
 * on a LAN-only service that is already behind an IP allow-list and is not
 * reachable from the internet. OWASP's 2^17 figure assumes an
 * internet-exposed, high-value credential store. If this service ever gains a
 * public surface, raise BOTH N and maxmem together and re-mint the hash.
 */
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const SESSION_TOKEN_BYTES = 32;

/**
 * Mints `salt:hash` (both hex). Used by the offline
 * `npm run cms:hash-password` helper and by tests — never by a request
 * handler, because the service must never receive a plaintext password to
 * hash in the first place (D-14, T-08-06).
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const derived = scryptSync(password, salt, KEY_LENGTH, SCRYPT_PARAMS);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

/**
 * Constant-time verification against a stored `salt:hash`.
 *
 * The length guard and the try/catch are both copied deliberately from
 * `agentServer.ts:46-57`: `timingSafeEqual` THROWS on a length mismatch
 * rather than returning false, so without the guard a malformed stored hash
 * would surface as an uncaught exception on the login path instead of a clean
 * rejection. Returns a bare boolean and logs nothing — neither the presented
 * password nor the stored digest may ever appear in a message, an error, or a
 * thrown value.
 */
export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [saltHex, hashHex] = stored.split(':');
    if (!saltHex || !hashHex) return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = scryptSync(password, salt, expected.length, SCRYPT_PARAMS);
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Constant-time string comparison for the username and for session tokens.
 * Same shape as verifyPassword's guard, for the same reason: `===` on strings
 * short-circuits at the first differing byte and leaks how many leading bytes
 * were correct.
 */
export function safeEqual(a: string, b: string): boolean {
  try {
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

export interface SessionStore {
  create(username: string): string;
  isValid(token: string): boolean;
  destroy(token: string): void;
  size(): number;
}

/**
 * D-14: sessions live in memory, in a Map built per router instance — never a
 * SQLite table and never module scope.
 *
 * In memory because CMS-03's durability requirement names event configuration
 * and photo history, not sessions: a service restart already requires an
 * operator to be present, so losing the session then is correct behaviour
 * rather than a gap. Per instance because two routers built in one process
 * (which is exactly what a test suite does) must not share session state.
 *
 * There is no inactivity timeout, deliberately — an event runs for hours and
 * ejecting the operator to a login screen mid-event is operationally worse
 * than a lingering session on an IP-allow-listed LAN. Logout is manual.
 *
 * THE CAP BELOW IS NOT A TIMEOUT AND MUST NOT BECOME ONE (Phase 8 code
 * review, WR-02). The Map grew by one entry per successful login and shrank
 * only on an explicit /logout, so a browser restart, a private window, a
 * second device — anything that loses the cookie without logging out — left a
 * token behind for the life of the process. That is unbounded growth, and it
 * is a different problem from session lifetime. Bounding the SIZE fixes it
 * without touching D-14; adding an expiry would fix it by breaking D-14.
 * `local-store-persistence`-style memory pressure is the concern here, not
 * stale credentials.
 */
export const MAX_SESSIONS = 100;

export function createSessionStore(): SessionStore {
  const sessions = new Map<string, { username: string; createdAt: number }>();
  return {
    create(username: string): string {
      // Oldest-first eviction. With a single operator account the realistic
      // ceiling is a handful of live sessions, so reaching 100 already means
      // something unusual is happening and the oldest token is the one least
      // likely to be the tab currently in front of the operator.
      //
      // Insertion order would give the same answer far more cheaply, but
      // createdAt is asserted on rather than assumed: a Map that ever gained
      // a re-insertion would silently change what "oldest" means.
      if (sessions.size >= MAX_SESSIONS) {
        let oldestToken: string | undefined;
        let oldestAt = Infinity;
        for (const [token, entry] of sessions) {
          if (entry.createdAt < oldestAt) {
            oldestAt = entry.createdAt;
            oldestToken = token;
          }
        }
        if (oldestToken !== undefined) sessions.delete(oldestToken);
      }
      const token = randomBytes(SESSION_TOKEN_BYTES).toString('hex');
      sessions.set(token, { username, createdAt: Date.now() });
      return token;
    },
    /**
     * Scans with safeEqual rather than calling `sessions.has(token)`. A Map
     * lookup is a hash comparison whose timing varies with the presented
     * value; with a single operator account the session set is tiny, so a
     * linear constant-time scan costs nothing measurable and keeps the token
     * check the same shape as every other secret comparison in this repo.
     */
    isValid(token: string): boolean {
      if (!token) return false;
      let found = false;
      for (const known of sessions.keys()) {
        if (safeEqual(known, token)) found = true;
      }
      return found;
    },
    destroy(token: string): void {
      for (const known of [...sessions.keys()]) {
        if (safeEqual(known, token)) sessions.delete(known);
      }
    },
    size(): number {
      return sessions.size;
    },
  };
}

/**
 * Minimal `Cookie:` header parse — no cookie-parser dependency for one key.
 *
 * `decodeURIComponent` THROWS on a malformed percent-sequence (`%`, `%zz`, a
 * truncated multi-byte run), and a `Cookie` header is attacker-controlled
 * input on every request. Left uncaught, that `URIError` propagated out of
 * `createRequireSession` and out of the pre-session `/logout` route into
 * Express's default handler: a 500 where this module promises a uniform 401,
 * carrying a stack trace and absolute filesystem paths whenever `NODE_ENV` is
 * not exactly 'production'. The 401/500 split is itself the oracle the
 * uniform-refusal design below exists to close (Phase 8 code review, CR-01).
 *
 * An undecodable pair is DROPPED, not fatal to the whole header. Discarding
 * every cookie because one unrelated one was malformed would log the operator
 * out — a second failure wearing the first one's clothes.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      // Undecodable value. A cookie that cannot be read is a cookie that was
      // not sent, which every caller here already handles.
      continue;
    }
  }
  return out;
}

/**
 * The Set-Cookie value for a new session.
 *
 * NO `Secure` ATTRIBUTE IS SET, AND THAT IS DELIBERATE. Nothing in this
 * deployment terminates TLS anywhere — the service is plain HTTP on a venue
 * LAN (see OPS-RUNBOOK). A `Secure` cookie would simply never be sent back by
 * the browser over http://, so the operator could never log in: a
 * "secure-by-default" flag that produces a total outage and no security.
 *
 * The honest consequence, stated rather than papered over: the session cookie
 * crosses the LAN in the clear and is readable by anything that can observe
 * that traffic. `CMS_IP_WHITELIST` BOUNDS that exposure to already-trusted LAN
 * addresses — it does not eliminate it. This is an accepted risk (threat
 * register T-08-04), not an oversight. If TLS is ever terminated in front of
 * this service, add `Secure` here at that time.
 *
 * `HttpOnly` blocks script access to the token; `SameSite=Lax` is the CSRF
 * control for the mutating /cms routes (T-08-05), chosen over a CSRF-token
 * library because this is a single-operator console with no public write
 * surface. `Path=/cms` keeps the cookie off every other route this service
 * serves, including the room screen.
 */
export function buildSessionCookie(cookieName: string, token: string): string {
  return `${cookieName}=${token}; HttpOnly; SameSite=Lax; Path=/cms`;
}

export function buildClearedSessionCookie(cookieName: string): string {
  return `${cookieName}=; HttpOnly; SameSite=Lax; Path=/cms; Max-Age=0`;
}

/**
 * One generic refusal for every way of failing the session check — no cookie,
 * an unknown token, a forged token, a destroyed one. Mirrors
 * `statusRoute.ts`'s `genericNotFound()` discipline: two shapes here would be
 * two failure modes waiting to drift apart, and any difference between them
 * tells an attacker which half of the guess was right.
 */
/**
 * CMS-09: what an expired session LOOKS like.
 *
 * Sessions live in memory and have no inactivity timeout (see the store's
 * header), so the way an operator actually loses one is a service restart —
 * a deploy, a crash, a reboot. That part is correct and stays. What was wrong
 * is what happened next: every unauthenticated request got `401 {"error":
 * "Unauthorized"}`, INCLUDING a plain browser navigation, so an operator who
 * came back to the CMS after a restart was shown raw JSON on a white page
 * with no way forward and nothing telling them to log in again.
 *
 * The response now depends on what asked:
 *   - a document navigation gets 302 to the login page, carrying where it was
 *     going so the operator lands back there instead of on a dashboard;
 *   - a fetch/XHR keeps 401 JSON, because a redirect to an HTML login form is
 *     useless to a caller expecting JSON — the page's own handler turns that
 *     401 into a navigation (see cmsEventPages.ts's shared in-flight script).
 *
 * `Accept` is the discriminator rather than a path prefix: it is what
 * distinguishes the two callers, and it keeps working if an API route is ever
 * mounted outside /cms/api.
 */
export function createRequireSession(sessions: SessionStore, cookieName: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = parseCookies(req.headers.cookie)[cookieName] ?? '';
    if (!sessions.isValid(token)) {
      const accept = String(req.headers.accept ?? '');
      const wantsHtml = accept.includes('text/html');
      // Never redirect a mutating request: replaying a POST as a GET after
      // login would be a silent, unasked-for repeat of whatever it was.
      if (wantsHtml && req.method === 'GET') {
        // originalUrl, not url: this middleware is mounted under /cms, and the
        // mount-relative path would send the operator to the wrong place.
        const next = encodeURIComponent(req.originalUrl);
        res.redirect(302, `/cms/login?next=${next}`);
        return;
      }
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };
}
