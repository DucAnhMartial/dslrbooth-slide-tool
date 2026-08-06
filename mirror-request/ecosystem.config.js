module.exports = {
  apps: [{
    name: 'mirror-service',
    script: './dist/index.js',
    env: {
      NODE_ENV: 'production',
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    time: true,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 2000,
  }],
};
