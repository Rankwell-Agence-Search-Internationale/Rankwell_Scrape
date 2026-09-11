import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';
import * as cron from 'node-cron';
import { NetlinkScraperService, ScrapedNetlinkData } from './modules/paperclub/services/netlink-scraper.service';
import { NetlinkService } from './modules/paperclub/services/netlink.service';
import { DomDetailerService } from './common/domdetailer.service';
import { DashboardHttpClient } from './common/dashboard-http-client.service';
import { ScrapingRunReporterService } from './common/scraping-run-reporter.service';
import { ConfigService } from '@nestjs/config';

const logger = new Logger('Main');

/**
 * Bootstrap the NestJS application with cron jobs
 */
async function bootstrap() {
  const bootstrapLogger = new Logger('Bootstrap');

  // Create HTTP application (ready for REST API endpoints)
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'error', 'warn', 'debug'],
  });

  bootstrapLogger.log('Rankwell Paper.club Scraper initialized');

  return app;
}

/**
 * Run the netlink scraper cron job
 * Page = day of month (1-31), so each day scrapes a different page
 */
async function runNetlinkScraperJob() {
  const dayOfMonth = new Date().getDate(); // 1-31
  logger.log(`Starting scheduled netlink scraper job (Day ${dayOfMonth}, Page ${dayOfMonth})...`);

  const app = await NestFactory.createApplicationContext(AppModule);
  const scraperService = app.get(NetlinkScraperService);
  const netlinkService = app.get(NetlinkService);
  const reporter = app.get(ScrapingRunReporterService);
  const dashboardBaseUrl = app.get(ConfigService).get<string>('DASHBOARD_BASE_URL', '');

  const run = reporter.start(
    'netlink',
    `${dashboardBaseUrl}/netlink/all/paginated?page=${dayOfMonth}&limit=200`,
  );
  // Kept outside the try so a failure after scraping can still report progress
  let results: ScrapedNetlinkData[] = [];
  let totalPages: number | undefined;

  try {
    // Fetch page based on day of month
    logger.log(`Fetching page ${dayOfMonth} with limit 200...`);
    const response = await netlinkService.fetchPage(dayOfMonth, 200);
    const netlinks = response.data;
    totalPages = response.pagination.totalPages;

    logger.log(`Fetched ${netlinks.length} netlinks (Page ${dayOfMonth}/${totalPages}). Starting scraping...`);

    // Scrape them
    results = await scraperService.scrapeNetlinks(netlinks, {
      concurrency: 3,
      timeout: 30000,
      retries: 2,
      delay: 500,
      onProgress: (current, total, url) => {
        if (current % 20 === 0 || current === total) {
          logger.log(`Progress: ${current}/${total}`);
        }
      },
    });

    // Post all results to API
    const successCount = results.filter(r => r.success).length;
    await scraperService.postBatchResults(results);

    logger.log(`Netlink scraper completed - Page: ${dayOfMonth}, Total: ${results.length}, Success: ${successCount}, Failed: ${results.length - successCount}`);

    await run.finish({
      ...netlinkOutcome(results),
      details: { page: dayOfMonth, total_pages: totalPages, fetched: netlinks.length },
    });
  } catch (error) {
    logger.error('Netlink scraper job failed:', error.message);
    await run.fail(error, {
      ...netlinkOutcome(results),
      details: { page: dayOfMonth, total_pages: totalPages },
    });
  } finally {
    await app.close();
  }
}

function netlinkOutcome(results: ScrapedNetlinkData[]) {
  return {
    successCount: results.filter(r => r.success).length,
    failed: results
      .filter(r => !r.success)
      .map(r => ({ url: r.url, reason: r.error || 'unknown error' })),
  };
}

/**
 * Run the DomDetailer cron job - processes ALL netlinks with pagination
 */
