import { createHash } from 'node:crypto';
import { CHECKS } from '../crawler/readiness/rubric.js';
import { CITATION_LIMITS } from './citation-opportunities.js';
import { FORMAT_LABELS } from './evidence-pack.js';
import { platformLabel } from './entity-profiles.js';
import { READINESS_GUIDANCE } from './fix-list.js';
import { calibratedConfidence, iceScore, impactScore } from './ice.js';

/**
 * The rules engine (MVP F7 "v0 rules"): what we found about a project, in; the things worth doing, out. Pure and
 * deterministic: the same findings always give the same candidates with the same keys, so running it again after every
 * check and every scan never makes a duplicate (the database's unique key on `(project_id, open_key)` is the lasting
 * guard, this is what makes the key stable).
 *
 * A candidate is one issue:
 *   ruleCode    `readiness.<check>` or `visibility.<rule>`; rule_version moves when a rule's meaning changes
 *   subject     what it is about: the check, the question, the site. With the rule it is the `stableKey`
 *   evidence    what we saw, as ids and numbers: no candidate without evidence, and the narrative may say nothing else
 *   promptIds   the questions it is meant to move: the scope of the before/after measurement
 *
 * Two families:
 *   readiness    a check of the latest website scan that failed or earned part of its points. A check that errored (we
 *                could not look) and a check that does not apply are NOT issues: "couldn't check" is never "failed".
 *   visibility   what the answers showed in the window: a question where competitors are named and the brand never is
 *                (it needs complete cells: a half-collected one might have named the brand), an outside site cited in
 *                answers that left the brand out, and answers that name the brand coldly.
 *
 * Entity (Milestone 12) is a third family, `entity.<what>`:
 *   entity.wrong_fact   an engine states a fact about the brand that the Brand Kit contradicts (src/core/entity-accuracy.js)
 *   entity.profile      a profile the customer listed that we could read and that does not name the business, or is gone
 *   entity.wikidata     Wikidata has no item for the brand, cannot tell which is theirs, or the item they gave is not theirs
 * None of them is raised for a check that could not run: an `error` check opens nothing, and keeps an issue already open
 * from being cleared.
 *
 * `evaluated` says which families had something to read. The caller clears only those: a project with no scan yet has
 * not "fixed" its readiness issues, and one with no readable answers has not "won back" its questions.
 */

export const RULE_VERSION = 1;

