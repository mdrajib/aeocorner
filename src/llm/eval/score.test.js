import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { decideD4, meetsTargets, scoreReadings } from './score.js';

const golden = [
  {
    id: 'a1',
    engine: 'perplexity',
    labels: {
      answer_type: 'list',
      tracked: {
        acme: { mentioned: true, list_rank: 2, stance: 'recommended' },
        rival: { mentioned: true, list_rank: 1, stance: 'recommended' },
        other: { mentioned: false, list_rank: null, stance: null },
      },
      others: ['Zoho CRM', 'Pipedrive'],
    },
  },
  {
    id: 'a2',
    engine: 'google_aio',
    labels: {
      answer_type: 'explanatory',
      tracked: {
        acme: { mentioned: false, list_rank: null, stance: null },
        rival: { mentioned: true, list_rank: null, stance: 'neutral' },
        other: { mentioned: false, list_rank: null, stance: null },
      },
      others: [],
    },
  },
];

describe('scoring readings against the golden set', () => {
  test('a perfect reading scores 1 everywhere', () => {
    const predictions = new Map([
      [
        'a1',
        {
          answerType: 'list',
          tracked: {
            acme: { mentioned: true, listRank: 2, stance: 'recommended' },
            rival: { mentioned: true, listRank: 1, stance: 'recommended' },
          },
          others: ['Zoho', 'pipedrive'],
        },
      ],
      [
        'a2',
        {
          answerType: 'explanatory',
          tracked: { rival: { mentioned: true, listRank: null, stance: 'neutral' } },
          others: [],
        },
      ],
    ]);
    const s = scoreReadings(golden, predictions);
    assert.equal(s.pairs, 6);
    assert.equal(s.mention, 1);
    assert.equal(s.stance, 1);
    assert.equal(s.rank, 1);
    assert.equal(s.answerType, 1);
    assert.equal(s.othersPrecision, 1, '"Zoho" counts for "Zoho CRM"');
    assert.equal(s.othersRecall, 1);
    assert.deepEqual(s.misses, []);
    assert.deepEqual(meetsTargets(s), { mention: true, stance: true, rank: true });
  });

  test('misses are counted and listed; a failed reading counts against every pair of its answer', () => {
    const predictions = new Map([
      [
        'a1',
        {
          answerType: 'comparison',
          tracked: {
            acme: { mentioned: true, listRank: 3, stance: 'neutral' },
            other: { mentioned: true, listRank: null, stance: 'neutral' },
          },
          others: ['Salesforce'],
        },
      ],
      ['a2', null],
    ]);
    const s = scoreReadings(golden, predictions);
    // a1: acme agree, rival missed (FN), other extra (FP); a2: acme agree, rival missed (FN), other agree.
    assert.equal(s.mention, 3 / 6);
    assert.equal(s.falsePositives, 1);
    assert.equal(s.falseNegatives, 2);
    assert.equal(s.bothNamed, 1);
    assert.equal(s.stance, 0);
    assert.equal(s.rank, 0);
    assert.equal(s.failed, 1);
    assert.equal(s.answerType, 0);
    assert.equal(s.othersPrecision, 0);
    assert.equal(s.othersRecall, 0);
    assert.deepEqual(s.byEngine, {
      perplexity: { pairs: 3, mention: 1 / 3 },
      google_aio: { pairs: 3, mention: 2 / 3 },
    });
    assert.deepEqual(
      s.misses.map((m) => `${m.id}/${m.entity}/${m.field}`),
      [
        'a1/acme/stance',
        'a1/acme/list_rank',
        'a1/rival/mentioned',
        'a1/other/mentioned',
        'a2/rival/mentioned',
      ],
    );
  });

  test('nothing to compare gives null, not a score', () => {
    const s = scoreReadings([], new Map());
    assert.equal(s.mention, null);
    assert.deepEqual(meetsTargets(s), { mention: false, stance: false, rank: false });
  });
});

describe('decision D4', () => {
  const opus = { mention: 0.97, stance: 0.93, rank: 0.95 };
  test('switch only if the cheaper model meets every target and is within 2 points on mentions', () => {
    assert.equal(
      decideD4(opus, { mention: 0.955, stance: 0.91, rank: 0.92 }).switchToCheaper,
      true,
    );
    assert.equal(
      decideD4(opus, { mention: 0.95, stance: 0.91, rank: 0.92 }).switchToCheaper,
      true,
      'exactly 2 points',
    );
    assert.equal(
      decideD4(opus, { mention: 0.949, stance: 0.91, rank: 0.92 }).switchToCheaper,
      false,
      'below target',
    );
    assert.equal(
      decideD4({ ...opus, mention: 0.99 }, { mention: 0.96, stance: 0.95, rank: 0.95 })
        .switchToCheaper,
      false,
      '3 points behind',
    );
    assert.equal(
      decideD4(opus, { mention: 0.97, stance: 0.89, rank: 0.95 }).switchToCheaper,
      false,
      'stance below target',
    );
  });
});
