/**
 * Failed jobs, listed and retried by hand (Milestone 8, task 8.19; MVP §7.8 "failed jobs shown in admin with a retry
 * button"). A job that used up its attempts stays in its queue's failed set for 30 days (src/lib/queues.js); this lists
 * them across queues in one table and retries one at a time. The full Bull Board is still at /queues for the rest.
 *
 * A job's payload carries IDs and nothing else (src/lib/job-ids.js), so showing its keys is safe; its failure reason is
 * our own message, cut short.
 */

const PER_QUEUE = 25;
const SAFE_ID = /^[A-Za-z0-9_.-]{1,200}$/;
const MAX_REASON = 240;

/** @returns {Promise<object[]>} the newest failed jobs of every queue, newest first */
export async function listFailedJobs(queues) {
  const rows = [];
  for (const [queue, q] of Object.entries(queues)) {
    const failed = await q.getFailed(0, PER_QUEUE - 1);
    for (const job of failed) {
      rows.push({
        queue,
        id: String(job.id),
        name: job.name,
        attempts: job.attemptsMade,
        reason: String(job.failedReason ?? 'Unknown').slice(0, MAX_REASON),
        failedAt: job.finishedOn ? new Date(job.finishedOn) : null,
        data: Object.fromEntries(
          Object.entries(job.data ?? {}).filter(([, v]) => typeof v !== 'object'),
        ),
      });
    }
  }
  return rows.sort((a, b) => (b.failedAt?.getTime() ?? 0) - (a.failedAt?.getTime() ?? 0));
}

/**
 * Put one failed job back to run again. The queue must be one of ours and the ID a plain word; a job that is not failed
 * (already retried, or finished) is left alone. Returns whether it was retried.
 */
export async function retryFailedJob(queues, { queue, id }) {
  if (!Object.hasOwn(queues, queue) || !SAFE_ID.test(id)) return false;
  const job = await queues[queue].getJob(id);
  if (!job) return false;
  if ((await job.getState()) !== 'failed') return false;
  await job.retry('failed');
  return true;
}
