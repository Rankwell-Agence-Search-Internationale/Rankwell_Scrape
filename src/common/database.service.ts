import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { PaperClubSite } from '../modules/paperclub/interfaces/paperclub-site.interface';

/**
 * Database Service
 *
 * Handles communication with the backend API for data persistence
 * Supports batch inserts and category-based deletions
 */
@Injectable()
export class DatabaseService {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly backendUrl: string;
  private readonly timeout: number;
  private readonly apiKey: string | undefined;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.backendUrl = this.configService.get<string>(
      'BACKEND_API_URL',
      'http://localhost:5000',
    );
    this.timeout = this.configService.get<number>(
      'BACKEND_API_TIMEOUT',
      30000,
    );
    this.apiKey =
      this.configService.get<string>('DASHBOARD_API_KEY') ||
      this.configService.get<string>('SCRAPING_RUNS_API_KEY');
  }

  /**
   * Add sites to database via backend API
   *
   * @param sites - Array of Paper.club sites or single site
   * @returns Success message
   */
  async addSites(
    sites: PaperClubSite | PaperClubSite[],
  ): Promise<{ success: boolean; message: string }> {
    const sitesArray = Array.isArray(sites) ? sites : [sites];
    const url = `${this.backendUrl}/backlinks/add`;

    try {
      this.logger.log(`Adding ${sitesArray.length} sites to database...`);
      this.logger.log(`Endpoint: ${url}`);
      this.logger.log(`Sample site: ${JSON.stringify(sitesArray[0])}`);

      const response = await firstValueFrom(
        this.httpService.post(url, sitesArray, {
          timeout: this.timeout,
          headers: {
            'Content-Type': 'application/json',
            // The Dashboard rejects writes without a key (401)
            ...(this.apiKey ? { 'X-Api-Key': this.apiKey } : {}),
          },
        }),
      );

      if (response.status === 200) {
        this.logger.log(
          `Successfully added ${sitesArray.length} sites to database`,
        );
        this.logger.log(`API Response: ${JSON.stringify(response.data)}`);
        return {
          success: true,
          message: `Added ${sitesArray.length} sites`,
        };
      } else {
        throw new Error(`API returned status: ${response.status}`);
      }
    } catch (error) {
      this.logger.error(`Failed to add sites to database: ${error.message}`);
      throw error;
    }
  }

  /**
   * Delete sites by category
   *
   * @param category - Category name
   * @param provider - Optional provider filter (defaults to 'Paper Club')
   */
  async deleteByCat(
    category: string,
    provider: string = 'Paper Club',
  ): Promise<{ success: boolean; message: string }> {
    const url = `${this.backendUrl}/backlinks/deleteByCategory`;

    try {
      this.logger.log(
        `Deleting all records for category: ${category} (${provider})`,
      );

      const response = await firstValueFrom(
        this.httpService.delete(url, {
          params: { category, provider },
          timeout: this.timeout,
          headers: this.apiKey ? { 'X-Api-Key': this.apiKey } : {},
        }),
      );

      if (response.status === 200) {
        this.logger.log(`Successfully deleted category: ${category}`);
        return {
          success: true,
          message: `Deleted category: ${category}`,
        };
      } else {
        throw new Error(`API returned status: ${response.status}`);
      }
    } catch (error) {
      this.logger.error(
        `Failed to delete category ${category}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Truncate all Paper.club data from database
   */
  async truncateTable(): Promise<{ success: boolean; message: string }> {
    const url = 'https://rankwell.one/api/backlinks/turncate_tables';

    try {
      this.logger.log('Truncating Paper Club table...');

      const response = await firstValueFrom(
        this.httpService.get(url, {
          timeout: this.timeout,
        }),
      );

      if (response.status === 200) {
        this.logger.log('Successfully truncated Paper Club table');
        return {
          success: true,
          message: 'Table truncated successfully',
        };
      } else {
        throw new Error(`API returned status: ${response.status}`);
      }
    } catch (error) {
      this.logger.error(`Failed to truncate table: ${error.message}`);
      throw error;
    }
  }

  /**
   * Batch add sites by category
   * Automatically adds all sites from a category result
   */
  async addCategoryBatch(categoryData: {
    category: string;
    category_id: string;
    sites: PaperClubSite[];
    total: number;
  }): Promise<{ success: boolean; message: string }> {
    if (!categoryData.sites || categoryData.sites.length === 0) {
      this.logger.warn(
        `No sites to add for category: ${categoryData.category}`,
      );
      return {
        success: true,
        message: 'No sites to add',
      };
    }

    return await this.addSites(categoryData.sites);
  }

  /**
   * Add all scraped data to database
   * Processes multiple categories in batch
   */
  async addAllScrapedData(scrapedData: {
    total: number;
    categories: Array<{
      category: string;
      category_id: string;
      sites: PaperClubSite[];
      total: number;
    }>;
  }): Promise<{ success: boolean; totalAdded: number; errors: string[] }> {
    let totalAdded = 0;
    const errors: string[] = [];

    this.logger.log(
      `Adding data from ${scrapedData.categories.length} categories to database...`,
    );

    for (const categoryData of scrapedData.categories) {
      try {
        const result = await this.addCategoryBatch(categoryData);
        if (result.success) {
          totalAdded += categoryData.total;
        }
      } catch (error) {
        errors.push(`${categoryData.category}: ${error.message}`);
      }
    }

    this.logger.log(
      `Database operation complete. Added ${totalAdded} sites with ${errors.length} errors`,
    );

    return {
      success: errors.length === 0,
      totalAdded,
      errors,
    };
  }
}
