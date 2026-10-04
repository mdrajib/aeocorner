import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { extractPage } from '../crawler/html.js';
import { judgeProfile, judgeWikidata, namesAnyOf, verifiedProfileUrls } from './entity-checks.js';

const NAMES = ['Acme Dental', 'Acme'];
const URL_ = 'https://www.example-directory.test/acme';

const filler = 'We are a family practice that cares for patients of every age. '.repeat(12);
const page = (inner, head = '') =>
  `<html><head><title>Acme Dental | Directory</title>${head}</head><body>${inner}</body></html>`;

function judge(
  html,
  { status = 200, headers = {}, names = NAMES, domain = 'acmedental.com' } = {},
) {
  const facts = html == null ? null : extractPage(html, URL_);
  return judgeProfile({ status, headers, body: html ?? '', facts, brandNames: names, domain });
}

describe('judgeProfile: what a page says', () => {
  test('passes a page that names the business, and notes a link back', () => {
    const r = judge(
      page(`<h1>Acme Dental</h1><p>${filler}</p><a href="https://acmedental.com/">Website</a>`),
    );
    assert.equal(r.status, 'passed');
    assert.equal(r.finding, 'names_brand');
    assert.equal(r.namesBrand, true);
    assert.equal(r.linksBack, true);
    assert.equal(r.reachable, true);
  });

  test('a page that names the business but does not link back still passes, and says so', () => {
    const r = judge(page(`<h1>Acme Dental</h1><p>${filler}</p>`));
    assert.equal(r.status, 'passed');
    assert.equal(r.linksBack, false);
  });

  test('a readable page that never names the business is a real failure', () => {
    const r = judge(
      `<html><head><title>Best Dentists</title></head><body><h1>Dentists near you</h1><p>${filler}</p></body></html>`,
    );
    assert.equal(r.status, 'failed');
    assert.equal(r.finding, 'brand_not_named');
  });

  test('a name is matched as whole words, not inside another word', () => {
    assert.equal(namesAnyOf('Acmeville Dental Group', ['Acme']), false);
    assert.equal(namesAnyOf('The Acme Dental team', ['Acme']), true);
    assert.equal(
      namesAnyOf('anything', ['ab']),
      false,
      'a name under three letters matches nothing',
    );
  });

  test('the name in structured data counts', () => {
    const ld = `<script type="application/ld+json">{"@type":"Organization","name":"Acme Dental"}</script>`;
    const r = judge(
      `<html><head><title>Profile</title>${ld}</head><body><p>${filler}</p></body></html>`,
    );
    assert.equal(r.status, 'passed');
  });
});

describe('judgeProfile: when we could not look, it is never "failed"', () => {
  for (const status of [401, 403, 429, 999]) {
    test(`status ${status} is "couldn't check"`, () => {
      const r = judge('', { status });
      assert.equal(r.status, 'error');
      assert.equal(r.finding, 'blocked');
    });
  }

  test('a firewall challenge page that answers 200 is "couldn\'t check"', () => {
    const r = judge(
      '<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing</body></html>',
    );
    assert.equal(r.status, 'error');
    assert.equal(r.finding, 'blocked');
  });

  test('a server error is "couldn\'t check"', () => {
    assert.equal(judge('', { status: 503 }).finding, 'unavailable');
    assert.equal(judge('', { status: 503 }).status, 'error');
  });

  test('a sign-in page is "couldn\'t check"', () => {
    const r = judge(
      `<html><head><title>Sign in</title></head><body><h1>Sign in</h1><p>${filler}</p></body></html>`,
    );
    assert.equal(r.status, 'error');
    assert.equal(r.finding, 'needs_login');
  });

  test('an empty shell that fills in later is "couldn\'t check"', () => {
    const r = judge(
      '<html><head><title>Loading</title></head><body><div id="root"></div></body></html>',
    );
    assert.equal(r.status, 'error');
    assert.equal(r.finding, 'needs_javascript');
  });

  test('a page we could not parse is "couldn\'t check"', () => {
    const r = judgeProfile({
      status: 200,
      facts: { skipped: 'too_deeply_nested' },
      brandNames: NAMES,
      domain: 'a.test',
    });
    assert.equal(r.status, 'error');
    assert.equal(r.finding, 'unreadable');
  });

  test('only a page that is plainly gone fails for that reason', () => {
    for (const status of [404, 410]) {
      const r = judge('', { status });
      assert.equal(r.status, 'failed');
      assert.equal(r.finding, 'not_found');
      assert.equal(r.reachable, false);
    }
  });
});

