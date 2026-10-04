import { canShare } from '../../core/proof-share.js';
import { ulid } from '../../lib/ulid.js';
import { DomainError, isUniqueViolation } from '../errors.js';

/**
 * One organization's shared proof cards (UI_DESIGN D4). Merged into `forOrg(orgId)` as `proofShares`. The organization is
 * bound once and no function takes an `org_id` from its arguments.
 *
 * A share is one row per outcome. Stopping it sets `revoked_at`; sharing again makes a NEW address, so a link that was
 * stopped stays dead. Only a proven win can be shared (`canShare`). The public page itself is read through
 * `db.system.proofShares.byPublicId`, the one reviewed cross-organization lookup.
 */

const toShare = (s) => ({
  id: s.id,
  outcomeId: s.outcome_id,
  publicId: s.public_id,
  sharedAt: s.shared_at,
  revokedAt: s.revoked_at,
});

export function proofShareRepos(prisma, orgId) {
  async function ownProject(projectId) {
    const project = await prisma.projects.findFirst({
      where: { id: projectId, org_id: orgId, deleted_at: null },
      select: { id: true },
    });
    if (!project) throw new DomainError('PROJECT_NOT_IN_ORG');
    return project;
  }

  /** The outcome of this recommendation in this project and organization, or a plain "not found". */
  async function ownOutcome(projectId, recId, outcomeId) {
    const row = await prisma.action_outcomes.findFirst({
      where: { id: outcomeId, recommendation_id: recId, project_id: projectId, org_id: orgId },
    });
    if (!row) throw new DomainError('OUTCOME_NOT_FOUND');
    return row;
  }

  const proofShares = {
    /** The addresses currently live for a recommendation's outcomes (a stopped share is not listed). */
    async forRecommendation(projectId, recId) {
      await ownProject(projectId);
      const rows = await prisma.proof_shares.findMany({
        where: {
          org_id: orgId,
          project_id: projectId,
          revoked_at: null,
          action_outcomes: { recommendation_id: recId, org_id: orgId },
        },
        orderBy: { id: 'asc' },
      });
      return rows.map(toShare);
    },

    /**
     * Make an outcome's public address. Sharing what is already shared changes nothing (a double click must not break a
     * link someone has just copied); sharing after a stop makes a new address.
     *
     * @returns `{ publicId, created }`
     */
    async share(projectId, recId, outcomeId, { userId, now = new Date() } = {}) {
      await ownProject(projectId);
      const outcome = await ownOutcome(projectId, recId, outcomeId);
      if (!canShare({ verdict: outcome.verdict, engineScope: outcome.engine_scope })) {
        throw new DomainError('NOT_SHAREABLE', 'Only a proven win can be shared.');
      }
      const existing = () =>
        prisma.proof_shares.findFirst({ where: { outcome_id: outcome.id, org_id: orgId } });
      const live = await existing();
      if (live && !live.revoked_at) return { publicId: live.public_id, created: false };

      if (live) {
        // Stopped before: a fresh address, and only if nobody revived it first.
        const publicId = ulid(now.getTime());
        const revived = await prisma.proof_shares.updateMany({
          where: { id: live.id, org_id: orgId, revoked_at: { not: null } },
          data: {
            public_id: publicId,
            revoked_at: null,
            shared_at: now,
            created_by_user_id: userId ?? null,
          },
        });
        if (revived.count === 1) return { publicId, created: true };
        return { publicId: (await existing()).public_id, created: false };
      }

      const publicId = ulid(now.getTime());
      try {
        await prisma.proof_shares.create({
          data: {
            org_id: orgId,
            project_id: projectId,
            outcome_id: outcome.id,
            public_id: publicId,
            created_by_user_id: userId ?? null,
            shared_at: now,
          },
        });
        return { publicId, created: true };
      } catch (err) {
        // Two clicks at once: the unique key held, so the other one's address is the answer.
        if (!isUniqueViolation(err)) throw err;
        return { publicId: (await existing()).public_id, created: false };
      }
    },

    /** Stop sharing: the address answers "not found" from now on. @returns `{ revoked }` (false if it was not live) */
    async revoke(projectId, recId, outcomeId, { now = new Date() } = {}) {
      await ownProject(projectId);
      const outcome = await ownOutcome(projectId, recId, outcomeId);
      const result = await prisma.proof_shares.updateMany({
        where: { outcome_id: outcome.id, org_id: orgId, project_id: projectId, revoked_at: null },
        data: { revoked_at: now },
      });
      return { revoked: result.count === 1 };
    },
  };

  return { proofShares };
}
