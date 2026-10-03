import 'dotenv/config';
import { createHash, randomBytes } from 'node:crypto';
import { normalizeName } from '../llm/names.js';
import { ulid } from '../lib/ulid.js';
import { createDb } from './index.js';
import { transaction } from './transaction.js';

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
  // Webhook deliveries this file makes through the route carry this prefix, so its cleanup removes its own rows and
  // never another file's mid-test (a shared prefix let one file delete a delivery another was still processing).
  const webhookPrefix = `msg_test_${unique()}_`;
  let webhookCount = 0;

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

    /** The audit-log rows a staff member's actions wrote, oldest first. */
    staffAuditRows(staffId) {
      return prisma.admin_audit_log.findMany({
        where: { staff_user_id: staffId },
        orderBy: { id: 'asc' },
      });
    },

    /** Write a membership_projects row directly, to prove the database itself refuses a cross-tenant project. */
    forceMembershipProject({ membershipId, projectId, orgId }) {
      return prisma.membership_projects.create({
        data: { membership_id: membershipId, project_id: projectId, org_id: orgId },
      });
    },

    /**
     * Make two transactions deadlock on purpose: each locks one user row, waits until the other has locked its
     * own, then asks for the other's. MySQL abandons one of them. Returns what each transaction ended with and
     * how many times each one's callback ran, to test that deadlocks are retried (src/db/transaction.js).
     */
    async provokeDeadlock({ attempts }) {
      const [a, b] = [await this.user(), await this.user()];
      const runs = [0, 0];
      let arrived = 0;
      let release;
      const bothHoldOne = new Promise((resolve) => (release = resolve));
      const run = (index, first, second) =>
        transaction(
          prisma,
          async (tx) => {
            runs[index] += 1;
            await tx.$queryRaw`SELECT id FROM users WHERE id = ${first} FOR UPDATE`;
            // Only the first round is staged; a retry runs after the other transaction is gone.
            if (runs[index] === 1) {
              arrived += 1;
              if (arrived === 2) release();
              await bothHoldOne;
            }
            await tx.$queryRaw`SELECT id FROM users WHERE id = ${second} FOR UPDATE`;
            return 'committed';
          },
          { attempts, baseDelayMs: 5 },
        ).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
      const results = await Promise.all([run(0, a.id, b.id), run(1, b.id, a.id)]);
      return { results, runs };
    },

    /** Write a site_scans row directly, to prove the database itself refuses another organization's project. */
    forceScan({ orgId, projectId }) {
      return prisma.site_scans.create({
        data: {
          org_id: orgId,
          project_id: projectId,
          trigger_type: 'manual',
          rubric_version: 'v0.1',
        },
      });
    },

    /**
     * A tracked prompt in a project (the Prompt Manager arrives in Phase 8). `searchQuery` is the keyword form
     * AI Overviews use.
     */
    async prompt(project, { text, searchQuery = null, country = 'US', language = 'en' } = {}) {
      const wording = text ?? `What is the best dental software? ${unique()}`;
      return prisma.prompts.create({
        data: {
          org_id: project.org_id,
          project_id: project.id,
          text: wording,
          text_hash: createHash('sha256').update(wording).digest(),
          search_query: searchQuery,
          intent: 'discovery',
          country,
          language,
          source: 'manual',
        },
      });
    },

    /** A tracking run of a project (the orchestrator arrives in Phase 9). */
    async run(project, { runDate = new Date() } = {}) {
      return prisma.runs.create({
        data: {
          org_id: project.org_id,
          project_id: project.id,
          slot_key: `m-${ulid()}`,
          trigger_type: 'manual',
          run_date: new Date(runDate.toISOString().slice(0, 10)),
          status: 'collecting',
        },
      });
    },

    /**
     * A tracked entity with its aliases (Brand Kit and competitors arrive in Phase 8). `domains` beyond the first
     * become domain aliases; `excludes` are "That's not us" rules.
     */
    async entity(
      project,
      {
        kind = 'competitor',
        name,
        aliases = [],
        domains = [],
        excludes = [],
        status = 'active',
      } = {},
    ) {
      const label = name ?? `Brand ${unique()}`;
      const row = await prisma.tracked_entities.create({
        data: {
          org_id: project.org_id,
          project_id: project.id,
          kind,
          name: label,
          name_normalized: normalizeName(label),
          primary_domain: domains[0] ?? null,
          status,
          source: 'user',
        },
      });
      const alias = (aliasKind, value) => ({
        org_id: project.org_id,
        project_id: project.id,
        entity_id: row.id,
        kind: aliasKind,
        value,
        value_normalized: aliasKind === 'domain' ? value.toLowerCase() : normalizeName(value),
        source: 'user',
      });
      const rows = [
        ...aliases.map((v) => alias('name', v)),
        ...domains.slice(1).map((v) => alias('domain', v)),
        ...excludes.map((v) => alias('exclude', v)),
      ];
      if (rows.length) await prisma.entity_aliases.createMany({ data: rows });
      return row;
    },

    /**
     * A collected answer, as `collect.answer` leaves it: an `ok` snapshot whose raw document is at `rawUri`, waiting
     * to be read.
     */
    async collectedAnswer(
      run,
      prompt,
      { engine = 'perplexity', sampleIdx = 0, rawUri, rawSha256 } = {},
    ) {
      const scoped = db.forOrg(run.org_id);
      const { snapshot } = await scoped.snapshots.create({
        runId: run.id,
        promptId: prompt.id,
        engineCode: engine,
        sampleIdx,
        providerCode: 'perplexity_api',
        method: 'api_grounded',
      });
      await scoped.snapshots.complete(snapshot.id, {
        status: 'ok',
        providerCode: 'perplexity_api',
        method: 'api_grounded',
        isFallback: false,
        providerTaskId: null,
        modelVersion: 'perplexity/sonar',
        collectedAt: new Date(),
        rawUri: rawUri ?? `test/answers/${unique()}.json`,
        rawSha256: rawSha256 ?? 'a'.repeat(64),
        answerChars: 100,
        textExcerpt: 'An answer',
        costUsd: '0.004',
      });
      return prisma.answer_snapshots.findFirst({ where: { id: snapshot.id } });
    },

    /** Delete one tracked entity (and its aliases), as a later Brand Kit edit would. */
    removeEntity: (entityId) => prisma.tracked_entities.delete({ where: { id: entityId } }),

    /** Remove URL-dictionary rows a test caused (the dictionary is global, so per-org cleanup misses it). */
    async forgetDomains(domains) {
      const rows = await prisma.web_domains.findMany({
        where: { domain: { in: domains } },
        select: { id: true },
      });
      const domainIds = rows.map((r) => r.id);
      if (!domainIds.length) return;
      await prisma.web_urls.deleteMany({ where: { domain_id: { in: domainIds } } });
      await prisma.web_domains.deleteMany({ where: { id: { in: domainIds } } });
    },

    /** Read a ledger row by its key, whoever's it is: to check what a job wrote. */
    ledgerRow: (idempotencyKey) =>
      prisma.usage_ledger.findUnique({ where: { idempotency_key: idempotencyKey } }),

    suspendStaff(staffId) {
      return prisma.staff_users.update({ where: { id: staffId }, data: { status: 'suspended' } });
    },

    /** A delivery ID (Clerk's `svix-id`) for a webhook this file sends through the route. */
    webhookId: () => `${webhookPrefix}${webhookCount++}`,

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
        // Scans reference projects, and take their pages and check results with them.
        await prisma.site_scans.deleteMany({ where });
        await prisma.site_pages.deleteMany({ where });
        await prisma.claims.deleteMany({ where });
        await prisma.mentions.deleteMany({ where });
        await prisma.citations.deleteMany({ where });
        await prisma.review_items.deleteMany({ where });
        await prisma.answer_snapshots.deleteMany({ where });
        await prisma.entity_aliases.deleteMany({ where });
        await prisma.tracked_entities.deleteMany({ where });
        await prisma.runs.deleteMany({ where });
        await prisma.prompts.deleteMany({ where });
        await prisma.projects.deleteMany({ where });
        await prisma.users.updateMany({
          where: { last_org_id: { in: orgs } },
          data: { last_org_id: null },
        });
        await prisma.organizations.deleteMany({ where: { id: { in: orgs } } });
      }
      if (userIds.length) await prisma.users.deleteMany({ where: { id: { in: userIds } } });
      // Deliveries this file sent through the route carry its own prefix; the others are tracked by id.
      await prisma.webhook_events.deleteMany({
        where: {
          OR: [
            { id: { in: webhookIds } },
            { source: 'clerk', external_id: { startsWith: webhookPrefix } },
          ],
        },
      });
      if (staffIds.length) {
        await prisma.admin_audit_log.deleteMany({ where: { staff_user_id: { in: staffIds } } });
        await prisma.staff_roles.deleteMany({ where: { staff_user_id: { in: staffIds } } });
        await prisma.staff_users.deleteMany({ where: { id: { in: staffIds } } });
      }
    },
  };
}
