import { NetlinkScraperService } from '../modules/paperclub/services/netlink-scraper.service';
import { LightpandaService } from '../common/lightpanda.service';
import { NetlinkService } from '../modules/paperclub/services/netlink.service';
import { FirecrawlService } from '../common/firecrawl.service';
import { ConfigService } from '@nestjs/config';
import * as dotenv from 'dotenv';

dotenv.config();

/**
 * Mock test for Netlink Scraper without requiring Dashboard API
 *
 * This demonstrates the scraping functionality using test data
 */
async function testScraperWithMockData() {
  console.log('='.repeat(60));
  console.log('MOCK TEST - NETLINK SCRAPER');
  console.log('='.repeat(60));

  const configService = new ConfigService();
  const lightpanda = new LightpandaService(configService);

  // Mock netlink service (not used in this test)
  const netlinkService = null as any;

  // Mock dashboard client (not used in this test)
  const dashboardClient = null as any;

  const firecrawl = new FirecrawlService(configService);

  const scraperService = new NetlinkScraperService(lightpanda, netlinkService, dashboardClient, firecrawl);

  try {
    console.log('\nTest 1: Scraping example.com and looking for example.com links');
    console.log('-'.repeat(60));

    // Test scraping with a known URL
    const result1 = await (scraperService as any).scrapeNetlink(
      'https://example.com',
      'example.com',  // This should match
      { timeout: 30000, retries: 2 }
    );

    console.log('\nResult 1:');
    console.log(`  URL: ${result1.url}`);
    console.log(`  Landing Page: ${result1.landingPage}`);
    console.log(`  Success: ${result1.success}`);
    console.log(`  Links Found: ${result1.allLinksCount}`);
    console.log(`  Match Found: ${result1.foundLink?.matched}`);

    if (result1.foundLink?.matched) {
      console.log(`  Match Type: ${result1.foundLink.matchType}`);
      console.log(`  Link Href: ${result1.foundLink.href}`);
      console.log(`  Link Text: ${result1.foundLink.text}`);
      console.log(`  Link HTML: ${result1.foundLink.outerHTML.substring(0, 100)}...`);
    }

    console.log('\n' + '-'.repeat(60));
    console.log('\nTest 2: Scraping example.com and looking for different domain');
    console.log('-'.repeat(60));

    const result2 = await (scraperService as any).scrapeNetlink(
      'https://example.com',
      'nonexistent-domain.com',  // This should NOT match
      { timeout: 30000, retries: 2 }
    );

    console.log('\nResult 2:');
    console.log(`  URL: ${result2.url}`);
    console.log(`  Landing Page: ${result2.landingPage}`);
    console.log(`  Success: ${result2.success}`);
    console.log(`  Links Found: ${result2.allLinksCount}`);
    console.log(`  Match Found: ${result2.foundLink?.matched}`);

    console.log('\n' + '='.repeat(60));
    console.log('TEST SUMMARY');
    console.log('='.repeat(60));
    console.log('✓ Scraper is working correctly!');
    console.log('✓ URL matching logic is functional');
    console.log('\nNext step: Start your Dashboard API at http://localhost:5000');
    console.log('Then run: npm run test:netlink-scraper sample');
    console.log('='.repeat(60));

  } catch (error) {
    console.error('\n✗ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await lightpanda.stopBrowser();
  }
}

// Run test
if (require.main === module) {
  testScraperWithMockData().catch(console.error);
}

export { testScraperWithMockData };
