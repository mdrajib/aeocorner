import { datesAfter, firstPayment, grantsFromAddons } from '../../core/billing.js';
import { ADDONS } from '../../core/addons.js';
import { addDays } from '../../core/entitlements.js';
import { graceAfterPlanChange } from '../../core/engines.js';
import { transaction } from '../transaction.js';
import { entitledLimit } from './org-billing.js';
import { systemPurge } from './system-purge.js';

/**
 * The billing lookups Stripe's webhooks and the worker make ACROSS organizations (Milestone 8). A webhook arrives
 * knowing a Stripe customer, not an organization, so these are the one place that finds the organization from Stripe's
 * IDs. Reviewed and listed in tests/tenancy like the rest of `system` (see system.js).
 *
 * Everything that writes is safe to run twice with the same input: the Stripe object it is given always produces
 * the same rows.
 */

const PAYING = new Set(['trialing', 'active', 'past_due']);
const ENDED = new Set(['canceled', 'incomplete_expired']);
const RETENTION_PURGE_DAYS = 30;
const monthStart = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

export function systemBilling(prisma) {
  /** The organization a Stripe subscription belongs to: by customer first, then by the ID we put in its metadata. */
  async function findOrg(db, { stripeCustomerId, orgPublicId }) {
    if (stripeCustomerId) {
      const byCustomer = await db.organizations.findFirst({
        where: { stripe_customer_id: stripeCustomerId },
        select: { id: true, deleted_at: true },
      });
      if (byCustomer) return { ...byCustomer, via: 'customer' };
    }
    if (orgPublicId) {
      const byPublic = await db.organizations.findFirst({
        where: { public_id: orgPublicId },
        select: { id: true, deleted_at: true, stripe_customer_id: true },
      });
      if (byPublic) return { ...byPublic, via: 'metadata' };
    }
    return null;
  }

  const plans = {
    /** Stripe price ID → plan code, for every plan that has been synced to Stripe. */
    async priceMap() {
      const rows = await prisma.plans.findMany({
        where: { stripe_price_id: { not: null } },
        select: { code: true, stripe_price_id: true },
      });
      return new Map(rows.map((r) => [r.stripe_price_id, r.code]));
    },
    /** Plans to show on the plan picker (public, in display order). */
    list: () =>
      prisma.plans.findMany({ where: { is_public: true }, orderBy: { sort_order: 'asc' } }),
    get: (code) => prisma.plans.findUnique({ where: { code } }),
    setStripePrice: (code, priceId) =>
      prisma.plans.update({ where: { code }, data: { stripe_price_id: priceId } }),
  };

  const subscriptions = {
    /**
     * Write what Stripe says about one subscription: its row, the organization's mirror of it (plan, status, dates)
     * and the add-on grants. Returns `{ applied: false, reason }` when it is not ours to apply.
     *
     * The organization mirror follows the organization's CURRENT subscription (the latest one still paying, else the
     * latest), so a late event about an old cancelled subscription cannot overwrite a new one.
     *
     * @param {object} parsed  from `subscriptionFromStripe`
     * @param {object} [invoice]  the invoice that triggered this, if any (a first payment opens the money-back window)
     */
    async apply({ parsed, invoice = null, now = new Date() }) {
      const found = await findOrg(prisma, parsed);
      if (!found) return { applied: false, reason: 'unknown_organization' };
      if (found.deleted_at) return { applied: false, reason: 'organization_deleted' };
      // A subscription claiming an organization that already has a different Stripe customer is not ours.
      if (
        found.via === 'metadata' &&
        found.stripe_customer_id &&
        found.stripe_customer_id !== parsed.stripeCustomerId
      ) {
        return { applied: false, reason: 'customer_mismatch' };
      }
      const orgId = found.id;

      return transaction(prisma, async (tx) => {
        // One writer per organization at a time: two webhooks about the same customer line up here.
        await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${orgId} FOR UPDATE`;
        const org = await tx.organizations.findUnique({ where: { id: orgId } });
        const previous = await tx.subscriptions.findFirst({
          where: { stripe_subscription_id: parsed.stripeSubscriptionId },
        });
        if (previous && previous.org_id !== orgId)
          return { applied: false, reason: 'customer_mismatch' };

        const dates = datesAfter({
          status: parsed.status,
          before: { graceUntil: previous?.grace_until ?? null, retainUntil: org.retain_until },
          now,
        });
        const paid = firstPayment({
          invoice,
          before: previous ? { firstPaidAt: previous.first_paid_at } : null,
        });

        const data = {
          plan_code: parsed.planCode,
          status: parsed.status,
          trial_ends_at: parsed.trialEndsAt,
          current_period_start: parsed.currentPeriodStart,
          current_period_end: parsed.currentPeriodEnd,
          cancel_at_period_end: parsed.cancelAtPeriodEnd,
          canceled_at: ENDED.has(parsed.status) ? (parsed.canceledAt ?? now) : null,
          grace_until: dates.graceUntil,
          ...(paid
            ? { first_paid_at: paid.firstPaidAt, money_back_until: paid.moneyBackUntil }
            : {}),
        };
        if (previous) {
          await tx.subscriptions.update({ where: { id: previous.id }, data });
        } else {
          // The organization row is locked above, so no second writer can create it at the same moment.
          await tx.subscriptions.create({
            data: { org_id: orgId, stripe_subscription_id: parsed.stripeSubscriptionId, ...data },
          });
        }

        // The current subscription: still paying wins, then the most recently touched.
        const all = await tx.subscriptions.findMany({
          where: { org_id: orgId },
          orderBy: [{ updated_at: 'desc' }, { id: 'desc' }],
        });
        const current = all.find((s) => PAYING.has(s.status)) ?? all[0];
        const isCurrent = current.stripe_subscription_id === parsed.stripeSubscriptionId;

        let mirrorChanged = false;
        if (isCurrent) {
          const ended = ENDED.has(current.status);
          const orgStatus = parsed.orgStatus;
          const next = {
            plan_code: current.plan_code,
            billing_status: orgStatus,
            stripe_customer_id: org.stripe_customer_id ?? parsed.stripeCustomerId,
            canceled_at: ended ? (current.canceled_at ?? now) : null,
            retain_until: ended ? dates.retainUntil : null,
          };
          mirrorChanged =
            org.plan_code !== next.plan_code || org.billing_status !== next.billing_status;
          // Losing Claude by a downgrade starts a grace until the end of the period already paid for (F3, option C).
          if (org.plan_code !== next.plan_code) {
            const hasClaude = async (code) =>
              code
                ? Boolean(
                    (await tx.plans.findUnique({ where: { code }, select: { features: true } }))
                      ?.features?.claude_engine,
                  )
                : false;
            next.claude_until = graceAfterPlanChange({
              before: await hasClaude(org.plan_code),
              after: await hasClaude(next.plan_code),
              periodEnd: current.current_period_end,
              existing: org.claude_until,
              now,
            });
          }
          await tx.organizations.update({ where: { id: orgId }, data: next });

          await syncGrants(tx, orgId, PAYING.has(parsed.status) ? parsed.addons : [], now);
        }

        if (isCurrent && mirrorChanged) {
          await tx.org_activity_log.create({
            data: {
              org_id: orgId,
              actor_type: 'system',
              action: 'billing.changed',
              summary: `Plan ${parsed.planCode}, status ${parsed.orgStatus}`,
              metadata: { plan: parsed.planCode, status: parsed.orgStatus },
            },
          });
        }
        return {
          applied: true,
          orgId,
          isCurrent,
          changed: mirrorChanged,
          firstPayment: Boolean(paid),
          status: parsed.status,
        };
      });
    },

    /** Subscriptions to re-check against Stripe (the daily reconcile): everything not yet ended. */
    async reconcilable({ afterId = 0n, limit = 100 } = {}) {
      const rows = await prisma.subscriptions.findMany({
        where: { id: { gt: afterId }, status: { notIn: ['canceled', 'incomplete_expired'] } },
        orderBy: { id: 'asc' },
        take: limit,
        select: { id: true, stripe_subscription_id: true, org_id: true },
      });
      return rows.map((r) => ({
        id: r.id,
        orgId: r.org_id,
        stripeSubscriptionId: r.stripe_subscription_id,
      }));
    },
  };

  /** Make the organization's add-on grants say exactly what its current subscription's items say. */
  async function syncGrants(tx, orgId, addons, now) {
    const want = grantsFromAddons(addons, ADDONS);
    const have = await tx.entitlement_grants.findMany({
      where: { org_id: orgId, source: 'addon', ends_at: null },
    });
    const wantedItems = new Set(want.map((w) => w.itemId));
    for (const g of have) {
      if (!wantedItems.has(g.stripe_subscription_item_id)) {
        await tx.entitlement_grants.update({ where: { id: g.id }, data: { ends_at: now } });
      }
    }
    for (const w of want) {
      const existing = have.find((g) => g.stripe_subscription_item_id === w.itemId);
      if (existing) {
        if (existing.amount !== w.amount || existing.meter !== w.meter) {
          await tx.entitlement_grants.update({
            where: { id: existing.id },
            data: { amount: w.amount, meter: w.meter },
          });
        }
      } else {
        await tx.entitlement_grants.create({
          data: {
            org_id: orgId,
            meter: w.meter,
            amount: w.amount,
            source: 'addon',
            stripe_subscription_item_id: w.itemId,
            reason: w.reason,
            starts_at: now,
          },
        });
      }
    }
  }

  const retention = {
    /** Cancelled organizations whose read-only window has run out and that have not been closed yet. */
    async due({ now = new Date(), limit = 100 } = {}) {
      const rows = await prisma.organizations.findMany({
        where: {
          billing_status: 'canceled',
          retain_until: { lte: now },
          deleted_at: null,
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: limit,
      });
      return rows.map((r) => r.id);
    },

    /** Cancelled organizations that will be closed within `days`, with their owners' emails (for the reminder). */
    async warnable({ now = new Date(), days = 14, limit = 200 } = {}) {
      const rows = await prisma.organizations.findMany({
        where: {
          billing_status: 'canceled',
          deleted_at: null,
          retain_until: { gt: now, lte: addDays(now, days) },
        },
        select: {
          id: true,
          name: true,
          retain_until: true,
          memberships: {
            where: { role: 'owner' },
            select: { users: { select: { id: true, email: true, name: true, deleted_at: true } } },
          },
        },
        orderBy: { id: 'asc' },
        take: limit,
      });
      return rows.map((r) => ({
        orgId: r.id,
        orgName: r.name,
        retainUntil: r.retain_until,
        owners: r.memberships.map((m) => m.users).filter((u) => u && !u.deleted_at),
      }));
    },

    /**
     * Close a cancelled organization at the end of its read-only window: it is marked deleted (nothing runs for it, the
     * app no longer lists it) and scheduled for the purge. Only a cancelled organization whose window is over can be
     * closed, and closing twice changes nothing.
     */
    async close(orgId, { now = new Date() } = {}) {
      const closed = await prisma.organizations.updateMany({
        where: {
          id: orgId,
          billing_status: 'canceled',
          retain_until: { lte: now },
          deleted_at: null,
        },
        data: { deleted_at: now, purge_after: addDays(now, RETENTION_PURGE_DAYS) },
      });
      if (closed.count !== 1) return false;
      await prisma.projects.updateMany({
        where: { org_id: orgId, deleted_at: null },
        data: {
          deleted_at: now,
          purge_after: addDays(now, RETENTION_PURGE_DAYS),
          status: 'archived',
        },
      });
      await prisma.org_activity_log.create({
        data: {
          org_id: orgId,
          actor_type: 'system',
          action: 'billing.retention_closed',
          summary: 'Closed at the end of the 90-day read-only period after cancellation',
        },
      });
      return true;
    },
  };

  const trials = {
    /**
     * Trials that end within `days` and whose owners have not been told: the subscription, the plan and the owners'
     * addresses. The notification's own dedupe key stops a second email, so this can be asked for as often as needed.
     */
    async ending({ now = new Date(), days = 4, limit = 200 } = {}) {
      const rows = await prisma.subscriptions.findMany({
        where: {
          status: 'trialing',
          trial_ends_at: { gt: now, lte: addDays(now, days) },
          organizations: { deleted_at: null },
        },
        select: {
          id: true,
          org_id: true,
          trial_ends_at: true,
          plans: { select: { name: true, price_usd_month: true } },
          organizations: {
            select: {
              name: true,
              public_id: true,
              memberships: {
                where: { role: 'owner' },
                select: { users: { select: { id: true, email: true, deleted_at: true } } },
              },
            },
          },
        },
        orderBy: { id: 'asc' },
        take: limit,
      });
      return rows.map((r) => ({
        subscriptionId: r.id,
        orgId: r.org_id,
        orgName: r.organizations.name,
        orgPublicId: r.organizations.public_id,
        trialEndsAt: r.trial_ends_at,
        planName: r.plans.name,
        priceText: `$${Number(r.plans.price_usd_month).toFixed(0)}`,
        owners: r.organizations.memberships.map((m) => m.users).filter((u) => u && !u.deleted_at),
      }));
    },
  };

  const meters = {
    /**
     * Drafts each organization with the metered "extra drafts" add-on has taken beyond its allowance this month and
     * not yet reported to Stripe. `units` is whole drafts (a refresh is half: the half waits for the next whole one).
     */
    async draftsToReport({ now = new Date(), limit = 500 } = {}) {
      const period = monthStart(now);
      const grants = await prisma.entitlement_grants.findMany({
        where: {
          source: 'addon',
          meter: 'drafts',
          amount: 0,
          starts_at: { lte: now },
          OR: [{ ends_at: null }, { ends_at: { gt: now } }],
          organizations: { stripe_customer_id: { not: null }, deleted_at: null },
        },
        select: {
          org_id: true,
          organizations: { select: { stripe_customer_id: true, public_id: true } },
        },
        distinct: ['org_id'],
        take: limit,
      });
      const out = [];
      for (const g of grants) {
        const rows = await prisma.quota_usage.findMany({
          where: {
            org_id: g.org_id,
            period_month: period,
            meter: { in: ['drafts', 'drafts_billed'] },
          },
        });
        const used = Number(rows.find((r) => r.meter === 'drafts')?.used_units ?? 0);
        const billed = Number(rows.find((r) => r.meter === 'drafts_billed')?.used_units ?? 0);
        const limitNow = await entitledLimit(prisma, g.org_id, 'drafts', now);
        const over = limitNow === null ? 0 : Math.max(0, Math.floor(used - limitNow));
        if (over > billed) {
          out.push({
            orgId: g.org_id,
            orgPublicId: g.organizations.public_id,
            customerId: g.organizations.stripe_customer_id,
            period,
            billed,
            units: over - billed,
          });
        }
      }
      return out;
    },

    /** Record that `units` more drafts reached Stripe. Called once the meter event was accepted. */
    async markDraftsReported({ orgId, period, units }) {
      await prisma.$executeRaw`
        INSERT INTO quota_usage (org_id, period_month, meter, used_units)
        VALUES (${orgId}, ${period}, 'drafts_billed', ${units})
        ON DUPLICATE KEY UPDATE used_units = used_units + ${units}`;
    },
  };

  /**
   * Claude after a downgrade (founder decision F3, option C; `organizations.claude_until`). The tracking planner
   * already stops asking Claude when the grace is over; this switches the engine off on the projects so the screens say
   * so, and finds who has to be told while it still runs.
   */
  const engineGrace = {
    /** Organizations whose grace is over: Claude is switched off on every project, the grace cleared, a line written. */
    async expire({ now = new Date(), limit = 100 } = {}) {
      const due = await prisma.organizations.findMany({
        where: { claude_until: { lte: now }, deleted_at: null },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: limit,
      });
      const done = [];
      for (const { id } of due) {
        const result = await transaction(prisma, async (tx) => {
          const org = await tx.organizations.findFirst({
            where: { id, claude_until: { lte: now } },
            select: { plan_code: true },
          });
          if (!org) return null;
          const plan = org.plan_code
            ? await tx.plans.findUnique({
                where: { code: org.plan_code },
                select: { features: true },
              })
            : null;
          // A plan with Claude again should have cleared the grace already; if it did not, nothing is switched off.
          const keep = !org.plan_code || Boolean(plan?.features?.claude_engine);
          const off = keep
            ? { count: 0 }
            : await tx.project_engines.updateMany({
                where: { org_id: id, engine_code: 'claude', enabled: true },
                data: { enabled: false },
              });
          await tx.organizations.update({ where: { id }, data: { claude_until: null } });
          if (off.count > 0) {
            await tx.org_activity_log.create({
              data: {
                org_id: id,
                actor_type: 'system',
                action: 'engine.claude_stopped',
                summary: 'Claude tracking stopped: the plan no longer includes it',
                metadata: { projects: off.count },
              },
            });
          }
          return { orgId: id, projects: off.count };
        });
        if (result) done.push(result);
      }
      return done;
    },

    /**
     * Organizations in a grace with Claude still on somewhere, with the projects and the owners' addresses (for the
     * notice). The notification's own dedupe key stops a second email, so this can be asked for as often as needed.
     */
    async ending({ now = new Date(), limit = 200 } = {}) {
      const orgs = await prisma.organizations.findMany({
        where: { claude_until: { gt: now }, deleted_at: null },
        select: {
          id: true,
          name: true,
          public_id: true,
          claude_until: true,
          memberships: {
            where: { role: 'owner' },
            select: { users: { select: { id: true, email: true, deleted_at: true } } },
          },
        },
        orderBy: { id: 'asc' },
        take: limit,
      });
      const out = [];
      for (const org of orgs) {
        const tracked = await prisma.project_engines.findMany({
          where: { org_id: org.id, engine_code: 'claude', enabled: true },
          select: { project_id: true },
        });
        if (tracked.length === 0) continue;
        const projects = await prisma.projects.findMany({
          where: { org_id: org.id, id: { in: tracked.map((t) => t.project_id) } },
          select: { name: true },
          orderBy: { id: 'asc' },
        });
        out.push({
          orgId: org.id,
          orgName: org.name,
          orgPublicId: org.public_id,
          until: org.claude_until,
          projectNames: projects.map((p) => p.name),
          owners: org.memberships.map((m) => m.users).filter((u) => u && !u.deleted_at),
        });
      }
      return out;
    },
  };

  // The purge is the last step of the same lifecycle: warn, close (above), then delete (system-purge.js).
  return {
    engineGrace,
    plans,
    subscriptions,
    retention: { ...retention, ...systemPurge(prisma) },
    trials,
    meters,
  };
}
