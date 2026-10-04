import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  calibratedConfidence,
  CONFIDENCE_BOUNDS,
  effortLabel,
  iceScore,
  impactScore,
  PRIOR_WEIGHT,
} from './ice.js';

describe('impact', () => {
  // Three questions: priority 3, 2 and 1, each tracked on 4 engines. The whole grid weighs 3×4 + 2×4 + 1×4 = 24.
  const universe = [
    { priority: 3, engines: 4 },
    { priority: 2, engines: 4 },
    { priority: 1, engines: 4 },
  ];

  test('a fix that touches everything is 100, at full severity', () => {
    assert.equal(impactScore({ affected: universe, universe }), 100);
  });

  test('one question on one engine is its share of the weighted grid', () => {
    // priority 3 × 1 engine = 3 of 24 = 12.5
    assert.equal(impactScore({ affected: [{ priority: 3, engines: 1 }], universe }), 12.5);
  });

  test('severity scales it: a check that lost 3 of 8 points is 0.375 of the problem', () => {
    // all of the grid × 0.375 = 37.5
    assert.equal(impactScore({ affected: universe, universe, severity: 0.375 }), 37.5);
  });

  test('nothing tracked is 0, never a division by zero', () => {
    assert.equal(impactScore({ affected: universe, universe: [] }), 0);
    assert.equal(impactScore({ affected: [], universe }), 0);
  });

  test('it never goes past 100 even if a fix names more than the universe', () => {
    assert.equal(
      impactScore({
        affected: [{ priority: 3, engines: 40 }],
        universe: [{ priority: 3, engines: 4 }],
      }),
      100,
    );
  });

  test('rejects nonsense', () => {
    assert.throws(() => impactScore({ affected: universe, universe, severity: 1.5 }), RangeError);
    assert.throws(
      () => impactScore({ affected: [{ priority: -1, engines: 1 }], universe }),
      RangeError,
    );
  });
});

describe('confidence', () => {
  test('with no outcomes it is the prior', () => {
    assert.equal(calibratedConfidence(0.5), 0.5);
    assert.equal(calibratedConfidence(0.7, { wins: 0, decided: 0 }), 0.7);
  });

  test('outcomes pull it towards the observed win rate, slowly', () => {
    // prior 0.5 worth 10; 10 wins of 10 → (5 + 10) / 20 = 0.75
    assert.equal(calibratedConfidence(0.5, { wins: 10, decided: 10 }), 0.75);
    // 0 wins of 10 → 5 / 20 = 0.25
    assert.equal(calibratedConfidence(0.5, { wins: 0, decided: 10 }), 0.25);
    assert.equal(PRIOR_WEIGHT, 10);
  });

  test('it stays inside the bounds however many outcomes there are', () => {
    assert.equal(
      calibratedConfidence(0.5, { wins: 100000, decided: 100000 }) <= CONFIDENCE_BOUNDS.max,
      true,
    );
    assert.equal(
      calibratedConfidence(0.5, { wins: 0, decided: 100000 }) >= CONFIDENCE_BOUNDS.min,
      true,
    );
    assert.equal(calibratedConfidence(0, { wins: 0, decided: 0 }), CONFIDENCE_BOUNDS.min);
  });

  test('rejects impossible counts', () => {
    assert.throws(() => calibratedConfidence(0.5, { wins: 3, decided: 2 }), RangeError);
    assert.throws(() => calibratedConfidence(1.5), RangeError);
  });
});

describe('ICE', () => {
  test('impact × confidence ÷ effort, to three decimals', () => {
    assert.equal(iceScore({ impact: 60, confidence: 0.5, effort: 3 }), 10);
    assert.equal(iceScore({ impact: 100, confidence: 0.7, effort: 1 }), 70);
    assert.equal(iceScore({ impact: 12.5, confidence: 0.3, effort: 5 }), 0.75);
    assert.equal(iceScore({ impact: 33.333, confidence: 0.5, effort: 3 }), 5.555);
  });

  test('an easy small fix can outrank a hard big one', () => {
    const easy = iceScore({ impact: 40, confidence: 0.5, effort: 1 }); // 20
    const hard = iceScore({ impact: 60, confidence: 0.5, effort: 5 }); // 6
    assert.ok(easy > hard);
  });

  test('effort is a whole number from 1 to 5', () => {
    for (const effort of [0, 6, 2.5]) {
      assert.throws(() => iceScore({ impact: 1, confidence: 0.5, effort }), RangeError);
    }
  });

  test('effort words', () => {
    assert.deepEqual([1, 2, 3, 4, 5].map(effortLabel), ['Low', 'Low', 'Medium', 'High', 'High']);
  });
});
