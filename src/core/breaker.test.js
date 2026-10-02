import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BREAKER_POLICY, nextBreakerState } from './breaker.js';
import { chooseRoute } from './routing.js';

const MIN = 60_000;
const step = (input) =>
  nextBreakerState({ openedAt: null, probes: { ok: 0, failed: 0 }, ...input });

describe('circuit breaker', () => {
  test('the policy is the one MVP §7.8 states: more than 10% over 15 minutes', () => {
    assert.equal(BREAKER_POLICY.errorRate, 0.1);
    assert.equal(BREAKER_POLICY.windowMs, 15 * MIN);
  });

  test('closed: an error rate above 10% trips it', () => {
    const r = step({ state: 'closed', now: 1000, window: { requests: 100, failures: 11 } });
    assert.equal(r.state, 'open');
    assert.equal(r.openedAt, 1000);
    assert.equal(r.changed, true);
    assert.match(r.reason, /11\.0%/);
  });

  test('closed: exactly 10% does not (the rule is "more than")', () => {
    const r = step({ state: 'closed', now: 1000, window: { requests: 100, failures: 10 } });
    assert.equal(r.state, 'closed');
    assert.equal(r.changed, false);
  });

  test('closed: too few requests to judge, even at 100% failures', () => {
    const r = step({ state: 'closed', now: 0, window: { requests: 19, failures: 19 } });
    assert.equal(r.state, 'closed');
    assert.equal(
      step({ state: 'closed', now: 0, window: { requests: 20, failures: 20 } }).state,
      'open',
    );
  });

  test('closed: no traffic at all is not an outage', () => {
    assert.equal(
      step({ state: 'closed', now: 0, window: { requests: 0, failures: 0 } }).state,
      'closed',
    );
  });

  test('open: stays open through the cooldown, then starts probing', () => {
    const open = { state: 'open', openedAt: 0, window: { requests: 100, failures: 100 } };
    assert.equal(step({ ...open, now: 5 * MIN - 1 }).state, 'open');
    const r = step({ ...open, now: 5 * MIN });
    assert.equal(r.state, 'half_open');
    assert.equal(r.changed, true);
  });

  test('half open: enough good probes close it', () => {
    const half = {
      state: 'half_open',
      openedAt: 0,
      now: 6 * MIN,
      window: { requests: 0, failures: 0 },
    };
    assert.equal(step({ ...half, probes: { ok: 2, failed: 0 } }).state, 'half_open');
    const closed = step({ ...half, probes: { ok: 3, failed: 0 } });
    assert.equal(closed.state, 'closed');
    assert.equal(closed.openedAt, null);
  });

  test('half open: one bad probe opens it again and restarts the cooldown', () => {
    const r = step({
      state: 'half_open',
      openedAt: 0,
      now: 7 * MIN,
      window: { requests: 0, failures: 0 },
      probes: { ok: 2, failed: 1 },
    });
    assert.equal(r.state, 'open');
    assert.equal(r.openedAt, 7 * MIN);
  });

  test('an unknown state is a bug, not something to guess about', () => {
    assert.throws(
      () => step({ state: 'melted', now: 0, window: { requests: 0, failures: 0 } }),
      RangeError,
    );
  });
});

describe('choosing a provider for an engine', () => {
  const engine = {
    code: 'chatgpt',
    primaryProviderCode: 'dataforseo',
    primaryMethod: 'ui_capture',
    fallbackProviderCode: 'openai_api',
    fallbackMethod: 'api_grounded',
  };
  const verdicts = (map) => async (provider) => map[provider] ?? 'allow';

  test('uses the primary when its breaker is closed', async () => {
    assert.deepEqual(await chooseRoute(engine, verdicts({})), {
      provider: 'dataforseo',
      method: 'ui_capture',
      kind: 'primary',
      probe: false,
    });
  });

  test('switches to the fallback when the primary is open', async () => {
    const route = await chooseRoute(engine, verdicts({ dataforseo: 'deny' }));
    assert.deepEqual(route, {
      provider: 'openai_api',
      method: 'api_grounded',
      kind: 'fallback',
      probe: false,
    });
  });

  test('a half-open primary gets the probe request', async () => {
    const route = await chooseRoute(engine, verdicts({ dataforseo: 'probe' }));
    assert.equal(route.provider, 'dataforseo');
    assert.equal(route.probe, true);
  });

  test('both open: no route, so the answer is "couldn’t check"', async () => {
    assert.equal(
      await chooseRoute(engine, verdicts({ dataforseo: 'deny', openai_api: 'deny' })),
      null,
    );
  });

  test('an engine with no fallback and an open primary has no route', async () => {
    const solo = { ...engine, fallbackProviderCode: null, fallbackMethod: null };
    assert.equal(await chooseRoute(solo, verdicts({ dataforseo: 'deny' })), null);
  });

  test('the fallback is not consulted while the primary is fine', async () => {
    const asked = [];
    await chooseRoute(engine, async (provider) => {
      asked.push(provider);
      return 'allow';
    });
    assert.deepEqual(asked, ['dataforseo']);
  });
});
