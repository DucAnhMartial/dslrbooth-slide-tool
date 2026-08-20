import { labelLogger } from '../logging/logger';

const log = labelLogger('photo');

/**
 * Turns dslrBooth's share LINK into the image FILE behind it.
 *
 * WHY THIS EXISTS. `queueService.ts`'s own comment has said since Phase 7 that
 * `param2` carries "the shared URL e.g. https://fotoshare.co/i/1t1vcs3", and
 * D-10 stored exactly that. Then the Phase 8 room screen put it in an
 * `<img src>`. Measured against the operator's booth on 2026-08-13:
 *
 *   https://fotoshare.co/i/3knbmax         -> text/html,  16 KB   (a page)
 *   https://cdn-bz-op.fotoshare.co/...jpg  -> image/jpeg, 314 KB  (the photo)
 *
 * The wall drew a broken image on every capture. One field was serving two
 * contradictory purposes: the guest's notification wants a PAGE they can open
 * and download from — which is why `photo_url` must keep carrying the share
 * link, NOT-01/NOT-02 depend on it — and the screen wants a FILE.
 *
 * The file's address is already published on the share page in `og:image`,
 * the tag that exists so a machine can find the picture. This module goes and
 * reads it.
 *
 * FAILURE IS ORDINARY HERE. A third party can be slow, be down, change its
 * markup, or stop serving a photo months later; D-10 accepted that cost when
 * it chose to store a reference rather than bytes. Every function here fails
 * to `undefined`, never throws at its caller, and the caller records the
 * photo either way — a resolution failure must never cost the operator a row
 * in their history.
 */

/** Read at most this much of the share page. An og:image lives in <head>. */
const MAX_BODY_BYTES = 256 * 1024;

/** Short on purpose: this runs while a guest is walking away from a booth. */
export const RESOLVE_TIMEOUT_MS = 4_000;

/**
 * Whether this service is willing to make a server-side request to `raw`.
 *
 * SSRF is the reason this function exists. The URL arrives from the Agent, and
 * resolving it means THIS service — which sits inside the venue LAN, behind
 * the allow-lists, next to the database — issues a request to whatever address
 * it names. A share link pointing at `127.0.0.1`, `169.254.169.254`, or the
 * operator's own subnet would turn the room screen's photo pipeline into a
 * request forwarder for anything that can reach the booth.
 *
 * Note what is NOT claimed: this is a literal-address check, so a public
 * hostname whose DNS answer is a private address still passes. Closing that
 * needs resolution-time pinning, which is a different piece of work; the
 * bound here is the cheap 90% and is stated rather than implied.
 */
export function isFetchableShareUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host === '::1' || host === '0.0.0.0') return false;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 0 || a === 10) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
  }
  return true;
}

/**
 * Pulls the image address out of share-page HTML.
 *
 * Separated from the fetch so it can be tested against fixture markup rather
 * than a live third-party host — a suite that reached out to fotoshare.co
 * would go red whenever someone's wifi did.
 *
 * The returned value ends up in an `<img src>` on every television in the
 * room, so it is checked to be http(s) here as well: a `javascript:` or
 * `data:` og:image is not a fotoshare concern, it is what a spoofed or
 * compromised share host would serve.
 */
export function extractDirectImageUrl(html: string): string | undefined {
  const patterns = [
    /<meta[^>]+property\s*=\s*["']og:image["'][^>]*content\s*=\s*["']([^"']+)["']/i,
    /<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:image["']/i,
    /<meta[^>]+name\s*=\s*["']twitter:image["'][^>]*content\s*=\s*["']([^"']+)["']/i,
    /<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]*name\s*=\s*["']twitter:image["']/i,
  ];
  for (const pattern of patterns) {
    const found = html.match(pattern)?.[1]?.trim();
    if (!found) continue;
    if (!/^https?:\/\//i.test(found)) return undefined;
    return found;
  }
  return undefined;
}

/**
 * Fetches `shareUrl` and returns the image address it advertises.
 *
 * Returns `undefined` for every failure — refused address, timeout, non-2xx,
 * non-HTML, no tag — and logs one line saying which. The caller treats that
 * as "no direct URL yet" and the screen falls back to the share link, which
 * renders the G4 placeholder already designed for an image that will not load.
 */
export async function resolveDirectImageUrl(
  shareUrl: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<string | undefined> {
  if (!isFetchableShareUrl(shareUrl)) {
    log.warn(`Refusing to resolve a share URL this service will not fetch: ${shareUrl}`);
    return undefined;
  }

  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? RESOLVE_TIMEOUT_MS);

  try {
    const res = await doFetch(shareUrl, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) {
      log.warn(`Share page for ${shareUrl} answered ${res.status}; no direct image URL`);
      return undefined;
    }
    const body = (await res.text()).slice(0, MAX_BODY_BYTES);
    const direct = extractDirectImageUrl(body);
    if (!direct) {
      log.warn(`Share page for ${shareUrl} advertised no usable og:image`);
      return undefined;
    }
    return direct;
  } catch (err) {
    // An abort lands here too, which is the point: a slow third party must
    // cost this service one log line, never a hung capture path.
    log.warn(`Could not resolve ${shareUrl}: ${(err as Error).message}`);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
