import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalStore } from '../src/state/localStore';
import { DBPoller } from '../src/ingestion/dbPoller';

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
