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
    },
  },
});
