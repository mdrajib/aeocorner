/**
 * Token bucket: the rate limit in front of every provider (MVP §7.8).
 *
 * This is the reference model. The Lua script in src/lib/rate-limit.js does the same arithmetic atomically
 * inside Redis, and an integration test replays random traffic through both and requires identical answers.
 * The model is what the unit tests push simulated load through.
 *
 * A bucket holds up to `capacity` tokens and gains `refillPerSec` tokens per second. A call takes `cost`
 * tokens. With too few, nothing is taken and the answer says how long until there are enough.
 */

/** Tokens are plain numbers; times are milliseconds. State is `{ tokens, updatedAt }` or null (never used). */
export function takeTokens(state, nowMs, { capacity, refillPerSec }, cost = 1) {
  if (!(capacity > 0) || !(refillPerSec > 0) || !(cost > 0)) {
    throw new RangeError('capacity, refillPerSec and cost must be positive');
  }
  if (cost > capacity) throw new RangeError('cost is larger than the bucket can ever hold');

  const last = state ?? { tokens: capacity, updatedAt: nowMs };
  const elapsedMs = Math.max(0, nowMs - last.updatedAt);
  const tokens = Math.min(capacity, last.tokens + (elapsedMs * refillPerSec) / 1000);

  if (tokens >= cost) {
    return { allowed: true, retryAfterMs: 0, state: { tokens: tokens - cost, updatedAt: nowMs } };
  }
  return {
    allowed: false,
    retryAfterMs: Math.ceil(((cost - tokens) / refillPerSec) * 1000),
    state: { tokens, updatedAt: nowMs },
  };
}
