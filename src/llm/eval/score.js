import { normalizeName } from '../names.js';

/**
 * Scoring extraction against the hand-labelled golden set (BUILD_PLAN Phase 6, MVP §10, decision D4). Pure:
 * the eval script (scripts/eval-extraction.js) feeds it the labels and what the pipeline read, and it returns the
 * numbers the targets are checked against.
 *
 * The unit is a pair: one answer × one tracked entity of its project. For every pair the label says whether the
 * answer names that entity and, if it does, its stance and its list rank.
 *
 *   mention   share of pairs where the reading agrees with the label on "is it named" (target ≥ 95%)
 *   stance    of the pairs both call named, the share with the same stance (target ≥ 90%)
 *   rank      of the pairs both call named, the share with the same list rank, "no rank" included (target ≥ 90%)
 * Also reported, with no target: answer type, other brands found (precision and recall), and mention agreement by
 * engine.
 */

export const TARGETS = Object.freeze({ mention: 0.95, stance: 0.9, rank: 0.9 });

/** D4: the cheaper model is accepted only if it meets every target and is at most this far behind on mentions. */
export const D4_MENTION_TOLERANCE = 0.02;

const ratio = (k, n) => (n === 0 ? null : k / n);

/**
 * @param {Array<{ id, engine, labels: { answer_type, tracked: { [key]: { mentioned, list_rank, stance } }, others: [] } }>} golden
 * @param {Map<string, { answerType, tracked: { [key]: { mentioned, listRank, stance } }, others: [] } | null>} predictions
 *   by answer ID; null where the pipeline produced no reading (a failure counts against every pair of that answer)
 */
export function scoreReadings(golden, predictions) {
  const counts = {
    pairs: 0,
    mentionAgree: 0,
    falsePositive: 0,
    falseNegative: 0,
    bothNamed: 0,
    stanceAgree: 0,
    rankAgree: 0,
    answers: 0,
    typeAgree: 0,
    failed: 0,
    othersLabelled: 0,
    othersFound: 0,
    othersRight: 0,
  };
  const byEngine = {};
  const misses = [];

  for (const item of golden) {
    const label = item.labels;
    const predicted = predictions.get(item.id) ?? null;
    counts.answers += 1;
    if (!predicted) counts.failed += 1;
    if (predicted?.answerType === label.answer_type) counts.typeAgree += 1;
    const engine = (byEngine[item.engine] ??= { pairs: 0, agree: 0 });

    for (const [key, truth] of Object.entries(label.tracked)) {
      const guess = predicted?.tracked?.[key] ?? { mentioned: false, listRank: null, stance: null };
      counts.pairs += 1;
      engine.pairs += 1;
      if (Boolean(guess.mentioned) === Boolean(truth.mentioned)) {
        counts.mentionAgree += 1;
        engine.agree += 1;
      } else {
        if (guess.mentioned) counts.falsePositive += 1;
        else counts.falseNegative += 1;
        misses.push({
          id: item.id,
          entity: key,
          field: 'mentioned',
          label: truth.mentioned,
          read: Boolean(guess.mentioned),
        });
      }
      if (truth.mentioned && guess.mentioned) {
        counts.bothNamed += 1;
        if (guess.stance === truth.stance) counts.stanceAgree += 1;
        else
          misses.push({
            id: item.id,
            entity: key,
            field: 'stance',
            label: truth.stance,
            read: guess.stance,
          });
        if ((guess.listRank ?? null) === (truth.list_rank ?? null)) counts.rankAgree += 1;
        else
          misses.push({
            id: item.id,
            entity: key,
            field: 'list_rank',
            label: truth.list_rank,
            read: guess.listRank,
          });
      }
    }

    const labelled = new Set((label.others ?? []).map(normalizeName).filter(Boolean));
    const found = new Set((predicted?.others ?? []).map(normalizeName).filter(Boolean));
    counts.othersLabelled += labelled.size;
    counts.othersFound += found.size;
    for (const name of found) if (matchesAny(name, labelled)) counts.othersRight += 1;
  }

  const othersRecalled = golden.reduce((sum, item) => {
    const found = new Set(
      (predictions.get(item.id)?.others ?? []).map(normalizeName).filter(Boolean),
    );
    return (
      sum +
      (item.labels.others ?? []).map(normalizeName).filter((n) => n && matchesAny(n, found)).length
    );
  }, 0);

  return {
    answers: counts.answers,
    failed: counts.failed,
    pairs: counts.pairs,
    mention: ratio(counts.mentionAgree, counts.pairs),
    falsePositives: counts.falsePositive,
    falseNegatives: counts.falseNegative,
    bothNamed: counts.bothNamed,
    stance: ratio(counts.stanceAgree, counts.bothNamed),
    rank: ratio(counts.rankAgree, counts.bothNamed),
    answerType: ratio(counts.typeAgree, counts.answers),
    othersPrecision: ratio(counts.othersRight, counts.othersFound),
    othersRecall: ratio(othersRecalled, counts.othersLabelled),
    byEngine: Object.fromEntries(
      Object.entries(byEngine).map(([e, v]) => [
        e,
        { pairs: v.pairs, mention: ratio(v.agree, v.pairs) },
      ]),
    ),
    misses,
  };
}

/** "Zoho CRM" matches "Zoho", and "HubSpot" matches "HubSpot CRM": one name contained in the other, as whole words. */
function matchesAny(name, set) {
  if (set.has(name)) return true;
  for (const other of set) {
    if (containsWords(name, other) || containsWords(other, name)) return true;
  }
  return false;
}
const containsWords = (outer, inner) => ` ${outer} `.includes(` ${inner} `);

/** Which targets a score meets. */
export function meetsTargets(score) {
  return {
    mention: score.mention !== null && score.mention >= TARGETS.mention,
    stance: score.stance !== null && score.stance >= TARGETS.stance,
    rank: score.rank !== null && score.rank >= TARGETS.rank,
  };
}

/**
 * The D4 rule (MVP §17): keep the default model unless the cheaper one meets every target and is within
 * D4_MENTION_TOLERANCE of it on mention detection.
 */
export function decideD4(defaultScore, cheaperScore) {
  const met = meetsTargets(cheaperScore);
  const gap = defaultScore.mention - cheaperScore.mention;
  const allMet = met.mention && met.stance && met.rank;
  return {
    switchToCheaper: allMet && gap <= D4_MENTION_TOLERANCE + 1e-9,
    cheaperMeetsTargets: met,
    mentionGap: gap,
  };
}
