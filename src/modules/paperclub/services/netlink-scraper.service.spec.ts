import { NetlinkScraperService, ScrapedNetlinkData } from './netlink-scraper.service';

describe('NetlinkScraperService online_status', () => {
  const service = new NetlinkScraperService({} as any, {} as any, {} as any, {} as any);
  const transform = (r: Partial<ScrapedNetlinkData>) =>
    (service as any).transformToAdditionalInfo({
      url: 'https://media.fr/article',
      netlinkId: 1,
      scrapedAt: '',
      success: true,
      ...r,
    });

  const target = { href: 'https://client.fr/page', text: '', outerHTML: '', matched: true, link_type: 'dofollow' };
  const none = { href: '', text: '', outerHTML: '', matched: false };

  it.each([
    ['target link found', { statusCode: 200, foundLink: target }, 1],
    ['target link found despite a 403', { statusCode: 403, foundLink: target }, 1],
    ['only another client page', { statusCode: 200, foundLink: none, domainFound: true, domainFoundLink: { href: 'x', text: '', link_type: 'dofollow' } }, 4],
    ['page read, no link', { statusCode: 200, foundLink: none, domainFound: false }, 2],
    ['404 is a deleted page', { statusCode: 404, foundLink: none }, 2],
    ['410 is a deleted page', { statusCode: 410, foundLink: none }, 2],
    ['403 is not verified, never dead', { statusCode: 403, foundLink: none }, 3],
    ['429 is not verified', { statusCode: 429, foundLink: none }, 3],
    ['redirected home beats a sitewide homepage link', { statusCode: 200, foundLink: target, redirectedToHomepage: true }, 2],
    ['timeout is not verified', { success: false, error: 'Timeout 30000ms exceeded' }, 3],
    ['dead domain is gone', { success: false, error: 'page.goto: net::ERR_NAME_NOT_RESOLVED at https://gone.fr/' }, 2],
  ])('%s -> %i', (_label, result, expected) => {
    expect(transform(result as Partial<ScrapedNetlinkData>).online_status).toBe(expected);
  });

  it('does not report a link type for a removed article', () => {
    const info = transform({ statusCode: 200, foundLink: target as any, redirectedToHomepage: true });
    expect(info.link_type).toBe('unknown');
  });
});

