import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LightpandaService } from '../../../common/lightpanda.service';
import { BQSCalculatorService } from '../../../scoring/bqs-calculator.service';
import { DatabaseService } from '../../../common/database.service';
import {
  GetfluenceSiteRaw,
  GetfluenceSite,
} from '../interfaces/getfluence-site.interface';
import type { Page, BrowserContext } from 'playwright-core';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Getfluence Scraper Service
 *
 * Main orchestrator that coordinates:
 * - Browser-based authentication to Getfluence
 * - Site scraping
 * - Data transformation
 * - BQS scoring
 * - Data persistence
 */
@Injectable()
export class GetfluenceScraperService {
  private readonly logger = new Logger(GetfluenceScraperService.name);
  private readonly baseUrl: string;
  private readonly email: string;
  private readonly password: string;
  private isLoggedIn: boolean = false;
  private context: BrowserContext | null = null;
  private pageNavigationCount: number = 0;
  private readonly PAGE_RECYCLE_THRESHOLD = 50;

  constructor(
    private readonly lightpanda: LightpandaService,
    private readonly configService: ConfigService,
    private readonly bqsCalculator: BQSCalculatorService,
    private readonly databaseService: DatabaseService,
  ) {
    this.baseUrl = this.configService.get<string>(
      'GETFLUENCE_URL',
      'https://app.getfluence.com',
    );
    this.email = this.configService.get<string>('GETFLUENCE_EMAIL', '');
    this.password = this.configService.get<string>('GETFLUENCE_PASSWORD', '');
  }

