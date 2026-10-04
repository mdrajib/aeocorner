import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeLivePage, LIVE_REASON_TEXT } from './live-check.js';

const facts = (over = {}) => ({
  skipped: null,
  noindex: false,
  title: 'How much does a crown cost? | Data Dental',
  headings: [
    { level: 1, text: 'How much does a crown cost?' },
    { level: 2, text: 'Is it covered?' },
  ],
  jsonLd: { types: ['Article', 'Organization'] },
  ...over,
});
const expectation = { headline: 'How much does a crown cost?', types: ['Article'] };

test('a live page with its headline and structured data passes', () => {
  assert.deepEqual(judgeLivePage({ status: 200, facts: facts(), expect: expectation }), {
    status: 'passed',
    couldntCheck: false,
    reasons: [],
  });
  assert.equal(judgeLivePage({ status: 200, facts: facts(), expect: {} }).status, 'passed');
  assert.equal(
    judgeLivePage({
      status: 200,
      facts: facts({ title: '', headings: [{ level: 2, text: 'HOW MUCH does a crown   cost?' }] }),
      expect: expectation,
    }).status,
    'passed',
  );
});

test('"we could not look" is never "your fix failed"', () => {
  for (const status of [null, 429, 401, 403, 500, 502, 503]) {
    const r = judgeLivePage({ status, facts: null, expect: expectation });
    assert.deepEqual([r.status, r.couldntCheck], ['failed', true], String(status));
  }
  assert.equal(judgeLivePage({ status: 200, facts: null, expect: expectation }).couldntCheck, true);
  assert.equal(
    judgeLivePage({
      status: 200,
      facts: facts({ skipped: 'too_deeply_nested' }),
      expect: expectation,
    }).couldntCheck,
    true,
  );
});

test('a page that is not there, or not what we published, is a real failure with reasons', () => {
  for (const status of [404, 410])
    assert.deepEqual(judgeLivePage({ status, facts: null, expect: expectation }), {
      status: 'failed',
      couldntCheck: false,
      reasons: ['not_found'],
    });
  assert.deepEqual(judgeLivePage({ status: 400, facts: null, expect: {} }).reasons, ['http_400']);
  assert.deepEqual(judgeLivePage({ status: 301, facts: null, expect: {} }).reasons, ['http_301']);
  const wrong = judgeLivePage({
    status: 200,
    facts: facts({ title: 'Home', headings: [], jsonLd: { types: [] }, noindex: true }),
    expect: expectation,
  });
  assert.deepEqual(wrong, {
    status: 'failed',
    couldntCheck: false,
    reasons: ['noindex', 'headline_missing', 'structured_data_missing'],
  });
  assert.deepEqual(
    judgeLivePage({
      status: 200,
      facts: facts({ jsonLd: { types: ['Organization'] } }),
      expect: expectation,
    }).reasons,
    ['structured_data_missing'],
  );
});

test('every reason has words for the customer', () => {
  for (const r of [
    'fetch_failed',
    'unreadable',
    'not_found',
    'noindex',
    'headline_missing',
    'structured_data_missing',
  ])
    assert.ok(LIVE_REASON_TEXT[r], r);
});
