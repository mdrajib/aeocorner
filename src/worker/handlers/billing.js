import { syncSubscription } from '../../integrations/stripe-sync.js';
import { StripeError } from '../../integrations/stripe.js';

/**
 * The billing jobs (Milestone 8), all on the `system` queue:
 *
 *   billing.reconcile     daily: ask Stripe about every subscription we think is live and store what it says. The
 *                         webhook does this in real time; this is the safety net, and a difference is an alert.
 *   billing.report_usage  hourly: tell Stripe's "extra drafts" meter about drafts taken beyond a plan's allowance.
 *   retention.sweep       daily: warn owners of cancelled accounts before their read-only period ends, close the
 *                         accounts whose period is over, then purge the rows of accounts closed 30 days ago
 *                         (src/db/repos/system-billing.js and system-purge.js, `retention`).
 *
 * None of them runs without Stripe configured (`ctx.billing.stripe`), except the retention sweep, which needs no Stripe.
 */

const noStripe = (ctx) => !ctx.billing?.stripe;

export async function billingReconcile(ctx) {
  if (noStripe(ctx)) return { skipped: 'billing is not configured' };
  const result = { checked: 0, differed: 0, failed: 0 };
  let afterId = 0n;
  for (;;) {
    const batch = await ctx.db.system.billing.subscriptions.reconcilable({ afterId, limit: 100 });
    if (batch.length === 0) break;
    for (const sub of batch) {
      afterId = sub.id;
      result.checked += 1;
      try {
        const done = await syncSubscription({
          db: ctx.db,
          stripe: ctx.billing.stripe,
          subscriptionId: sub.stripeSubscriptionId,
          now: ctx.now(),
        });
        // `changed` means the organization's plan or status was out of date: a webhook never arrived or failed.
        if (done.applied && done.changed) {
          result.differed += 1;
          await ctx.alerts.alert({
            key: `billing.mismatch:${sub.id}`,
            severity: 'warning',
            title: 'A subscription was out of step with Stripe and has been corrected',
            details: { subscription: String(sub.id), status: done.status },
          });
        }
      } catch (err) {
        result.failed += 1;
        ctx.logger.error(
          { subscription: String(sub.id), err: err.message },
          'Reconcile failed for one subscription',
        );
        if (!(err instanceof StripeError)) throw err;
      }
    }
  }
  return result;
}

/**
 * One meter event per whole draft beyond the allowance. The identifier names the organization, the month and the
 * running total, so asking again for the same draft is a duplicate Stripe refuses (and we treat as already reported).
 */
export async function billingReportUsage(ctx) {
  if (noStripe(ctx)) return { skipped: 'billing is not configured' };
  const now = ctx.now();
  const pending = await ctx.db.system.billing.meters.draftsToReport({ now });
  const sent = { orgs: 0, units: 0, failed: 0 };
  for (const p of pending) {
    let reported = 0;
    for (let n = 1; n <= p.units; n += 1) {
      const total = p.billed + n;
      try {
        await ctx.billing.stripe.meterEvents.create({
          eventName: 'aeo_extra_draft',
          customerId: p.customerId,
          value: 1,
          identifier: `draft-${p.orgPublicId}-${p.period.toISOString().slice(0, 7)}-${total}`,
          timestamp: Math.floor(now.getTime() / 1000),
        });
        reported += 1;
      } catch (err) {
        if (err instanceof StripeError && err.code === 'billing_meter_event_duplicate') {
          reported += 1; // an earlier attempt got through before we could write it down
          continue;
        }
        sent.failed += 1;
        ctx.logger.error(
          { org: String(p.orgId), err: err.message },
          'Could not report extra drafts to Stripe',
        );
        break;
      }
    }
    if (reported > 0) {
      await ctx.db.system.billing.meters.markDraftsReported({
        orgId: p.orgId,
        period: p.period,
        units: reported,
      });
      sent.orgs += 1;
      sent.units += reported;
    }
  }
  return sent;
}

/** Warn, then close. The warning is one email per organization (its dedupe key), 14 days before the end. */
export async function retentionSweep(ctx) {
  const now = ctx.now();
  const out = { warned: 0, closed: 0 };

  if (ctx.mail) {
    for (const org of await ctx.db.system.billing.retention.warnable({ now })) {
      for (const owner of org.owners) {
        const sent = await ctx.mail.sendRetentionWarning({
          to: owner.email,
          userId: owner.id,
          orgId: org.orgId,
          orgName: org.orgName,
          retainUntil: org.retainUntil,
        });
        if (sent) out.warned += 1;
      }
    }
  }

  for (const orgId of await ctx.db.system.billing.retention.due({ now })) {
    if (await ctx.db.system.billing.retention.close(orgId, { now })) {
      out.closed += 1;
      ctx.logger.info(
        { orgId: String(orgId) },
        'Closed a cancelled organization at the end of its read-only period',
      );
    }
  }

  // Then delete what was closed 30 days ago or more. A few organizations a night; the rest wait for tomorrow.
  out.purged = 0;
  for (const orgId of await ctx.db.system.billing.retention.purgeDue({ now, limit: 5 })) {
    try {
      const removed = await ctx.db.system.billing.retention.purge(orgId, { now });
      if (removed) {
        out.purged += 1;
        ctx.logger.info(
          { orgId: String(orgId), tables: Object.keys(removed).length },
          'Purged a closed organization’s data',
        );
      }
    } catch (error) {
      // One stuck organization must not stop the others; it stays purgeable and is tried again tomorrow.
      ctx.logger.error(
        { orgId: String(orgId), err: error },
        'Purging a closed organization failed',
      );
    }
  }
  return out;
}

/** The trial-ending email, four days before the card is charged. One per owner and trial (the notification's dedupe key). */
export async function billingNotices(ctx) {
  if (!ctx.mail) return { skipped: 'email is not configured' };
  const out = { trialEnding: 0 };
  for (const t of await ctx.db.system.billing.trials.ending({ now: ctx.now() })) {
    for (const owner of t.owners) {
      const sent = await ctx.mail.sendTrialEnding({
        to: owner.email,
        userId: owner.id,
        orgId: t.orgId,
        orgName: t.orgName,
        orgPublicId: t.orgPublicId,
        subscriptionId: t.subscriptionId,
        planName: t.planName,
        priceText: t.priceText,
        chargeDate: t.trialEndsAt,
      });
      if (sent) out.trialEnding += 1;
    }
  }
  return out;
}

export const billingHandlers = {
  'billing.notices': billingNotices,
  'billing.reconcile': billingReconcile,
  'billing.report_usage': billingReportUsage,
  'retention.sweep': retentionSweep,
};
