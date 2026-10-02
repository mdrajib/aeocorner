/**
 * Provider circuit breaker (MVP §7.8): an error rate above 10% over 15 minutes stops sending traffic to that
 * provider for that engine and switches to the fallback.
 *
 *   closed     normal. Everything goes through.
 *   open       tripped. Nothing goes through; the engine uses its fallback provider.
 *   half_open  after a cooldown, a trickle of probe requests tests whether the provider is back.
 *              Enough good probes close the breaker; one bad probe opens it again.
 *
 * Pure functions. The Redis-backed tracker (src/lib/provider-health.js) feeds in the numbers; the
 * `guard.provider_health` job applies the answer every 5 minutes.
 */

export const BREAKER_POLICY = Object.freeze({
  /** Trip when failures / requests is strictly greater than this. */
  errorRate: 0.1,
  /** How far back the error rate looks. */
  windowMs: 15 * 60_000,
  /** Fewer requests than this in the window is too little to judge: one failure in three is not an outage. */
  minRequests: 20,
  /** How long a tripped breaker stays fully open before probing. */
  cooldownMs: 5 * 60_000,
  /** Good probes needed to close again. */
  probesToClose: 3,
  /** At most one probe request per this long while half open. */
  probeEveryMs: 30_000,
});

/**
 * @param {object} input
 * @param {'closed'|'open'|'half_open'} input.state
 * @param {number|null} input.openedAt     when it last tripped (ms)
 * @param {number} input.now               ms
 * @param {{requests:number, failures:number}} input.window   the last `windowMs`
 * @param {{ok:number, failed:number}} input.probes           probes since it went half open
 * @returns {{state:string, openedAt:number|null, changed:boolean, reason:string|null}}
 */
export function nextBreakerState(
  { state, openedAt, now, window, probes },
  policy = BREAKER_POLICY,
) {
  const keep = { state, openedAt, changed: false, reason: null };

  if (state === 'closed') {
    const rate = window.requests > 0 ? window.failures / window.requests : 0;
    if (window.requests >= policy.minRequests && rate > policy.errorRate) {
      return {
        state: 'open',
        openedAt: now,
        changed: true,
        reason: `error rate ${(rate * 100).toFixed(1)}% over ${window.requests} requests`,
      };
    }
    return keep;
  }

  if (state === 'open') {
    if (now - (openedAt ?? 0) >= policy.cooldownMs) {
      return { state: 'half_open', openedAt, changed: true, reason: 'cooldown over, probing' };
    }
    return keep;
  }

  if (state === 'half_open') {
    if (probes.failed > 0) {
      return { state: 'open', openedAt: now, changed: true, reason: 'a probe failed' };
    }
    if (probes.ok >= policy.probesToClose) {
      return { state: 'closed', openedAt: null, changed: true, reason: 'probes succeeded' };
    }
    return keep;
  }

  throw new RangeError(`Unknown breaker state: ${state}`);
}
