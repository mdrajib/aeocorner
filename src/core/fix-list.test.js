import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CHECKS } from '../crawler/readiness/rubric.js';
import { buildFixList, READINESS_GUIDANCE } from './fix-list.js';

const check = (code, status, points, summary = '') => ({
  code,
  status,
  points,
  possible: CHECKS[code].points,
  summary,
});

const answer = (engineCode, promptIdx, over = {}) => ({
  engineCode,
  promptIdx,
  status: 'ok',
  brandPresent: false,
  ...over,
});

describe('guidance', () => {
  test('every check that can be a fix has guidance, and informational checks have none', () => {
    for (const [code, def] of Object.entries(CHECKS)) {
      assert.equal(code in READINESS_GUIDANCE, !def.informational, code);
    }
    for (const g of Object.values(READINESS_GUIDANCE)) {
      assert.ok(g.title.length > 10 && g.how.length > 40);
    }
  });
});

describe('the fix list, against a hand-computed audit', () => {
  // Evaluated checks: A1 (8) + C1 (6) + E2 (6) + A2 (2) + F3 (3) = 25 possible. B1 errored and D2 does not apply,
  // so neither is in the 25. Readiness 60% of the AEO Score:
  //   A1 lost 8  -> 8/25 × 100 × 0.6 = 19.2      E2 lost 6 -> 14.4      C1 lost 3 -> 7.2
  const checks = [
    check('A1', 'fail', 0, 'robots.txt blocks OAI-SearchBot'),
    check('C1', 'partial', 3),
    check('E2', 'fail', 0),
    check('A2', 'fail', 0),
    check('B1', 'error', 0),
    check('D2', 'not_applicable', 0),
    check('F3', 'pass', 3),
  ];
  // Four readable answers, weight 1 each:
  const answers = [
    answer('chatgpt', 0, { competitorsNamed: ['Rival'], citedDomains: ['g2.com'] }),
    answer('gemini', 0, { competitorsNamed: ['Rival'], citedDomains: ['g2.com'] }),
    answer('chatgpt', 1, { brandPresent: true, brandRank: 1 }),
    answer('gemini', 1, { brandPresent: true, brandRank: 3, brandStance: 'cautioned' }),
  ];
  //   not-named        two absent answers, each worth 0.5 → 1.0 / 4 × 100 × 0.4 = 10
  //   competitor-ahead the same two answers → 10
  //   cited-source     g2.com in both → half of 10 = 5
  //   hedged           rank 3 would be 0.7, halved by the caution (loses 0.35) → 0.35 / 4 × 100 × 0.4 = 3.5
  const fixes = buildFixList({ checks, answers, brandName: 'Acme' });

  test('ranks by the points each could win back, ties by id, and keeps five', () => {
    assert.deepEqual(
      fixes.map((f) => [f.rank, f.id, f.impact]),
      [
        [1, 'check-A1', 19.2],
        [2, 'check-E2', 14.4],
        [3, 'competitor-ahead', 10],
        [4, 'not-named', 10],
        [5, 'check-C1', 7.2],
      ],
    );
  });

  test('with room for more, the smaller fixes follow', () => {
    const all = buildFixList({ checks, answers, brandName: 'Acme', limit: 10 });
    assert.deepEqual(all.map((f) => [f.id, f.impact]).slice(5), [
      ['cited-source', 5],
      ['hedged', 3.5],
    ]);
  });

  test('a failed informational check, an errored check and a check that does not apply are never fixes', () => {
    const ids = buildFixList({ checks, answers, brandName: 'Acme', limit: 20 }).map((f) => f.id);
    for (const never of ['check-A2', 'check-B1', 'check-D2', 'check-F3']) {
      assert.ok(!ids.includes(never), never);
    }
  });

  test('every fix links to its evidence: a check, or the answers it came from', () => {
    const [a1, , competitor, notNamed] = fixes;
    assert.deepEqual(a1.evidence, {
      type: 'check',
      checkCode: 'A1',
      status: 'fail',
      summary: 'robots.txt blocks OAI-SearchBot',
      points: 0,
      possible: 8,
    });
    assert.deepEqual(competitor.evidence, {
      type: 'answers',
      competitor: 'Rival',
      answers: [
        { promptIdx: 0, engineCode: 'chatgpt' },
        { promptIdx: 0, engineCode: 'gemini' },
      ],
    });
    assert.deepEqual(notNamed.evidence.engines, ['chatgpt', 'gemini']);
    assert.match(competitor.title, /Rival/);
    assert.match(notNamed.how, /2 of 4 answers/);
  });
});

describe('what is not a fix', () => {
  test('a site that passes everything and is named everywhere has nothing to fix', () => {
    const fixes = buildFixList({
      checks: [check('A1', 'pass', 8), check('C1', 'pass', 6)],
      answers: [answer('chatgpt', 0, { brandPresent: true, brandRank: 1 })],
      brandName: 'Acme',
    });
    assert.deepEqual(fixes, []);
  });

  test('answers that could not be read give no visibility fix: a failure is not "not named"', () => {
    const fixes = buildFixList({
      checks: [],
      answers: [
        answer('chatgpt', 0, { status: 'failed', brandPresent: null }),
        answer('gemini', 0, { status: 'pending', brandPresent: null }),
        answer('google_aio', 0, { status: 'no_answer', brandPresent: null }),
      ],
      brandName: 'Acme',
    });
    assert.deepEqual(fixes, []);
  });

  test('with no scan, the fixes come from the answers alone, and the other way round', () => {
    const fromAnswers = buildFixList({
      answers: [answer('chatgpt', 0)],
      brandName: 'Acme',
    });
    assert.deepEqual(
      fromAnswers.map((f) => f.id),
      ['not-named'],
    );
    const fromChecks = buildFixList({ checks: [check('E3', 'fail', 0)], brandName: 'Acme' });
    assert.deepEqual(
      fromChecks.map((f) => f.id),
      ['check-E3'],
    );
    assert.equal(fromChecks[0].impact, 60, 'the only evaluated check, all of readiness: 100 × 0.6');
  });

  test('a domain cited once is not a pattern; two answers are', () => {
    const once = buildFixList({
      answers: [
        answer('chatgpt', 0, { citedDomains: ['g2.com'] }),
        answer('gemini', 0, { citedDomains: ['capterra.com'] }),
      ],
      brandName: 'Acme',
    });
    assert.ok(!once.some((f) => f.id === 'cited-source'));
  });

  test('a competitor is the one named most often, ties broken by name', () => {
    const fixes = buildFixList({
      answers: [
        answer('chatgpt', 0, { competitorsNamed: ['Zed', 'Alpha'] }),
        answer('gemini', 0, { competitorsNamed: ['Zed', 'Alpha'] }),
        answer('chatgpt', 1, { competitorsNamed: ['Zed'] }),
      ],
      brandName: 'Acme',
    });
    const fix = fixes.find((f) => f.id === 'competitor-ahead');
    assert.equal(fix.evidence.competitor, 'Zed');
    assert.equal(fix.evidence.answers.length, 3);
  });
});
