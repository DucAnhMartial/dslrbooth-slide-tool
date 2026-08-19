import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FIELD_SCREEN_MAP, SCREEN_TAG } from '../src/cms/cmsEventPages';
import { renderDisplayPage } from '../src/display/displayPage';
import { renderSlidesPage } from '../src/display/slidesPage';

// ---------------------------------------------------------------------------
// CMS-08 — every event setting says which screen it changes.
//
// The form mixes settings for two different screens, plus two that change
// nothing visible at all, and said so nowhere. An operator edited the QR, the
// background and the photo settings and reported seeing no change anywhere:
// part of it genuinely did nothing (CMS-07, since fixed), and the rest only
// appears on a screen they were not looking at.
//
// THE POINT OF THIS FILE is that the labels cannot drift from the behaviour.
// A wrong "Cả hai màn" is worse than no label, because an operator believes it
// and stops looking. So the map is re-derived here from the pages themselves —
// every 'cfg.<field>' each page dereferences — and compared against what the
// CMS claims. A page that starts or stops reading a field fails this suite
// until the map is updated.
// ---------------------------------------------------------------------------

const SRC = path.join(__dirname, '..', 'src', 'display');

/** Every eventConfig key a page actually dereferences. */
function fieldsReadBy(file: string): Set<string> {
  const source = fs.readFileSync(path.join(SRC, file), 'utf8');
  return new Set([...source.matchAll(/cfg\.([a-zA-Z]+)/g)].map((m) => m[1]));
}

/** snake_case form name -> camelCase snapshot key. */
function toCamel(name: string): string {
  return name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

const waitingReads = fieldsReadBy('displayPage.ts');
const slidesReads = fieldsReadBy('slidesPage.ts');

describe('the map matches what the pages actually read (CMS-08)', () => {
  it.each(Object.entries(FIELD_SCREEN_MAP))('%s is tagged correctly', (formName, tag) => {
    const key = toCamel(formName);
    const onWaiting = waitingReads.has(key);
    const onSlides = slidesReads.has(key);

    switch (tag) {
      case 'both':
        expect(onWaiting, `${formName} is tagged "both" but the waiting screen does not read it`).toBe(true);
        expect(onSlides, `${formName} is tagged "both" but the slides screen does not read it`).toBe(true);
        break;
      case 'waiting':
        expect(onWaiting).toBe(true);
        expect(onSlides, `${formName} is tagged waiting-only but the slides screen reads it`).toBe(false);
        break;
      case 'slides':
        expect(onSlides).toBe(true);
        expect(onWaiting, `${formName} is tagged slides-only but the waiting screen reads it`).toBe(false);
        break;
      case 'cmsOnly':
      case 'inactive':
        expect(onWaiting, `${formName} is tagged as affecting no screen but the waiting screen reads it`).toBe(false);
        expect(onSlides, `${formName} is tagged as affecting no screen but the slides screen reads it`).toBe(false);
        break;
    }
  });

  it('leaves no field a page reads unaccounted for', () => {
    // A snapshot key a page consumes but the form never labels is a setting an
    // operator changes blind.
    const mapped = new Set(Object.keys(FIELD_SCREEN_MAP).map(toCamel));
    // Keys that are not operator-editable event settings at all.
    const notSettings = new Set(['id', 'photoUrl', 'name']);
    for (const key of [...waitingReads, ...slidesReads]) {
      if (notSettings.has(key)) continue;
      expect(mapped, `no CMS field is mapped for the config key "${key}"`).toContain(key);
    }
  });
});

describe('the tags reach the rendered form (CMS-08)', () => {
  // Rendered indirectly: renderCmsEventFormPage needs a full event row, so the
  // assertions below check the source of truth (the map) plus the presence of
  // the tag markup in the page module's own output helpers.
  const pageSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'cms', 'cmsEventPages.ts'),
    'utf8',
  );

  it('every field helper attaches a tag', () => {
    // text, colour, checkbox and asset fields plus the four hand-built selects
    // and numbers — a helper that forgets is a whole class of fields with no
    // label at all.
    const attachments = pageSource.match(/screenTag\(/g) ?? [];
    // 4 helpers + 4 hand-built fields + the helper's own definition.
    expect(attachments.length).toBeGreaterThanOrEqual(9);
  });

  it('the legend names every tag an operator can meet', () => {
    for (const tag of Object.values(SCREEN_TAG)) {
      expect(pageSource).toContain(tag.text);
    }
  });

  it('the four tag styles are distinguishable, not four greys', () => {
    const colours = new Set(
      [...pageSource.matchAll(/\.screentag\.(both|waiting|slides|none)\{color:(#[0-9a-f]{6})\}/g)].map((m) => m[2]),
    );
    expect(colours.size).toBe(4);
  });

  it('an unmapped field renders no tag rather than a wrong one', () => {
    expect(pageSource).toMatch(/if \(!key\) return '';/);
  });
});

describe('the tags tell the truth about the screens as they are today', () => {
  const waiting = renderDisplayPage();
  const slides = renderSlidesPage();

  it('the QR is waiting-only, and the pages agree', () => {
    expect(FIELD_SCREEN_MAP.qr_image_url).toBe('waiting');
    expect(waiting).toContain('qrImageUrl');
    expect(slides).not.toContain('qrImageUrl');
  });

  it('the photo settings are slides-only, and the pages agree', () => {
    for (const f of ['photo_count', 'photo_duration_ms', 'show_guest_name', 'hero_enabled', 'guest_name_template', 'caption_position', 'photo_fit']) {
      expect(FIELD_SCREEN_MAP[f]).toBe('slides');
    }
    expect(waiting).not.toContain('photoDurationMs');
    expect(slides).toContain('photoDurationMs');
    expect(waiting).not.toContain('guestNameTemplate');
    expect(waiting).not.toContain('captionPosition');
    expect(waiting).not.toContain('photoFit');
    expect(slides).toContain('guestNameTemplate');
    expect(slides).toContain('captionPosition');
    expect(slides).toContain('photoFit');
  });

  it('layout_style is honestly labelled as not yet doing anything', () => {
    // displayPage.ts states this outright: the column exists so a later phase
    // can add layouts without a migration, and there is no second branch.
    expect(FIELD_SCREEN_MAP.layout_style).toBe('inactive');
    expect(waiting).not.toContain('layoutStyle');
    expect(slides).not.toContain('layoutStyle');
  });

  it('the event name is CMS-only — no screen prints it', () => {
    expect(FIELD_SCREEN_MAP.name).toBe('cmsOnly');
  });
});
