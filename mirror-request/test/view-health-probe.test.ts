import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalStore } from '../src/state/localStore';
import { ViewHealthProbe, VIEW_BROKEN_ERROR_CODES, opsLogger } from '../src/ops/viewHealthProbe';
import { NAME_AUDIT_CURSOR_KEY, nameSourceWarnings } from '../src/ops/nameSourceAudit';
import { NAME_SOURCE_VALUES } from '../src/ops/registrationsViewSql';

// Same rationale as test/db-poller.test.ts:11-22 — a naive `vi.mock` does not
// intercept `viewHealthProbe.ts`'s lazy `require('mysql2/promise')` call, so
// we spy on the real, already-installed module object's `createPool` export
// via `createRequire`, exactly as db-poller.test.ts does.
const nodeRequire = createRequire(import.meta.url);
const mysql2Promise = nodeRequire('mysql2/promise');

function mysqlError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

// runOnce() now also runs the D-05 name-source audit on the same connection
// pool after a healthy count query. When a test's health-query mock resolves
// (rather than rejects), the SAME queryMock would otherwise also answer the
// audit's SELECT with a `{total, distinct_registered_at}`-shaped row, which
// has no `name_source` and would produce a spurious warning. Branching on the
// SQL text keeps the two queries independent, matching production (two
// different SELECT statements against two different VIEWs).
function healthyQueryImpl(row: { total: number; distinct_registered_at: number } = { total: 0, distinct_registered_at: 0 }) {
  return (sql: string) => {
    if (typeof sql === 'string' && sql.includes('registrations_name_audit')) {
      return Promise.resolve([[]]);
    }
    return Promise.resolve([[row]]);
  };
}

