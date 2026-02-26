import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LightpandaService } from '../../../common/lightpanda.service';
import { BQSCalculatorService } from '../../../scoring/bqs-calculator.service';
import { DatabaseService } from '../../../common/database.service';
import {
  RocketLinksSite,
  RocketLinksSiteRaw,
} from '../interfaces/rocketlinks-site.interface';
import {
  RocketLinksCategory,
  ROCKETLINKS_CATEGORIES
} from '../../../config/rocketlinks-categories.config';
import type { Page, BrowserContext } from 'playwright-core';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Price ranges for filtering catalog results
 * Each range is [minPrice, maxPrice]
 */
export const PRICE_RANGES: Array<[number, number]> = [
  [0, 50],
  [50, 100],
  [100, 200],
  [200, 300],
  [300, 400],
  [400, 500],
  [500, 600],
  [600, 700],
  [700, 800],
  [800, 900],
  [900, 1000],
  [1000, 2000],
  [2000, 5000],
  [5000, 50000],
];

/**
 * RocketLinks Scraper Service
 *
 * Main orchestrator that coordinates:
 * - Browser-based authentication to RocketLinks
 * - Category scraping with pagination
 * - Data transformation
 * - BQS scoring
 * - Data persistence
 */
@Injectable()
export class RocketLinksScraperService {
  private readonly logger = new Logger(RocketLinksScraperService.name);
  private readonly baseUrl: string;
  private readonly email: string;
  private readonly password: string;
  private isLoggedIn: boolean = false;
  private context: BrowserContext | null = null;
  private pageNavigationCount: number = 0;
  private readonly PAGE_RECYCLE_THRESHOLD = 50; // Recreate page every 50 navigations to prevent memory leaks

  constructor(
    private readonly lightpanda: LightpandaService,
    private readonly configService: ConfigService,
    private readonly bqsCalculator: BQSCalculatorService,
    private readonly databaseService: DatabaseService,
  ) {
    this.baseUrl = this.configService.get<string>(
      'ROCKETLINKS_URL',
      'https://www.rocketlinks.net',
    );
    this.email = this.configService.get<string>('ROCKETLINKS_EMAIL', '');
    this.password = this.configService.get<string>('ROCKETLINKS_PASSWORD', '');
  }

