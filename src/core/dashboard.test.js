import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  byEngine,
  citationRows,
  competitorTable,
  describeChange,
  headline,
  incompleteNotice,
  matrixCell,
  rangeKey,
  staleNotice,
  trendSeries,
  winRate,
} from './dashboard.js';

/**
 * Every figure here is worked out by hand in the comments, so a change to a formula has to change a number you can
 * check with a pencil (Milestone 5 Definition of Done: "score and share of voice match hand-computed fixtures").
 */
const BRAND = '1';
const RIVAL = '2';
const AS_OF = '2026-10-03'; // this window: 2026-09-06..2026-10-03; the one before: 2026-08-09..2026-09-05

const row = (over) => ({
  metricDate: '2026-09-20',
  engineCode: 'chatgpt',
  entityId: BRAND,
  cellsTotal: 5,
  cellsPartial: 0,
  nAnswers: 0,
  kMentioned: 0,
  kRecommended: 0,
  kCited: 0,
  rankSum: 0,
  rankN: 0,
  sentimentSum: 0,
  sentimentN: 0,
  citationsTotal: 0,
  citationsEntity: 0,
  visWeightedSum: null,
  visWeightTotal: null,
  ...over,
});

// Brand rows in this window. Gemini's 10-01 checks all failed: no readable answers, 5 of 5 cells partial.
//   chatgpt 09-20  n10 k4  rec2  rank 6/3   sentiment 3/4  citations 5 of 20  vis 3.0/5
//   gemini  09-20  n10 k1                                   citations 0 of 10  vis 0.5/5
//   chatgpt 10-01  n10 k6  rec3  rank 3/2   sentiment 5/6  citations 10 of 20 vis 4.0/5
//   gemini  10-01  n0  k0   (failed)                                           vis none
function thisWindow() {
  return [
    row({
      nAnswers: 10,
      kMentioned: 4,
      kRecommended: 2,
      rankSum: 6,
      rankN: 3,
      sentimentSum: 3,
      sentimentN: 4,
      citationsTotal: 20,
      citationsEntity: 5,
      visWeightedSum: 3,
      visWeightTotal: 5,
    }),
    row({
      engineCode: 'gemini',
      nAnswers: 10,
      kMentioned: 1,
      citationsTotal: 10,
      citationsEntity: 0,
      visWeightedSum: 0.5,
      visWeightTotal: 5,
    }),
    row({
      metricDate: '2026-10-01',
      nAnswers: 10,
      kMentioned: 6,
      kRecommended: 3,
      rankSum: 3,
      rankN: 2,
      sentimentSum: 5,
      sentimentN: 6,
      citationsTotal: 20,
      citationsEntity: 10,
      visWeightedSum: 4,
      visWeightTotal: 5,
    }),
    row({ metricDate: '2026-10-01', engineCode: 'gemini', cellsPartial: 5 }),
    // The rival, same days: 6 + 3 + 4 = 13 mentions.
    row({ entityId: RIVAL, nAnswers: 10, kMentioned: 6, rankSum: 9, rankN: 3 }),
    row({ entityId: RIVAL, engineCode: 'gemini', nAnswers: 10, kMentioned: 3 }),
    row({ entityId: RIVAL, metricDate: '2026-10-01', nAnswers: 10, kMentioned: 4 }),
    row({ entityId: RIVAL, metricDate: '2026-10-01', engineCode: 'gemini', cellsPartial: 5 }),
  ];
}
const before = (brandK) => [
  row({ metricDate: '2026-09-01', nAnswers: 10, kMentioned: brandK }),
  row({ metricDate: '2026-09-01', engineCode: 'gemini', nAnswers: 10, kMentioned: 0 }),
  row({ metricDate: '2026-09-01', entityId: RIVAL, nAnswers: 10, kMentioned: 5 }),
];

