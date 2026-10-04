import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  afterWindow,
  baselineWindow,
  countWindow,
  dayBounds,
  HORIZONS,
  horizonDue,
  measureOutcome,
  nextDueHorizon,
  proofSentence,
  statusAfterOutcome,
} from './outcomes.js';

describe('windows', () => {
  const iso = (w) => ({ from: w.from.toISOString(), to: w.to.toISOString() });

  test('the baseline is the 28 days up to the moment the fix was marked done', () => {
    assert.deepEqual(iso(baselineWindow('2026-10-03T15:30:00Z')), {
      from: '2026-09-05T15:30:00.000Z',
      to: '2026-10-03T15:30:00.000Z',
    });
  });

  test('the after window starts when measuring started and runs 14 or 28 days', () => {
    assert.deepEqual(iso(afterWindow('2026-10-03T15:30:00Z', 'week_2')), {
      from: '2026-10-03T15:30:00.000Z',
      to: '2026-10-17T15:30:00.000Z',
    });
    assert.equal(
      afterWindow('2026-10-03T15:30:00Z', 'week_4').to.toISOString(),
      '2026-10-31T15:30:00.000Z',
    );
    assert.throws(() => afterWindow('2026-10-03', 'week_9'), RangeError);
    assert.equal(HORIZONS.week_2.days, 14);
  });

  test('the days a window touches, for a date-range query', () => {
    assert.deepEqual(dayBounds(baselineWindow('2026-10-03T15:30:00Z')), [
      '2026-09-05',
      '2026-10-03',
    ]);
  });

  test('a check is due only once its whole window is in the past', () => {
    const start = '2026-10-03T15:30:00Z';
    assert.equal(horizonDue(start, 'week_2', new Date('2026-10-17T15:29:59Z')), false);
    assert.equal(horizonDue(start, 'week_2', new Date('2026-10-17T15:30:00Z')), true);
    assert.equal(horizonDue(start, 'week_4', new Date('2026-10-18T00:00:00Z')), false);
    assert.equal(horizonDue(start, 'week_4', new Date('2026-10-31T15:30:00Z')), true);
  });

  test('the first horizon without an outcome that is due', () => {
    const startedAt = '2026-10-03T00:00:00Z';
    const nowAt = (d) => new Date(`${d}T12:00:00Z`);
    assert.equal(nextDueHorizon({ startedAt, have: [], now: nowAt('2026-10-10') }), null);
    assert.equal(nextDueHorizon({ startedAt, have: [], now: nowAt('2026-10-20') }), 'week_2');
    assert.equal(nextDueHorizon({ startedAt, have: ['week_2'], now: nowAt('2026-10-20') }), null);
    assert.equal(
      nextDueHorizon({ startedAt, have: ['week_2'], now: nowAt('2026-11-02') }),
      'week_4',
    );
    assert.equal(
      nextDueHorizon({ startedAt, have: ['week_2', 'week_4'], now: nowAt('2026-12-01') }),
      null,
    );
  });
});

describe('counting a window', () => {
  const window = baselineWindow('2026-10-03T12:00:00Z');
  const cells = [
    {
      promptId: '1',
      runId: '10',
      queuedAt: '2026-09-20T06:00:00Z',
      status: 'complete',
      nOk: 10,
      brandK: 1,
    },
    {
      promptId: '2',
      runId: '10',
      queuedAt: '2026-09-20T06:00:00Z',
      status: 'complete',
      nOk: 10,
      brandK: 2,
    },
    {
      promptId: '3',
      runId: '10',
      queuedAt: '2026-09-20T06:00:00Z',
      status: 'complete',
      nOk: 10,
      brandK: 9,
    }, // not targeted
    {
      promptId: '1',
      runId: '11',
      queuedAt: '2026-09-27T06:00:00Z',
      status: 'partial',
      nOk: 4,
      brandK: 0,
    }, // half a cell
    {
      promptId: '1',
      runId: '12',
      queuedAt: '2026-08-01T06:00:00Z',
      status: 'complete',
      nOk: 10,
      brandK: 5,
    }, // too old
    {
      promptId: '1',
      runId: '13',
      queuedAt: '2026-10-03T12:00:01Z',
      status: 'complete',
      nOk: 10,
      brandK: 5,
    }, // after the fix
  ];

  test('adds up complete cells of the targeted questions inside the window', () => {
    const r = countWindow({ cells, promptIds: ['1', '2'], window });
    assert.equal(r.n, 20);
    assert.equal(r.k, 3);
    assert.deepEqual(r.runIds, ['10']);
    assert.deepEqual(r.perPrompt, [
      { promptId: '1', n: 10, k: 1 },
      { promptId: '2', n: 10, k: 2 },
    ]);
  });

  test('a run queued before the fix on the same day is in the baseline; one queued after is not', () => {
    const sameDay = [
      {
        promptId: '1',
        runId: '20',
        queuedAt: '2026-10-03T09:00:00Z',
        status: 'complete',
        nOk: 10,
        brandK: 1,
      },
      {
        promptId: '1',
        runId: '21',
        queuedAt: '2026-10-03T15:00:00Z',
        status: 'complete',
        nOk: 10,
        brandK: 9,
      },
    ];
    const r = countWindow({ cells: sameDay, promptIds: ['1'], window });
    assert.deepEqual([r.n, r.k, r.runIds], [10, 1, ['20']]);
    // and the after window starts where the baseline ends
    const after = countWindow({
      cells: sameDay,
      promptIds: ['1'],
      window: afterWindow('2026-10-03T12:00:00Z', 'week_2'),
    });
    assert.deepEqual([after.n, after.k, after.runIds], [10, 9, ['21']]);
  });

  test('a partial cell is left out and counted, never added as "not mentioned"', () => {
    const r = countWindow({ cells, promptIds: ['1'], window });
    assert.equal(r.n, 10); // the partial cell's 4 answers are not in n
    assert.equal(r.partialCells, 1);
  });

  test('an empty window is zero answers, not an error', () => {
    const r = countWindow({ cells: [], promptIds: ['1'], window });
    assert.deepEqual([r.n, r.k, r.runIds, r.perPrompt], [0, 0, [], []]);
  });
});

