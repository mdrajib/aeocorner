import { Redis } from 'ioredis';

/**
 * Redis connections for queues, rate limits and circuit breakers (MVP §7.8).
 *
 * Two roles, because they fail differently:
 *  - 'worker'   BullMQ workers block waiting for jobs, so commands must wait through a reconnect (BullMQ
 *               requires `maxRetriesPerRequest: null`).
 *  - 'producer' The web process adds jobs while handling a request. If Redis is down a command gives up after
 *               two reconnection attempts and the request fails with an error, instead of hanging until the
 *               browser gives up.
 *
 * `rediss://` URLs (DigitalOcean Managed Redis) turn on TLS by themselves.
 */
export function createRedis(url, { role = 'worker', name = 'aeo-corner' } = {}) {
  const common = { connectionName: name, enableReadyCheck: true };
  return new Redis(
    url,
    role === 'producer'
      ? { ...common, maxRetriesPerRequest: 2 }
      : { ...common, maxRetriesPerRequest: null },
  );
}

/** Every key this app creates outside BullMQ lives under `<prefix>:`, so one Redis can serve more than one app. */
export function redisKeys(prefix) {
  const part = (v) => String(v).replace(/[^A-Za-z0-9_.-]/g, '_');
  return {
    prefix,
    bucket: (id) => `${prefix}:rl:bucket:${part(id)}`,
    leases: (scope, orgId) => `${prefix}:rl:leases:${part(scope)}:${part(orgId)}`,
    health: (provider, engine, bucketStartMs) =>
      `${prefix}:health:${part(provider)}:${part(engine || '-')}:${bucketStartMs}`,
    healthLatency: (provider, engine, bucketStartMs) =>
      `${prefix}:health:${part(provider)}:${part(engine || '-')}:${bucketStartMs}:ms`,
    healthIndex: () => `${prefix}:health:pairs`,
    breaker: (provider, engine) => `${prefix}:breaker:${part(provider)}:${part(engine || '-')}`,
    auditLimit: (kind, id, day) => `${prefix}:audit-limit:${part(kind)}:${part(id)}:${day}`,
    otp: (auditId) => `${prefix}:otp:${part(auditId)}`,
    otpSends: (auditId) => `${prefix}:otp:${part(auditId)}:sends`,
    otpCooldown: (auditId) => `${prefix}:otp:${part(auditId)}:cooldown`,
    probe: (provider, engine) => `${prefix}:breaker:${part(provider)}:${part(engine || '-')}:probe`,
  };
}

/**
 * BullMQ stores queued jobs in Redis. If Redis is allowed to evict keys when it fills up, it can silently
 * throw away jobs. Returns the policy so the caller can warn; DigitalOcean's default is already noeviction.
 */
export async function evictionPolicy(redis) {
  const info = await redis.info('memory');
  return /maxmemory_policy:(\S+)/.exec(info)?.[1] ?? 'unknown';
}

/** Close politely, and force the socket shut if Redis doesn't answer. */
export async function closeRedis(redis) {
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}
