/**
 * What kind of site is a cited source? (Milestone 13, task 13.01.) Decided by rules and a reviewed list, never by a model:
 * a site that is not on the list and matches no rule is "other". Wrongly guessing "this is a forum" would send a customer
 * to the wrong kind of place, so not knowing is a legitimate answer.
 *
 * The types:
 *   own          the brand's own site (decided per project from the customer's domain, not from the list)
 *   competitor   a tracked competitor's site (same)
 *   review       a review site or a business directory
 *   forum        a forum or community where people write the posts
 *   news         news and media
 *   docs         documentation, a wiki, an encyclopedia or a code host
 *   marketplace  a shop or marketplace that lists many sellers
 *   other        anything else
 *
 * Domains are compared as registrable names: `www.` is dropped, and a listed name also matches its subdomains
 * (`uk.trustpilot.com`). The list is deliberately short and well known; adding to it is a reviewed change.
 */

export const SOURCE_TYPES = Object.freeze([
  'own',
  'competitor',
  'review',
  'forum',
  'news',
  'docs',
  'marketplace',
  'other',
]);

export const SOURCE_TYPE_LABELS = Object.freeze({
  own: 'Your site',
  competitor: 'Competitor',
  review: 'Review site or directory',
  forum: 'Forum or community',
  news: 'News and media',
  docs: 'Documentation or wiki',
  marketplace: 'Marketplace',
  other: 'Other',
});

/** The reviewed list. One entry per registrable domain. */
export const KNOWN_SOURCES = Object.freeze({
  review: [
    'g2.com',
    'capterra.com',
    'trustpilot.com',
    'getapp.com',
    'softwareadvice.com',
    'gartner.com',
    'trustradius.com',
    'sitejabber.com',
    'yelp.com',
    'tripadvisor.com',
    'clutch.co',
    'goodfirms.co',
    'bbb.org',
    'angi.com',
    'yellowpages.com',
    'glassdoor.com',
    'consumerreports.org',
    'productreview.com.au',
    'which.co.uk',
    'producthunt.com',
    'crunchbase.com',
  ],
  forum: [
    'reddit.com',
    'quora.com',
    'stackoverflow.com',
    'stackexchange.com',
    'news.ycombinator.com',
    'discourse.org',
    'community.cloudflare.com',
    'answers.microsoft.com',
    'tumblr.com',
    'medium.com',
    'substack.com',
    'dev.to',
    'hashnode.com',
  ],
  news: [
    'nytimes.com',
    'wsj.com',
    'washingtonpost.com',
    'theguardian.com',
    'bbc.com',
    'bbc.co.uk',
    'cnn.com',
    'reuters.com',
    'bloomberg.com',
    'forbes.com',
    'businessinsider.com',
    'techcrunch.com',
    'theverge.com',
    'wired.com',
    'cnet.com',
    'zdnet.com',
    'engadget.com',
    'fortune.com',
    'inc.com',
    'entrepreneur.com',
    'fastcompany.com',
    'axios.com',
    'apnews.com',
    'usatoday.com',
    'npr.org',
    'time.com',
    'huffpost.com',
    'independent.co.uk',
    'telegraph.co.uk',
    'techradar.com',
    'pcmag.com',
    'tomsguide.com',
    'searchengineland.com',
    'searchenginejournal.com',
  ],
  docs: [
    'wikipedia.org',
    'wikidata.org',
    'wikihow.com',
    'britannica.com',
    'github.com',
    'gitlab.com',
    'readthedocs.io',
    'developer.mozilla.org',
    'w3.org',
    'schema.org',
    'learn.microsoft.com',
    'docs.github.com',
    'support.google.com',
    'developers.google.com',
    'cloud.google.com',
    'docs.aws.amazon.com',
    'kubernetes.io',
    'npmjs.com',
    'pypi.org',
  ],
  marketplace: [
    'amazon.com',
    'amazon.co.uk',
    'ebay.com',
    'etsy.com',
    'walmart.com',
    'target.com',
    'bestbuy.com',
    'alibaba.com',
    'aliexpress.com',
    'shopify.com',
    'apps.apple.com',
    'play.google.com',
    'chromewebstore.google.com',
    'appsource.microsoft.com',
    'marketplace.visualstudio.com',
    'wordpress.org',
  ],
});

/** A host with `www.` removed, lower case, no port or trailing dot; '' when it is not a plain host name. */
export function normalizeDomain(value) {
  const host = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, '')
    .replace(/\.$/, '')
    .replace(/^www\./, '');
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) ? host : '';
}

const matches = (domain, listed) => domain === listed || domain.endsWith(`.${listed}`);

// Hosts whose first label says what they are: `docs.example.com`, `developer.example.com`.
const DOC_LABELS = new Set(['docs', 'doc', 'developer', 'developers', 'wiki', 'help', 'support']);

const LOOKUP = (() => {
  const out = [];
  for (const [type, list] of Object.entries(KNOWN_SOURCES))
    for (const d of list) out.push([d, type]);
  // The longest name wins, so `docs.github.com` is not decided by a shorter entry.
  return out.sort((a, b) => b[0].length - a[0].length);
})();

/**
 * The type of one cited domain.
 *
 * @param domain       the cited site's domain
 * @param ownDomains   the brand's own domains (decided per project)
 * @param rivalDomains the tracked competitors' domains
 * @returns one of `SOURCE_TYPES`; "other" when nothing in the rules or the list says otherwise
 */
export function classifyDomain(domain, { ownDomains = [], rivalDomains = [] } = {}) {
  const d = normalizeDomain(domain);
  if (!d) return 'other';
  if (ownDomains.map(normalizeDomain).some((o) => o && matches(d, o))) return 'own';
  if (rivalDomains.map(normalizeDomain).some((o) => o && matches(d, o))) return 'competitor';
  for (const [listed, type] of LOOKUP) if (matches(d, listed)) return type;
  if (DOC_LABELS.has(d.split('.')[0]) && d.split('.').length > 2) return 'docs';
  return 'other';
}

/**
 * Count cited sources by type, with each type's share of all citations.
 *
 * @param domains  `[{ domain, timesCited, own, ownerEntityIds? }]`; a site flagged `own` is the brand's even if the
 *                 customer's domain list does not name it
 * @returns `[{ type, label, timesCited, sites, share }]` for every type that has a citation, most cited first (ties by
 *   type name); `share` is a whole percent of all citations in `domains`, or null when there are none
 */
export function typeBreakdown(domains, context = {}) {
  const total = domains.reduce((n, d) => n + Number(d.timesCited), 0);
  const byType = new Map();
  for (const d of domains) {
    const type = d.own ? 'own' : classifyDomain(d.domain, context);
    const row = byType.get(type) ?? {
      type,
      label: SOURCE_TYPE_LABELS[type],
      timesCited: 0,
      sites: 0,
    };
    row.timesCited += Number(d.timesCited);
    row.sites += 1;
    byType.set(type, row);
  }
  return [...byType.values()]
    .map((r) => ({ ...r, share: total === 0 ? null : Math.round((r.timesCited / total) * 100) }))
    .sort((a, b) => b.timesCited - a.timesCited || a.type.localeCompare(b.type));
}
