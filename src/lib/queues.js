import { Queue } from 'bullmq';
import { RETRY_POLICY } from '../core/backoff.js';

/**
 * The queues (MVP §7.8): one per kind of work, each with its own concurrency so a flood of crawls can't use up
 * the slots that answer collection needs. `system` is ours: the hourly tick and the guards (spend, provider
 * health) are housekeeping, not customer work, and shouldn't wait behind it.
 *
 * `concurrency` is how many jobs of that queue one worker process runs at once. Collection is I/O bound (it
 * waits for providers), so it gets the most; content generation holds big prompts in memory, so the least.
 */
export const QUEUES = Object.freeze({
  audit: { concurrency: 4 },
  crawl: { concurrency: 4 },
  collect: { concurrency: 20 },
  extract: { concurrency: 5 },
  content: { concurrency: 3 },
  sync: { concurrency: 4 },
  digest: { concurrency: 2 },
  system: { concurrency: 4 },
});
export const QUEUE_NAMES = Object.freeze(Object.keys(QUEUES));

const DAY_S = 24 * 60 * 60;

/**
 * Applied to every job unless it says otherwise.
 *  - Five attempts with exponential backoff and jitter (the worker supplies the delay: `jitter` below).
 *  - Finished jobs are kept for 7 days, which is also how long a repeated job ID is still recognised as a
 *    duplicate. The database's own unique keys (a run's slot) are the lasting guard.
 *  - Jobs that fail all five attempts stay in the queue's failed set for 30 days. That set is the dead-letter
 *    queue: the admin console lists it with a retry button.
 */
export const DEFAULT_JOB_OPTIONS = Object.freeze({
  attempts: RETRY_POLICY.attempts,
  backoff: { type: 'jitter' },
  removeOnComplete: { age: 7 * DAY_S, count: 50_000 },
  removeOnFail: { age: 30 * DAY_S },
});

/** One Queue object per queue, sharing a Redis connection. The web process uses them to add jobs. */
export function createQueues({ connection, prefix }) {
  return Object.fromEntries(
    QUEUE_NAMES.map((name) => [
      name,
      new Queue(name, { connection, prefix, defaultJobOptions: DEFAULT_JOB_OPTIONS }),
    ]),
  );
}

export async function closeQueues(queues) {
  await Promise.all(Object.values(queues).map((q) => q.close()));
}
