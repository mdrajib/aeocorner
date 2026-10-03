import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  answerCards,
  describeProgress,
  engineCards,
  engineState,
  headline,
} from './audit-progress.js';

const row = (idx, engine, status = 'ok', extra = {}) => ({
  prompt_idx: idx,
  engine_code: engine,
  status,
  text_excerpt: status === 'ok' ? `answer ${idx} from ${engine}` : null,
  brand_present: status === 'ok' ? false : null,
  entities: null,
  ...extra,
});
const five = (engine, status = 'ok', extra) =>
  [0, 1, 2, 3, 4].map((i) => row(i, engine, status, extra));
const prompts = [0, 1, 2, 3, 4].map((promptIdx) => ({ promptIdx, text: `Question ${promptIdx}?` }));
const stateOf = (progress, id) => progress.steps.find((s) => s.id === id).state;

describe('engineState', () => {
  test('nothing yet is waiting, some is active, all is done', () => {
    assert.equal(engineState([], 5).state, 'waiting');
    assert.equal(engineState([row(0, 'chatgpt')], 5).state, 'active');
    assert.equal(engineState(five('chatgpt'), 5).state, 'done');
  });
  test('a pending answer is not an answer yet', () => {
    const rows = [...five('chatgpt').slice(0, 4), row(4, 'chatgpt', 'pending')];
    assert.equal(engineState(rows, 5).state, 'active');
  });
  test('a finished engine with failures is "unknown", never done', () => {
    const rows = [
      ...five('gemini').slice(0, 3),
      row(3, 'gemini', 'failed'),
      row(4, 'gemini', 'failed'),
    ];
    assert.equal(engineState(rows, 5).state, 'unknown');
  });
  test('an engine with no answer to give (no AI Overview) counts as done', () => {
    assert.equal(engineState(five('google_aio', 'no_answer'), 5).state, 'done');
  });
});

describe('describeProgress', () => {
  test('a queued audit has every step waiting', () => {
    const p = describeProgress({
      audit: { status: 'queued', prompts: null },
      scan: null,
      answers: [],
    });
    assert.equal(p.done, false);
    assert.ok(
      p.steps.every((s) => s.state === 'waiting'),
      JSON.stringify(p.steps),
    );
  });

  test('a running audit shows the site read, the questions and engines in their own states', () => {
    const p = describeProgress({
      audit: { status: 'running', prompts },
      scan: { status: 'complete', pages_fetched: 14 },
      answers: [...five('chatgpt'), ...five('gemini', 'failed'), row(0, 'perplexity')],
    });
    assert.equal(p.steps[0].label, 'Read your site (14 pages)');
    assert.equal(stateOf(p, 'questions'), 'done');
    assert.equal(stateOf(p, 'engine-chatgpt'), 'done');
    assert.equal(stateOf(p, 'engine-gemini'), 'unknown');
    assert.equal(stateOf(p, 'engine-perplexity'), 'active');
    assert.equal(stateOf(p, 'engine-google_aio'), 'waiting');
    assert.equal(stateOf(p, 'score'), 'waiting');
    assert.match(p.steps.find((s) => s.id === 'engine-gemini').label, /couldn’t check Gemini/);
  });

  test('a scan that failed says it could not be checked', () => {
    const p = describeProgress({
      audit: { status: 'running', prompts: null },
      scan: { status: 'failed' },
      answers: [],
    });
    assert.equal(stateOf(p, 'site'), 'unknown');
  });

  test('a finished audit never leaves an engine "waiting": it is done or couldn’t be checked', () => {
    const p = describeProgress({
      audit: { status: 'partial', prompts },
      scan: { status: 'complete', pages_fetched: 1 },
      answers: five('chatgpt'),
    });
    assert.equal(p.done, true);
    assert.equal(stateOf(p, 'engine-chatgpt'), 'done');
    assert.equal(stateOf(p, 'engine-perplexity'), 'unknown');
    assert.equal(stateOf(p, 'score'), 'done');
  });

  test('a failed audit is reported as failed, with the score step unknown', () => {
    const p = describeProgress({
      audit: { status: 'failed', prompts: null },
      scan: null,
      answers: [],
    });
    assert.equal(p.failed, true);
    assert.equal(stateOf(p, 'score'), 'unknown');
  });
});