describe('ViewHealthProbe — two failure classes, one alert channel, never fatal', () => {
  let dir: string;
  let dbPath: string;
  let store: LocalStore;
  let queryMock: ReturnType<typeof vi.fn>;
  let releaseMock: ReturnType<typeof vi.fn>;
  let endMock: ReturnType<typeof vi.fn>;
  let getConnectionMock: ReturnType<typeof vi.fn>;
  let createPoolMock: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let alertMock: ReturnType<typeof vi.fn>;

  const dbConfig = { host: 'h', port: 3306, database: 'd', user: 'u', password: 'pw' };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-view-probe-'));
    dbPath = path.join(dir, 'test.sqlite');
    store = new LocalStore(dbPath);

    queryMock = vi.fn().mockImplementation(healthyQueryImpl());
    releaseMock = vi.fn();
    endMock = vi.fn().mockResolvedValue(undefined);
    getConnectionMock = vi.fn().mockResolvedValue({ query: queryMock, release: releaseMock });
    createPoolMock = vi.spyOn(mysql2Promise, 'createPool').mockReturnValue({
      getConnection: getConnectionMock,
      end: endMock,
    });
    errorSpy = vi.spyOn(opsLogger, 'error').mockImplementation(() => opsLogger);
    warnSpy = vi.spyOn(opsLogger, 'warn').mockImplementation(() => opsLogger);
    alertMock = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeProbe(overrides: { webhookUrl?: string } = {}) {
    return new ViewHealthProbe({
      intervalMs: 1_000_000,
      dbConfig,
      webhookUrl: overrides.webhookUrl ?? 'https://webhook.example.test/alert',
      fetchTimeoutMs: 5000,
      store,
      alert: alertMock,
    });
  }

  it('ER_VIEW_INVALID: dispatches exactly one alert and logs exactly one error', async () => {
    queryMock.mockRejectedValue(mysqlError('ER_VIEW_INVALID', 'View invalid'));
    const probe = makeProbe();
    probe.start();
    await new Promise((resolve) => setImmediate(resolve));

    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('View invalid'));

    probe.stop();
  });

  it('ER_NO_SUCH_USER: treated as the same broken-VIEW class as ER_VIEW_INVALID', async () => {
    queryMock.mockRejectedValue(mysqlError('ER_NO_SUCH_USER', 'Definer account gone'));
    const probe = makeProbe();
    probe.start();
    await new Promise((resolve) => setImmediate(resolve));

    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    probe.stop();
  });

  it('ECONNREFUSED: dispatches zero alerts and logs exactly one warn', async () => {
    queryMock.mockRejectedValue(mysqlError('ECONNREFUSED', 'connection refused'));
    const probe = makeProbe();
    probe.start();
    await new Promise((resolve) => setImmediate(resolve));

    expect(alertMock).toHaveBeenCalledTimes(0);
    const cycleWarnCalls = warnSpy.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('DB unreachable')
    );
    expect(cycleWarnCalls).toHaveLength(1);

    probe.stop();
  });

  it('an unrecognised error code takes the warn-only branch with zero alerts', async () => {
    queryMock.mockRejectedValue(mysqlError('ER_SOME_UNKNOWN_CODE', 'mystery failure'));
    const probe = makeProbe();
    probe.start();
    await new Promise((resolve) => setImmediate(resolve));

    expect(alertMock).toHaveBeenCalledTimes(0);
    expect(errorSpy).toHaveBeenCalledTimes(0);
    expect(warnSpy).toHaveBeenCalled();

    probe.stop();
  });

  it('unequal counts: one error log and one alert naming both measured numbers', async () => {
    queryMock.mockImplementation(healthyQueryImpl({ total: 9, distinct_registered_at: 7 }));
    const probe = makeProbe();
    probe.start();
    await new Promise((resolve) => setImmediate(resolve));

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(alertMock).toHaveBeenCalledTimes(1);
    const alertPayload = alertMock.mock.calls[0][0];
    expect(alertPayload.message).toContain('9');
    expect(alertPayload.message).toContain('7');

    probe.stop();
  });

  it('healthy cycle (equal counts): opsLogger.error, opsLogger.warn and alert are all called zero times', async () => {
    queryMock.mockImplementation(healthyQueryImpl({ total: 4, distinct_registered_at: 4 }));
    const probe = makeProbe();
    probe.start();
    await new Promise((resolve) => setImmediate(resolve));

    expect(errorSpy).toHaveBeenCalledTimes(0);
    expect(warnSpy).toHaveBeenCalledTimes(0);
    expect(alertMock).toHaveBeenCalledTimes(0);

    probe.stop();
  });

  it('runOnce() resolves (never rejects) for every failure class', async () => {
    // runOnce() is a no-op until `this.pool` exists, which only start()
    // creates (synchronously, before its own detached first cycle). Flush
    // once so that detached first cycle (health-only, harmless default
    // response) fully settles before this test drives its own explicit
    // runOnce() calls below — otherwise the two would race over the shared
    // queryMock queue.
    const probe = makeProbe();
    probe.start();
    await new Promise((resolve) => setImmediate(resolve));
    errorSpy.mockClear();
    warnSpy.mockClear();
    alertMock.mockClear();

    for (const code of [...VIEW_BROKEN_ERROR_CODES, 'ECONNREFUSED', 'ETIMEDOUT', 'PROTOCOL_CONNECTION_LOST', 'ER_ACCESS_DENIED_ERROR', 'ER_TOTALLY_UNKNOWN']) {
      queryMock.mockRejectedValueOnce(mysqlError(code, `failure ${code}`));
      await expect(probe.runOnce()).resolves.toBeUndefined();
    }

    probe.stop();
  });

  it('runOnce() resolves even when the injected alert itself rejects', async () => {
    queryMock.mockRejectedValue(mysqlError('ER_VIEW_INVALID', 'View invalid'));
    alertMock.mockRejectedValue(new Error('webhook receiver is down'));
    const probe = makeProbe();
    // Synchronously creates the pool (no need to await the detached first
    // cycle — this test's mocks are blanket `mockRejectedValue`/
    // `mockRejectedValue`, not queued `Once` values, so the detached first
    // cycle racing with the explicit call below observes the same behaviour
    // either way).
    probe.start();
    await expect(probe.runOnce()).resolves.toBeUndefined();
    probe.stop();
  });

  it('start() returns synchronously even when the first cycle rejects, and the branch still runs after a flush', async () => {
    queryMock.mockRejectedValue(mysqlError('ER_VIEW_INVALID', 'View invalid'));
    const probe = makeProbe();

    let syncMarkerSet = false;
    probe.start();
    syncMarkerSet = true;
    // Assert the marker was set synchronously, before the rejected first
    // cycle's promise chain has had any chance to settle.
    expect(syncMarkerSet).toBe(true);
    expect(alertMock).toHaveBeenCalledTimes(0);

    await new Promise((resolve) => setImmediate(resolve));
    expect(alertMock).toHaveBeenCalledTimes(1);

    probe.stop();
  });

  it('no branch throws out of start(): calling start() itself never rejects or throws synchronously', () => {
    queryMock.mockRejectedValue(mysqlError('ER_VIEW_INVALID', 'View invalid'));
    const probe = makeProbe();
    expect(() => probe.start()).not.toThrow();
    probe.stop();
  });

  it('the alert payload key set is exactly source, severity, message, timestamp', async () => {
    queryMock.mockRejectedValue(mysqlError('ER_VIEW_INVALID', 'View invalid'));
    const probe = makeProbe();
    probe.start();
    await new Promise((resolve) => setImmediate(resolve));

    const payload = alertMock.mock.calls[0][0];
    expect(Object.keys(payload).sort()).toEqual(['message', 'severity', 'source', 'timestamp']);
    expect(payload.source).toBe('extension-service');
    expect(payload.severity).toBe('error');
    expect(payload).not.toHaveProperty('photoUrl');

    probe.stop();
  });

  it('when webhookUrl is empty, the alert is skipped with one warn and the injected alert function is never called', async () => {
    queryMock.mockRejectedValue(mysqlError('ER_VIEW_INVALID', 'View invalid'));
    const probe = makeProbe({ webhookUrl: '' });
    probe.start();
    await new Promise((resolve) => setImmediate(resolve));

    expect(alertMock).toHaveBeenCalledTimes(0);
    const skipWarnCalls = warnSpy.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('NOTIFY_WEBHOOK_URL')
    );
    expect(skipWarnCalls).toHaveLength(1);

    probe.stop();
  });
});

