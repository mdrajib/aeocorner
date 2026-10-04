import { invoiceSubscriptionId, subscriptionFromStripe } from '../core/billing.js';
import { StripeError } from './stripe.js';

/**
 * Bring our copy of one Stripe subscription up to date: ask Stripe for it (Stripe's own advice is to fetch the current
 * object rather than trust the order events arrive in), turn it into our rows and write them. Used by the webhook
 * and by the daily reconcile, so both do exactly the same thing.
 *
 * @returns {{ applied: boolean, reason?: string, ... }}
 */
export async function syncSubscription({
  db,
  stripe,
  subscriptionId,
  invoice = null,
  fallback = null,
  now,
}) {
  let sub;
  try {
    sub = await stripe.subscriptions.retrieve(subscriptionId);
  } catch (err) {
    // A subscription Stripe no longer has: the event's own copy is all there is.
    if (err instanceof StripeError && err.status === 404 && fallback) sub = fallback;
    else throw err;
  }
  const parsed = subscriptionFromStripe(sub, await db.system.billing.plans.priceMap());
  if (!parsed) return { applied: false, reason: 'not_a_plan_subscription' };
  return db.system.billing.subscriptions.apply({ parsed, invoice, now });
}

/** What each event type we subscribe to means for a subscription. Anything else is ignored. */
export const STRIPE_EVENTS = Object.freeze([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
]);

/**
 * Apply one verified Stripe event. Returns `'processed'` or `'ignored'`; throws when Stripe could not be asked or
 * the database failed, so the delivery is marked failed and Stripe sends it again.
 */
export async function handleStripeEvent({ db, stripe, event, now }) {
  const object = event?.data?.object;
  switch (event?.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const result = await syncSubscription({
        db,
        stripe,
        subscriptionId: object.id,
        fallback: object,
        now,
      });
      return result.applied ? 'processed' : 'ignored';
    }
    case 'checkout.session.completed': {
      const id =
        typeof object.subscription === 'string' ? object.subscription : object.subscription?.id;
      if (object.mode !== 'subscription' || !id) return 'ignored';
      const result = await syncSubscription({ db, stripe, subscriptionId: id, now });
      return result.applied ? 'processed' : 'ignored';
    }
    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const id = invoiceSubscriptionId(object);
      if (!id) return 'ignored';
      const result = await syncSubscription({
        db,
        stripe,
        subscriptionId: id,
        invoice: object,
        now,
      });
      return result.applied ? 'processed' : 'ignored';
    }
    default:
      return 'ignored';
  }
}
