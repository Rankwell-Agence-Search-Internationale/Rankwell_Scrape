import {
  buildScrapingRunPayload,
  DEFAULT_NOTIFY_EMAIL,
  ScrapingRun,
  ScrapingRunReporterService,
  summarizeFailures,
} from './scraping-run-reporter.service';

const notifyEmail = ['reewaz@rankwell.fr'];

describe('buildScrapingRunPayload', () => {
  it('matches the Dashboard contract for a run with item failures', () => {
    const payload = buildScrapingRunPayload({
      scraper: 'paperclub',
      notifyEmail,
      outcome: {
        successCount: 1240,
        failed: [
          { url: 'https://example.com/a', reason: 'timeout' },
          { url: 'https://example.com/b', reason: 'HTTP 403' },
          { url: 'https://example.com/c', reason: 'timeout' },
        ],
      },
    });

    expect(payload).toEqual({
      scraper: 'paperclub',
      status: 'failure',
      success_count: 1240,
      failed_count: 3,
      error_message: '3 failed (2× timeout, 1× HTTP 403)',
      notify_email: ['reewaz@rankwell.fr'],
      details: {
        failed: [
          { url: 'https://example.com/a', reason: 'timeout' },
          { url: 'https://example.com/b', reason: 'HTTP 403' },
          { url: 'https://example.com/c', reason: 'timeout' },
        ],
      },
    });
  });

  it('is a success only when nothing failed', () => {
    const payload = buildScrapingRunPayload({
      scraper: 'netlink',
      notifyEmail,
      outcome: { successCount: 100, failed: [] },
    });

    expect(payload.status).toBe('success');
    expect(payload.error_message).toBeNull();
    expect(payload.failed_count).toBe(0);
    expect(payload.details.failed).toEqual([]);
  });

  it('carries the abort reason and partial progress when the job throws', () => {
    const payload = buildScrapingRunPayload({
      scraper: 'netlink',
      notifyEmail,
      error: new Error('Dashboard returned 502'),
      outcome: { successCount: 40, failed: [] },
    });

    expect(payload.status).toBe('failure');
    expect(payload.error_message).toBe('Dashboard returned 502');
    expect(payload.success_count).toBe(40);
  });

  it('defaults counts to zero when a job aborts before producing anything', () => {
    const payload = buildScrapingRunPayload({
      scraper: 'rocketlinks',
      notifyEmail,
      error: 'login failed',
    });

    expect(payload.success_count).toBe(0);
    expect(payload.failed_count).toBe(0);
    expect(payload.error_message).toBe('login failed');
  });

  it('lets failedCount override the list length when failures are not enumerable', () => {
    const payload = buildScrapingRunPayload({
      scraper: 'domdetailer',
      notifyEmail,
      outcome: { successCount: 900, failedCount: 17 },
    });

    expect(payload.status).toBe('failure');
    expect(payload.failed_count).toBe(17);
    expect(payload.error_message).toBe('17 failed');
  });

  it('emits exactly the contract keys and nothing else', () => {
    const payload = buildScrapingRunPayload({
      scraper: 'paperclub',
      notifyEmail,
      outcome: { successCount: 1 },
    });

    expect(Object.keys(payload).sort()).toEqual(
      [
        'scraper',
        'status',
        'success_count',
        'failed_count',
        'error_message',
        'notify_email',
        'details',
      ].sort(),
    );
    expect(Object.keys(payload.details)).toEqual(['failed']);
  });
});

describe('summarizeFailures', () => {
  it('groups by reason, most common first, at most three', () => {
    const failed = [
      ...Array(5).fill({ url: 'a', reason: 'timeout' }),
      ...Array(3).fill({ url: 'b', reason: 'HTTP 403' }),
      { url: 'c', reason: 'DNS' },
      { url: 'd', reason: 'TLS' },
    ];
    expect(summarizeFailures(10, failed)).toBe(
      '10 failed (5× timeout, 3× HTTP 403, 1× DNS)',
    );
  });

  it('truncates long reasons so the summary stays one line', () => {
    const reason = 'page.goto: Timeout 30000ms exceeded. ' + 'x'.repeat(100);
    const summary = summarizeFailures(1, [{ url: 'a', reason }]);
    expect(summary.length).toBeLessThan(90);
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

    await service.start('paperclub').finish({ successCount: 1 });

    expect(post).toHaveBeenCalledTimes(1);
    const [url, payload, requestConfig] = post.mock.calls[0];
    expect(url).toBe('/scraping/runs');
    expect(payload.scraper).toBe('paperclub');
    expect(requestConfig.headers['X-Api-Key']).toBe('k');
  });

  it('uses the fixed recipient list unless SCRAPING_RUNS_NOTIFY_EMAIL overrides it', async () => {
    const post = jest.fn().mockResolvedValue({});

    const fixed = new ScrapingRunReporterService(
      config({ SCRAPING_RUNS_API_KEY: 'k' }) as any,
      { post } as any,
    );
    await fixed.start('paperclub').finish({ successCount: 1 });
    expect(post.mock.calls[0][1].notify_email).toEqual(DEFAULT_NOTIFY_EMAIL);

    const overridden = new ScrapingRunReporterService(
      config({
        SCRAPING_RUNS_API_KEY: 'k',
        SCRAPING_RUNS_NOTIFY_EMAIL: 'a@rankwell.fr, b@rankwell.fr',
      }) as any,
      { post } as any,
    );
    await overridden.start('paperclub').finish({ successCount: 1 });
    expect(post.mock.calls[1][1].notify_email).toEqual([
      'a@rankwell.fr',
      'b@rankwell.fr',
    ]);
  });

  it('skips the request when no API key is configured', async () => {
    const post = jest.fn();
    const service = new ScrapingRunReporterService(
      config({}) as any,
      { post } as any,
    );

    await service.start('paperclub').finish({ successCount: 1 });

    expect(post).not.toHaveBeenCalled();
  });

  it('swallows delivery errors so the scrape itself is unaffected', async () => {
    const post = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const service = new ScrapingRunReporterService(
      config({ SCRAPING_RUNS_API_KEY: 'k' }) as any,
      { post } as any,
    );

    await expect(
      service.start('paperclub').finish({ successCount: 1 }),
    ).resolves.toBeUndefined();
  });

  it('closes a run only once, so fail() after finish() is a no-op', async () => {
    const post = jest.fn().mockResolvedValue({});
    const service = new ScrapingRunReporterService(
      config({ SCRAPING_RUNS_API_KEY: 'k' }) as any,
      { post } as any,
    );
    const run: ScrapingRun = service.start('netlink');

    await run.finish({ successCount: 3 });
    await run.fail(new Error('late'));

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1].status).toBe('success');
  });
});
