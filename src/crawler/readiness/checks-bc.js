import {
  homePage,
  isOrganizationNode,
  NO_PAGES,
  organizationNodes,
  pageBasics,
  pct,
  readablePages,
  schemaTypes,
  stringsOf,
} from './helpers.js';

/**
 * B. Renderability (10 points). Most AI crawlers do not run JavaScript (MVP §7 key architectural fact), so
 * whatever is only added by scripts is invisible to them.
 * C. Structured data (20 points). Schema.org JSON-LD tells an engine what a page IS without guessing.
 */

/** Below this much text, a page has nothing meaningful to compare raw against rendered. */
const MIN_COMPARABLE_CHARS = 200;
const RAW_SHARE_NEEDED = 0.8;

/** B1 (7): the main content is in the raw HTML (raw text is at least 80% of the rendered text). */
export function b1(ctx) {
  const pages = readablePages(ctx);
  if (pages.length === 0) return NO_PAGES;
  const rendered = pages.filter((p) => p.rendered?.facts && !p.rendered.facts.skipped);
  if (rendered.length === 0) {
    return {
      status: 'error',
      summary:
        'No page could be rendered in a browser, so raw and rendered content could not be compared.',
      evidence: {
        reason: 'no_rendered_pages',
        renderErrors: pages.map((p) => p.rendered?.error).filter(Boolean),
      },
    };
  }

  const compared = rendered
    .map((p) => {
      const rawChars = p.facts.visibleTextChars;
      const renderedChars = p.rendered.facts.visibleTextChars;
      return {
        url: p.url,
        rawChars,
        renderedChars,
        ratio: renderedChars > 0 ? Math.min(1, rawChars / renderedChars) : 1,
        platform: p.facts.platform,
      };
    })
    .filter((p) => p.renderedChars >= MIN_COMPARABLE_CHARS);

  if (compared.length === 0) {
    return {
      status: 'not_applicable',
      summary: 'The pages checked have very little text, so there is nothing to compare.',
      evidence: { pages: rendered.length },
    };
  }
  const good = compared.filter((p) => p.ratio >= RAW_SHARE_NEEDED);
  const worst = [...compared].sort((a, b) => a.ratio - b.ratio)[0];
  return {
    score: good.length / compared.length,
    summary:
      good.length === compared.length
        ? `The main content is in the raw HTML on all ${compared.length} pages compared (lowest: ${pct(worst.ratio)}).`
        : `Only ${pct(worst.ratio)} of the text on ${worst.url} is in the raw HTML; the rest is added by JavaScript, which most AI crawlers do not run.`,
    evidence: { threshold: RAW_SHARE_NEEDED, pages: compared },
  };
}

/** B2 (3): key content is not hidden behind iframes, tabs or accordions that hide text until clicked. */
export function b2(ctx) {
  const pages = readablePages(ctx);
  if (pages.length === 0) return NO_PAGES;
  const flagged = [];
  for (const p of pages) {
    // Judge the rendered page when we have it: that is where script-built tabs and accordions show up.
    const facts = p.rendered?.facts && !p.rendered.facts.skipped ? p.rendered.facts : p.facts;
    const reasons = [];
    if (facts.iframes.length > 0 && facts.visibleTextChars < 600) {
      reasons.push('the page is mostly an embedded frame (its content belongs to another address)');
    }
    if (facts.textChars > 500 && facts.hiddenTextChars / facts.textChars > 0.4) {
      reasons.push(
        `${pct(facts.hiddenTextChars / facts.textChars)} of the text is hidden until a click`,
      );
    }
    if (reasons.length) flagged.push({ url: p.url, reasons });
  }
  return {
    score: 1 - flagged.length / pages.length,
    summary: flagged.length
      ? `Key content is hidden or embedded on ${flagged.length} of ${pages.length} pages, such as ${flagged[0].url}.`
      : `No key content is hidden behind frames, tabs or accordions on the ${pages.length} pages checked.`,
    evidence: { flagged, pages: pages.length },
  };
}

// --- C. Structured data --------------------------------------------------------------------------------------

const present = (value) => stringsOf(value).length > 0;

/** C1 (6): an Organization (or local business) with name, logo, url and sameAs. A quarter of the points per field. */
export function c1(ctx) {
  const pages = readablePages(ctx);
  if (pages.length === 0) return NO_PAGES;
  const fieldsOf = (node) => ({
    name: present(node.name),
    logo: present(node.logo) || present(node.image),
    url: present(node.url),
    sameAs: present(node.sameAs),
  });
  let best = null;
  for (const p of pages) {
    for (const node of organizationNodes(p.facts)) {
      const fields = fieldsOf(node);
      const count = Object.values(fields).filter(Boolean).length;
      if (!best || count > best.count)
        best = { count, fields, page: p.url, type: [node['@type']].flat()[0] };
    }
  }
  if (!best) {
    const onlyRendered = pages.some((p) =>
      p.rendered?.facts?.jsonLd?.nodes?.some(isOrganizationNode),
    );
    return {
      score: 0,
      summary: onlyRendered
        ? 'An Organization schema exists only after JavaScript runs, so most AI crawlers never see it.'
        : 'No Organization or LocalBusiness schema was found.',
      evidence: { found: false, onlyAddedByJavaScript: onlyRendered },
    };
  }
  const missing = Object.entries(best.fields)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  return {
    score: best.count / 4,
    summary: missing.length
      ? `The ${best.type} schema on ${best.page} is missing ${missing.join(', ')}.`
      : `A complete ${best.type} schema (name, logo, URL, sameAs) is on ${best.page}.`,
    evidence: { found: true, page: best.page, type: best.type, fields: best.fields },
  };
}

