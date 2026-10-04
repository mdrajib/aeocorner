import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CHECKS } from '../crawler/readiness/rubric.js';
import { READINESS_GUIDANCE } from './fix-list.js';
import {
  adviceTextFor,
  DEFAULT_ENGINE_LABELS,
  factsFor,
  findUnsupported,
  templateNarrative,
  TEMPLATE_VERSION,
} from './narrative.js';
import { RULES } from './recommendations.js';

const context = {
  brandName: 'Data Dental',
  domain: 'datadental.com',
  engineLabel: (code) => DEFAULT_ENGINE_LABELS[code] ?? code,
};

const readiness = (code, over = {}) => ({
  type: 'readiness',
  scanId: '9',
  check: {
    code,
    title: CHECKS[code].title,
    status: 'fail',
    points: 0,
    possible: CHECKS[code].points,
    summary: '',
    ...over,
  },
});
const lost = {
  type: 'lost_prompt',
  promptId: '1',
  question: 'Best family dentist in Austin?',
  answersRead: 10,
  brandMentions: 0,
  engines: ['chatgpt', 'perplexity'],
  competitors: [
    { name: 'Rival Dental', k: 6 },
    { name: 'Other Dental', k: 1 },
  ],
};
const cited = {
  type: 'cited_source',
  domain: 'reddit.com',
  siteType: 'Forum',
  timesCited: 6,
  answersCiting: 5,
  answersWithoutBrand: 4,
};
const cool = { type: 'sentiment', average: -1, answers: 10 };
const wrongFact = {
  type: 'entity_fact',
  fact: 'founded',
  label: 'Year founded',
  expected: '2014',
  wrong: 3,
  right: 1,
  answersRead: 8,
  examples: [{ engine: 'chatgpt', said: 'The company was founded in 2011.' }],
};
const badProfile = {
  type: 'entity_profile',
  platform: 'linkedin',
  platformLabel: 'LinkedIn',
  url: 'https://www.linkedin.com/company/data-dental',
  finding: 'brand_not_named',
  reachable: true,
  namesBrand: false,
  linksBack: false,
};
const noItem = {
  type: 'entity_wikidata',
  finding: 'not_in_wikidata',
  candidates: 0,
  givenId: null,
  item: null,
};

const narrativeFor = (ruleCode, evidence) => {
  const rule = RULES[ruleCode];
  return templateNarrative({ ruleCode, category: rule.category, evidence }, context);
};
const problems = (ruleCode, evidence, narrative = narrativeFor(ruleCode, evidence)) =>
  findUnsupported(
    narrative,
    factsFor(evidence, context),
    adviceTextFor(ruleCode, evidence),
    context,
  );

describe('facts', () => {
  test('a readiness fact says what was checked and how many points it earned', () => {
    const facts = factsFor(
      readiness('C1', { points: 3, summary: 'Organization schema has no logo.' }),
      context,
    );
    assert.equal(facts.length, 2);
    assert.match(facts[0].text, /datadental\.com/);
    assert.match(facts[0].text, /earned 3 of 6 points/);
    assert.match(facts[1].text, /Organization schema has no logo\./);
  });

  test('a lost question names the engines, the answers read and who was named instead', () => {
    const [first, second] = factsFor(lost, context);
    assert.match(first.text, /10 answers from ChatGPT and Perplexity/);
    assert.match(first.text, /Data Dental was not named in any of them/);
    assert.match(second.text, /Rival Dental \(6 times\) and Other Dental \(1 time\)/);
  });

  test('evidence of a kind we do not know has no facts, so nothing can be said', () => {
    assert.deepEqual(factsFor({ type: 'mystery' }, context), []);
    assert.deepEqual(factsFor(null, context), []);
  });
});

