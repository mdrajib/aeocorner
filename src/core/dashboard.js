import { compareWindows, VERDICT_LABELS, wilsonInterval } from './significance.js';
import { MEASURES, usable, windowsAt } from './trends.js';
import { visibilityOfRows } from './tracking.js';

/**
 * The numbers on the dashboard (MVP F5, §6.5). Pure: daily rollup rows (`metric_daily`, sums only) in, figures and
 * their wording out, so every number on a screen can be checked by hand.
 *
 * Four rules run through all of it:
 *  1. A figure with nothing readable behind it is `unknown` ("Couldn’t check"), never 0. Mention rate over 0
 *     answers is not 0%; it is not known.
 *  2. Rates are sums divided at the last step (Σk / Σn over the window), never an average of daily rates.
 *  3. A change is coloured green or red only if the significance test passed (core/significance.js). The score,
 *     position and sentiment are not proportions, so their change is shown, never coloured.
 *  4. A day on which an engine did not finish cleanly is a gap in that engine's trend line, as in core/trends.js.
 */

/** The ranges the screens offer: a query value, its label and its length in days. */
export const RANGES = Object.freeze({
  '4w': { label: 'Last 4 weeks', days: 28 },
  '8w': { label: 'Last 8 weeks', days: 56 },
  '12w': { label: 'Last 12 weeks', days: 84 },
});
export const DEFAULT_RANGE = '4w';

/** A range key from a query string, falling back to the default for anything else. */
export const rangeKey = (value) => (Object.hasOwn(RANGES, value) ? value : DEFAULT_RANGE);

const day = (value) => String(value).slice(0, 10);
const within = (date, [start, end]) => day(date) >= start && day(date) <= end;
const sum = (rows, pick) => rows.reduce((n, r) => n + Number(pick(r)), 0);
const isBrand = (brandId) => (r) => String(r.entityId) === String(brandId);
const round1 = (n) => Math.round(n * 10) / 10;

const percent = (rate) => (rate == null ? null : Math.round(rate * 100));
const percentLabel = (rate) => (rate == null ? '—' : `${Math.round(rate * 100)}%`);

/** `{ low, high }` as whole percentages, or null when there is nothing to put a range around. */
function band({ k, n }) {
  if (n === 0) return null;
  const { low, high } = wilsonInterval({ k, n });
  return { low: Math.round(low * 100), high: Math.round(high * 100) };
}

const weeksLabel = (days) => `${Math.round(days / 7)} weeks`;

/** What the change of a proportion says: coloured only when it passed the test. */
function proportionChange(kind, { rows, windows, entityId, days, options }) {
  const read = (window) => {
    const found = usable(rows, window, null);
    return MEASURES[kind]({ rows: found, entityId });
  };
  const before = read(windows.before);
  const after = read(windows.after);
  const result = compareWindows(before, after, options);
  const against = `the ${weeksLabel(days)} before`;
  if (result.verdict === 'not_enough_data') {
    return {
      verdict: result.verdict,
      significant: false,
      direction: 'flat',
      text: 'Not enough answers yet to compare',
    };
  }
  if (!result.significant) {
    return {
      verdict: result.verdict,
      significant: false,
      direction: 'flat',
      text: VERDICT_LABELS.within_variation,
    };
  }
  const points = Math.abs(Math.round(result.deltaPp));
  return {
    verdict: result.verdict,
    significant: true,
    direction: result.direction,
    text: `${result.direction === 'up' ? '+' : '−'}${points} points vs ${against}`,
  };
}

/** A change of a figure that is not a proportion: shown, never coloured. */
function plainChange(before, after, { unit, days }) {
  if (before == null || after == null) return null;
  const diff = round1(after - before);
  if (diff === 0)
    return {
      significant: false,
      direction: 'flat',
      text: `Unchanged vs the ${weeksLabel(days)} before`,
    };
  const sign = diff > 0 ? '+' : '−';
  return {
    significant: false,
    direction: 'flat',
    text: `${sign}${Math.abs(diff)} ${unit} vs the ${weeksLabel(days)} before (not tested)`,
  };
}

const UNKNOWN_NOTE = 'No answer could be read in this period.';

