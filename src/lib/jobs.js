import { z } from 'zod';
import { jobId as buildJobId } from './job-ids.js';

/**
 * Every kind of job: which queue it belongs to and what its payload must look like. A payload is checked when
 * the job is added AND when a worker picks it up (zod at every boundary), so a bad payload fails loudly at the
 * place that made it instead of deep inside a handler.
 *
 * IDs in a payload are the database's internal IDs as decimal strings: JSON can't carry a BigInt, and these
 * never leave the server.
 */
const id = z.string().regex(/^[1-9]\d{0,19}$/, 'must be a database ID as a string');

export const JOBS = Object.freeze({
  // Hourly: find the projects whose weekly slot is due and start their runs.
  'scheduler.tick': { queue: 'system', schema: z.object({ at: z.iso.datetime().optional() }) },
  // Every 15 minutes: check each organization's spend against its cap. With an `orgId`, only that one (the admin
  // console runs it right after someone changes a cap).
  'guard.spend': { queue: 'system', schema: z.object({ orgId: id.optional() }) },
  // Every 5 minutes: compute error rates, trip or reset circuit breakers, copy health to MySQL.
  'guard.provider_health': { queue: 'system', schema: z.object({}) },

  // The first step of a project's weekly run: make the run for the slot (once), then plan it.
  'tracking.start': {
    queue: 'collect',
    schema: z.object({ orgId: id, projectId: id, weekKey: z.string().regex(/^\d{4}-W\d{2}$/) }),
  },

  // Plan a run that already has its row: a first run or a "run now". The scheduled run is made by `tracking.start`.
  'tracking.run': { queue: 'collect', schema: z.object({ orgId: id, runId: id }) },
  // Move one run along: wait for its answers, have them read, then build its cells, rollup and change events. It
  // waits by deferring itself, so it is one job per run for the run's whole life.
  'tracking.advance': { queue: 'collect', schema: z.object({ orgId: id, runId: id }) },

  // Read one project's website and score its AI readiness (Phase 4, MVP F1/F2). Whoever asks first creates the
  // scan row ("queued"); the job carries only its ID. The website to read comes from the project, never the payload.
  'crawl.readiness': {
    queue: 'crawl',
    schema: z.object({ orgId: id, projectId: id, scanId: id }),
  },

  // Collect one AI answer (Phase 5, MVP F4): one prompt, one engine, one sample. The snapshot row is created first
  // ("pending"); the question, the engine and the locale come from it and its prompt, never from the payload.
  // `submittedAt` is set by the job itself when a provider queued the question, so polling knows when to give up.
  'collect.answer': {
    queue: 'collect',
    schema: z.object({ orgId: id, snapshotId: id, submittedAt: z.iso.datetime().optional() }),
  },

  // Read every collected answer of a run with one Claude batch (Phase 6, MVP §6.4). The answers, the tracked brands
  // and the model come from the database and the configuration, never the payload.
  'extract.batch': { queue: 'extract', schema: z.object({ orgId: id, runId: id }) },
  // Wait for one Claude batch, then store its results. The batch ID must be one the run itself recorded.
  'extract.poll': {
    queue: 'extract',
    schema: z.object({ orgId: id, runId: id, batchId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }),
  },
  // Read one answer now (a batch item that failed; the free audit in Phase 7).
  'extract.answer': { queue: 'extract', schema: z.object({ orgId: id, snapshotId: id }) },

  // Read a project's website and draft its full Brand Kit (Milestone 3, MVP F2). `baseVersion` is the kit version the
  // request started from (0 = none): a kit saved since means a person got there first, and the draft is dropped.
  'brandkit.extract': {
    queue: 'content',
    schema: z.object({
      orgId: id,
      projectId: id,
      baseVersion: z.number().int().min(0).max(100_000),
    }),
  },
  // Write a project's question set from its Brand Kit (Milestone 3, MVP F3). The set is saved as active questions
  // (source "generated") that the customer can pause, reword or archive in the Prompt Manager.
  'questions.generate': {
    queue: 'content',
    schema: z.object({
      orgId: id,
      projectId: id,
      count: z.number().int().min(25).max(50).default(30),
    }),
  },

  // Bring a project's recommendations up to date from its latest scan and answers (Milestone 6, MVP F7). The rules
  // engine reads everything from the database; `runId` only records which run it was triggered by.
  'recommendations.refresh': {
    queue: 'content',
    schema: z.object({ orgId: id, projectId: id, runId: id.optional() }),
  },
  // Have the model rewrite one recommendation's words from its evidence. Whatever it returns is checked against the
  // evidence, and thrown away if it claims more than the evidence does.
  'recommendations.narrate': {
    queue: 'content',
    schema: z.object({ orgId: id, recommendationId: id }),
  },
  // The same-day re-check of a fix marked done: scan the site again and read the check the fix is about. Attempt 1 is
  // at once, 2 after an hour, 3 after a day.
  'fix.verify': {
    queue: 'crawl',
    schema: z.object({ orgId: id, recommendationId: id, attempt: z.number().int().min(1).max(3) }),
  },
  // Daily: queue the before/after measurement of every fix that is due, and re-queue re-checks that never ran.
  'outcomes.sweep': { queue: 'system', schema: z.object({}) },
  // One fix's +2 or +4 week before/after comparison.
  'outcomes.measure': { queue: 'system', schema: z.object({ orgId: id, recommendationId: id }) },

  // The Content Studio's pipeline (Milestone 7, MVP F8): one job per stage, each queuing the next when it succeeds.
  // Everything but the IDs comes from the item's row. Research and the draft are paid Claude calls; the check is free.
  'content.research': {
    queue: 'content',
    schema: z.object({ orgId: id, projectId: id, itemId: id }),
  },
  'content.brief': { queue: 'content', schema: z.object({ orgId: id, projectId: id, itemId: id }) },
  'content.draft': { queue: 'content', schema: z.object({ orgId: id, projectId: id, itemId: id }) },
  'content.qc': { queue: 'content', schema: z.object({ orgId: id, projectId: id, itemId: id }) },
  // Send an approved item to the customer's WordPress. The change row (`site_changes`) says what and who approved it.
  'content.publish': {
    queue: 'content',
    schema: z.object({ orgId: id, projectId: id, itemId: id, siteChangeId: id }),
  },
  // Check a project's WordPress connection: does the site answer, is the login still good, is the plugin there.
  'wordpress.test': { queue: 'content', schema: z.object({ orgId: id, projectId: id }) },

  // Run one free audit from start to finish (Milestone 1, MVP F1): read the site, work out the brand, ask four engines
  // five questions, score and list the fixes. The domain, the visitor and everything else come from the audit row;
  // the payload is only its ID.
  'audit.run': { queue: 'audit', schema: z.object({ auditId: id }) },

  // Billing (Milestone 8). Daily: ask Stripe about every live subscription and store what it says (the webhook does this in
  // real time; this is the safety net). Hourly: report drafts beyond a plan's allowance to Stripe's usage meter. Daily:
  // warn cancelled accounts before their read-only period ends, then close the ones whose period is over.
  'billing.reconcile': { queue: 'system', schema: z.object({}) },
  'billing.report_usage': { queue: 'system', schema: z.object({}) },
  'retention.sweep': { queue: 'system', schema: z.object({}) },
  // Daily: tell owners their trial is about to end.
  'billing.notices': { queue: 'system', schema: z.object({}) },

  // Google Analytics and Search Console (Milestone 8). Daily: queue one sync per connected project; each sync opens the
  // project's stored login (only the worker can), reads the days not yet read, and stores them.
  'sync.google.sweep': { queue: 'system', schema: z.object({}) },
  'sync.google': { queue: 'system', schema: z.object({ orgId: id, projectId: id }) },

  // The weekly digest and alerts (Milestone 8). Hourly: find the timezones that are at Monday 08:00 and queue one
  // `digest.send` per project with someone there; that job builds the digest once and sends it to each member whose
  // local time it is. `alerts.evaluate` follows a finished run: significant drops, a rising competitor, negative claims.
  'digest.tick': { queue: 'system', schema: z.object({ at: z.iso.datetime().optional() }) },
  'digest.send': {
    queue: 'system',
    schema: z.object({ orgId: id, projectId: id, at: z.iso.datetime() }),
  },
  'alerts.evaluate': {
    queue: 'system',
    schema: z.object({ orgId: id, projectId: id, runId: id.optional() }),
  },

  // A job that goes through the whole path (queue, retries, rate limit, spend cap, ledger) and does nothing
  // else. It is the Phase 3 exit test, and the way to prove the plumbing on a new machine.
  'system.noop': {
    queue: 'system',
    schema: z.object({
      orgId: id,
      projectId: id.optional(),
      provider: z.string().min(1).max(32).default('noop'),
      engine: z.string().max(32).default(''),
      costUsd: z
        .string()
        .regex(/^\d{1,6}(\.\d{1,6})?$/)
        .default('0.001'),
      /** Fail this many attempts before succeeding, to exercise retries. */
      failTimes: z.number().int().min(0).max(10).default(0),
      /** Fail the first attempt AFTER the ledger row is written, to prove a retry doesn't double-count. */
      failAfterLedger: z.boolean().default(false),
      /** Sleep inside the call, to hold a concurrency slot. */
      holdMs: z.number().int().min(0).max(60_000).default(0),
    }),
  },
});

export class UnknownJobError extends Error {}

export function parseJob(name, data) {
  const def = JOBS[name];
  if (!def) throw new UnknownJobError(`Unknown job: ${name}`);
  return { def, data: def.schema.parse(data ?? {}) };
}

/**
 * The producer's side: `jobs.add('system.noop', data, { jobId })` validates the payload and puts the job on the
 * right queue. Adding a job whose `jobId` already exists is a no-op that returns the existing job.
 */
export function createJobClient(queues) {
  return {
    async add(name, data, { jobId, delayMs, priority } = {}) {
      const { def, data: valid } = parseJob(name, data);
      const queue = queues[def.queue];
      return queue.add(name, valid, {
        ...(jobId ? { jobId: buildJobId(jobId) } : {}),
        ...(delayMs ? { delay: delayMs } : {}),
        ...(priority ? { priority } : {}),
      });
    },
  };
}
