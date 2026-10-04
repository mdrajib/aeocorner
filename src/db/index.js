import { createPrisma } from './client.js';
import { abuseRepo } from './repos/abuse.js';
import { auditsRepo } from './repos/audits.js';
import { leadsRepo } from './repos/leads.js';
import { notificationsRepo } from './repos/notifications.js';
import { invitationLinksRepo } from './repos/invitation-links.js';
import { orgScopedRepos } from './repos/org-scoped.js';
import { organizationsRepo } from './repos/organizations.js';
import { referenceRepos } from './repos/reference.js';
import { staffRepo } from './repos/staff.js';
import { systemRepos } from './repos/system.js';
import { usersRepo } from './repos/users.js';
import { webhookEventsRepo } from './repos/webhook-events.js';

export { DomainError } from './errors.js';
export { RUNS_NOW_PLACEHOLDER } from './repos/org-tracking.js';
export { DRAFTS_PLACEHOLDER } from './repos/org-content.js';

/**
 * The data layer's public face. The rest of the app never sees Prisma: it gets these repositories.
 * `prisma.*` and raw SQL are allowed only inside src/db (an ESLint rule enforces it).
 *
 * Global repositories (users, organizations, webhookEvents, invitationLinks, staff, audits) cover data that
 * isn't owned by one organization or that is looked up before the organization is known. `system` holds the
 * few cross-organization lookups the background worker makes (due projects, spend by organization, provider
 * health); see repos/system.js. `reference` is shared reference data (the engines and their provider routing).
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
    audits: auditsRepo(prisma),
    abuse: abuseRepo(prisma),
    leads: leadsRepo(prisma),
    notifications: notificationsRepo(prisma),
    system: systemRepos(prisma),
    reference: referenceRepos(prisma),
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