// The schema type a key page of each kind should carry, any one of which counts.
const EXPECTED_TYPES = {
  product: [
    'Product',
    'SoftwareApplication',
    'WebApplication',
    'MobileApplication',
    'Service',
    'Offer',
  ],
  service: ['Service', 'ProfessionalService', 'LocalBusiness', 'Product'],
  article: ['Article', 'BlogPosting', 'NewsArticle', 'TechArticle', 'ScholarlyArticle', 'Report'],
  faq: ['FAQPage'],
  pricing: ['Product', 'Offer', 'AggregateOffer', 'Service', 'SoftwareApplication', 'FAQPage'],
  about: ['AboutPage', 'Organization', 'LocalBusiness', 'Corporation', 'Person', 'ProfilePage'],
  contact: ['ContactPage', 'LocalBusiness', 'Organization'],
};

/** C2 (8): each key page carries the schema type that fits what it is. */
export function c2(ctx) {
  const pages = readablePages(ctx);
  if (pages.length === 0) return NO_PAGES;
  const applicable = pages.filter((p) => EXPECTED_TYPES[p.pageType]);
  if (applicable.length === 0) {
    return {
      status: 'not_applicable',
      summary:
        'None of the pages checked is a kind (product, service, article, FAQ...) that has its own schema type.',
      evidence: { pages: pages.length },
    };
  }
  const results = applicable.map((p) => {
    const wanted = EXPECTED_TYPES[p.pageType];
    const has = [...schemaTypes(p.facts)].filter((t) => wanted.includes(t));
    const renderedHas = [...schemaTypes(p.rendered?.facts)].filter((t) => wanted.includes(t));
    return {
      url: p.url,
      pageType: p.pageType,
      expected: wanted,
      found: has,
      ok: has.length > 0,
      onlyAfterJavaScript: has.length === 0 && renderedHas.length > 0,
      // What Auto-fix may build the missing block from: only what the page itself says.
      ...(has.length === 0 && renderedHas.length === 0 ? { basics: pageBasics(p) } : {}),
    };
  });
  const ok = results.filter((r) => r.ok);
  const lacking = results.find((r) => !r.ok);
  return {
    score: ok.length / results.length,
    summary: lacking
      ? `${results.length - ok.length} of ${results.length} key pages lack their schema type, such as ${lacking.url} (a ${lacking.pageType} page; ${lacking.expected.slice(0, 3).join(' / ')} fits).`
      : `All ${results.length} key pages carry the schema type that fits them.`,
    evidence: { pages: results },
  };
}

/** C3 (3): the JSON-LD is valid and is in the HTML the server sends (not added later by scripts). */
export function c3(ctx) {
  const pages = readablePages(ctx);
  if (pages.length === 0) return NO_PAGES;
  const blocks = pages.reduce((sum, p) => sum + p.facts.jsonLd.blocks, 0);
  const broken = pages.reduce(
    (sum, p) => sum + p.facts.jsonLd.parseErrors + p.facts.jsonLd.oversize,
    0,
  );
  if (blocks === 0) {
    const renderedBlocks = pages.reduce(
      (sum, p) => sum + (p.rendered?.facts?.jsonLd?.blocks ?? 0),
      0,
    );
    return {
      score: 0,
      summary: renderedBlocks
        ? 'Structured data is added by JavaScript only, so most AI crawlers never see it. It must be in the HTML the server sends.'
        : 'No JSON-LD structured data was found on any page checked.',
      evidence: { blocks: 0, addedByJavaScript: renderedBlocks },
    };
  }
  const badPage = pages.find((p) => p.facts.jsonLd.parseErrors > 0);
  return {
    score: 1 - broken / blocks,
    summary: broken
      ? `${broken} of ${blocks} JSON-LD blocks are not valid JSON${badPage ? `, for example on ${badPage.url}` : ''}.`
      : `All ${blocks} JSON-LD blocks are valid and in the server's HTML.`,
    evidence: { blocks, invalid: broken },
  };
}

/** C4 (3): WebSite schema on the home page, and BreadcrumbList on inner pages. */
export function c4(ctx) {
  const pages = readablePages(ctx);
  if (pages.length === 0) return NO_PAGES;
  const home = homePage(ctx);
  const hasWebSite = home ? schemaTypes(home.facts).has('WebSite') : false;
  const inner = pages.filter(
    (p) => p.pageType !== 'home' && new URL(p.url).pathname.split('/').filter(Boolean).length >= 1,
  );
  const withCrumbs = inner.filter((p) => schemaTypes(p.facts).has('BreadcrumbList'));

  let score;
  let summary;
  if (inner.length === 0) {
    score = hasWebSite ? 1 : 0;
    summary = hasWebSite
      ? 'The home page has WebSite schema.'
      : 'The home page has no WebSite schema.';
  } else {
    const share = withCrumbs.length / inner.length;
    score = (hasWebSite ? 0.5 : 0) + 0.5 * Math.min(1, share / 0.5);
    const parts = [];
    parts.push(
      hasWebSite ? 'The home page has WebSite schema' : 'The home page has no WebSite schema',
    );
    parts.push(`${withCrumbs.length} of ${inner.length} inner pages have BreadcrumbList`);
    summary = `${parts.join('; ')}.`;
  }
  return {
    score,
    summary,
    evidence: { webSite: hasWebSite, innerPages: inner.length, withBreadcrumbs: withCrumbs.length },
  };
}
