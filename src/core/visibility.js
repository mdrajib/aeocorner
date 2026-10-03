/**
 * The free audit's scores (MVP §6.5 "AI Visibility Score (v0)" and §6.6 "Audit AEO Score"). Pure: answers in, numbers
 * out, so every figure on the report can be checked by hand.
 *
 *   s(p,e) = how well the brand showed up in engine e's answer to question p (0 to 1, table below)
 *   VS     = 100 × Σ w_p·w_e·s(p,e) / Σ w_p·w_e          over the answers we could read
 *   AEO    = 0.6 × readiness + 0.4 × VS
 *
 * An answer we could not read (`failed`, `pending`) is NOT "not mentioned": it leaves both sums, like a readiness
 * check that errored (CLAUDE.md). An engine that said it had no answer (`no_answer`: no AI Overview was shown) is a
 * real result of its own and is also left out, since it says nothing about the brand. With fewer than half of the
 * answers readable the visibility score is null ("couldn't check"), never a low number, and so is the AEO Score.
 */

export const VISIBILITY_VERSION = 'v0.1';

/** The share of the questions × engines that must be readable before a visibility score is worth showing. */
export const MIN_READABLE_SHARE = 0.5;

export const AEO_WEIGHTS = Object.freeze({ readiness: 0.6, visibility: 0.4 });

/** Rank 1 or the only recommendation = 1; rank 2 = 0.85; rank 3 = 0.7; rank 4+ or a non-list mention = 0.5. */
const RANK_SCORE = [1, 0.85, 0.7];
const MENTIONED_UNRANKED = 0.5;
const CITED_NOT_NAMED = 0.25;
const CAUTIONED = new Set(['cautioned', 'not_recommended']);

const round = (n) => Math.round(n);
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * How well the brand showed up in one readable answer, 0 to 1. `brandPresent` true means named; a domain that is
 * cited while the brand is not named is worth a little.
 */
export function presenceValue({
  brandPresent,
  brandRank = null,
  brandStance = null,
  domainCited = false,
}) {
  if (!brandPresent) return domainCited ? CITED_NOT_NAMED : 0;
  const base =
    Number.isInteger(brandRank) && brandRank >= 1
      ? (RANK_SCORE[brandRank - 1] ?? MENTIONED_UNRANKED)
      : MENTIONED_UNRANKED;
  return CAUTIONED.has(brandStance) ? base * 0.5 : base;
}

const readable = (a) => a.status === 'ok' && typeof a.brandPresent === 'boolean';

/**
 * The visibility score and what it is made of.
 *
 * @param answers `{ promptIdx, engineCode, status, brandPresent, brandRank?, brandStance?, domainCited?, priority? }`
 *   one per question and engine. `priority` is the question's weight (1-3, default 1).
 * @param options `{ engineWeights }` an engine's weight by code (default 1 for every engine).
 * @returns `{ score, perEngine, cells, readable, unreadable, noAnswer, mentioned }`; `score` is a whole number
 *   0-100 or null.
 */
export function scoreVisibility(answers, { engineWeights = {} } = {}) {
  const used = answers.filter(readable);
  const noAnswer = answers.filter((a) => a.status === 'no_answer').length;
  const unreadable = answers.length - used.length - noAnswer;
  // What the share is of: every answer the engine could have given, so a no_answer is neither readable nor lost.
  const asked = answers.length - noAnswer;

  const weight = (a) => (a.priority ?? 1) * (engineWeights[a.engineCode] ?? 1);
  const tally = (list) => {
    let top = 0;
    let bottom = 0;
    for (const a of list) {
      top += weight(a) * presenceValue(a);
      bottom += weight(a);
    }
    return bottom > 0 ? (100 * top) / bottom : null;
  };

  const perEngine = {};
  for (const code of [...new Set(answers.map((a) => a.engineCode))].sort()) {
    const mine = answers.filter((a) => a.engineCode === code);
    const mineUsed = mine.filter(readable);
    const value = tally(mineUsed);
    perEngine[code] = {
      score: value === null ? null : round(value),
      asked: mine.length,
      readable: mineUsed.length,
      mentioned: mineUsed.filter((a) => a.brandPresent).length,
    };
  }

  const enough = asked > 0 && used.length / asked >= MIN_READABLE_SHARE;
  const value = enough ? tally(used) : null;
  return {
    score: value === null ? null : round(value),
    perEngine,
    cells: answers.length,
    readable: used.length,
    unreadable,
    noAnswer,
    mentioned: used.filter((a) => a.brandPresent).length,
    coverage: asked > 0 ? round2(used.length / asked) : 0,
  };
}

/** The audit's single number. Null when either part could not be worked out: the sub-scores are shown separately. */
export function aeoScore({ readiness, visibility }) {
  if (!Number.isFinite(readiness) || !Number.isFinite(visibility)) return null;
  return round(AEO_WEIGHTS.readiness * readiness + AEO_WEIGHTS.visibility * visibility);
}
