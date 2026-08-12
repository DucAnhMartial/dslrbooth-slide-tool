/**
 * Turn whatever URL the booth handed us into one an `<img src>` can render.
 *
 * Why this exists: dslrBooth's `file_upload` trigger reports the photo's
 * *share page*, not the photo. Measured against a real booth on 2026-08-12:
 *
 *   https://fotoshare.co/i/2hbhm1f
 *     -> HTTP 200, content-type: text/html
 *   <meta property="og:image" content="https://cdn-bz-op.fotoshare.co/b/833cf/.../20260812_133725_288.jpg">
 *     -> HTTP 200, content-type: image/jpeg, 522164 bytes
 *
 * `web-slide` renders the value with `<img src="${imageUrl}">`, so the share
 * page produced a broken image for every guest while the pipeline itself was
 * working perfectly. No URL rewrite rule finds the real file — `.jpg`, `/p/`
 * and `/photo/` were each tried against the live service and all three return
 * HTML. Only the meta tag carries it.
 *
 * Deliberately generic rather than fotoshare-specific: `og:image` is the
 * standard any share page publishes, so a different booth vendor or a changed
 * sharing target keeps working without another patch here.
 *
 * **Never throws, never returns empty.** A resolution failure returns the
 * original URL rather than nothing: the guest's name still reaches the
 * slideshow and the share link is still recorded, which beats dropping the
 * notification entirely.
 *
 * This module deliberately does NOT log. It returns an optional `warning` for
 * the caller to emit through its own logger — importing `notifyLogger` here
 * would make `notificationService` <-> `resolveImageUrl` a circular import
 * that happens to work only because the logger is used inside a function.
 */

const DIRECT_IMAGE_PATH = /\.(jpe?g|png|gif|webp|avif|bmp)$/i;

/** `<meta property="og:image" content="...">` in either attribute order. */
const OG_IMAGE_PATTERNS = [
  /<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image["']/i,
];

/** Bytes of the page to inspect — the meta block sits near the top. */
const MAX_HTML_BYTES = 256 * 1024;

export interface ResolveResult {
  /** Always a usable value: the resolved image, or the input unchanged. */
  url: string;
  /** Present only when resolution was attempted and did not succeed. */
  warning?: string;
}

export interface ResolveOptions {
  timeoutMs?: number;
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export async function resolveDisplayableImageUrl(
  url: string,
  opts: ResolveOptions = {},
): Promise<ResolveResult> {
  if (!url) return { url };

  // A URL that already names an image file needs no network call at all.
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return { url }; // not a URL we can reason about — hand it back untouched
  }
  if (DIRECT_IMAGE_PATH.test(pathname)) return { url };

  const timeoutMs = opts.timeoutMs ?? 5_000;
  const doFetch = opts.fetchImpl ?? fetch;

  try {
    const response = await doFetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { url, warning: `share page returned HTTP ${response.status}` };
    }

    const contentType = response.headers.get('content-type') ?? '';
    // Already an image despite the extensionless path — nothing to extract.
    if (contentType.startsWith('image/')) return { url };
    if (!contentType.includes('html')) {
      return { url, warning: `unexpected content-type '${contentType}'` };
    }

    const html = (await response.text()).slice(0, MAX_HTML_BYTES);
    for (const pattern of OG_IMAGE_PATTERNS) {
      const match = pattern.exec(html);
      if (match?.[1]) {
        // Resolve against the page so a relative og:image still works.
        try {
          return { url: new URL(match[1], url).toString() };
        } catch {
          return { url: match[1] };
        }
      }
    }
    return { url, warning: 'share page carried no og:image' };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { url, warning: `fetch failed (${reason})` };
  }
}
