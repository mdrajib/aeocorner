/**
 * ICE scoring for the Action Center (MVP F7, "ICE scoring (v0)"): Impact × Confidence ÷ Effort. Pure, so a ranking can
 * be checked by hand.
 *
 *   impact       0-100. The share of the question × engine grid the fix touches, weighted by each question's priority,
 *                times how severe the problem is (a check that lost 3 of its 8 points is less severe than one that
 *                lost all 8). A crawler block touches every question on every engine; a lost question touches one.
 *   confidence   0-1. The rule's prior (how often this kind of fix has moved visibility), recalibrated from the closed
 *                loop's outcomes as they arrive: `calibratedConfidence` pulls the prior towards the observed win rate,
 *                slowly at first (the prior counts as 10 observations).
 *   effort       1-5. Auto-fixable = 1, content = 3, off-site = 5 (MVP F7); a rule says its own number.
 *   ice          impact × confidence ÷ effort, to three decimals (the column is DECIMAL(8,3)).
 *
 * A bigger number is a better thing to do first. It is a way to put the biggest first, not a forecast.
 */

export const EFFORT_LEVELS = Object.freeze({ min: 1, max: 5 });

/** Words for the effort number, as the screens show it. */
export function effortLabel(effort) {
  if (effort <= 2) return 'Low';
  if (effort <= 3) return 'Medium';
  return 'High';
}

/** How many observations the rule's prior is worth when it is mixed with what we have seen. */
export const PRIOR_WEIGHT = 10;
export const CONFIDENCE_BOUNDS = Object.freeze({ min: 0.05, max: 0.95 });

const round = (n, places) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

const weightOf = (item) => {
  const priority = Number(item.priority ?? 1);
  const engines = Number(item.engines ?? 0);
  if (!(priority >= 0) || !(engines >= 0))
    throw new RangeError('priority and engines must be 0 or more');
  return priority * engines;
};

/**
 * @param affected  what the fix touches: `[{ priority, engines }]`, one per question (engines = how many engines it
 *                  touches that question on)
 * @param universe  everything that is tracked: `[{ priority, engines }]`, one per active question (engines = enabled)
 * @param severity  0-1, how much of the problem there is (default 1)
 * @returns 0-100, three decimals; 0 when nothing is tracked
 */
export function impactScore({ affected, universe, severity = 1 }) {
  if (!(severity >= 0 && severity <= 1)) throw new RangeError('severity must be between 0 and 1');
  const total = universe.reduce((sum, item) => sum + weightOf(item), 0);
  if (total === 0) return 0;
  const touched = affected.reduce((sum, item) => sum + weightOf(item), 0);
  return round(clamp(touched / total, 0, 1) * severity * 100, 3);
}

/**
 * The rule's prior mixed with what the closed loop has shown: `wins` proven wins out of `decided` fixes that reached
 * a verdict (proven win, no change or decline). With no outcomes yet it is the prior.
 */
export function calibratedConfidence(prior, { wins = 0, decided = 0 } = {}) {
  if (!(prior >= 0 && prior <= 1)) throw new RangeError('a prior is a number between 0 and 1');
  if (!Number.isInteger(wins) || !Number.isInteger(decided) || wins < 0 || wins > decided) {
    throw new RangeError('wins and decided must be whole numbers with 0 <= wins <= decided');
  }
  const mixed = (prior * PRIOR_WEIGHT + wins) / (PRIOR_WEIGHT + decided);
  return round(clamp(mixed, CONFIDENCE_BOUNDS.min, CONFIDENCE_BOUNDS.max), 3);
}

/** impact × confidence ÷ effort. */
export function iceScore({ impact, confidence, effort }) {
  if (!Number.isInteger(effort) || effort < EFFORT_LEVELS.min || effort > EFFORT_LEVELS.max) {
    throw new RangeError('effort is a whole number from 1 to 5');
  }
  if (!(impact >= 0) || !(confidence >= 0 && confidence <= 1)) {
    throw new RangeError('impact must be 0 or more and confidence between 0 and 1');
  }
  return round((impact * confidence) / effort, 3);
}