/** The rules, by code: where the fix belongs, how hard it is, and how often such fixes have moved visibility (v0 priors). */
export const RULES = Object.freeze({
  'readiness.A1': { category: 'crawler_access', fixPath: 'auto_fix', effort: 1, prior: 0.7 },
  'readiness.A3': { category: 'crawler_access', fixPath: 'guidance', effort: 3, prior: 0.6 },
  'readiness.A4': { category: 'technical', fixPath: 'auto_fix', effort: 1, prior: 0.4 },
  'readiness.B1': { category: 'renderability', fixPath: 'guidance', effort: 4, prior: 0.6 },
  'readiness.B2': { category: 'renderability', fixPath: 'guidance', effort: 3, prior: 0.4 },
  'readiness.C1': { category: 'structured_data', fixPath: 'auto_fix', effort: 1, prior: 0.5 },
  'readiness.C2': { category: 'structured_data', fixPath: 'auto_fix', effort: 1, prior: 0.5 },
  'readiness.C3': { category: 'structured_data', fixPath: 'guidance', effort: 2, prior: 0.4 },
  'readiness.C4': { category: 'structured_data', fixPath: 'auto_fix', effort: 1, prior: 0.3 },
  'readiness.D1': { category: 'entity', fixPath: 'guidance', effort: 2, prior: 0.4 },
  'readiness.D2': { category: 'entity', fixPath: 'content', effort: 3, prior: 0.5 },
  'readiness.D3': { category: 'entity', fixPath: 'auto_fix', effort: 2, prior: 0.5 },
  'readiness.D4': { category: 'entity', fixPath: 'guidance', effort: 2, prior: 0.3 },
  'readiness.E1': { category: 'content_refresh', fixPath: 'content', effort: 3, prior: 0.4 },
  'readiness.E2': { category: 'content_refresh', fixPath: 'content', effort: 3, prior: 0.5 },
  'readiness.E3': { category: 'content_refresh', fixPath: 'content', effort: 3, prior: 0.3 },
  'readiness.E4': { category: 'content_refresh', fixPath: 'content', effort: 3, prior: 0.4 },
  'readiness.E5': { category: 'content_refresh', fixPath: 'content', effort: 3, prior: 0.4 },
  'readiness.E6': { category: 'content_refresh', fixPath: 'content', effort: 2, prior: 0.3 },
  'readiness.F1': { category: 'technical', fixPath: 'guidance', effort: 2, prior: 0.6 },
  'readiness.F2': { category: 'technical', fixPath: 'guidance', effort: 2, prior: 0.4 },
  'readiness.F3': { category: 'technical', fixPath: 'auto_fix', effort: 1, prior: 0.3 },
  'visibility.lost_prompt': { category: 'content_new', fixPath: 'content', effort: 3, prior: 0.5 },
  'visibility.cited_source': {
    category: 'offsite_presence',
    fixPath: 'guidance',
    effort: 5,
    prior: 0.3,
  },
  'visibility.hedged': { category: 'reputation', fixPath: 'content', effort: 3, prior: 0.3 },
  // Citations (Milestone 13). Judged on citation share, not on how often the brand is named: the fix is about being a source.
  // A gap is "get listed" (guidance) unless the site is a competitor's and its pages are in a format we write, when the path
  // is Content Studio; the candidate says which. Both replace `visibility.cited_source` once the caller gives `citations`.
  'citation.gap': {
    category: 'offsite_presence',
    fixPath: 'guidance',
    effort: 5,
    prior: 0.3,
    metric: 'citation_share',
  },
  'citation.own_page_uncited': {
    category: 'content_refresh',
    fixPath: 'content',
    effort: 3,
    prior: 0.35,
    metric: 'citation_share',
  },
  // Entity (Milestone 12). All guidance: we do not write to other people's profiles or to Google's Knowledge Graph.
  'entity.wrong_fact': { category: 'entity', fixPath: 'guidance', effort: 2, prior: 0.4 },
  'entity.profile': { category: 'entity', fixPath: 'guidance', effort: 2, prior: 0.35 },
  // Wikidata only keeps items about things with outside references, so a small or new business may not qualify.
  'entity.wikidata': { category: 'entity', fixPath: 'guidance', effort: 4, prior: 0.2 },
});

export const RULE_CODES = Object.freeze(Object.keys(RULES));

/** Limits that keep the board readable: more than this is noise, not advice. */
export const LIMITS = Object.freeze({
  lostQuestions: 10,
  citedSites: 3,
  /** Readable answers a question needs before "the brand is never named" means anything. */
  minAnswersForLost: 3,
  /** Answers with a sentiment before "coldly named" means anything, and how cold. */
  minSentimentAnswers: 10,
  maxAverageSentiment: -0.5,
  /** A cited site must appear in this many answers that left the brand out. */
  minCitingAnswers: 2,
  affectedUrls: 20,
  /** An engine must state a fact wrongly this many times in the window before it is worth a task: one answer can be noise. */
  minWrongClaims: 2,
});

export const stableKeyOf = (ruleCode, subject) => `${ruleCode}:${String(subject).toLowerCase()}`;

const round3 = (n) => Math.round(n * 1000) / 1000;
const clip = (text, max) => {
  const s = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
};

/** Page addresses named anywhere in a check's evidence (one level of arrays), for "affected pages". */
export function urlsIn(evidence) {
  const found = [];
  const take = (value) => {
    if (typeof value === 'string' && /^https?:\/\//i.test(value) && !found.includes(value)) {
      found.push(value);
    } else if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof value.url === 'string'
    ) {
      take(value.url);
    }
  };
  for (const value of Object.values(evidence ?? {})) {
    if (Array.isArray(value)) value.forEach(take);
    else take(value);
  }
  return found.slice(0, LIMITS.affectedUrls);
}

