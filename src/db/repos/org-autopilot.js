import { AUTOPILOT, LOWERS_CONFIDENCE, REJECT_REASONS } from '../../core/autopilot.js';
import { ulid } from '../../lib/ulid.js';
import { DomainError, isUniqueViolation } from '../errors.js';
import { transaction } from '../transaction.js';

/**
 * One organization's Autopilot (Milestone 15, ADR-0016). Merged into `forOrg(orgId)` as `autopilot`; the organization is bound
 * once, no function takes an `org_id` from its arguments, and every query names it and the project.
 *
 * Autopilot PREPARES and a person APPROVES, so nothing here approves, applies or publishes. An item is created `ready`; the only
 * ways out are:
 *   - `reject` (a person, with a reason),
 *   - `withdraw` (the system: the fix is no longer needed),
 *   - `settle`, which marks an item `approved` ONLY IF a person has actually approved what it points at, through the Action
 *     Center's own approve route: a change in `site_changes` with an `approved_by_user_id`, or a content item holding
 *     `approved_revision_id`. It records a decision somebody else made; it never makes one.
 */

const toJson = (value) => JSON.parse(JSON.stringify(value));

/** What a project has until its owner chooses otherwise: off, both kinds allowed, two drafts a week. */
const DEFAULTS = Object.freeze({
  enabled: false,
  allowAutoFix: true,
  allowContent: true,
  weeklyDrafts: AUTOPILOT.defaultWeeklyDrafts,
});

const toSettings = (r) =>
  r
    ? {
        exists: true,
        enabled: r.enabled,
        allowAutoFix: r.allow_auto_fix,
        allowContent: r.allow_content,
        weeklyDrafts: r.weekly_drafts,
        pausedAt: r.paused_at,
        pausedByUserId: r.paused_by_user_id,
        updatedByUserId: r.updated_by_user_id,
        updatedAt: r.updated_at,
        lastTickAt: r.last_tick_at,
        lastTick: r.last_tick ?? null,
      }
    : {
        exists: false,
        ...DEFAULTS,
        pausedAt: null,
        pausedByUserId: null,
        updatedByUserId: null,
        updatedAt: null,
        lastTickAt: null,
        lastTick: null,
      };

const toItem = (r) => ({
  id: r.id,
  publicId: r.public_id,
  projectId: r.project_id,
  recommendationId: r.recommendation_id,
  kind: r.kind,
  status: r.status,
  weekKey: r.week_key,
  basisHash: r.basis_hash,
  title: r.title,
  summary: r.summary,
  preparedHash: r.prepared_hash,
  prepared: r.prepared ?? null,
  contentItemId: r.content_item_id,
  rejectReason: r.reject_reason,
  rejectNote: r.reject_note,
  withdrawnReason: r.withdrawn_reason,
  decidedByUserId: r.decided_by_user_id,
  decidedAt: r.decided_at,
  createdAt: r.created_at,
});

/** Statuses of a change or an item that mean a person said yes. */
const CHANGE_APPROVED = ['approved', 'applying', 'applied', 'failed', 'rolled_back'];

