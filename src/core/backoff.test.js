import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { backoffDelayMs, RETRY_POLICY } from './backoff.js';

const POLICY = { baseMs: 5_000, capMs: 600_000 };

describe('retry backoff', () => {
  test('the policy is five attempts, as MVP §7.8 says', () => {
    assert.equal(RETRY_POLICY.attempts, 5);
  });

  test('the ceiling doubles with every failure', () => {
    const atMax = [1, 2, 3, 4, 5].map((n) => backoffDelayMs(n, POLICY, () => 1));
    assert.deepEqual(atMax, [5_000, 10_000, 20_000, 40_000, 80_000]);
  });

  test('the wait is between half the ceiling and the ceiling', () => {
    assert.equal(
      backoffDelayMs(3, POLICY, () => 0),
      10_000,
    );
    assert.equal(
      backoffDelayMs(3, POLICY, () => 1),
      20_000,
    );
    assert.equal(
      backoffDelayMs(3, POLICY, () => 0.5),
      15_000,
    );
  });

  test('never exceeds the cap, however many failures', () => {
    assert.equal(
      backoffDelayMs(30, POLICY, () => 1),
      600_000,
    );
    assert.equal(
      backoffDelayMs(1000, POLICY, () => 1),
      600_000,
    );
  });

  test('jitter spreads a burst: a hundred jobs failing together do not retry together', () => {
    let s = 3;
    const random = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
    const delays = new Set(Array.from({ length: 100 }, () => backoffDelayMs(4, POLICY, random)));
    assert.ok(delays.size > 90, `only ${delays.size} different delays`);
    for (const d of delays) assert.ok(d >= 20_000 && d <= 40_000);
  });

  test('treats a first-time or nonsense attempt count as the first failure', () => {
    assert.equal(
      backoffDelayMs(0, POLICY, () => 1),
      5_000,
    );
    assert.equal(
      backoffDelayMs(-4, POLICY, () => 1),
      5_000,
    );
  });
});