function readinessCandidates({ scan, universeAll }) {
  if (!scan?.checks?.length) return [];
  const evaluated = scan.checks.filter(
    (c) => c.status !== 'error' && c.status !== 'not_applicable',
  );
  if (evaluated.length === 0) return [];
  const out = [];
  for (const check of evaluated) {
    const def = CHECKS[check.code];
    const rule = RULES[`readiness.${check.code}`];
    const guidance = READINESS_GUIDANCE[check.code];
    if (!def || !rule || !guidance || def.informational) continue;
    if (check.status !== 'fail' && check.status !== 'partial') continue;
    const possible = Number(check.possible);
    const points = Number(check.points);
    if (!(possible > 0)) continue;
    const ruleCode = `readiness.${check.code}`;
    out.push({
      ruleCode,
      subject: check.code,
      stableKey: stableKeyOf(ruleCode, check.code),
      ...rule,
      title: guidance.title,
      severity: round3(Math.min(1, Math.max(0, (possible - points) / possible))),
      // A site-wide problem is in the way of every question on every engine.
      reach: { affected: universeAll },
      promptIds: universeAll.map((u) => u.promptId),
      evidence: {
        type: 'readiness',
        scanId: scan.id == null ? null : String(scan.id),
        scannedAt: scan.finishedAt ? new Date(scan.finishedAt).toISOString() : null,
        check: {
          code: check.code,
          title: def.title,
          status: check.status,
          points,
          possible,
          summary: clip(check.summary, 300),
        },
      },
      affectedUrls: urlsIn(check.evidence),
    });
  }
  return out;
}

const FACT_TITLES = Object.freeze({
  founded: (brand) => `Correct the year AI engines say ${brand} was founded`,
  headquarters: (brand) => `Correct where AI engines say ${brand} is based`,
  price: (brand) => `Correct the prices AI engines quote for ${brand}`,
});

function wrongFactCandidates({ entity, brandName, windowRange }) {
  const accuracy = entity?.accuracy;
  if (!accuracy || accuracy.answersRead === 0) return [];
  const out = [];
  for (const fact of accuracy.facts) {
    if (fact.wrong < LIMITS.minWrongClaims) continue;
    const ruleCode = 'entity.wrong_fact';
    out.push({
      ruleCode,
      subject: fact.key,
      stableKey: stableKeyOf(ruleCode, fact.key),
      ...RULES[ruleCode],
      title: FACT_TITLES[fact.key]?.(brandName) ?? `Correct what AI engines say about ${brandName}`,
      // A wrong fact is wrong for everyone who reads it: severity is full, and reach is how often the answers said it.
      severity: 1,
      reach: { share: Math.min(1, fact.wrong / accuracy.answersRead) },
      promptIds: [],
      sortKey: fact.wrong,
      evidence: {
        type: 'entity_fact',
        fact: fact.key,
        label: fact.label,
        expected: fact.expected,
        wrong: fact.wrong,
        right: fact.right,
        answersRead: accuracy.answersRead,
        examples: fact.examples,
        window: windowRange,
      },
      affectedUrls: [],
    });
  }
  return out.sort((a, b) => b.sortKey - a.sortKey || a.subject.localeCompare(b.subject));
}

/** A short, stable name for one profile address in a recommendation key (the key column is only 191 characters). */
export const profileSubject = (platform, url) =>
  `${platform}-${createHash('sha256').update(String(url)).digest('hex').slice(0, 8)}`;

const hostOfUrl = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return String(url).slice(0, 60);
  }
};

/**
 * A profile we could read that does not name the business, or that is gone, is an issue. One we could not look at is not:
 * its key goes in `couldNotLook`, which keeps an issue already open from being cleared by a week of blocked requests.
 */
function profileCandidates({ entity, brandName, universeAll }) {
  const out = [];
  const couldNotLook = [];
  for (const check of entity?.checks ?? []) {
    if (check.kind !== 'profile') continue;
    const subject = profileSubject(check.platform ?? 'other', check.subject);
    if (check.status === 'error') {
      couldNotLook.push(stableKeyOf('entity.profile', subject));
      continue;
    }
    if (check.status !== 'failed') continue;
    const ruleCode = 'entity.profile';
    const label = platformLabel(check.platform ?? 'other');
    out.push({
      ruleCode,
      subject,
      stableKey: stableKeyOf(ruleCode, subject),
      ...RULES[ruleCode],
      title:
        check.platform && check.platform !== 'other'
          ? `Fix your ${label} profile so it names ${brandName}`
          : `Fix your listing at ${hostOfUrl(check.subject)} so it names ${brandName}`,
      severity: check.finding === 'not_found' ? 0.6 : 0.4,
      reach: { affected: universeAll },
      promptIds: universeAll.map((u) => u.promptId),
      evidence: {
        type: 'entity_profile',
        platform: check.platform ?? 'other',
        platformLabel: label,
        url: check.subject,
        finding: check.finding,
        reachable: check.details?.reachable ?? null,
        namesBrand: check.details?.namesBrand ?? null,
        linksBack: check.details?.linksBack ?? null,
        checkedAt: check.checkedAt ? new Date(check.checkedAt).toISOString() : null,
      },
      affectedUrls: [check.subject],
    });
  }
  return { out, couldNotLook };
}

