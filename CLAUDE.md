# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NestJS + TypeScript scraper application for backlink marketplace platforms (Paper.club, RocketLinks, Netlink). Scrapes site data, calculates Backlink Quality Scores (BQS), and syncs results to a backend Dashboard API at `rankwell.one/api`.

## Common Commands

```bash
# Build
npm run build

# Dev mode (watch)
npm run start:dev

# Production (runs cron jobs for daily netlink scraping + monthly DomDetailer)
npm run start:prod

# Lint (with auto-fix)
npm run lint

# Format
npm run format

# Tests
npm test

# Scrape Paper.club (all categories)
npm run scrape:paperclub

# Scrape RocketLinks (all categories)
npm run scrape:rocketlinks -- --all

# Scrape RocketLinks (single category)
npm run scrape:rocketlinks -- --category sw_travel

# Test single netlink URL
npm run test:single-netlink "<url>" "<landing_page>" [netlink_id]

# Test DomDetailer on a URL
npm run test:domdetailer url example.com
```

PM2 for production: `npm run pm2:start` (config in `ecosystem.config.js`, timezone Europe/Paris).

## Architecture

**NestJS module structure** with dependency injection. Two main scraper modules plus shared services:

- `src/modules/paperclub/` — Paper.club API-based scraper (no browser needed). Services: `paperclub-api.service` (auth + API client), `paperclub-scraper.service` (orchestrator), `data-transformer.service`, `netlink-scraper.service` (scrapes netlink URLs for landing page links using Playwright), `netlink.service` (fetches netlinks from Dashboard API).
- `src/modules/rocketlinks/` — RocketLinks browser-based scraper using Playwright with stealth plugin. Service: `rocketlinks-scraper.service`.
- `src/scoring/bqs-calculator.service.ts` — BQS scoring: Authority (45%), Traffic (30%), Referring Domains (25%), with consistency penalties and hard filters (TF>=10, DR>=10, Traffic>=100).
- `src/common/` — Shared services: `database.service` (backend API client), `dashboard-http-client.service` (Dashboard API), `domdetailer.service` (domain authority checks), `lightpanda.service` (cloud browser), `cron-manager.ts` / `cron.service.ts` (scheduled jobs).
- `src/config/` — Category definitions for Paper.club and RocketLinks.
- `src/cli/` — Standalone CLI scripts (run via `ts-node`). Each `test:*` and `scrape:*` npm script maps to a file here.

**Data flow**: Scrape platform API/website → Transform to DTO → Calculate BQS → POST to Dashboard API (`/backlinks/add`, `/netlink/batchUpsert`, etc.) and/or save to `data/` or `scraped-data/` as JSON.

**Cron jobs** (in `main.ts`): Netlink scraper runs daily at 23:00 (page = day of month). DomDetailer runs on last day of month at 23:00. Controlled by `ENABLE_CRON` env var.

## TypeScript Path Aliases

Configured in `tsconfig.json`: `@/*` → `src/*`, `@modules/*` → `src/modules/*`, `@config/*` → `src/config/*`, `@common/*` → `src/common/*`.

## Environment

Requires `.env` file (see `.env.example`). Key vars: `PAPERCLUB_API_EMAIL/PASSWORD`, `ROCKETLINKS_EMAIL/PASSWORD`, `DASHBOARD_BASE_URL`, `LIGHTPANDA_TOKEN`, `DOMDETAILER_API_KEY`. RocketLinks scraper needs `--max-old-space-size=4096`.