export function autopilotRepos(prisma, orgId, { appendActivity }) {
  async function ownProject(projectId) {
    const project = await prisma.projects.findFirst({
      where: { id: projectId, org_id: orgId, deleted_at: null },
      select: { id: true },
    });
    if (!project) throw new DomainError('PROJECT_NOT_IN_ORG');
    return project;
  }

  /** The settings row, made when it is first needed (a unique key makes two at once one). */
  async function ensureRow(projectId, now) {
    const existing = await prisma.autopilot_settings.findFirst({
      where: { org_id: orgId, project_id: projectId },
    });
    if (existing) return existing;
    try {
      return await prisma.autopilot_settings.create({
        data: { org_id: orgId, project_id: projectId, created_at: now },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      return prisma.autopilot_settings.findFirstOrThrow({
        where: { org_id: orgId, project_id: projectId },
      });
    }
  }

  const event = (tx, rec, kind, { actor = 'system', userId = null, note, now }) =>
    tx.recommendation_events.create({
      data: {
        org_id: orgId,
        recommendation_id: rec.id,
        from_status: rec.status,
        to_status: kind,
        actor_type: actor,
        actor_user_id: userId,
        note: note ? String(note).slice(0, 500) : null,
        created_at: now,
      },
    });

  const autopilot = {
    // ----- settings -----------------------------------------------------------------------------------------

    async settings(projectId) {
      await ownProject(projectId);
      return toSettings(
        await prisma.autopilot_settings.findFirst({
          where: { org_id: orgId, project_id: projectId },
        }),
      );
    },

    /** Owner or admin changed the switches. Turning it on is a decision somebody made, and is written down as one. */
    async saveSettings(projectId, value, { userId, now = new Date() }) {
      await ownProject(projectId);
      if (!userId) throw new DomainError('SETTINGS_NEED_A_PERSON');
      return transaction(prisma, async (tx) => {
        const before = await tx.autopilot_settings.findFirst({
          where: { org_id: orgId, project_id: projectId },
        });
        if (!before) {
          try {
            await tx.autopilot_settings.create({
              data: { org_id: orgId, project_id: projectId, created_at: now },
            });
          } catch (err) {
            if (!isUniqueViolation(err)) throw err;
          }
        }
        await tx.autopilot_settings.updateMany({
          where: { org_id: orgId, project_id: projectId },
          data: {
            enabled: Boolean(value.enabled),
            allow_auto_fix: Boolean(value.allowAutoFix),
            allow_content: Boolean(value.allowContent),
            weekly_drafts: value.weeklyDrafts,
            updated_by_user_id: userId,
          },
        });
        const changed =
          !before ||
          before.enabled !== Boolean(value.enabled) ||
          before.allow_auto_fix !== Boolean(value.allowAutoFix) ||
          before.allow_content !== Boolean(value.allowContent) ||
          before.weekly_drafts !== value.weeklyDrafts;
        if (changed) {
          await appendActivity(tx, {
            actorUserId: userId,
            action: value.enabled ? 'autopilot.settings_saved' : 'autopilot.turned_off',
            targetType: 'project',
            targetId: projectId,
            summary: value.enabled
              ? `Autopilot is on: ${value.allowAutoFix ? 'fixes' : 'no fixes'}, ${value.allowContent ? `${value.weeklyDrafts} drafts a week` : 'no drafts'}`
              : 'Autopilot was turned off',
          });
        }
        return { changed };
      });
    },

    /** The project-level pause: nothing is prepared while it is set. The settings stay as they were. */
    async setPaused(projectId, paused, { userId, now = new Date() }) {
      await ownProject(projectId);
      if (!userId) throw new DomainError('SETTINGS_NEED_A_PERSON');
      await ensureRow(projectId, now);
      return transaction(prisma, async (tx) => {
        const r = await tx.autopilot_settings.updateMany({
          where: {
            org_id: orgId,
            project_id: projectId,
            paused_at: paused ? null : { not: null },
          },
          data: {
            paused_at: paused ? now : null,
            paused_by_user_id: paused ? userId : null,
            updated_by_user_id: userId,
          },
        });
        if (r.count === 1) {
          await appendActivity(tx, {
            actorUserId: userId,
            action: paused ? 'autopilot.paused' : 'autopilot.resumed',
            targetType: 'project',
            targetId: projectId,
            summary: paused ? 'Autopilot was paused' : 'Autopilot was resumed',
          });
        }
        return { changed: r.count === 1 };
      });
    },

    /** What the latest tick did or why it did not, for the screen and the staff console. */
    async recordTick(projectId, summary, { now = new Date() } = {}) {
      await ownProject(projectId);
      await ensureRow(projectId, now);
      await prisma.autopilot_settings.updateMany({
        where: { org_id: orgId, project_id: projectId },
        data: { last_tick_at: now, last_tick: toJson(summary) },
      });
    },

    // ----- items --------------------------------------------------------------------------------------------

    /** Everything prepared so far, in the shape the planner counts: whatever became of an item, it was prepared. */
    async forPlanning(projectId) {
      await ownProject(projectId);
      const rows = await prisma.autopilot_items.findMany({
        where: { org_id: orgId, project_id: projectId },
        select: {
          recommendation_id: true,
          basis_hash: true,
          kind: true,
          status: true,
          week_key: true,
          created_at: true,
        },
      });
      return rows.map((r) => ({
        recommendationId: r.recommendation_id,
        basisHash: r.basis_hash,
        kind: r.kind,
        status: r.status,
        weekKey: r.week_key,
        createdAt: r.created_at,
      }));
    },

    async list(projectId, { statuses = null, limit = 100 } = {}) {
      await ownProject(projectId);
      const rows = await prisma.autopilot_items.findMany({
        where: {
          org_id: orgId,
          project_id: projectId,
          ...(statuses ? { status: { in: statuses } } : {}),
        },
        orderBy: { id: 'desc' },
        take: Math.min(limit, 200),
      });
      return rows.map(toItem);
    },

    /** One item by its public id, or null when it is not this project's (or this organization's). */
    async get(projectId, publicId) {
      await ownProject(projectId);
      if (!/^[0-9A-Z]{26}$/.test(String(publicId))) return null;
      const row = await prisma.autopilot_items.findFirst({
        where: { org_id: orgId, project_id: projectId, public_id: String(publicId) },
      });
      return row ? toItem(row) : null;
    },

    /** The ready item for a recommendation, if there is one: what the Action Center says "Autopilot prepared this" from. */
    async readyFor(projectId, recommendationId) {
      await ownProject(projectId);
      const row = await prisma.autopilot_items.findFirst({
        where: {
          org_id: orgId,
          project_id: projectId,
          recommendation_id: recommendationId,
          status: 'ready',
        },
        orderBy: { id: 'desc' },
      });
      return row ? toItem(row) : null;
    },

    async readyCount(projectId) {
      await ownProject(projectId);
      return prisma.autopilot_items.count({
        where: { org_id: orgId, project_id: projectId, status: 'ready' },
      });
    },

    /**
     * Write down what was prepared. One item per recommendation and basis: asking twice makes one, so a tick that runs twice,
     * or two at once, prepares an item once. The recommendation must still be open.
     *
     * @returns `{ created: true, item }` or `{ created: false }`
     */
    async prepare(
      projectId,
      {
        recommendationId,
        kind,
        basisHash,
        weekKey,
        title,
        summary = null,
        preparedHash = null,
        prepared = null,
        contentItemId = null,
        now = new Date(),
      },
    ) {
      await ownProject(projectId);
      if (!['auto_fix', 'content'].includes(kind)) throw new DomainError('BAD_KIND');
      if ((kind === 'auto_fix') !== Boolean(preparedHash)) throw new DomainError('BAD_PREPARED');
      try {
        return await transaction(prisma, async (tx) => {
          const rec = await tx.recommendations.findFirst({
            where: { id: recommendationId, org_id: orgId, project_id: projectId },
            select: { id: true, status: true },
          });
          if (!rec) throw new DomainError('RECOMMENDATION_NOT_FOUND');
          if (rec.status !== 'open') throw new DomainError('STALE_STATUS');
          if (contentItemId != null) {
            const content = await tx.content_items.findFirst({
              where: { id: contentItemId, org_id: orgId, project_id: projectId },
              select: { id: true },
            });
            if (!content) throw new DomainError('CONTENT_NOT_FOUND');
          }
          const row = await tx.autopilot_items.create({
            data: {
              public_id: ulid(now.getTime()),
              org_id: orgId,
              project_id: projectId,
              recommendation_id: rec.id,
              kind,
              week_key: weekKey,
              basis_hash: basisHash,
              title: String(title).slice(0, 255),
              summary: summary ? String(summary).slice(0, 500) : null,
              prepared_hash: preparedHash,
              prepared: prepared ? toJson(prepared) : undefined,
              content_item_id: contentItemId,
              created_at: now,
            },
          });
          await event(tx, rec, 'ap_prepared', {
            note:
              kind === 'auto_fix'
                ? 'Autopilot prepared a fix for your approval'
                : 'Autopilot started a draft for your review',
            now,
          });
          return { created: true, item: toItem(row) };
        });
      } catch (err) {
        if (isUniqueViolation(err, 'uq_autopilot_items_basis')) return { created: false };
        throw err;
      }
    },

    /** A person turned it down, with a reason. Only a ready item can be: a decided one is final. */
    async reject(projectId, publicId, { userId, reason, note = '', now = new Date() }) {
      await ownProject(projectId);
      if (!userId) throw new DomainError('DECISION_NEEDS_A_PERSON');
      if (!Object.hasOwn(REJECT_REASONS, reason)) throw new DomainError('BAD_REASON');
      return transaction(prisma, async (tx) => {
        const item = await tx.autopilot_items.findFirst({
          where: { org_id: orgId, project_id: projectId, public_id: String(publicId) },
        });
        if (!item) throw new DomainError('ITEM_NOT_FOUND');
        const r = await tx.autopilot_items.updateMany({
          where: { id: item.id, org_id: orgId, project_id: projectId, status: 'ready' },
          data: {
            status: 'rejected',
            reject_reason: reason,
            reject_note:
              String(note ?? '')
                .trim()
                .slice(0, 500) || null,
            decided_by_user_id: userId,
            decided_at: now,
          },
        });
        if (r.count !== 1) throw new DomainError('STALE_STATUS');
        const rec = await tx.recommendations.findFirst({
          where: { id: item.recommendation_id, org_id: orgId },
          select: { id: true, status: true },
        });
        if (rec) {
          await event(tx, rec, 'ap_rejected', {
            actor: 'user',
            userId,
            note: `Rejected: ${REJECT_REASONS[reason]}`,
            now,
          });
        }
        await appendActivity(tx, {
          actorUserId: userId,
          action: 'autopilot.rejected',
          targetType: 'autopilot_item',
          targetId: item.id,
          summary: `An Autopilot item was rejected: ${REJECT_REASONS[reason]}`,
        });
        return toItem({
          ...item,
          status: 'rejected',
          reject_reason: reason,
          decided_by_user_id: userId,
          decided_at: now,
        });
      });
    },

    /** The system takes an item off the list: the fix is not needed any more. Only a ready one; the reason is plain words. */
    async withdraw(projectId, itemId, reason, { now = new Date() } = {}) {
      await ownProject(projectId);
      const item = await prisma.autopilot_items.findFirst({
        where: { id: itemId, org_id: orgId, project_id: projectId },
      });
      if (!item) throw new DomainError('ITEM_NOT_FOUND');
      const r = await prisma.autopilot_items.updateMany({
        where: { id: item.id, org_id: orgId, project_id: projectId, status: 'ready' },
        data: { status: 'withdrawn', withdrawn_reason: String(reason).slice(0, 100) },
      });
      if (r.count === 1) {
        const rec = await prisma.recommendations.findFirst({
          where: { id: item.recommendation_id, org_id: orgId },
          select: { id: true, status: true },
        });
        if (rec) {
          await prisma.recommendation_events.create({
            data: {
              org_id: orgId,
              recommendation_id: rec.id,
              from_status: rec.status,
              to_status: 'ap_withdrawn',
              actor_type: 'system',
              note: String(reason).slice(0, 500),
              created_at: now,
            },
          });
        }
      }
      return { withdrawn: r.count === 1 };
    },

    /**
     * Follow what people did. A ready item becomes `approved` only when what it points at really was approved by a person:
     * a site change made for its recommendation after the item was prepared (with the person who approved it), or a content
     * item that holds an approved revision. This writes down somebody else's decision; it cannot make one.
     */
    async settle(projectId, { now = new Date() } = {}) {
      await ownProject(projectId);
      const ready = await prisma.autopilot_items.findMany({
        where: { org_id: orgId, project_id: projectId, status: 'ready' },
      });
      let approved = 0;
      for (const item of ready) {
        let by = null;
        if (item.kind === 'auto_fix') {
          const change = await prisma.site_changes.findFirst({
            where: {
              org_id: orgId,
              project_id: projectId,
              recommendation_id: item.recommendation_id,
              status: { in: CHANGE_APPROVED },
              approved_by_user_id: { not: null },
              approved_at: { gte: item.created_at },
            },
            orderBy: { id: 'asc' },
          });
          if (change) by = { userId: change.approved_by_user_id, at: change.approved_at };
        } else if (item.content_item_id != null) {
          const content = await prisma.content_items.findFirst({
            where: {
              id: item.content_item_id,
              org_id: orgId,
              project_id: projectId,
              approved_revision_id: { not: null },
              approved_at: { not: null },
              approved_by_user_id: { not: null },
            },
            select: { approved_by_user_id: true, approved_at: true },
          });
          if (content) by = { userId: content.approved_by_user_id, at: content.approved_at };
        }
        if (!by) continue;
        const r = await prisma.autopilot_items.updateMany({
          where: { id: item.id, org_id: orgId, project_id: projectId, status: 'ready' },
          data: { status: 'approved', decided_by_user_id: by.userId, decided_at: by.at },
        });
        if (r.count === 1) {
          approved += 1;
          const rec = await prisma.recommendations.findFirst({
            where: { id: item.recommendation_id, org_id: orgId },
            select: { id: true, status: true },
          });
          if (rec) {
            await prisma.recommendation_events.create({
              data: {
                org_id: orgId,
                recommendation_id: rec.id,
                from_status: rec.status,
                to_status: 'ap_approved',
                actor_type: 'user',
                actor_user_id: by.userId,
                note: 'Approved from what Autopilot prepared',
                created_at: now,
              },
            });
          }
        }
      }
      return { approved };
    },

    /**
     * How this project's people answered what was prepared, by rule: `{ [ruleCode]: { rejected, accepted } }`. Only a rejection
     * that says the rule is not right for them (`not_useful`, `wrong_content`) counts against it; "not now" says nothing.
     */
    async decisionCounts(projectId) {
      await ownProject(projectId);
      const rows = await prisma.autopilot_items.findMany({
        where: { org_id: orgId, project_id: projectId, status: { in: ['approved', 'rejected'] } },
        select: {
          status: true,
          reject_reason: true,
          recommendations: { select: { rule_code: true } },
        },
      });
      const out = {};
      for (const r of rows) {
        const code = r.recommendations.rule_code;
        out[code] ??= { rejected: 0, accepted: 0 };
        if (r.status === 'approved') out[code].accepted += 1;
        else if (LOWERS_CONFIDENCE.includes(r.reject_reason)) out[code].rejected += 1;
      }
      return out;
    },

    /** The ready items with the recommendation each one is about, for the inbox. */
    async inbox(projectId) {
      await ownProject(projectId);
      const rows = await prisma.autopilot_items.findMany({
        where: { org_id: orgId, project_id: projectId, status: 'ready' },
        orderBy: { id: 'desc' },
        include: { recommendations: { select: { rule_code: true, status: true, ice: true } } },
      });
      return rows.map((r) => ({
        ...toItem(r),
        ruleCode: r.recommendations.rule_code,
        recommendationStatus: r.recommendations.status,
        ice: Number(r.recommendations.ice),
      }));
    },
  };

  return { autopilot };
}
