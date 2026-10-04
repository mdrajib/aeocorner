import { AUTOFIX_RULES, fingerprint, withSlash } from './autofix.js';
import { validateJsonLd } from './jsonld.js';

/**
 * The fixes that are not the home-page graph (see `autofix.js` for the home page): structured data for several key pages
 * (`readiness.C2`), titles and descriptions (`readiness.F3`) and Allow lines in robots.txt (`readiness.A1`). Pure.
 *
 * Every one is built from the latest scan's evidence for its check, and only from what a page says about itself: its own
 * headline, its description or first paragraph, the dates it states. Nothing is invented, and what is left out is said.
 * The fingerprint ties what the person saw to what is sent, exactly as it does for the home page.
 */

/** An address as the plugin keys it: host and path only, no scheme, query, "www." or trailing slash. */
export function addressKey(url) {
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return '';
  }
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};
const sameHost = (a, b) => hostOf(a) !== '' && hostOf(a) === hostOf(b);

/** Page kinds we can describe honestly from what the page says about itself, and the schema type each gets. */
const PAGE_SCHEMA = Object.freeze({
  article: 'Article',
  service: 'Service',
  product: 'Product',
  about: 'AboutPage',
  contact: 'ContactPage',
});
const SKIPPED_KINDS = Object.freeze({
  faq: 'a FAQ needs its questions and answers read from the page: write it in Content Studio',
  pricing: 'a price list needs the prices, and they are not guessed',
});

const ISO = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const MAX_ITEMS = 10;

/**
 * The missing page-type schema for key pages (`readiness.C2`). No author, rating or price is ever made up.
 *
 * @param {object} p
 * @param {{pages?: object[]}} p.evidence  the C2 check's evidence from the latest scan
 * @param {{name: string}} p.brand
 * @param {string} p.homeUrl               the connected site's home address
 */
export function buildPageSchemaFix({ evidence, brand, homeUrl }) {
  const brandName = String(brand?.name ?? '').trim();
  const pages = Array.isArray(evidence?.pages) ? evidence.pages : [];
  const items = [];
  const notIncluded = [];
  for (const page of pages) {
    if (page.ok || page.onlyAfterJavaScript || !page.basics) continue;
    const at = page.url;
    const type = PAGE_SCHEMA[page.pageType];
    if (!type) {
      if (SKIPPED_KINDS[page.pageType]) notIncluded.push(`${at}: ${SKIPPED_KINDS[page.pageType]}.`);
      continue;
    }
    if (!sameHost(at, homeUrl)) {
      notIncluded.push(`${at}: it is not on your connected site.`);
      continue;
    }
    const b = page.basics;
    if (!b.name) {
      notIncluded.push(`${at}: it has no headline to name the schema after.`);
      continue;
    }
    const description = b.description || b.lead;
    const org = brandName
      ? { '@type': 'Organization', name: brandName, url: withSlash(homeUrl) }
      : null;
    const node = { '@type': type, '@id': `${at}#${type.toLowerCase()}`, url: at };
    if (type === 'Article') {
      node.headline = b.name;
      if (description) node.description = description;
      if (ISO.test(b.published)) node.datePublished = b.published;
      if (ISO.test(b.modified)) node.dateModified = b.modified;
      if (org) node.publisher = org;
    } else {
      node.name = b.name;
      if (description) node.description = description;
      if (type === 'Service' && org) node.provider = org;
    }
    const valid = validateJsonLd({ '@context': 'https://schema.org', '@graph': [node] });
    if (!valid.ok) {
      notIncluded.push(
        `${at}: the structured data did not pass its check (${valid.errors[0].message}).`,
      );
      continue;
    }
    if (items.length >= MAX_ITEMS) {
      notIncluded.push(`${at}: ${MAX_ITEMS} pages are done at a time; do the rest after this.`);
      continue;
    }
    items.push({ url: at, pageType: page.pageType, type, node });
  }
  if (!items.length) {
    return {
      ok: false,
      reason:
        notIncluded[0] ??
        'There is no page we can describe from what it says about itself, so follow the steps and mark it done.',
    };
  }
  return {
    ok: true,
    kind: 'jsonld',
    scope: 'pages',
    targetUrl: withSlash(homeUrl),
    items,
    hash: fingerprint({ items: items.map((i) => ({ url: i.url, node: i.node })) }),
    includes: items.map((i) => `${i.type} on ${i.url}`),
    notIncluded,
  };
}

