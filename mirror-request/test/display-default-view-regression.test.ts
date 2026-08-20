import { afterEach, describe, expect, it } from 'vitest';
import { renderDisplayPage } from '../src/display/displayPage';
import { LocalStore } from '../src/state/localStore';
import { DisplayServer } from '../src/display/displayServer';
import type { QueueService } from '../src/queue/queueService';
import type { AgentServer } from '../src/agent/agentServer';
import type { DisplaySnapshot } from '../src/types';

/**
 * D9-02: the physical cutover ALREADY EXECUTED — real TVs in the venue are
 * pointed at bare `/display-screen` right now. This file is deliberately
 * narrow and deliberately blunt: it exists so that a future edit which
 * quietly deletes the sidebar, the queue list, or the two-column grid fails
 * HERE rather than on a wall. Every commit in this phase must leave
 * `renderDisplayPage()` rendering exactly what it rendered before this phase
 * started (SC-2).
 *
 * The second half of this file pins T-09-05/D-09's diff-guard: the two new
 * `EventConfig` fields ride the existing snapshot without becoming a
 * per-tick-varying value, so `maybeBroadcast()`'s serialized-diff guard still
 * sends nothing while the room is still.
 */

const HTML = renderDisplayPage();

describe('Default room screen — the D9-02 regression pin (bare /display-screen is unchanged)', () => {
  it('still carries the sidebar region: aside, the ordered list, the heading, and the queue-count element', () => {
    expect(HTML).toMatch(/<aside/);
    expect(HTML).toContain('id="queue"');
    expect(HTML).toContain('queueMeta');
    expect(HTML).toContain('Thứ tự tiếp theo');
  });

  it('still declares the two-column grid and the single-column collapse media query', () => {
    expect(HTML).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s*23rem/);
    expect(HTML).toMatch(/@media\s*\(max-width:\s*\d+px\)/);
    expect(HTML).toMatch(/grid-template-columns:\s*1fr/);
  });

  it('renderDisplayPage() still takes zero arguments and is byte-stable across calls', () => {
    expect(renderDisplayPage.length).toBe(0);
    expect(renderDisplayPage()).toBe(HTML);
    expect(renderDisplayPage()).toBe(renderDisplayPage());
  });
});

/**
 * D9-04, Task 3: both toggles are EVENT configuration, so the default screen
 * honours them exactly as the slides screen does — this is the default-page
 * half of that proof; test/display-slides-view.test.ts carries the
 * slides-side half plus the shared snapshot-level assertions.
 */
describe('Default room screen — D9-04, both toggles honoured (hero takeover + guest name)', () => {
  // SUPERSEDED 2026-08-14. D9-04's two toggles used to govern this screen as
  // well as the slides view; this screen now draws no photographs at all, so
  // there is nothing here for either toggle to gate. The assertions are
  // INVERTED rather than deleted — the guard that mattered was "the hero
  // branch behaves as decided", and the decision changed to "there is no hero
  // branch". A deleted test would let it come back unnoticed.
  it('has no hero-takeover branch at all: no photograph reaches this screen', () => {
    expect(HTML).not.toMatch(/heroTakeoverEnabled/);
    expect(HTML).not.toMatch(/if\s*\(\s*heroTakeoverEnabled\s*&&\s*data\.justCaptured\s*\)/);
    expect(HTML).not.toMatch(/currentStageState='hero'/);
  });

  it('has no photo-tile builder for a guest name to be drawn onto', () => {
    // showGuestName is still a live event setting — it governs the slides view
    // now, and cmsEventPages.ts was corrected to say exactly that.
    expect(HTML).not.toMatch(/guestNameEnabled/);
    expect(HTML).not.toMatch(/function shotTile/);
    expect(HTML).not.toMatch(/function photoFrame/);
  });

  it('does not consume any caption/template/fit configuration or construct a blur/photo layer (D999.1-09)', () => {
    for (const field of ['guestNameTemplate', 'captionPosition', 'photoFit', 'contain_blur']) {
      expect(HTML).not.toContain(field);
    }
    expect(HTML).not.toMatch(/photo-foreground|photo-blur/);
  });

  it('leaves the sidebar untouched: the queue list renders regardless of the guest-name toggle', () => {
    // The toggle governs the name shown WITH A PHOTO, not the waiting list —
    // a different thing, per 09-CONTEXT.md D9-04.
    expect(HTML).toContain('id="queue"');
    expect(HTML).toContain("nm.className='qname'");
  });

  it('keeps the stage-precedence chain that survives: announcing, capturing, idle', () => {
    // The slideshow branch is gone with the photographs. The other three are
    // the whole of what this screen now says, so losing one silently would
    // leave a wall screen with nothing to show.
    expect(HTML).toContain("data.boothState==='ANNOUNCING'");
    expect(HTML).toContain("data.boothState==='BUSY'");
    expect(HTML).toContain('renderIdle(cfg)');
    expect(HTML).not.toContain('slides.length>=1');
    expect(HTML).not.toMatch(/currentStageState='slideshow'/);
  });

  it('idle is now the resting state, not a zero-photo edge case', () => {
    // With no rotation to fall through to, a screen with nothing announced
    // comes to rest on the QR and its call to register — which is the useful
    // thing to show a room that has not signed up yet.
    const chain = HTML.slice(HTML.indexOf("data.boothState==='ANNOUNCING'"));
    const idleAt = chain.indexOf('renderIdle(cfg)');
    expect(idleAt).toBeGreaterThan(-1);
    expect(chain.slice(0, idleAt)).not.toMatch(/drawSlide|shotTile/);
  });
});

