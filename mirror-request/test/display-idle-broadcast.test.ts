import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalStore } from '../src/state/localStore';
import { DisplayServer } from '../src/display/displayServer';
import type { QueueService } from '../src/queue/queueService';
import type { AgentServer } from '../src/agent/agentServer';

// ---------------------------------------------------------------------------
// The idle guard, added after the 2026-08-16 audit measured what an unattended
// service was doing: buildSnapshot() issues roughly eight store reads and the
// broadcast timer fired four times a second whether or not a single screen was
// connected — about thirty-two queries a second, indefinitely, against tables
// that D-11 forbids trimming.
//
// The property under test is specifically that the guard runs BEFORE the
// snapshot is built, not before it is sent. A guard placed after the build
// would look identical from the outside — no client receives anything either
// way — while still paying every query. So these cases assert on the store
// being untouched, never on send() not being called.
//
// Every case drives maybeBroadcast() directly on a server that was never
// start()ed: no interval, no socket, no timer. If the guard needed the real
// lifecycle to be correct, nothing here could pass.
// ---------------------------------------------------------------------------

let storeCounter = 0;
const openStores: LocalStore[] = [];

function makeStore(): LocalStore {
  storeCounter += 1;
  const store = new LocalStore(`./data/test-display-idle-${process.pid}-${Date.now()}-${storeCounter}.sqlite`);
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

/** A stand-in for a connected browser: open, and counting what it is sent. */
function fakeClient(): { readyState: number; send: ReturnType<typeof vi.fn> } {
  return { readyState: 1 /* WebSocket.OPEN */, send: vi.fn() };
}

interface Internals {
  clients: Set<unknown>;
  maybeBroadcast(): void;
  lastSent: string | null;
}

function build(): { server: DisplayServer; internals: Internals; reads: () => number; store: LocalStore } {
  const store = makeStore();

  // Every read buildSnapshot() makes, counted through one shared spy. Spying
  // on the store rather than on buildSnapshot itself is the point: the claim
  // is about queries not being issued, and buildSnapshot() could be called
  // and cheap, or not called and expensive, without this distinction.
  let reads = 0;
  for (const method of [
    'getQueuedGuestSummaries',
    'getActiveEventConfig',
    'getActiveEventId',
    'getMostRecentEventPhoto',
    'listEventPhotos',
    'getBoothState',
  ] as const) {
    const original = store[method].bind(store) as (...args: unknown[]) => unknown;
    vi.spyOn(store, method).mockImplementation(((...args: unknown[]) => {
      reads += 1;
      return original(...args);
    }) as never);
  }

  const queue = {
    getAnnouncement: () => null,
    getQueueLength: () => {
      reads += 1;
      return 0;
    },
  } as unknown as QueueService;
  const agent = { isAgentOnline: () => true } as unknown as AgentServer;

  const server = new DisplayServer(queue, agent, store, { displayWhitelist: [] });
  return { server, internals: server as unknown as Internals, reads: () => reads, store };
}

describe('the display broadcast tick while no screen is connected', () => {
  it('issues no store reads at all when there are zero clients', () => {
    const { internals, reads } = build();
    expect(internals.clients.size).toBe(0);

    for (let i = 0; i < 40; i += 1) internals.maybeBroadcast();

    // Forty ticks is ten seconds of real time at the 250ms interval.
    expect(reads()).toBe(0);
  });

  it('resumes reading and sending the moment a client is present', () => {
    const { internals, reads } = build();
    const client = fakeClient();

    internals.maybeBroadcast();
    expect(reads()).toBe(0);

    internals.clients.add(client);
    internals.maybeBroadcast();

    expect(reads()).toBeGreaterThan(0);
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it('does not strand a stale lastSent when the room empties and refills', () => {
    // The one way an idle guard can go wrong: `lastSent` is deliberately NOT
    // cleared while idle, so a snapshot that changed during the empty period
    // must still reach the next client. It does, because the diff is never
    // consulted for a newly connected client — the connection handler sends
    // unconditionally and reseeds lastSent. This case pins the equivalent
    // behaviour at the maybeBroadcast() layer: a tick with a client present
    // after a changed snapshot sends, even though lastSent is stale.
    const { internals } = build();

    const first = fakeClient();
    internals.clients.add(first);
    internals.maybeBroadcast();
    const seeded = internals.lastSent;
    expect(seeded).toBeTruthy();

    // Room empties. Ticks keep firing; nothing is read, nothing is sent, and
    // lastSent is left exactly as it was.
    internals.clients.delete(first);
    for (let i = 0; i < 10; i += 1) internals.maybeBroadcast();
    expect(internals.lastSent).toBe(seeded);

    // A screen arrives and the snapshot has since changed underneath.
    const second = fakeClient();
    internals.clients.add(second);
    internals.lastSent = 'a snapshot that is no longer current';
    internals.maybeBroadcast();
    expect(second.send).toHaveBeenCalledTimes(1);
    expect(internals.lastSent).not.toBe('a snapshot that is no longer current');
  });

  it('still suppresses an unchanged snapshot when a client IS connected', () => {
    // The pre-existing D-13 diff must survive the new guard: with a client
    // connected and nothing moving, the second tick reads the store but sends
    // nothing.
    const { internals } = build();
    const client = fakeClient();
    internals.clients.add(client);

    internals.maybeBroadcast();
    internals.maybeBroadcast();

    expect(client.send).toHaveBeenCalledTimes(1);
  });
});
