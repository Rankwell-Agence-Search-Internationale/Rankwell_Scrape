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
