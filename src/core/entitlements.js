/**
 * What an organization may do, from its plan, its add-ons and the state of its subscription (Milestone 8, task 8.07).
 * Pure functions: the database and Stripe are somewhere else. Two separate questions are answered here:
 *
 *   LIMITS   how much (projects, questions, seats, drafts, "run now"): `limitsFor`, `checkLimit`
 *   ACCESS   whether collection may run at all right now: `accessFor`
 *
 * A limit of `null` means "not enforced" (the plan row says NULL). It never means zero.
 */

export const METERS = Object.freeze(['projects', 'prompts', 'seats', 'drafts', 'runs_now']);

/** After a failed payment the customer keeps full use this long, then tracking pauses (CUSTOMER_JOURNEY §Stage 9). */
export const GRACE_DAYS = 7;
/** The first paid month can be refunded within this long (decision D9). */
export const MONEY_BACK_DAYS = 30;
/** A cancelled account stays readable this long, then is deleted (DATABASE_SCHEMA O4, proposed 2026-09-28). */
export const RETAIN_DAYS = 90;
export const TRIAL_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;
export const addDays = (date, days) => new Date(date.getTime() + days * DAY_MS);

const COLUMN = Object.freeze({
  projects: 'max_projects',
  prompts: 'max_prompts',
  seats: 'max_seats',
  drafts: 'drafts_per_month',
  runs_now: 'runs_now_per_month',
});

/** A grant counts while it has started and has not ended. */
export function grantIsActive(grant, now) {
  const starts = grant.starts_at ?? grant.startsAt;
  const ends = grant.ends_at ?? grant.endsAt;
  if (starts && new Date(starts) > now) return false;
  return !ends || new Date(ends) > now;
}

/**
 * The limit for each meter: the plan's number plus every active grant. A plan that does not enforce a meter
 * (`null`) stays unenforced, whatever grants exist: a grant adds to a number, it cannot create one.
 *
 * @param {object|null} plan   a `plans` row (snake_case) or null for an organization with no plan yet
 * @param {object[]} grants    `entitlement_grants` rows
 * @param {Date} now
 * @param {object} [fallback]  limits to use when there is no plan (the placeholders until task 0.17)
 */
export function limitsFor(plan, grants = [], now = new Date(), fallback = {}) {
  const limits = {};
  for (const meter of METERS) {
    const base = plan ? plan[COLUMN[meter]] : (fallback[meter] ?? null);
    if (base === null || base === undefined) {
      limits[meter] = null;
      continue;
    }
    const extra = grants
      .filter((g) => g.meter === meter && grantIsActive(g, now))
      .reduce((sum, g) => sum + Number(g.amount), 0);
    limits[meter] = Number(base) + extra;
  }
  return limits;
}

/**
 * Is one more of something allowed? `used` is what the organization has now, `want` how many it is asking for.
 * Returns `{ allowed, used, limit, left }`; `limit` and `left` are null when the plan does not enforce it.
 */
export function checkLimit({ limit, used, want = 1 }) {
  const usedNow = Number(used) || 0;
  if (limit === null || limit === undefined) {
    return { allowed: true, used: usedNow, limit: null, left: null };
  }
  const left = Math.max(0, limit - usedNow);
  return { allowed: usedNow + want <= limit, used: usedNow, limit, left };
}

/** A plan feature switch (`features.csv_export` and so on). An unknown feature is off. */
export function featureOn(plan, feature) {
  return Boolean(plan?.features?.[feature]);
}

/**
 * What the subscription allows right now. The levels:
 *
 *   full      everything: collection, drafts, publishing, new projects
 *   grace     a payment failed: everything still works, and the screen says to update the card
 *   setup     no subscription yet: set up the project, but nothing that costs money runs
 *   paused    payment lapsed (or the account is paused): data kept and readable, nothing collects
 *   readonly  cancelled, inside the retention window: readable, can be reactivated
 *   ended     cancelled and past the retention window: the purge job will remove it
 *
 * `enforced: false` (no Stripe keys: a laptop, the tests) is always `full`, so nothing is locked before there is a
 * way to pay.
 */
export function accessFor({
  enforced = true,
  billingStatus = 'none',
  graceUntil = null,
  retainUntil = null,
  now = new Date(),
}) {
  if (!enforced) return level('full');
  switch (billingStatus) {
    case 'trialing':
    case 'active':
      return level('full');
    case 'past_due':
      return graceUntil && new Date(graceUntil) > now ? level('grace') : level('paused');
    case 'paused':
      return level('paused');
    case 'canceled':
      return retainUntil && new Date(retainUntil) > now ? level('readonly') : level('ended');
    default:
      return level('setup');
  }
}

const LEVELS = {
  full: { collect: true, edit: true },
  grace: { collect: true, edit: true },
  setup: { collect: false, edit: true },
  paused: { collect: false, edit: true },
  readonly: { collect: false, edit: false },
  ended: { collect: false, edit: false },
};

function level(name) {
  return { level: name, ...LEVELS[name] };
}