describe('answerCards', () => {
  test('only readable answers get a card, in question then engine order, naming the question', () => {
    const cards = answerCards({
      answers: [
        row(1, 'gemini'),
        row(0, 'perplexity'),
        row(0, 'chatgpt'),
        row(0, 'gemini', 'failed'),
      ],
      questions: prompts,
      brandName: 'Acme',
    });
    assert.deepEqual(
      cards.map((c) => `${c.promptIdx}:${c.engine}`),
      ['0:chatgpt', '0:perplexity', '1:gemini'],
    );
    assert.equal(cards[0].question, 'Question 0?');
    assert.deepEqual(cards[0].highlights, [{ term: 'Acme', kind: 'brand' }]);
  });

  test('the engine’s named businesses are highlighted as competitors, the brand as the brand', () => {
    const [card] = answerCards({
      answers: [
        row(0, 'chatgpt', 'ok', {
          entities: [
            { name: 'RivalCo', kind: 'competitor' },
            { name: 'Acme Dental', kind: 'brand' },
            { name: '  ', kind: 'discovered' },
          ],
        }),
      ],
      questions: prompts,
    });
    assert.deepEqual(card.highlights, [
      { term: 'RivalCo', kind: 'competitor' },
      { term: 'Acme Dental', kind: 'brand' },
    ]);
  });

  test('a limit keeps the latest', () => {
    const cards = answerCards({ answers: five('chatgpt'), questions: prompts, limit: 2 });
    assert.deepEqual(
      cards.map((c) => c.promptIdx),
      [3, 4],
    );
  });
});

describe('engineCards', () => {
  test('an engine with unreadable answers is "unknown", never "not mentioned"', () => {
    const cards = engineCards({ answers: five('gemini', 'failed') });
    const gemini = cards.find((c) => c.code === 'gemini');
    assert.equal(gemini.status, 'unknown');
    assert.equal(gemini.mentioned, undefined);
  });

  test('an engine we never heard from is "unknown"', () => {
    assert.equal(engineCards({ answers: [] }).find((c) => c.code === 'chatgpt').status, 'unknown');
  });

  test('"no answer" from every question is "no AI Overview", not a miss', () => {
    const aio = engineCards({ answers: five('google_aio', 'no_answer') }).find(
      (c) => c.code === 'google_aio',
    );
    assert.equal(aio.status, 'no_overview');
  });

  test('a brand the pre-pass found counts; one nobody found is "not mentioned" only if Claude read it', () => {
    const found = engineCards({
      answers: [row(0, 'chatgpt', 'ok', { brand_present: true }), row(1, 'chatgpt')],
    }).find((c) => c.code === 'chatgpt');
    assert.equal(found.status, 'ok');
    assert.equal(found.mentioned, true);
    assert.equal(found.mentionedIn, 1);

    const unread = engineCards({
      answers: five('perplexity', 'ok', { brand_present: null }),
    }).find((c) => c.code === 'perplexity');
    assert.equal(unread.status, 'unknown');
  });

  test('the rivals an engine named most come first, at most three', () => {
    const rivals = ['A', 'B', 'C', 'D'].map((name) => ({ name, kind: 'competitor' }));
    const card = engineCards({
      answers: [
        row(0, 'chatgpt', 'ok', { entities: rivals }),
        row(1, 'chatgpt', 'ok', { entities: [rivals[3], rivals[1]] }),
      ],
    }).find((c) => c.code === 'chatgpt');
    assert.deepEqual(card.named, ['B', 'D', 'A']);
  });
});

describe('headline', () => {
  const cards = (list) => list;
  test('says it could not read enough rather than "0 of 5"', () => {
    assert.match(
      headline({ cards: engineCards({ answers: [] }), brandName: 'Acme' }),
      /couldn’t read enough/,
    );
  });
  test('names the best engine and a rival', () => {
    const c = engineCards({
      answers: [
        row(0, 'chatgpt', 'ok', {
          brand_present: true,
          entities: [{ name: 'RivalCo', kind: 'competitor' }],
        }),
        row(1, 'chatgpt'),
      ],
    });
    assert.equal(
      headline({ cards: cards(c), brandName: 'Acme' }),
      'ChatGPT named Acme in 1 of 2 buyer questions. RivalCo was named too.',
    );
  });
  test('no engine naming the brand says so plainly', () => {
    const c = engineCards({
      answers: [row(0, 'chatgpt', 'ok', { entities: [{ name: 'RivalCo', kind: 'competitor' }] })],
    });
    assert.equal(
      headline({ cards: c, brandName: 'Acme' }),
      'No engine we could read named Acme. RivalCo was named instead.',
    );
  });
});
