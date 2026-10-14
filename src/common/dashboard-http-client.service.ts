import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { firstValueFrom } from 'rxjs';

/**
 * Dashboard HTTP Client Service
 *
 * A reusable HTTP client for making requests to the Dashboard API.
 * Configured with base URL from environment variables and provides
 * convenience methods for common HTTP operations.
 *
 * Features:
 * - Centralized configuration
 * - Request/Response interceptors
 * - Automatic error handling and logging
 * - Type-safe methods for GET, POST, PUT, PATCH, DELETE
 */
@Injectable()
export class DashboardHttpClient {
  private readonly logger = new Logger(DashboardHttpClient.name);
  private readonly baseURL: string;
  private readonly axiosInstance: AxiosInstance;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
  ) {
    this.baseURL = this.configService.get<string>('DASHBOARD_BASE_URL');

    if (!this.baseURL) {
      throw new Error('DASHBOARD_BASE_URL environment variable is required');
    }

    // Get the axios instance from HttpService
    this.axiosInstance = this.httpService.axiosRef;

    // Set default configuration
    this.axiosInstance.defaults.baseURL = this.baseURL;
    this.axiosInstance.defaults.timeout = 30000; // 30 seconds
    this.axiosInstance.defaults.headers.common['Content-Type'] = 'application/json';

    this.setupInterceptors();
    this.logger.log(`Dashboard HTTP Client initialized with base URL: ${this.baseURL}`);
  }

  /**
   * Setup request and response interceptors
   */
  private setupInterceptors(): void {
    // The Dashboard rejects every write without a key (401 "Missing
    // credentials"). It accepts its shared SCRAPING_API_KEY, which the scraper
    // already holds as SCRAPING_RUNS_API_KEY for run reports.
    const apiKey =
      this.configService.get<string>('DASHBOARD_API_KEY') ||
      this.configService.get<string>('SCRAPING_RUNS_API_KEY');
    const dashboardHost = new URL(this.baseURL).host;

    // Request interceptor
    this.axiosInstance.interceptors.request.use(
      (config) => {
        this.logger.debug(`${config.method?.toUpperCase()} ${config.url}`);

        // This axios instance is shared with other clients (Paper.club...),
        // so the key is attached per request and only for the Dashboard host.
        if (apiKey && new URL(config.url ?? '', this.baseURL).host === dashboardHost) {
          config.headers.set('X-Api-Key', apiKey);
        }
        return config;
      },
      (error) => {
        this.logger.error('Request interceptor error:', error.message);
        return Promise.reject(error);
      },
    );

    // Response interceptor
    this.axiosInstance.interceptors.response.use(
      (response) => {
        this.logger.debug(
          `Response: ${response.config.method?.toUpperCase()} ${response.config.url} - ${response.status}`,
        );
        return response;
      },
      (error) => {
        if (error.response) {
          // Server responded with error status
          this.logger.error(
            `API Error: ${error.config?.method?.toUpperCase()} ${error.config?.url} - ${error.response.status}`,
          );
          this.logger.error(`Response data: ${JSON.stringify(error.response.data)}`);
        } else if (error.request) {
          // Request made but no response received
          this.logger.error('No response received from API');
        } else {
          // Error setting up request
          this.logger.error(`Request setup error: ${error.message}`);
        }
        return Promise.reject(error);
      },
    );
  }

  /**
   * Generic request method
   */
  private async request<T = any>(config: AxiosRequestConfig): Promise<T> {
    try {
      const response = await firstValueFrom(this.httpService.request<T>(config));
      return response.data;
    } catch (error) {
      this.logger.error(`Request failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * GET request
   */
  async get<T = any>(url: string, config?: AxiosRequestConfig): Promise<T> {
    return this.request<T>({
      ...config,
      method: 'GET',
      url,
    });
  }

  /**
   * POST request
   */
  async post<T = any, D = any>(
    url: string,
    data?: D,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    return this.request<T>({
      ...config,
      method: 'POST',
      url,
      data,
    });
  }

  /**
   * PUT request
   */
  async put<T = any, D = any>(
    url: string,
    data?: D,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    return this.request<T>({
      ...config,
      method: 'PUT',
      url,
      data,
    });
  }

  /**
   * PATCH request
   */
  async patch<T = any, D = any>(
    url: string,
    data?: D,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    return this.request<T>({
      ...config,
      method: 'PATCH',
      url,
      data,
    });
  }

  /**
   * DELETE request
   */
  async delete<T = any>(url: string, config?: AxiosRequestConfig): Promise<T> {
    return this.request<T>({
      ...config,
      method: 'DELETE',
      url,
    });
  }

  /**
   * Get the base URL
   */
  getBaseURL(): string {
    return this.baseURL;
  }

  /**
   * Get the raw axios instance for advanced usage
   */
  getAxiosInstance(): AxiosInstance {
    return this.axiosInstance;
  }

  /**
   * Set custom headers for subsequent requests
   */
  setHeader(key: string, value: string): void {
    this.axiosInstance.defaults.headers.common[key] = value;
  }

  /**
   * Remove a custom header
   */
  removeHeader(key: string): void {
    delete this.axiosInstance.defaults.headers.common[key];
  }

  /**
   * Set authorization token
   */
  setAuthToken(token: string): void {
    this.setHeader('Authorization', `Bearer ${token}`);
  }

  /**
   * Remove authorization token
   */
  removeAuthToken(): void {
    this.removeHeader('Authorization');
  }

  /**
   * Set timeout for requests (in milliseconds)
   */
  setTimeout(timeout: number): void {
    this.axiosInstance.defaults.timeout = timeout;
  }
}
