import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

describe('loadConfig() — production-strict validation and Phase 1 defaults', () => {
  let envSnapshot: NodeJS.ProcessEnv;

  beforeEach(() => {
    envSnapshot = { ...process.env };
  });

  afterEach(() => {
    process.env = { ...envSnapshot };
  });

  it('throws naming WEBHOOK_HMAC_SECRET when NODE_ENV=production and it is unset', () => {
    process.env.NODE_ENV = 'production';
    process.env.AGENT_WS_TOKEN = 'real-agent-token';
    process.env.DB_PASSWORD = 'real-db-password';
    process.env.PROXY_IP_WHITELIST = '10.0.0.5';
    delete process.env.WEBHOOK_HMAC_SECRET;

    expect(() => loadConfig()).toThrowError(/WEBHOOK_HMAC_SECRET/);
  });

  it('throws naming PROXY_IP_WHITELIST when NODE_ENV=production and it is unset or only loopback', () => {
    process.env.NODE_ENV = 'production';
    process.env.AGENT_WS_TOKEN = 'real-agent-token';
    process.env.DB_PASSWORD = 'real-db-password';
    process.env.WEBHOOK_HMAC_SECRET = 'real-webhook-secret';
    process.env.PROXY_IP_WHITELIST = '127.0.0.1';

    expect(() => loadConfig()).toThrowError(/PROXY_IP_WHITELIST/);
  });

  it('does not throw when NODE_ENV=production and both webhook controls are configured with real values', () => {
    process.env.NODE_ENV = 'production';
    process.env.AGENT_WS_TOKEN = 'real-agent-token';
    process.env.DB_PASSWORD = 'real-db-password';
    process.env.WEBHOOK_HMAC_SECRET = 'real-webhook-secret';
    process.env.PROXY_IP_WHITELIST = '10.0.0.5,10.0.0.6';
    process.env.DISPLAY_IP_WHITELIST = '10.0.0.20';

    expect(() => loadConfig()).not.toThrow();
  });

  it('throws naming DISPLAY_IP_WHITELIST when NODE_ENV=production and it is unset (D-09, Assumption A4)', () => {
    process.env.NODE_ENV = 'production';
    process.env.AGENT_WS_TOKEN = 'real-agent-token';
    process.env.DB_PASSWORD = 'real-db-password';
    process.env.WEBHOOK_HMAC_SECRET = 'real-webhook-secret';
    process.env.PROXY_IP_WHITELIST = '10.0.0.5,10.0.0.6';
    delete process.env.DISPLAY_IP_WHITELIST;

    expect(() => loadConfig()).toThrowError(/DISPLAY_IP_WHITELIST/);
  });

  it('does not throw when NODE_ENV=production and DISPLAY_IP_WHITELIST is configured alongside the other two controls', () => {
    process.env.NODE_ENV = 'production';
    process.env.AGENT_WS_TOKEN = 'real-agent-token';
    process.env.DB_PASSWORD = 'real-db-password';
    process.env.WEBHOOK_HMAC_SECRET = 'real-webhook-secret';
    process.env.PROXY_IP_WHITELIST = '10.0.0.5,10.0.0.6';
    process.env.DISPLAY_IP_WHITELIST = '10.0.0.20,10.0.0.21';

    const config = loadConfig();
    expect(config.DISPLAY_IP_WHITELIST).toEqual(['10.0.0.20', '10.0.0.21']);
  });

  it('does not throw when NODE_ENV=test and neither control is configured, using dev defaults', () => {
    process.env.NODE_ENV = 'test';
    process.env.AGENT_WS_TOKEN = 'real-agent-token';
    process.env.DB_PASSWORD = 'real-db-password';
    delete process.env.WEBHOOK_HMAC_SECRET;
    delete process.env.PROXY_IP_WHITELIST;

    const config = loadConfig();
    expect(config.WEBHOOK_HMAC_SECRET).toBe('');
    expect(config.PROXY_IP_WHITELIST).toEqual(['127.0.0.1']);
    expect(config.DISPLAY_IP_WHITELIST).toEqual([]);
  });

  it('defaults REGISTRATION_DEDUP_WINDOW_MS and WEBHOOK_TIMESTAMP_SKEW_MS to 300000 when unset', () => {
    process.env.NODE_ENV = 'test';
    process.env.AGENT_WS_TOKEN = 'real-agent-token';
    process.env.DB_PASSWORD = 'real-db-password';
    delete process.env.REGISTRATION_DEDUP_WINDOW_MS;
    delete process.env.WEBHOOK_TIMESTAMP_SKEW_MS;

    const config = loadConfig();
    expect(config.REGISTRATION_DEDUP_WINDOW_MS).toBe(300000);
    expect(config.WEBHOOK_TIMESTAMP_SKEW_MS).toBe(300000);
  });

  it('defaults DB_PORT to 3306 when unset', () => {
    process.env.NODE_ENV = 'test';
    process.env.AGENT_WS_TOKEN = 'real-agent-token';
    process.env.DB_PASSWORD = 'real-db-password';
    delete process.env.DB_PORT;

    const config = loadConfig();
    expect(config.DB_PORT).toBe(3306);
  });
});
