import { createPrisma } from './client.js';
import { invitationLinksRepo } from './repos/invitation-links.js';
import { orgScopedRepos } from './repos/org-scoped.js';
import { organizationsRepo } from './repos/organizations.js';
import { staffRepo } from './repos/staff.js';
import { usersRepo } from './repos/users.js';
import { webhookEventsRepo } from './repos/webhook-events.js';

export { DomainError } from './errors.js';

/**
 * The data layer's public face. The rest of the app never sees Prisma: it gets these repositories.
 * `prisma.*` and raw SQL are allowed only inside src/db (an ESLint rule enforces it).
 *
 * Global repositories (users, organizations, webhookEvents, invitationLinks, staff) cover data that
 * isn't owned by one organization or that is looked up before the organization is known.
 * Everything tenant-owned goes through `forOrg(orgId)`.
 */
export function createDb(options) {
  const prisma = options.prisma ?? createPrisma(options);
  return {
    users: usersRepo(prisma),
    organizations: organizationsRepo(prisma),
    invitationLinks: invitationLinksRepo(prisma),
    webhookEvents: webhookEventsRepo(prisma),
    staff: staffRepo(prisma),
    forOrg: (orgId) => orgScopedRepos(prisma, orgId),
    /** True if the database answers. Used by the health check. */
    async ping() {
      await prisma.$queryRaw`SELECT 1`;
      return true;
    },
    close: () => prisma.$disconnect(),
    /** The raw client, for src/db/testing.js only. */
    _prisma: prisma,
  };
}
