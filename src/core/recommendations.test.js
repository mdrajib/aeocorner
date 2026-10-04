import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CHECKS } from '../crawler/readiness/rubric.js';
import { READINESS_GUIDANCE } from './fix-list.js';
import {
  evaluateRules,
  hasEvidence,
  LIMITS,
  RULE_CODES,
  RULES,
  scoreCandidates,
  stableKeyOf,
  urlsIn,
} from './recommendations.js';

const check = (code, status, points, extra = {}) => ({
  code,
  status,
  points,
  possible: CHECKS[code].points,
  summary: '',
  evidence: {},
  ...extra,
});

const prompts = [
  { id: '1', text: 'Best family dentist in Austin?', priority: 3 },
  { id: '2', text: 'How do I fix a chipped tooth?', priority: 2 },
  { id: '3', text: 'Is Data Dental good?', priority: 1 },
];

const cell = (engineCode, nOk, brandK, rivals = [], status = 'complete') => ({
  engineCode,
  status,
  nOk,
  brandK,
  rivals,
});

const base = { brandName: 'Data Dental', prompts, enginesCount: 4 };

describe('the rule table', () => {
  test('every readiness check that can be a fix has a rule, and nothing else does', () => {
    const readiness = RULE_CODES.filter((c) => c.startsWith('readiness.')).map(
      (c) => c.split('.')[1],
    );
    const fixable = Object.keys(READINESS_GUIDANCE);
    assert.deepEqual([...readiness].sort(), [...fixable].sort());
    for (const code of readiness) assert.ok(CHECKS[code], code);
  });

  test('every rule is one of the schema’s categories and fix paths, with a prior and an effort', () => {
    const categories = [
      'crawler_access',
      'renderability',
      'structured_data',
      'entity',
      'content_new',
      'content_refresh',
      'offsite_presence',
      'reputation',
      'technical',
    ];
    for (const [code, rule] of Object.entries(RULES)) {
      assert.ok(categories.includes(rule.category), code);
      assert.ok(['auto_fix', 'content', 'guidance'].includes(rule.fixPath), code);
      assert.ok(rule.prior > 0 && rule.prior < 1, code);
      assert.ok(Number.isInteger(rule.effort) && rule.effort >= 1 && rule.effort <= 5, code);
    }
    // MVP F7: automatic = 1, content = 3, off-site = 5.
    assert.equal(RULES['readiness.A1'].effort, 1);
    assert.equal(RULES['visibility.lost_prompt'].effort, 3);
    assert.equal(RULES['visibility.cited_source'].effort, 5);
  });
});

describe('readiness rules', () => {
  const scan = {
    id: 9n,
    finishedAt: '2026-10-01T10:00:00Z',
    checks: [
      check('A1', 'fail', 0, {
        summary: 'robots.txt blocks OAI-SearchBot',
        evidence: { blocked: ['https://x.com/a'] },
      }),
      check('C1', 'partial', 3),
      check('B1', 'error', 0), // we could not look
      check('D2', 'not_applicable', 0),
      check('A2', 'fail', 0), // informational: a business choice
      check('F3', 'pass', 3),
    ],
  };

  test('a failed or partial check is an issue; an error, "does not apply", informational and a pass are not', () => {
    const { candidates, evaluated } = evaluateRules({ ...base, scan });
    assert.deepEqual(candidates.map((c) => c.stableKey).sort(), [
      'readiness.A1:a1',
      'readiness.C1:c1',
    ]);
    assert.equal(evaluated.readiness, true);
  });

  test('the key is the rule and the subject, so it never changes between runs', () => {
    const first = evaluateRules({ ...base, scan }).candidates.map((c) => c.stableKey);
    const again = evaluateRules({
      ...base,
      scan: { ...scan, id: 10n, finishedAt: '2026-10-08T10:00:00Z' },
    }).candidates.map((c) => c.stableKey);
    assert.deepEqual(again, first);
    assert.equal(
      stableKeyOf('visibility.cited_source', 'Reddit.com'),
      'visibility.cited_source:reddit.com',
    );
  });

  test('severity is the share of the check’s points that were lost', () => {
    const { candidates } = evaluateRules({ ...base, scan });
    const bySubject = Object.fromEntries(candidates.map((c) => [c.subject, c]));
    assert.equal(bySubject.A1.severity, 1);
    assert.equal(bySubject.C1.severity, 0.5); // 3 of 6 lost
  });

  test('evidence says which scan and which check, and the pages the check named', () => {
    const a1 = evaluateRules({ ...base, scan }).candidates.find((c) => c.subject === 'A1');
    assert.equal(a1.evidence.type, 'readiness');
    assert.equal(a1.evidence.scanId, '9');
    assert.equal(a1.evidence.check.code, 'A1');
    assert.equal(a1.evidence.check.status, 'fail');
    assert.deepEqual(a1.affectedUrls, ['https://x.com/a']);
    assert.deepEqual(a1.promptIds, ['1', '2', '3']);
  });

  test('no scan, or a scan with nothing evaluated, says readiness was not evaluated', () => {
    assert.equal(evaluateRules({ ...base, scan: null }).evaluated.readiness, false);
    assert.equal(
      evaluateRules({ ...base, scan: { id: 1n, checks: [] } }).evaluated.readiness,
      false,
    );
    const onlyErrors = { id: 1n, checks: [check('A1', 'error', 0)] };
    const result = evaluateRules({ ...base, scan: onlyErrors });
    assert.deepEqual(result.candidates, []);
  });

  test('urlsIn reads addresses out of arrays and objects, once each, at most 20', () => {
    const many = Array.from({ length: 30 }, (_, i) => `https://x.com/${i}`);
    assert.equal(urlsIn({ pages: many }).length, 20);
    assert.deepEqual(
      urlsIn({ a: ['https://x.com/1', { url: 'https://x.com/2' }, 'nope', 'https://x.com/1'] }),
      ['https://x.com/1', 'https://x.com/2'],
    );
    assert.deepEqual(urlsIn(null), []);
  });
});