/**
 * The headline figures of a project for the last `days` days ending on `asOf`.
 *
 * @param rows     `metric_daily` rows (`metrics.range`), covering both this window and the one before it.
 * @param brandId  the brand entity.
 * @returns `{ windows, hasData, coverage, tiles }`. `tiles` has `visibility`, `mentionRate`, `shareOfVoice`,
 *   `citationShare`, `position`, `sentiment` and `recommendationRate`, each
 *   `{ key, state: 'ok' | 'unknown', value, display, n, k, interval, change, note }`.
 */
export function headline({ rows, brandId, asOf, days = RANGES[DEFAULT_RANGE].days, options }) {
  const windows = windowsAt(asOf, days);
  const after = rows.filter((r) => within(r.metricDate, windows.after));
  const before = rows.filter((r) => within(r.metricDate, windows.before));
  const mine = after.filter(isBrand(brandId));
  const mineBefore = before.filter(isBrand(brandId));
  const hasData = mine.length > 0;

  const answers = sum(mine, (r) => r.nAnswers);
  const cellsTotal = sum(mine, (r) => r.cellsTotal);
  const cellsPartial = sum(mine, (r) => r.cellsPartial);
  const coverage = {
    answers,
    cellsTotal,
    cellsPartial,
    incomplete: cellsPartial > 0,
    // Which engines had a cell that did not finish: the banner names them.
    engines: [...new Set(mine.filter((r) => r.cellsPartial > 0).map((r) => r.engineCode))].sort(),
  };

  const common = { rows, windows, entityId: brandId, days, options };
  const unknown = (key) => ({
    key,
    state: 'unknown',
    value: null,
    display: '—',
    n: 0,
    k: 0,
    interval: null,
    change: null,
    note: UNKNOWN_NOTE,
  });

  // Mention rate: answers that name the brand ÷ answers we could read.
  const mention = { n: sum(mine, (r) => r.nAnswers), k: sum(mine, (r) => r.kMentioned) };
  const mentionRate =
    mention.n === 0
      ? unknown('mentionRate')
      : {
          key: 'mentionRate',
          state: 'ok',
          value: percent(mention.k / mention.n),
          display: percentLabel(mention.k / mention.n),
          ...mention,
          interval: band(mention),
          change: proportionChange('mention_rate_change', common),
          note: `${mention.k} of ${mention.n} answers named the brand`,
        };

  // Share of voice: the brand's mentions ÷ the mentions of everyone we track.
  const sov = MEASURES.sov_change({ rows: after, entityId: brandId });
  const shareOfVoice =
    sov.n === 0
      ? {
          ...unknown('shareOfVoice'),
          note:
            mention.n === 0
              ? UNKNOWN_NOTE
              : 'None of the brands we track was named in these answers.',
          state: mention.n === 0 ? 'unknown' : 'empty',
        }
      : {
          key: 'shareOfVoice',
          state: 'ok',
          value: percent(sov.k / sov.n),
          display: percentLabel(sov.k / sov.n),
          ...sov,
          interval: band(sov),
          change: proportionChange('sov_change', common),
          note: `${sov.k} of ${sov.n} mentions of tracked brands`,
        };

  // Citation share: sources that point at the brand's own domain ÷ all sources cited.
  const cites = MEASURES.citation_share_change({ rows: mine, entityId: brandId });
  const citationShare =
    cites.n === 0
      ? {
          ...unknown('citationShare'),
          state: mention.n === 0 ? 'unknown' : 'empty',
          note: mention.n === 0 ? UNKNOWN_NOTE : 'No sources were cited in these answers.',
        }
      : {
          key: 'citationShare',
          state: 'ok',
          value: percent(cites.k / cites.n),
          display: percentLabel(cites.k / cites.n),
          ...cites,
          interval: band(cites),
          change: proportionChange('citation_share_change', common),
          note: `${cites.k} of ${cites.n} sources cited`,
        };

  // The score (0-100): weighted presence over the questions and engines we could read.
  const score = visibilityOfRows(mine);
  const scoreBefore = visibilityOfRows(mineBefore);
  const visibility =
    score == null
      ? unknown('visibility')
      : {
          key: 'visibility',
          state: 'ok',
          value: score,
          display: String(score),
          n: mention.n,
          k: mention.k,
          interval: null,
          change: plainChange(scoreBefore, score, { unit: 'points', days }),
          note: 'Out of 100. Higher ranks and recommendations score more.',
        };

  const rankN = sum(mine, (r) => r.rankN);
  const position =
    rankN === 0
      ? {
          ...unknown('position'),
          state: mention.n === 0 ? 'unknown' : 'empty',
          note: mention.n === 0 ? UNKNOWN_NOTE : 'The brand was not named in a ranked list.',
        }
      : {
          key: 'position',
          state: 'ok',
          value: round1(sum(mine, (r) => r.rankSum) / rankN),
          display: String(round1(sum(mine, (r) => r.rankSum) / rankN)),
          n: rankN,
          k: rankN,
          interval: null,
          change: (() => {
            const before = sum(mineBefore, (r) => r.rankN);
            if (before === 0) return null;
            return plainChange(
              round1(sum(mineBefore, (r) => r.rankSum) / before),
              round1(sum(mine, (r) => r.rankSum) / rankN),
              { unit: 'places', days },
            );
          })(),
          note: `Average place in lists, over ${rankN} ranked ${rankN === 1 ? 'mention' : 'mentions'}. 1 is best.`,
        };

  const sentN = sum(mine, (r) => r.sentimentN);
  const sentiment =
    sentN === 0
      ? {
          ...unknown('sentiment'),
          state: mention.n === 0 ? 'unknown' : 'empty',
          note:
            mention.n === 0
              ? UNKNOWN_NOTE
              : 'The brand was not named, so there is no tone to read.',
        }
      : (() => {
          const value = round1(sum(mine, (r) => r.sentimentSum) / sentN);
          const beforeN = sum(mineBefore, (r) => r.sentimentN);
          return {
            key: 'sentiment',
            state: 'ok',
            value,
            display: `${value > 0 ? '+' : ''}${value}`,
            n: sentN,
            k: sentN,
            interval: null,
            change:
              beforeN === 0
                ? null
                : plainChange(round1(sum(mineBefore, (r) => r.sentimentSum) / beforeN), value, {
                    unit: 'points',
                    days,
                  }),
            note: 'Tone when named, from −2 (negative) to +2 (positive).',
          };
        })();

  const recommended = { n: mention.k, k: sum(mine, (r) => r.kRecommended) };
  const recommendationRate =
    recommended.n === 0
      ? {
          ...unknown('recommendationRate'),
          state: mention.n === 0 ? 'unknown' : 'empty',
          note: mention.n === 0 ? UNKNOWN_NOTE : 'The brand was not named.',
        }
      : {
          key: 'recommendationRate',
          state: 'ok',
          value: percent(recommended.k / recommended.n),
          display: percentLabel(recommended.k / recommended.n),
          ...recommended,
          interval: band(recommended),
          change: null,
          note: `${recommended.k} of ${recommended.n} mentions were recommendations`,
        };

  return {
    windows,
    hasData,
    coverage,
    tiles: {
      visibility,
      mentionRate,
      shareOfVoice,
      citationShare,
      position,
      sentiment,
      recommendationRate,
    },
  };
}