describe('nameSourceWarnings — pure D-05 projection', () => {
  it('returns [] for an empty input', () => {
    expect(nameSourceWarnings([])).toEqual([]);
  });

  it('a personalinfo_name row (the first rung) produces no warning', () => {
    const rows = [{ id: 'AAAA1111', name_source: 'personalinfo_name' as const, registered_at: '2026-08-11 09:00:00.000000' }];
    expect(nameSourceWarnings(rows)).toEqual([]);
  });

  it('NAME_AUDIT_CURSOR_KEY is the literal poll key "name_audit"', () => {
    expect(NAME_AUDIT_CURSOR_KEY).toBe('name_audit');
  });

  // Iterates NAME_SOURCE_VALUES rather than hard-coding four literals, so a
  // sixth rung added later to registrationsViewSql.ts fails this test
  // instead of silently passing.
  it.each(NAME_SOURCE_VALUES.filter((rung) => rung !== 'personalinfo_name'))(
    'a %s row produces exactly one warning naming its own rung',
    (rung) => {
      const rows = [{ id: 'BBBB2222', name_source: rung, registered_at: '2026-08-11 09:00:00.000000' }];
      const warnings = nameSourceWarnings(rows);
      expect(warnings).toHaveLength(1);
      expect(warnings[0].ticketCode).toBe('BBBB2222');
      expect(warnings[0].nameSource).toBe(rung);
      expect(warnings[0].registeredAt).toBe('2026-08-11 09:00:00.000000');
    }
  );
});

