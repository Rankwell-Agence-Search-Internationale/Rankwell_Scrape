import {
  buildScrapingRunPayload,
  MAX_FAILURES_IN_PAYLOAD,
  ScrapingRun,
  ScrapingRunReporterService,
  toLocalIso,
} from './scraping-run-reporter.service';

describe('toLocalIso', () => {
  it('formats with the local UTC offset rather than Z', () => {
    const iso = toLocalIso(new Date(2026, 8, 11, 3, 0, 0));
    expect(iso).toMatch(/^2026-09-11T03:00:00[+-]\d{2}:\d{2}$/);
  });
});

describe('buildScrapingRunPayload', () => {
  const startedAt = new Date(2026, 8, 11, 3, 0, 0);
  const finishedAt = new Date(2026, 8, 11, 3, 12, 40);

  it('matches the Dashboard contract for a completed run with item failures', () => {
    const payload = buildScrapingRunPayload({
      scraper: 'paperclub',
      target: 'https://example.com/category',
      status: 'success',
      startedAt,
      finishedAt,
      outcome: {
        successCount: 1240,
        failed: [{ url: 'https://example.com/a', reason: 'timeout' }],
      },
    });

    expect(payload).toMatchObject({
      scraper: 'paperclub',
      target: 'https://example.com/category',
      status: 'success',
      success_count: 1240,
      failed_count: 1,
      error_message: null,
    });
    expect(payload.details.failed).toEqual([
      { url: 'https://example.com/a', reason: 'timeout' },
    ]);
    expect(payload.details.duration_ms).toBe(12 * 60 * 1000 + 40 * 1000);
    expect(typeof payload.details.host).toBe('string');
  });

  it('carries the abort reason and partial progress for a failed run', () => {
    const payload = buildScrapingRunPayload({
      scraper: 'netlink',
      target: 'page 10',
      status: 'failed',
      startedAt,
      finishedAt,
      error: new Error('Dashboard returned 502'),
      outcome: { successCount: 40, failed: [] },
    });

    expect(payload.status).toBe('failed');
    expect(payload.error_message).toBe('Dashboard returned 502');
    expect(payload.success_count).toBe(40);
    expect(payload.failed_count).toBe(0);
  });

  it('defaults counts to zero when a job aborts before producing anything', () => {
    const payload = buildScrapingRunPayload({
      scraper: 'rocketlinks',
      target: 'catalog',
      status: 'failed',
      startedAt,
      finishedAt,
      error: 'login failed',
    });

    expect(payload.success_count).toBe(0);
    expect(payload.failed_count).toBe(0);
    expect(payload.error_message).toBe('login failed');
    expect(payload.details.failed).toEqual([]);
  });

  it('lets failedCount override the list length when failures are not enumerable', () => {
    const payload = buildScrapingRunPayload({
      scraper: 'domdetailer',
      target: 'all',
      status: 'success',
      startedAt,
      finishedAt,
      outcome: { successCount: 900, failedCount: 17 },
    });

    expect(payload.failed_count).toBe(17);
  });

  it('caps the failure list and records how many were dropped', () => {
    const failed = Array.from(
      { length: MAX_FAILURES_IN_PAYLOAD + 5 },
      (_, i) => ({
        url: `https://example.com/${i}`,
        reason: 'timeout',
      }),
    );
    const payload = buildScrapingRunPayload({
      scraper: 'netlink',
      target: 'page 1',
      status: 'success',
      startedAt,
      finishedAt,
      outcome: { successCount: 0, failed },
    });

    expect(payload.failed_count).toBe(MAX_FAILURES_IN_PAYLOAD + 5);
    expect((payload.details.failed as unknown[]).length).toBe(
      MAX_FAILURES_IN_PAYLOAD,
    );
    expect(payload.details.failed_truncated).toBe(5);
  });
});

describe('ScrapingRunReporterService', () => {
  const config = (values: Record<string, string>) => ({
    get: (key: string, fallback?: string) => values[key] ?? fallback,
  });

  it('posts with the X-Api-Key header to the configured path', async () => {
    const post = jest.fn().mockResolvedValue({});
    const service = new ScrapingRunReporterService(
      config({ SCRAPING_RUNS_API_KEY: 'k' }) as any,
      { post } as any,
    );

    await service.start('paperclub', 'target').finish({ successCount: 1 });

    expect(post).toHaveBeenCalledTimes(1);
    const [url, payload, requestConfig] = post.mock.calls[0];
    expect(url).toBe('/scraping/runs');
    expect(payload.scraper).toBe('paperclub');
    expect(requestConfig.headers['X-Api-Key']).toBe('k');
  });

  it('skips the request when no API key is configured', async () => {
    const post = jest.fn();
    const service = new ScrapingRunReporterService(
      config({}) as any,
      { post } as any,
    );

    await service.start('paperclub', 'target').finish({ successCount: 1 });

    expect(post).not.toHaveBeenCalled();
  });

  it('swallows delivery errors so the scrape itself is unaffected', async () => {
    const post = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const service = new ScrapingRunReporterService(
      config({ SCRAPING_RUNS_API_KEY: 'k' }) as any,
      { post } as any,
    );

    await expect(
      service.start('paperclub', 'target').finish({ successCount: 1 }),
    ).resolves.toBeUndefined();
  });

  it('closes a run only once, so fail() after finish() is a no-op', async () => {
    const post = jest.fn().mockResolvedValue({});
    const service = new ScrapingRunReporterService(
      config({ SCRAPING_RUNS_API_KEY: 'k' }) as any,
      { post } as any,
    );
    const run: ScrapingRun = service.start('netlink', 'page 1');

    await run.finish({ successCount: 3 });
    await run.fail(new Error('late'));

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1].status).toBe('success');
  });
});
