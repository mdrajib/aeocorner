import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { validateJsonLd } from './jsonld.js';
import {
  AUTOFIX_RULES,
  buildAutofix,
  fingerprint,
  homeUrlOf,
  isAutofixable,
  parseExtras,
} from './autofix.js';

const brand = {
  name: 'Data Dental',
  legalName: 'Data Dental LLC',
  definition: 'Family dentist in Austin.',
};

describe('parseExtras', () => {
  test('takes https addresses, one per line or comma separated, without repeats', () => {
    const r = parseExtras({
      logoUrl: ' https://dd.example/logo.png ',
      sameAs:
        'https://www.linkedin.com/company/dd\nhttps://www.crunchbase.com/organization/dd, https://www.linkedin.com/company/dd',
    });
    assert.equal(r.ok, true);
    assert.equal(r.logoUrl, 'https://dd.example/logo.png');
    assert.equal(r.sameAs.length, 2);
  });

  test('empty is fine; anything that is not a plain https address is refused with a message', () => {
    assert.deepEqual(parseExtras({}), { ok: true, logoUrl: null, sameAs: [] });
    for (const bad of [
      'http://x.com/a',
      'javascript:alert(1)',
      'not a url',
      'https://u:pw@x.com/',
    ]) {
      assert.equal(parseExtras({ logoUrl: bad }).ok, false, bad);
      assert.equal(parseExtras({ sameAs: bad }).ok, false, bad);
    }
    const many = Array.from({ length: 11 }, (_, i) => `https://a${i}.example/`).join('\n');
    assert.equal(parseExtras({ sameAs: many }).ok, false);
  });
});

describe('buildAutofix', () => {
  test('Organization: only what is known, a valid graph, and what was left out is said', () => {
    const r = buildAutofix({ ruleCode: 'readiness.C1', brand, domain: 'datadental.example' });
    assert.equal(r.ok, true);
    assert.equal(r.targetUrl, 'https://datadental.example/');
    const org = r.jsonld['@graph'][0];
    assert.equal(org['@type'], 'Organization');
    assert.equal(org.name, 'Data Dental');
    assert.equal(org.legalName, 'Data Dental LLC');
    assert.ok(!('logo' in org) && !('sameAs' in org), 'nothing is invented');
    assert.equal(r.notIncluded.length, 2);
    assert.equal(validateJsonLd(r.jsonld).ok, true);
  });

  test('the connected site’s own address wins over the project’s domain', () => {
    const r = buildAutofix({
      ruleCode: 'readiness.C4',
      brand,
      domain: 'datadental.example',
      homeUrl: 'https://www.datadental.example',
    });
    assert.equal(r.targetUrl, 'https://www.datadental.example/');
    assert.equal(r.node.url, 'https://www.datadental.example/');
  });

  test('with a logo and profiles they are included', () => {
    const r = buildAutofix({
      ruleCode: 'readiness.C1',
      brand,
      domain: 'datadental.example',
      extras: {
        logoUrl: 'https://dd.example/l.png',
        sameAs: ['https://www.linkedin.com/company/dd'],
      },
    });
    const org = r.jsonld['@graph'][0];
    assert.equal(org.logo, 'https://dd.example/l.png');
    assert.deepEqual(org.sameAs, ['https://www.linkedin.com/company/dd']);
    assert.deepEqual(r.notIncluded, []);
  });

  test('WebSite is added beside an Organization already applied; the same type is replaced, not repeated', () => {
    const org = buildAutofix({ ruleCode: 'readiness.C1', brand, domain: 'dd.example' });
    const site = buildAutofix({
      ruleCode: 'readiness.C4',
      brand,
      domain: 'dd.example',
      existingNodes: org.jsonld['@graph'],
    });
    assert.deepEqual(
      site.jsonld['@graph'].map((n) => n['@type']),
      ['Organization', 'WebSite'],
    );
    const again = buildAutofix({
      ruleCode: 'readiness.C1',
      brand: { ...brand, name: 'Data Dental Austin' },
      domain: 'dd.example',
      existingNodes: site.jsonld['@graph'],
    });
    assert.deepEqual(
      again.jsonld['@graph'].map((n) => n['@type']),
      ['WebSite', 'Organization'],
    );
    assert.equal(again.jsonld['@graph'][1].name, 'Data Dental Austin');
  });

  test('the fingerprint changes with any change to what would be written', () => {
    const base = { ruleCode: 'readiness.C1', brand, domain: 'dd.example' };
    const a = buildAutofix(base);
    const b = buildAutofix(base);
    const c = buildAutofix({ ...base, extras: { logoUrl: 'https://x.example/l.png' } });
    assert.equal(a.hash, b.hash);
    assert.notEqual(a.hash, c.hash);
  });

  test('the fingerprint ignores key order (MySQL stores JSON in its own order)', () => {
    assert.equal(
      fingerprint({ '@context': 'x', '@graph': [{ name: 'a', url: 'b' }] }),
      fingerprint({ '@graph': [{ url: 'b', name: 'a' }], '@context': 'x' }),
    );
  });

  test('refuses what cannot be fixed this way, and a missing name', () => {
    assert.equal(buildAutofix({ ruleCode: 'readiness.A1', brand, domain: 'x.example' }).ok, false);
    assert.equal(
      buildAutofix({ ruleCode: 'readiness.C1', brand: { name: '' }, domain: 'x.example' }).ok,
      false,
    );
    assert.equal(isAutofixable('readiness.C1'), true);
    assert.equal(isAutofixable('readiness.A1'), true, 'robots.txt lines have their own builder');
    assert.equal(isAutofixable('readiness.A4'), false, 'the sitemap stays guidance');
    assert.equal(homeUrlOf(' Example.COM/ '), 'https://example.com/');
    assert.ok(Object.keys(AUTOFIX_RULES).every((k) => k.startsWith('readiness.')));
  });
});

