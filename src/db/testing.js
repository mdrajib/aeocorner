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
  const auditIds = [];
  const leadIds = [];
  const webhookIds = [];
  const flagKeys = [];
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

    /** Switch engines on for a project, as project creation does (the helper above makes a bare project). */
    async engines(project, codes = ['perplexity']) {
      await prisma.project_engines.createMany({
        data: codes.map((engine_code) => ({
          project_id: project.id,
          org_id: project.org_id,
          engine_code,
          enabled: true,
        })),
      });
    },

    /**
     * Write daily rollup rows directly, to give a project history without running weeks of tracking. Each row:
     * `{ date, engine, entityKind ('brand' or a competitor's entity id), nAnswers, kMentioned, ... }`. The brand
     * is the project's brand entity, made here if it has none.
     */
    async seedMetrics(project, rows) {
      let brand = await prisma.tracked_entities.findFirst({
        where: { project_id: project.id, kind: 'brand' },
      });
      if (!brand) brand = await this.entity(project, { kind: 'brand', name: `Brand ${unique()}` });
      await prisma.metric_daily.createMany({
        data: rows.map((r) => ({
          org_id: project.org_id,
          project_id: project.id,
          metric_date: new Date(`${r.date}T00:00:00Z`),
          engine_code: r.engine,
          entity_id: r.entityKind === 'brand' ? brand.id : BigInt(r.entityKind),
          cells_total: r.cellsTotal ?? 1,
          cells_partial: r.cellsPartial ?? 0,
          n_answers: r.nAnswers ?? 0,
          k_mentioned: r.kMentioned ?? 0,
          k_recommended: r.kRecommended ?? 0,
          k_cited: r.kCited ?? 0,
          citations_total: r.citationsTotal ?? 0,
          citations_entity: r.citationsEntity ?? 0,
        })),
      });
      return brand;
    },

    /** A project as stored (including deleted_at), to prove another organization could not change it. */
    projectRow: (projectId) => prisma.projects.findUnique({ where: { id: projectId } }),

    /** Hand an audit to an organization, as signing up from its report will. */
    claimAudit: (auditId, orgId) =>
      prisma.audits.update({ where: { id: auditId }, data: { org_id: orgId } }),

    /** A tracked entity as stored, including its generated columns (brand_project_id). */
    entityRow: (entityId) => prisma.tracked_entities.findUnique({ where: { id: entityId } }),

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

    /** A lead (an address that asked for an audit), removed with the fixtures. */
    async lead({ email = `lead-${unique()}@example.test`, ...rest } = {}) {
      const lead = await db.leads.capture({ email, ...rest });
      leadIds.push(lead.id);
      return lead;
    },

    /** A free audit awaiting verification, on a domain no other test uses. */
    async audit(overrides = {}) {
      const domain = overrides.domain ?? `audit-${unique()}.example.test`;
      const lead = overrides.leadId === undefined ? await this.lead() : { id: overrides.leadId };
      const audit = await db.audits.create({
        inputUrl: `https://${domain}/`,
        domain,
        leadId: lead.id,
        ...overrides,
      });
      auditIds.push(audit.id);
      return audit;
    },

    /** An audit the web form made (and its lead), to be removed with the fixtures. Returns the audit row. */
    async adoptAudit(publicId) {
      const audit = await prisma.audits.findUnique({ where: { public_id: publicId } });
      if (!audit) throw new Error(`No audit ${publicId}`);
      auditIds.push(audit.id);
      if (audit.lead_id) leadIds.push(audit.lead_id);
      return audit;
    },

    /** Make a verified audit look older, to test what happens to one that waited too long. */
    backdateVerification(auditId, verifiedAt) {
      return prisma.audits.update({ where: { id: auditId }, data: { verified_at: verifiedAt } });
    },

    /** The audit-log rows a staff member's actions wrote, oldest first. */
    /** An item in the extraction review queue about one answer (and, optionally, one tracked entity). */
    reviewItem(
      run,
      snapshot,
      {
        source = 'disagreement',
        entity,
        status = 'open',
        reportKind = null,
        comment = null,
        details = null,
        userId = null,
      } = {},
    ) {
      return prisma.review_items.create({
        data: {
          org_id: run.org_id,
          project_id: run.project_id,
          source,
          snapshot_id: snapshot.id,
          run_date: snapshot.run_date,
          entity_id: entity?.id ?? null,
          reported_by_user_id: userId,
          report_kind: reportKind,
          report_comment: comment,
          details,
          status,
        },
      });
    },

    /** A review item's row, for assertions the console does not expose. */
    reviewRow(id) {
      return prisma.review_items.findUnique({ where: { id } });
    },

    /** An answer snapshot's row (its extraction status, say). */
    snapshotRow(snapshot) {
      return prisma.answer_snapshots.findFirst({
        where: { id: snapshot.id, run_date: snapshot.run_date },
      });
    },

    /** The aliases of an entity, for assertions. */
    aliasRows(entity) {
      return prisma.entity_aliases.findMany({
        where: { entity_id: entity.id },
        orderBy: { id: 'asc' },
      });
    },

    /** A feature flag key for a test; cleanup removes the ones this file made (and no one else's). */
    flagKey() {
      const key = `test.flag_${unique()}`;
      flagKeys.push(key);
      return key;
    },

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
    async prompt(
      project,
      { text, searchQuery = null, country = 'US', language = 'en', intent = 'discovery' } = {},
    ) {
      const wording = text ?? `What is the best dental software? ${unique()}`;
      return prisma.prompts.create({
        data: {
          org_id: project.org_id,
          project_id: project.id,
          text: wording,
          text_hash: createHash('sha256').update(wording).digest(),
          search_query: searchQuery,
          intent,
          country,
          language,
          source: 'manual',
        },
      });
    },

    /** A tracking run of a project (the orchestrator arrives in Phase 9). */
    async run(
      project,
      {
        runDate = new Date(),
        status = 'collecting',
        trigger = 'manual',
        counts = {},
        queuedAt,
      } = {},
    ) {
      return prisma.runs.create({
        data: {
          org_id: project.org_id,
          project_id: project.id,
          slot_key: `m-${ulid()}`,
          trigger_type: trigger,
          run_date: new Date(runDate.toISOString().slice(0, 10)),
          status,
          ...(queuedAt ? { queued_at: queuedAt } : {}),
          ...(['complete', 'partial', 'failed'].includes(status)
            ? { finished_at: new Date() }
            : {}),
          ...counts,
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
     * A settled cell written directly, for tests that need exact counts without collecting answers: `nOk` readable
     * answers of which `brandK` named the brand, and `rivals` (`[{ entity, k }]`) named others. `status` is the
     * cell's (`complete` or `partial`).
     */
    async cell(
      run,
      prompt,
      {
        engine = 'perplexity',
        status = 'complete',
        nOk = 10,
        brandK = 0,
        brand,
        rivals = [],
        sentiment = 0,
        citationsTotal = 0,
        citationsOwn = 0,
      } = {},
    ) {
      const base = {
        run_date: run.run_date,
        org_id: run.org_id,
        project_id: run.project_id,
        run_id: run.id,
        prompt_id: prompt.id,
        engine_code: engine,
      };
      await prisma.cell_results.create({
        data: {
          ...base,
          status,
          n_planned: nOk,
          n_ok: nOk,
          n_failed: 0,
          citations_total: citationsTotal,
          citations_own: citationsOwn,
          extraction_version: 'test',
        },
      });
      const entityRows = [
        ...(brand && brandK > 0
          ? [{ entity: brand, k: brandK, sentimentN: brandK, sentimentSum: brandK * sentiment }]
          : []),
        ...rivals.map((r) => ({ entity: r.entity, k: r.k, sentimentN: 0, sentimentSum: 0 })),
      ].filter((r) => r.k > 0);
      if (entityRows.length) {
        await prisma.cell_entity_results.createMany({
          data: entityRows.map((r) => ({
            ...base,
            entity_id: r.entity.id,
            k_mentioned: r.k,
            sentiment_sum: r.sentimentSum,
            sentiment_n: r.sentimentN,
          })),
        });
      }
    },

    /** A before/after outcome written directly, to show a screen a result without waiting two weeks. */
    forceOutcome(
      rec,
      {
        horizon = 'week_2',
        verdict = 'proven_win',
        nBefore = 120,
        kBefore = 10,
        nAfter = 118,
        kAfter = 40,
        promptsCount = 3,
        p = '0.00001000',
        metric = 'mention_rate',
      } = {},
    ) {
      return prisma.action_outcomes.create({
        data: {
          org_id: rec.org_id,
          project_id: rec.project_id,
          recommendation_id: rec.id,
          horizon,
          prompts_count: promptsCount,
          baseline_run_ids: [],
          after_run_ids: [],
          n_before: nBefore,
          k_before: kBefore,
          n_after: nAfter,
          k_after: kAfter,
          rate_before: nBefore ? (kBefore / nBefore).toFixed(4) : null,
          rate_after: nAfter ? (kAfter / nAfter).toFixed(4) : null,
          delta_pp:
            verdict !== 'insufficient_data' && nBefore && nAfter
              ? String(Math.round((kAfter / nAfter - kBefore / nBefore) * 10000) / 100)
              : null,
          p_value: verdict === 'insufficient_data' ? null : p,
          verdict,
          metric,
        },
      });
    },

    /** Set columns of a recommendation directly, to put it in a state a test needs (declined, long ago, ...). */
    forceRecommendation(id, data) {
      return prisma.recommendations.update({ where: { id }, data });
    },

    /** A recommendation row with sensible defaults, for tests that need one to point at. */
    recommendation(project, overrides = {}) {
      return prisma.recommendations.create({
        data: {
          org_id: project.org_id,
          project_id: project.id,
          rule_code: 'visibility.lost_prompt',
          rule_version: 1,
          stable_key: `k${unique()}`,
          why_md: 'why',
          category: 'content_new',
          fix_path: 'content',
          title: 'Lost',
          evidence: {},
          impact: '1',
          confidence: '0.5',
          effort: 3,
          ice: '0.1',
          ...overrides,
        },
      });
    },

    /** The raw WordPress integration row of a project (to check what is stored, never to read a secret back). */
    integrationRow(projectId) {
      return prisma.integrations.findFirst({ where: { project_id: projectId, type: 'wordpress' } });
    },
    integrationCount(projectId) {
      return prisma.integrations.count({ where: { project_id: projectId } });
    },

    /**
     * A Content Studio item in any state, written directly (no pipeline, no draft allowance taken), with one revision
     * when `html` is given. For route and browser tests that need a page to look at.
     */
    async contentItem(
      project,
      {
        title = `Page ${unique()}`,
        status = 'ready',
        kind = 'new',
        format = 'faq',
        brief = null,
        research = null,
        qc = null,
        jsonld = null,
        html = null,
        failure = null,
        publishedUrl = null,
        recommendationId = null,
        userId = null,
      } = {},
    ) {
      const item = await prisma.content_items.create({
        data: {
          public_id: ulid(),
          org_id: project.org_id,
          project_id: project.id,
          recommendation_id: recommendationId,
          kind,
          format,
          title,
          status: ['approved', 'publishing', 'published'].includes(status) ? 'ready' : status,
          brief: brief ?? undefined,
          research: research ?? undefined,
          jsonld: jsonld ?? undefined,
          created_by_user_id: userId,
        },
      });
      let revision = null;
      if (html) {
        revision = await prisma.content_revisions.create({
          data: {
            org_id: project.org_id,
            content_item_id: item.id,
            revision: 1,
            body_html: html,
            word_count: html
              .replace(/<[^>]+>/g, ' ')
              .split(/s+/)
              .filter(Boolean).length,
            source: 'ai_draft',
          },
        });
      }
      const data = { current_revision_id: revision?.id ?? null };
      if (qc) {
        data.qc = { ...qc, revisionId: String(revision?.id ?? '') };
        data.qc_score = qc.score;
      }
      if (failure) {
        data.failed_stage = failure.stage;
        data.failure_reason = failure.reason;
      }
      if (['approved', 'publishing', 'published'].includes(status)) {
        Object.assign(data, {
          approved_revision_id: revision?.id,
          approved_at: new Date(),
          approved_by_user_id: userId,
          status,
        });
        if (status === 'published')
          Object.assign(data, {
            published_url: publishedUrl,
            published_at: new Date(),
            cms_ref: '1',
          });
      }
      return prisma.content_items.update({ where: { id: item.id }, data });
    },

    /** Set columns on a content item directly (a test that needs a state the pipeline would take time to reach). */
    forceContent(id, data) {
      return prisma.content_items.update({ where: { id }, data });
    },

    /** Put an organization on a plan, with a billing status (and any other column of the row). */
    setOrg(orgId, data) {
      return prisma.organizations.update({ where: { id: orgId }, data });
    },

    /** Rows an organization still owns, per table: every table with an `org_id` except those named in `skip`. */
    async tenantRows(orgId, { skip = [] } = {}) {
      const out = {};
      for (const table of await tablesWithOrgId(db)) {
        if (skip.includes(table)) continue;
        const [row] = await prisma.$queryRawUnsafe(
          `SELECT COUNT(*) AS n FROM \`${table}\` WHERE org_id = ?`,
          orgId,
        );
        if (Number(row.n) > 0) out[table] = Number(row.n);
      }
      return out;
    },

    /** How many rows a table has that match `where` (a Prisma filter). For checking what a purge left. */
    count(table, where) {
      return prisma[table].count({ where });
    },

    /** Give an audit to an organization, and add a scan of it that carries no org_id (as the free audit's scan does). */
    async claimAuditWithScan(auditId, orgId) {
      await prisma.audits.update({ where: { id: auditId }, data: { org_id: orgId } });
      return prisma.site_scans.create({
        data: { audit_id: auditId, trigger_type: 'audit', rubric_version: 'v0.1' },
      });
    },

    /** Set columns on a site change directly (to tamper with what was approved). */
    forceSiteChange(id, data) {
      return prisma.site_changes.update({ where: { id }, data });
    },

    /** Set columns on a user directly (their timezone, say). */
    setUser(id, data) {
      return prisma.users.update({ where: { id }, data });
    },

    /** A significant change event, as change detection stores it (a test that needs one without a run). */
    changeEvent(
      project,
      {
        kind = 'mention_rate_change',
        direction = 'down',
        engine = null,
        entity,
        significant = true,
        createdAt = new Date(),
        alertedAt = null,
        key = `${unique()}`,
      } = {},
    ) {
      return prisma.change_events.create({
        data: {
          org_id: project.org_id,
          project_id: project.id,
          kind,
          engine_code: engine,
          entity_id: entity?.id ?? null,
          before_start: new Date('2026-09-01T00:00:00Z'),
          before_end: new Date('2026-09-28T00:00:00Z'),
          after_start: new Date('2026-09-29T00:00:00Z'),
          after_end: new Date('2026-10-26T00:00:00Z'),
          n_before: 120,
          k_before: direction === 'down' ? 72 : 24,
          n_after: 120,
          k_after: direction === 'down' ? 24 : 72,
          value_before: direction === 'down' ? 0.6 : 0.2,
          value_after: direction === 'down' ? 0.2 : 0.6,
          delta_pp: direction === 'down' ? '-40.00' : '40.00',
          p_value: '0.00000100',
          direction,
          is_significant: significant,
          dedupe_key: key,
          created_at: createdAt,
          alerted_at: alertedAt,
        },
      });
    },

    /** A claim an answer made about an entity (the digest and alerts read negative ones about the brand). */
    claim(
      project,
      {
        entity,
        attribute = 'pricing',
        value,
        polarity = 'negative',
        runDate = new Date(),
        snapshotId = 1n,
      } = {},
    ) {
      return prisma.claims.create({
        data: {
          run_date: new Date(runDate.toISOString().slice(0, 10)),
          org_id: project.org_id,
          project_id: project.id,
          snapshot_id: snapshotId,
          mention_id: 1n,
          entity_id: entity.id,
          attribute,
          claim_value: value,
          polarity,
        },
      });
    },

    /** Set columns on a project directly (an archived project, say). */
    setProject(id, data) {
      return prisma.projects.update({ where: { id }, data });
    },

    /** Set one month's counter for an organization (a quota that has been used up, say). */
    async setQuota(orgId, period, meter, units) {
      await prisma.quota_usage.upsert({
        where: { org_id_period_month_meter: { org_id: orgId, period_month: period, meter } },
        create: { org_id: orgId, period_month: period, meter, used_units: String(units) },
        update: { used_units: String(units) },
      });
    },

    /** Give an organization an entitlement grant (an add-on, a coupon, a staff grant). */
    grant(
      orgId,
      {
        meter = 'prompts',
        amount = 10,
        source = 'staff_grant',
        itemId = null,
        endsAt = null,
        reason = 'test',
      } = {},
    ) {
      return prisma.entitlement_grants.create({
        data: {
          org_id: orgId,
          meter,
          amount,
          source,
          stripe_subscription_item_id: itemId,
          ends_at: endsAt,
          reason,
          starts_at: new Date(Date.now() - 1000),
        },
      });
    },

    /** The rows of one organization's subscriptions and grants, for assertions the repositories do not expose. */
    billingRows(orgId) {
      return Promise.all([
        prisma.subscriptions.findMany({ where: { org_id: orgId }, orderBy: { id: 'asc' } }),
        prisma.entitlement_grants.findMany({ where: { org_id: orgId }, orderBy: { id: 'asc' } }),
        prisma.organizations.findUnique({ where: { id: orgId } }),
      ]).then(([subscriptions, grants, org]) => ({ subscriptions, grants, org }));
    },

    /** A Stripe event ID this file's cleanup will remove. */
    stripeEventId: () => `evt_test_${webhookPrefix}${webhookCount++}`,

    /** The raw rows of one table for an item, for assertions the repositories do not expose. */
    contentRows(id) {
      return Promise.all([
        prisma.content_items.findUnique({ where: { id } }),
        prisma.content_revisions.findMany({
          where: { content_item_id: id },
          orderBy: { revision: 'asc' },
        }),
        prisma.site_changes.findMany({ where: { content_item_id: id }, orderBy: { id: 'asc' } }),
      ]).then(([item, revisions, changes]) => ({ item, revisions, changes }));
    },

    /**
     * A finished website scan with the given check results (`[{ code, status, points, possible, summary }]`), as the
     * crawler leaves one. Returns the scan row.
     */
    async scan(
      project,
      { status = 'complete', checks = [], finishedAt = new Date(), trigger = 'manual' } = {},
    ) {
      const scan = await prisma.site_scans.create({
        data: {
          org_id: project.org_id,
          project_id: project.id,
          trigger_type: trigger,
          rubric_version: 'v0.1',
          status,
          started_at: finishedAt,
          finished_at: finishedAt,
        },
      });
      if (checks.length) {
        await prisma.scan_checks.createMany({
          data: checks.map((c) => ({
            scan_id: scan.id,
            org_id: project.org_id,
            check_code: c.code,
            status: c.status,
            points_awarded: String(c.points ?? 0),
            points_possible: String(c.possible),
            evidence: { summary: c.summary ?? '', ...(c.evidence ?? {}) },
          })),
        });
      }
      return scan;
    },

    /**
     * The pages a scan fetched: `[{ url, key = true, status = 200 }]`, in the order given (the scan's order, the most
     * important first). Key pages are what Milestone 13 asks "was this ever cited?" about.
     */
    async scanPages(scan, pages) {
      for (const p of pages) {
        await prisma.scan_pages.create({
          data: {
            scan_id: scan.id,
            org_id: scan.org_id,
            url: p.url,
            url_hash: createHash('sha256').update(p.url).digest(),
            is_key_page: p.key ?? true,
            http_status: p.status ?? 200,
          },
        });
      }
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

    /**
     * An answer collected AND read, as the extractor leaves it: an `ok` snapshot marked read, with its mentions and
     * citations. `mentions` are `{ entity (a tracked_entities row), listRank, stance, sentiment, excerpt }`;
     * `citations` are `{ url, isOwn, owner (an entity row or null) }`. Cited domains go into the global dictionary, so
     * a test that cites its own hosts removes them with `forgetDomains`. Returns the snapshot.
     */
    async readAnswer(
      run,
      prompt,
      {
        engine = 'perplexity',
        sampleIdx = 0,
        excerpt = 'An answer',
        mentions = [],
        citations = [],
        claims = [],
      } = {},
    ) {
      const snapshot = await this.collectedAnswer(run, prompt, { engine, sampleIdx });
      await prisma.answer_snapshots.updateMany({
        where: { id: snapshot.id, run_date: snapshot.run_date },
        data: {
          extraction_status: 'done',
          extraction_version: 'test',
          extracted_at: new Date(),
          text_excerpt: excerpt,
          answer_type: 'list',
        },
      });
      const fact = {
        run_date: snapshot.run_date,
        org_id: run.org_id,
        project_id: run.project_id,
        run_id: run.id,
        snapshot_id: snapshot.id,
        prompt_id: prompt.id,
        engine_code: engine,
        extraction_version: 'test',
      };
      if (mentions.length) {
        await prisma.mentions.createMany({
          data: mentions.map((m, i) => ({
            ...fact,
            entity_id: m.entity.id,
            name_as_written: m.entity.name,
            list_rank: m.listRank ?? null,
            mention_order: i + 1,
            prominence: 'primary',
            stance: m.stance ?? 'neutral',
            sentiment: m.sentiment ?? 0,
            excerpt: m.excerpt ?? null,
            detected_by: 'both',
          })),
        });
      }
      if (claims.length) {
        // A claim belongs to the mention of the entity it is about (the first mention, if the test named none for it).
        const rows = await prisma.mentions.findMany({
          where: { snapshot_id: snapshot.id, run_date: snapshot.run_date },
          select: { id: true, entity_id: true },
        });
        await prisma.claims.createMany({
          data: claims.map((c) => ({
            run_date: snapshot.run_date,
            org_id: run.org_id,
            project_id: run.project_id,
            snapshot_id: snapshot.id,
            mention_id: (rows.find((r) => r.entity_id === c.entity.id) ?? rows[0]).id,
            entity_id: c.entity.id,
            attribute: c.attribute ?? 'company_fact',
            claim_value: c.value,
            polarity: c.polarity ?? 'neutral',
          })),
        });
      }
      for (const [i, c] of citations.entries()) {
        const domain = new URL(c.url).hostname.replace(/^www\./, '');
        const domainRow =
          (await prisma.web_domains.findUnique({ where: { domain } })) ??
          (await prisma.web_domains.create({ data: { domain } }));
        const hash = createHash('sha256').update(c.url).digest();
        const urlRow =
          (await prisma.web_urls.findUnique({ where: { url_hash: hash } })) ??
          (await prisma.web_urls.create({
            data: { url_hash: hash, url: c.url, domain_id: domainRow.id },
          }));
        await prisma.citations.create({
          data: {
            ...fact,
            position: i + 1,
            url_id: urlRow.id,
            domain_id: domainRow.id,
            owner_entity_id: c.owner?.id ?? null,
            is_own: c.isOwn ?? false,
          },
        });
      }
      return snapshot;
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

    /** Every ledger row an audit wrote, oldest first: to check what a job charged. */
    auditLedgerRows: (auditId) =>
      prisma.usage_ledger.findMany({ where: { audit_id: auditId }, orderBy: { id: 'asc' } }),

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
        await prisma.subscriptions.deleteMany({ where });
        await prisma.entitlement_grants.deleteMany({ where });
        await prisma.feature_flag_overrides.deleteMany({ where });
        // Scans reference projects, and take their pages and check results with them.
        // An audit handed to an organization is removed with its own fixtures, not with the organization.
        await prisma.audits.updateMany({ where, data: { org_id: null, project_id: null } });
        await prisma.fix_verifications.deleteMany({ where });
        await prisma.site_changes.deleteMany({ where });
        await prisma.content_target_prompts.deleteMany({ where });
        await prisma.content_revisions.deleteMany({ where });
        await prisma.content_items.deleteMany({ where });
        await prisma.integrations.deleteMany({ where });
        await prisma.recovery_events.deleteMany({ where });
        await prisma.recovery_cases.deleteMany({ where });
        await prisma.entity_checks.deleteMany({ where });
        await prisma.traffic_daily.deleteMany({ where });
        await prisma.search_console_daily.deleteMany({ where });
        await prisma.action_outcomes.deleteMany({ where });
        await prisma.recommendations.deleteMany({ where });
        await prisma.site_scans.deleteMany({ where });
        await prisma.site_pages.deleteMany({ where });
        await prisma.cell_entity_results.deleteMany({ where });
        await prisma.cell_results.deleteMany({ where });
        await prisma.metric_daily.deleteMany({ where });
        await prisma.change_events.deleteMany({ where });
        await prisma.quota_usage.deleteMany({ where });
        await prisma.claims.deleteMany({ where });
        await prisma.mentions.deleteMany({ where });
        await prisma.citations.deleteMany({ where });
        await prisma.review_items.deleteMany({ where });
        await prisma.answer_snapshots.deleteMany({ where });
        await prisma.entity_aliases.deleteMany({ where });
        await prisma.project_engines.deleteMany({ where });
        await prisma.brand_profiles.deleteMany({ where });
        await prisma.tracked_entities.deleteMany({ where });
        await prisma.runs.deleteMany({ where });
        await prisma.prompts.deleteMany({ where });
        await prisma.prompt_clusters.deleteMany({ where });
        await prisma.projects.deleteMany({ where });
        await prisma.users.updateMany({
          where: { last_org_id: { in: orgs } },
          data: { last_org_id: null },
        });
        await prisma.organizations.deleteMany({ where: { id: { in: orgs } } });
      }
      if (auditIds.length) {
        // An audit's scans are not deleted with it (the foreign key is NO ACTION); its answers are.
        await prisma.usage_ledger.deleteMany({ where: { audit_id: { in: auditIds } } });
        await prisma.site_scans.deleteMany({ where: { audit_id: { in: auditIds } } });
        await prisma.audits.deleteMany({ where: { id: { in: auditIds } } });
      }
      if (leadIds.length) await prisma.leads.deleteMany({ where: { id: { in: leadIds } } });
      if (userIds.length) {
        // Addresses a test put on the suppression list (a bounce, a complaint) are removed with the people.
        const emails = (
          await prisma.users.findMany({ where: { id: { in: userIds } }, select: { email: true } })
        ).map((u) => u.email.toLowerCase());
        await prisma.email_suppressions.deleteMany({
          where: { OR: [{ email: { in: emails } }, { email: { startsWith: 'bounce-' } }] },
        });
        await prisma.notifications.deleteMany({ where: { user_id: { in: userIds } } });
        await prisma.users.deleteMany({ where: { id: { in: userIds } } });
      }
      // Deliveries this file sent through the route carry its own prefix; the others are tracked by id.
      await prisma.webhook_events.deleteMany({
        where: {
          OR: [
            { id: { in: webhookIds } },
            { source: 'clerk', external_id: { startsWith: webhookPrefix } },
            { source: 'stripe', external_id: { contains: webhookPrefix } },
          ],
        },
      });
      await prisma.feature_flag_overrides.deleteMany({ where: { flag_key: { in: flagKeys } } });
      await prisma.feature_flags.deleteMany({ where: { flag_key: { in: flagKeys } } });
      if (staffIds.length) {
        await prisma.admin_audit_log.deleteMany({ where: { staff_user_id: { in: staffIds } } });
        await prisma.staff_roles.deleteMany({ where: { staff_user_id: { in: staffIds } } });
        await prisma.staff_users.deleteMany({ where: { id: { in: staffIds } } });
      }
    },
  };
}

/** Names of the tables that carry an `org_id` column, read from the schema itself (the tenant leak sweep uses it). */
export async function tablesWithOrgId(db) {
  const rows = await db._prisma.$queryRaw`
    SELECT DISTINCT table_name AS name FROM information_schema.columns
    WHERE table_schema = DATABASE() AND column_name = 'org_id' ORDER BY table_name`;
  return rows.map((r) => String(r.name));
}

/**
 * Tables where `needle` appears in ANY column of ANY of the organization's rows (text, JSON and binary alike). The
 * secrets audit plants a known password and token, then asks where they ended up: the answer must be nowhere.
 */
export async function tablesContaining(db, orgId, needle) {
  const prisma = db._prisma;
  const tables = await tablesWithOrgId(db);
  const hits = [];
  for (const table of tables) {
    const cols = await prisma.$queryRaw`
      SELECT column_name AS name FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ${table}`;
    const all = cols.map((c) => `CAST(\`${String(c.name)}\` AS BINARY)`).join(', ');
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) AS n FROM \`${table}\` WHERE org_id = ? AND LOCATE(CAST(? AS BINARY), CONCAT_WS('|', ${all})) > 0`,
      orgId,
      String(needle),
    );
    if (Number(rows[0].n) > 0) hits.push(table);
  }
  return hits;
}