/**
 * The sentence above the figures when some checks did not finish, or null when every check did. The wording follows
 * UI_DESIGN §7: what is left out, and that it is not counted as "not mentioned".
 */
export function incompleteNotice(coverage, engineNames = {}) {
  if (!coverage?.incomplete) return null;
  const names = coverage.engines.map((code) => engineNames[code] ?? code);
  const which =
    names.length === 0
      ? ''
      : names.length === 1
        ? `${names[0]} data is incomplete. `
        : `${names.slice(0, -1).join(', ')} and ${names.at(-1)} data are incomplete. `;
  return {
    title: 'Some checks are incomplete.',
    text:
      `${which}${coverage.cellsPartial} of ${coverage.cellsTotal} question-and-engine checks did not finish. ` +
      'Their missing answers are left out of the numbers: they are not counted as “not mentioned”.',
  };
}

/**
 * The points of one trend line, oldest first: `{ date, value, low, high, n, gap }`.
 *
 * `measure` is `mentionRate` (with a 95% band), `shareOfVoice` or `visibility`. With an `engineCode` the line is that
 * engine's; without one it is all engines. A day an engine did not finish cleanly, or with no readable answer, is a
 * gap (`value: null`): the line breaks there instead of falling to zero.
 */
export function trendSeries({
  rows,
  brandId,
  from,
  to,
  engineCode = null,
  measure = 'mentionRate',
}) {
  const inRange = rows.filter(
    (r) => within(r.metricDate, [from, to]) && (engineCode == null || r.engineCode === engineCode),
  );
  const dates = [...new Set(inRange.map((r) => day(r.metricDate)))].sort();
  return dates.map((date) => {
    const that = inRange.filter((r) => day(r.metricDate) === date);
    const brand = that.filter(isBrand(brandId));
    const clean = brand.length > 0 && brand.every((r) => Number(r.cellsPartial) === 0);
    const n = sum(brand, (r) => r.nAnswers);
    const gap = { date, value: null, low: null, high: null, n, gap: true };
    if (!clean || n === 0) return gap;
    if (measure === 'visibility') {
      const value = visibilityOfRows(brand);
      return value == null ? gap : { date, value, low: null, high: null, n, gap: false };
    }
    if (measure === 'shareOfVoice') {
      const total = sum(that, (r) => r.kMentioned);
      if (total === 0) return gap;
      const k = sum(brand, (r) => r.kMentioned);
      const b = band({ k, n: total });
      return { date, value: percent(k / total), low: b.low, high: b.high, n: total, gap: false };
    }
    const k = sum(brand, (r) => r.kMentioned);
    const b = band({ k, n });
    return { date, value: percent(k / n), low: b.low, high: b.high, n, gap: false };
  });
}

