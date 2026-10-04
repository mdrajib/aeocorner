import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BAD_NARRATIVES, CORPUS } from '../../evals/narrative/corpus.js';
import { evaluateBadNarratives, evaluateTemplates } from '../../evals/narrative/run.js';
import { RULE_CODES } from './recommendations.js';

/**
 * The narrative eval's offline half, run with the unit tests (Milestone 6, task 6.04 and its Definition of Done: "no
 * narrative states a fact absent from its evidence"). The model's half is `npm run eval:narrative -- --live`.
 */
describe('the narrative eval', () => {
  test('the corpus has every rule, and every kind of evidence', () => {
    assert.deepEqual([...new Set(CORPUS.map((c) => c.ruleCode))].sort(), [...RULE_CODES].sort());
    assert.ok(CORPUS.length >= 50);
    assert.deepEqual([...new Set(CORPUS.map((c) => c.evidence.type))].sort(), [
      'cited_source',
      'lost_prompt',
      'readiness',
      'sentiment',
    ]);
  });

  test('no template narrative states a fact absent from its evidence', () => {
    const { cases, failures } = evaluateTemplates();
    assert.ok(cases >= 50);
    assert.deepEqual(failures, []);
  });

  test('every made-up narrative is flagged, for the right reason', () => {
    const { cases, missed } = evaluateBadNarratives();
    assert.equal(cases, BAD_NARRATIVES.length);
    assert.deepEqual(missed, []);
  });
});
