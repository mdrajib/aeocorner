import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  isOwnHost,
  normalizeProfileUrl,
  parseProfileLines,
  parseWikidataId,
  platformOfUrl,
} from './entity-profiles.js';

describe('platformOfUrl', () => {
  test('recognises the platforms by address and calls the rest "other"', () => {
    assert.equal(platformOfUrl('https://www.linkedin.com/company/acme'), 'linkedin');
    assert.equal(platformOfUrl('https://uk.linkedin.com/company/acme'), 'linkedin');
    assert.equal(platformOfUrl('https://g.page/acme'), 'google_business');
    assert.equal(platformOfUrl('https://www.google.com/maps/place/Acme'), 'google_business');
    assert.equal(platformOfUrl('https://www.google.com/search?q=acme'), 'other');
    assert.equal(platformOfUrl('https://en.wikipedia.org/wiki/Acme'), 'wikipedia');
    assert.equal(platformOfUrl('https://twitter.com/acme'), 'x');
    assert.equal(platformOfUrl('https://dentists.example.org/acme'), 'other');
  });

  test('a look-alike host is not the platform', () => {
    assert.equal(platformOfUrl('https://notlinkedin.com/company/acme'), 'other');
    assert.equal(platformOfUrl('https://linkedin.com.evil.example/acme'), 'other');
  });

  test('only a plain https address has a platform', () => {
    assert.equal(platformOfUrl('http://linkedin.com/company/acme'), null);
    assert.equal(platformOfUrl('javascript:alert(1)'), null);
    assert.equal(platformOfUrl('https://user:pw@linkedin.com/x'), null);
    assert.equal(platformOfUrl('linkedin.com/company/acme'), null);
  });
});

describe('normalizeProfileUrl', () => {
  test('drops the fragment, tracking and a trailing slash, and lower-cases the host', () => {
    assert.equal(
      normalizeProfileUrl('https://WWW.LinkedIn.com/company/acme/?utm_source=a&fbclid=b#x'),
      'https://www.linkedin.com/company/acme',
    );
    assert.equal(normalizeProfileUrl('https://example.com/'), 'https://example.com/');
    assert.equal(normalizeProfileUrl('https://example.com/p?id=3'), 'https://example.com/p?id=3');
  });
});

describe('parseWikidataId', () => {
  test('reads an item number in every form a person pastes', () => {
    assert.equal(parseWikidataId('Q42'), 'Q42');
    assert.equal(parseWikidataId(' q42 '), 'Q42');
    assert.equal(parseWikidataId('https://www.wikidata.org/wiki/Q42'), 'Q42');
    assert.equal(parseWikidataId('https://www.wikidata.org/entity/Q42?x=1'), 'Q42');
    assert.equal(parseWikidataId(''), '');
  });

  test('says null for anything else', () => {
    for (const bad of [
      '42',
      'Q',
      'Qabc',
      'P31',
      'https://example.com/wiki/Q42',
      'Q1234567890123',
    ]) {
      assert.equal(parseWikidataId(bad), null, bad);
    }
  });
});

describe('parseProfileLines', () => {
  test('keeps each address once, with its platform', () => {
    const r = parseProfileLines([
      'https://www.linkedin.com/company/acme',
      '',
      'https://www.linkedin.com/company/acme/',
      'https://www.crunchbase.com/organization/acme',
    ]);
    assert.equal(r.ok, true);
    assert.deepEqual(
      r.profiles.map((p) => p.platform),
      ['linkedin', 'crunchbase'],
    );
  });

  test('a Wikidata address is the item, not a profile', () => {
    const r = parseProfileLines(['https://www.wikidata.org/wiki/Q7']);
    assert.deepEqual(r, { ok: true, profiles: [], wikidataId: 'Q7' });
  });

  test('refuses a line that is not an address, and says which', () => {
    const r = parseProfileLines(['https://www.linkedin.com/company/acme', 'acme on linkedin']);
    assert.equal(r.ok, false);
    assert.match(r.error, /acme on linkedin/);
  });
});

describe('isOwnHost', () => {
  test('the domain, www and sub-domains are the same site; a look-alike is not', () => {
    assert.equal(isOwnHost('acme.com', 'acme.com'), true);
    assert.equal(isOwnHost('www.acme.com', 'acme.com'), true);
    assert.equal(isOwnHost('blog.acme.com', 'www.acme.com'), true);
    assert.equal(isOwnHost('notacme.com', 'acme.com'), false);
    assert.equal(isOwnHost('acme.com.evil.test', 'acme.com'), false);
    assert.equal(isOwnHost('acme.com', ''), false);
  });
});
