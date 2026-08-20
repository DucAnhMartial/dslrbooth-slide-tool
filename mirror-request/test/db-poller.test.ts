import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalStore } from '../src/state/localStore';
import { DBPoller } from '../src/ingestion/dbPoller';
import logger from '../src/logging/logger';
import { loadConfig } from '../src/config';

// `dbPoller.ts` loads the driver via a lazy `require('mysql2/promise')` (kept
// lazy on purpose so a missing driver degrades to a log instead of a crash —
// see task 1's <action>). `vi.mock('mysql2/promise', ...)` does not intercept
// that call: vite-node's mock interception only covers statically-analyzed
// `import` statements, and a runtime CommonJS `require()` for an externalized
// node_modules package resolves through Node's real module loader instead
// (confirmed experimentally — a hoisted `vi.mock` here still let a real DNS
// lookup through). Because Node's CJS loader shares one module-cache instance
// keyed by resolved path regardless of how `require` was obtained, we instead
// grab the real, already-installed `mysql2/promise` module object via
// `createRequire` and spy on its `createPool` export directly — the same
// object `dbPoller.ts`'s own `require('mysql2/promise')` call will return.
const nodeRequire = createRequire(import.meta.url);
const mysql2Promise = nodeRequire('mysql2/promise');

describe('DBPoller — typed config + mocked-pool harness', () => {
  let dir: string;
  let dbPath: string;
  let store: LocalStore;
  let queryMock: ReturnType<typeof vi.fn>;
  let releaseMock: ReturnType<typeof vi.fn>;
  let endMock: ReturnType<typeof vi.fn>;
  let getConnectionMock: ReturnType<typeof vi.fn>;
  let createPoolMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-dbpoller-'));
    dbPath = path.join(dir, 'test.sqlite');
    store = new LocalStore(dbPath);

    queryMock = vi.fn().mockResolvedValue([[]]);
    releaseMock = vi.fn();
    endMock = vi.fn().mockResolvedValue(undefined);
    getConnectionMock = vi.fn().mockResolvedValue({ query: queryMock, release: releaseMock });
    createPoolMock = vi.spyOn(mysql2Promise, 'createPool').mockReturnValue({
      getConnection: getConnectionMock,
      end: endMock,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('constructing with explicit dbConfig and calling start() passes exactly those values to mysql.createPool', async () => {
    const poller = new DBPoller(3000, 50, store, {
      host: 'h',
      port: 3306,
      database: 'd',
      user: 'u',
      password: 'p',
    });

    poller.start();
    await new Promise((resolve) => setImmediate(resolve));

    expect(createPoolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'h',
        port: 3306,
        database: 'd',
        user: 'u',
        password: 'p',
      })
    );

    poller.stop();
  });

  it("with user: '', start() logs a warning, creates no pool, and leaves the poller stopped", async () => {
    const logger = (await import('../src/logging/logger')).default;
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

    const poller = new DBPoller(3000, 50, store, {
      host: 'h',
      port: 3306,
      database: 'd',
      user: '',
      password: 'p',
    });

    poller.start();
    await new Promise((resolve) => setImmediate(resolve));

    expect(createPoolMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('DB_USER not configured'));

    warnSpy.mockRestore();
  });

  it('stop() after a successful start() clears the interval and ends the pool', async () => {
    const poller = new DBPoller(3000, 50, store, {
      host: 'h',
      port: 3306,
      database: 'd',
      user: 'u',
      password: 'p',
    });

    poller.start();
    await vi.waitFor(() => {
      expect(createPoolMock).toHaveBeenCalled();
    });
    // Let the initial doPoll() promise chain settle so `this.timer` is set.
    await new Promise((resolve) => setImmediate(resolve));

    poller.stop();
    expect(endMock).toHaveBeenCalled();
  });

  it('doPoll issues a query whose SQL text begins with SELECT and contains no mutating keyword', async () => {
    const poller = new DBPoller(3000, 50, store, {
      host: 'h',
      port: 3306,
      database: 'd',
      user: 'u',
      password: 'p',
    });

    poller.start();
    await vi.waitFor(() => {
      expect(queryMock).toHaveBeenCalled();
    });

    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toMatch(/^\s*SELECT\b/i);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/i);

    poller.stop();
  });
});

