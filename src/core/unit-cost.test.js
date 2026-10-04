import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TARGETS, auditCost, describe, promptRunCost } from './unit-cost.js';

test('collection and extraction are summed and divided by the prompt-runs; other spend is kept apart', () => {
  const r = promptRunCost(
    [
      { meter: 'answer_collect', costMicros: 290_000 },
      { meter: 'serp', costMicros: 100_000 },
      { meter: 'llm_extract', costMicros: 600_000 },
      { meter: 'llm_content', costMicros: 5_000_000 },
    ],
    10,
  );
  assert.equal(r.collectionMicros, 390_000);
  assert.equal(r.extractionMicros, 600_000);
  assert.equal(r.otherMicros, 5_000_000);
  assert.equal(r.perPromptRunMicros, 99_000);
  assert.equal(r.collectionPerMicros, 39_000);
  assert.equal(r.extractionPerMicros, 60_000);
  assert.equal(r.verdict, 'met');
});

test('the target is inclusive, and one micro-dollar over misses it', () => {
  assert.equal(
    promptRunCost([{ meter: 'llm_extract', costMicros: TARGETS.promptRunMicros * 4 }], 4).verdict,
    'met',
  );
  assert.equal(
    promptRunCost([{ meter: 'llm_extract', costMicros: TARGETS.promptRunMicros * 4 + 4 }], 4)
      .verdict,
    'missed',
  );
});

test('with no prompt-runs nothing is claimed: unknown, never zero and never met', () => {
  const r = promptRunCost([{ meter: 'answer_collect', costMicros: 1_000 }], 0);
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.perPromptRunMicros, null);
  assert.equal(auditCost({ audits: 0, costMicros: 0 }).verdict, 'unknown');
});

test('an audit is held to the target on average and for the worst one', () => {
  assert.equal(
    auditCost({ audits: 10, costMicros: 5_000_000, worstMicros: 700_000 }).verdict,
    'met',
  );
  assert.equal(
    auditCost({ audits: 10, costMicros: 5_000_000, worstMicros: 900_000 }).verdict,
    'missed',
  );
  assert.equal(
    auditCost({ audits: 10, costMicros: 8_000_000, worstMicros: 800_000 }).verdict,
    'missed',
  );
});

test('the sentences carry the figures and the verdict', () => {
  const p = describe(
    'prompt-run',
    promptRunCost([{ meter: 'llm_extract', costMicros: 1_600_000 }], 10),
  );
  assert.match(p, /\$0\.1600 each over 10/);
  assert.match(p, /missed/);
  assert.match(
    describe('audit', auditCost({ audits: 2, costMicros: 1_000_000 })),
    /\$0\.5000 each over 2.*met/,
  );
  assert.match(describe('audit', auditCost({ audits: 0, costMicros: 0 })), /nothing measured/);
});