async function runDomDetailerJob() {
  logger.log('Starting scheduled DomDetailer job (processing all netlinks)...');

  const app = await NestFactory.createApplicationContext(AppModule);
  const domDetailerService = app.get(DomDetailerService);
  const netlinkService = app.get(NetlinkService);
  const dashboardClient = app.get(DashboardHttpClient);
  const reporter = app.get(ScrapingRunReporterService);
  const dashboardBaseUrl = app.get(ConfigService).get<string>('DASHBOARD_BASE_URL', '');

  const BATCH_SIZE = 100;
  const CONCURRENCY = 3;
  const DELAY = 500;

  const run = reporter.start('domdetailer', `${dashboardBaseUrl}/netlink/all/paginated (all pages)`);

  let currentPage = 1;
  let totalProcessed = 0;
  let totalSuccess = 0;
  let totalFailed = 0;
  const failures: Array<{ url: string; reason: string }> = [];
  const startTime = Date.now();

  try {
    // Get first page to know total
    const firstPage = await netlinkService.fetchPage(1, BATCH_SIZE);
    const totalPages = firstPage.pagination.totalPages;
    const totalItems = firstPage.pagination.totalItems;

    logger.log(`Total netlinks: ${totalItems}, Pages: ${totalPages}`);

    let hasNextPage = true;
    let pageData = firstPage;

    while (hasNextPage) {
      logger.log(`Processing page ${currentPage}/${totalPages}...`);

      if (currentPage > 1) {
        pageData = await netlinkService.fetchPage(currentPage, BATCH_SIZE);
      }

      // Extract url_bought with netlinkId
      const urlBoughtMap = new Map<string, number>();
      for (const netlink of pageData.data) {
        if (netlink.url_bought && !urlBoughtMap.has(netlink.url_bought)) {
          urlBoughtMap.set(netlink.url_bought, netlink.id);
        }
      }

      const urls = Array.from(urlBoughtMap.keys());

      if (urls.length === 0) {
        hasNextPage = pageData.pagination.hasNextPage;
        currentPage++;
        continue;
      }

      // Run DomDetailer checks
      const results = await domDetailerService.checkDomainsBatchConcurrent(urls, CONCURRENCY, DELAY);

      // Prepare items for API
      const items = results
        .map(result => {
          const netlinkId = urlBoughtMap.get(result.url);
          if (!netlinkId) return null;
          return {
            netlink_id: netlinkId,
            domdetailers: JSON.stringify({
              url: result.url,
              success: result.success,
              checkedAt: result.checkedAt,
              ...(result.success && result.data ? { data: result.data } : {}),
              ...(result.error ? { error: result.error } : {}),
            }),
          };
        })
        .filter(item => item !== null);

      // Post to API
      if (items.length > 0) {
        await dashboardClient.post('/netlink/additionalInfo/upsert', { items });
      }

      const pageSuccess = results.filter(r => r.success).length;
      totalProcessed += results.length;
      totalSuccess += pageSuccess;
      totalFailed += results.length - pageSuccess;
      for (const r of results) {
        if (!r.success) failures.push({ url: r.url, reason: r.error || 'unknown error' });
      }

      logger.log(`Page ${currentPage} done: ${pageSuccess}/${results.length} success. Total: ${totalProcessed}/${totalItems}`);

      hasNextPage = pageData.pagination.hasNextPage;
      currentPage++;
    }

    const duration = (Date.now() - startTime) / 1000 / 60;
    logger.log(`DomDetailer completed - Total: ${totalProcessed}, Success: ${totalSuccess}, Failed: ${totalFailed}, Duration: ${duration.toFixed(2)} minutes`);

    await run.finish({
      successCount: totalSuccess,
      failed: failures,
      details: { pages: currentPage - 1, processed: totalProcessed },
    });
  } catch (error) {
    logger.error('DomDetailer job failed:', error.message);
    await run.fail(error, {
      successCount: totalSuccess,
      failed: failures,
      details: { pages_completed: currentPage - 1, processed: totalProcessed },
    });
  } finally {
    await app.close();
  }
}

/**
 * Check if today is the last day of the month
 */
function isLastDayOfMonth(): boolean {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow.getDate() === 1;
}

/**
 * Initialize cron jobs
 */
function initCronJobs() {
  // Run netlink scraper every day at 11 PM (23:00)
  cron.schedule('0 23 * * *', () => {
    logger.log('Cron triggered: Running netlink scraper at 11 PM');
    runNetlinkScraperJob();
  });

  // Run DomDetailer on last day of month at 11 PM
  // Schedule runs on 28-31, but only executes if it's actually the last day
  cron.schedule('0 23 28-31 * *', () => {
    if (isLastDayOfMonth()) {
      logger.log('Cron triggered: Running DomDetailer on last day of month at 11 PM');
      runDomDetailerJob();
    }
  });

  logger.log('Cron jobs initialized:');
  logger.log('  - Netlink scraper: Daily at 11 PM');
  logger.log('  - DomDetailer: Last day of month at 11 PM');
}

