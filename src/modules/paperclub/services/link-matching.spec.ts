import {
  normalizeUrl,
  classifyLink,
  linkTypeFromRel,
  pickBestLink,
  isRedirectToHomepage,
  isDeadDomainError,
  anchorsFromScripts,
} from './link-matching';

describe('normalizeUrl', () => {
  it.each([
    ['https://www.Client.fr/Page/', 'client.fr/page'],
    ['http://client.fr/page?utm_source=x#top', 'client.fr/page'],
    // trailing slash before a query string used to survive normalisation
    ['https://client.fr/page/?utm=1', 'client.fr/page'],
    ['https://client.fr', 'client.fr'],
    ['https://client.fr/', 'client.fr'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeUrl(input)).toBe(expected);
  });
});

describe('classifyLink', () => {
  const landing = 'https://www.client.fr/agences/paris/';

  it.each([
    ['same page, different scheme/www/slash/query', 'http://client.fr/agences/paris?ref=1', 'target'],
    ['client homepage is another page, not the target', 'https://client.fr/', 'other_page'],
    ['parent folder is another page', 'https://client.fr/agences/', 'other_page'],
    ['child page is another page', 'https://client.fr/agences/paris/contact', 'other_page'],
    ['client subdomain is the client', 'https://blog.client.fr/article', 'other_page'],
    ['lookalike domain is not the client', 'https://notclient.fr/agences/paris/', null],
    ['domain that merely contains the client', 'https://client.fr.evil.com/agences/paris/', null],
    ['unrelated site', 'https://example.com/', null],
    ['mailto', 'mailto:contact@client.fr', null],
    ['javascript', 'javascript:void(0)', null],
    ['empty', '', null],
  ])('%s', (_label, href, expected) => {
    expect(classifyLink(href, landing)).toBe(expected);
  });

  it('matches a homepage landing page only against the homepage', () => {
    expect(classifyLink('https://client.fr', 'https://www.client.fr/')).toBe('target');
    expect(classifyLink('https://client.fr/contact', 'https://www.client.fr/')).toBe('other_page');
  });

  it('treats the bare domain as the client when the landing page is on a subdomain', () => {
    expect(classifyLink('https://client.fr/x', 'https://shop.client.fr/y')).toBe('other_page');
  });
});

describe('linkTypeFromRel', () => {
  it.each([
    ['', 'dofollow'],
    ['noopener noreferrer', 'dofollow'],
    ['external', 'dofollow'],
    ['nofollow', 'nofollow'],
    ['NoFollow noopener', 'nofollow'],
    // sponsored is not a followed link; reported as nofollow until the
    // upsert accepts a dedicated value
    ['sponsored', 'nofollow'],
    ['noopener sponsored', 'nofollow'],
    ['ugc', 'nofollow'],
  ])('rel="%s" -> %s', (rel, expected) => {
    expect(linkTypeFromRel(rel)).toBe(expected);
  });
});

describe('pickBestLink', () => {
  const landing = 'https://client.fr/page';
  const a = (href: string, rel = '') => ({ href, text: href, outerHTML: '', rel });

  it('prefers the target page over another client page, whatever the order', () => {
    const best = pickBestLink([a('https://client.fr/'), a('https://client.fr/page')], landing);
    expect(best?.kind).toBe('target');
    expect(best?.link.href).toBe('https://client.fr/page');
  });

  it('prefers a followed link over a nofollow one of the same kind', () => {
    const best = pickBestLink(
      [a('https://client.fr/page', 'nofollow'), a('https://client.fr/page', 'noopener')],
      landing,
    );
    expect(best?.link.rel).toBe('noopener');
  });

  it('still reports a nofollow target link when that is all there is', () => {
    const best = pickBestLink([a('https://client.fr/page', 'nofollow')], landing);
    expect(best?.kind).toBe('target');
    expect(linkTypeFromRel(best!.link.rel)).toBe('nofollow');
  });

  it('returns null when no link points to the client', () => {
    expect(pickBestLink([a('https://example.com/')], landing)).toBeNull();
  });
});

