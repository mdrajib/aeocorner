import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { normalizeFindings } from './tool-findings.js';
import { SUPPORTED_TYPES } from './jsonld.js';
import { structuredDataFindings } from './tool-structured-data.js';

const org = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Acme',
  url: 'https://acme.test',
  logo: 'https://acme.test/logo.png',
  sameAs: ['https://www.linkedin.com/company/acme'],
};
const findings = (items, over = {}) =>
  normalizeFindings(structuredDataFindings({ source: 'paste', items, ...over }));
const rowsOf = (f) => f.sections.flatMap((s) => s.rows);

describe('what it says about the blocks', () => {
  test('a valid block: no errors, and the types that were checked', () => {
    const f = findings([{ block: 1, data: org }]);
    assert.match(f.headline, /1 block of structured data, no errors found/);
    assert.ok(rowsOf(f).some((r) => r.label === 'Types we checked' && r.value === 'Organization'));
    assert.ok(rowsOf(f).some((r) => r.label === 'Result' && r.state === 'good'));
  });

  test('a wrong value is a problem with its path and a plain explanation', () => {
    const f = findings([
      { block: 1, data: { ...org, url: 'acme.test', foundingDate: 'last year' } },
    ]);
    assert.match(f.headline, /2 problems in 1 block/);
    const bad = rowsOf(f).filter((r) => r.state === 'bad' && r.label.startsWith('$.'));
    assert.deepEqual(bad.map((r) => r.label).sort(), ['$.foundingDate', '$.url']);
    assert.ok(bad.every((r) => r.detail.length > 10));
  });

  test('a type or property we do not know is "not checked", never wrong', () => {
    const f = findings([
      { block: 1, data: { '@context': 'https://schema.org', '@type': 'Recipe', name: 'Pancakes' } },
    ]);
    assert.match(f.headline, /no errors found/);
    const row = rowsOf(f).find((r) => r.label === 'Not checked');
    assert.equal(row.state, 'neutral');
    assert.match(row.detail, /Recipe \(a type\)/);
    assert.match(row.detail, /does not mean they are wrong/);
  });

  test('a suggestion is a warning, and the block is still valid', () => {
    const f = findings([
      { block: 1, data: { '@context': 'https://schema.org', '@type': 'Organization' } },
    ]);
    assert.match(f.headline, /no errors found/);
    assert.ok(rowsOf(f).some((r) => r.state === 'warn' && /normally has name/.test(r.detail)));
    assert.match(f.notes[0], /A suggestion is not an error/);
  });

  test('a block that is not JSON is a problem, and one that is too large is "couldn’t check"', () => {
    const bad = findings([{ block: 1, problem: 'invalid_json' }]);
    assert.match(bad.headline, /1 problem in 1 block/);
    assert.ok(rowsOf(bad).some((r) => r.label === 'Not valid JSON' && r.state === 'bad'));
    const big = findings([{ block: 1, problem: 'too_large' }]);
    assert.ok(rowsOf(big).some((r) => r.state === 'unknown'));
    assert.doesNotMatch(big.headline, /problem/);
    assert.match(big.headline, /too large to check/);
  });

  test('no blocks is its own answer, worded for where they were looked for', () => {
    assert.match(findings([], { source: 'paste' }).headline, /no JSON-LD in what you pasted/);
    const page = findings([], { source: 'page', pageUrl: 'https://acme.test/', httpStatus: 200 });
    assert.match(page.headline, /no structured data in the page’s HTML/);
    assert.match(JSON.stringify(page), /add structured data with JavaScript/);
  });

  test('a page says what was read', () => {
    const f = findings([{ block: 1, data: org }], {
      source: 'page',
      pageUrl: 'https://acme.test/about',
      httpStatus: 200,
    });
    const read = rowsOf(f).find((r) => r.label === 'Page read');
    assert.equal(read.detail, 'https://acme.test/about');
    assert.equal(read.value, 'HTTP 200');
  });

  test('many blocks: the first seven are shown, and the headline and a note say there are more', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ block: i + 1, data: org }));
    const f = findings(items);
    assert.match(f.headline, /20 blocks/);
    assert.equal(f.sections.length, 7);
    assert.ok(f.notes.some((n) => /first 7 of 20/.test(n)));
  });

  test('every note is honest: the checked types are named and a valid block promises nothing', () => {
    const f = findings([{ block: 1, data: org }]);
    const shown = f.notes.join(' ');
    assert.ok(
      SUPPORTED_TYPES.every((t) => shown.includes(t)),
      'every checked type is named, none cut off',
    );
    assert.match(shown, /read for syntax only/);
    assert.ok(f.notes.some((n) => /does not promise/.test(n)));
  });

  test('hostile blocks (nodes by the thousand, nesting by the tens of thousands) stay inside the caps and the clock', () => {
    const many = {
      '@context': 'https://schema.org',
      '@graph': Array.from({ length: 20_000 }, (_, i) => ({ '@type': 'Thing', name: `n${i}` })),
    };
    let deep = { '@type': 'Organization', name: 'x' };
    for (let i = 0; i < 30_000; i += 1)
      deep = { '@type': 'Organization', name: 'x', parentOrganization: deep };
    const started = Date.now();
    const f = findings([
      { block: 1, data: many },
      { block: 2, data: { '@context': 'https://schema.org', ...deep } },
    ]);
    assert.ok(Date.now() - started < 10_000, 'a loose bound');
    assert.ok(JSON.stringify(f).length < 100_000);
    assert.match(f.headline, /problems? in 2 blocks/);
  });
});
