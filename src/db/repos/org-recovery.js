import {
  canMoveCase,
  CLOSED_STATUSES,
  inCooldown,
  METRICS,
  OPEN_STATUSES,
  openKey,
} from '../../core/recovery.js';
import { STATUS_LABELS as REC_STATUS_LABELS } from '../../core/recommendation-lifecycle.js';
import { DomainError, isUniqueViolation } from '../errors.js';
import { ulid } from '../../lib/ulid.js';
import { transaction } from '../transaction.js';

/**
 * One organization's visibility recovery cases (Milestone 14). Merged into `forOrg(orgId)` as `recovery`; the organization is
 * bound once and no function takes an `org_id` from its arguments, and every query below names it and the project.
 *
 * A case holds counts, never rates: what the figure was before, what it fell to and what it is now, as `n` answers of which
 * `k` named the brand. Only the system moves a case (`canMoveCase`); the rules for opening, diagnosing and closing are pure
 * code in `src/core/recovery.js`, and this file only reads and writes. A decline opens exactly one case: the open key
 * (`metric:engine`) is unique per project while the case is open, and a repeated job finds the case that is already there.
 */

const day = (value) => new Date(`${new Date(value).toISOString().slice(0, 10)}T00:00:00Z`);
const dayText = (value) => new Date(value).toISOString().slice(0, 10);
const toNumber = (value) => (value == null ? null : Number(value));
const toJson = (value) => JSON.parse(JSON.stringify(value));
const DAY_MS = 86_400_000;

/** How far back we look for our own changes that could line up with a fall. */
const CHANGE_LOOKBACK_DAYS = 60;
/** The recommendations whose fix should be on the site: done, being checked or measured, or already judged. */
const FIX_STATUSES = [
  'done',
  'verified',
  'unverified',
  'measuring',
  'proven_win',
  'no_change',
  'declined',
];
const MAX_FIXES = 25;

const toCase = (r) => ({
  id: r.id,
  publicId: r.public_id,
  projectId: r.project_id,
  metric: r.metric,
  engineCode: r.engine_code,
  status: r.status,
  openKey: r.open_key,
  triggerEventId: r.trigger_event_id,
  baseline: {
    start: dayText(r.baseline_start),
    end: dayText(r.baseline_end),
    n: r.baseline_n,
    k: r.baseline_k,
  },
  decline: {
    start: dayText(r.decline_start),
    end: dayText(r.decline_end),
    n: r.decline_n,
    k: r.decline_k,
  },
  recent: { n: r.recent_n, k: r.recent_k },
  p: toNumber(r.p_value),
  onsetDate: r.onset_date ? dayText(r.onset_date) : null,
  openedAt: r.opened_at,
  recheck: r.recheck ?? null,
  recheckDoneAt: r.recheck_done_at,
  diagnosis: r.diagnosis ?? null,
  diagnosedAt: r.diagnosed_at,
  repairs: r.repairs ?? [],
  closedAt: r.closed_at,
  closeDetails: r.close_details ?? null,
  alertedAt: r.alerted_at,
});

