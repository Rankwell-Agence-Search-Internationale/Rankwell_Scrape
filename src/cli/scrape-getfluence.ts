#!/usr/bin/env node

/**
 * CLI Script for Getfluence Scraping
 *
 * Usage:
 *   npm run scrape:getfluence                        # Scrape ALL categories
 *   npm run scrape:getfluence -- --login              # Just test login
 *   npm run scrape:getfluence -- --no-api             # Don't send to database
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { GetfluenceScraperService } from '../modules/getfluence/services/getfluence-scraper.service';
import { LightpandaService } from '../common/lightpanda.service';
import { ScrapingRunReporterService } from '../common/scraping-run-reporter.service';
import { ConfigService } from '@nestjs/config';

async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('RANKWELL GETFLUENCE SCRAPER');
  console.log('='.repeat(60) + '\n');

  // Parse command line arguments
  const args = process.argv.slice(2);

  // Get max pages from args (--max-pages 3)
  const maxPagesIndex = args.indexOf('--max-pages');
  const maxPages = maxPagesIndex !== -1 && args[maxPagesIndex + 1]
    ? parseInt(args[maxPagesIndex + 1], 10)
    : 0; // 0 = unlimited

  const options = {
    loginOnly: args.includes('--login'),
    sendToAPI: !args.includes('--no-api'),
    maxPages,
  };

  console.log('Options:');
  console.log(`  - Login only: ${options.loginOnly}`);
  console.log(`  - Send to API: ${options.sendToAPI}`);
  console.log(`  - Max pages per category: ${options.maxPages || 'unlimited'}`);
  console.log('');

  try {
    // Create NestJS application context
    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: ['log', 'error', 'warn'],
    });

    // Get services
    const scraperService = app.get(GetfluenceScraperService);
    const browserService = app.get(LightpandaService);
    const reporter = app.get(ScrapingRunReporterService);
    const baseUrl = app.get(ConfigService).get<string>('GETFLUENCE_URL', 'https://app.getfluence.com');

    // Started before login so a login failure is reported as a failed job.
    const run = options.loginOnly ? null : reporter.start('getfluence');

    try {
      // Step 1: Login to Getfluence
      console.log('Step 1: Logging in to Getfluence...\n');
      await scraperService.login();

      if (options.loginOnly) {
        console.log('\n--login flag set, stopping after login.');
        console.log('Login successful! Browser session is ready for scraping.');

        await new Promise(resolve => setTimeout(resolve, 5000));

        await scraperService.logout();
        await app.close();
        process.exit(0);
      }

      // Step 2: Scrape all categories
      console.log('\nStep 2: Scraping all categories...\n');
      const result = await scraperService.scrapeAllCategories({
        sendToAPI: options.sendToAPI,
        maxPages: options.maxPages,
      });

      console.log(`\nScraping complete!`);
      console.log(`Total categories: ${result.categoryResults.length}`);
      console.log(`Total sites: ${result.totalSites}`);

      const outcome = {
        successCount: result.totalSites,
        failed: result.categoryResults
          .filter(r => r.error)
          .map(r => ({ url: `${baseUrl} category:${r.category}`, reason: r.error })),
      };
      if (result.totalSites === 0 && result.categoryResults.length > 0) {
        await run.fail(new Error(`0 sites returned across ${result.categoryResults.length} categories`), outcome);
      } else {
        await run.finish(outcome);
      }

      // Cleanup
      await scraperService.logout();
      await app.close();

      console.log('\nDone!');
      console.log('='.repeat(60) + '\n');

      process.exit(0);
    } catch (error) {
      console.error('\nError during scraping:');
      console.error(error.message);

      if (run) await run.fail(error);

      // Cleanup on error
      try {
        await scraperService.logout();
      } catch {}

      await app.close();
      process.exit(1);
    }
  } catch (error) {
    console.error('\nFailed to initialize application:');
    console.error(error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

export { main };
