import { buildCells, rollupDay, runOutcome, samplesFor } from '../../core/tracking.js';
import { detectChanges, TREND_WINDOW_DAYS, windowsAt } from '../../core/trends.js';
import { DomainError, isUniqueViolation } from '../errors.js';
import { transaction } from '../transaction.js';

/**
 * One organization's tracking runs and what they produce (MVP F4, DATABASE_SCHEMA §9–10): the `runs` row of a
 * project's slot, the grid of answers it plans, the cells and daily rollups built from them, and the significant
 * changes found in those rollups. Merged into `forOrg(orgId)`; no function takes an `org_id` from its arguments.
 *
 * `cell_results`, `cell_entity_results` and `metric_daily` are written here and nowhere else, always as sums
 * (n, k, weighted sums) and never as rates. The fact tables have no foreign keys, so every read and write names
 * the organization and the run date (the date is in each table's keys, so it also keeps the index in use).
 *
 * An answer counts as readable only if it was collected AND read: `ok` with `extraction_status = done`. An answer
 * that was collected but whose reading failed or never finished has no mention rows, and counting it would turn
 * "we could not read it" into "the brand was not named". It is counted as one we could not check.
 */

export const RUN_TRIGGERS = ['schedule', 'daily', 'manual', 'onboarding'];
export const EXTRACTION_MODES = ['batch', 'sync'];

/** A project in these states can be tracked; an archived or paused one cannot. */
const TRACKABLE = ['onboarding', 'active'];

/**
 * Until the founder fills in the plan limits (task 0.17), a plan with no "run now" allowance gets this many a
 * month. It is a placeholder, not a decision.
 */
export const RUNS_NOW_PLACEHOLDER = 4;

const FORWARD = ['queued', 'collecting', 'extracting', 'rolling_up'];

