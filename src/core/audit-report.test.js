import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  answerGrid,
  competitorBoard,
  entityKey,
  MAX_COMPETITORS,
  presenceOf,
  reportFigures,
  reportStats,
} from './audit-report.js';

const ENGINES = ['chatgpt', 'perplexity', 'gemini', 'google_aio'];

/** An answer row as `db.audits.answers()` returns it. `names` are `[name, rank?, stance?]` rivals. */
const row = (idx, engine, { brand = false, names = [], status = 'ok', ...extra } = {}) => ({
  prompt_idx: idx,
  engine_code: engine,
  status,
  text_excerpt: status === 'ok' ? `answer ${idx} from ${engine}` : null,
  brand_present: status === 'ok' ? brand : null,
  brand_rank: null,
  brand_stance: null,
  citations: [],
  entities:
    status === 'ok'
      ? [
          ...(brand
            ? [{ name: 'Acme Widgets', kind: 'brand', rank: null, stance: 'neutral' }]
            : []),
          ...names.map(([name, rank = null, stance = 'neutral']) => ({
            name,
            kind: 'competitor',
            rank,
            stance,
          })),
        ]
      : null,
  ...extra,
});

const all = (build, questions = 5) =>
  Array.from({ length: questions }, (_, i) => ENGINES.map((e) => build(i, e))).flat();
const prompts = Array.from({ length: 5 }, (_, promptIdx) => ({
  promptIdx,
  text: `Question ${promptIdx}?`,
}));

describe('presenceOf', () => {
  test('named, or the brand site cited, is present', () => {
    assert.equal(presenceOf(row(0, 'chatgpt', { brand: true })), 'present');
    assert.equal(
      presenceOf(row(0, 'chatgpt', { citations: [{ url: 'https://acme.test', isOwn: true }] })),
      'present',
    );
  });
  test('read and neither named nor cited is absent', () => {
    assert.equal(presenceOf(row(0, 'chatgpt')), 'absent');
  });
  test('a failed, pending, missing or unread answer is unknown, never absent', () => {
    assert.equal(presenceOf(row(0, 'chatgpt', { status: 'failed' })), 'unknown');
    assert.equal(presenceOf(row(0, 'chatgpt', { status: 'pending' })), 'unknown');
    assert.equal(presenceOf(row(0, 'chatgpt', { brand_present: null })), 'unknown');
    assert.equal(presenceOf(undefined), 'unknown');
  });
  test('an engine with nothing to say is its own state', () => {
    assert.equal(presenceOf(row(0, 'google_aio', { status: 'no_answer' })), 'no_overview');
  });
});

describe('entityKey', () => {
  test('case, accents, punctuation, www, domain endings and legal suffixes do not matter', () => {
    const same = ['Jasper', 'JASPER', 'jasper.ai', 'www.jasper.com', 'Jasper, Inc.', 'Jásper'];
    for (const name of same) assert.equal(entityKey(name), 'jasper', name);
    assert.equal(entityKey('Johnson & Johnson'), 'johnson and johnson');
  });
  test('a name made only of symbols has no key; a non-Latin name keeps one', () => {
    assert.equal(entityKey('•••'), '');
    assert.equal(entityKey('ব্র্যান্ড'), 'ব্র্যান্ড');
  });
  test('a hostile name is cut and handled in linear time', () => {
    const started = Date.now();
    entityKey(`${'a.'.repeat(500_000)}com`);
    entityKey('́'.repeat(1_000_000));
    assert.ok(Date.now() - started < 2000);
  });
});