  /**
   * Login to RocketLinks using browser automation
   */
  async login(): Promise<boolean> {
    this.logger.log('='.repeat(60));
    this.logger.log('ROCKETLINKS LOGIN');
    this.logger.log('='.repeat(60));

    if (!this.email || !this.password) {
      throw new Error(
        'RocketLinks credentials not found. Please set ROCKETLINKS_EMAIL and ROCKETLINKS_PASSWORD in .env',
      );
    }

    this.logger.log(`Logging in as: ${this.email}`);

    try {
      // Create a persistent browser context for the session
      this.context = await this.lightpanda.createContext();
      const page = await this.context.newPage();

      // Navigate to login page
      this.logger.log('Navigating to login page...');
      await page.goto(`${this.baseUrl}/login`, {
        waitUntil: 'networkidle',
        timeout: 30000,
      });

      // Wait for page to load
      await page.waitForTimeout(2000);

      // Log current URL
      this.logger.log(`Current URL: ${page.url()}`);

      // Wait for email input field - RocketLinks specific selectors
      this.logger.log('Looking for login form...');

      // RocketLinks specific email selector
      const emailSelector = '#loginEmail';
      let emailInput = null;

      try {
        emailInput = await page.waitForSelector(emailSelector, { timeout: 10000 });
        this.logger.log(`Found email input with selector: ${emailSelector}`);
      } catch {
        // Try alternative selector
        try {
          emailInput = await page.waitForSelector('input[name="data[User][email]"]', { timeout: 5000 });
          this.logger.log('Found email input with name selector');
        } catch {
          throw new Error('Could not find email input field on login page');
        }
      }

      // RocketLinks specific password selector
      const passwordSelector = '#loginPassword';
      let passwordInput = null;

      try {
        passwordInput = await page.waitForSelector(passwordSelector, { timeout: 5000 });
        this.logger.log(`Found password input with selector: ${passwordSelector}`);
      } catch {
        // Try alternative selector
        try {
          passwordInput = await page.waitForSelector('input[name="data[User][password]"]', { timeout: 5000 });
          this.logger.log('Found password input with name selector');
        } catch {
          throw new Error('Could not find password input field on login page');
        }
      }

      // Fill in credentials with human-like typing
      this.logger.log('Entering credentials...');
      await emailInput.click();
      await page.waitForTimeout(500);
      await emailInput.fill(this.email);
      await page.waitForTimeout(500);

      await passwordInput.click();
      await page.waitForTimeout(500);
      await passwordInput.fill(this.password);
      await page.waitForTimeout(500);

      // Find and click submit button - RocketLinks specific
      const submitSelectors = [
        'input[type="submit"]',
        'button[type="submit"]',
        '#loginSubmit',
        'input.formSubmit',
        'button.formSubmit',
        'input[value="Connexion"]',
        'input[value="Se connecter"]',
        'button:has-text("Connexion")',
        'button:has-text("Se connecter")',
        'form#loginForm input[type="submit"]',
        'form input[type="submit"]',
      ];

      let submitButton = null;
      for (const selector of submitSelectors) {
        try {
          submitButton = await page.waitForSelector(selector, { timeout: 3000 });
          if (submitButton) {
            this.logger.log(`Found submit button with selector: ${selector}`);
            break;
          }
        } catch {
          // Try next selector
        }
      }

      if (!submitButton) {
        // Try to find any submit-like element in the form
        this.logger.log('Looking for any clickable submit element...');
        const formSubmit = await page.$('form input[type="submit"], form button[type="submit"], form .btn, form button');
        if (formSubmit) {
          submitButton = formSubmit;
          this.logger.log('Found form submit element');
        } else {
          throw new Error('Could not find submit button on login page');
        }
      }

      // Click login button
      this.logger.log('Submitting login form...');
      await submitButton.click();

      // Wait for navigation after login
      await page.waitForTimeout(3000);

      // Check if login was successful by checking URL or page content
      const currentUrl = page.url();
      this.logger.log(`Post-login URL: ${currentUrl}`);

      // Check if we're still on login page (login failed) or redirected
      if (currentUrl.includes('/login')) {
        // Check for error messages
        const errorSelectors = ['.error', '.alert-danger', '.login-error', '[class*="error"]'];
        for (const selector of errorSelectors) {
          const errorElement = await page.$(selector);
          if (errorElement) {
            const errorText = await errorElement.textContent();
            this.logger.error(`Login error: ${errorText}`);
          }
        }
        throw new Error('Login failed - still on login page');
      }

      this.isLoggedIn = true;
      this.logger.log('Successfully logged in to RocketLinks!');

      // Keep the page open for further operations
      return true;

    } catch (error) {
      this.logger.error(`Login failed: ${error.message}`);
      this.isLoggedIn = false;
      throw error;
    }
  }

  /**
   * Check if currently logged in
   */
  isAuthenticated(): boolean {
    return this.isLoggedIn;
  }

  /**
   * Get the browser context (for further scraping operations)
   */
  getContext(): BrowserContext | null {
    return this.context;
  }

  /**
   * Close the browser session
   */
  async logout(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
    this.isLoggedIn = false;
    this.logger.log('Logged out from RocketLinks');
  }

  /**
   * Navigate to a page within the logged-in session
   */
  async navigateTo(urlPath: string): Promise<Page> {
    if (!this.isLoggedIn || !this.context) {
      throw new Error('Not logged in. Please call login() first.');
    }

    const pages = this.context.pages();
    const page = pages[0] || await this.context.newPage();

    const url = `${this.baseUrl}${urlPath}`;
    this.logger.log(`Navigating to: ${url}`);

    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    return page;
  }

