import { BREAKER_POLICY } from '../core/breaker.js';
import { redisKeys } from './redis.js';

/**
 * Live provider health and circuit-breaker state, in Redis (DATABASE_SCHEMA §4: "the live breaker state is in
 * Redis"; MySQL keeps the 5-minute history in `provider_health`).
 *
 * Every provider call records its outcome into the current 5-minute bucket for (provider, engine). The
 * `guard.provider_health` job reads the last 15 minutes of buckets, asks src/core/breaker.js what the breaker
 * should do, stores the answer here, and copies the buckets to MySQL.
 *
 * "Engine" is optional: providers that don't serve one engine (the Claude API) use ''.
 */
export const BUCKET_MS = 5 * 60_000;
const BUCKET_TTL_SECONDS = 3 * 60 * 60; // long enough for the guard to copy a bucket, short enough to clean itself
const LATENCY_SAMPLES = 500;

export const bucketStartOf = (ms) => Math.floor(ms / BUCKET_MS) * BUCKET_MS;

/** The value at percentile `p` (0-1) of a sorted list, or null if there is none. */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

export function createHealthTracker(redis, { prefix, policy = BREAKER_POLICY }) {
  const keys = redisKeys(prefix);
  const bucketCount = Math.ceil(policy.windowMs / BUCKET_MS);

  async function state(provider, engine = '') {
    const h = await redis.hgetall(keys.breaker(provider, engine));
    return {
      state: h.state ?? 'closed',
      openedAt: h.openedAt ? Number(h.openedAt) : null,
      probes: { ok: Number(h.probeOk ?? 0), failed: Number(h.probeFailed ?? 0) },
    };
  }

  return {
    /**
     * Record the outcome of one call. `outcome` is 'success', 'failure' or 'timeout'. `probe` marks the test
     * request sent while the breaker was half open. Cost is in micro-dollars.
     */
    async record(
      provider,
      engine,
      { outcome, ms = 0, costMicros = 0, probe = false, nowMs = Date.now() },
    ) {
      if (!['success', 'failure', 'timeout'].includes(outcome)) {
        throw new RangeError(`Unknown outcome: ${outcome}`);
      }
      const start = bucketStartOf(nowMs);
      const key = keys.health(provider, engine, start);
      const latencyKey = keys.healthLatency(provider, engine, start);
      const pipeline = redis
        .multi()
        .hincrby(key, 'requests', 1)
        .hincrby(
          key,
          outcome === 'success' ? 'successes' : outcome === 'timeout' ? 'timeouts' : 'failures',
          1,
        )
        .hincrby(key, 'costMicros', costMicros)
        .expire(key, BUCKET_TTL_SECONDS)
        .lpush(latencyKey, Math.max(0, Math.round(ms)))
        .ltrim(latencyKey, 0, LATENCY_SAMPLES - 1)
        .expire(latencyKey, BUCKET_TTL_SECONDS)
        .sadd(keys.healthIndex(), `${provider}|${engine}`);
      if (probe) {
        pipeline.hincrby(
          keys.breaker(provider, engine),
          outcome === 'success' ? 'probeOk' : 'probeFailed',
          1,
        );
      }
      await pipeline.exec();
    },

    /** Requests and failures over the last 15 minutes (this bucket plus the two before it). Timeouts count as failures. */
    async window(provider, engine = '', nowMs = Date.now()) {
      const current = bucketStartOf(nowMs);
      const pipeline = redis.multi();
      for (let i = 0; i < bucketCount; i += 1) {
        pipeline.hmget(
          keys.health(provider, engine, current - i * BUCKET_MS),
          'requests',
          'failures',
          'timeouts',
        );
      }
      const results = await pipeline.exec();
      let requests = 0;
      let failures = 0;
      for (const [, [req, fail, timeout]] of results) {
        requests += Number(req ?? 0);
        failures += Number(fail ?? 0) + Number(timeout ?? 0);
      }
      return { requests, failures };
    },

    /** One bucket's counters and latency percentiles, for copying to MySQL. */
    async bucket(provider, engine, bucketStartMs) {
      const [h, samples] = await Promise.all([
        redis.hgetall(keys.health(provider, engine, bucketStartMs)),
        redis.lrange(keys.healthLatency(provider, engine, bucketStartMs), 0, -1),
      ]);
      const sorted = samples.map(Number).sort((a, b) => a - b);
      return {
        requests: Number(h.requests ?? 0),
        successes: Number(h.successes ?? 0),
        failures: Number(h.failures ?? 0),
        timeouts: Number(h.timeouts ?? 0),
        costMicros: Number(h.costMicros ?? 0),
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
      };
    },

    /** Every (provider, engine) that has recorded anything lately. */
    async pairs() {
      const members = await redis.smembers(keys.healthIndex());
      return members.map((m) => {
        const [provider, engine = ''] = m.split('|');
        return { provider, engine };
      });
    },

    state,

    async setState(provider, engine, { state: next, openedAt }) {
      const key = keys.breaker(provider, engine);
      await redis
        .multi()
        .del(key)
        .hset(key, { state: next, ...(openedAt ? { openedAt } : {}), probeOk: 0, probeFailed: 0 })
        .del(keys.probe(provider, engine))
        .exec();
    },

    /**
     * May a request go to this provider for this engine?
     *   'allow'  closed
     *   'probe'  half open, and this request was picked as the test (one per `probeEveryMs`)
     *   'deny'   open, or half open with the test already taken
     */
    async admit(provider, engine = '') {
      const { state: current } = await state(provider, engine);
      if (current === 'closed') return 'allow';
      if (current === 'open') return 'deny';
      const taken = await redis.set(
        keys.probe(provider, engine),
        '1',
        'PX',
        policy.probeEveryMs,
        'NX',
      );
      return taken === 'OK' ? 'probe' : 'deny';
    },
  };
}