describe('headline', () => {
  const h = headline({ rows: [...before(3), ...thisWindow()], brandId: BRAND, asOf: AS_OF });

  test('windows are the last 28 days and the 28 before', () => {
    assert.deepEqual(h.windows.after, ['2026-09-06', '2026-10-03']);
    assert.deepEqual(h.windows.before, ['2026-08-09', '2026-09-05']);
    assert.equal(h.hasData, true);
  });

  test('mention rate is Σk / Σn: 11 of 30 = 37%, with a Wilson range', () => {
    const t = h.tiles.mentionRate;
    assert.equal(t.state, 'ok');
    assert.equal(t.n, 30);
    assert.equal(t.k, 11);
    assert.equal(t.display, '37%');
    assert.deepEqual(t.interval, { low: 22, high: 54 }); // Wilson 95% for 11/30
  });

  test('a rise that could be chance is "within normal variation", not coloured', () => {
    // 3/20 = 15% before, 11/30 = 36.7% now, but the test is not passed (z ≈ 1.67, p ≈ 0.09).
    const c = h.tiles.mentionRate.change;
    assert.equal(c.significant, false);
    assert.equal(c.direction, 'flat');
    assert.equal(c.verdict, 'within_variation');
    assert.equal(c.text, 'Within normal variation');
  });

  test('a significant rise says how many points, against the right window', () => {
    // 0/20 before, 11/30 now: pooled 0.22, z ≈ 3.07, p ≈ 0.002, +36.67 points
    const rises = headline({ rows: [...before(0), ...thisWindow()], brandId: BRAND, asOf: AS_OF });
    const c = rises.tiles.mentionRate.change;
    assert.equal(c.significant, true);
    assert.equal(c.direction, 'up');
    assert.equal(c.text, '+37 points vs the 4 weeks before');
  });

  test('share of voice is the brand’s mentions ÷ everyone tracked: 11 of 24 = 46%', () => {
    const t = h.tiles.shareOfVoice;
    assert.equal(t.k, 11);
    assert.equal(t.n, 24);
    assert.equal(t.display, '46%');
  });

  test('citation share is own sources ÷ all sources: 15 of 50 = 30%', () => {
    const t = h.tiles.citationShare;
    assert.equal(t.k, 15);
    assert.equal(t.n, 50);
    assert.equal(t.display, '30%');
  });

  test('the score is the weighted presence of the readable cells: 100 × 7.5 / 15 = 50', () => {
    assert.equal(h.tiles.visibility.value, 50);
  });

  test('position and sentiment are sums over sums: 9/5 = 1.8 and 8/10 = +0.8', () => {
    assert.equal(h.tiles.position.value, 1.8);
    assert.equal(h.tiles.sentiment.value, 0.8);
    assert.equal(h.tiles.sentiment.display, '+0.8');
    assert.equal(h.tiles.recommendationRate.display, '45%'); // 5 of 11
  });

  test('the change of a score is shown but never coloured', () => {
    const withScore = headline({
      rows: [
        row({ metricDate: '2026-09-01', nAnswers: 10, visWeightedSum: 2, visWeightTotal: 5 }),
        ...thisWindow(),
      ],
      brandId: BRAND,
      asOf: AS_OF,
    });
    const c = withScore.tiles.visibility.change; // 40 before, 50 now
    assert.equal(c.significant, false);
    assert.equal(c.direction, 'flat');
    assert.match(c.text, /^\+10 points vs the 4 weeks before \(not tested\)$/);
  });

  test('coverage counts the checks that did not finish and names the engine', () => {
    assert.deepEqual(h.coverage, {
      answers: 30,
      cellsTotal: 20,
      cellsPartial: 5,
      incomplete: true,
      engines: ['gemini'],
    });
  });

  test('answers the engines could not give are never turned into 0%', () => {
    const nothing = headline({
      rows: [row({ cellsPartial: 5 }), row({ engineCode: 'gemini', cellsPartial: 5 })],
      brandId: BRAND,
      asOf: AS_OF,
    });
    for (const key of [
      'mentionRate',
      'visibility',
      'shareOfVoice',
      'citationShare',
      'position',
      'sentiment',
    ]) {
      assert.equal(nothing.tiles[key].state, 'unknown', key);
      assert.equal(nothing.tiles[key].value, null, key);
      assert.equal(nothing.tiles[key].display, '—', key);
    }
  });

  test('read answers that name nobody are an honest zero for mention rate, and "nothing to show" elsewhere', () => {
    const none = headline({
      rows: [row({ nAnswers: 10, kMentioned: 0, visWeightedSum: 0, visWeightTotal: 5 })],
      brandId: BRAND,
      asOf: AS_OF,
    });
    assert.equal(none.tiles.mentionRate.display, '0%');
    assert.equal(none.tiles.mentionRate.state, 'ok');
    assert.equal(none.tiles.shareOfVoice.state, 'empty');
    assert.equal(none.tiles.position.state, 'empty');
    assert.equal(none.tiles.visibility.value, 0);
  });

  test('no rows at all is "no data", not a screen of zeros', () => {
    const empty = headline({ rows: [], brandId: BRAND, asOf: AS_OF });
    assert.equal(empty.hasData, false);
    assert.equal(empty.coverage.incomplete, false);
  });

  test('a longer range uses a longer window', () => {
    const long = headline({ rows: thisWindow(), brandId: BRAND, asOf: AS_OF, days: 56 });
    assert.deepEqual(long.windows.after, ['2026-08-09', '2026-10-03']);
  });
});

