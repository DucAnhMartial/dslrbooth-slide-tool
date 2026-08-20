---
phase: 08-cms-event-display
reviewed: 2026-08-13T02:20:24Z
depth: standard
files_reviewed: 10
files_reviewed_list:
  - mirror-request/src/cms/cmsAuth.ts
  - mirror-request/src/cms/cmsIpGate.ts
  - mirror-request/src/cms/cmsRouter.ts
  - mirror-request/src/cms/uploadHandler.ts
  - mirror-request/scripts/hashCmsPassword.ts
  - mirror-request/src/config.ts
  - mirror-request/.env.example
  - mirror-request/test/cms-access-control.test.ts
  - mirror-request/test/cms-upload-validation.test.ts
  - mirror-request/test/config-validation.test.ts
findings:
  critical: 1
  warning: 5
  info: 2
  total: 8
status: issues_found
---

# Phase 8: Code Review Report — Security Surface (CMS & Event Display)

**Reviewed:** 2026-08-13T02:20:24Z
**Depth:** standard (with targeted empirical probes against the running code — see below)
**Files Reviewed:** 10 (plus `src/app.ts`, `src/index.ts`, `src/security/ipAllowlist.ts`, `src/cms/cmsEventRoutes.ts`, `src/types.ts` read for cross-reference to verify the locked decisions in situ)
**Status:** issues_found

## Summary

This review verified the three locked decisions (D-13 IP-then-password ordering, D-14 hashed single-operator credential with no auto-timeout, D-15 magic-byte upload validation with server-minted filenames) against the actual mounted code in `src/app.ts`, not just the module-level comments, and ran the existing test suite plus several throwaway empirical probes (written to `test/tmp_*.test.ts`, executed, then deleted — no source file was modified and the repo is clean) to confirm claims rather than take the extensive header comments at face value.

**D-13, D-14 (ordering/hashing) and D-15 hold as designed** — I could not construct a case where the IP gate is skipped, where a plaintext password is accepted or logged, or where a non-image payload is written to or served from the uploads directory. The existing `test/cms-access-control.test.ts` and `test/cms-upload-validation.test.ts` suites genuinely pin the behaviors they claim to (they are not vacuous — e.g. "refuses to leave the upload directory even when the target IS a valid image" exists specifically to catch a mutation that would otherwise slip past the magic-byte checks alone, and every rejection case asserts on directory contents, not just response codes).

However, empirical probing turned up one **CRITICAL** defect: a malformed `Cookie` header crashes `parseCookies()` with an uncaught `URIError`, which breaks the exact "one generic refusal" anti-enumeration-oracle property `cmsAuth.ts` documents as its own design goal, on every session-gated CMS route. Five WARNING-level defense-in-depth gaps and two INFO-level items are also recorded below.

## Critical Issues

### CR-01: A malformed `Cookie` header crashes `parseCookies()`, breaking the documented "one generic refusal" oracle protection on every session-gated CMS route

**File:** `mirror-request/src/cms/cmsAuth.ts:155` (thrown), `:199` (uncaught call site in `createRequireSession`); also reachable pre-session via `mirror-request/src/cms/cmsRouter.ts:105` (`POST /cms/logout`)
**Issue:** `parseCookies()` calls `decodeURIComponent(part.slice(index + 1).trim())` on every `key=value` segment of the `Cookie` header with no `try/catch`. `decodeURIComponent` throws a `URIError` on a malformed percent-escape (e.g. a lone `%` or `%zz`). `createRequireSession()` (`cmsAuth.ts:199`) calls `parseCookies(req.headers.cookie)` directly, synchronously, with nothing catching the exception — so it propagates up through Express, which (per its default synchronous-error handling) returns a `500` with its own default error page instead of the module's own documented `401 {"error":"Unauthorized"}`.

I reproduced this empirically against the real `createRequireSession` middleware (throwaway test, not committed):

