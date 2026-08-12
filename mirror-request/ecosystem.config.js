module.exports = {
  apps: [{
    name: 'mirror-service',
    script: './dist/index.js',
    // Default (`pm2 start ecosystem.config.js`). config.ts fail-fasts in
    // production unless WEBHOOK_HMAC_SECRET, PROXY_IP_WHITELIST and
    // DISPLAY_IP_WHITELIST are all set — see OPS-RUNBOOK §3. Starting here
    // without them crash-loops to max_restarts rather than serving.
    env: {
      NODE_ENV: 'production',
    },
    // `pm2 start ecosystem.config.js --env staging` — for a booth rehearsal on
    // a machine that does not yet hold the production secrets. Same code, same
    // process supervision; only the fail-fast gate differs. Never use this for
    // a real event: it leaves webhook signature verification and both IP
    // allow-lists disabled.
    env_staging: {
      NODE_ENV: 'staging',
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    time: true,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 2000,
  }],
};
