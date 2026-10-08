import { randomBytes } from 'node:crypto';
import {
  QUOTE_NOTICES,
  invoiceNumber,
  quotePayment,
  takaText,
  trialSubscription,
} from '../../core/bkash-billing.js';
import { BkashError, ALREADY_COMPLETED } from '../../integrations/bkash.js';

/**
 * Paying with bKash (ADR-0018), registered by `billingRoutes` on the organization router. Owners only (`billing.manage`).
 *
 *   POST /billing/bkash/trial    start the 14-day trial: nothing is charged and bKash is not asked
 *   POST /billing/bkash/pay      ask bKash for one month (start, renewal, or a bigger plan) and send the customer there
 *   GET  /billing/bkash/return   where bKash sends the customer back; the payment is EXECUTED here and only then believed
 *   POST /billing/bkash/renewal  stop or resume the reminder and the renewal at the end of the paid period
 *
 * What a payment costs and buys is `src/core/bkash-billing.js`. The query string bKash sends back is only used to find
 * our own payment row: whether money moved is what bKash answers to `execute`, checked against our row's amount.
 */

const PAYING = new Set(['trialing', 'active', 'past_due']);
const planCodeOk = (v) => typeof v === 'string' && /^[a-z0-9_]{1,32}$/.test(v);
const paymentIdOk = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);

export function bkashRoutes(org, { auth, billing, config, db, logger, now = () => new Date() }) {
  const owner = auth.requirePermission('billing.manage');
  const bkash = billing?.bkash ?? null;
  const base = (res) => `${res.locals.orgBase}/billing`;
  const back = (res, notice) => res.redirect(303, `${base(res)}?notice=${notice}`);

  async function chosenPlan(code) {
    const plan = planCodeOk(code) ? await db.reference.plans.get(code) : null;
    return plan && plan.is_public ? plan : null;
  }

  org.post('/billing/bkash/trial', owner, async (req, res, next) => {
    try {
      if (!bkash) return back(res, 'billing-unavailable');
      const plan = await chosenPlan(req.body.plan);
      if (!plan) return back(res, 'billing-bad-plan');
      if (plan.price_bdt_month === null) return back(res, 'billing-not-ready');
      const summary = await req.orgDb.billing.summary({ enforced: config.billingEnforced });
      // One free trial per organization: anyone who has had a subscription pays from the first day.
      if (summary.subscription) return back(res, 'billing-trial-used');

      const result = await db.system.billing.subscriptions.apply({
        parsed: trialSubscription({
          orgPublicId: req.org.public_id,
          planCode: plan.code,
          now: now(),
        }),
        now: now(),
      });
      return back(res, result.applied ? 'billing-bkash-trial' : 'billing-unavailable');
    } catch (err) {
      return next(err);
    }
  });

  org.post('/billing/bkash/pay', owner, async (req, res, next) => {
    try {
      if (!bkash) return back(res, 'billing-unavailable');
      const plan = await chosenPlan(req.body.plan);
      if (!plan) return back(res, 'billing-bad-plan');

      const summary = await req.orgDb.billing.summary({ enforced: config.billingEnforced });
      const sub = summary.subscription;
      // A plan that is paying through Stripe is changed on Stripe, not here.
      if (sub?.provider === 'stripe' && PAYING.has(sub.status))
        return back(res, 'billing-has-plan');

      // A smaller plan has to be big enough for what is in use now (nothing is deleted, the change just waits).
      if (sub && summary.planCode && summary.planCode !== plan.code) {
        const usage = await req.orgDb.billing.usage();
        if (
          (plan.max_projects !== null && usage.projects > plan.max_projects) ||
          (plan.max_prompts !== null && usage.prompts > plan.max_prompts)
        ) {
          return back(res, 'billing-downgrade-blocked');
        }
      }

      const quote = quotePayment({
        plan,
        subscription: sub,
        currentPlan: summary.plan,
        now: now(),
      });
      if (!quote.ok) return back(res, QUOTE_NOTICES[quote.reason] ?? 'billing-not-ready');
      if (!(quote.amountBdt >= 1)) return back(res, 'billing-not-ready');

      const payment = await req.orgDb.bkash.begin({
        planCode: plan.code,
        purpose: quote.purpose,
        amountBdt: quote.amountBdt,
        invoiceNumber: invoiceNumber(req.org.public_id, now(), randomBytes(3).toString('hex')),
        now: now(),
      });
      try {
        const created = await bkash.createPayment({
          amountBdt: payment.amountBdt,
          invoiceNumber: payment.invoiceNumber,
          payerReference: req.org.public_id,
          callbackUrl: `${config.baseUrl}${base(res)}/bkash/return`,
        });
        await req.orgDb.bkash.attach(payment.publicId, created.paymentId);
        return res.redirect(303, created.url);
      } catch (err) {
        if (!(err instanceof BkashError)) throw err;
        logger.error({ code: err.code, status: err.status }, 'bKash could not create a payment');
        await req.orgDb.bkash.close(payment.publicId, {
          status: 'failed',
          reason: err.code ? `bKash refused (code ${err.code})` : 'bKash could not be reached',
        });
        return back(res, 'billing-bkash-error');
      }
    } catch (err) {
      return next(err);
    }
  });

  org.get('/billing/bkash/return', owner, async (req, res, next) => {
    try {
      if (!bkash) return back(res, 'billing-unavailable');
      const paymentId = req.query.paymentID;
      if (!paymentIdOk(paymentId)) return back(res, 'billing-bkash-failed');
      const payment = await req.orgDb.bkash.byBkashId(paymentId);
      if (!payment) return back(res, 'billing-bkash-failed');
      if (payment.status === 'completed') return back(res, 'billing-bkash-paid');

      if (req.query.status === 'cancel') {
        await req.orgDb.bkash.close(payment.publicId, { status: 'cancelled' });
        return back(res, 'billing-bkash-cancelled');
      }
      if (req.query.status !== 'success') {
        await req.orgDb.bkash.close(payment.publicId, {
          status: 'failed',
          reason: 'bKash reported a failure.',
        });
        return back(res, 'billing-bkash-failed');
      }

      let result;
      try {
        result = await bkash.executePayment(paymentId);
      } catch (err) {
        if (!(err instanceof BkashError)) throw err;
        if (err.code === ALREADY_COMPLETED) {
          // Executed already (a reload, or the sweep got there first): ask what it became.
          try {
            result = await bkash.queryPayment(paymentId);
          } catch {
            return back(res, 'billing-bkash-checking');
          }
        } else if (err.retryable || !err.code) {
          return back(res, 'billing-bkash-checking'); // the sweep looks it up again
        } else {
          await req.orgDb.bkash.close(payment.publicId, {
            status: 'failed',
            reason: `bKash declined (code ${err.code})`,
          });
          return back(res, 'billing-bkash-failed');
        }
      }

      if (result.status !== 'completed') return back(res, 'billing-bkash-checking');
      const settled = await db.system.billing.bkash.settle({
        publicId: payment.publicId,
        paid: {
          trxId: result.trxId,
          amount: result.amount,
          currency: result.currency,
          invoiceNumber: result.invoiceNumber,
        },
        now: now(),
      });
      if (settled.settled) return back(res, 'billing-bkash-paid');
      logger.error({ reason: settled.reason }, 'A bKash payment could not be settled');
      return back(
        res,
        settled.reason === 'mismatch' ? 'billing-bkash-failed' : 'billing-bkash-checking',
      );
    } catch (err) {
      return next(err);
    }
  });

  org.post('/billing/bkash/renewal', owner, async (req, res, next) => {
    try {
      const stop = req.body.stop === '1';
      const changed = await req.orgDb.bkash.setCancelAtPeriodEnd(stop);
      if (!changed) return back(res, 'billing-no-plan');
      return back(res, stop ? 'billing-bkash-renewal-stopped' : 'billing-bkash-renewal-resumed');
    } catch (err) {
      return next(err);
    }
  });
}