  /**
   * Navigate to catalog page for a specific category
   * URL formats:
   *   Price mode: /catalog/all/p{page}/minSAP:{minPrice}/maxSAP:{maxPrice}/wordCount:300/searchResultsNumber:100/category:{categoryId}
   *   Date mode:  /catalog/all/p{page}/wordCount:300/minARB:{date}/searchResultsNumber:100/category:{categoryId}
   */
  async navigateToCatalog(
    categoryId: string,
    pageNum: number = 1,
    options?: {
      wordCount?: number;
      searchResultsNumber?: number;
      minPrice?: number;
      maxPrice?: number;
      dateFilter?: string; // Format: YYYY-MM-DD
    }
  ): Promise<Page> {
    if (!this.isLoggedIn || !this.context) {
      throw new Error('Not logged in. Please call login() first.');
    }

    const { wordCount = 300, searchResultsNumber = 100, minPrice, maxPrice, dateFilter } = options || {};

    // Periodically recycle the page to prevent memory leaks from accumulated Playwright state
    this.pageNavigationCount++;
    const pages = this.context.pages();
    let page: Page;

    if (this.pageNavigationCount % this.PAGE_RECYCLE_THRESHOLD === 0 && pages.length > 0) {
      this.logger.log(`Recycling browser page to free memory (after ${this.pageNavigationCount} navigations)...`);
      try {
        await pages[0].close();
      } catch {}
      page = await this.context.newPage();
    } else {
      page = pages[0] || await this.context.newPage();
    }

    // Build catalog URL
    let catalogPath = `/catalog/all/p${pageNum}`;

    if (dateFilter) {
      // Date mode: use minARB filter (no price filters)
      catalogPath += `/wordCount:${wordCount}/minARB:${dateFilter}/searchResultsNumber:${searchResultsNumber}/category:${categoryId}`;
    } else {
      // Price mode: add price filters if specified
      if (minPrice !== undefined) {
        catalogPath += `/minSAP:${minPrice}`;
      }
      if (maxPrice !== undefined) {
        catalogPath += `/maxSAP:${maxPrice}`;
      }
      catalogPath += `/wordCount:${wordCount}/searchResultsNumber:${searchResultsNumber}/category:${categoryId}`;
    }

    const url = `${this.baseUrl}${catalogPath}`;

    let filterInfo = '';
    if (dateFilter) {
      filterInfo = ` [Date: ${dateFilter}]`;
    } else if (minPrice !== undefined && maxPrice !== undefined) {
      filterInfo = ` [Price: ${minPrice}-${maxPrice}€]`;
    }

    this.logger.log('='.repeat(60));
    this.logger.log(`Navigating to catalog: ${categoryId} (page ${pageNum})${filterInfo}`);
    this.logger.log(`URL: ${url}`);
    this.logger.log('='.repeat(60));

    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    // Wait for content to load
    await page.waitForTimeout(2000);

    // Log current URL
    this.logger.log(`Current URL: ${page.url()}`);

    return page;
  }