describe('judgeProfile: hostile pages (linear time, nothing thrown)', () => {
  // A deliberately loose wall-clock bound: it exists to catch quadratic or exponential work, not to time the machine.
  const LOOSE_MS = 5000;
  const time = (fn) => {
    const start = Date.now();
    const result = fn();
    return { result, ms: Date.now() - start };
  };

  test('a page nested far past the limit is refused, not parsed', () => {
    const html = `<html><body>${'<div>'.repeat(5000)}Acme Dental${'</div>'.repeat(5000)}</body></html>`;
    const { result, ms } = time(() => judge(html));
    assert.equal(result.status, 'error');
    assert.equal(result.finding, 'unreadable');
    assert.ok(ms < LOOSE_MS);
  });

  test('a huge page of repeated near-matches does not slow the name search', () => {
    const body = `<h1>Welcome</h1><p>${'Acm Acme-ville Acmé '.repeat(40_000)}</p>`;
    const { result, ms } = time(() => judge(page(body)));
    assert.ok(['passed', 'failed', 'error'].includes(result.status));
    assert.ok(ms < LOOSE_MS, `took ${ms} ms`);
  });

  test('a page of one enormous word, and of thousands of links, is handled', () => {
    const word = judge(page(`<p>${'a'.repeat(2_000_000)}</p>`));
    assert.ok(['failed', 'error', 'passed'].includes(word.status));
    const links = Array.from(
      { length: 20_000 },
      (_, i) => `<a href="https://x${i}.test/">l</a>`,
    ).join('');
    const { ms } = time(() => judge(page(`<h1>Acme Dental</h1><p>${filler}</p>${links}`)));
    assert.ok(ms < LOOSE_MS, `took ${ms} ms`);
  });
});

describe('judgeWikidata', () => {
  const item = (
    id,
    { label = 'Acme Dental', aliases = [], website = null, description = 'dental practice' } = {},
  ) => ({
    id,
    labels: { en: { value: label } },
    aliases: { en: aliases.map((value) => ({ value })) },
    descriptions: { en: { value: description } },
    claims: website ? { P856: [{ mainsnak: { datavalue: { value: website } } }] } : {},
  });
  const base = { brandNames: NAMES, domain: 'acmedental.com' };

  test('an item whose official website is the domain is found', () => {
    const r = judgeWikidata({
      ...base,
      items: [item('Q1', { website: 'https://www.acmedental.com/' }), item('Q2')],
    });
    assert.equal(r.status, 'passed');
    assert.equal(r.finding, 'found');
    assert.equal(r.item.id, 'Q1');
  });

  test('a name match alone is ambiguous, never "found"', () => {
    const r = judgeWikidata({ ...base, items: [item('Q2')] });
    assert.equal(r.status, 'failed');
    assert.equal(r.finding, 'ambiguous');
    assert.equal(r.candidates, 1);
  });

  test('two items claiming the same website are ambiguous', () => {
    const w = 'https://acmedental.com';
    const r = judgeWikidata({
      ...base,
      items: [item('Q1', { website: w }), item('Q3', { website: w })],
    });
    assert.equal(r.finding, 'ambiguous');
  });

  test('nothing with the name is "no item"', () => {
    const r = judgeWikidata({ ...base, items: [item('Q9', { label: 'Other Dental Co' })] });
    assert.equal(r.finding, 'not_in_wikidata');
    assert.equal(judgeWikidata({ ...base, items: [] }).finding, 'not_in_wikidata');
  });

  test('a look-alike website is not the same site', () => {
    const r = judgeWikidata({
      ...base,
      items: [item('Q1', { label: 'Other', website: 'https://acmedental.com.evil.test' })],
    });
    assert.equal(r.finding, 'not_in_wikidata');
  });

  test('an item the customer named is confirmed by its name or its website', () => {
    assert.equal(
      judgeWikidata({ ...base, givenId: 'Q5', items: [item('Q5', { aliases: ['Acme'] })] }).finding,
      'confirmed',
    );
    assert.equal(
      judgeWikidata({
        ...base,
        givenId: 'Q5',
        items: [item('Q5', { label: 'Different', website: 'https://acmedental.com' })],
      }).finding,
      'confirmed',
    );
  });

  test('an item the customer named that looks like someone else is a mismatch; one that does not exist is missing', () => {
    assert.equal(
      judgeWikidata({ ...base, givenId: 'Q5', items: [item('Q5', { label: 'Unrelated Bank' })] })
        .finding,
      'mismatch',
    );
    assert.equal(
      judgeWikidata({ ...base, givenId: 'Q5', items: [{ id: 'Q5', missing: '' }] }).finding,
      'not_in_wikidata',
    );
    assert.equal(judgeWikidata({ ...base, givenId: 'Q5', items: [] }).finding, 'not_in_wikidata');
  });
});

describe('verifiedProfileUrls', () => {
  test('only a profile that passed is offered for sameAs', () => {
    const checks = [
      { kind: 'profile', subject: 'https://a.test/1', status: 'passed' },
      { kind: 'profile', subject: 'https://a.test/2', status: 'failed' },
      { kind: 'profile', subject: 'https://a.test/3', status: 'error' },
      { kind: 'wikidata', subject: 'wikidata', status: 'passed' },
    ];
    assert.deepEqual(verifiedProfileUrls(checks), ['https://a.test/1']);
  });
});
