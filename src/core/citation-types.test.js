import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  classifyDomain,
  KNOWN_SOURCES,
  normalizeDomain,
  SOURCE_TYPES,
  typeBreakdown,
} from './citation-types.js';

describe('classifyDomain', () => {
  test('the reviewed list decides, subdomains included', () => {
    assert.equal(classifyDomain('www.g2.com'), 'review');
    assert.equal(classifyDomain('uk.trustpilot.com'), 'review');
    assert.equal(classifyDomain('old.reddit.com'), 'forum');
    assert.equal(classifyDomain('https://www.nytimes.com/2026/x'), 'news');
    assert.equal(classifyDomain('en.wikipedia.org'), 'docs');
    assert.equal(classifyDomain('amazon.com'), 'marketplace');
  });

  test('the customer’s own site and the competitors’ are decided per project, before the list', () => {
    const ctx = { ownDomains: ['acme.com'], rivalDomains: ['rival.io', 'reddit.com'] };
    assert.equal(classifyDomain('blog.acme.com', ctx), 'own');
    assert.equal(classifyDomain('rival.io', ctx), 'competitor');
    assert.equal(classifyDomain('reddit.com', ctx), 'competitor');
    assert.equal(classifyDomain('notacme.com', ctx), 'other');
  });

  test('a suffix is not a match: "g2.com.evil.net" and "fakeg2.com" are other', () => {
    assert.equal(classifyDomain('g2.com.evil.net'), 'other');
    assert.equal(classifyDomain('fakeg2.com'), 'other');
  });

  test('an unknown site, a made-up one and rubbish are "other", never guessed', () => {
    assert.equal(classifyDomain('some-small-shop.example'), 'other');
    assert.equal(classifyDomain('a'), 'other');
    assert.equal(classifyDomain(''), 'other');
    assert.equal(classifyDomain(null), 'other');
    assert.equal(classifyDomain('not a host'), 'other');
  });

  test('a host that says it is documentation is documentation, a bare one is not', () => {
    assert.equal(classifyDomain('docs.somevendor.example'), 'docs');
    assert.equal(classifyDomain('help.somevendor.example'), 'docs');
    assert.equal(classifyDomain('docs.example'), 'other');
  });

  test('every type the list holds is a known type, and the list has no duplicates', () => {
    const seen = new Set();
    for (const [type, list] of Object.entries(KNOWN_SOURCES)) {
      assert.ok(SOURCE_TYPES.includes(type));
      for (const d of list) {
        assert.equal(d, normalizeDomain(d));
        assert.ok(!seen.has(d), `${d} is listed twice`);
        seen.add(d);
        assert.equal(classifyDomain(d), type);
      }
    }
  });
});

describe('typeBreakdown', () => {
  const domains = [
    { domain: 'g2.com', timesCited: 6 },
    { domain: 'reddit.com', timesCited: 3 },
    { domain: 'acme.com', timesCited: 2, own: true },
    { domain: 'obscure.example', timesCited: 1 },
  ];

  test('counts citations and sites per type with whole-percent shares', () => {
    const rows = typeBreakdown(domains);
    assert.deepEqual(
      rows.map((r) => [r.type, r.timesCited, r.sites, r.share]),
      [
        ['review', 6, 1, 50],
        ['forum', 3, 1, 25],
        ['own', 2, 1, 17],
        ['other', 1, 1, 8],
      ],
    );
  });

  test('no citations gives no rows, and a type with none is left out', () => {
    assert.deepEqual(typeBreakdown([]), []);
    assert.ok(!typeBreakdown(domains).some((r) => r.type === 'news'));
  });
});
