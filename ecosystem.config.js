// The PM2 daemon may run on a different Node than the one this app was
// installed with (e.g. a host whose system Node is pinned for another app).
// Export SCRAPER_NODE=/path/to/node before `pm2 start` to pick the runtime;
// pm2 save persists it, so `pm2 resurrect` after a reboot keeps it too.
const interpreter = process.env.SCRAPER_NODE;

module.exports = {
  apps: [
    {
      name: 'rankwell-scraper',
      script: 'dist/main.js',
      ...(interpreter ? { interpreter } : {}),
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '2G',
      min_uptime: '30s',
      max_restarts: 10,
      restart_delay: 5000,
      env_production: {
        NODE_ENV: 'production',
        ENABLE_CRON: 'true',
        CRON_TIMEZONE: 'Europe/Paris',
        // node-cron schedules in main.ts use the process timezone, so pin it
        // here: the daily job must fire at 23:00 Paris and the "page = day of
        // month" number must be the Paris day.
        TZ: 'Europe/Paris',
        // The VPS has no X server: a headed launch dies on 'Missing X server or
        // $DISPLAY'. Pinned here because process.env beats the .env file in
        // @nestjs/config, so a developer .env with BROWSER_HEADLESS=false
        // cannot take production headed.
        BROWSER_HEADLESS: 'true',
        HEADLESS_BROWSER: 'true',
      },
      env: {
        NODE_ENV: 'development',
        ENABLE_CRON: 'false',
        CRON_TIMEZONE: 'Europe/Paris',
        TZ: 'Europe/Paris',
      },
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
    }
  ]
};
