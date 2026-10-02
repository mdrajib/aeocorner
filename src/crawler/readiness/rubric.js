/**
 * The AEO readiness rubric, v0 (MVP §6.6): 24 checks in six categories, 100 points in all.
 *
 * The weights are v0 heuristics. After about 200 projects they are recalibrated by regressing observed
 * visibility on these features, so the version is stored with every scan: a score is only comparable with scores
 * of the same rubric version.
 *
 * `informational` checks (A2 training-bot policy, F4 llms.txt) are shown but are not recommendations: the first is
 * a business choice, and the major engines haven't said they use the second.
 */

export const RUBRIC_VERSION = 'v0.1';

export const CATEGORIES = Object.freeze({
  A: { name: 'AI crawler access', points: 20 },
  B: { name: 'Renderability', points: 10 },
  C: { name: 'Structured data', points: 20 },
  D: { name: 'Entity clarity', points: 15 },
  E: { name: 'Content answerability', points: 25 },
  F: { name: 'Technical foundations', points: 10 },
});

/** code -> { category, points, title, informational? } in rubric order. */
export const CHECKS = Object.freeze({
  A1: { category: 'A', points: 8, title: 'Answer and search crawlers are allowed' },
  A2: { category: 'A', points: 2, title: 'Training-crawler policy is stated', informational: true },
  A3: { category: 'A', points: 6, title: 'No firewall block or challenge for AI crawlers' },
  A4: { category: 'A', points: 4, title: 'XML sitemap exists and robots.txt points to it' },
  B1: { category: 'B', points: 7, title: 'Main content is in the raw HTML' },
  B2: {
    category: 'B',
    points: 3,
    title: 'Key content is not hidden behind interactions or iframes',
  },
  C1: { category: 'C', points: 6, title: 'Organization schema with name, logo, URL and sameAs' },
  C2: { category: 'C', points: 8, title: 'Page-type schema on key pages' },
  C3: { category: 'C', points: 3, title: 'JSON-LD is valid and server-rendered' },
  C4: { category: 'C', points: 3, title: 'WebSite and BreadcrumbList schema' },
  D1: {
    category: 'D',
    points: 4,
    title: 'Brand name is consistent across title, og:site_name and schema',
  },
  D2: { category: 'D', points: 4, title: 'About page says who, what, where and for whom' },
  D3: { category: 'D', points: 4, title: 'sameAs links to authoritative profiles' },
  D4: {
    category: 'D',
    points: 3,
    title: 'Name, address and phone are consistent (local businesses)',
  },
  E1: { category: 'E', points: 5, title: 'Question-style headings' },
  E2: { category: 'E', points: 6, title: 'A direct answer right under each question' },
  E3: { category: 'E', points: 4, title: 'Lists and tables' },
  E4: { category: 'E', points: 4, title: 'FAQ sections' },
  E5: { category: 'E', points: 3, title: 'Evidence: statistics, sources and authors' },
  E6: { category: 'E', points: 3, title: 'Freshness: visible, recent dates' },
  F1: { category: 'F', points: 4, title: 'Key pages are indexable with correct canonicals' },
  F2: { category: 'F', points: 2, title: 'HTTPS, 200 responses and no redirect chains' },
  F3: { category: 'F', points: 3, title: 'Titles and meta descriptions are present and unique' },
  F4: { category: 'F', points: 1, title: 'llms.txt is present', informational: true },
});

export const CHECK_CODES = Object.freeze(Object.keys(CHECKS));

/** What the share of the rubric we could actually evaluate must be before a score is worth showing. */
export const MIN_EVALUATED_SHARE = 0.5;

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Turn a check's answer into the stored result. A check returns `{ score, evidence, summary }` where `score` is
 * 0 to 1 (how much of the check's points were earned), or `{ status: 'not_applicable' | 'error', ... }`.
 *
 * An `error` means we could not look (the page didn't load, the browser was missing), and it is NOT a fail:
 * a failed collection is never counted as "not there" (CLAUDE.md), so it is left out of the score entirely.
 */
export function finishCheck(code, answer) {
  const def = CHECKS[code];
  const base = {
    code,
    possible: def.points,
    evidence: answer.evidence ?? {},
    summary: answer.summary ?? '',
  };
  if (answer.status === 'not_applicable' || answer.status === 'error') {
    return { ...base, status: answer.status, points: 0 };
  }
  const score = Math.min(1, Math.max(0, answer.score));
  const points = round1(score * def.points);
  const status = points >= def.points ? 'pass' : points <= 0 ? 'fail' : 'partial';
  return { ...base, status, points };
}

/**
 * The readiness score: points earned out of points that could be earned among the checks we could evaluate,
 * as a whole number 0-100. Checks that don't apply, or that errored, are not in either number. If too little of
 * the rubric could be evaluated, the score is null ("couldn't check"), never a low number.
 */
export function scoreChecks(results) {
  const category = (letter) => {
    const mine = results.filter((r) => CHECKS[r.code].category === letter);
    const evaluated = mine.filter((r) => r.status !== 'not_applicable' && r.status !== 'error');
    const possible = evaluated.reduce((sum, r) => sum + r.possible, 0);
    const earned = evaluated.reduce((sum, r) => sum + r.points, 0);
    return {
      name: CATEGORIES[letter].name,
      earned: round1(earned),
      possible,
      checks: mine.length,
      evaluated: evaluated.length,
      score: possible > 0 ? Math.round((earned / possible) * 100) : null,
    };
  };
  const categories = Object.fromEntries(
    Object.keys(CATEGORIES).map((letter) => [letter, category(letter)]),
  );

  const evaluated = results.filter((r) => r.status !== 'not_applicable' && r.status !== 'error');
  const possible = evaluated.reduce((sum, r) => sum + r.possible, 0);
  const earned = evaluated.reduce((sum, r) => sum + r.points, 0);
  const totalPossible = Object.values(CHECKS).reduce((sum, c) => sum + c.points, 0);
  // Checks that don't apply to this site shrink the denominator on purpose; only errors reduce coverage.
  const applicablePossible = results
    .filter((r) => r.status !== 'not_applicable')
    .reduce((sum, r) => sum + r.possible, 0);
  const coverage = applicablePossible > 0 ? possible / applicablePossible : 0;

  return {
    score:
      coverage >= MIN_EVALUATED_SHARE && possible > 0
        ? Math.round((earned / possible) * 100)
        : null,
    earned: round1(earned),
    possible,
    totalPossible,
    coverage: Math.round(coverage * 100) / 100,
    categories,
    counts: {
      pass: results.filter((r) => r.status === 'pass').length,
      partial: results.filter((r) => r.status === 'partial').length,
      fail: results.filter((r) => r.status === 'fail').length,
      not_applicable: results.filter((r) => r.status === 'not_applicable').length,
      error: results.filter((r) => r.status === 'error').length,
    },
  };
}
