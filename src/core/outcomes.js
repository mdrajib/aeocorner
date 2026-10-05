import { compareWindows, SIGNIFICANCE } from './significance.js';

/**
 * Did a fix move visibility? (MVP F7 "Closed loop", CUSTOMER_JOURNEY Stage 8.) Pure: counts in, a verdict and the words
 * for it out.
 *
 * When a fix is marked done we save a BASELINE: for the questions it targets, how many readable answers there were
 * over the 28 days up to that moment (`n`) and how many named the brand (`k`). At +2 and +4 weeks we count the same
 * thing for the days after, and compare the two with the significance test every other change on the product uses
 * (core/significance.js: p < 0.05, at least 5 points, at least 20 answers in each window). Only "complete" cells count,
 * on both sides: a half-collected cell might have named the brand, so counting it would invent a change.
 *
 *   proven_win         significantly up
 *   declined           significantly down
 *   no_change          within normal variation
 *   insufficient_data  too few readable answers on one side: said so, never shown as "no change"
 *
 * The +2 week check can only close a recommendation by a win or a decline; "no change" and "not enough data" wait for the
 * +4 week check, because answers often take 2-6 weeks to move. After +4 weeks the recommendation ends as `no_change`
 * (the screen says "not enough data" when that is the case: the outcome row keeps the real verdict).
 */

export const HORIZONS = Object.freeze({
  week_2: { days: 14, label: '2 weeks' },
  week_4: { days: 28, label: '4 weeks' },
});
export const HORIZON_KEYS = Object.freeze(Object.keys(HORIZONS));
export const BASELINE_DAYS = 28;

const DAY_MS = 86_400_000;
const at = (value) => new Date(value);

/**
 * A window is the runs QUEUED after `from` (exclusive) up to and including `to`. It is by the moment, not the day: a
 * project's first run and its first fix often happen on the same day, and the run before the fix is the baseline.
 */

/** The 28 days up to the moment the fix was marked done. */
export function baselineWindow(doneAt, days = BASELINE_DAYS) {
  const to = at(doneAt);
  return { from: new Date(to.getTime() - days * DAY_MS), to };
}

/** The runs queued after measuring started, up to `days` later (14 for the +2 week check, 28 for +4). */
export function afterWindow(startedAt, horizon) {
  const def = HORIZONS[horizon];
  if (!def) throw new RangeError(`Unknown horizon: ${horizon}`);
  const from = at(startedAt);
  return { from, to: new Date(from.getTime() + def.days * DAY_MS) };
}

/** A check is due once its whole window is in the past. */
export function horizonDue(startedAt, horizon, now) {
  return at(now).getTime() >= afterWindow(startedAt, horizon).to.getTime();
}

/** The UTC days a window touches, for a date-range query (`run_date` is in the fact tables' keys): `[from, to]`. */
export function dayBounds({ from, to }) {
  return [from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)];
}

const inWindow = (queuedAt, { from, to }) => {
  const t = at(queuedAt).getTime();
  return t > from.getTime() && t <= to.getTime();
};

/**
 * Add up the cells of a window for the targeted questions.
 *
 * @param cells       `[{ promptId, runId, queuedAt, status, nOk, brandK }]`: one per question × engine × run
 * @param promptIds   the targeted questions (strings)
 * @param window      `{ from, to }` from `baselineWindow` or `afterWindow`
 * @returns `{ n, k, runIds, perPrompt: [{ promptId, n, k }], partialCells }`: only complete cells are counted; the
 *          number left out is reported so the screen can say so
 */
export function countWindow({ cells, promptIds, window }) {
  const wanted = new Set(promptIds.map(String));
  let n = 0;
  let k = 0;
  let partialCells = 0;
  const runIds = new Set();
  const per = new Map();
  for (const cell of cells) {
    if (!wanted.has(String(cell.promptId)) || !inWindow(cell.queuedAt, window)) continue;
    if (cell.status !== 'complete') {
      partialCells += 1;
      continue;
    }
    n += Number(cell.nOk);
    k += Number(cell.brandK);
    runIds.add(String(cell.runId));
    const row = per.get(String(cell.promptId)) ?? { promptId: String(cell.promptId), n: 0, k: 0 };
    row.n += Number(cell.nOk);
    row.k += Number(cell.brandK);
    per.set(row.promptId, row);
  }
  return {
    n,
    k,
    runIds: [...runIds].sort((a, b) => Number(a) - Number(b)),
    perPrompt: [...per.values()].sort((a, b) => Number(a.promptId) - Number(b.promptId)),
    partialCells,
  };
}

