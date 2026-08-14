import { describe, it, expect } from 'vitest';
import { renderDisplayPage } from '../src/display/displayPage';
import { renderSlidesPage } from '../src/display/slidesPage';

// ---------------------------------------------------------------------------
// CMS-07 — the uploaded images must actually appear somewhere.
//
// Operator report: "tôi có cấu hình QR và image nhưng mà nó ko có sự thay đổi
// gì ở đâu cả". They were right, and the cause was worse than a bug — the
// feature had no consumer at all. `logoUrl`, `backgroundUrl` and `qrImageUrl`
// were uploaded, validated, stored, served over /uploads and projected into
// every snapshot, and then NOTHING read them: a grep across src/ found the
// three names only in the store, the types and the CMS form. Three upload
// controls, three helpful Vietnamese descriptions, and no pixel on any screen.
//
// What the CMS's own copy promises is the specification these cases pin:
//   "Ảnh nền của màn hình phòng, cũng là ảnh hiển thị ở trạng thái chờ"
//   "Tải lên ảnh mã QR đã tạo sẵn cho sự kiện này"
// ---------------------------------------------------------------------------

const defaultPage = renderDisplayPage();
const slidesPage = renderSlidesPage();

describe('the background and logo reach both room screens (CMS-07)', () => {
  it('both pages carry a background layer and a logo element', () => {
    for (const page of [defaultPage, slidesPage]) {
      expect(page).toContain('id="eventBg"');
      expect(page).toContain('id="eventLogo"');
    }
  });

  it('both start hidden, so an event with no images shows no empty boxes', () => {
    for (const page of [defaultPage, slidesPage]) {
      expect(page).toMatch(/id="eventBg"[^>]*hidden/);
      expect(page).toMatch(/id="eventLogo"[^>]*hidden/);
    }
  });

  it('the applier reads the snapshot fields that were previously ignored', () => {
    for (const page of [defaultPage, slidesPage]) {
      expect(page).toContain('cfg.backgroundUrl');
      expect(page).toContain('cfg.logoUrl');
    }
  });

  it('clearing an image in the CMS clears it on the TV, rather than leaving the old one', () => {
    // The else-branches are the point: an applier that only ever SETS leaves a
    // removed background on every screen until someone reloads it.
    for (const page of [defaultPage, slidesPage]) {
      expect(page).toMatch(/backgroundImage=''/);
      expect(page).toMatch(/removeAttribute\('src'\)/);
    }
  });

  it('the logo takes the opposite corner from the screen badge', () => {
    // Both are fixed overlays; sharing a corner would stack them.
    for (const page of [defaultPage, slidesPage]) {
      expect(page).toMatch(/#eventLogo\{[^}]*right:1\.6vw/);
      expect(page).toMatch(/\.screenbadge\{[^}]*left:1\.6vw/);
    }
  });

  it('the background sits behind a scrim, so operator text stays legible over any photo', () => {
    // A bright portrait behind white type is unreadable at TV distance
    // (UI-01), and choosing a background should not mean solving contrast.
    for (const page of [defaultPage, slidesPage]) {
      expect(page).toMatch(/#eventBg:after\{[^}]*opacity:\.\d+/);
    }
  });

  it('never builds an image URL by string-interpolating into markup', () => {
    // These URLs are operator-supplied and cross a trust boundary. src
    // PROPERTY and style property only — the same rule the photo tiles had.
    for (const page of [defaultPage, slidesPage]) {
      expect(page).not.toMatch(/innerHTML[^;]*(logoUrl|backgroundUrl|qrImageUrl)/);
      expect(page).toMatch(/logo\.src=cfg\.logoUrl/);
    }
  });
});

describe('the QR appears where people who have not registered are looking (CMS-07)', () => {
  it('the waiting screen renders the QR image and its caption', () => {
    expect(defaultPage).toContain('id="qrBlock"');
    expect(defaultPage).toContain('id="qrImage"');
    expect(defaultPage).toMatch(/#qrImage'\)\.src=cfg\.qrImageUrl/);
  });

  it('the caption is written as text, never as markup', () => {
    expect(defaultPage).toMatch(/#qrCta'\)\.textContent=/);
  });

  it('the QR lives in the idle state only, not during announcing or capturing', () => {
    // A guest being called to the camera does not need to scan anything, and
    // a code on screen during someone's turn is clutter aimed at the wrong
    // person. Idle is this screen's resting state now, which is what makes
    // that placement useful rather than hidden.
    const renderIdle = defaultPage.slice(
      defaultPage.indexOf('function renderIdle'),
      defaultPage.indexOf('function render(data)'),
    );
    expect(renderIdle).toContain('qrImageUrl');

    const announcing = defaultPage.slice(defaultPage.indexOf("data.boothState==='ANNOUNCING'"));
    const idleCall = announcing.indexOf('renderIdle(cfg)');
    expect(announcing.slice(0, idleCall)).not.toContain('qrImageUrl');
  });

  it('an event with no QR uploaded still shows its call to action, as before', () => {
    // The regression that would otherwise ship: adding a QR block that hides
    // the instruction when there is no QR to show beside it.
    expect(defaultPage).toMatch(/if\(cfg\.qrImageUrl\)\{[\s\S]{0,600}\}else\{[\s\S]{0,200}#idleSub'\)\.textContent=cta/);
  });

  it('does not print the same instruction twice when the QR is shown', () => {
    expect(defaultPage).toMatch(/#idleSub'\)\.textContent='';/);
  });

  it('the slides screen carries NO QR — it is photographs', () => {
    // A registration code over someone's portrait is an advert on a picture
    // frame. D9-01's spirit, applied to a control D9-01 never saw.
    expect(slidesPage).not.toContain('qrBlock');
    expect(slidesPage).not.toContain('qrImageUrl');
  });
});
