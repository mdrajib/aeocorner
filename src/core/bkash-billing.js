import { orgBillingStatus } from './billing.js';
import { GRACE_DAYS, TRIAL_DAYS, addDays } from './entitlements.js';

/**
 * Paying through bKash (ADR-0018). bKash has no subscription engine: a customer pays one month at a time on bKash's
 * payment page, and each completed payment extends the period. Everything that decides an amount, a period or a state
 * is here, pure, so it can be tested without a network or a database.
 *
 * Stripe's subscription is the model we already have, so a bKash subscription is stored in the same rows
 * (`subscriptions.provider = 'bkash'`) and goes through the same `subscriptions.apply`.
 */

export const BKASH_CURRENCY = 'BDT';

/** A reminder email goes out this many days before a period (or the trial) ends. */
export const RENEWAL_REMINDER_DAYS = 5;

/** A plan may be changed to a cheaper one this close to the end of the period; before that the customer waits. */
export const DOWNGRADE_WINDOW_DAYS = 7;

/** How long a lapsed account stays paused (after the grace period) before it is treated as cancelled. */
export const UNPAID_CANCEL_DAYS = 30;

/** A payment page nobody finished is given up on after this many hours. */
export const PAYMENT_EXPIRES_HOURS = 24;

/** The key a bKash subscription has in `subscriptions.stripe_subscription_id` (the column predates bKash). */
export const bkashSubscriptionKey = (orgPublicId) => `bkash-${orgPublicId}`;

/** One month later, on the same day of the month where there is one, else the month's last day (UTC). */
export function addMonths(date, months = 1) {
  const d = new Date(date);
  const day = d.getUTCDate();
  const target = new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth() + months,
      1,
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
      d.getUTCMilliseconds(),
    ),
  );
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target;
}

export { amountString, takaText } from './taka.js';

/** The invoice number we send bKash: ours alone, at most 40 characters, letters and digits and dashes. */
export function invoiceNumber(orgPublicId, now, nonce) {
  return `AEO-${String(orgPublicId).slice(-8)}-${now.getTime().toString(36)}-${nonce}`.slice(0, 40);
}

const priceOf = (plan) => (plan?.price_bdt_month == null ? null : Number(plan.price_bdt_month));

/**
 * What a payment for `plan` costs and what it buys, given the subscription the organization has now.
 *
 *   - Same plan (or a paid-for period that is nearly over, or one that has lapsed): the plan's price for one month,
 *     counted from the end of the period already paid for (paying early loses nothing), or from now if that is past.
 *   - A trial: the first payment is counted from the end of the trial, so no trial days are lost.
 *   - A bigger plan in the middle of a paid period: starts now; the unused part of the old month is taken off.
 *   - A smaller plan in the middle of a paid period: not until the last days of it. We never refund the rest.
 *
 * @returns {{ ok: true, amountBdt: number, periodStart: Date, periodEnd: Date, purpose: 'start'|'renewal'|'change', creditBdt: number }
 *   | { ok: false, reason: 'no_price'|'downgrade_mid_period' }}
 */
export function quotePayment({ plan, subscription = null, currentPlan = null, now = new Date() }) {
  const price = priceOf(plan);
  if (price === null || !(price >= 0)) return { ok: false, reason: 'no_price' };

  const periodEnd = subscription?.currentPeriodEnd ? new Date(subscription.currentPeriodEnd) : null;
  const periodStart = subscription?.currentPeriodStart
    ? new Date(subscription.currentPeriodStart)
    : null;
  const live = Boolean(periodEnd && periodEnd > now);
  const paidPeriod = live && subscription?.status === 'active' && Boolean(subscription.firstPaidAt);
  const samePlan = !subscription || !currentPlan || currentPlan.code === plan.code;

  if (paidPeriod && !samePlan) {
    const oldPrice = priceOf(currentPlan) ?? 0;
    const daysLeft = (periodEnd - now) / 86_400_000;
    if (price <= oldPrice) {
      if (daysLeft > DOWNGRADE_WINDOW_DAYS) return { ok: false, reason: 'downgrade_mid_period' };
      // Close to the end: the smaller plan simply starts when the paid one runs out.
      return month(price, periodEnd, 'renewal');
    }
    const length = periodStart ? periodEnd - periodStart : 30 * 86_400_000;
    const unused = length > 0 ? Math.min(1, Math.max(0, (periodEnd - now) / length)) : 0;
    const credit = Math.floor(oldPrice * unused);
    const amount = Math.max(0, Math.ceil(price - credit));
    return {
      ok: true,
      amountBdt: amount,
      periodStart: now,
      periodEnd: addMonths(now, 1),
      purpose: 'change',
      creditBdt: credit,
    };
  }

  const start = live ? periodEnd : now;
  const purpose = subscription && subscription.status !== 'canceled' ? 'renewal' : 'start';
  return month(price, start, purpose);

  function month(amount, from, why) {
    return {
      ok: true,
      amountBdt: amount,
      periodStart: from,
      periodEnd: addMonths(from, 1),
      purpose: why,
      creditBdt: 0,
    };
  }
}

