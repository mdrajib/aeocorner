import {
  homePage,
  NO_PAGES,
  pct,
  readablePages,
  sameAddress,
  sameSite,
  hostOf,
} from './helpers.js';

/**
 * F. Technical foundations (10 points). The basics that decide whether a page can be found and trusted at all.
 */

const hasNoindexHeader = (headers) =>
  /\bnoindex\b|\bnone\b/i.test(String(headers?.['x-robots-tag'] ?? ''));

/** F1 (4): key pages can be indexed (no noindex) and name themselves as the canonical address. */
export function f1(ctx) {
  const pages = readablePages(ctx);
  if (pages.length === 0) return NO_PAGES;

  const noindex = pages.filter((p) => p.facts.noindex || hasNoindexHeader(p.headers));
  const home = homePage(ctx);
  const homeBlocked = home && noindex.includes(home);

  // A canonical that names this page is right; none is a gap; one that names another page is a problem.
  const canonicalVerdicts = pages.map((p) => {
    if (!p.facts.canonical) return { url: p.url, verdict: 'missing', value: 0.5 };
    const self =
      sameAddress(p.facts.canonical, p.finalUrl ?? p.url) || sameAddress(p.facts.canonical, p.url);
    return self
      ? { url: p.url, verdict: 'self', value: 1 }
      : {
          url: p.url,
          verdict: sameSite(hostOf(p.facts.canonical), hostOf(p.url))
            ? 'points_elsewhere'
            : 'other_site',
          canonical: p.facts.canonical,
          value: 0,
        };
  });
  const canonicalScore =
    canonicalVerdicts.reduce((sum, v) => sum + v.value, 0) / canonicalVerdicts.length;
  const indexScore = 1 - noindex.length / pages.length;
  const evidence = {
    noindex: noindex.map((p) => p.url),
    canonicals: canonicalVerdicts.filter((v) => v.verdict !== 'self'),
  };

  if (homeBlocked) {
    return {
      score: 0,
      summary: `The home page tells search engines not to index it (noindex), so it will not appear in results. This is the setting staging sites use.`,
      evidence,
    };
  }
  const problems = [];
  if (noindex.length)
    problems.push(`${noindex.length} of ${pages.length} pages are marked noindex`);
  const elsewhere = canonicalVerdicts.filter(
    (v) => v.verdict === 'points_elsewhere' || v.verdict === 'other_site',
  );
  if (elsewhere.length)
    problems.push(
      `${elsewhere.length} name a different page as canonical (such as ${elsewhere[0].url})`,
    );
  const missing = canonicalVerdicts.filter((v) => v.verdict === 'missing');
  if (missing.length) problems.push(`${missing.length} have no canonical tag`);
  return {
    score: 0.5 * indexScore + 0.5 * canonicalScore,
    summary: problems.length
      ? `${problems.join('; ')}.`
      : `All ${pages.length} key pages can be indexed and name themselves as canonical.`,
    evidence,
  };
}

/** F2 (2): the site is on HTTPS, key pages answer 200, and none sit behind a chain of redirects. */
export function f2(ctx) {
  const answered = ctx.pages.filter((p) => typeof p.status === 'number');
  if (answered.length === 0) return NO_PAGES;
  const home = ctx.pages.find((p) => p.pageType === 'home');
  const https = Boolean((home?.finalUrl ?? ctx.site.homeUrl ?? '').startsWith('https://'));
  const ok = answered.filter((p) => p.status >= 200 && p.status < 300);
  const chained = answered.filter((p) => (p.redirectCount ?? 0) > 1);
  const score =
    0.25 * (https ? 1 : 0) +
    0.5 * (ok.length / answered.length) +
    0.25 * (1 - chained.length / answered.length);
  const problems = [];
  if (!https) problems.push('the site is not served over HTTPS');
  if (ok.length < answered.length)
    problems.push(`${answered.length - ok.length} of ${answered.length} pages did not answer 200`);
  if (chained.length) problems.push(`${chained.length} pages go through more than one redirect`);
  return {
    score,
    summary: problems.length
      ? `${problems.join('; ')}.`
      : 'The site is on HTTPS and every key page answers 200 directly.',
    evidence: {
      https,
      notOk: answered
        .filter((p) => p.status < 200 || p.status >= 300)
        .map((p) => ({ url: p.url, status: p.status }))
        .slice(0, 10),
      redirectChains: chained.map((p) => ({ url: p.url, redirects: p.redirectCount })).slice(0, 10),
    },
  };
}

/** F3 (3): every page has a title and a meta description, and no two share one. */
export function f3(ctx) {
  const pages = readablePages(ctx);
  if (pages.length === 0) return NO_PAGES;
  const withTitle = pages.filter((p) => p.facts.title);
  const withDescription = pages.filter((p) => p.facts.metaDescription);
  const duplicated = (field) => {
    const counts = new Map();
    for (const p of pages)
      if (p.facts[field]) counts.set(p.facts[field], (counts.get(p.facts[field]) ?? 0) + 1);
    return pages.filter((p) => p.facts[field] && counts.get(p.facts[field]) > 1);
  };
  const dupTitles = duplicated('title');
  const dupDescriptions = duplicated('metaDescription');
  const unique = 1 - (dupTitles.length + dupDescriptions.length) / (2 * pages.length);
  const score =
    (withTitle.length / pages.length + withDescription.length / pages.length + unique) / 3;
  const problems = [];
  if (withTitle.length < pages.length)
    problems.push(`${pages.length - withTitle.length} pages have no title`);
  if (withDescription.length < pages.length)
    problems.push(`${pages.length - withDescription.length} pages have no meta description`);
  if (dupTitles.length) problems.push(`${dupTitles.length} pages share a title`);
  if (dupDescriptions.length) problems.push(`${dupDescriptions.length} pages share a description`);
  return {
    score,
    summary: problems.length
      ? `${problems.join('; ')}.`
      : `All ${pages.length} pages have their own title and description.`,
    evidence: {
      titles: pct(withTitle.length / pages.length),
      descriptions: pct(withDescription.length / pages.length),
      duplicateTitles: dupTitles.map((p) => p.url).slice(0, 10),
      duplicateDescriptions: dupDescriptions.map((p) => p.url).slice(0, 10),
    },
  };
}

/** F4 (1): an llms.txt file. Informational: the major engines have not said they read it. */
export function f4(ctx) {
  const llms = ctx.llmsTxt;
  if (!llms || llms.status === 'error') {
    return {
      status: 'error',
      summary: 'llms.txt could not be checked.',
      evidence: { informational: true, httpStatus: llms?.httpStatus ?? null },
    };
  }
  return {
    score: llms.status === 'present' ? 1 : 0,
    summary:
      llms.status === 'present'
        ? 'An llms.txt file is present.'
        : 'There is no llms.txt. This is optional: the major engines have not said they use it.',
    evidence: { informational: true, httpStatus: llms.httpStatus ?? null, key: llms.key ?? null },
  };
}