describe('lost questions', () => {
  const rivals = [
    { name: 'Rival Dental', k: 4 },
    { name: 'Other Dental', k: 1 },
  ];

  test('competitors named, the brand never, on complete cells: a lost question', () => {
    const grid = [
      {
        promptId: '1',
        text: prompts[0].text,
        priority: 3,
        engines: [
          cell('chatgpt', 5, 0, rivals),
          cell('perplexity', 5, 0, [{ name: 'Rival Dental', k: 2 }]),
        ],
      },
    ];
    const { candidates, evaluated } = evaluateRules({ ...base, grid });
    assert.equal(evaluated.visibility, true);
    assert.equal(candidates.length, 1);
    const c = candidates[0];
    assert.equal(c.stableKey, 'visibility.lost_prompt:1');
    assert.deepEqual(c.promptIds, ['1']);
    assert.equal(c.evidence.answersRead, 10);
    assert.deepEqual(c.evidence.competitors, [
      { name: 'Rival Dental', k: 6 },
      { name: 'Other Dental', k: 1 },
    ]);
    assert.deepEqual(c.evidence.engines, ['chatgpt', 'perplexity']);
  });

  test('a partial cell that names the brand means the question is not lost', () => {
    const grid = [
      {
        promptId: '1',
        text: 'q',
        priority: 1,
        engines: [cell('chatgpt', 5, 0, rivals), cell('gemini', 2, 1, [], 'partial')],
      },
    ];
    assert.deepEqual(evaluateRules({ ...base, grid }).candidates, []);
  });

  test('a partial cell that did NOT name the brand is not proof of absence', () => {
    const grid = [
      {
        promptId: '1',
        text: 'q',
        priority: 1,
        engines: [cell('chatgpt', 2, 0, rivals, 'partial')],
      },
    ];
    // Only partial cells: not enough complete answers to say the brand is absent.
    assert.deepEqual(evaluateRules({ ...base, grid }).candidates, []);
  });

  test('too few readable answers, or nobody named instead, is not a lost question', () => {
    const few = [
      { promptId: '1', text: 'q', priority: 1, engines: [cell('chatgpt', 2, 0, rivals)] },
    ];
    assert.deepEqual(evaluateRules({ ...base, grid: few }).candidates, []);
    const nobody = [
      { promptId: '1', text: 'q', priority: 1, engines: [cell('chatgpt', 5, 0, [])] },
    ];
    assert.deepEqual(evaluateRules({ ...base, grid: nobody }).candidates, []);
  });

  test('no readable answers at all: visibility was not evaluated, so nothing is "cleared"', () => {
    const grid = [
      { promptId: '1', text: 'q', priority: 1, engines: [cell('chatgpt', 0, 0, [], 'failed')] },
    ];
    assert.equal(evaluateRules({ ...base, grid }).evaluated.visibility, false);
    assert.equal(evaluateRules({ ...base, grid: null }).evaluated.visibility, false);
  });

  test('at most ten, most important first', () => {
    const grid = Array.from({ length: 14 }, (_, i) => ({
      promptId: String(i + 1),
      text: `q${i}`,
      priority: i < 4 ? 1 : 3,
      engines: [cell('chatgpt', 5, 0, rivals)],
    }));
    const { candidates, detectedKeys } = evaluateRules({ ...base, grid });
    assert.equal(candidates.length, LIMITS.lostQuestions);
    // The four left out are still found, so they are never mistaken for fixed ones.
    assert.equal(detectedKeys.length, 14);
    // priority 3 questions (ids 5-14) beat priority 1 (ids 1-4)
    assert.ok(candidates.every((c) => Number(c.subject) > 4));
  });
});