describe('isRedirectToHomepage', () => {
  it.each([
    ['article redirected to home', 'https://media.fr/2025/article-x/', 'https://media.fr/', true],
    ['article redirected to www home', 'https://media.fr/article', 'https://www.media.fr', true],
    ['article redirected to home with tracking query', 'https://media.fr/article', 'https://media.fr/?from=404', true],
    ['no redirect', 'https://media.fr/article', 'https://media.fr/article', false],
    ['http to https only', 'http://media.fr/article', 'https://media.fr/article/', false],
    ['moved to another article', 'https://media.fr/old', 'https://media.fr/new', false],
    ['bought link was the homepage itself', 'https://media.fr/', 'https://media.fr/', false],
    ['redirected to a section is not treated as home', 'https://media.fr/article', 'https://media.fr/fr/', false],
    ['unknown final url', 'https://media.fr/article', undefined, false],
  ])('%s', (_label, requested, final, expected) => {
    expect(isRedirectToHomepage(requested, final)).toBe(expected);
  });
});

describe('isDeadDomainError', () => {
  it.each([
    ['page.goto: net::ERR_NAME_NOT_RESOLVED at https://gone.fr/', true],
    ['getaddrinfo ENOTFOUND gone.fr', true],
    ['page.goto: net::ERR_CONNECTION_TIMED_OUT', false],
    ['Timeout 30000ms exceeded', false],
    [undefined, false],
  ])('%s', (message, expected) => {
    expect(isDeadDomainError(message)).toBe(expected);
  });
});

describe('anchorsFromScripts', () => {
  const base = 'https://media.fr/article';

  it('finds an anchor in an article body stored as a JSON string (paywalled sites)', () => {
    const script = JSON.stringify({
      article: { body: '<p>Voir <a href="https://client.fr/page" rel="noopener">le site</a>.</p>' },
    });
    expect(anchorsFromScripts([script], base)).toEqual([
      { href: 'https://client.fr/page', text: 'le site', outerHTML: expect.any(String), rel: 'noopener', source: 'json' },
    ]);
  });

  it('decodes unicode-escaped markup (Next.js / Nuxt payloads)', () => {
    const script = '{"html":"\\u003ca href=\\u0022https:\\u002F\\u002Fclient.fr\\u002Fpage\\u0022 rel=\\u0022nofollow\\u0022\\u003eici\\u003c\\u002Fa\\u003e"}';
    const [link] = anchorsFromScripts([script], base);
    expect(link.href).toBe('https://client.fr/page');
    expect(link.rel).toBe('nofollow');
  });

  it('decodes markup escaped twice (JSON inside a JSON string)', () => {
    const inner = JSON.stringify({ body: '<a href="https://client.fr/page">x</a>' });
    const [link] = anchorsFromScripts([JSON.stringify({ state: inner })], base);
    expect(link.href).toBe('https://client.fr/page');
  });

  it('resolves relative hrefs and decodes &amp;', () => {
    const script = '{"b":"<a href=\\"/autre?a=1&amp;b=2\\">x</a>"}';
    expect(anchorsFromScripts([script], base)[0].href).toBe('https://media.fr/autre?a=1&b=2');
  });

  it('ignores scripts without markup and bare URLs (not proof of a link)', () => {
    expect(anchorsFromScripts(['{"url":"https://client.fr/page"}', 'var a = 1;'], base)).toEqual([]);
  });

  it('keeps the rel of a sponsored anchor', () => {
    const script = '{"b":"<a rel=\\"sponsored\\" href=\\"https://client.fr/page\\">x</a>"}';
    expect(linkTypeFromRel(anchorsFromScripts([script], base)[0].rel)).toBe('nofollow');
  });
});
