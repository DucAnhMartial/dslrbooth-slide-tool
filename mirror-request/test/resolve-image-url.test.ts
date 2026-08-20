import { describe, expect, it, vi } from 'vitest';
import { resolveDisplayableImageUrl } from '../src/notifications/resolveImageUrl';

/**
 * Cover for a defect that only a real booth could reveal: the pipeline
 * delivered a notification successfully, and the guest still saw a broken
 * image, because dslrBooth reports the photo's SHARE PAGE rather than the
 * photo. Captured live on 2026-08-12.
 *
 * The share page below is the real response shape from
 * `https://fotoshare.co/i/2hbhm1f`, whose og:image pointed at a genuine
 * 522164-byte image/jpeg on the fotoshare CDN.
 */

const SHARE_URL = 'https://fotoshare.co/i/2hbhm1f';
const CDN_URL = 'https://cdn-bz-op.fotoshare.co/b/833cf/-Ozk5IGXQWGPycmUJiEh/20260812_133725_288.jpg';

const REAL_SHARE_PAGE = `<!DOCTYPE html><html><head>
<meta property="og:image" content="${CDN_URL}" />
<meta property="og:image:width" content="1182" />
<meta property="og:image:height" content="1772" />
</head><body>...</body></html>`;

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=UTF-8' } });
}

describe('resolveDisplayableImageUrl — dslrBooth hands us a share page, not a photo', () => {
  it('extracts the real image from the share page og:image tag', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse(REAL_SHARE_PAGE));

    const result = await resolveDisplayableImageUrl(SHARE_URL, { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result.url).toBe(CDN_URL);
    expect(result.warning).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('makes NO network call for a URL that already names an image file', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse(REAL_SHARE_PAGE));

    const result = await resolveDisplayableImageUrl(CDN_URL, { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result.url).toBe(CDN_URL);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('handles the reversed attribute order some pages emit', async () => {
    const page = `<html><head><meta content="${CDN_URL}" property="og:image"></head></html>`;
    const fetchImpl = vi.fn(async () => htmlResponse(page));

    const result = await resolveDisplayableImageUrl(SHARE_URL, { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result.url).toBe(CDN_URL);
  });

  it('resolves a relative og:image against the page it came from', async () => {
    const page = `<html><head><meta property="og:image" content="/media/photo.jpg"></head></html>`;
    const fetchImpl = vi.fn(async () => htmlResponse(page));

    const result = await resolveDisplayableImageUrl('https://booth.example/share/abc', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.url).toBe('https://booth.example/media/photo.jpg');
  });

  describe('every failure returns the booth\'s own URL rather than nothing', () => {
    it('on an HTTP error from the share host', async () => {
      const fetchImpl = vi.fn(async () => htmlResponse('nope', 503));

      const result = await resolveDisplayableImageUrl(SHARE_URL, { fetchImpl: fetchImpl as unknown as typeof fetch });

      expect(result.url).toBe(SHARE_URL);
      expect(result.warning).toContain('503');
    });

    it('when the page carries no og:image at all', async () => {
      const fetchImpl = vi.fn(async () => htmlResponse('<html><head><title>x</title></head></html>'));

      const result = await resolveDisplayableImageUrl(SHARE_URL, { fetchImpl: fetchImpl as unknown as typeof fetch });

      expect(result.url).toBe(SHARE_URL);
      expect(result.warning).toContain('no og:image');
    });

    it('when the response is neither HTML nor an image', async () => {
      const fetchImpl = vi.fn(async () =>
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
      );

      const result = await resolveDisplayableImageUrl(SHARE_URL, { fetchImpl: fetchImpl as unknown as typeof fetch });

      expect(result.url).toBe(SHARE_URL);
      expect(result.warning).toContain('application/json');
    });

    it('when the fetch throws — a timeout, DNS failure, or the host being down', async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error('The operation was aborted due to timeout');
      });

      const result = await resolveDisplayableImageUrl(SHARE_URL, { fetchImpl: fetchImpl as unknown as typeof fetch });

      expect(result.url).toBe(SHARE_URL);
      expect(result.warning).toContain('timeout');
    });

    it('never throws out of the function, whatever the failure', async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error('boom');
      });

      await expect(
        resolveDisplayableImageUrl(SHARE_URL, { fetchImpl: fetchImpl as unknown as typeof fetch }),
      ).resolves.toEqual({ url: SHARE_URL, warning: expect.stringContaining('boom') });
    });
  });

  it('treats an extensionless URL that already serves an image as final', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('binary', { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    );

    const result = await resolveDisplayableImageUrl('https://cdn.example/photo/abc123', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.url).toBe('https://cdn.example/photo/abc123');
    expect(result.warning).toBeUndefined();
  });

  it('passes an empty or unparseable value straight through without a network call', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse(REAL_SHARE_PAGE));

    expect(await resolveDisplayableImageUrl('', { fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({ url: '' });
    expect(
      await resolveDisplayableImageUrl('not a url', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).toEqual({ url: 'not a url' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