const TITLE_MAX = 60;
const DESCRIPTION_MAX = 155;

/** A title of at most 60 characters: the page's own headline, with the brand's name after it if that fits. */
function titleFor(name, brandName) {
  const base = String(name).trim();
  if (!base) return '';
  if (brandName && !base.toLowerCase().includes(brandName.toLowerCase())) {
    const withBrand = `${base} | ${brandName}`;
    if (withBrand.length <= TITLE_MAX) return withBrand;
  }
  if (base.length <= TITLE_MAX) return base;
  const cut = base.slice(0, TITLE_MAX - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 20)).trimEnd()}…`;
}

/** A description of at most 155 characters from the page's first paragraph: whole sentences if they fit, else whole words. */
function descriptionFrom(lead) {
  const text = String(lead).replace(/\s+/g, ' ').trim();
  if (text.length < 40) return '';
  if (text.length <= DESCRIPTION_MAX) return text;
  const sentences = text.match(/[^.!?]+[.!?]+(?=\s|$)/g) ?? [];
  let out = '';
  for (const sentence of sentences) {
    const next = `${out}${out ? ' ' : ''}${sentence.trim()}`;
    if (next.length > DESCRIPTION_MAX) break;
    out = next;
  }
  if (out.length >= 60) return out;
  const cut = text.slice(0, DESCRIPTION_MAX - 1);
  return `${cut.slice(0, cut.lastIndexOf(' ')).replace(/[\s,;:–—-]+$/, '')}…`;
}

/**
 * A title and a description for the pages that have none or share one (`readiness.F3`), from each page's own headline and
 * first paragraph. Only the missing or shared part is proposed (a good title is never replaced), and two pages never get
 * the same proposal.
 *
 * @param {{pages?: object[]}} p.evidence  the F3 check's evidence from the latest scan
 */
export function buildMetaFix({ evidence, brand, homeUrl }) {
  const brandName = String(brand?.name ?? '').trim();
  const pages = Array.isArray(evidence?.pages) ? evidence.pages : [];
  const items = [];
  const notIncluded = [];
  const titles = new Set();
  const descriptions = new Set();
  for (const page of pages) {
    const at = page.url;
    if (!sameHost(at, homeUrl)) {
      notIncluded.push(`${at}: it is not on your connected site.`);
      continue;
    }
    const problems = Array.isArray(page.problems) ? page.problems : [];
    const item = { url: at, title: null, description: null, was: {} };
    if (problems.includes('no_title') || problems.includes('duplicate_title')) {
      const title = titleFor(page.name, brandName);
      if (!title) notIncluded.push(`${at}: it has no headline to make a title from.`);
      else if (title === page.title)
        notIncluded.push(
          `${at}: its headline is the title it already has, so it needs a title of its own.`,
        );
      else if (titles.has(title.toLowerCase()))
        notIncluded.push(`${at}: another page has the same headline, so its title needs a person.`);
      else {
        titles.add(title.toLowerCase());
        item.title = title;
        item.was.title = page.title || null;
      }
    }
    if (problems.includes('no_description') || problems.includes('duplicate_description')) {
      const description = descriptionFrom(page.lead);
      if (!description)
        notIncluded.push(`${at}: it has no opening paragraph to make a description from.`);
      else if (description === page.description)
        notIncluded.push(`${at}: its opening paragraph is the description it already has.`);
      else if (descriptions.has(description.toLowerCase()))
        notIncluded.push(
          `${at}: another page opens the same way, so its description needs a person.`,
        );
      else {
        descriptions.add(description.toLowerCase());
        item.description = description;
        item.was.description = page.description || null;
      }
    }
    if (item.title === null && item.description === null) continue;
    if (items.length >= MAX_ITEMS) {
      notIncluded.push(`${at}: ${MAX_ITEMS} pages are done at a time; do the rest after this.`);
      continue;
    }
    items.push(item);
  }
  if (!items.length) {
    return {
      ok: false,
      reason:
        notIncluded[0] ??
        'There is no page we can write a title or description for from what it says about itself, so follow the steps and mark it done.',
    };
  }
  return {
    ok: true,
    kind: 'meta',
    scope: 'pages',
    targetUrl: withSlash(homeUrl),
    items,
    hash: fingerprint({
      items: items.map(({ url, title, description }) => ({ url, title, description })),
    }),
    includes: items.map(
      (i) =>
        `${[i.title && 'a title', i.description && 'a description'].filter(Boolean).join(' and ')} for ${i.url}`,
    ),
    notIncluded,
  };
}

/** Only a plain group per crawler, so what reaches robots.txt can be read at a glance and checked line by line. */
const GROUP = 'User-agent: [A-Za-z0-9._-]{1,60}\\nAllow: /';
const ROBOTS_LINES = new RegExp(`^${GROUP}(?:\\n\\n${GROUP})*$`);
export const isRobotsLines = (lines) =>
  typeof lines === 'string' && lines.length <= 2000 && ROBOTS_LINES.test(lines);

/**
 * Allow lines for the answer crawlers that robots.txt blocks from the whole site (`readiness.A1`). A group of its own
 * names a crawler more closely than `User-agent: *` does, so it wins; where the crawler's own group blocks it, "Allow: /"
 * and "Disallow: /" are the same length and the one that allows wins (RFC 9309). A crawler blocked from only part of the
 * site is left alone and said so: opening the whole site is not what the customer asked for.
 *
 * @param {{robotsFile?: boolean, bots?: {agent, verdict, rule?}[]}} p.evidence  the A1 check's evidence
 */
export function buildRobotsFix({ evidence, homeUrl }) {
  if (evidence?.robotsFile === false) {
    return { ok: false, reason: 'There is no robots.txt, so nothing is blocked.' };
  }
  const bots = Array.isArray(evidence?.bots) ? evidence.bots : [];
  const blocked = bots.filter(
    (b) => b.verdict === 'blocked' && /^[A-Za-z0-9._-]{1,60}$/.test(String(b.agent)),
  );
  const partly = bots.filter((b) => b.verdict === 'partly');
  const notIncluded = partly.map(
    (b) =>
      `${b.agent} is blocked from only part of the site (${b.rule ?? 'a Disallow rule'}); that is left to you.`,
  );
  if (!blocked.length) {
    return {
      ok: false,
      reason: partly.length
        ? 'The crawlers are blocked only from parts of the site. Edit those rules in your robots.txt.'
        : 'No answer crawler is blocked from the whole site.',
    };
  }
  const lines = blocked.map((b) => `User-agent: ${b.agent}\nAllow: /`).join('\n\n');
  return {
    ok: true,
    kind: 'robots_txt',
    scope: 'site',
    targetUrl: homeUrl ? withSlash(homeUrl) : null,
    lines,
    bots: blocked.map((b) => b.agent),
    hash: fingerprint({ lines }),
    includes: blocked.map((b) => `Allow ${b.agent} to read the whole site`),
    notIncluded,
  };
}

/** The one entry point for a fix that is not the home-page graph: which builder, from which check's evidence. */
export function buildFix({ ruleCode, evidence, brand, homeUrl }) {
  const rule = AUTOFIX_RULES[ruleCode];
  if (rule?.scope === 'pages' && rule.kind === 'jsonld')
    return buildPageSchemaFix({ evidence, brand, homeUrl });
  if (rule?.scope === 'pages' && rule.kind === 'meta')
    return buildMetaFix({ evidence, brand, homeUrl });
  if (rule?.scope === 'site') return buildRobotsFix({ evidence, homeUrl });
  return { ok: false, reason: 'This recommendation cannot be fixed automatically.' };
}

/** What is stored with an approved change: the exact data that was shown, and its fingerprint. */
export function payloadOf(ruleCode, built) {
  const base = { ruleCode, hash: built.hash };
  if (built.scope === 'home') return { ...base, jsonld: built.jsonld };
  if (built.kind === 'robots_txt') return { ...base, lines: built.lines };
  if (built.kind === 'meta') {
    return {
      ...base,
      items: built.items.map(({ url, title, description }) => ({ url, title, description })),
    };
  }
  return { ...base, items: built.items.map(({ url, node }) => ({ url, node })) };
}

/**
 * Does an approved change's stored data still hash to what was approved, and is it still valid? The worker asks before it
 * sends anything. An empty list means all is well.
 */
export function payloadProblems(kind, payload) {
  if (!payload || typeof payload !== 'object') return ['missing'];
  const problems = [];
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (kind === 'jsonld' && payload.jsonld) {
    if (fingerprint(payload.jsonld) !== payload.hash) problems.push('hash');
    if (!validateJsonLd(payload.jsonld).ok) problems.push('invalid');
  } else if (kind === 'jsonld') {
    if (!items.length || fingerprint({ items }) !== payload.hash) problems.push('hash');
    for (const i of items) {
      const doc = { '@context': 'https://schema.org', '@graph': [i?.node] };
      if (!validateJsonLd(doc).ok) problems.push('invalid');
    }
  } else if (kind === 'meta') {
    if (!items.length || fingerprint({ items }) !== payload.hash) problems.push('hash');
    for (const i of items) {
      if (String(i.title ?? '').length > 300 || String(i.description ?? '').length > 500)
        problems.push('invalid');
    }
  } else if (kind === 'robots_txt') {
    if (fingerprint({ lines: payload.lines }) !== payload.hash) problems.push('hash');
    if (!isRobotsLines(payload.lines)) problems.push('invalid');
  } else problems.push('kind');
  return problems;
}

/**
 * The family a change belongs to and the addresses it touches. Two changes in one family that touch the same address
 * overwrite each other, so only the latest of them can be taken back without dropping a later fix.
 */
export function touchedBy(change) {
  const payload = change.payload ?? {};
  if (change.kind === 'robots_txt') return { family: 'robots', keys: ['robots.txt'] };
  if (change.kind === 'meta') {
    return {
      family: 'meta',
      keys: (payload.items ?? []).map((i) => addressKey(i.url)).filter(Boolean),
    };
  }
  const keys = payload.jsonld
    ? [addressKey(change.targetUrl)]
    : (payload.items ?? []).map((i) => addressKey(i.url));
  return { family: 'schema', keys: keys.filter(Boolean) };
}

/** The first plugin version that has the routes the page, title and robots.txt fixes use. */
export const PLUGIN_WITH_FIXES = '1.1.0';

/** Is a plugin version (such as "1.0.0") at least `min`? An unknown version is not. */
export function pluginAtLeast(version, min = PLUGIN_WITH_FIXES) {
  const parse = (v) =>
    String(v ?? '')
      .match(/^(\d+)\.(\d+)\.(\d+)/)
      ?.slice(1)
      .map(Number);
  const have = parse(version);
  const need = parse(min);
  if (!have || !need) return false;
  for (let i = 0; i < 3; i += 1) {
    if (have[i] !== need[i]) return have[i] > need[i];
  }
  return true;
}

/** The nodes of a stored JSON-LD document, whether it is one node or a `@graph`. */
export function nodesOfDocument(doc) {
  if (!doc || typeof doc !== 'object') return [];
  if (Array.isArray(doc['@graph'])) return doc['@graph'].filter((n) => n && typeof n === 'object');
  const node = Object.fromEntries(Object.entries(doc).filter(([key]) => key !== '@context'));
  return Object.keys(node).length ? [node] : [];
}

/**
 * What to write for a page that may already hold structured data (an Article from Content Studio, say): the nodes it has
 * of any other type, then ours. The same type is replaced, so a retry writes the same thing.
 */
export function mergedPageDocument(existing, node) {
  const kept = nodesOfDocument(existing).filter((n) => n['@type'] !== node['@type']);
  return { '@context': 'https://schema.org', '@graph': [...kept, node] };
}

/** Allow groups already saved plus new ones, one group per crawler (a crawler named twice keeps one group). */
export function mergeRobotsLines(saved, added) {
  const groups = new Map();
  for (const text of [saved, added]) {
    for (const group of String(text ?? '')
      .split(/\n\n+/)
      .map((g) => g.trim())
      .filter(Boolean)) {
      const agent = group.match(/^User-agent: (\S+)/)?.[1];
      if (agent && !groups.has(agent.toLowerCase())) groups.set(agent.toLowerCase(), group);
    }
  }
  return [...groups.values()].join('\n\n');
}