describe('ViewHealthProbe — D-05 name-source audit, driven by the probe cadence', () => {
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

  // Simulates the real `WHERE registered_at > ?` filter (lexical comparison
  // over the fixed-format DATE_FORMAT string, same as dbPoller.ts:101) so
  // the exactly-once/restart-safety tests below exercise the actual cursor
  // mechanism (LocalStore.getCursor/setCursor), not just "the fixture never
  // changes" — a dumb mock that ignored the bound cursor parameter would
  // prove nothing about D-05's restart-safety claim.
  function setupPoolMocks(fixedRows: Array<{ id: string; name_source: string; registered_at: string; [k: string]: unknown }>) {
    queryMock = vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('registrations_name_audit')) {
        const cursor = (params?.[0] as string) ?? '1970-01-01T00:00:00.000Z';
        const filtered = fixedRows
          .filter((r) => r.registered_at > cursor)
          .sort((a, b) => (a.registered_at < b.registered_at ? -1 : 1));
        return Promise.resolve([filtered]);
      }
      return Promise.resolve([[{ total: 0, distinct_registered_at: 0 }]]);
    });
    releaseMock = vi.fn();
    endMock = vi.fn().mockResolvedValue(undefined);
    getConnectionMock = vi.fn().mockResolvedValue({ query: queryMock, release: releaseMock });
    createPoolMock = vi.spyOn(mysql2Promise, 'createPool').mockReturnValue({
      getConnection: getConnectionMock,
      end: endMock,
    });
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-view-probe-audit-'));
    dbPath = path.join(dir, 'test.sqlite');
    store = new LocalStore(dbPath);
    warnSpy = vi.spyOn(opsLogger, 'warn').mockImplementation(() => opsLogger);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function nameWarnCalls() {
    return warnSpy.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('Guest name for ticket')
    );
  }

  // `runOnce()` is a no-op until `this.pool` exists, which only `start()`
  // creates (synchronously). This helper starts the probe and flushes its
  // own detached first cycle — production's exact sequence — so that
  // first cycle is "cycle 1" for every test below, and any additional
  // explicit `probe.runOnce()` calls are cycle 2, cycle 3, etc.
  async function makeProbe(overrideStore: LocalStore = store): Promise<ViewHealthProbe> {
    const probe = new ViewHealthProbe({
      intervalMs: 1_000_000,
      dbConfig,
      webhookUrl: '',
      fetchTimeoutMs: 5000,
      store: overrideStore,
      alert: vi.fn().mockResolvedValue(undefined),
    });
    probe.start();
    await new Promise((resolve) => setImmediate(resolve));
    return probe;
  }

  it('two consecutive cycles over the identically-mocked row produce one warn for the ticket in total, not two', async () => {
    setupPoolMocks([{ id: 'ABCD1234', name_source: 'customer_username', registered_at: '2026-08-11 10:00:00.000000' }]);
    const probe = await makeProbe(); // cycle 1

    await probe.runOnce(); // cycle 2 — same fixed rows, cursor now advanced

    expect(nameWarnCalls()).toHaveLength(1);
    expect(nameWarnCalls()[0][0]).toContain('ABCD1234');
    expect(nameWarnCalls()[0][0]).toContain('customer_username');

    probe.stop();
  });

  it('a fresh ViewHealthProbe reopening the same SQLite file produces zero additional warnings on a third cycle', async () => {
    setupPoolMocks([{ id: 'ABCD1234', name_source: 'customer_username', registered_at: '2026-08-11 10:00:00.000000' }]);
    const probe1 = await makeProbe(); // cycle 1
    await probe1.runOnce(); // cycle 2
    expect(nameWarnCalls()).toHaveLength(1);
    probe1.stop();

    store.close();
    const store2 = new LocalStore(dbPath); // genuinely reopens the same file
    const probe2 = await makeProbe(store2); // cycle 3, fresh instance + reopened store

    expect(nameWarnCalls()).toHaveLength(1); // unchanged — zero new warnings
    probe2.stop();
    store2.close();
    store = new LocalStore(dbPath); // so afterEach's store.close() has a live handle
  });

  it('with no name_audit cursor but a registrations cursor later than the mocked rows, zero warnings are produced', async () => {
    store.setCursor('registrations', '2026-12-31 00:00:00.000000');
    setupPoolMocks([{ id: 'ABCD1234', name_source: 'customer_username', registered_at: '2026-08-11 10:00:00.000000' }]);
    const probe = await makeProbe(); // cycle 1

    expect(nameWarnCalls()).toHaveLength(0);

    probe.stop();
  });

  it('a cycle whose health query fails performs no audit query', async () => {
    queryMock = vi.fn().mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('registrations_name_audit')) {
        return Promise.resolve([[]]);
      }
      return Promise.reject(Object.assign(new Error('down'), { code: 'ECONNREFUSED' }));
    });
    releaseMock = vi.fn();
    endMock = vi.fn().mockResolvedValue(undefined);
    getConnectionMock = vi.fn().mockResolvedValue({ query: queryMock, release: releaseMock });
    createPoolMock = vi.spyOn(mysql2Promise, 'createPool').mockReturnValue({ getConnection: getConnectionMock, end: endMock });

    const probe = await makeProbe(); // cycle 1: health query rejects

    const auditCalls = queryMock.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('registrations_name_audit')
    );
    expect(auditCalls).toHaveLength(0);

    probe.stop();
  });

  it('a rejecting audit query yields exactly one additional warn and runOnce() still resolves', async () => {
    queryMock = vi.fn().mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('registrations_name_audit')) {
        return Promise.reject(new Error('audit table missing'));
      }
      return Promise.resolve([[{ total: 0, distinct_registered_at: 0 }]]);
    });
    releaseMock = vi.fn();
    endMock = vi.fn().mockResolvedValue(undefined);
    getConnectionMock = vi.fn().mockResolvedValue({ query: queryMock, release: releaseMock });
    createPoolMock = vi.spyOn(mysql2Promise, 'createPool').mockReturnValue({ getConnection: getConnectionMock, end: endMock });

    const probe = await makeProbe(); // cycle 1 already produced one audit-failure warn
    warnSpy.mockClear();

    await expect(probe.runOnce()).resolves.toBeUndefined(); // cycle 2, explicit

    const auditWarnCalls = warnSpy.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('Name-source audit')
    );
    expect(auditWarnCalls).toHaveLength(1);

    probe.stop();
  });

  it('each emitted warn message names the ticket code and the rung, and contains neither an @ character nor the fixture\'s guest name', async () => {
    setupPoolMocks([
      {
        id: 'WXYZ9999',
        name_source: 'synthetic',
        registered_at: '2026-08-11 11:00:00.000000',
        // Extra fields present on the underlying VIEW row but never selected
        // by the audit query in production — included here to prove the
        // warn line cannot leak them even if a future edit widened the
        // SELECT list.
        name: 'Nguyen Van A',
        email: 'guest@example.com',
      },
    ]);
    const probe = await makeProbe(); // cycle 1

    expect(nameWarnCalls()).toHaveLength(1);
    const message = nameWarnCalls()[0][0] as string;
    expect(message).toContain('WXYZ9999');
    expect(message).toContain('synthetic');
    expect(message).not.toContain('@');
    expect(message).not.toContain('Nguyen Van A');

    probe.stop();
  });
});
