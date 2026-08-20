import { describe, it, expect } from 'vitest';
import { renderCmsClearHistoryConfirmPage } from '../src/cms/cmsPhotoPages';
import type { EventSummary } from '../src/state/localStore';

// ---------------------------------------------------------------------------
// Phase 8 code review, WR-08 — `JSON.stringify` is not an HTML escape.
//
// `cmsPhotoPages.ts` interpolates the event id into an inline `<script>`
// block via `JSON.stringify`. That produces a valid JS string literal, and it
// is the right tool for a JS context — but it does not escape `<` or `/`, so
// a value containing `</script>` closes the element from inside a string the
// browser never gets to evaluate. The HTML parser wins that race every time;
// it does not know or care that the sequence sits inside quotes.
//
// Every other dynamic value in this file goes through `escapeHtml()`. This
// one could not: HTML entities are NOT decoded inside `<script>` (it is a raw
// text element), so `escapeHtml` on JS source would ship `&quot;` into the
// script and break it. A JS context needs a JS-context escape —
// `jsonForScript()` — which emits `\u003C` and friends: still a valid JS
// string literal, no longer a valid HTML close tag.
//
// Today this is unexploitable. Event ids come from `randomUUID()`
// (localStore.ts:1006), so no attacker chooses those bytes. It is filed as a
// warning rather than shrugged off because the ONLY thing standing between
// this and a stored XSS is a fact about id minting recorded nowhere near this
// line — and "operator-chosen event slug" is an ordinary future request.
// ---------------------------------------------------------------------------

const BREAKOUT = 'e1</script><script>alert(1)</script>';

function evt(id: string): EventSummary {
  return { id, name: 'Tiệc cưới An & Bình', createdAt: 0, updatedAt: 0 };
}

describe('WR-08: values reaching an inline <script> are escaped for the JS context', () => {
  it('a breakout payload in the event id cannot close the script element', () => {
    const page = renderCmsClearHistoryConfirmPage({ event: evt(BREAKOUT), photoCount: 3 });

    expect(page).not.toContain('</script><script>alert(1)');
  });

  it('every <script> in the page is closed exactly once — no injected element', () => {
    const page = renderCmsClearHistoryConfirmPage({ event: evt(BREAKOUT), photoCount: 3 });

    // The structural form of the same claim. A page whose open and close tags
    // no longer balance has had an element injected into it, whatever the
    // payload happened to spell.
    const opens = page.match(/<script\b/g)?.length ?? 0;
    const closes = page.match(/<\/script>/g)?.length ?? 0;
    expect({ opens, closes }).toEqual({ opens: 1, closes: 1 });
  });

  it('the id survives escaping as a JS string literal, not as HTML entities', () => {
    const page = renderCmsClearHistoryConfirmPage({ event: evt(BREAKOUT), photoCount: 3 });
    const script = page.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? '';

    // Scoped to the SCRIPT BLOCK on purpose. The same id also lands in a
    // `data-event-id` attribute, where `&lt;` is the correct escape and would
    // make an unscoped assertion fail against correct code — the two contexts
    // want two different escapes, which is the point of having two helpers.
    expect(script).toContain('\\u003C/script');
    expect(script).not.toContain('&lt;');
    expect(script).not.toContain('&quot;');
  });

  // -------------------------------------------------------------------------
  // Non-vacuity. Passes BEFORE the fix. Without it, deleting the
  // interpolation entirely would satisfy all three cases above.
  // -------------------------------------------------------------------------

  it('an ordinary uuid still reaches the script as a working redirect target', () => {
    const id = '3f7c1a90-2b4d-4e88-9a11-0c5e6d7f8a90';
    const page = renderCmsClearHistoryConfirmPage({ event: evt(id), photoCount: 3 });

    expect(page).toContain(`"/cms/photos?event=${id}"`);
  });

  it('the guest-visible event name is still HTML-escaped in its HTML context', () => {
    const page = renderCmsClearHistoryConfirmPage({
      event: { ...evt('ok'), name: '<img src=x onerror=alert(1)>' },
      photoCount: 0,
    });

    expect(page).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(page).not.toContain('<img src=x onerror=alert(1)>');
  });
});
