import { ADDONS, ADDON_CODES } from '../../core/addons.js';
import { billingView, subscriptionFromStripe } from '../../core/billing.js';
import { TRIAL_DAYS } from '../../core/entitlements.js';
import { addonPriceId } from '../../integrations/stripe-catalog.js';
import { StripeError } from '../../integrations/stripe.js';
import { syncSubscription } from '../../integrations/stripe-sync.js';
import { bkashRoutes, bkashScreen } from './org-billing-bkash.js';

/**
 * Plan, trial and billing (Milestone 8, tasks 8.02, 8.05 and 8.08; wireframe E3). Registered on the organization router.
 * Money stays in Stripe: we send the customer to Stripe's own pages to enter a card (Checkout) and to manage it (the
 * Customer Portal), and show what comes back. Owners only (`billing.manage`).
 *
 * Nothing here decides what a plan allows: that is `src/core/entitlements.js`. Nothing here trusts the return trip from
 * Stripe: after Checkout we ask Stripe what the customer's subscriptions are and store that, the same as the webhook.
 */

const PAYING = new Set(['trialing', 'active', 'past_due']);
const planCodeOk = (v) => typeof v === 'string' && /^[a-z0-9_]{1,32}$/.test(v);

export function billingRoutes(org, { auth, appPage, billing, config, db, logger }) {
  const owner = auth.requirePermission('billing.manage');
  const stripe = billing?.stripe ?? null;
  // bKash takes over the plan screen when it is configured; Stripe's own routes keep working for a Stripe customer.
  const payWith = billing?.bkash ? 'bkash' : stripe ? 'stripe' : null;
  const base = (res) => `${res.locals.orgBase}/billing`;
  const back = (res, notice) => res.redirect(303, `${base(res)}?notice=${notice}`);

  /** Ask Stripe for the customer's subscriptions and store them. Never throws: the page shows what we have. */
  async function refreshFromStripe(customerId) {
    if (!stripe || !customerId) return;
    try {
      const list = await stripe.subscriptions.list({ customer: customerId });
      for (const sub of list.data ?? []) {
        await syncSubscription({
          db,
          stripe,
          subscriptionId: sub.id,
          fallback: sub,
          now: new Date(),
        });
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'Could not refresh the subscription from Stripe');
    }
  }

  bkashRoutes(org, { auth, billing, config, db, logger });

  org.get('/billing', owner, async (req, res, next) => {
    try {
      const justStarted = req.query.notice === 'billing-started';
      if (justStarted) {
        const before = await req.orgDb.billing.summary({ enforced: config.billingEnforced });
        await refreshFromStripe(before.stripeCustomerId);
      }
      const [summary, usage, plans, addons] = await Promise.all([
        req.orgDb.billing.summary({ enforced: config.billingEnforced }),
        req.orgDb.billing.usage(),
        db.reference.plans.list(),
        req.orgDb.billing.addons(),
      ]);
      const view = billingView({
        billingStatus: summary.billingStatus,
        plan: summary.plan,
        subscription: summary.subscription,
        usage,
        limits: summary.limits,
        access: summary.access,
        plans,
        claudeUntil: summary.claudeUntil,
        provider: payWith === 'bkash' ? 'bkash' : 'stripe',
      });
      const bkash =
        payWith === 'bkash'
          ? bkashScreen({
              view,
              plans,
              summary,
              payments: await req.orgDb.bkash.recent(),
              now: new Date(),
            })
          : null;
      if (bkash) view.choices = bkash.choices;
      appPage(res, 'billing', {
        view,
        provider: payWith === 'bkash' ? 'bkash' : 'stripe',
        bkash,
        addons: ADDON_CODES.map((code) => ({
          code,
          name: ADDONS[code].name,
          description: ADDONS[code].description,
          priceText:
            ADDONS[code].kind === 'metered'
              ? `$${ADDONS[code].priceUsdPerUnit} each`
              : `$${ADDONS[code].priceUsdMonth} a month`,
          on: addons.filter((a) => a.reason?.includes(ADDONS[code].name)),
          quantity: ADDONS[code].kind === 'licensed',
        })),
        trialDays: TRIAL_DAYS,
        configured: Boolean(payWith),
        hasCustomer: Boolean(summary.stripeCustomerId),
        pending: justStarted && summary.billingStatus === 'none',
        meta: {
          title: `Plan and billing · ${req.org.name} | AEO Corner`,
          description: 'Your plan, your usage and your billing.',
        },
      });
    } catch (err) {
      next(err);
    }
  });

  /** Start the 14-day trial: a customer in Stripe, then Stripe's own Checkout page (card, $0 today). */
  org.post('/billing/checkout', owner, async (req, res, next) => {
    try {
      if (!stripe) return back(res, 'billing-unavailable');
      const code = req.body.plan;
      const plan = planCodeOk(code) ? await db.reference.plans.get(code) : null;
      if (!plan || !plan.is_public) return back(res, 'billing-bad-plan');
      if (!plan.stripe_price_id) return back(res, 'billing-not-ready');

      const summary = await req.orgDb.billing.summary({ enforced: config.billingEnforced });
      if (PAYING.has(summary.billingStatus)) return back(res, 'billing-has-plan');

      let customerId = summary.stripeCustomerId;
      if (!customerId) {
        const customer = await stripe.customers.create(
          {
            name: req.org.name,
            email: req.user.email,
            metadata: { org_id: req.org.public_id },
          },
          { idempotencyKey: `aeo-customer-${req.org.public_id}` },
        );
        customerId = await req.orgDb.billing.attachCustomer(customer.id);
      }

      // One free trial per organization: someone who has had a subscription before pays from the first day.
      const hadSubscription = Boolean(summary.subscription);
      const session = await stripe.checkout.create({
        mode: 'subscription',
        customer: customerId,
        client_reference_id: req.org.public_id,
        line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
        payment_method_collection: 'always',
        allow_promotion_codes: true,
        subscription_data: {
          metadata: { org_id: req.org.public_id },
          ...(hadSubscription
            ? {}
            : {
                trial_period_days: TRIAL_DAYS,
                trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
              }),
        },
        success_url: `${config.baseUrl}${base(res)}?notice=billing-started`,
        cancel_url: `${config.baseUrl}${base(res)}?notice=billing-canceled`,
      });
      if (typeof session.url !== 'string' || !session.url.startsWith('https://')) {
        throw new StripeError('Stripe gave no checkout address.');
      }
      return res.redirect(303, session.url);
    } catch (err) {
      return failed(err, req, res, next);
    }
  });

  /** Stripe's Customer Portal: card, invoices, cancel. */
  org.post('/billing/portal', owner, async (req, res, next) => {
    try {
      if (!stripe) return back(res, 'billing-unavailable');
      const { stripeCustomerId } = await req.orgDb.billing.summary({
        enforced: config.billingEnforced,
      });
      if (!stripeCustomerId) return back(res, 'billing-no-customer');
      const session = await stripe.portal.create({
        customer: stripeCustomerId,
        return_url: `${config.baseUrl}${base(res)}`,
      });
      if (typeof session.url !== 'string' || !session.url.startsWith('https://')) {
        throw new StripeError('Stripe gave no portal address.');
      }
      return res.redirect(303, session.url);
    } catch (err) {
      return failed(err, req, res, next);
    }
  });

  /** Move to another plan while subscribed. A plan that is too small for what is in use is refused, with the reason. */
  org.post('/billing/plan', owner, async (req, res, next) => {
    try {
      if (!stripe) return back(res, 'billing-unavailable');
      const code = req.body.plan;
      const plan = planCodeOk(code) ? await db.reference.plans.get(code) : null;
      if (!plan || !plan.is_public) return back(res, 'billing-bad-plan');
      if (!plan.stripe_price_id) return back(res, 'billing-not-ready');

      const summary = await req.orgDb.billing.summary({ enforced: config.billingEnforced });
      if (!PAYING.has(summary.billingStatus) || !summary.subscription)
        return back(res, 'billing-no-plan');
      if (summary.planCode === plan.code) return back(res, 'billing-same-plan');

      // Paused, never deleted (CUSTOMER_JOURNEY): a smaller plan waits until the customer has chosen what to archive.
      const usage = await req.orgDb.billing.usage();
      if (
        (plan.max_projects !== null && usage.projects > plan.max_projects) ||
        (plan.max_prompts !== null && usage.prompts > plan.max_prompts)
      ) {
        return back(res, 'billing-downgrade-blocked');
      }

      const sub = await stripe.subscriptions.retrieve(summary.subscription.stripeSubscriptionId);
      const parsed = subscriptionFromStripe(sub, await db.system.billing.plans.priceMap());
      const planItem = sub.items.data.find(
        (i) =>
          i.price?.lookup_key?.startsWith('aeo-plan-') ||
          i.price?.id === summary.plan?.stripe_price_id,
      );
      if (!parsed || !planItem) throw new StripeError('The subscription has no plan item.');
      await stripe.subscriptions.changePlan(sub.id, {
        itemId: planItem.id,
        priceId: plan.stripe_price_id,
      });
      await syncSubscription({ db, stripe, subscriptionId: sub.id, now: new Date() });
      return back(res, 'billing-plan-changed');
    } catch (err) {
      return failed(err, req, res, next);
    }
  });

  org.post('/billing/addons/add', owner, async (req, res, next) => {
    try {
      if (!stripe) return back(res, 'billing-unavailable');
      const code = req.body.addon;
      if (!ADDON_CODES.includes(code)) return back(res, 'billing-bad-plan');
      const summary = await req.orgDb.billing.summary({ enforced: config.billingEnforced });
      if (!PAYING.has(summary.billingStatus) || !summary.subscription)
        return back(res, 'billing-no-plan');
      const priceId = await addonPriceId(stripe, code);
      if (!priceId) return back(res, 'billing-not-ready');
      // A metered add-on has no quantity; a pack is 1 to 10.
      const quantity =
        ADDONS[code].kind === 'metered'
          ? undefined
          : Math.min(10, Math.max(1, Number(req.body.quantity) || 1));
      await stripe.subscriptionItems.create({
        subscription: summary.subscription.stripeSubscriptionId,
        priceId,
        quantity,
      });
      await syncSubscription({
        db,
        stripe,
        subscriptionId: summary.subscription.stripeSubscriptionId,
        now: new Date(),
      });
      return back(res, 'billing-addon-added');
    } catch (err) {
      return failed(err, req, res, next);
    }
  });

  org.post('/billing/addons/remove', owner, async (req, res, next) => {
    try {
      if (!stripe) return back(res, 'billing-unavailable');
      const itemId = typeof req.body.itemId === 'string' ? req.body.itemId : '';
      const [summary, addons] = await Promise.all([
        req.orgDb.billing.summary({ enforced: config.billingEnforced }),
        req.orgDb.billing.addons(),
      ]);
      // Only an item this organization's own grants name can be removed.
      if (!summary.subscription || !addons.some((a) => a.itemId === itemId))
        return back(res, 'billing-no-plan');
      await stripe.subscriptionItems.remove(itemId);
      await syncSubscription({
        db,
        stripe,
        subscriptionId: summary.subscription.stripeSubscriptionId,
        now: new Date(),
      });
      return back(res, 'billing-addon-removed');
    } catch (err) {
      return failed(err, req, res, next);
    }
  });

  /** A Stripe problem is shown as one plain sentence; the details go to the log. */
  function failed(err, req, res, next) {
    if (err instanceof StripeError) {
      logger.error({ err: err.message, code: err.code, status: err.status }, 'Stripe call failed');
      return back(res, 'billing-stripe-error');
    }
    return next(err);
  }
}