/** The shape `subscriptions.apply` takes (what `subscriptionFromStripe` returns), for a bKash subscription. */
function parsed({
  orgPublicId,
  planCode,
  status,
  trialEndsAt = null,
  currentPeriodStart,
  currentPeriodEnd,
  cancelAtPeriodEnd = false,
  canceledAt = null,
}) {
  return {
    provider: 'bkash',
    stripeSubscriptionId: bkashSubscriptionKey(orgPublicId),
    stripeCustomerId: null,
    orgPublicId,
    planCode,
    status,
    orgStatus: orgBillingStatus(status),
    trialEndsAt,
    currentPeriodStart,
    currentPeriodEnd,
    cancelAtPeriodEnd,
    canceledAt,
    addons: [],
  };
}

/** The 14-day trial: nothing is paid, nothing is asked of bKash. Once per organization (the caller checks). */
export function trialSubscription({ orgPublicId, planCode, now = new Date() }) {
  const end = addDays(now, TRIAL_DAYS);
  return parsed({
    orgPublicId,
    planCode,
    status: 'trialing',
    trialEndsAt: end,
    currentPeriodStart: now,
    currentPeriodEnd: end,
  });
}

/** The subscription after a payment completed: active, for the period the payment bought. */
export function subscriptionAfterPayment({ orgPublicId, planCode, period, previous = null }) {
  return parsed({
    orgPublicId,
    planCode,
    status: 'active',
    trialEndsAt: previous?.trialEndsAt ?? null,
    currentPeriodStart: period.start,
    currentPeriodEnd: period.end,
  });
}

/** A stored subscription row (camelCase) turned back into what `apply` takes, with some fields changed. */
export function subscriptionFromRow(row, orgPublicId, changes = {}) {
  return parsed({
    orgPublicId,
    planCode: row.planCode,
    status: row.status,
    trialEndsAt: row.trialEndsAt,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    canceledAt: row.canceledAt,
    ...changes,
  });
}

/**
 * What the passing of time does to a bKash subscription (nobody pays by themselves, so nothing renews on its own):
 *   - a trial or paid month that has run out becomes `past_due` (a seven-day grace, then tracking pauses), or `canceled`
 *     if the customer had asked for it to end;
 *   - one that has stayed unpaid for the grace period plus 30 days is cancelled, which starts the read-only window.
 * @returns {'past_due'|'canceled'|null}
 */
export function lapseTransition({ subscription, now = new Date() }) {
  if (!subscription) return null;
  const { status, currentPeriodEnd, cancelAtPeriodEnd, graceUntil } = subscription;
  if ((status === 'trialing' || status === 'active') && currentPeriodEnd) {
    if (new Date(currentPeriodEnd) > now) return null;
    return cancelAtPeriodEnd ? 'canceled' : 'past_due';
  }
  if (status === 'past_due') {
    const limit = graceUntil ? addDays(new Date(graceUntil), UNPAID_CANCEL_DAYS) : null;
    return limit && limit <= now ? 'canceled' : null;
  }
  return null;
}

/** Whether to remind the owners now: the period ends within the reminder window and the customer has not asked to stop. */
export function reminderDue({ subscription, now = new Date() }) {
  if (!subscription || subscription.cancelAtPeriodEnd) return false;
  if (subscription.status !== 'trialing' && subscription.status !== 'active') return false;
  if (!subscription.currentPeriodEnd) return false;
  const end = new Date(subscription.currentPeriodEnd);
  return end > now && end <= addDays(now, RENEWAL_REMINDER_DAYS);
}

/** Days of grace after a lapse, for the screen's wording. */
export const GRACE_TEXT_DAYS = GRACE_DAYS;

/** What a plain-words reason for a refused quote says on the billing screen. */
export const QUOTE_NOTICES = Object.freeze({
  no_price: 'billing-not-ready',
  downgrade_mid_period: 'billing-downgrade-later',
});