  /**
   * Scrape site listings from a page
   * Extracts data from table.light > tbody > tr rows
   */
  async scrapeSitesFromPage(page: Page): Promise<RocketLinksSiteRaw[]> {
    this.logger.log('Scraping sites from page...');

    // Wait for table to load - if no results, return empty array
    try {
      await page.waitForSelector('table.light tbody tr', { timeout: 5000 });
    } catch {
      // Table not found or empty - no results on this page
      this.logger.log('No table rows found - page appears empty');
      return [];
    }

    // Extract data from all rows
    const sites = await page.evaluate(() => {
      const rows = document.querySelectorAll('table.light tbody tr');
      const results: any[] = [];

      // Helper to clean numeric values (remove spaces, &nbsp;, etc.)
      const cleanNumber = (text: string): number | undefined => {
        if (!text) return undefined;
        const cleaned = text.replace(/\s/g, '').replace(/&nbsp;/g, '').replace(/[^\d.-]/g, '');
        const num = parseFloat(cleaned);
        return isNaN(num) ? undefined : num;
      };

      // Helper to get text content and clean it
      const getText = (el: Element | null): string => {
        if (!el) return '';
        return el.textContent?.trim().replace(/\s+/g, ' ') || '';
      };

      rows.forEach((row) => {
        // Get domain from a.site-domain
        const domainLink = row.querySelector('a.site-domain');
        const domain = domainLink?.getAttribute('data-domain') || '';

        if (!domain) return; // Skip rows without domain

        // Extract all metrics
        const site = {
          domain,
          url: `https://${domain}`,

          // Majestic metrics
          tf: cleanNumber(getText(row.querySelector('td.tfV'))),
          cf: cleanNumber(getText(row.querySelector('td.cfV'))),
          backlinks: cleanNumber(getText(row.querySelector('td.backlinkMSV'))),
          refDomains: cleanNumber(getText(row.querySelector('td.refdomainsMSV'))),

          // Moz metrics
          da: cleanNumber(getText(row.querySelector('td.daV'))),
          pa: cleanNumber(getText(row.querySelector('td.paV'))),

          // SEMRush metrics
          semrushKeywords: cleanNumber(getText(row.querySelector('td.numberSEMRushKeywordsV'))),
          semrushTraffic: cleanNumber(getText(row.querySelector('td.semRushTrafficV'))),
          semrushValue: cleanNumber(getText(row.querySelector('td.semRushValueV'))),

          // SimilarWeb metrics
          similarwebTraffic: cleanNumber(getText(row.querySelector('td.similarWebTotalTrafficV'))),
          similarwebOrganicTraffic: cleanNumber(getText(row.querySelector('td.similarWebOrganicTrafficV'))),
          similarwebCategory: getText(row.querySelector('td.similarWebCategoryV')),

          // Ahrefs metrics
          ahrefsDR: cleanNumber(getText(row.querySelector('td.ahrefsDomainRatingV'))),
          ahrefsTraffic: cleanNumber(getText(row.querySelector('td.ahrefsOrganicTrafficV'))),
          ahrefsKeywords: cleanNumber(getText(row.querySelector('td.ahrefsOrganicKeywordsV'))),
          ahrefsValue: cleanNumber(getText(row.querySelector('td.ahrefsOrganicValueV'))),

          // Price - extract number from the span
          price: (() => {
            const priceCell = row.querySelector('td.sponsoredPV');
            if (!priceCell) return undefined;
            const priceText = priceCell.textContent || '';
            const match = priceText.match(/[\d\s]+(?:€|EUR)/);
            if (match) {
              return cleanNumber(match[0]);
            }
            return undefined;
          })(),

          // Price recommended - full string like "4 011 € pour 1200 mots"
          priceRecommended: getText(row.querySelector('td.sponsoredPRecommendedV')).trim() || null,

          // Categories
          topicalTrustFlow: getText(row.querySelector('td.topicalTrustFlowV')),
          siteCategories: getText(row.querySelector('td.siteCategoriesV')),

          // Other info
          doFollow: getText(row.querySelector('td.doFollowV')).toLowerCase().includes('oui'),
          waybackAge: cleanNumber(getText(row.querySelector('td.waybackV'))),
          googleIndexed: cleanNumber(getText(row.querySelector('td.googleV'))),
        };

        results.push(site);
      });

      return results;
    });

    this.logger.log(`Found ${sites.length} sites on page`);
    return sites;
  }

  /**
   * Scrape all pages for a category (with optional price or date filter) until no results or duplicate results
   * Saves to database after each page (batch of 100)
   */
  async scrapeAllPagesForCategory(
    categoryId: string,
    options?: {
      wordCount?: number;
      searchResultsNumber?: number;
      delayBetweenPages?: number;
      sendToAPI?: boolean;
      minPrice?: number;
      maxPrice?: number;
      dateFilter?: string;
    }
  ): Promise<{ totalSites: number; totalPages: number }> {
    const { delayBetweenPages = 2000, sendToAPI = true, minPrice, maxPrice, dateFilter } = options || {};

    let filterInfo = '';
    if (dateFilter) {
      filterInfo = ` [Date: ${dateFilter}]`;
    } else if (minPrice !== undefined && maxPrice !== undefined) {
      filterInfo = ` [Price: ${minPrice}-${maxPrice}€]`;
    }

    this.logger.log('='.repeat(60));
    this.logger.log(`SCRAPING ALL PAGES FOR CATEGORY: ${categoryId}${filterInfo}`);
    this.logger.log('='.repeat(60));

    let totalSites = 0;
    let pageNum = 1;
    let hasMoreResults = true;
    let previousPageDomains: string[] = [];

    while (hasMoreResults) {
      this.logger.log(`\nFetching page ${pageNum}...`);

      // Navigate to the page
      const page = await this.navigateToCatalog(categoryId, pageNum, options);

      // Scrape sites from this page
      const sites = await this.scrapeSitesFromPage(page);

      if (sites.length === 0) {
        // No results on this page
        this.logger.log(`Page ${pageNum}: No results found. Stopping pagination.`);
        hasMoreResults = false;
      } else {
        // Check if current page has same sites as previous page (means we've reached the end)
        const currentPageDomains = sites.map(s => s.domain).sort();
        const isSameAsPrevious =
          previousPageDomains.length > 0 &&
          currentPageDomains.length === previousPageDomains.length &&
          currentPageDomains.every((domain, i) => domain === previousPageDomains[i]);

        if (isSameAsPrevious) {
          this.logger.log(`Page ${pageNum}: Same results as previous page. Stopping pagination.`);
          hasMoreResults = false;
        } else {
          this.logger.log(`Page ${pageNum}: Found ${sites.length} sites`);

          // Save to database immediately after each page
          if (sendToAPI) {
            try {
              await this.sendToDatabase(sites);
              this.logger.log(`Page ${pageNum}: Saved ${sites.length} sites to database`);
            } catch (error) {
              this.logger.error(`Page ${pageNum}: Failed to save to database: ${error.message}`);
            }
          }

          totalSites += sites.length;
          previousPageDomains = currentPageDomains;
          pageNum++;

          // Delay between pages to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, delayBetweenPages));
        }
      }
    }

    this.logger.log('='.repeat(60));
    this.logger.log(`COMPLETED: ${categoryId}`);
    this.logger.log(`Total pages scraped: ${pageNum - 1}`);
    this.logger.log(`Total sites saved: ${totalSites}`);
    this.logger.log('='.repeat(60));

    return { totalSites, totalPages: pageNum - 1 };
  }

