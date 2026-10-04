import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseBrandKit } from './brand-kit.js';
import { entityView, profileRow, wikidataCard } from './entity-view.js';

const LI = 'https://www.linkedin.com/company/dd';
const CB = 'https://www.crunchbase.com/organization/dd';
const kit = (entity = {}) =>
  parseBrandKit({
    identity: { brandName: 'Data Dental', definition: 'A family dental practice.' },
    offerings: { items: [{ name: 'Cleaning', price: 'From $99' }] },
    entity: {
      foundingYear: '2014',
      headquarters: 'Austin, Texas',
      profiles: [
        { platform: 'linkedin', url: LI },
        { platform: 'crunchbase', url: CB },
      ],
      ...entity,
    },
  }).kit;
const check = (subject, status, finding, extra = {}) => ({
  kind: 'profile',
  subject,
  platform: 'x',
  status,
  finding,
  details: {},
  checkedAt: new Date('2026-10-01T00:00:00Z'),
  ...extra,
});
const view = (over = {}) =>
  entityView({
    kit: kit(),
    checks: [],
    said: { claims: [], answersRead: 0 },
    domain: 'datadental.test',
    ...over,
  });

describe('a profile row', () => {
  const p = { platform: 'linkedin', url: LI };

  test('with no check it is "not checked yet", never a result', () => {
    const r = profileRow(p, undefined);
    assert.deepEqual([r.tone, r.status, r.confirmed], ['unknown', 'Not checked yet', false]);
  });

  test('passed is confirmed, and says when it does not link back', () => {
    assert.equal(
      profileRow(p, check(LI, 'passed', 'names_brand', { details: { linksBack: true } })).tone,
      'success',
    );
    assert.match(
      profileRow(p, check(LI, 'passed', 'names_brand', { details: { linksBack: false } })).detail,
      /does not link/,
    );
  });

  test('failed is a warning, in words that say why; "couldn\'t check" is never one', () => {
    const failed = profileRow(p, check(LI, 'failed', 'brand_not_named'));
    assert.deepEqual([failed.tone, failed.status], ['warning', 'Doesn’t name you']);
    const gone = profileRow(p, check(LI, 'failed', 'not_found'));
    assert.equal(gone.status, 'Page not found');
    const blocked = profileRow(p, check(LI, 'error', 'blocked'));
    assert.deepEqual([blocked.tone, blocked.status], ['unknown', 'Couldn’t check']);
    assert.match(blocked.detail, /turned our crawler away/);
  });

  test('a kept result says we could not look again', () => {
    const r = profileRow(
      p,
      check(LI, 'passed', 'names_brand', {
        details: { lastAttempt: { finding: 'blocked', at: '2026-10-04T00:00:00Z' } },
      }),
    );
    assert.equal(r.status, 'Confirmed');
    assert.match(r.note, /could not check again on Oct 4, 2026/);
    assert.match(r.note, /from Oct 1, 2026/);
  });
});

describe('the Wikidata card', () => {
  test('found shows the item with its address; "no item" is a warning; an error is "couldn\'t check"', () => {
    const found = wikidataCard({
      status: 'passed',
      finding: 'found',
      details: { item: { id: 'Q7', label: 'Data Dental', description: 'dentist' } },
      checkedAt: new Date(),
    });
    assert.equal(found.itemUrl, 'https://www.wikidata.org/wiki/Q7');
    assert.match(found.item, /Q7/);
    assert.equal(
      wikidataCard({
        status: 'failed',
        finding: 'not_in_wikidata',
        details: {},
        checkedAt: new Date(),
      }).tone,
      'warning',
    );
    const err = wikidataCard({
      status: 'error',
      finding: 'lookup_failed',
      details: {},
      checkedAt: new Date(),
    });
    assert.deepEqual([err.tone, err.status], ['unknown', 'Couldn’t check']);
  });
});

describe('the whole screen', () => {
  test('with nothing checked or read, every figure is unknown, not 0', () => {
    const v = view();
    assert.equal(v.tiles.profiles, null);
    assert.equal(v.tiles.wikidata, null);
    assert.equal(v.tiles.facts, null);
    assert.ok(v.facts.every((f) => f.tone === 'unknown'));
  });

  test('profiles confirmed counts only real results', () => {
    const v = view({ checks: [check(LI, 'passed', 'names_brand'), check(CB, 'error', 'blocked')] });
    assert.deepEqual(v.tiles.profiles, { value: '1 of 2', note: 'Profiles confirmed' });
    const onlyBlocked = view({
      checks: [check(LI, 'error', 'blocked'), check(CB, 'error', 'blocked')],
    });
    assert.equal(onlyBlocked.tiles.profiles, null);
  });

  test('facts: a wrong one is a warning with the engine’s words; not mentioned is neutral', () => {
    const v = view({
      said: {
        answersRead: 5,
        claims: [
          { id: 1, engineCode: 'gemini', attribute: 'company_fact', value: 'Founded in 2011' },
          { id: 2, engineCode: 'chatgpt', attribute: 'company_fact', value: 'Founded in 2012' },
        ],
      },
    });
    const founded = v.facts.find((f) => f.key === 'founded');
    assert.deepEqual([founded.tone, founded.status], ['warning', 'Engines disagree']);
    assert.deepEqual(
      founded.examples.map((e) => e.engine),
      ['ChatGPT', 'Gemini'],
    );
    assert.equal(v.facts.find((f) => f.key === 'headquarters').tone, 'neutral');
    assert.equal(v.tiles.facts.value, '1 to fix');
  });

  test('says what to add to compare more, and has a checklist for each platform', () => {
    const bare = entityView({
      kit: parseBrandKit({ identity: { brandName: 'Data Dental' } }).kit,
      checks: [],
      said: { claims: [], answersRead: 0 },
      domain: 'datadental.test',
    });
    assert.deepEqual(bare.missing, [
      'the year you were founded',
      'where you are based',
      'a price on at least one offering',
    ]);
    assert.equal(bare.checklists.length, 5);
    assert.equal(
      entityView({ kit: null, checks: [], said: { claims: [], answersRead: 0 }, domain: 'a.test' })
        .hasKit,
      false,
    );
  });
});
