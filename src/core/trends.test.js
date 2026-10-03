import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { detectChanges, windowsAt } from './trends.js';

const BRAND = '1';
const RIVAL = '2';
const AS_OF = '2026-10-26';

/** One day's rows for an engine: the brand named `bk` times, the rival `rk` times, of `n` answers. */
const day = (metricDate, engineCode, { n, bk, rk = 0, partial = 0, cites = 0, own = 0 }) =>
  [
    [BRAND, bk, own],
    [RIVAL, rk, 0],
  ].map(([entityId, k, citationsEntity]) => ({
    metricDate,
    engineCode,
    entityId,
    cellsPartial: partial,
    nAnswers: n,
    kMentioned: k,
    citationsTotal: cites,
    citationsEntity,
  }));

describe('windowsAt', () => {
  test('two adjacent 28-day windows ending on the date', () => {
    assert.deepEqual(windowsAt('2026-10-26'), {
      after: ['2026-09-29', '2026-10-26'],
      before: ['2026-09-01', '2026-09-28'],
    });
  });
  test('accepts a Date, as the database returns one', () => {
    assert.deepEqual(windowsAt(new Date('2026-10-26T00:00:00Z')), windowsAt('2026-10-26'));
  });
  test('accepts a Date-like string with a time', () => {
    assert.deepEqual(windowsAt('2026-10-26T14:00:00Z'), windowsAt('2026-10-26'));
  });
});

describe('detectChanges', () => {
  // Weekly runs: four in the before window, four in the after window.
  const weeks = (before, after, engine = 'chatgpt') => [
    ...['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28'].flatMap((d) =>
      day(d, engine, before),
    ),
    ...['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'].flatMap((d) =>
      day(d, engine, after),
    ),
  ];

  test('a real rise in the brand mention rate is reported, for the engine and for all engines', () => {
    const rows = weeks({ n: 30, bk: 9 }, { n: 30, bk: 18 });
    const found = detectChanges({ rows, brandId: BRAND, asOf: AS_OF }).filter(
      (e) => e.kind === 'mention_rate_change',
    );
    assert.deepEqual(found.map((e) => e.engineCode).sort(), ['chatgpt', null]);
    const e = found[0];
    assert.equal(e.direction, 'up');
    assert.equal(e.nBefore, 120);
    assert.equal(e.kBefore, 36);
    assert.equal(e.nAfter, 120);
    assert.equal(e.kAfter, 72);
    assert.equal(e.deltaPp, 30);
    assert.ok(e.p < 0.001);
    assert.equal(e.dedupeKey.endsWith(':2026-10-26'), true);
  });

  test('a drop is reported as down', () => {
    const rows = weeks({ n: 30, bk: 18 }, { n: 30, bk: 6 });
    const e = detectChanges({ rows, brandId: BRAND, asOf: AS_OF }).find(
      (x) => x.kind === 'mention_rate_change' && x.engineCode === 'chatgpt',
    );
    assert.equal(e.direction, 'down');
    assert.equal(e.deltaPp, -40);
  });

  test('normal variation says nothing', () => {
    const rows = weeks({ n: 30, bk: 12 }, { n: 30, bk: 13 });
    assert.deepEqual(detectChanges({ rows, brandId: BRAND, asOf: AS_OF }), []);
  });

  test('a project with only one window of history says nothing: not enough data', () => {
    const rows = ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'].flatMap((d) =>
      day(d, 'chatgpt', { n: 30, bk: 18 }),
    );
    assert.deepEqual(detectChanges({ rows, brandId: BRAND, asOf: AS_OF }), []);
  });

  test('a day that did not finish cleanly is left out of both windows for that engine', () => {
    // The newest week collected half of its answers and almost none mention the brand: counted as it stands, that
    // would read as a collapse. It must be left out instead.
    const rows = [
      ...weeks({ n: 30, bk: 12 }, { n: 30, bk: 12 }).filter((r) => r.metricDate !== '2026-10-26'),
      ...day('2026-10-26', 'chatgpt', { n: 5, bk: 0, partial: 4 }),
    ];
    assert.deepEqual(detectChanges({ rows, brandId: BRAND, asOf: AS_OF }), []);
    const counted = detectChanges({
      rows: rows.map((r) => ({ ...r, cellsPartial: 0 })),
      brandId: BRAND,
      asOf: AS_OF,
    });
    assert.deepEqual(counted, [], 'sanity: the half-day alone is too small to move the rate');
  });

  test('a partial engine does not hide a real change on another engine', () => {
    const rows = [
      ...weeks({ n: 30, bk: 9 }, { n: 30, bk: 18 }, 'perplexity'),
      ...weeks({ n: 30, bk: 12 }, { n: 30, bk: 12, partial: 2 }, 'chatgpt'),
    ];
    const kinds = detectChanges({ rows, brandId: BRAND, asOf: AS_OF }).filter(
      (e) => e.kind === 'mention_rate_change',
    );
    assert.ok(kinds.some((e) => e.engineCode === 'perplexity'));
    assert.ok(!kinds.some((e) => e.engineCode === 'chatgpt'));
  });

  test('share of voice moves when the rival takes mentions', () => {
    const rows = weeks({ n: 30, bk: 10, rk: 10 }, { n: 30, bk: 10, rk: 30 });
    const e = detectChanges({ rows, brandId: BRAND, asOf: AS_OF }).find(
      (x) => x.kind === 'sov_change' && x.engineCode === 'chatgpt',
    );
    assert.equal(e.direction, 'down');
    assert.equal(e.valueBefore, 0.5);
    assert.equal(e.valueAfter, 0.25);
  });

  test('a competitor surge is reported only for a rise', () => {
    const up = detectChanges({
      rows: weeks({ n: 30, bk: 12, rk: 6 }, { n: 30, bk: 12, rk: 20 }),
      brandId: BRAND,
      asOf: AS_OF,
    }).filter((e) => e.kind === 'competitor_surge');
    assert.deepEqual(
      up.map((e) => [e.entityId, e.engineCode]).sort(),
      [
        [RIVAL, null],
        [RIVAL, 'chatgpt'],
      ].sort(),
    );
    const down = detectChanges({
      rows: weeks({ n: 30, bk: 12, rk: 20 }, { n: 30, bk: 12, rk: 6 }),
      brandId: BRAND,
      asOf: AS_OF,
    }).filter((e) => e.kind === 'competitor_surge');
    assert.deepEqual(down, []);
  });

  test('citation share reads the engine total once, not once per entity', () => {
    const rows = weeks({ n: 30, bk: 12, cites: 40, own: 4 }, { n: 30, bk: 12, cites: 40, own: 16 });
    const e = detectChanges({ rows, brandId: BRAND, asOf: AS_OF }).find(
      (x) => x.kind === 'citation_share_change' && x.engineCode === 'chatgpt',
    );
    assert.equal(e.nBefore, 160);
    assert.equal(e.kBefore, 16);
    assert.equal(e.kAfter, 64);
    assert.equal(e.direction, 'up');
  });

  test('the same data gives the same events and keys (alerts are never sent twice)', () => {
    const rows = weeks({ n: 30, bk: 9 }, { n: 30, bk: 18 });
    const a = detectChanges({ rows, brandId: BRAND, asOf: AS_OF });
    const b = detectChanges({ rows: [...rows].reverse(), brandId: BRAND, asOf: AS_OF });
    assert.deepEqual(a.map((e) => e.dedupeKey).sort(), b.map((e) => e.dedupeKey).sort());
    assert.equal(new Set(a.map((e) => e.dedupeKey)).size, a.length);
  });
});