const WIKIDATA_TITLES = Object.freeze({
  not_in_wikidata: (brand) => `Get ${brand} a Wikidata item`,
  ambiguous: (brand) => `Tell AI engines which Wikidata item is ${brand}`,
  mismatch: () => 'Fix the Wikidata item number in your Brand Kit',
});

function wikidataCandidates({ entity, brandName, universeAll }) {
  const check = (entity?.checks ?? []).find((c) => c.kind === 'wikidata');
  if (!check) return { out: [], couldNotLook: [] };
  const ruleCode = 'entity.wikidata';
  const key = stableKeyOf(ruleCode, 'item');
  if (check.status === 'error') return { out: [], couldNotLook: [key] };
  if (check.status !== 'failed' || !WIKIDATA_TITLES[check.finding]) {
    return { out: [], couldNotLook: [] };
  }
  return {
    couldNotLook: [],
    out: [
      {
        ruleCode,
        subject: 'item',
        stableKey: key,
        ...RULES[ruleCode],
        title: WIKIDATA_TITLES[check.finding](brandName),
        severity: check.finding === 'mismatch' ? 0.5 : 0.3,
        reach: { affected: universeAll },
        promptIds: universeAll.map((u) => u.promptId),
        evidence: {
          type: 'entity_wikidata',
          finding: check.finding,
          candidates: Number(check.details?.candidates ?? 0),
          givenId: entity?.wikidataId || null,
          item: check.details?.item ?? null,
          checkedAt: check.checkedAt ? new Date(check.checkedAt).toISOString() : null,
        },
        affectedUrls: [],
      },
    ],
  };
}

const complete = (cell) => cell.status === 'complete';

function lostQuestionCandidates({ grid, brandName }) {
  const out = [];
  for (const row of grid) {
    // Any cell that names the brand, even a partial one or one with nothing else readable, means it is not lost.
    if (row.engines.some((e) => Number(e.brandK) > 0)) continue;
    const full = row.engines.filter((e) => Number(e.nOk) > 0 && complete(e));
    const readable = full.reduce((n, e) => n + Number(e.nOk), 0);
    if (readable < LIMITS.minAnswersForLost) continue;
    const rivals = new Map();
    for (const cell of full) {
      for (const rival of cell.rivals ?? []) {
        if (Number(rival.k) > 0)
          rivals.set(rival.name, (rivals.get(rival.name) ?? 0) + Number(rival.k));
      }
    }
    if (rivals.size === 0) continue;
    const named = [...rivals]
      .map(([name, k]) => ({ name, k }))
      .sort((a, b) => b.k - a.k || a.name.localeCompare(b.name));
    const engines = full.map((e) => e.engineCode).sort();
    const ruleCode = 'visibility.lost_prompt';
    out.push({
      ruleCode,
      subject: String(row.promptId),
      stableKey: stableKeyOf(ruleCode, row.promptId),
      ...RULES[ruleCode],
      title: `Get ${brandName} into the answer to “${clip(row.text, 90)}”`,
      severity: 1,
      reach: {
        affected: [{ promptId: row.promptId, priority: row.priority, engines: engines.length }],
      },
      promptIds: [row.promptId],
      priority: row.priority,
      rivalTotal: named.reduce((n, r) => n + r.k, 0),
      evidence: {
        type: 'lost_prompt',
        promptId: String(row.promptId),
        question: clip(row.text, 300),
        answersRead: readable,
        brandMentions: 0,
        engines,
        competitors: named.slice(0, 5),
      },
      affectedUrls: [],
    });
  }
  return out.sort(
    (a, b) =>
      b.priority - a.priority ||
      b.rivalTotal - a.rivalTotal ||
      String(a.subject).localeCompare(String(b.subject), 'en', { numeric: true }),
  );
}

