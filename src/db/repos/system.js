import { nextDueHorizon } from '../../core/outcomes.js';
import { toMicros } from '../../core/spend.js';
import { isForeignKeyViolation } from '../errors.js';

/**
 * Lookups the background worker makes ACROSS organizations, by design: "which projects are due this hour",
 * "who has spent money today", "what is each provider's health".
 *
 * These are the one place outside `forOrg()` that reads tenant tables without an organization bound, so the
 * set is kept small, read-only where it touches tenant data, and listed in tests/tenancy (the coverage test
 * fails if a function is added without being reviewed there). They return IDs and numbers the worker needs to
 * hand each job to the right `forOrg(orgId)`; nothing here returns tenant content.
 */
export function systemRepos(prisma) {
  const scheduling = {
    /**
     * Active projects whose weekly slot is `hour` (0-167). Skips archived and deleted projects and deleted
     * organizations. Returns only what is needed to enqueue the run.
     */
    async dueProjects({ hour }) {
      const rows = await prisma.projects.findMany({
        where: {
          weekly_slot_hour: hour,
          status: 'active',
          deleted_at: null,
          organizations: { deleted_at: null },
        },
        select: { id: true, public_id: true, org_id: true },
        orderBy: { id: 'asc' },
      });
      return rows.map((r) => ({ projectId: r.id, projectPublicId: r.public_id, orgId: r.org_id }));
    },
  };

  const spendMonitor = {
    /** Every organization with ledger rows since `since`, and what it has spent, in micro-dollars. */
    async spentByOrgSince(since) {
      const rows = await prisma.usage_ledger.groupBy({
        by: ['org_id'],
        where: { occurred_at: { gte: since }, org_id: { not: null } },
        _sum: { cost_usd: true },
      });
      return rows.map((r) => ({
        orgId: r.org_id,
        spentMicros: toMicros(r._sum.cost_usd?.toString() ?? '0'),
      }));
    },

    /** Organizations whose collection is currently marked paused (so the guard can lift it). */
    async pausedOrgIds() {
      const rows = await prisma.organizations.findMany({
        where: { collection_paused_until: { not: null } },
        select: { id: true },
      });
      return rows.map((r) => r.id);
    },
  };

  const providerHealth = {
    /** Provider codes that exist in `providers`, so health rows are only written for real providers. */
    async knownProviders() {
      const rows = await prisma.providers.findMany({ select: { code: true } });
      return new Set(rows.map((r) => r.code));
    },

    /**
     * Write (or refresh) one 5-minute health bucket. The bucket's counters live in Redis while it is open, so
     * this is called repeatedly with growing numbers: one row per provider, engine and bucket, last write wins.
     * `INSERT … ON DUPLICATE KEY UPDATE` because Prisma's `upsert` is not atomic on MySQL.
     */
    async upsertBucket(b) {
      try {
        await prisma.$executeRaw`
          INSERT INTO provider_health
            (provider_code, engine_code, bucket_start, requests, successes, failures, timeouts,
             p50_ms, p95_ms, cost_usd, breaker_state)
          VALUES
            (${b.providerCode}, ${b.engineCode}, ${b.bucketStart}, ${b.requests}, ${b.successes},
             ${b.failures}, ${b.timeouts}, ${b.p50Ms}, ${b.p95Ms}, ${b.costUsd}, ${b.breakerState})
          ON DUPLICATE KEY UPDATE
            requests = VALUES(requests), successes = VALUES(successes), failures = VALUES(failures),
            timeouts = VALUES(timeouts), p50_ms = VALUES(p50_ms), p95_ms = VALUES(p95_ms),
            cost_usd = VALUES(cost_usd), breaker_state = VALUES(breaker_state)`;
        return true;
      } catch (err) {
        // A provider that isn't in the providers table (a test double, a typo) has no health row. Not an error.
        if (isForeignKeyViolation(err)) return false;
        throw err;
      }
    },

    recent: ({ providerCode, limit = 100 }) =>
      prisma.provider_health.findMany({
        where: { provider_code: providerCode },
        orderBy: { bucket_start: 'desc' },
        take: Math.min(limit, 1000),
      }),
  };

  const outcomes = {
    /**
     * Recommendations that are measuring and have a before/after check due: only IDs, so the worker can hand each to its
     * organization's `forOrg().outcomes.measure`.
     */
    async due({ now = new Date(), limit = 500 } = {}) {
      const rows = await prisma.recommendations.findMany({
        where: {
          status: 'measuring',
          measuring_started_at: { not: null },
          projects: { deleted_at: null, organizations: { deleted_at: null } },
        },
        select: {
          id: true,
          org_id: true,
          project_id: true,
          measuring_started_at: true,
          action_outcomes: { select: { horizon: true } },
        },
        orderBy: { id: 'asc' },
        take: limit,
      });
      return rows
        .filter(
          (r) =>
            nextDueHorizon({
              startedAt: r.measuring_started_at,
              have: r.action_outcomes.map((o) => o.horizon),
              now,
            }) !== null,
        )
        .map((r) => ({ orgId: r.org_id, projectId: r.project_id, recommendationId: r.id }));
    },

    /**
     * How each rule's fixes have turned out across every project: `{ [ruleCode]: { wins, decided } }`. Counts only, no
     * tenant content; it is what recalibrates a rule's confidence (core/ice.js). A fix that ended for lack of data is
     * not counted as "decided": it says nothing about whether the rule works.
     */
    async ruleStats() {
      const rows = await prisma.$queryRaw`
        SELECT r.rule_code AS rule_code,
               SUM(CASE WHEN o.verdict = 'proven_win' THEN 1 ELSE 0 END) AS wins,
               COUNT(*) AS decided
        FROM action_outcomes o
        JOIN recommendations r ON r.id = o.recommendation_id
        JOIN (SELECT recommendation_id, MAX(id) AS last_id FROM action_outcomes GROUP BY recommendation_id) l
          ON l.last_id = o.id
        WHERE r.status IN ('proven_win', 'no_change', 'declined')
          AND o.verdict IN ('proven_win', 'no_change', 'declined')
        GROUP BY r.rule_code`;
      return Object.fromEntries(
        rows.map((r) => [r.rule_code, { wins: Number(r.wins), decided: Number(r.decided) }]),
      );
    },
  };

  const verifications = {
    /**
     * Re-check attempts that should have run by now and did not (their delayed job was lost, say): the safety net
     * behind the job queue. Only attempts of fixes still waiting on the check.
     */
    async overdue({ now = new Date(), graceMs = 10 * 60_000, limit = 200 } = {}) {
      const rows = await prisma.fix_verifications.findMany({
        where: {
          status: 'pending',
          scheduled_for: { lt: new Date(now.getTime() - graceMs) },
          recommendations: { status: 'done' },
        },
        select: { org_id: true, recommendation_id: true, attempt: true },
        orderBy: { id: 'asc' },
        take: limit,
      });
      return rows.map((r) => ({
        orgId: r.org_id,
        recommendationId: r.recommendation_id,
        attempt: r.attempt,
      }));
    },
  };

  return { scheduling, spendMonitor, providerHealth, outcomes, verifications };
}
