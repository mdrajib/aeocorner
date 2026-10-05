import { KNOWN_FLAGS, resolveFlag } from '../../core/flags.js';
import { normalizeEntityName } from '../../core/project-rules.js';
import { toMicros, utcDayStart } from '../../core/spend.js';
import { DomainError, isUniqueViolation } from '../errors.js';
import { transaction } from '../transaction.js';

/**
 * What the staff console reads and changes ACROSS organizations, by design (Milestone 8, tasks 8.17–8.21). Staff are not
 * members of the organizations they look at, so none of this goes through `forOrg()`. It is a deliberate, reviewed
 * exception, kept small and listed in tests/tenancy: every function here is either an aggregate (money, counts, health), or
 * takes an item ID the console already showed, and every write is recorded in `admin_audit_log` by the route that calls it.
 *
 * What each group may show is narrower than what it can reach: the review queue shows the answer and the names being
 * tracked, never who the customer is (ADMIN_OPERATIONS §2: a reviewer sees no account details beyond the answer).
 */

const dayText = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

export function systemAdmin(prisma) {
  // --- Cost and margin (8.17) ------------------------------------------------------------------------------------
  const costs = {
    /** Spend by meter, provider and model since `since`, most expensive first. */
    async byMeter({ since }) {
      const rows = await prisma.usage_ledger.groupBy({
        by: ['meter', 'provider_code', 'model'],
        where: { occurred_at: { gte: since } },
        _sum: { cost_usd: true, quantity: true },
        _count: { _all: true },
      });
      return rows
        .map((r) => ({
          meter: r.meter,
          providerCode: r.provider_code,
          model: r.model,
          costMicros: toMicros(r._sum.cost_usd?.toString() ?? '0'),
          quantity: Number(r._sum.quantity ?? 0),
          calls: r._count._all,
        }))
        .sort((a, b) => b.costMicros - a.costMicros);
    },

    /** Spend per UTC day since `since`, oldest first. */
    async daily({ since }) {
      const rows = await prisma.$queryRaw`
        SELECT DATE(occurred_at) AS day, SUM(cost_usd) AS cost
        FROM usage_ledger WHERE occurred_at >= ${since}
        GROUP BY DATE(occurred_at) ORDER BY day ASC`;
      return rows.map((r) => ({
        day: dayText(r.day),
        costMicros: toMicros(String(r.cost ?? '0')),
      }));
    },

    /**
     * Every organization that cost something since `since` or is paying us now, with its plan and price: the input to
     * margin per organization and per plan. Money in micro-dollars.
     */
    async byOrganization({ since }) {
      const spent = await prisma.usage_ledger.groupBy({
        by: ['org_id'],
        where: { occurred_at: { gte: since }, org_id: { not: null } },
        _sum: { cost_usd: true },
      });
      const costOf = new Map(
        spent.map((r) => [r.org_id, toMicros(r._sum.cost_usd?.toString() ?? '0')]),
      );
      const orgs = await prisma.organizations.findMany({
        where: {
          deleted_at: null,
          OR: [{ id: { in: [...costOf.keys()] } }, { billing_status: 'active' }],
        },
        select: {
          id: true,
          public_id: true,
          name: true,
          plan_code: true,
          billing_status: true,
          plans: { select: { price_usd_month: true } },
        },
        orderBy: { id: 'asc' },
      });
      return orgs.map((o) => ({
        orgId: o.id,
        orgPublicId: o.public_id,
        orgName: o.name,
        planCode: o.plan_code,
        billingStatus: o.billing_status,
        priceMicros: toMicros(o.plans?.price_usd_month?.toString() ?? '0'),
        costMicros: costOf.get(o.id) ?? 0,
      }));
    },

    /** What visitors' free audits cost (no organization), since `since`. */
    async auditsMicros({ since }) {
      const { _sum } = await prisma.usage_ledger.aggregate({
        where: { occurred_at: { gte: since }, org_id: null },
        _sum: { cost_usd: true },
      });
      return toMicros(_sum.cost_usd?.toString() ?? '0');
    },

    /**
     * What one window cost, for the unit-cost report (Milestone 10): organization spend by meter, the prompt-runs
     * collected (a question asked in one run, all its engines and samples), and what each free audit that ran its own
     * pipeline cost. Aggregates only: no organization, project or audit identifier leaves this function.
     */
    async unitCosts({ from, to }) {
      const meters = await prisma.usage_ledger.groupBy({
        by: ['meter'],
        where: { occurred_at: { gte: from, lt: to }, org_id: { not: null } },
        _sum: { cost_usd: true },
      });
      const [runs] = await prisma.$queryRaw`
        SELECT COUNT(*) AS n FROM (
          SELECT DISTINCT run_id, prompt_id FROM answer_snapshots
          WHERE collected_at >= ${from} AND collected_at < ${to} AND status IN ('ok', 'no_answer')) t`;
      const audits = await prisma.$queryRaw`
        SELECT SUM(l.cost_usd) AS cost FROM audits a JOIN usage_ledger l ON l.audit_id = a.id
        WHERE a.cached_from_audit_id IS NULL AND l.occurred_at >= ${from} AND l.occurred_at < ${to}
        GROUP BY a.id`;
      const costs = audits.map((a) => toMicros(String(a.cost ?? '0')));
      return {
        meters: meters.map((m) => ({
          meter: m.meter,
          costMicros: toMicros(m._sum.cost_usd?.toString() ?? '0'),
        })),
        promptRuns: Number(runs?.n ?? 0),
        audits: {
          count: costs.length,
          costMicros: costs.reduce((a, b) => a + b, 0),
          worstMicros: costs.length ? Math.max(...costs) : 0,
        },
      };
    },

    /** Answers collected (read or confirmed absent) since `since`: the divisor of cost per answer. */
    answers: ({ since }) =>
      prisma.answer_snapshots.count({
        where: { status: { in: ['ok', 'no_answer'] }, collected_at: { gte: since } },
      }),
  };

  // --- Provider health (8.18) ------------------------------------------------------------------------------------
  const providers = {
    /** Health buckets since `since`. */
    async buckets({ since }) {
      const rows = await prisma.provider_health.findMany({
        where: { bucket_start: { gte: since } },
        orderBy: { bucket_start: 'asc' },
      });
      return rows.map((r) => ({
        providerCode: r.provider_code,
        engineCode: r.engine_code,
        bucketStart: r.bucket_start,
        requests: r.requests,
        successes: r.successes,
        failures: r.failures,
        timeouts: r.timeouts,
        p50Ms: r.p50_ms,
        p95Ms: r.p95_ms,
        costUsd: r.cost_usd.toString(),
        breakerState: r.breaker_state,
      }));
    },
  };

  // --- The extraction review queue (8.20) ------------------------------------------------------------------------
  async function snapshotFor(item) {
    return prisma.answer_snapshots.findFirst({
      where: { id: item.snapshot_id, run_date: item.run_date, org_id: item.org_id },
    });
  }

  const review = {
    /** Open and in-review items, oldest first. Each says what kind it is, which engine and question, and nothing about the customer. */
    async list({ status = 'open', source = null, limit = 50 } = {}) {
      const statuses = status === 'all' ? ['open', 'in_review'] : [status];
      const items = await prisma.review_items.findMany({
        where: { status: { in: statuses }, ...(source ? { source } : {}) },
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        take: Math.min(limit, 200),
      });
      const out = [];
      for (const item of items) {
        const snap = await snapshotFor(item);
        const prompt = snap
          ? await prisma.prompts.findFirst({
              where: { id: snap.prompt_id, org_id: item.org_id },
              select: { text: true },
            })
          : null;
        out.push({
          id: item.id,
          source: item.source,
          status: item.status,
          reportKind: item.report_kind,
          createdAt: item.created_at,
          engineCode: snap?.engine_code ?? null,
          question: prompt?.text ?? null,
          excerpt: snap?.text_excerpt ?? null,
          assignedStaffId: item.assigned_staff_id,
        });
      }
      return out;
    },

    /** Counts of open items by source, for the badge on the module. */
    async counts() {
      const rows = await prisma.review_items.groupBy({
        by: ['source'],
        where: { status: { in: ['open', 'in_review'] } },
        _count: { _all: true },
      });
      return Object.fromEntries(rows.map((r) => [r.source, r._count._all]));
    },

    /**
     * One item with what a reviewer needs to decide: the question, the answer's excerpt, what the pre-pass and Claude each
     * found (the mentions), and the names being tracked with their aliases and exclusions. Never the customer's name.
     */
    async get(id) {
      const item = await prisma.review_items.findUnique({ where: { id } });
      if (!item) return null;
      const snap = await snapshotFor(item);
      const [prompt, mentions, entities] = await Promise.all([
        snap
          ? prisma.prompts.findFirst({
              where: { id: snap.prompt_id, org_id: item.org_id },
              select: { text: true },
            })
          : null,
        snap
          ? prisma.mentions.findMany({
              where: { snapshot_id: snap.id, run_date: snap.run_date, org_id: item.org_id },
              orderBy: { mention_order: 'asc' },
            })
          : [],
        prisma.tracked_entities.findMany({
          where: { project_id: item.project_id, org_id: item.org_id },
          include: { entity_aliases: { orderBy: { id: 'asc' } } },
          orderBy: { id: 'asc' },
        }),
      ]);
      const nameOf = new Map(entities.map((e) => [String(e.id), e.name]));
      return {
        id: item.id,
        source: item.source,
        status: item.status,
        reportKind: item.report_kind,
        reportComment: item.report_comment,
        details: item.details,
        resolution: item.resolution,
        resolutionNote: item.resolution_note,
        reextractRequestedAt: item.reextract_requested_at,
        goldenSetExportedAt: item.golden_set_exported_at,
        assignedStaffId: item.assigned_staff_id,
        createdAt: item.created_at,
        customerReported: Boolean(item.reported_by_user_id),
        entityId: item.entity_id,
        orgId: item.org_id,
        snapshotId: item.snapshot_id,
        answer: snap && {
          engineCode: snap.engine_code,
          status: snap.status,
          excerpt: snap.text_excerpt,
          question: prompt?.text ?? null,
          extractionStatus: snap.extraction_status,
        },
        mentions: mentions.map((m) => ({
          entityName: nameOf.get(String(m.entity_id)) ?? 'Unknown',
          writtenAs: m.name_as_written,
          detectedBy: m.detected_by,
          stance: m.stance,
          excerpt: m.excerpt,
          excluded: m.is_excluded,
        })),
        tracked: entities
          .filter((e) => e.status !== 'ignored')
          .map((e) => ({
            id: e.id,
            kind: e.kind,
            name: e.name,
            aliases: e.entity_aliases.filter((a) => a.kind === 'name').map((a) => a.value),
            exclusions: e.entity_aliases.filter((a) => a.kind === 'exclude').map((a) => a.value),
          })),
      };
    },

    /** Take an item: it moves to in review under the staff member. Only an open one can be taken (two reviewers can't both). */
    async assign(id, staffId) {
      const done = await prisma.review_items.updateMany({
        where: { id, status: 'open' },
        data: { status: 'in_review', assigned_staff_id: staffId },
      });
      return done.count === 1;
    },

    /** Decide an item. Only one that is not yet decided can be, and the resolution has to be one we know. */
    async resolve(id, { staffId, resolution, note = null, now = new Date() }) {
      const done = await prisma.review_items.updateMany({
        where: { id, status: { in: ['open', 'in_review'] } },
        data: {
          status: 'resolved',
          resolution,
          resolution_note: note ? String(note).slice(0, 1000) : null,
          resolved_by_staff_id: staffId,
          resolved_at: now,
        },
      });
      return done.count === 1;
    },

    /** Turn a report down (a "That's not us" that was us, say), with the reason. */
    async reject(id, { staffId, note, now = new Date() }) {
      const done = await prisma.review_items.updateMany({
        where: { id, status: { in: ['open', 'in_review'] } },
        data: {
          status: 'rejected',
          resolution_note: String(note ?? '').slice(0, 1000),
          resolved_by_staff_id: staffId,
          resolved_at: now,
        },
      });
      return done.count === 1;
    },

    /**
     * Add a name alias or an exclusion ("that's a different business") to the tracked entity the item is about, from the
     * review. Needs an item that names an entity. The same alias twice is harmless.
     */
    async addAlias(id, { staffId, kind, value }) {
      if (!['name', 'exclude'].includes(kind)) throw new DomainError('INVALID_KIND');
      const clean = String(value ?? '')
        .trim()
        .slice(0, 255);
      if (clean.length < 2) throw new DomainError('INVALID_VALUE');
      const item = await prisma.review_items.findUnique({ where: { id } });
      if (!item?.entity_id) throw new DomainError('NO_ENTITY');
      try {
        await prisma.entity_aliases.create({
          data: {
            org_id: item.org_id,
            project_id: item.project_id,
            entity_id: item.entity_id,
            kind,
            value: clean,
            value_normalized: normalizeEntityName(clean),
            source: 'review',
            created_by_staff_id: staffId,
          },
        });
        return true;
      } catch (err) {
        if (isUniqueViolation(err)) return false;
        throw err;
      }
    },

    /**
     * Ask for the answer to be read again: its reading is marked pending, and the caller queues the job. Returns the IDs the
     * job needs, or null when the answer cannot be read again (it was never collected).
     */
    async requestReextract(id, { now = new Date() } = {}) {
      const item = await prisma.review_items.findUnique({ where: { id } });
      if (!item) return null;
      const snap = await snapshotFor(item);
      if (!snap || snap.status !== 'ok') return null;
      await transaction(prisma, async (tx) => {
        await tx.answer_snapshots.updateMany({
          where: { id: snap.id, run_date: snap.run_date, org_id: item.org_id },
          data: { extraction_status: 'pending' },
        });
        await tx.review_items.update({ where: { id }, data: { reextract_requested_at: now } });
      });
      return { orgId: item.org_id, snapshotId: snap.id };
    },

    /** Mark an item as added to the golden set (the set itself lives in the repository: evals/extraction). */
    async markGolden(id, { now = new Date() } = {}) {
      const done = await prisma.review_items.updateMany({
        where: { id, golden_set_exported_at: null },
        data: { golden_set_exported_at: now },
      });
      return done.count === 1;
    },
  };

  // --- Feature flags (8.21) --------------------------------------------------------------------------------------
  const flags = {
    /** Every flag with its default and the organizations that override it. */
    async list() {
      const [rows, overrides] = await Promise.all([
        prisma.feature_flags.findMany({ orderBy: { flag_key: 'asc' } }),
        prisma.feature_flag_overrides.findMany({
          include: { organizations: { select: { public_id: true, name: true } } },
          orderBy: [{ flag_key: 'asc' }, { org_id: 'asc' }],
        }),
      ]);
      return rows.map((f) => ({
        key: f.flag_key,
        description: f.description,
        enabledDefault: f.enabled_default,
        updatedAt: f.updated_at,
        overrides: overrides
          .filter((o) => o.flag_key === f.flag_key)
          .map((o) => ({
            orgId: o.org_id,
            orgPublicId: o.organizations.public_id,
            orgName: o.organizations.name,
            enabled: o.enabled,
          })),
      }));
    },

    /** Make sure every flag the application reads has a row, so the console can show and change it. Keeps any default already set. */
    async ensureKnown() {
      for (const [key, description] of Object.entries(KNOWN_FLAGS)) {
        await prisma.$executeRaw`
          INSERT INTO feature_flags (flag_key, description, enabled_default) VALUES (${key}, ${description}, TRUE)
          ON DUPLICATE KEY UPDATE description = VALUES(description)`;
      }
    },

    /** Create a flag or change its default and words. Idempotent. */
    async set({ key, description, enabledDefault, staffId }) {
      await prisma.$executeRaw`
        INSERT INTO feature_flags (flag_key, description, enabled_default, updated_by_staff_id)
        VALUES (${key}, ${String(description).slice(0, 255)}, ${Boolean(enabledDefault)}, ${staffId})
        ON DUPLICATE KEY UPDATE description = VALUES(description),
          enabled_default = VALUES(enabled_default), updated_by_staff_id = VALUES(updated_by_staff_id)`;
      return true;
    },

    /** Turn a flag on or off for one organization, by its public ID. Returns false for a flag or organization that does not exist. */
    async setOverride({ key, orgPublicId, enabled, staffId }) {
      const [flag, org] = await Promise.all([
        prisma.feature_flags.findUnique({ where: { flag_key: key } }),
        prisma.organizations.findFirst({
          where: { public_id: orgPublicId, deleted_at: null },
          select: { id: true },
        }),
      ]);
      if (!flag || !org) return false;
      await prisma.$executeRaw`
        INSERT INTO feature_flag_overrides (flag_key, org_id, enabled, set_by_staff_id)
        VALUES (${key}, ${org.id}, ${Boolean(enabled)}, ${staffId})
        ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), set_by_staff_id = VALUES(set_by_staff_id)`;
      return true;
    },

    /** Take an organization's own setting away: it follows the default again. */
    async clearOverride({ key, orgPublicId }) {
      const org = await prisma.organizations.findFirst({
        where: { public_id: orgPublicId },
        select: { id: true },
      });
      if (!org) return false;
      const done = await prisma.feature_flag_overrides.deleteMany({
        where: { flag_key: key, org_id: org.id },
      });
      return done.count === 1;
    },

    /**
     * Is the flag on, for this organization (or for everyone, with no organization)? A flag nobody has created is off:
     * a typo in code must not switch something on. The exception is a flag the application itself reads (KNOWN_FLAGS): until
     * someone has opened the console it has no row, and it is on, as its description says.
     */
    async isEnabled(key, orgId = null) {
      const flag = await prisma.feature_flags.findUnique({ where: { flag_key: key } });
      if (!flag) return Object.hasOwn(KNOWN_FLAGS, key);
      let override = null;
      if (orgId !== null) {
        const row = await prisma.feature_flag_overrides.findUnique({
          where: { flag_key_org_id: { flag_key: key, org_id: orgId } },
        });
        override = row ? row.enabled : null;
      }
      return resolveFlag({ defaultEnabled: flag.enabled_default, override });
    },
  };

  // --- Spend caps ------------------------------------------------------------------------------------------------
  const spend = {
    /**
     * The organizations whose cap matters today: those that spent something since UTC midnight, have a cap of their own,
     * or are paused. With `orgPublicId`, that one organization whatever its state. Names and money, nothing else.
     */
    async list({ now = new Date(), orgPublicId = null, limit = 100 } = {}) {
      const spentRows = await prisma.usage_ledger.groupBy({
        by: ['org_id'],
        where: { occurred_at: { gte: utcDayStart(now) }, org_id: { not: null } },
        _sum: { cost_usd: true },
      });
      const spentOf = new Map(
        spentRows.map((r) => [r.org_id, toMicros(r._sum.cost_usd?.toString() ?? '0')]),
      );
      const orgs = await prisma.organizations.findMany({
        where: orgPublicId
          ? { public_id: orgPublicId, deleted_at: null }
          : {
              deleted_at: null,
              OR: [
                { id: { in: [...spentOf.keys()] } },
                { spend_cap_usd_daily: { not: null } },
                { collection_paused_until: { gt: now } },
              ],
            },
        select: {
          id: true,
          public_id: true,
          name: true,
          plan_code: true,
          spend_cap_usd_daily: true,
          collection_paused_until: true,
        },
        orderBy: { id: 'asc' },
        take: Math.min(limit, 500),
      });
      return orgs.map((o) => ({
        orgPublicId: o.public_id,
        orgName: o.name,
        planCode: o.plan_code,
        orgCapUsd: o.spend_cap_usd_daily?.toString() ?? null,
        pausedUntil: o.collection_paused_until,
        spentMicros: spentOf.get(o.id) ?? 0,
      }));
    },

    /**
     * Set an organization's own daily cap (`capUsd`, two-decimal text), or take it away with `null` so it follows its plan
     * again. Returns what it was and what it is now, or `null` if there is no such organization. Collection that the old cap
     * paused resumes at the next spend check (15 minutes at most), which compares today's spend with the new cap.
     */
    async setCap({ orgPublicId, capUsd }) {
      const org = await prisma.organizations.findFirst({
        where: { public_id: orgPublicId, deleted_at: null },
        select: { id: true, name: true, spend_cap_usd_daily: true },
      });
      if (!org) return null;
      await prisma.organizations.update({
        where: { id: org.id },
        data: { spend_cap_usd_daily: capUsd },
      });
      return {
        orgName: org.name,
        before: org.spend_cap_usd_daily?.toString() ?? null,
        after: capUsd,
      };
    },
  };

  const autopilot = {
    /**
     * Where Autopilot is switched on across organizations, for the staff console (read-only; the kill switch is the `autopilot`
     * feature flag). Names and counts, never what was prepared: no recommendation, draft or code is read here.
     */
    async overview({ now = new Date(), limit = 200 } = {}) {
      const since = new Date(now.getTime() - 7 * 86_400_000);
      const settings = await prisma.autopilot_settings.findMany({
        where: { OR: [{ enabled: true }, { paused_at: { not: null } }] },
        include: { projects: { select: { name: true, domain: true, deleted_at: true } } },
        orderBy: { id: 'asc' },
        take: Math.min(limit, 500),
      });
      const live = settings.filter((s) => !s.projects.deleted_at);
      const projectIds = live.map((s) => s.project_id);
      const [orgs, readyRows, weekRows] = projectIds.length
        ? await Promise.all([
            prisma.organizations.findMany({
              where: { id: { in: [...new Set(live.map((s) => s.org_id))] }, deleted_at: null },
              select: { id: true, public_id: true, name: true, plan_code: true },
            }),
            prisma.autopilot_items.groupBy({
              by: ['project_id'],
              where: { project_id: { in: projectIds }, status: 'ready' },
              _count: { _all: true },
            }),
            prisma.autopilot_items.groupBy({
              by: ['project_id'],
              where: { project_id: { in: projectIds }, created_at: { gte: since } },
              _count: { _all: true },
            }),
          ])
        : [[], [], []];
      const orgOf = new Map(orgs.map((o) => [o.id, o]));
      const ready = new Map(readyRows.map((r) => [r.project_id, r._count._all]));
      const week = new Map(weekRows.map((r) => [r.project_id, r._count._all]));
      const rows = live
        .filter((s) => orgOf.has(s.org_id))
        .map((s) => ({
          orgPublicId: orgOf.get(s.org_id).public_id,
          orgName: orgOf.get(s.org_id).name,
          planCode: orgOf.get(s.org_id).plan_code,
          projectName: s.projects.name,
          projectDomain: s.projects.domain,
          enabled: s.enabled,
          pausedAt: s.paused_at,
          ready: ready.get(s.project_id) ?? 0,
          preparedWeek: week.get(s.project_id) ?? 0,
          lastTickAt: s.last_tick_at,
          lastTick: s.last_tick ?? null,
        }));
      return {
        rows,
        totals: {
          on: rows.filter((r) => r.enabled && !r.pausedAt).length,
          paused: rows.filter((r) => r.pausedAt).length,
          ready: rows.reduce((n, r) => n + r.ready, 0),
          preparedWeek: rows.reduce((n, r) => n + r.preparedWeek, 0),
        },
      };
    },
  };

  return { costs, providers, review, flags, spend, autopilot };
}
