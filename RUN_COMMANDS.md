# NPM Run Commands Reference

This document describes all available npm run commands in the Rankwell Scraper project.

---

## Build & Development

| Command | Description |
|---------|-------------|
| `npm run build` | Compiles the NestJS application using `nest build` |
| `npm run start` | Starts the NestJS application |
| `npm run start:dev` | Starts the application in watch mode (auto-restarts on file changes) |
| `npm run start:debug` | Starts the application in debug mode with watch enabled |
| `npm run start:prod` | Runs the compiled application from `dist/main` |

---

## Code Quality

| Command | Description |
|---------|-------------|
| `npm run format` | Formats all TypeScript files in `src/` using Prettier |
| `npm run lint` | Runs ESLint with auto-fix on all TypeScript files |
| `npm run test` | Runs Jest test suite |

---

## PM2 Process Management

| Command | Description |
|---------|-------------|
| `npm run pm2:start` | Starts the application using PM2 with `ecosystem.config.js` |
| `npm run pm2:stop` | Stops the PM2 process named `rankwell-scraper` |
| `npm run pm2:restart` | Restarts the PM2 process |
| `npm run pm2:logs` | Shows logs from the PM2 process |
| `npm run pm2:status` | Shows status of all PM2 processes |

---

## Scrapers

### Paper.club Scraper

#### `npm run scrape`

Scrapes all categories from Paper.club website.

**Behavior:**
- Scrapes ALL categories by default
- Calculates BQS (Backlink Quality Score) for each site
- Saves results to file and sends to API after each category

**Options:**
```bash
npm run scrape                    # Scrape all categories (default)
npm run scrape -- --no-bqs        # Skip BQS score calculation
npm run scrape -- --no-save       # Don't save results to file
npm run scrape -- --no-api        # Don't send results to database
npm run scrape -- --truncate      # Truncate database before scraping
```

---

### RocketLinks Scraper

#### `npm run scrape:rocketlinks`

Scrapes data from RocketLinks platform.

**Behavior:**
- By default, scrapes a **single category** (`sw_adult`)
- Requires login to RocketLinks
- Sends scraped data to API

**Options:**
```bash
npm run scrape:rocketlinks                        # Scrape single category (default: sw_adult)
npm run scrape:rocketlinks -- --all               # Scrape ALL categories
npm run scrape:rocketlinks -- --category sw_travel # Scrape a specific category
npm run scrape:rocketlinks -- --login             # Just test login (no scraping)
npm run scrape:rocketlinks -- --no-api            # Don't send results to database
```

---

## Test Scripts

### Authentication Tests

#### `npm run test:auth`

Tests Paper.club API authentication.

**Behavior:**
- Verifies API credentials are working
- Authenticates and gets a token
- Makes a test API request to fetch the "Animaux" category
- Reports success or failure with detailed error info

---

### Category Tests

#### `npm run test:category`

Tests scraping a single Paper.club category.

**Behavior:**
- Scrapes one category (default: Animaux - first category)
- Calculates BQS scores
- Sends results to API
- Shows quality distribution and top sites

**Options:**
```bash
npm run test:category               # Scrape first category (Animaux)
npm run test:category -- Sport      # Scrape Sport category (by name)
npm run test:category -- 5          # Scrape by index (0-based)
npm run test:category -- "High-Tech" # Scrape with spaces in name
```

---

### Browser Tests

#### `npm run test:lightpanda`

Tests Lightpanda cloud browser connection.

**Behavior:**
- Connects to Lightpanda cloud browser
- Navigates to `example.com` and extracts content
- Tests navigation to Hacker News
- Verifies browser service is working correctly

---

### Dashboard Client Tests

#### `npm run test:dashboard`

Tests the Dashboard HTTP client service.

**Behavior:**
- Verifies client initialization and configuration
- Tests header management (custom headers, auth tokens)
- Tests GET/POST request structure
- Shows usage examples for the HTTP client

---

### Netlink Service Tests

#### `npm run test:netlink`

Tests the Netlink service for fetching netlinks from API.

**Behavior:**
- Tests pagination info retrieval
- Fetches pages of netlinks
- Tests batch processing
- Shows progress tracking examples

**Options:**
```bash
npm run test:netlink                # Run basic tests
npm run test:netlink all            # Fetch all netlinks with progress
npm run test:netlink retry          # Test fetch with retry logic
npm run test:netlink batch          # Test memory-efficient batch processing
npm run test:netlink examples       # Show usage examples
```

---

### Netlink Scraper Tests

#### `npm run test:netlink-scraper`

Tests the Netlink scraper service (fetches from internal Dashboard API).

**Behavior:**
- Fetches netlinks in batches of 200 from internal Dashboard API
- Scrapes each netlink URL looking for landing page links
- Posts results back to API via batch upsert
- Continues until all pages are processed
- Shows success/failure rates

**Options:**
```bash

npm run test:netlink-scraper           # Scrape all batches
npm run test:netlink-scraper sample    # Same as default
npm run test:netlink-scraper batch     # Batch scraping with file output
npm run test:netlink-scraper save      # Scrape and save to single JSON file
npm run test:netlink-scraper examples  # Show scraping implementation examples
npm run test:netlink-scraper patterns  # Show service usage patterns
```

---

#### `npm run test:netlink-scraper-rest`

Tests the Netlink scraper with REST API (fetches from `/netlink/all/toScrape`).

**Behavior:**
- Fetches netlinks marked as "toScrape" from Dashboard API
- Scrapes URLs with progress tracking
- Posts results back to batch upsert endpoint
- Shows sample successful and failed results