function citedSourceCandidates({ citationGaps, answersTotal, windowRange }) {
  const out = [];
  for (const gap of citationGaps) {
    if (gap.own || Number(gap.answersWithoutBrand) < LIMITS.minCitingAnswers) continue;
    const ruleCode = 'visibility.cited_source';
    out.push({
      ruleCode,
      subject: gap.domain,
      stableKey: stableKeyOf(ruleCode, gap.domain),
      ...RULES[ruleCode],
      title: `Get listed or mentioned on ${gap.domain}`,
      // An outside mention helps indirectly, so it counts for half as much as a fix on the brand's own pages.
      severity: 0.5,
      reach: {
        share: answersTotal > 0 ? Math.min(1, Number(gap.answersWithoutBrand) / answersTotal) : 0,
      },
      promptIds: [],
      sortKey: Number(gap.answersWithoutBrand),
      evidence: {
        type: 'cited_source',
        domain: gap.domain,
        siteType: gap.classLabel ?? null,
        timesCited: Number(gap.timesCited),
        answersCiting: Number(gap.answersCiting),
        answersWithoutBrand: Number(gap.answersWithoutBrand),
        window: windowRange,
      },
      affectedUrls: [],
    });
  }
  return out.sort((a, b) => b.sortKey - a.sortKey || a.subject.localeCompare(b.subject));
}

/** A short, stable name for one page address in a recommendation key (the key column is only 191 characters). */
export const pageSubject = (url) => {
  let slug = '';
  try {
    slug = new URL(url).pathname
      .split('/')
      .filter(Boolean)
      .pop()
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
  } catch {
    // not an address: the hash alone names it
  }
  return `${slug ? `${slug}-` : ''}${createHash('sha256').update(String(url)).digest('hex').slice(0, 10)}`;
};

const lowerFirst = (text) => (text ? text[0].toLowerCase() + text.slice(1) : text);

const hostPath = (url) => {
  try {
    const u = new URL(url);
    return clip(`${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`, 80);
  } catch {
    return clip(url, 80);
  }
};

/**
 * Citation gaps (13.05): a site engines cite for the brand's questions, in answers that left the brand out. Where the
 * path is Content Studio (a competitor's page in a format we write) the title says what to publish; otherwise it is the
 * "get listed" task the old rule made.
 */
function citationGapCandidates({ citations, answersTotal, windowRange }) {
  const out = [];
  for (const site of citations?.opportunities ?? []) {
    if (site.answersWithoutBrand < CITATION_LIMITS.minAnswers) continue;
    const content = site.path === 'content' && site.contentFormat;
    const ruleCode = 'citation.gap';
    out.push({
      ruleCode,
      subject: site.domain,
      stableKey: stableKeyOf(ruleCode, site.domain),
      ...RULES[ruleCode],
      fixPath: content ? 'content' : 'guidance',
      category: content ? 'content_new' : 'offsite_presence',
      title: content
        ? `Publish a ${lowerFirst(FORMAT_LABELS[site.contentFormat])} to compete with ${site.domain}`
        : `Get listed or mentioned on ${site.domain}`,
      // An outside mention helps indirectly, so it counts for half as much as a fix on the brand's own pages.
      severity: content ? 0.6 : 0.5,
      reach: {
        share: answersTotal > 0 ? Math.min(1, site.answersWithoutBrand / answersTotal) : 0,
      },
      promptIds: site.promptIds,
      sortKey: site.answersWithoutBrand,
      evidence: {
        type: 'citation_gap',
        domain: site.domain,
        siteKind: site.type,
        siteType: site.typeLabel,
        format: site.format,
        formatLabel: site.formatLabel,
        path: content ? 'content' : 'guidance',
        contentFormat: content ? site.contentFormat : null,
        timesCited: site.timesCited,
        answersCiting: site.answersCiting,
        answersWithoutBrand: site.answersWithoutBrand,
        questions: site.questions.slice(0, 3).map((q) => ({
          promptId: q.promptId,
          text: clip(q.text, 160),
          answersWithoutBrand: q.answersWithoutBrand,
        })),
        pages: site.pages.map((p) => ({
          url: p.url,
          title: p.title ? clip(p.title, 120) : null,
          format: p.format ?? null,
        })),
        window: windowRange,
      },
      affectedUrls: site.pages.map((p) => p.url),
    });
  }
  return out.sort((a, b) => b.sortKey - a.sortKey || a.subject.localeCompare(b.subject));
}

