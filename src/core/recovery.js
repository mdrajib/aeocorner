import { CHECKS } from '../crawler/readiness/rubric.js';
import { DEFAULT_ENGINE_LABELS } from './narrative.js';
import { compareWindows, SIGNIFICANCE } from './significance.js';
import { MEASURES, TREND_WINDOW_DAYS, usable, windowsAt } from './trends.js';

/**
 * Visibility recovery cases (Milestone 14, MVP F7 and docs/MILESTONES_SERVICES.md). Pure: daily rollup rows and what we
 * know about the site go in, and out come whether a decline has LASTED, what probably caused it (with the facts behind
 * each cause, or "we can't tell"), which existing repairs it points at, and whether a case may be closed.
 *
 * What this file never does:
 *   - guess. A cause is named only when at least two separate facts support it and they outnumber the facts against it;
 *     otherwise the answer is "can't tell". Every fact is a sentence built here from numbers we were given, so the words
 *     cannot say more than the evidence does (no model writes any of it).
 *   - count our own outages as the customer's decline. Rows come through `usable()` like in trends.js: a day on which an
 *     engine did not finish cleanly is left out of that engine's windows.
 *   - turn "couldn't check" into a result. A page we could not look at is `unknown`, and an unknown fix is never "gone".
 *   - repair anything itself. A repair is a pointer to an ordinary Action Center rule or fix; a person still approves it.
 *
 * Decision F4 (docs/MILESTONES_SERVICES.md §4), defaults until the founder picks: a decline is LASTING when it passed the
 * 28-vs-28 significance test AND the latest 14 days are still at least 5 points below the earlier range; a decline on one
 * engine counts like a decline on all of them (`oneEngineCounts`).
 */

export const RECOVERY = Object.freeze({
  /** The recent window the "still lower" rule and the closing rule look at. */
  recentDays: 14,
  /** Answers the recent window needs before it can say anything (the 28-day windows need 20 each, see significance.js). */
  minRecentAnswers: 10,
  /** How far below its earlier range the recent window must still be, in points. */
  minDropPp: SIGNIFICANCE.minDeltaPp,
  /** A case that never recovers is closed as unknown after this many days. */
  unknownAfterDays: 56,
  /** A closed case's decline is not opened again for this many days. */
  cooldownDays: 14,
  /** F4: does a drop on one engine open a case? */
  oneEngineCounts: true,
  /** The most facts or causes shown in one list. */
  maxFacts: 4,
});

export const METRICS = Object.freeze({
  mention_rate: { kind: 'mention_rate_change', label: 'How often AI answers name you' },
  share_of_voice: { kind: 'sov_change', label: 'Your share of voice' },
  citation_share: { kind: 'citation_share_change', label: 'Your share of cited sources' },
});
export const METRIC_KEYS = Object.freeze(Object.keys(METRICS));

export const CASE_STATUSES = Object.freeze([
  'diagnosing',
  'repairing',
  'recovered',
  'closed_noise',
  'closed_unknown',
]);
export const OPEN_STATUSES = Object.freeze(['diagnosing', 'repairing']);
export const CLOSED_STATUSES = Object.freeze(
  CASE_STATUSES.filter((s) => !OPEN_STATUSES.includes(s)),
);

/** One table of allowed moves. Only the system moves a case: a person cannot declare a recovery or close a case. */
const MOVES = Object.freeze({
  diagnosing: ['repairing', 'recovered', 'closed_noise', 'closed_unknown'],
  repairing: ['recovered', 'closed_noise', 'closed_unknown'],
  recovered: [],
  closed_noise: [],
  closed_unknown: [],
});
export const canMoveCase = (from, to) => (MOVES[from] ?? []).includes(to);

export const STATUS_LABELS = Object.freeze({
  diagnosing: 'Finding the cause',
  repairing: 'Repairs in progress',
  recovered: 'Recovered',
  closed_noise: 'Recovered by itself',
  closed_unknown: 'Closed, cause unknown',
});

export const openKey = (metric, engineCode) => `${metric}:${engineCode ?? 'all'}`;

// --- Days ----------------------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const dayString = (value) =>
  (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);