describe('the incomplete-data banner', () => {
  test('is null when everything finished', () => {
    assert.equal(incompleteNotice({ incomplete: false }), null);
  });

  test('names the engine, the count, and that missing answers are not "not mentioned"', () => {
    const h = headline({ rows: thisWindow(), brandId: BRAND, asOf: AS_OF });
    const notice = incompleteNotice(h.coverage, { gemini: 'Gemini' });
    assert.equal(notice.title, 'Some checks are incomplete.');
    assert.match(
      notice.text,
      /^Gemini data is incomplete\. 5 of 20 question-and-engine checks did not finish\./,
    );
    assert.match(notice.text, /not counted as “not mentioned”/);
  });

  test('lists several engines', () => {
    const text = incompleteNotice(
      {
        incomplete: true,
        cellsPartial: 2,
        cellsTotal: 8,
        engines: ['chatgpt', 'gemini', 'perplexity'],
      },
      { chatgpt: 'ChatGPT', gemini: 'Gemini', perplexity: 'Perplexity' },
    ).text;
    assert.match(text, /^ChatGPT, Gemini and Perplexity data are incomplete\./);
  });
});

describe('trendSeries', () => {
  const rows = thisWindow();
  const range = { from: '2026-09-06', to: '2026-10-03' };

  test('all engines: a day an engine failed is a gap, not a fall to zero', () => {
    const points = trendSeries({ rows, brandId: BRAND, ...range });
    assert.deepEqual(
      points.map((p) => p.date),
      ['2026-09-20', '2026-10-01'],
    );
    // 09-20: chatgpt 4 + gemini 1 = 5 of 20 = 25%
    assert.equal(points[0].value, 25);
    assert.equal(points[0].gap, false);
    assert.equal(points[0].n, 20);
    assert.ok(points[0].low < 25 && points[0].high > 25);
    // 10-01: gemini did not finish
    assert.equal(points[1].value, null);
    assert.equal(points[1].gap, true);
  });

  test('one engine: its own days only, and its own gaps', () => {
    const chatgpt = trendSeries({ rows, brandId: BRAND, ...range, engineCode: 'chatgpt' });
    assert.deepEqual(
      chatgpt.map((p) => p.value),
      [40, 60],
    );
    const gemini = trendSeries({ rows, brandId: BRAND, ...range, engineCode: 'gemini' });
    assert.deepEqual(
      gemini.map((p) => p.value),
      [10, null],
    );
  });

  test('score and share of voice per day', () => {
    const score = trendSeries({
      rows,
      brandId: BRAND,
      ...range,
      engineCode: 'chatgpt',
      measure: 'visibility',
    });
    assert.deepEqual(
      score.map((p) => p.value),
      [60, 80],
    ); // 3.0/5 and 4.0/5
    const sov = trendSeries({
      rows,
      brandId: BRAND,
      ...range,
      engineCode: 'chatgpt',
      measure: 'shareOfVoice',
    });
    assert.deepEqual(
      sov.map((p) => p.value),
      [40, 60],
    ); // 4 of 10, 6 of 10
  });

  test('days outside the range are left out', () => {
    const points = trendSeries({ rows, brandId: BRAND, from: '2026-09-25', to: '2026-10-03' });
    assert.deepEqual(
      points.map((p) => p.date),
      ['2026-10-01'],
    );
  });
});

describe('byEngine', () => {
  const rows = [...thisWindow(), row({ engineCode: 'perplexity', cellsPartial: 5 })];
  const result = byEngine({
    rows,
    brandId: BRAND,
    engineCodes: ['chatgpt', 'gemini', 'perplexity', 'google_aio'],
    asOf: AS_OF,
  });
  const by = Object.fromEntries(result.map((e) => [e.engineCode, e]));

  test('a readable engine shows its rate', () => {
    assert.equal(by.chatgpt.state, 'ok');
    assert.equal(by.chatgpt.display, '50%'); // 10 of 20
    assert.equal(by.chatgpt.incomplete, false);
  });

  test('an engine with some failed cells still shows what was read, marked incomplete', () => {
    assert.equal(by.gemini.display, '10%'); // 1 of 10
    assert.equal(by.gemini.incomplete, true);
  });

  test('an engine that was checked but could not be read is "unknown", never 0%', () => {
    assert.equal(by.perplexity.state, 'unknown');
    assert.equal(by.perplexity.display, '—');
  });

  test('an engine not yet checked is "none"', () => {
    assert.equal(by.google_aio.state, 'none');
  });
});

