import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ANOMALY_FACTOR,
  byOrganization,
  byPlan,
  costPerAnswer,
  margin,
  spendAnomaly,
  usd,
} from './admin-costs.js';
import { summarizeHealth } from './admin-health.js';
import { KNOWN_FLAGS, FLAG_KEY, resolveFlag } from './flags.js';

const M = 1_000_000;

describe('margin', () => {
  test('profit over revenue, against the 70% target', () => {
    assert.deepEqual(
      (({ state, pct }) => ({ state, pct }))(margin({ revenueMicros: 79 * M, costMicros: 20 * M })),
      { state: 'on_target', pct: ((79 - 20) / 79) * 100 },
    );
    assert.equal(margin({ revenueMicros: 79 * M, costMicros: 38 * M }).state, 'below_target');
    assert.equal(margin({ revenueMicros: 79 * M, costMicros: 90 * M }).state, 'loss');
    assert.equal(margin({ revenueMicros: 79 * M, costMicros: 20 * M }).text, '75%');
  });

  test('no revenue (a trial, a design partner) is "no revenue", never −100%', () => {
    const m = margin({ revenueMicros: 0, costMicros: 12 * M });
    assert.equal(m.state, 'no_revenue');
    assert.equal(m.pct, null);
    assert.equal(m.profitMicros, -12 * M);
  });
});

describe('by plan and by organization', () => {
  const rows = [
    {
      orgId: 1n,
      planCode: 'starter',
      billingStatus: 'active',
      priceMicros: 79 * M,
      costMicros: 30 * M,
    },
    {
      orgId: 2n,
      planCode: 'starter',
      billingStatus: 'active',
      priceMicros: 79 * M,
      costMicros: 10 * M,
    },
    {
      orgId: 3n,
      planCode: 'starter',
      billingStatus: 'trialing',
      priceMicros: 79 * M,
      costMicros: 5 * M,
    },
    {
      orgId: 4n,
      planCode: 'growth',
      billingStatus: 'active',
      priceMicros: 249 * M,
      costMicros: 90 * M,
    },
    { orgId: 5n, planCode: null, billingStatus: 'none', priceMicros: 0, costMicros: 1 * M },
  ];

  test('only paying organizations count as revenue; a trial’s cost still counts', () => {
    const plans = byPlan(rows);
    const starter = plans.find((p) => p.planCode === 'starter');
    assert.deepEqual(
      [starter.orgs, starter.paying, starter.revenueMicros, starter.costMicros],
      [3, 2, 158 * M, 45 * M],
    );
    assert.equal(starter.margin.text, `${Math.round(((158 - 45) / 158) * 100)}%`);
    assert.equal(plans.find((p) => p.planCode === 'none').margin.state, 'no_revenue');
    assert.equal(plans[0].planCode, 'growth', 'the plan that costs most is first');
  });

  test('each organization shows its own margin, most expensive first; a trial has no revenue', () => {
    const orgs = byOrganization(rows);
    assert.deepEqual(
      orgs.map((o) => String(o.orgId)),
      ['4', '1', '2', '3', '5'],
    );
    assert.equal(orgs.find((o) => o.orgId === 3n).margin.state, 'no_revenue');
    assert.equal(orgs.find((o) => o.orgId === 1n).revenueMicros, 79 * M);
  });
});

describe('spend anomalies', () => {
  test('flags today only when it has already passed 150% of the recent average', () => {
    const prior = [10 * M, 10 * M, 10 * M, 10 * M];
    assert.equal(
      spendAnomaly({ todayMicros: 4 * M, priorMicros: prior }).state,
      'normal',
      'a quiet morning is not an anomaly',
    );
    assert.equal(
      spendAnomaly({ todayMicros: 15 * M, priorMicros: prior }).state,
      'normal',
      'exactly 150% is not over',
    );
    const high = spendAnomaly({ todayMicros: 16 * M, priorMicros: prior });
    assert.equal(high.state, 'high');
    assert.match(high.text, /160%/);
    assert.equal(ANOMALY_FACTOR, 1.5);
  });

  test('with fewer than three earlier days there is nothing to compare, and zero days do not drag the average down', () => {
    assert.equal(
      spendAnomaly({ todayMicros: 99 * M, priorMicros: [5 * M, 5 * M] }).state,
      'unknown',
    );
    assert.equal(
      spendAnomaly({ todayMicros: 99 * M, priorMicros: [0, 0, 0, 0, 10 * M] }).state,
      'unknown',
    );
    assert.equal(
      spendAnomaly({ todayMicros: 11 * M, priorMicros: [0, 10 * M, 10 * M, 10 * M] }).state,
      'normal',
    );
  });
});

