/**
 * Per-organization daily spend cap (MVP §7.8): the circuit breaker on cost.
 *
 * Money is handled in micro-dollars (whole numbers) so adding up thousands of fractions of a cent can't drift
 * the way floating point does. The ledger column is DECIMAL(12,6), which is exactly micro-dollars.
 *
 * The day is the UTC day. Hitting the cap pauses collection until the next UTC midnight; raising the cap, or
 * the day rolling over, resumes it. Pure functions: the worker supplies the numbers and applies the decision.
 */

const MICROS = 1_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** "0.012345" (or 0.012345, or a Prisma Decimal) -> 12345. */
export function toMicros(value) {
  const text = String(value ?? '0').trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) throw new RangeError(`Not an amount of money: ${text}`);
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace('-', '').split('.');
  const micros = Number(whole) * MICROS + Number(fraction.padEnd(6, '0').slice(0, 6));
  return negative ? -micros : micros;
}

/** 12345 -> "0.012345", the form MySQL DECIMAL(12,6) takes. */
export function fromMicros(micros) {
  const negative = micros < 0;
  const abs = Math.abs(Math.round(micros));
  const text = `${Math.floor(abs / MICROS)}.${String(abs % MICROS).padStart(6, '0')}`;
  return negative ? `-${text}` : text;
}

export function utcDayStart(now) {
  return new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
}

/** When today's spend counts as zero again: the next UTC midnight. */
export function nextResetAt(now) {
  return new Date(utcDayStart(now).getTime() + DAY_MS);
}

/**
 * Daily cap by plan, in USD, until an organization has its own (`organizations.spend_cap_usd_daily`).
 *
 * Sized from the margin check in MVP §12.3: a full weekly run costs at most ~$0.12 per prompt, so the largest
 * single day (one whole run, plus a "run now") is Starter 50 prompts ≈ $6, Growth 150 ≈ $18, Agency 500 ≈ $60.
 * The cap is about 2.5x that, high enough that a normal day never trips it, low enough that a retry loop or
 * abuse is stopped within hours rather than after a $5,000 bill. No plan (trial, free audit follow-up) gets the
 * smallest. Staff can set any organization's own cap in the admin console.
 */
export const PLAN_DAILY_CAP_USD = Object.freeze({ starter: 15, growth: 45, agency: 150 });
export const DEFAULT_DAILY_CAP_USD = 15;

/** The cap in force for an organization, in micro-dollars. */
export function dailyCapMicros({ orgCapUsd, planCode }) {
  if (orgCapUsd !== null && orgCapUsd !== undefined) return toMicros(orgCapUsd);
  return toMicros(PLAN_DAILY_CAP_USD[planCode] ?? DEFAULT_DAILY_CAP_USD);
}

/**
 * Decide what to do with an organization's collection, given what it has spent today.
 *
 *   spentMicros    spend since UTC midnight
 *   capMicros      the cap in force
 *   pausedUntil    `organizations.collection_paused_until` (a Date or null)
 *
 * Returns `{ action, until }` where action is:
 *   'pause'  spend reached the cap and collection is not paused yet: pause until `until`
 *   'resume' collection is paused but shouldn't be (the day rolled over, or the cap was raised)
 *   'none'   nothing to change
 */
export function evaluateSpend({ spentMicros, capMicros, pausedUntil, now }) {
  const overCap = spentMicros >= capMicros;
  const paused = pausedUntil instanceof Date && pausedUntil.getTime() > now.getTime();
  if (overCap && !paused) return { action: 'pause', until: nextResetAt(now) };
  if (!overCap && pausedUntil instanceof Date) return { action: 'resume', until: null };
  return { action: 'none', until: pausedUntil ?? null };
}
