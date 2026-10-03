import { DelayedError, UnrecoverableError, Worker } from 'bullmq';
import { backoffDelayMs, RETRY_POLICY } from '../core/backoff.js';
import { createAlerter } from '../lib/alerts.js';
import { createConcurrencyLimiter } from '../lib/concurrency.js';
import { jobId } from '../lib/job-ids.js';
import { createJobClient, JOBS } from '../lib/jobs.js';
import { createHealthTracker } from '../lib/provider-health.js';
import { closeQueues, createQueues, QUEUES } from '../lib/queues.js';
import { createRateLimiter } from '../lib/rate-limit.js';
import { DEFAULT_AUDIT_DAILY_BUDGET_USD } from '../core/spend.js';
import { createAuditBudget } from './audit-budget.js';
import { Deferral, deferJob } from './deferral.js';
import { auditHandlers } from './handlers/audit.js';
import { collectHandlers } from './handlers/collect.js';
import { crawlHandlers } from './handlers/crawl.js';
import { extractHandlers } from './handlers/extract.js';
import { setupHandlers } from './handlers/setup.js';
import { systemHandlers } from './handlers/system.js';
import { createProviderCaller } from './provider-call.js';
import { createSpendGuard } from './spend-guard.js';

/** What runs on a schedule, and how often. Cron times are UTC. */
export const SCHEDULES = Object.freeze([
  { name: 'scheduler.tick', repeat: { pattern: '0 * * * *', tz: 'UTC' } },
  { name: 'guard.spend', repeat: { every: 15 * 60_000 } },
  { name: 'guard.provider_health', repeat: { every: 5 * 60_000 } },
]);

/**
 * The worker, as an object: queues, one BullMQ Worker per queue, and the shared helpers every handler gets.
 * src/worker/index.js is a thin wrapper that starts one; tests start their own against a private key prefix.
 *
 * @param {object} deps
 * @param {object} deps.redis    an ioredis connection created with role 'worker'
 * @param {string} deps.prefix   key prefix for every queue and Redis key
 * @param {object} deps.db       createDb()
 * @param {object} [deps.handlers]   extra or replacement handlers by job name (tests, later phases)
 * @param {object} [deps.retry]      { baseMs, capMs } for backoff; tests use tiny values
 * @param {object} [deps.crawler]    { fetcher, renderer, store, targetFor } for crawl.readiness; without it that job fails
 *                                   at once instead of retrying
 * @param {object} [deps.collection] { adapters, store } for collect.answer: the engine adapters (src/engines) and the
 *                                   bucket raw answers go to; without it that job fails at once
 * @param {object} [deps.audit]      { dailyBudgetUsd, mail, setupModel, extractionModel } for audit.run: what all free audits may
 *                                   spend in a UTC day, the sender of the report email (src/lib/audit-mail.js, optional),
 *                                   and the model keys for the Brand Kit/questions (default haiku45) and for reading
 *                                   answers (default: the extraction model). audit.run also needs `crawler`,
 *                                   `collection` and `extraction`; without them it fails at once
 * @param {object} [deps.extraction] { claude, store, model } for the extract.* jobs: the Claude client (src/llm/claude.js),
 *                                   the bucket the answers are in, and the model key (src/llm/models.js); without it
 *                                   those jobs fail at once
 */
export function createWorkerRuntime({
  redis,
  prefix,
  db,
  logger,
  alerts = createAlerter({ logger }),
  handlers: extraHandlers = {},
  retry = {},
  crawler = null,
  collection = null,
  extraction = null,
  audit = {},
  now = () => new Date(),
  queueNames = Object.keys(QUEUES),
  concurrencyOverride = {},
}) {
  const queues = createQueues({ connection: redis, prefix });
  const jobs = createJobClient(queues);
  const handlers = {
    ...systemHandlers,
    ...auditHandlers,
    ...crawlHandlers,
    ...collectHandlers,
    ...extractHandlers,
    ...setupHandlers,
    ...extraHandlers,
  };

  const limiter = createRateLimiter(redis, { prefix });
  const concurrency = createConcurrencyLimiter(redis, { prefix });
  const health = createHealthTracker(redis, { prefix });
  const spendGuard = createSpendGuard({ db, alerts, logger, now });
  const callProvider = createProviderCaller({
    db,
    limiter,
    concurrency,
    health,
    spendGuard,
    logger,
    now,
  });

  const auditBudget = createAuditBudget({
    db,
    alerts,
    logger,
    capUsd: audit.dailyBudgetUsd ?? DEFAULT_AUDIT_DAILY_BUDGET_USD,
    now,
  });

  const ctx = {
    db,
    redis,
    prefix,
    logger,
    alerts,
    jobs,
    limiter,
    concurrency,
    health,
    spendGuard,
    callProvider,
    crawler,
    collection,
    extraction,
    audit: { ...audit, budget: auditBudget },
    now,
    isHandled: (name) => typeof handlers[name] === 'function',
  };

  /** Validate, find the handler, run it. A "not now" answer becomes a delayed job, not a failure. */
  const processorFor = (queueName) => async (job, token) => {
    const def = JOBS[job.name];
    if (!def || def.queue !== queueName) {
      throw new UnrecoverableError(`Unexpected job "${job.name}" on queue "${queueName}"`);
    }
    let data;
    try {
      data = def.schema.parse(job.data);
    } catch (err) {
      // A malformed payload will be just as malformed on the next attempt.
      throw new UnrecoverableError(`Bad payload for ${job.name}: ${err.message}`);
    }
    const handler = handlers[job.name];
    if (!handler) throw new UnrecoverableError(`No handler registered for ${job.name}`);
    try {
      return await handler(ctx, data, job);
    } catch (err) {
      if (err instanceof Deferral) return deferJob(job, token, err);
      throw err;
    }
  };

  const workers = [];

  return {
    queues,
    jobs,
    ctx,
    workers,

    /** Create the recurring jobs (idempotent: running it again just updates them) and start every worker. */
    async start({ schedule = true } = {}) {
      for (const { name, repeat } of schedule ? SCHEDULES : []) {
        await queues.system.upsertJobScheduler(
          jobId('schedule', name.replaceAll('.', '_')),
          repeat,
          { name, data: {} },
        );
      }
      for (const queueName of queueNames) {
        const worker = new Worker(queueName, processorFor(queueName), {
          connection: redis,
          prefix,
          concurrency: concurrencyOverride[queueName] ?? QUEUES[queueName].concurrency,
          settings: {
            backoffStrategy: (attemptsMade) =>
              backoffDelayMs(attemptsMade, {
                baseMs: retry.baseMs ?? RETRY_POLICY.baseMs,
                capMs: retry.capMs ?? RETRY_POLICY.capMs,
              }),
          },
        });
        worker.on('error', (err) =>
          logger.error({ queue: queueName, err: err.message }, 'Worker error'),
        );
        worker.on('failed', (job, err) => {
          if (err instanceof DelayedError) return;
          const final = job && job.attemptsMade >= (job.opts.attempts ?? 1);
          logger[final ? 'error' : 'warn'](
            {
              queue: queueName,
              job: job?.name,
              id: job?.id,
              attemptsMade: job?.attemptsMade,
              err: err.message,
            },
            final ? 'Job failed for good (dead-lettered)' : 'Job failed, will retry',
          );
        });
        workers.push(worker);
      }
      for (const worker of workers) await worker.waitUntilReady();
    },

    /** Stop taking new jobs, let running ones finish, then close everything this runtime opened. */
    async stop() {
      await Promise.all(workers.map((w) => w.close()));
      await closeQueues(queues);
    },
  };
}
