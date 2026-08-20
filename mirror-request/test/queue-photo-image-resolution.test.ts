import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { LocalStore } from '../src/state/localStore';
import { QueueService } from '../src/queue/queueService';

// ---------------------------------------------------------------------------
// Resolving the share page must never cost a capture.
//
// `writePhotoHistory()` is reached from the SYNCHRONOUS Agent-event path. The
// resolution it now triggers is a network call to a third party that can be
// slow, hang, 500, or return markup nobody expected. The guarantee under test
// here is the ordering: the row is written FIRST and unconditionally, the
// resolution is fire-and-forget, and every failure mode leaves the history
// row exactly as it would have been before this change existed.
//
// The resolver is injected. A suite that reached fotoshare.co would go red
// whenever someone's wifi did, and would prove nothing about this ordering.
//
// D11-02/D11-04/D11-05 (phase 11): `writePhotoHistory()` is now called from
// `finalizePendingPrint()`, not from `onFileUpload()` directly — an upload
// only WRITES the URL into the pending-print slot (D11-04); the history row,
// and the resolver call this whole file is about, both wait for one of
// D11-05's three finalize doors to open. Every case below adds the approving
// `printing` this phase requires — the ordering guarantee under test (row
// written before the resolver answers) is otherwise completely unchanged.
// ---------------------------------------------------------------------------

const SHARE = 'https://fotoshare.co/i/3knbmax';
const DIRECT = 'https://cdn-bz-op.fotoshare.co/b/833cf/x/20260813_135523_092_1x.jpg';
const COMPOSITE = 'C:\\dslrBooth\\Prints\\x_2x.jpg';

const tmpDirs: string[] = [];
const openStores: LocalStore[] = [];

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-queue-imgres-'));
  tmpDirs.push(dir);
  const dbPath = path.join(dir, 'test.sqlite');
  const store = new LocalStore(dbPath);
  openStores.push(store);

  // `enqueueJob` sets registration_id = id, so the registration must carry
  // the job's own id for `getJobRegistration()` to resolve a guest name.
  store.upsertRegistration({
    id: 'JOB1', name: 'Nguyen Duc Anh', email: 'a@b.c', phone: '0900000000',
    mode: 'photo', registered_at: new Date().toISOString(),
  });
  store.enqueueJob({ id: 'JOB1', queued_at: Date.now() });
  // Phase 7 D-07: a print upload is delivered against the PENDING-PRINT
  // registry, never against whoever owns the booth at that instant. No slot
  // means the upload is dropped as a stranger's, so the harness must open one
  // exactly as a real session does.
  store.openPendingPrint({
    jobId: 'JOB1',
    compositePath: COMPOSITE,
    openedAt: Date.now(),
    expiresAt: Date.now() + 600_000,
  });
  store.createEvent({ name: 'E' });
  const eventId = store.listEvents()[0].id;
  store.setActiveEvent(eventId);

  const qs = new QueueService(store);
  return { store, qs, eventId, dbPath };
}

/**
 * D11-05 door 1. Every case in this file needs the finalize gate to actually
 * open before `writePhotoHistory()`/the resolver can be reached — an upload
 * alone (D11-04) only writes the URL. Binds the booth and opens an attempt
 * directly (this harness never runs a full dispatch/session_start cycle),
 * then sends an approving `printing` whose composite stem matches the one
 * `harness()` already opened the slot with.
 */
function approve(store: LocalStore, qs: QueueService): void {
  store.setBoothBusy('JOB1');
  store.openBoothAttempt();
  qs.onAgentEvent('printing', 'JOB1', { param1: COMPOSITE });
}

function rawImageUrl(dbPath: string, jobId = 'JOB1'): string | null {
  const raw = new Database(dbPath, { readonly: true });
  const row = raw.prepare('SELECT image_url FROM event_photo WHERE jobId = ?').get(jobId) as
    | { image_url: string | null }
    | undefined;
  raw.close();
  return row?.image_url ?? null;
}

