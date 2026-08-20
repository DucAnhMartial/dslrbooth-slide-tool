import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalStore } from '../src/state/localStore';
import { renderDisplayPage } from '../src/display/displayPage';
import { renderSlidesPage } from '../src/display/slidesPage';
import { FIELD_SCREEN_MAP, BACKGROUND_OVERLAY_RANGE } from '../src/cms/cmsEventPages';

// ---------------------------------------------------------------------------
// CMS-10 — the dim over the event background is the operator's number.
//
// Both room screens hard-coded a heavy scrim (72% and 82%) so that white type
// stayed legible over a bright photograph. Correct for a bright photograph,
// and wrong for the operator who uploaded a dark, low-contrast backdrop and
// then could not see it: "Bạn đang tạo lớp phủ những có những khách hàng
// người ta không cần điều đó."
//
// That is a judgement about the customer's own artwork, and this software is
// not in a position to make it. The default stays 72 — what both screens
// already rendered — so nothing changes until someone decides it should.
// ---------------------------------------------------------------------------

const openStores: LocalStore[] = [];
const tmpDirs: string[] = [];

function makeStore(): LocalStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-overlay-'));
  tmpDirs.push(dir);
  const store = new LocalStore(path.join(dir, 'test.sqlite'));
  openStores.push(store);
  return store;
}

afterEach(() => {
  while (openStores.length) {
    try { openStores.pop()?.close(); } catch { /* closed */ }
  }
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('the setting round-trips (CMS-10)', () => {
  it('defaults to what the screens already rendered, so nothing changes on upgrade', () => {
    const store = makeStore();
    const event = store.createEvent({ name: 'Đám cưới A' });
    store.setActiveEvent(event.id);
    expect(store.getActiveEventConfig()?.backgroundOverlay).toBe(72);
  });

  it('accepts 0 — the whole point: artwork shown untouched', () => {
    const store = makeStore();
    const event = store.createEvent({ name: 'Đám cưới A' });
    store.updateEvent(event.id, { background_overlay: 0 });
    store.setActiveEvent(event.id);
    expect(store.getActiveEventConfig()?.backgroundOverlay).toBe(0);
  });

  it('clamps a value from a hand-edited database on the way out', () => {
    // A page that trusts a number it was handed is one bad row away from an
    // unreadable wall.
    const store = makeStore();
    const event = store.createEvent({ name: 'Đám cưới A' });
    (store as unknown as { db: { exec: (s: string) => void } }).db.exec(
      `UPDATE event SET background_overlay = 999 WHERE id = '${event.id}'`,
    );
    store.setActiveEvent(event.id);
    expect(store.getActiveEventConfig()?.backgroundOverlay).toBe(100);
  });
});

describe('both screens read it instead of a constant (CMS-10)', () => {
  const pages = { waiting: renderDisplayPage(), slides: renderSlidesPage() };

  it.each(Object.entries(pages))('%s reads cfg.backgroundOverlay', (_n, html) => {
    expect(html).toContain('cfg.backgroundOverlay');
  });

  it.each(Object.entries(pages))('%s drives the scrim from a custom property', (_n, html) => {
    expect(html).toMatch(/#eventBg:after\{[^}]*opacity:var\(--event-bg-overlay/);
  });

  it.each(Object.entries(pages))('%s no longer hard-codes the old scrim', (_n, html) => {
    expect(html).not.toMatch(/#eventBg:after\{[^}]*opacity:\.(72|82)\}/);
  });

  it.each(Object.entries(pages))('%s clamps the value it was handed', (_n, html) => {
    expect(html).toMatch(/Math\.min\(100,Math\.max\(0,ov\)\)/);
  });
});

describe('the CMS exposes it honestly (CMS-10)', () => {
  it('is tagged as affecting both screens, because it does', () => {
    expect(FIELD_SCREEN_MAP.background_overlay).toBe('both');
  });

  it('allows zero rather than a token minimum', () => {
    expect(BACKGROUND_OVERLAY_RANGE.min).toBe(0);
    expect(BACKGROUND_OVERLAY_RANGE.max).toBe(100);
  });
});