const VERDICTS = Object.freeze({
  significant_up: 'proven_win',
  significant_down: 'declined',
  within_variation: 'no_change',
  not_enough_data: 'insufficient_data',
});

/**
 * Compare the baseline with a window after.
 * @returns `{ verdict, rateBefore, rateAfter, deltaPp, p, significant }`; rates are 0-1 or null when a side has no answers
 */
export function measureOutcome({ baseline, after }, options = {}) {
  const result = compareWindows(
    { n: baseline.n, k: baseline.k },
    { n: after.n, k: after.k },
    options,
  );
  return {
    verdict: VERDICTS[result.verdict],
    rateBefore: result.valueBefore,
    rateAfter: result.valueAfter,
    deltaPp: result.deltaPp,
    p: result.p,
    significant: result.significant,
  };
}

/**
 * What a check at this horizon does to the recommendation: its new status, or null to keep measuring.
 */
export function statusAfterOutcome(verdict, horizon) {
  if (verdict === 'proven_win') return 'proven_win';
  if (verdict === 'declined') return 'declined';
  return horizon === 'week_4' ? 'no_change' : null;
}

/** The first horizon still without an outcome and due, or null. `have` is the horizons already computed. */
export function nextDueHorizon({ startedAt, have, now }) {
  for (const horizon of HORIZON_KEYS) {
    if (have.includes(horizon)) continue;
    return horizonDue(startedAt, horizon, now) ? horizon : null;
  }
  return null;
}

export const longDate = (value) =>
  new Date(value).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * The figure an outcome measured (Milestone 13). `mention_rate` is every fix that is not a citation fix: k answers named
 * the brand out of n readable. `citation_share` is a citation fix: k of the n sources cited in those answers were the
 * brand's own site. Both go through the same test; only the words differ.
 */
export const METRICS = Object.freeze(['mention_rate', 'citation_share']);
export const isCitationShare = (outcome) => outcome?.metric === 'citation_share';

/** "from 3 of 40 to 12 of 45 answers", or for a citation fix "went from 3 of 40 cited sources to 12 of 45". */
export function changePhrase(outcome, { brandName, scope }) {
  if (isCitationShare(outcome)) {
    return `${scope}, ${brandName}’s own site went from ${outcome.kBefore} of ${outcome.nBefore} cited sources to ${outcome.kAfter} of ${outcome.nAfter}`;
  }
  return `${brandName} was named ${scope} from ${outcome.kBefore} of ${outcome.nBefore} to ${outcome.kAfter} of ${outcome.nAfter} answers`;
}

/**
 * The proof card's sentence (UI D4), from an outcome row. No figure appears that is not in the row; a result that did
 * not pass the test says so in plain words and never in the colours of a win.
 *
 * @param outcome  `{ horizon, verdict, kBefore, nBefore, kAfter, nAfter }`
 * @param context  `{ title, startedAt, questions, brandName }`
 */
export function proofSentence(outcome, { title, startedAt, questions, brandName }) {
  const since = `Since you marked “${title}” done on ${longDate(startedAt)}`;
  const scope = `on the ${plural(questions, 'question', 'questions')} it targets`;
  const counts = isCitationShare(outcome)
    ? `from ${outcome.kBefore} of ${outcome.nBefore} cited sources to ${outcome.kAfter} of ${outcome.nAfter}`
    : `from ${outcome.kBefore} of ${outcome.nBefore} to ${outcome.kAfter} of ${outcome.nAfter} answers`;
  const change = changePhrase(outcome, { brandName, scope });
  switch (outcome.verdict) {
    case 'proven_win':
      return `${since}, ${change}. That is bigger than normal variation.`;
    case 'declined':
      return `${since}, ${change}. That drop is bigger than normal variation, so the fix may not have helped.`;
    case 'no_change':
      return outcome.horizon === 'week_4'
        ? isCitationShare(outcome)
          ? `Four weeks on, on the questions it targets, ${brandName}’s own site is ${outcome.kAfter} of ${outcome.nAfter} cited sources (it was ${outcome.kBefore} of ${outcome.nBefore}). That is within normal variation: this fix has not shown an effect yet.`
          : `Four weeks on, ${brandName} is being named ${scope} ${counts}. That is within normal variation: this fix has not shown an effect yet.`
        : `Within normal variation so far (${counts}). AI answers often take 2–6 weeks to change, so we check again at 4 weeks.`;
    default:
      return `We do not have enough readable answers yet to tell. We need at least ${SIGNIFICANCE.minAnswers} before and after, and have ${outcome.nBefore} and ${outcome.nAfter}.`;
  }
}
