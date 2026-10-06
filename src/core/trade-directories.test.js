import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { COUNTRIES } from './project-rules.js';
import {
  DIRECTORIES,
  DIRECTORIES_CHECKED_ON,
  MAX_DIRECTORIES,
  looksLikeSoftware,
  suggestDirectories,
} from './trade-directories.js';

const ids = (list) => list.map((d) => d.id);

describe('the reviewed list', () => {
  test('every entry has a unique id, a secure address, a reason, and only known countries', () => {
    assert.equal(new Set(DIRECTORIES.map((d) => d.id)).size, DIRECTORIES.length);
    for (const d of DIRECTORIES) {
      assert.match(d.url, /^https:\/\/[^\s]+$/, d.id);
      assert.ok(d.name && d.about && d.kind, d.id);
      for (const c of d.countries ?? []) assert.ok(Object.hasOwn(COUNTRIES, c), `${d.id} ${c}`);
    }
    assert.match(DIRECTORIES_CHECKED_ON, /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('suggestDirectories', () => {
  test('a software business in Bangladesh gets three local places, the trade body first', () => {
    const s = suggestDirectories({ country: 'BD', category: 'invoicing software' });
    assert.equal(s.length, MAX_DIRECTORIES);
    assert.equal(s[0].id, 'basis');
    assert.ok(s.every((d) => d.scope === 'local'));
  });

  test('a business that is not software is not sent to a software trade body', () => {
    const s = suggestDirectories({ country: 'BD', category: 'family dental practice' });
    assert.ok(!ids(s).includes('basis'));
    assert.equal(s.length, MAX_DIRECTORIES);
    assert.ok(s.every((d) => d.scope === 'local'));
  });

  test('a country with fewer local entries is topped up with worldwide ones, local first', () => {
    const s = suggestDirectories({ country: 'IN', category: 'invoicing software' });
    assert.equal(s.length, MAX_DIRECTORIES);
    assert.deepEqual(ids(s).slice(0, 3), ['nasscom', 'justdial', 'indiamart']);
    const dental = suggestDirectories({ country: 'IN', category: 'dental clinic' });
    assert.deepEqual(ids(dental), ['justdial', 'indiamart', 'bing-places']);
    assert.deepEqual(
      dental.map((d) => d.scope),
      ['local', 'local', 'worldwide'],
    );
  });

  test('a country with no local entry still gets at least one, from the worldwide list', () => {
    for (const country of Object.keys(COUNTRIES)) {
      for (const category of ['invoicing software', 'family dental practice', '']) {
        const s = suggestDirectories({ country, category });
        assert.ok(s.length >= 1 && s.length <= MAX_DIRECTORIES, `${country} ${category}`);
      }
    }
    const us = suggestDirectories({ country: 'US', category: 'dental clinic' });
    assert.deepEqual(ids(us), ['bing-places']);
    assert.equal(us[0].scope, 'worldwide');
  });

  test('an unknown or empty country and a missing category do not throw', () => {
    assert.ok(suggestDirectories().length >= 1);
    assert.ok(suggestDirectories({ country: 'ZZ' }).length >= 1);
    assert.ok(suggestDirectories({ country: 'bd' }).length >= 1);
  });

  test('looks like software from the category or the definition', () => {
    assert.equal(looksLikeSoftware('invoicing software'), true);
    assert.equal(looksLikeSoftware('', 'A cloud tool for small shops'), true);
    assert.equal(looksLikeSoftware('family dental practice', 'cleanings and braces'), false);
    assert.equal(looksLikeSoftware(undefined, null), false);
  });
});
