# Rankwell Paper.club Scraper (NestJS)

A professional, reusable web scraper for Paper.club built with **NestJS**, **TypeScript**, and **Playwright** (ready for Lightpanda integration).

## Features

- 🚀 **API-Based Scraping** - Efficiently scrapes Paper.club using their API (no browser automation needed for Paper.club)
- 📊 **BQS Scoring** - Automatic Backlink Quality Score calculation for each site
- 🏗️ **Clean Architecture** - NestJS modules with dependency injection
- 🔄 **Reusable Services** - Modular design for easy extension
- 💾 **Database Integration** - Direct sync with your NestJS backend API
- 📁 **File Export** - Save scraped data as JSON files
- ⚙️ **Configurable** - Environment-based configuration
- 🎯 **Type-Safe** - Full TypeScript support with interfaces and DTOs

## Project Structure

```
Rankwell_Scrape/
├── src/
│   ├── modules/
│   │   └── paperclub/
│   │       ├── services/
│   │       │   ├── paperclub-api.service.ts       # API client
│   │       │   ├── paperclub-scraper.service.ts   # Main orchestrator
│   │       │   └── data-transformer.service.ts    # Data transformation
│   │       ├── interfaces/
│   │       │   └── paperclub-site.interface.ts    # TypeScript interfaces
│   │       ├── dto/
│   │       │   └── paperclub-site.dto.ts          # Data validation
│   │       └── paperclub.module.ts                # Module definition
│   ├── scoring/
│   │   └── bqs-calculator.service.ts              # BQS scoring logic
│   ├── common/
│   │   └── database.service.ts                    # Database API client
│   ├── config/
│   │   └── categories.config.ts                   # Category definitions
│   ├── cli/
│   │   └── scrape-paperclub.ts                    # CLI script
│   ├── app.module.ts                              # Root module
│   └── main.ts                                    # Bootstrap
├── data/                                          # Output directory
├── logs/                                          # Log files
├── .env                                           # Environment variables
├── package.json
├── tsconfig.json
└── README.md
```

## Installation

### 1. Install Dependencies

```bash
npm install
```

### 2. Install Playwright (Optional - for future browser-based scraping)

```bash
npx playwright install chromium
```

### 3. Configure Environment

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Paper.club Credentials
PAPER_CLUB_EMAIL=your-email@example.com
PAPER_CLUB_PASSWORD=your-password

# API Configuration
PAPER_CLUB_API_URL=https://app.paper.club/api

# Scraping Settings
REQUEST_DELAY=300
PAGE_LIMIT=100

# Backend API (for database sync)
BACKEND_API_URL=http://localhost:5000
BACKEND_API_TIMEOUT=30000

# BQS Scoring
BQS_T_MAX=100000
BQS_RD_MAX=1000
BQS_HARD_FILTER=true
```

## Usage

### Basic Scraping

Scrape all categories with BQS scoring and save to file + database:

```bash
npm run scrape
```

### CLI Options

```bash
# Skip BQS scoring (faster)
npm run scrape -- --no-bqs

# Don't save to file (only database)
npm run scrape -- --no-save

# Don't send to database (only save to file)
npm run scrape -- --no-db

# Truncate database before scraping
npm run scrape -- --truncate
```

### Development

```bash
# Run in development mode
npm run start:dev

# Build the project
npm run build

# Run built version
npm run start:prod
```

## API-Based Scraping

Paper.club scraping is **API-based**, not browser-based:

1. **Authentication** - Logs into Paper.club API with credentials
2. **Paginated Fetching** - Fetches all pages for each category
3. **Data Transformation** - Converts API responses to structured data
4. **BQS Scoring** - Calculates quality scores
5. **Persistence** - Saves to JSON files and/or database

## Playwright Integration (Future)

The project is structured to easily add Playwright/Lightpanda for browser-based scraping:

```typescript
// Example: Add browser service
@Injectable()
export class BrowserService {
  async launch() {
    const browser = await playwright.chromium.launch({
      headless: true,
    });
    return browser;
  }
}
```

### Lightpanda Integration

To use Lightpanda (lightweight Playwright alternative):

```bash
# Install Lightpanda
npm install lightpanda-playwright