/**
 * How the brand does on each engine in the window: `{ engineCode, state, display, n, k, interval, incomplete }`.
 *   ok       something was read
 *   unknown  the engine was checked but nothing could be read ("Couldn’t check")
 *   none     the engine has not been checked in this period
 */
export function byEngine({ rows, brandId, engineCodes, asOf, days = RANGES[DEFAULT_RANGE].days }) {
  const windows = windowsAt(asOf, days);
  return engineCodes.map((engineCode) => {
    const mine = rows.filter(
      (r) =>
        isBrand(brandId)(r) && r.engineCode === engineCode && within(r.metricDate, windows.after),
    );
    if (mine.length === 0) {
      return {
        engineCode,
        state: 'none',
        display: '—',
        n: 0,
        k: 0,
        interval: null,
        incomplete: false,
      };
    }
    const n = sum(mine, (r) => r.nAnswers);
    const k = sum(mine, (r) => r.kMentioned);
    const incomplete = mine.some((r) => Number(r.cellsPartial) > 0);
    if (n === 0) {
      return { engineCode, state: 'unknown', display: '—', n, k, interval: null, incomplete };
    }
    return {
      engineCode,
      state: 'ok',
      display: percentLabel(k / n),
      n,
      k,
      interval: band({ k, n }),
      incomplete,
    };
  });
}

/**
 * The brand and its competitors side by side, most-mentioned first: `{ entityId, isBrand, state, n, k, mentionRate,
 * interval, shareOfVoice, position, sentiment, change }`. A competitor's change is coloured only when it passed the test.
 *
 * @param entities  `[{ id, name, kind }]`, the brand and the competitors we track.
 */
export function competitorTable({
  rows,
  entities,
  brandId,
  asOf,
  days = RANGES[DEFAULT_RANGE].days,
  options,
}) {
  const windows = windowsAt(asOf, days);
  const after = rows.filter((r) => within(r.metricDate, windows.after));
  const totalMentions = sum(after, (r) => r.kMentioned);
  const out = entities.map((e) => {
    const mine = after.filter(isBrand(e.id));
    const n = sum(mine, (r) => r.nAnswers);
    const k = sum(mine, (r) => r.kMentioned);
    const rankN = sum(mine, (r) => r.rankN);
    const sentN = sum(mine, (r) => r.sentimentN);
    return {
      entityId: String(e.id),
      name: e.name,
      isBrand: String(e.id) === String(brandId),
      state: mine.length === 0 ? 'none' : n === 0 ? 'unknown' : 'ok',
      n,
      k,
      mentionRate: n === 0 ? null : percent(k / n),
      interval: band({ k, n }),
      shareOfVoice: totalMentions === 0 || mine.length === 0 ? null : percent(k / totalMentions),
      position: rankN === 0 ? null : round1(sum(mine, (r) => r.rankSum) / rankN),
      sentiment: sentN === 0 ? null : round1(sum(mine, (r) => r.sentimentSum) / sentN),
      change:
        n === 0
          ? null
          : proportionChange('mention_rate_change', {
              rows,
              windows,
              entityId: e.id,
              days,
              options,
            }),
    };
  });
  return out.sort(
    (a, b) =>
      (b.shareOfVoice ?? -1) - (a.shareOfVoice ?? -1) ||
      Number(b.isBrand) - Number(a.isBrand) ||
      a.name.localeCompare(b.name),
  );
}