/**
 * What the billing screen shows for bKash: one price line per plan ("Pay ৳N today") worked out by the same rule the
 * payment uses, and the recent payments. Pure given its inputs, so the screen and the payment cannot disagree.
 */
export function bkashScreen({ view, plans, summary, payments, now }) {
  const byCode = new Map(plans.map((p) => [p.code, p]));
  const choices = view.choices.map((c) => {
    const plan = byCode.get(c.code);
    const quote = quotePayment({
      plan,
      subscription: summary.subscription,
      currentPlan: summary.plan,
      now,
    });
    return {
      ...c,
      pay: quote.ok
        ? {
            amountText: takaText(quote.amountBdt),
            purpose: quote.purpose,
            note:
              quote.purpose === 'change' && quote.creditBdt > 0
                ? `Includes a credit of ${takaText(quote.creditBdt)} for the unused part of this month.`
                : null,
          }
        : { blocked: quote.reason },
    };
  });
  return {
    choices,
    canTrial: !summary.subscription,
    renewalStopped: Boolean(summary.subscription?.cancelAtPeriodEnd),
    payments: payments.map((p) => ({
      date: p.completedAt ?? p.createdAt,
      amountText: takaText(p.amountBdt),
      status: p.status,
      trxId: p.trxId,
      planCode: p.planCode,
    })),
  };
}