  /**
   * Scrape all price ranges for a category
   * For each price range, scrape all pages until no results, then move to next price range
   */
  async scrapeAllPriceRangesForCategory(
    categoryId: string,
    options?: {
      wordCount?: number;
      searchResultsNumber?: number;
      delayBetweenPages?: number;
      delayBetweenPriceRanges?: number;
      sendToAPI?: boolean;
      priceRanges?: Array<[number, number]>;
    }
  ): Promise<{
    totalSites: number;
    totalPages: number;
    priceRangeResults: Array<{ minPrice: number; maxPrice: number; sites: number; pages: number }>;
  }> {
    const {
      delayBetweenPages = 2000,
      delayBetweenPriceRanges = 3000,
      sendToAPI = true,
      priceRanges = PRICE_RANGES,
    } = options || {};

    this.logger.log('');
    this.logger.log('#'.repeat(60));
    this.logger.log(`SCRAPING ALL PRICE RANGES FOR CATEGORY: ${categoryId}`);
    this.logger.log(`Total price ranges: ${priceRanges.length}`);
    this.logger.log('#'.repeat(60));

    const priceRangeResults: Array<{ minPrice: number; maxPrice: number; sites: number; pages: number }> = [];
    let totalSites = 0;
    let totalPages = 0;

    for (let i = 0; i < priceRanges.length; i++) {
      const [minPrice, maxPrice] = priceRanges[i];

      this.logger.log('');
      this.logger.log('-'.repeat(60));
      this.logger.log(`PRICE RANGE ${i + 1}/${priceRanges.length}: ${minPrice}€ - ${maxPrice}€`);
      this.logger.log('-'.repeat(60));

      try {
        const result = await this.scrapeAllPagesForCategory(categoryId, {
          ...options,
          delayBetweenPages,
          sendToAPI,
          minPrice,
          maxPrice,
        });

        priceRangeResults.push({
          minPrice,
          maxPrice,
          sites: result.totalSites,
          pages: result.totalPages,
        });

        totalSites += result.totalSites;
        totalPages += result.totalPages;

        this.logger.log(`Price range ${minPrice}-${maxPrice}€: ${result.totalSites} sites from ${result.totalPages} pages`);

      } catch (error) {
        this.logger.error(`Failed to scrape price range ${minPrice}-${maxPrice}€: ${error.message}`);
        priceRangeResults.push({
          minPrice,
          maxPrice,
          sites: 0,
          pages: 0,
        });
      }

      // Delay between price ranges (except for last one)
      if (i < priceRanges.length - 1) {
        this.logger.log(`Waiting ${delayBetweenPriceRanges / 1000}s before next price range...`);
        await new Promise(resolve => setTimeout(resolve, delayBetweenPriceRanges));
      }
    }

    this.logger.log('');
    this.logger.log('#'.repeat(60));
    this.logger.log(`COMPLETED ALL PRICE RANGES FOR: ${categoryId}`);
    this.logger.log(`Total price ranges scraped: ${priceRangeResults.length}`);
    this.logger.log(`Total pages scraped: ${totalPages}`);
    this.logger.log(`Total sites saved: ${totalSites}`);
    this.logger.log('#'.repeat(60));

    return { totalSites, totalPages, priceRangeResults };
  }