# Update browser service to use Lightpanda
import { chromium } from 'lightpanda-playwright';
```

## BQS Scoring

The scraper includes a sophisticated **Backlink Quality Score (BQS)** calculator:

### Scoring Factors

- **Authority** (45%): Trust Flow, Domain Rating, Citation Flow
- **Traffic** (30%): Normalized monthly traffic
- **Referring Domains** (25%): Domain authority indicators
- **Consistency Penalty**: Penalizes CF/TF and DR/TF gaps

### Quality Tiers

- **Excellent** (BQS ≥ 75): Premium backlink opportunities
- **Good** (BQS 60-74): Quality backlinks
- **Fair** (BQS 45-59): Moderate quality
- **Poor** (BQS < 45): Low quality

### Hard Filters

- TF ≥ 10
- DR ≥ 10
- Traffic ≥ 100/month
- CF/TF gap ≤ 40
- DR/TF gap ≤ 40

## Database Integration

The scraper sends data to your NestJS backend API:

### Required Endpoints

Your backend must implement:

```
POST /backlinks/add
  - Accepts array of Paper.club sites
  - Returns 200 on success

DELETE /backlinks/deleteByCategory?category={name}&provider=Paper%20Club
  - Deletes sites by category
  - Returns 200 on success

GET /backlinks/turncate_tables
  - Truncates Paper.club data
  - Returns 200 on success
```

## Output Format

### JSON File Structure

```json
[
  {
    "category": "Animaux",
    "category_id": "4DPZZQt60rXRwkaFls6VLf",
    "total": 150,
    "sites": [
      {
        "name": "example.com",
        "provider": "Paper Club",
        "tf": 45,
        "cf": 42,
        "domainRating": 50,
        "traffic": 5000,
        "articles_price": 150,
        "category": "Animaux",
        "bqs_score": 68.5,
        "bqs_score_info": {
          "bqs_quality_tier": "Good",
          "bqs_authority": 47.4,
          "bqs_passed_filter": true,
          "bqs_roi": 0.46
        },
        ...
      }
    ]
  }
]
```

## Categories

The scraper processes 33 thematic categories:

- Animaux, Auto & Moto, Business & Entreprise
- Culture & Art, Ecologie & Environnement
- Finance & Banque, Formation & Emploi
- Gaming & Jeux vidéo, High-Tech & Geek
- Immobilier & Assurance, Informatique
- Lifestyle & Vie pratique, Marketing & Communication
- Mode & Beauté, Santé & Bien-être
- Sport, Tourisme & Voyage, ...and more

See `src/config/categories.config.ts` for the complete list.

## Extending the Scraper

### Add a New Provider

```typescript
// 1. Create interface
export interface NewProviderSite {
  name: string;
  // ... fields
}

// 2. Create API service
@Injectable()
export class NewProviderAPIService {
  async fetchData() {
    // Implementation
  }
}

// 3. Create transformer
@Injectable()
export class NewProviderTransformer {
  transform(raw: any): NewProviderSite {
    // Implementation
  }
}

// 4. Create module and wire it up
@Module({
  providers: [NewProviderAPIService, NewProviderTransformer],
  exports: [NewProviderAPIService],
})
export class NewProviderModule {}
```

## Testing

```bash
# Run tests
npm test

