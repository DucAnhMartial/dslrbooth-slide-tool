import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalStore } from '../src/state/localStore';
import { DisplayServer } from '../src/display/displayServer';
import { renderDisplayPage } from '../src/display/displayPage';
import type { QueueService } from '../src/queue/queueService';
import type { AgentServer } from '../src/agent/agentServer';
import type { DisplaySnapshot } from '../src/types';

/**
 * D-09's hero moment, and RESEARCH Pitfall 1 in particular.
 *
 * The property under test is not "the hero appears" — that half is easy to get
 * right by accident. It is that the hero appears AND expires **from a
 * derivation**, computed on every `buildSnapshot()` evaluation by comparing the
 * durable `event_photo.captured_at` against an injected TTL, exactly the way
 * `countdownSeconds`/`announcementEndsAt` already work.
 *
 * The two failure modes a field-plus-`setTimeout` implementation has are both
 * silent, and both are pinned below:
 *   - a stored field cleared only by a deferred callback never clears at all if
 *     the process restarts inside the window, pinning a departed guest's face
 *     on the wall indefinitely;
 *   - a field that re-serialises differently on every tick would defeat
 *     `maybeBroadcast()`'s `lastSent` diff and flood every connected screen.
 *
 * Every case here therefore drives a `DisplayServer` that was **never
 * started** — no interval, no socket, no timer of any kind exists — and reads
 * `buildSnapshot()` directly. If the implementation needed a timer to be
 * correct, nothing in this file could pass.
 */

let storeCounter = 0;
function uniqueStorePath(): string {
  storeCounter += 1;
  return `./data/test-display-hero-${process.pid}-${Date.now()}-${storeCounter}.sqlite`;
}
const openStores: LocalStore[] = [];
function makeStore(): LocalStore {
  const store = new LocalStore(uniqueStorePath());
  openStores.push(store);
  return store;
}

