/**
 * How hard the worker may push, in one place.
 *
 * PROVIDER_LIMITS are token buckets: `capacity` is the burst, `refillPerSec` the sustained rate. A provider not
 * listed gets the conservative default. (`noop` is the stand-in provider used by the test job.)
 *
 * The provider values (2026-10-03) come from the providers' documentation, set well under the stated ceiling,
 * because our own polling shares the budget and a throttled account stops every customer at once:
 *   dataforseo      2,000 requests a minute per account (about 33 a second); we use 20 a second, burst 40
 *   perplexity_api  limits depend on the account's usage tier and are not published for the Agent API; 2 a
 *                   second, burst 5, until the account's tier is known
 *   serpapi         each plan has an hourly throughput cap as well as its monthly searches; 2 a second, burst 5,
 *                   until the plan is chosen
 * Re-measure each once the account exists (BUILD_PLAN Phase 5 spike) and record it in ADR-0006.
 *
 * ORG_CONCURRENCY is the most jobs of one kind that a single organization may have running at once across all
 * workers, so one large agency can't take every slot (MVP §7.8). `ttlMs` is how long a slot stays reserved if its
 * worker dies without giving it back.
 */
export const PROVIDER_LIMITS = Object.freeze({
  default: { capacity: 10, refillPerSec: 5 },
  noop: { capacity: 50, refillPerSec: 50 },
  dataforseo: { capacity: 40, refillPerSec: 20 },
  perplexity_api: { capacity: 5, refillPerSec: 2 },
  serpapi: { capacity: 5, refillPerSec: 2 },
  // Claude: a batch is one request however many answers it holds, so this mostly paces single-answer reads.
  anthropic: { capacity: 10, refillPerSec: 4 },
});

export const ORG_CONCURRENCY = Object.freeze({
  default: { cap: 4, ttlMs: 10 * 60_000 },
  collect: { cap: 8, ttlMs: 10 * 60_000 },
  crawl: { cap: 2, ttlMs: 10 * 60_000 },
  extract: { cap: 4, ttlMs: 10 * 60_000 },
  content: { cap: 2, ttlMs: 30 * 60_000 },
});

export const providerLimits = (provider) => PROVIDER_LIMITS[provider] ?? PROVIDER_LIMITS.default;
export const orgConcurrency = (scope) => ORG_CONCURRENCY[scope] ?? ORG_CONCURRENCY.default;