describe('NetlinkScraperService confirm before reporting a link gone', () => {
  const url = 'https://media.fr/article';
  const landing = 'https://client.fr/page';
  const target = { href: landing, text: '', outerHTML: '', matched: true, link_type: 'dofollow' };
  const none = { href: '', text: '', outerHTML: '', matched: false };

  const pageRead = (r: Partial<ScrapedNetlinkData>) => ({ statusCode: 200, allLinksCount: 80, foundLink: none, domainFound: false, ...r });
  const secondRead = (r: Partial<ScrapedNetlinkData>) =>
    ({ url, landingPage: landing, scrapedAt: '', success: true, recoveredVia: 'firecrawl', ...pageRead(r) }) as ScrapedNetlinkData;

  function setup(first: Partial<ScrapedNetlinkData>, second: ScrapedNetlinkData | null, firecrawlEnabled = true) {
    const browser = { withPage: jest.fn().mockResolvedValue(pageRead(first)) };
    const firecrawl = { isEnabled: () => firecrawlEnabled };
    const service = new NetlinkScraperService(browser as any, {} as any, {} as any, firecrawl as any);
    const fallback = jest.spyOn(service as any, 'scrapeViaFirecrawl').mockResolvedValue(second);
    const run = async () => {
      const result = await service.scrapeNetlink(url, landing, { retries: 1 });
      return { result, status: (service as any).onlineStatusOf(result) as number };
    };
    return { run, fallback };
  }

  it('does not re-check a link that was found', async () => {
    const { run, fallback } = setup({ foundLink: target }, null);
    expect((await run()).status).toBe(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('does not re-check another client page', async () => {
    const { run, fallback } = setup({ domainFound: true, domainFoundLink: { href: 'https://client.fr/', text: '' } }, null);
    expect((await run()).status).toBe(4);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('a second read that finds the link wins: the first read was wrong', async () => {
    const { run } = setup({}, secondRead({ foundLink: target }));
    const { result, status } = await run();
    expect(status).toBe(1);
    expect(result.recoveredVia).toBe('firecrawl');
  });

  it('a second read that also sees no link confirms it gone', async () => {
    const { run } = setup({}, secondRead({}));
    expect((await run()).status).toBe(2);
  });

  it('a 404 confirmed by the second read stays gone', async () => {
    const { run } = setup({ statusCode: 404 }, secondRead({ statusCode: 404, allLinksCount: 30 }));
    expect((await run()).status).toBe(2);
  });

  it('a 404 the second read cannot fetch becomes not verified', async () => {
    const { run } = setup({ statusCode: 404 }, null);
    expect((await run()).status).toBe(3);
  });

  it('a second read that is itself blocked cannot confirm: not verified', async () => {
    const { run } = setup({}, secondRead({ statusCode: 403, allLinksCount: 2 }));
    expect((await run()).status).toBe(3);
  });

  it('a redirect home confirmed by the second read stays gone', async () => {
    const { run } = setup(
      { redirectedToHomepage: true, finalUrl: 'https://media.fr/' },
      secondRead({ redirectedToHomepage: true, finalUrl: 'https://media.fr/', foundLink: target }),
    );
    expect((await run()).status).toBe(2);
  });

  it('a redirect home is not overturned by a sitewide link when the second read cannot tell where it landed', async () => {
    const { run } = setup({ redirectedToHomepage: true, finalUrl: 'https://media.fr/' }, secondRead({ foundLink: target }));
    expect((await run()).status).toBe(2);
  });

  it('a redirect home served only to our browser is overturned when the second read reaches the article', async () => {
    const { run } = setup(
      { redirectedToHomepage: true, finalUrl: 'https://media.fr/' },
      secondRead({ finalUrl: url, foundLink: target }),
    );
    expect((await run()).status).toBe(1);
  });

  it('keeps the single-read verdict when no second reader is configured', async () => {
    const { run } = setup({}, null, false);
    expect((await run()).status).toBe(2);
  });

  it('a blocked first read the second read cannot fix stays not verified', async () => {
    const { run } = setup({ statusCode: 403, allLinksCount: 3 }, null);
    expect((await run()).status).toBe(3);
  });
});

describe('NetlinkScraperService reading pages that resist', () => {
  const url = 'https://media.fr/article';
  const landing = 'https://client.fr/page';
  const service = new NetlinkScraperService({} as any, {} as any, {} as any, {} as any);
  const extract = (page: any) => (service as any).extractData(page, url, landing);
  const pageData = {
    domLinks: [{ href: landing, text: 'client', outerHTML: '<a>', rel: '' }],
    scripts: [] as string[],
  };

  function fakePage(evaluate: jest.Mock) {
    return {
      waitForSelector: jest.fn().mockResolvedValue(undefined),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      waitForLoadState: jest.fn().mockResolvedValue(undefined),
      url: () => url,
      evaluate,
    };
  }

  it('only needs <body> to exist, not to be visible (sites that hide it until their JS runs)', async () => {
    const page = fakePage(jest.fn().mockResolvedValue(pageData));
    await extract(page);
    expect(page.waitForSelector).toHaveBeenCalledWith('body', expect.objectContaining({ state: 'attached' }));
  });

  it('reads the page again after a JavaScript redirect destroys it mid-read', async () => {
    const evaluate = jest
      .fn()
      .mockRejectedValueOnce(new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation'))
      .mockResolvedValueOnce(pageData);
    const page = fakePage(evaluate);

    const result = await extract(page);

    expect(page.waitForLoadState).toHaveBeenCalled();
    expect(result.foundLink.matched).toBe(true);
  });

  it('gives up after repeated navigations instead of looping', async () => {
    const evaluate = jest.fn().mockRejectedValue(new Error('Execution context was destroyed'));
    await expect(extract(fakePage(evaluate))).rejects.toThrow('Execution context was destroyed');
    expect(evaluate.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('does not retry unrelated errors', async () => {
    const evaluate = jest.fn().mockRejectedValue(new Error('Target page, context or browser has been closed'));
    await expect(extract(fakePage(evaluate))).rejects.toThrow('has been closed');
    expect(evaluate).toHaveBeenCalledTimes(1);
  });
});
