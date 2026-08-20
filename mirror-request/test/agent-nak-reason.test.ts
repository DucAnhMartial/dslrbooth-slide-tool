import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalStore } from '../src/state/localStore';
import { QueueService, queueLogger } from '../src/queue/queueService';
import { GUEST_STATUSES } from '../src/status/guestStatus';

// ---------------------------------------------------------------------------
// Why a refused capture must leave a reason behind.
//
// Found while reading four real failed jobs. All four carried
// `stall_reason = 'agent_nak'` — the Agent refused the start_session — and not
// one of them recorded WHY. Two causes, both in `onAgentAck`:
//
//   1. the Agent's message was logged at DEBUG, and this service runs at
//      `info`, so the line was never written to a file at all; and
//   2. `ack_error_message` — a column that has existed since Phase 2 — was
//      never written to by any code path in the service.
//
// So the one party who knew what went wrong told us, and we discarded it
// twice. These cases pin both halves, plus the boundary that makes storing it
// safe: `ack_error_message` is an operator word and may never reach a guest.
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];
const openStores: LocalStore[] = [];

function makeStore(): LocalStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-nak-'));
  tmpDirs.push(dir);
  const store = new LocalStore(path.join(dir, 'test.sqlite'));
  openStores.push(store);
  return store;
}

/** A queued job, driven the way production makes one. */
function queueJob(store: LocalStore, jobId: string): void {
  store.upsertRegistration({
    id: jobId,
    name: 'Khách thử',
    email: '',
    phone: '',
    mode: 'standard',
    registered_at: new Date().toISOString(),
  });
  store.enqueueJob({ id: jobId, queued_at: Date.now() });
}

function makeService(store: LocalStore): QueueService {
  const service = new QueueService(store);
  service.bindSendCommand(() => {});
  service.bindNotificationService({ sendPhotoLink: async () => {} });
  // Never started: no dispatch tick, no sweep, no timer outlives the case.
  return service;
}

function readJob(store: LocalStore, jobId: string): Record<string, unknown> {
  // Raw row on purpose: the point is what is DURABLE, not what a projection
  // chooses to expose.
  return (store as unknown as { db: { prepare: (s: string) => { get: (v: string) => Record<string, unknown> } } }).db
    .prepare('SELECT * FROM queue_job WHERE id = ?')
    .get(jobId);
}

afterEach(() => {
  vi.restoreAllMocks();
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

describe('a refused start_session records why (agent_nak)', () => {
  it('stores the Agent reason in ack_error_message', () => {
    const store = makeStore();
    queueJob(store, 'JOB-NAK-1');
    const service = makeService(store);

    service.onAgentAck('JOB-NAK-1', false, 'dslrBooth API refused: 401 Unauthorized');

    expect(readJob(store, 'JOB-NAK-1').ack_error_message).toBe('dslrBooth API refused: 401 Unauthorized');
  });

  it('logs it at warn, not debug — this service runs at info', () => {
    // The whole reason four real failures are unexplainable: a debug line at
    // an info log level is a line that does not exist.
    const store = makeStore();
    queueJob(store, 'JOB-NAK-2');
    const service = makeService(store);
    const warn = vi.spyOn(queueLogger, 'warn').mockImplementation(() => undefined as never);
    const debug = vi.spyOn(queueLogger, 'debug').mockImplementation(() => undefined as never);

    service.onAgentAck('JOB-NAK-2', false, 'trigger port already in use');

    const nakWarnings = warn.mock.calls.map(String).filter((line) => line.includes('trigger port already in use'));
    expect(nakWarnings).toHaveLength(1);
    expect(debug.mock.calls.map(String).some((l) => l.includes('trigger port already in use'))).toBe(false);
  });

  it('records something useful even when the Agent sends no message', () => {
    const store = makeStore();
    queueJob(store, 'JOB-NAK-3');
    const service = makeService(store);

    service.onAgentAck('JOB-NAK-3', false, undefined);

    // Not null, not empty: "the Agent refused and said nothing" is itself a
    // finding, and distinguishing it from "nobody wrote this column" is the
    // difference between a diagnosis and a shrug.
    expect(readJob(store, 'JOB-NAK-3').ack_error_message).toBe('no error message');
  });

  it('records the reason on the FIRST refusal, not only the one that exhausts retries', () => {
    // By the last attempt the booth may be failing for a different reason
    // than it started with.
    const store = makeStore();
    queueJob(store, 'JOB-NAK-4');
    const service = makeService(store);

    service.onAgentAck('JOB-NAK-4', false, 'first reason');
    const afterFirst = readJob(store, 'JOB-NAK-4');

    expect(afterFirst.ack_error_message).toBe('first reason');
    expect(afterFirst.status).not.toBe('failed'); // still retrying
  });

  it('keeps the latest reason when the Agent refuses again', () => {
    const store = makeStore();
    queueJob(store, 'JOB-NAK-5');
    const service = makeService(store);

    service.onAgentAck('JOB-NAK-5', false, 'first reason');
    service.onAgentAck('JOB-NAK-5', false, 'second reason');

    expect(readJob(store, 'JOB-NAK-5').ack_error_message).toBe('second reason');
  });

  it('leaves stall_reason as the stable category, not the free text', () => {
    // `agent_nak` is what other code and the CMS match on. The prose belongs
    // in its own column; merging them would make the category unmatchable.
    const store = makeStore();
    queueJob(store, 'JOB-NAK-6');
    const service = makeService(store);

    for (let i = 0; i < 5; i += 1) service.onAgentAck('JOB-NAK-6', false, 'some prose');

    const row = readJob(store, 'JOB-NAK-6');
    expect(row.status).toBe('failed');
    expect(row.stall_reason).toBe('agent_nak');
    expect(row.ack_error_message).toBe('some prose');
  });

  it('writes nothing on a successful ack', () => {
    const store = makeStore();
    queueJob(store, 'JOB-OK');
    const service = makeService(store);

    service.onAgentAck('JOB-OK', true);

    expect(readJob(store, 'JOB-OK').ack_error_message ?? null).toBeNull();
  });
});

describe('the reason stays on the operator side of the boundary', () => {
  it('ack_error_message is not a guest status word', () => {
    // guestStatus.ts names this column among the operator words that may never
    // cross to a guest. Storing it changes nothing about that.
    expect([...GUEST_STATUSES]).not.toContain('ack_error_message');
    expect([...GUEST_STATUSES]).not.toContain('agent_nak');
  });

  it('the guest vocabulary is still exactly six words', () => {
    // A regression here would mean someone widened the guest wire while
    // wiring this through.
    expect(GUEST_STATUSES).toHaveLength(6);
  });
});
