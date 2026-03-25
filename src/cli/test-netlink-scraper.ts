import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { NetlinkScraperService } from '../modules/paperclub/services/netlink-scraper.service';
import { NetlinkService } from '../modules/paperclub/services/netlink.service';
import * as fs from 'fs/promises';
import * as path from 'path';

// Global handler for CDP errors from playwright-extra stealth plugin
// These errors occur during page/context cleanup and are safe to suppress
process.on('unhandledRejection', (reason: any) => {
  const message = reason?.message || String(reason);

  if (
    message?.includes('cdpSession') ||
    message?.includes('Target page, context or browser has been closed') ||
    message?.includes('Session closed')
  ) {
    console.log('[Suppressed CDP cleanup error]');
    return;
  }

  throw reason;
});

/**
 * Test script for Netlink Scraper Service
 *
 * This script demonstrates:
 * 1. Testing scraping on sample URLs
 * 2. Scraping with progress tracking
 * 3. Batch scraping
 * 4. Saving results to file
 */
async function testNetlinkScraper() {
  console.log('='.repeat(60));
  console.log('TESTING NETLINK SCRAPER SERVICE');
  console.log('='.repeat(60));

  const app = await NestFactory.createApplicationContext(AppModule);
  const scraperService = app.get(NetlinkScraperService);
  const netlinkService = app.get(NetlinkService);

  const BATCH_SIZE = 200; // Fetch 200 netlinks per batch
  let currentPage = 1;
  let hasNextPage = true;
  let totalProcessed = 0;
  let totalSuccess = 0;
  let totalFailed = 0;

  try {
    while (hasNextPage) {
      // 1. Fetch batch of 200 netlinks
      console.log(`\n${'='.repeat(60)}`);
      console.log(`BATCH ${currentPage}: Fetching ${BATCH_SIZE} netlinks (page ${currentPage})...`);
      console.log('='.repeat(60));

      const response = await netlinkService.fetchPage(currentPage, BATCH_SIZE);
      const netlinks = response.data;
      const pagination = response.pagination;

      console.log(`✓ Fetched ${netlinks.length} netlinks`);
      console.log(`  Page: ${pagination.currentPage}/${pagination.totalPages}`);
      console.log(`  Total items: ${pagination.totalItems}`);
      console.log(`  Has next page: ${pagination.hasNextPage}`);

      if (netlinks.length === 0) {
        console.log('No more netlinks to process.');
        break;
      }

      // 2. Scrape all netlinks in this batch
      console.log(`\nScraping ${netlinks.length} netlinks...`);

      let results;
      try {
        const scrapePromise = scraperService.scrapeNetlinks(netlinks, {
          concurrency: 3,
          timeout: 30000,
          retries: 2,
          delay: 500,
          skipErrors: true,
          enableDomDetailer: false,
          onProgress: (current, total, url) => {
            const percentage = ((current / total) * 100).toFixed(1);
            process.stdout.write(
              `\r   Progress: ${percentage}% (${current}/${total}) - ${url.slice(0, 50)}...`
            );
          },
        });

        // Add a timeout wrapper (10 minutes per batch)
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Batch scraping timed out after 10 minutes')), 10 * 60 * 1000);
        });

        results = await Promise.race([scrapePromise, timeoutPromise]);
        console.log('\n✓ Batch scraping completed!');
      } catch (error) {
        console.error('\n✗ Batch scraping failed:', error.message);
        // Continue to next batch even if this one fails
        hasNextPage = pagination.hasNextPage;
        currentPage++;
        continue;
      }

      // 3. Show batch results
      const successCount = results.filter(r => r.success).length;
      const failedCount = results.filter(r => !r.success).length;
      totalProcessed += results.length;
      totalSuccess += successCount;
      totalFailed += failedCount;

      console.log(`\nBatch ${currentPage} Results:`);
      console.log(`  Total: ${results.length}`);
      console.log(`  ✓ Successful: ${successCount}`);
      console.log(`  ✗ Failed: ${failedCount}`);

      // 4. Post batch results to API
      console.log(`\nPosting batch ${currentPage} to API...`);
      try {
        await scraperService.postBatchResults(results);
        console.log('✓ Batch upsert completed successfully');
      } catch (error) {
        console.error('✗ Batch upsert failed:', error.message);
      }

      // 5. Check if there's more data
      hasNextPage = pagination.hasNextPage;
      currentPage++;

      if (hasNextPage) {
        console.log(`\n→ Moving to next batch (page ${currentPage})...`);
      }
    }

    // Final summary
    console.log('\n' + '='.repeat(60));
    console.log('ALL BATCHES COMPLETE');
    console.log('='.repeat(60));
    console.log(`Total processed: ${totalProcessed}`);
    console.log(`Total successful: ${totalSuccess}`);
    console.log(`Total failed: ${totalFailed}`);
    console.log(`Success rate: ${totalProcessed > 0 ? ((totalSuccess / totalProcessed) * 100).toFixed(1) : 0}%`);
    console.log('='.repeat(60));

  } catch (error) {
    console.error('\n✗ Test failed:', error.message);
    console.error(error.stack);
    await app.close();
    process.exit(1);
  }

  // Force exit after closing app
  await app.close();
  console.log('\n✓ Application closed. Exiting...');
  process.exit(0);
}

