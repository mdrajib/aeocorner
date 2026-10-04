import { addonFromLookupKey } from './addons.js';
import { GRACE_DAYS, MONEY_BACK_DAYS, RETAIN_DAYS, addDays } from './entitlements.js';

/**
 * Billing rules that need no database and no network (Milestone 8, tasks 8.02–8.08). Stripe is the source of truth for
 * money; what lives here turns what Stripe says into the rows and sentences we keep.
 */

/** Stripe's subscription status → the `subscriptions.status` enum (identical names). */
const STRIPE_STATUSES = new Set([
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'canceled',
  'paused',
]);

/** Stripe's status → the shorter mirror on the organization row. An unpaid subscription is a lapsed one. */
export function orgBillingStatus(stripeStatus) {
  switch (stripeStatus) {
    case 'trialing':
    case 'active':
    case 'paused':
    case 'canceled':
      return stripeStatus;
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'incomplete_expired':
      return 'canceled';
    default:
      return 'none'; // incomplete: checkout was not finished
  }
}

const seconds = (value) => (Number.isFinite(value) ? new Date(value * 1000) : null);

/** The plan code in a Stripe price: the plan table's price ID first, then our own lookup key. */
function planCodeOf(price, planByPriceId) {
  if (!price) return null;
  if (planByPriceId.has(price.id)) return planByPriceId.get(price.id);
  const match = /^aeo-plan-([a-z0-9_]+)-monthly-\d+$/.exec(price.lookup_key ?? '');
  return match ? match[1] : null;
}

/**
 * Everything we store about one Stripe subscription, from the object Stripe returns. Written to be read twice:
 * the same Stripe object always gives the same result, so replaying an event can't change anything.
 *
 * Newer Stripe API versions keep the billing period on each item rather than on the subscription, so both are read.
 *
 * @param {object} sub              a Stripe subscription (with `items.data`)
 * @param {Map<string,string>} planByPriceId
 * @returns {object|null}  null when the subscription has no plan item we recognise
 */
export function subscriptionFromStripe(sub, planByPriceId = new Map()) {
  if (!sub?.id || !STRIPE_STATUSES.has(sub.status)) return null;
  const items = sub.items?.data ?? [];

  let planCode = null;
  const addons = [];
  for (const item of items) {
    const code = planCodeOf(item.price, planByPriceId);
    if (code && !planCode) {
      planCode = code;
      continue;
    }
    const addon = addonFromLookupKey(item.price?.lookup_key);
    if (addon) addons.push({ code: addon, itemId: item.id, quantity: item.quantity ?? 1 });
  }
  if (!planCode) return null;

  const first = items[0] ?? {};
  return {
    stripeSubscriptionId: sub.id,
    stripeCustomerId: typeof sub.customer === 'string' ? sub.customer : (sub.customer?.id ?? null),
    orgPublicId: sub.metadata?.org_id ?? null,
    planCode,
    status: sub.status,
    orgStatus: orgBillingStatus(sub.status),
    trialEndsAt: seconds(sub.trial_end),
    currentPeriodStart: seconds(sub.current_period_start ?? first.current_period_start),
    currentPeriodEnd: seconds(sub.current_period_end ?? first.current_period_end),
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end || sub.cancel_at),
    canceledAt: seconds(sub.canceled_at ?? sub.ended_at),
    addons,
  };
}

/**
 * The dates that follow from a subscription's new state. `before` is the row we already had (or null):
 * a failed payment starts the grace period once and it is not restarted by a second failure; a recovered one clears it;
 * a cancellation starts the retention window.
 */
export function datesAfter({ status, before = null, now = new Date() }) {
  const out = { graceUntil: before?.graceUntil ?? null, retainUntil: null };
  if (status === 'past_due' || status === 'unpaid') {
    out.graceUntil = before?.graceUntil ?? addDays(now, GRACE_DAYS);
  } else {
    out.graceUntil = null;
  }
  if (status === 'canceled' || status === 'incomplete_expired') {
    out.retainUntil = before?.retainUntil ?? addDays(now, RETAIN_DAYS);
  }
  return out;
}

/**
 * The first real payment starts the money-back window (D9). A $0 invoice (the trial's) does not.
 * @returns {{firstPaidAt, moneyBackUntil}|null} null when this invoice changes nothing
 */
export function firstPayment({ invoice, before }) {
  if (before?.firstPaidAt) return null;
  if (!invoice || !(invoice.amount_paid > 0)) return null;
  const paidAt =
    seconds(invoice.status_transitions?.paid_at) ?? seconds(invoice.created) ?? new Date();
  return { firstPaidAt: paidAt, moneyBackUntil: addDays(paidAt, MONEY_BACK_DAYS) };
}

/** The Stripe subscription ID an invoice belongs to (the field moved between API versions). */
export function invoiceSubscriptionId(invoice) {
  const id =
    invoice?.subscription ??
    invoice?.parent?.subscription_details?.subscription ??
    invoice?.lines?.data?.[0]?.parent?.subscription_item_details?.subscription ??
    null;
  return typeof id === 'string' ? id : (id?.id ?? null);
}

// --- Entitlement grants from add-ons -------------------------------------------------------------------------

/**
 * The grants an add-on item should produce, for the sync to write. A metered add-on grants no amount: its mere
 * presence on the subscription allows drafting past the plan's allowance (see `extraDraftsAllowed`).
 */
export function grantsFromAddons(addons, ADDONS) {
  return addons.map((a) => {
    const def = ADDONS[a.code];
    return {
      meter: def.grants.meter,
      amount: def.grants.amountPerUnit * a.quantity,
      itemId: a.itemId,
      reason: `add-on: ${def.name}`,
      metered: def.kind === 'metered',
    };
  });
}

