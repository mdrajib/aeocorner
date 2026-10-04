import { UnrecoverableError } from 'bullmq';
import { planTasks } from '../../core/tracking.js';
import { DomainError } from '../../db/errors.js';
import {
  answerJobId,
  extractAnswerJobId,
  extractRunJobId,
  trackingAdvanceJobId,
} from '../../lib/job-ids.js';
import { Deferral } from '../deferral.js';
import { queueRefresh } from '../refresh-queue.js';

/**
 * Handlers for a project's tracking run (MVP F4, §7.8): the orchestrator.
 *
 *   tracking.start    the scheduled run of a week: make the run for the slot (once), then plan it.
 *   tracking.run      plan a run that already has its row (a first run or a "run now").
 *   tracking.advance  move the run along until it is done. One job per run; it waits by deferring itself.
 *
 * Planning writes one `pending` snapshot for every question × engine × sample and queues `collect.answer` for each.
 * Both steps are safe to repeat (the snapshot's key and the job's ID are the identity), so a planner that crashed
 * halfway is simply run again and finishes the job.
 *
 * Advancing is a state machine whose state is the database, so a retry or a second copy of the job does no harm:
 *
 *   answers still out       wait (a deadline turns the stragglers into "couldn't check")
 *   answers to be read      batch run: one Claude batch (half price); first run / run now: one reading per answer,
 *                           at once. Wait. (a deadline marks the unread ones failed)
 *   nothing left to wait on settle the cells, roll up the day, look for significant changes, finish the run.
 *
 * A finished run is `complete`, `partial` (some answers could not be checked) or `failed` (none could). Neither of
 * the last two is ever turned into zeros: see core/tracking.js.
 */

export const TRACKING = Object.freeze({
  /** How often a waiting run looks again. */
  collectEveryMs: 30_000,
  extractEveryMs: 60_000,
  /** Longest a run waits for its answers, then for their reading (a Claude batch ends within 24 hours). */
  collectDeadlineMs: 4 * 3_600_000,
  extractDeadlineMs: 26 * 3_600_000,
});

const timing = (ctx) => ({ ...TRACKING, ...(ctx.tracking?.timing ?? {}) });

const FINISHED = new Set(['complete', 'partial', 'failed', 'canceled']);

const queueAdvance = (ctx, orgId, runId, delayMs) =>
  ctx.jobs.add(
    'tracking.advance',
    { orgId: String(orgId), runId: String(runId) },
    { jobId: trackingAdvanceJobId(runId), delayMs },
  );

/** Plan a run: its answers, its collect jobs, and the job that waits on them. Safe to repeat. */
async function planRun(ctx, orgId, runId) {
  const scoped = ctx.db.forOrg(orgId);
  const { run, prompts, engines } = await scoped.runs.plan(runId);
  if (!run) throw new UnrecoverableError(`Run ${runId} was not found`);
  if (FINISHED.has(run.status)) return { runId: String(runId), repeated: true, status: run.status };

  if (run.status === 'queued') {
    if (prompts.length === 0 || engines.length === 0) {
      await scoped.runs.finish(run.id, 'failed', {
        errorSummary: {
          reason: 'nothing_to_track',
          questions: prompts.length,
          engines: engines.length,
        },
      });
      return { runId: String(runId), status: 'failed', reason: 'nothing_to_track' };
    }
    // A person waiting on the result gets the fast queue; the weekly run takes the cheaper one.
    const mode = run.trigger_type === 'schedule' ? 'standard' : 'live';
    const byCode = new Map(engines.map((e) => [e.code, e]));
    for (const task of planTasks({ prompts, engines })) {
      const engine = byCode.get(task.engineCode);
      await scoped.snapshots.create({
        runId: run.id,
        promptId: task.promptId,
        engineCode: task.engineCode,
        sampleIdx: task.sampleIdx,
        providerCode: engine.providerCode,
        method: engine.method,
        mode,
      });
    }
    const tasksPlanned = prompts.length * engines.reduce((n, e) => n + e.samples, 0);
    await scoped.runs.begin(run.id, {
      promptsCount: prompts.length,
      tasksPlanned,
      now: ctx.now(),
    });
  }

  // Every answer that is still waiting gets its job (a duplicate is refused by its ID).
  let queued = 0;
  for (const snapshot of await scoped.snapshots.forRun(run.id)) {
    if (snapshot.status !== 'pending') continue;
    await ctx.jobs.add(
      'collect.answer',
      { orgId: String(orgId), snapshotId: String(snapshot.id) },
      { jobId: answerJobId(snapshot.id) },
    );
    queued += 1;
  }
  await queueAdvance(ctx, orgId, run.id, timing(ctx).collectEveryMs);
  return { runId: String(runId), planned: true, queued };
}

