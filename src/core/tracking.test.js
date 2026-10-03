import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildCells,
  cellScore,
  classifyCell,
  entityTally,
  planTasks,
  rollupDay,
  runOutcome,
  samplesFor,
  visibilityOfRows,
} from './tracking.js';

const BRAND = '1';
const RIVAL = '2';

const sample = (over = {}) => ({
  promptId: '10',
  engineCode: 'chatgpt',
  sampleIdx: 0,
  status: 'ok',
  mentions: [],
  citations: [],
  ...over,
});
const brandAt = (listRank, stance = 'recommended', sentiment = 1) => ({
  entityId: BRAND,
  listRank,
  stance,
  sentiment,
});
const rivalAt = (listRank) => ({ entityId: RIVAL, listRank, stance: 'neutral', sentiment: 0 });

describe('samplesFor', () => {
  test('the plan caps the engine, a project override wins', () => {
    assert.equal(samplesFor({ engineDefault: 3, planSamples: 3 }), 3);
    assert.equal(samplesFor({ engineDefault: 3, planSamples: 2 }), 2);
    assert.equal(samplesFor({ engineDefault: 1, planSamples: 3 }), 1);
    assert.equal(samplesFor({ engineDefault: 3, planSamples: 3, override: 5 }), 5);
  });
  test('is always between 1 and 10', () => {
    assert.equal(samplesFor({ engineDefault: 0, planSamples: 3 }), 1);
    assert.equal(samplesFor({ engineDefault: 3, planSamples: 3, override: 99 }), 10);
  });
});

describe('planTasks', () => {
  const prompts = [{ id: '1' }, { id: '2' }];
  const engines = [
    { code: 'chatgpt', samples: 3 },
    { code: 'google_aio', samples: 1 },
  ];
  test('is questions x engines x samples, in a stable order', () => {
    const tasks = planTasks({ prompts, engines });
    assert.equal(tasks.length, 2 * (3 + 1));
    assert.deepEqual(tasks[0], { promptId: '1', engineCode: 'chatgpt', sampleIdx: 0 });
    assert.deepEqual(tasks[3], { promptId: '1', engineCode: 'google_aio', sampleIdx: 0 });
    assert.deepEqual(planTasks({ prompts, engines }), tasks);
  });
  test('has no tasks for no questions or no engines', () => {
    assert.deepEqual(planTasks({ prompts: [], engines }), []);
    assert.deepEqual(planTasks({ prompts, engines: [] }), []);
  });
});

describe('classifyCell', () => {
  const of = (...statuses) => classifyCell(statuses.map((status) => ({ status })));
  test('every answer read is complete', () => {
    assert.deepEqual(of('ok', 'ok', 'ok'), {
      status: 'complete',
      nPlanned: 3,
      nOk: 3,
      nNoAnswer: 0,
      nFailed: 0,
    });
  });
  test('some failed is partial, all failed is failed', () => {
    assert.equal(of('ok', 'failed', 'ok').status, 'partial');
    assert.equal(of('failed', 'failed').status, 'failed');
  });
  test('an engine with nothing to say is no_answer, not failed and not zero', () => {
    const c = of('no_answer');
    assert.equal(c.status, 'no_answer');
    assert.equal(c.nOk, 0);
    assert.equal(c.nFailed, 0);
  });
  test('an answer still pending when the run settles is one we could not check', () => {
    const c = of('ok', 'pending');
    assert.equal(c.status, 'partial');
    assert.equal(c.nFailed, 1);
  });
  test('no_answer plus a failure is partial (something real was learned)', () => {
    assert.equal(of('no_answer', 'failed').status, 'partial');
  });
});

describe('cellScore', () => {
  test('is the mean presence value over readable answers', () => {
    const samples = [
      sample({ mentions: [brandAt(1)] }), // 1.0
      sample({ mentions: [brandAt(2)] }), // 0.85
      sample({ mentions: [] }), // 0
    ];
    assert.equal(cellScore(samples, BRAND), 0.6167);
  });
  test('a failed answer leaves the mean instead of pulling it to zero', () => {
    const samples = [
      sample({ mentions: [brandAt(1)] }),
      sample({ status: 'failed' }),
      sample({ status: 'pending' }),
    ];
    assert.equal(cellScore(samples, BRAND), 1);
  });
  test('is null when nothing was readable: never 0', () => {
    assert.equal(cellScore([sample({ status: 'failed' })], BRAND), null);
    assert.equal(cellScore([sample({ status: 'no_answer' })], BRAND), null);
    assert.equal(cellScore([], BRAND), null);
  });
  test('a cited own domain is worth a little when the brand is not named', () => {
    const s = sample({ citations: [{ ownerEntityId: BRAND, isOwn: true, supportsEntityIds: [] }] });
    assert.equal(cellScore([s], BRAND), 0.25);
  });
  test('a cautioned mention is halved', () => {
    assert.equal(cellScore([sample({ mentions: [brandAt(1, 'cautioned', -1)] })], BRAND), 0.5);
  });
});

