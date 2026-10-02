/**
 * Retry delay: exponential backoff with jitter (MVP §7.8, max 5 attempts).
 *
 * The ceiling doubles with every failure (base, 2x base, 4x ...) up to `capMs`. The actual wait is somewhere
 * between half the ceiling and the ceiling, so a burst of jobs that failed together doesn't come back
 * together and hit the struggling provider in one wave.
 *
 * `random` is injectable so tests are exact.
 */
export const RETRY_POLICY = Object.freeze({
  attempts: 5,
  baseMs: 5_000,
  capMs: 10 * 60_000,
});

/** `attemptsMade` is how many times the job has run and failed so far (1 after the first failure). */
export function backoffDelayMs(
  attemptsMade,
  { baseMs = RETRY_POLICY.baseMs, capMs = RETRY_POLICY.capMs } = {},
  random = Math.random,
) {
  const n = Math.max(1, Math.floor(attemptsMade));
  const ceiling = Math.min(capMs, baseMs * 2 ** (n - 1));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}
