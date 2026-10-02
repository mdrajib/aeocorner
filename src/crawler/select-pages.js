/**
 * Which pages of a site matter for AEO (MVP F1 step 2: "select up to 20 key pages: nav, sitemap priority,
 * About / Pricing / Product / Service"). We cannot read a whole site, so we pick the pages an answer engine is
 * most likely to quote when it describes the business: the home page, the pages the site itself puts in its
 * menu, and the ones whose address says what they are (about, pricing, products, services, FAQ, contact), plus
 * a few recent articles.
 *
 * Pure functions, no network, so the rules are easy to read and to test.
 */

export const MAX_KEY_PAGES = 20;
export const MAX_RENDERED_PAGES = 5;

const TRACKING_PARAMS =
  /^(utm_.+|gclid|fbclid|msclkid|mc_cid|mc_eid|ref|ref_src|_ga|igshid|yclid|dclid|gbraid|wbraid)$/i;

const FILE_EXTENSIONS = new Set(
  (
    'pdf jpg jpeg png gif svg webp avif ico bmp zip gz tar rar 7z mp3 mp4 mov avi webm wav css js json xml txt rss atom ' +
    'doc docx xls xlsx ppt pptx csv woff woff2 ttf eot exe dmg apk'
  ).split(' '),
);

// Path segments that mean "not a page about the business": accounts, carts, search, feeds, blog archives, legal.
const EXCLUDED_SEGMENTS = new Set([
  'wp-admin',
  'wp-login.php',
  'wp-json',
  'wp-content',
  'wp-includes',
  'xmlrpc.php',
  'feed',
  'feeds',
  'login',
  'log-in',
  'signin',
  'sign-in',
  'signup',
  'sign-up',
  'register',
  'logout',
  'password',
  'reset-password',
  'cart',
  'checkout',
  'basket',
  'account',
  'my-account',
  'profile',
  'orders',
  'search',
  'cdn-cgi',
  'admin',
  'tag',
  'tags',
  'category',
  'categories',
  'author',
  'authors',
  'print',
  'privacy',
  'privacy-policy',
  'terms',
  'terms-of-service',
  'terms-and-conditions',
  'cookie',
  'cookies',
  'cookie-policy',
  'legal',
  'gdpr',
  'sitemap',
  'unsubscribe',
]);
const EXCLUDED_QUERY =
  /^(s|search|q|replytocom|add-to-cart|orderby|paged|page|sort|filter|print|share)$/i;

const PAGE_TYPE_SEGMENTS = [
  ['pricing', ['pricing', 'plans', 'prices', 'price', 'packages', 'rates']],
  [
    'faq',
    ['faq', 'faqs', 'frequently-asked-questions', 'questions', 'help', 'support', 'help-center'],
  ],
  [
    'contact',
    ['contact', 'contact-us', 'locations', 'find-us', 'get-in-touch', 'visit-us', 'location'],
  ],
  [
    'about',
    [
      'about',
      'about-us',
      'company',
      'who-we-are',
      'our-story',
      'team',
      'our-team',
      'mission',
      'story',
    ],
  ],
  ['product', ['product', 'products', 'features', 'platform', 'shop', 'store', 'catalog']],
  [
    'service',
    [
      'service',
      'services',
      'solutions',
      'what-we-do',
      'offerings',
      'capabilities',
      'practice-areas',
    ],
  ],
];
const ARTICLE_SECTIONS = new Set([
  'blog',
  'news',
  'articles',
  'article',
  'insights',
  'resources',
  'guides',
  'learn',
  'stories',
  'press',
  'posts',
  'journal',
  'case-studies',
  'research',
]);

// How much a kind of page is worth for answering "what is this business?". Menus and sitemaps add to it.
const TYPE_WEIGHT = {
  home: 1000,
  about: 100,
  pricing: 95,
  product: 90,
  service: 90,
  faq: 80,
  contact: 60,
  article: 40,
  other: 20,
};
// At most this many of a kind, so a blog with 500 posts doesn't crowd out the pages that define the business.
const TYPE_CAP = {
  article: 4,
  other: 5,
  product: 5,
  service: 5,
  faq: 3,
  about: 2,
  pricing: 2,
  contact: 2,
  home: 1,
};

/** Same site means the same host, with or without a leading "www." Subdomains are a different site in v0. */
export function sameSite(a, b) {
  const strip = (h) =>
    String(h)
      .toLowerCase()
      .replace(/^www\./, '')
      .replace(/\.$/, '');
  return strip(a) === strip(b);
}

