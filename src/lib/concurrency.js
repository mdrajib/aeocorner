import { redisKeys } from './redis.js';

/**
 * Per-organization concurrency caps in Redis (MVP §7.8): at most `cap` jobs of one kind running for one
 * organization at a time, across every worker process.
 *
 * Each running job holds a lease in a sorted set, scored by the moment the lease expires. Expired leases are
 * dropped on every call, so a worker that crashes mid-job gives its slot back by itself. The logic is
 * src/core/concurrency.js, run as one Lua script so two workers can't both take the last slot.
 */
const ACQUIRE = `
local cap = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local id = ARGV[3]
local now
if ARGV[4] ~= '' then
  now = tonumber(ARGV[4])
else
  local t = redis.call('TIME')
  now = t[1] * 1000 + math.floor(t[2] / 1000)
end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local held = redis.call('ZSCORE', KEYS[1], id)
if held or redis.call('ZCARD', KEYS[1]) < cap then
  redis.call('ZADD', KEYS[1], now + ttl, id)
  redis.call('PEXPIRE', KEYS[1], ttl * 2)
  return 1
end
return 0
`;

export function createConcurrencyLimiter(redis, { prefix }) {
  const keys = redisKeys(prefix);
  if (!redis.aeoAcquireLease)
    redis.defineCommand('aeoAcquireLease', { numberOfKeys: 1, lua: ACQUIRE });

  return {
    /**
     * Take (or renew) a slot for `leaseId` in `scope` (a queue or provider name) for `orgId`.
     * `leaseId` should be the job's ID, so a retried job renews its own slot instead of taking a second one.
     */
    async acquire(scope, orgId, { cap, ttlMs }, leaseId, { nowMs } = {}) {
      if (!(cap >= 1) || !(ttlMs > 0))
        throw new RangeError('cap must be at least 1 and ttlMs positive');
      const ok = await redis.aeoAcquireLease(
        keys.leases(scope, orgId),
        cap,
        ttlMs,
        String(leaseId),
        nowMs ?? '',
      );
      return ok === 1;
    },

    async release(scope, orgId, leaseId) {
      await redis.zrem(keys.leases(scope, orgId), String(leaseId));
    },

    /** Live leases right now (for the admin console and tests). */
    async active(scope, orgId, { nowMs } = {}) {
      const now = nowMs ?? Date.now();
      return redis.zcount(keys.leases(scope, orgId), `(${now}`, '+inf');
    },
  };
}