```
GET /x
Cookie: cms_session=%
```
produces `500 text/html "Internal Server Error"` (with `NODE_ENV=production`) instead of the uniform `401 {"error":"Unauthorized"}` every other "failing the session check" case in this file is documented to produce ("no cookie, an unknown token, a forged token, a destroyed one... any difference between them tells an attacker which half of the guess was right" — `cmsAuth.ts:190-195`). With `NODE_ENV` unset or anything other than `'production'` (which `src/config.ts` never actually enforces — see WR-03 below for the same root cause on a different route), the response body additionally contains a full stack trace with absolute filesystem paths:

```
URIError: URI malformed
    at decodeURIComponent (<anonymous>)
    at parseCookies (/opt/.../mirror-request/src/cms/cmsAuth.ts:155:16)
    at /opt/.../mirror-request/src/cms/cmsAuth.ts:199:19
    ...
```

This is trivially reachable by any client that can reach a session-gated `/cms/*` route (i.e. anyone inside `CMS_IP_WHITELIST`, exactly the audience D-13 intends to reach a password prompt) — it requires no valid credentials and no valid session token, just a single malformed `Cookie` header. It is *also* reachable via `POST /cms/logout`, which is one of the two routes explicitly documented as "reachable WITHOUT a session" (`cmsRouter.ts:35`), so this specific crash needs no prior authentication step at all, only network reachability.

This qualifies as CRITICAL under this review's own classification rubric ("crashes... unhandled exception," and a documented anti-oracle security control that is provably defeated) rather than WARNING, because it is a concrete, reproduced defect in the authentication layer's error handling, not a hypothetical.

**Fix:** Wrap the `decodeURIComponent` call (or the whole loop) in a `try/catch` that skips the unparseable segment rather than propagating, mirroring the fail-closed discipline already used everywhere else in this file (`verifyPassword`, `safeEqual`):
```ts
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
      // A malformed percent-escape in one cookie must not crash the request —
      // treat it as absent, exactly as createRequireSession treats a missing
      // or unknown token: fail closed, not fail loud.
      continue;
    }
  }
  return out;
}
```

## Warnings

### WR-01: No rate limiting or lockout on `POST /cms/login`

**File:** `mirror-request/src/cms/cmsRouter.ts:74-102`
**Issue:** The login handler runs `safeEqual()`/`verifyPassword()` for every attempt with no counter, backoff, or lockout. `SCRYPT_PARAMS` is deliberately `N=2^14` rather than OWASP's `2^17` (documented, and a reasonable tradeoff given `maxmem`), which makes each guess cheaper than a hardened login would allow. The codebase already has a precedent for exactly this kind of protection — `STATUS_RATE_LIMIT_WINDOW_MS`/`STATUS_RATE_LIMIT_MAX`/`STATUS_RATE_LIMIT_MAX_KEYS` in `src/config.ts` gate the status-polling route — but no equivalent exists for the CMS login route. D-13's IP allow-list is the first line of defense, but within a whitelisted subnet (e.g. a `10.0.0.*`-style CIDR entry, or any device sharing the venue LAN segment that happens to fall in the configured range) an attacker gets unlimited online guesses against the single operator credential.
**Fix:** Add a small per-source-IP attempt counter with an increasing delay or a temporary lockout after N failures, mirroring the existing `STATUS_RATE_LIMIT_*` pattern already established in `src/status/statusRoute.ts`/`src/config.ts`.

### WR-02: Session store has no size cap and sessions never expire