/**
 * Win rate of the brand against one competitor over a set of questions (MVP §6.5): of the questions where either was
 * named, the share where the brand came out ahead.
 *
 * Per question (answers pooled over the window and engines):
 *   brand named, competitor not   → win
 *   competitor named, brand not   → loss
 *   both named, both ranked       → the lower average list place wins (equal: tie)
 *   both named, not both ranked   → more mentions wins (equal: tie)
 *   neither named                 → left out
 *
 * @param cells  `[{ promptId, entityId, k, rankSum, rankN }]` for the brand and the competitor.
 * @returns `{ wins, losses, ties, decided, rate }`; `rate` is a whole percentage or null when nothing was decided.
 */
export function winRate({ cells, brandId, competitorId }) {
  const byPrompt = new Map();
  for (const c of cells) {
    const entry = byPrompt.get(String(c.promptId)) ?? {};
    if (String(c.entityId) === String(brandId)) entry.brand = c;
    else if (String(c.entityId) === String(competitorId)) entry.rival = c;
    byPrompt.set(String(c.promptId), entry);
  }
  let wins = 0;
  let losses = 0;
  let ties = 0;
  for (const { brand, rival } of byPrompt.values()) {
    const b = brand?.k ?? 0;
    const r = rival?.k ?? 0;
    if (b === 0 && r === 0) continue;
    if (r === 0) wins += 1;
    else if (b === 0) losses += 1;
    else if (brand.rankN > 0 && rival.rankN > 0) {
      const diff = brand.rankSum / brand.rankN - rival.rankSum / rival.rankN;
      if (diff < 0) wins += 1;
      else if (diff > 0) losses += 1;
      else ties += 1;
    } else if (b > r) wins += 1;
    else if (b < r) losses += 1;
    else ties += 1;
  }
  const decided = wins + losses + ties;
  return { wins, losses, ties, decided, rate: decided === 0 ? null : percent(wins / decided) };
}

/**
 * What one cell of the question matrix shows. Pure mapping from the stored cell, so a cell that could not be read can
 * only ever be "Couldn’t check":
 *   complete + named in ≥ 1 answer   mentioned          complete + never named   absent
 *   partial  + named in ≥ 1 answer   mentioned          partial  + never named   unknown (the missing answers may have named it)
 *   no_answer                        no_overview        failed / no cell         unknown / none
 *
 * @returns `{ state, status, mentioned, detail }` ready for `ui.resultCell`.
 */
export function matrixCell(cell) {
  if (!cell) return { state: 'none', status: 'none', mentioned: null, detail: 'Not checked yet' };
  const { status, nOk, nPlanned, kMentioned } = cell;
  if (status === 'no_answer')
    return {
      state: 'no_overview',
      status: 'no_overview',
      mentioned: null,
      detail: 'The engine showed no answer',
    };
  if (status === 'failed' || nOk === 0)
    return {
      state: 'unknown',
      status: 'failed',
      mentioned: null,
      detail: `0 of ${nPlanned} answers could be read`,
    };
  const detail = `${kMentioned} of ${nOk} readable answers named the brand${status === 'partial' ? `; ${nPlanned - nOk} could not be checked` : ''}`;
  if (kMentioned > 0) return { state: 'mentioned', status: 'ok', mentioned: true, detail };
  if (status === 'partial') return { state: 'unknown', status: 'failed', mentioned: null, detail };
  return { state: 'absent', status: 'ok', mentioned: false, detail };
}

export const DOMAIN_CLASS_LABELS = Object.freeze({
  unclassified: 'Other',
  review_site: 'Review site',
  ugc: 'Forum or community',
  media: 'News and media',
  reference: 'Reference',
  directory: 'Directory',
  social: 'Social network',
  ecommerce: 'Shop',
  government: 'Government',
  education: 'Education',
  vendor: 'Company site',
  other: 'Other',
});