describe('competitorTable', () => {
  const rows = [...before(3), ...thisWindow()];
  const entities = [
    { id: BRAND, name: 'Acme', kind: 'brand' },
    { id: RIVAL, name: 'Rival', kind: 'competitor' },
  ];
  const table = competitorTable({ rows, entities, brandId: BRAND, asOf: AS_OF });

  test('sorted by share of voice; the rival has 13 of 24 mentions', () => {
    assert.deepEqual(
      table.map((r) => r.name),
      ['Rival', 'Acme'],
    );
    assert.equal(table[0].shareOfVoice, 54); // 13/24
    assert.equal(table[1].shareOfVoice, 46); // 11/24
  });

  test('each row has its own mention rate and position', () => {
    assert.equal(table[0].mentionRate, 43); // 13 of 30
    assert.equal(table[0].position, 3); // 9/3
    assert.equal(table[1].mentionRate, 37);
    assert.equal(table[1].isBrand, true);
  });

  test('an entity with no rows is "none", one with no readable answers is "unknown"', () => {
    const extra = competitorTable({
      rows,
      entities: [...entities, { id: '9', name: 'Newcomer', kind: 'competitor' }],
      brandId: BRAND,
      asOf: AS_OF,
    });
    const newcomer = extra.find((r) => r.name === 'Newcomer');
    assert.equal(newcomer.state, 'none');
    assert.equal(newcomer.mentionRate, null);
    assert.equal(newcomer.shareOfVoice, null);
  });
});

describe('winRate', () => {
  const cell = (promptId, entityId, k, rankSum = 0, rankN = 0) => ({
    promptId,
    entityId,
    k,
    rankSum,
    rankN,
  });

  test('counts wins, losses and ties by the rule in the spec, and leaves out questions where neither was named', () => {
    const cells = [
      cell('1', BRAND, 2, 2, 2),
      cell('1', RIVAL, 2, 6, 2), // both ranked: 1.0 vs 3.0 -> win
      cell('2', RIVAL, 1), //                                   rival only -> loss
      cell('3', BRAND, 1), //                                   brand only -> win
      // question 4: neither named, no rows -> left out
      cell('5', BRAND, 1),
      cell('5', RIVAL, 1), //              no ranks, equal mentions -> tie
      cell('6', BRAND, 2, 4, 2),
      cell('6', RIVAL, 3, 6, 3), //  both ranked: 2.0 vs 2.0 -> tie
      cell('7', BRAND, 1),
      cell('7', RIVAL, 2), //              no ranks, fewer mentions -> loss
    ];
    assert.deepEqual(winRate({ cells, brandId: BRAND, competitorId: RIVAL }), {
      wins: 2,
      losses: 2,
      ties: 2,
      decided: 6,
      rate: 33, // 2 of 6
    });
  });

  test('is null, not 0%, when nothing was decided', () => {
    assert.equal(winRate({ cells: [], brandId: BRAND, competitorId: RIVAL }).rate, null);
  });

  test('ignores other entities', () => {
    const cells = [cell('1', BRAND, 1), cell('1', '99', 5)];
    assert.equal(winRate({ cells, brandId: BRAND, competitorId: RIVAL }).wins, 1);
  });
});

describe('matrixCell', () => {
  const cell = (over) => ({ status: 'complete', nPlanned: 3, nOk: 3, kMentioned: 0, ...over });

  test('no cell yet is "none"', () => {
    assert.equal(matrixCell(null).state, 'none');
  });

  test('a complete cell is mentioned or not mentioned', () => {
    assert.equal(matrixCell(cell({ kMentioned: 2 })).state, 'mentioned');
    assert.equal(matrixCell(cell()).state, 'absent');
  });

  test('a partial cell can say "mentioned" but never "not mentioned"', () => {
    const partial = { status: 'partial', nOk: 2, nPlanned: 3 };
    assert.equal(matrixCell(cell({ ...partial, kMentioned: 1 })).state, 'mentioned');
    const none = matrixCell(cell({ ...partial, kMentioned: 0 }));
    assert.equal(none.state, 'unknown');
    assert.equal(none.status, 'failed'); // resultCell turns this into "Couldn’t check"
  });

  test('a failed cell is "couldn’t check"; a cell with no answer from the engine is "no AI Overview"', () => {
    assert.equal(matrixCell(cell({ status: 'failed', nOk: 0 })).state, 'unknown');
    assert.equal(matrixCell(cell({ status: 'no_answer', nOk: 0 })).state, 'no_overview');
  });
});

