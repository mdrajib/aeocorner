import { isUniqueViolation } from '../errors.js';

const LOGIN_TOUCH_INTERVAL_MS = 10 * 60 * 1000;

const toDate = (value) => (value instanceof Date ? value : new Date(value));

/** What we copy from a Clerk user. `updatedAt` is Clerk's own timestamp (ms or Date). */
function clerkFields(clerkUser) {
  return {
    email: String(clerkUser.email ?? '')
      .trim()
      .toLowerCase()
      .slice(0, 320),
    name: String(clerkUser.name ?? '')
      .trim()
      .slice(0, 128),
    image_url: clerkUser.imageUrl ? String(clerkUser.imageUrl).slice(0, 1024) : null,
    clerk_updated_at: toDate(clerkUser.updatedAt ?? Date.now()),
  };
}

/**
 * `users` is global on purpose (DATABASE_SCHEMA §6): one person can belong to several organizations.
 * Access to anything tenant-owned always goes through `memberships`, never through this table.
 */
export function usersRepo(prisma) {
  const findByClerkId = (clerkUserId) =>
    prisma.users.findUnique({ where: { clerk_user_id: String(clerkUserId) } });

  /**
   * The Clerk webhook and the first page view can both try to create the same user, and either can
   * win (DATABASE_SCHEMA §10.1). The loser hits the unique key, then reads the winner's row.
   */
  async function createFromClerk(clerkUser) {
    try {
      return await prisma.users.create({
        data: { clerk_user_id: String(clerkUser.id), ...clerkFields(clerkUser) },
      });
    } catch (err) {
      if (!isUniqueViolation(err, 'uq_users_clerk')) throw err;
      return findByClerkId(clerkUser.id);
    }
  }

  return {
    findByClerkId,
    findById: (id) => prisma.users.findUnique({ where: { id } }),

    /** Lazy create for the first request. Returns null for a user we already anonymized. */
    async getOrCreateFromClerk(clerkUser) {
      const existing = await findByClerkId(clerkUser.id);
      if (existing) return existing.deleted_at ? null : existing;
      const created = await createFromClerk(clerkUser);
      return created?.deleted_at ? null : created;
    },

    /**
     * Apply a `user.created` / `user.updated` event. Clerk can deliver events twice or out of order, so an
     * event is applied only if it is newer than what we already hold, and never to a deleted user.
     * @returns {Promise<'created'|'applied'|'stale'|'deleted'>}
     */
    async applyClerkUpdate(clerkUser) {
      const fields = clerkFields(clerkUser);
      const applied = await prisma.users.updateMany({
        where: {
          clerk_user_id: String(clerkUser.id),
          deleted_at: null,
          OR: [{ clerk_updated_at: null }, { clerk_updated_at: { lt: fields.clerk_updated_at } }],
        },
        data: fields,
      });
      if (applied.count > 0) return 'applied';

      const existing = await findByClerkId(clerkUser.id);
      if (!existing) {
        await createFromClerk(clerkUser);
        return 'created';
      }
      return existing.deleted_at ? 'deleted' : 'stale';
    },

    /**
     * `user.deleted`: keep the row (history keeps its IDs), clear everything personal, and remove the
     * person from every organization (DATABASE_SCHEMA §10.1). A repeat is a no-op.
     * @returns {Promise<{ status: 'deleted'|'missing'|'already', orphanedOrgIds: bigint[] }>}
     */
    async markDeleted(clerkUserId) {
      return prisma.$transaction(async (tx) => {
        const user = await tx.users.findUnique({ where: { clerk_user_id: String(clerkUserId) } });
        if (!user) return { status: 'missing', orphanedOrgIds: [] };
        if (user.deleted_at) return { status: 'already', orphanedOrgIds: [] };

        const owned = await tx.memberships.findMany({
          where: { user_id: user.id, role: 'owner' },
          select: { org_id: true },
        });
        await tx.memberships.deleteMany({ where: { user_id: user.id } });
        await tx.users.update({
          where: { id: user.id },
          data: {
            email: `deleted-${user.id}@deleted.invalid`,
            name: '',
            image_url: null,
            last_org_id: null,
            deleted_at: new Date(),
          },
        });

        // An organization whose last owner just left has nobody who can manage it. Report it so the
        // caller can alert staff; the data stays, and retention rules decide what happens next.
        const orphanedOrgIds = [];
        for (const { org_id } of owned) {
          const remaining = await tx.memberships.count({ where: { org_id, role: 'owner' } });
          if (remaining === 0) orphanedOrgIds.push(org_id);
        }
        return { status: 'deleted', orphanedOrgIds };
      });
    },

    /** Record a sign-in, but at most every ten minutes so a busy session isn't a write per page. */
    async touchLogin(user) {
      const last = user.last_login_at?.getTime() ?? 0;
      if (Date.now() - last < LOGIN_TOUCH_INTERVAL_MS) return;
      await prisma.users.update({ where: { id: user.id }, data: { last_login_at: new Date() } });
    },

    setLastOrg: (userId, orgId) =>
      prisma.users.update({ where: { id: userId }, data: { last_org_id: orgId } }),
  };
}