// --- What the billing screen says ----------------------------------------------------------------------------

const STATUS_COPY = {
  none: { label: 'No plan yet', tone: 'neutral' },
  trialing: { label: 'Free trial', tone: 'info' },
  active: { label: 'Active', tone: 'success' },
  past_due: { label: 'Payment failed', tone: 'warning' },
  paused: { label: 'Paused', tone: 'warning' },
  canceled: { label: 'Cancelled', tone: 'neutral' },
};

const METER_LABELS = {
  projects: ['Projects', 'project', 'projects'],
  prompts: ['Buyer questions', 'question', 'questions'],
  seats: ['Team seats', 'seat', 'seats'],
  drafts: ['Content drafts this month', 'draft', 'drafts'],
  runs_now: ['“Check now” runs this month', 'run', 'runs'],
};

const dateText = (date) =>
  date
    ? new Date(date).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'UTC',
      })
    : null;

export function trialDaysLeft(trialEndsAt, now = new Date()) {
  if (!trialEndsAt) return null;
  const ms = new Date(trialEndsAt).getTime() - now.getTime();
  return ms <= 0 ? 0 : Math.ceil(ms / (24 * 60 * 60 * 1000));
}

/**
 * The whole billing screen as data (UI_DESIGN E3): the plan and its state in words, the usage meters, what the
 * customer can do next, and the banners. Nothing here reaches into a template.
 */
export function billingView({
  billingStatus,
  plan,
  subscription,
  usage,
  limits,
  access,
  plans,
  now = new Date(),
}) {
  const copy = STATUS_COPY[billingStatus] ?? STATUS_COPY.none;
  const days = trialDaysLeft(subscription?.trialEndsAt, now);

  let statusLine = copy.label;
  if (billingStatus === 'trialing' && days !== null) {
    statusLine =
      days === 0 ? 'Trial ends today' : `Trial ends in ${days} day${days === 1 ? '' : 's'}`;
  }

  const lines = [];
  if (billingStatus === 'trialing' && subscription?.trialEndsAt) {
    lines.push(
      `Your card is charged $${Number(plan?.price_usd_month ?? 0).toFixed(0)} on ${dateText(subscription.trialEndsAt)} unless you cancel first.`,
    );
  }
  if (billingStatus === 'active' && subscription?.currentPeriodEnd) {
    lines.push(
      subscription.cancelAtPeriodEnd
        ? `Your plan ends on ${dateText(subscription.currentPeriodEnd)} and won’t renew.`
        : `Renews on ${dateText(subscription.currentPeriodEnd)}.`,
    );
  }
  if (subscription?.moneyBackUntil && new Date(subscription.moneyBackUntil) > now) {
    lines.push(
      `Not what you hoped for? Email us by ${dateText(subscription.moneyBackUntil)} for a full refund of your first month.`,
    );
  }

  const meters = Object.entries(METER_LABELS).flatMap(([meter, [label]]) => {
    const used = usage?.[meter];
    if (used === undefined || used === null) return [];
    const limit = limits?.[meter] ?? null;
    return [
      {
        meter,
        label,
        used,
        limit,
        text: limit === null ? `${used} used` : `${used} of ${limit}`,
        full: limit !== null && used >= limit,
        nearly: limit !== null && limit > 0 && used / limit >= 0.8 && used < limit,
      },
    ];
  });

  const banners = [];
  const message = access ? accessText(access) : null;
  if (message) banners.push({ tone: access.level === 'setup' ? 'info' : 'warning', text: message });
  const full = meters.find((m) => m.full);
  if (full) {
    banners.push({
      tone: 'warning',
      text: `You’ve used all of your plan’s ${METER_LABELS[full.meter][2]}. Upgrade or add more to keep going.`,
    });
  }

  const hasSubscription = billingStatus !== 'none' && billingStatus !== 'canceled';
  const choices = (plans ?? []).map((p) => ({
    code: p.code,
    name: p.name,
    priceText: `$${Number(p.price_usd_month).toFixed(0)}`,
    current: p.code === plan?.code,
    canChoose: Boolean(p.stripe_price_id),
    highlights: planHighlights(p),
  }));

  return {
    planName: plan?.name ?? null,
    statusLabel: copy.label,
    statusTone: copy.tone,
    statusLine,
    lines,
    meters,
    banners,
    choices,
    hasSubscription,
    canManage: hasSubscription,
    ctaLabel: hasSubscription ? 'Change plan' : 'Start your 14-day free trial',
  };
}

/** The sentence the banner says for an access level (null while everything works). */
export function accessText(access) {
  switch (access.level) {
    case 'setup':
      return 'Choose a plan to start your 14-day free trial. Nothing is tracked until you do.';
    case 'grace':
      return 'Your last payment didn’t go through. Update your card to keep tracking without a break.';
    case 'paused':
      return 'Tracking is paused because payment didn’t go through. Your data is kept. Update your card to start again.';
    case 'readonly':
      return 'Your subscription was cancelled. You can still read everything; choose a plan to start again.';
    default:
      return null;
  }
}

/** The few lines a plan card shows. Numbers come from the plan row; a limit that is not set is left out. */
export function planHighlights(plan) {
  const out = [];
  if (plan.max_projects != null)
    out.push(`${plan.max_projects} project${plan.max_projects === 1 ? '' : 's'}`);
  if (plan.max_prompts != null) out.push(`${plan.max_prompts} buyer questions`);
  if (plan.drafts_per_month != null)
    out.push(`${Number(plan.drafts_per_month)} content drafts a month`);
  const f = plan.features ?? {};
  if (f.alerts) out.push('Alerts on drops and negative mentions');
  if (f.csv_export) out.push('CSV export');
  if (f.client_seats) out.push('Client seats');
  return out;
}
