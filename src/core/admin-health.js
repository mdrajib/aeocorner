/**
 * Provider health as a table (Milestone 8, task 8.18; ADMIN_OPERATIONS module 4). Pure: five-minute buckets from
 * `provider_health` come in, one row per provider and engine goes out, with the two windows the runbook uses (the last
 * 15 minutes, where a breaker trips; the last 24 hours, where a trend shows).
 */

/** The error rate that trips a breaker and is worth an alert (ADMIN_OPERATIONS §7). */
export const ERROR_RATE_ALERT = 0.1;
const MIN_REQUESTS = 5;

const rate = (failures, requests) => (requests > 0 ? failures / requests : null);
const pct = (r) => (r === null ? '—' : `${(r * 100).toFixed(r < 0.1 ? 1 : 0)}%`);

/**
 * @param {object[]} buckets  `{ providerCode, engineCode, bucketStart, requests, successes, failures, timeouts, p50Ms, p95Ms, costUsd, breakerState }`
 * @param {Date} now
 * @returns {object[]} rows sorted with the unhealthy first: `{ providerCode, engineCode, label, last15, last24h, p95Ms, breaker, status, lastSeen }`
 */
export function summarizeHealth(buckets, now = new Date()) {
  const since15 = now.getTime() - 15 * 60_000;
  const groups = new Map();
  for (const b of buckets) {
    const key = `${b.providerCode}|${b.engineCode ?? ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  const rows = [...groups.values()].map((list) => {
    const sorted = [...list].sort((a, b) => new Date(a.bucketStart) - new Date(b.bucketStart));
    const recent = sorted.filter((b) => new Date(b.bucketStart).getTime() >= since15);
    const total = (rs) => ({
      requests: rs.reduce((n, b) => n + b.requests, 0),
      failures: rs.reduce((n, b) => n + b.failures + b.timeouts, 0),
    });
    const t15 = total(recent);
    const t24 = total(sorted);
    const last = sorted.at(-1);
    const r15 = rate(t15.failures, t15.requests);
    const r24 = rate(t24.failures, t24.requests);
    const breaker = last.breakerState ?? 'closed';
    let status = 'ok';
    if (breaker === 'open') status = 'open';
    else if (breaker === 'half_open') status = 'recovering';
    else if (r15 !== null && t15.requests >= MIN_REQUESTS && r15 > ERROR_RATE_ALERT)
      status = 'degraded';
    return {
      providerCode: last.providerCode,
      engineCode: last.engineCode ?? '',
      label: last.engineCode ? `${last.providerCode} (${last.engineCode})` : last.providerCode,
      last15: { requests: t15.requests, failures: t15.failures, rate: r15, text: pct(r15) },
      last24h: { requests: t24.requests, failures: t24.failures, rate: r24, text: pct(r24) },
      p95Ms: Math.max(...sorted.map((b) => b.p95Ms ?? 0)) || null,
      costUsd: sorted.reduce((n, b) => n + Number(b.costUsd ?? 0), 0),
      breaker,
      status,
      lastSeen: new Date(last.bucketStart),
    };
  });
  const order = { open: 0, degraded: 1, recovering: 2, ok: 3 };
  return rows.sort((a, b) => order[a.status] - order[b.status] || a.label.localeCompare(b.label));
}

export const STATUS_TEXT = Object.freeze({
  open: { text: 'Breaker open', tone: 'danger' },
  degraded: { text: 'Error rate high', tone: 'warning' },
  recovering: { text: 'Recovering', tone: 'warning' },
  ok: { text: 'Healthy', tone: 'success' },
});