  /**
   * Scrape all categories sequentially
   * - With dateFilter: scrapes each category with date filter (no price ranges)
   * - Without dateFilter: loops through all price ranges for each category
   */
  async scrapeAllCategories(options?: {
    delayBetweenPages?: number;
    delayBetweenPriceRanges?: number;
    delayBetweenCategories?: number;
    sendToAPI?: boolean;
    categories?: RocketLinksCategory[];
    priceRanges?: Array<[number, number]>;
    dateFilter?: string; // If set, use date filter instead of price ranges
  }): Promise<{
    totalCategories: number;
    totalSites: number;
    categoryResults: Array<{ category: string; sites: number; pages: number }>;
  }> {
    const {
      delayBetweenPages = 2000,
      delayBetweenPriceRanges = 3000,
      delayBetweenCategories = 5000,
      sendToAPI = true,
      categories = ROCKETLINKS_CATEGORIES,
      priceRanges = PRICE_RANGES,
      dateFilter,
    } = options || {};

    this.logger.log('='.repeat(60));
    if (dateFilter) {
      this.logger.log('SCRAPING ALL ROCKETLINKS CATEGORIES WITH DATE FILTER');
      this.logger.log(`Total categories: ${categories.length}`);
      this.logger.log(`Date filter: ${dateFilter}`);
    } else {
      this.logger.log('SCRAPING ALL ROCKETLINKS CATEGORIES WITH PRICE RANGES');
      this.logger.log(`Total categories: ${categories.length}`);
      this.logger.log(`Price ranges: ${priceRanges.length} (${priceRanges[0][0]}-${priceRanges[priceRanges.length - 1][1]}€)`);
    }
    this.logger.log('='.repeat(60));

    const categoryResults: Array<{ category: string; sites: number; pages: number }> = [];
    let totalSites = 0;

    for (let i = 0; i < categories.length; i++) {
      const category = categories[i];

      this.logger.log('');
      this.logger.log('*'.repeat(60));
      this.logger.log(`CATEGORY ${i + 1}/${categories.length}: ${category.name} (${category.id})`);
      this.logger.log('*'.repeat(60));

      try {
        if (dateFilter) {
          // Date mode: scrape directly without price ranges
          const result = await this.scrapeAllPagesForCategory(category.id, {
            delayBetweenPages,
            sendToAPI,
            dateFilter,
          });

          categoryResults.push({
            category: category.id,
            sites: result.totalSites,
            pages: result.totalPages,
          });

          totalSites += result.totalSites;

          this.logger.log(`Category ${category.id} complete: ${result.totalSites} sites from ${result.totalPages} pages`);
        } else {
          // Price range mode: scrape all price ranges for this category
          const result = await this.scrapeAllPriceRangesForCategory(category.id, {
            delayBetweenPages,
            delayBetweenPriceRanges,
            sendToAPI,
            priceRanges,
          });

          categoryResults.push({
            category: category.id,
            sites: result.totalSites,
            pages: result.totalPages,
          });

          totalSites += result.totalSites;

          this.logger.log(`Category ${category.id} complete: ${result.totalSites} sites from ${result.totalPages} pages across ${result.priceRangeResults.length} price ranges`);
        }

      } catch (error) {
        this.logger.error(`Failed to scrape category ${category.id}: ${error.message}`);
        categoryResults.push({
          category: category.id,
          sites: 0,
          pages: 0,
        });
      }

      // Delay between categories (except for last one)
      if (i < categories.length - 1) {
        this.logger.log(`Waiting ${delayBetweenCategories / 1000}s before next category...`);
        await new Promise(resolve => setTimeout(resolve, delayBetweenCategories));
      }
    }

    this.logger.log('');
    this.logger.log('='.repeat(60));
    this.logger.log('ALL CATEGORIES COMPLETED');
    this.logger.log('='.repeat(60));
    this.logger.log(`Total categories scraped: ${categoryResults.length}`);
    this.logger.log(`Total sites saved: ${totalSites}`);
    this.logger.log('');
    this.logger.log('Results by category:');
    categoryResults.forEach((r, i) => {
      this.logger.log(`  ${i + 1}. ${r.category}: ${r.sites} sites (${r.pages} pages)`);
    });
    this.logger.log('='.repeat(60));

    return {
      totalCategories: categoryResults.length,
      totalSites,
      categoryResults,
    };
  }