**File:** `mirror-request/src/cms/cmsAuth.ts:112-144`
**Issue:** `createSessionStore()`'s `Map` grows by one entry on every successful login and is never pruned — `isValid()`/`destroy()` only remove entries on an explicit `/logout`. D-14's "no auto-timeout" decision is about *not ejecting the operator mid-event*, which is reasonable, but it does not by itself justify an *unbounded* store: over a multi-day deployment, or any workflow where the operator's browser doesn't retain the cookie (private browsing, a second device, a browser restart) and they log in repeatedly, the process accumulates session tokens forever until restart. The codebase already caps a structurally identical unbounded-growth risk elsewhere (`STATUS_RATE_LIMIT_MAX_KEYS` bounds the rate-limiter's per-IP map); no equivalent cap exists here.
**Fix:** Cap the map size (evict the oldest `createdAt` entry once a generous ceiling is hit) or expire sessions after a long but bounded absolute lifetime (e.g. 24-72h) — long enough to never eject an operator mid-event, short enough to bound memory growth:
```ts
const MAX_SESSIONS = 100; // generous for a single-operator console
create(username: string): string {
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (oldest) sessions.delete(oldest[0]);
  }
  const token = randomBytes(SESSION_TOKEN_BYTES).toString('hex');
  sessions.set(token, { username, createdAt: Date.now() });
  return token;
}
```

### WR-03: A grossly oversized `POST /cms/api/assets` body breaks the endpoint's own "one shape for every failure" invariant, and can leak filesystem paths if `NODE_ENV` is misconfigured

**File:** `mirror-request/src/app.ts:71-74`, `mirror-request/src/cms/uploadHandler.ts:168-170`
**Issue:** `uploadHandler.ts`'s own comment states the design goal explicitly: "One refusal for every way an upload can fail... Distinct messages here would tell a caller which of its guesses was closer." That invariant is genuinely upheld for every failure *inside* `handleAssetUpload` (verified — malformed base64, wrong signature, oversize-after-decode all return the identical `400 {"error":"Invalid upload"}` shape, and the test suite proves it). But the invariant is **not** upheld for a request whose *encoded* body exceeds the scoped `express.json({ limit: ... })` mounted in `app.ts` (`Math.ceil(CMS_UPLOAD_MAX_BYTES * 4/3) + 65_536`, ~6.7MB by default): that request never reaches the handler at all — `body-parser` rejects it with a `413 PayloadTooLargeError` and Express's *default* error page, a different status code, a different `Content-Type` (`text/html`), and a different body shape than every other refusal on this endpoint.
I verified empirically that this default error page includes a full stack trace with absolute filesystem paths (`/opt/.../node_modules/raw-body/index.js:163:17`, etc.) whenever `NODE_ENV` is not exactly `'production'` at runtime — and `src/config.ts` never *requires* `NODE_ENV=production` to be set; it only branches additional validation on it if it happens to be set. An operator who forgets to export `NODE_ENV=production` in the process environment gets both a weaker config-validation posture *and* a stack-trace leak on this route (see also CR-01, same root cause: nothing in this app registers a JSON-aware error-handling middleware, so every synchronous/parser-level throw falls through to Express's default HTML error page).
**Fix:** Add an explicit error-handling middleware for the `/cms/api/assets` path that catches `PayloadTooLargeError`/`entity.too.large` and returns the same generic `400 {"error":"Invalid upload"}` shape the rest of the route uses, independent of `NODE_ENV`:
```ts
app.use('/cms/api/assets', (err: Error & { type?: string }, _req: Request, res: Response, next: NextFunction) => {
  if (err.type === 'entity.too.large') {
    res.status(400).json({ error: 'Invalid upload' });
    return;
  }
  next(err);
});
```

### WR-04: `scripts/hashCmsPassword.ts` reads the master password from `argv`, exposing it via shell history and `ps`

**File:** `mirror-request/scripts/hashCmsPassword.ts:26-27`
**Issue:** The file's own header states the goal precisely: "The password is read from argv, not prompted and not stored. It never touches disk." That's true of *disk*, but `process.argv[2]` is visible in plaintext to: (a) the invoking shell's history file (`.bash_history`/`.zsh_history`) unless the operator remembers to prefix the command with a space or otherwise suppress history, and (b) any other local process via `ps aux` / `/proc/<pid>/cmdline` for the (brief) window the script runs. Both are more commonly-checked attack surfaces on a shared or multi-user machine than "touches disk," and neither is addressed in the file's threat reasoning.
**Fix:** Prompt for the password on stdin (with terminal echo disabled) instead of accepting it as a positional argument:
```ts
import { createInterface } from 'readline';
function readPasswordFromStdin(): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write('Password: ');
    // ...disable TTY echo, read one line, restore echo, resolve...
  });
}
```

### WR-05: The `/cms/api/assets` body-size override is mounted ahead of the CMS IP gate, so any network-reachable client — whitelisted or not — pays the full body-parse cost before authorization runs

**File:** `mirror-request/src/app.ts:71-74` vs `:138-149`
**Issue:** `app.use('/cms/api/assets', express.json({ limit: ... }))` is the very first middleware registered in `createApp()`, ahead of `createMirrorReceiver`, `/display-screen`, the status router, and — critically — `createCmsIpGate(config.CMS_IP_WHITELIST)` (mounted later at line 149). I verified empirically that a request from a *non-whitelisted* IP to `POST /cms/api/assets` still gets its full JSON body parsed and buffered (up to ~6.7MB) by this scoped parser before the request ever reaches the IP gate; the final response is correctly `403 {"error":"Forbidden"}` (D-13's ultimate access decision is not violated), but the computational and memory cost of parsing an attacker-controlled body up to the raised limit is paid regardless of whether the peer is allowed to be there at all. This is the inverse of the ordering principle the same file's own comment insists on for the IP-gate-then-session pairing a few lines below ("Route order... is load-bearing... Swapping these two arguments leaves a CMS that still demands a password... while having silently deleted the network control").
**Fix:** Scope the raised body-size limit to run *after* the IP check, or duplicate a lightweight IP check ahead of the parser mount so a non-whitelisted peer is rejected before its body is read at all:
```ts
app.use('/cms/api/assets', (req, res, next) => {
  if (!isWhitelisted(clientIp(req), config.CMS_IP_WHITELIST)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}, express.json({ limit: Math.ceil(config.CMS_UPLOAD_MAX_BYTES * (4 / 3)) + 65_536 }));
```

## Info

### IN-01: `CMS_PASSWORD_HASH`'s startup check validates presence, not shape

**File:** `mirror-request/src/config.ts:33-39, 50`
**Issue:** `required('CMS_PASSWORD_HASH', 'replace-with-cms-password-hash')` only checks the value is non-empty and not the literal placeholder. A value that isn't `salt:hash` hex (e.g. an operator accidentally pastes a plaintext password, or truncates the copy-paste) passes startup validation silently. `verifyPassword()` then fails closed at every login attempt (safe — confirmed by the `try/catch` and the `!saltHex || !hashHex` guard), but the operator has no startup-time signal that their `.env` value is malformed; they only discover it when login mysteriously never succeeds.
**Fix:** Extend the `required()` check for this one key with a format assertion, e.g. `/^[0-9a-f]+:[0-9a-f]+$/.test(val)`, and push a distinct error message ("CMS_PASSWORD_HASH is not a salt:hash pair — mint it with npm run cms:hash-password") when it fails.

### IN-02: `isWhitelisted()`'s exact-string IP match does not normalize IPv6-mapped IPv4 addresses

**File:** `mirror-request/src/security/ipAllowlist.ts:31-43` (shared by `createCmsIpGate`, `/display-screen`, and `/uploads`)
**Issue:** This is pre-existing shared infrastructure (Phase 5), not new in Phase 8, but Phase 8's `CMS_IP_WHITELIST` reuses it verbatim for the CMS's network layer (D-13), so a gap here is a gap in D-13's enforcement too. `isWhitelisted('::ffff:10.0.0.5', ['10.0.0.5'])` returns `false` because the comparison is a plain `ip === allowed` (or a `.*` prefix match) with no IPv4-mapped-IPv6 normalization. Under the default `HOST=0.0.0.0` (an IPv4-only bind — confirmed via `src/config.ts:99`), Node's `socket.remoteAddress` for an IPv4 peer is the plain dotted form, so this does not manifest with the shipped default. It becomes a real operational gap only if an operator ever rebinds `HOST` to `::` for dual-stack listening.
**Fix:** Not urgent given the current default, but worth a one-line normalization (`ip.replace(/^::ffff:/, '')`) if `HOST` is ever expected to support dual-stack binding, plus a comment at the `HOST` config default explaining why `0.0.0.0` (not `::`) is load-bearing for this address-matching assumption.

---

_Reviewed: 2026-08-13T02:20:24Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
