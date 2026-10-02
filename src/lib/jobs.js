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

  // The first step of a project's weekly run. The orchestrator that handles it arrives with Phase 9; until
  // then nothing is enqueued because no project is "active" yet.
  'tracking.start': {
    queue: 'collect',
    schema: z.object({ orgId: id, projectId: id, weekKey: z.string().regex(/^\d{4}-W\d{2}$/) }),
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