  /**
   * Clean domain: remove https://, http://, and www. prefix
   */
  private cleanDomain(domain: string): string {
    if (!domain) return domain;
    return domain
      .replace(/^https?:\/\//i, '')  // Remove http:// or https://
      .replace(/^www\./i, '');        // Remove www.
  }

  /**
   * Transform raw site data to database format
   * Matches the expected backend API format
   */
  transformSiteForDB(raw: RocketLinksSiteRaw): any {
    const today = new Date().toISOString().split('T')[0]; // "2025-09-11" format
    const domain = this.cleanDomain(raw.domain || '');

    return {
      name: domain,
      url: domain ? `https://${domain}` : null,
      tf: raw.tf || null,
      cf: raw.cf || null,
      bl: raw.backlinks || null,
      domain_ref: raw.refDomains || null,
      keywords: raw.semrushKeywords || raw.ahrefsKeywords || null,
      traffic: raw.semrushTraffic || raw.ahrefsTraffic || null,
      da: raw.da || null,
      articles_price: raw.price || null,
      price_recommande: raw.priceRecommended || null, // String like "4 011 € pour 1200 mots"
      traffic_sw: raw.similarwebTraffic || null,
      category: raw.siteCategories || null,
      entry_date: today,
      link_ahref: domain ? `https://app.ahrefs.com/site-explorer/overview/v2/subdomains/live?target=${domain}` : null,
      provider: 'Rocketlinks',
      // bqs_score and bqs_score_info will be added by BQSCalculatorService
    };
  }

  /**
   * Transform array of raw sites to database format
   */
  transformSitesForDB(sites: RocketLinksSiteRaw[]): any[] {
    return sites.map(site => this.transformSiteForDB(site));
  }

  /**
   * Send scraped sites to database API
   */
  async sendToDatabase(sites: RocketLinksSiteRaw[]): Promise<void> {
    if (sites.length === 0) {
      this.logger.warn('No sites to send to database');
      return;
    }

    const transformedSites = this.transformSitesForDB(sites);

    // Calculate BQS scores
    this.logger.log(`Calculating BQS scores for ${transformedSites.length} sites...`);
    const sitesWithBQS = this.bqsCalculator.addBQSScores(transformedSites);

    this.logger.log(`Sending ${sitesWithBQS.length} sites to database...`);

    try {
      await this.databaseService.addSites(sitesWithBQS);
      this.logger.log(`Successfully sent ${sitesWithBQS.length} sites to database`);
    } catch (error) {
      this.logger.error(`Failed to send sites to database: ${error.message}`);
      throw error;
    }
  }

  /**
   * Transform raw site data to standardized format (legacy)
   */
  transformSite(raw: RocketLinksSiteRaw): RocketLinksSite {
    return {
      name: raw.domain || raw.url || 'Unknown',
      provider: 'Rocketlinks',
      domain: raw.domain,
      url: raw.url,
      status: undefined,
      price: raw.price,
      traffic: raw.semrushTraffic,
      tf: raw.tf,
      cf: raw.cf,
      da: raw.da,
      dr: raw.ahrefsDR,
      domain_ref: raw.refDomains,
      bl: raw.backlinks,
      category: raw.siteCategories,
      link_ahref: raw.domain ? `https://ahrefs.com/site-explorer/overview/v2/subdomains/live?target=${raw.domain}` : '',
      entry_date: new Date().toISOString().split('T')[0],
    };
  }

  /**
   * Save scraped data to JSON file
   */
  async saveToFile(data: any[], filename?: string): Promise<string> {
    try {
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .split('T')[0] +
        '_' +
        new Date().toTimeString().split(' ')[0].replace(/:/g, '');
      const file = filename || `rocketlinks_data_${timestamp}.json`;
      const filepath = path.join(process.cwd(), 'data', file);

      // Ensure data directory exists
      await fs.mkdir(path.join(process.cwd(), 'data'), { recursive: true });

      await fs.writeFile(filepath, JSON.stringify(data, null, 2), 'utf-8');

      this.logger.log(`Data saved to: ${filepath}`);
      return filepath;
    } catch (error) {
      this.logger.error(`Error saving to file: ${error.message}`);
      throw error;
    }
  }
}