/**
 * Cited sources as a table, and the gaps among them.
 *
 * @param domains  `[{ domain, class, timesCited, answersCiting, answersWithBrand, own, ownerEntityIds }]`
 * @param total    every citation in the period (the denominator of "share").
 * @returns `{ rows, gaps }`. A gap is a site that AI cites for your questions, that is not yours, in answers that
 *   did not name the brand: where you would need to be listed to be in those answers.
 */
export function citationRows({ domains, total, minAnswers = 2 }) {
  const rows = domains.map((d) => ({
    ...d,
    classLabel: DOMAIN_CLASS_LABELS[d.class] ?? DOMAIN_CLASS_LABELS.other,
    share: total === 0 ? null : percent(d.timesCited / total),
    answersWithoutBrand: d.answersCiting - d.answersWithBrand,
  }));
  const gaps = rows
    .filter((r) => !r.own && r.answersCiting >= minAnswers && r.answersWithoutBrand > 0)
    .sort(
      (a, b) =>
        b.answersWithoutBrand - a.answersWithoutBrand ||
        b.timesCited - a.timesCited ||
        a.domain.localeCompare(b.domain),
    );
  return { rows, gaps };
}

const CHANGE_METRICS = {
  mention_rate_change: () => 'Your mention rate',
  sov_change: () => 'Your share of voice',
  citation_share_change: () => 'Your citation share',
  competitor_surge: (name) => `${name}’s mention rate`,
};

/**
 * A stored change event (`change_events`: only ones that passed the significance test are kept) in words, with the
 * counts behind it, so a green or red number is never unexplained (UI_DESIGN §7).
 *
 * @param event  a `change_events` row: kind, engine_code, value_before/after (0-1), delta_pp, direction, n/k before
 *               and after, after_start/after_end.
 * @param names  `{ entityName }` for a competitor's surge; `engineNames` maps engine codes to labels.
 * @returns `{ tone, title, text, date }`; `tone` is success (up), danger (down) or warning (a competitor rising).
 */
export function describeChange(event, { entityName = 'A competitor', engineNames = {} } = {}) {
  const metric = (CHANGE_METRICS[event.kind] ?? (() => 'A figure'))(entityName);
  const engine = event.engine_code ? (engineNames[event.engine_code] ?? event.engine_code) : null;
  const up = event.direction === 'up';
  const pct = (value) => Math.round(Number(value) * 100);
  const points = Math.abs(Math.round(Number(event.delta_pp)));
  const afterEnd = new Date(event.after_end);
  const days = Math.round((afterEnd - new Date(event.after_start)) / 86_400_000) + 1;
  return {
    tone: event.kind === 'competitor_surge' ? 'warning' : up ? 'success' : 'danger',
    title: `${metric}${engine ? ` on ${engine}` : ''} ${up ? 'rose' : 'fell'} ${points} points`,
    text:
      `From ${pct(event.value_before)}% (${event.k_before} of ${event.n_before} answers) to ` +
      `${pct(event.value_after)}% (${event.k_after} of ${event.n_after}), comparing the last ` +
      `${weeksLabel(days)} with the ${weeksLabel(days)} before. This passed the significance test, ` +
      'so it is unlikely to be chance.',
    date: afterEnd.toISOString().slice(0, 10),
  };
}

/** No finished check in this many days: the screen says when it was last updated instead of showing fresh-looking numbers. */
export const STALE_AFTER_DAYS = 14;

/**
 * The banner for numbers that have not been refreshed in a while (UI_DESIGN §7: "No run in 14+ days"), or null.
 * `finishedAt` is when the newest finished check ended; null means no check has finished, which has its own state.
 */
export function staleNotice(finishedAt, now = new Date()) {
  if (!finishedAt) return null;
  const days = Math.floor((now.getTime() - new Date(finishedAt).getTime()) / 86_400_000);
  if (days < STALE_AFTER_DAYS) return null;
  return {
    title: `These numbers are ${days} days old.`,
    text: 'No check has finished since then, so nothing here is newer. Check the AI checks card on the project’s overview page.',
  };
}