describe('competitorBoard', () => {
  test('ranks rivals by shortlisted answers, then presence, and puts the brand first', () => {
    const answers = [
      row(0, 'chatgpt', { names: [['Canva', 1, 'recommended'], ['Buffer']] }),
      row(0, 'gemini', { names: [['Canva', 2, 'recommended'], ['Buffer']] }),
      row(1, 'chatgpt', { names: [['Buffer'], ['Jasper', 1, 'recommended']] }),
    ];
    const board = competitorBoard({ answers, brandName: 'Acme Widgets' });
    assert.deepEqual(
      board.rows.map((r) => r.name),
      ['Acme Widgets', 'Canva', 'Jasper', 'Buffer'],
    );
    assert.equal(board.rows[0].isBrand, true);
    const canva = board.rows[1];
    assert.equal(canva.presence, 2);
    assert.equal(canva.shortlisted, 2);
    assert.equal(canva.presencePct, 67);
    assert.equal(board.basis, 3);
  });

  test('share of voice is a business’s mentions out of everyone’s, hidden businesses included', () => {
    const names = Array.from({ length: MAX_COMPETITORS + 3 }, (_, i) => [`Rival ${i}`]);
    const answers = [row(0, 'chatgpt', { brand: true, names })];
    const board = competitorBoard({ answers, brandName: 'Acme Widgets' });
    assert.equal(board.rows.length, MAX_COMPETITORS + 1);
    assert.equal(board.hidden, 3);
    // 1 brand mention + 13 rival mentions = 14 in all, so each is 1/14.
    assert.equal(board.totalMentions, 14);
    assert.equal(board.rows[0].shareOfVoice, 7);
  });

  test('"X AI" and "X" are one business only when both appear; a lone "X AI" stays as it is', () => {
    const together = competitorBoard({
      answers: [
        row(0, 'chatgpt', { names: [['Jasper'], ['Jasper AI']] }),
        row(1, 'chatgpt', { names: [['Jasper AI']] }),
        row(2, 'chatgpt', { names: [['Jasper']] }),
      ],
      brandName: 'Acme Widgets',
    });
    const jasper = together.rows.filter((r) => !r.isBrand);
    assert.equal(jasper.length, 1);
    assert.equal(jasper[0].name, 'Jasper');
    assert.equal(jasper[0].presence, 3, 'an answer naming both counts once');

    const alone = competitorBoard({
      answers: [row(0, 'chatgpt', { names: [['Canva AI']] })],
      brandName: 'Acme Widgets',
    });
    assert.equal(alone.rows[1].name, 'Canva AI');
  });

  test('the brand under another label is not its own rival', () => {
    const board = competitorBoard({
      answers: [
        row(0, 'chatgpt', { names: [['acmewidgets.com'], ['Acme Widgets Inc'], ['Bright']] }),
      ],
      brandName: 'Acme Widgets',
      domain: 'acmewidgets.com',
    });
    assert.deepEqual(
      board.rows.map((r) => r.name),
      ['Acme Widgets', 'Bright'],
    );
  });

  test('a business advised against is named but not shortlisted', () => {
    const board = competitorBoard({
      answers: [row(0, 'chatgpt', { names: [['Bright', 1, 'not_recommended']] })],
      brandName: 'Acme Widgets',
    });
    assert.equal(board.rows[1].presence, 1);
    assert.equal(board.rows[1].shortlisted, 0);
  });

  test('answers Claude did not read are left out of the base, never counted as "absent"', () => {
    const answers = [
      row(0, 'chatgpt', { names: [['Bright']] }),
      row(1, 'chatgpt', { status: 'failed' }),
      row(2, 'chatgpt', { brand_present: true, entities: null }),
    ];
    const board = competitorBoard({ answers, brandName: 'Acme Widgets' });
    assert.equal(board.basis, 1);
    assert.equal(board.rows[1].presencePct, 100);
  });

  test('nothing readable gives an empty board, not zeros', () => {
    const board = competitorBoard({
      answers: [row(0, 'chatgpt', { status: 'failed' })],
      brandName: 'Acme Widgets',
    });
    assert.deepEqual(board, { basis: 0, rows: [], hidden: 0, totalMentions: 0 });
  });

  test('when nobody is named at all, share of voice is unknown, not 0', () => {
    const board = competitorBoard({ answers: [row(0, 'chatgpt')], brandName: 'Acme Widgets' });
    assert.equal(board.rows[0].presence, 0);
    assert.equal(board.rows[0].shareOfVoice, null);
  });

  test('the brand’s own site cited counts as presence', () => {
    const board = competitorBoard({
      answers: [row(0, 'chatgpt', { citations: [{ url: 'https://acme.test', isOwn: true }] })],
      brandName: 'Acme Widgets',
    });
    assert.equal(board.rows[0].presence, 1);
  });
});

