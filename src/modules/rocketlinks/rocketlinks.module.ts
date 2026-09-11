import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { RocketLinksScraperService } from './services/rocketlinks-scraper.service';
import { BQSCalculatorService } from '../../scoring/bqs-calculator.service';
import { DatabaseService } from '../../common/database.service';
import { LightpandaService } from '../../common/lightpanda.service';
import { DashboardHttpClient } from '../../common/dashboard-http-client.service';
import { ScrapingRunReporterService } from '../../common/scraping-run-reporter.service';

/**
 * RocketLinks Module
 *
 * Encapsulates all RocketLinks scraping functionality including:
 * - Browser-based authentication
 * - Site scraping
 * - Data transformation
 * - BQS scoring
 * - Database persistence
 */
@Module({
  imports: [HttpModule, ConfigModule],
  providers: [
    RocketLinksScraperService,
    BQSCalculatorService,
    DatabaseService,
    LightpandaService,
    DashboardHttpClient,
    ScrapingRunReporterService,
  ],
  exports: [
    RocketLinksScraperService,
    DatabaseService,
    LightpandaService,
    DashboardHttpClient,
    ScrapingRunReporterService,
  ],
})
export class RocketLinksModule {}
