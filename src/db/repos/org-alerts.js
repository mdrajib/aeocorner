import { claimKey } from '../../core/alerts.js';
import { prefAllows, readPrefs } from '../../core/notify.js';
import { DomainError } from '../errors.js';

/**
 * What an organization's alerts and weekly digest are built from, and who gets them (Milestone 8, tasks 8.13–8.15).
 * Merged into `forOrg(orgId)` as `alerts` and `notifyPrefs`; the organization is bound once and no function takes an
 * `org_id` argument. The rules (which change deserves an email, what the digest says) are in src/core/alerts.js and
 * digest.js; this file only finds the rows.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** A change older than this is history, not news: it is never alerted late. */
const ALERT_WINDOW_DAYS = 14;
/** A claim about the brand is looked for in answers from this long ago. */
const CLAIM_WINDOW_DAYS = 7;
/** A claim already told about in the last 90 days is not told about again. */
const CLAIM_MEMORY_DAYS = 90;

export function alertRepos(prisma, orgId) {
  async function ownProject(projectId) {
    const found = await prisma.projects.findFirst({
      where: { id: projectId, org_id: orgId },
      select: { id: true },
    });
    if (!found) throw new DomainError('PROJECT_NOT_IN_ORG');
  }

  async function names(projectId) {
    const [entities, engines] = await Promise.all([
      prisma.tracked_entities.findMany({
        where: { project_id: projectId, org_id: orgId },
        select: { id: true, kind: true, name: true },
      }),
      prisma.engines.findMany({ select: { code: true, name: true } }),
    ]);
    return {
      brand: entities.find((e) => e.kind === 'brand') ?? null,
      entityNames: Object.fromEntries(entities.map((e) => [String(e.id), e.name])),
      engineNames: Object.fromEntries(engines.map((e) => [e.code, e.name])),
    };
  }

  const alerts = {
    /**
     * What may be worth an email for a project right now: significant changes nobody has been alerted about yet, and
     * negative claims about the brand in recent answers that we have not already told anyone about. Names come with it
     * so the words can say "ChatGPT" and "Rival Dental".
     */
    async pending(projectId, { now = new Date() } = {}) {
      await ownProject(projectId);
      const { brand, entityNames, engineNames } = await names(projectId);

      const events = await prisma.change_events.findMany({
        where: {
          project_id: projectId,
          org_id: orgId,
          is_significant: true,
          alerted_at: null,
          created_at: { gte: new Date(now.getTime() - ALERT_WINDOW_DAYS * DAY_MS) },
        },
        orderBy: { id: 'asc' },
      });

      let claims = [];
      if (brand) {
        const since = new Date(now.getTime() - CLAIM_WINDOW_DAYS * DAY_MS);
        const rows = await prisma.claims.findMany({
          where: {
            project_id: projectId,
            org_id: orgId,
            entity_id: brand.id,
            polarity: 'negative',
            run_date: { gte: new Date(`${since.toISOString().slice(0, 10)}T00:00:00Z`) },
          },
          select: { attribute: true, claim_value: true, snapshot_id: true, run_date: true },
        });
        const snapshotIds = [...new Set(rows.map((r) => r.snapshot_id))];
        const snaps = snapshotIds.length
          ? await prisma.answer_snapshots.findMany({
              where: { id: { in: snapshotIds }, project_id: projectId, org_id: orgId },
              select: { id: true, engine_code: true },
            })
          : [];
        const engineOf = new Map(snaps.map((s) => [String(s.id), s.engine_code]));
        const grouped = new Map();
        for (const r of rows) {
          const key = `${r.attribute}\n${r.claim_value.trim().toLowerCase()}`;
          const g = grouped.get(key) ?? {
            attribute: r.attribute,
            value: r.claim_value,
            snapshots: new Set(),
            engines: new Set(),
          };
          g.snapshots.add(String(r.snapshot_id));
          const engine = engineOf.get(String(r.snapshot_id));
          if (engine) g.engines.add(engine);
          grouped.set(key, g);
        }

        // Claims already told about, remembered in the alert emails' own records.
        const earlier = await prisma.notifications.findMany({
          where: {
            org_id: orgId,
            project_id: projectId,
            kind: 'alert',
            created_at: { gte: new Date(now.getTime() - CLAIM_MEMORY_DAYS * DAY_MS) },
          },
          select: { payload: true },
        });
        const told = new Set(earlier.flatMap((n) => n.payload?.keys ?? []));
        claims = [...grouped.values()]
          .map((g) => ({
            attribute: g.attribute,
            value: g.value,
            count: g.snapshots.size,
            engineCodes: [...g.engines].sort(),
          }))
          .filter((c) => !told.has(claimKey(c)))
          .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
      }
      return { events, claims, brand, entityNames, engineNames };
    },

    /** Mark change events as alerted, so they are never alerted twice. Only this project's own events. */
    async markAlerted(projectId, eventIds, { now = new Date() } = {}) {
      await ownProject(projectId);
      if (eventIds.length === 0) return 0;
      const done = await prisma.change_events.updateMany({
        where: { id: { in: eventIds }, project_id: projectId, org_id: orgId, alerted_at: null },
        data: { alerted_at: now },
      });
      return done.count;
    },

    /**
     * Who may be emailed about a project: members who can see it, whose preferences allow `kind`, and who have not
     * deleted their account. An owner or admin sees every project; a client seat only the ones chosen for them.
     */
    async recipients(projectId, kind) {
      await ownProject(projectId);
      const members = await prisma.memberships.findMany({
        where: { org_id: orgId },
        select: {
          user_id: true,
          role: true,
          project_access: true,
          notify_prefs: true,
          membership_projects: { select: { project_id: true } },
          users: {
            select: { id: true, email: true, name: true, timezone: true, deleted_at: true },
          },
        },
        orderBy: { id: 'asc' },
      });
      return members
        .filter((m) => m.users && !m.users.deleted_at)
        .filter(
          (m) =>
            m.project_access === 'all' ||
            m.membership_projects.some((p) => p.project_id === projectId),
        )
        .filter((m) => prefAllows(m.notify_prefs, kind))
        .map((m) => ({
          userId: m.users.id,
          role: m.role,
          email: m.users.email,
          name: m.users.name,
          timezone: m.users.timezone,
        }));
    },

    /**
     * The week's news for the digest: the significant changes of the last seven days and the before/after proofs won in
     * that time, with the names to say them in. The figures themselves come from the rollups (`metrics.range`).
     */
    async digestFacts(projectId, { now = new Date() } = {}) {
      await ownProject(projectId);
      const since = new Date(now.getTime() - 7 * DAY_MS);
      const [{ brand, entityNames, engineNames }, events, outcomes, lastRun] = await Promise.all([
        names(projectId),
        prisma.change_events.findMany({
          where: {
            project_id: projectId,
            org_id: orgId,
            is_significant: true,
            created_at: { gte: since },
          },
          orderBy: { id: 'asc' },
        }),
        prisma.action_outcomes.findMany({
          where: {
            project_id: projectId,
            org_id: orgId,
            verdict: 'proven_win',
            computed_at: { gte: since },
          },
          select: {
            n_before: true,
            k_before: true,
            n_after: true,
            k_after: true,
            recommendations: { select: { title: true } },
          },
          orderBy: { id: 'asc' },
        }),
        prisma.runs.findFirst({
          where: {
            project_id: projectId,
            org_id: orgId,
            status: { in: ['complete', 'partial'] },
            finished_at: { not: null },
          },
          orderBy: { finished_at: 'desc' },
          select: { finished_at: true },
        }),
      ]);
      return {
        brandId: brand?.id ?? null,
        entityNames,
        engineNames,
        events,
        wins: outcomes.map((o) => ({
          title: o.recommendations.title,
          nBefore: o.n_before,
          kBefore: o.k_before,
          nAfter: o.n_after,
          kAfter: o.k_after,
        })),
        lastFinishedAt: lastRun?.finished_at ?? null,
      };
    },
  };

  const notifyPrefs = {
    /** One member's email choices in this organization (the defaults when they never chose). */
    async get(userId) {
      const m = await prisma.memberships.findFirst({
        where: { org_id: orgId, user_id: userId },
        select: { notify_prefs: true },
      });
      return m ? readPrefs(m.notify_prefs) : null;
    },

    /** Save a member's choices. Only the two known switches are kept, and only for a member of this organization. */
    async set(userId, prefs) {
      const clean = { digest: Boolean(prefs.digest), alerts: Boolean(prefs.alerts) };
      const done = await prisma.memberships.updateMany({
        where: { org_id: orgId, user_id: userId },
        data: { notify_prefs: clean },
      });
      if (done.count !== 1) throw new DomainError('NOT_FOUND');
      return clean;
    },
  };

  return { alerts, notifyPrefs };
}
