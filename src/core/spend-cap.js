import { DEFAULT_DAILY_CAP_USD, PLAN_DAILY_CAP_USD, dailyCapMicros } from './spend.js';

/**
 * Changing an organization's daily spend cap from the staff console (Milestone 10; ADMIN_OPERATIONS module 5). Pure: what a
 * typed value means, and how a row on the screen reads. The cap itself is enforced by `evaluateSpend` (spend.js).
 */

/** Below this a normal day would trip the cap; above it the cap no longer protects anything. In whole dollars. */
export const MIN_CAP_USD = 1;
export const MAX_CAP_USD = 10_000;

/**
 * What staff typed into the cap box.
 *   ''  (or 'default')  take the organization's own cap away: it follows its plan again   → { ok, capUsd: null }
 *   '25' / '25.5'       a cap in dollars, at most two decimals, within the limits        → { ok, capUsd: '25.50' }
 * Anything else (a minus sign, a comma, three decimals, a number outside the limits) is refused with a reason that can be shown.
 */
export function parseCap(input) {
  const text = typeof input === 'string' ? input.trim().replace(/^\$/, '') : '';
  if (text === '' || text.toLowerCase() === 'default') return { ok: true, capUsd: null };
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(text)) {
    return { ok: false, reason: 'Enter dollars with at most two decimals, like 25 or 25.50.' };
  }
  const value = Number(text);
  if (value < MIN_CAP_USD || value > MAX_CAP_USD) {
    return {
      ok: false,
      reason: `A cap must be between $${MIN_CAP_USD} and $${MAX_CAP_USD.toLocaleString('en-US')} a day.`,
    };
  }
  return { ok: true, capUsd: value.toFixed(2) };
}

const dollars = (micros) => `$${(micros / 1_000_000).toFixed(2)}`;

/** The plan's cap in dollars, the one an organization follows until it has its own. */
export const planCapUsd = (planCode) => PLAN_DAILY_CAP_USD[planCode] ?? DEFAULT_DAILY_CAP_USD;

/**
 * One organization as the screen shows it: the cap in force and where it comes from, today's spend against it, and
 * whether collection is paused. `percent` is capped at 100 for display and null when the cap is zero.
 */
export function capRow({ orgCapUsd, planCode, spentMicros, pausedUntil, now }) {
  const capMicros = dailyCapMicros({ orgCapUsd, planCode });
  const paused = Boolean(pausedUntil && pausedUntil.getTime() > now.getTime());
  const percent = capMicros > 0 ? Math.min(100, Math.round((spentMicros / capMicros) * 100)) : null;
  let state = 'ok';
  if (paused) state = 'paused';
  else if (percent !== null && percent >= 80) state = 'near';
  return {
    capText: dollars(capMicros),
    capSource: orgCapUsd === null || orgCapUsd === undefined ? 'plan' : 'own',
    spentText: dollars(spentMicros),
    percent,
    state,
    paused,
    resumesAt: paused ? pausedUntil : null,
    capInput: orgCapUsd === null || orgCapUsd === undefined ? '' : String(orgCapUsd),
    spentMicros,
  };
}

/** Most urgent first: paused, then closest to the cap, then the biggest spender. */
export function byUrgency(rows) {
  const rank = { paused: 0, near: 1, ok: 2 };
  return [...rows].sort(
    (a, b) =>
      rank[a.state] - rank[b.state] ||
      (b.percent ?? 0) - (a.percent ?? 0) ||
      b.spentMicros - a.spentMicros,
  );
}
