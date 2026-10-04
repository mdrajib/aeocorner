/**
 * The evidence pack (MVP F8 step 2, task 7.03): everything the Content Studio knows about a target before it writes a
 * word, taken only from this product's own tracking data: what each engine answers today, who it names, which pages
 * it cites and what format they are in. Pure: the repository reads the answers, this shapes them.
 *
 * The pack is what the research, brief and draft steps are given, and what the customer sees as "evidence used", so
 * nothing in it is written by a model. It is capped (a few hundred characters per answer, 15 sources) because it
 * travels in prompts.
 */

export const FORMATS = Object.freeze([
  'comparison',
  'best_of',
  'how_to',
  'faq',
  'glossary',
  'facts_page',
  'other',
  'about_page',
]);

export const FORMAT_LABELS = Object.freeze({
  comparison: 'Comparison',
  best_of: 'Best-of list',
  how_to: 'How-to guide',
  faq: 'FAQ',
  glossary: 'Glossary entry',
  facts_page: 'Facts page',
  other: 'Article',
  about_page: 'About page',
});

/** The JSON-LD type a format is published with. */
export const SCHEMA_FOR_FORMAT = Object.freeze({
  comparison: 'Article',
  best_of: 'Article',
  how_to: 'HowTo',
  faq: 'FAQPage',
  glossary: 'Article',
  facts_page: 'Article',
  other: 'Article',
  about_page: 'Article',
});

const PAGE_FORMATS = [
  [
    'comparison',
    /\b(?:vs\.?|versus|compared?\s+(?:to|with)|comparison|alternatives?\s+to|which\s+is\s+better)\b/i,
  ],
  [
    'best_of',
    /\b(?:best|top\s+\d+|top\s+ten|\d+\s+best|ranked|rankings?|reviews?\s+of|recommended)\b/i,
  ],
  ['how_to', /\b(?:how\s+to|step[- ]by[- ]step|guide\s+to|tutorial|checklist)\b/i],
  ['faq', /\b(?:faqs?|frequently\s+asked|questions\s+(?:and|&)\s+answers)\b/i],
  ['glossary', /\b(?:what\s+(?:is|are|does)|definition|meaning\s+of|glossary|explained)\b/i],
  [
    'facts_page',
    /\b(?:cost|price|pricing|fees?|statistics|stats|facts|numbers|how\s+much|how\s+long|rates?)\b/i,
  ],
];

/** The format a cited page looks like, from its title and address; null when it gives no sign. */
export function formatOfPage({ url, title } = {}) {
  const path = (() => {
    try {
      return decodeURIComponent(new URL(url).pathname).replace(/[-_/]+/g, ' ');
    } catch {
      return '';
    }
  })();
  const text = `${title ?? ''} ${path}`;
  for (const [format, pattern] of PAGE_FORMATS) if (pattern.test(text)) return format;
  return null;
}

/** The format a question asks for, when no cited page settles it. */
export function formatFromQuestion(question) {
  const q = String(question ?? '');
  for (const [format, pattern] of PAGE_FORMATS) if (pattern.test(q)) return format;
  if (/^\s*(?:who|where|which)\b/i.test(q)) return 'best_of';
  if (/^\s*(?:how\s+do|how\s+can|how\s+should)\b/i.test(q)) return 'how_to';
  return 'faq';
}

const clip = (text, max) => {
  const s = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
};

export const PACK_LIMITS = Object.freeze({ excerpt: 600, sources: 15, competitors: 8, engines: 6 });

/**
 * Build the pack for a question.
 *
 * @param {object} input
 * @param {string} input.question
 * @param {string} input.brandName
 * @param {string[]} [input.brandDomains]  the brand's own domains, so own pages are marked
 * @param {Array} input.snapshots   the newest answers to the question (`answers.drilldown(...).snapshots`)
 * @param {{name, k}[]} [input.competitors]  from the recommendation's evidence, most named first
 * @returns {object} `{ question, brandName, engines, answersRead, answersThatNamedBrand, competitors, sources,
 *   ownPagesCited, format: { recommended, basis, counts } }`
 */
