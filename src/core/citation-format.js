/**
 * What a frequently cited page IS, and what makes it easy to cite (Milestone 13, tasks 13.03 and 13.06). Pure: it reads
 * the facts `extractPage` (src/crawler/html.js) already makes, so a cited page is hostile input read by the same linear,
 * depth-capped parser as every other page. Nothing here fetches.
 *
 * The page formats (`PAGE_FORMATS`) are what engines tend to cite for a question: a list, a comparison, a review, a guide,
 * a FAQ, documentation. A page that gives no sign is "other": it was read and does not look like any of them. A page we
 * could not read has NO format (null), which is not "other".
 *
 * `citableSignals` is the other half: the things that make a page worth citing (a named author, dates, sources linked,
 * original figures). They are read from the page, counted, never judged against a made-up bar: the screen shows them as
 * "what the pages engines cite have", and Content Studio's quality check asks the same of our own draft.
 */

export const PAGE_FORMATS = Object.freeze([
  'list',
  'comparison',
  'review',
  'guide',
  'documentation',
  'faq',
  'other',
]);

export const PAGE_FORMAT_LABELS = Object.freeze({
  list: 'List or roundup',
  comparison: 'Comparison',
  review: 'Review',
  guide: 'Guide or how-to',
  documentation: 'Documentation',
  faq: 'FAQ',
  other: 'Other page',
});

/**
 * The Content Studio format that writes a page like this one (src/core/evidence-pack.js `FORMATS`), or null when it is not
 * something we write for a customer: a review is somebody else's opinion of you, and documentation is the product's own.
 */
export const CONTENT_FORMAT_FOR = Object.freeze({
  list: 'best_of',
  comparison: 'comparison',
  guide: 'how_to',
  faq: 'faq',
  review: null,
  documentation: null,
  other: null,
});

export const contentFormatFor = (format) => CONTENT_FORMAT_FOR[format] ?? null;

const DOC_HOST_LABELS = new Set([
  'docs',
  'doc',
  'developer',
  'developers',
  'wiki',
  'help',
  'support',
]);
const DOC_PATH = /^\/(?:docs?|documentation|reference|api|manual|help|support|wiki|kb)(?:\/|$)/i;
const COMPARISON =
  /\b(?:vs\.?|versus|compared?\s+(?:to|with)|comparison|alternatives?\s+to|which\s+is\s+better)\b/i;
const LIST_TITLE =
  /\b(?:top\s+\d+|top\s+ten|\d+\s+(?:best|top|great|easy|ways|tools|apps|options|reasons|tips)|best\s+\w+|roundup|ranked)\b/i;
const FAQ_TITLE = /\b(?:faqs?|frequently\s+asked|questions\s+(?:and|&)\s+answers)\b/i;
const GUIDE_TITLE =
  /\b(?:how\s+to|step[- ]by[- ]step|guide|tutorial|checklist|what\s+(?:is|are)|explained|beginner)\b/i;
const REVIEW_TITLE = /\b(?:reviews?|reviewed|hands[- ]on|our\s+verdict)\b/i;
const QUESTION_HEADING = /\?\s*$/;
const NUMBERED_HEADING = /^\s*(?:#?\d{1,2}[.):]|\d{1,2}\s+[-–—])\s*\S/;

const lower = (s) => String(s ?? '').toLowerCase();

function pathOf(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname.replace(/^www\./, ''), path: decodeURIComponent(u.pathname) };
  } catch {
    return { host: '', path: '' };
  }
}

/**
 * Read the format of one page.
 *
 * @param facts  from `extractPage`: `{ skipped, title, headings, jsonLd: { types }, ogType }`
 * @param url    the page's address (a documentation host or path is a sign too)
 * @returns `{ format, signals }` where `signals` names what decided it, or `{ format: null, finding: 'unreadable' }`
 *          when the page gave nothing to read (a page too deeply nested, or one with no title and no headings)
 */