/** Key pages of the brand's own site that engines never cited, though they cited the site (13.05). */
function ownPageCandidates({ citations, windowRange }) {
  const out = [];
  for (const page of citations?.uncitedPages ?? []) {
    const ruleCode = 'citation.own_page_uncited';
    const subject = pageSubject(page.url);
    out.push({
      ruleCode,
      subject,
      stableKey: stableKeyOf(ruleCode, subject),
      ...RULES[ruleCode],
      title: `Make ${hostPath(page.url)} easier for AI to cite`,
      severity: 0.4,
      reach: { share: 0.25 },
      promptIds: [],
      evidence: {
        type: 'citation_own_page',
        url: page.url,
        ownCitations: citations.ownCitations,
        pagesCited: citations.ownPagesCited,
        window: windowRange,
      },
      affectedUrls: [page.url],
    });
  }
  return out;
}

function hedgedCandidates({ sentiment, grid, brandName, windowRange }) {
  if (!sentiment || sentiment.n < LIMITS.minSentimentAnswers) return [];
  const average = sentiment.sum / sentiment.n;
  if (average > LIMITS.maxAverageSentiment) return [];
  const affected = grid
    .map((row) => ({
      promptId: row.promptId,
      priority: row.priority,
      engines: row.engines.filter((e) => Number(e.brandK) > 0).length,
    }))
    .filter((a) => a.engines > 0);
  const ruleCode = 'visibility.hedged';
  return [
    {
      ruleCode,
      subject: 'brand',
      stableKey: stableKeyOf(ruleCode, 'brand'),
      ...RULES[ruleCode],
      title: `Address why AI engines describe ${brandName} coolly`,
      severity: round3(Math.min(1, -average / 2)),
      reach: { affected },
      promptIds: affected.map((a) => a.promptId),
      evidence: {
        type: 'sentiment',
        average: Math.round(average * 100) / 100,
        answers: sentiment.n,
        window: windowRange,
      },
      affectedUrls: [],
    },
  ];
}

/**
 * Run every rule over what we know.
 *
 * @param scan          the latest finished scan, `{ id, finishedAt, checks: [{ code, status, points, possible, summary,
 *                      evidence }] }`, or null
 * @param prompts       the active questions, `[{ id, text, priority }]`
 * @param enginesCount  how many engines are enabled
 * @param grid          the window's cells per question, or null when nothing was tracked:
 *                      `[{ promptId, text, priority, engines: [{ engineCode, status, nOk, brandK, rivals: [{ name, k }] }] }]`
 * @param sentiment     the brand's `{ n, sum }` over the window (answers with a sentiment, and their total), or null
 * @param citationGaps  rows from `citationRows().gaps`
 * @param answersTotal  readable answers in the window (the denominator for a cited site's reach)
 * @param entity        what Milestone 12 knows, or null: `{ checks, accuracy, wikidataId, profilesListed }`: the latest
 *                      entity checks, the accuracy comparison (`checkFacts`), the Wikidata item the customer named, and how
 *                      many profiles the Brand Kit lists
 * @param citations     Milestone 13, or null: `{ opportunities, uncitedPages, ownCitations, ownPagesCited, ownPagesJudged }`
 *                      from `rankOpportunities().bySite` and `uncitedKeyPages`. When it is given, `citation.gap` and
 *                      `citation.own_page_uncited` are raised and the older `visibility.cited_source` is not
 * @returns `{ candidates, detectedKeys, evaluated }` (`evaluated` has `readiness`, `visibility` and one entry per entity rule); `candidates` are what to raise (capped);
 *          `detectedKeys` is every issue found, capped or not, so one the cap left out is not mistaken for a fixed one;
 *          candidates have no impact or ice yet: see `scoreCandidates`
 */
