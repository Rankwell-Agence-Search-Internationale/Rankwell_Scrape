import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DashboardHttpClient } from './dashboard-http-client.service';

/**
 * Scraping Run Reporter
 *
 * Posts one record per scraping job to the Dashboard so it can store the run
 * and send the notification mail (POST /scraping/runs, X-Api-Key auth).
 *
 * Report at the outermost point that owns the job — the cron handler in
 * main.ts or the CLI entry point — so each invocation yields exactly one run:
 *
 *   const run = reporter.start('paperclub');
 *   try {
 *     const data = await scrape();
 *     await run.finish({ successCount: data.total, failed: data.failed });
 *   } catch (error) {
 *     await run.fail(error);
 *     throw error;
 *   }
 *
 * A run is "success" only when nothing failed. Any failed item, or the job
 * aborting, makes it "failure" with an error_message the mail can show.
 * Reporting never throws — a Dashboard outage must not turn a finished
 * scrape into a failed one.
 */

export type ScrapingRunStatus = 'success' | 'failure';

export interface ScrapingRunFailure {
  url: string;
  reason: string;
}

export interface ScrapingRunOutcome {
  successCount: number;
  failed?: ScrapingRunFailure[];
  /** Set when failures cannot be listed individually; defaults to failed.length */
  failedCount?: number;
}

export interface ScrapingRunPayload {
  scraper: string;
  status: ScrapingRunStatus;
  success_count: number;
  failed_count: number;
  error_message: string | null;
  notify_email: string[];
  details: { failed: ScrapingRunFailure[] };
}

/** Who gets the mail when SCRAPING_RUNS_NOTIFY_EMAIL is not set. */
export const DEFAULT_NOTIFY_EMAIL = ['reewaz@rankwell.fr'];

export function buildScrapingRunPayload(input: {
  scraper: string;
  notifyEmail: string[];
  error?: unknown;
  outcome?: ScrapingRunOutcome;
}): ScrapingRunPayload {
  const { scraper, notifyEmail, error, outcome } = input;
  const failed = outcome?.failed ?? [];
  const failedCount = outcome?.failedCount ?? failed.length;
  const aborted = error !== undefined && error !== null;

  return {
    scraper,
    status: aborted || failedCount > 0 ? 'failure' : 'success',
    success_count: outcome?.successCount ?? 0,
    failed_count: failedCount,
    error_message: aborted
      ? errorMessage(error)
      : failedCount > 0
        ? summarizeFailures(failedCount, failed)
        : null,
    notify_email: notifyEmail,
    details: { failed },
  };
}

/**
 * "8 failed (5× timeout, 3× HTTP 403)" — the mail subject line, basically.
 * Reasons are grouped verbatim; long Playwright messages are cut so three of
 * them still fit on a line.
 */
export function summarizeFailures(
  count: number,
  failed: ScrapingRunFailure[],
): string {
  const byReason = new Map<string, number>();
  for (const f of failed) {
    const reason = (f.reason || 'unknown error').slice(0, 60);
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  }
  const top = [...byReason.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, n]) => `${n}× ${reason}`);
  return top.length ? `${count} failed (${top.join(', ')})` : `${count} failed`;
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
  private closed = false;

  constructor(
    private readonly reporter: ScrapingRunReporterService,
    readonly scraper: string,
  ) {}

  finish(outcome: ScrapingRunOutcome): Promise<void> {
    return this.close(undefined, outcome);
  }

  /** `outcome` carries whatever partial progress was made before the abort. */
  fail(error: unknown, outcome?: ScrapingRunOutcome): Promise<void> {
    return this.close(error ?? new Error('unknown error'), outcome);
  }

  private async close(
    error: unknown,
    outcome?: ScrapingRunOutcome,
  ): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    await this.reporter.report(
      buildScrapingRunPayload({
        scraper: this.scraper,
        notifyEmail: this.reporter.notifyEmail,
        error,
        outcome,
      }),
    );
  }
}

@Injectable()
export class ScrapingRunReporterService {
  private readonly logger = new Logger(ScrapingRunReporterService.name);
  private readonly apiKey: string | undefined;
  private readonly url: string;
  readonly notifyEmail: string[];
  private warnedMissingKey = false;

  constructor(
    configService: ConfigService,
    private readonly dashboardClient: DashboardHttpClient,
  ) {
    this.apiKey = configService.get<string>('SCRAPING_RUNS_API_KEY');
    // Relative by default so it follows DASHBOARD_BASE_URL; an absolute URL
    // here bypasses the base (axios ignores baseURL for absolute urls).
    this.url = configService.get<string>('SCRAPING_RUNS_URL', '/scraping/runs');
    this.notifyEmail = parseEmails(
      configService.get<string>('SCRAPING_RUNS_NOTIFY_EMAIL'),
    );
  }

  start(scraper: string): ScrapingRun {
    return new ScrapingRun(this, scraper);
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

function parseEmails(value: string | undefined): string[] {
  const list = (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : DEFAULT_NOTIFY_EMAIL;
}
