import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalStore, getStore } from '../src/state/localStore';

describe('LocalStore persistence — webhook replay + poll cursor', () => {
  let dir: string;
  let dbPath: string;
  let store: LocalStore | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-store-'));
    dbPath = path.join(dir, 'test.sqlite');
    store = undefined;
  });

  afterEach(() => {
    if (store) {
      store.close();
      store = undefined;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('hasSeenWebhookId is false on a fresh database, true after recordWebhookId', () => {
    store = new LocalStore(dbPath);
    expect(store.hasSeenWebhookId('wh-1')).toBe(false);
    store.recordWebhookId('wh-1', Date.now());
    expect(store.hasSeenWebhookId('wh-1')).toBe(true);
  });

  it('recordWebhookId called twice with the same id does not throw and leaves countWebhookIds() at 1', () => {
    store = new LocalStore(dbPath);
    const t = Date.now();
    expect(() => store!.recordWebhookId('wh-1', t)).not.toThrow();
    expect(() => store!.recordWebhookId('wh-1', t)).not.toThrow();
    expect(store.countWebhookIds()).toBe(1);
  });

  it('a webhook id recorded before close() is still reported as seen after reopening the same database file', () => {
    store = new LocalStore(dbPath);
    store.recordWebhookId('wh-1', Date.now());
    store.close();

    store = new LocalStore(dbPath);
    expect(store.hasSeenWebhookId('wh-1')).toBe(true);
  });

  it('the poll cursor survives a close/reopen cycle', () => {
    store = new LocalStore(dbPath);
    store.setCursor('registrations', 'cursor-value-1');
    store.close();

    store = new LocalStore(dbPath);
    expect(store.getCursor('registrations')).toBe('cursor-value-1');
  });

  it('getStore() with no argument still resolves the configured LOCAL_STORE_PATH exactly as before', () => {
    // getStore() is a process-wide singleton bound to CONFIG.LOCAL_STORE_PATH
    // (set to ./data/test-extension-service.sqlite by vitest.config.ts's test.env
    // block); this is unrelated to the throwaway `store` created above.
    const singleton = getStore();
    expect(singleton).toBeInstanceOf(LocalStore);
    expect(singleton.hasSeenWebhookId('nonexistent')).toBe(false);
  });
});