  /**
   * Random delay between min and max ms (human-like)
   */
  private randomDelay(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min)) + min;
  }

  /**
   * Human-like typing: types text character by character with random delays
   */
  private async humanType(page: Page, selector: string, text: string): Promise<void> {
    // Click the field first
    await page.click(selector);
    await page.waitForTimeout(this.randomDelay(200, 500));

    // Clear any existing value
    await page.fill(selector, '');
    await page.waitForTimeout(this.randomDelay(100, 300));

    // Type character by character
    for (const char of text) {
      await page.type(selector, char, { delay: this.randomDelay(50, 150) });
    }
  }

  /**
   * Simulate human-like mouse movement and scroll on a page
   */
  private async simulateHumanBehavior(page: Page): Promise<void> {
    try {
      // Random initial delay (1-3 seconds)
      await page.waitForTimeout(this.randomDelay(1000, 3000));

      // Random mouse movements
      const viewport = page.viewportSize();
      if (viewport) {
        const moves = this.randomDelay(2, 5);
        for (let i = 0; i < moves; i++) {
          const x = Math.floor(Math.random() * viewport.width);
          const y = Math.floor(Math.random() * viewport.height);
          await page.mouse.move(x, y, { steps: this.randomDelay(5, 15) });
          await page.waitForTimeout(this.randomDelay(200, 600));
        }
      }

      // Random scroll
      await page.evaluate(() => {
        window.scrollBy(0, Math.floor(Math.random() * 300) + 100);
      });
      await page.waitForTimeout(this.randomDelay(300, 800));

    } catch (error) {
      this.logger.warn(`Error simulating human behavior: ${error.message}`);
    }
  }

  /**
   * Login to Getfluence using browser automation with human-like behavior
   */
  async login(): Promise<boolean> {
    this.logger.log('='.repeat(60));
    this.logger.log('GETFLUENCE LOGIN');
    this.logger.log('='.repeat(60));

    if (!this.email || !this.password) {
      throw new Error(
        'Getfluence credentials not found. Please set GETFLUENCE_EMAIL and GETFLUENCE_PASSWORD in .env',
      );
    }

    this.logger.log(`Logging in as: ${this.email}`);

    try {
      // Create a persistent browser context for the session
      this.context = await this.lightpanda.createContext();
      const page = await this.context.newPage();

      // Navigate to login page
      this.logger.log('Navigating to login page...');
      await page.goto(`${this.baseUrl}/en-US/login`, {
        waitUntil: 'networkidle',
        timeout: 30000,
      });

      // Human-like: wait for page to fully render, simulate looking at the page
      await page.waitForTimeout(this.randomDelay(2000, 4000));

      // Log current URL
      this.logger.log(`Current URL: ${page.url()}`);

      // Simulate human looking at the page before interacting
      await this.simulateHumanBehavior(page);

      // Wait for email input field
      this.logger.log('Looking for login form...');

      const emailSelectors = [
        'input[name="email"]',
        'input[type="email"]',
        '#email',
        'input[placeholder*="email" i]',
      ];

      let emailInput = null;
      let emailSelector = '';
      for (const sel of emailSelectors) {
        try {
          emailInput = await page.waitForSelector(sel, { timeout: 5000 });
          if (emailInput) {
            emailSelector = sel;
            this.logger.log(`Found email input with selector: ${sel}`);
            break;
          }
        } catch {
          // Try next selector
        }
      }

      if (!emailInput) {
        const pageContent = await page.content();
        this.logger.error('Could not find email input. Page HTML length: ' + pageContent.length);
        throw new Error('Could not find email input field on login page');
      }

      // Find password input
      const passwordSelectors = [
        'input[name="password"]',
        'input[type="password"]',
        '#password',
      ];

      let passwordInput = null;
      let passwordSelector = '';
      for (const sel of passwordSelectors) {
        try {
          passwordInput = await page.waitForSelector(sel, { timeout: 5000 });
          if (passwordInput) {
            passwordSelector = sel;
            this.logger.log(`Found password input with selector: ${sel}`);
            break;
          }
        } catch {
          // Try next selector
        }
      }

      if (!passwordInput) {
        throw new Error('Could not find password input field on login page');
      }

      // Human-like: move mouse towards email field area first
      this.logger.log('Entering credentials (human-like typing)...');
      const emailBox = await emailInput.boundingBox();
      if (emailBox) {
        await page.mouse.move(
          emailBox.x + emailBox.width / 2 + this.randomDelay(-10, 10),
          emailBox.y + emailBox.height / 2 + this.randomDelay(-5, 5),
          { steps: this.randomDelay(10, 25) },
        );
        await page.waitForTimeout(this.randomDelay(200, 500));
      }

      // Type email character by character
      await this.humanType(page, emailSelector, this.email);

      // Human-like pause between fields (like moving hand to type password)
      await page.waitForTimeout(this.randomDelay(500, 1200));

      // Move mouse towards password field
      const passwordBox = await passwordInput.boundingBox();
      if (passwordBox) {
        await page.mouse.move(
          passwordBox.x + passwordBox.width / 2 + this.randomDelay(-10, 10),
          passwordBox.y + passwordBox.height / 2 + this.randomDelay(-5, 5),
          { steps: this.randomDelay(10, 25) },
        );
        await page.waitForTimeout(this.randomDelay(200, 500));
      }

      // Type password character by character
      await this.humanType(page, passwordSelector, this.password);

      // Human-like pause before clicking submit (like reading the form)
      await page.waitForTimeout(this.randomDelay(800, 1500));

      // Find submit button
      const submitSelectors = [
        'button[type="submit"]',
        'input[type="submit"]',
        'button:has-text("Login")',
        'button:has-text("Log in")',
        'button:has-text("Sign in")',
        'button:has-text("Connexion")',
        'button:has-text("Se connecter")',
        'form button',
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
        throw new Error('Could not find submit button on login page');
      }

      // Human-like: move mouse to button before clicking
      const buttonBox = await submitButton.boundingBox();
      if (buttonBox) {
        await page.mouse.move(
          buttonBox.x + buttonBox.width / 2 + this.randomDelay(-5, 5),
          buttonBox.y + buttonBox.height / 2 + this.randomDelay(-3, 3),
          { steps: this.randomDelay(10, 20) },
        );
        await page.waitForTimeout(this.randomDelay(200, 500));
      }

      // Click login button
      this.logger.log('Submitting login form...');
      await submitButton.click();

      // Wait for navigation after login (human-like patience)
      await page.waitForTimeout(this.randomDelay(4000, 6000));

      // Check if login was successful
      const currentUrl = page.url();
      this.logger.log(`Post-login URL: ${currentUrl}`);

      // Check if we're still on login page
      if (currentUrl.includes('/login')) {
        // Check for error messages
        const errorSelectors = ['.error', '.alert-danger', '.alert-error', '[class*="error"]', '[role="alert"]'];
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
      this.logger.log('Successfully logged in to Getfluence!');

      // Dismiss cookie banner if present
      try {
        const cookieAccept = await page.$('#hs-eu-cookie-confirmation-button-group-accept, #hs-eu-confirmation-button');
        if (cookieAccept) {
          this.logger.log('Dismissing cookie banner...');
          await cookieAccept.click();
          await page.waitForTimeout(this.randomDelay(1000, 2000));
        }
      } catch {
        // No cookie banner, that's fine
      }

      // Simulate human looking at the dashboard after login
      await this.simulateHumanBehavior(page);

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
    this.logger.log('Logged out from Getfluence');
  }

  /**
   * Human-like click on an element: move mouse to it, pause, then click
   */
  private async humanClick(page: Page, element: any, force: boolean = false): Promise<void> {
    const box = await element.boundingBox();
    if (box) {
      await page.mouse.move(
        box.x + box.width / 2 + this.randomDelay(-3, 3),
        box.y + box.height / 2 + this.randomDelay(-3, 3),
        { steps: this.randomDelay(10, 20) },
      );
      await page.waitForTimeout(this.randomDelay(200, 500));
    }
    await element.click({ force });
  }

  /**
   * Open the Categories dropdown panel.
   * Returns true if the panel is visible.
   */
  private async openCategoriesDropdown(page: Page, retries: number = 3): Promise<boolean> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await page.waitForSelector('div#start', { timeout: 10000 });
        await page.waitForTimeout(this.randomDelay(800, 1500));

        // Check if panel is already visible (from previous open)
        const alreadyOpen = await page.$('div.itemPanel[style*="visibility: visible"]');
        if (alreadyOpen) {
          return true;
        }

        // Click the Categories button in div#start (nth-child(2)) to open the popup
        const categoriesButton = await page.$('div#start > div:nth-child(2) button');
        if (!categoriesButton) {
          this.logger.warn('Could not find Categories button');
          return false;
        }

        await this.humanClick(page, categoriesButton);
        await page.waitForTimeout(this.randomDelay(1500, 2500));

        // Inside the popup, click the first accordion item ("Categories"), not the second ("Topical Trust Flow")
        const categoriesAccordion = await page.$('.css-1qm3c90-itemBtn:first-child');
        if (!categoriesAccordion) {
          const firstItem = await page.$('.item:first-child .css-1qm3c90-itemBtn');
          if (firstItem) {
            await this.humanClick(page, firstItem);
          } else {
            this.logger.warn('Could not find Categories accordion item');
            if (attempt < retries) continue;
            return false;
          }
        } else {
          await this.humanClick(page, categoriesAccordion);
        }
        await page.waitForTimeout(this.randomDelay(1500, 2500));

        await page.waitForSelector('div.itemPanel[style*="visibility: visible"]', { timeout: 8000 });
        return true;
      } catch {
        this.logger.warn(`Attempt ${attempt}/${retries} to open Categories dropdown failed`);
        if (attempt < retries) {
          // Close any partially open popup before retrying
          const closeBtn = await page.$('div#start > div:nth-child(2) button');
          if (closeBtn) {
            await closeBtn.click({ force: true });
            await page.waitForTimeout(this.randomDelay(1000, 2000));
          }
        }
      }
    }
    return false;
  }

  /**
   * Get all category names and their checkbox elements from the open dropdown
   */
  private async getCategoryNames(page: Page): Promise<string[]> {
    return page.evaluate(() => {
      const panel = document.querySelector('div.itemPanel[style*="visibility: visible"]');
      if (!panel) return [];

      const rows = panel.querySelectorAll('[class*="lpm1a6-root"]');
      const names: string[] = [];

      rows.forEach((row) => {
        const span = row.querySelector('span');
        if (span) {
          const name = span.textContent?.trim();
          if (name) names.push(name);
        }
      });

      return names;
    });
  }

  /**
   * Click a category checkbox by its text label in the open dropdown.
   * Scrolls the item into view if needed.
   */
  private async clickCategoryByName(page: Page, categoryName: string): Promise<boolean> {
    // Find the checkbox row that contains this category text
    const checkbox = await page.evaluateHandle((name) => {
      const panel = document.querySelector('div.itemPanel[style*="visibility: visible"]');
      if (!panel) return null;

      const rows = panel.querySelectorAll('[class*="lpm1a6-root"]');
      for (const row of rows) {
        const span = row.querySelector('span');
        if (span && span.textContent?.trim() === name) {
          // Return the clickable div[tabindex="0"] checkbox
          const cb = row.querySelector('div[tabindex="0"]');
          return cb;
        }
      }
      return null;
    }, categoryName);

    const element = checkbox.asElement();
    if (!element) {
      this.logger.warn(`Could not find checkbox for category: ${categoryName}`);
      return false;
    }

    // Scroll into view first
    await element.scrollIntoViewIfNeeded();
    await page.waitForTimeout(this.randomDelay(300, 600));

    await this.humanClick(page, element);
    await page.waitForTimeout(this.randomDelay(1500, 2500));
    return true;
  }

  /**
   * Scrape all categories: loop through each category, scrape all pages, then move to next.
   * For each category:
   *   1. Open Categories dropdown
   *   2. Click the category checkbox (selects it)
   *   3. Scrape all pages with pagination
   *   4. Re-open Categories dropdown
   *   5. Uncheck current category (click same checkbox again)
   *   6. Move to next category
   */
  async scrapeAllCategories(options?: {
    sendToAPI?: boolean;
    maxPages?: number; // 0 = unlimited (default), >0 = stop after N pages per category
  }): Promise<{ totalSites: number; categoryResults: Array<{ category: string; sites: number }> }> {
    const { sendToAPI = true, maxPages = 0 } = options || {};

    if (!this.isLoggedIn || !this.context) {
      throw new Error('Not logged in. Please call login() first.');
    }

    const pages = this.context.pages();
    const page = pages[0] || await this.context.newPage();

    // Step 1: Open dropdown and get all category names
    this.logger.log('Opening Categories dropdown to read all categories...');
    const opened = await this.openCategoriesDropdown(page);
    if (!opened) {
      throw new Error('Could not open Categories dropdown');
    }

    const allCategoryNames = await this.getCategoryNames(page);
    this.logger.log(`Found ${allCategoryNames.length} categories`);

    // Step 2: Loop through each category
    // Panel is already open from the initial read — use it for the first category
    const categoryResults: Array<{ category: string; sites: number }> = [];
    let totalSites = 0;
    const allSites: GetfluenceSiteRaw[] = [];
    let previousCategoryName: string | null = null;

    for (let i = 0; i < allCategoryNames.length; i++) {
      const categoryName = allCategoryNames[i];

      this.logger.log('');
      this.logger.log('='.repeat(60));
      this.logger.log(`CATEGORY ${i + 1}/${allCategoryNames.length}: ${categoryName}`);
      this.logger.log('='.repeat(60));

      try {
        // For categories after the first, reopen the dropdown
        if (i > 0) {
          const panelOpened = await this.openCategoriesDropdown(page);
          if (!panelOpened) {
            this.logger.warn(`Could not open dropdown for ${categoryName}, skipping`);
            categoryResults.push({ category: categoryName, sites: 0 });
            continue;
          }

          // Remove all selected category tags first (✕ buttons inside rti--tag spans)
          if (previousCategoryName) {
            this.logger.log(`Removing previous categories...`);
            let removed = 0;
            while (true) {
              const removeButton = await page.$('.rti--container span.rti--tag button');
              if (!removeButton) break;
              await removeButton.click({ force: true });
              await page.waitForTimeout(this.randomDelay(800, 1500));
              removed++;
              if (removed > 10) break; // safety limit
            }
            if (removed > 0) {
              this.logger.log(`Removed ${removed} category tag(s)`);
              await page.waitForTimeout(this.randomDelay(500, 1000));
            }
          }
        }

        // Click this category (panel is already open)
        const selected = await this.clickCategoryByName(page, categoryName);
        if (!selected) {
          this.logger.warn(`Could not select ${categoryName}, skipping`);
          categoryResults.push({ category: categoryName, sites: 0 });
          continue;
        }
        this.logger.log(`Selected: ${categoryName}`);

        // Scrape all pages for this category (sends to DB after each page if enabled)
        const sites = await this.scrapeAllPages(page, maxPages, sendToAPI, categoryName);
        this.logger.log(`${categoryName}: ${sites.length} sites scraped`);

        allSites.push(...sites);
        totalSites += sites.length;
        categoryResults.push({ category: categoryName, sites: sites.length });

        // Remember this category so we uncheck it next iteration
        previousCategoryName = categoryName;

        // Delay between categories
        await page.waitForTimeout(this.randomDelay(2000, 4000));

      } catch (error) {
        this.logger.error(`Error scraping ${categoryName}: ${error.message}`);
        categoryResults.push({ category: categoryName, sites: 0 });
      }
    }

    // Save all sites to file
    if (allSites.length > 0) {
      await this.saveToFile(allSites);
    }

    // Final summary
    this.logger.log('');
    this.logger.log('='.repeat(60));
    this.logger.log('ALL CATEGORIES COMPLETED');
    this.logger.log('='.repeat(60));
    this.logger.log(`Total categories: ${categoryResults.length}`);
    this.logger.log(`Total sites: ${totalSites}`);
    this.logger.log('');
    categoryResults.forEach((r, idx) => {
      this.logger.log(`  ${idx + 1}. ${r.category}: ${r.sites} sites`);
    });
    this.logger.log('='.repeat(60));

    return { totalSites, categoryResults };
  }

  /**
   * Navigate to a page within the logged-in session with human-like behavior
   */
  async navigateTo(urlPath: string): Promise<Page> {
    if (!this.isLoggedIn || !this.context) {
      throw new Error('Not logged in. Please call login() first.');
    }

    // Periodically recycle the page to prevent memory leaks
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

    const url = `${this.baseUrl}${urlPath}`;
    this.logger.log(`Navigating to: ${url}`);

    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    // Simulate human looking at the new page
    await page.waitForTimeout(this.randomDelay(1500, 3000));

    return page;
  }

  /**
   * Scrape all pages of results: scrape current table, click "next page", repeat until disabled
   */
  async scrapeAllPages(page: Page, maxPages: number = 0, sendToAPI: boolean = false, categoryName?: string): Promise<GetfluenceSiteRaw[]> {
    const allSites: GetfluenceSiteRaw[] = [];
    let pageNum = 1;

    while (true) {
      // Stop if we hit the max pages limit (0 = unlimited)
      if (maxPages > 0 && pageNum > maxPages) {
        this.logger.log(`Reached max pages limit (${maxPages}). Stopping.`);
        break;
      }
      // Wait for table to load
      this.logger.log(`Waiting for table on page ${pageNum}...`);
      try {
        await page.waitForSelector('table[style*="width: 100%"] tbody tr td[id*="catalog_offer"]', { timeout: 15000 });
        await page.waitForTimeout(this.randomDelay(2000, 3000));
      } catch {
        this.logger.log(`No table found on page ${pageNum}. Stopping.`);
        break;
      }

      // Scrape current page
      const sites = await this.scrapeSitesFromTable(page);
      this.logger.log(`Page ${pageNum}: scraped ${sites.length} sites`);

      if (sites.length === 0) {
        this.logger.log('No sites found. Stopping pagination.');
        break;
      }

      // Tag each site with category
      if (categoryName) {
        sites.forEach(s => s.category = categoryName);
      }

      allSites.push(...sites);

      // Save to database immediately after each page
      if (sendToAPI && sites.length > 0) {
        try {
          await this.sendToDatabase(sites);
          this.logger.log(`Page ${pageNum}: Saved ${sites.length} sites to database`);
        } catch (error) {
          this.logger.error(`Page ${pageNum}: Failed to save to database: ${error.message}`);
        }
      }

      // Check if "next page" button exists and is NOT disabled
      const nextButton = await page.$('button[aria-label="next page"]:not([disabled])');
      if (!nextButton) {
        this.logger.log('Next page button disabled or not found. Last page reached.');
        break;
      }

      // Human-like: move mouse to next button and click
      const btnBox = await nextButton.boundingBox();
      if (btnBox) {
        await page.mouse.move(
          btnBox.x + btnBox.width / 2 + this.randomDelay(-3, 3),
          btnBox.y + btnBox.height / 2 + this.randomDelay(-3, 3),
          { steps: this.randomDelay(10, 20) },
        );
        await page.waitForTimeout(this.randomDelay(300, 600));
      }

      this.logger.log(`Clicking next page (going to page ${pageNum + 1})...`);
      await nextButton.click({ force: true });
      await page.waitForTimeout(this.randomDelay(2000, 4000));

      pageNum++;
    }

    this.logger.log(`Pagination complete: ${allSites.length} total sites across ${pageNum} pages`);
    return allSites;
  }

  /**
   * Scrape sites from the Getfluence catalog table
   * Each row has td cells with ids like: td-/api/offers/{id}/catalog_{column}
   * Columns: offer (site name), organic_traffic, monthly_visits, da, tf, cf, price, etc.
   */
  async scrapeSitesFromTable(page: Page): Promise<GetfluenceSiteRaw[]> {
    this.logger.log('Scraping sites from table...');

    const sites = await page.evaluate(() => {
      const rows = document.querySelectorAll('table[style*="width: 100%"] tbody tr');
      const results: any[] = [];

      const getText = (el: Element | null): string => {
        if (!el) return '';
        return el.textContent?.trim().replace(/\s+/g, ' ') || '';
      };

      const cleanNumber = (text: string): number | undefined => {
        if (!text) return undefined;
        const cleaned = text.replace(/[^0-9.-]/g, '');
        const num = parseFloat(cleaned);
        return isNaN(num) ? undefined : num;
      };

      rows.forEach((row) => {
        // Find offer cell (site name) - td with id containing "catalog_offer"
        const offerCell = row.querySelector('td[id*="catalog_offer"]');
        const priceCell = row.querySelector('td[id*="catalog_price"]');
        const trafficCell = row.querySelector('td[id*="catalog_organic_traffic"]');
        const monthlyVisitsCell = row.querySelector('td[id*="catalog_monthly_visits"]');
        const daCell = row.querySelector('td[id*="catalog_da"]');
        const tfCell = row.querySelector('td[id*="catalog_tf"]');
        const cfCell = row.querySelector('td[id*="catalog_cf"]');

        const siteName = getText(offerCell);
        const priceText = getText(priceCell);

        if (!siteName) return; // Skip rows without a site name

        const site = {
          domain: siteName,
          url: `https://${siteName}`,
          traffic: cleanNumber(getText(trafficCell)),
          monthlyVisits: cleanNumber(getText(monthlyVisitsCell)),
          da: cleanNumber(getText(daCell)),
          tf: cleanNumber(getText(tfCell)),
          cf: cleanNumber(getText(cfCell)),
          price: cleanNumber(priceText),
        };

        results.push(site);
      });

      return results;
    });

    this.logger.log(`Found ${sites.length} sites in table`);
    return sites;
  }

  /**
   * Clean domain: remove https://, http://, and www. prefix
   */
  private cleanDomain(domain: string): string {
    if (!domain) return domain;
    return domain
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '');
  }

  /**
   * Transform raw site data to database format
   */
  transformSiteForDB(raw: GetfluenceSiteRaw): any {
    const today = new Date().toISOString().split('T')[0];
    const domain = this.cleanDomain(raw.domain || '');

    return {
      name: domain,
      url: domain ? `https://${domain}` : null,
      tf: raw.tf || null,
      cf: raw.cf || null,
      bl: raw.backlinks || null,
      domain_ref: raw.refDomains || null,
      keywords: raw.keywords || null,
      traffic: raw.traffic || null,
      da: raw.da || null,
      articles_price: raw.price || null,
      category: raw.category || null,
      entry_date: today,
      link_ahref: domain ? `https://app.ahrefs.com/site-explorer/overview/v2/subdomains/live?target=${domain}` : null,
      provider: 'Getfluence',
    };
  }

  /**
   * Transform array of raw sites to database format
   */
  transformSitesForDB(sites: GetfluenceSiteRaw[]): any[] {
    return sites.map(site => this.transformSiteForDB(site));
  }

  /**
   * Send scraped sites to database API
   */
  async sendToDatabase(sites: GetfluenceSiteRaw[]): Promise<void> {
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
      const file = filename || `getfluence_data_${timestamp}.json`;
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
