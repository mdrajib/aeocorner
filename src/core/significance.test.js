import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  compareWindows,
  normalCdf,
  SIGNIFICANCE,
  twoProportionZ,
  VERDICT_LABELS,
  wilsonInterval,
} from './significance.js';

const near = (actual, expected, tolerance, label) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label ?? ''} expected ${expected} ± ${tolerance}, got ${actual}`,
  );

describe('normalCdf', () => {
  test('matches the standard normal table', () => {
    near(normalCdf(0), 0.5, 1e-7);
    near(normalCdf(1), 0.8413447, 2e-7);
    near(normalCdf(1.96), 0.9750021, 2e-7);
    near(normalCdf(-1.96), 0.0249979, 2e-7);
    near(normalCdf(2.5758), 0.995, 1e-5);
    near(normalCdf(-3), 0.0013499, 2e-7);
  });
  test('stays between 0 and 1 far out', () => {
    assert.ok(normalCdf(40) <= 1 && normalCdf(40) > 0.999999);
    assert.ok(normalCdf(-40) >= 0 && normalCdf(-40) < 1e-6);
  });
});

describe('wilsonInterval', () => {
  test('matches hand-computed intervals', () => {
    const a = wilsonInterval({ k: 8, n: 10 });
    near(a.rate, 0.8, 1e-12);
    near(a.low, 0.4902, 2e-4);
    near(a.high, 0.9433, 2e-4);
    const b = wilsonInterval({ k: 0, n: 20 });
    assert.equal(b.low, 0);
    near(b.high, 0.1611, 2e-4);
    const c = wilsonInterval({ k: 50, n: 100 });
    near(c.low, 0.4038, 2e-4);
    near(c.high, 0.5962, 2e-4);
  });
  test('has no band when nothing was read', () => {
    assert.deepEqual(wilsonInterval({ k: 0, n: 0 }), { rate: null, low: null, high: null });
  });
  test('stays inside 0 to 1 at the edges', () => {
    const all = wilsonInterval({ k: 30, n: 30 });
    assert.ok(all.high <= 1 && all.low > 0.85);
  });
  test('refuses impossible counts', () => {
    assert.throws(() => wilsonInterval({ k: 5, n: 4 }), RangeError);
    assert.throws(() => wilsonInterval({ k: -1, n: 4 }), RangeError);
    assert.throws(() => wilsonInterval({ k: 1.5, n: 4 }), RangeError);
  });
});

describe('twoProportionZ', () => {
  test('matches hand-computed z and p', () => {
    const a = twoProportionZ({ k: 50, n: 100 }, { k: 65, n: 100 });
    near(a.z, 2.1455, 1e-3);
    near(a.p, 0.03193, 1e-4);
    const b = twoProportionZ({ k: 40, n: 100 }, { k: 55, n: 100 });
    near(b.z, 2.124, 1e-3);
    near(b.p, 0.03365, 1e-4);
  });
  test('is symmetric apart from the sign', () => {
    const up = twoProportionZ({ k: 30, n: 120 }, { k: 50, n: 120 });
    const down = twoProportionZ({ k: 50, n: 120 }, { k: 30, n: 120 });
    near(up.z, -down.z, 1e-12);
    near(up.p, down.p, 1e-12);
  });
  test('equal rates, or no spread at all, give p = 1', () => {
    assert.deepEqual(twoProportionZ({ k: 10, n: 40 }, { k: 10, n: 40 }), { z: 0, p: 1 });
    assert.deepEqual(twoProportionZ({ k: 0, n: 40 }, { k: 0, n: 40 }), { z: 0, p: 1 });
    assert.deepEqual(twoProportionZ({ k: 40, n: 40 }, { k: 40, n: 40 }), { z: 0, p: 1 });
  });
  test('an empty window cannot be compared', () => {
    assert.deepEqual(twoProportionZ({ k: 0, n: 0 }, { k: 5, n: 10 }), { z: 0, p: 1 });
  });
});

describe('compareWindows', () => {
  test('a large, well-measured rise is significant and up', () => {
    const r = compareWindows({ k: 50, n: 100 }, { k: 65, n: 100 });
    assert.equal(r.verdict, 'significant_up');
    assert.equal(r.significant, true);
    assert.equal(r.direction, 'up');
    assert.equal(r.deltaPp, 15);
    near(r.p, 0.0319, 1e-3);
  });
  test('a large fall is significant and down', () => {
    const r = compareWindows({ k: 65, n: 100 }, { k: 50, n: 100 });
    assert.equal(r.verdict, 'significant_down');
    assert.equal(r.deltaPp, -15);
  });
  test('a small gap with a tiny p is still within variation: it must also be 5 points', () => {
    // 50.0% -> 52.0% over 20,000 answers each: p is far below 0.05 but the move is 2 points.
    const r = compareWindows({ k: 10000, n: 20000 }, { k: 10400, n: 20000 });
    assert.ok(r.p < 0.001);
    assert.equal(r.verdict, 'within_variation');
    assert.equal(r.significant, false);
    assert.equal(r.direction, null);
  });
  test('a 10-point gap on few answers is within variation: p is not low enough', () => {
    const r = compareWindows({ k: 10, n: 40 }, { k: 14, n: 40 });
    assert.equal(r.deltaPp, 10);
    assert.ok(r.p > 0.05);
    assert.equal(r.verdict, 'within_variation');
  });
  test('exactly 5 points counts as large enough; 4.99 does not', () => {
    const five = compareWindows({ k: 5000, n: 10000 }, { k: 5500, n: 10000 });
    assert.equal(five.deltaPp, 5);
    assert.equal(five.significant, true);
    const less = compareWindows({ k: 5000, n: 10000 }, { k: 5499, n: 10000 });
    assert.equal(less.significant, false);
  });
  test('too few answers is its own verdict, not "no change"', () => {
    const r = compareWindows({ k: 3, n: 10 }, { k: 8, n: 10 });
    assert.equal(r.verdict, 'not_enough_data');
    assert.equal(r.significant, false);
    assert.equal(r.deltaPp, null);
    assert.equal(r.p, null);
    assert.equal(r.valueBefore, 0.3);
  });
  test('an empty window is not enough data and has no rate', () => {
    const r = compareWindows({ k: 0, n: 0 }, { k: 8, n: 30 });
    assert.equal(r.verdict, 'not_enough_data');
    assert.equal(r.valueBefore, null);
  });
  test('the minimum is checked per window, and can be changed by the caller', () => {
    const low = { k: 10, n: SIGNIFICANCE.minAnswers - 1 };
    const fine = { k: 12, n: 60 };
    assert.equal(compareWindows(low, fine).verdict, 'not_enough_data');
    assert.notEqual(compareWindows(low, fine, { minAnswers: 5 }).verdict, 'not_enough_data');
  });
  test('every verdict has words for a screen', () => {
    for (const v of ['not_enough_data', 'within_variation', 'significant_up', 'significant_down']) {
      assert.ok(VERDICT_LABELS[v]);
    }
  });
});
