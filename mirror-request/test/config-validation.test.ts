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
    // Phase 8 D-13: a fourth production-required control. This line was added
    // when CMS_IP_WHITELIST landed — without it the case fails naming the CMS
    // key rather than proving anything about the webhook controls it is
    // actually about.
    process.env.CMS_IP_WHITELIST = '10.0.0.30';

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
    process.env.CMS_IP_WHITELIST = '10.0.0.30';

    const config = loadConfig();
    expect(config.DISPLAY_IP_WHITELIST).toEqual(['10.0.0.20', '10.0.0.21']);
  });

  // -------------------------------------------------------------------------
  // Phase 8 — CMS_IP_WHITELIST (D-13, RESEARCH Pitfall 2)
  // -------------------------------------------------------------------------

  it('throws naming CMS_IP_WHITELIST when NODE_ENV=production and it is unset (D-13)', () => {
    process.env.NODE_ENV = 'production';
    process.env.AGENT_WS_TOKEN = 'real-agent-token';
    process.env.DB_PASSWORD = 'real-db-password';
    process.env.WEBHOOK_HMAC_SECRET = 'real-webhook-secret';
    process.env.PROXY_IP_WHITELIST = '10.0.0.5,10.0.0.6';
    process.env.DISPLAY_IP_WHITELIST = '10.0.0.20';
    delete process.env.CMS_IP_WHITELIST;

    expect(() => loadConfig()).toThrowError(/CMS_IP_WHITELIST/);
  });

  it('keeps CMS_IP_WHITELIST independent of DISPLAY_IP_WHITELIST — a configured display list does not satisfy the CMS one', () => {
    process.env.NODE_ENV = 'production';
    process.env.AGENT_WS_TOKEN = 'real-agent-token';
    process.env.DB_PASSWORD = 'real-db-password';
    process.env.WEBHOOK_HMAC_SECRET = 'real-webhook-secret';
    process.env.PROXY_IP_WHITELIST = '10.0.0.5,10.0.0.6';
    // The room's TVs are configured; the operator's laptop is not. RESEARCH
    // Pitfall 2's failure mode is exactly this being allowed to pass.
    process.env.DISPLAY_IP_WHITELIST = '10.0.0.20,10.0.0.21';
    delete process.env.CMS_IP_WHITELIST;

    expect(() => loadConfig()).toThrowError(/CMS_IP_WHITELIST/);

    process.env.CMS_IP_WHITELIST = '10.0.0.30';
    const config = loadConfig();
    expect(config.CMS_IP_WHITELIST).toEqual(['10.0.0.30']);
    expect(config.CMS_IP_WHITELIST).not.toEqual(config.DISPLAY_IP_WHITELIST);
  });

  it('defaults CMS_SESSION_COOKIE_NAME to cms_session and never exposes a plaintext CMS password (D-14)', () => {
    process.env.NODE_ENV = 'test';
    process.env.AGENT_WS_TOKEN = 'real-agent-token';
    process.env.DB_PASSWORD = 'real-db-password';
    delete process.env.CMS_SESSION_COOKIE_NAME;

    const config = loadConfig();
    expect(config.CMS_SESSION_COOKIE_NAME).toBe('cms_session');
    // The only credential key on EnvConfig is the hash — there is no
    // CMS_PASSWORD field for a plaintext value to be assigned to.
    expect(Object.keys(config)).not.toContain('CMS_PASSWORD');
    expect(config.CMS_PASSWORD_HASH).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
  });

  it('does not throw when NODE_ENV=test and neither control is configured, using dev defaults', () => {
    process.env.NODE_ENV = 'test';
    process.env.AGENT_WS_TOKEN = 'real-agent-token';
    process.env.DB_PASSWORD = 'real-db-password';
    delete process.env.WEBHOOK_HMAC_SECRET;
    delete process.env.PROXY_IP_WHITELIST;
    // Deleted for the same reason as the two above, and it was missing: this
    // case asserts the SHIPPED DEFAULT, so it must not read whatever the
    // developer's own `.env` happens to hold. Without this line the case
    // passed only on machines whose .env had no DISPLAY_IP_WHITELIST, and
    // went red the day a real deployment configured one — a test failing
    // because production was configured correctly.
    delete process.env.DISPLAY_IP_WHITELIST;

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
