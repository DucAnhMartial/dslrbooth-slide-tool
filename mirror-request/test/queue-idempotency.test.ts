import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalStore } from '../src/state/localStore';
import type { QueueJob } from '../src/types';

// A real-LocalStore integration suite on a per-file temp database (matches
// test/db-poller.test.ts's harness). Never calls getStore() — 02-VALIDATION.md
// binds all Phase 2 queue/booth tests to a mocked LocalStore or a per-file
// temp DB via constructor(dbPath?). Counting rows is safe here because this
// file owns its database; no assertion below touches a row this file did not
// create, and none counts a total table size without a filter.
//
// This task adds no production code (D-11): QUE-02 is already satisfied by
// Phase 1's processed_id table and enqueueJob's INSERT OR IGNORE. What D-12
// owes is the proof below that the retry path this phase introduced cannot
// create a second queue_job row for one registration.
describe('LocalStore — one registration can never become two queue_job rows, retry path included (QUE-02, D-11, D-12)', () => {
  let dir: string;
  let dbPath: string;
  let store: LocalStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-queue-idempotency-'));
    dbPath = path.join(dir, 'test.sqlite');
    store = new LocalStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function safeId(prefix: string): string {
    return `${prefix}-${randomUUID().replace(/(\d)(?=\d)/g, '$1x')}`;
  }

  function seedRegistration(id: string): void {
    store.upsertRegistration({
      id,
      name: 'Test Guest',
      email: `${id}@example.com`,
      phone: '',
      mode: 'standard',
      registered_at: new Date().toISOString(),
    });
  }

  function registrationIdOf(id: string): string | undefined {
    const job = store.getJob(id) as (QueueJob & { registration_id?: string }) | undefined;
    return job?.registration_id;
  }

  it('two enqueueJob calls with the same id and different queued_at values leave one row carrying the first queued_at', () => {
    const id = safeId('reg');
    seedRegistration(id);

    store.enqueueJob({ id, queued_at: 1000 });
    store.enqueueJob({ id, queued_at: 9000 });

    const rows = store.getQueuedJobs().filter((j) => j.id === id);
    expect(rows).toHaveLength(1);
    expect(rows[0].queued_at).toBe(1000);
    expect(store.getJob(id)?.queued_at).toBe(1000);
  });

  it('re-enqueuing after requeueWithRetry leaves one row with retries still 1 and queued_at untouched', () => {
    const id = safeId('reg');
    seedRegistration(id);

    store.enqueueJob({ id, queued_at: 1000 });
    store.updateJobStatus(id, 'dispatched', 'dispatched_at', 1100);
    const { retries } = store.requeueWithRetry(id);
    expect(retries).toBe(1);

    // A second registration arriving with the same id (e.g. a resubmitted
    // webhook) must not create a second row or reset the retry/position state.
    store.enqueueJob({ id, queued_at: 5000 });

    const rows = store.getQueuedJobs().filter((j) => j.id === id);
    expect(rows).toHaveLength(1);
    expect(rows[0].retries).toBe(1);
    expect(rows[0].queued_at).toBe(1000);
    expect(store.getJob(id)?.status).toBe('queued');
  });

  it('re-enqueuing after failJob has made the job terminal does not resurrect it: row count stays 1, status stays failed', () => {
    const id = safeId('reg');
    seedRegistration(id);

    store.enqueueJob({ id, queued_at: 1000 });
    store.updateJobStatus(id, 'dispatched', 'dispatched_at', 1100);
    store.requeueWithRetry(id);
    store.updateJobStatus(id, 'dispatched', 'dispatched_at', 1200);
    store.requeueWithRetry(id);
    store.failJob(id, 'session_ack_timeout');

    store.enqueueJob({ id, queued_at: 9000 });

    const totalRows = [store.getJob(id)].filter(Boolean);
    expect(totalRows).toHaveLength(1);
    expect(store.getJob(id)?.status).toBe('failed');
    expect(store.getQueuedJobs().find((j) => j.id === id)).toBeUndefined();
  });

  it('registration_id on the single row equals the registration id it was created from', () => {
    const id = safeId('reg');
    seedRegistration(id);

    store.enqueueJob({ id, queued_at: 1000 });
    store.enqueueJob({ id, queued_at: 4000 });

    expect(registrationIdOf(id)).toBe(id);
  });

  it('markProcessed/isProcessed report the id as processed independently of the queue row status', () => {
    const id = safeId('reg');
    seedRegistration(id);

    expect(store.isProcessed(id)).toBe(false);
    store.markProcessed(id);
    expect(store.isProcessed(id)).toBe(true);

    store.enqueueJob({ id, queued_at: 1000 });
    store.updateJobStatus(id, 'dispatched', 'dispatched_at', 1100);
    store.requeueWithRetry(id);
    store.updateJobStatus(id, 'dispatched', 'dispatched_at', 1200);
    store.requeueWithRetry(id);
    store.failJob(id, 'session_ack_timeout');

    // Independent of the queue row's terminal status.
    expect(store.isProcessed(id)).toBe(true);
  });
});
