import { Injectable, Logger } from '@nestjs/common';
import { PaperClubAPIService } from './paperclub-api.service';
import { DataTransformerService } from './data-transformer.service';
import { BQSCalculatorService } from '../../../scoring/bqs-calculator.service';
import { DatabaseService } from '../../../common/database.service';
import { PAPERCLUB_CATEGORIES, Category } from '../../../config/categories.config';
import { PaperClubSite } from '../interfaces/paperclub-site.interface';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Paper.club Scraper Service
 *
 * Main orchestrator that coordinates:
 * - API authentication
 * - Category scraping with pagination
 * - Data transformation
 * - BQS scoring
 * - Data persistence (sends to API after each category)
 */
@Injectable()
export class PaperClubScraperService {
  private readonly logger = new Logger(PaperClubScraperService.name);

  constructor(
    private readonly apiService: PaperClubAPIService,
    private readonly transformerService: DataTransformerService,
    private readonly bqsCalculator: BQSCalculatorService,
    private readonly databaseService: DatabaseService,
  ) {}

  /**
   * Scrape all categories and return structured data
   * Sends data to API after each category is scraped
   */
  async scrapeAllCategories(options?: {
    calculateBQS?: boolean;
    saveToFile?: boolean;
    sendToAPI?: boolean;
    categories?: Category[];
  }): Promise<{
    total: number;
    categories: any[];
    failed: Array<{ category: string; category_id: string; error: string }>;
  }> {
    const {
      calculateBQS = true,
      saveToFile = true,
      sendToAPI = true,
      categories = PAPERCLUB_CATEGORIES,
    } = options || {};

    this.logger.log('='.repeat(60));
    this.logger.log('FETCHING PAPERCLUB DATA');
    this.logger.log('='.repeat(60));
    this.logger.log(`Send to API after each category: ${sendToAPI ? 'YES' : 'NO'}`);
    this.logger.log('');

    const allData = [];
    const failed: Array<{ category: string; category_id: string; error: string }> = [];

    try {
      // Authenticate first
      await this.apiService.authenticate();

      // Process each category sequentially
      for (const category of categories) {
        try {
          const categoryData = await this.scrapeCategory(
            category,
            calculateBQS,
            sendToAPI, // Send to API immediately after each category
          );
          allData.push(categoryData);
        } catch (error) {
          this.logger.error(
            `Failed to scrape category ${category.name}: ${error.message}`,
          );
          failed.push({ category: category.name, category_id: category.id, error: error.message });
        }
      }

      // Save to file if requested
      if (saveToFile) {
        await this.saveToFile(allData);
      }

      // Print summary
      this.printSummary(allData);

      return {
        total: allData.reduce((sum, cat) => sum + cat.total, 0),
        categories: allData,
        failed,
      };
    } catch (error) {
      this.logger.error(`Error in scrapeAllCategories: ${error.message}`);
      throw error;
    }
  }

  /**
   * Scrape a single category
   */
  async scrapeCategory(
    category: Category,
    calculateBQS: boolean = true,
    sendToAPI: boolean = true,
  ): Promise<any> {
    this.logger.log(`Starting fetch for: ${category.name}`);

    try {
      // Fetch all pages for this category
      const rawSites = await this.apiService.fetchAllCategoryPages(
        category.id,
        category.name,
      );

      // Transform raw data to structured format
      const transformedSites =
        this.transformerService.transformSites(rawSites);

      // Calculate BQS scores if requested
      let sitesWithScores = transformedSites;
      if (calculateBQS) {
        sitesWithScores = this.bqsCalculator.addBQSScores(transformedSites);
      }

      // Send to API immediately after scraping this category
      if (sendToAPI && sitesWithScores.length > 0) {
        try {
          this.logger.log(`Sending ${sitesWithScores.length} sites from ${category.name} to API...`);
          await this.databaseService.addSites(sitesWithScores);
          this.logger.log(`✓ Successfully sent ${category.name} data to API`);
        } catch (error) {
          this.logger.error(`✗ Failed to send ${category.name} to API: ${error.message}`);
          // Don't throw - continue with other categories
        }
      }

      return {
        category: category.name,
        category_id: category.id,
        sites: sitesWithScores,
        total: sitesWithScores.length,
      };
    } catch (error) {
      this.logger.error(`Error scraping category ${category.name}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Save scraped data to JSON file
   */
  private async saveToFile(data: any[]): Promise<string> {
    try {
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .split('T')[0] +
        '_' +
        new Date().toTimeString().split(' ')[0].replace(/:/g, '');
      const filename = `paperclub_data_${timestamp}.json`;
      const filepath = path.join(process.cwd(), 'data', filename);

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

  /**
   * Print summary of scraped data
   */
  private printSummary(data: any[]): void {
    this.logger.log('='.repeat(60));
    this.logger.log('SUMMARY');
    this.logger.log('='.repeat(60));

    for (const item of data) {
      this.logger.log(`  ${item.category}: ${item.total} sites`);
    }

    const total = data.reduce((sum, item) => sum + item.total, 0);
    this.logger.log(`\nTotal sites across all categories: ${total}`);
    this.logger.log('\nDone paperclub scraping');
  }

  /**
   * Get statistics about scraped data
   */
  getStatistics(data: any[]): {
    totalSites: number;
    averageBQS: number;
    qualityDistribution: Record<string, number>;
    topCategories: Array<{ category: string; count: number }>;
  } {
    const totalSites = data.reduce((sum, cat) => sum + cat.total, 0);

    // Flatten all sites
    const allSites = data.flatMap((cat) => cat.sites);

    // Calculate average BQS
    const bqsScores = allSites
      .filter((site) => site.bqs_score !== undefined)
      .map((site) => site.bqs_score);
    const averageBQS =
      bqsScores.length > 0
        ? bqsScores.reduce((a, b) => a + b, 0) / bqsScores.length
        : 0;

    // Quality distribution
    const qualityDistribution = {
      Excellent: 0,
      Good: 0,
      Fair: 0,
      Poor: 0,
    };

    allSites.forEach((site) => {
      if (site.bqs_score_info?.bqs_quality_tier) {
        qualityDistribution[site.bqs_score_info.bqs_quality_tier]++;
      }
    });

    // Top categories by site count
    const topCategories = data
      .map((cat) => ({
        category: cat.category,
        count: cat.total,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      totalSites,
      averageBQS: Math.round(averageBQS * 100) / 100,
      qualityDistribution,
      topCategories,
    };
  }
}
