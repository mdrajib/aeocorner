import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  brandNames,
  changedSections,
  emptyBrandKit,
  fromLiteKit,
  parseBrandKit,
} from './brand-kit.js';

describe('parseBrandKit', () => {
  test('fills every section, so a screen never meets a missing one', () => {
    const r = parseBrandKit({ identity: { brandName: 'Acme' } });
    assert.equal(r.ok, true);
    assert.deepEqual(r.kit.offerings, { items: [], audiences: [], differentiators: [] });
    assert.deepEqual(r.kit.facts, []);
    assert.deepEqual(r.kit.voice.personas, []);
    assert.equal(r.kit.identity.legalName, '');
  });

  test('tidies text, drops blanks and repeats, and cuts what is too long', () => {
    const r = parseBrandKit({
      identity: {
        brandName: '  Acme   Dental ',
        aliases: ['Acme', ' Acme ', '', 'AcmeDental'],
        definition: 'x'.repeat(900),
      },
    });
    assert.equal(r.kit.identity.brandName, 'Acme Dental');
    assert.deepEqual(r.kit.identity.aliases, ['Acme', 'AcmeDental']);
    assert.equal(r.kit.identity.definition.length, 400);
  });

  test('explains what is wrong by field', () => {
    const r = parseBrandKit({
      identity: { brandName: '   ' },
      facts: [{ label: 'Founded', value: '' }],
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors['identity.brandName']);
    assert.ok(r.errors['facts.0.value']);
  });

  test('refuses more than the limits allow instead of silently dropping rows', () => {
    const r = parseBrandKit({
      identity: { brandName: 'Acme' },
      offerings: { items: Array.from({ length: 31 }, (_, i) => ({ name: `P${i}` })) },
    });
    assert.equal(r.ok, false);
  });

  test('ignores fields it does not know, and rejects non-objects without throwing', () => {
    const r = parseBrandKit({ identity: { brandName: 'Acme', admin: true }, __proto__x: 1 });
    assert.equal(r.ok, true);
    assert.equal('admin' in r.kit.identity, false);
    assert.equal(parseBrandKit(null).ok, false);
    assert.equal(parseBrandKit('x').ok, false);
  });
});

describe('kits from other sources', () => {
  test('a new project starts with its name and site', () => {
    const kit = emptyBrandKit({ name: 'Acme', domain: 'acme.test' });
    assert.deepEqual(kit.identity.domains, ['acme.test']);
  });

  test('the audit’s lite kit becomes a version-1 kit without its competitors', () => {
    const kit = fromLiteKit(
      {
        brand_name: 'Acme Dental',
        aliases: ['Acme'],
        category: 'family dental practice',
        definition: 'A family dentist.',
        offerings: ['Cleanings', 'Invisalign'],
        audience: 'Families in Austin',
        geography: null,
        competitors: [{ name: 'Rival', domain: null }],
      },
      { domain: 'acme.test' },
    );
    assert.equal(kit.identity.category, 'family dental practice');
    assert.deepEqual(
      kit.offerings.items.map((o) => o.name),
      ['Cleanings', 'Invisalign'],
    );
    assert.deepEqual(kit.offerings.audiences, ['Families in Austin']);
    assert.equal(kit.identity.geography, '');
    assert.equal(JSON.stringify(kit).includes('Rival'), false);
    assert.equal(fromLiteKit({ brand_name: '' }), null);
  });
});

describe('names and history', () => {
  test('brandNames lists the name and aliases once each', () => {
    const kit = emptyBrandKit({ name: 'Acme Inc.', domain: 'a.test' });
    kit.identity.aliases = ['ACME inc', 'Acme'];
    assert.deepEqual(brandNames(kit), ['Acme Inc.', 'Acme']);
  });

  test('changedSections names only the sections that differ', () => {
    const a = emptyBrandKit({ name: 'Acme', domain: 'a.test' });
    const b = structuredClone(a);
    assert.deepEqual(changedSections(a, b), []);
    b.voice.tone = ['warm'];
    b.facts = [{ label: 'Founded', value: '1999' }];
    assert.deepEqual(changedSections(a, b), ['facts', 'voice']);
    assert.deepEqual(changedSections(null, a), [
      'identity',
      'offerings',
      'facts',
      'voice',
      'entity',
    ]);
  });

  test('a version-1 kit has no entity change just because it predates the section', () => {
    const v1 = structuredClone(emptyBrandKit({ name: 'Acme', domain: 'a.test' }));
    delete v1.entity;
    const v2 = parseBrandKit(v1).kit;
    assert.deepEqual(changedSections(v1, v2), []);
    v2.entity.foundingYear = '2014';
    assert.deepEqual(changedSections(v1, v2), ['entity']);
  });
});

describe('the entity section (schema version 2)', () => {
  const kit = (entity) => parseBrandKit({ identity: { brandName: 'Acme' }, entity });

  test('is empty by default, so an older kit still parses', () => {
    const r = parseBrandKit({ identity: { brandName: 'Acme' } });
    assert.deepEqual(r.kit.entity, {
      foundingYear: '',
      headquarters: '',
      profiles: [],
      wikidataId: '',
    });
  });

  test('keeps the year, the place, tidy profile addresses once each, and a normal item number', () => {
    const r = kit({
      foundingYear: ' 2014 ',
      headquarters: '  Austin,   Texas ',
      profiles: [
        { platform: 'linkedin', url: 'https://www.linkedin.com/company/acme/?utm_source=x#top' },
        { platform: 'linkedin', url: 'https://www.linkedin.com/company/acme' },
      ],
      wikidataId: 'q42',
    });
    assert.equal(r.ok, true);
    assert.equal(r.kit.entity.foundingYear, '2014');
    assert.equal(r.kit.entity.headquarters, 'Austin, Texas');
    assert.deepEqual(r.kit.entity.profiles, [
      { platform: 'linkedin', url: 'https://www.linkedin.com/company/acme' },
    ]);
    assert.equal(r.kit.entity.wikidataId, 'Q42');
  });

  test('says what is wrong, by field', () => {
    const r = kit({
      foundingYear: '19x4',
      profiles: [{ platform: 'other', url: 'http://x.test' }],
      wikidataId: 'Z9',
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors['entity.foundingYear']);
    assert.ok(r.errors['entity.profiles.0.url']);
    assert.ok(r.errors['entity.wikidataId']);
  });

  test('refuses more profiles than the limit instead of dropping some', () => {
    const profiles = Array.from({ length: 13 }, (_, i) => ({
      platform: 'other',
      url: `https://p${i}.example.com/a`,
    }));
    assert.equal(kit({ profiles }).ok, false);
  });
});
