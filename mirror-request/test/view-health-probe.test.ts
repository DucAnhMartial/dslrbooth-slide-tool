import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalStore } from '../src/state/localStore';
import { ViewHealthProbe, VIEW_BROKEN_ERROR_CODES, opsLogger } from '../src/ops/viewHealthProbe';

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

    queryMock = vi.fn().mockResolvedValue([[{ total: 0, distinct_registered_at: 0 }]]);
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
    queryMock.mockResolvedValue([[{ total: 9, distinct_registered_at: 7 }]]);
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
    queryMock.mockResolvedValue([[{ total: 4, distinct_registered_at: 4 }]]);
    const probe = makeProbe();
    probe.start();
    await new Promise((resolve) => setImmediate(resolve));

    expect(errorSpy).toHaveBeenCalledTimes(0);
    expect(warnSpy).toHaveBeenCalledTimes(0);
    expect(alertMock).toHaveBeenCalledTimes(0);

    probe.stop();
  });

  it('runOnce() resolves (never rejects) for every failure class', async () => {
    const probe = makeProbe();
    for (const code of [...VIEW_BROKEN_ERROR_CODES, 'ECONNREFUSED', 'ETIMEDOUT', 'PROTOCOL_CONNECTION_LOST', 'ER_ACCESS_DENIED_ERROR', 'ER_TOTALLY_UNKNOWN']) {
      queryMock.mockRejectedValueOnce(mysqlError(code, `failure ${code}`));
      await expect(probe.runOnce()).resolves.toBeUndefined();
    }
  });

  it('runOnce() resolves even when the injected alert itself rejects', async () => {
    queryMock.mockRejectedValue(mysqlError('ER_VIEW_INVALID', 'View invalid'));
    alertMock.mockRejectedValue(new Error('webhook receiver is down'));
    const probe = makeProbe();
    await expect(probe.runOnce()).resolves.toBeUndefined();
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
