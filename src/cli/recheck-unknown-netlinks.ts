#!/usr/bin/env node

/**
 * Re-check netlinks whose stored link state is "unknown".
 *
 * "unknown" means the last scrape never managed to read the link, not that the
 * link is nofollow — so after a scraper fix the same URLs are worth another
 * pass to see how many were only unreadable by the old code.
 *
 * Usage:
 *   npm run recheck:unknown                 # re-check all, post results
 *   npm run recheck:unknown -- --limit 50   # sample the first 50
 *   npm run recheck:unknown -- --dry-run    # scrape but do not post
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import {
  NetlinkScraperService,
  ScrapedNetlinkData,
} from '../modules/paperclub/services/netlink-scraper.service';
import { DashboardHttpClient } from '../common/dashboard-http-client.service';
import { ScrapingRunReporterService } from '../common/scraping-run-reporter.service';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
};

async function main() {
  const limit = Number(arg('limit')) || 0;
  const dryRun = process.argv.includes('--dry-run');
  const concurrency = Number(arg('concurrency')) || 3;

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'error', 'warn'],
  });
  const scraper = app.get(NetlinkScraperService);
  const dashboard = app.get(DashboardHttpClient);
  const reporter = app.get(ScrapingRunReporterService);
  const run = dryRun ? null : reporter.start('netlink-recheck-unknown');

  try {
    // One request: the endpoint filters in JS, so a page big enough for the
    // whole set is simpler than paging through a filtered total we cannot
    // trust (its totalItems reflects the page, not the match count).
    const response = await dashboard.post(
      '/netlink/getFilteredNetlinks?page=1&limit=100000',
      { additional_link_type: ['unknown'] },
    );
    let netlinks = response.data ?? [];
    console.log(`Found ${netlinks.length} netlinks with link state "unknown"`);
    if (limit) {
      netlinks = netlinks.slice(0, limit);
      console.log(`--limit ${limit}: re-checking the first ${netlinks.length}`);
    }
    if (netlinks.length === 0) {
      await run?.finish({ successCount: 0 });
      return;
    }

    const started = Date.now();
    const results = await scraper.scrapeNetlinks(netlinks, {
      concurrency,
      timeout: 30000,
      retries: 2,
      delay: 500,
      onProgress: (current: number, total: number) => {
        if (current % 25 === 0 || current === total) {
          const rate = (Date.now() - started) / current / 1000;
          const left = ((total - current) * rate) / 60;
          console.log(`Progress: ${current}/${total} (~${left.toFixed(0)} min left)`);
        }
      },
    });

    if (dryRun) {
      console.log('\n--dry-run: results NOT posted');
    } else {
      await scraper.postBatchResults(results);
      console.log('\nResults posted to the Dashboard');
    }

    summarize(results);
    await run?.finish({
      successCount: results.filter(r => r.success).length,
      failed: results
        .filter(r => !r.success)
        .map(r => ({ url: r.url, reason: r.error || 'unknown error' })),
    });
  } catch (error) {
    console.error('\nRe-check failed:', error.message);
    await run?.fail(error);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

/**
 * Mirror of NetlinkScraperService.transformToAdditionalInfo's link_type rule,
 * so the summary reports what was actually written rather than guessing.
 */
function linkTypeOf(r: ScrapedNetlinkData): string {
  if (r.redirectedToHomepage) return 'unknown';
  if (r.success && r.foundLink?.matched && r.foundLink?.link_type) return r.foundLink.link_type;
  if (r.success && r.domainFound && r.domainFoundLink?.link_type) return r.domainFoundLink.link_type;
  return 'unknown';
}

function summarize(results: ScrapedNetlinkData[]) {
  const counts = new Map<string, number>();
  for (const r of results) {
    const key = linkTypeOf(r);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const resolved = results.length - (counts.get('unknown') ?? 0);

  console.log('\n' + '='.repeat(60));
  console.log(`Re-checked:        ${results.length}  (all were "unknown" before)`);
  console.log(`Now resolved:      ${resolved}`);
  console.log(`Still unknown:     ${counts.get('unknown') ?? 0}`);
  console.log(`Scrape errors:     ${results.filter(r => !r.success).length}`);
  console.log('New link state:');
  for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${n}`);
  }
  console.log('='.repeat(60));
}

if (require.main === module) {
  main();
}
