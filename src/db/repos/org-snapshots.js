import { DomainError, isUniqueViolation } from '../errors.js';

/**
 * One organization's collected AI answers (`answer_snapshots`, DATABASE_SCHEMA §8): one row per prompt × engine ×
 * sample of a run. Merged into `forOrg(orgId)`; the organization is bound once and no function takes an `org_id`
 * from its arguments (see org-scoped.js).
 *
 * `answer_snapshots` is a fact table with no foreign keys (so it can be partitioned later), which means the
 * database does NOT stop a row from naming another organization's run or prompt. `create` checks both here.
 *
 * A snapshot's life: `create` (pending) -> `submitted` (a provider has the question) -> `complete` (ok or
 * no_answer) or `fail`. Only a pending snapshot moves, so a duplicate or late job can't overwrite a result.
 * A failed snapshot is "couldn't check", never "not mentioned".
 */

const clip = (text, max) => (text == null ? null : String(text).slice(0, max));

export function snapshotRepos(prisma, orgId) {
  const findOwn = (snapshotId) =>
    prisma.answer_snapshots.findFirst({ where: { id: snapshotId, org_id: orgId } });

  const snapshots = {
    /**
     * Plan one answer to collect. Idempotent: the same run, prompt, engine and sample is one row, so a planner that
     * runs twice gets the existing snapshot back (`created: false`).
     */
    async create({
      runId,
      promptId,
      engineCode,
      sampleIdx,
      providerCode,
      method,
      mode = 'standard',
    }) {
      const run = await prisma.runs.findFirst({
        where: { id: runId, org_id: orgId },
        select: { id: true, project_id: true, run_date: true },
      });
      if (!run) throw new DomainError('RUN_NOT_IN_ORG');
      const prompt = await prisma.prompts.findFirst({
        where: { id: promptId, org_id: orgId, project_id: run.project_id },
        select: { id: true, country: true, language: true, city: true },
      });
      if (!prompt) throw new DomainError('PROMPT_NOT_IN_RUN');

      const key = {
        run_id: run.id,
        prompt_id: prompt.id,
        engine_code: engineCode,
        sample_idx: sampleIdx,
        run_date: run.run_date,
      };
      try {
        const snapshot = await prisma.answer_snapshots.create({
          data: {
            ...key,
            org_id: orgId,
            project_id: run.project_id,
            provider_code: providerCode,
            method,
            mode,
            country: prompt.country,
            language: prompt.language,
            city: prompt.city,
          },
        });
        return { created: true, snapshot };
      } catch (err) {
        if (!isUniqueViolation(err, 'uq_answer_snapshots_task')) throw err;
        const existing = await prisma.answer_snapshots.findFirst({
          where: { ...key, org_id: orgId },
        });
        return { created: false, snapshot: existing };
      }
    },

    /**
     * A snapshot and the question it asks, or null if it is not this organization's. The prompt's wording comes
     * from the prompts table, never from a job payload.
     */
    async get(snapshotId) {
      const snapshot = await findOwn(snapshotId);
      if (!snapshot) return null;
      const prompt = await prisma.prompts.findFirst({
        where: { id: snapshot.prompt_id, org_id: orgId, project_id: snapshot.project_id },
        select: { text: true, search_query: true },
      });
      return { ...snapshot, prompt };
    },

    /**
     * A provider has the question: record which one (primary or fallback), its task ID and what it charged
     * (providers that queue work charge when it is queued). Counts an attempt. False if the snapshot already
     * finished.
     */
    async submitted(snapshotId, { providerCode, method, isFallback, providerTaskId, costUsd }) {
      const current = await findOwn(snapshotId);
      if (!current || current.status !== 'pending') return false;
      const { count } = await prisma.answer_snapshots.updateMany({
        where: { id: snapshotId, org_id: orgId, status: 'pending' },
        data: {
          provider_code: providerCode,
          method,
          is_fallback: Boolean(isFallback),
          provider_task_id: clip(providerTaskId, 128),
          attempts: Math.min(255, current.attempts + 1),
          ...(costUsd !== undefined ? { cost_usd: String(costUsd) } : {}),
          failure_reason: null,
        },
      });
      return count === 1;
    },

    /**
     * The answer is in: `ok` with text, or `no_answer` (the engine showed none). Its raw payload is already in
     * object storage at `rawUri`. False if the snapshot had already finished (a duplicate job).
     */
    async complete(snapshotId, result) {
      if (!['ok', 'no_answer'].includes(result.status)) {
        throw new DomainError(
          'INVALID',
          'An answer is ok or no_answer; a failure goes through fail().',
        );
      }
      if (!/^[0-9a-f]{64}$/.test(result.rawSha256 ?? '')) {
        throw new DomainError(
          'INVALID',
          'The raw payload must be stored, with its SHA-256, first.',
        );
      }
      const { count } = await prisma.answer_snapshots.updateMany({
        where: { id: snapshotId, org_id: orgId, status: 'pending' },
        data: {
          status: result.status,
          provider_code: result.providerCode,
          method: result.method,
          is_fallback: Boolean(result.isFallback),
          provider_task_id: clip(result.providerTaskId, 128),
          model_version: clip(result.modelVersion, 64),
          collected_at: result.collectedAt,
          raw_uri: clip(result.rawUri, 512),
          raw_sha256: Buffer.from(result.rawSha256, 'hex'),
          answer_chars: result.answerChars,
          text_excerpt: clip(result.textExcerpt, 500),
          ...(result.costUsd !== undefined ? { cost_usd: String(result.costUsd) } : {}),
          failure_reason: null,
          // A no_answer has nothing to extract.
          ...(result.status === 'no_answer' ? { extraction_status: 'skipped' } : {}),
        },
      });
      return count === 1;
    },

    /**
     * Give up on a snapshot ("couldn't check"). `rawUri` points at what the provider sent when it sent something
     * we couldn't read, so staff can look at it. False if it had already finished.
     */
    async fail(snapshotId, reason, { rawUri } = {}) {
      const { count } = await prisma.answer_snapshots.updateMany({
        where: { id: snapshotId, org_id: orgId, status: 'pending' },
        data: {
          status: 'failed',
          failure_reason: clip(reason ?? 'unknown', 255),
          extraction_status: 'skipped',
          ...(rawUri ? { raw_uri: clip(rawUri, 512) } : {}),
        },
      });
      return count === 1;
    },

    /** Every snapshot of one of this organization's runs, in a stable order. */
    forRun: (runId) =>
      prisma.answer_snapshots.findMany({
        where: { run_id: runId, org_id: orgId },
        orderBy: [{ prompt_id: 'asc' }, { engine_code: 'asc' }, { sample_idx: 'asc' }],
      }),
  };

  return { snapshots };
}
