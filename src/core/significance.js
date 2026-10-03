/**
 * Is a change real, or is it normal variation? (MVP §6.3.) Pure: counts in, a verdict out.
 *
 * A rate here is always `k` of `n`: k answers that named the brand out of n answers we could read. A change is
 * called significant only when BOTH hold:
 *
 *   - a two-proportion z-test gives p < 0.05, and
 *   - the change is at least 5 percentage points.
 *
 * Anything else is "within normal variation". A window with too few answers is "not enough data", which is a
 * different thing from "no change": the screen must say so rather than showing a flat line. Failed and partial
 * collections never reach this code as zeros: the caller leaves them out of both n and k (see core/tracking.js).
 */

export const SIGNIFICANCE = Object.freeze({
  alpha: 0.05,
  minDeltaPp: 5,
  /** Answers needed in EACH window before a comparison means anything (the z-test's normal approximation). */
  minAnswers: 20,
  z95: 1.959964,
});

/** The standard normal CDF, Φ(x). Chebyshev fit to erfc (Numerical Recipes 6.2), relative error below 1.2e-7. */
export function normalCdf(x) {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * z);
  const erfc =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  // erfc(z) for z >= 0; Φ(x) = 1 - erfc(x/√2)/2 for x >= 0 and erfc(|x|/√2)/2 for x < 0.
  return x >= 0 ? 1 - erfc / 2 : erfc / 2;
}

const isCount = (n) => Number.isInteger(n) && n >= 0;

function checkCounts(name, { n, k }) {
  if (!isCount(n) || !isCount(k) || k > n) {
    throw new RangeError(`${name} needs whole numbers with 0 <= k <= n (got k=${k}, n=${n})`);
  }
}

/**
 * The Wilson 95% interval for k of n: better behaved than the textbook interval at small n and at rates near 0 or 1,
 * which is where a young project lives. `null` bounds for n = 0: there is nothing to show a band for.
 */
export function wilsonInterval({ k, n }, z = SIGNIFICANCE.z95) {
  checkCounts('wilsonInterval', { k, n });
  if (n === 0) return { rate: null, low: null, high: null };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { rate: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/**
 * Two-sided two-proportion z-test with a pooled estimate. Returns `{ z, p }`; `z` is positive when the second
 * sample's rate is higher. Identical rates, or both windows all-or-nothing, give z = 0 and p = 1.
 */
export function twoProportionZ(before, after) {
  checkCounts('twoProportionZ before', before);
  checkCounts('twoProportionZ after', after);
  if (before.n === 0 || after.n === 0) return { z: 0, p: 1 };
  const pooled = (before.k + after.k) / (before.n + after.n);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / before.n + 1 / after.n));
  if (se === 0) return { z: 0, p: 1 };
  const z = (after.k / after.n - before.k / before.n) / se;
  return { z, p: Math.min(1, 2 * (1 - normalCdf(Math.abs(z)))) };
}

/**
 * Compare a window with the one before it.
 *
 * @returns `{ verdict, significant, direction, valueBefore, valueAfter, deltaPp, p }` where verdict is
 *   `not_enough_data`, `within_variation`, `significant_up` or `significant_down`.
 */
export function compareWindows(before, after, options = {}) {
  const { alpha, minDeltaPp, minAnswers } = { ...SIGNIFICANCE, ...options };
  checkCounts('compareWindows before', before);
  checkCounts('compareWindows after', after);
  const valueBefore = before.n > 0 ? before.k / before.n : null;
  const valueAfter = after.n > 0 ? after.k / after.n : null;
  if (before.n < minAnswers || after.n < minAnswers) {
    return {
      verdict: 'not_enough_data',
      significant: false,
      direction: null,
      valueBefore,
      valueAfter,
      deltaPp: null,
      p: null,
    };
  }
  const deltaPp = Math.round((valueAfter - valueBefore) * 10000) / 100;
  const { p } = twoProportionZ(before, after);
  const significant = p < alpha && Math.abs(deltaPp) >= minDeltaPp;
  const direction = deltaPp > 0 ? 'up' : deltaPp < 0 ? 'down' : null;
  return {
    verdict: significant ? `significant_${direction}` : 'within_variation',
    significant,
    direction: significant ? direction : null,
    valueBefore,
    valueAfter,
    deltaPp,
    p,
  };
}

/** What a screen says about a verdict. */
export const VERDICT_LABELS = Object.freeze({
  not_enough_data: 'Not enough data yet',
  within_variation: 'Within normal variation',
  significant_up: 'Significantly up',
  significant_down: 'Significantly down',
});
