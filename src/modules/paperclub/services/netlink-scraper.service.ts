import { Injectable, Logger } from '@nestjs/common';
import { LightpandaService } from '../../../common/lightpanda.service';
import { NetlinkService, NetlinkItem } from './netlink.service';
import { DashboardHttpClient } from '../../../common/dashboard-http-client.service';
import { FirecrawlService } from '../../../common/firecrawl.service';
import {
  PageLink,
  pickBestLink,
  linkTypeFromRel,
  isRedirectToHomepage,
  isDeadDomainError,
  anchorsFromScripts,
} from './link-matching';

import type { Page } from 'playwright-core';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Scraped Data Interface
 */
export interface ScrapedNetlinkData {
  url: string;
  netlinkId?: string | number;
  landingPage?: string;
  scrapedAt: string;
  success: boolean;
  error?: string;
  statusCode?: number; // HTTP status code from page response

  // Found link data
  foundLink?: {
    href: string;
    text: string;
    outerHTML: string;
    matched: boolean;
    matchType?: 'exact' | 'domain' | 'subdomain' | 'partial';
    rel?: string;
    link_type?: string;
  };

  // Domain match (found domain but not exact URL)
  domainFound?: boolean;
  domainFoundLink?: {
    href: string;
    text: string;
    rel?: string;
    link_type?: string;
  };

  // All links found (for debugging)
  allLinksCount?: number;

  // Set when our own browser was blocked and the page was retrieved via Firecrawl
  recoveredVia?: 'firecrawl';

  // Address the browser ended on after redirects
  finalUrl?: string;
  // The article URL now lands on the site's homepage: the article was removed
  redirectedToHomepage?: boolean;
  // Our read said "gone" but a second fetch could not confirm it
  unconfirmed?: boolean;


  [key: string]: any;
}

/**
 * Scraping Options Interface
 */
export interface ScrapeOptions {
  concurrency?: number;
  timeout?: number;
  retries?: number;
  delay?: number;
  skipErrors?: boolean;
  enableLogging?: boolean;
  logFilePath?: string;
  enableDomDetailer?: boolean;
  domDetailerConcurrency?: number;
  onProgress?: (current: number, total: number, url: string) => void;
  onSuccess?: (data: ScrapedNetlinkData) => void | Promise<void>;
  onError?: (url: string, error: Error) => void | Promise<void>;
}

/**
 * Scraping Statistics Interface
 */
export interface ScrapingStats {
  total: number;
  successful: number;
  failed: number;
  skipped: number;
  duration: number;
  startTime: Date;
  endTime?: Date;
  errors: Array<{ url: string; error: string }>;
}

/**
 * Netlink Additional Info for Batch Upsert
 */
export interface NetlinkAdditionalInfo {
  netlink_id: number;
  link_type: string; // 'dofollow' | 'nofollow' | 'unknown'
  online_status: number; // 1 = exact link found, 2 = link absent / page or domain gone, 3 = not verified (blocked/unreachable), 4 = domain found but not exact URL
  status_code?: number; // HTTP status code from page response
}

/**
 * Batch Upsert Request Body
 */
export interface BatchUpsertRequest {
  items: NetlinkAdditionalInfo[];
}

/**
 * Netlink Scraper Service
 *
 * Service for scraping individual netlink URLs using Lightpanda browser.
 * Provides infrastructure for:
 * - Scraping individual URLs
 * - Batch scraping with concurrency control
 * - Progress tracking and statistics
 * - Error handling and retries
 * - Data extraction from pages
 *
 * Usage:
 * 1. Implement the extractData() method with your scraping logic
 * 2. Use scrapeNetlink() for single URL
 * 3. Use scrapeAllNetlinks() for batch processing
 */
@Injectable()
export class NetlinkScraperService {
  private readonly logger = new Logger(NetlinkScraperService.name);
  private logFilePath: string | null = null;
  private logBuffer: string[] = [];

  constructor(
    private readonly lightpanda: LightpandaService,
    private readonly netlinkService: NetlinkService,
    private readonly dashboardClient: DashboardHttpClient,
    private readonly firecrawl: FirecrawlService,
  ) {}

