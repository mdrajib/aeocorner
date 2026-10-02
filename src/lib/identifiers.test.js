import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { maskEmail } from './mask.js';
import { slugify, withSuffix } from './slug.js';
import { hashToken, hmac, newToken, safeEqual } from './tokens.js';
import { isUlid, ulid } from './ulid.js';

describe('ulid', () => {
  test('is 26 Crockford base32 characters', () => {
    for (let i = 0; i < 200; i++) assert.match(ulid(), /^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  test('sorts by creation time', () => {
    const earlier = ulid(1_700_000_000_000);
    const later = ulid(1_700_000_000_001);
    assert.ok(earlier.slice(0, 10) < later.slice(0, 10));
  });

  test('the first ten characters encode the millisecond clock', () => {
    // 48-bit time: 2026 is far below 2^48 ms, so the first character is "0".
    assert.match(ulid(Date.UTC(2026, 9, 2)), /^0/);
    assert.equal(ulid(0).slice(0, 10), '0000000000');
  });

  test('does not repeat', () => {
    const seen = new Set(Array.from({ length: 5000 }, () => ulid(1_700_000_000_000)));
    assert.equal(seen.size, 5000);
  });

  test('isUlid accepts ULIDs and rejects look-alikes', () => {
    assert.equal(isUlid(ulid()), true);
    for (const bad of [
      '',
      'x',
      'I'.repeat(26),
      'O'.repeat(26),
      'u'.repeat(26),
      `${ulid()}0`,
      ulid().toLowerCase(),
      null,
      undefined,
      123,
    ]) {
      assert.equal(isUlid(bad), false, String(bad));
    }
  });
});

describe('tokens', () => {
  test('newToken is long, URL-safe and never repeats', () => {
    const tokens = Array.from({ length: 500 }, newToken);
    assert.equal(new Set(tokens).size, 500);
    for (const t of tokens) assert.match(t, /^[A-Za-z0-9_-]{43}$/);
  });

  test('hashToken gives the 32 bytes a BINARY(32) column holds, deterministically', () => {
    const a = hashToken('abc');
    assert.equal(a.length, 32);
    assert.deepEqual(a, hashToken('abc'));
    assert.notDeepEqual(a, hashToken('abd'));
    // SHA-256("abc")
    assert.equal(
      a.toString('hex'),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  test('safeEqual compares by value and tolerates different lengths', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('abc', 'abcd'), false);
    assert.equal(safeEqual('', ''), true);
  });

  test('hmac depends on the secret and on every part', () => {
    const base = hmac('s1', 'a', 'b');
    assert.equal(base, hmac('s1', 'a', 'b'));
    assert.notEqual(base, hmac('s2', 'a', 'b'));
    assert.notEqual(base, hmac('s1', 'a', 'c'));
    assert.notEqual(hmac('s1', 'ab', ''), hmac('s1', 'a', 'b'), 'parts are not simply joined');
  });
});

describe('slugify', () => {
  test('makes tidy URL-safe slugs', () => {
    assert.equal(slugify('Acme Dental, Inc.'), 'acme-dental-inc');
    assert.equal(slugify('  Café   Ünïcode  '), 'cafe-unicode');
    assert.equal(slugify('A/B?C&D'), 'a-b-c-d');
  });

  test('never returns an empty or over-long slug', () => {
    assert.equal(slugify('!!!'), 'org');
    assert.equal(slugify(''), 'org');
    assert.equal(slugify(undefined), 'org');
    const long = slugify('word '.repeat(40));
    assert.ok(long.length <= 48);
    assert.doesNotMatch(long, /-$/);
  });

  test('withSuffix adds a short random tail and stays within the column', () => {
    const s = withSuffix(slugify('x'.repeat(100), 100));
    assert.match(s, /-[0-9a-f]{4}$/);
    assert.ok(s.length <= 64);
    assert.notEqual(withSuffix('acme'), withSuffix('acme'));
  });
});

describe('maskEmail', () => {
  test('keeps the first letter and the domain', () => {
    assert.equal(maskEmail('sam.lee@example.com'), 's•••@example.com');
    assert.equal(maskEmail('a@b.test'), 'a•••@b.test');
  });

  test('copes with junk', () => {
    assert.equal(maskEmail(''), '•••@');
    assert.equal(maskEmail(undefined), 'u•••@');
  });
});