/** One spelling per page: no fragment, no tracking parameters, no trailing slash, no `index.html`. Null if unusable. */
export function normalizePageUrl(href, base) {
  if (!String(href ?? '').trim()) return null; // an empty link means "this page", which is not a new one
  let url;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  let path = url.pathname
    .replace(/\/{2,}/g, '/')
    .replace(/\/(index|default)\.(html?|php|aspx?)$/i, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  url.pathname = path;
  return url.href.replace(/\?$/, '');
}

/** True for addresses that are not pages about the business (files, logins, carts, search, archives, legal). */
export function isExcludedPage(href) {
  const url = new URL(href);
  const segments = url.pathname.toLowerCase().split('/').filter(Boolean);
  const last = segments.at(-1) ?? '';
  const extension = /\.([a-z0-9]{2,5})$/.exec(last)?.[1];
  if (extension && FILE_EXTENSIONS.has(extension)) return true;
  if (segments.some((s) => EXCLUDED_SEGMENTS.has(s))) return true;
  if (/\/page\/\d+(\/|$)/i.test(url.pathname)) return true; // pagination: /blog/page/2
  return [...url.searchParams.keys()].some((k) => EXCLUDED_QUERY.test(k));
}

/** Guess what a page is from its address (and the words of the link that pointed to it). */
export function classifyPage(href, linkText = '') {
  const url = new URL(href);
  const segments = url.pathname.toLowerCase().split('/').filter(Boolean);
  if (segments.length === 0) return 'home';

  for (const [type, words] of PAGE_TYPE_SEGMENTS) {
    if (segments.some((s) => words.includes(s.replace(/\.(html?|php|aspx?)$/, '')))) return type;
  }
  // A page inside a blog or news section is an article; the section's own front page is not.
  if (segments.length >= 2 && ARTICLE_SECTIONS.has(segments[0])) return 'article';
  if (/^\d{4}$/.test(segments[0]) && segments.length >= 3) return 'article'; // /2026/09/post-title

  const text = linkText.toLowerCase().trim();
  if (/^(about|about us|our story|who we are|company|team)\b/.test(text)) return 'about';
  if (/^(pricing|plans|plans & pricing)\b/.test(text)) return 'pricing';
  if (/^(faq|faqs|help|support)\b/.test(text)) return 'faq';
  if (/^(contact|contact us)\b/.test(text)) return 'contact';
  return 'other';
}

/**
 * Choose up to `limit` pages to read. The home page is always first.
 *
 * @param {object} input
 * @param {string} input.home       the home page's final address (after redirects)
 * @param {{href: string, text?: string, area?: string}[]} [input.links]   links found on the home page
 * @param {{loc: string, lastmod?: Date|null, priority?: number|null}[]} [input.sitemapUrls]
 * @returns {{url: string, pageType: string, sources: string[], score: number}[]}
 */
export function selectPages({ home, links = [], sitemapUrls = [], limit = MAX_KEY_PAGES }) {
  const homeUrl = normalizePageUrl(home);
  if (!homeUrl) return [];
  const homeHost = new URL(homeUrl).hostname;
  const candidates = new Map();

  const consider = (href, source, { text = '', bonus = 0, lastmod = null } = {}) => {
    const url = normalizePageUrl(href, homeUrl);
    if (!url || url === homeUrl) return;
    if (!sameSite(new URL(url).hostname, homeHost) || isExcludedPage(url)) return;
    const existing = candidates.get(url) ?? {
      url,
      pageType: classifyPage(url, text),
      sources: [],
      score: 0,
      lastmod: null,
      text,
    };
    // A page listed in several places earns each one's bonus once.
    if (!existing.sources.includes(source)) {
      existing.sources.push(source);
      existing.score += bonus;
    }
    if (lastmod && (!existing.lastmod || lastmod > existing.lastmod)) existing.lastmod = lastmod;
    if (existing.pageType === 'other' && text) existing.pageType = classifyPage(url, text);
    candidates.set(url, existing);
  };

  for (const link of links) {
    const inMenu = link.area === 'nav' || link.area === 'header';
    consider(link.href, inMenu ? 'nav' : 'home-page', { text: link.text, bonus: inMenu ? 30 : 8 });
  }
  for (const entry of sitemapUrls) {
    consider(entry.loc, 'sitemap', {
      bonus: 4 + (entry.priority ?? 0.5) * 16,
      lastmod: entry.lastmod ?? null,
    });
  }

  const now = Date.now();
  for (const c of candidates.values()) {
    const depth = new URL(c.url).pathname.split('/').filter(Boolean).length;
    c.score += TYPE_WEIGHT[c.pageType] + Math.max(0, 12 - depth * 4);
    if (c.pageType === 'article' && c.lastmod) {
      const ageDays = (now - c.lastmod.getTime()) / 86_400_000;
      c.score += Math.max(0, 20 - ageDays / 30); // recent posts first, fading over about 20 months
    }
  }

  const ranked = [...candidates.values()].sort(
    (a, b) => b.score - a.score || a.url.localeCompare(b.url),
  );
  // First pass: the best pages, but only so many of one kind. Second pass: if places are left (a site whose
  // pages all look alike), fill them with the best of what remains.
  const taken = {};
  const chosen = new Set();
  for (const c of ranked) {
    if (chosen.size >= limit - 1) break;
    if ((taken[c.pageType] ?? 0) >= TYPE_CAP[c.pageType]) continue;
    taken[c.pageType] = (taken[c.pageType] ?? 0) + 1;
    chosen.add(c);
  }
  for (const c of ranked) {
    if (chosen.size >= limit - 1) break;
    chosen.add(c);
  }
  const inRankOrder = ranked
    .filter((c) => chosen.has(c))
    .map((c) => ({
      url: c.url,
      pageType: c.pageType,
      sources: c.sources,
      score: Math.round(c.score),
    }));
  return [
    { url: homeUrl, pageType: 'home', sources: ['home'], score: TYPE_WEIGHT.home },
    ...inRankOrder,
  ].slice(0, limit);
}

/**
 * Which of the chosen pages get the slower, headless-browser fetch (MVP F1: "a headless-rendered fetch for 5 of
 * them"): the home page, then the best page of each kind, then the best of what is left.
 */
export function pickRenderPages(selected, count = MAX_RENDERED_PAGES) {
  if (selected.length <= count) return selected.map((p) => p.url);
  const picked = [selected[0]];
  const seenTypes = new Set([selected[0].pageType]);
  for (const page of selected.slice(1)) {
    if (picked.length >= count) break;
    if (!seenTypes.has(page.pageType)) {
      picked.push(page);
      seenTypes.add(page.pageType);
    }
  }
  for (const page of selected.slice(1)) {
    if (picked.length >= count) break;
    if (!picked.includes(page)) picked.push(page);
  }
  return picked.map((p) => p.url);
}