const toDay = (value) => new Date(`${dayString(value)}T00:00:00Z`);
const addDays = (day, n) => dayString(new Date(toDay(day).getTime() + n * DAY_MS));
const daysBetween = (a, b) => Math.round((toDay(b).getTime() - toDay(a).getTime()) / DAY_MS);
const shortDate = (value) =>
  toDay(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** The latest `days` whole UTC days ending on `asOf`, inclusive. */
export const recentWindow = (asOf, days = RECOVERY.recentDays) => [
  addDays(asOf, -(days - 1)),
  dayString(asOf),
];

const rate = ({ n, k }) => (n > 0 ? k / n : null);
const pct = (value) => `${Math.round(value * 100)}%`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const list = (items) =>
  items.length <= 2
    ? items.join(' and ')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

// --- Counting ------------------------------------------------------------------------------------------------------

/** `{ n, k }` of one metric over one window for the brand, optionally for one engine. Unfinished days are left out. */
export function measure(rows, { metric, entityId, engineCode = null, window }) {
  const found = usable(rows, window, engineCode);
  const { n, k } = MEASURES[METRICS[metric].kind]({ rows: found, entityId });
  return { n, k, rate: rate({ n, k }), window };
}

// --- 14.02: is a decline lasting? ----------------------------------------------------------------------------------

/**
 * Is one metric's decline a LASTING one, as of a day?
 *
 * verdict:
 *   `not_enough_data`  a 28-day window has fewer than 20 answers: nothing can be said (never "no decline")
 *   `none`             no significant fall
 *   `pending`          a significant fall, but the last 14 days have too few answers to say whether it lasts
 *   `noise`            a significant fall that has already come back (the latest 14 days are within 5 points of before)
 *   `lasting`          a significant fall and the latest 14 days are still at least 5 points below the earlier range
 */
export function judgeDecline({ rows, brandId, asOf, metric, engineCode = null, options = {} }) {
  const windows = windowsAt(asOf, TREND_WINDOW_DAYS);
  const baseline = measure(rows, { metric, entityId: brandId, engineCode, window: windows.before });
  const decline = measure(rows, { metric, entityId: brandId, engineCode, window: windows.after });
  const recent = measure(rows, {
    metric,
    entityId: brandId,
    engineCode,
    window: recentWindow(asOf),
  });
  const test = compareWindows(
    { n: baseline.n, k: baseline.k },
    { n: decline.n, k: decline.k },
    options,
  );
  const base = {
    metric,
    engineCode,
    baseline,
    decline,
    recent,
    deltaPp: test.deltaPp,
    p: test.p,
  };
  if (test.verdict === 'not_enough_data') return { ...base, verdict: 'not_enough_data' };
  if (!(test.significant && test.direction === 'down')) return { ...base, verdict: 'none' };
  if (recent.n < RECOVERY.minRecentAnswers) return { ...base, verdict: 'pending' };
  const stillLower = recent.rate <= baseline.rate - RECOVERY.minDropPp / 100;
  return { ...base, verdict: stillLower ? 'lasting' : 'noise' };
}

/**
 * Every lasting decline of the brand's metrics as of a day: each metric across all engines and on each engine. Rows are
 * ordered all-engines first, so a caller that opens cases in order sees the broadest one first.
 */
export function findLastingDeclines({ rows, brandId, asOf, options = {} }) {
  const engines = [...new Set(rows.map((r) => r.engineCode))].sort();
  const scopes = RECOVERY.oneEngineCounts ? [null, ...engines] : [null];
  const found = [];
  for (const metric of METRIC_KEYS) {
    for (const engineCode of scopes) {
      const judged = judgeDecline({ rows, brandId, asOf, metric, engineCode, options });
      if (judged.verdict === 'lasting') found.push(judged);
    }
  }
  return found;
}

/** Our estimate of the day the fall began: the first week of the decline window already well below the earlier range. */
export function estimateOnset({ rows, brandId, decline }) {
  const { metric, engineCode, baseline } = decline;
  const [start, end] = decline.decline.window;
  for (let from = start; from <= end; from = addDays(from, 7)) {
    const to = addDays(from, 6) > end ? end : addDays(from, 6);
    const week = measure(rows, { metric, entityId: brandId, engineCode, window: [from, to] });
    if (week.n >= 5 && week.rate <= baseline.rate - RECOVERY.minDropPp / 100) return from;
  }
  return start;
}

// --- 14.03: what probably caused it ----------------------------------------------------------------------------------

const KIND_LABELS = Object.freeze({
  jsonld: 'structured data',
  meta: 'page titles and descriptions',
  robots_txt: 'robots.txt lines',
});
const fix = (id, text, data = {}) => ({ id, text, data });
const engineName = (code, names) => names?.[code] ?? DEFAULT_ENGINE_LABELS[code] ?? code;

/** Checks that went from a pass to a fail or part-pass between two scans. A check that errored on either side is skipped. */
export function regressedChecks(before, latest) {
  if (!before?.checks || !latest?.checks) return [];
  const was = new Map(before.checks.map((c) => [c.code, c.status]));
  return latest.checks
    .filter((c) => was.get(c.code) === 'pass' && (c.status === 'fail' || c.status === 'partial'))
    .filter((c) => CHECKS[c.code] && !CHECKS[c.code].informational)
    .map((c) => ({ code: c.code, title: CHECKS[c.code].title, now: c.status }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

const scoreFell = (before, latest) =>
  Number.isFinite(before?.score) && Number.isFinite(latest?.score)
    ? before.score - latest.score
    : 0;

function siteChangeCause({ onset, siteChanges = [], scans, regressed }) {
  const near = siteChanges.filter((c) => {
    const at = dayString(c.appliedAt);
    return !c.rolledBack && at >= addDays(onset, -14) && at <= addDays(onset, 7);
  });
  if (near.length === 0) return null;
  const facts = near.slice(0, 2).map((c) => {
    const gap = daysBetween(c.appliedAt, onset);
    const when =
      gap > 0
        ? `${plural(gap, 'day', 'days')} before`
        : gap < 0
          ? `${plural(-gap, 'day', 'days')} after`
          : 'the day of';
    return fix(
      `site_change.${c.id}`,
      `We changed ${KIND_LABELS[c.kind] ?? 'your site'}${c.targetUrl ? ` on ${c.targetUrl}` : ''} on ${shortDate(c.appliedAt)}, ${when} the fall began.`,
      { siteChangeId: String(c.id), appliedAt: dayString(c.appliedAt) },
    );
  });
  const against = [];
  if (regressed.length > 0 && scans?.latest) {
    facts.push(
      fix(
        'site_change.regressed',
        `After that change ${list(regressed.slice(0, 3).map((c) => c.code))} no longer passes in our site check.`,
        { codes: regressed.map((c) => c.code) },
      ),
    );
  } else if (scans?.before && scans?.latest) {
    against.push(
      fix('site_change.clean', 'Our site check found nothing that got worse after the change.'),
    );
  }
  return { code: 'site_change', facts, against };
}

function readinessCause({ scans, regressed }) {
  if (!scans?.before || !scans?.latest || regressed.length === 0) return null;
  const facts = [
    fix(
      'readiness.regressed',
      `${list(regressed.slice(0, 3).map((c) => `${c.code} (${c.title})`))} passed in the check on ${shortDate(scans.before.finishedAt)} and does not now.`,
      { codes: regressed.map((c) => c.code) },
    ),
  ];
  const fell = scoreFell(scans.before, scans.latest);
  if (fell >= 5) {
    facts.push(
      fix(
        'readiness.score',
        `Your site’s readiness score fell ${fell} points, from ${scans.before.score} to ${scans.latest.score}.`,
        {
          from: scans.before.score,
          to: scans.latest.score,
        },
      ),
    );
  }
  const reach = regressed.filter((c) => ['A', 'B'].includes(CHECKS[c.code].category));
  if (reach.length > 0) {
    facts.push(
      fix(
        'readiness.reach',
        `${list(reach.slice(0, 2).map((c) => c.code))} decides whether engines can reach or read your pages at all.`,
        { codes: reach.map((c) => c.code) },
      ),
    );
  }
  return { code: 'readiness_regression', facts, against: [] };
}

function earlierFixCause({ onset, earlierFixes = [] }) {
  const gone = earlierFixes.filter((f) => f.live === 'gone');
  if (gone.length === 0) return null;
  const facts = [];
  const against = earlierFixes
    .filter((f) => f.live === 'present')
    .slice(0, 2)
    .map((f) =>
      fix(`fix.present.${f.recommendationId}`, `“${f.title}” is still in place on your site.`),
    );
  for (const f of gone.slice(0, 2)) {
    facts.push(
      fix(
        `fix.gone.${f.recommendationId}`,
        `“${f.title}” is no longer on your site when we looked just now.`,
        {
          recommendationId: String(f.recommendationId),
        },
      ),
    );
    if (f.verifiedBefore) {
      facts.push(
        fix(
          `fix.was.${f.recommendationId}`,
          `We had confirmed “${f.title}” was in place when it was done.`,
          {
            recommendationId: String(f.recommendationId),
          },
        ),
      );
    }
    if (f.doneAt && dayString(f.doneAt) <= addDays(onset, 7)) {
      facts.push(
        fix(
          `fix.before.${f.recommendationId}`,
          `“${f.title}” was done on ${shortDate(f.doneAt)}, before the fall.`,
          {
            recommendationId: String(f.recommendationId),
          },
        ),
      );
    }
  }
  return { code: 'earlier_fix_gone', facts: facts.slice(0, RECOVERY.maxFacts), against };
}

/** The other engines' verdict on the same metric: did they fall too? Used to tell "this engine changed" from "we lost ground". */
const compareScope = (rows, { metric, entityId, engineCode, asOf }) => {
  const windows = windowsAt(asOf, TREND_WINDOW_DAYS);
  const before = measure(rows, { metric, entityId, engineCode, window: windows.before });
  const after = measure(rows, { metric, entityId, engineCode, window: windows.after });
  return { before, after, test: compareWindows(before, after) };
};

function engineWideCause({ rows, brandId, decline, asOf, names }) {
  const { engineCode, metric } = decline;
  if (!engineCode || metric !== 'mention_rate') return null;
  const others = [...new Set(rows.map((r) => r.engineCode))].filter((e) => e !== engineCode).sort();
  const compared = others.map((e) => ({
    engineCode: e,
    ...compareScope(rows, { metric, entityId: brandId, engineCode: e, asOf }),
  }));
  const judged = compared.filter((c) => c.test.verdict !== 'not_enough_data');
  const facts = [];
  const against = [];
  if (
    judged.length > 0 &&
    judged.every((c) => !(c.test.significant && c.test.direction === 'down'))
  ) {
    facts.push(
      fix(
        'engine.others_flat',
        `Your figure did not fall on ${list(judged.map((c) => engineName(c.engineCode, names)))}; only ${engineName(engineCode, names)} fell.`,
        { engines: judged.map((c) => c.engineCode) },
      ),
    );
  } else if (judged.length > 0) {
    against.push(fix('engine.others_fell', 'Your figure fell on other engines too.'));
  }
  // Competitors on the same engine: if they all lost ground, the engine changed rather than you.
  const rivals = [...new Set(rows.map((r) => String(r.entityId)))].filter(
    (id) => id !== String(brandId),
  );
  const total = (window) =>
    rivals.reduce(
      (acc, id) => {
        const m = measure(rows, { metric, entityId: id, engineCode, window });
        return { n: acc.n + m.n, k: acc.k + m.k };
      },
      { n: 0, k: 0 },
    );
  const windows = windowsAt(asOf, TREND_WINDOW_DAYS);
  const b = total(windows.before);
  const a = total(windows.after);
  if (b.n >= 20 && a.n >= 20 && rate(a) <= rate(b) - RECOVERY.minDropPp / 100) {
    facts.push(
      fix(
        'engine.rivals_fell',
        `The competitors you track fell too on ${engineName(engineCode, names)}: ${pct(rate(b))} before, ${pct(rate(a))} now.`,
        { before: rate(b), after: rate(a) },
      ),
    );
  } else if (b.n >= 20 && a.n >= 20 && rate(a) > rate(b) + RECOVERY.minDropPp / 100) {
    against.push(fix('engine.rivals_rose', 'Competitors rose on the same engine.'));
  }
  return { code: 'engine_wide', facts, against };
}

function competitorCause({ rows, brandId, decline, asOf, entityNames = {}, sov }) {
  const rivals = [...new Set(rows.map((r) => String(r.entityId)))]
    .filter((id) => id !== String(brandId))
    .sort();
  const risers = [];
  for (const id of rivals) {
    const c = compareScope(rows, {
      metric: 'mention_rate',
      entityId: id,
      engineCode: decline.engineCode,
      asOf,
    });
    if (c.test.significant && c.test.direction === 'up') {
      risers.push({ id, name: entityNames[id] ?? 'A competitor', gainPp: c.test.deltaPp });
    }
  }
  if (risers.length === 0) return null;
  risers.sort((a, b) => b.gainPp - a.gainPp || a.id.localeCompare(b.id));
  const facts = [
    fix(
      'competitor.rose',
      `${list(risers.slice(0, 3).map((r) => r.name))} ${risers.length === 1 ? 'is' : 'are'} named significantly more often than before, up ${risers[0].gainPp} points for ${risers[0].name}.`,
      { entityIds: risers.map((r) => r.id) },
    ),
  ];
  const brandFall = Math.abs(decline.deltaPp ?? 0);
  const gain = risers.reduce((n, r) => n + r.gainPp, 0);
  if (gain >= brandFall / 2 && brandFall > 0) {
    facts.push(
      fix(
        'competitor.size',
        `Their gain is about as big as your fall (${Math.round(gain)} points up, ${Math.round(brandFall)} points down).`,
        { gainPp: gain, fallPp: brandFall },
      ),
    );
  }
  if (sov && sov.test.significant && sov.test.direction === 'down') {
    facts.push(
      fix('competitor.sov', 'Your share of voice fell significantly over the same weeks.', {
        deltaPp: sov.test.deltaPp,
      }),
    );
  }
  return { code: 'competitor_gain', facts, against: [] };
}

function lostCitationCause({ ownCitations, citationTest }) {
  if (!ownCitations?.before || !ownCitations?.after) return null;
  const { before, after } = ownCitations;
  if (before.total < 4) return null;
  const facts = [];
  const against = [];
  if (after.total <= before.total / 2) {
    facts.push(
      fix(
        'citation.fell',
        `Engines cited your own site ${after.total} times in the latest weeks, against ${before.total} before.`,
        {
          before: before.total,
          after: after.total,
        },
      ),
    );
  } else if (after.total > before.total) {
    against.push(fix('citation.rose', 'Engines cited your own site more often than before.'));
  }
  const now = new Set(after.pages.map((p) => p.url));
  const lost = before.pages.filter((p) => p.count >= 2 && !now.has(p.url)).slice(0, 3);
  if (lost.length > 0) {
    facts.push(
      fix(
        'citation.lost',
        `${plural(lost.length, 'page', 'pages')} that engines used to cite no longer ${lost.length === 1 ? 'is' : 'are'} cited: ${list(lost.map((p) => p.url))}.`,
        {
          urls: lost.map((p) => p.url),
        },
      ),
    );
  }
  if (citationTest?.significant && citationTest.direction === 'down') {
    facts.push(
      fix('citation.share', 'Your share of cited sources fell significantly over the same weeks.', {
        deltaPp: citationTest.deltaPp,
      }),
    );
  }
  return { code: 'lost_citation', facts, against };
}

function noAnswerCause({ rows, brandId, decline, asOf, names }) {
  const windows = windowsAt(asOf, TREND_WINDOW_DAYS);
  const engines = [
    ...new Set(rows.filter((r) => Number(r.aioQueries) > 0).map((r) => r.engineCode)),
  ].sort();
  for (const code of engines) {
    if (decline.engineCode && decline.engineCode !== code) continue;
    const count = (window) => {
      const found = usable(rows, window, code).filter(
        (r) => String(r.entityId) === String(brandId),
      );
      return {
        n: found.reduce((s, r) => s + Number(r.aioQueries ?? 0), 0),
        k: found.reduce((s, r) => s + Number(r.aioTriggered ?? 0), 0),
      };
    };
    const before = count(windows.before);
    const after = count(windows.after);
    const test = compareWindows(before, after, { minDeltaPp: 20 });
    if (!(test.significant && test.direction === 'down')) continue;
    const facts = [
      fix(
        'aio.fewer',
        `${engineName(code, names)} showed an answer for ${pct(rate(after))} of your questions, down from ${pct(rate(before))}.`,
        { engine: code, before: rate(before), after: rate(after) },
      ),
    ];
    const brandOnEngine = compareScope(rows, {
      metric: decline.metric,
      entityId: brandId,
      engineCode: code,
      asOf,
    });
    if (brandOnEngine.test.significant && brandOnEngine.test.direction === 'down') {
      facts.push(
        fix('aio.brand', `Your figure fell on ${engineName(code, names)} over the same weeks.`, {
          engine: code,
        }),
      );
    }
    const readable = (w) =>
      measure(rows, { metric: 'mention_rate', entityId: brandId, engineCode: code, window: w }).n;
    const readBefore = readable(windows.before);
    const readAfter = readable(windows.after);
    if (readBefore >= 20 && readAfter <= readBefore * 0.7) {
      facts.push(
        fix(
          'aio.answers',
          `We could read ${readAfter} answers from ${engineName(code, names)} in the latest weeks, against ${readBefore} before.`,
          {
            before: readBefore,
            after: readAfter,
          },
        ),
      );
    }
    return { code: 'engine_no_answer', facts, against: [] };
  }
  return null;
}

export const CAUSE_ORDER = Object.freeze([
  'site_change',
  'readiness_regression',
  'earlier_fix_gone',
  'lost_citation',
  'competitor_gain',
  'engine_no_answer',
  'engine_wide',
]);

export const CAUSE_LABELS = Object.freeze({
  site_change: 'A change made to your site',
  readiness_regression: 'Your site got harder for engines to read',
  earlier_fix_gone: 'An earlier fix is no longer on your site',
  lost_citation: 'Engines stopped citing your pages',
  competitor_gain: 'A competitor gained ground',
  engine_no_answer: 'An engine stopped showing an answer',
  engine_wide: 'One engine changed for everyone',
});

/**
 * What probably caused a lasting decline.
 *
 * @param {object} input
 * @param {object} input.decline        one `judgeDecline` result with verdict `lasting`
 * @param {object[]} input.rows         the project's `metric_daily` rows over both windows
 * @param {string} input.brandId
 * @param {string} input.asOf           the day the windows end on
 * @param {object[]} [input.siteChanges]  our own applied changes: `{ id, kind, targetUrl, appliedAt, rolledBack }`
 * @param {object} [input.scans]        `{ before, latest }`: `{ finishedAt, score, checks: [{ code, status }] }` or null
 * @param {object[]} [input.earlierFixes]  `{ recommendationId, title, live: 'present'|'gone'|'unknown', verifiedBefore, doneAt }`
 * @param {object} [input.ownCitations]   `{ before, after }`: `{ total, pages: [{ url, count }] }`, or null
 * @param {object} [input.engineNames] [input.entityNames]
 * @returns `{ outcome: 'named'|'cant_tell', onset, causes, considered, reason }`. A cause is
 *   `{ code, label, band: 'likely'|'strong', facts, against }`: named only with two or more facts that outnumber what
 *   speaks against it (`strong` with three and nothing against).
 */
export function diagnose({
  decline,
  rows,
  brandId,
  asOf,
  siteChanges = [],
  scans = null,
  earlierFixes = [],
  ownCitations = null,
  engineNames = {},
  entityNames = {},
}) {
  const onset = estimateOnset({ rows, brandId, decline });
  const regressed = regressedChecks(scans?.before, scans?.latest);
  const sov =
    decline.metric === 'share_of_voice'
      ? null
      : compareScope(rows, {
          metric: 'share_of_voice',
          entityId: brandId,
          engineCode: decline.engineCode,
          asOf,
        });
  const citationTest = compareScope(rows, {
    metric: 'citation_share',
    entityId: brandId,
    engineCode: decline.engineCode,
    asOf,
  }).test;
  const names = engineNames;

  const found = [
    siteChangeCause({ onset, siteChanges, scans, regressed }),
    readinessCause({ scans, regressed }),
    earlierFixCause({ onset, earlierFixes }),
    lostCitationCause({ ownCitations, citationTest }),
    competitorCause({ rows, brandId, decline, asOf, entityNames, sov }),
    noAnswerCause({ rows, brandId, decline, asOf, names }),
    engineWideCause({ rows, brandId, decline, asOf, names }),
  ].filter(Boolean);

  const causes = found
    .filter((c) => c.facts.length >= 2 && c.facts.length > c.against.length)
    .map((c) => ({
      code: c.code,
      label: CAUSE_LABELS[c.code],
      band: c.facts.length >= 3 && c.against.length === 0 ? 'strong' : 'likely',
      facts: c.facts.slice(0, RECOVERY.maxFacts),
      against: c.against,
    }))
    .sort(
      (a, b) =>
        (b.band === 'strong') - (a.band === 'strong') ||
        b.facts.length - a.facts.length ||
        CAUSE_ORDER.indexOf(a.code) - CAUSE_ORDER.indexOf(b.code),
    );
  const considered = found.filter((c) => !causes.some((x) => x.code === c.code)).map((c) => c.code);
  if (causes.length === 0) {
    return {
      outcome: 'cant_tell',
      onset,
      causes: [],
      considered,
      reason:
        found.length === 0
          ? 'We found nothing in our records that lines up with the fall.'
          : 'Each possible cause had fewer than two facts behind it, so we are not naming one.',
    };
  }
  return { outcome: 'named', onset, causes, considered, reason: null };
}

/** Every named cause must stand on at least two facts, outnumbering the ones against it. Used by the eval and the saver. */
export function findUnsupportedCauses(diagnosis) {
  const problems = [];
  if (diagnosis.outcome === 'cant_tell' && diagnosis.causes.length > 0) {
    problems.push('cant_tell names a cause');
  }
  if (diagnosis.outcome === 'named' && diagnosis.causes.length === 0)
    problems.push('named without a cause');
  for (const c of diagnosis.causes) {
    if (c.facts.length < 2) problems.push(`${c.code} has fewer than two facts`);
    if (c.facts.length <= c.against.length)
      problems.push(`${c.code} has as many facts against as for`);
    if (!CAUSE_LABELS[c.code]) problems.push(`${c.code} is not a known cause`);
    if (c.facts.some((f) => !f.id || !f.text)) problems.push(`${c.code} has a fact with no text`);
  }
  return problems;
}

// --- 14.05: repairs ---------------------------------------------------------------------------------------------------

/** What a repair may never do for a case (the "SEO-safe" rule): these are not offered, and a test pins that none is. */
export const FORBIDDEN_REPAIRS = Object.freeze([
  'block_crawlers',
  'remove_noindex_handling',
  'change_canonical',
]);

const RULE_REPAIRS = Object.freeze({
  competitor_gain: ['visibility.lost_prompt'],
  lost_citation: ['citation.own_page_uncited', 'citation.gap'],
});

/**
 * The repairs a diagnosis points at. Each is a pointer to something that already exists in the Action Center, so a person
 * approves it the usual way:
 *   `undo`   take back one of our own site changes (`siteChangeId`; the change page's Undo button)
 *   `redo`   a fix that fell off the site, to do again (`recommendationId`)
 *   `rules`  the open recommendations of these rule codes (`ruleCodes`), or of one stable key when `stableKeys` is given
 *   `none`   nothing on your site caused this: we keep watching
 */
export function repairsFor(diagnosis, { regressed = [] } = {}) {
  const out = [];
  for (const cause of diagnosis.causes ?? []) {
    if (cause.code === 'site_change') {
      for (const f of cause.facts.filter(
        (x) => x.id.startsWith('site_change.') && x.data?.siteChangeId,
      )) {
        out.push({
          cause: cause.code,
          kind: 'undo',
          siteChangeId: f.data.siteChangeId,
          text: 'Undo the change we made and watch whether the figure comes back.',
        });
      }
    } else if (cause.code === 'readiness_regression') {
      out.push({
        cause: cause.code,
        kind: 'rules',
        ruleCodes: regressed.slice(0, 5).map((c) => `readiness.${c.code}`),
        text: 'Fix the checks that stopped passing.',
      });
    } else if (cause.code === 'earlier_fix_gone') {
      for (const f of cause.facts.filter((x) => x.id.startsWith('fix.gone.'))) {
        out.push({
          cause: cause.code,
          kind: 'redo',
          recommendationId: f.data.recommendationId,
          text: 'Put the fix back and let us check it again.',
        });
      }
    } else if (RULE_REPAIRS[cause.code]) {
      out.push({
        cause: cause.code,
        kind: 'rules',
        ruleCodes: RULE_REPAIRS[cause.code],
        text: 'Work through the matching actions.',
      });
    } else {
      out.push({
        cause: cause.code,
        kind: 'none',
        text: 'Nothing on your site caused this, so there is nothing to repair. We keep watching and tell you when it recovers.',
      });
    }
  }
  return out.filter(seoSafe);
}

/** A repair is safe when it is a pointer of a known kind that does not ask for anything on the forbidden list. */
export const seoSafe = (repair) =>
  ['undo', 'redo', 'rules', 'none'].includes(repair.kind) &&
  !FORBIDDEN_REPAIRS.some((f) => JSON.stringify(repair).includes(f));

// --- 14.06: closing a case --------------------------------------------------------------------------------------------

/** What happened to the figure and what was done about it, as a plain sentence for the case page. */
export function outcomeSentence(kase) {
  const label = METRICS[kase.metric]?.label ?? 'The figure';
  const scope = kase.engineCode ? ` on ${engineName(kase.engineCode, kase.engineNames)}` : '';
  const b = rate({ n: kase.baseline.n, k: kase.baseline.k });
  const d = rate({ n: kase.decline.n, k: kase.decline.k });
  const r = kase.recent ? rate(kase.recent) : null;
  const start = `${label}${scope} was ${pct(b)} (${plural(kase.baseline.n, 'answer', 'answers')}), fell to ${pct(d)} (${plural(kase.decline.n, 'answer', 'answers')})`;
  return r == null
    ? `${start}.`
    : `${start} and is ${pct(r)} over the last ${RECOVERY.recentDays} days (${plural(kase.recent.n, 'answer', 'answers')}).`;
}

/**
 * Should an open case be closed, and how? System-only.
 *
 * @param {object} input
 * @param {object} input.kase       `{ metric, engineCode, openedAt, baseline: { n, k } }`
 * @param {object[]} input.rows     rollup rows including the latest 14 days
 * @param {string} input.brandId
 * @param {string} input.asOf
 * @param {boolean} input.repaired  a repair for this case was done (a linked fix marked done, or our change undone) since it opened
 * @param {Date} input.now
 * @returns `{ status, recent }` where status is `recovered`, `closed_noise`, `closed_unknown` or null (keep it open), and
 *   `recent` is the counts it looked at. `recovered` needs the latest 14 days back inside the earlier range by the same
 *   significance test; `closed_noise` is the same recovery with nothing done; `closed_unknown` is a case still down after
 *   `unknownAfterDays`. A recent window with too few answers decides nothing: it is never read as a recovery.
 */
export function decideClose({ kase, rows, brandId, asOf, repaired = false, now }) {
  const recent = measure(rows, {
    metric: kase.metric,
    entityId: brandId,
    engineCode: kase.engineCode ?? null,
    window: recentWindow(asOf),
  });
  const counts = { n: recent.n, k: recent.k, window: recent.window };
  if (recent.n >= RECOVERY.minRecentAnswers) {
    const test = compareWindows(
      { n: kase.baseline.n, k: kase.baseline.k },
      { n: recent.n, k: recent.k },
      { minAnswers: RECOVERY.minRecentAnswers },
    );
    const baselineRate = rate(kase.baseline);
    const inside =
      !(test.significant && test.direction === 'down') &&
      recent.rate > baselineRate - RECOVERY.minDropPp / 100;
    if (inside) return { status: repaired ? 'recovered' : 'closed_noise', recent: counts };
  }
  const age = daysBetween(dayString(kase.openedAt), dayString(now));
  if (age >= RECOVERY.unknownAfterDays) return { status: 'closed_unknown', recent: counts };
  return { status: null, recent: counts };
}

/** May a decline that just ended a case open another? Not within the cooldown, so a wobble is not a second case. */
export function inCooldown(closedAt, now) {
  return (
    Boolean(closedAt) &&
    now.getTime() - new Date(closedAt).getTime() < RECOVERY.cooldownDays * DAY_MS
  );
}

// --- Words ----------------------------------------------------------------------------------------------------------

export function caseTitle({ metric, engineCode }, engineNames = {}) {
  const base = {
    mention_rate: 'AI answers name you less often',
    share_of_voice: 'Your share of voice has fallen',
    citation_share: 'Engines cite your site less',
  }[metric];
  return engineCode ? `${base} on ${engineName(engineCode, engineNames)}` : base;
}

/** What the "decline has lasted" alert says (the alert email lays it out). */
export function alertItem(kase, engineNames = {}) {
  const title = caseTitle(kase, engineNames);
  return {
    key: `recovery.${kase.id}`,
    kind: 'recovery',
    tone: 'danger',
    title,
    text: `${outcomeSentence({ ...kase, engineNames })} It has stayed down for more than two weeks, so we opened a recovery case and are looking for the cause.`,
  };
}

// --- Which declines become cases -------------------------------------------------------------------------------------

/**
 * From every lasting decline found, the ones that deserve a case of their own. One underlying fall must not become five
 * cases:
 *   - a decline on one engine is folded into the all-engines decline of the same metric (found now, or already open);
 *   - share of voice is folded into mention rate for the same scope, because it is made of the same counts.
 * Citation share stays separate: engines can stop citing a site without naming the brand less often.
 *
 * @param declines   `findLastingDeclines` results
 * @param openKeys   the open keys of cases already open for the project
 */
export function selectDeclines(declines, openKeys = []) {
  const covered = new Set([...openKeys, ...declines.map((d) => openKey(d.metric, d.engineCode))]);
  return declines.filter((d) => {
    if (d.engineCode && covered.has(openKey(d.metric, null))) return false;
    if (d.metric === 'share_of_voice' && covered.has(openKey('mention_rate', d.engineCode)))
      return false;
    return true;
  });
}

/** A stored case as the `judgeDecline` result it was opened from, so a diagnosis reads the numbers as they were measured. */
export function declineOf(kase) {
  const side = (s) => ({ n: s.n, k: s.k, rate: rate(s), window: [s.start, s.end] });
  const baseline = side(kase.baseline);
  const decline = side(kase.decline);
  return {
    metric: kase.metric,
    engineCode: kase.engineCode ?? null,
    verdict: 'lasting',
    baseline,
    decline,
    recent: { ...kase.recent, rate: rate(kase.recent) },
    deltaPp: Math.round(((decline.rate ?? 0) - (baseline.rate ?? 0)) * 10000) / 100,
    p: kase.p,
  };
}

/** The brand's own citations in a window as the diagnosis wants them: pages summed over engines. `ownPageCitations` rows in. */
export function foldOwnCitations({ ownCitations, pages }) {
  const byUrl = new Map();
  for (const p of pages) byUrl.set(p.url, (byUrl.get(p.url) ?? 0) + Number(p.timesCited));
  return {
    total: Number(ownCitations),
    pages: [...byUrl]
      .map(([url, count]) => ({ url, count }))
      .sort((a, b) => b.count - a.count || a.url.localeCompare(b.url)),
  };
}
