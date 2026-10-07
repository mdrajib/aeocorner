/**
 * What the free sitemap checker says about a site's sitemap (Milestone 17, task 17.08). Pure: it takes what
 * `readSitemap` and `fetchRobots` gathered and returns the findings shape of `tool-findings.js`. It mirrors readiness
 * check A4 (a sitemap exists and robots.txt points to it), and adds what a person can fix from a list: how many addresses,
 * how fresh the dates are, and addresses that crawlers will ignore.
 *
 * Only counts and a few example addresses come out; the file itself never does. "We could not look" is the tool's
 * `CouldntCheck` and never reaches here: this module is for a sitemap that was found or a site that really has none.
 */

const DAY_MS = 86_400_000;
const STALE_DAYS = 365;
const SAMPLE = 10;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
};
/** On the site, or one of its subdomains. A different registered domain is "another site". */
const onSite = (host, domain) =>
  host === domain || host === `www.${domain}` || host.endsWith(`.${domain}`);

const isoDay = (date) => date.toISOString().slice(0, 10);

/**
 * @param {object} input
 * @param {{ origin: string, domain: string }} input.site
 * @param {{ status: 'ok' | 'missing' | 'unreachable', parsed: object | null }} input.robots
 * @param {{ found: object[], referenced: string[], urls: { loc: string, lastmod: Date | null }[] }} input.sitemaps
 * @param {Date} input.now
 * @param {number} [input.childrenRead]  child sitemaps read from an index
 */
export function sitemapFindings({ site, robots, sitemaps, now, childrenRead = 0 }) {
  const { found, referenced, urls } = sitemaps;
  const top = found[0] ?? null;
  const robotsKnown = robots.status !== 'unreachable';
  const declared = referenced.length > 0;

  let headline;
  if (top && declared) headline = `Your sitemap is at ${top.url}, and robots.txt points to it`;
  else if (top) headline = `Your sitemap is at ${top.url}, but robots.txt does not point to it`;
  else if (declared) headline = 'robots.txt points to a sitemap, but we could not read it as one';
  else
    headline = 'We found no sitemap at the usual addresses, and robots.txt does not point to one';

  const rows = [];
  rows.push(
    top
      ? {
          label: 'Sitemap found',
          state: 'good',
          value:
            top.kind === 'index'
              ? 'Index of sitemaps'
              : top.kind === 'text'
                ? 'Text list'
                : 'XML list',
          detail: top.url,
        }
      : {
          label: 'Sitemap found',
          state: 'warn',
          value: 'No',
          detail: declared
            ? 'robots.txt names a sitemap, but the address did not give us a valid one.'
            : 'A sitemap is optional, and crawlers also find pages by following links. It helps them find pages that are not linked well, and tells them what changed.',
        },
  );

  rows.push(
    !robotsKnown
      ? {
          label: 'robots.txt points to it',
          state: 'unknown',
          detail: 'We could not read robots.txt.',
        }
      : declared
        ? {
            label: 'robots.txt points to it',
            state: 'good',
            value: 'Yes',
            detail: `${plural(referenced.length, 'Sitemap line')} in robots.txt.`,
          }
        : {
            label: 'robots.txt points to it',
            state: 'warn',
            value: 'No',
            detail: top
              ? `Add a line to robots.txt: Sitemap: ${top.url}`
              : 'robots.txt has no “Sitemap:” line.',
          },
  );

  if (top) {
    const partial = top.kind === 'index' && childrenRead < top.children;
    if (top.kind === 'index') {
      rows.push({
        label: 'Sitemaps in the index',
        state: 'neutral',
        value: String(top.children),
        detail: partial
          ? `We read ${childrenRead} of them, so the counts below are for that part.`
          : `We read all of them.`,
      });
    }
    rows.push({
      label: 'Addresses listed',
      state: urls.length ? 'neutral' : 'warn',
      value: `${partial ? 'at least ' : ''}${urls.length.toLocaleString('en-US')}`,
      detail: urls.length ? '' : 'The sitemap lists no pages.',
    });

    // Dates: crawlers use them to decide what to fetch again.
    const dated = urls.filter(
      (u) => u.lastmod instanceof Date && !Number.isNaN(u.lastmod.getTime()),
    );
    if (urls.length) {
      if (dated.length === 0) {
        rows.push({
          label: 'Last-modified dates',
          state: 'warn',
          value: 'None',
          detail: 'No address has a date, so a crawler cannot tell which pages changed.',
        });
      } else {
        const newest = new Date(Math.max(...dated.map((u) => u.lastmod.getTime())));
        const ageDays = Math.floor((now.getTime() - newest.getTime()) / DAY_MS);
        const stale = ageDays > STALE_DAYS;
        rows.push({
          label: 'Last-modified dates',
          state: stale || dated.length < urls.length / 2 ? 'warn' : 'good',
          value: `${dated.length.toLocaleString('en-US')} of ${urls.length.toLocaleString('en-US')}`,
          detail: `The newest is ${isoDay(newest)}${ageDays >= 0 ? ` (${plural(ageDays, 'day')} ago)` : ''}.${stale ? ' That is over a year old: if the site has changed since, the dates are not being kept up.' : ''}`,
        });
      }
    }

    // Addresses a crawler will not use.
    const foreign = urls.filter((u) => !onSite(hostOf(u.loc), site.domain)).length;
    if (foreign) {
      rows.push({
        label: 'Addresses on another site',
        state: 'warn',
        value: String(foreign),
        detail: 'A sitemap may list only addresses on its own site, so crawlers ignore these.',
      });
    }
    const insecure = site.origin.startsWith('https://')
      ? urls.filter((u) => u.loc.startsWith('http://')).length
      : 0;
    if (insecure) {
      rows.push({
        label: 'Addresses without https',
        state: 'warn',
        value: String(insecure),
        detail:
          'The site uses https, so these addresses probably redirect. List the https address.',
      });
    }
  }

  const sections = [{ heading: 'Your sitemap', rows }];
  const lines = urls.length
    ? {
        heading: 'A few of the addresses listed',
        items: urls.slice(0, SAMPLE).map((u) => u.loc),
        more: Math.max(0, urls.length - SAMPLE),
      }
    : null;

  const notes = [
    'We read the sitemap and up to three of the sitemaps in an index. A large site may have more than we read.',
    'A sitemap does not make a search or AI engine fetch or use a page. It only tells crawlers where your pages are.',
  ];

  return { headline, sections, ...(lines ? { lines } : {}), notes };
}
