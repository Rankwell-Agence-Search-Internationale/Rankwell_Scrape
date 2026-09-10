# VPS Deployment

Live deployment: `72.62.239.187`, app at `/opt/rankwell-scrape`, PM2 process
`rankwell-scraper`.

This host also runs the Dashboard backend (`rankwell-dashboard-server`, nginx
for `dashboard.rankwell.fr`, MySQL, Redis). Two constraints follow from that,
and both are load-bearing:

- **Do not change the system Node.** `/usr/bin/node` is 18.19.1 and the
  dashboard is pinned to it. The scraper runs on an nvm-installed Node 20
  instead, selected via `SCRAPER_NODE` (see below).
- **Do not run `pm2 startup` again.** `pm2-root.service` is already installed
  and enabled by the dashboard deployment. `pm2 save` is all that is needed to
  persist a new app across reboots.

## First-time setup

```bash
# Node 20, isolated from the system Node the dashboard uses
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
nvm install 20

git clone https://github.com/Rankwell-Agence-Search-Internationale/Rankwell_Scrape.git \
  /opt/rankwell-scrape
cd /opt/rankwell-scrape

# .env is gitignored — copy it from a machine that has it, then lock it down.
# scp .env root@72.62.239.187:/opt/rankwell-scrape/.env
chmod 600 .env

npm ci                                    # dev deps included: the scrape:*/test:* CLIs use ts-node
npx playwright install --with-deps chromium
npm run build
mkdir -p logs
```

### BROWSER_HEADLESS must be true here

A `.env` copied from a dev machine often carries `BROWSER_HEADLESS=false` for
debugging. On this server that launches the *headed* chromium build, which dies
with `Missing X server or $DISPLAY`; Playwright surfaces it as the much less
obvious `browserType.launch: Target page, context or browser has been closed`,
and every scrape fails.

`ecosystem.config.js` pins `BROWSER_HEADLESS=true` in `env_production` as a
guard. That works because `process.env` beats the `.env` file in
`@nestjs/config` — `assignVariablesToProcess` only fills in keys that are not
already set. Keep the `.env` correct anyway.

## Start / update

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 20
cd /opt/rankwell-scrape
export SCRAPER_NODE="$(nvm which 20)"     # PM2's daemon runs on system Node 18

git pull && npm ci && npm run build
npm run pm2:start                          # or pm2:restart if already running
pm2 save                                   # persist across reboot
```

`SCRAPER_NODE` matters only at `pm2 start` time; `pm2 save` writes the resolved
interpreter into `~/.pm2/dump.pm2`, so `pm2 resurrect` after a reboot keeps
Node 20.

Both `pm2:start` and `pm2:restart` pass `--env production`. Plain
`pm2 start ecosystem.config.js` would silently apply the *development* env
block instead (`NODE_ENV=development`, `ENABLE_CRON=false`).

## Scheduled jobs

`TZ=Europe/Paris` is set in `env_production`. The `cron.schedule` calls in
`src/main.ts` pass no timezone option, so they follow the process timezone —
without this the host clock (UTC) would shift both jobs by an hour and change
which day-of-month page gets scraped.

| Job | Schedule (Paris) | Notes |
|-----|------------------|-------|
| Netlink scraper | daily 23:00 | page number = day of month |
| DomDetailer | last day of month, 23:00 | paginates all netlinks |

Only ever run these on **one** host. Two instances would scrape the same page
and double-post to `/netlink/batchUpsert`.

## Verify

```bash
pm2 logs rankwell-scraper --lines 50
node dist/main test          # scrapes 5 netlinks + 5 DomDetailer, posts nothing
```

A healthy `node dist/main test` ends with `Total: 5, Success: 5` twice. The
DomDetailer half prints `DA: N/A` even when it works — that log line reads a
`domainAuthority` field the API does not return (the real values are `mozDA` /
`majesticTF`, and the full payload is what gets stored).

The `GoogleSearchConsoleService` authentication error at startup is expected
unless `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` is configured. Neither cron job uses
GSC.

## PM2 commands

| Command | Description |
|---------|-------------|
| `npm run pm2:start` | Start (production env) |
| `npm run pm2:restart` | Restart, re-reading env |
| `npm run pm2:stop` | Stop |
| `npm run pm2:logs` | Tail logs |
| `npm run pm2:status` | Status |
| `pm2 monit` | Real-time monitoring |
