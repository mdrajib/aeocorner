import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { ulid } from '../lib/ulid.js';
import { createDb } from './index.js';

/**
 * Helpers for the integration and tenancy suites. Lives in src/db because those suites need to seed rows
 * the repositories don't expose yet (projects arrive in Phase 8), and only src/db may touch Prisma.
 * The application never imports this file.
 */

/** A db handle on the test database. Refuses any database whose name doesn't end in `_test`. */
export function connectTestDb({ connectionLimit = 4 } = {}) {
  const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to run the database tests.');
  const name = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!name.endsWith('_test')) {
    throw new Error(
      `Refusing to run tests against "${name}": the database name must end in _test.`,
    );
  }
  return createDb({ databaseUrl, connectionLimit });
}

const unique = () => randomBytes(5).toString('hex');

/**
 * Seed data for one test file, and remove it afterwards. Test files run in parallel against one database,
 * so every row gets a unique name instead of the suite truncating tables.
 */
export function fixtures(db) {
  const prisma = db._prisma;
  const userIds = [];
  const orgIds = [];
  const staffIds = [];
  const webhookIds = [];

  return {
    /** A Clerk-style user record, as the webhook or the Clerk API would hand it over. */
    clerkUser(overrides = {}) {
      const id = `test_${unique()}`;
      return {
        id,
        email: `${id}@example.test`,
        name: 'Test Person',
        imageUrl: null,
        updatedAt: Date.now(),
        ...overrides,
      };
    },

    async user(overrides = {}) {
      const user = await db.users.getOrCreateFromClerk(this.clerkUser(overrides));
      userIds.push(user.id);
      return user;
    },

    /** An organization with `owner` (a new user by default) as its owner. */
    async org({ owner, name } = {}) {
      const user = owner ?? (await this.user());
      const { org, membership } = await db.organizations.createWithOwner({
        user,
        name: name ?? `Test Org ${unique()}`,
      });
      orgIds.push(org.id);
      return { org, owner: user, ownerMembership: membership, scoped: db.forOrg(org.id) };
    },

    /** A new user who is a member of `org` with `role`. */
    async member(org, role = 'viewer', overrides = {}) {
      const user = await this.user(overrides);
      const membership = await db.forOrg(org.id).memberships.add({ userId: user.id, role });
      return { user, membership };
    },

    async project(orgId, name = `Project ${unique()}`, { status, slotHour = 1 } = {}) {
      return prisma.projects.create({
        data: {
          public_id: ulid(),
          org_id: orgId,
          name,
          domain: `${unique()}.example.test`,
          country: 'US',
          language: 'en',
          weekly_slot_hour: slotHour,
          ...(status ? { status } : {}),
        },
      });
    },

    /** Set an organization's plan and its own daily cap directly, as the admin console will later. */
    setOrgSpend(orgId, { planCode, capUsd } = {}) {
      return prisma.organizations.update({
        where: { id: orgId },
        data: {
          ...(planCode !== undefined ? { plan_code: planCode } : {}),
          ...(capUsd !== undefined ? { spend_cap_usd_daily: capUsd } : {}),
        },
      });
    },

    /** Read an organization row, for checks on state the repositories only change (never expose whole). */
    organizationRow: (orgId) => prisma.organizations.findUnique({ where: { id: orgId } }),

    /** Remove health buckets a test wrote for a real provider code. */
    deleteProviderHealth({ providerCode, from, to }) {
      return prisma.provider_health.deleteMany({
        where: { provider_code: providerCode, bucket_start: { gte: from, lte: to } },
      });
    },

    async staff({ roles = ['support'], email, name = 'Test Staff' } = {}) {
      const staff = await db.staff.invite({
        email: email ?? `staff-${unique()}@example.test`,
        name,
        roles,
      });
      staffIds.push(staff.id);
      return staff;
    },

    /** Write a membership_projects row directly, to prove the database itself refuses a cross-tenant project. */
    forceMembershipProject({ membershipId, projectId, orgId }) {
      return prisma.membership_projects.create({
        data: { membership_id: membershipId, project_id: projectId, org_id: orgId },
      });
    },

    suspendStaff(staffId) {
      return prisma.staff_users.update({ where: { id: staffId }, data: { status: 'suspended' } });
    },

    trackWebhook(id) {
      webhookIds.push(id);
    },
    trackOrg(id) {
      orgIds.push(id);
    },
    trackUser(id) {
      userIds.push(id);
    },

    /**
     * Forget rows left behind by an earlier run that never got to clean up (a killed server): every user
     * whose Clerk ID starts with `prefix`, with their organizations. Call before seeding.
     */
    async purgeLeftovers(prefix) {
      const old = await prisma.users.findMany({
        where: { clerk_user_id: { startsWith: prefix } },
        select: { id: true },
      });
      userIds.push(...old.map((u) => u.id));
      await this.cleanup();
      userIds.length = 0;
      orgIds.length = 0;
    },

    /** Delete everything this file created, children first. */
    async cleanup() {
      // Organizations that tests created through the app (not through this object) are found via their members.
      const viaMembers = userIds.length
        ? await prisma.memberships.findMany({
            where: { user_id: { in: userIds } },
            select: { org_id: true },
          })
        : [];
      const orgs = [...new Set([...orgIds, ...viaMembers.map((m) => m.org_id)])];

      if (userIds.length) {
        await prisma.users.updateMany({
          where: { id: { in: userIds } },
          data: { last_org_id: null },
        });
      }
      if (orgs.length) {
        const where = { org_id: { in: orgs } };
        await prisma.membership_projects.deleteMany({ where });
        await prisma.memberships.deleteMany({ where });
        await prisma.invitations.deleteMany({ where });
        await prisma.org_activity_log.deleteMany({ where });
        await prisma.usage_ledger.deleteMany({ where });
        await prisma.notifications.deleteMany({ where });
        await prisma.projects.deleteMany({ where });
        await prisma.users.updateMany({
          where: { last_org_id: { in: orgs } },
          data: { last_org_id: null },
        });
        await prisma.organizations.deleteMany({ where: { id: { in: orgs } } });
      }
      if (userIds.length) await prisma.users.deleteMany({ where: { id: { in: userIds } } });
      // Deliveries made through the webhook route use ids like "msg_test_…"; the others are tracked by id.
      await prisma.webhook_events.deleteMany({
        where: {
          OR: [
            { id: { in: webhookIds } },
            { source: 'clerk', external_id: { startsWith: 'msg_test_' } },
          ],
        },
      });
      if (staffIds.length) {
        await prisma.staff_roles.deleteMany({ where: { staff_user_id: { in: staffIds } } });
        await prisma.staff_users.deleteMany({ where: { id: { in: staffIds } } });
      }
    },
  };
}
