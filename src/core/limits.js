/**
 * How hard the worker may push, in one place.
 *
 * PROVIDER_LIMITS are token buckets: `capacity` is the burst, `refillPerSec` the sustained rate. Phase 5 replaces
 * `default` with measured values for each provider once the adapters have been run against the real services;
 * until then every provider gets the conservative default, which is slow but can't get an account throttled.
 * (`noop` is the stand-in provider used by the test job.)
 *
 * ORG_CONCURRENCY is the most jobs of one kind that a single organization may have running at once across all
 * workers, so one large agency can't take every slot (MVP §7.8). `ttlMs` is how long a slot stays reserved if its
 * worker dies without giving it back.
 */
export const PROVIDER_LIMITS = Object.freeze({
  default: { capacity: 10, refillPerSec: 5 },
  noop: { capacity: 50, refillPerSec: 50 },
});

export const ORG_CONCURRENCY = Object.freeze({
  default: { cap: 4, ttlMs: 10 * 60_000 },
  collect: { cap: 8, ttlMs: 10 * 60_000 },
  crawl: { cap: 2, ttlMs: 10 * 60_000 },
  content: { cap: 2, ttlMs: 30 * 60_000 },
});

export const providerLimits = (provider) => PROVIDER_LIMITS[provider] ?? PROVIDER_LIMITS.default;
export const orgConcurrency = (scope) => ORG_CONCURRENCY[scope] ?? ORG_CONCURRENCY.default;
