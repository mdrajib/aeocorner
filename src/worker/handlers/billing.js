import { WEBHOOK_PAYLOAD_DAYS, WEBHOOK_ROW_DAYS } from '../../core/org-purge.js';
import { PAYMENT_EXPIRES_HOURS } from '../../core/bkash-billing.js';
import { takaText } from '../../core/taka.js';
import { BkashError } from '../../integrations/bkash.js';
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

/**
 * What the purge of a closed organization does beyond deleting rows (system-purge.js runs these first and stops if one
 * fails): delete its raw files from Spaces (only keys under this app's own prefix, and only the ones no other owner's
 * rows point at; the repository decides that) and the Clerk accounts of people who belong to no other organization.
 * Without a bucket or without Clerk keys on the worker that part is skipped and said so in the log.
 */
function erasure(ctx) {
  const { store, clerk } = ctx.retention ?? {};
  const erase = {};
  if (store?.prefix) {
    erase.files = async (keys) => {
      const own = keys.filter((key) => key.startsWith(store.prefix));
      for (let i = 0; i < own.length; i += 20) {
        await Promise.all(own.slice(i, i + 20).map((key) => store.delete(key)));
      }
      if (own.length < keys.length) {
        ctx.logger.warn(
          { skipped: keys.length - own.length },
          'Purge: files outside this app’s storage prefix were left alone',
        );
      }
      return own.length;
    };
  } else {
    ctx.logger.warn('Purge: no storage prefix, so the organization’s files were not deleted');
  }
  if (clerk?.configured) {
    erase.users = async (members) => {
      for (const member of members) {
        await clerk.deleteUser(member.clerkUserId);
        await ctx.db.users.markDeleted(member.clerkUserId);
      }
      return members.length;
    };
  } else {
    ctx.logger.warn(
      'Purge: Clerk is not configured here, so the people’s accounts were not deleted',
    );
  }
  return erase;
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

  // A delivery's payload (customer details) is kept 30 days; the row, which recognises a repeat, 90.
  const day = 86_400_000;
  const pruned = await ctx.db.webhookEvents.prune({
    payloadsBefore: new Date(now.getTime() - WEBHOOK_PAYLOAD_DAYS * day),
    rowsBefore: new Date(now.getTime() - WEBHOOK_ROW_DAYS * day),
  });
  out.payloadsEmptied = pruned.payloads;
  out.webhooksDeleted = pruned.rows;

  // Claude after a downgrade: a grace that has run out switches the engine off on the projects (the tracking planner has
  // stopped asking it since the moment the grace ended; this makes the screens say so).
  out.claudeStopped = (await ctx.db.system.billing.engineGrace.expire({ now })).reduce(
    (n, o) => n + o.projects,
    0,
  );

  // Then delete what was closed 30 days ago or more. A few organizations a night; the rest wait for tomorrow.
  out.purged = 0;
  for (const orgId of await ctx.db.system.billing.retention.purgeDue({ now, limit: 5 })) {
    try {
      const removed = await ctx.db.system.billing.retention.purge(orgId, {
        now,
        erase: erasure(ctx),
      });
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

/**
 * bKash (ADR-0018), hourly. Nothing renews by itself, so this is what keeps the copy honest:
 *   1. finish a payment that completed but whose subscription was not updated (a crash in between);
 *   2. look up payments nobody heard the end of (the customer closed the tab, the callback never came) at bKash;
 *   3. give up on a payment page nobody finished within a day;
 *   4. let time move the subscriptions: a trial or paid month that ran out is `past_due` (a grace period, then tracking
 *      pauses), and one unpaid for the grace plus 30 days is cancelled, which starts the read-only window.
 * Steps 1, 3 and 4 need no call to bKash, so they run without credentials; step 2 needs them.
 */
export async function bkashSweep(ctx) {
  const now = ctx.now();
  const sys = ctx.db.system.billing.bkash;
  const bkash = ctx.billing?.bkash ?? null;
  const out = { retried: 0, looked: 0, settled: 0, closed: 0, expired: 0, lapsed: 0, failed: 0 };

  for (const publicId of await sys.unapplied()) {
    const done = await sys.applyCompleted(publicId, { now });
    if (done.settled) out.retried += 1;
  }

  if (bkash) {
    for (const p of await sys.pending({ olderThan: new Date(now.getTime() - 10 * 60_000) })) {
      out.looked += 1;
      try {
        const found = await bkash.queryPayment(p.bkashPaymentId);
        if (found.status !== 'completed') continue;
        const settled = await sys.settle({
          publicId: p.publicId,
          paid: {
            trxId: found.trxId,
            amount: found.amount,
            currency: found.currency,
            invoiceNumber: found.invoiceNumber,
          },
          now,
        });
        if (settled.settled) out.settled += 1;
        else
          await ctx.alerts.alert({
            key: `bkash.unsettled:${p.publicId}`,
            severity: 'warning',
            title: 'A bKash payment is complete at bKash but could not be settled here',
            details: { payment: p.publicId, reason: settled.reason },
          });
      } catch (err) {
        if (!(err instanceof BkashError)) throw err;
        out.failed += 1;
        ctx.logger.warn(
          { payment: p.publicId, code: err.code },
          'Could not look up a bKash payment',
        );
      }
    }
  }

  out.expired = await sys.expire({
    before: new Date(now.getTime() - PAYMENT_EXPIRES_HOURS * 3_600_000),
  });
  out.lapsed = (await sys.lapse({ now })).length;
  return out;
}

/** The trial-ending email, four days before the card is charged. One per owner and trial (the notification's dedupe key). */
export async function billingNotices(ctx) {
  if (!ctx.mail) return { skipped: 'email is not configured' };
  const out = { trialEnding: 0, bkashRenewal: 0, claudeEnding: 0 };
  // bKash plans: nothing is charged by itself, so the owner is asked to pay a few days before the period ends.
  for (const r of await ctx.db.system.billing.bkash.reminders({ now: ctx.now() })) {
    if (r.priceBdt === null) continue;
    for (const owner of r.owners) {
      const sent = await ctx.mail.sendBkashRenewal({
        to: owner.email,
        userId: owner.id,
        orgId: r.orgId,
        orgName: r.orgName,
        orgPublicId: r.orgPublicId,
        planName: r.planName,
        priceText: takaText(r.priceBdt),
        endsAt: r.endsAt,
        trial: r.trial,
      });
      if (sent) out.bkashRenewal += 1;
    }
  }
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
  // Told once, when the plan change is first seen (the notification's dedupe key holds an owner and an end date).
  for (const g of await ctx.db.system.billing.engineGrace.ending({ now: ctx.now() })) {
    for (const owner of g.owners) {
      const sent = await ctx.mail.sendClaudeEnding({
        to: owner.email,
        userId: owner.id,
        orgId: g.orgId,
        orgPublicId: g.orgPublicId,
        orgName: g.orgName,
        until: g.until,
        projectNames: g.projectNames,
      });
      if (sent) out.claudeEnding += 1;
    }
  }
  return out;
}

export const billingHandlers = {
  'billing.bkash_sweep': bkashSweep,
  'billing.notices': billingNotices,
  'billing.reconcile': billingReconcile,
  'billing.report_usage': billingReportUsage,
  'retention.sweep': retentionSweep,
};
