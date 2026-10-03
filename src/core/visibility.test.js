import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { aeoScore, presenceValue, scoreVisibility } from './visibility.js';

const ans = (engineCode, promptIdx, over = {}) => ({
  engineCode,
  promptIdx,
  status: 'ok',
  brandPresent: false,
  ...over,
});

describe('presence of the brand in one answer', () => {
  test('follows the table in MVP §6.5', () => {
    assert.equal(presenceValue({ brandPresent: true, brandRank: 1 }), 1);
    assert.equal(presenceValue({ brandPresent: true, brandRank: 2 }), 0.85);
    assert.equal(presenceValue({ brandPresent: true, brandRank: 3 }), 0.7);
    assert.equal(presenceValue({ brandPresent: true, brandRank: 7 }), 0.5);
    assert.equal(presenceValue({ brandPresent: true, brandRank: null }), 0.5);
    assert.equal(presenceValue({ brandPresent: false, domainCited: true }), 0.25);
    assert.equal(presenceValue({ brandPresent: false }), 0);
  });

  test('a caution halves it; a citation never adds to a named brand', () => {
    assert.equal(
      presenceValue({ brandPresent: true, brandRank: 1, brandStance: 'cautioned' }),
      0.5,
    );
    assert.equal(
      presenceValue({ brandPresent: true, brandRank: 2, brandStance: 'not_recommended' }),
      0.425,
    );
    assert.equal(presenceValue({ brandPresent: true, brandRank: 1, domainCited: true }), 1);
  });
});

describe('the visibility score', () => {
  test('is the weighted mean of the readable answers, by hand', () => {
    // chatgpt: rank 1 (1.0, weight 1), absent (0, weight 1); gemini: rank 3 (0.7, weight 2)
    const result = scoreVisibility([
      ans('chatgpt', 0, { brandPresent: true, brandRank: 1 }),
      ans('chatgpt', 1),
      ans('gemini', 0, { brandPresent: true, brandRank: 3, priority: 2 }),
    ]);
    // (1×1 + 0×1 + 2×0.7) / (1 + 1 + 2) = 2.4 / 4 = 0.6
    assert.equal(result.score, 60);
    assert.deepEqual(result.perEngine.chatgpt, { score: 50, asked: 2, readable: 2, mentioned: 1 });
    assert.deepEqual(result.perEngine.gemini, { score: 70, asked: 1, readable: 1, mentioned: 1 });
    assert.equal(result.mentioned, 2);
  });

  test('engine weights shift the mean', () => {
    const answers = [ans('chatgpt', 0, { brandPresent: true, brandRank: 1 }), ans('gemini', 0)];
    assert.equal(scoreVisibility(answers).score, 50);
    assert.equal(scoreVisibility(answers, { engineWeights: { chatgpt: 3 } }).score, 75);
  });

  test('a failed or pending answer is left out, not counted as "not mentioned"', () => {
    const result = scoreVisibility([
      ans('chatgpt', 0, { brandPresent: true, brandRank: 1 }),
      ans('chatgpt', 1, { brandPresent: true, brandRank: 1 }),
      ans('gemini', 0, { status: 'pending', brandPresent: null }),
    ]);
    assert.equal(result.score, 100, 'the pending answer is not a 0');
    assert.equal(result.unreadable, 1);
  });

  test('with fewer than half of the answers readable there is no score, not a low one', () => {
    const result = scoreVisibility([
      ans('chatgpt', 0, { brandPresent: true, brandRank: 1 }),
      ans('chatgpt', 1, { status: 'failed', brandPresent: null }),
      ans('gemini', 0, { status: 'failed', brandPresent: null }),
      ans('gemini', 1, { status: 'failed', brandPresent: null }),
    ]);
    assert.equal(result.score, null);
    assert.equal(result.unreadable, 3);
    assert.equal(result.coverage, 0.25);
    assert.equal(result.perEngine.gemini.score, null);
  });

  test('exactly half readable still scores', () => {
    const result = scoreVisibility([
      ans('chatgpt', 0, { brandPresent: true, brandRank: 1 }),
      ans('chatgpt', 1, { status: 'failed', brandPresent: null }),
    ]);
    assert.equal(result.score, 100);
  });

  test('"no AI Overview shown" is its own result: it neither scores nor counts against coverage', () => {
    const result = scoreVisibility([
      ans('chatgpt', 0, { brandPresent: true, brandRank: 2 }),
      ans('google_aio', 0, { status: 'no_answer', brandPresent: null }),
    ]);
    assert.equal(result.score, 85);
    assert.equal(result.noAnswer, 1);
    assert.equal(result.unreadable, 0);
    assert.equal(result.coverage, 1);
  });

  test('nothing at all, or only no_answer, is null', () => {
    assert.equal(scoreVisibility([]).score, null);
    assert.equal(scoreVisibility([ans('google_aio', 0, { status: 'no_answer' })]).score, null);
  });

  test('a readable answer that names no brand scores 0, which is a real result', () => {
    assert.equal(scoreVisibility([ans('chatgpt', 0)]).score, 0);
  });
});

describe('the AEO Score', () => {
  test('is 0.6 readiness + 0.4 visibility, rounded', () => {
    assert.equal(aeoScore({ readiness: 72, visibility: 40 }), 59); // 43.2 + 16
    assert.equal(aeoScore({ readiness: 0, visibility: 0 }), 0);
    assert.equal(aeoScore({ readiness: 100, visibility: 100 }), 100);
  });

  test('is null when either part is unknown, never treated as 0', () => {
    assert.equal(aeoScore({ readiness: null, visibility: 40 }), null);
    assert.equal(aeoScore({ readiness: 72, visibility: null }), null);
    assert.equal(aeoScore({ readiness: undefined, visibility: 40 }), null);
  });
});
