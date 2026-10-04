import { DomainError } from '../errors.js';
import { transaction } from '../transaction.js';

/**
 * One organization's auto-fixes (UI_DESIGN D3): a change the customer previewed and approved, to be written to their
 * site by the plugin. Merged into `forOrg(orgId)` as `autofix`. The organization is bound once and no function takes an
 * `org_id` from its arguments.
 *
 * A fix is a `site_changes` row: `approved` the moment a person approves the exact data they saw, then `applying`,
 * then `applied` or `failed`. The recommendation's own moves (start, done, the re-check) stay in `recommendations`:
 * this file never changes a recommendation's status, so the lifecycle table is the only thing that does.
 */

const toJson = (v) => JSON.parse(JSON.stringify(v));

const toChange = (s) => ({
  id: s.id,
  kind: s.kind,
  status: s.status,
  targetUrl: s.target_url,
  payload: s.payload,
  recommendationId: s.recommendation_id,
  approvedByUserId: s.approved_by_user_id,
  approvedAt: s.approved_at,
  appliedAt: s.applied_at,
  lastError: s.last_error,
  attempts: s.attempts,
  createdAt: s.created_at,
});

/** The fix is still in flight: approved and waiting, or being written. */
const ACTIVE = ['approved', 'applying'];

export function autofixRepos(prisma, orgId) {
  async function ownProject(projectId) {
    const project = await prisma.projects.findFirst({
      where: { id: projectId, org_id: orgId, deleted_at: null },
      select: { id: true },
    });
    if (!project) throw new DomainError('PROJECT_NOT_IN_ORG');
    return project;
  }

  /** The nodes the plugin holds for an address: those of the latest change that was applied there. */
  async function appliedNodes(db, projectId, targetUrl) {
    const row = await db.site_changes.findFirst({
      where: {
        org_id: orgId,
        project_id: projectId,
        kind: 'jsonld',
        target_url: targetUrl,
        status: 'applied',
      },
      orderBy: { id: 'desc' },
    });
    const nodes = row?.payload?.jsonld?.['@graph'];
    return Array.isArray(nodes) ? nodes : [];
  }

  const autofix = {
    /** The latest change made for a recommendation, or null. */
    async current(projectId, recommendationId) {
      await ownProject(projectId);
      const row = await prisma.site_changes.findFirst({
        where: {
          org_id: orgId,
          project_id: projectId,
          recommendation_id: recommendationId,
          kind: 'jsonld',
        },
        orderBy: { id: 'desc' },
      });
      return row ? toChange(row) : null;
    },

    /** What is on the home page now, as nodes: the base a new fix builds on. */
    async appliedNodes(projectId, targetUrl) {
      await ownProject(projectId);
      return appliedNodes(prisma, projectId, targetUrl);
    },

    /**
     * A person approved exactly this data. Refused if the recommendation is not open or in progress, if the plugin is not
     * connected, or if an earlier approval for it is still being written. Returns the change to queue.
     */
    async approve(
      projectId,
      recommendationId,
      { userId, targetUrl, jsonld, hash, ruleCode, now = new Date() },
    ) {
      await ownProject(projectId);
      if (!userId) throw new DomainError('APPROVAL_NEEDS_A_PERSON');
      return transaction(prisma, async (tx) => {
        const rec = await tx.recommendations.findFirst({
          where: { id: recommendationId, org_id: orgId, project_id: projectId },
          select: { id: true, status: true, rule_code: true },
        });
        if (!rec) throw new DomainError('RECOMMENDATION_NOT_FOUND');
        if (rec.rule_code !== ruleCode || !['open', 'in_progress'].includes(rec.status)) {
          throw new DomainError('STALE_STATUS');
        }
        const integration = await tx.integrations.findFirst({
          where: { org_id: orgId, project_id: projectId, type: 'wordpress', status: 'connected' },
        });
        if (!integration) throw new DomainError('WORDPRESS_NOT_CONNECTED');
        if (!integration.config?.pluginConnected) throw new DomainError('PLUGIN_NOT_CONNECTED');
        const active = await tx.site_changes.count({
          where: {
            org_id: orgId,
            project_id: projectId,
            recommendation_id: recommendationId,
            status: { in: ACTIVE },
          },
        });
        if (active > 0) throw new DomainError('ALREADY_APPROVED');
        const before = await appliedNodes(tx, projectId, targetUrl);
        const change = await tx.site_changes.create({
          data: {
            org_id: orgId,
            project_id: projectId,
            integration_id: integration.id,
            recommendation_id: recommendationId,
            kind: 'jsonld',
            target_url: targetUrl,
            payload: toJson({ ruleCode, jsonld, hash }),
            previous_value: toJson({ nodes: before }),
            status: 'approved',
            approved_by_user_id: userId,
            approved_at: now,
            created_at: now,
          },
        });
        return { siteChangeId: change.id };
      });
    },

    /** What the apply job needs, or null if the change is not this organization's. */
    async forApply(projectId, siteChangeId) {
      await ownProject(projectId);
      const row = await prisma.site_changes.findFirst({
        where: { id: siteChangeId, org_id: orgId, project_id: projectId, kind: 'jsonld' },
      });
      return row ? toChange(row) : null;
    },

    async markApplying(projectId, siteChangeId) {
      await ownProject(projectId);
      const r = await prisma.site_changes.updateMany({
        where: {
          id: siteChangeId,
          org_id: orgId,
          project_id: projectId,
          status: { in: ACTIVE },
        },
        data: { status: 'applying', attempts: { increment: 1 } },
      });
      return r.count === 1;
    },

    /** The write finished. Only a change that is still approved or applying can be finished: a finished one is final. */
    async finish(projectId, siteChangeId, { ok, error = null, now = new Date() }) {
      await ownProject(projectId);
      const r = await prisma.site_changes.updateMany({
        where: {
          id: siteChangeId,
          org_id: orgId,
          project_id: projectId,
          status: { in: ACTIVE },
        },
        data: ok
          ? { status: 'applied', applied_at: now, last_error: null }
          : {
              status: 'failed',
              last_error: String(error ?? 'The change could not be applied').slice(0, 1000),
            },
      });
      return r.count === 1;
    },
  };

  return { autofix };
}
