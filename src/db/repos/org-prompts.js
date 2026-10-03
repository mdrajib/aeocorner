import { INTENTS, checkQuestion, nearDuplicates, questionHash } from '../../core/prompt-rules.js';
import { DomainError, isUniqueViolation } from '../errors.js';
import { transaction } from '../transaction.js';

/**
 * One project's buyer questions, the "Prompt Manager" (MVP F3). Merged into `forOrg(orgId)`; the organization is
 * bound once and no function takes an `org_id` from its arguments (see org-scoped.js).
 *
 * A question's text is immutable once it exists: changing the wording archives the old row and creates a new one
 * that points back at it (`replaces_prompt_id`), so a trend line never mixes two different questions. Everything else
 * (priority, topic, intent, on/off) changes in place.
 *
 * `limit` on `add`, `import` and `setStatus` is the plan's cap on ACTIVE questions (null = none). Nothing is dropped
 * silently: a refused question comes back with the reason.
 */

const STATUSES = ['active', 'paused', 'archived'];
const MAX_CLUSTER = 128;
const MAX_QUERY = 255;

export function promptRepos(prisma, orgId, { appendActivity }) {
  async function ownProject(tx, projectId) {
    const project = await tx.projects.findFirst({
      where: { id: projectId, org_id: orgId, deleted_at: null },
    });
    if (!project) throw new DomainError('NOT_FOUND');
    return project;
  }

  async function ownPrompt(tx, promptId) {
    const prompt = await tx.prompts.findFirst({ where: { id: promptId, org_id: orgId } });
    if (!prompt) throw new DomainError('NOT_FOUND');
    return prompt;
  }

  const activeCount = (tx, projectId) =>
    tx.prompts.count({ where: { project_id: projectId, org_id: orgId, status: 'active' } });

  async function clusterId(tx, projectId, name) {
    const clean = String(name ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_CLUSTER);
    if (!clean) return null;
    const found = await tx.prompt_clusters.findFirst({
      where: { project_id: projectId, org_id: orgId, name: clean },
    });
    if (found) return found.id;
    try {
      return (
        await tx.prompt_clusters.create({
          data: { org_id: orgId, project_id: projectId, name: clean },
        })
      ).id;
    } catch (err) {
      // Two imports created the same topic at once: use the one that won.
      if (!isUniqueViolation(err)) throw err;
      return (
        await tx.prompt_clusters.findFirstOrThrow({
          where: { project_id: projectId, org_id: orgId, name: clean },
        })
      ).id;
    }
  }

  /** Validate the fields of one question. Throws DomainError with a customer-readable message. */
  function fieldsOf(input) {
    const checked = checkQuestion(input.text);
    if (!checked.ok) throw new DomainError('INVALID_QUESTION', checked.error);
    if (!INTENTS.includes(input.intent)) throw new DomainError('INVALID_INTENT');
    const priority = input.priority ?? 2;
    if (![1, 2, 3].includes(priority)) throw new DomainError('INVALID_PRIORITY');
    const searchQuery = input.searchQuery
      ? String(input.searchQuery).replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY) || null
      : null;
    return { text: checked.text, intent: input.intent, priority, searchQuery };
  }

  /** Insert one question into an open transaction. Returns `{ prompt, restored }`. */
  async function insertOne(tx, project, input, { actorUserId, limit }) {
    const f = fieldsOf(input);
    const hash = questionHash(f.text);
    const where = {
      project_id: project.id,
      country: project.country,
      language: project.language,
      city: project.city,
      text_hash: hash,
    };
    const existing = await tx.prompts.findFirst({ where });
    if (existing && existing.status !== 'archived') throw new DomainError('DUPLICATE');
    if (limit != null && (await activeCount(tx, project.id)) >= limit) {
      throw new DomainError('PLAN_LIMIT');
    }
    if (existing) {
      // The same question was archived earlier: bring it back, so its history joins up with its past.
      const prompt = await tx.prompts.update({
        where: { id: existing.id },
        data: { status: 'active', paused_reason: null, archived_at: null, priority: f.priority },
      });
      return { prompt, restored: true };
    }
    const prompt = await tx.prompts.create({
      data: {
        org_id: orgId,
        project_id: project.id,
        cluster_id: await clusterId(tx, project.id, input.clusterName),
        text: f.text,
        text_hash: hash,
        search_query: f.searchQuery,
        intent: f.intent,
        funnel_stage: input.funnelStage ?? null,
        priority: f.priority,
        country: project.country,
        language: project.language,
        city: project.city,
        source: input.source ?? 'manual',
        created_by_user_id: actorUserId ?? null,
      },
    });
    return { prompt, restored: false };
  }

  const prompts = {
    /**
     * A project's questions with their topic name. By default archived ones are left out. Filters: `status`,
     * `intent`, `clusterId`, and `q` (words that must appear in the text).
     */
    async list(projectId, { status, intent, clusterId: topic, q } = {}) {
      await ownProject(prisma, projectId);
      const rows = await prisma.prompts.findMany({
        where: {
          project_id: projectId,
          org_id: orgId,
          ...(status ? { status } : { status: { not: 'archived' } }),
          ...(intent ? { intent } : {}),
          ...(topic ? { cluster_id: topic } : {}),
          ...(q ? { text: { contains: String(q).slice(0, 100) } } : {}),
        },
        include: { prompt_clusters: { select: { name: true } } },
        orderBy: [{ priority: 'asc' }, { id: 'asc' }],
      });
      return rows.map(({ prompt_clusters: cluster, ...row }) => ({
        ...row,
        clusterName: cluster?.name ?? null,
      }));
    },

    /** The topics of a project, in order. */
    async clusters(projectId) {
      await ownProject(prisma, projectId);
      return prisma.prompt_clusters.findMany({
        where: { project_id: projectId, org_id: orgId },
        orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
      });
    },

    /**
     * Add one question. Returns `{ prompt, restored, similar }`: `restored` when it was an archived question
     * brought back, `similar` the active questions that say nearly the same thing (flagged, not refused).
     * Refuses an exact duplicate (`DUPLICATE`) and a full plan (`PLAN_LIMIT`).
     */
    async add(projectId, input, { actorUserId, limit = null } = {}) {
      return transaction(prisma, async (tx) => {
        const project = await ownProject(tx, projectId);
        const { prompt, restored } = await insertOne(tx, project, input, { actorUserId, limit });
        const others = await tx.prompts.findMany({
          where: {
            project_id: project.id,
            org_id: orgId,
            status: { not: 'archived' },
            id: { not: prompt.id },
          },
          select: { id: true, text: true },
        });
        await appendActivity(tx, {
          actorUserId,
          action: 'prompt.added',
          targetType: 'prompt',
          targetId: prompt.id,
          summary: restored ? 'A question was restored' : 'A question was added',
        });
        return { prompt, restored, similar: nearDuplicates(prompt.text, others) };
      });
    },

    /**
     * Change a question. New wording archives this one and creates its replacement (the result is the new row);
     * anything else changes in place. Returns the row that is now current.
     */
    async edit(promptId, changes, { actorUserId } = {}) {
      return transaction(prisma, async (tx) => {
        const prompt = await ownPrompt(tx, promptId);
        if (prompt.status === 'archived') throw new DomainError('ARCHIVED');
        const project = await ownProject(tx, prompt.project_id);

        const wording = changes.text === undefined ? prompt.text : changes.text;
        const f = fieldsOf({
          text: wording,
          intent: changes.intent ?? prompt.intent,
          priority: changes.priority ?? prompt.priority,
          searchQuery:
            changes.searchQuery === undefined ? prompt.search_query : changes.searchQuery,
        });
        const topic =
          changes.clusterName === undefined
            ? prompt.cluster_id
            : await clusterId(tx, project.id, changes.clusterName);

        if (questionHash(f.text).equals(prompt.text_hash)) {
          // Same question (the wording may differ only in case or punctuation, which we treat as the same):
          // keep the row, so its history stays one line.
          const updated = await tx.prompts.update({
            where: { id: prompt.id },
            data: {
              intent: f.intent,
              priority: f.priority,
              search_query: f.searchQuery,
              cluster_id: topic,
            },
          });
          await appendActivity(tx, {
            actorUserId,
            action: 'prompt.updated',
            targetType: 'prompt',
            targetId: prompt.id,
            summary: 'A question was changed',
          });
          return updated;
        }

        const clash = await tx.prompts.findFirst({
          where: {
            project_id: project.id,
            country: prompt.country,
            language: prompt.language,
            city: prompt.city,
            text_hash: questionHash(f.text),
          },
        });
        if (clash) throw new DomainError('DUPLICATE');

        await tx.prompts.update({
          where: { id: prompt.id },
          data: { status: 'archived', archived_at: new Date() },
        });
        const replacement = await tx.prompts.create({
          data: {
            org_id: orgId,
            project_id: project.id,
            cluster_id: topic,
            text: f.text,
            text_hash: questionHash(f.text),
            search_query: f.searchQuery,
            intent: f.intent,
            funnel_stage: prompt.funnel_stage,
            priority: f.priority,
            country: prompt.country,
            language: prompt.language,
            city: prompt.city,
            status: prompt.status,
            paused_reason: prompt.paused_reason,
            source: prompt.source,
            daily_tracking: prompt.daily_tracking,
            replaces_prompt_id: prompt.id,
            created_by_user_id: actorUserId ?? null,
          },
        });
        await appendActivity(tx, {
          actorUserId,
          action: 'prompt.reworded',
          targetType: 'prompt',
          targetId: replacement.id,
          summary: 'A question was reworded (the earlier wording is kept as history)',
          metadata: { replaces: String(prompt.id) },
        });
        return replacement;
      });
    },

    /** Turn a question on, pause it, or archive it. Turning one on counts against the plan's `limit`. */
    async setStatus(promptId, status, { actorUserId, limit = null } = {}) {
      if (!STATUSES.includes(status)) throw new DomainError('INVALID_STATUS');
      return transaction(prisma, async (tx) => {
        const prompt = await ownPrompt(tx, promptId);
        if (prompt.status === status) return prompt;
        if (
          status === 'active' &&
          limit != null &&
          (await activeCount(tx, prompt.project_id)) >= limit
        ) {
          throw new DomainError('PLAN_LIMIT');
        }
        const updated = await tx.prompts.update({
          where: { id: prompt.id },
          data: {
            status,
            paused_reason: status === 'paused' ? 'user' : null,
            archived_at: status === 'archived' ? new Date() : null,
          },
        });
        await appendActivity(tx, {
          actorUserId,
          action: 'prompt.status_changed',
          targetType: 'prompt',
          targetId: prompt.id,
          summary: `A question was set to ${status}`,
          metadata: { status },
        });
        return updated;
      });
    },

    /**
     * Add many questions (a CSV, or the generator's set). Every row gets an answer, in order, and none is dropped
     * silently: `{ row, result: 'added' | 'restored' | 'duplicate' | 'invalid' | 'over_limit', error?, prompt? }`.
     * One bad row never stops the rest; the good ones are saved together.
     */
    async importMany(projectId, rows, { actorUserId, limit = null, source = 'imported' } = {}) {
      if (!Array.isArray(rows) || rows.length > 500) throw new DomainError('TOO_MANY_ROWS');
      return transaction(prisma, async (tx) => {
        const project = await ownProject(tx, projectId);
        const results = [];
        for (const [index, input] of rows.entries()) {
          const row = index + 1;
          try {
            const { prompt, restored } = await insertOne(
              tx,
              project,
              { ...input, source: input?.source ?? source },
              { actorUserId, limit },
            );
            results.push({ row, result: restored ? 'restored' : 'added', prompt });
          } catch (err) {
            if (!(err instanceof DomainError)) throw err;
            const result =
              err.code === 'DUPLICATE'
                ? 'duplicate'
                : err.code === 'PLAN_LIMIT'
                  ? 'over_limit'
                  : 'invalid';
            results.push({ row, result, error: err.message });
          }
        }
        const added = results.filter((r) => r.result === 'added' || r.result === 'restored').length;
        if (added > 0) {
          await appendActivity(tx, {
            actorUserId,
            action: 'prompt.imported',
            targetType: 'project',
            targetId: project.id,
            summary: `${added} question${added === 1 ? '' : 's'} added`,
            metadata: { rows: rows.length, added },
          });
        }
        return results;
      });
    },
  };

  return { prompts };
}
