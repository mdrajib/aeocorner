import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  checkCoverage,
  checkQuestion,
  mentionsBrand,
  namingProblem,
  nearDuplicates,
  normalizeQuestion,
  questionHash,
  similarity,
} from './prompt-rules.js';

const set = (mix) =>
  Object.entries(mix).flatMap(([intent, n]) =>
    Array.from({ length: n }, (_, i) => ({ intent, text: `${intent} ${i}` })),
  );

describe('normalizing and hashing', () => {
  test('wording that differs only in case, punctuation or spacing is the same question', () => {
    const a = 'What’s the BEST family dentist in Austin?';
    const b = '  whats the best   family dentist in austin ';
    assert.equal(normalizeQuestion(a), normalizeQuestion(b));
    assert.deepEqual(questionHash(a), questionHash(b));
    assert.notDeepEqual(questionHash(a), questionHash('best dentist in Dallas'));
    assert.equal(questionHash(a).length, 32);
  });
});

describe('near duplicates', () => {
  test('flags a rewording but not an unrelated question, and never the identical one', () => {
    const existing = [
      { id: 1, text: 'best family dentist in Austin' },
      { id: 2, text: 'how do I whiten my teeth at home' },
      { id: 3, text: 'Best family dentist in Austin?' },
    ];
    const found = nearDuplicates('best family dentist austin tx', existing);
    assert.deepEqual(
      found.map((f) => f.id),
      [1, 3],
    );
    assert.deepEqual(nearDuplicates('best family dentist in Austin', existing), []);
    assert.ok(similarity('abc def', 'xyz uvw') < 0.2);
    assert.equal(similarity('', 'x'), 0);
  });

  test('is linear: a very long question finishes at once', () => {
    const long = 'word '.repeat(20_000);
    const t = Date.now();
    similarity(long, long + 'x');
    assert.ok(Date.now() - t < 2_000);
  });
});

describe('checkQuestion', () => {
  test('accepts and tidies a real question', () => {
    assert.deepEqual(checkQuestion('  Which   dentist is best? '), {
      ok: true,
      text: 'Which dentist is best?',
    });
  });

  test('refuses blank, one-word, over-long, control-character and non-string input', () => {
    for (const bad of [
      '',
      '   ',
      'dentist',
      'x'.repeat(1001),
      'best dentist\u0000 now',
      null,
      42,
      {},
    ]) {
      assert.equal(checkQuestion(bad).ok, false, String(bad));
    }
  });
});

describe('naming the brand', () => {
  const names = ['Acme Dental', 'Acme'];

  test('finds whole names only', () => {
    assert.equal(mentionsBrand('Is acme dental good?', names), true);
    assert.equal(mentionsBrand('Is the Acmeville clinic good?', names), false);
    assert.equal(mentionsBrand('anything', []), false);
  });

  test('discovery and problem questions must not name it; comparison and brand questions must', () => {
    assert.match(
      namingProblem({ intent: 'discovery', text: 'Is Acme the best dentist?' }, names),
      /names your brand/,
    );
    assert.equal(
      namingProblem({ intent: 'discovery', text: 'Best dentist in Austin?' }, names),
      null,
    );
    assert.match(
      namingProblem({ intent: 'brand', text: 'Is this dentist good?' }, names),
      /should name/,
    );
    assert.equal(
      namingProblem({ intent: 'comparison', text: 'Acme vs Rival for implants?' }, names),
      null,
    );
    assert.equal(namingProblem({ intent: 'local', text: 'Acme near me?' }, names), null);
    assert.equal(namingProblem({ intent: 'discovery', text: 'x' }, []), null);
  });
});

describe('intent coverage', () => {
  test('a balanced set of 30 passes', () => {
    const r = checkCoverage(
      set({ discovery: 10, comparison: 5, problem_solution: 8, brand: 5, transactional: 2 }),
    );
    assert.equal(r.ok, true, r.problems.join(' | '));
    assert.equal(r.total, 30);
  });

  test('says how many to add when the set is small or lopsided', () => {
    const r = checkCoverage(set({ discovery: 20 }));
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => /Add 5 more:/.test(p)));
    assert.ok(r.problems.some((p) => /comparing/.test(p)));
    assert.ok(r.problems.some((p) => /brand/.test(p)));
  });

  test('a set over the maximum is told how many to remove', () => {
    const r = checkCoverage(
      set({ discovery: 20, comparison: 10, problem_solution: 15, brand: 10 }),
    );
    assert.ok(r.problems.some((p) => /5 more than the 50 allowed/.test(p)));
  });

  test('a business with a city needs a local question', () => {
    const base = set({
      discovery: 10,
      comparison: 5,
      problem_solution: 8,
      brand: 5,
      transactional: 2,
    });
    assert.equal(checkCoverage(base, { hasCity: true }).ok, false);
    assert.equal(
      checkCoverage([...base, { intent: 'local', text: 'x' }], { hasCity: true }).ok,
      true,
    );
  });

  test('an unknown intent is ignored, not counted', () => {
    assert.equal(checkCoverage([{ intent: 'nonsense', text: 'x' }]).total, 0);
  });
});
