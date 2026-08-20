import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { LocalStore } from '../src/state/localStore';

// ---------------------------------------------------------------------------
// getQueueLength() answers with COUNT(*) instead of materialising every queued
// row and taking .length.
//
// Found by a full-journey load test on 2026-08-16, not by reading the code:
// with 392 guests waiting and the display timer running at 4 Hz, this one call
// cost 3.4ms per tick — more than building the entire rest of the snapshot
// against a 10,000-photo history. It is invisible at the queue depths a test
// suite or a quiet afternoon produces, and it grows with the line.
//
// Two things have to hold, and the second is the one that matters. The count
// must be RIGHT — identical to what the old implementation returned, for every
// mix of statuses — and it must not degrade with queue depth. A rewrite that
// is fast and subtly wrong would move the guest-position number on every
// screen in the venue.
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];
const openStores: LocalStore[] = [];

function makeStore(): LocalStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-length-'));
  tmpDirs.push(dir);
  const store = new LocalStore(path.join(dir, 'store.sqlite'));
  openStores.push(store);
  return store;
}

function db(store: LocalStore): Database.Database {
  return (store as unknown as { db: Database.Database }).db;
}

/** Seed a queue with a given mix of statuses. */
function seed(store: LocalStore, mix: Record<string, number>): void {
  const handle = db(store);
  const reg = handle.prepare(
    "INSERT INTO registration (id,name,email,phone,mode,registered_at,raw_payload,received_at) VALUES (?,?,'','','standard','now',NULL,?)",
  );
  const job = handle.prepare('INSERT INTO queue_job (id,registration_id,status,queued_at) VALUES (?,?,?,?)');
  let n = 0;
  handle.exec('BEGIN');
  for (const [status, count] of Object.entries(mix)) {
    for (let i = 0; i < count; i += 1) {
      n += 1;
      reg.run('r' + n, 'Guest ' + n, 1_786_000_000_000 + n);
      job.run('j' + n, 'r' + n, status, 1_786_000_000_000 + n);
    }
  }
  handle.exec('COMMIT');
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
    fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
  }
});

describe('getQueueLength()', () => {
  it('is zero on an empty queue', () => {
    expect(makeStore().getQueueLength()).toBe(0);
  });

  it('counts only queued rows, never the ones the booth has finished with', () => {
    const store = makeStore();
    seed(store, { queued: 7, dispatched: 1, in_progress: 1, completed: 40, failed: 3, no_photo: 2 });
    expect(store.getQueueLength()).toBe(7);
  });

  it('returns exactly what the previous implementation returned', () => {
    // The equivalence pin. getQueuedJobs() is the old definition's source, and
    // it is still used elsewhere, so it stays available as an oracle. If the
    // two ever disagree, the rewrite changed behaviour and the number on every
    // room screen moved with it.
    const store = makeStore();
    for (const mix of [
      { queued: 0, completed: 5 },
      { queued: 1 },
      { queued: 3, dispatched: 1, completed: 9 },
      { queued: 250, completed: 300, failed: 12 },
    ]) {
      const fresh = makeStore();
      seed(fresh, mix);
      expect(fresh.getQueueLength()).toBe(fresh.getQueuedJobs().length);
    }
    expect(store.getQueueLength()).toBe(0);
  });

  it('reads through the index rather than scanning the table', () => {
    // The structural half of the fix. COUNT(*) over a scan would still be
    // O(n); what makes the cost independent of queue depth is that the
    // predicate rides idx_queue_job_status_queued_at's leading column.
    const store = makeStore();
    seed(store, { queued: 20, completed: 200 });
    const detail = (
      db(store)
        .prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM queue_job WHERE status = 'queued'")
        .all() as Array<{ detail: string }>
    )
      .map((r) => r.detail)
      .join(' | ');
    expect(detail).toContain('idx_queue_job_status_queued_at');
    expect(detail).not.toContain('SCAN queue_job');
  });

  it('does not get slower as the queue gets longer', () => {
    // The property the load test was measuring. Asserted as a ratio rather
    // than an absolute duration so it does not turn into a flaky benchmark on
    // a loaded CI box: the old implementation was 84x slower at 400 than the
    // new one, so a 10x-depth increase costing anywhere near 10x more time
    // means the O(n) read has come back.
    const shallow = makeStore();
    seed(shallow, { queued: 40 });
    const deep = makeStore();
    seed(deep, { queued: 400 });

    const time = (store: LocalStore): number => {
      for (let i = 0; i < 50; i += 1) store.getQueueLength();
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < 500; i += 1) store.getQueueLength();
      return Number(process.hrtime.bigint() - t0) / 500;
    };

    expect(shallow.getQueueLength()).toBe(40);
    expect(deep.getQueueLength()).toBe(400);
    // Ten times the rows must not cost anything like ten times the time.
    expect(time(deep) / time(shallow)).toBeLessThan(3);
  });
});