afterEach(() => {
  while (openStores.length) {
    try {
      openStores.pop()?.close();
    } catch {
      /* already closed */
    }
  }
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('the print upload records first and resolves after', () => {
  it('writes the history row before the resolver has answered anything', async () => {
    const { store, qs, eventId, dbPath } = harness();
    let release!: (v: string | undefined) => void;
    qs.bindImageUrlResolver(() => new Promise<string | undefined>((res) => { release = res; }));

    qs.onAgentEvent('file_upload', 'JOB1', { param3: 'print', param2: SHARE });
    // D11-04: written to the slot, not yet resolved — no history row exists
    // until a door opens.
    expect(store.getMostRecentEventPhoto(eventId)).toBeUndefined();

    approve(store, qs);

    // The resolver is still hanging. The row must already exist, with the
    // share URL standing in — a guest's photo cannot be contingent on a
    // third party answering.
    expect(store.getMostRecentEventPhoto(eventId)?.photoUrl).toBe(SHARE);
    expect(rawImageUrl(dbPath)).toBeNull();

    release(DIRECT);
    await vi.waitFor(() => expect(rawImageUrl(dbPath)).toBe(DIRECT));
  });

  it('once resolved, the display projection hands out the direct file', async () => {
    const { store, qs, eventId } = harness();
    qs.bindImageUrlResolver(async () => DIRECT);

    qs.onAgentEvent('file_upload', 'JOB1', { param3: 'print', param2: SHARE });
    approve(store, qs);

    await vi.waitFor(() => {
      expect(store.getMostRecentEventPhoto(eventId)?.photoUrl).toBe(DIRECT);
    });
  });

  it('a resolver that REJECTS leaves the row intact and does not throw at the caller', async () => {
    const { store, qs, eventId, dbPath } = harness();
    qs.bindImageUrlResolver(async () => {
      throw new Error('fotoshare exploded');
    });

    qs.onAgentEvent('file_upload', 'JOB1', { param3: 'print', param2: SHARE });
    // The synchronous handler must not observe the rejection.
    expect(() => approve(store, qs)).not.toThrow();

    await new Promise((r) => setTimeout(r, 20));
    expect(store.getMostRecentEventPhoto(eventId)?.photoUrl).toBe(SHARE);
    expect(rawImageUrl(dbPath)).toBeNull();
  });

  it('a resolver that gives up (undefined) leaves the share URL in place', async () => {
    const { store, qs, eventId, dbPath } = harness();
    qs.bindImageUrlResolver(async () => undefined);

    qs.onAgentEvent('file_upload', 'JOB1', { param3: 'print', param2: SHARE });
    approve(store, qs);

    await new Promise((r) => setTimeout(r, 20));
    expect(store.getMostRecentEventPhoto(eventId)?.photoUrl).toBe(SHARE);
    expect(rawImageUrl(dbPath)).toBeNull();
  });

  it('the guest is still sent the SHARE page, never the resolved file', async () => {
    const { store, qs } = harness();
    const delivered: Array<[string, string]> = [];
    qs.bindNotificationService({
      sendPhotoLink: async (jobId, url) => { delivered.push([jobId, url]); },
    });
    qs.bindImageUrlResolver(async () => DIRECT);

    qs.onAgentEvent('file_upload', 'JOB1', { param3: 'print', param2: SHARE });
    approve(store, qs);
    await new Promise((r) => setTimeout(r, 20));

    // NOT-01/NOT-02: the guest wants a page they can open and download from.
    // Handing them a raw CDN file would be a silent downgrade, and it is the
    // exact mistake two columns exist to prevent.
    expect(delivered).toEqual([['JOB1', SHARE]]);
  });

  // -------------------------------------------------------------------------
  // Non-vacuity: the resolver must actually be reached for a real print, and
  // must NOT be reached for the things that are not one.
  // -------------------------------------------------------------------------

  it('does not resolve for a non-print upload', async () => {
    const { qs } = harness();
    const calls: string[] = [];
    qs.bindImageUrlResolver(async (u) => { calls.push(u); return DIRECT; });

    qs.onAgentEvent('file_upload', 'JOB1', { param3: 'original', param2: SHARE });

    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([]);
  });

  it('does not resolve when there is no active event — nothing was recorded to attach to', async () => {
    const { store, qs } = harness();
    store.setActiveEvent(null);
    const calls: string[] = [];
    qs.bindImageUrlResolver(async (u) => { calls.push(u); return DIRECT; });

    qs.onAgentEvent('file_upload', 'JOB1', { param3: 'print', param2: SHARE });
    approve(store, qs);

    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([]);
  });

  it('IS reached, with the share url, for a real print upload', async () => {
    const { store, qs } = harness();
    const calls: string[] = [];
    qs.bindImageUrlResolver(async (u) => { calls.push(u); return DIRECT; });

    qs.onAgentEvent('file_upload', 'JOB1', { param3: 'print', param2: SHARE });
    approve(store, qs);

    await vi.waitFor(() => expect(calls).toEqual([SHARE]));
  });
});
