import { z } from 'zod';
import {
  fetchRobots,
  newSitemapState,
  readSitemap,
  sitemapCandidates,
} from '../../crawler/gather.js';
import { FetchError } from '../../crawler/safe-fetch.js';
import { sitemapFindings } from '../../core/tool-sitemap.js';
import { CouldntCheck, plainReason } from '../../lib/tool-runner.js';
import { normalizeWebsite } from '../../lib/url.js';

/**
 * Sitemap checker (Milestone 17, task 17.08). The visitor gives a site, or the address of a sitemap. We read robots.txt
 * (to see whether it points to a sitemap), then the sitemap: the one the visitor named, else the ones robots.txt names,
 * else the usual addresses, stopping at the first real one. An index is followed one level, to at most three files,
 * inside the run's five fetches. The judging is `src/core/tool-sitemap.js`.
 *
 * Sitemaps and robots.txt are files made for crawlers, so they are fetched directly (ADR-0017, decision 4). A sitemap we
 * could not look at is "couldn't check": a firewall page, a 5xx, a 429 or a failed connection on any address we tried is
 * never "no sitemap". Only a site that answered "not found" everywhere has none.
 */

const MAX_URLS = 50_000;
const MAX_CHILDREN = 3;

const schema = z.object({
  url: z.string({ error: normalizeWebsite('').message }).transform((raw, ctx) => {
    const site = normalizeWebsite(raw);
    if (!site.ok) {
      ctx.addIssue({ code: 'custom', message: site.message });
      return z.NEVER;
    }
    const u = new URL(site.url);
    // An address with a path that looks like a sitemap is the sitemap itself; anything else is the site.
    const isSitemap = u.pathname !== '/' && /(\.xml(\.gz)?|\.txt)$|sitemap/i.test(u.pathname);
    return {
      origin: u.origin,
      domain: site.domain,
      sitemapUrl: isSitemap ? `${u.origin}${u.pathname}` : null,
    };
  }),
});

/** Wraps `get` to remember when a look went wrong (an error, a 429 or a 5xx), which is not the same as "not found". */
function watching(get) {
  const trouble = [];
  const watched = async (url, options) => {
    const res = await get(url, options);
    if (!res.ok) trouble.push(res.error.code);
    else if (res.status === 429 || res.status >= 500) trouble.push(`http_${res.status}`);
    return res;
  };
  return { get: watched, trouble };
}

export const sitemapChecker = {
  slug: 'sitemap-checker',
  kind: 'fetch',
  name: 'Sitemap checker',
  crumb: 'Sitemap checker',
  title: 'Sitemap checker for search and AI crawlers (free) | AEO Corner',
  description:
    'Free sitemap checker: see whether your site has an XML sitemap, whether robots.txt points to it, and how many pages and dates it lists. No account needed.',
  lastmod: '2026-10-06',
  lead: 'Enter your website address, or the address of a sitemap, and see whether you have one, whether robots.txt points to it, and how many pages and dates it lists.',
  cannotSee:
    'This tool reads your sitemap and counts its addresses and dates. It cannot tell you whether search or AI engines have fetched, indexed or used those pages. A sitemap only tells crawlers where your pages are. We read up to three sitemaps in an index.',
  faq: [
    {
      q: 'Do I need a sitemap?',
      a: 'Not always. Crawlers also find pages by following links. A sitemap helps most when a site is large, new, or has pages that few links point to, and it can tell crawlers which pages changed.',
    },
    {
      q: 'Where should my sitemap be?',
      a: 'Most sites put it at /sitemap.xml, and add a Sitemap line to robots.txt with its full address so crawlers can find it wherever it is. This tool checks both places.',
    },
    {
      q: 'What is a sitemap index?',
      a: 'A big site can split its sitemap into several files and list them in one index file. This tool reads the index and up to three of the files it lists, so the count may be for only part of the site.',
    },
    {
      q: 'Why does it say some addresses are on another site?',
      a: 'A sitemap may list only addresses on the site that hosts it, and crawlers ignore the others. This often means an old domain name was left in the file after a move.',
    },
  ],
  submitLabel: 'Check my sitemap',
  fields: [
    {
      name: 'url',
      label: 'Website or sitemap address',
      type: 'text',
      inputmode: 'url',
      autocomplete: 'url',
      placeholder: 'yourcompany.com',
      hint: 'Your website, or the full address of your sitemap file.',
    },
  ],
  schema,
  domain: (input) => input.url.domain,

  async run(ctx, { url: site }) {
    const { get, trouble } = watching(ctx.get);
    const robots = await fetchRobots(get, site.origin);
    const state = newSitemapState(robots);
    const stop = () => ctx.fetchesLeft() <= 0;

    const declared = robots.parsed?.sitemaps.length > 0;
    const candidates = site.sitemapUrl ? [site.sitemapUrl] : sitemapCandidates(robots, site.origin);
    for (const candidate of candidates) {
      if (stop()) break;
      const found = await readSitemap(get, candidate, state, {
        maxUrls: MAX_URLS,
        maxChildren: Math.min(MAX_CHILDREN, ctx.fetchesLeft()),
        stop,
      });
      // The usual addresses are guesses: stop at the first real one. Addresses robots.txt names are all read.
      if (found && !declared && !site.sitemapUrl) break;
    }

    // Never "no sitemap" when we could not look.
    if (state.found.length === 0) {
      if (state.blocked)
        throw new CouldntCheck(
          'The site turned our request away from the sitemap (a firewall or a rate limit), so we could not tell whether it has one.',
        );
      if (trouble.length) {
        const code = trouble.find((t) => !t.startsWith('http_') && t !== 'tool_fetch_cap');
        throw new CouldntCheck(
          code
            ? plainReason(new FetchError(code, ''))
            : 'The site gave an error when we asked for its sitemap, so we could not tell whether it has one.',
        );
      }
    }

    return sitemapFindings({
      site: { origin: site.origin, domain: site.domain },
      robots,
      sitemaps: state,
      now: new Date(),
      childrenRead: Math.max(0, state.found.length - 1),
    });
  },
};