const utcDate = (date) => new Date(date.toISOString().slice(0, 10));
const monthStart = (date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
const dayString = (value) => new Date(value).toISOString().slice(0, 10);
const toJson = (value) => JSON.parse(JSON.stringify(value));

export function trackingRepos(prisma, orgId) {
  const findRun = (runId) => prisma.runs.findFirst({ where: { id: runId, org_id: orgId } });

  async function ownRun(runId) {
    const run = await findRun(runId);
    if (!run) throw new DomainError('RUN_NOT_IN_ORG');
    return run;
  }

  async function ownProject(projectId) {
    const project = await prisma.projects.findFirst({
      where: { id: projectId, org_id: orgId, deleted_at: null },
      select: { id: true, status: true, public_id: true },
    });
    if (!project) throw new DomainError('PROJECT_NOT_IN_ORG');
    return project;
  }

  /**
   * Every planned answer of a run, as the pure code wants it: its effective state, who it named and what it cited.
   * An answer still pending, or collected but not read, counts as one we could not check.
   */
  async function samplesOf(run) {
    const snapshots = await prisma.answer_snapshots.findMany({
      where: { run_id: run.id, org_id: orgId, run_date: run.run_date },
      orderBy: [{ prompt_id: 'asc' }, { engine_code: 'asc' }, { sample_idx: 'asc' }],
    });
    if (snapshots.length === 0) return { snapshots, samples: [] };
    const ids = snapshots.map((s) => s.id);
    const [mentions, citations] = await Promise.all([
      prisma.mentions.findMany({
        where: {
          org_id: orgId,
          project_id: run.project_id,
          run_date: run.run_date,
          snapshot_id: { in: ids },
          is_excluded: false,
        },
        select: {
          snapshot_id: true,
          entity_id: true,
          list_rank: true,
          stance: true,
          sentiment: true,
        },
      }),
      prisma.citations.findMany({
        where: {
          org_id: orgId,
          project_id: run.project_id,
          run_date: run.run_date,
          snapshot_id: { in: ids },
        },
        select: {
          snapshot_id: true,
          owner_entity_id: true,
          is_own: true,
          supports_entity_ids: true,
        },
      }),
    ]);
    const group = (rows) => {
      const by = new Map();
      for (const r of rows) {
        if (!by.has(r.snapshot_id)) by.set(r.snapshot_id, []);
        by.get(r.snapshot_id).push(r);
      }
      return by;
    };
    const mentionsBy = group(mentions);
    const citationsBy = group(citations);
    const samples = snapshots.map((s) => {
      const read = s.status === 'ok' && s.extraction_status === 'done';
      const status = s.status === 'ok' && !read ? 'failed' : s.status;
      return {
        promptId: String(s.prompt_id),
        engineCode: s.engine_code,
        sampleIdx: s.sample_idx,
        status,
        mentions: read
          ? (mentionsBy.get(s.id) ?? []).map((m) => ({
              entityId: String(m.entity_id),
              listRank: m.list_rank,
              stance: m.stance,
              sentiment: m.sentiment,
            }))
          : [],
        citations: read
          ? (citationsBy.get(s.id) ?? []).map((c) => ({
              ownerEntityId: c.owner_entity_id == null ? null : String(c.owner_entity_id),
              isOwn: c.is_own,
              supportsEntityIds: (Array.isArray(c.supports_entity_ids)
                ? c.supports_entity_ids
                : []
              ).map(String),
            }))
          : [],
      };
    });
    return { snapshots, samples };
  }

  /** The brand and active competitors of a project, brand first. */
  async function trackedIds(projectId) {
    const rows = await prisma.tracked_entities.findMany({
      where: {
        org_id: orgId,
        project_id: projectId,
        kind: { in: ['brand', 'competitor'] },
        status: 'active',
      },
      select: { id: true, kind: true },
      orderBy: { id: 'asc' },
    });
    const brand = rows.find((r) => r.kind === 'brand');
    return {
      brandId: brand ? String(brand.id) : null,
      entityIds: [
        ...(brand ? [String(brand.id)] : []),
        ...rows.filter((r) => r.kind !== 'brand').map((r) => String(r.id)),
      ],
    };
  }

  const runs = {
    /**
     * Start (or find) the run of a project's slot. The slot is the idempotency key: `2026-W40` for a weekly run, so a
     * scheduler that fires twice gets the same run back (`created: false`) and plans nothing twice. Throws
     * PROJECT_NOT_IN_ORG, PROJECT_NOT_TRACKABLE (archived or paused) and INVALID.
     */
    async start({
      projectId,
      slotKey,
      trigger,
      extractionMode = 'batch',
      requestedByUserId = null,
      now = new Date(),
    }) {
      if (!RUN_TRIGGERS.includes(trigger)) throw new DomainError('INVALID', 'Unknown run trigger.');
      if (!EXTRACTION_MODES.includes(extractionMode)) {
        throw new DomainError('INVALID', 'Unknown extraction mode.');
      }
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(String(slotKey))) {
        throw new DomainError('INVALID', 'A run slot is a short word like 2026-W40.');
      }
      const project = await ownProject(projectId);
      if (!TRACKABLE.includes(project.status)) throw new DomainError('PROJECT_NOT_TRACKABLE');
      const kit = await prisma.brand_profiles.findFirst({
        where: { project_id: projectId, org_id: orgId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const key = { project_id: projectId, slot_key: slotKey };
      try {
        const run = await prisma.runs.create({
          data: {
            ...key,
            org_id: orgId,
            trigger_type: trigger,
            run_date: utcDate(now),
            extraction_mode: extractionMode,
            brand_profile_version: kit?.version ?? null,
            requested_by_user_id: requestedByUserId,
          },
        });
        return { created: true, run };
      } catch (err) {
        if (!isUniqueViolation(err, 'uq_runs_slot')) throw err;
        return {
          created: false,
          run: await prisma.runs.findFirst({ where: { ...key, org_id: orgId } }),
        };
      }
    },

    get: (runId) => findRun(runId),

    /** A project's runs, newest first. */
    recent: (projectId, { limit = 20 } = {}) =>
      prisma.runs.findMany({
        where: { project_id: projectId, org_id: orgId },
        orderBy: [{ run_date: 'desc' }, { id: 'desc' }],
        take: Math.min(Math.max(1, limit), 100),
      }),

    /**
     * What a run needs planned: the project's active questions and enabled engines (with the samples each gets and
     * its weight), from the project and its plan. Empty lists for a run that is not this organization's.
     */
    async plan(runId) {
      const run = await findRun(runId);
      if (!run) return { run: null, prompts: [], engines: [] };
      const [prompts, projectEngines, org] = await Promise.all([
        prisma.prompts.findMany({
          where: { project_id: run.project_id, org_id: orgId, status: 'active' },
          select: { id: true, priority: true },
          orderBy: { id: 'asc' },
        }),
        prisma.project_engines.findMany({
          where: { project_id: run.project_id, org_id: orgId, enabled: true },
          orderBy: { engine_code: 'asc' },
        }),
        prisma.organizations.findFirst({
          where: { id: orgId },
          select: { plan_code: true },
        }),
      ]);
      const plan = org?.plan_code
        ? await prisma.plans.findUnique({
            where: { code: org.plan_code },
            select: { samples_per_engine: true },
          })
        : null;
      const references = await prisma.engines.findMany({
        where: {
          code: { in: projectEngines.map((e) => e.engine_code) },
          status: { not: 'disabled' },
        },
        select: {
          code: true,
          default_samples: true,
          primary_provider_code: true,
          primary_method: true,
          query_field: true,
        },
      });
      const byCode = new Map(references.map((e) => [e.code, e]));
      const engines = projectEngines
        .filter((e) => byCode.has(e.engine_code))
        .map((e) => {
          const ref = byCode.get(e.engine_code);
          return {
            code: e.engine_code,
            weight: Number(e.weight),
            samples: samplesFor({
              engineDefault: ref.default_samples,
              planSamples: plan?.samples_per_engine ?? ref.default_samples,
              override: e.samples_override,
            }),
            providerCode: ref.primary_provider_code,
            method: ref.primary_method,
            queryField: ref.query_field,
          };
        });
      return {
        run,
        prompts: prompts.map((p) => ({ id: p.id, priority: p.priority })),
        engines,
      };
    },

    /**
     * The run has been planned: record how big it is and that collecting began. Only a queued run moves, so a
     * repeated planner changes nothing. False if it already began (or is not this organization's).
     */
    async begin(runId, { promptsCount, tasksPlanned, now = new Date() }) {
      const { count } = await prisma.runs.updateMany({
        where: { id: runId, org_id: orgId, status: 'queued' },
        data: {
          status: 'collecting',
          prompts_count: promptsCount,
          tasks_planned: tasksPlanned,
          started_at: now,
        },
      });
      return count === 1;
    },

    /**
     * Move a run forward through collecting → extracting → rolling_up. Never backwards, never out of a finished
     * state: a late or repeated job is a no-op (false).
     */
    async advance(runId, to, { now = new Date() } = {}) {
      const at = FORWARD.indexOf(to);
      if (at < 1)
        throw new DomainError('INVALID', 'A run advances to collecting, extracting or rolling_up.');
      const stamp =
        to === 'extracting'
          ? { collected_at: now }
          : to === 'rolling_up'
            ? { extracted_at: now }
            : {};
      const { count } = await prisma.runs.updateMany({
        where: { id: runId, org_id: orgId, status: { in: FORWARD.slice(0, at) } },
        data: { status: to, ...stamp },
      });
      return count === 1;
    },

    /**
     * Where a run's answers stand: planned, still being collected, collected but not yet read, and done. The
     * orchestrator waits on these.
     */
    async progress(runId) {
      const run = await findRun(runId);
      if (!run) return null;
      const rows = await prisma.answer_snapshots.groupBy({
        by: ['status', 'extraction_status'],
        where: { run_id: run.id, org_id: orgId, run_date: run.run_date },
        _count: { _all: true },
      });
      const p = { planned: 0, collecting: 0, toRead: 0, settled: 0 };
      for (const r of rows) {
        const n = r._count._all;
        p.planned += n;
        if (r.status === 'pending') p.collecting += n;
        else if (r.status === 'ok' && r.extraction_status === 'pending') p.toRead += n;
        else p.settled += n;
      }
      return p;
    },

    /**
     * Give up on answers still out when the run's deadline has passed: they become "couldn't check" (failed), and the
     * run goes on with what it has. Returns how many.
     */
    async expirePending(runId, reason = 'timed out') {
      const run = await ownRun(runId);
      const { count } = await prisma.answer_snapshots.updateMany({
        where: {
          run_id: run.id,
          org_id: orgId,
          run_date: run.run_date,
          status: 'pending',
          extraction_status: 'pending',
        },
        data: {
          status: 'failed',
          failure_reason: String(reason).slice(0, 255),
          extraction_status: 'skipped',
        },
      });
      return count;
    },

    /** Give up on collected answers nobody read in time: their reading is marked failed. Returns how many. */
    async expireUnread(runId) {
      const run = await ownRun(runId);
      const { count } = await prisma.answer_snapshots.updateMany({
        where: {
          run_id: run.id,
          org_id: orgId,
          run_date: run.run_date,
          status: 'ok',
          extraction_status: 'pending',
        },
        data: { extraction_status: 'failed' },
      });
      return count;
    },

    /**
     * Build the run's cells from its answers and write them, with the run's counts, cost and verdict, in one
     * transaction. Idempotent: the cells are replaced, so a repeated job writes the same rows. Leaves the run in
     * `rolling_up`; `finish` sets its final status after the daily rollup. Returns the outcome.
     */
    async settle(runId) {
      const run = await ownRun(runId);
      if (['complete', 'partial', 'failed', 'canceled'].includes(run.status)) {
        return { repeated: true, status: run.status };
      }
      const { brandId, entityIds } = await trackedIds(run.project_id);
      if (!brandId) throw new DomainError('NO_BRAND', 'The project has no brand entity.');
      const { snapshots, samples } = await samplesOf(run);
      const cells = buildCells({ samples, brandId, entityIds });
      const outcome = runOutcome(samples);
      const version =
        snapshots.find((s) => s.extraction_version)?.extraction_version ??
        run.extraction_version ??
        'none';

      const ledger = await prisma.usage_ledger.aggregate({
        where: {
          org_id: orgId,
          OR: [
            { ref_type: 'run', ref_id: run.id },
            ...(snapshots.length
              ? [{ ref_type: 'snapshot', ref_id: { in: snapshots.map((s) => s.id) } }]
              : []),
          ],
        },
        _sum: { cost_usd: true },
      });

      await transaction(prisma, async (tx) => {
        const where = { run_id: run.id, org_id: orgId, run_date: run.run_date };
        await tx.cell_entity_results.deleteMany({ where });
        await tx.cell_results.deleteMany({ where });
        const base = {
          org_id: orgId,
          project_id: run.project_id,
          run_id: run.id,
          run_date: run.run_date,
        };
        if (cells.length) {
          await tx.cell_results.createMany({
            data: cells.map((c) => ({
              ...base,
              prompt_id: BigInt(c.promptId),
              engine_code: c.engineCode,
              status: c.status,
              n_planned: c.nPlanned,
              n_ok: c.nOk,
              n_no_answer: c.nNoAnswer,
              n_failed: c.nFailed,
              cell_score: c.cellScore == null ? null : String(c.cellScore),
              citations_total: Math.min(65535, c.citationsTotal),
              citations_own: Math.min(65535, c.citationsOwn),
              extraction_version: version,
            })),
          });
        }
        const entityRows = cells.flatMap((c) =>
          c.entities.map((e) => ({
            ...base,
            prompt_id: BigInt(c.promptId),
            engine_code: c.engineCode,
            entity_id: BigInt(e.entityId),
            k_mentioned: e.kMentioned,
            k_recommended: e.kRecommended,
            k_cited: e.kCited,
            rank_sum: e.rankSum,
            rank_n: e.rankN,
            best_rank: e.bestRank,
            sentiment_sum: e.sentimentSum,
            sentiment_n: e.sentimentN,
          })),
        );
        if (entityRows.length) await tx.cell_entity_results.createMany({ data: entityRows });
        await tx.runs.updateMany({
          where: { id: run.id, org_id: orgId },
          data: {
            tasks_planned: outcome.tasksPlanned,
            tasks_ok: outcome.tasksOk,
            tasks_no_answer: outcome.tasksNoAnswer,
            tasks_failed: outcome.tasksFailed,
            cost_usd: ledger._sum.cost_usd?.toString() ?? '0',
            extraction_version: version,
            status: 'rolling_up',
            extracted_at: run.extracted_at ?? new Date(),
          },
        });
      });
      return { repeated: false, ...outcome, cells: cells.length };
    },

    /**
     * Set a settled run's final status (complete, partial or failed) and stamp the time. A failed run keeps its
     * reasons in `error_summary`. False if the run was already finished.
     */
    async finish(runId, status, { errorSummary = null, now = new Date() } = {}) {
      if (!['complete', 'partial', 'failed'].includes(status)) {
        throw new DomainError('INVALID', 'A run finishes as complete, partial or failed.');
      }
      const run = await ownRun(runId);
      const { count } = await prisma.runs.updateMany({
        where: { id: runId, org_id: orgId, status: { in: FORWARD } },
        data: {
          status,
          finished_at: now,
          ...(errorSummary ? { error_summary: toJson(errorSummary) } : {}),
        },
      });
      if (count === 1 && !run.started_at) {
        await prisma.runs.updateMany({
          where: { id: runId, org_id: orgId },
          data: { started_at: now },
        });
      }
      return count === 1;
    },

    /**
     * The project has its first finished run: note when, once. A run that produced nothing readable does not count,
     * so the first real data is what ends "setting up".
     */
    async noteFirstRun(projectId, now = new Date()) {
      const { count } = await prisma.projects.updateMany({
        where: { id: projectId, org_id: orgId, first_run_at: null },
        data: { first_run_at: now },
      });
      return count === 1;
    },

    /** The cells of one run, for the prompt matrix: `[{ promptId, engine, status, nOk, … }]`. */
    async cells(runId) {
      const run = await findRun(runId);
      if (!run) return [];
      const rows = await prisma.cell_results.findMany({
        where: { run_id: run.id, org_id: orgId, run_date: run.run_date },
        orderBy: [{ prompt_id: 'asc' }, { engine_code: 'asc' }],
      });
      return rows.map((r) => ({
        promptId: r.prompt_id,
        engineCode: r.engine_code,
        status: r.status,
        nPlanned: r.n_planned,
        nOk: r.n_ok,
        nNoAnswer: r.n_no_answer,
        nFailed: r.n_failed,
        cellScore: r.cell_score == null ? null : Number(r.cell_score),
        citationsTotal: r.citations_total,
        citationsOwn: r.citations_own,
      }));
    },
  };

  const metrics = {
    /**
     * Rebuild one project's rollup for one UTC date from the cells of that day's complete and partial runs. The
     * rows are replaced in one transaction, so running it twice gives the same table. Returns how many rows.
     */
    async rollupDay(projectId, date) {
      await ownProject(projectId);
      const day = utcDate(new Date(`${dayString(date)}T00:00:00Z`));
      const dayRuns = await prisma.runs.findMany({
        where: {
          project_id: projectId,
          org_id: orgId,
          run_date: day,
          status: { in: ['rolling_up', 'complete', 'partial'] },
        },
        select: { id: true },
      });
      const runIds = dayRuns.map((r) => r.id);
      const { brandId, entityIds } = await trackedIds(projectId);
      if (!brandId) throw new DomainError('NO_BRAND', 'The project has no brand entity.');

      const [cellRows, entityRows, prompts, engines, citedRows] = await Promise.all([
        runIds.length
          ? prisma.cell_results.findMany({
              where: {
                org_id: orgId,
                project_id: projectId,
                run_date: day,
                run_id: { in: runIds },
              },
            })
          : [],
        runIds.length
          ? prisma.cell_entity_results.findMany({
              where: {
                org_id: orgId,
                project_id: projectId,
                run_date: day,
                run_id: { in: runIds },
              },
            })
          : [],
        prisma.prompts.findMany({
          where: { project_id: projectId, org_id: orgId },
          select: { id: true, priority: true },
        }),
        prisma.project_engines.findMany({
          where: { project_id: projectId, org_id: orgId },
          select: { engine_code: true, weight: true },
        }),
        runIds.length
          ? prisma.citations.groupBy({
              by: ['engine_code', 'owner_entity_id', 'is_own'],
              where: {
                org_id: orgId,
                project_id: projectId,
                run_date: day,
                run_id: { in: runIds },
              },
              _count: { _all: true },
            })
          : [],
      ]);

      const cells = cellRows.map((c) => ({
        promptId: String(c.prompt_id),
        engineCode: c.engine_code,
        status: c.status,
        nOk: c.n_ok,
        nNoAnswer: c.n_no_answer,
        cellScore: c.cell_score == null ? null : Number(c.cell_score),
        entities: entityRows
          .filter(
            (e) =>
              e.run_id === c.run_id &&
              e.prompt_id === c.prompt_id &&
              e.engine_code === c.engine_code,
          )
          .map((e) => ({
            entityId: String(e.entity_id),
            kMentioned: e.k_mentioned,
            kRecommended: e.k_recommended,
            kCited: e.k_cited,
            rankSum: e.rank_sum,
            rankN: e.rank_n,
            sentimentSum: e.sentiment_sum,
            sentimentN: e.sentiment_n,
          })),
      }));

      const citationCounts = {};
      for (const r of citedRows) {
        const c = (citationCounts[r.engine_code] ??= { total: 0, byEntity: {} });
        const n = r._count._all;
        c.total += n;
        const owner = r.owner_entity_id == null ? null : String(r.owner_entity_id);
        // The brand's own domain counts for the brand even when the citation names no owner.
        const credit = owner ?? (r.is_own ? brandId : null);
        if (credit) c.byEntity[credit] = (c.byEntity[credit] ?? 0) + n;
      }

      const rows = rollupDay({
        cells,
        entityIds,
        brandId,
        promptWeights: Object.fromEntries(prompts.map((p) => [String(p.id), p.priority])),
        engineWeights: Object.fromEntries(engines.map((e) => [e.engine_code, Number(e.weight)])),
        citationCounts,
      });

      await transaction(prisma, async (tx) => {
        await tx.metric_daily.deleteMany({
          where: { project_id: projectId, org_id: orgId, metric_date: day },
        });
        if (rows.length) {
          await tx.metric_daily.createMany({
            data: rows.map((r) => ({
              org_id: orgId,
              project_id: projectId,
              metric_date: day,
              engine_code: r.engineCode,
              entity_id: BigInt(r.entityId),
              cells_total: r.cellsTotal,
              cells_partial: r.cellsPartial,
              n_answers: r.nAnswers,
              k_mentioned: r.kMentioned,
              k_recommended: r.kRecommended,
              k_cited: r.kCited,
              rank_sum: r.rankSum,
              rank_n: r.rankN,
              sentiment_sum: r.sentimentSum,
              sentiment_n: r.sentimentN,
              citations_total: r.citationsTotal,
              citations_entity: r.citationsEntity,
              vis_weighted_sum: r.visWeightedSum == null ? null : String(r.visWeightedSum),
              vis_weight_total: r.visWeightTotal == null ? null : String(r.visWeightTotal),
              aio_queries: r.aioQueries,
              aio_triggered: r.aioTriggered,
            })),
          });
        }
      });
      return rows.length;
    },

    /** A project's rollup rows between two dates (inclusive), oldest first. */
    async range(projectId, { from, to }) {
      const rows = await prisma.metric_daily.findMany({
        where: {
          project_id: projectId,
          org_id: orgId,
          metric_date: {
            gte: new Date(`${dayString(from)}T00:00:00Z`),
            lte: new Date(`${dayString(to)}T00:00:00Z`),
          },
        },
        orderBy: [{ metric_date: 'asc' }, { engine_code: 'asc' }, { entity_id: 'asc' }],
      });
      return rows.map((r) => ({
        metricDate: dayString(r.metric_date),
        engineCode: r.engine_code,
        entityId: String(r.entity_id),
        cellsTotal: r.cells_total,
        cellsPartial: r.cells_partial,
        nAnswers: r.n_answers,
        kMentioned: r.k_mentioned,
        kRecommended: r.k_recommended,
        kCited: r.k_cited,
        rankSum: r.rank_sum,
        rankN: r.rank_n,
        sentimentSum: r.sentiment_sum,
        sentimentN: r.sentiment_n,
        citationsTotal: r.citations_total,
        citationsEntity: r.citations_entity,
        visWeightedSum: r.vis_weighted_sum == null ? null : Number(r.vis_weighted_sum),
        visWeightTotal: r.vis_weight_total == null ? null : Number(r.vis_weight_total),
        aioQueries: r.aio_queries,
        aioTriggered: r.aio_triggered,
      }));
    },
  };

  const changes = {
    /**
     * Compare the trailing four weeks with the four before and store each significant change once (the dedupe key
     * is the metric, the engine, the entity and the window's last day, so a repeated job adds nothing). Returns
     * `{ found, added }`.
     */
    async detect(projectId, { asOf, runId = null }) {
      await ownProject(projectId);
      const { brandId } = await trackedIds(projectId);
      if (!brandId) return { found: 0, added: 0 };
      const windows = windowsAt(asOf, TREND_WINDOW_DAYS);
      const rows = await metrics.range(projectId, {
        from: windows.before[0],
        to: windows.after[1],
      });
      const events = detectChanges({ rows, brandId, asOf });
      let added = 0;
      for (const e of events) {
        try {
          await prisma.change_events.create({
            data: {
              org_id: orgId,
              project_id: projectId,
              run_id: runId,
              kind: e.kind,
              engine_code: e.engineCode,
              entity_id: BigInt(e.entityId),
              before_start: new Date(`${e.before[0]}T00:00:00Z`),
              before_end: new Date(`${e.before[1]}T00:00:00Z`),
              after_start: new Date(`${e.after[0]}T00:00:00Z`),
              after_end: new Date(`${e.after[1]}T00:00:00Z`),
              n_before: e.nBefore,
              k_before: e.kBefore,
              n_after: e.nAfter,
              k_after: e.kAfter,
              value_before: e.valueBefore.toFixed(4),
              value_after: e.valueAfter.toFixed(4),
              delta_pp: e.deltaPp.toFixed(2),
              p_value: e.p.toFixed(8),
              direction: e.direction,
              is_significant: true,
              dedupe_key: e.dedupeKey,
            },
          });
          added += 1;
        } catch (err) {
          if (!isUniqueViolation(err, 'uq_change_events_dedupe')) throw err;
        }
      }
      return { found: events.length, added };
    },

    /** A project's change events, newest first. */
    forProject: (projectId, { limit = 50 } = {}) =>
      prisma.change_events.findMany({
        where: { project_id: projectId, org_id: orgId },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: Math.min(Math.max(1, limit), 200),
      }),
  };

  const quota = {
    /**
     * Take one "run now" from this month's allowance, if there is one left. The check and the increment are one
     * statement, so two clicks at once cannot both take the last one. The allowance is the plan's
     * `runs_now_per_month`, or `RUNS_NOW_PLACEHOLDER` until the founder sets it (task 0.17).
     * Returns `{ allowed, used, limit }`.
     */
    async takeRunNow({ now = new Date() } = {}) {
      const org = await prisma.organizations.findFirst({
        where: { id: orgId },
        select: { plan_code: true },
      });
      const plan = org?.plan_code
        ? await prisma.plans.findUnique({
            where: { code: org.plan_code },
            select: { runs_now_per_month: true },
          })
        : null;
      const limit = plan?.runs_now_per_month ?? RUNS_NOW_PLACEHOLDER;
      const period = monthStart(now);
      // The row must exist before it can be incremented conditionally.
      await prisma.$executeRaw`
        INSERT INTO quota_usage (org_id, period_month, meter, used_units)
        VALUES (${orgId}, ${period}, 'runs_now', 0)
        ON DUPLICATE KEY UPDATE org_id = org_id`;
      const taken = await prisma.$executeRaw`
        UPDATE quota_usage SET used_units = used_units + 1
        WHERE org_id = ${orgId} AND period_month = ${period} AND meter = 'runs_now' AND used_units < ${limit}`;
      const row = await prisma.quota_usage.findFirst({
        where: { org_id: orgId, period_month: period, meter: 'runs_now' },
      });
      return { allowed: Number(taken) === 1, used: Number(row?.used_units ?? 0), limit };
    },

    /** Give back a "run now" that did not start a run (the project was archived in between, say). */
    async returnRunNow({ now = new Date() } = {}) {
      await prisma.$executeRaw`
        UPDATE quota_usage SET used_units = used_units - 1
        WHERE org_id = ${orgId} AND period_month = ${monthStart(now)} AND meter = 'runs_now' AND used_units >= 1`;
    },

    /** This month's "run now" use: `{ used, limit }`. */
    async runNowUsage({ now = new Date() } = {}) {
      const org = await prisma.organizations.findFirst({
        where: { id: orgId },
        select: { plan_code: true },
      });
      const plan = org?.plan_code
        ? await prisma.plans.findUnique({
            where: { code: org.plan_code },
            select: { runs_now_per_month: true },
          })
        : null;
      const row = await prisma.quota_usage.findFirst({
        where: { org_id: orgId, period_month: monthStart(now), meter: 'runs_now' },
      });
      return {
        used: Number(row?.used_units ?? 0),
        limit: plan?.runs_now_per_month ?? RUNS_NOW_PLACEHOLDER,
      };
    },
  };

  return { runs, metrics, changes, quota };
}