export function readPageFormat(facts, url) {
  if (!facts || facts.skipped || (!facts.title && !(facts.headings ?? []).length)) {
    return { format: null, finding: 'unreadable', signals: [] };
  }
  const types = new Set((facts.jsonLd?.types ?? []).map(lower));
  const headings = facts.headings ?? [];
  const h1 = headings.find((h) => h.level === 1)?.text ?? '';
  const heads = [facts.title, h1].filter(Boolean).join(' | ');
  const { host, path } = pathOf(url);
  const pathWords = path.replace(/[-_/]+/g, ' ');
  const sub = headings.filter((h) => h.level === 2 || h.level === 3);
  const questions = sub.filter((h) => QUESTION_HEADING.test(h.text)).length;
  const numbered = sub.filter((h) => NUMBERED_HEADING.test(h.text)).length;

  const decide = () => {
    if (
      DOC_PATH.test(path) ||
      (DOC_HOST_LABELS.has(host.split('.')[0]) && host.split('.').length > 2) ||
      types.has('techarticle') ||
      types.has('apireference')
    ) {
      return ['documentation', 'documentation address or markup'];
    }
    if (COMPARISON.test(heads) || COMPARISON.test(pathWords))
      return ['comparison', 'vs or compare in the title'];
    if (types.has('faqpage') || FAQ_TITLE.test(heads)) return ['faq', 'FAQ markup or title'];
    if (types.has('itemlist') || LIST_TITLE.test(heads) || numbered >= 4) {
      return ['list', 'a numbered or best-of list'];
    }
    if (questions >= 4) return ['faq', 'four or more question headings'];
    if (types.has('howto') || GUIDE_TITLE.test(heads) || GUIDE_TITLE.test(pathWords)) {
      return ['guide', 'how-to or guide wording'];
    }
    if (types.has('review') || REVIEW_TITLE.test(heads))
      return ['review', 'review markup or wording'];
    return ['other', 'no sign of any format'];
  };
  const [format, signal] = decide();
  return { format, finding: null, signals: [signal] };
}

const FIGURE = /\d[\d,.]*\s?%|[$€£]\s?\d[\d,.]*|\b\d[\d,.]*\s?(?:million|billion|x)\b/gi;

/**
 * What makes a page easy to cite, counted from its facts.
 *
 * @returns `{ author, dated, sourcesLinked, figures }`: whether a named author is given, whether the page shows when it
 *   was written or updated, how many outside sites it links to, and how many figures (percentages, amounts) it states
 */
export function citableSignals(facts, url) {
  if (!facts || facts.skipped) return null;
  const nodes = facts.jsonLd?.nodes ?? [];
  const author =
    Boolean(facts.metaAuthor) ||
    nodes.some((n) => {
      const a = n.author ?? n.creator;
      return Boolean(typeof a === 'string' ? a.trim() : a?.name);
    });
  const dates = facts.dates ?? {};
  const dated =
    Boolean(dates.metaPublished || dates.metaModified) ||
    (dates.timeElements ?? []).length > 0 ||
    nodes.some((n) => n.datePublished || n.dateModified);
  const { host } = pathOf(url);
  const outside = new Set();
  for (const link of facts.links ?? []) {
    const h = pathOf(link.href).host;
    if (h && h !== host && !h.endsWith(`.${host}`)) outside.add(h);
  }
  const figures = String(facts.text ?? '').match(FIGURE)?.length ?? 0;
  return { author, dated, sourcesLinked: outside.size, figures: Math.min(figures, 999) };
}

/**
 * Add up the signals of several pages: "of the pages engines cite on this question, 4 of 5 name an author". Pages with no
 * signals (not read) are left out and counted in `unread`.
 *
 * @param pages  `[{ signals }]` where signals come from `citableSignals`, or are null
 */
export function summarizeSignals(pages) {
  const read = pages.filter((p) => p.signals);
  const count = (pick) => read.filter((p) => pick(p.signals)).length;
  return {
    pages: read.length,
    unread: pages.length - read.length,
    withAuthor: count((s) => s.author),
    dated: count((s) => s.dated),
    withSources: count((s) => s.sourcesLinked > 0),
    withFigures: count((s) => s.figures > 0),
  };
}