describe('cost per answer', () => {
  test('against the target, with the cost of a question and engine', () => {
    const ok = costPerAnswer({ costMicros: 30_000 * 100, answers: 100 });
    assert.equal(ok.state, 'on_target');
    assert.equal(ok.perAnswerMicros, 30_000);
    assert.match(ok.text, /\$0\.0300 per answer, about \$0\.090 per question and engine/);
    assert.equal(costPerAnswer({ costMicros: 50_000 * 10, answers: 10 }).state, 'over_target');
  });

  test('no answers is "no data", never a cost of zero', () => {
    const none = costPerAnswer({ costMicros: 5 * M, answers: 0 });
    assert.equal(none.state, 'unknown');
    assert.equal(none.perAnswerMicros, null);
  });
});

describe('usd', () => {
  test('whole dollars, cents or fractions of a cent, with a proper minus', () => {
    assert.equal(usd(1_234_567), '$1.23');
    assert.equal(usd(1_234_567, 4), '$1.2346');
    assert.equal(usd(-5 * M), '−$5.00');
    assert.equal(usd(0), '$0.00');
  });
});

describe('provider health', () => {
  const now = new Date('2026-10-05T12:00:00Z');
  const bucket = (provider, minutesAgo, over = {}) => ({
    providerCode: provider,
    engineCode: '',
    bucketStart: new Date(now.getTime() - minutesAgo * 60_000),
    requests: 100,
    successes: 100,
    failures: 0,
    timeouts: 0,
    p50Ms: 400,
    p95Ms: 900,
    costUsd: '0.50',
    breakerState: 'closed',
    ...over,
  });

  test('a healthy provider is healthy, with the 15-minute and 24-hour rates', () => {
    const [row] = summarizeHealth(
      [bucket('dataforseo', 5), bucket('dataforseo', 600, { failures: 2, successes: 98 })],
      now,
    );
    assert.equal(row.status, 'ok');
    assert.equal(row.last15.text, '0.0%');
    assert.equal(row.last24h.requests, 200);
    assert.equal(row.last24h.text, '1.0%');
    assert.equal(row.p95Ms, 900);
    assert.equal(row.costUsd, 1);
  });

  test('more than 10% failing in the last 15 minutes is degraded; timeouts count as failures', () => {
    const [row] = summarizeHealth(
      [bucket('serpapi', 5, { failures: 8, timeouts: 6, successes: 86 })],
      now,
    );
    assert.equal(row.status, 'degraded');
    assert.equal(row.last15.text, '14%');
  });

  test('a handful of requests is not enough to call a provider degraded', () => {
    const [row] = summarizeHealth(
      [bucket('serpapi', 5, { requests: 3, failures: 3, successes: 0 })],
      now,
    );
    assert.equal(row.status, 'ok');
  });

  test('an open breaker comes first, then degraded, then recovering, then healthy', () => {
    const rows = summarizeHealth(
      [
        bucket('a_ok', 5),
        bucket('b_open', 5, { breakerState: 'open' }),
        bucket('c_half', 5, { breakerState: 'half_open' }),
        bucket('d_bad', 5, { failures: 20, successes: 80 }),
      ],
      now,
    );
    assert.deepEqual(
      rows.map((r) => r.providerCode),
      ['b_open', 'd_bad', 'c_half', 'a_ok'],
    );
  });

  test('a provider with no requests in the last 15 minutes has no rate, shown as a dash and not as 0%', () => {
    const [row] = summarizeHealth([bucket('perplexity_api', 120)], now);
    assert.equal(row.last15.text, '—');
    assert.equal(row.last15.rate, null);
    assert.equal(row.last24h.text, '0.0%');
  });

  test('engines are separate rows of the same provider; no data is no rows', () => {
    const rows = summarizeHealth(
      [
        bucket('dataforseo', 5, { engineCode: 'chatgpt' }),
        bucket('dataforseo', 5, { engineCode: 'gemini' }),
      ],
      now,
    );
    assert.deepEqual(
      rows.map((r) => r.label),
      ['dataforseo (chatgpt)', 'dataforseo (gemini)'],
    );
    assert.deepEqual(summarizeHealth([], now), []);
  });
});

describe('feature flags', () => {
  test('an organization’s own setting wins over the default, in either direction', () => {
    assert.equal(resolveFlag({ defaultEnabled: true }), true);
    assert.equal(resolveFlag({ defaultEnabled: true, override: false }), false);
    assert.equal(resolveFlag({ defaultEnabled: false, override: true }), true);
    assert.equal(resolveFlag({ defaultEnabled: false, override: null }), false);
  });

  test('a flag that does not exist is off, even with an override', () => {
    assert.equal(resolveFlag({ exists: false, defaultEnabled: true, override: true }), false);
  });

  test('keys are lower-case words with dots and underscores; every known flag has a valid key and a description', () => {
    for (const ok of ['digest.weekly', 'a_b.c9']) assert.match(ok, FLAG_KEY);
    for (const bad of ['', 'Digest', '1abc', 'a b', 'a-b', 'x'.repeat(65), "a'; DROP"])
      assert.doesNotMatch(bad, FLAG_KEY);
    for (const [key, text] of Object.entries(KNOWN_FLAGS)) {
      assert.match(key, FLAG_KEY);
      assert.ok(text.length > 10);
    }
  });
});