export function recoveryRepos(prisma, orgId) {
  async function ownProject(projectId) {
    const project = await prisma.projects.findFirst({
      where: { id: projectId, org_id: orgId, deleted_at: null },
      select: { id: true },
    });
    if (!project) throw new DomainError('PROJECT_NOT_IN_ORG');
    return project;
  }

  const event = (db, projectId, caseId, kind, details = null, now = new Date()) =>
    db.recovery_events.create({
      data: {
        org_id: orgId,
        project_id: projectId,
        case_id: caseId,
        kind,
        details: details == null ? undefined : toJson(details),
        created_at: now,
      },
    });

  const recovery = {
    /**
     * Open the case for a lasting decline (`judgeDecline` with verdict `lasting`), once. Returns `{ created, case }`:
     * `created` is false when a case for the same metric and engine is already open (the job ran twice), and the case is
     * null, with `reason: 'cooldown'`, when one for it ended inside the cooldown.
     */
    async open(
      projectId,
      decline,
      { onset = null, triggerEventId = null, asOf, now = new Date() },
    ) {
      await ownProject(projectId);
      const key = openKey(decline.metric, decline.engineCode);
      const existing = await prisma.recovery_cases.findFirst({
        where: { org_id: orgId, project_id: projectId, open_key: key },
      });
      if (existing) return { created: false, case: toCase(existing) };

      const last = await prisma.recovery_cases.findFirst({
        where: {
          org_id: orgId,
          project_id: projectId,
          metric: decline.metric,
          engine_code: decline.engineCode ?? null,
          open_key: null,
        },
        orderBy: { closed_at: 'desc' },
      });
      if (last && inCooldown(last.closed_at, now))
        return { created: false, case: null, reason: 'cooldown' };

      try {
        const created = await transaction(prisma, async (tx) => {
          const row = await tx.recovery_cases.create({
            data: {
              public_id: ulid(now.getTime()),
              org_id: orgId,
              project_id: projectId,
              metric: decline.metric,
              engine_code: decline.engineCode ?? null,
              status: 'diagnosing',
              open_key: key,
              trigger_event_id: triggerEventId,
              baseline_start: day(decline.baseline.window[0]),
              baseline_end: day(decline.baseline.window[1]),
              baseline_n: decline.baseline.n,
              baseline_k: decline.baseline.k,
              decline_start: day(decline.decline.window[0]),
              decline_end: day(decline.decline.window[1]),
              decline_n: decline.decline.n,
              decline_k: decline.decline.k,
              recent_n: decline.recent.n,
              recent_k: decline.recent.k,
              p_value: decline.p == null ? null : decline.p.toFixed(8),
              onset_date: onset ? day(onset) : null,
              opened_at: now,
            },
          });
          await event(
            tx,
            projectId,
            row.id,
            'opened',
            {
              asOf: dayText(asOf),
              deltaPp: decline.deltaPp,
              baseline: { n: decline.baseline.n, k: decline.baseline.k },
              decline: { n: decline.decline.n, k: decline.decline.k },
              recent: { n: decline.recent.n, k: decline.recent.k },
            },
            now,
          );
          return row;
        });
        return { created: true, case: toCase(created) };
      } catch (err) {
        // Two jobs at once: the other one's case stands.
        if (!isUniqueViolation(err, 'uq_recovery_cases_open')) throw err;
        const found = await prisma.recovery_cases.findFirst({
          where: { org_id: orgId, project_id: projectId, open_key: key },
        });
        return { created: false, case: found ? toCase(found) : null };
      }
    },

    /** A project's cases, open ones first and then the newest closed. `view`: `open`, `closed` or all. */
    async list(projectId, { view = null, limit = 50 } = {}) {
      await ownProject(projectId);
      const rows = await prisma.recovery_cases.findMany({
        where: {
          org_id: orgId,
          project_id: projectId,
          ...(view === 'open' ? { status: { in: OPEN_STATUSES } } : {}),
          ...(view === 'closed' ? { status: { in: CLOSED_STATUSES } } : {}),
        },
        orderBy: [{ opened_at: 'desc' }, { id: 'desc' }],
        take: Math.min(Math.max(1, limit), 200),
      });
      return rows.map(toCase);
    },

    async openCount(projectId) {
      await ownProject(projectId);
      return prisma.recovery_cases.count({
        where: { org_id: orgId, project_id: projectId, status: { in: OPEN_STATUSES } },
      });
    },

    /** One case by its public id (the address), or null. */
    async get(projectId, publicId) {
      await ownProject(projectId);
      if (!/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(String(publicId))) return null;
      const row = await prisma.recovery_cases.findFirst({
        where: { org_id: orgId, project_id: projectId, public_id: String(publicId).toUpperCase() },
      });
      return row ? toCase(row) : null;
    },

    async byId(projectId, caseId) {
      await ownProject(projectId);
      const row = await prisma.recovery_cases.findFirst({
        where: { org_id: orgId, project_id: projectId, id: caseId },
      });
      return row ? toCase(row) : null;
    },

    /** The case's timeline, oldest first. */
    async events(projectId, caseId) {
      await ownProject(projectId);
      const rows = await prisma.recovery_events.findMany({
        where: { org_id: orgId, project_id: projectId, case_id: caseId },
        orderBy: { id: 'asc' },
      });
      return rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        details: r.details ?? {},
        at: r.created_at,
      }));
    },

    /** The change event a case was opened from, if one was stored. */
    async triggerEvent(projectId, kaseRow) {
      await ownProject(projectId);
      if (!kaseRow.triggerEventId) return null;
      return prisma.change_events.findFirst({
        where: { id: kaseRow.triggerEventId, org_id: orgId, project_id: projectId },
      });
    },

    /** The change event that matches a decline, so the case can say which alert it follows (null when none was stored). */
    async matchingEvent(projectId, decline, asOf) {
      await ownProject(projectId);
      const kind = METRICS[decline.metric].kind;
      return prisma.change_events.findFirst({
        where: {
          org_id: orgId,
          project_id: projectId,
          kind,
          engine_code: decline.engineCode ?? null,
          direction: 'down',
          is_significant: true,
          after_end: { lte: day(asOf) },
        },
        orderBy: { id: 'desc' },
      });
    },

    /** Store the re-checks taken when the case opened. Only once: a repeated job keeps the first result. */
    async saveRecheck(projectId, caseId, recheck, { now = new Date() } = {}) {
      await ownProject(projectId);
      return transaction(prisma, async (tx) => {
        const done = await tx.recovery_cases.updateMany({
          where: {
            id: caseId,
            org_id: orgId,
            project_id: projectId,
            status: { in: OPEN_STATUSES },
            recheck_done_at: null,
          },
          data: { recheck: toJson(recheck), recheck_done_at: now },
        });
        if (done.count === 1) await event(tx, projectId, caseId, 'rechecked', recheck, now);
        return done.count === 1;
      });
    },

    /**
     * Keep the diagnosis the code made. A named diagnosis moves a `diagnosing` case to `repairing` and links its repairs; a
     * "can't tell" leaves it `diagnosing` (the next evaluation tries again with fresher evidence). Returns the new status,
     * or null when the case was no longer open.
     */
    async saveDiagnosis(projectId, caseId, { diagnosis, repairs, now = new Date() }) {
      await ownProject(projectId);
      return transaction(prisma, async (tx) => {
        const row = await tx.recovery_cases.findFirst({
          where: {
            id: caseId,
            org_id: orgId,
            project_id: projectId,
            status: { in: OPEN_STATUSES },
          },
        });
        if (!row) return null;
        const named = diagnosis.outcome === 'named';
        const next =
          named && row.status === 'diagnosing' && canMoveCase('diagnosing', 'repairing')
            ? 'repairing'
            : row.status;
        const same =
          JSON.stringify(row.diagnosis?.causes?.map((c) => c.code) ?? null) ===
            JSON.stringify(diagnosis.causes.map((c) => c.code)) &&
          row.diagnosis?.outcome === diagnosis.outcome;
        await tx.recovery_cases.updateMany({
          where: { id: caseId, org_id: orgId, project_id: projectId, status: row.status },
          data: {
            diagnosis: toJson(diagnosis),
            diagnosed_at: now,
            repairs: toJson(repairs),
            status: next,
          },
        });
        // The timeline says what changed, not that the same answer was read again.
        if (!same) {
          await event(
            tx,
            projectId,
            caseId,
            'diagnosed',
            {
              outcome: diagnosis.outcome,
              causes: diagnosis.causes.map((c) => ({ code: c.code, band: c.band })),
            },
            now,
          );
          if (repairs.length > 0)
            await event(tx, projectId, caseId, 'repairs_linked', { repairs: repairs.length }, now);
        }
        return next;
      });
    },

    /**
     * Close an open case, once. `status` is `recovered`, `closed_noise` or `closed_unknown`; the open key is freed so a new
     * decline can open a new case after the cooldown. Returns false when the case was already closed.
     */
    async close(projectId, caseId, { status, recent, now = new Date() }) {
      await ownProject(projectId);
      if (!canMoveCase('repairing', status)) throw new DomainError('CASE_MOVE_NOT_ALLOWED');
      return transaction(prisma, async (tx) => {
        const done = await tx.recovery_cases.updateMany({
          where: {
            id: caseId,
            org_id: orgId,
            project_id: projectId,
            status: { in: OPEN_STATUSES },
          },
          data: { status, open_key: null, closed_at: now, close_details: toJson(recent) },
        });
        if (done.count === 1) await event(tx, projectId, caseId, status, recent, now);
        return done.count === 1;
      });
    },

    /** Cases nobody has been told about yet, newest first: opened in the last 14 days. */
    async pendingAlerts(projectId, { now = new Date() } = {}) {
      await ownProject(projectId);
      const rows = await prisma.recovery_cases.findMany({
        where: {
          org_id: orgId,
          project_id: projectId,
          alerted_at: null,
          opened_at: { gte: new Date(now.getTime() - 14 * DAY_MS) },
        },
        orderBy: { id: 'asc' },
      });
      return rows.map(toCase);
    },

    async markAlerted(projectId, caseIds, { now = new Date() } = {}) {
      await ownProject(projectId);
      if (caseIds.length === 0) return 0;
      return transaction(prisma, async (tx) => {
        const rows = await tx.recovery_cases.findMany({
          where: { id: { in: caseIds }, org_id: orgId, project_id: projectId, alerted_at: null },
          select: { id: true },
        });
        const done = await tx.recovery_cases.updateMany({
          where: {
            id: { in: rows.map((r) => r.id) },
            org_id: orgId,
            project_id: projectId,
            alerted_at: null,
          },
          data: { alerted_at: now },
        });
        for (const r of rows) await event(tx, projectId, r.id, 'alerted', null, now);
        return done.count;
      });
    },

    /**
     * What the diagnosis may look at besides the numbers: our own applied or taken-back site changes lately, the last site
     * check before the fall began and the latest one, and the fixes that should be on the site now.
     */
    async evidence(projectId, { onset, now = new Date() }) {
      await ownProject(projectId);
      const since = new Date(
        Math.min(now.getTime(), day(onset).getTime()) - CHANGE_LOOKBACK_DAYS * DAY_MS,
      );
      const [changes, scanRows, fixRows] = await Promise.all([
        prisma.site_changes.findMany({
          where: {
            org_id: orgId,
            project_id: projectId,
            status: { in: ['applied', 'rolled_back'] },
            applied_at: { gte: since },
          },
          orderBy: { id: 'asc' },
          select: {
            id: true,
            kind: true,
            target_url: true,
            applied_at: true,
            status: true,
            recommendation_id: true,
          },
        }),
        prisma.site_scans.findMany({
          where: { org_id: orgId, project_id: projectId, status: { in: ['complete', 'partial'] } },
          orderBy: [{ finished_at: 'desc' }, { id: 'desc' }],
          take: 40,
          select: { id: true, finished_at: true, readiness_score: true },
        }),
        prisma.recommendations.findMany({
          where: { org_id: orgId, project_id: projectId, status: { in: FIX_STATUSES } },
          orderBy: [{ done_at: 'desc' }, { id: 'desc' }],
          take: MAX_FIXES,
          select: {
            id: true,
            rule_code: true,
            title: true,
            status: true,
            done_at: true,
            verified_at: true,
            fix_path: true,
          },
        }),
      ]);

      const onsetDay = dayText(onset);
      const latestScan = scanRows[0] ?? null;
      const beforeScan =
        scanRows.find((s) => s.finished_at && dayText(s.finished_at) < onsetDay) ?? null;
      const checksOf = async (scan) =>
        scan
          ? {
              id: scan.id,
              finishedAt: scan.finished_at,
              score: scan.readiness_score,
              checks: (
                await prisma.scan_checks.findMany({
                  where: { scan_id: scan.id, org_id: orgId },
                  select: { check_code: true, status: true },
                })
              ).map((c) => ({ code: c.check_code, status: c.status })),
            }
          : null;

      const recIds = fixRows.map((f) => f.id);
      const [content, changeRows] = recIds.length
        ? await Promise.all([
            prisma.content_items.findMany({
              where: {
                org_id: orgId,
                project_id: projectId,
                recommendation_id: { in: recIds },
                status: 'published',
              },
              select: { recommendation_id: true, published_url: true },
            }),
            prisma.site_changes.findMany({
              where: {
                org_id: orgId,
                project_id: projectId,
                recommendation_id: { in: recIds },
                status: 'applied',
              },
              select: { recommendation_id: true },
            }),
          ])
        : [[], []];
      const urlOf = new Map(
        content
          .filter((c) => c.published_url)
          .map((c) => [String(c.recommendation_id), c.published_url]),
      );
      const autofixed = new Set(changeRows.map((c) => String(c.recommendation_id)));

      return {
        siteChanges: changes.map((c) => ({
          id: c.id,
          kind: c.kind,
          targetUrl: c.target_url,
          appliedAt: c.applied_at,
          rolledBack: c.status === 'rolled_back',
          recommendationId: c.recommendation_id,
        })),
        scans: { before: await checksOf(beforeScan), latest: await checksOf(latestScan) },
        fixes: fixRows.map((f) => ({
          recommendationId: f.id,
          ruleCode: f.rule_code,
          title: f.title,
          status: f.status,
          doneAt: f.done_at,
          verifiedBefore:
            f.verified_at != null ||
            ['verified', 'measuring', 'proven_win', 'no_change', 'declined'].includes(f.status),
          publishedUrl: urlOf.get(String(f.id)) ?? null,
          autofix: autofixed.has(String(f.id)),
        })),
      };
    },

    /**
     * Where each repair stands now: the open recommendations it points at (by rule code, or one by id) with their status,
     * our own change for an undo, and whether anything was done since the case opened (`repaired`, which lets the system
     * tell "recovered" from "recovered by itself").
     */
    async repairProgress(projectId, kase) {
      await ownProject(projectId);
      const opened = kase.openedAt;
      const done = (at) => Boolean(at) && new Date(at).getTime() >= opened.getTime();
      const out = [];
      let repaired = false;
      for (const repair of kase.repairs ?? []) {
        const item = { ...repair, links: [] };
        if (repair.kind === 'undo') {
          const change = await prisma.site_changes.findFirst({
            where: { id: BigInt(repair.siteChangeId), org_id: orgId, project_id: projectId },
            select: {
              id: true,
              status: true,
              rolled_back_at: true,
              recommendation_id: true,
              kind: true,
            },
          });
          if (change) {
            const undone = done(change.rolled_back_at);
            repaired ||= undone;
            item.links.push({
              recommendationId: change.recommendation_id,
              title: undone ? 'Our change was taken back' : 'Our change is still on your site',
              status: undone ? 'done' : change.status,
              done: undone,
            });
          }
        } else if (repair.kind === 'redo') {
          const rec = await prisma.recommendations.findFirst({
            where: { id: BigInt(repair.recommendationId), org_id: orgId, project_id: projectId },
            select: { id: true, title: true, status: true, done_at: true },
          });
          if (rec) {
            const isDone = done(rec.done_at);
            repaired ||= isDone;
            item.links.push({
              recommendationId: rec.id,
              title: rec.title,
              status: rec.status,
              statusLabel: REC_STATUS_LABELS[rec.status],
              done: isDone,
            });
          }
        } else if (repair.kind === 'rules' && repair.ruleCodes?.length) {
          const recs = await prisma.recommendations.findMany({
            where: {
              org_id: orgId,
              project_id: projectId,
              rule_code: { in: repair.ruleCodes },
              status: { notIn: ['dismissed'] },
            },
            orderBy: [{ ice: 'desc' }, { id: 'asc' }],
            take: 8,
            select: { id: true, title: true, status: true, done_at: true, updated_at: true },
          });
          for (const rec of recs) {
            // An old finished one that nobody did since the case opened is history, not a repair in progress.
            const isDone = done(rec.done_at);
            if (['proven_win', 'no_change', 'declined'].includes(rec.status) && !isDone) continue;
            repaired ||= isDone;
            item.links.push({
              recommendationId: rec.id,
              title: rec.title,
              status: rec.status,
              statusLabel: REC_STATUS_LABELS[rec.status],
              done: isDone,
            });
          }
        }
        out.push(item);
      }
      return { repairs: out, repaired };
    },
  };

  return { recovery };
}