/**
 * Example: Batch scraping with file output
 */
async function exampleBatchScraping() {
  console.log('\n' + '='.repeat(60));
  console.log('EXAMPLE: BATCH SCRAPING');
  console.log('='.repeat(60));

  const app = await NestFactory.createApplicationContext(AppModule);
  const scraperService = app.get(NetlinkScraperService);

  try {
    const outputDir = path.join(process.cwd(), 'scraped-data');
    await fs.mkdir(outputDir, { recursive: true });

    console.log(`\nOutput directory: ${outputDir}\n`);

    const stats = await scraperService.scrapeInBatches(
      10, // batch size
      async (results, batchNumber) => {
        // Save each batch to a separate file
        const filename = `batch-${batchNumber}.json`;
        const filepath = path.join(outputDir, filename);

        await fs.writeFile(filepath, JSON.stringify(results, null, 2));

        const successCount = results.filter(r => r.success).length;
        console.log(`   Saved ${filename}: ${successCount}/${results.length} successful`);

        // Post batch results to API
        try {
          await scraperService.postBatchResults(results);
          console.log(`   ✓ Posted batch ${batchNumber} to API`);
        } catch (error) {
          console.error(`   ✗ Failed to post batch ${batchNumber}: ${error.message}`);
        }
      },
      {
        concurrency: 2,
        timeout: 30000,
        retries: 2,
        delay: 500,
      }
    );

    console.log('\n' + '='.repeat(60));
    console.log('BATCH SCRAPING STATS');
    console.log('='.repeat(60));
    console.log(`Total scraped: ${stats.total}`);
    console.log(`Successful: ${stats.successful}`);
    console.log(`Failed: ${stats.failed}`);
    console.log(`Duration: ${(stats.duration / 1000).toFixed(2)}s`);
    console.log(`Success rate: ${((stats.successful / stats.total) * 100).toFixed(1)}%`);
    console.log('='.repeat(60));

  } catch (error) {
    console.error('Batch scraping failed:', error.message);
  } finally {
    await app.close();
  }
}

/**
 * Example: Scrape and save to single file
 */