describe('the template narrative', () => {
  test('is versioned, with a why and numbered steps', () => {
    const n = narrativeFor('readiness.A1', readiness('A1'));
    assert.equal(n.version, TEMPLATE_VERSION);
    assert.match(n.why, /earned 0 of 8 points/);
    assert.match(n.steps, /^1\. /);
    assert.match(n.steps, /\n2\. /);
  });

  test('says nothing the evidence does not say: every rule, every kind of evidence', () => {
    const cases = [
      ...Object.keys(READINESS_GUIDANCE).map((code) => [
        `readiness.${code}`,
        readiness(code, { points: 1, summary: 'Seen on 3 pages.' }),
      ]),
      ['visibility.lost_prompt', lost],
      ['visibility.cited_source', cited],
      ['visibility.hedged', cool],
      ['entity.wrong_fact', wrongFact],
      ['entity.profile', badProfile],
      ['entity.wikidata', noItem],
    ];
    assert.equal(cases.length, Object.keys(RULES).length);
    for (const [ruleCode, evidence] of cases) {
      assert.deepEqual(problems(ruleCode, evidence), [], ruleCode);
    }
  });

  test('uses the rule’s own fixed advice for the steps, including its figures', () => {
    // E2's advice says "60 words or fewer": a figure about advice, not about the customer.
    const n = narrativeFor('readiness.E2', readiness('E2'));
    assert.match(n.steps, /60 words/);
    assert.deepEqual(problems('readiness.E2', readiness('E2'), n), []);
  });
});

describe('the check finds what the evidence does not support', () => {
  const evidence = lost;
  const good = narrativeFor('visibility.lost_prompt', evidence);

  test('a number that is not in the evidence', () => {
    const bad = { ...good, why: `${good.why} Rival Dental was named 9 times.` };
    const found = problems('visibility.lost_prompt', evidence, bad);
    assert.deepEqual(
      found.map((f) => [f.kind, f.value]),
      [['number', '9']],
    );
  });

  test('a derived figure is not a fact either', () => {
    // 6 of 10 is 60%: the evidence has 6 and 10 but never 60.
    const bad = { ...good, why: 'Rival Dental took 60% of the answers.' };
    assert.deepEqual(
      problems('visibility.lost_prompt', evidence, bad).map((f) => f.value),
      ['60'],
    );
  });

  test('a site that is not in the evidence', () => {
    const bad = { ...good, why: `${good.why} Yelp.com ranks you last.` };
    assert.ok(
      problems('visibility.lost_prompt', evidence, bad).some(
        (f) => f.kind === 'site' && f.value === 'yelp.com',
      ),
    );
  });

  test('a quoted phrase that is not in the evidence', () => {
    const bad = { ...good, why: 'Engines call you “the cheapest dentist”.' };
    assert.ok(problems('visibility.lost_prompt', evidence, bad).some((f) => f.kind === 'quote'));
  });

  test('a business name that is not in the evidence', () => {
    const bad = { ...good, why: 'Engines recommend Smile Direct instead.' };
    assert.ok(
      problems('visibility.lost_prompt', evidence, bad).some(
        (f) => f.kind === 'name' && f.value === 'Direct',
      ),
    );
  });

  test('the why may not borrow the steps’ advice figures, but the steps may', () => {
    const e = readiness('E2');
    const n = narrativeFor('readiness.E2', e);
    const bad = { ...n, why: 'Your answers are 60 words too long.' };
    assert.deepEqual(
      problems('readiness.E2', e, bad).map((f) => `${f.where}:${f.value}`),
      ['why:60'],
    );
  });

  test('common terms, the brand name, its site and the files engines read are fine', () => {
    const e = readiness('A1');
    const fine = {
      why: 'Data Dental’s robots.txt keeps ChatGPT and Perplexity out of datadental.com, so Google AI Overviews cannot quote it.',
      steps: '1. Edit robots.txt and allow the crawlers. Then press “Mark as done”.',
    };
    assert.deepEqual(problems('readiness.A1', e, fine), []);
  });

  test('a figure with a minus sign is the same figure', () => {
    const e = cool;
    const n = narrativeFor('visibility.hedged', e);
    assert.deepEqual(problems('visibility.hedged', e, n), []);
    assert.match(n.why, /-1 on a scale from -2/);
  });
});
