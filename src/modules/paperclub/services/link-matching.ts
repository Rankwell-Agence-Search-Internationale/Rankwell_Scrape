/**
 * Pure rules for deciding whether a page carries the backlink we bought.
 *
 * Kept free of Playwright so the cron scraper and the single-netlink debug
 * script apply exactly the same verdicts, and so the rules are unit-tested.
 */

export interface PageLink {
  href: string;
  text: string;
  outerHTML: string;
  rel: string;
  // 'json' when the anchor was found in a script payload rather than the DOM
  source?: 'json';
}

/** 'target': the landing page entered in the Dashboard. 'other_page': any other page of the client. */
export type LinkKind = 'target' | 'other_page';

export type LinkType = 'dofollow' | 'nofollow';

function parseHttpUrl(url: string): URL | null {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

function bareHost(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./, '');
}

function barePath(url: URL): string {
  return url.pathname.toLowerCase().replace(/\/+$/, '');
}

/**
 * Compare form of a URL: no scheme, no www, no query, no hash, no trailing
 * slash, lowercased.
 */
export function normalizeUrl(url: string): string {
  const parsed = parseHttpUrl(url);
  if (!parsed) return url.toLowerCase().trim();
  return bareHost(parsed) + barePath(parsed);
}

/** Same client site: identical host, or one is a subdomain of the other (never a mere substring). */
function isSameSite(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/**
 * Whether a link points to the landing page, to another page of the client,
 * or not to the client at all (null).
 *
 * A homepage or parent-folder link is deliberately not the target: it is a
 * link to the client, but not to the page that was bought.
 */
export function classifyLink(href: string, landingPage: string): LinkKind | null {
  const link = parseHttpUrl(href);
  const landing = parseHttpUrl(landingPage);
  if (!link || !landing) return null;

  if (!isSameSite(bareHost(link), bareHost(landing))) return null;

  return normalizeUrl(href) === normalizeUrl(landingPage) ? 'target' : 'other_page';
}

/**
 * nofollow, sponsored and ugc all tell search engines not to follow the link.
 * sponsored/ugc are reported as nofollow because the upsert only accepts
 * dofollow/nofollow today. noopener, noreferrer and external change nothing.
 */
export function linkTypeFromRel(rel: string): LinkType {
  const tokens = (rel || '').toLowerCase().split(/\s+/);
  return tokens.some(t => t === 'nofollow' || t === 'sponsored' || t === 'ugc')
    ? 'nofollow'
    : 'dofollow';
}

/**
 * The most favourable client link on the page: the target page beats another
 * page, and a followed link beats a nofollow one. Taking the first match in
 * document order instead could report a nofollow menu link while the article
 * carries the real one.
 */
export function pickBestLink(
  links: PageLink[],
  landingPage: string,
): { kind: LinkKind; link: PageLink } | null {
  let best: { kind: LinkKind; link: PageLink; score: number } | null = null;

  for (const link of links) {
    const kind = classifyLink(link.href, landingPage);
    if (!kind) continue;

    const score = (kind === 'target' ? 2 : 0) + (linkTypeFromRel(link.rel) === 'dofollow' ? 1 : 0);
    if (!best || score > best.score) {
      best = { kind, link, score };
    }
  }

  return best && { kind: best.kind, link: best.link };
}

/**
 * An article URL that now lands on the site's homepage has been removed: the
 * publisher redirects dead articles home rather than serving a 404.
 */
export function isRedirectToHomepage(requestedUrl: string, finalUrl?: string): boolean {
  if (!finalUrl) return false;
  const requested = parseHttpUrl(requestedUrl);
  const final = parseHttpUrl(finalUrl);
  if (!requested || !final) return false;

  return barePath(requested) !== '' && barePath(final) === '';
}

/** The domain no longer resolves: the site is gone from every network, not just blocking us. */
export function isDeadDomainError(message?: string): boolean {
  return !!message && /ERR_NAME_NOT_RESOLVED|ENOTFOUND/.test(message);
}

/** Undo one level of JSON/JS string escaping around markup. */
function unescapeOnce(text: string): string {
  return text
    .replace(/\\u003c/gi, '<')
    .replace(/\\u003e/gi, '>')
    .replace(/\\u0022/gi, '"')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u002f/gi, '/')
    .replace(/\\"/g, '"')
    .replace(/\\\//g, '/');
}

const ANCHOR_TAG = /<a\s[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const REL_ATTR = /\brel\s*=\s*["']([^"']*)["']/i;

/**
 * Anchors written inside inline script payloads.
 *
 * Paywalled publishers ship the full article - including the bought link - as
 * HTML inside a JSON blob and only render the teaser, so the DOM alone reports
 * the link as missing. Only real <a> tags count: a bare client URL in JSON
 * (schema.org data, tracking) is not proof that the article links to it.
 */
export function anchorsFromScripts(scripts: string[], baseUrl: string): PageLink[] {
  const links: PageLink[] = [];

  for (const script of scripts) {
    // Markup can be escaped several times (JSON inside a JSON string)
    let text = script;
    for (let i = 0; i < 3; i++) {
      const next = unescapeOnce(text);
      if (next === text) break;
      text = next;
    }

    for (const match of text.matchAll(ANCHOR_TAG)) {
      const [outerHTML, rawHref, inner] = match;
      let href: string;
      try {
        href = new URL(rawHref.replace(/&amp;/g, '&'), baseUrl).href;
      } catch {
        continue;
      }
      links.push({
        href,
        text: inner.replace(/<[^>]*>/g, '').trim(),
        outerHTML,
        rel: outerHTML.match(REL_ATTR)?.[1] ?? '',
        source: 'json',
      });
    }
  }

  return links;
}
