#!/usr/bin/env node

/**
 * CLI Script for RocketLinks Scraping
 *
 * Usage:
 *   npm run scrape:rocketlinks                                    # Scrape ALL categories with price ranges (default)
 *   npm run scrape:rocketlinks -- --start-from g_arts_entertainment  # Resume from a specific category
 *   npm run scrape:rocketlinks -- --date 2026-01-14               # Scrape by date (no price ranges)
 *   npm run scrape:rocketlinks -- --single                        # Scrape single category (default: sw_adult)
 *   npm run scrape:rocketlinks -- --category sw_adult             # Scrape specific category (implies --single)
 *   npm run scrape:rocketlinks -- --login                         # Just test login
 *   npm run scrape:rocketlinks -- --no-api                        # Don't send to database
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { RocketLinksScraperService } from '../modules/rocketlinks/services/rocketlinks-scraper.service';
import { LightpandaService } from '../common/lightpanda.service';
import { ROCKETLINKS_CATEGORIES } from '../config/rocketlinks-categories.config';

async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('RANKWELL ROCKETLINKS SCRAPER');
  console.log('='.repeat(60) + '\n');

  // Parse command line arguments
  const args = process.argv.slice(2);

  // Get category from args (--category sw_adult)
  const categoryIndex = args.indexOf('--category');
  const category = categoryIndex !== -1 && args[categoryIndex + 1]
    ? args[categoryIndex + 1]
    : 'sw_adult'; // Default to sw_adult for testing

  // Get date from args (--date 2026-01-14)
  const dateIndex = args.indexOf('--date');
  const dateFilter = dateIndex !== -1 && args[dateIndex + 1]
    ? args[dateIndex + 1]
    : null;

  // Get start-from category (--start-from g_arts_entertainment)
  const startFromIndex = args.indexOf('--start-from');
  const startFrom = startFromIndex !== -1 && args[startFromIndex + 1]
    ? args[startFromIndex + 1]
    : null;

  // If --category is specified, it implies single mode
  const hasCategoryFlag = categoryIndex !== -1;

  const options = {
    loginOnly: args.includes('--login'),
    scrapeAll: !args.includes('--single') && !hasCategoryFlag, // Default to ALL categories
    sendToAPI: !args.includes('--no-api'),
    category,
    dateFilter, // If set, use date filter instead of price ranges
    startFrom,
  };

  console.log('Options:');
  console.log(`  - Login only: ${options.loginOnly}`);
  console.log(`  - Scrape all categories: ${options.scrapeAll}`);
  console.log(`  - Category: ${options.scrapeAll ? 'ALL' : options.category}`);
  console.log(`  - Start from: ${options.startFrom || 'beginning'}`);
  console.log(`  - Date filter: ${options.dateFilter || 'none (using price ranges)'}`);
  console.log(`  - Send to API: ${options.sendToAPI}`);
  console.log('');

  try {
    // Create NestJS application context
    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: ['log', 'error', 'warn'],
    });

    // Get services
    const scraperService = app.get(RocketLinksScraperService);
    const browserService = app.get(LightpandaService);

    try {
      // Step 1: Login to RocketLinks
      console.log('Step 1: Logging in to RocketLinks...\n');
      await scraperService.login();

      if (options.loginOnly) {
        console.log('\n--login flag set, stopping after login.');
        console.log('Login successful! Browser session is ready for scraping.');

        // Wait a bit to see the result
        await new Promise(resolve => setTimeout(resolve, 5000));

        await scraperService.logout();
        await app.close();
        process.exit(0);
      }

      // Step 2: Scrape categories
      if (options.scrapeAll) {
        // Filter categories if --start-from is set
        let categoriesToScrape = ROCKETLINKS_CATEGORIES;

        if (options.startFrom) {
          const startIdx = categoriesToScrape.findIndex(c => c.id === options.startFrom);
          if (startIdx === -1) {
            console.error(`\nError: Category '${options.startFrom}' not found.`);
            console.error('Available categories:');
            categoriesToScrape.forEach(c => console.error(`  - ${c.id} (${c.name})`));
            await scraperService.logout();
            await app.close();
            process.exit(1);
          }
          categoriesToScrape = categoriesToScrape.slice(startIdx);
          console.log(`\nResuming from category: ${options.startFrom} (skipping ${startIdx} already-scraped categories)`);
        }

        // Scrape ALL categories (or remaining ones)
        const modeDesc = options.dateFilter
          ? `with date filter: ${options.dateFilter}`
          : 'with price ranges';
        console.log(`\nStep 2: Scraping ${categoriesToScrape.length} categories ${modeDesc}...\n`);

        const result = await scraperService.scrapeAllCategories({
          delayBetweenPages: 2000,
          delayBetweenCategories: 5000,
          sendToAPI: options.sendToAPI,
          dateFilter: options.dateFilter,
          categories: categoriesToScrape,
        });

        console.log(`\nAll categories complete!`);
        console.log(`Total categories: ${result.totalCategories}`);
        console.log(`Total sites saved: ${result.totalSites}`);
      } else {
        // Scrape single category
        const modeDesc = options.dateFilter
          ? `with date filter: ${options.dateFilter}`
          : 'with price ranges';
        console.log(`\nStep 2: Scraping category: ${options.category} ${modeDesc}...\n`);

        if (options.dateFilter) {
          // Date mode: scrape without price ranges
          const result = await scraperService.scrapeAllPagesForCategory(options.category, {
            delayBetweenPages: 2000,
            sendToAPI: options.sendToAPI,
            dateFilter: options.dateFilter,
          });
          console.log(`\nScraping complete!`);
          console.log(`Total pages: ${result.totalPages}`);
          console.log(`Total sites saved: ${result.totalSites}`);
        } else {
          // Price range mode
          const result = await scraperService.scrapeAllPriceRangesForCategory(options.category, {
            delayBetweenPages: 2000,
            sendToAPI: options.sendToAPI,
          });
          console.log(`\nScraping complete!`);
          console.log(`Total pages: ${result.totalPages}`);
          console.log(`Total sites saved: ${result.totalSites}`);
        }
      }

      // Cleanup
      await scraperService.logout();
      await app.close();

      console.log('\nScraping complete!');
      console.log('='.repeat(60) + '\n');

      process.exit(0);
    } catch (error) {
      console.error('\nError during scraping:');
      console.error(error.message);

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