/**
 * Test netlink scraper with sample size
 */
async function testNetlinkScraper(sampleSize: number = 5) {
  logger.log(`Testing netlink scraper with ${sampleSize} samples...`);

  const app = await NestFactory.createApplicationContext(AppModule);
  const scraperService = app.get(NetlinkScraperService);
  const netlinkService = app.get(NetlinkService);

  try {
    const response = await netlinkService.fetchPage(1, sampleSize);
    const netlinks = response.data;

    logger.log(`Fetched ${netlinks.length} netlinks. Scraping...`);

    const results = await scraperService.scrapeNetlinks(netlinks, {
      concurrency: 2,
      timeout: 30000,
      retries: 1,
      delay: 500,
    });

    const successCount = results.filter(r => r.success).length;
    logger.log(`Test complete - Total: ${results.length}, Success: ${successCount}, Failed: ${results.length - successCount}`);

    // Show results
    results.forEach((r, i) => {
      logger.log(`  ${i + 1}. ${r.url} - ${r.success ? 'SUCCESS' : 'FAILED: ' + r.error}`);
    });

    return results;
  } finally {
    await app.close();
  }
}

/**
 * Test DomDetailer with sample size
 */
async function testDomDetailer(sampleSize: number = 5) {
  logger.log(`Testing DomDetailer with ${sampleSize} samples...`);

  const app = await NestFactory.createApplicationContext(AppModule);
  const domDetailerService = app.get(DomDetailerService);
  const netlinkService = app.get(NetlinkService);

  try {
    const response = await netlinkService.fetchPage(1, sampleSize);
    const netlinks = response.data;

    const urlBoughtMap = new Map<string, number>();
    for (const netlink of netlinks) {
      if (netlink.url_bought && !urlBoughtMap.has(netlink.url_bought)) {
        urlBoughtMap.set(netlink.url_bought, netlink.id);
      }
    }

    const urls = Array.from(urlBoughtMap.keys());
    logger.log(`Found ${urls.length} unique url_bought. Running DomDetailer...`);

    const results = await domDetailerService.checkDomainsBatchConcurrent(urls, 2, 500);

    const successCount = results.filter(r => r.success).length;
    logger.log(`Test complete - Total: ${results.length}, Success: ${successCount}, Failed: ${results.length - successCount}`);

    // Show results
    results.forEach((r, i) => {
      if (r.success) {
        logger.log(`  ${i + 1}. ${r.url} - DA: ${r.data?.domainAuthority || 'N/A'}, PA: ${r.data?.pageAuthority || 'N/A'}`);
      } else {
        logger.log(`  ${i + 1}. ${r.url} - FAILED: ${r.error}`);
      }
    });

    return results;
  } finally {
    await app.close();
  }
}

// Only bootstrap if run directly (not imported)
if (require.main === module) {
  const command = process.argv[2];

  if (command === 'test') {
    // Run both tests
    (async () => {
      console.log('\n' + '='.repeat(60));
      console.log('TESTING CRON JOBS (5 samples each)');
      console.log('='.repeat(60) + '\n');

      console.log('--- TEST 1: NETLINK SCRAPER ---\n');
      await testNetlinkScraper(5);

      console.log('\n--- TEST 2: DOMDETAILER ---\n');
      await testDomDetailer(5);

      console.log('\n' + '='.repeat(60));
      console.log('ALL TESTS COMPLETE');
      console.log('='.repeat(60) + '\n');
    })().catch(console.error);
  } else {
    // Normal production mode
    bootstrap()
      .then((app) => {
        console.log('Application ready. Initializing cron jobs...');
        initCronJobs();
        console.log('Cron jobs running. Press Ctrl+C to exit.');
      })
      .catch((error) => {
        console.error('Application failed to start:', error);
        process.exit(1);
      });
  }
}

export { bootstrap, testNetlinkScraper, testDomDetailer };
