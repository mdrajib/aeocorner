import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { byUrgency, capRow, parseCap } from './spend-cap.js';

describe('parseCap', () => {
  test('a blank box (or the word default) takes the own cap away', () => {
    assert.deepEqual(parseCap(''), { ok: true, capUsd: null });
    assert.deepEqual(parseCap('  '), { ok: true, capUsd: null });
    assert.deepEqual(parseCap('Default'), { ok: true, capUsd: null });
    assert.deepEqual(parseCap(undefined), { ok: true, capUsd: null });
  });

  test('dollars become the two-decimal form the column takes', () => {
    assert.deepEqual(parseCap('25'), { ok: true, capUsd: '25.00' });
    assert.deepEqual(parseCap('$25.5'), { ok: true, capUsd: '25.50' });
    assert.deepEqual(parseCap('10000'), { ok: true, capUsd: '10000.00' });
  });

  test('anything that is not a plain amount inside the limits is refused with a reason', () => {
    for (const bad of ['-5', '1,000', '12.345', 'abc', '0', '0.5', '10001', '1e3', '99999999']) {
      const r = parseCap(bad);
      assert.equal(r.ok, false, bad);
      assert.ok(r.reason.length > 10);
    }
    assert.equal(parseCap(25).ok, true, 'a number typed by a script is read as its text');
  });
});

describe('capRow', () => {
  const now = new Date('2026-10-04T12:00:00Z');
  test('follows the plan until the organization has its own cap', () => {
    const plan = capRow({
      orgCapUsd: null,
      planCode: 'growth',
      spentMicros: 0,
      pausedUntil: null,
      now,
    });
    assert.equal(plan.capText, '$45.00');
    assert.equal(plan.capSource, 'plan');
    assert.equal(plan.capInput, '');
    const own = capRow({
      orgCapUsd: '100.00',
      planCode: 'growth',
      spentMicros: 0,
      pausedUntil: null,
      now,
    });
    assert.equal(own.capText, '$100.00');
    assert.equal(own.capSource, 'own');
    assert.equal(own.capInput, '100.00');
  });

  test('says how close to the cap and whether collection is paused', () => {
    const near = capRow({
      orgCapUsd: '10.00',
      planCode: null,
      spentMicros: 8_500_000,
      pausedUntil: null,
      now,
    });
    assert.equal(near.state, 'near');
    assert.equal(near.percent, 85);
    const paused = capRow({
      orgCapUsd: '10.00',
      planCode: null,
      spentMicros: 10_000_000,
      pausedUntil: new Date('2026-10-05T00:00:00Z'),
      now,
    });
    assert.equal(paused.state, 'paused');
    assert.equal(paused.percent, 100);
    const lapsed = capRow({
      orgCapUsd: '10.00',
      planCode: null,
      spentMicros: 1,
      pausedUntil: new Date('2026-10-04T00:00:00Z'),
      now,
    });
    assert.equal(lapsed.paused, false, 'a pause that has ended is not shown as one');
  });
});

describe('byUrgency', () => {
  test('paused first, then closest to the cap', () => {
    const rows = [
      { id: 'a', state: 'ok', percent: 10, spentMicros: 5 },
      { id: 'b', state: 'paused', percent: 100, spentMicros: 1 },
      { id: 'c', state: 'near', percent: 90, spentMicros: 1 },
      { id: 'd', state: 'near', percent: 95, spentMicros: 1 },
    ];
    assert.deepEqual(
      byUrgency(rows).map((r) => r.id),
      ['b', 'd', 'c', 'a'],
    );
  });
});
