import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.?(c|m)[jt]s?(x)', 'test/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    // Removes the per-test SQLite files the constructor-seam pattern creates.
    // See test/global-teardown.ts for why, and for the scoping guarantee that
    // keeps it away from the real store and the backups.
    globalSetup: ['./test/global-teardown.ts'],
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      AGENT_WS_TOKEN: 'test-agent-token',
      DB_PASSWORD: 'test-db-password',
      WEBHOOK_HMAC_SECRET: 'test-webhook-secret',
      LOCAL_STORE_PATH: './data/test-extension-service.sqlite',
      // Phase 8 (D-13/D-14). CMS_USERNAME and CMS_PASSWORD_HASH go through
      // config.ts's required() check, so they MUST be supplied here in the
      // same commit that adds them to config.ts — otherwise every existing
      // test fails at loadConfig(), for want of a value rather than for any
      // real defect. CMS_IP_WHITELIST and CMS_SESSION_COOKIE_NAME are not
      // required() keys but are pinned here so a test never depends on a
      // developer's own .env.
      //
      // The hash below is a real scrypt digest (N=2^14, r=8, p=1) of the
      // string 'test-cms-password', minted by scripts/hashCmsPassword.ts. It
      // is a test fixture, not a credential: nothing in production reads it,
      // and the plaintext it covers is published in this comment on purpose
      // so no future reader mistakes it for a leaked secret.
      CMS_USERNAME: 'test-operator',
      CMS_PASSWORD_HASH:
        '787573058ca13b1fccd1066f920d3277:9f4c0257894e8a206c18c88bd9dfa13179f31ff28797230aa8b66acca9a5efec3e95bf87ae1b8876b014d43cb8d2457d7f9c85f0b2448fa25126d8e4af43e5ac',
      CMS_IP_WHITELIST: '',
      CMS_SESSION_COOKIE_NAME: 'cms_session',
      // Pinned for the reason the comment above already gives, and it was the
      // one allow-list left out. A real deployment configuring
      // DISPLAY_IP_WHITELIST in `.env` turned config-validation.test.ts red
      // on that machine alone — the suite must not depend on a developer's
      // own .env. Suites that need a non-empty list still set it themselves
      // in `vi.hoisted`, which runs after this block is applied.
      DISPLAY_IP_WHITELIST: '',
    },
  },
});
