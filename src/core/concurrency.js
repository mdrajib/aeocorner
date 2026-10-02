/**
 * Per-organization concurrency cap: at most `cap` jobs of one kind running for one organization at a time,
 * so one big agency can't take every worker slot (MVP §7.8).
 *
 * A slot is a lease with an expiry. If a worker dies without releasing, the lease times out by itself and the
 * slot comes back, so a crash can never lock an organization out. The Lua script in src/lib/concurrency.js is
 * this same logic inside Redis; an integration test replays random traffic through both.
 *
 * `leases` maps lease ID -> expiry time (ms). Functions return a new map and never change the one passed in.
 */

export function acquireLease(leases, nowMs, { cap, ttlMs }, leaseId) {
  if (!(cap >= 1) || !(ttlMs > 0))
    throw new RangeError('cap must be at least 1 and ttlMs positive');
  const live = new Map([...leases].filter(([, expiresAt]) => expiresAt > nowMs));
  // Asking again with a lease you already hold (a retried job) renews it instead of taking a second slot.
  if (live.has(leaseId) || live.size < cap) {
    live.set(leaseId, nowMs + ttlMs);
    return { acquired: true, leases: live };
  }
  return { acquired: false, leases: live };
}

export function releaseLease(leases, leaseId) {
  const next = new Map(leases);
  next.delete(leaseId);
  return next;
}

/** How many leases are live right now. */
export function activeLeases(leases, nowMs) {
  let n = 0;
  for (const expiresAt of leases.values()) if (expiresAt > nowMs) n += 1;
  return n;
}