# Test with sample data
npm run scrape -- --no-db
```

## Troubleshooting

### Authentication Issues

- Verify credentials in `.env`
- Check Paper.club account is active
- Ensure no rate limiting from Paper.club

### Database Connection

- Verify `BACKEND_API_URL` is correct
- Ensure backend API is running
- Check network connectivity

### Performance

- Adjust `REQUEST_DELAY` for rate limiting
- Use `--no-bqs` flag to skip scoring
- Process categories in batches if needed

## License

MIT

## Author

Rankwell

---

**Note**: This scraper respects Paper.club's terms of service. Always use responsibly and comply with rate limits.
#   R a n k w e l l _ S c r a p e 
 
 

============================================================
[Nest] 1342570  - 03/16/2026, 4:03:22 PM     LOG [GetfluenceScraperService] CATEGORY 12/24: Hobbies and leisure activities
[Nest] 1342570  - 03/16/2026, 4:03:22 PM     LOG [GetfluenceScraperService] ============================================================
[Nest] 1342570  - 03/16/2026, 4:03:33 PM    WARN [GetfluenceScraperService] Could not open dropdown for Hobbies and leisure activities, skipping
[Nest] 1342570  - 03/16/2026, 4:03:33 PM     LOG [GetfluenceScraperService]

Total sites: 11175
[Nest] 1342570  - 03/16/2026, 4:06:18 PM     LOG [GetfluenceScraperService]
[Nest] 1342570  - 03/16/2026, 4:06:18 PM     LOG [GetfluenceScraperService]   1. Animals and pets: 514 sites
[Nest] 1342570  - 03/16/2026, 4:06:18 PM     LOG [GetfluenceScraperService]   2. Arts and entertainment: 0 sites
[Nest] 1342570  - 03/16/2026, 4:06:18 PM     LOG [GetfluenceScraperService]   3. BtoB / Marketing: 6075 sites
[Nest] 1342570  - 03/16/2026, 4:06:18 PM     LOG [GetfluenceScraperService]   4. Community and society: 0 sites
[Nest] 1342570  - 03/16/2026, 4:06:18 PM     LOG [GetfluenceScraperService]   5. E-commerce: 909 sites
[Nest] 1342570  - 03/16/2026, 4:06:18 PM     LOG [GetfluenceScraperService]   6. Employment and career: 0 sites
[Nest] 1342570  - 03/16/2026, 4:06:18 PM     LOG [GetfluenceScraperService]   7. Finance and Economy: 2358 sites
[Nest] 1342570  - 03/16/2026, 4:06:18 PM     LOG [GetfluenceScraperService]   8. Food and drink: 0 sites
[Nest] 1342570  - 03/16/2026, 4:06:18 PM     LOG [GetfluenceScraperService]   9. Gambling: 394 sites
[Nest] 1342570  - 03/16/2026, 4:06:18 PM     LOG [GetfluenceScraperService]   10. Games and Gaming: 0 sites
[Nest] 1342570  - 03/16/2026, 4:06:18 PM     LOG [GetfluenceScraperService]   11. Health: 925 sites
[Nest] 1342570  - 03/16/2026, 4:06:18 PM     LOG [GetfluenceScraperService]   12. Hobbies and leisure activities: 0 sites
[Nest] 1342570  - 03/16/2026, 4:06:18 PM     LOG [GetfluenceScraperService]   13. House and garden: 0 sites
[Nest] 1342570  - 03/16/2026, 4:06:18 PM     LOG [GetfluenceScraperService]   14. Industry and construction: 0 sites
[Nest] 1342570  - 03/16/2026, 4:06:18 PM     LOG [GetfluenceScraperService]   15. Law and Government: 0 sites
[Nest] 1342570  - 03/16/2026, 4:06:18 PM     LOG [GetfluenceScraperService]   16. Lifestyle: 0 sites
[Nest] 1342570  - 03/16/2026, 4:06:18 PM     LOG [GetfluenceScraperService]   17. News and Media: 0 sites
[Nest] 1342570  - 03/16/2026, 4:06:18 PM     LOG [GetfluenceScraperService]   18. Rated Adult: 0 sites
[Nest] 1342570  - 03/16/2026, 4:06:18 PM     LOG [GetfluenceScraperService]   19. Reference works: 0 sites
[Nest] 1342570  - 03/16/2026, 4:06:18 PM     LOG [GetfluenceScraperService]   20. Science and education: 0 sites
[Nest] 1342570  - 03/16/2026, 4:06:18 PM     LOG [GetfluenceScraperService]   21. Sports: 0 sites
[Nest] 1342570  - 03/16/2026, 4:06:18 PM     LOG [GetfluenceScraperService]   22. Tech and Geek: 0 sites
[Nest] 1342570  - 03/16/2026, 4:06:18 PM     LOG [GetfluenceScraperService]   23. Travel and tourism: 0 sites
[Nest] 1342570  - 03/16/2026, 4:06:18 PM     LOG [GetfluenceScraperService]   24. Vehicles and cars: 0 sites