describe('buildAutofix for the profile links (readiness.D3, Milestone 12)', () => {
  const PASSED = 'https://www.linkedin.com/company/data-dental';
  const build = (over = {}) =>
    buildAutofix({
      ruleCode: 'readiness.D3',
      brand,
      domain: 'datadental.example',
      entity: { sameAs: [PASSED], foundingYear: '2014' },
      ...over,
    });

  test('writes the Organization node with the checked profiles and the founding year, and says so', () => {
    const r = build();
    assert.equal(r.ok, true);
    const org = r.jsonld['@graph'][0];
    assert.deepEqual(org.sameAs, [PASSED]);
    assert.equal(org.foundingDate, '2014');
    assert.equal(org.legalName, 'Data Dental LLC');
    assert.ok(r.includes.some((line) => /1 profile link that passed our check/.test(line)));
    assert.equal(validateJsonLd(r.jsonld).ok, true);
  });

  test('a link typed in the extras is never used: only the checked ones are', () => {
    const r = build({ extras: { sameAs: ['https://evil.example/profile'] } });
    assert.deepEqual(r.jsonld['@graph'][0].sameAs, [PASSED]);
  });

  test('with no checked profile there is nothing to write, and the reason says where to add them', () => {
    const r = build({ entity: { sameAs: [], foundingYear: '2014' } });
    assert.equal(r.ok, false);
    assert.match(r.reason, /Entity tab of your Brand Kit/);
  });

  test('a missing or malformed founding year is left out and said to be left out, never guessed', () => {
    for (const foundingYear of ['', 'about 2014', '14']) {
      const r = build({ entity: { sameAs: [PASSED], foundingYear } });
      assert.ok(!('foundingDate' in r.jsonld['@graph'][0]), foundingYear);
      assert.ok(r.notIncluded.some((line) => /founding year/.test(line)));
    }
  });

  test('keeps the logo and links an earlier fix wrote, which the whole-node replacement would otherwise drop', () => {
    const first = buildAutofix({
      ruleCode: 'readiness.C1',
      brand,
      domain: 'datadental.example',
      extras: { logoUrl: 'https://datadental.example/logo.png', sameAs: [] },
    });
    const withLinks = build({ existingNodes: first.jsonld['@graph'] });
    assert.equal(withLinks.jsonld['@graph'][0].logo, 'https://datadental.example/logo.png');
    // A later Organization fix with nothing new to say keeps the profile links and year the node already had.
    const later = buildAutofix({
      ruleCode: 'readiness.C1',
      brand,
      domain: 'datadental.example',
      existingNodes: withLinks.jsonld['@graph'],
    });
    const org = later.jsonld['@graph'][0];
    assert.deepEqual(org.sameAs, [PASSED]);
    assert.equal(org.foundingDate, '2014');
  });
});
