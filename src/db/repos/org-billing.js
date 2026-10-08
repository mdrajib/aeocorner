import { accessFor, checkLimit, limitsFor } from '../../core/entitlements.js';
import { DomainError, isUniqueViolation } from '../errors.js';

/**
 * One organization's plan, limits and usage (Milestone 8, tasks 8.07 and 8.08). Merged into `forOrg(orgId)` as
 * `billing`; the organization is bound once and no function takes an `org_id` argument.
 *
 * What an organization may do is decided by `src/core/entitlements.js` (pure). This file only reads the rows that
 * rule needs: the plan, the add-on grants, how much is used.
 */

const monthStart = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

/**
 * Until the founder fills in the NULL plan limits (task 0.17), a drafts or "check now" limit that is not set falls
 * back to these. Everything else that is NULL stays "not enforced". An organization with no plan yet gets them too.
 */
export const LIMIT_PLACEHOLDERS = Object.freeze({ drafts: 4, runs_now: 4 });

/**
 * The limit for one meter of one organization: the plan's number plus active grants; `null` is "not enforced".
 * Drafts and "check now" fall back to a placeholder while their plan numbers are unset. Used by the repositories that
 * take a quota where the work is done (drafts, "check now"), so they and the billing screen read the same number.
 */
export async function entitledLimit(db, orgId, meter, now = new Date()) {
  const org = await db.organizations.findFirst({
    where: { id: orgId },
    select: { plan_code: true },
  });
  if (!org) throw new DomainError('NOT_FOUND');
  const plan = org.plan_code ? await db.plans.findUnique({ where: { code: org.plan_code } }) : null;
  const grants = await db.entitlement_grants.findMany({ where: { org_id: orgId, meter } });
  const limits = limitsFor(plan, grants, now, LIMIT_PLACEHOLDERS);
  return limits[meter] ?? LIMIT_PLACEHOLDERS[meter] ?? null;
}