describe('maybeBroadcast() diff guard — the two new EventConfig fields cannot flood the venue (T-09-05, D-09)', () => {
  let storeCounter = 0;
  function uniqueStorePath(): string {
    storeCounter += 1;
    return `./data/test-display-regression-diffguard-${process.pid}-${Date.now()}-${storeCounter}.sqlite`;
  }
  const openStores: LocalStore[] = [];
  function makeStore(): LocalStore {
    const store = new LocalStore(uniqueStorePath());
    openStores.push(store);
    return store;
  }

  afterEach(() => {
    while (openStores.length) {
      try {
        openStores.pop()?.close();
      } catch {
        /* already closed */
      }
    }
  });

  function makeAgent(): Partial<AgentServer> {
    return { isAgentOnline: () => true };
  }
  function makeQueue(store: LocalStore): Partial<QueueService> {
    return {
      getQueuePosition: () => undefined,
      getQueueLength: () => store.getQueueLength(),
      getAnnouncement: () => null,
    };
  }

  /** Reaches the private builder directly, exactly as
   * display-hero-moment.test.ts's snapshotOf() does — a never-started
   * DisplayServer, so no interval, no socket, no timer exists. */
  function snapshotOf(display: DisplayServer): DisplaySnapshot {
    return (display as unknown as { buildSnapshot(): DisplaySnapshot }).buildSnapshot();
  }

  it('four consecutive evaluations with nothing changed serialise byte-identically', () => {
    const store = makeStore();
    const event = store.createEvent({ name: 'Sự kiện ổn định' });
    store.setActiveEvent(event.id);
    store.recordEventPhoto({
      jobId: 'job-still-1',
      eventId: event.id,
      guestName: 'Khách A',
      photoUrl: 'https://fotoshare.co/i/still-1',
      capturedAt: Date.now() - 3_600_000, // well outside the hero window
    });

    const display = new DisplayServer(makeQueue(store) as QueueService, makeAgent() as AgentServer, store, {
      heroMomentDurationMs: 12_000,
    });

    const serialised = new Set<string>();
    for (let i = 0; i < 4; i += 1) {
      serialised.add(JSON.stringify(snapshotOf(display)));
    }
    expect(serialised.size).toBe(1);
  });

  it('flipping a toggle changes the serialisation exactly once, across the write', () => {
    const store = makeStore();
    const event = store.createEvent({ name: 'Sự kiện đổi cấu hình' });
    store.setActiveEvent(event.id);

    const display = new DisplayServer(makeQueue(store) as QueueService, makeAgent() as AgentServer, store, {
      heroMomentDurationMs: 12_000,
    });

    const before = new Set<string>();
    for (let i = 0; i < 3; i += 1) before.add(JSON.stringify(snapshotOf(display)));
    expect(before.size).toBe(1);

    store.updateEvent(event.id, { hero_enabled: 0 });

    const after = new Set<string>();
    for (let i = 0; i < 3; i += 1) after.add(JSON.stringify(snapshotOf(display)));
    expect(after.size).toBe(1);

    // Exactly one distinct serialisation across the whole window spanning
    // the write: the pre-write set and the post-write set together form
    // exactly two distinct values, never a third, never a per-tick drift.
    const spanningWindow = new Set<string>([...before, ...after]);
    expect(spanningWindow.size).toBe(2);
  });

  it('the flipped field is the only thing that changed in the serialised snapshot', () => {
    const store = makeStore();
    const event = store.createEvent({ name: 'Sự kiện kiểm tra field' });
    store.setActiveEvent(event.id);

    const display = new DisplayServer(makeQueue(store) as QueueService, makeAgent() as AgentServer, store, {
      heroMomentDurationMs: 12_000,
    });

    const beforeSnapshot = snapshotOf(display);
    expect(beforeSnapshot.eventConfig.showGuestName).toBe(true);

    store.updateEvent(event.id, { show_guest_name: 0 });
    const afterSnapshot = snapshotOf(display);
    expect(afterSnapshot.eventConfig.showGuestName).toBe(false);

    const beforeMinusToggle = { ...beforeSnapshot, eventConfig: { ...beforeSnapshot.eventConfig, showGuestName: undefined } };
    const afterMinusToggle = { ...afterSnapshot, eventConfig: { ...afterSnapshot.eventConfig, showGuestName: undefined } };
    expect(JSON.stringify(afterMinusToggle)).toBe(JSON.stringify(beforeMinusToggle));
  });
});