describe('the verdict', () => {
  // 3 questions × 4 engines × 10 samples = 120 answers a run; the numbers below are chosen by hand.
  test('1 of 9 → 5 of 9 is too few answers to say: it is not a win', () => {
    const r = measureOutcome({ baseline: { n: 9, k: 1 }, after: { n: 9, k: 5 } });
    assert.equal(r.verdict, 'insufficient_data');
    assert.equal(r.deltaPp, null);
  });

  test('a significant rise is a proven win', () => {
    // 10 of 120 (8.3%) → 40 of 120 (33.3%): +25 points, z ≈ 5.3
    const r = measureOutcome({ baseline: { n: 120, k: 10 }, after: { n: 120, k: 40 } });
    assert.equal(r.verdict, 'proven_win');
    assert.equal(r.significant, true);
    assert.equal(r.deltaPp, 25);
    assert.ok(r.p < 0.001);
  });

  test('a significant fall is a decline', () => {
    const r = measureOutcome({ baseline: { n: 120, k: 40 }, after: { n: 120, k: 10 } });
    assert.equal(r.verdict, 'declined');
  });

  test('a small move is within normal variation', () => {
    // 40 of 120 → 44 of 120: +3.3 points, under the 5-point bar
    const r = measureOutcome({ baseline: { n: 120, k: 40 }, after: { n: 120, k: 44 } });
    assert.equal(r.verdict, 'no_change');
    assert.equal(r.significant, false);
  });

  test('a big move on few answers is "not enough data", not a win', () => {
    const r = measureOutcome({ baseline: { n: 19, k: 1 }, after: { n: 120, k: 80 } });
    assert.equal(r.verdict, 'insufficient_data');
  });

  test('a baseline with no answers is not enough data either', () => {
    const r = measureOutcome({ baseline: { n: 0, k: 0 }, after: { n: 120, k: 80 } });
    assert.equal(r.verdict, 'insufficient_data');
    assert.equal(r.rateBefore, null);
  });
});

describe('what a check does to the recommendation', () => {
  test('a win or a decline closes it at either horizon', () => {
    for (const horizon of ['week_2', 'week_4']) {
      assert.equal(statusAfterOutcome('proven_win', horizon), 'proven_win');
      assert.equal(statusAfterOutcome('declined', horizon), 'declined');
    }
  });

  test('no change and not enough data wait for four weeks, then end as no change', () => {
    for (const verdict of ['no_change', 'insufficient_data']) {
      assert.equal(statusAfterOutcome(verdict, 'week_2'), null);
      assert.equal(statusAfterOutcome(verdict, 'week_4'), 'no_change');
    }
  });
});

describe('the proof sentence', () => {
  const context = {
    title: 'Add Organization schema to your homepage',
    startedAt: '2026-10-03T09:00:00Z',
    questions: 3,
    brandName: 'Data Dental',
  };
  const outcome = (verdict, horizon = 'week_2') => ({
    horizon,
    verdict,
    kBefore: 10,
    nBefore: 120,
    kAfter: 40,
    nAfter: 118,
  });

  test('a win states the counts from the outcome row and no others', () => {
    const text = proofSentence(outcome('proven_win'), context);
    assert.match(
      text,
      /Since you marked “Add Organization schema to your homepage” done on October 3, 2026/,
    );
    assert.match(text, /3 questions/);
    assert.match(text, /from 10 of 120 to 40 of 118 answers/);
    assert.match(text, /bigger than normal variation/);
  });

  test('no change at two weeks says answers take time; at four weeks it says no effect yet', () => {
    assert.match(proofSentence(outcome('no_change'), context), /2–6 weeks/);
    assert.match(
      proofSentence(outcome('no_change', 'week_4'), context),
      /has not shown an effect yet/,
    );
  });

  test('a decline and missing data are said plainly', () => {
    assert.match(
      proofSentence(outcome('declined'), context),
      /drop is bigger than normal variation/,
    );
    assert.match(
      proofSentence(outcome('insufficient_data'), context),
      /at least 20 .* have 120 and 118/,
    );
  });

  test('one question reads as one question', () => {
    assert.match(
      proofSentence(outcome('proven_win'), { ...context, questions: 1 }),
      /1 question it targets/,
    );
  });
});
