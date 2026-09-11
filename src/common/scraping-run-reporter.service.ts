import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as os from 'os';
import { DashboardHttpClient } from './dashboard-http-client.service';

/**
 * Scraping Run Reporter
 *
 * Posts one record per scraping job to the Dashboard so it can store the run
 * and notify people (POST /scraping/runs, authenticated with X-Api-Key).
 *
 * Report at the outermost point that owns the job — the cron handler in
 * main.ts or the CLI entry point — so each invocation yields exactly one run:
 *
 *   const run = reporter.start('paperclub', 'https://app.paper.club/api');
 *   try {
 *     const data = await scrape();
 *     await run.finish({ successCount: data.total, failed: data.failed });
 *   } catch (error) {
 *     await run.fail(error);
 *     throw error;
 *   }
 *
 * `status` is about the job, not the items: a run that completed with some
 * URLs failing is "success" with a non-zero failed_count; "failed" means the
 * job itself aborted. Reporting never throws — a Dashboard outage must not
 * turn a finished scrape into a failed one.
 */

export type ScrapingRunStatus = 'success' | 'failed';

export interface ScrapingRunFailure {
  url: string;
  reason: string;
}

export interface ScrapingRunOutcome {
  successCount: number;
  failed?: ScrapingRunFailure[];
  /** Set when failures cannot be listed individually; defaults to failed.length */
  failedCount?: number;
  /** Free-form extras merged into `details` (page numbers, category breakdowns…) */
  details?: Record<string, unknown>;
}

export interface ScrapingRunPayload {
  scraper: string;
  target: string;
  status: ScrapingRunStatus;
  started_at: string;
  finished_at: string;
  success_count: number;
  failed_count: number;
  error_message: string | null;
  details: Record<string, unknown>;
}

/** Keep the payload bounded on a bad night; the full list is still in the logs. */
export const MAX_FAILURES_IN_PAYLOAD = 200;

/**
 * ISO-8601 with the process's local UTC offset (2026-09-11T03:00:00+02:00),
 * rather than Date#toISOString's "Z", so the Dashboard sees Paris wall-clock
 * time — the same time the cron schedule and the logs use.
 */
export function toLocalIso(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export function buildScrapingRunPayload(input: {
  scraper: string;
  target: string;
  status: ScrapingRunStatus;
  startedAt: Date;
  finishedAt: Date;
  error?: unknown;
  outcome?: ScrapingRunOutcome;
}): ScrapingRunPayload {
  const { scraper, target, status, startedAt, finishedAt, error, outcome } =
    input;
  const failed = outcome?.failed ?? [];
  const failedCount = outcome?.failedCount ?? failed.length;

  const details: Record<string, unknown> = {
    host: os.hostname(),
    duration_ms: finishedAt.getTime() - startedAt.getTime(),
    ...(outcome?.details ?? {}),
    failed: failed.slice(0, MAX_FAILURES_IN_PAYLOAD),
  };
  if (failed.length > MAX_FAILURES_IN_PAYLOAD) {
    details.failed_truncated = failed.length - MAX_FAILURES_IN_PAYLOAD;
  }

  return {
    scraper,
    target,
    status,
    started_at: toLocalIso(startedAt),
    finished_at: toLocalIso(finishedAt),
    success_count: outcome?.successCount ?? 0,
    failed_count: failedCount,
    error_message: error ? errorMessage(error) : null,
    details,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * One in-flight job. Created by ScrapingRunReporterService.start(); closed
 * exactly once by finish() or fail() — a second close is ignored so callers
 * can fail() in a catch block without checking whether finish() already ran.
 */
export class ScrapingRun {
  private readonly startedAt = new Date();
  private closed = false;

  constructor(
    private readonly reporter: ScrapingRunReporterService,
    readonly scraper: string,
    readonly target: string,
  ) {}

  finish(outcome: ScrapingRunOutcome): Promise<void> {
    return this.close('success', undefined, outcome);
  }

  /** `outcome` carries whatever partial progress was made before the abort. */
  fail(error: unknown, outcome?: ScrapingRunOutcome): Promise<void> {
    return this.close('failed', error, outcome);
  }

  private async close(
    status: ScrapingRunStatus,
    error: unknown,
    outcome?: ScrapingRunOutcome,
  ): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    const payload = buildScrapingRunPayload({
      scraper: this.scraper,
      target: this.target,
      status,
      startedAt: this.startedAt,
      finishedAt: new Date(),
      error,
      outcome,
    });
    await this.reporter.report(payload);
  }
}

@Injectable()
export class ScrapingRunReporterService {
  private readonly logger = new Logger(ScrapingRunReporterService.name);
  private readonly apiKey: string | undefined;
  private readonly url: string;
  private warnedMissingKey = false;

  constructor(
    configService: ConfigService,
    private readonly dashboardClient: DashboardHttpClient,
  ) {
    this.apiKey = configService.get<string>('SCRAPING_RUNS_API_KEY');
    // Relative by default so it follows DASHBOARD_BASE_URL; an absolute URL
    // here bypasses the base (axios ignores baseURL for absolute urls).
    this.url = configService.get<string>('SCRAPING_RUNS_URL', '/scraping/runs');
  }

  start(scraper: string, target: string): ScrapingRun {
    return new ScrapingRun(this, scraper, target);
  }

  /**
   * Deliver one run to the Dashboard. Never throws: failures are logged and
   * swallowed so the scrape's own exit status is not affected.
   */
  async report(payload: ScrapingRunPayload): Promise<void> {
    if (!this.apiKey) {
      if (!this.warnedMissingKey) {
        this.logger.warn(
          'SCRAPING_RUNS_API_KEY is not set — scraping runs will not be reported to the Dashboard',
        );
        this.warnedMissingKey = true;
      }
      return;
    }

    const summary =
      `${payload.scraper} ${payload.status} — ` +
      `${payload.success_count} ok, ${payload.failed_count} failed`;

    try {
      await this.dashboardClient.post(this.url, payload, {
        headers: { 'X-Api-Key': this.apiKey },
        timeout: 15000,
      });
      this.logger.log(`Reported scraping run: ${summary}`);
    } catch (error) {
      // The scrape already happened and its results were posted through the
      // normal channels; losing the run record is worth a log line, not a crash.
      this.logger.error(
        `Failed to report scraping run (${summary}): ${errorMessage(error)}`,
      );
    }
  }
}
