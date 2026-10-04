import { approvalBlockers, canMove, OPEN, retryStage } from '../../core/content-lifecycle.js';
import { analyzeBody } from '../../core/content-html.js';
import { DomainError, isUniqueViolation } from '../errors.js';
import { entitledLimit } from './org-billing.js';
import { Prisma } from '../generated/client/client.ts';
import { transaction } from '../transaction.js';
import { ulid } from '../../lib/ulid.js';

/**
 * One organization's Content Studio and integrations (Milestone 7, MVP F8 and F9): items on the board, their
 * revisions, the approval that pins one revision, publishing to WordPress, and the WordPress connection itself.
 * Merged into `forOrg(orgId)` as `content` and `integrations`; the organization is bound once and no function takes
 * an `org_id` from its arguments.
 *
 * Who may do what is decided in `src/core/content-lifecycle.js`; every status write here asks that table, names the
 * old status in its WHERE (two clicks, or a click and a job, cannot both win) and says who made the move. The pipeline
 * stages are the system's (`saveResearch`, `saveBrief`, `saveDraft`, `saveQc`, `fail`, `finishPublish`); approval is
 * only ever a person's (`approve`), and it pins the exact revision, the one that is later published.
 *
 * `content_revisions` has no project column: it is reached only through an item that was first found in this
 * organization and project.
 */

/** Drafts a month until the founder sets the plan limits (task 0.17); refreshes count as half. */
export const DRAFTS_PLACEHOLDER = 4;

const toNumber = (v) => (v == null ? 0 : Number(v));
const toJson = (v) => JSON.parse(JSON.stringify(v));
const monthStart = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

const toItem = (c) => ({
  id: c.id,
  publicId: c.public_id,
  projectId: c.project_id,
  recommendationId: c.recommendation_id,
  kind: c.kind,
  format: c.format,
  title: c.title,
  targetUrl: c.target_url,
  status: c.status,
  brief: c.brief,
  research: c.research,
  qc: c.qc,
  qcScore: c.qc_score,
  jsonld: c.jsonld,
  currentRevisionId: c.current_revision_id,
  approvedRevisionId: c.approved_revision_id,
  quotaUnits: toNumber(c.quota_units),
  llmCostUsd: toNumber(c.llm_cost_usd),
  approvedByUserId: c.approved_by_user_id,
  approvedAt: c.approved_at,
  cmsRef: c.cms_ref,
  publishedUrl: c.published_url,
  publishedAt: c.published_at,
  failedStage: c.failed_stage,
  failureReason: c.failure_reason,
  createdByUserId: c.created_by_user_id,
  createdAt: c.created_at,
  updatedAt: c.updated_at,
});

const toRevision = (r, { body = false } = {}) => ({
  id: r.id,
  revision: r.revision,
  source: r.source,
  wordCount: r.word_count,
  createdByUserId: r.created_by_user_id,
  createdAt: r.created_at,
  ...(body ? { bodyHtml: r.body_html } : {}),
});

const toIntegration = (i) => ({
  id: i.id,
  type: i.type,
  status: i.status,
  config: i.config ?? {},
  lastSuccessAt: i.last_success_at,
  lastErrorAt: i.last_error_at,
  lastError: i.last_error,
  connectedAt: i.connected_at,
  disconnectedAt: i.disconnected_at,
  hasSecret: Boolean(i.secret_ciphertext),
});

const toSiteChange = (s) => ({
  id: s.id,
  kind: s.kind,
  status: s.status,
  targetUrl: s.target_url,
  remoteRef: s.remote_ref,
  payload: s.payload,
  appliedAt: s.applied_at,
  lastError: s.last_error,
  createdAt: s.created_at,
});