async function exampleScrapeAndSave() {
  console.log('\n' + '='.repeat(60));
  console.log('EXAMPLE: SCRAPE ALL AND SAVE');
  console.log('='.repeat(60));

  const app = await NestFactory.createApplicationContext(AppModule);
  const scraperService = app.get(NetlinkScraperService);

  try {
    const allResults: any[] = [];

    console.log('\nStarting full scrape...\n');

    const stats = await scraperService.scrapeAllNetlinks({
      concurrency: 3,
      timeout: 30000,
      retries: 2,
      delay: 500,
      onProgress: (current, total, url) => {
        const percentage = ((current / total) * 100).toFixed(1);
        process.stdout.write(
          `\r   Progress: ${percentage}% (${current}/${total}) - ${url.slice(0, 50)}...`
        );
      },
      onSuccess: (data) => {
        allResults.push(data);
      },
    });

    console.log('\n\nSaving results...');

    // Save all results to file
    const outputDir = path.join(process.cwd(), 'scraped-data');
    await fs.mkdir(outputDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
    const filename = `netlinks-scraped-${timestamp}.json`;
    const filepath = path.join(outputDir, filename);

    await fs.writeFile(filepath, JSON.stringify(allResults, null, 2));

    console.log(`✓ Saved to: ${filepath}`);
    console.log('\nStats:');
    console.log(`  Total: ${stats.total}`);
    console.log(`  Successful: ${stats.successful}`);
    console.log(`  Failed: ${stats.failed}`);
    console.log(`  Duration: ${(stats.duration / 1000 / 60).toFixed(2)} minutes`);

  } catch (error) {
    console.error('Scraping failed:', error.message);
  } finally {
    await app.close();
  }
}

/**
 * Show scraping examples and patterns
 */
function showScrapingExamples() {
  console.log('\n' + '='.repeat(60));
  console.log('SCRAPING IMPLEMENTATION EXAMPLES');
  console.log('='.repeat(60));

  const examples = `
// In netlink-scraper.service.ts, implement extractData():

// Example 1: Basic content extraction
private async extractData(page: Page, url: string) {
  const title = await page.title();
  const heading = await page.locator('h1').first().textContent();
  const description = await page.locator('meta[name="description"]').getAttribute('content');

  return {
    title,
    heading,
    description,
  };
}

// Example 2: List extraction
private async extractData(page: Page, url: string) {
  const links = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a')).map(a => ({
      text: a.textContent?.trim(),
      href: a.href,
    }));
  });

  return { links };
}

// Example 3: Complex structured data
private async extractData(page: Page, url: string) {
  // Wait for specific content
  await page.waitForSelector('.content', { timeout: 5000 });

  const data = await page.evaluate(() => {
    return {
      title: document.querySelector('h1')?.textContent?.trim(),
      author: document.querySelector('.author')?.textContent?.trim(),
      date: document.querySelector('.date')?.textContent?.trim(),
      content: document.querySelector('.main-content')?.textContent?.trim(),
      images: Array.from(document.querySelectorAll('img')).map(img => img.src),
      tags: Array.from(document.querySelectorAll('.tag')).map(tag => tag.textContent?.trim()),
    };
  });

  return data;
}

// Example 4: Handle dynamic content
private async extractData(page: Page, url: string) {
  // Wait for dynamic content to load
  await page.waitForSelector('.dynamic-content', { timeout: 10000 });

  // Scroll to load lazy images
  await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
  });

  await page.waitForTimeout(2000); // Wait for images to load

  const data = await page.evaluate(() => {
    return {
      // Your extraction logic
    };
  });

  return data;
}

// Example 5: Form interaction
private async extractData(page: Page, url: string) {
  // Fill form
  await page.locator('input[name="search"]').fill('query');
  await page.click('button[type="submit"]');

  // Wait for results
  await page.waitForSelector('.results');

  const results = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.result')).map(result => ({
      title: result.querySelector('h3')?.textContent,
      link: result.querySelector('a')?.href,
    }));
  });

  return { results };
}

// Example 6: Screenshot capture
private async extractData(page: Page, url: string) {
  const screenshot = await page.screenshot({
    type: 'png',
    fullPage: true
  });

  // Convert to base64 or save to file
  const screenshotBase64 = screenshot.toString('base64');

  return {
    hasScreenshot: true,
    screenshot: screenshotBase64, // or save path
  };
}

// Example 7: Error handling in extraction
private async extractData(page: Page, url: string) {
  try {
    // Try primary selector
    const content = await page.locator('.main-content').textContent();
    return { content };
  } catch (error) {
    // Fallback to alternative selector
    try {
      const content = await page.locator('#content').textContent();
      return { content };
    } catch (fallbackError) {
      return {
        content: null,
        extractionError: 'Content selector not found'
      };
    }
  }
}
`;

  console.log(examples);
}

/**
 * Show usage patterns
 */
function showUsagePatterns() {
  console.log('\n' + '='.repeat(60));
  console.log('SERVICE USAGE PATTERNS');
  console.log('='.repeat(60));

  const patterns = `
// 1. Scrape single URL
const result = await scraperService.scrapeNetlink('https://example.com');

// 2. Scrape with custom options
const result = await scraperService.scrapeNetlink('https://example.com', {
  timeout: 60000,
  retries: 5
});

// 3. Scrape multiple netlinks
const netlinks = [{ url: 'https://example.com' }, { url: 'https://test.com' }];
const results = await scraperService.scrapeNetlinks(netlinks, {
  concurrency: 5,
  timeout: 30000,
  delay: 1000
});

// 4. Scrape all netlinks with progress
await scraperService.scrapeAllNetlinks({
  concurrency: 3,
  onProgress: (current, total, url) => {
    console.log(\`\${current}/\${total}: \${url}\`);
  },
  onSuccess: async (data) => {
    await saveToDatabase(data);
  }
});

// 5. Memory-efficient batch processing
await scraperService.scrapeInBatches(
  20, // batch size
  async (results, batchNum) => {
    await processAndSaveBatch(results, batchNum);
  },
  { concurrency: 2 }
);

// 6. Test before full scrape
const testResults = await scraperService.testScraping(10);
console.log('Test successful:', testResults.filter(r => r.success).length);
`;

  console.log(patterns);
}

// Run based on command
if (require.main === module) {
  const command = process.argv[2];

  switch (command) {
    case 'sample':
    case 'test':
      testNetlinkScraper().catch(console.error);
      break;
    case 'batch':
      exampleBatchScraping().catch(console.error);
      break;
    case 'save':
      exampleScrapeAndSave().catch(console.error);
      break;
    case 'examples':
      showScrapingExamples();
      break;
    case 'patterns':
      showUsagePatterns();
      break;
    default:
      testNetlinkScraper().catch(console.error);
  }
}

export { testNetlinkScraper };