afterEach(() => {
  vi.useRealTimers();
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

function makeQueue(
  store: LocalStore,
  announcement: { jobId: string; endsAt: number; remainingSeconds: number } | null = null,
): Partial<QueueService> {
  return {
    getQueuePosition: () => undefined,
    getQueueLength: () => store.getQueueLength(),
    getAnnouncement: () => announcement,
  };
}

/** Reaches the private builder deliberately: `buildSnapshot()` is exactly the
 * unit under test, and routing through a live WebSocket would drag in the very
 * timers this file exists to prove are absent. */
function snapshotOf(display: DisplayServer): DisplaySnapshot {
  return (display as unknown as { buildSnapshot(): DisplaySnapshot }).buildSnapshot();
}

function seedActiveEvent(store: LocalStore, name = 'Đám cưới Minh & Lan'): string {
  const event = store.createEvent({ name });
  store.setActiveEvent(event.id);
  return event.id;
}

function seedQueuedGuest(store: LocalStore, id: string, name: string): void {
  store.upsertRegistration({
    id,
    name,
    email: '',
    phone: '',
    mode: 'standard',
    registered_at: new Date().toISOString(),
  });
  store.enqueueJob({ id, queued_at: Date.now() });
}

const HERO_TTL_MS = 12_000;

describe('DisplaySnapshot.justCaptured — derived per tick, never stored (D-09, Pitfall 1)', () => {
  it('shows the guest who just finished, then stops on its own with no timer involved', () => {
    vi.useFakeTimers();
    const capturedAt = Date.UTC(2026, 7, 12, 10, 0, 0);
    vi.setSystemTime(capturedAt);

    const store = makeStore();
    const eventId = seedActiveEvent(store);
    store.recordEventPhoto({
      jobId: 'job-1',
      eventId,
      guestName: 'Trần Quốc Bảo',
      photoUrl: 'https://fotoshare.co/i/hero1',
      capturedAt,
    });

    const display = new DisplayServer(
      makeQueue(store) as QueueService,
      makeAgent() as AgentServer,
      store,
      { heroMomentDurationMs: HERO_TTL_MS },
    );

    // One millisecond inside the window.
    vi.setSystemTime(capturedAt + HERO_TTL_MS - 1);
    const inside = snapshotOf(display);
    expect(inside.justCaptured).toEqual({
      photoUrl: 'https://fotoshare.co/i/hero1',
      name: 'Trần Quốc Bảo',
    });

    // One millisecond past it, on the SAME never-started instance. Nothing
    // fired; the clock simply moved and the derivation noticed.
    vi.setSystemTime(capturedAt + HERO_TTL_MS + 1);
    expect(snapshotOf(display).justCaptured).toBeNull();

    // The mechanical form of the same claim: no deferred callback exists to
    // have done this. A `setTimeout(() => this.justCaptured = null, ttl)`
    // implementation would have scheduled one here.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is correct for a photo captured before the server object even existed (restart mid-hero)', () => {
    vi.useFakeTimers();
    const capturedAt = Date.UTC(2026, 7, 12, 11, 0, 0);
    vi.setSystemTime(capturedAt);

    const store = makeStore();
    const eventId = seedActiveEvent(store);
    store.recordEventPhoto({
      jobId: 'job-2',
      eventId,
      guestName: 'Lê Hoàng Phúc',
      photoUrl: 'https://fotoshare.co/i/hero2',
      capturedAt,
    });

    // The restart: the DisplayServer is constructed AFTER the capture, three
    // seconds into the window. A timer-based implementation lost its callback
    // with the old process; a derived one reads captured_at back off disk.
    vi.setSystemTime(capturedAt + 3_000);
    const fresh = new DisplayServer(
      makeQueue(store) as QueueService,
      makeAgent() as AgentServer,
      store,
      { heroMomentDurationMs: HERO_TTL_MS },
    );
    expect(snapshotOf(fresh).justCaptured).not.toBeNull();

    // And a restart AFTER the window correctly shows nothing, rather than
    // resurrecting a hero moment that already ended.
    vi.setSystemTime(capturedAt + HERO_TTL_MS + 5_000);
    const later = new DisplayServer(
      makeQueue(store) as QueueService,
      makeAgent() as AgentServer,
      store,
      { heroMomentDurationMs: HERO_TTL_MS },
    );
    expect(snapshotOf(later).justCaptured).toBeNull();
  });

  it('honours the injected TTL rather than a hard-coded one', () => {
    vi.useFakeTimers();
    const capturedAt = Date.UTC(2026, 7, 12, 12, 0, 0);
    vi.setSystemTime(capturedAt);

    const store = makeStore();
    const eventId = seedActiveEvent(store);
    store.recordEventPhoto({
      jobId: 'job-3',
      eventId,
      guestName: 'Phạm Ngọc Diệp',
      photoUrl: 'https://fotoshare.co/i/hero3',
      capturedAt,
    });

    const short = new DisplayServer(
      makeQueue(store) as QueueService,
      makeAgent() as AgentServer,
      store,
      { heroMomentDurationMs: 1_000 },
    );
    const long = new DisplayServer(
      makeQueue(store) as QueueService,
      makeAgent() as AgentServer,
      store,
      { heroMomentDurationMs: 60_000 },
    );

    vi.setSystemTime(capturedAt + 5_000);
    expect(snapshotOf(short).justCaptured).toBeNull();
    expect(snapshotOf(long).justCaptured).not.toBeNull();
  });

  it('never confuses the guest being announced with the guest who just finished', () => {
    vi.useFakeTimers();
    const capturedAt = Date.UTC(2026, 7, 12, 13, 0, 0);
    vi.setSystemTime(capturedAt);

    const store = makeStore();
    const eventId = seedActiveEvent(store);
    // The guest who just shot and is walking away.
    store.recordEventPhoto({
      jobId: 'job-done',
      eventId,
      guestName: 'Nguyễn Thị Hồng Ánh',
      photoUrl: 'https://fotoshare.co/i/hero4',
      capturedAt,
    });
    // A different person entirely, being called to the booth right now.
    seedQueuedGuest(store, 'job-next', 'Vũ Đình Trọng');

    const display = new DisplayServer(
      makeQueue(store, { jobId: 'job-next', endsAt: capturedAt + 7_000, remainingSeconds: 7 }) as QueueService,
      makeAgent() as AgentServer,
      store,
      { heroMomentDurationMs: HERO_TTL_MS },
    );

    vi.setSystemTime(capturedAt + 1_000);
    const snapshot = snapshotOf(display);

    // D-09's actual failure mode: one name overwriting the other. Two people
    // are on this screen at this instant and they are not the same person.
    expect(snapshot.guestName).toBe('Vũ Đình Trọng');
    expect(snapshot.justCaptured?.name).toBe('Nguyễn Thị Hồng Ánh');
    expect(snapshot.guestName).not.toBe(snapshot.justCaptured?.name);
  });

  it('is null with no active event, and null when the active event has no photos', () => {
    const store = makeStore();
    const display = new DisplayServer(
      makeQueue(store) as QueueService,
      makeAgent() as AgentServer,
      store,
      { heroMomentDurationMs: HERO_TTL_MS },
    );

    // Zero rows anywhere — the UI-01 boot state.
    expect(snapshotOf(display).justCaptured).toBeNull();

    // An active event that simply has not seen a capture yet.
    seedActiveEvent(store);
    expect(snapshotOf(display).justCaptured).toBeNull();
  });

  it('does not leak a photo from a different event onto the active event screen', () => {
    vi.useFakeTimers();
    const capturedAt = Date.UTC(2026, 7, 12, 14, 0, 0);
    vi.setSystemTime(capturedAt);

    const store = makeStore();
    const other = store.createEvent({ name: 'Sự kiện khác' });
    store.recordEventPhoto({
      jobId: 'job-other',
      eventId: other.id,
      guestName: 'Khách sự kiện khác',
      photoUrl: 'https://fotoshare.co/i/other',
      capturedAt,
    });
    seedActiveEvent(store, 'Sự kiện đang diễn ra');

    const display = new DisplayServer(
      makeQueue(store) as QueueService,
      makeAgent() as AgentServer,
      store,
      { heroMomentDurationMs: HERO_TTL_MS },
    );

    vi.setSystemTime(capturedAt + 1_000);
    expect(snapshotOf(display).justCaptured).toBeNull();
  });

  it('serialises identically on repeated evaluations inside the window, so the diff guard holds', () => {
    vi.useFakeTimers();
    const capturedAt = Date.UTC(2026, 7, 12, 15, 0, 0);
    vi.setSystemTime(capturedAt);

    const store = makeStore();
    const eventId = seedActiveEvent(store);
    store.recordEventPhoto({
      jobId: 'job-5',
      eventId,
      guestName: 'Hoàng Mỹ Duyên',
      photoUrl: 'https://fotoshare.co/i/hero5',
      capturedAt,
    });

    const display = new DisplayServer(
      makeQueue(store) as QueueService,
      makeAgent() as AgentServer,
      store,
      { heroMomentDurationMs: HERO_TTL_MS },
    );

    // Four consecutive poll ticks inside the window. If `justCaptured` carried
    // a remaining-time or an elapsed-ms field, these would differ and
    // maybeBroadcast()'s `msg === this.lastSent` guard would send on every
    // 250ms tick — a broadcast flood to every TV in the venue.
    const serialised = new Set<string>();
    for (let i = 0; i < 4; i += 1) {
      vi.setSystemTime(capturedAt + 1_000 + i * 250);
      serialised.add(JSON.stringify(snapshotOf(display).justCaptured));
    }
    expect(serialised.size).toBe(1);
  });

  it('the served page carries the hero branch keyed on justCaptured', () => {
    expect(renderDisplayPage()).toContain('justCaptured');
  });
});