export function evaluateRules({
  brandName,
  scan = null,
  prompts = [],
  enginesCount = 0,
  grid = null,
  sentiment = null,
  citationGaps = [],
  answersTotal = 0,
  windowRange = null,
  entity = null,
  citations = null,
}) {
  const universeAll = prompts.map((p) => ({
    promptId: p.id,
    priority: p.priority ?? 1,
    engines: enginesCount,
  }));
  const readiness = readinessCandidates({ scan, universeAll });
  const hasAnswers =
    Boolean(grid) && grid.some((row) => row.engines.some((e) => Number(e.nOk) > 0));
  const lost = hasAnswers ? lostQuestionCandidates({ grid, brandName }) : [];
  const sites =
    hasAnswers && !citations
      ? citedSourceCandidates({ citationGaps, answersTotal, windowRange })
      : [];
  const gaps =
    hasAnswers && citations ? citationGapCandidates({ citations, answersTotal, windowRange }) : [];
  const ownPages = hasAnswers && citations ? ownPageCandidates({ citations, windowRange }) : [];
  const cool = hasAnswers ? hedgedCandidates({ sentiment, grid, brandName, windowRange }) : [];
  const facts = wrongFactCandidates({ entity, brandName, windowRange });
  const profiles = profileCandidates({ entity, brandName, universeAll });
  const wiki = wikidataCandidates({ entity, brandName, universeAll });
  // Everything found, before the caps below: an issue the cap leaves out is still there, so it must not look "fixed".
  const everything = [
    ...readiness,
    ...lost,
    ...sites,
    ...gaps,
    ...ownPages,
    ...cool,
    ...facts,
    ...profiles.out,
    ...wiki.out,
  ].filter((c) => hasEvidence(c));
  const shown = new Set([
    ...readiness.map((c) => c.stableKey),
    ...lost.slice(0, LIMITS.lostQuestions).map((c) => c.stableKey),
    ...sites.slice(0, LIMITS.citedSites).map((c) => c.stableKey),
    ...gaps.slice(0, CITATION_LIMITS.gaps).map((c) => c.stableKey),
    ...ownPages.slice(0, CITATION_LIMITS.uncitedPages).map((c) => c.stableKey),
    ...cool.map((c) => c.stableKey),
    ...facts.map((c) => c.stableKey),
    ...profiles.out.map((c) => c.stableKey),
    ...wiki.out.map((c) => c.stableKey),
  ]);
  // The sort fields are for ordering the caps above; a candidate does not carry them on.
  const strip = (c) => {
    const candidate = { ...c };
    delete candidate.priority;
    delete candidate.rivalTotal;
    delete candidate.sortKey;
    return candidate;
  };
  return {
    candidates: everything.filter((c) => shown.has(c.stableKey)).map(strip),
    // An entity check that could not look is not "fixed": its key stays detected, so an issue already open is not cleared.
    detectedKeys: [
      ...everything.map((c) => c.stableKey),
      ...profiles.couldNotLook,
      ...wiki.couldNotLook,
    ],
    evaluated: {
      readiness: Boolean(scan?.checks?.length),
      visibility: hasAnswers,
      // The entity rules are judged one by one (`reconcile` looks for a rule's own code before its family): each needs
      // its own evidence, and a week of readable answers says nothing about a profile.
      'entity.wrong_fact': Boolean(entity?.accuracy && entity.accuracy.answersRead > 0),
      'entity.profile': Boolean(
        entity && (entity.checks.some((c) => c.kind === 'profile') || entity.profilesListed === 0),
      ),
      // The citation rules are judged one by one too: a gap needs readable answers, an uncited page needs a scan and a site
      // that was cited often enough for "never" to mean something.
      'citation.gap': Boolean(citations) && hasAnswers,
      'citation.own_page_uncited': Boolean(citations?.ownPagesJudged) && hasAnswers,
      'entity.wikidata': Boolean(
        entity?.checks.some((c) => c.kind === 'wikidata' && c.status !== 'error'),
      ),
    },
  };
}

/** No recommendation without evidence: an object with something in it. */
export const hasEvidence = (candidate) =>
  Boolean(candidate?.evidence) &&
  typeof candidate.evidence === 'object' &&
  Object.keys(candidate.evidence).length > 0;

/**
 * Give each candidate its impact, confidence and ICE score, and put the best first. Ties break on the key so the
 * order never depends on the order the rules ran in.
 *
 * @param candidates  from `evaluateRules`
 * @param prompts     the active questions `[{ id, priority }]`, and `enginesCount`
 * @param outcomes    closed-loop results by rule code, `{ [ruleCode]: { wins, decided } }`, to recalibrate the priors
 */
export function scoreCandidates(candidates, { prompts, enginesCount, outcomes = {} }) {
  const universe = prompts.map((p) => ({ priority: p.priority ?? 1, engines: enginesCount }));
  return candidates
    .map((c) => {
      const impact =
        c.reach.share != null
          ? round3(Math.min(1, Math.max(0, c.reach.share)) * c.severity * 100)
          : impactScore({
              affected: c.reach.affected.map((a) => ({ priority: a.priority, engines: a.engines })),
              universe,
              severity: c.severity,
            });
      const confidence = calibratedConfidence(c.prior, outcomes[c.ruleCode]);
      return { ...c, impact, confidence, ice: iceScore({ impact, confidence, effort: c.effort }) };
    })
    .sort((a, b) => b.ice - a.ice || a.stableKey.localeCompare(b.stableKey));
}
