import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  dailyCapMicros,
  DEFAULT_DAILY_CAP_USD,
  evaluateSpend,
  fromMicros,
  nextResetAt,
  PLAN_DAILY_CAP_USD,
  toMicros,
  utcDayStart,
} from './spend.js';

const at = (iso) => new Date(iso);
const CAP = toMicros('15.00');

describe('money in micro-dollars', () => {
  test('converts exactly, with no floating-point drift', () => {
    assert.equal(toMicros('0.012345'), 12_345);
    assert.equal(toMicros(0.1) + toMicros(0.2), toMicros(0.3)); // 0.1 + 0.2 !== 0.3 in floating point
    assert.equal(toMicros('15'), 15_000_000);
    assert.equal(toMicros('0.0000009'), 0, 'finer than a micro-dollar is dropped, not rounded up');
    assert.equal(toMicros(null), 0);
    assert.equal(fromMicros(12_345), '0.012345');
    assert.equal(fromMicros(15_000_000), '15.000000');
    assert.equal(fromMicros(toMicros('123.456789')), '123.456789');
  });

  test('adding 100,000 sub-cent costs lands on the exact total', () => {
    let total = 0;
    for (let i = 0; i < 100_000; i += 1) total += toMicros('0.000123');
    assert.equal(fromMicros(total), '12.300000');
  });

  test('refuses text that is not money', () => {
    assert.throws(() => toMicros('twelve'), RangeError);
    assert.throws(() => toMicros('1e3'), RangeError);
  });
});

describe('the spend-cap day', () => {
  test('is the UTC day, and resets at the next UTC midnight', () => {
    const now = at('2026-10-02T23:59:59.999Z');
    assert.equal(utcDayStart(now).toISOString(), '2026-10-02T00:00:00.000Z');
    assert.equal(nextResetAt(now).toISOString(), '2026-10-03T00:00:00.000Z');
    assert.equal(
      nextResetAt(at('2026-10-03T00:00:00.000Z')).toISOString(),
      '2026-10-04T00:00:00.000Z',
    );
  });
});

describe('the cap in force', () => {
  test('an organization’s own cap wins over its plan', () => {
    assert.equal(dailyCapMicros({ orgCapUsd: '200.00', planCode: 'starter' }), toMicros(200));
    assert.equal(
      dailyCapMicros({ orgCapUsd: '0.00', planCode: 'agency' }),
      0,
      'a cap of zero means no spend',
    );
  });

  test('otherwise the plan’s, otherwise the smallest', () => {
    assert.equal(
      dailyCapMicros({ orgCapUsd: null, planCode: 'growth' }),
      toMicros(PLAN_DAILY_CAP_USD.growth),
    );
    assert.equal(
      dailyCapMicros({ orgCapUsd: null, planCode: null }),
      toMicros(DEFAULT_DAILY_CAP_USD),
    );
    assert.equal(
      dailyCapMicros({ orgCapUsd: undefined, planCode: 'unknown-plan' }),
      toMicros(DEFAULT_DAILY_CAP_USD),
    );
  });

  test('bigger plans never get a smaller cap', () => {
    assert.ok(PLAN_DAILY_CAP_USD.starter <= PLAN_DAILY_CAP_USD.growth);
    assert.ok(PLAN_DAILY_CAP_USD.growth <= PLAN_DAILY_CAP_USD.agency);
  });
});

describe('spend guard decisions', () => {
  const noon = at('2026-10-02T12:00:00Z');
  const decide = (spentUsd, pausedUntil = null, now = noon, capMicros = CAP) =>
    evaluateSpend({ spentMicros: toMicros(spentUsd), capMicros, pausedUntil, now });

  test('under the cap: nothing to do', () => {
    assert.deepEqual(decide('14.999999'), { action: 'none', until: null });
  });

  test('reaching the cap pauses collection until the next UTC midnight', () => {
    const d = decide('15.00');
    assert.equal(d.action, 'pause');
    assert.equal(d.until.toISOString(), '2026-10-03T00:00:00.000Z');
    assert.equal(decide('90.00').action, 'pause');
  });

  test('already paused and still over: leave it alone (no repeat pause, no repeat alert)', () => {
    const until = at('2026-10-03T00:00:00Z');
    assert.deepEqual(decide('20.00', until), { action: 'none', until });
  });

  test('the day rolls over: spend is back to zero, so collection resumes', () => {
    const until = at('2026-10-03T00:00:00Z');
    const nextMorning = at('2026-10-03T00:15:00Z'); // the 15-minute guard runs
    assert.deepEqual(decide('0.00', until, nextMorning), { action: 'resume', until: null });
  });

  test('raising the cap resumes collection immediately', () => {
    const until = at('2026-10-03T00:00:00Z');
    const raised = toMicros('50.00');
    assert.deepEqual(decide('20.00', until, noon, raised), { action: 'resume', until: null });
  });

  test('a pause that already expired but spend is over again today pauses afresh', () => {
    const stale = at('2026-10-02T00:00:00Z');
    const d = decide('16.00', stale);
    assert.equal(d.action, 'pause');
    assert.equal(d.until.toISOString(), '2026-10-03T00:00:00.000Z');
  });

  test('a stale pause with spend under the cap is cleared', () => {
    assert.equal(decide('1.00', at('2026-10-01T00:00:00Z')).action, 'resume');
  });

  test('a cap of zero pauses at once', () => {
    assert.equal(decide('0.00', null, noon, 0).action, 'pause');
  });
});
