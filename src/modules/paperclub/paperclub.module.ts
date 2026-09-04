import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { PaperClubAPIService } from './services/paperclub-api.service';
import { DataTransformerService } from './services/data-transformer.service';
import { PaperClubScraperService } from './services/paperclub-scraper.service';
import { NetlinkService } from './services/netlink.service';
import { NetlinkScraperService } from './services/netlink-scraper.service';
import { BQSCalculatorService } from '../../scoring/bqs-calculator.service';
import { DatabaseService } from '../../common/database.service';
import { LightpandaService } from '../../common/lightpanda.service';
import { DashboardHttpClient } from '../../common/dashboard-http-client.service';
import { DomDetailerService } from '../../common/domdetailer.service';
import { GoogleSearchConsoleService } from '../../common/google-search-console.service';
import { FirecrawlService } from '../../common/firecrawl.service';

/**
 * Paper.club Module
 *
 * Encapsulates all Paper.club scraping functionality including:
 * - API client
 * - Data transformation
 * - Scraping orchestration
 * - BQS scoring
 * - Database persistence
 * - Browser automation
 * - Dashboard API integration
 */
@Module({
  imports: [HttpModule, ConfigModule],
  providers: [
    PaperClubAPIService,
    DataTransformerService,
    PaperClubScraperService,
    NetlinkService,
    NetlinkScraperService,
    BQSCalculatorService,
    DatabaseService,
    LightpandaService,
    DashboardHttpClient,
    DomDetailerService,
    GoogleSearchConsoleService,
    FirecrawlService,
  ],
  exports: [
    PaperClubScraperService,
    PaperClubAPIService,
    DataTransformerService,
    NetlinkService,
    NetlinkScraperService,
    DatabaseService,
    LightpandaService,
    DashboardHttpClient,
    DomDetailerService,
    GoogleSearchConsoleService,
    FirecrawlService,
  ],
})
export class PaperClubModule {}