describe('citationRows', () => {
  const domain = (over) => ({
    domain: 'example.com',
    class: 'review_site',
    timesCited: 5,
    answersCiting: 4,
    answersWithBrand: 1,
    own: false,
    ownerEntityIds: [],
    ...over,
  });

  test('share is of all citations, and a gap is a foreign site cited where the brand was not named', () => {
    const { rows, gaps } = citationRows({
      total: 20,
      domains: [
        domain({ domain: 'g2.com', timesCited: 8, answersCiting: 6, answersWithBrand: 2 }),
        domain({
          domain: 'acme.test',
          own: true,
          timesCited: 5,
          answersCiting: 5,
          answersWithBrand: 0,
        }),
        domain({
          domain: 'reddit.com',
          class: 'ugc',
          timesCited: 4,
          answersCiting: 4,
          answersWithBrand: 0,
        }),
        domain({ domain: 'once.example', timesCited: 1, answersCiting: 1, answersWithBrand: 0 }),
        domain({ domain: 'covered.example', timesCited: 2, answersCiting: 2, answersWithBrand: 2 }),
      ],
    });
    assert.equal(rows[0].share, 40); // 8 of 20
    assert.equal(rows[0].classLabel, 'Review site');
    assert.equal(rows[2].classLabel, 'Forum or community');
    // Not the brand's own site, cited in at least 2 answers, some of which did not name the brand.
    // Both have 4 answers without the brand; the one cited more often comes first.
    assert.deepEqual(
      gaps.map((g) => g.domain),
      ['g2.com', 'reddit.com'],
    );
    assert.equal(gaps[0].answersWithoutBrand, 4);
    assert.equal(gaps[1].answersWithoutBrand, 4);
  });

  test('no citations at all gives no share, not 0%', () => {
    const { rows } = citationRows({ total: 0, domains: [domain()] });
    assert.equal(rows[0].share, null);
  });
});

test('rangeKey accepts only the offered ranges', () => {
  assert.equal(rangeKey('8w'), '8w');
  assert.equal(rangeKey('1y'), '4w');
  assert.equal(rangeKey(undefined), '4w');
  assert.equal(rangeKey('__proto__'), '4w');
});

describe('describeChange', () => {
  const event = (over) => ({
    kind: 'mention_rate_change',
    engine_code: 'chatgpt',
    value_before: '0.1111',
    value_after: '0.5556',
    delta_pp: '44.45',
    direction: 'up',
    n_before: 9,
    k_before: 1,
    n_after: 9,
    k_after: 5,
    after_start: new Date('2026-09-06T00:00:00Z'),
    after_end: new Date('2026-10-03T00:00:00Z'),
    ...over,
  });

  test('a rise says the counts behind it, the window, and that it passed the test', () => {
    const c = describeChange(event(), { engineNames: { chatgpt: 'ChatGPT' } });
    assert.equal(c.tone, 'success');
    assert.equal(c.title, 'Your mention rate on ChatGPT rose 44 points');
    assert.equal(
      c.text,
      'From 11% (1 of 9 answers) to 56% (5 of 9), comparing the last 4 weeks with the 4 weeks before. ' +
        'This passed the significance test, so it is unlikely to be chance.',
    );
    assert.equal(c.date, '2026-10-03');
  });

  test('a fall is danger, across all engines when no engine is named', () => {
    const c = describeChange(event({ engine_code: null, direction: 'down', delta_pp: '-12.4' }));
    assert.equal(c.tone, 'danger');
    assert.equal(c.title, 'Your mention rate fell 12 points');
  });

  test('a competitor rising is a warning that names the competitor', () => {
    const c = describeChange(event({ kind: 'competitor_surge' }), { entityName: 'Rival Smiles' });
    assert.equal(c.tone, 'warning');
    assert.equal(c.title, 'Rival Smiles’s mention rate on chatgpt rose 44 points');
  });

  test('share of voice and citation share have their own names', () => {
    assert.match(describeChange(event({ kind: 'sov_change' })).title, /^Your share of voice/);
    assert.match(
      describeChange(event({ kind: 'citation_share_change' })).title,
      /^Your citation share/,
    );
  });
});

describe('staleNotice', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  test('says how old the numbers are after two weeks, and not before', () => {
    assert.equal(staleNotice(new Date('2026-10-07T12:00:00Z'), now), null); // 13 days
    const stale = staleNotice(new Date('2026-10-05T12:00:00Z'), now); // 15 days
    assert.equal(stale.title, 'These numbers are 15 days old.');
  });
  test('says nothing when no check has finished (that has its own state)', () => {
    assert.equal(staleNotice(null, now), null);
  });
});
