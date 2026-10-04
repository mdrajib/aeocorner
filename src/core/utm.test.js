import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { cleanUtm, utmLabel } from './utm.js';

describe('cleanUtm', () => {
  test('keeps plain labels, lower-cased', () => {
    assert.deepEqual(
      cleanUtm({ utm_source: 'Newsletter', utm_medium: 'email', utm_campaign: 'launch-2026_q4' }),
      { utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'launch-2026_q4' },
    );
  });

  test('drops anything that is not a short plain label (never trims it into one)', () => {
    for (const value of [
      'jane@example.com',
      'two words',
      'https://x.test',
      '<script>',
      'a'.repeat(41),
      '',
      '-leading',
      ['array'],
      { toString: () => 'obj' },
      42,
    ]) {
      assert.deepEqual(cleanUtm({ utm_source: value }), {}, JSON.stringify(value));
    }
    assert.equal(utmLabel('a'.repeat(40)), 'a'.repeat(40));
  });

  test('keeps only source, medium and campaign', () => {
    assert.deepEqual(cleanUtm({ utm_content: 'x', utm_term: 'y', utm_id: 'z', other: 'q' }), {});
  });

  test('is safe on missing or odd input', () => {
    assert.deepEqual(cleanUtm(undefined), {});
    assert.deepEqual(cleanUtm(null), {});
    assert.deepEqual(cleanUtm('utm_source=a'), {});
  });
});