describe('DBPoller — retry, reconcile, audit-skip, advance (task 2)', () => {
  let dir: string;
  let dbPath: string;
  let store: LocalStore;
  let queryMock: ReturnType<typeof vi.fn>;
  let releaseMock: ReturnType<typeof vi.fn>;
  let endMock: ReturnType<typeof vi.fn>;
  let getConnectionMock: ReturnType<typeof vi.fn>;
  let createPoolMock: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  const dbConfig = { host: 'h', port: 3306, database: 'd', user: 'u', password: 'super-secret-pw' };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-dbpoller-t2-'));
    dbPath = path.join(dir, 'test.sqlite');
    store = new LocalStore(dbPath);

    queryMock = vi.fn().mockResolvedValue([[]]);
    releaseMock = vi.fn();
    endMock = vi.fn().mockResolvedValue(undefined);
    getConnectionMock = vi.fn().mockResolvedValue({ query: queryMock, release: releaseMock });
    createPoolMock = vi.spyOn(mysql2Promise, 'createPool').mockReturnValue({
      getConnection: getConnectionMock,
      end: endMock,
    });
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a first-cycle rejection still schedules the interval, and the next tick ingests successfully', async () => {
    vi.useFakeTimers();

    const goodRow = { id: 'r1', name: 'Alice', email: '', phone: '', mode: 'photo', registered_at: '2026-01-01T00:00:00.000Z' };
    getConnectionMock
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValue({ query: queryMock, release: releaseMock });
    queryMock.mockResolvedValue([[goodRow]]);

    const poller = new DBPoller(3000, 50, store, dbConfig);
    poller.start();

    // First cycle: getConnection() rejects, caught inside doPoll(), and the
    // .then() branch of start()'s promise chain still schedules the interval.
    await vi.advanceTimersByTimeAsync(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('DB poller cycle failed'));

    // Second cycle: advancing past intervalMs runs doPoll() again; this time
    // getConnection() resolves and the row is ingested normally.
    await vi.advanceTimersByTimeAsync(3000);

    expect(store.getRegistration('r1')).toBeDefined();
    poller.stop();
  });

  it('a rejected query inside a cycle produces exactly one logger.warn call and no thrown rejection escaping doPoll()', async () => {
    queryMock.mockRejectedValue(new Error('syntax error'));

    const poller = new DBPoller(3000, 50, store, dbConfig);
    let escaped: unknown;
    try {
      poller.start();
      await new Promise((resolve) => setImmediate(resolve));
    } catch (err) {
      escaped = err;
    }
    expect(escaped).toBeUndefined();

    const cycleFailedCalls = warnSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes('DB poller cycle failed')
    );
    expect(cycleFailedCalls).toHaveLength(1);

    poller.stop();
  });

  it('an already-processed id produces one logger.info reconciliation line and no persistence call', async () => {
    store.markProcessed('r1');
    const row = { id: 'r1', name: 'Alice', email: '', phone: '', mode: 'photo', registered_at: '2026-01-01T00:00:00.000Z' };
    queryMock.mockResolvedValue([[row]]);

    const poller = new DBPoller(3000, 50, store, dbConfig);
    poller.start();
    await new Promise((resolve) => setImmediate(resolve));

    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('reconciled r1'));
    expect(store.getRegistration('r1')).toBeUndefined();
    expect(store.getQueuedJobs()).toHaveLength(0);

    poller.stop();
  });

  it('a malformed row (missing id or name) is audit-skipped without persistence, and the cursor still advances', async () => {
    const malformed = { id: '', name: 'Bob', email: '', phone: '', mode: 'photo', registered_at: '2026-01-01T00:00:00.000Z' };
    queryMock.mockResolvedValue([[malformed]]);

    const poller = new DBPoller(3000, 50, store, dbConfig);
    poller.start();
    await new Promise((resolve) => setImmediate(resolve));

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('skipped malformed source row'));
    expect(store.getQueuedJobs()).toHaveLength(0);
    expect(store.getCursor('registrations')).toBe('2026-01-01T00:00:00.000Z');

    poller.stop();
  });

  it('a batch of [malformed, good] leaves the cursor at the good row\'s registered_at (last fetched, not last ingested)', async () => {
    const malformed = { id: '', name: '', email: '', phone: '', mode: 'photo', registered_at: '2026-01-01T00:00:00.000Z' };
    const good = { id: 'r2', name: 'Carol', email: '', phone: '', mode: 'photo', registered_at: '2026-01-02T00:00:00.000Z' };
    queryMock.mockResolvedValue([[malformed, good]]);

    const poller = new DBPoller(3000, 50, store, dbConfig);
    poller.start();
    await new Promise((resolve) => setImmediate(resolve));

    expect(store.getCursor('registrations')).toBe('2026-01-02T00:00:00.000Z');
    expect(store.getRegistration('r2')).toBeDefined();

    poller.stop();
  });

  it('no log line emitted by doPoll() contains the database password or an email address', async () => {
    queryMock.mockRejectedValue(new Error('connection failed'));

    const poller = new DBPoller(3000, 50, store, dbConfig);
    poller.start();
    await new Promise((resolve) => setImmediate(resolve));
    poller.stop();

    const allMessages = [...warnSpy.mock.calls, ...infoSpy.mock.calls]
      .map((args) => args[0])
      .filter((m): m is string => typeof m === 'string');

    for (const message of allMessages) {
      expect(message).not.toContain('super-secret-pw');
      expect(message).not.toMatch(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    }
  });

  it('D-08: DB_POLL_INTERVAL_MS defaults to 3000ms when unset', () => {
    const envSnapshot = { ...process.env };
    process.env.NODE_ENV = 'test';
    process.env.AGENT_WS_TOKEN = 'real-agent-token';
    process.env.DB_PASSWORD = 'real-db-password';
    delete process.env.DB_POLL_INTERVAL_MS;

    const config = loadConfig();
    expect(config.DB_POLL_INTERVAL_MS).toBe(3000);

    process.env = envSnapshot;
  });
});

