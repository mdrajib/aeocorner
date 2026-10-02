import { toMicros } from '../../core/spend.js';
import { DomainError, isUniqueViolation } from '../errors.js';

/**
 * One organization's cost ledger, spend-cap state and in-app notifications. Merged into `forOrg(orgId)`; the
 * organization is bound once and no function takes an `org_id` argument (see org-scoped.js).
 *
 * `appendActivity` is passed in from org-scoped.js so changes to the pause state land in the same activity log
 * the Team page uses.
 */
export function usageRepos(prisma, orgId, { appendActivity }) {
  async function ownProject(projectId) {
    const found = await prisma.projects.findFirst({
      where: { id: projectId, org_id: orgId },
      select: { id: true },
    });
    if (!found) throw new DomainError('PROJECT_NOT_IN_ORG');
  }

  const usage = {
    /**
     * Write one paid call to the ledger. `idempotencyKey` is derived from the job, so a retried job writes the
     * same key again and nothing is counted twice: the second call returns the first row with `recorded: false`.
     */
    async record(entry) {
      const costMicros = toMicros(entry.costUsd);
      if (costMicros < 0) throw new DomainError('INVALID', 'A cost cannot be negative.');
      if (entry.projectId !== undefined && entry.projectId !== null) {
        await ownProject(entry.projectId);
      }
      const data = {
        org_id: orgId,
        project_id: entry.projectId ?? null,
        meter: entry.meter,
        provider_code: entry.providerCode,
        model: entry.model ?? null,
        quantity: entry.quantity ?? 1,
        unit: entry.unit,
        tokens_in: entry.tokensIn ?? null,
        tokens_out: entry.tokensOut ?? null,
        tokens_cached: entry.tokensCached ?? null,
        cost_usd: String(entry.costUsd),
        ref_type: entry.refType ?? null,
        ref_id: entry.refId ?? null,
        idempotency_key: entry.idempotencyKey,
        ...(entry.occurredAt ? { occurred_at: entry.occurredAt } : {}),
      };
      try {
        return { recorded: true, entry: await prisma.usage_ledger.create({ data }) };
      } catch (err) {
        if (!isUniqueViolation(err, 'uq_usage_ledger_idem')) throw err;
        // Only this organization's own row counts as "already written". A key that belongs to someone else is
        // reported as a clash, without saying whose it is.
        const existing = await prisma.usage_ledger.findFirst({
          where: { idempotency_key: entry.idempotencyKey, org_id: orgId },
        });
        if (!existing) throw new DomainError('KEY_IN_USE');
        return { recorded: false, entry: existing };
      }
    },

    /** Total spent since `since` (inclusive) in micro-dollars: whole numbers, so sums are exact. */
    async spentSinceMicros(since) {
      const { _sum } = await prisma.usage_ledger.aggregate({
        where: { org_id: orgId, occurred_at: { gte: since } },
        _sum: { cost_usd: true },
      });
      return toMicros(_sum.cost_usd?.toString() ?? '0');
    },

    recent: ({ limit = 50 } = {}) =>
      prisma.usage_ledger.findMany({
        where: { org_id: orgId },
        orderBy: [{ occurred_at: 'desc' }, { id: 'desc' }],
        take: Math.min(limit, 500),
      }),
  };

  const spend = {
    /** What the spend guard needs to decide: the plan, the organization's own cap, and any current pause. */
    async state() {
      const org = await prisma.organizations.findUnique({
        where: { id: orgId },
        select: { plan_code: true, spend_cap_usd_daily: true, collection_paused_until: true },
      });
      if (!org) throw new DomainError('NOT_FOUND');
      return {
        planCode: org.plan_code,
        orgCapUsd: org.spend_cap_usd_daily?.toString() ?? null,
        pausedUntil: org.collection_paused_until,
      };
    },

    /**
     * Stop collection for this organization until `until` (the spend cap was reached). Returns true only if
     * this call is the one that paused it, so when a retried job and the 15-minute guard hit the cap at the
     * same moment, exactly one of them sends the notices.
     */
    async pause({ until, now, spentUsd, capUsd }) {
      return prisma.$transaction(async (tx) => {
        const { count } = await tx.organizations.updateMany({
          where: {
            id: orgId,
            OR: [{ collection_paused_until: null }, { collection_paused_until: { lte: now } }],
          },
          data: { collection_paused_until: until },
        });
        if (count === 0) return false;
        await appendActivity(tx, {
          actorType: 'system',
          action: 'collection.paused',
          summary: 'Collection paused: the daily spend cap was reached',
          metadata: { until: until.toISOString(), spentUsd, capUsd },
        });
        return true;
      });
    },

    /** Let collection continue (the day rolled over, or the cap was raised). */
    async resume({ reason }) {
      return prisma.$transaction(async (tx) => {
        const { count } = await tx.organizations.updateMany({
          where: { id: orgId, collection_paused_until: { not: null } },
          data: { collection_paused_until: null },
        });
        if (count > 0) {
          await appendActivity(tx, {
            actorType: 'system',
            action: 'collection.resumed',
            summary: 'Collection resumed',
            metadata: { reason },
          });
        }
        return count > 0;
      });
    },
  };

  const notifications = {
    /**
     * Tell one member something, once. `dedupeKey` makes it idempotent, so a retried job or a second guard run
     * never sends the same notice twice: the repeat returns `{ created: false }`. Keys are per organization.
     */
    async createOnce({
      userId,
      kind,
      dedupeKey,
      subject,
      payload,
      channel = 'in_app',
      category = 'transactional',
      projectId,
    }) {
      const member = await prisma.memberships.findFirst({
        where: { org_id: orgId, user_id: userId },
        select: { id: true },
      });
      if (!member) throw new DomainError('NOT_MEMBER');
      try {
        const created = await prisma.notifications.create({
          data: {
            org_id: orgId,
            user_id: userId,
            project_id: projectId ?? null,
            channel,
            category,
            kind,
            // The column is unique across the whole table; prefixing the organization keeps one tenant's keys from
            // colliding with, or revealing, another's.
            dedupe_key: `o${orgId}:${dedupeKey}`.slice(0, 191),
            subject: subject ?? null,
            payload: payload ?? undefined,
            // In-app messages have nothing to deliver: they are visible the moment they exist.
            ...(channel === 'in_app' ? { status: 'delivered', sent_at: new Date() } : {}),
          },
        });
        return { created: true, notification: created };
      } catch (err) {
        if (isUniqueViolation(err, 'uq_notifications_dedupe')) return { created: false };
        throw err;
      }
    },

    forUser: (userId, { limit = 50 } = {}) =>
      prisma.notifications.findMany({
        where: { org_id: orgId, user_id: userId },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: Math.min(limit, 200),
      }),
  };

  return { usage, spend, notifications };
}