describe('entityTally', () => {
  test('counts only readable answers and keeps sums, not rates', () => {
    const samples = [
      sample({ mentions: [brandAt(1), rivalAt(2)] }),
      sample({ mentions: [brandAt(3, 'neutral', -1)] }),
      sample({ status: 'failed', mentions: [brandAt(1)] }), // would count if a failure were trusted
      sample({ mentions: [] }),
    ];
    assert.deepEqual(entityTally(samples, BRAND), {
      kMentioned: 2,
      kRecommended: 1,
      kCited: 0,
      rankSum: 4,
      rankN: 2,
      bestRank: 1,
      sentimentSum: 0,
      sentimentN: 2,
    });
    assert.equal(entityTally(samples, RIVAL).kMentioned, 1);
  });
  test('a mention without a rank adds to k but not to the rank sums', () => {
    const t = entityTally([sample({ mentions: [{ entityId: BRAND, listRank: null }] })], BRAND);
    assert.equal(t.kMentioned, 1);
    assert.equal(t.rankN, 0);
    assert.equal(t.bestRank, null);
  });
  test('a citation that supports an entity counts as cited, once per answer', () => {
    const s = sample({
      citations: [
        { ownerEntityId: null, isOwn: false, supportsEntityIds: [RIVAL] },
        { ownerEntityId: RIVAL, isOwn: false, supportsEntityIds: [] },
      ],
    });
    assert.equal(entityTally([s], RIVAL).kCited, 1);
  });
  test('only the brand counts its own-domain flag', () => {
    const s = sample({ citations: [{ ownerEntityId: null, isOwn: true, supportsEntityIds: [] }] });
    assert.equal(entityTally([s], BRAND, { isBrand: true }).kCited, 1);
    assert.equal(entityTally([s], RIVAL).kCited, 0);
  });
});

describe('buildCells', () => {
  const samples = [
    sample({ promptId: '10', engineCode: 'chatgpt', sampleIdx: 0, mentions: [brandAt(1)] }),
    sample({ promptId: '10', engineCode: 'chatgpt', sampleIdx: 1, mentions: [rivalAt(1)] }),
    sample({ promptId: '10', engineCode: 'chatgpt', sampleIdx: 2, status: 'failed' }),
    sample({ promptId: '10', engineCode: 'google_aio', status: 'no_answer' }),
    sample({ promptId: '9', engineCode: 'chatgpt', status: 'failed' }),
  ];
  const cells = buildCells({ samples, brandId: BRAND, entityIds: [BRAND, RIVAL] });

  test('one cell per question and engine, in a stable order', () => {
    assert.deepEqual(
      cells.map((c) => [c.promptId, c.engineCode, c.status]),
      [
        ['10', 'chatgpt', 'partial'],
        ['10', 'google_aio', 'no_answer'],
        ['9', 'chatgpt', 'failed'],
      ],
    );
  });
  test('a partial cell keeps what was read and says what was not', () => {
    const c = cells[0];
    assert.equal(c.nPlanned, 3);
    assert.equal(c.nOk, 2);
    assert.equal(c.nFailed, 1);
    assert.equal(c.cellScore, 0.5);
    assert.deepEqual(
      c.entities.map((e) => [e.entityId, e.kMentioned]),
      [
        [BRAND, 1],
        [RIVAL, 1],
      ],
    );
  });
  test('failed and no_answer cells have no score and no entities', () => {
    for (const c of [cells[1], cells[2]]) {
      assert.equal(c.cellScore, null);
      assert.deepEqual(c.entities, []);
    }
  });
});

describe('runOutcome', () => {
  const all = (...statuses) => runOutcome(statuses.map((status) => ({ status })));
  test('complete, partial and failed', () => {
    assert.equal(all('ok', 'ok', 'no_answer').status, 'complete');
    assert.equal(all('ok', 'failed').status, 'partial');
    assert.equal(all('failed', 'failed').status, 'failed');
    assert.equal(all('failed', 'pending').status, 'failed');
  });
  test('counts add up to the plan', () => {
    const r = all('ok', 'ok', 'no_answer', 'failed', 'pending');
    assert.deepEqual(r, {
      status: 'partial',
      tasksPlanned: 5,
      tasksOk: 2,
      tasksNoAnswer: 1,
      tasksFailed: 2,
    });
  });
  test('an empty run has nothing to call complete', () => {
    assert.equal(all().tasksPlanned, 0);
  });
});