describe('registered_at bind type across the mysql2 -> better-sqlite3 boundary (RESEARCH Pitfall 1)', () => {
  let dir: string;
  let dbPath: string;
  let store: LocalStore;
  let queryMock: ReturnType<typeof vi.fn>;
  let releaseMock: ReturnType<typeof vi.fn>;
  let endMock: ReturnType<typeof vi.fn>;
  let getConnectionMock: ReturnType<typeof vi.fn>;
  let createPoolMock: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  const dbConfig = { host: 'h', port: 3306, database: 'd', user: 'u', password: 'pw' };

  // One row fixture factory taking only the registered_at value, so the Date
  // case and the string case below are provably identical apart from that
  // single field — isolating the bind type as the cause of whatever happens.
  function makeRow(registeredAt: unknown) {
    return {
      id: 'bindtest-1',
      name: 'Bind Test Guest',
      email: 'bind@example.com',
      phone: '',
      mode: 'print',
      registered_at: registeredAt,
    };
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-dbpoller-bind-'));
    dbPath = path.join(dir, 'test.sqlite');
    store = new LocalStore(dbPath);

    queryMock = vi.fn().mockResolvedValue([[]]);
    releaseMock = vi.fn();
    endMock = vi.fn().mockResolvedValue(undefined);
    getConnectionMock = vi.fn().mockResolvedValue({ query: queryMock, release: releaseMock });
    createPoolMock = vi.spyOn(mysql2Promise, 'createPool').mockReturnValue({
      getConnection: getConnectionMock,
      end: endMock,
    });
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // This is the silent-forever failure mode: mysql2's default decoding of a
  // bare DATETIME/TIMESTAMP column hands dbPoller.ts a native JS Date. This
  // test reads the REAL, file-backed LocalStore built in beforeEach (not a
  // mock), so the assertions below observe better-sqlite3's actual bind
  // behaviour rather than a stand-in for it.
  it('a native JS Date registered_at crashes the bind inside the warn-and-retry catch: nothing is stored, nothing is queued, the cursor does not move', async () => {
    const row = makeRow(new Date('2026-08-11T10:00:00.000Z'));
    queryMock.mockResolvedValue([[row]]);

    const poller = new DBPoller(3000, 50, store, dbConfig);
    poller.start();
    await new Promise((resolve) => setImmediate(resolve));

    // Observed behaviour, measured directly against a real better-sqlite3
    // handle before writing this assertion (see Task 2's SUMMARY entry):
    // better-sqlite3 THROWS a TypeError ("SQLite3 can only bind numbers,
    // strings, bigints, buffers, and null") on a Date bind parameter. The
    // throw happens inside LocalStore.upsertRegistration()'s stmt.run(),
    // before the INSERT executes, so nothing is written; it propagates up
    // through DBPoller.doPoll()'s try block and lands in the catch at
    // dbPoller.ts:134, which only warns — it never crashes the process, and
    // it never advances the cursor past this row, so the same row will be
    // retried (and will fail the same way) on the next cycle.
    expect(store.getRegistration(row.id)).toBeUndefined();
    expect(store.getJob(row.id)).toBeUndefined();
    expect(store.getCursor('registrations')).toBeUndefined();

    const cycleFailedCalls = warnSpy.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('DB poller cycle failed')
    );
    expect(cycleFailedCalls).toHaveLength(1);

    poller.stop();
  });

  // The control: same row, same poller, same harness — only registered_at's
  // TYPE differs (a string in the exact DATE_FORMAT(...,
  // '%Y-%m-%d %H:%i:%s.%f') shape the projection emits, per
  // registrationsViewSql.ts). This proves the Date case's "nothing happened"
  // above is caused by the bind value, not by the harness failing to run the
  // poller at all: with the string form, the cursor DOES advance and a job
  // IS enqueued.
  it('the DATE_FORMAT string form the projection actually emits binds cleanly: registration stored, one job enqueued, cursor advances to that exact string', async () => {
    const row = makeRow('2026-08-11 10:00:00.000000');
    queryMock.mockResolvedValue([[row]]);

    const poller = new DBPoller(3000, 50, store, dbConfig);
    poller.start();
    await new Promise((resolve) => setImmediate(resolve));

    expect(store.getRegistration(row.id)).toBeDefined();
    expect(store.getQueuedJobs()).toHaveLength(1);
    expect(store.getCursor('registrations')).toBe('2026-08-11 10:00:00.000000');

    poller.stop();
  });
});
