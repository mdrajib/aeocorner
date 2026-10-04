import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { amountsIn, checkFacts, statedFacts } from './entity-accuracy.js';

const kit = ({
  year = '2014',
  hq = 'Austin, Texas',
  prices = ['From $199/month', '$1,299 one-time'],
} = {}) => ({
  entity: { foundingYear: year, headquarters: hq, profiles: [], wikidataId: '' },
  offerings: {
    items: prices.map((price, i) => ({ name: `Plan ${i}`, url: '', description: '', price })),
  },
});
const claim = (value, attribute = 'company_fact', engineCode = 'chatgpt', id = 1) => ({
  id,
  engineCode,
  attribute,
  value,
});
const factOf = (result, key) => result.facts.find((f) => f.key === key);

describe('only what the customer stated is checked', () => {
  test('a fact left empty is not compared at all', () => {
    const r = checkFacts({
      kit: kit({ year: '', hq: '', prices: [''] }),
      claims: [claim('founded in 1999')],
      answersRead: 5,
    });
    assert.deepEqual(r.facts, []);
  });

  test('prices come from the offerings, with thousands separators and decimals', () => {
    assert.deepEqual(
      amountsIn('From $1,299.50 or £49 per month, USD 20, 5 dollars'),
      [1299.5, 49, 20],
    );
    assert.deepEqual(
      [...statedFacts(kit()).price].sort((a, b) => a - b),
      [199, 1299],
    );
  });
});

describe('founded', () => {
  test('a year that matches is right, one that does not is wrong', () => {
    const r = checkFacts({
      kit: kit(),
      claims: [
        claim('The company was founded in 2014.'),
        claim('Established in 2011 in Texas', 'company_fact', 'gemini', 2),
      ],
      answersRead: 4,
    });
    const f = factOf(r, 'founded');
    assert.deepEqual([f.status, f.right, f.wrong], ['wrong', 1, 1]);
    assert.deepEqual(f.engines, {
      chatgpt: { right: 1, wrong: 0 },
      gemini: { right: 0, wrong: 1 },
    });
    assert.deepEqual(f.examples, [{ engine: 'gemini', said: 'Established in 2011 in Texas' }]);
  });

  test('a sentence with a year that is not about founding says nothing', () => {
    const r = checkFacts({
      kit: kit(),
      claims: [claim('Won an award in 2019'), claim('Open since Monday')],
      answersRead: 3,
    });
    assert.equal(factOf(r, 'founded').status, 'not_mentioned');
  });
});

describe('headquarters', () => {
  test('shares a word with the customer’s place: right; shares none: wrong', () => {
    const r = checkFacts({
      kit: kit(),
      claims: [
        claim('Based in the Austin area', 'location', 'perplexity', 1),
        claim('headquartered in Denver, Colorado', 'location', 'gemini', 2),
        claim('located in Texas', 'location', 'chatgpt', 3),
      ],
      answersRead: 3,
    });
    const f = factOf(r, 'headquarters');
    assert.deepEqual([f.status, f.right, f.wrong], ['wrong', 2, 1]);
    assert.equal(f.examples[0].engine, 'gemini');
  });

  test('"founded in 2014" is not a place', () => {
    const r = checkFacts({ kit: kit(), claims: [claim('founded in 2014')], answersRead: 1 });
    assert.equal(factOf(r, 'headquarters').status, 'not_mentioned');
  });
});

describe('price', () => {
  test('any matching amount is right; only pricing claims count', () => {
    const r = checkFacts({
      kit: kit(),
      claims: [
        claim('Plans start at $199/month', 'pricing', 'chatgpt', 1),
        claim('$199 setup plus $49/month', 'pricing', 'gemini', 2),
        claim('Costs $349/month', 'pricing', 'perplexity', 3),
        claim('Costs $349/month', 'feature', 'perplexity', 4),
        claim('Free to start', 'pricing', 'chatgpt', 5),
      ],
      answersRead: 4,
    });
    const f = factOf(r, 'price');
    assert.deepEqual([f.status, f.right, f.wrong], ['wrong', 2, 1]);
    assert.equal(f.expected, '$199, $1,299');
  });
});

describe('what "not mentioned" means', () => {
  test('is only said when answers were read; with none read it is unknown', () => {
    assert.equal(
      factOf(checkFacts({ kit: kit(), claims: [], answersRead: 6 }), 'founded').status,
      'not_mentioned',
    );
    assert.equal(
      factOf(checkFacts({ kit: kit(), claims: [], answersRead: 0 }), 'founded').status,
      'unknown',
    );
  });

  test('is deterministic whatever order the claims arrive in', () => {
    const claims = [1, 2, 3, 4, 5].map((n) =>
      claim(`Founded in 20${10 + n}`, 'company_fact', n % 2 ? 'chatgpt' : 'gemini', n),
    );
    const a = checkFacts({ kit: kit(), claims, answersRead: 5 });
    const b = checkFacts({ kit: kit(), claims: [...claims].reverse(), answersRead: 5 });
    assert.deepEqual(a, b);
    assert.equal(factOf(a, 'founded').examples.length, 3);
  });
});

describe('hostile claim text', () => {
  test('long and repetitive claims are read in bounded time', () => {
    const nasty = [
      'founded '.repeat(60),
      'based in '.repeat(60),
      '$'.repeat(500),
      `${'founded in x'.repeat(40)}1999`,
    ];
    const start = Date.now();
    for (let i = 0; i < 200; i += 1) {
      checkFacts({
        kit: kit(),
        claims: nasty.map((v) => claim(v.slice(0, 500), 'pricing')),
        answersRead: 1,
      });
    }
    assert.ok(Date.now() - start < 5000, 'loose bound: only meant to catch runaway matching');
  });
});
