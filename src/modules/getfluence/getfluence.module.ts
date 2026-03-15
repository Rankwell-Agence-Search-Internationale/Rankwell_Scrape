import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { GetfluenceScraperService } from './services/getfluence-scraper.service';
import { BQSCalculatorService } from '../../scoring/bqs-calculator.service';
import { DatabaseService } from '../../common/database.service';
import { LightpandaService } from '../../common/lightpanda.service';
import { DashboardHttpClient } from '../../common/dashboard-http-client.service';

/**
 * Getfluence Module
 *
 * Encapsulates all Getfluence scraping functionality including:
 * - Browser-based authentication
 * - Site scraping
 * - Data transformation
 * - BQS scoring
 * - Database persistence
 */
@Module({
  imports: [HttpModule, ConfigModule],
  providers: [
    GetfluenceScraperService,
    BQSCalculatorService,
    DatabaseService,
    LightpandaService,
    DashboardHttpClient,
  ],
  exports: [
    GetfluenceScraperService,
    DatabaseService,
    LightpandaService,
    DashboardHttpClient,
  ],
})
export class GetfluenceModule {}