export function contentRepos(prisma, orgId) {
  async function ownProject(projectId) {
    const project = await prisma.projects.findFirst({
      where: { id: projectId, org_id: orgId, deleted_at: null },
      select: { id: true, domain: true },
    });
    if (!project) throw new DomainError('PROJECT_NOT_IN_ORG');
    return project;
  }

  const findItem = (db, projectId, ref) =>
    db.content_items.findFirst({
      where: {
        org_id: orgId,
        project_id: projectId,
        ...(typeof ref === 'string' && !/^\d+$/.test(ref)
          ? { public_id: ref }
          : { id: BigInt(ref) }),
      },
    });

  /** Move an item along: asked of the lifecycle table, written only if it still has the status it was read with. */
  async function moveRow(db, item, to, actor, fields = {}) {
    if (!canMove(item.status, to, actor)) {
      throw new DomainError('INVALID_TRANSITION', `${item.status} -> ${to} by ${actor}`);
    }
    const result = await db.content_items.updateMany({
      where: { id: item.id, org_id: orgId, status: item.status },
      data: { ...fields, status: to },
    });
    if (result.count !== 1) throw new DomainError('STALE_STATUS');
    return { ...item, status: to };
  }

  /**
   * Take `units` from this month's draft allowance. The check and the increment are one statement, so two requests
   * at once cannot both take the last unit. The limit is the plan's plus add-ons (src/db/repos/org-billing.js). A
   * customer with the metered "extra drafts" add-on is let through past the limit; those units are counted and the
   * hourly usage report tells Stripe about each one (src/worker/handlers/billing.js).
   */
  async function takeDraftUnits(db, units, now) {
    const limit = await entitledLimit(db, orgId, 'drafts', now);
    const period = monthStart(now);
    await db.$executeRaw`
      INSERT INTO quota_usage (org_id, period_month, meter, used_units)
      VALUES (${orgId}, ${period}, 'drafts', 0)
      ON DUPLICATE KEY UPDATE org_id = org_id`;
    const taken =
      limit === null
        ? await db.$executeRaw`
      UPDATE quota_usage SET used_units = used_units + ${units}
      WHERE org_id = ${orgId} AND period_month = ${period} AND meter = 'drafts'`
        : await db.$executeRaw`
      UPDATE quota_usage SET used_units = used_units + ${units}
      WHERE org_id = ${orgId} AND period_month = ${period} AND meter = 'drafts' AND used_units + ${units} <= ${limit}`;
    let allowed = Number(taken) === 1;
    let metered = false;
    if (!allowed) {
      const grant = await db.entitlement_grants.findFirst({
        where: {
          org_id: orgId,
          source: 'addon',
          meter: 'drafts',
          amount: 0,
          starts_at: { lte: now },
          OR: [{ ends_at: null }, { ends_at: { gt: now } }],
        },
        select: { id: true },
      });
      if (grant) {
        await db.$executeRaw`
          UPDATE quota_usage SET used_units = used_units + ${units}
          WHERE org_id = ${orgId} AND period_month = ${period} AND meter = 'drafts'`;
        allowed = true;
        metered = true;
      }
    }
    const row = await db.quota_usage.findFirst({
      where: { org_id: orgId, period_month: period, meter: 'drafts' },
    });
    return { allowed, metered, used: toNumber(row?.used_units), limit };
  }

  async function giveBackDraftUnits(db, units, when) {
    await db.$executeRaw`
      UPDATE quota_usage SET used_units = GREATEST(0, used_units - ${units})
      WHERE org_id = ${orgId} AND period_month = ${monthStart(when)} AND meter = 'drafts'`;
  }

  const addCost = (usd) => (usd > 0 ? { llm_cost_usd: { increment: usd.toFixed(6) } } : {});

  const content = {
    /**
     * A new item for a recommendation or a question. The month's draft allowance is taken in the same transaction (a
     * refresh counts half). One recommendation has at most one open item.
     *
     * @returns the item, or `{ blocked: 'quota', used, limit }`
     */
    async create(
      projectId,
      {
        recommendationId = null,
        promptIds = [],
        kind = 'new',
        format = 'other',
        title,
        targetUrl = null,
        userId = null,
        now = new Date(),
      },
    ) {
      await ownProject(projectId);
      if (!String(title ?? '').trim()) throw new DomainError('TITLE_REQUIRED');
      const units = kind === 'refresh' ? 0.5 : 1;
      return transaction(prisma, async (tx) => {
        if (recommendationId != null) {
          const rec = await tx.recommendations.findFirst({
            where: { id: BigInt(recommendationId), project_id: projectId, org_id: orgId },
            select: { id: true },
          });
          if (!rec) throw new DomainError('RECOMMENDATION_NOT_FOUND');
          const open = await tx.content_items.findFirst({
            where: {
              org_id: orgId,
              project_id: projectId,
              recommendation_id: rec.id,
              status: { in: OPEN },
            },
            select: { public_id: true },
          });
          if (open) throw new DomainError('CONTENT_ALREADY_OPEN', open.public_id);
        }
        const prompts = promptIds.length
          ? await tx.prompts.findMany({
              where: {
                org_id: orgId,
                project_id: projectId,
                id: { in: promptIds.map((p) => BigInt(p)) },
              },
              select: { id: true },
            })
          : [];
        if (prompts.length !== new Set(promptIds.map(String)).size)
          throw new DomainError('PROMPT_NOT_IN_PROJECT');
        const taken = await takeDraftUnits(tx, units, now);
        if (!taken.allowed) return { blocked: 'quota', used: taken.used, limit: taken.limit };
        const row = await tx.content_items.create({
          data: {
            public_id: ulid(now.getTime()),
            org_id: orgId,
            project_id: projectId,
            recommendation_id: recommendationId == null ? null : BigInt(recommendationId),
            kind,
            format,
            title: String(title).trim().slice(0, 255),
            target_url: targetUrl ? String(targetUrl).slice(0, 2048) : null,
            quota_units: units.toFixed(1),
            created_by_user_id: userId,
            created_at: now,
          },
        });
        if (prompts.length) {
          await tx.content_target_prompts.createMany({
            data: prompts.map((p) => ({ content_item_id: row.id, prompt_id: p.id, org_id: orgId })),
          });
        }
        return toItem(row);
      });
    },

    /** Items of a project, newest first; `statuses` narrows the list. */
    async list(projectId, { statuses = null, limit = 100 } = {}) {
      await ownProject(projectId);
      const rows = await prisma.content_items.findMany({
        where: {
          org_id: orgId,
          project_id: projectId,
          ...(statuses ? { status: { in: statuses } } : { status: { not: 'archived' } }),
        },
        orderBy: { id: 'desc' },
        take: limit,
      });
      return rows.map((r) => {
        const item = toItem(r);
        // The board needs no bodies: leave the big JSON out.
        return {
          ...item,
          brief: undefined,
          research: undefined,
          jsonld: undefined,
          qc: item.qc ? { blocking: item.qc.blocking ?? [] } : null,
        };
      });
    },

    /** One item by its public id (the address) or its numeric id (a job), with its current revision's text. */
    async get(projectId, ref) {
      await ownProject(projectId);
      const row = await findItem(prisma, projectId, ref);
      if (!row) return null;
      const [current, revisions, prompts] = await Promise.all([
        row.current_revision_id
          ? prisma.content_revisions.findFirst({
              where: { id: row.current_revision_id, content_item_id: row.id, org_id: orgId },
            })
          : null,
        prisma.content_revisions.findMany({
          where: { content_item_id: row.id, org_id: orgId },
          orderBy: { revision: 'desc' },
          take: 50,
        }),
        prisma.content_target_prompts.findMany({
          where: { content_item_id: row.id, org_id: orgId },
          select: { prompt_id: true },
        }),
      ]);
      return {
        ...toItem(row),
        current: current ? toRevision(current, { body: true }) : null,
        revisions: revisions.map((r) => toRevision(r)),
        promptIds: prompts.map((p) => String(p.prompt_id)),
      };
    },

    /** The text of one revision of an item. */
    async revision(projectId, ref, revision) {
      await ownProject(projectId);
      const item = await findItem(prisma, projectId, ref);
      if (!item) return null;
      const row = await prisma.content_revisions.findFirst({
        where: { content_item_id: item.id, org_id: orgId, revision: Number(revision) },
      });
      return row ? toRevision(row, { body: true }) : null;
    },

    /** The newest item of each recommendation of a project: `Map<recommendationId, { publicId, status }>`. */
    async forRecommendations(projectId, recommendationIds) {
      await ownProject(projectId);
      if (recommendationIds.length === 0) return new Map();
      const rows = await prisma.content_items.findMany({
        where: {
          org_id: orgId,
          project_id: projectId,
          recommendation_id: { in: recommendationIds.map((r) => BigInt(r)) },
          status: { not: 'archived' },
        },
        orderBy: { id: 'asc' },
        select: { recommendation_id: true, public_id: true, status: true },
      });
      return new Map(
        rows.map((r) => [r.recommendation_id, { publicId: r.public_id, status: r.status }]),
      );
    },

    async counts(projectId) {
      await ownProject(projectId);
      const grouped = await prisma.content_items.groupBy({
        by: ['status'],
        where: { org_id: orgId, project_id: projectId },
        _count: { _all: true },
      });
      return Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
    },

    // ----- the pipeline: the system's moves ------------------------------------------------------------------

    /** Research is done: keep the facts, go on to planning. Repeating it after the item moved on does nothing. */
    async saveResearch(projectId, ref, { research, costUsd = 0 }) {
      await ownProject(projectId);
      const item = await findItem(prisma, projectId, ref);
      if (!item) throw new DomainError('CONTENT_NOT_FOUND');
      if (item.status !== 'researching') return { skipped: true };
      await moveRow(prisma, item, 'briefing', 'system', {
        research: toJson(research),
        ...addCost(costUsd),
        failed_stage: null,
        failure_reason: null,
      });
      return { skipped: false };
    },

    async saveBrief(projectId, ref, { brief, costUsd = 0 }) {
      await ownProject(projectId);
      const item = await findItem(prisma, projectId, ref);
      if (!item) throw new DomainError('CONTENT_NOT_FOUND');
      if (item.status !== 'briefing') return { skipped: true };
      await moveRow(prisma, item, 'drafting', 'system', {
        brief: toJson(brief),
        format: brief.format,
        title: String(brief.title).slice(0, 255),
        ...addCost(costUsd),
      });
      return { skipped: false };
    },

    /** The draft is written: a new revision becomes the current one, and the item goes on to the check. */
    async saveDraft(projectId, ref, { html, costUsd = 0, now = new Date() }) {
      await ownProject(projectId);
      return transaction(prisma, async (tx) => {
        const item = await findItem(tx, projectId, ref);
        if (!item) throw new DomainError('CONTENT_NOT_FOUND');
        if (item.status !== 'drafting') return { skipped: true };
        const last = await tx.content_revisions.findFirst({
          where: { content_item_id: item.id, org_id: orgId },
          orderBy: { revision: 'desc' },
          select: { revision: true },
        });
        const revision = (last?.revision ?? 0) + 1;
        const row = await tx.content_revisions.create({
          data: {
            org_id: orgId,
            content_item_id: item.id,
            revision,
            body_html: html,
            word_count: analyzeBody(html).words,
            source: revision === 1 ? 'ai_draft' : 'ai_revision',
            created_at: now,
          },
        });
        await moveRow(tx, item, 'qc', 'system', {
          current_revision_id: row.id,
          ...addCost(costUsd),
          qc: Prisma.DbNull,
          qc_score: null,
          failed_stage: null,
          failure_reason: null,
        });
        return { skipped: false, revisionId: row.id, revision };
      });
    },

    /** The check of one revision. Ignored if the text has moved on since (a newer check is on its way). */
    async saveQc(projectId, ref, { revisionId, qc, jsonld }) {
      await ownProject(projectId);
      const item = await findItem(prisma, projectId, ref);
      if (!item) throw new DomainError('CONTENT_NOT_FOUND');
      if (item.status !== 'qc' || item.current_revision_id !== BigInt(revisionId))
        return { skipped: true };
      await moveRow(prisma, item, 'ready', 'system', {
        qc: toJson({ ...qc, revisionId: String(revisionId) }),
        qc_score: qc.score,
        jsonld: jsonld ? toJson(jsonld) : Prisma.DbNull,
      });
      return { skipped: false };
    },

    /** A stage failed. If no draft was ever written the month's allowance is given back. */
    async fail(projectId, ref, { stage, reason, costUsd = 0, now = new Date() }) {
      await ownProject(projectId);
      return transaction(prisma, async (tx) => {
        const item = await findItem(tx, projectId, ref);
        if (!item) throw new DomainError('CONTENT_NOT_FOUND');
        if (!canMove(item.status, 'failed', 'system')) return { skipped: true };
        await moveRow(tx, item, 'failed', 'system', {
          failed_stage: String(stage).slice(0, 16),
          failure_reason: String(reason).slice(0, 500),
          ...addCost(costUsd),
        });
        // A publish that failed leaves no change "working" for ever on the item's history.
        if (stage === 'publishing') {
          await tx.site_changes.updateMany({
            where: {
              content_item_id: item.id,
              org_id: orgId,
              status: { in: ['approved', 'applying'] },
            },
            data: { status: 'failed', last_error: String(reason).slice(0, 1000) },
          });
        }
        if (!item.current_revision_id && Number(item.quota_units) > 0)
          await giveBackDraftUnits(tx, Number(item.quota_units), item.created_at ?? now);
        return { skipped: false };
      });
    },

    // ----- a person's moves ---------------------------------------------------------------------------------

    /** The customer edited the brief. Allowed while the item waits for review. */
    async editBrief(projectId, ref, { brief, userId = null }) {
      await ownProject(projectId);
      const item = await findItem(prisma, projectId, ref);
      if (!item) throw new DomainError('CONTENT_NOT_FOUND');
      if (item.status !== 'ready')
        throw new DomainError('INVALID_TRANSITION', `edit brief in ${item.status}`);
      const result = await prisma.content_items.updateMany({
        where: { id: item.id, org_id: orgId, status: 'ready' },
        data: {
          brief: toJson({ ...brief, editedByUserId: userId == null ? null : String(userId) }),
          format: brief.format,
          title: String(brief.title).slice(0, 255),
        },
      });
      if (result.count !== 1) throw new DomainError('STALE_STATUS');
      return true;
    },

    /**
     * The customer edited the text: a new revision, and a new check. Approval, if there was one, is gone.
     * `expectedRevision` is the revision the editor started from; a newer one means somebody else saved first.
     */
    async saveEdit(projectId, ref, { html, expectedRevision, userId = null, now = new Date() }) {
      await ownProject(projectId);
      return transaction(prisma, async (tx) => {
        const item = await findItem(tx, projectId, ref);
        if (!item) throw new DomainError('CONTENT_NOT_FOUND');
        if (!['ready', 'approved'].includes(item.status))
          throw new DomainError('INVALID_TRANSITION', `edit in ${item.status}`);
        const last = await tx.content_revisions.findFirst({
          where: { content_item_id: item.id, org_id: orgId },
          orderBy: { revision: 'desc' },
          select: { revision: true, body_html: true },
        });
        if (expectedRevision != null && last?.revision !== Number(expectedRevision))
          throw new DomainError('STALE_REVISION');
        if (last?.body_html === html) return { unchanged: true, revision: last.revision };
        const revision = (last?.revision ?? 0) + 1;
        const row = await tx.content_revisions.create({
          data: {
            org_id: orgId,
            content_item_id: item.id,
            revision,
            body_html: html,
            word_count: analyzeBody(html).words,
            source: 'user_edit',
            created_by_user_id: userId,
            created_at: now,
          },
        });
        await moveRow(tx, item, 'qc', 'user', {
          current_revision_id: row.id,
          approved_revision_id: null,
          approved_at: null,
          approved_by_user_id: null,
          qc: Prisma.DbNull,
          qc_score: null,
        });
        return { unchanged: false, revision, revisionId: row.id };
      });
    },

    /**
     * Approve the draft. Only a person can; the check of THIS revision must have run and found nothing that blocks.
     * The revision approved is pinned, and it is the one that is published.
     *
     * @returns `{ approved: true }` or `{ approved: false, blockers: string[] }`
     */
    async approve(projectId, ref, { userId, revisionId, now = new Date() }) {
      await ownProject(projectId);
      return transaction(prisma, async (tx) => {
        const item = await findItem(tx, projectId, ref);
        if (!item) throw new DomainError('CONTENT_NOT_FOUND');
        if (!canMove(item.status, 'approved', 'user'))
          throw new DomainError('INVALID_TRANSITION', `${item.status} -> approved`);
        if (!userId) throw new DomainError('APPROVAL_NEEDS_A_PERSON');
        if (item.current_revision_id !== BigInt(revisionId))
          return {
            approved: false,
            blockers: ['The text changed since you opened it: reload and check it again.'],
          };
        const blockers = approvalBlockers({
          qc: item.qc,
          qcRevisionId: item.qc?.revisionId ? BigInt(item.qc.revisionId) : null,
          currentRevisionId: item.current_revision_id,
          hasJsonld: Boolean(item.jsonld),
        });
        if (blockers.length > 0) return { approved: false, blockers };
        await moveRow(tx, item, 'approved', 'user', {
          approved_revision_id: item.current_revision_id,
          approved_at: now,
          approved_by_user_id: userId,
        });
        return { approved: true };
      });
    },

    /** Take the approval back without changing the text. */
    async unapprove(projectId, ref) {
      await ownProject(projectId);
      const item = await findItem(prisma, projectId, ref);
      if (!item) throw new DomainError('CONTENT_NOT_FOUND');
      await moveRow(prisma, item, 'ready', 'user', {
        approved_revision_id: null,
        approved_at: null,
        approved_by_user_id: null,
      });
      return true;
    },

    /** Ask for a new draft from the (possibly edited) brief: a new revision, never an overwrite. */
    async redraft(projectId, ref) {
      await ownProject(projectId);
      const item = await findItem(prisma, projectId, ref);
      if (!item) throw new DomainError('CONTENT_NOT_FOUND');
      if (!item.brief) throw new DomainError('NO_BRIEF');
      await moveRow(prisma, item, 'drafting', 'user', {
        approved_revision_id: null,
        approved_at: null,
        approved_by_user_id: null,
        qc: Prisma.DbNull,
        qc_score: null,
        failed_stage: null,
        failure_reason: null,
      });
      return true;
    },

    /** Start again after a failure: from the stage that broke (research and plan both start from research). */
    async retry(projectId, ref, { now = new Date() } = {}) {
      await ownProject(projectId);
      return transaction(prisma, async (tx) => {
        const item = await findItem(tx, projectId, ref);
        if (!item) throw new DomainError('CONTENT_NOT_FOUND');
        // A failed publish goes back to approved: the approval it was given is still in place (a person made it).
        const stage = retryStage(item.failed_stage);
        const to =
          stage === 'approved' && item.approved_revision_id
            ? 'approved'
            : stage === 'drafting' && item.brief
              ? 'drafting'
              : 'researching';
        if (!canMove(item.status, to, 'user'))
          throw new DomainError('INVALID_TRANSITION', `${item.status} -> ${to}`);
        if (!item.current_revision_id && Number(item.quota_units) > 0) {
          const taken = await takeDraftUnits(tx, Number(item.quota_units), now);
          if (!taken.allowed) return { blocked: 'quota', used: taken.used, limit: taken.limit };
        }
        await moveRow(tx, item, to, 'user', { failed_stage: null, failure_reason: null });
        return { to };
      });
    },

    async archive(projectId, ref) {
      await ownProject(projectId);
      const item = await findItem(prisma, projectId, ref);
      if (!item) throw new DomainError('CONTENT_NOT_FOUND');
      await moveRow(prisma, item, 'archived', 'user');
      return true;
    },

    // ----- publishing -----------------------------------------------------------------------------------------

    /**
     * A person pressed publish. The approved revision is what goes; the item moves to `publishing` and the change is
     * written down as a `site_changes` row (what was sent, to which connection, approved by whom).
     *
     * @param {'draft'|'publish'} mode  save a draft in WordPress, or make it live
     */
    async beginPublish(projectId, ref, { userId, mode, now = new Date() }) {
      await ownProject(projectId);
      if (!['draft', 'publish'].includes(mode)) throw new DomainError('BAD_MODE');
      return transaction(prisma, async (tx) => {
        const item = await findItem(tx, projectId, ref);
        if (!item) throw new DomainError('CONTENT_NOT_FOUND');
        // A refresh replaces a live page in place: WordPress cannot hold an unpublished version of a published page,
        // so "save as a draft" would take the page down. It is not offered.
        if (item.kind === 'refresh' && mode === 'draft') throw new DomainError('BAD_MODE');
        if (item.status !== 'approved' || !item.approved_revision_id || !item.approved_at)
          throw new DomainError('NOT_APPROVED');
        if (!userId) throw new DomainError('APPROVAL_NEEDS_A_PERSON');
        const integration = await tx.integrations.findFirst({
          where: { org_id: orgId, project_id: projectId, type: 'wordpress', status: 'connected' },
        });
        if (!integration) throw new DomainError('WORDPRESS_NOT_CONNECTED');
        await moveRow(tx, item, 'publishing', 'user');
        const change = await tx.site_changes.create({
          data: {
            org_id: orgId,
            project_id: projectId,
            integration_id: integration.id,
            recommendation_id: item.recommendation_id,
            content_item_id: item.id,
            kind: item.cms_ref ? 'post_update' : 'post_create',
            target_url: item.published_url,
            payload: toJson({
              mode,
              revisionId: String(item.approved_revision_id),
              title: item.title,
              cmsRef: item.cms_ref,
            }),
            status: 'approved',
            approved_by_user_id: userId,
            approved_at: now,
            created_at: now,
          },
        });
        return { siteChangeId: change.id, integrationId: integration.id };
      });
    },

    /** What the publish job needs: the approved revision, the structured data, the brief's meta, the connection. */
    async forPublish(projectId, ref) {
      await ownProject(projectId);
      const item = await findItem(prisma, projectId, ref);
      if (!item) return null;
      const revision = item.approved_revision_id
        ? await prisma.content_revisions.findFirst({
            where: { id: item.approved_revision_id, content_item_id: item.id, org_id: orgId },
          })
        : null;
      const integration = await prisma.integrations.findFirst({
        where: { org_id: orgId, project_id: projectId, type: 'wordpress' },
      });
      const change = await prisma.site_changes.findFirst({
        where: {
          org_id: orgId,
          content_item_id: item.id,
          status: { in: ['approved', 'applying'] },
        },
        orderBy: { id: 'desc' },
      });
      return {
        item: toItem(item),
        bodyHtml: revision?.body_html ?? null,
        revisionId: revision?.id ?? null,
        integration: integration
          ? { ...toIntegration(integration), secret: secretOf(integration) }
          : null,
        siteChange: change ? { ...toSiteChange(change), id: change.id } : null,
      };
    },

    /**
     * The post exists in WordPress: remember which one at once, before anything else can fail, so a retry updates it
     * instead of making a second post.
     */
    async rememberPost(projectId, ref, { cmsRef, url = null }) {
      await ownProject(projectId);
      const result = await prisma.content_items.updateMany({
        where: {
          ...(typeof ref === 'string' && !/^d+$/.test(ref)
            ? { public_id: ref }
            : { id: BigInt(ref) }),
          org_id: orgId,
          project_id: projectId,
          status: 'publishing',
        },
        data: {
          cms_ref: String(cmsRef).slice(0, 128),
          ...(url ? { published_url: String(url).slice(0, 2048) } : {}),
        },
      });
      return result.count === 1;
    },

    async markApplying(projectId, siteChangeId) {
      await ownProject(projectId);
      const r = await prisma.site_changes.updateMany({
        where: {
          id: siteChangeId,
          org_id: orgId,
          project_id: projectId,
          status: { in: ['approved', 'applying'] },
        },
        data: { status: 'applying', attempts: { increment: 1 } },
      });
      return r.count === 1;
    },

    /**
     * The publish job finished. `drafted` leaves the item approved (a draft sits in WordPress, nothing is live);
     * `published` makes it published; `failed` sends it to `failed` with the stage `publishing`.
     */
    async finishPublish(
      projectId,
      ref,
      { siteChangeId, outcome, cmsRef = null, url = null, error = null, now = new Date() },
    ) {
      await ownProject(projectId);
      return transaction(prisma, async (tx) => {
        const item = await findItem(tx, projectId, ref);
        if (!item) throw new DomainError('CONTENT_NOT_FOUND');
        if (item.status !== 'publishing') return { skipped: true };
        const done = outcome === 'published' || outcome === 'drafted';
        await tx.site_changes.updateMany({
          where: { id: siteChangeId, org_id: orgId },
          data: done
            ? {
                status: 'applied',
                applied_at: now,
                remote_ref: cmsRef ? String(cmsRef).slice(0, 128) : null,
                target_url: url,
                last_error: null,
              }
            : { status: 'failed', last_error: String(error ?? 'Publishing failed').slice(0, 1000) },
        });
        if (outcome === 'published') {
          await moveRow(tx, item, 'published', 'system', {
            cms_ref: String(cmsRef),
            published_url: url,
            published_at: now,
            failed_stage: null,
            failure_reason: null,
          });
        } else if (outcome === 'drafted') {
          await moveRow(tx, item, 'approved', 'system', {
            cms_ref: String(cmsRef),
            published_url: url,
          });
        } else {
          await moveRow(tx, item, 'failed', 'system', {
            failed_stage: 'publishing',
            failure_reason: String(error ?? 'Publishing failed').slice(0, 500),
          });
        }
        return { skipped: false };
      });
    },

    /** The changes made to the customer's site for one item, newest first. */
    async siteChanges(projectId, ref) {
      await ownProject(projectId);
      const item = await findItem(prisma, projectId, ref);
      if (!item) return [];
      const rows = await prisma.site_changes.findMany({
        where: { org_id: orgId, project_id: projectId, content_item_id: item.id },
        orderBy: { id: 'desc' },
        take: 20,
      });
      return rows.map(toSiteChange);
    },

    /** What the pipeline reads about the item and project: used by the worker for every stage. */
    async forPipeline(projectId, ref) {
      await ownProject(projectId);
      const item = await findItem(prisma, projectId, ref);
      if (!item) return null;
      const prompts = await prisma.content_target_prompts.findMany({
        where: { content_item_id: item.id, org_id: orgId },
        select: { prompt_id: true },
      });
      const revision = item.current_revision_id
        ? await prisma.content_revisions.findFirst({
            where: { id: item.current_revision_id, content_item_id: item.id, org_id: orgId },
          })
        : null;
      return {
        ...toItem(item),
        promptIds: prompts.map((p) => String(p.prompt_id)),
        bodyHtml: revision?.body_html ?? null,
      };
    },
  };

  const secretOf = (i) =>
    i.secret_ciphertext
      ? {
          ciphertext: Buffer.from(i.secret_ciphertext),
          wrappedDek: Buffer.from(i.secret_wrapped_dek),
          keyVersion: i.secret_key_version,
        }
      : null;

  const integrations = {
    /** The WordPress connection of a project, with no secret in it. */
    async wordpress(projectId) {
      await ownProject(projectId);
      const row = await prisma.integrations.findFirst({
        where: { org_id: orgId, project_id: projectId, type: 'wordpress' },
      });
      return row ? toIntegration(row) : null;
    },

    /**
     * Save a connection after the handshake worked: the settings, and the encrypted credentials the worker will open.
     * One WordPress connection per project; saving again replaces it.
     */
    async saveWordpress(projectId, { config, secret, userId, now = new Date() }) {
      await ownProject(projectId);
      const data = {
        status: 'connected',
        config: toJson(config),
        secret_ciphertext: secret.ciphertext,
        secret_wrapped_dek: secret.wrappedDek,
        secret_key_version: secret.keyVersion,
        // Saving again from a background check (userId left out) keeps who connected it.
        ...(userId === undefined ? {} : { connected_by_user_id: userId }),
        connected_at: now,
        disconnected_at: null,
        last_success_at: now,
        last_error: null,
        last_error_at: null,
      };
      const find = () =>
        prisma.integrations.findFirst({
          where: { org_id: orgId, project_id: projectId, type: 'wordpress' },
        });
      const existing = await find();
      if (existing)
        return toIntegration(
          await prisma.integrations.update({ where: { id: existing.id, org_id: orgId }, data }),
        );
      try {
        return toIntegration(
          await prisma.integrations.create({
            data: { org_id: orgId, project_id: projectId, type: 'wordpress', ...data },
          }),
        );
      } catch (err) {
        // Two saves at once: the second finds the first's row and updates it (upsert is not atomic on MySQL).
        if (!isUniqueViolation(err)) throw err;
        const row = await find();
        if (!row) throw err;
        return toIntegration(
          await prisma.integrations.update({ where: { id: row.id, org_id: orgId }, data }),
        );
      }
    },

    /** The encrypted credentials: for the worker, which opens them with the master key. */
    async wordpressSecret(projectId) {
      await ownProject(projectId);
      const row = await prisma.integrations.findFirst({
        where: { org_id: orgId, project_id: projectId, type: 'wordpress' },
      });
      if (!row || row.status === 'disconnected' || !row.secret_ciphertext) return null;
      return { id: row.id, status: row.status, config: row.config ?? {}, secret: secretOf(row) };
    },

    /** Record what the last call to WordPress did, so the screen can say "broken: ..." without a new call. */
    async wordpressResult(projectId, { ok, error = null, config = null, now = new Date() }) {
      await ownProject(projectId);
      const row = await prisma.integrations.findFirst({
        where: { org_id: orgId, project_id: projectId, type: 'wordpress' },
      });
      if (!row || row.status === 'disconnected') return false;
      await prisma.integrations.update({
        where: { id: row.id, org_id: orgId },
        data: ok
          ? {
              status: 'connected',
              last_success_at: now,
              last_error: null,
              last_error_at: null,
              ...(config ? { config: toJson({ ...(row.config ?? {}), ...config }) } : {}),
            }
          : {
              status: 'broken',
              last_error_at: now,
              last_error: String(error ?? 'Failed').slice(0, 500),
            },
      });
      return true;
    },

    /** One-click disconnect: the credentials are erased, not just hidden. */
    async disconnectWordpress(projectId, { now = new Date() } = {}) {
      await ownProject(projectId);
      const result = await prisma.integrations.updateMany({
        where: { org_id: orgId, project_id: projectId, type: 'wordpress' },
        data: {
          status: 'disconnected',
          secret_ciphertext: null,
          secret_wrapped_dek: null,
          secret_key_version: null,
          disconnected_at: now,
        },
      });
      return result.count === 1;
    },
  };

  const quota = {
    async draftsUsed({ now = new Date() } = {}) {
      const row = await prisma.quota_usage.findFirst({
        where: { org_id: orgId, period_month: monthStart(now), meter: 'drafts' },
      });
      return {
        used: toNumber(row?.used_units),
        limit: await entitledLimit(prisma, orgId, 'drafts', now),
      };
    },
  };

  return { content, integrations, draftQuota: quota };
}