export function billingRepos(prisma, orgId, { appendActivity }) {
  async function orgRow(db = prisma) {
    const org = await db.organizations.findFirst({
      where: { id: orgId },
      select: {
        plan_code: true,
        billing_status: true,
        stripe_customer_id: true,
        canceled_at: true,
        retain_until: true,
        claude_until: true,
        public_id: true,
        name: true,
      },
    });
    if (!org) throw new DomainError('NOT_FOUND');
    return org;
  }

  async function planOf(code, db = prisma) {
    return code ? db.plans.findUnique({ where: { code } }) : null;
  }

  const grantsOf = (db = prisma) => db.entitlement_grants.findMany({ where: { org_id: orgId } });

  /**
   * The limit for one meter right now: the plan's number plus active grants. `null` means "not enforced".
   * Drafts and "check now" fall back to a placeholder while their plan numbers are unset.
   */
  const limitFor = (meter, { now = new Date(), db = prisma } = {}) =>
    entitledLimit(db, orgId, meter, now);

  async function liveProjectCount(db = prisma) {
    return db.projects.count({
      where: { org_id: orgId, deleted_at: null, status: { not: 'archived' } },
    });
  }

  /** Active questions across the organization's live projects, optionally leaving one project out. */
  async function activePromptCount({ exceptProjectId = null, db = prisma } = {}) {
    return db.prompts.count({
      where: {
        org_id: orgId,
        status: 'active',
        projects: { deleted_at: null, status: { not: 'archived' } },
        ...(exceptProjectId ? { project_id: { not: exceptProjectId } } : {}),
      },
    });
  }

  const billing = {
    /** Everything the billing screen and the guards need in one read. */
    async summary({ now = new Date(), enforced = true } = {}) {
      const org = await orgRow();
      const [plan, grants, subscription] = await Promise.all([
        planOf(org.plan_code),
        grantsOf(),
        prisma.subscriptions.findFirst({
          where: { org_id: orgId },
          orderBy: [{ updated_at: 'desc' }, { id: 'desc' }],
        }),
      ]);
      const limits = limitsFor(plan, grants, now, LIMIT_PLACEHOLDERS);
      const access = accessFor({
        enforced,
        billingStatus: org.billing_status,
        graceUntil: subscription?.grace_until ?? null,
        retainUntil: org.retain_until,
        now,
      });
      return {
        orgPublicId: org.public_id,
        planCode: org.plan_code,
        billingStatus: org.billing_status,
        stripeCustomerId: org.stripe_customer_id,
        // After a downgrade: when Claude stops being collected (null when no grace is running).
        claudeUntil: org.claude_until && org.claude_until > now ? org.claude_until : null,
        plan,
        grants: grants.filter((g) => !g.ends_at || g.ends_at > now),
        subscription: subscription && {
          provider: subscription.provider,
          currentPeriodStart: subscription.current_period_start,
          stripeSubscriptionId: subscription.stripe_subscription_id,
          status: subscription.status,
          trialEndsAt: subscription.trial_ends_at,
          currentPeriodEnd: subscription.current_period_end,
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
          graceUntil: subscription.grace_until,
          firstPaidAt: subscription.first_paid_at,
          moneyBackUntil: subscription.money_back_until,
        },
        limits,
        access,
      };
    },

    /** Only what the page banner needs: the access level, from two small reads. */
    async access({ now = new Date(), enforced = true } = {}) {
      const org = await orgRow();
      const subscription = await prisma.subscriptions.findFirst({
        where: { org_id: orgId },
        orderBy: [{ updated_at: 'desc' }, { id: 'desc' }],
        select: { grace_until: true },
      });
      return accessFor({
        enforced,
        billingStatus: org.billing_status,
        graceUntil: subscription?.grace_until ?? null,
        retainUntil: org.retain_until,
        now,
      });
    },

    /** What is used now, against the same meters as the limits. */
    async usage({ now = new Date() } = {}) {
      const period = monthStart(now);
      const [projects, prompts, members, pending, quota] = await Promise.all([
        liveProjectCount(),
        activePromptCount(),
        prisma.memberships.count({ where: { org_id: orgId } }),
        prisma.invitations.count({
          where: { org_id: orgId, status: 'pending', expires_at: { gt: now } },
        }),
        prisma.quota_usage.findMany({ where: { org_id: orgId, period_month: period } }),
      ]);
      const used = (meter) => Number(quota.find((q) => q.meter === meter)?.used_units ?? 0);
      return {
        projects,
        prompts,
        seats: members + pending,
        drafts: used('drafts'),
        runs_now: used('runs_now'),
      };
    },

    /** The limit for one meter. */
    limitFor: (meter, opts) => limitFor(meter, opts),

    /**
     * Can this organization add one more of `meter` (projects, seats)? Returns `{ allowed, used, limit, left }`.
     * Questions and drafts are checked where they are written, against the same `limitFor`.
     */
    async canAdd(meter, { want = 1, now = new Date() } = {}) {
      const usage = await billing.usage({ now });
      const limit = await limitFor(meter, { now });
      return checkLimit({ limit, used: usage[meter], want });
    },

    /**
     * How many more active questions this project may hold: the organization's limit minus the questions in its other
     * live projects. `null` when the plan does not limit questions.
     */
    async promptRoom(projectId, { now = new Date() } = {}) {
      const limit = await limitFor('prompts', { now });
      if (limit === null) return null;
      const elsewhere = await activePromptCount({ exceptProjectId: projectId });
      return Math.max(0, limit - elsewhere);
    },

    /**
     * May this organization use a plan feature? An organization with no plan yet (before billing is switched on, or
     * before it has chosen one) is not held back here: the access level handles that. One with a plan needs the switch.
     */
    async featureAllowed(name) {
      const org = await orgRow();
      if (!org.plan_code) return true;
      const plan = await planOf(org.plan_code);
      return Boolean(plan?.features?.[name]);
    },

    /** Is a plan feature switched on for this organization (`csv_export`, `alerts`, `client_seats`…)? */
    async feature(name) {
      const org = await orgRow();
      const plan = await planOf(org.plan_code);
      return Boolean(plan?.features?.[name]);
    },

    /**
     * Remember the Stripe customer made for this organization. Only the first one counts: a second call (two Checkout
     * clicks at once) returns the one already stored, so an organization never has two customers here.
     */
    async attachCustomer(customerId) {
      const org = await orgRow();
      if (org.stripe_customer_id) return org.stripe_customer_id;
      try {
        const done = await prisma.organizations.updateMany({
          where: { id: orgId, stripe_customer_id: null },
          data: { stripe_customer_id: customerId },
        });
        if (done.count === 1) return customerId;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        throw new DomainError('CUSTOMER_IN_USE');
      }
      return (await orgRow()).stripe_customer_id;
    },

    /** Add-ons currently on the subscription (for the billing screen). */
    async addons({ now = new Date() } = {}) {
      const rows = await prisma.entitlement_grants.findMany({
        where: {
          org_id: orgId,
          source: 'addon',
          OR: [{ ends_at: null }, { ends_at: { gt: now } }],
        },
        orderBy: { id: 'asc' },
      });
      return rows.map((g) => ({
        meter: g.meter,
        amount: g.amount,
        reason: g.reason,
        itemId: g.stripe_subscription_item_id,
      }));
    },

    /** Is a metered "extra drafts" add-on on the subscription right now? */
    async hasMeteredDrafts({ now = new Date(), db = prisma } = {}) {
      const grant = await db.entitlement_grants.findFirst({
        where: {
          org_id: orgId,
          source: 'addon',
          meter: 'drafts',
          amount: 0,
          OR: [{ ends_at: null }, { ends_at: { gt: now } }],
        },
        select: { id: true },
      });
      return Boolean(grant);
    },

    /** Staff-side note in this organization's own activity log. */
    note: (entry) => appendActivity(prisma, { actorType: 'system', ...entry }),
  };

  return { billing };
}
