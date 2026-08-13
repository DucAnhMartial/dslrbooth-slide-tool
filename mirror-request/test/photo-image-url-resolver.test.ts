import { describe, it, expect } from 'vitest';
import { extractDirectImageUrl, isFetchableShareUrl } from '../src/display/imageUrlResolver';

// ---------------------------------------------------------------------------
// dslrBooth's `param2` is a SHARE PAGE, not an image.
//
// `queueService.ts:896` has said so since Phase 7 — "param2 = the shared URL
// e.g. https://fotoshare.co/i/1t1vcs3" — and Phase 8's D-10 stored exactly
// that string, then Phase 8's room screen put it in an `<img src>`. Measured
// against the operator's own booth on 2026-08-13:
//
//   https://fotoshare.co/i/3knbmax          -> text/html, 16580 bytes
//   https://cdn-bz-op.fotoshare.co/...jpg   -> image/jpeg, 314868 bytes
//
// The browser fetches the first, gets HTML, and draws a broken image. One
// field was being asked to serve two contradictory purposes: the guest's
// notification wants a PAGE they can open and download from, and the wall
// wants a FILE. Both are right; they are not the same string.
//
// The direct URL is already on the share page, in `og:image` — the tag that
// exists precisely so a machine can find the picture. This module extracts
// it. The extraction is separated from the fetching so it can be tested
// against fixture HTML rather than against a live third-party host, which
// would make this suite fail whenever someone's wifi did.
// ---------------------------------------------------------------------------

const REAL_SHARE_PAGE_HEAD = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta property="og:image" content="https://cdn-bz-op.fotoshare.co/b/833cf/-Ozk5IGXQWGPycmUJiEh/20260813_135523_092_1x.jpg">
    <meta property="og:image:width" content="600">
    <meta property="og:image:height" content="1800">
</head>`;

describe('extractDirectImageUrl — finding the picture on a share page', () => {
  it('pulls og:image out of the real fotoshare markup', () => {
    expect(extractDirectImageUrl(REAL_SHARE_PAGE_HEAD)).toBe(
      'https://cdn-bz-op.fotoshare.co/b/833cf/-Ozk5IGXQWGPycmUJiEh/20260813_135523_092_1x.jpg',
    );
  });

  it('accepts single quotes and reversed attribute order', () => {
    // No promise is made about a third party's exact markup. `content` before
    // `property` is legal HTML and a template change away.
    const html = `<meta content='https://cdn.example/a.jpg' property='og:image'>`;
    expect(extractDirectImageUrl(html)).toBe('https://cdn.example/a.jpg');
  });

  it('falls back to twitter:image when og:image is absent', () => {
    const html = `<meta name="twitter:image" content="https://cdn.example/b.png">`;
    expect(extractDirectImageUrl(html)).toBe('https://cdn.example/b.png');
  });

  it('returns undefined when the page advertises no image at all', () => {
    expect(extractDirectImageUrl('<html><head><title>hi</title></head></html>')).toBeUndefined();
  });

  it('refuses a non-http(s) og:image rather than putting it in an src', () => {
    // `javascript:` and `data:` in an og:image are not a real fotoshare
    // concern; they are what a compromised or spoofed share host would use,
    // and this value ends up in an `<img src>` on every television.
    for (const bad of ['javascript:alert(1)', 'data:image/svg+xml;base64,AAAA', 'file:///etc/passwd']) {
      expect(extractDirectImageUrl(`<meta property="og:image" content="${bad}">`)).toBeUndefined();
    }
  });

  it('ignores an empty content attribute', () => {
    expect(extractDirectImageUrl('<meta property="og:image" content="">')).toBeUndefined();
  });
});

describe('isFetchableShareUrl — what this service is willing to go and get', () => {
  it('accepts an ordinary https share link', () => {
    expect(isFetchableShareUrl('https://fotoshare.co/i/3knbmax')).toBe(true);
  });

  it('accepts http, because a booth on a LAN may not have TLS', () => {
    expect(isFetchableShareUrl('http://fotoshare.co/i/3knbmax')).toBe(true);
  });

  it('refuses schemes that are not http(s)', () => {
    for (const bad of ['file:///etc/passwd', 'ftp://x/y', 'javascript:alert(1)', 'data:text/html,x']) {
      expect(isFetchableShareUrl(bad)).toBe(false);
    }
  });

  it('refuses loopback and link-local hosts', () => {
    // SSRF: this URL arrives from the Agent, and the service fetches it
    // server-side from inside the venue LAN. A share link pointing at
    // 127.0.0.1 or 169.254.169.254 would make this service fetch its own
    // internals on someone else's behalf.
    for (const bad of [
      'http://127.0.0.1/x',
      'http://localhost/x',
      'http://[::1]/x',
      'http://169.254.169.254/latest/meta-data/',
      'http://0.0.0.0/x',
    ]) {
      expect(isFetchableShareUrl(bad)).toBe(false);
    }
  });

  it('refuses private ranges', () => {
    for (const bad of ['http://10.0.0.5/x', 'http://192.168.12.100/x', 'http://172.16.4.4/x']) {
      expect(isFetchableShareUrl(bad)).toBe(false);
    }
  });

  it('refuses a malformed URL rather than throwing', () => {
    expect(isFetchableShareUrl('not a url')).toBe(false);
    expect(isFetchableShareUrl('')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Non-vacuity: the guard must not be "refuse everything".
  // -------------------------------------------------------------------------

  it('accepts the public CDN host the real photos actually live on', () => {
    expect(isFetchableShareUrl('https://cdn-bz-op.fotoshare.co/b/833cf/x/y_1x.jpg')).toBe(true);
  });
});
