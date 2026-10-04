import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  canShare,
  NEVER_SHARED,
  publicProof,
  SHARED_FIELDS,
  shareSentence,
} from './proof-share.js';

const win = {
  horizon: 'week_2',
  engineScope: 'all',
  verdict: 'proven_win',
  promptsCount: 3,
  nBefore: 120,
  kBefore: 10,
  nAfter: 118,
  kAfter: 40,
  rateBefore: 0.0833,
  rateAfter: 0.339,
  deltaPp: 25.57,
  p: 0.00001,
  computedAt: new Date('2026-10-04T10:00:00Z'),
};
const context = {
  title: 'Allow AI crawlers',
  startedAt: new Date('2026-09-20T10:00:00Z'),
  brandName: 'Data Dental',
  domain: 'datadental.example',
};

describe('what may be shared', () => {
  test('only a proven win across all engines', () => {
    assert.equal(canShare(win), true);
    for (const verdict of ['no_change', 'declined', 'insufficient_data'])
      assert.equal(canShare({ ...win, verdict }), false, verdict);
    assert.equal(canShare({ ...win, engineScope: 'chatgpt' }), false);
    assert.equal(canShare(null), false);
  });
});

describe('the public page', () => {
  test('says who did what, with the outcome’s own figures and nothing else', () => {
    const s = shareSentence(win, context);
    assert.match(s, /^Since Data Dental marked “Allow AI crawlers” done on /);
    assert.match(s, /named on the 3 questions it targets from 10 of 120 to 40 of 118 answers/);
    assert.match(s, /bigger than normal variation/);
    assert.doesNotMatch(s, /\byou\b/i, 'a reader outside the company is not “you”');
  });

  test('is built from the brand, the title and the counts: its fields are exactly these', () => {
    const p = publicProof(win, context);
    assert.deepEqual(Object.keys(p).sort(), [
      'brandName',
      'computedOn',
      'domain',
      'horizon',
      'label',
      'rows',
      'sentence',
      'sure',
      'title',
      'tone',
    ]);
    assert.equal(p.label, 'Proven win');
    assert.equal(p.tone, 'success');
    assert.deepEqual(
      p.rows.map((r) => r.label),
      ['Before', 'After', 'Change'],
    );
    assert.match(p.sure, /p < 0\.001/);
  });

  test('is never built for a result that is not a win', () => {
    assert.equal(publicProof({ ...win, verdict: 'declined' }, context), null);
    assert.equal(publicProof({ ...win, verdict: 'no_change' }, context), null);
    assert.equal(publicProof(win, { ...context, startedAt: null }), null, 'no date, no page');
  });

  test('the promise made before sharing is written once', () => {
    assert.ok(SHARED_FIELDS.length >= 3);
    assert.ok(NEVER_SHARED.some((t) => /answers/.test(t)));
    assert.ok(NEVER_SHARED.some((t) => /competitors/.test(t)));
  });
});
