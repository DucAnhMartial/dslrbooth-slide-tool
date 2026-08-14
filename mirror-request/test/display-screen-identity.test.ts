import { describe, it, expect } from 'vitest';
import {
  renderDisplayPage,
  SCREEN_BADGE_LABEL,
  SCREEN_BADGE_HINT,
  SCREEN_BADGE_PROMINENT_MS,
} from '../src/display/displayPage';
import {
  renderSlidesPage,
  SLIDES_BADGE_LABEL,
  SLIDES_BADGE_HINT,
  SLIDES_BADGE_PROMINENT_MS,
} from '../src/display/slidesPage';

// ---------------------------------------------------------------------------
// CMS-06 — the two room screens must be tellable apart.
//
// Both draw the same photos from the same snapshot: the default screen runs
// the identical slideshow in its stage column that the slides view runs
// full-bleed. The only difference was a sidebar, which from across a room
// reads as "this TV is cropped differently", not as "this TV is a different
// page". An operator setting up two TVs could not tell which URL either one
// was on — reported after a real event.
//
// Three axes, because one alone was not enough: the screen says its own name,
// the layout diverges, and the content diverges. The badge is the one that
// answers the setup question directly, and it is deliberately loud only for
// the first few seconds — a permanent banner on a wedding wall screen would
// aim an operator's problem at the guests.
// ---------------------------------------------------------------------------

const defaultPage = renderDisplayPage();
const slidesPage = renderSlidesPage();

describe('each screen states which screen it is (CMS-06)', () => {
  it('the queue screen carries its own label and hint', () => {
    expect(defaultPage).toContain(SCREEN_BADGE_LABEL);
    expect(defaultPage).toContain(SCREEN_BADGE_HINT);
  });

  it('the slides screen carries its own label and hint', () => {
    expect(slidesPage).toContain(SLIDES_BADGE_LABEL);
    expect(slidesPage).toContain(SLIDES_BADGE_HINT);
  });

  it('the two labels differ — the whole point', () => {
    expect(SCREEN_BADGE_LABEL).not.toBe(SLIDES_BADGE_LABEL);
    expect(SCREEN_BADGE_HINT).not.toBe(SLIDES_BADGE_HINT);
  });

  it('neither page carries the other page label', () => {
    // A copy-paste that left both TVs claiming to be the same screen would
    // pass every other case in this file.
    expect(defaultPage).not.toContain(SLIDES_BADGE_LABEL);
    expect(slidesPage).not.toContain(SCREEN_BADGE_LABEL);
  });

  it('both badges sit in the same corner, so two TVs are compared at the same spot', () => {
    for (const page of [defaultPage, slidesPage]) {
      expect(page).toMatch(/\.screenbadge\{[^}]*position:fixed/);
      expect(page).toMatch(/\.screenbadge\{[^}]*top:1\.6vw/);
      expect(page).toMatch(/\.screenbadge\{[^}]*left:1\.6vw/);
    }
  });

  it('the badge can never intercept a click or a touch', () => {
    for (const page of [defaultPage, slidesPage]) {
      expect(page).toMatch(/\.screenbadge\{[^}]*pointer-events:none/);
    }
  });

  it('is hidden from assistive technology — it addresses an operator, not a reader', () => {
    for (const page of [defaultPage, slidesPage]) {
      expect(page).toMatch(/id="screenbadge"[^>]*aria-hidden="true"/);
    }
  });

  it('settles on a timer rather than on the first snapshot', () => {
    // A screen that never receives a snapshot is exactly the screen whose
    // identity someone is trying to read, so the shrink must not depend on one.
    for (const page of [defaultPage, slidesPage]) {
      expect(page).toMatch(/setTimeout\(function\(\)\{[\s\S]{0,160}classList\.add\('settled'\)/);
    }
    expect(defaultPage).toContain(String(SCREEN_BADGE_PROMINENT_MS));
    expect(slidesPage).toContain(String(SLIDES_BADGE_PROMINENT_MS));
  });

  it('shrinks rather than vanishing, so the screen stays identifiable all night', () => {
    for (const page of [defaultPage, slidesPage]) {
      expect(page).toMatch(/\.screenbadge\.settled\{[^}]*opacity:0?\.\d+/);
      expect(page).toMatch(/\.screenbadge\.settled\{[^}]*transform:scale\(/);
      // Not display:none — that would make it unidentifiable after 8 seconds.
      expect(page).not.toMatch(/\.screenbadge\.settled\{[^}]*display:none/);
    }
  });

  it('carries no guest data, which is why it is safe as static markup', () => {
    for (const label of [SCREEN_BADGE_LABEL, SCREEN_BADGE_HINT, SLIDES_BADGE_LABEL, SLIDES_BADGE_HINT]) {
      expect(label).not.toMatch(/[<>&]/);
    }
  });
});

describe('the layouts diverge (CMS-06)', () => {
  it('only the queue screen has a sidebar, and it is a panel rather than a margin', () => {
    expect(defaultPage).toMatch(/aside\{[^}]*border-radius/);
    expect(defaultPage).toMatch(/aside\{[^}]*background:color-mix/);
    expect(slidesPage).not.toContain('<aside');
  });

  it('the slides screen keeps its black stage — no tinted panel anywhere', () => {
    // The badge there is white-on-transparent for this reason: a coloured
    // block would be the brightest thing in a dark room.
    expect(slidesPage).toMatch(/\.screenbadge\{[^}]*background:rgba\(255,255,255/);
    expect(defaultPage).toMatch(/\.screenbadge\{[^}]*background:color-mix/);
  });
});

describe('the content diverges (CMS-06, D9-01)', () => {
  it('only the queue screen publishes a waiting count', () => {
    expect(defaultPage).toContain('queueCount');
    expect(defaultPage).toContain('qcount');
    // D9-01: the slides view carries no queue metadata of any kind.
    expect(slidesPage).not.toContain('queueCount');
    expect(slidesPage).not.toContain('qcount');
  });

  it('the count is written as text, never as markup', () => {
    expect(defaultPage).toMatch(/qc\.textContent\s*=/);
  });

  it('an empty queue shows no badge at all, rather than a zero to interpret', () => {
    expect(defaultPage).toMatch(/\.qcount:empty\{display:none\}/);
    expect(defaultPage).toMatch(/qc\.textContent=data\.queueLength\?String\(data\.queueLength\):''/);
  });

  it('only the queue screen names the queue in its heading', () => {
    expect(defaultPage).toContain('Thứ tự tiếp theo');
    expect(slidesPage).not.toContain('Thứ tự tiếp theo');
  });
});
