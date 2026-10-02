import { redisKeys } from './redis.js';

/**
 * Per-provider rate limits as Redis token buckets (MVP §7.8).
 *
 * The bucket has to be shared by every worker process, and "read the tokens, subtract, write them back" from
 * two processes at once would hand out the same token twice. So the whole step runs as one Lua script, which
 * Redis executes without interruption. The arithmetic is the one in src/core/token-bucket.js, which is also
 * what the unit tests drive; an integration test replays random traffic through both and requires the same
 * answers.
 *
 * Time comes from Redis (`TIME`), not from the worker, so servers whose clocks disagree still share one
 * bucket fairly. `nowMs` exists for tests.
 */
const TAKE_TOKENS = `
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local now
if ARGV[4] ~= '' then
  now = tonumber(ARGV[4])
else
  local t = redis.call('TIME')
  now = t[1] * 1000 + math.floor(t[2] / 1000)
end
local data = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then
  tokens = capacity
  ts = now
end
local elapsed = math.max(0, now - ts)
tokens = math.min(capacity, tokens + elapsed * rate / 1000)
local allowed = 0
local wait = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  wait = math.ceil((cost - tokens) / rate * 1000)
end
redis.call('HSET', KEYS[1], 'tokens', string.format('%.17g', tokens), 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / rate * 1000) + 60000)
return { allowed, wait, string.format('%.17g', tokens) }
`;

export function createRateLimiter(redis, { prefix }) {
  const keys = redisKeys(prefix);
  if (!redis.aeoTakeTokens)
    redis.defineCommand('aeoTakeTokens', { numberOfKeys: 1, lua: TAKE_TOKENS });

  return {
    /**
     * Try to take `cost` tokens from the bucket named `id` (for example "dataforseo", or "dataforseo:key2" when a
     * provider has more than one account key). Never waits: if there aren't enough tokens, `retryAfterMs` says
     * when there will be.
     */
    async take(id, { capacity, refillPerSec }, cost = 1, { nowMs } = {}) {
      if (!(capacity > 0) || !(refillPerSec > 0) || !(cost > 0) || cost > capacity) {
        throw new RangeError(
          'capacity, refillPerSec and cost must be positive, and cost within capacity',
        );
      }
      const [allowed, retryAfterMs, tokens] = await redis.aeoTakeTokens(
        keys.bucket(id),
        capacity,
        refillPerSec,
        cost,
        nowMs ?? '',
      );
      return { allowed: allowed === 1, retryAfterMs: Number(retryAfterMs), tokens: Number(tokens) };
    },
  };
}
