import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { NetlinkScraperService } from '../modules/paperclub/services/netlink-scraper.service';
import { LightpandaService } from '../common/lightpanda.service';
import { DashboardHttpClient } from '../common/dashboard-http-client.service';
import {
  PageLink,
  normalizeUrl,
  classifyLink,
  linkTypeFromRel,
  pickBestLink,
  isRedirectToHomepage,
  anchorsFromScripts,
} from '../modules/paperclub/services/link-matching';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Test script for debugging a single netlink scraping issue
 *
 * This script helps you debug why link matching might have failed by:
 * 1. Scraping the specific URL
 * 2. Showing all links found on the page
 * 3. Showing detailed matching logic for each link
 * 4. Helping identify why the landing page link wasn't found
 *
 * Usage:
 *   npm run test:single-netlink <url> <landing_page>
 *
 * Example:
 *   npm run test:single-netlink "https://ilbi.org/marche-immobilier-a-paris-6eme/" "https://www.district-immo.com/agences/saint-germain/"
 */
async function testSingleNetlink() {
  console.log('='.repeat(80));
  console.log('DEBUG SINGLE NETLINK SCRAPING');
  console.log('='.repeat(80));

  // Get URL, landing page, and optional netlink_id from command line
  const url = process.argv[2];
  const landingPage = process.argv[3];
  const netlinkId = process.argv[4] ? parseInt(process.argv[4], 10) : null;

  if (!url || !landingPage) {
    console.error('\n❌ Error: Both URL and landing page are required');
    console.log('\nUsage:');
    console.log('  npm run test:single-netlink <url> <landing_page> [netlink_id]');
    console.log('\nExample:');
    console.log('  npm run test:single-netlink "https://ilbi.org/marche-immobilier-a-paris-6eme/" "https://www.district-immo.com/agences/saint-germain/" 123');
    console.log('\nNote: If netlink_id is provided, results will be sent to the API');
    process.exit(1);
  }

  console.log(`\nURL to scrape: ${url}`);
  console.log(`Landing page to find: ${landingPage}`);
  if (netlinkId) {
    console.log(`Netlink ID: ${netlinkId}`);
  }
  console.log('');

  const app = await NestFactory.createApplicationContext(AppModule);
  const lightpandaService = app.get(LightpandaService);
  const dashboardClient = app.get(DashboardHttpClient);

  try {
    console.log('Starting browser and navigating to URL...\n');

    await lightpandaService.withPage(async (page) => {
      // Navigate to the page
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      const statusCode = response?.status();
      const finalUrl = page.url();
      console.log('✓ Page loaded successfully');
      console.log(`✓ HTTP Status Code: ${statusCode}`);
      console.log(`✓ Final URL: ${finalUrl}\n`);

      // Wait for body
      await page.waitForSelector('body', { timeout: 5000 });

      // Get and save page source
      const pageSource = await page.content();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logsDir = path.join(process.cwd(), 'logs', 'page-sources');
      await fs.mkdir(logsDir, { recursive: true });

      const sourceFilePath = path.join(logsDir, `page-source-${timestamp}.html`);
      await fs.writeFile(sourceFilePath, pageSource, 'utf-8');

      console.log(`✓ Page source saved to: ${sourceFilePath}\n`);

      // Get all links with detailed information
      const linksData: Array<PageLink & { index: number; class: string; id: string }> = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a'));
        return links.map((link, index) => ({
          index: index + 1,
          href: link.href,
          text: link.textContent?.trim() || '',
          rel: link.getAttribute('rel') || '',
          class: link.className || '',
          id: link.id || '',
          outerHTML: link.outerHTML.substring(0, 200), // First 200 chars
        }));
      });

      // Anchors inside inline scripts (paywalled article bodies), as the cron reads them
      const scripts = await page.evaluate(() =>
        Array.from(document.querySelectorAll('script:not([src])'))
          .map(s => s.textContent || '')
          .filter(t => /href/i.test(t)),
      );
      const scriptLinks = anchorsFromScripts(scripts, finalUrl);
      linksData.push(
        ...scriptLinks.map((link, i) => ({
          ...link,
          index: linksData.length + i + 1,
          class: '',
          id: '',
          outerHTML: link.outerHTML.substring(0, 200),
        })),
      );

      console.log(`\n✓ Found ${linksData.length - scriptLinks.length} links on the page (+${scriptLinks.length} in page data)`);

      // Save all links to JSON file for easier analysis
      const linksFilePath = path.join(logsDir, `links-${timestamp}.json`);
      await fs.writeFile(linksFilePath, JSON.stringify({
        url,
        landingPage,
        scrapedAt: new Date().toISOString(),
        totalLinks: linksData.length,
        links: linksData,
      }, null, 2), 'utf-8');
      console.log(`✓ All links saved to: ${linksFilePath}`);

      console.log('\n');

      // Same rules as the cron scraper (link-matching.ts)
      const clientLinks = linksData
        .map(link => ({ link, kind: classifyLink(link.href, landingPage) }))
        .filter(({ kind }) => kind !== null);

      if (clientLinks.length > 0) {
        console.log('='.repeat(80));
        console.log(`FOUND ${clientLinks.length} LINK(S) TO THE CLIENT`);
        console.log('='.repeat(80));
        clientLinks.forEach(({ link, kind }, idx) => {
          console.log(`\n${idx + 1}. HREF: ${link.href}`);
          console.log(`   TEXT: ${link.text.substring(0, 100)}${link.text.length > 100 ? '...' : ''}`);
          console.log(`   MATCH: ${kind === 'target' ? 'target page' : 'other client page'}`);
          console.log(`   LINK TYPE: ${linkTypeFromRel(link.rel)}`);
          console.log(`   REL: ${link.rel || 'none'}`);
          if (link.source === 'json') console.log('   FOUND IN: page data (script)');
        });
        console.log('\n');
      }

      const best = pickBestLink(linksData, landingPage);
      const matchFound = best?.kind === 'target';
      const redirectedToHomepage = isRedirectToHomepage(url, finalUrl);

      console.log('='.repeat(80));
      if (redirectedToHomepage) {
        console.log(`✗ ARTICLE REDIRECTED TO THE HOMEPAGE (${finalUrl})`);
      } else if (matchFound) {
        console.log('✓ LINK TO THE TARGET PAGE FOUND');
      } else if (best) {
        console.log(`~ LINK TO ANOTHER CLIENT PAGE ONLY: ${best.link.href}`);
      } else {
        console.log('✗ NO LINK TO THE CLIENT FOUND ON PAGE');
        console.log('\nPossible reasons:');
        console.log('  1. The link might be loaded dynamically with JavaScript');
        console.log('  2. The link might be in an iframe');
        console.log('  3. The landing page URL format might be different than expected');
        console.log('  4. The link might be hidden or not rendered');
      }
      console.log('='.repeat(80));

      // Show what would be sent to API
      console.log('\n');
      console.log('='.repeat(80));
      console.log('API PAYLOAD (what would be sent to /netlink/additionalInfo/upsert)');
      console.log('='.repeat(80));

      // Determine online_status (same order as NetlinkScraperService)
      let onlineStatus: number;
      const linkType = best && !redirectedToHomepage ? linkTypeFromRel(best.link.rel) : 'unknown';

      if (redirectedToHomepage) {
        onlineStatus = 2;
      } else if (matchFound) {
        onlineStatus = 1;
      } else if (best) {
        onlineStatus = 4;
      } else if (statusCode === 404 || statusCode === 410) {
        onlineStatus = 2;
      } else if (statusCode === undefined || statusCode >= 400) {
        onlineStatus = 3;
      } else {
        onlineStatus = 2;
      }

      const apiPayload = {
        netlink_id: netlinkId || 'NETLINK_ID',
        link_type: linkType,
        online_status: onlineStatus,
        status_code: statusCode,
      };

      console.log(JSON.stringify(apiPayload, null, 2));
      console.log('\nOnline Status Legend:');
      console.log('  1 = Exact link found & accessible');
      console.log('  2 = No matching link found');
      console.log('  3 = Site not accessible/offline');
      console.log('  4 = Domain found but not exact URL');
      console.log('='.repeat(80));

      // Send to API if netlink_id is provided
      if (netlinkId) {
        console.log('\n');
        console.log('='.repeat(80));
        console.log('SENDING TO API');
        console.log('='.repeat(80));

        try {
          const requestBody = {
            items: [
              {
                netlink_id: netlinkId,
                link_type: linkType,
                online_status: onlineStatus,
                status_code: statusCode,
              }
            ]
          };

          console.log('\nPosting to /netlink/additionalInfo/upsert...');
          const response = await dashboardClient.post(
            '/netlink/additionalInfo/upsert',
            requestBody
          );

          console.log('✅ Successfully sent to API');
          console.log('\nAPI Response:');
          console.log(JSON.stringify(response, null, 2));
        } catch (error) {
          console.error('❌ Failed to send to API:', error.message);
          if (error.response) {
            console.error('Response data:', JSON.stringify(error.response.data, null, 2));
          }
        }
        console.log('='.repeat(80));
      } else {
        console.log('\n💡 Tip: Provide a netlink_id as third argument to send results to API');
      }

      // Save test summary
      const summaryFilePath = path.join(logsDir, `summary-${timestamp}.json`);
      await fs.writeFile(summaryFilePath, JSON.stringify({
        testUrl: url,
        landingPage,
        testedAt: new Date().toISOString(),
        matchFound,
        totalLinksFound: linksData.length,
        normalizedLandingPage: normalizeUrl(landingPage),
        files: {
          pageSource: sourceFilePath,
          allLinks: linksFilePath,
          summary: summaryFilePath,
        },
      }, null, 2), 'utf-8');

      console.log(`\n✓ Test summary saved to: ${summaryFilePath}`);
    });

    console.log('\n✓ Test completed successfully');

  } catch (error) {
    console.error('\n✗ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await app.close();
  }
}

// Run the test
if (require.main === module) {
  testSingleNetlink().catch(console.error);
}

export { testSingleNetlink };
