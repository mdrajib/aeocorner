import { DomainError, isForeignKeyViolation, isUniqueViolation } from '../errors.js';
import { extractionRepos } from './org-extractions.js';
import { scanRepos } from './org-scans.js';
import { snapshotRepos } from './org-snapshots.js';
import { usageRepos } from './org-usage.js';
import { transaction } from '../transaction.js';

/**
 * Repositories for one organization's data. `forOrg(orgId)` binds the organization once, and every
 * query below filters on it; no function takes an `org_id` from its arguments. That is the runtime layer
 * of tenant isolation (DATABASE_SCHEMA §6). The cross-tenant suite in tests/tenancy calls every function
 * here as the wrong organization and checks that nothing leaks.
 *
 * `orgId` must come from `organizationsRepo.findForUser()`, which proves the signed-in user is a member.
 */
export function orgScopedRepos(prisma, orgId) {
  const OWNER_ROLES = ['owner', 'admin'];

  /** Lock the organization's owner rows so two concurrent demotions can't both succeed. */
  async function lockedOwnerCount(tx) {
    const rows = await tx.$queryRaw`
      SELECT id FROM memberships WHERE org_id = ${orgId} AND role = 'owner' FOR UPDATE`;
    return rows.length;
  }

  async function appendActivity(tx, entry) {
    await tx.org_activity_log.create({
      data: {
        org_id: orgId,
        actor_type: entry.actorType ?? 'user',
        actor_user_id: entry.actorUserId ?? null,
        action: entry.action,
        target_type: entry.targetType ?? null,
        target_id: entry.targetId ?? null,
        summary: String(entry.summary).slice(0, 500),
        metadata: entry.metadata ?? undefined,
        ip: entry.ip ?? null,
      },
    });
  }

  /** Projects in this organization among `projectIds`. The composite FK is the backstop; this gives a clear error. */
  async function ownProjectIds(tx, projectIds) {
    if (projectIds.length === 0) return [];
    const rows = await tx.projects.findMany({
      where: { org_id: orgId, id: { in: projectIds } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  async function writeProjectAccess(tx, membership, access, projectIds) {
    if (access === 'selected' && OWNER_ROLES.includes(membership.role)) {
      throw new DomainError('ACCESS_NEEDS_ALL', 'Owners and admins always see every project.');
    }
    const wanted = [...new Set(projectIds)];
    if (access === 'selected') {
      const found = await ownProjectIds(tx, wanted);
      if (found.length !== wanted.length) {
        throw new DomainError(
          'PROJECT_NOT_IN_ORG',
          'A selected project is not in this organization.',
        );
      }
    }
    await tx.membership_projects.deleteMany({ where: { membership_id: membership.id } });
    await tx.memberships.update({ where: { id: membership.id }, data: { project_access: access } });
    if (access === 'selected' && wanted.length) {
      try {
        await tx.membership_projects.createMany({
          data: wanted.map((project_id) => ({
            membership_id: membership.id,
            project_id,
            org_id: orgId,
          })),
        });
      } catch (err) {
        if (isForeignKeyViolation(err)) throw new DomainError('PROJECT_NOT_IN_ORG');
        throw err;
      }
    }
  }

  const memberships = {
    async list() {
      const rows = await prisma.memberships.findMany({
        where: { org_id: orgId, users: { deleted_at: null } },
        include: { users: true, membership_projects: { select: { project_id: true } } },
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      });
      return rows.map(({ users: user, membership_projects: mp, ...membership }) => ({
        ...membership,
        user,
        projectIds: mp.map((p) => p.project_id),
      }));
    },

    get: (membershipId) =>
      prisma.memberships.findFirst({ where: { id: membershipId, org_id: orgId } }),

    getByUser: (userId) =>
      prisma.memberships.findFirst({ where: { user_id: userId, org_id: orgId } }),

    /** Add a member (used when an invitation is accepted). Adding the same person twice is an error. */
    async add({ userId, role, projectAccess = 'all', projectIds = [], actorUserId, summary }) {
      try {
        return await transaction(prisma, async (tx) => {
          const membership = await tx.memberships.create({
            data: { org_id: orgId, user_id: userId, role, project_access: 'all' },
          });
          if (projectAccess === 'selected') {
            await writeProjectAccess(tx, membership, 'selected', projectIds);
          }
          await appendActivity(tx, {
            actorUserId,
            action: 'member.added',
            targetType: 'membership',
            targetId: membership.id,
            summary: summary ?? `A member was added as ${role}`,
          });
          return membership;
        });
      } catch (err) {
        if (isUniqueViolation(err, 'uq_memberships_org_user'))
          throw new DomainError('ALREADY_MEMBER');
        throw err;
      }
    },

    /**
     * Change a member's role. The organization must always keep at least one owner, so demoting the last
     * one fails, even when two owners demote each other at the same moment (the owner rows are locked).
     */
    async changeRole({ membershipId, role, actorUserId }) {
      return transaction(prisma, async (tx) => {
        const owners = await lockedOwnerCount(tx);
        const target = await tx.memberships.findFirst({
          where: { id: membershipId, org_id: orgId },
        });
        if (!target) throw new DomainError('NOT_FOUND');
        if (target.role === role) return target;
        if (target.role === 'owner' && owners <= 1) throw new DomainError('LAST_OWNER');

        const updated = await tx.memberships.update({ where: { id: target.id }, data: { role } });
        if (OWNER_ROLES.includes(role) && target.project_access === 'selected') {
          await writeProjectAccess(tx, updated, 'all', []);
        }
        await appendActivity(tx, {
          actorUserId,
          action: 'member.role_changed',
          targetType: 'membership',
          targetId: target.id,
          summary: `A member's role changed from ${target.role} to ${role}`,
          metadata: { from: target.role, to: role },
        });
        return updated;
      });
    },

    async remove({ membershipId, actorUserId }) {
      return transaction(prisma, async (tx) => {
        const owners = await lockedOwnerCount(tx);
        const target = await tx.memberships.findFirst({
          where: { id: membershipId, org_id: orgId },
        });
        if (!target) throw new DomainError('NOT_FOUND');
        if (target.role === 'owner' && owners <= 1) throw new DomainError('LAST_OWNER');

        await tx.memberships.delete({ where: { id: target.id } });
        // The removed person's "last opened" organization must not point at somewhere they can't go.
        await tx.users.updateMany({
          where: { id: target.user_id, last_org_id: orgId },
          data: { last_org_id: null },
        });
        await appendActivity(tx, {
          actorUserId,
          action: 'member.removed',
          targetType: 'membership',
          targetId: target.id,
          summary: 'A member was removed',
          metadata: { role: target.role },
        });
        return target;
      });
    },

    /** Which projects a member can see: everything, or only the listed ones (agency client seats). */
    async setProjectAccess({ membershipId, access, projectIds = [], actorUserId }) {
      return transaction(prisma, async (tx) => {
        const target = await tx.memberships.findFirst({
          where: { id: membershipId, org_id: orgId },
        });
        if (!target) throw new DomainError('NOT_FOUND');
        await writeProjectAccess(tx, target, access, projectIds);
        await appendActivity(tx, {
          actorUserId,
          action: 'member.access_changed',
          targetType: 'membership',
          targetId: target.id,
          summary:
            access === 'all'
              ? 'A member can see every project'
              : 'A member is limited to selected projects',
        });
        return tx.memberships.findFirst({ where: { id: target.id, org_id: orgId } });
      });
    },
  };

  const invitations = {
    /**
     * Invite someone by email. One live invitation per address: inviting again cancels the earlier one,
     * so only the newest emailed link works.
     */
    async create({
      email,
      role,
      projectAccess = 'all',
      projectIds = [],
      inviterUserId,
      tokenHash,
      expiresAt,
    }) {
      const address = String(email).trim().toLowerCase();
      return transaction(prisma, async (tx) => {
        const existingMember = await tx.memberships.findFirst({
          where: { org_id: orgId, users: { email: address, deleted_at: null } },
        });
        if (existingMember) throw new DomainError('ALREADY_MEMBER');

        if (projectAccess === 'selected') {
          if (OWNER_ROLES.includes(role)) throw new DomainError('ACCESS_NEEDS_ALL');
          const found = await ownProjectIds(tx, projectIds);
          if (found.length !== new Set(projectIds).size || found.length === 0) {
            throw new DomainError(
              'PROJECT_NOT_IN_ORG',
              'Choose at least one project in this organization.',
            );
          }
        }

        await tx.invitations.updateMany({
          where: { org_id: orgId, email: address, status: 'pending' },
          data: { status: 'canceled' },
        });
        const invitation = await tx.invitations.create({
          data: {
            org_id: orgId,
            email: address,
            role,
            project_access: projectAccess,
            project_ids: projectAccess === 'selected' ? projectIds.map(String) : undefined,
            token_hash: tokenHash,
            inviter_user_id: inviterUserId,
            expires_at: expiresAt,
          },
        });
        await appendActivity(tx, {
          actorUserId: inviterUserId,
          action: 'invitation.sent',
          targetType: 'invitation',
          targetId: invitation.id,
          summary: `An invitation was sent as ${role}`,
          metadata: { role },
        });
        return invitation;
      });
    },

    /** Invitations still waiting for an answer and not past their expiry. */
    listPending: () =>
      prisma.invitations.findMany({
        where: { org_id: orgId, status: 'pending', expires_at: { gt: new Date() } },
        orderBy: { created_at: 'desc' },
      }),

    get: (invitationId) =>
      prisma.invitations.findFirst({ where: { id: invitationId, org_id: orgId } }),

    async cancel({ invitationId, actorUserId }) {
      return transaction(prisma, async (tx) => {
        const result = await tx.invitations.updateMany({
          where: { id: invitationId, org_id: orgId, status: 'pending' },
          data: { status: 'canceled' },
        });
        if (result.count === 0) throw new DomainError('NOT_FOUND');
        await appendActivity(tx, {
          actorUserId,
          action: 'invitation.canceled',
          targetType: 'invitation',
          targetId: invitationId,
          summary: 'An invitation was canceled',
        });
      });
    },

    /** Replace the link in an invitation (for "resend"): the old link stops working, the expiry restarts. */
    async reissue({ invitationId, tokenHash, expiresAt, actorUserId }) {
      return transaction(prisma, async (tx) => {
        const result = await tx.invitations.updateMany({
          where: { id: invitationId, org_id: orgId, status: 'pending' },
          data: { token_hash: tokenHash, expires_at: expiresAt },
        });
        if (result.count === 0) throw new DomainError('NOT_FOUND');
        await appendActivity(tx, {
          actorUserId,
          action: 'invitation.resent',
          targetType: 'invitation',
          targetId: invitationId,
          summary: 'An invitation was sent again',
        });
        return tx.invitations.findFirst({ where: { id: invitationId, org_id: orgId } });
      });
    },
  };

  const activity = {
    append: (entry) => appendActivity(prisma, entry),
    recent: ({ limit = 50 } = {}) =>
      prisma.org_activity_log.findMany({
        where: { org_id: orgId },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: Math.min(limit, 200),
      }),
  };

  return {
    orgId,
    memberships,
    invitations,
    activity,
    ...usageRepos(prisma, orgId, { appendActivity }),
    ...scanRepos(prisma, orgId),
    ...snapshotRepos(prisma, orgId),
    ...extractionRepos(prisma, orgId),
  };
}