**Options:**
```bash
npm run test:netlink-scraper-rest           # Scrape first 100 netlinks
npm run test:netlink-scraper-rest batch     # Scrape all pages with pagination
npm run test:netlink-scraper-rest save      # Scrape and save to file
npm run test:netlink-scraper-rest save 2 50 # Scrape page 2 with limit 50
npm run test:netlink-scraper-rest help      # Show usage instructions
```

---

#### `npm run test:netlink-scraper:mock`

Tests the Netlink scraper with mock data (no API required).

**Behavior:**
- Uses test data to verify scraper functionality
- Scrapes `example.com` looking for links
- Tests URL matching logic
- No Dashboard API connection required

---

#### `npm run test:netlink-scraper:contract`

Scrapes netlinks filtered by contract ID with detailed logging.

**Behavior:**
- Fetches netlinks for a specific contract
- Creates detailed log file for each netlink
- Saves results to JSON file
- Posts results to API

**Usage:**
```bash
npm run test:netlink-scraper:contract <contract_id>
npm run test:netlink-scraper:contract 123
npm run test:netlink-scraper:contract help   # Show usage
```

**Output Files:**
- `logs/contract-<id>-<timestamp>.log` - Detailed log file
- `scraped-data/contract-<id>-results.json` - JSON results

---

#### `npm run test:single-netlink`

Debug tool for testing a single netlink URL.

**Behavior:**
- Scrapes a specific URL
- Shows all links found on the page
- Displays detailed URL matching logic
- Saves page source and links to files
- Optionally sends results to API

**Usage:**
```bash
npm run test:single-netlink "<url>" "<landing_page>" [netlink_id]
npm run test:single-netlink "https://example.com/page" "https://target.com/link"
npm run test:single-netlink "https://example.com/page" "https://target.com/link" 123
```

**Output Files:**
- `logs/page-sources/page-source-<timestamp>.html` - Page HTML source
- `logs/page-sources/links-<timestamp>.json` - All links found
- `logs/page-sources/summary-<timestamp>.json` - Test summary

---

### DomDetailer Tests

#### `npm run test:domdetailer`

Tests DomDetailer service for domain authority checks.

**Behavior:**
- Processes ALL netlinks with pagination
- Fetches netlinks page by page
- Runs DomDetailer checks on `url_bought` URLs
- Saves results to database after each batch
- Shows progress and final summary

**Options:**
```bash
npm run test:domdetailer                    # Process all netlinks (paginated)
npm run test:domdetailer batch              # Batch check all netlinks
npm run test:domdetailer contract <id>      # Check netlinks for specific contract
npm run test:domdetailer url <url>          # Check a single URL
npm run test:domdetailer help               # Show help
```

---

#### `npm run test:domdetailer:integration`

Tests DomDetailer integration with Netlink scraper.

**Behavior:**
- Fetches 3 sample netlinks for testing
- Scrapes each netlink with DomDetailer enabled
- Shows combined scraping and DomDetailer results
- Tests batch upsert with DomDetailer data included
- Saves detailed results to JSON file

---

## Examples

### Lightpanda Example

#### `npm run example:lightpanda`

Demonstrates Lightpanda cloud browser usage.

**Behavior:**
- Shows Hacker News scraping example
- Extracts top 10 stories with titles, URLs, and scores
- Demonstrates `withPage` helper for automatic cleanup
- Shows manual page management patterns

---

### DomDetailer Example

#### `npm run example:domdetailer`

Demonstrates DomDetailer service usage patterns.

**Behavior:**
- Shows 7 different usage examples:
  1. Basic usage - single domain check
  2. Custom configuration
  3. Batch processing (sequential)
  4. Concurrent batch processing
  5. Using result map for lookups
  6. Error handling patterns
  7. Integration with scraping results

**Options:**
```bash
npm run example:domdetailer       # Run all examples
npm run example:domdetailer 1     # Run example 1 only
npm run example:domdetailer 3     # Run example 3 only
```

---

## Environment Variables Required

| Variable | Description |
|----------|-------------|
| `DASHBOARD_BASE_URL` | Base URL for the Dashboard API |
| `PAPERCLUB_API_EMAIL` | Paper.club API email |
| `PAPERCLUB_API_PASSWORD` | Paper.club API password |
| `ROCKETLINKS_EMAIL` | RocketLinks login email |
| `ROCKETLINKS_PASSWORD` | RocketLinks login password |
| `LIGHTPANDA_TOKEN` | Lightpanda cloud browser token |
| `DOMDETAILER_API_KEY` | DomDetailer API key |

---

## Quick Reference

### Scraping Commands
```bash
# Paper.club - scrape all categories
npm run scrape

# RocketLinks - scrape all categories
npm run scrape:rocketlinks

# Default: scrape with price ranges
  npm run scrape:rocketlinks

# With date filter (no price ranges)
  npm run scrape:rocketlinks -- --date 2026-01-14

# RocketLinks - scrape single category
npm run scrape:rocketlinks -- --category sw_travel
```

### Testing Commands
```bash
# Test Netlink 
npm run test:netlink-scraper

# Test rest netlink scraping
npm run test:netlink-scraper-rest

# Test scrape Rocketlinks 
npm run scrape:rocketlinks

# Test scrape Paperclub
npm run scrape:paperclub 

# Test DomDetailer
npm run test:domdetailer url example.com
```

### Development Commands
```bash
# Development mode
npm run start:dev

# Build
npm run build

# Lint and format
npm run lint && npm run format
```