async function trackingStart(ctx, data) {
  const orgId = BigInt(data.orgId);
  const scoped = ctx.db.forOrg(orgId);
  let started;
  try {
    started = await scoped.runs.start({
      projectId: BigInt(data.projectId),
      slotKey: data.weekKey,
      trigger: 'schedule',
      extractionMode: 'batch',
      now: ctx.now(),
    });
  } catch (err) {
    // A project archived or paused since the scheduler looked has nothing to run: not a failure to retry.
    if (
      err instanceof DomainError &&
      ['PROJECT_NOT_IN_ORG', 'PROJECT_NOT_TRACKABLE'].includes(err.code)
    ) {
      return { skipped: err.code };
    }
    throw err;
  }
  return { created: started.created, ...(await planRun(ctx, orgId, started.run.id)) };
}

async function trackingRun(ctx, data) {
  return planRun(ctx, BigInt(data.orgId), BigInt(data.runId));
}

async function trackingAdvance(ctx, data) {
  const orgId = BigInt(data.orgId);
  const runId = BigInt(data.runId);
  const scoped = ctx.db.forOrg(orgId);
  const wait = timing(ctx);
  const now = ctx.now();

  const run = await scoped.runs.get(runId);
  if (!run) throw new UnrecoverableError(`Run ${data.runId} was not found`);
  if (FINISHED.has(run.status)) return { runId: data.runId, status: run.status, repeated: true };
  if (run.status === 'queued')
    throw new Deferral(wait.collectEveryMs, 'the run is not planned yet');

  let progress = await scoped.runs.progress(runId);

  // 1. Answers still out.
  if (progress.collecting > 0) {
    const since = run.started_at ?? run.queued_at;
    if (now.getTime() - since.getTime() < wait.collectDeadlineMs) {
      throw new Deferral(
        wait.collectEveryMs,
        `${progress.collecting} answers still being collected`,
      );
    }
    const expired = await scoped.runs.expirePending(runId, 'timed out waiting for the engine');
    ctx.logger.warn({ runId: data.runId, expired }, 'Run gave up on answers still out');
    progress = await scoped.runs.progress(runId);
  }

  // 2. Answers to be read.
  if (progress.toRead > 0) {
    await scoped.runs.advance(runId, 'extracting', { now });
    const since = run.collected_at ?? now;
    if (now.getTime() - since.getTime() >= wait.extractDeadlineMs) {
      const expired = await scoped.runs.expireUnread(runId);
      ctx.logger.warn({ runId: data.runId, expired }, 'Run gave up on answers nobody read in time');
    } else {
      if (run.extraction_mode === 'sync') {
        for (const snapshot of await scoped.extractions.pendingForRun(runId)) {
          await ctx.jobs.add(
            'extract.answer',
            { orgId: data.orgId, snapshotId: String(snapshot.id) },
            { jobId: extractAnswerJobId(snapshot.id, `run${runId}`) },
          );
        }
      } else {
        await ctx.jobs.add(
          'extract.batch',
          { orgId: data.orgId, runId: data.runId },
          { jobId: extractRunJobId(runId) },
        );
      }
      throw new Deferral(wait.extractEveryMs, `${progress.toRead} answers waiting to be read`);
    }
  }

  // 3. Everything is in, or given up on: build the results.
  await scoped.runs.advance(runId, 'extracting', { now });
  await scoped.runs.advance(runId, 'rolling_up', { now });
  const outcome = await scoped.runs.settle(runId);
  if (outcome.repeated) return { runId: data.runId, status: outcome.status, repeated: true };
  const rows = await scoped.metrics.rollupDay(run.project_id, run.run_date);
  const changes = await scoped.changes.detect(run.project_id, { asOf: run.run_date, runId });

  const errorSummary =
    outcome.status === 'complete'
      ? null
      : { failed: outcome.tasksFailed, planned: outcome.tasksPlanned, ok: outcome.tasksOk };
  await scoped.runs.finish(runId, outcome.status, { errorSummary, now: ctx.now() });
  if (outcome.tasksOk > 0) {
    await scoped.runs.noteFirstRun(run.project_id, ctx.now());
    // New answers may open, change or clear recommendations.
    await queueRefresh(ctx, {
      orgId,
      projectId: run.project_id,
      cause: `run${data.runId}`,
      runId,
    });
  }
  if (outcome.status === 'failed') {
    await ctx.alerts.alert({
      key: `run.failed:${data.runId}`,
      severity: 'warning',
      title: 'A tracking run produced no readable answers',
      details: { runId: data.runId, planned: outcome.tasksPlanned },
    });
  }
  return {
    runId: data.runId,
    status: outcome.status,
    tasksOk: outcome.tasksOk,
    tasksFailed: outcome.tasksFailed,
    rollupRows: rows,
    changes: changes.added,
  };
}

export const trackingHandlers = {
  'tracking.start': trackingStart,
  'tracking.run': trackingRun,
  'tracking.advance': trackingAdvance,
};