  /**
   * Initialize logging to a file
   */
  private async initializeLogging(logFilePath?: string): Promise<void> {
    if (!logFilePath) {
      const logsDir = path.join(process.cwd(), 'logs');
      await fs.mkdir(logsDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      this.logFilePath = path.join(logsDir, `netlink-scraper-${timestamp}.log`);
    } else {
      this.logFilePath = logFilePath;
      const logDir = path.dirname(logFilePath);
      await fs.mkdir(logDir, { recursive: true });
    }

    this.logBuffer = [];
    await this.writeLog('='.repeat(80));
    await this.writeLog(`NETLINK SCRAPER LOG - ${new Date().toISOString()}`);
    await this.writeLog('='.repeat(80));
    this.logger.log(`Logging initialized: ${this.logFilePath}`);
  }

  /**
   * Write a log entry to file
   */
  private async writeLog(message: string): Promise<void> {
    if (!this.logFilePath) return;

    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}\n`;
    this.logBuffer.push(logEntry);

    // Flush buffer if it gets too large (every 10 entries)
    if (this.logBuffer.length >= 10) {
      await this.flushLogs();
    }
  }

  /**
   * Flush log buffer to file
   */
  private async flushLogs(): Promise<void> {
    if (!this.logFilePath || this.logBuffer.length === 0) return;

    try {
      await fs.appendFile(this.logFilePath, this.logBuffer.join(''));
      this.logBuffer = [];
    } catch (error) {
      this.logger.error(`Failed to write logs: ${error.message}`);
    }
  }

  /**
   * Log detailed netlink information
   */
  private async logNetlinkDetails(netlink: NetlinkItem, result: ScrapedNetlinkData): Promise<void> {
    if (!this.logFilePath) return;

    await this.writeLog('');
    await this.writeLog('-'.repeat(80));
    await this.writeLog(`NETLINK ID: ${netlink.id || 'N/A'}`);
    await this.writeLog(`CONTRACT ID: ${netlink.contract_id || 'N/A'}`);
    await this.writeLog(`URL: ${result.url}`);
    await this.writeLog(`LANDING PAGE: ${result.landingPage || 'N/A'}`);
    await this.writeLog(`STATUS: ${result.success ? 'SUCCESS' : 'FAILED'}`);

    if (result.success) {
      await this.writeLog(`ALL LINKS FOUND: ${result.allLinksCount || 0}`);

      if (result.foundLink) {
        await this.writeLog(`LINK MATCHED: ${result.foundLink.matched}`);
        if (result.foundLink.matched) {
          await this.writeLog(`MATCH TYPE: ${result.foundLink.matchType || 'N/A'}`);
          await this.writeLog(`LINK TYPE: ${result.foundLink.link_type || 'unknown'}`);
          await this.writeLog(`LINK HREF: ${result.foundLink.href}`);
          await this.writeLog(`LINK TEXT: ${result.foundLink.text}`);
          await this.writeLog(`LINK REL: ${result.foundLink.rel || 'none'}`);
        } else if (result.domainFound) {
          // Domain found but not exact URL
          await this.writeLog(`DOMAIN MATCH FOUND: YES`);
          await this.writeLog(`DOMAIN LINK TYPE: ${result.domainFoundLink?.link_type || 'unknown'}`);
          await this.writeLog(`DOMAIN LINK HREF: ${result.domainFoundLink?.href || 'N/A'}`);
          await this.writeLog(`DOMAIN LINK TEXT: ${result.domainFoundLink?.text || 'N/A'}`);
          await this.writeLog(`DOMAIN LINK REL: ${result.domainFoundLink?.rel || 'none'}`);
          await this.writeLog(`NOTE: Domain found but exact landing page URL not found`);
        } else {
          await this.writeLog(`DOMAIN MATCH FOUND: NO`);
        }
      }
    } else {
      await this.writeLog(`ERROR: ${result.error}`);
    }

    await this.writeLog(`SCRAPED AT: ${result.scrapedAt}`);
    await this.writeLog('-'.repeat(80));
  }

  /**
   * Finalize logging (flush remaining logs)
   */
  private async finalizeLogging(): Promise<void> {
    if (!this.logFilePath) return;

    await this.writeLog('');
    await this.writeLog('='.repeat(80));
    await this.writeLog(`SCRAPING COMPLETED - ${new Date().toISOString()}`);
    await this.writeLog('='.repeat(80));
    await this.flushLogs();

    this.logger.log(`Logs saved to: ${this.logFilePath}`);
  }

  /**
   * online_status for a scrape result
   * 1 = exact link found & accessible (success with matched link)
   * 2 = link absent: page read without it, page deleted (404/410, redirected
   *     home) or domain gone
   * 3 = not verified: blocked, unreachable, or a "gone" read that a second
   *     fetch could not confirm - says nothing about the link
   * 4 = links to the client, but not to the landing page entered
   */
  private onlineStatusOf(result: ScrapedNetlinkData): number {
    if (!result.success) {
      // A domain that no longer resolves is gone for everyone, unlike a
      // timeout or a block which only means we could not read it.
      return isDeadDomainError(result.error) ? 2 : 3;
    }
    if (result.unconfirmed === true) {
      return 3;
    }
    if (result.redirectedToHomepage === true) {
      // Checked before the link: a sitewide homepage link to the client is
      // not the article link that was bought.
      return 2;
    }
    if (result.foundLink?.matched === true) {
      // Exact matching link found. Checked before the status code because
      // finding the link proves we read the real article - some publishers
      // answer 403 to the scraper while still serving the full page.
      return 1;
    }
    if (result.domainFound === true) {
      return 4;
    }
    if (result.statusCode === 404 || result.statusCode === 410) {
      // The page itself is deleted - the same answer from any network, unlike
      // a 403 - so the link is gone, not merely unverified.
      return 2;
    }
    if (result.statusCode !== undefined && result.statusCode >= 400) {
      // page.goto() resolves on 4xx/5xx, so an error page (bot block, rate
      // limit) would otherwise be parsed as a real page with no matching
      // link. We cannot claim the link is absent - report it as not verified.
      return 3;
    }
    // Page read, no link to the client on it
    return 2;
  }

  /**
   * Transform scraped result to NetlinkAdditionalInfo format
   */
  private transformToAdditionalInfo(result: ScrapedNetlinkData): NetlinkAdditionalInfo | null {
    // Skip if no netlinkId
    if (!result.netlinkId) {
      this.logger.warn(`Skipping result without netlinkId: ${result.url}`);
      return null;
    }

    // Determine link_type from the foundLink or domainFoundLink
    let link_type = 'unknown'; // Default to unknown

    if (result.redirectedToHomepage) {
      // The article is gone; a link found on the homepage is not the one bought
    } else if (result.success && result.foundLink?.matched && result.foundLink?.link_type) {
      // Exact match found
      link_type = result.foundLink.link_type;
    } else if (result.success && result.domainFound && result.domainFoundLink?.link_type) {
      // Domain match found
      link_type = result.domainFoundLink.link_type;
    }

    const online_status = this.onlineStatusOf(result);

    // Build the additional info object
    const additionalInfo: NetlinkAdditionalInfo = {
      netlink_id: Number(result.netlinkId),
      link_type,
      online_status,
    };

    // Add status code if available
    if (result.statusCode !== undefined) {
      additionalInfo.status_code = result.statusCode;
    }


    return additionalInfo;
  }

  /**
   * Post batch results to the upsert endpoint
   */
  async postBatchResults(results: ScrapedNetlinkData[]): Promise<void> {
    try {
      // Transform results to additional info format
      const items: NetlinkAdditionalInfo[] = results
        .map(result => this.transformToAdditionalInfo(result))
        .filter((item): item is NetlinkAdditionalInfo => item !== null);

      if (items.length === 0) {
        this.logger.warn('No valid items to upsert');
        return;
      }

      const requestBody: BatchUpsertRequest = { items };

      this.logger.log(`Posting ${items.length} items to /netlink/additionalInfo/upsert`);
      this.logger.debug(`Request body: ${JSON.stringify(requestBody, null, 2)}`);

      // Post to the endpoint
      const response = await this.dashboardClient.post(
        '/netlink/additionalInfo/upsert',
        requestBody
      );

      this.logger.log(`✓ Batch upsert successful: ${JSON.stringify(response)}`);
    } catch (error) {
      this.logger.error(`Failed to post batch results: ${error.message}`);
      if (error.response) {
        this.logger.error(`Response data: ${JSON.stringify(error.response.data)}`);
      }
      throw error;
    }
  }

  /**
   * All links on the page, plus inline scripts that may carry the full
   * (paywalled) article as markup.
   *
   * Some pages redirect themselves with JavaScript just after load
   * (domcontentloaded resolves before the redirect), which destroys the page
   * mid-read. Wait for the new page and read that one - it is where a
   * visitor ends up - rather than failing the whole netlink.
   */
  private async readLinksSurvivingNavigation(
    page: Page,
  ): Promise<{ domLinks: PageLink[]; scripts: string[] }> {
    const maxAttempts = 3;

    for (let attempt = 1; ; attempt++) {
      try {
        return await page.evaluate(() => ({
          domLinks: Array.from(document.querySelectorAll('a')).map(link => ({
            href: link.href,
            text: link.textContent?.trim() || '',
            outerHTML: link.outerHTML,
            rel: link.getAttribute('rel') || '',
          })),
          scripts: Array.from(document.querySelectorAll('script:not([src])'))
            .map(s => s.textContent || '')
            .filter(t => /href/i.test(t)),
        }));
      } catch (error) {
        const navigated = /Execution context was destroyed|navigation/i.test(error.message ?? '');
        if (!navigated || attempt >= maxAttempts) throw error;

        this.logger.debug(`Page navigated while reading ${page.url()}, reading the new page`);
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => undefined);
      }
    }
  }

  /**
   * Extract data from a page - find the best <a> pointing to the client
   * (rules in link-matching.ts, shared with the single-netlink debug script)
   */
  private async extractData(page: Page, url: string, landingPage?: string): Promise<Partial<ScrapedNetlinkData>> {
    try {
      // Wait for page to load. 'attached', not the default 'visible': some
      // themes keep <body> hidden until their scripts run, and the links are
      // in the DOM either way.
      await page.waitForSelector('body', { state: 'attached', timeout: 5000 });

      // Wait a bit for dynamic content to load
      await page.waitForTimeout(2000);

      const { domLinks, scripts } = await this.readLinksSurvivingNavigation(page);

      // allLinksCount stays DOM-only: looksBlocked() relies on it to spot
      // near-empty challenge pages
      // Firecrawl HTML is loaded with setContent(), where page.url() is about:blank
      const baseUrl = page.url().startsWith('http') ? page.url() : url;
      const linksData: PageLink[] = [...domLinks, ...anchorsFromScripts(scripts, baseUrl)];

      this.logger.debug(`Found ${domLinks.length} links on page ${url} (+${linksData.length - domLinks.length} in scripts)`);

      // If no landing page provided, return all links
      if (!landingPage) {
        return {
          allLinksCount: domLinks.length,
          foundLink: undefined,
        };
      }

      const best = pickBestLink(linksData, landingPage);
      const notMatched = { href: '', text: '', outerHTML: '', matched: false };

      if (!best) {
        this.logger.warn(`No link to the client found for landing page: ${landingPage}`);
        return { allLinksCount: domLinks.length, foundLink: notMatched, domainFound: false };
      }

      const { kind, link } = best;
      const link_type = linkTypeFromRel(link.rel);
      this.logger.log(`✓ Found ${kind === 'target' ? 'target' : 'other client page'} link: ${link.href} (${link_type}, rel="${link.rel || 'none'}")${link.source === 'json' ? ' [in page data]' : ''}`);

      if (kind === 'target') {
        return {
          allLinksCount: domLinks.length,
          foundLink: {
            href: link.href,
            text: link.text,
            outerHTML: link.outerHTML,
            matched: true,
            matchType: 'exact',
            rel: link.rel || undefined,
            link_type,
          },
        };
      }

      // Links to the client, but not to the landing page entered in the Dashboard
      return {
        allLinksCount: domLinks.length,
        foundLink: notMatched,
        domainFound: true,
        domainFoundLink: {
          href: link.href,
          text: link.text,
          rel: link.rel || undefined,
          link_type,
        },
      };

    } catch (error) {
      this.logger.error(`Error extracting data from ${url}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Scrape a single netlink URL
   */
  async scrapeNetlink(
    url: string,
    landingPage?: string,
    options?: Pick<ScrapeOptions, 'timeout' | 'retries'>
  ): Promise<ScrapedNetlinkData> {
    const { timeout = 30000, retries = 3 } = options || {};

    let lastError: Error;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        this.logger.debug(`Scraping ${url} (attempt ${attempt}/${retries})`);

        const scrapedData = await this.lightpanda.withPage(async (page) => {
          try {
            // Set timeout for page operations
            page.setDefaultTimeout(timeout);

            // Navigate to URL and capture response
            const response = await page.goto(url, {
              waitUntil: 'domcontentloaded',
              timeout,
            });

            // Get status code from response
            const statusCode = response?.status();

            // Extract data using the extractData method
            const extractedData = await this.extractData(page, url, landingPage);

            // Read after extraction: a JavaScript redirect (e.g. a removed
            // article sent home) only happens after domcontentloaded
            const finalUrl = page.url();

            return {
              ...extractedData,
              statusCode,
              finalUrl,
              redirectedToHomepage: isRedirectToHomepage(url, finalUrl),
            };
          } catch (pageError) {
            // Handle CDP session errors that occur during page operations
            if (pageError.message?.includes('Target page, context or browser has been closed') ||
                pageError.message?.includes('cdpSession.send') ||
                pageError.message?.includes('Session closed')) {
              this.logger.warn(`CDP session closed during ${url} processing`);
            }
            throw pageError; // Re-throw to be caught by outer catch
          }
        });

        const firstRead: ScrapedNetlinkData = {
          url,
          landingPage,
          scrapedAt: new Date().toISOString(),
          success: true,
          ...scrapedData,
        };

        return await this.confirmIfNotFound(firstRead);

      } catch (error) {
        lastError = error;

        // Handle CDP session errors gracefully (browser/page already closed)
        const isCDPError = error.message?.includes('Target page, context or browser has been closed') ||
                          error.message?.includes('cdpSession.send') ||
                          error.message?.includes('Session closed');

        if (isCDPError) {
          this.logger.warn(
            `Attempt ${attempt}/${retries} failed for ${url}: Browser session closed (likely timeout)`
          );
        } else {
          this.logger.warn(
            `Attempt ${attempt}/${retries} failed for ${url}: ${error.message}`
          );
        }

        if (attempt < retries) {
          // Wait before retry (exponential backoff)
          const delay = 1000 * Math.pow(2, attempt - 1);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    // Our browser could not reach the page at all. It may still be reachable
    // from a different network, so try the fallback before declaring it offline.
    const viaFirecrawl = await this.scrapeViaFirecrawl(url, landingPage);
    if (viaFirecrawl?.redirectedToHomepage) {
      return viaFirecrawl; // reported as gone, not as the homepage's links
    }
    if (viaFirecrawl?.foundLink?.matched || viaFirecrawl?.domainFound) {
      return viaFirecrawl;
    }

    // All retries failed
    this.logger.error(`Failed to scrape ${url} after ${retries} attempts`);
    return {
      url,
      landingPage,
      scrapedAt: new Date().toISOString(),
      success: false,
      error: lastError.message,
    };
  }

  /**
   * Never report a link as gone, or leave it unverified, on a single read.
   *
   * A found link proves we read the real article, so it is kept as-is. Any
   * other verdict gets a second read from another network and browser
   * (Firecrawl): paywalls, consent walls, late JavaScript and bot-only 404s or
   * redirects all make a live link look missing to one reader.
   */
  private async confirmIfNotFound(firstRead: ScrapedNetlinkData): Promise<ScrapedNetlinkData> {
    const status = this.onlineStatusOf(firstRead);
    if (status === 1 || status === 4) return firstRead;

    // Without a second reader there is nothing to confirm with; keep the
    // single-read verdict rather than turning every miss into "not verified".
    if (!this.firecrawl.isEnabled()) return firstRead;

    const { url, landingPage } = firstRead;
    const secondRead = await this.scrapeViaFirecrawl(url, landingPage);

    // Our browser was redirected home; if the second read cannot say where it
    // landed, a link it found may be the homepage's sitewide one.
    const secondLandingUnknown = firstRead.redirectedToHomepage && !secondRead?.finalUrl;

    if (
      secondRead &&
      !secondRead.redirectedToHomepage &&
      !secondLandingUnknown &&
      (secondRead.foundLink?.matched || secondRead.domainFound)
    ) {
      this.logger.log(`Second read found the link on ${url}: first read was wrong`);
      return secondRead;
    }

    if (status !== 2) return firstRead;

    // The second read confirms "gone" only if it really saw the page: the
    // same homepage redirect, or a readable page without the link. A blocked
    // or failed second read proves nothing.
    const confirmed =
      secondRead !== null &&
      (secondRead.redirectedToHomepage === true ||
        !this.looksBlocked(secondRead.statusCode, secondRead.allLinksCount));

    if (!confirmed) {
      this.logger.warn(`Could not confirm ${url} is gone - reporting it as not verified`);
      return { ...firstRead, unconfirmed: true };
    }
    return firstRead;
  }

  /**
   * Decide whether a loaded page should be distrusted.
   *
   * page.goto() resolves on 4xx/5xx, and anti-bot vendors often serve a
   * challenge with HTTP 200, so "no matching link" can mean "we never saw the
   * article" rather than "the backlink was removed".
   *
   * 404/410 are excluded on purpose: a deleted page is genuine information and
   * returns the same from any network, so retrying it only wastes credits.
   */
  private looksBlocked(statusCode?: number, allLinksCount?: number): boolean {
    if (statusCode === 404 || statusCode === 410) return false;
    if (statusCode !== undefined && statusCode >= 400) return true;

    // A real article carries dozens of links; a challenge page carries almost
    // none. Measured across ~100 live netlinks, no genuine page had under 20.
    return allLinksCount !== undefined && allLinksCount < 5;
  }

  /**
   * Re-fetch a page through Firecrawl and run the normal extraction over it.
   *
   * The HTML is loaded into a real page so extractData() applies unchanged -
   * matching rules and rel/nofollow handling stay in one place instead of being
   * reimplemented against a second parser.
   *
   * Returns null if the fallback is unavailable or also failed, so the caller
   * keeps its original (not-accessible) result rather than claiming the link is
   * absent based on a page we never read.
   */
  private async scrapeViaFirecrawl(
    url: string,
    landingPage?: string,
  ): Promise<ScrapedNetlinkData | null> {
    if (!this.firecrawl.isEnabled()) return null;

    this.logger.log(`Falling back to Firecrawl for ${url}`);
    const fetched = await this.firecrawl.fetchRawHtml(url);
    if (!fetched) return null;

    try {
      const extracted = await this.lightpanda.withPage(async (page) => {
        // <base> preserves resolution of relative hrefs, which would otherwise
        // resolve against about:blank once the HTML is loaded out of context.
        const html = fetched.html.replace(
          /<head([^>]*)>/i,
          `<head$1><base href="${url}">`,
        );
        await page.setContent(html, { waitUntil: 'domcontentloaded' });
        return this.extractData(page, url, landingPage);
      }, { javaScriptEnabled: false });

      this.logger.log(
        `Firecrawl recovered ${url} (${extracted.allLinksCount} links, ` +
          `match=${extracted.foundLink?.matched ?? false})`,
      );

      return {
        url,
        landingPage,
        scrapedAt: new Date().toISOString(),
        success: true,
        ...extracted,
        statusCode: fetched.statusCode,
        finalUrl: fetched.finalUrl,
        redirectedToHomepage: isRedirectToHomepage(url, fetched.finalUrl),
        recoveredVia: 'firecrawl',
      };
    } catch (error) {
      this.logger.warn(`Failed to parse Firecrawl HTML for ${url}: ${error.message}`);
      return null;
    }
  }


  /**
   * Scrape multiple netlinks with concurrency control
   *
   * Supports concurrent scraping with local Lightpanda browser.
   * Each scraping operation runs in its own isolated browser context.
   */
  async scrapeNetlinks(
    netlinks: NetlinkItem[],
    options?: ScrapeOptions
  ): Promise<ScrapedNetlinkData[]> {
    const {
      concurrency = 3,
      timeout = 30000,
      retries = 3,
      delay = 1000,
      skipErrors = true,
      enableLogging = false,
      logFilePath,
      enableDomDetailer = false,
      domDetailerConcurrency = 2,
      onProgress,
      onSuccess,
      onError,
    } = options || {};

    // Initialize logging if enabled
    if (enableLogging) {
      await this.initializeLogging(logFilePath);
      await this.writeLog(`Starting to scrape ${netlinks.length} netlinks with concurrency ${concurrency}`);
    }

    this.logger.log(`Starting to scrape ${netlinks.length} netlinks with concurrency ${concurrency}`);
    this.logger.debug(`Queue initialized with ${netlinks.length} items`);

    const results: ScrapedNetlinkData[] = [];
    const queue = [...netlinks];
    let completed = 0;
    let activeWorkers = 0;
    const netlinkMap = new Map(netlinks.map(n => [n.url_bought || n.url, n]));

    return new Promise((resolve, reject) => {
      // No global timeout - rely on per-item timeout (2 minutes per URL)
      // Each item has its own timeout, so workers will complete naturally

      const worker = async () => {
        while (queue.length > 0) {
          const netlink = queue.shift();
          if (!netlink) {
            this.logger.debug(`Worker exiting: netlink is undefined, queue.length=${queue.length}`);
            break;
          }

          activeWorkers++;

          // Extract URL from netlink - using url_bought field
          const url = netlink.url_bought || netlink.url || netlink.link || netlink.href;
          this.logger.debug(`Worker started item #${completed + 1}: activeWorkers=${activeWorkers}, queue.length=${queue.length}, url=${url?.substring(0, 50)}`);

          if (!url) {
            this.logger.warn(`Netlink has no URL property: ${JSON.stringify(netlink)}`);
            activeWorkers--;
            continue;
          }

          try {
            // Progress callback (called before processing)
            if (onProgress) {
              onProgress(completed + 1, netlinks.length, url);
            }

            // Extract landing_page from netlink
            const landingPage = netlink.landing_page;

            // Scrape the netlink with landing_page - with hard timeout protection
            // Maximum time: (timeout * retries) + buffer for retries
            const maxTime = timeout * retries + 10000; // Add 10s buffer

            let result: ScrapedNetlinkData;
            try {
              result = await Promise.race([
                this.scrapeNetlink(url, landingPage, { timeout, retries }),
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error(`Hard timeout after ${maxTime}ms`)), maxTime)
                ),
              ]);
            } catch (timeoutError) {
              this.logger.warn(`Hard timeout hit for ${url}: ${timeoutError.message}`);
              result = {
                url,
                landingPage,
                scrapedAt: new Date().toISOString(),
                success: false,
                error: `Timeout: ${timeoutError.message}`,
              };
            }

            // Add netlink ID if available
            if (netlink.id) {
              result.netlinkId = netlink.id;
            }

            results.push(result);

            // Log netlink details if logging is enabled
            if (enableLogging) {
              await this.logNetlinkDetails(netlink, result);
            }

            // Success callback
            if (result.success && onSuccess) {
              await onSuccess(result);
            }

            // Error callback
            if (!result.success && onError) {
              await onError(url, new Error(result.error));
            }

          } catch (error) {
            this.logger.error(`Unexpected error scraping ${url}: ${error.message}`);

            const errorResult: ScrapedNetlinkData = {
              url,
              netlinkId: netlink.id,
              scrapedAt: new Date().toISOString(),
              success: false,
              error: error.message,
            };

            results.push(errorResult);

            // Log error details if logging is enabled
            if (enableLogging) {
              const netlinkObj = netlinkMap.get(url);
              if (netlinkObj) {
                await this.logNetlinkDetails(netlinkObj, errorResult);
              }
            }

            if (onError) {
              await onError(url, error);
            }

            if (!skipErrors) {
              activeWorkers--; // Decrement before rejecting
              reject(error);
              return;
            }
          }

          // Increment completed count AFTER processing
          completed++;

          // Delay between requests
          if (delay > 0 && queue.length > 0) {
            await new Promise(resolve => setTimeout(resolve, delay));
          }

          activeWorkers--;
          this.logger.debug(`Worker finished item: activeWorkers=${activeWorkers}, queue.length=${queue.length}, completed=${completed}`);

          // Check if all work is done (check inside loop too, not just after)
          if (activeWorkers === 0 && queue.length === 0) {
            this.logger.log(`✓ All workers finished! Resolving with ${results.length} results`);

            if (enableLogging) {
              await this.finalizeLogging();
            }
            resolve(results);
            return;
          }
        }

        // Double-check after loop exits (shouldn't be needed, but just in case)
        if (activeWorkers === 0 && queue.length === 0) {

          // Finalize logging if enabled
          if (enableLogging) {
            await this.finalizeLogging();
          }
          resolve(results);
        }
      };

      // Start workers
      const workerCount = Math.min(concurrency, netlinks.length);
      for (let i = 0; i < workerCount; i++) {
        worker().catch(reject);
      }
    });
  }

  /**
   * Scrape netlinks filtered by contract_id (using backend API filtering)
   */
  async scrapeByContractId(
    contractId: number | string,
    options?: ScrapeOptions
  ): Promise<ScrapingStats> {
    const startTime = new Date();
    const stats: ScrapingStats = {
      total: 0,
      successful: 0,
      failed: 0,
      skipped: 0,
      duration: 0,
      startTime,
      errors: [],
    };

    try {
      this.logger.log(`Fetching netlinks for contract_id: ${contractId} (API filtered)...`);

      // Initialize logging if enabled
      if (options?.enableLogging) {
        await this.initializeLogging(options.logFilePath);
        await this.writeLog(`Fetching netlinks for contract_id: ${contractId}`);
      }

      // Fetch netlinks filtered by contract_id from API
      const netlinks = await this.netlinkService.fetchAllNetlinks({
        limit: 100,
        contractId: contractId,
        onProgress: (page, totalPages, itemCount) => {
          this.logger.log(`Fetching netlinks: Page ${page}/${totalPages} (${itemCount} items)`);
        },
      });

      stats.total = netlinks.length;
      this.logger.log(`Found ${netlinks.length} netlinks for contract_id ${contractId}. Starting scraping...`);

      if (options?.enableLogging) {
        await this.writeLog(`Netlinks found for contract_id ${contractId}: ${netlinks.length}`);
      }

      if (netlinks.length === 0) {
        this.logger.warn(`No netlinks found for contract_id: ${contractId}`);
        if (options?.enableLogging) {
          await this.writeLog(`WARNING: No netlinks found for contract_id: ${contractId}`);
          await this.finalizeLogging();
        }
        stats.endTime = new Date();
        stats.duration = stats.endTime.getTime() - startTime.getTime();
        return stats;
      }

      // Scrape netlinks
      const results = await this.scrapeNetlinks(netlinks, {
        ...options,
        onProgress: (current, total, url) => {
          const percentage = ((current / total) * 100).toFixed(1);
          this.logger.log(`Progress: ${percentage}% (${current}/${total}) - ${url}`);

          if (options?.onProgress) {
            options.onProgress(current, total, url);
          }
        },
        onSuccess: async (data) => {
          stats.successful++;
          if (options?.onSuccess) {
            await options.onSuccess(data);
          }
        },
        onError: async (url, error) => {
          stats.failed++;
          stats.errors.push({ url, error: error.message });
          if (options?.onError) {
            await options.onError(url, error);
          }
        },
      });

      stats.endTime = new Date();
      stats.duration = stats.endTime.getTime() - startTime.getTime();

      this.logger.log('='.repeat(60));
      this.logger.log('SCRAPING COMPLETED');
      this.logger.log('='.repeat(60));
      this.logger.log(`Contract ID: ${contractId}`);
      this.logger.log(`Total: ${stats.total}`);
      this.logger.log(`Successful: ${stats.successful}`);
      this.logger.log(`Failed: ${stats.failed}`);
      this.logger.log(`Duration: ${(stats.duration / 1000).toFixed(2)}s`);
      this.logger.log('='.repeat(60));

      return stats;

    } catch (error) {
      this.logger.error(`Error in scrapeByContractId: ${error.message}`);
      if (options?.enableLogging) {
        await this.writeLog(`ERROR: ${error.message}`);
        await this.finalizeLogging();
      }
      stats.endTime = new Date();
      stats.duration = stats.endTime.getTime() - startTime.getTime();
      throw error;
    }
  }

  /**
   * Scrape all netlinks from the dashboard API
   */
  async scrapeAllNetlinks(options?: ScrapeOptions): Promise<ScrapingStats> {
    const startTime = new Date();
    const stats: ScrapingStats = {
      total: 0,
      successful: 0,
      failed: 0,
      skipped: 0,
      duration: 0,
      startTime,
      errors: [],
    };

    try {
      this.logger.log('Fetching netlinks from dashboard...');

      // Fetch all netlinks
      const netlinks = await this.netlinkService.fetchAllNetlinks({
        limit: 100,
        onProgress: (page, totalPages, itemCount) => {
          this.logger.log(`Fetching netlinks: Page ${page}/${totalPages} (${itemCount} items)`);
        },
      });

      stats.total = netlinks.length;
      this.logger.log(`Fetched ${netlinks.length} netlinks. Starting scraping...`);

      // Scrape all netlinks
      const results = await this.scrapeNetlinks(netlinks, {
        ...options,
        onProgress: (current, total, url) => {
          const percentage = ((current / total) * 100).toFixed(1);
          this.logger.log(`Progress: ${percentage}% (${current}/${total}) - ${url}`);

          if (options?.onProgress) {
            options.onProgress(current, total, url);
          }
        },
        onSuccess: async (data) => {
          stats.successful++;
          if (options?.onSuccess) {
            await options.onSuccess(data);
          }
        },
        onError: async (url, error) => {
          stats.failed++;
          stats.errors.push({ url, error: error.message });
          if (options?.onError) {
            await options.onError(url, error);
          }
        },
      });

      stats.endTime = new Date();
      stats.duration = stats.endTime.getTime() - startTime.getTime();

      this.logger.log('='.repeat(60));
      this.logger.log('SCRAPING COMPLETED');
      this.logger.log('='.repeat(60));
      this.logger.log(`Total: ${stats.total}`);
      this.logger.log(`Successful: ${stats.successful}`);
      this.logger.log(`Failed: ${stats.failed}`);
      this.logger.log(`Duration: ${(stats.duration / 1000).toFixed(2)}s`);
      this.logger.log('='.repeat(60));

      return stats;

    } catch (error) {
      this.logger.error(`Error in scrapeAllNetlinks: ${error.message}`);
      stats.endTime = new Date();
      stats.duration = stats.endTime.getTime() - startTime.getTime();
      throw error;
    }
  }

  /**
   * Scrape netlinks in batches (memory efficient)
   */
  async scrapeInBatches(
    batchSize: number,
    onBatchComplete: (results: ScrapedNetlinkData[], batchNumber: number) => Promise<void>,
    options?: ScrapeOptions
  ): Promise<ScrapingStats> {
    const startTime = new Date();
    const stats: ScrapingStats = {
      total: 0,
      successful: 0,
      failed: 0,
      skipped: 0,
      duration: 0,
      startTime,
      errors: [],
    };

    try {
      this.logger.log(`Starting batch scraping with batch size ${batchSize}`);

      let batchNumber = 0;

      // Fetch and scrape in batches
      await this.netlinkService.fetchInBatches(
        10, // 10 pages per batch of netlinks
        async (netlinkBatch, _batchNum) => {
          batchNumber++;
          stats.total += netlinkBatch.length;

          this.logger.log(`Processing batch ${batchNumber}: ${netlinkBatch.length} netlinks`);

          // Scrape this batch
          const results = await this.scrapeNetlinks(netlinkBatch, {
            ...options,
            onSuccess: (data) => {
              stats.successful++;
              if (options?.onSuccess) options.onSuccess(data);
            },
            onError: (url, error) => {
              stats.failed++;
              stats.errors.push({ url, error: error.message });
              if (options?.onError) options.onError(url, error);
            },
          });

          // Process batch results
          await onBatchComplete(results, batchNumber);

          this.logger.log(
            `Batch ${batchNumber} complete: ${results.filter(r => r.success).length}/${results.length} successful`
          );
        },
        { limit: 100 }
      );

      stats.endTime = new Date();
      stats.duration = stats.endTime.getTime() - startTime.getTime();

      this.logger.log('='.repeat(60));
      this.logger.log('BATCH SCRAPING COMPLETED');
      this.logger.log('='.repeat(60));
      this.logger.log(`Total: ${stats.total}`);
      this.logger.log(`Successful: ${stats.successful}`);
      this.logger.log(`Failed: ${stats.failed}`);
      this.logger.log(`Duration: ${(stats.duration / 1000).toFixed(2)}s`);
      this.logger.log('='.repeat(60));

      return stats;

    } catch (error) {
      this.logger.error(`Error in scrapeInBatches: ${error.message}`);
      stats.endTime = new Date();
      stats.duration = stats.endTime.getTime() - startTime.getTime();
      throw error;
    }
  }

  /**
   * Test scraping on a sample of netlinks
   */
  async testScraping(sampleSize: number = 5): Promise<ScrapedNetlinkData[]> {
    this.logger.log(`Testing scraping on ${sampleSize} sample netlinks...`);

    // Fetch first page
    const firstPage = await this.netlinkService.fetchPage(1, sampleSize);
    const sampleNetlinks = firstPage.data.slice(0, sampleSize);

    this.logger.log(`Sample netlinks fetched: ${sampleNetlinks.length}`);

    // Scrape sample
    const results = await this.scrapeNetlinks(sampleNetlinks, {
      concurrency: 1,
      timeout: 30000,
      retries: 2,
      onProgress: (current, total, url) => {
        this.logger.log(`Test ${current}/${total}: ${url}`);
      },
    });

    const successful = results.filter(r => r.success).length;
    this.logger.log(`Test complete: ${successful}/${results.length} successful`);

    return results;
  }
}
