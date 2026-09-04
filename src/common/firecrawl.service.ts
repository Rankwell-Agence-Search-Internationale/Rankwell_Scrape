import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

/**
 * Firecrawl Service
 *
 * Fallback fetcher for pages our own browser cannot reach. Some publishers
 * (DataDome, Cloudflare, plain 403s) block the scraper's IP while serving the
 * page normally to real visitors. Firecrawl rotates egress IPs and gets through.
 *
 * Returns raw HTML only. Markdown output is deliberately not used: it discards
 * `rel` attributes, and dofollow/nofollow classification depends on them.
 */
@Injectable()
export class FirecrawlService {
  private readonly logger = new Logger(FirecrawlService.name);
  private readonly apiKey: string | undefined;
  private readonly http: AxiosInstance;

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.get<string>('FIRECRAWL_API_KEY');

    this.http = axios.create({
      baseURL: 'https://api.firecrawl.dev/v1',
      timeout: 90000,
      headers: { 'Content-Type': 'application/json' },
    });

    if (!this.apiKey) {
      this.logger.warn(
        'FIRECRAWL_API_KEY not set - fallback fetching is disabled, blocked pages will report as not accessible',
      );
    }
  }

  isEnabled(): boolean {
    return Boolean(this.apiKey);
  }

  /**
   * Fetch a URL's raw HTML through Firecrawl.
   * Returns null when disabled or when Firecrawl also fails to retrieve it.
   */
  async fetchRawHtml(url: string): Promise<{ html: string; statusCode?: number } | null> {
    if (!this.apiKey) return null;

    try {
      const response = await this.http.post(
        '/scrape',
        { url, formats: ['rawHtml'], timeout: 60000 },
        { headers: { Authorization: `Bearer ${this.apiKey}` } },
      );

      const body = response.data;
      if (!body?.success || !body?.data?.rawHtml) {
        this.logger.warn(`Firecrawl returned no HTML for ${url}`);
        return null;
      }

      return {
        html: body.data.rawHtml,
        statusCode: body.data.metadata?.statusCode,
      };
    } catch (error) {
      const status = error.response?.status;
      const detail = error.response?.data?.error || error.message;
      this.logger.warn(`Firecrawl failed for ${url}${status ? ` (HTTP ${status})` : ''}: ${detail}`);
      return null;
    }
  }
}
