import { createLogger } from '../../src/lib/logger.js';
import { memoryAlerter } from '../../src/lib/alerts.js';
import { createWorkerRuntime } from '../../src/worker/runtime.js';
import { connectTestRedis } from './redis.js';

const silent = createLogger({ isTest: true, appEnv: 'test' });

/**
 * A real worker runtime (real BullMQ workers, real Redis, real MySQL) on a private key prefix.
 * Retries use tiny delays so a job that fails five times finishes in well under a second.
 * The recurring schedules are off unless a test asks for them, so no guard runs behind its back.
 */
export async function startRuntime({
  db,
  handlers,
  retry = { baseMs: 20, capMs: 80 },
  queueNames = ['system'],
  schedule = false,
  now,
  concurrencyOverride,
} = {}) {
  const connection = connectTestRedis();
  const alerts = memoryAlerter();
  const runtime = createWorkerRuntime({
    redis: connection.redis,
    prefix: connection.prefix,
    db,
    logger: silent,
    alerts,
    handlers,
    retry,
    queueNames,
    now,
    concurrencyOverride,
  });
  await runtime.start({ schedule });
  return {
    runtime,
    alerts,
    redis: connection.redis,
    prefix: connection.prefix,
    queue: (name) => runtime.queues[name],
    async stop() {
      await runtime.stop();
      await connection.close();
    },
  };
}

/** Poll until `check()` returns something truthy, or fail with `message`. */
export async function until(
  check,
  { timeoutMs = 10_000, intervalMs = 25, message = 'timed out' } = {},
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`until(): ${message}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Wait for a job to reach one of `states`; returns the job as it is once it has.
 * The job is read again after its state matches: a job fetched just before it finished would still show no
 * return value and the old attempt count.
 */
export async function waitForJob(queue, id, states = ['completed', 'failed'], opts = {}) {
  return until(
    async () => {
      const job = await queue.getJob(id);
      if (!job || !states.includes(await job.getState())) return null;
      return queue.getJob(id);
    },
    { message: `job ${id} never reached ${states.join('/')}`, ...opts },
  );
}