describe('reportStats', () => {
  test('counts readable answers only, and says how many could not be read', () => {
    const answers = [
      ...[0, 1, 2, 3].map((i) => row(i, 'chatgpt', { brand: i < 1 })),
      row(0, 'gemini', { status: 'failed' }),
      row(0, 'google_aio', { status: 'no_answer' }),
    ];
    const stats = reportStats({ answers, questions: prompts.slice(0, 4), board: { rows: [] } });
    assert.equal(stats.known, 4);
    assert.equal(stats.mentioned, 1);
    assert.equal(stats.mentionRate, 25);
    assert.equal(stats.unreadable, 1);
    assert.equal(stats.noOverview, 1);
  });

  test('a question is missed when the brand is absent from at least half its readable answers', () => {
    const answers = [
      // question 0: absent in 2 of 4 readable -> missed
      row(0, 'chatgpt', { brand: true }),
      row(0, 'perplexity', { brand: true }),
      row(0, 'gemini'),
      row(0, 'google_aio'),
      // question 1: absent in 1 of 4 -> not missed
      row(1, 'chatgpt', { brand: true }),
      row(1, 'perplexity', { brand: true }),
      row(1, 'gemini', { brand: true }),
      row(1, 'google_aio'),
      // question 2: nothing readable -> not counted either way
      row(2, 'chatgpt', { status: 'failed' }),
      row(2, 'gemini', { status: 'failed' }),
    ];
    const stats = reportStats({ answers, questions: prompts.slice(0, 3), board: { rows: [] } });
    assert.equal(stats.questionsConsidered, 2);
    assert.equal(stats.questionsMissed, 1);
  });

  test('with nothing readable every figure is null, never 0', () => {
    const answers = all((i, e) => row(i, e, { status: 'failed' }));
    const stats = reportStats({ answers, questions: prompts, board: { rows: [] } });
    assert.equal(stats.mentionRate, null);
    assert.equal(stats.questionsConsidered, 0);
    assert.equal(stats.topCompetitor, null);
  });

  test('the top competitor is the board’s first rival, and null when nobody was named', () => {
    const named = reportFigures({
      answers: all((i, e) => row(i, e, { names: [['Bright', 1, 'recommended']] })),
      questions: prompts,
      brandName: 'Acme Widgets',
    });
    assert.equal(named.stats.topCompetitor.name, 'Bright');
    assert.equal(named.stats.topCompetitor.presence, 20);
    const none = reportFigures({
      answers: all((i, e) => row(i, e)),
      questions: prompts,
      brandName: 'Acme Widgets',
    });
    assert.equal(none.stats.topCompetitor, null);
    assert.equal(none.stats.mentionRate, 0, 'readable and all absent is a real 0%');
  });
});

describe('answerGrid', () => {
  test('one row per question, one cell per engine, in the engines’ order', () => {
    const answers = all((i, e) => row(i, e, { brand: e === 'chatgpt' }));
    const grid = answerGrid({ answers, questions: prompts });
    assert.deepEqual(
      grid.engines.map((e) => e.code),
      ENGINES,
    );
    assert.equal(grid.rows.length, 5);
    assert.equal(grid.rows[0].question, 'Question 0?');
    assert.deepEqual(
      grid.rows[0].cells.map((c) => c.state),
      ['present', 'absent', 'absent', 'absent'],
    );
    assert.equal(grid.rows[0].cells[0].link, '#answer-0-chatgpt');
  });

  test('a failed cell, a missing cell and a no-overview cell are never "not mentioned"', () => {
    const answers = [
      row(0, 'chatgpt', { status: 'failed' }),
      row(0, 'google_aio', { status: 'no_answer' }),
    ];
    const grid = answerGrid({ answers, questions: prompts.slice(0, 1) });
    const [chatgpt, perplexity, gemini, aio] = grid.rows[0].cells;
    assert.deepEqual([chatgpt.status, chatgpt.mentioned], ['unknown', undefined]);
    assert.equal(perplexity.status, 'unknown', 'no row at all');
    assert.equal(gemini.status, 'unknown');
    assert.equal(aio.status, 'no_overview');
    assert.equal(chatgpt.link, null);
  });

  test('an answer with no stored question text still gets a row', () => {
    const grid = answerGrid({ answers: [row(3, 'chatgpt')], questions: [] });
    assert.equal(grid.rows[0].question, 'Question 4');
  });
});
