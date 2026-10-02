import { DelayedError } from 'bullmq';

/**
 * "Not now" is not a failure. When a rate limit, an organization's concurrency cap, an open circuit breaker or a
 * spend pause says wait, the job goes back to the queue to run later and does NOT use up one of its five
 * attempts. Handlers and helpers throw a Deferral; the worker turns it into a delayed job.
 */
export class Deferral extends Error {
  constructor(delayMs, reason) {
    super(`Deferred ${Math.round(delayMs)} ms: ${reason}`);
    this.name = 'Deferral';
    this.delayMs = Math.max(1000, Math.round(delayMs));
    this.reason = reason;
  }
}

/** Move the job to the delayed set and stop the current run without counting it as a failure. */
export async function deferJob(job, token, deferral) {
  await job.moveToDelayed(Date.now() + deferral.delayMs, token);
  throw new DelayedError();
}