describe('rollupDay', () => {
  const samples = [
    ...[0, 1, 2].map((i) =>
      sample({
        promptId: '10',
        sampleIdx: i,
        mentions: i < 2 ? [brandAt(i + 1)] : [rivalAt(1)],
        citations: i === 0 ? [{ ownerEntityId: BRAND, isOwn: true, supportsEntityIds: [] }] : [],
      }),
    ),
    sample({ promptId: '11', sampleIdx: 0, status: 'failed' }),
    sample({ promptId: '11', sampleIdx: 1, mentions: [brandAt(1)] }),
    sample({ promptId: '12', engineCode: 'google_aio', status: 'no_answer' }),
    sample({ promptId: '13', engineCode: 'google_aio', mentions: [brandAt(null)] }),
  ];
  const cells = buildCells({ samples, brandId: BRAND, entityIds: [BRAND, RIVAL] });
  const rows = rollupDay({
    cells,
    entityIds: [BRAND, RIVAL],
    brandId: BRAND,
    promptWeights: { 10: 3, 11: 1 },
    citationCounts: { chatgpt: { total: 4, byEntity: { [BRAND]: 1 } } },
  });
  const row = (engineCode, entityId) =>
    rows.find((r) => r.engineCode === engineCode && r.entityId === entityId);

  test('one row per engine and tracked entity, even for one never named', () => {
    assert.equal(rows.length, 4);
    assert.equal(row('google_aio', RIVAL).kMentioned, 0);
    assert.equal(row('google_aio', RIVAL).nAnswers, 1);
  });
  test('n counts readable answers only; k adds up across cells', () => {
    const b = row('chatgpt', BRAND);
    assert.equal(b.nAnswers, 4); // 3 from prompt 10, 1 readable from prompt 11 (the failed one is left out)
    assert.equal(b.kMentioned, 3);
    assert.equal(b.kRecommended, 3);
    assert.equal(b.rankSum, 1 + 2 + 1);
    assert.equal(row('chatgpt', RIVAL).kMentioned, 1);
  });
  test('a failed or partial cell is counted as incomplete, never as a zero', () => {
    assert.equal(row('chatgpt', BRAND).cellsTotal, 2);
    assert.equal(row('chatgpt', BRAND).cellsPartial, 1);
    assert.equal(row('chatgpt', BRAND).nAnswers - row('chatgpt', BRAND).kMentioned, 1); // 1 real "not named"
  });
  test('citation counts come from the citations table and are the same on each entity row', () => {
    assert.equal(row('chatgpt', BRAND).citationsTotal, 4);
    assert.equal(row('chatgpt', RIVAL).citationsTotal, 4);
    assert.equal(row('chatgpt', BRAND).citationsEntity, 1);
    assert.equal(row('chatgpt', RIVAL).citationsEntity, 0);
  });
  test('only the brand row carries the visibility sums, weighted by priority', () => {
    const b = row('chatgpt', BRAND);
    // cell 10: score (1 + 0.85 + 0)/3 = 0.55 + own cite on sample 0 does not matter (named); weight 3
    // cell 11: score 1.0 over one readable answer; weight 1
    assert.equal(b.visWeightTotal, 4);
    assert.equal(b.visWeightedSum, 2.8501);
    assert.equal(row('chatgpt', RIVAL).visWeightedSum, null);
    assert.equal(visibilityOfRows([b]), Math.round((100 * 2.8501) / 4));
  });
  test('the AI Overview rows say how many searches showed an overview', () => {
    const b = row('google_aio', BRAND);
    assert.equal(b.aioQueries, 2);
    assert.equal(b.aioTriggered, 1);
    assert.equal(row('chatgpt', BRAND).aioQueries, null);
  });
  test('a day with only unreadable cells has no visibility score', () => {
    const only = buildCells({
      samples: [sample({ status: 'failed' })],
      brandId: BRAND,
      entityIds: [BRAND],
    });
    const r = rollupDay({ cells: only, entityIds: [BRAND], brandId: BRAND });
    assert.equal(r[0].nAnswers, 0);
    assert.equal(r[0].visWeightedSum, null);
    assert.equal(visibilityOfRows(r), null);
  });
  test('rolling the same cells up twice gives the same rows', () => {
    assert.deepEqual(
      rollupDay({ cells, entityIds: [BRAND, RIVAL], brandId: BRAND }),
      rollupDay({ cells, entityIds: [BRAND, RIVAL], brandId: BRAND }),
    );
  });
});
