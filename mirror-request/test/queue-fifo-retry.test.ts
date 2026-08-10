import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalStore } from '../src/state/localStore';
import logger, { mask } from '../src/logging/logger';

// A real-LocalStore suite on a per-file temp database (matches
// test/db-poller.test.ts's harness). Never calls getStore() — 02-VALIDATION.md
// binds all Phase 2 queue/booth tests to either a mocked LocalStore or a
// per-file temp DB via the constructor(dbPath?) seam, because booth_state is
// a single global row with no per-test id to scope an assertion to.
describe('LocalStore.enqueueJob — FIFO position logging and retry-preserves-position (QUE-01, D-06)', () => {
  let dir: string;
  let dbPath: string;
  let store: LocalStore;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-queue-fifo-'));
    dbPath = path.join(dir, 'test.sqlite');
    store = new LocalStore(dbPath);
    infoSpy = vi.spyOn(logger, 'info');
  });

  afterEach(() => {
    infoSpy.mockRestore();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function capturedMessages(): string[] {
    return infoSpy.mock.calls.map((call) => call[0] as string);
  }

  // Random UUIDs occasionally contain a run of 7+ consecutive digits by
  // chance, which mask()'s pre-existing PHONE_RE would then partially
  // asterisk — a known, out-of-scope false positive (STATE.md Known Issues,
  // test/logging-mask.test.ts's safeId()). Break up digit runs so the ids
  // used here match "the shape this service actually receives" without
  // tripping that unrelated, already-flagged limitation.
  function safeId(prefix: string): string {
    return `${prefix}-${randomUUID().replace(/(\d)(?=\d)/g, '$1x')}`;
  }

  it('enqueuing two ids in order reports positions 1 and 2 and the queue length at each moment', () => {
    const first = safeId('guest-a');
    const second = safeId('guest-b');

    store.enqueueJob({ id: first, queued_at: 1000 });
    store.enqueueJob({ id: second, queued_at: 2000 });

    const logs = capturedMessages();
    expect(logs.some((m) => m.includes(first) && m.includes('at position') && m.includes('position 1 of 1'))).toBe(true);
    expect(logs.some((m) => m.includes(second) && m.includes('at position') && m.includes('position 2 of 2'))).toBe(true);
  });

  it('enqueuing the same id twice creates one row and the second call logs that it was not re-queued', () => {
    const id = safeId('guest-dup');

    store.enqueueJob({ id, queued_at: 1000 });
    store.enqueueJob({ id, queued_at: 5000 });

    const rows = store.getQueuedJobs().filter((j) => j.id === id);
    expect(rows).toHaveLength(1);
    expect(rows[0].queued_at).toBe(1000);

    const logs = capturedMessages();
    const positionLine = logs.filter((m) => m.includes(id) && m.includes('at position'));
    expect(positionLine).toHaveLength(1);
    const dupLine = logs.find((m) => m.includes(id) && !m.includes('at position'));
    expect(dupLine).toBeDefined();
    expect(dupLine).toMatch(/not re-queued/i);
  });

  it('after the first guest is dispatched and requeued via requeueWithRetry, getNextQueuedJob still returns them first, with queued_at untouched and retries at 1', () => {
    const first = safeId('guest-1');
    const second = safeId('guest-2');

    store.enqueueJob({ id: first, queued_at: 1000 });
    store.enqueueJob({ id: second, queued_at: 2000 });

    expect(store.getQueuePosition(first)).toBe(1);
    expect(store.getQueuePosition(second)).toBe(2);

    store.updateJobStatus(first, 'dispatched', 'dispatched_at', 1500);
    const { retries } = store.requeueWithRetry(first);

    expect(retries).toBe(1);

    const next = store.getNextQueuedJob();
    expect(next?.id).toBe(first);
    expect(next?.queued_at).toBe(1000);
    expect(next?.retries).toBe(1);
  });

  it('a job requeued twice then failed disappears from getQueuedJobs, and the guest behind it becomes next', () => {
    const stuck = safeId('guest-x');
    const behind = safeId('guest-y');

    store.enqueueJob({ id: stuck, queued_at: 1000 });
    store.enqueueJob({ id: behind, queued_at: 2000 });

    store.updateJobStatus(stuck, 'dispatched', 'dispatched_at', 1100);
    store.requeueWithRetry(stuck);
    store.updateJobStatus(stuck, 'dispatched', 'dispatched_at', 1200);
    store.requeueWithRetry(stuck);
    store.failJob(stuck, 'session_ack_timeout');

    const queued = store.getQueuedJobs();
    expect(queued.find((j) => j.id === stuck)).toBeUndefined();
    expect(store.getNextQueuedJob()?.id).toBe(behind);
  });

  it('every message enqueueJob emits is unchanged by mask() for ids of the shape this service actually receives', () => {
    const id = safeId('reg');

    store.enqueueJob({ id, queued_at: 3000 });
    store.enqueueJob({ id, queued_at: 9000 });

    const logs = capturedMessages();
    expect(logs.length).toBeGreaterThan(0);
    for (const msg of logs) {
      expect(mask(msg)).toBe(msg);
    }
  });
});