describe('cited sources and cool sentiment', () => {
  const grid = [{ promptId: '1', text: 'q', priority: 1, engines: [cell('chatgpt', 10, 3, [])] }];
  const gaps = [
    {
      domain: 'reddit.com',
      classLabel: 'Forum',
      timesCited: 6,
      answersCiting: 5,
      answersWithoutBrand: 4,
    },
    {
      domain: 'yelp.com',
      classLabel: 'Review site',
      timesCited: 3,
      answersCiting: 3,
      answersWithoutBrand: 1,
    },
    { domain: 'own.com', own: true, timesCited: 9, answersCiting: 9, answersWithoutBrand: 9 },
  ];

  test('a site cited in at least two answers that left the brand out, never the brand’s own', () => {
    const { candidates } = evaluateRules({ ...base, grid, citationGaps: gaps, answersTotal: 20 });
    const sites = candidates.filter((c) => c.ruleCode === 'visibility.cited_source');
    assert.deepEqual(
      sites.map((c) => c.subject),
      ['reddit.com'],
    );
    assert.equal(sites[0].reach.share, 0.2); // 4 of 20 answers
    assert.equal(sites[0].evidence.answersWithoutBrand, 4);
  });

  test('cool sentiment needs enough answers and an average at or below -0.5', () => {
    const run = (sentiment) =>
      evaluateRules({ ...base, grid, sentiment }).candidates.filter(
        (c) => c.ruleCode === 'visibility.hedged',
      );
    assert.equal(run({ n: 9, sum: -18 }).length, 0); // too few answers
    assert.equal(run({ n: 10, sum: -4 }).length, 0); // -0.4: not cool enough
    const hit = run({ n: 10, sum: -10 });
    assert.equal(hit.length, 1);
    assert.equal(hit[0].evidence.average, -1);
    assert.equal(hit[0].severity, 0.5);
  });
});

describe('evidence and scoring', () => {
  test('no candidate without evidence', () => {
    assert.equal(hasEvidence({ evidence: {} }), false);
    assert.equal(hasEvidence({ evidence: null }), false);
    assert.equal(hasEvidence({}), false);
    assert.equal(hasEvidence({ evidence: { type: 'readiness' } }), true);
  });

  test('every candidate the engine returns has evidence', () => {
    const scan = { id: 1n, checks: [check('A1', 'fail', 0), check('C1', 'fail', 0)] };
    const grid = [
      {
        promptId: '1',
        text: 'q',
        priority: 1,
        engines: [cell('chatgpt', 5, 0, [{ name: 'R', k: 2 }])],
      },
    ];
    for (const c of evaluateRules({ ...base, scan, grid }).candidates)
      assert.ok(hasEvidence(c), c.stableKey);
  });

  test('ICE ranks the easy site-wide fix above a hard narrow one, and ties break on the key', () => {
    const scan = { id: 1n, checks: [check('A1', 'fail', 0)] };
    const grid = [
      {
        promptId: '1',
        text: 'q',
        priority: 3,
        engines: [cell('chatgpt', 5, 0, [{ name: 'R', k: 2 }])],
      },
    ];
    const { candidates } = evaluateRules({ ...base, scan, grid });
    const scored = scoreCandidates(candidates, { prompts, enginesCount: 4 });
    // A1: impact 100 × 1 (severity) = 100, confidence 0.7, effort 1 → 70
    assert.equal(scored[0].stableKey, 'readiness.A1:a1');
    assert.equal(scored[0].impact, 100);
    assert.equal(scored[0].confidence, 0.7);
    assert.equal(scored[0].ice, 70);
    // lost question: priority 3 × 1 engine = 3 of (3+2+1)×4 = 24 → 12.5; 12.5 × 0.5 ÷ 3 = 2.083
    assert.equal(scored[1].impact, 12.5);
    assert.equal(scored[1].ice, 2.083);
  });

  test('closed-loop outcomes recalibrate a rule’s confidence', () => {
    const scan = { id: 1n, checks: [check('A1', 'fail', 0)] };
    const { candidates } = evaluateRules({ ...base, scan });
    const [plain] = scoreCandidates(candidates, { prompts, enginesCount: 4 });
    const [learned] = scoreCandidates(candidates, {
      prompts,
      enginesCount: 4,
      outcomes: { 'readiness.A1': { wins: 0, decided: 10 } },
    });
    assert.ok(learned.confidence < plain.confidence);
    assert.equal(learned.confidence, 0.35); // (7 + 0) / 20
  });

  test('the same findings in a different order give the same ranking', () => {
    const scan = {
      id: 1n,
      checks: [check('C1', 'fail', 0), check('A1', 'fail', 0), check('F3', 'fail', 0)],
    };
    const a = evaluateRules({ ...base, scan }).candidates;
    const b = evaluateRules({
      ...base,
      scan: { ...scan, checks: [...scan.checks].reverse() },
    }).candidates;
    const rank = (list) =>
      scoreCandidates(list, { prompts, enginesCount: 4 }).map((c) => c.stableKey);
    assert.deepEqual(rank(a), rank(b));
  });
});
