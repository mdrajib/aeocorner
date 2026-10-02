import { slugify, withSuffix } from '../../lib/slug.js';
import { ulid } from '../../lib/ulid.js';
import { DomainError, isUniqueViolation } from '../errors.js';
import { transaction } from '../transaction.js';

const MAX_SLUG_ATTEMPTS = 6;

/**
 * The tenant root. These functions are how a request gets from "a signed-in user" to "an organization
 * they belong to": there is deliberately no way to load an organization by ID alone.
 */
export function organizationsRepo(prisma) {
  async function createOnce({ user, name, kind, slug }) {
    return transaction(prisma, async (tx) => {
      const org = await tx.organizations.create({
        data: { public_id: ulid(), name, slug, kind },
      });
      const membership = await tx.memberships.create({
        data: { org_id: org.id, user_id: user.id, role: 'owner', project_access: 'all' },
      });
      await tx.users.update({ where: { id: user.id }, data: { last_org_id: org.id } });
      await tx.org_activity_log.create({
        data: {
          org_id: org.id,
          actor_type: 'user',
          actor_user_id: user.id,
          action: 'org.created',
          target_type: 'organization',
          target_id: org.id,
          summary: `${user.name || user.email} created the organization`,
        },
      });
      return { org, membership };
    });
  }

  return {
    /** Create an organization and make `user` its owner, atomically. The slug is made unique if taken. */
    async createWithOwner({ user, name, kind = 'brand' }) {
      const cleanName = String(name ?? '').trim();
      if (cleanName.length < 2 || cleanName.length > 128) {
        throw new DomainError('INVALID_NAME', 'Organization name must be 2–128 characters.');
      }
      let slug = slugify(cleanName);
      for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
        try {
          return await createOnce({ user, name: cleanName, kind, slug });
        } catch (err) {
          if (!isUniqueViolation(err, 'uq_organizations_slug')) throw err;
          slug = withSuffix(slugify(cleanName, 40));
        }
      }
      throw new DomainError('SLUG_UNAVAILABLE', 'Could not find a free slug.');
    },

    /** Every organization the user belongs to, newest membership last. Deleted organizations are hidden. */
    async listForUser(userId) {
      const rows = await prisma.memberships.findMany({
        where: { user_id: userId, organizations: { deleted_at: null } },
        include: { organizations: true },
        orderBy: { created_at: 'asc' },
      });
      return rows.map(({ organizations: org, ...membership }) => ({ org, membership }));
    },

    /**
     * The organization with this public ID, but only if `userId` is a member. Anyone else gets `null`,
     * the same as for an ID that doesn't exist, so the response never reveals which IDs are real.
     */
    async findForUser({ publicId, userId }) {
      const org = await prisma.organizations.findFirst({
        where: {
          public_id: String(publicId),
          deleted_at: null,
          memberships: { some: { user_id: userId } },
        },
      });
      if (!org) return null;
      const membership = await prisma.memberships.findFirst({
        where: { org_id: org.id, user_id: userId },
      });
      return membership ? { org, membership } : null;
    },
  };
}
