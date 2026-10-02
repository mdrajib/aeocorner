import { extractPage } from '../../src/crawler/html.js';
import { parseRobots } from '../../src/crawler/robots.js';
import { finishCheck } from '../../src/crawler/readiness/rubric.js';
import * as readiness from '../../src/crawler/readiness/index.js';

/**
 * Fixtures for the readiness checks: small, readable pages and a scan context to put them in, so each test shows
 * in a few lines what a site looked like and what the check made of it.
 */

export const NOW = new Date('2026-10-02T12:00:00Z');

/** `n` plain words, so a paragraph can be exactly as long as a test needs. */
export const words = (n, prefix = 'word') =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');

export const ld = (data) => `<script type="application/ld+json">${JSON.stringify(data)}</script>`;

export const html = ({ head = '', body = '', lang = 'en' } = {}) =>
  `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;

const TYPE_FROM_PATH = {
  '/': 'home',
  '/about': 'about',
  '/pricing': 'pricing',
  '/faq': 'faq',
  '/contact': 'contact',
};

/**
 * A page as the pipeline records it. Give `html` (raw) and optionally `rendered` (the headless-browser HTML);
 * leave `html` out and `fetchFailed: true` for a page that never loaded.
 */
export function page({
  url = 'https://acme.com/',
  type,
  html: raw,
  rendered,
  status = 200,
  headers = {},
  redirectCount = 0,
  fetchFailed = false,
  isKey = true,
  finalUrl,
} = {}) {
  const path = new URL(url).pathname;
  return {
    url,
    finalUrl: finalUrl ?? url,
    pageType: type ?? TYPE_FROM_PATH[path] ?? 'other',
    isKey,
    status: fetchFailed ? null : status,
    redirectCount,
    headers,
    facts: fetchFailed || raw === undefined ? null : extractPage(raw, url, { headers }),
    rendered: rendered === undefined ? null : { ok: true, facts: extractPage(rendered, url) },
    error: fetchFailed ? 'connect_failed' : null,
  };
}

export const robots = (text, httpStatus = 200) =>
  text === null
    ? { status: 'missing', httpStatus: 404, parsed: null }
    : text === 'unreachable'
      ? { status: 'unreachable', httpStatus: 503, parsed: null }
      : { status: 'ok', httpStatus, parsed: parseRobots(text) };

export function context({
  pages = [],
  robots: robotsInfo = robots(null),
  sitemaps,
  botProbes = null,
  llmsTxt,
} = {}) {
  return {
    site: { origin: 'https://acme.com', domain: 'acme.com', homeUrl: 'https://acme.com/' },
    robots: robotsInfo,
    sitemaps: { found: [], referenced: [], lastmods: [], ...sitemaps },
    botProbes,
    llmsTxt: llmsTxt ?? { status: 'missing', httpStatus: 404 },
    pages,
    now: NOW,
  };
}

/** Run one check the way the pipeline does: the check's answer, finished into a stored result. */
export function run(code, ctx) {
  return finishCheck(code, readiness.RUNNERS_FOR_TESTS[code](ctx));
}

/** A well-built home page: complete Organization and WebSite schema, consistent name, questions with short answers. */
export const GOOD_ORG = {
  '@type': 'Organization',
  name: 'Acme Widgets',
  url: 'https://acme.com/',
  logo: 'https://acme.com/logo.png',
  sameAs: [
    'https://www.linkedin.com/company/acme',
    'https://www.crunchbase.com/organization/acme',
    'https://www.wikidata.org/wiki/Q42',
  ],
};

export const goodHome = (extra = {}) =>
  html({
    head: `<title>Acme Widgets | Industrial widgets for small factories</title>
      <meta name="description" content="Acme Widgets builds industrial widgets for small factories.">
      <link rel="canonical" href="https://acme.com/">
      <meta property="og:site_name" content="Acme Widgets">
      ${ld({ '@context': 'https://schema.org', '@graph': [GOOD_ORG, { '@type': 'WebSite', name: 'Acme Widgets', url: 'https://acme.com/' }] })}
      ${extra.head ?? ''}`,
    body: `<header><nav><a href="/about">About</a> <a href="/pricing">Pricing</a></nav></header>
      <main><h1>Acme Widgets</h1>
      <p>Acme Widgets is a widget maker based in Ohio, serving small factories since 1998. ${words(30)}</p>
      <h2>What does Acme Widgets make?</h2>
      <p>We make durable industrial widgets in three sizes, tested to ten thousand hours of continuous use.</p>
      <h2>How much do widgets cost?</h2>
      <p>Widgets start at forty dollars each, with discounts for orders of one hundred or more units.</p>
      <ul><li>Small</li><li>Medium</li><li>Large</li></ul>
      <p>Last updated September 15, 2026. Output rose 45% in 2025 and defects fell 30%, according to <a href="https://industry.example.org/report">the industry report</a> and <a href="https://stats.example.net/widgets">official statistics</a>.</p>
      <p class="byline">By Jo Writer</p>
      ${extra.body ?? ''}</main>
      <footer><a href="https://www.linkedin.com/company/acme">LinkedIn</a></footer>`,
  });