export function buildEvidencePack({
  question,
  brandName,
  brandDomains = [],
  snapshots = [],
  competitors = [],
}) {
  const own = new Set(
    brandDomains.map((d) =>
      String(d)
        .toLowerCase()
        .replace(/^www\./, ''),
    ),
  );
  const isOwnDomain = (domain) => {
    const d = String(domain ?? '')
      .toLowerCase()
      .replace(/^www\./, '');
    return [...own].some((o) => d === o || d.endsWith(`.${o}`));
  };

  const byEngine = new Map();
  for (const s of snapshots) {
    if (!byEngine.has(s.engineCode)) byEngine.set(s.engineCode, []);
    byEngine.get(s.engineCode).push(s);
  }
  const sourceMap = new Map();
  let answersRead = 0;
  let answersThatNamedBrand = 0;
  const engines = [];
  for (const [engineCode, list] of [...byEngine].sort((a, b) => a[0].localeCompare(b[0]))) {
    const readable = list.filter((s) => s.read);
    answersRead += readable.length;
    const sample = readable.find((s) => s.textExcerpt) ?? null;
    const named = new Map();
    for (const s of readable) {
      let brandNamed = false;
      for (const m of s.mentions ?? []) {
        if (m.kind === 'brand') brandNamed = true;
        named.set(m.name, (named.get(m.name) ?? 0) + 1);
      }
      if (brandNamed) answersThatNamedBrand += 1;
      for (const c of s.citations ?? []) {
        if (!c.url) continue;
        const entry = sourceMap.get(c.url) ?? {
          url: c.url,
          title: c.title ?? null,
          domain: c.domain ?? null,
          timesCited: 0,
          engines: new Set(),
          isOwn: Boolean(c.isOwn) || isOwnDomain(c.domain),
        };
        entry.timesCited += 1;
        entry.engines.add(engineCode);
        if (!entry.title && c.title) entry.title = c.title;
        sourceMap.set(c.url, entry);
      }
    }
    engines.push({
      engineCode,
      answers: list.length,
      readable: readable.length,
      excerpt: sample ? clip(sample.textExcerpt, PACK_LIMITS.excerpt) : null,
      named: [...named]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
        .slice(0, 8),
    });
  }

  const sources = [...sourceMap.values()]
    .map((s) => ({
      url: s.url,
      title: s.title ? clip(s.title, 160) : null,
      domain: s.domain,
      timesCited: s.timesCited,
      engines: [...s.engines].sort(),
      isOwn: s.isOwn,
      format: formatOfPage(s),
    }))
    .sort((a, b) => b.timesCited - a.timesCited || a.url.localeCompare(b.url))
    .slice(0, PACK_LIMITS.sources);

  const counts = {};
  for (const s of sources) if (s.format) counts[s.format] = (counts[s.format] ?? 0) + s.timesCited;
  const winning = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const recommended = winning.length > 0 ? winning[0][0] : formatFromQuestion(question);
  const basis =
    winning.length > 0
      ? `${winning[0][1]} of ${sources.reduce((n, s) => n + s.timesCited, 0)} citations are ${FORMAT_LABELS[winning[0][0]].toLowerCase()} pages`
      : 'the way the question is asked';

  return {
    question: clip(question, 300),
    brandName,
    engines: engines.slice(0, PACK_LIMITS.engines),
    answersRead,
    answersThatNamedBrand,
    competitors: competitors
      .slice(0, PACK_LIMITS.competitors)
      .map((c) => ({ name: c.name, k: Number(c.k) || 0 })),
    sources,
    ownPagesCited: sources.filter((s) => s.isOwn).map((s) => s.url),
    format: { recommended, basis, counts },
  };
}

/**
 * The pack for a recommendation that is not about one question (a readiness check or a coldly named brand): what the
 * evidence says, as it was stored, and the page to refresh if one is named.
 */
export function buildCheckPack({ ruleCode, title, evidence, targetUrls = [], brandName }) {
  const format =
    ruleCode === 'readiness.E4'
      ? 'faq'
      : ruleCode === 'readiness.E3'
        ? 'comparison'
        : ruleCode === 'readiness.D2'
          ? 'about_page'
          : 'other';
  return {
    question: null,
    brandName,
    ruleCode,
    title: clip(title, 255),
    evidence: JSON.parse(
      JSON.stringify(evidence ?? {}, (_, v) => (typeof v === 'string' ? clip(v, 400) : v)),
    ),
    targetUrls: targetUrls.slice(0, 5),
    engines: [],
    sources: [],
    competitors: [],
    format: { recommended: format, basis: 'the check that failed', counts: {} },
  };
}

/** Every address the pack knows about: the only ones the draft may link to as sources before research adds more. */
export const packUrls = (pack) => [
  ...new Set([...(pack.sources ?? []).map((s) => s.url), ...(pack.targetUrls ?? [])]),
];
